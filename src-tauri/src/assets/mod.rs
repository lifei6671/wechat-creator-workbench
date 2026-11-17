mod cleanup;
pub mod commands;
mod export;
mod image_cache;
mod import_markdown;
pub mod publishing;
pub mod references;
pub(crate) mod s3;
pub(crate) mod upload_format;

use crate::db::{AppError, Result, Workspace, id, now, workspace_id};
use image::{ImageDecoder, ImageFormat, ImageReader};
use image_cache::ImageCache;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use rusqlite::{Connection, OptionalExtension, Row, params};
use s3::{Profile, Target};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    io::{Cursor, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Notify, Semaphore};
use tokio_util::sync::CancellationToken;

pub(crate) const MAX_BYTES: usize = 20 * 1024 * 1024;

pub struct Assets {
    root: PathBuf,
    ready: Notify,
    activity: tokio::sync::watch::Sender<()>,
    upload_gate: Mutex<()>,
    thumbnails: Semaphore,
    thumbnail_cache: Option<PathBuf>,
    uploads_stopped: CancellationToken,
    cleanup_stopped: CancellationToken,
    uncertain_upload: AtomicBool,
    public_http: reqwest::Client,
    external_http: reqwest::Client,
    image_cache: Option<ImageCache>,
}

const IMAGE_TIMEOUT: Duration = Duration::from_secs(25);
const THUMBNAIL_SIZE: u32 = 160;

enum ImageOrigin<'a> {
    Attachment,
    Hosting(&'a Target),
    Library,
    ImportPlaceholder(&'a str),
    Derived(&'a str),
}

#[derive(Debug)]
struct PublicImageDns;

impl Resolve for PublicImageDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|address| public_ip(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(std::io::Error::other("外链图片必须使用公网地址").into());
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn public_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 198 && matches!(b, 18 | 19))
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(ip) => {
            let [prefix, next, ..] = ip.segments();
            prefix & 0xe000 == 0x2000
                && !matches!(
                    (prefix, next),
                    (0x2001, 0 | 2 | 0xdb8) | (0x2002, _) | (0x3fff, 0..=0xfff)
                )
        }
    }
}

pub(crate) fn remote_image_url(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw).map_err(|_| AppError::invalid("图片地址无效"))?;
    if !is_http_image(&url) {
        return Err(AppError::invalid("图片地址必须使用 HTTP 或 HTTPS"));
    }
    Ok(url)
}

fn is_http_image(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

fn has_public_image_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => public_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => public_ip(IpAddr::V6(ip)),
        Some(url::Host::Domain(_)) => true,
        None => false,
    }
}

