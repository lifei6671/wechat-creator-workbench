mod cleanup;
pub(crate) mod integrity;
pub mod commands;
mod export;
mod image_cache;
mod import_markdown;
pub mod publishing;
pub mod references;
mod remote_image;
pub(crate) mod s3;
pub(crate) mod sync;
pub(crate) mod upload_format;
pub(crate) mod version_cleanup;

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

pub(crate) struct CanvasFile {
    pub hash: String,
    pub relative: String,
    pub mime: String,
    pub bytes: i64,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn enqueue_canvas_output(conn: &Connection, asset_id: &str, hash: &str) -> Result<()> {
    if let Some(profile) = Profile::for_incoming_image(conn, None)? {
        enqueue(conn, asset_id, hash, &profile.id, false)?;
    }
    Ok(())
}

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
    Canvas,
    ImportPlaceholder(&'a str),
    Derived(&'a str),
}

#[derive(Debug)]
struct ExternalResourceDns;

impl Resolve for ExternalResourceDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|address| external_dns_ip(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(std::io::Error::other("外部资源不能访问本机或内网地址").into());
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn external_dns_ip(ip: IpAddr) -> bool {
    // Trust the system network's TUN mapping for DNS answers in the Fake IP pool.
    // Literal URLs still require public_ip; the local proxy owns the final destination.
    public_ip(ip)
        || matches!(ip.to_canonical(), IpAddr::V4(ip) if matches!(ip.octets(), [198, 18 | 19, _, _]))
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
    preserve_source: bool,
}

const ASSET_ROW_QUERY: &str =
    "SELECT a.id,a.name,a.width,a.height,a.bytes,
            CASE WHEN j.status<>'completed' THEN j.status END,j.error,c.error,
            CASE WHEN l.uploaded_at IS NOT NULL AND l.deleted_at IS NULL THEN l.public_url END,
            COALESCE(a.source_key LIKE 'image-render:%',0)
     FROM assets a
     LEFT JOIN asset_locations l ON l.sha256=a.sha256 AND l.storage_profile_id=:profile
     LEFT JOIN jobs j ON j.id=(SELECT id FROM jobs WHERE kind='upload' AND sha256=a.sha256
        AND storage_profile_id=:profile ORDER BY created_at DESC, id DESC LIMIT 1)
     LEFT JOIN jobs c ON c.id=(SELECT id FROM jobs WHERE kind='cleanup' AND sha256=a.sha256
        AND status='failed' ORDER BY updated_at DESC, id DESC LIMIT 1)";

impl AssetRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            width: row.get(2)?,
            height: row.get(3)?,
            bytes: row.get(4)?,
            upload_status: row.get(5)?,
            upload_error: row.get(6)?,
            cleanup_error: row.get(7)?,
            public_url: row.get(8)?,
            preserve_source: row.get(9)?,
        })
    }
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
    pub(crate) async fn fetch_external_page(&self, url: &url::Url) -> Result<reqwest::Response> {
        if !is_http_image(url) || !has_public_image_host(url) {
            return Err(AppError::invalid("只能导入公网 HTTP 或 HTTPS 链接"));
        }
        self.external_http.get(url.clone())
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
            .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (compatible; Workbench Link Import)")
            .send().await
            .map_err(|_| AppError::new("LINK_NETWORK", "无法访问网页，请检查地址或网络后重试"))
    }

    pub fn new(root: PathBuf, db: &Workspace) -> Result<Self> {
        db.bind_assets_root(&root);
        db.write(|tx| {
            tx.execute(
                "UPDATE jobs SET status='retrying', error=NULL, updated_at=?1
                 WHERE kind='upload'
                   AND storage_profile_id=(SELECT value FROM app_settings WHERE key='image_storage_profile')
                   AND (status IN ('running','queued','retrying') OR (status='failed' AND (
                       error GLOB 'UPLOAD_CANCELLED:*' OR error GLOB 'UPLOAD_UNCERTAIN:*'
                       OR error IN ('上传已中断，可手动重试','退出时已取消，可手动重试')
                   )))",
                [now()],
            )?;
            Ok(())
        })?;
        let assets = Self {
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
                .dns_resolver(Arc::new(ExternalResourceDns))
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
        };
        assets.kick();
        Ok(assets)
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

    pub(crate) fn import_canvas(&self, db: &Workspace, name: &str, bytes: &[u8]) -> Result<String> {
        self.store_image(db, name, bytes, ImageOrigin::Canvas)
    }

    pub(crate) async fn normalize_canvas(&self, bytes:Vec<u8>)->Result<Vec<u8>> {
        remote_image::normalize(bytes).await
    }

    pub(crate) async fn read_canvas(&self,db:&Workspace,url:&str)->Result<Vec<u8>> {
        let mut bytes=self.read_canvas_original(db,url).await?;
        if canvas_orientation(&bytes)?==1 {return Ok(bytes);}
        if image_header(&bytes)?.0==ImageFormat::Jpeg {
            let mut cursor=2;
            while cursor+1<bytes.len() {
                if bytes[cursor]!=0xff {return Err(AppError::invalid("JPEG 图片标记无效"));}
                while cursor<bytes.len() && bytes[cursor]==0xff {cursor+=1;}
                let marker=*bytes.get(cursor).ok_or_else(||AppError::invalid("JPEG 图片标记不完整"))?;cursor+=1;
                if matches!(marker,0xda|0xd9){break;}
                if matches!(marker,0x01|0xd0..=0xd8){continue;}
                let length=bytes.get(cursor..cursor+2).map(|part|usize::from(u16::from_be_bytes([part[0],part[1]]))).ok_or_else(||AppError::invalid("JPEG 图片段不完整"))?;
                let end=cursor.checked_add(length).filter(|end|length>=2&&*end<=bytes.len()).ok_or_else(||AppError::invalid("JPEG 图片段长度无效"))?;
                if marker==0xe1 && length>=8 && bytes.get(cursor+2..cursor+8)==Some(b"Exif\0\0") {
                    let _=image::metadata::Orientation::remove_from_exif_chunk(&mut bytes[cursor+8..end]);
                }
                cursor=end;
            }
            if canvas_orientation(&bytes)?!=1 {return Err(AppError::invalid("无法读取图片原始方向"));}
            return Ok(bytes);
        }
        tokio::task::spawn_blocking(move || {
            let image=image::load_from_memory(&bytes).map_err(|error|AppError::new("IMAGE_FORMAT",format!("无法解码原图：{error}")))?;
            let mut output=Cursor::new(Vec::new());
            image.write_to(&mut output,ImageFormat::Png).map_err(|error|AppError::new("IMAGE_FORMAT",format!("无法读取原图像素：{error}")))?;
            Ok(output.into_inner())
        }).await.map_err(|error|AppError::new("IMAGE_FORMAT",format!("无法读取原图像素：{error}")))?
    }

    pub(crate) async fn read_canvas_original(&self, db:&Workspace, url:&str)->Result<Vec<u8>> {
        if !url.starts_with("asset://") { return self.read(db,url).await; }
        let mut file=db.read(|conn|by_url(conn,url))?;
        self.prepare_version_read(db,&file).await?;
        db.maintenance(|conn| {
            if let Some(hash)=&file.hash {version_cleanup::restore_for_read(conn,&self.root,hash)?;}
            conn.query_row("SELECT image_session_pin(?1)",[&file.id],|row|row.get::<_,bool>(0))?;
            Ok(())
        })?;
        file=db.read(|conn|by_url(conn,url))?;
        if file.path.is_none() {
            file.path=db.read(|conn|sync::snapshot(conn,&file.id)?.map(|snapshot|snapshot.relative()).transpose().map(Option::flatten))?;
            if let Some(path)=&file.path {db.save(|tx|{tx.execute("UPDATE assets SET relative_path=?2 WHERE id=?1 AND sha256=?3 AND relative_path IS NULL",params![file.id,path,file.hash])?;Ok(())})?;}
        }
        let hash=file.hash.as_deref().ok_or_else(||AppError::new("ASSET_MISSING","图片工程缺少原图"))?;
        if let Some(path)=&file.path {
            match tokio::fs::read(self.root.join(path)).await {
                Ok(bytes) if hex::encode(Sha256::digest(&bytes))==hash => { image_header(&bytes)?;return Ok(bytes); },
                Ok(_) => {},
                Err(error) if error.kind()==std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(local_error(error)),
            }
        }
        match self.read_synced_file(db,&file).await {
            Ok(Some(bytes))=>return Ok(bytes),
            Ok(None)=>{},
            Err(error)=>{if db.read(|conn|Ok(hosted_location(conn,&file)?.is_none()))? {return Err(error);}},
        }
        let bytes=self.read_remote_file(db,&file).await?;
        if hex::encode(Sha256::digest(&bytes))!=hash {return Err(AppError::new("ASSET_ORIGINAL_MISSING","图片工程需要原图，图床中的压缩图片不能替代原图"));}
        image_header(&bytes)?;
        if let Some(relative)=&file.path {self.cache_original(relative,&bytes)?;}
        Ok(bytes)
    }

    pub(crate) fn stage_canvas(&self, bytes: &[u8]) -> Result<CanvasFile> {
        let (format, width, height) = image_header(bytes)?;
        let hash = hex::encode(Sha256::digest(bytes));
        let relative = format!("{}/{}/{}.{}", &hash[..2], &hash[2..4], hash, format.extensions_str()[0]);
        let path = self.root.join(&relative);
        let parent = path.parent().expect("asset path has parent");
        std::fs::create_dir_all(parent).map_err(local_error)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(local_error)?;
        temporary.write_all(bytes).map_err(local_error)?;
        temporary.persist(&path).map_err(|error| local_error(error.error))?;
        Ok(CanvasFile { hash, relative, mime: format.to_mime_type().into(), bytes: bytes.len() as i64, width, height })
    }

    pub async fn fill(&self, db: &Workspace, asset_id: &str, bytes: Vec<u8>) -> Result<String> {
        let bytes = remote_image::normalize(bytes).await?;
        self.store_image(
            db,
            "公众号图片",
            &bytes,
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
            ImageOrigin::Canvas => ("original", None, None, false),
            ImageOrigin::ImportPlaceholder(id) => ("original", None, Some(id), false),
            ImageOrigin::Derived(key) => ("derived", Some(key), None, false),
        };
        let (format, width, height) = image_header(bytes)?;
        let hash = hex::encode(Sha256::digest(bytes));
        let relative = format!(
            "{}/{}/{}.{}",
            &hash[..2],
            &hash[2..4],
            hash,
            format.extensions_str()[0]
        );
        let asset_id = db.write(|tx| {
            let active = if kind == "original" && !matches!(origin, ImageOrigin::Canvas) { Profile::for_incoming_image(tx, expected)? } else { None };
            if let Some(placeholder) = placeholder
                && !cleanup::referenced(tx)?.0.contains(placeholder) {
                return Err(AppError::new("ASSET_UNUSED", "图片已不再被引用"));
            }
            let existing = tx.query_row(
                "SELECT id FROM assets WHERE sha256=?1 AND source_key IS ?2 AND kind=?3 ORDER BY created_at LIMIT 1",
                params![hash, source, kind], |r| r.get::<_, String>(0),
            ).optional()?;
            let path = self.root.join(&relative);
            let needs_write = match std::fs::read(&path) {
                Ok(stored) => hex::encode(Sha256::digest(&stored)) != hash,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => return Err(local_error(error)),
            };
            if needs_write {
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
            let has_screenshots: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM collection_nodes WHERE asset_id IS NOT NULL)",
                [], |row| row.get(0),
            )?;
            let (ids, hashes) = if has_screenshots {
                let (ids, hashes) = cleanup::entry_references(conn)?;
                (serde_json::json!(ids).to_string(), serde_json::json!(hashes).to_string())
            } else {
                ("[]".into(), "[]".into())
            };
            let visible = "WHERE NOT EXISTS (SELECT 1 FROM collection_nodes WHERE asset_id=a.id)
                 OR a.retain_on_exit=1
                 OR a.id IN (SELECT value FROM json_each(:ids))
                 OR a.sha256 IN (SELECT value FROM json_each(:hashes))
                 OR a.sha256 IN (SELECT sha256 FROM assets WHERE retain_on_exit=1)";
            let count: u32 = conn.query_row(&format!("SELECT COUNT(*) FROM assets a {visible}"),
                rusqlite::named_params! {":ids": ids, ":hashes": hashes}, |row| row.get(0))?;
            let last_page = count.saturating_sub(1) / PAGE_SIZE;
            let page = page.min(last_page);
            let mut query = conn.prepare(&format!(
                "{ASSET_ROW_QUERY} {visible} ORDER BY a.created_at DESC, a.id DESC LIMIT :limit OFFSET :offset",
            ))?;
            let items = query.query_map(rusqlite::named_params! {
                ":profile": active_id, ":limit": PAGE_SIZE, ":offset": page * PAGE_SIZE,
                ":ids": ids, ":hashes": hashes,
            }, AssetRow::from_row)?.collect::<rusqlite::Result<_>>()?;
            Ok(AssetLibrary { items, target: active.map(|p| p.target), page, has_next: page < last_page })
        })
    }

    pub fn detail(&self, db: &Workspace, asset_id: &str) -> Result<Option<AssetRow>> {
        db.read(|conn| {
            let active = Profile::active(conn)?;
            Ok(conn
                .query_row(
                    &format!("{ASSET_ROW_QUERY} WHERE a.id=:id"),
                    rusqlite::named_params! {
                        ":profile": active.as_ref().map(|profile| profile.id.as_str()),
                        ":id": asset_id,
                    },
                    AssetRow::from_row,
                )
                .optional()?)
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
        let bytes = self.read_without_session(db, &file).await?;
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
                    .is_some_and(|hash| hash == hex::encode(Sha256::digest(&bytes)))
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
        remote_image::normalize(bytes).await
    }

    async fn read_without_session(&self, db: &Workspace, file: &AssetFile) -> Result<Vec<u8>> {
        if let Some(relative)=&file.path {
            match tokio::fs::read(self.root.join(relative)).await {
                Ok(bytes)=>return Ok(bytes),
                Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{},
                Err(error)=>return Err(local_error(error)),
            }
        }
        let recovery=db.read(|conn|Ok(conn.query_row("SELECT state,backup_path,bytes FROM image_version_cleanup
            WHERE sha256=?1 AND state IN ('copying','removed','failed','expired') ORDER BY created_at DESC LIMIT 1",
            [file.hash.as_deref()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,i64>(2)?))).optional()?))?;
        if let Some((state,backup,size))=recovery {
            if state=="expired" {return Err(AppError::new("IMAGE_VERSION_EXPIRED","旧版图片已超过回收保留期"));}
            if let Some(backup)=backup {
                let bytes=tokio::fs::read(self.root.join(backup)).await.map_err(local_error)?;
                if bytes.len() as i64!=size || Some(hex::encode(Sha256::digest(&bytes)))!=file.hash {
                    return Err(AppError::new("IMAGE_CLEANUP_CHANGED","图片回收副本校验失败"));
                }
                return Ok(bytes);
            }
        }
        self.read_remote_file(db,file).await
    }

    pub(super) async fn read_file(&self, db: &Workspace, file: &AssetFile) -> Result<Vec<u8>> {
        self.prepare_version_read(db,file).await?;
        let current=db.read(|conn|by_id(conn,&file.id))?;
        let file=&current;
        if let Some(hash) = &file.hash {
            let restored = db.maintenance(|conn| {
                let restored=version_cleanup::restore_for_read(conn, &self.root, hash)?;
                conn.query_row("SELECT image_session_pin(?1)",[&file.id],|row|row.get::<_,bool>(0))?;
                Ok(restored)
            })?;
            if restored {
                let current = db.read(|conn| by_id(conn, &file.id))?;
                let relative = current.path.ok_or_else(|| AppError::new("ASSET_MISSING", "恢复后的图片缺少本地路径"))?;
                return tokio::fs::read(self.root.join(relative)).await.map_err(local_error);
            }
        }
        if let Some(relative) = &file.path {
            match tokio::fs::read(self.root.join(relative)).await {
                Ok(data) => return Ok(data),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(local_error(error)),
            }
        }
        self.read_remote_file(db,file).await
    }

    async fn prepare_version_read(&self,db:&Workspace,file:&AssetFile)->Result<()> {
        let Some(hash)=file.hash.as_deref() else{return Ok(());};
        let local=db.maintenance(|conn|version_cleanup::restore_for_read(conn,&self.root,hash));
        if local.as_ref().is_ok_and(|restored|*restored) {return Ok(());}
        if let Some(relative)=&file.path && self.root.join(relative).try_exists().map_err(local_error)? {return Ok(());}
        let known=db.read(|conn|Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM image_gc_remote g JOIN sync_binding b ON b.instance_id=g.instance_id AND b.epoch=g.epoch WHERE g.sha256=?1 AND g.payload_json->>'$.backend'='private')",[hash],|row|row.get::<_,bool>(0))?))?;
        if !known {local?;return Ok(());}
        crate::sync::contents::restore_image_blob(db,hash).await?;
        let snapshot=db.read(|conn|sync::snapshot(conn,&file.id))?.ok_or_else(||AppError::new("ASSET_MISSING","图片记录已不存在"))?;
        let relative=snapshot.relative()?.ok_or_else(||AppError::new("ASSET_MISSING","图片缺少文件路径"))?;
        let bytes=crate::sync::synced_blob(db,hash,snapshot.bytes.ok_or_else(||AppError::new("ASSET_MISSING","图片缺少大小记录"))?).await?;
        self.cache_original(&relative,&bytes)?;
        db.maintenance(|conn|{conn.execute("UPDATE assets SET relative_path=?2 WHERE sha256=?1",params![hash,relative])?;conn.execute("UPDATE image_version_cleanup SET state='restored',error=NULL WHERE sha256=?1 AND state IN ('expired','removed','failed','copying')",[hash])?;Ok(())})
    }

    async fn read_remote_file(&self, db: &Workspace, file: &AssetFile) -> Result<Vec<u8>> {
        let hosted = db.read(|conn| {
            hosted_location(conn, file)?
                .map(|location| Ok((Profile::read(conn, &location.profile_id)?, location)))
                .transpose()
        })?;
        let Some((profile, location)) = hosted else {
            return self
                .read_synced_file(db, file)
                .await?
                .ok_or_else(|| AppError::new("ASSET_MISSING", "找不到本地图片或可用的远端副本"));
        };
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
        if hex::encode(Sha256::digest(&bytes)) != location.content_hash {
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
        let bytes = self.read_without_session(db, &upload.file).await?;
        let options = upload.options.clone();
        let (format, bytes) = tokio::task::spawn_blocking(move || options.encode(bytes))
            .await
            .map_err(|error| AppError::new("IMAGE_FORMAT", error.to_string()))??;
        let mut key = name_for_format(&upload.key, format);
        let content_hash = hex::encode(Sha256::digest(&bytes));
        let derived=db.read(|conn|Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM assets a JOIN image_renders r ON r.output_asset_id=a.id WHERE a.id=?1 AND a.source_key='image-render:'||r.id)",[&upload.file.id],|row|row.get::<_,bool>(0))?))?;
        let hash=upload.file.hash.as_deref().expect("upload hash");
        let previous=if derived && upload.registered {version_cleanup::s3::registered(db,&upload.profile,hash,&upload.key)?}else{None};
        let managed=if derived && (!upload.registered || version_cleanup::s3::is_managed(db,&upload.profile,hash,&upload.key)?) {
            // Reuse only the never-admitted uploading identity with the same actual bytes.
            let previous=if let Some(previous)=previous {
                let same=db.read(|conn|Ok(conn.query_row("SELECT content_sha256=?2 FROM image_public_copies WHERE id=?1",params![previous.id,content_hash],|r|r.get::<_,bool>(0))?))?;
                if same {Some(previous)}else{version_cleanup::s3::resolve_upload(db,&upload.profile,&previous).await?;None}
            } else {None};
            let value=if let Some(previous)=previous {previous}else{
                version_cleanup::s3::reserve(db,&upload.profile,hash,&content_hash,bytes.len(),format.extensions_str()[0]).await?
            };
            key=value.key.clone().into();Some(value)
        } else {None};
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
                if upload.registered && key != upload.key && !version_cleanup::s3::is_managed(db,&upload.profile,hash,&upload.key)? {
                    store.delete(&upload.key).await?;
                }
                register_target(db, upload, &key, &content_hash)?;
                if let Some(managed)=managed {
                    let version=version_cleanup::s3::put(&store,&managed,format.to_mime_type(),bytes.clone()).await?;
                    let readback=store.get(&key).await?;
                    if readback!=bytes {return Err(AppError::new("IMAGE_CLEANUP_CHANGED","图床上传回读与原数据不一致"));}
                    version_cleanup::s3::committed(db,&managed,version).await
                } else {store.put(&key, format.to_mime_type(), bytes).await}
            } => result,
            () = self.uploads_stopped.cancelled() => Err(AppError::new("UPLOAD_UNCERTAIN", "退出前上传未结束，可手动重试")),
        }
    }

    pub fn spawn(app: AppHandle) {
        Self::spawn_version_cleanup(app.clone());
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

pub(crate) fn canvas_orientation(bytes:&[u8])->Result<u8>{
    let (format,_,_)=image_header(bytes)?;
    let mut decoder=ImageReader::with_format(Cursor::new(bytes),format).into_decoder().map_err(|error|AppError::new("IMAGE_FORMAT",format!("无法读取图片方向：{error}")))?;
    decoder.orientation().map(|orientation|orientation.to_exif()).map_err(|error|AppError::new("IMAGE_FORMAT",format!("无法读取图片方向：{error}")))
}

pub(crate) fn image_header(bytes: &[u8]) -> Result<(ImageFormat, u32, u32)> {
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
        "SELECT id,sha256,relative_path FROM assets WHERE id=?1
         UNION ALL SELECT output_asset_id,sha256,relative_path FROM image_render_staging WHERE output_asset_id=?1
         AND NOT EXISTS(SELECT 1 FROM assets WHERE id=?1) LIMIT 1",
        [id],
        file_row,
    )?)
}

pub(crate) fn canvas_output_id(conn: &Connection, value: &str) -> Result<Option<String>> {
    let Ok(url) = url::Url::parse(value) else {
        return Ok(None);
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Ok(None);
    }
    let Some(id) = url
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("wcb-image="))
    else {
        return Ok(None);
    };
    if !crate::sync::valid_id(id) {
        return Err(AppError::invalid("图片工程标识无效"));
    }
    let asset = conn
        .query_row(
            "SELECT a.id FROM assets a JOIN image_renders r ON r.output_asset_id=a.id WHERE a.id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    asset.map(Some).ok_or_else(|| {
        AppError::invalid("图片工程尚未同步完成或已不可用，请同步完成后重试")
    })
}

fn by_url(conn: &Connection, url: &str) -> Result<AssetFile> {
    if let Some(id) = url.strip_prefix("asset://") {
        return by_id(conn, id);
    }
    if let Some(id) = canvas_output_id(conn, url)? {
        return by_id(conn, &id);
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
