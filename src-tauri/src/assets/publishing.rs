use super::{
    AssetFile, Assets, by_url, enqueue, image_header, local_error, publication_file, s3::Profile,
};
use crate::db::{AppError, Result, Workspace};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::{borrow::Cow, collections::BTreeMap, io::Write, path::Path, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use zip::{ZipWriter, write::SimpleFileOptions};

#[tauri::command]
pub fn wechat_graphics(markdown: String) -> Vec<super::references::DerivedSource> {
    super::references::derived_sources(&markdown)
}

#[derive(Serialize)]
pub struct ImageInfo {
    id: String,
    name: String,
}

impl Assets {
    pub async fn public_image(&self, db: &Workspace, url: &str) -> Result<String> {
        let upload = db.write(|tx| {
            let Some(file) = publication_file(tx, url)? else {
                return Ok(None);
            };
            let hash = file
                .hash
                .ok_or_else(|| AppError::new("ASSET_MISSING", "图片尚未下载"))?;
            let profile =
                Profile::active(tx)?.ok_or_else(|| AppError::invalid("请先配置 S3 图床"))?;
            enqueue(tx, &file.id, &hash, &profile.id, true)?;
            Ok(Some((profile.id, hash)))
        })?;
        let Some((profile, hash)) = upload else {
            return Ok(url.to_owned());
        };
        let mut status = self.activity.subscribe();
        self.kick();
        let public = tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let (public, failure) = db.read_running(|conn| {
                    if Profile::active(conn)?.as_ref().map(|p| p.id.as_str()) != Some(profile.as_str()) {
                        return Err(AppError::new("S3_CHANGED", "图床配置已变更，请重新复制"));
                    }
                    let public = conn.query_row(
                        "SELECT public_url FROM asset_locations WHERE sha256=?1 AND storage_profile_id=?2 AND uploaded_at IS NOT NULL AND deleted_at IS NULL",
                        params![hash,profile], |r| r.get::<_,String>(0),
                    ).optional()?;
                    let failed = conn.query_row(
                        "SELECT error FROM jobs WHERE kind='upload' AND sha256=?1 AND storage_profile_id=?2 AND status='failed' ORDER BY updated_at DESC LIMIT 1",
                        params![hash,profile], |r| r.get::<_,String>(0),
                    ).optional()?;
                    Ok((public,failed))
                })?;
                if let Some(public) = public { return Ok(public); }
                if let Some(error) = failure { return Err(AppError::new("S3_UPLOAD",error)); }
                status.changed().await.expect("workspace owns the asset activity sender");
            }
        }).await.map_err(|_| AppError::new("S3_TIMEOUT","图片仍在上传，请稍后重试"))??;
        let bytes = self.read_public(&public).await?;
        use sha2::{Digest, Sha256};
        if format!("{:x}", Sha256::digest(bytes)) != hash {
            return Err(AppError::new("S3_PUBLIC", "公开地址返回的图片与素材不一致"));
        }
        Ok(public)
    }
}

fn image_name(file: &AssetFile) -> Result<String> {
    file.path
        .as_deref()
        .and_then(|path| Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| AppError::new("ASSET_MISSING", "图片尚未下载"))
}

pub async fn destination(
    app: &AppHandle,
    kind: &str,
    suffix: &str,
    name: &str,
) -> Result<Option<std::path::PathBuf>> {
    let dialog = app
        .dialog()
        .file()
        .add_filter(kind, &[suffix])
        .set_file_name(name);
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| AppError::new("EXPORT_FAILED", e.to_string()))?
        .map(|path| {
            path.into_path()
                .map_err(|e| AppError::new("EXPORT_FAILED", e.to_string()))
        })
        .transpose()
}

#[tauri::command]
pub async fn asset_derive(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    kind: String,
    source: String,
    png: Vec<u8>,
) -> Result<String> {
    let id = assets.derive(&db, &kind, &source, &png)?;
    let _ = app.emit("assets-changed", ());
    Ok(id)
}

#[tauri::command]
pub async fn asset_info(db: State<'_, Workspace>, url: String) -> Result<Option<ImageInfo>> {
    db.read(|conn| {
        publication_file(conn, &url)?
            .map(|file| {
                let name = image_name(&file)?;
                Ok(ImageInfo { id: file.id, name })
            })
            .transpose()
    })
}

#[tauri::command]
pub async fn asset_public(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    url: String,
) -> Result<String> {
    assets.public_image(&db, &url).await
}

#[tauri::command]
pub async fn asset_copy_image(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    url: String,
) -> Result<()> {
    let bytes = assets.read(&db, &url).await?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| AppError::new("IMAGE_FORMAT", e.to_string()))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    arboard::Clipboard::new()
        .and_then(|mut clipboard| {
            clipboard.set_image(arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::Owned(image.into_raw()),
            })
        })
        .map_err(|e| AppError::new("CLIPBOARD", format!("无法复制图片：{e}")))
}

#[tauri::command]
pub async fn asset_save_image(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    url: String,
) -> Result<bool> {
    let (name, bytes) = match db.read(|conn| by_url(conn, &url)) {
        Ok(file) => (image_name(&file)?, assets.read_file(&db, &file).await?),
        Err(error) if error.code() == "NOT_FOUND" => {
            let bytes = assets.read(&db, &url).await?;
            let (format, ..) = image_header(&bytes)?;
            (format!("图片.{}", format.extensions_str()[0]), bytes)
        }
        Err(error) => return Err(error),
    };
    let extension = name.rsplit_once('.').expect("asset file has extension").1;
    let Some(path) = destination(&app, "图片", extension, &name).await? else {
        return Ok(false);
    };
    std::fs::write(path, bytes).map_err(local_error)?;
    Ok(true)
}

#[tauri::command]
pub async fn wechat_export_html(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    html: String,
    urls: Vec<String>,
) -> Result<bool> {
    let files = db.read(|conn| {
        let mut files = BTreeMap::new();
        for url in urls {
            if let Some(file) = publication_file(conn, &url)? {
                files.insert(image_name(&file)?, file);
            }
        }
        Ok(files)
    })?;
    if files.is_empty() {
        let Some(path) = destination(&app, "HTML", "html", "article.html").await? else {
            return Ok(false);
        };
        std::fs::write(path, html).map_err(local_error)?;
        return Ok(true);
    }
    let Some(path) = destination(&app, "HTML 和图片", "zip", "article-html.zip").await? else {
        return Ok(false);
    };
    let mut output = tempfile::NamedTempFile::new_in(path.parent().expect("save path is absolute"))
        .map_err(local_error)?;
    let mut zip = ZipWriter::new(output.as_file_mut());
    let options = SimpleFileOptions::default();
    let zip_error =
        |error: zip::result::ZipError| AppError::new("EXPORT_FAILED", error.to_string());
    zip.start_file("article.html", options).map_err(zip_error)?;
    zip.write_all(html.as_bytes()).map_err(local_error)?;
    for (name, file) in files {
        let bytes = assets.read_file(&db, &file).await?;
        zip.start_file(format!("assets/{name}"), options)
            .map_err(zip_error)?;
        zip.write_all(&bytes).map_err(local_error)?;
    }
    zip.finish().map_err(zip_error)?;
    output
        .persist(path)
        .map_err(|error| local_error(error.error))?;
    Ok(true)
}