#[derive(Clone)]
pub(super) struct AssetFile {
    pub id: String,
    pub hash: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRow {
    id: String,
    name: String,
    width: Option<u32>,
    height: Option<u32>,
    bytes: Option<i64>,
    upload_status: Option<String>,
    upload_error: Option<String>,
    cleanup_error: Option<String>,
    public_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLibrary {
    items: Vec<AssetRow>,
    target: Option<Target>,
    page: u32,
    has_next: bool,
}

struct Upload {
    job: String,
    file: AssetFile,
    profile: Profile,
    key: String,
    registered: bool,
    options: upload_format::UploadOptions,
}

struct HostedLocation {
    profile_id: String,
    key: String,
    url: String,
    content_hash: String,
}

impl Assets {
    pub fn new(root: PathBuf, db: &Workspace) -> Result<Self> {
        db.write(|tx| {
            tx.execute(
                "UPDATE jobs SET status='failed', error='上传已中断，可手动重试', updated_at=?1
                 WHERE kind='upload' AND status IN ('running','queued','retrying')",
                [now()],
            )?;
            Ok(())
        })?;
        Ok(Self {
            root,
            ready: Notify::new(),
            activity: tokio::sync::watch::channel(()).0,
            upload_gate: Mutex::new(()),
            thumbnails: Semaphore::new(2),
            thumbnail_cache: None,
            uploads_stopped: CancellationToken::new(),
            cleanup_stopped: CancellationToken::new(),
            uncertain_upload: AtomicBool::new(false),
            public_http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(IMAGE_TIMEOUT)
                .build()
                .map_err(|error| AppError::new("S3_NETWORK", error.to_string()))?,
            external_http: reqwest::Client::builder()
                .no_proxy()
                .dns_resolver(Arc::new(PublicImageDns))
                .referer(false)
                .redirect(reqwest::redirect::Policy::custom(|redirect| {
                    if redirect.previous().len() > 5 {
                        return redirect.error("图片地址重定向次数过多");
                    }
                    if !is_http_image(redirect.url()) || !has_public_image_host(redirect.url()) {
                        return redirect.error("外链图片只能跳转到公网 HTTP 或 HTTPS 地址");
                    }
                    redirect.follow()
                }))
                .timeout(IMAGE_TIMEOUT)
                .build()
                .map_err(|error| AppError::new("IMAGE_NETWORK", error.to_string()))?,
            image_cache: None,
        })
    }

    pub fn with_image_cache(mut self, directory: &Path) -> Self {
        match ImageCache::open(directory) {
            Ok(cache) => self.image_cache = Some(cache),
            Err(error) => eprintln!("Could not open the remote image cache: {error}"),
        }
        self
    }

    pub fn with_thumbnail_cache(mut self, directory: PathBuf) -> Self {
        self.thumbnail_cache = Some(directory);
        self
    }

    pub fn kick(&self) {
        self.ready.notify_one();
        self.activity.send_replace(());
    }

    pub async fn wait_uploads(&self) {
        let _upload = self.upload_gate.lock().await;
    }

    pub fn import(&self, db: &Workspace, name: &str, bytes: &[u8]) -> Result<String> {
        self.store_image(db, name, bytes, ImageOrigin::Attachment)
    }

    pub fn import_to_library(&self, db: &Workspace, name: &str, bytes: &[u8]) -> Result<String> {
        self.store_image(db, name, bytes, ImageOrigin::Library)
    }

    pub fn fill(&self, db: &Workspace, asset_id: &str, bytes: &[u8]) -> Result<String> {
        self.store_image(
            db,
            "公众号图片",
            bytes,
            ImageOrigin::ImportPlaceholder(asset_id),
        )
    }

    pub fn derive(&self, db: &Workspace, kind: &str, source: &str, bytes: &[u8]) -> Result<String> {
        if !matches!(kind, "math-inline" | "math-block" | "mermaid") {
            return Err(AppError::invalid("未知的排版图片类型"));
        }
        let key = references::source_key(kind, source);
        let label = if kind == "mermaid" {
            "Mermaid 图表"
        } else {
            "数学公式"
        };
        self.store_image(db, label, bytes, ImageOrigin::Derived(&key))
    }

    fn store_image(
        &self,
        db: &Workspace,
        name: &str,
        bytes: &[u8],
        origin: ImageOrigin<'_>,
    ) -> Result<String> {
        let expected = match origin {
            ImageOrigin::Hosting(target) => Some(target),
            _ => None,
        };
        let (kind, source, placeholder, retained) = match origin {
            ImageOrigin::Attachment | ImageOrigin::Hosting(_) => ("original", None, None, false),
            ImageOrigin::Library => ("original", None, None, true),
            ImageOrigin::ImportPlaceholder(id) => ("original", None, Some(id), false),
            ImageOrigin::Derived(key) => ("derived", Some(key), None, false),
        };
        let (format, width, height) = image_header(bytes)?;
        let hash = format!("{:x}", Sha256::digest(bytes));
        let relative = format!(
            "{}/{}/{}.{}",
            &hash[..2],
            &hash[2..4],
            hash,
            format.extensions_str()[0]
        );
        let asset_id = db.write(|tx| {
            let active = if kind == "original" { Profile::for_incoming_image(tx, expected)? } else { None };
            if let Some(placeholder) = placeholder
                && !cleanup::referenced(tx)?.0.contains(placeholder) {
                return Err(AppError::new("ASSET_UNUSED", "图片已不再被引用"));
            }
            let existing = tx.query_row(
                "SELECT id FROM assets WHERE sha256=?1 AND source_key IS ?2 AND kind=?3 ORDER BY created_at LIMIT 1",
                params![hash, source, kind], |r| r.get::<_, String>(0),
            ).optional()?;
            let path = self.root.join(&relative);
            if !path.is_file() {
                let parent = path.parent().expect("asset path has parent");
                std::fs::create_dir_all(parent).map_err(local_error)?;
                let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(local_error)?;
                temporary.write_all(bytes).map_err(local_error)?;
                temporary.persist(&path).map_err(|e| local_error(e.error))?;
            }
            let asset_id = if let Some(placeholder) = placeholder {
                tx.execute("UPDATE assets SET sha256=?2, mime_type=?3, relative_path=?4, bytes=?5, width=?6, height=?7 WHERE id=?1",
                    params![placeholder, hash, format.to_mime_type(), relative, bytes.len() as i64, width, height])?;
                placeholder.to_owned()
            } else if let Some(id) = existing {
                if retained {
                    tx.execute("UPDATE assets SET retain_on_exit=1 WHERE id=?1", [&id])?;
                }
                id
            } else {
                let asset_id = id();
                tx.execute(
                    "INSERT INTO assets (id, sha256, mime_type, relative_path, kind, source_key, bytes, created_at, name, width, height, retain_on_exit)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    params![asset_id, hash, format.to_mime_type(), relative, kind,
                        source, bytes.len() as i64, now(), name, width, height, retained],
                )?;
                asset_id
            };
            if retained {
                tx.execute(
                    "DELETE FROM jobs WHERE kind='cleanup' AND sha256=?1 AND status<>'completed'",
                    [&hash],
                )?;
            }
            if let Some(profile) = active { enqueue(tx, &asset_id, &hash, &profile.id, false)?; }
            Ok(asset_id)
        })?;
        self.kick();
        Ok(asset_id)
    }

    pub fn is_referenced(&self, db: &Workspace, asset_id: &str) -> Result<bool> {
        db.read(|conn| Ok(cleanup::referenced(conn)?.0.contains(asset_id)))
    }

    pub fn library(&self, db: &Workspace, page: u32) -> Result<AssetLibrary> {
        const PAGE_SIZE: u32 = 48;
        db.read(|conn| {
            let active = Profile::active(conn)?;
            let active_id = active.as_ref().map(|p| p.id.as_str());
            let count: u32 = conn.query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))?;
            let last_page = count.saturating_sub(1) / PAGE_SIZE;
            let page = page.min(last_page);
            let mut query = conn.prepare(
                "SELECT a.id,a.name,a.width,a.height,a.bytes,
                        CASE WHEN j.status<>'completed' THEN j.status END,j.error,c.error,
                        CASE WHEN l.uploaded_at IS NOT NULL AND l.deleted_at IS NULL THEN l.public_url END
                 FROM assets a
                 LEFT JOIN asset_locations l ON l.sha256=a.sha256 AND l.storage_profile_id=?1
                 LEFT JOIN jobs j ON j.id=(SELECT id FROM jobs WHERE kind='upload' AND sha256=a.sha256
                    AND storage_profile_id=?1 ORDER BY created_at DESC, id DESC LIMIT 1)
                 LEFT JOIN jobs c ON c.id=(SELECT id FROM jobs WHERE kind='cleanup' AND sha256=a.sha256
                    AND status='failed' ORDER BY updated_at DESC, id DESC LIMIT 1)
                 ORDER BY a.created_at DESC, a.id DESC LIMIT ?2 OFFSET ?3",
            )?;
            let items = query.query_map(params![active_id, PAGE_SIZE, page * PAGE_SIZE], |r| Ok(AssetRow {
                id: r.get(0)?, name: r.get(1)?, width: r.get(2)?, height: r.get(3)?, bytes: r.get(4)?,
                upload_status: r.get(5)?, upload_error: r.get(6)?, cleanup_error: r.get(7)?, public_url: r.get(8)?,
            }))?.collect::<rusqlite::Result<_>>()?;
            Ok(AssetLibrary { items, target: active.map(|p| p.target), page, has_next: page < last_page })
        })
    }

    pub fn upload(&self, db: &Workspace, asset_id: &str) -> Result<()> {
        db.write(|tx| {
            let file = by_id(tx, asset_id)?;
            let hash = file
                .hash
                .ok_or_else(|| AppError::new("ASSET_MISSING", "图片文件尚未保存"))?;
            let profile =
                Profile::active(tx)?.ok_or_else(|| AppError::invalid("请先配置 S3 图床"))?;
            enqueue(tx, asset_id, &hash, &profile.id, true)
        })?;
        self.kick();
        Ok(())
    }

    pub async fn thumbnail(&self, db: &Workspace, id: &str) -> Result<Vec<u8>> {
        let file = db.read(|conn| by_id(conn, id))?;
        let cached_path = self
            .thumbnail_cache
            .as_ref()
            .zip(file.hash.as_ref())
            .filter(|(_, hash)| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .map(|(directory, hash)| directory.join(format!("v1-{THUMBNAIL_SIZE}-{hash}.png")));
        if let Some(path) = &cached_path
            && let Ok(bytes) = tokio::fs::read(path).await
        {
            return Ok(bytes);
        }
        let _slot = self
            .thumbnails
            .acquire()
            .await
            .expect("thumbnail semaphore stays open");
        let bytes = self.read_file(db, &file).await?;
        tauri::async_runtime::spawn_blocking(move || {
            let (format, _, _) = image_header(&bytes)?;
            let decode_error =
                |error| AppError::new("IMAGE_FORMAT", format!("无法解码素材图片：{error}"));
            let mut decoder = ImageReader::with_format(Cursor::new(&bytes), format)
                .into_decoder()
                .map_err(decode_error)?;
            let orientation = decoder.orientation().map_err(decode_error)?;
            let image = image::DynamicImage::from_decoder(decoder).map_err(decode_error)?;
            let mut thumbnail = image.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
            thumbnail.apply_orientation(orientation);
            let mut output = Cursor::new(Vec::new());
            thumbnail
                .write_to(&mut output, ImageFormat::Png)
                .map_err(|error| {
                    AppError::new("IMAGE_FORMAT", format!("无法生成图片缩略图：{error}"))
                })?;
            let thumbnail = output.into_inner();
            // A hosted copy can be re-encoded and have a different content hash.
            if let Some(path) = cached_path
                && file
                    .hash
                    .is_some_and(|hash| hash == format!("{:x}", Sha256::digest(&bytes)))
                && let Err(error) = save_thumbnail(&path, &thumbnail)
            {
                eprintln!("Could not cache the asset thumbnail: {error}");
            }
            Ok(thumbnail)
        })
        .await
        .map_err(|error| AppError::new("ASSET_FILE", error.to_string()))?
    }

    pub async fn read(&self, db: &Workspace, url: &str) -> Result<Vec<u8>> {
        self.read_image(db, url, false).await
    }

    pub(super) async fn read_image(
        &self,
        db: &Workspace,
        url: &str,
        retry: bool,
    ) -> Result<Vec<u8>> {
        match db.read(|conn| by_url(conn, url)) {
            Ok(file) => self.read_file(db, &file).await,
            Err(error) if error.code() != "NOT_FOUND" => Err(error),
            Err(_) if url.starts_with("asset://") => {
                Err(AppError::new("ASSET_MISSING", "素材库中找不到这张图片"))
            }
            Err(_) => {
                let address = remote_image_url(url)?;
                if !db.read(|conn| configured_image(conn, &address))? {
                    return self.read_external(&address, retry).await;
                }
                let bytes = self.read_public(address.as_str()).await?;
                image_header(&bytes)?;
                Ok(bytes)
            }
        }
    }

    pub async fn localize(&self, db: &Workspace, url: &str) -> Result<String> {
        self.localize_for(db, url, None).await
    }

    pub(super) async fn localize_for(
        &self,
        db: &Workspace,
        url: &str,
        expected: Option<&Target>,
    ) -> Result<String> {
        let address = remote_image_url(url)?;
        if db.read_running(|conn| {
            Ok(Profile::active_for(conn, expected)?
                .is_some_and(|profile| profile.target.contains_public_url(&address)))
        })? {
            return Ok(url.to_owned());
        }
        match db.read_running(|conn| by_url(conn, url)) {
            Ok(file) => {
                let hash = file
                    .hash
                    .as_deref()
                    .expect("a public alias has an image hash");
                let queued = db.write(|tx| {
                    let Some(profile) = Profile::for_incoming_image(tx, expected)? else {
                        return Ok(false);
                    };
                    enqueue(tx, &file.id, hash, &profile.id, expected.is_some())?;
                    Ok(true)
                })?;
                if queued {
                    self.kick();
                }
                return Ok(format!("asset://{}", file.id));
            }
            Err(error) if error.code() != "NOT_FOUND" => return Err(error),
            Err(_) => {}
        }
        let bytes = self.read_external(&address, false).await?;
        let name = address
            .path()
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("粘贴图片");
        let origin = expected.map_or(ImageOrigin::Attachment, ImageOrigin::Hosting);
        let id = self.store_image(db, name, &bytes, origin)?;
        Ok(format!("asset://{id}"))
    }

    async fn read_external(&self, address: &url::Url, retry: bool) -> Result<Vec<u8>> {
        if !has_public_image_host(address) {
            return Err(AppError::invalid("外链图片必须使用公网地址"));
        }
        if let Some(cache) = &self.image_cache {
            return cache.read(&self.external_http, address, retry).await;
        }
        let bytes = Self::read_remote(
            &self.external_http,
            address.as_str(),
            "外链图片",
            "IMAGE_NETWORK",
            "IMAGE_TIMEOUT",
        )
        .await?;
        image_header(&bytes)?;
        Ok(bytes)
    }

    pub(super) async fn read_file(&self, db: &Workspace, file: &AssetFile) -> Result<Vec<u8>> {
        if let Some(relative) = &file.path {
            match tokio::fs::read(self.root.join(relative)).await {
                Ok(data) => return Ok(data),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(local_error(error)),
            }
        }
        let (profile, location) = db.read(|conn| {
            let location = hosted_location(conn, file)?
                .ok_or_else(|| AppError::new("ASSET_MISSING", "找不到本地图片或可用的图床副本"))?;
            Ok((Profile::read(conn, &location.profile_id)?, location))
        })?;
        let result = match profile.provider() {
            Ok(store) => store.get(&location.key).await,
            Err(error) => Err(error),
        };
        let bytes = match result {
            Err(error) if matches!(error.code(), "S3_CREDENTIALS" | "S3_PERMISSION") => {
                self.read_public(&location.url).await?
            }
            result => result?,
        };
        image_header(&bytes)?;
        if format!("{:x}", Sha256::digest(&bytes)) != location.content_hash {
            return Err(AppError::new("ASSET_CHANGED", "图床图片与素材记录不一致"));
        }
        Ok(bytes)
    }

    fn export_name(&self, conn: &Connection, file: &AssetFile) -> Result<String> {
        let relative = file
            .path
            .as_deref()
            .ok_or_else(|| AppError::new("ASSET_MISSING", "图片尚未下载"))?;
        let name = Path::new(relative)
            .file_name()
            .and_then(|name| name.to_str())
            .expect("asset has a generated file name");
        if !self.root.join(relative).try_exists().map_err(local_error)?
            && let Some(location) = hosted_location(conn, file)?
            && let Some(format) = Path::new(&location.key)
                .extension()
                .and_then(ImageFormat::from_extension)
        {
            return Ok(name_for_format(name, format).into_owned());
        }
        Ok(name.to_owned())
    }

    async fn read_export_file(
        &self,
        db: &Workspace,
        file: &AssetFile,
        name: &str,
    ) -> Result<Vec<u8>> {
        let expected = Path::new(name)
            .extension()
            .and_then(ImageFormat::from_extension);
        let bytes = self.read_file(db, file).await?;
        if Some(
            image::guess_format(&bytes)
                .map_err(|err| AppError::new("IMAGE_FORMAT", err.to_string()))?,
        ) != expected
        {
            return Err(AppError::new(
                "EXPORT_FAILED",
                "导出期间图片格式发生变化，请重新导出",
            ));
        }
        Ok(bytes)
    }

    async fn read_public(&self, url: &str) -> Result<Vec<u8>> {
        Self::read_remote(
            &self.public_http,
            url,
            "图床公开图片",
            "S3_NETWORK",
            "S3_TIMEOUT",
        )
        .await
    }

    async fn read_remote(
        client: &reqwest::Client,
        url: &str,
        label: &str,
        network_code: &'static str,
        timeout_code: &'static str,
    ) -> Result<Vec<u8>> {
        let response =
            client.get(url).send().await.map_err(|error| {
                Self::image_network_error(error, label, network_code, timeout_code)
            })?;
        Self::read_image_body(response, label, network_code, timeout_code).await
    }

    fn image_network_error(
        error: reqwest::Error,
        label: &str,
        network_code: &'static str,
        timeout_code: &'static str,
    ) -> AppError {
        let code = if error.is_timeout() {
            timeout_code
        } else {
            network_code
        };
        AppError::new(code, format!("无法读取{label}：{}", error.without_url()))
    }

    async fn read_image_body(
        mut response: reqwest::Response,
        label: &str,
        network_code: &'static str,
        timeout_code: &'static str,
    ) -> Result<Vec<u8>> {
        if !response.status().is_success() {
            return Err(AppError::new(
                "ASSET_MISSING",
                format!("{label}地址不可用（HTTP {}）", response.status().as_u16()),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| Self::image_network_error(error, label, network_code, timeout_code))?
        {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(AppError::new("IMAGE_SIZE", "远程图片超过 20 MB"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub async fn run_uploads(&self, db: &Workspace, app: &AppHandle) {
        use tauri::Emitter;
        loop {
            tokio::select! {
                () = self.uploads_stopped.cancelled() => break,
                () = self.ready.notified() => {}
            }
            let _guard = self.upload_gate.lock().await;
            while !self.uploads_stopped.is_cancelled() {
                let upload = match claim(db) {
                    Ok(Some(upload)) => upload,
                    Ok(None) => break,
                    Err(error) if error.code() == "EXIT_PENDING" => break,
                    Err(error) => {
                        eprintln!("{error}");
                        break;
                    }
                };
                let _ = app.emit("assets-changed", ());
                let outcome = self.perform_upload(db, &upload).await;
                if let Err(error) = &outcome
                    && matches!(
                        error.code(),
                        "S3_TIMEOUT" | "S3_NETWORK" | "UPLOAD_UNCERTAIN"
                    )
                {
                    self.uncertain_upload.store(true, Ordering::Relaxed);
                }
                if let Err(error) = complete_upload(db, &upload, outcome) {
                    eprintln!("{error}");
                }
                self.activity.send_replace(());
                let _ = app.emit("assets-changed", ());
            }
        }
    }

    async fn perform_upload(&self, db: &Workspace, upload: &Upload) -> Result<()> {
        let bytes = self.read_file(db, &upload.file).await?;
        let options = upload.options.clone();
        let (format, bytes) = tokio::task::spawn_blocking(move || options.encode(bytes))
            .await
            .map_err(|error| AppError::new("IMAGE_FORMAT", error.to_string()))??;
        let key = name_for_format(&upload.key, format);
        let content_hash = format!("{:x}", Sha256::digest(&bytes));
        let store = upload.profile.provider()?;
        if self.uploads_stopped.is_cancelled() {
            return Err(AppError::new(
                "UPLOAD_CANCELLED",
                "退出时取消上传，可手动重试",
            ));
        }
        tokio::select! {
            biased;
            result = async {
                if upload.registered && key != upload.key {
                    store.delete(&upload.key).await?;
                }
                register_target(db, upload, &key, &content_hash)?;
                store.put(&key, format.to_mime_type(), bytes).await
            } => result,
            () = self.uploads_stopped.cancelled() => Err(AppError::new("UPLOAD_UNCERTAIN", "退出前上传未结束，可手动重试")),
        }
    }

    pub fn spawn(app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            app.state::<Assets>()
                .run_uploads(&app.state::<Workspace>(), &app)
                .await;
        });
    }
}

pub(crate) fn configured_image(conn: &Connection, url: &url::Url) -> Result<bool> {
    Ok(Profile::active(conn)?.is_some_and(|profile| profile.target.contains_public_url(url)))
}

fn publication_file(conn: &Connection, url: &str) -> Result<Option<AssetFile>> {
    match by_url(conn, url) {
        Ok(file) => Ok(Some(file)),
        Err(error) => {
            if error.code() == "NOT_FOUND"
                && let Ok(address) = remote_image_url(url)
                && configured_image(conn, &address)?
            {
                return Ok(None);
            }
            Err(error)
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct UploadProgress {
    completed: usize,
    total: usize,
}

fn upload_progress(db: &Workspace, markdown: &str) -> Result<Option<UploadProgress>> {
    let urls = references::urls(markdown)?;
    if urls.is_empty() {
        return Ok(None);
    }
    db.read(|conn| {
        let Some(profile) = Profile::active(conn)? else {
            return Ok(None);
        };
        let active: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='upload' AND storage_profile_id=?1
                AND status IN ('queued','running','retrying'))",
            [&profile.id],
            |row| row.get(0),
        )?;
        if !active {
            return Ok(None);
        }
        let mut hashes = std::collections::HashSet::new();
        let mut progress = UploadProgress { completed: 0, total: 0 };
        let mut pending = false;
        let mut query = conn.prepare(
            "SELECT CASE
                WHEN EXISTS(SELECT 1 FROM asset_locations WHERE sha256=?1 AND storage_profile_id=?2
                    AND uploaded_at IS NOT NULL AND deleted_at IS NULL) THEN 'uploaded'
                WHEN EXISTS(SELECT 1 FROM jobs WHERE kind='upload' AND sha256=?1 AND storage_profile_id=?2
                    AND status IN ('queued','running','retrying')) THEN 'pending'
                WHEN EXISTS(SELECT 1 FROM jobs WHERE kind='upload' AND sha256=?1 AND storage_profile_id=?2
                    AND status='failed') THEN 'failed'
             END",
        )?;
        for url in urls {
            let file = match by_url(conn, &url) {
                Ok(file) => file,
                Err(error) if error.code() == "NOT_FOUND" => continue,
                Err(error) => return Err(error),
            };
            let Some(hash) = file.hash else { continue };
            if !hashes.insert(hash.clone()) {
                continue;
            }
            let status: Option<String> =
                query.query_row(params![hash, profile.id], |row| row.get(0))?;
            match status.as_deref() {
                Some("uploaded") => {
                    progress.completed += 1;
                    progress.total += 1;
                }
                Some("pending") => {
                    pending = true;
                    progress.total += 1;
                }
                Some("failed") => progress.total += 1,
                _ => {}
            }
        }
        Ok(pending.then_some(progress))
    })
}

fn save_thumbnail(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let directory = path.parent().expect("thumbnail cache file has a directory");
    std::fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.error),
    }
}

fn local_error(error: std::io::Error) -> AppError {
    AppError::new("ASSET_FILE", format!("无法处理素材文件：{error}"))
}

fn name_for_format(name: &str, format: ImageFormat) -> Cow<'_, str> {
    let (stem, extension) = name.rsplit_once('.').expect("asset name has an extension");
    if ImageFormat::from_extension(extension) == Some(format) {
        Cow::Borrowed(name)
    } else {
        Cow::Owned(format!("{stem}.{}", format.extensions_str()[0]))
    }
}

fn hosted_location(conn: &Connection, file: &AssetFile) -> Result<Option<HostedLocation>> {
    Ok(conn.query_row(
        "SELECT storage_profile_id,object_key,public_url,COALESCE(content_sha256,sha256) FROM asset_locations WHERE sha256=?1
         AND uploaded_at IS NOT NULL AND deleted_at IS NULL
         ORDER BY (storage_profile_id=(SELECT value FROM app_settings WHERE key='image_storage_profile')) DESC, uploaded_at DESC LIMIT 1",
        [file.hash.as_deref()], |row| Ok(HostedLocation { profile_id: row.get(0)?, key: row.get(1)?, url: row.get(2)?, content_hash: row.get(3)? }),
    ).optional()?)
}

fn image_header(bytes: &[u8]) -> Result<(ImageFormat, u32, u32)> {
    if bytes.len() > MAX_BYTES {
        return Err(AppError::new("IMAGE_SIZE", "单张图片不能超过 20 MB"));
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(local_error)?;
    let format = reader
        .format()
        .filter(|format| {
            matches!(
                format,
                ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
            )
        })
        .ok_or_else(|| AppError::new("IMAGE_FORMAT", "仅支持 PNG、JPEG、GIF 和 WebP 图片"))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| AppError::new("IMAGE_FORMAT", "图片文件头或尺寸无效"))?;
    validate_dimensions(width, height)?;
    Ok((format, width, height))
}

pub(crate) fn validate_dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > 16000
        || height > 16000
        || u64::from(width) * u64::from(height) > 40_000_000
    {
        return Err(AppError::new(
            "IMAGE_SIZE",
            "图片尺寸不能超过 16000 像素或 4000 万像素总量",
        ));
    }
    Ok(())
}

fn file_row(r: &Row<'_>) -> rusqlite::Result<AssetFile> {
    Ok(AssetFile {
        id: r.get(0)?,
        hash: r.get(1)?,
        path: r.get(2)?,
    })
}

fn by_id(conn: &Connection, id: &str) -> Result<AssetFile> {
    Ok(conn.query_row(
        "SELECT id,sha256,relative_path FROM assets WHERE id=?1",
        [id],
        file_row,
    )?)
}

fn by_url(conn: &Connection, url: &str) -> Result<AssetFile> {
    if let Some(id) = url.strip_prefix("asset://") {
        return by_id(conn, id);
    }
    Ok(conn.query_row(
        "SELECT id,sha256,relative_path FROM assets
         WHERE sha256 IN (SELECT sha256 FROM asset_urls WHERE url=?1) ORDER BY relative_path IS NULL LIMIT 1",
        [references::canonical_url(url)], file_row,
    )?)
}

fn enqueue(
    conn: &Connection,
    asset_id: &str,
    hash: &str,
    profile: &str,
    retry: bool,
) -> Result<()> {
    let already_uploaded: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM asset_locations WHERE sha256=?1 AND storage_profile_id=?2 AND uploaded_at IS NOT NULL AND deleted_at IS NULL)",
        params![hash, profile], |r| r.get(0),
    )?;
    if already_uploaded {
        return Ok(());
    }
    let job = conn.query_row(
        "SELECT id,status FROM jobs WHERE kind='upload' AND sha256=?1 AND storage_profile_id=?2 ORDER BY created_at DESC,id DESC LIMIT 1",
        params![hash, profile], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)),
    ).optional()?;
    match job {
        Some((job, state)) if state == "failed" && retry => {
            conn.execute("UPDATE jobs SET status='retrying',asset_id=?2,error=NULL,updated_at=?3 WHERE id=?1", params![job, asset_id, now()])?;
        }
        Some((_, state)) if state != "completed" => {}
        _ => {
            conn.execute("INSERT INTO jobs (id,kind,status,asset_id,sha256,storage_profile_id,created_at,updated_at)
                VALUES (?1,'upload','queued',?2,?3,?4,?5,?5)", params![id(),asset_id,hash,profile,now()])?;
        }
    }
    Ok(())
}

fn claim(db: &Workspace) -> Result<Option<Upload>> {
    db.write(|tx| {
        let next = tx.query_row(
            "SELECT id,asset_id,storage_profile_id FROM jobs WHERE kind='upload' AND status IN ('queued','retrying') ORDER BY created_at,id LIMIT 1",
            [], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?)),
        ).optional()?;
        let Some((job, asset_id, profile_id)) = next else { return Ok(None); };
        let file = by_id(tx, &asset_id)?;
        let profile = Profile::read(tx, &profile_id)?;
        let name = file.path.as_deref().and_then(|p| Path::new(p).file_name()).and_then(|v| v.to_str())
            .expect("queued asset has a generated file name");
        let options = profile.upload_options(tx)?;
        let previous = tx.query_row(
            "SELECT object_key FROM asset_locations WHERE sha256=?1 AND storage_profile_id=?2 AND uploaded_at IS NULL AND deleted_at IS NULL",
            params![file.hash, profile.id], |row| row.get::<_, String>(0),
        ).optional()?;
        let (key, registered) = match previous {
            Some(key) => (key, true),
            None => (profile.target.key(&workspace_id(tx)?, &options.filename(name, now())?), false),
        };
        tx.execute("UPDATE jobs SET status='running',updated_at=?2 WHERE id=?1", params![job, now()])?;
        Ok(Some(Upload { job, file, profile, key, registered, options }))
    })
}

fn register_target(db: &Workspace, upload: &Upload, key: &str, content_hash: &str) -> Result<()> {
    db.maintenance(|tx| {
        let profile = Profile::read(tx, &upload.profile.id)?;
        let hash = upload.file.hash.as_deref().expect("queued asset has hash");
        let url = profile.target.public_url(key);
        tx.execute(
            "INSERT INTO asset_locations (sha256,storage_profile_id,object_key,public_url,content_sha256) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(sha256,storage_profile_id) DO UPDATE SET uploaded_at=NULL,deleted_at=NULL,object_key=excluded.object_key,public_url=excluded.public_url,content_sha256=excluded.content_sha256",
            params![hash, profile.id, key, url, content_hash],
        )?;
        tx.execute("INSERT OR IGNORE INTO asset_urls VALUES (?1,?2,?3)", params![url, hash, profile.id])?;
        Ok(())
    })
}

fn complete_upload(db: &Workspace, upload: &Upload, outcome: Result<()>) -> Result<()> {
    db.maintenance(|tx| {
        let timestamp = now();
        let (status, error) = match outcome {
            Ok(()) => {
                tx.execute("UPDATE asset_locations SET uploaded_at=?3 WHERE sha256=?1 AND storage_profile_id=?2",
                    params![upload.file.hash, upload.profile.id, timestamp])?;
                ("completed", None)
            }
            Err(error) => ("failed", Some(error.to_string())),
        };
        tx.execute("UPDATE jobs SET status=?2,error=?3,updated_at=?4 WHERE id=?1", params![upload.job, status, error, timestamp])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests;
