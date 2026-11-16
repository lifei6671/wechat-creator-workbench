use super::{
    AssetLibrary, Assets,
    s3::{Secret, Target},
    upload_format::UploadOptions,
};
use crate::db::{AppError, Result, Workspace};
use crate::wechat_import::Imports;
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, State,
    ipc::{InvokeBody, Request, Response},
};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn asset_import(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    request: Request<'_>,
) -> Result<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::invalid("请发送图片文件字节"));
    };
    let name = request
        .headers()
        .get("x-asset-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let encoded = format!("name={name}");
    let (_, name) = url::form_urlencoded::parse(encoded.as_bytes())
        .next()
        .expect("name parameter is present");
    let id = if request
        .headers()
        .get("x-asset-origin")
        .is_some_and(|value| value == "library")
    {
        assets.import_to_library(&db, &name, bytes)?
    } else {
        assets.import(&db, &name, bytes)?
    };
    let _ = app.emit("assets-changed", ());
    Ok(id)
}

#[tauri::command]
pub async fn asset_library(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
) -> Result<AssetLibrary> {
    assets.library(&db)
}

#[tauri::command]
pub async fn asset_thumbnail(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    id: String,
) -> Result<Response> {
    Ok(Response::new(assets.thumbnail(&db, &id).await?))
}

#[tauri::command]
pub async fn asset_read(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    imports: State<'_, Imports>,
    url: String,
    retry: Option<bool>,
) -> Result<Response> {
    if retry == Some(true)
        && let Some(id) = url.strip_prefix("asset://")
        && imports.retry_asset(&db, &assets, id).await?
    {
        let _ = app.emit("assets-changed", ());
    }
    Ok(Response::new(assets.read(&db, &url).await?))
}

#[tauri::command]
pub async fn asset_localize_image(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    url: String,
) -> Result<String> {
    let localized = assets.localize(&db, &url).await?;
    if localized != url {
        let _ = app.emit("assets-changed", ());
    }
    Ok(localized)
}

#[tauri::command]
pub async fn asset_upload(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    id: String,
) -> Result<()> {
    assets.upload(&db, &id)?;
    let _ = app.emit("assets-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn image_storage_save(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    target: Option<Target>,
    secret: Option<Secret>,
    options: Option<UploadOptions>,
) -> Result<()> {
    assets.configure(&db, target, secret, options)?;
    assets.kick();
    let _ = app.emit("assets-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn image_storage_test(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    target: Target,
    secret: Option<Secret>,
) -> Result<()> {
    assets.test(&db, target, secret).await
}

#[derive(Serialize)]
pub struct ImageStorageSettings {
    target: Option<Target>,
    enabled: bool,
    secret: Option<Secret>,
    options: UploadOptions,
}

#[tauri::command]
pub fn image_storage_target(db: State<'_, Workspace>) -> Result<Option<Target>> {
    Ok(db
        .read(super::s3::Profile::active)?
        .map(|profile| profile.target))
}

#[tauri::command]
pub fn image_storage_settings(
    window: tauri::WebviewWindow,
    db: State<'_, Workspace>,
) -> Result<ImageStorageSettings> {
    if window.label() != "main" {
        return Err(AppError::invalid("请在主窗口打开图床设置"));
    }
    let (profile, enabled) = Assets::settings_profile(&db)?;
    let secret = profile.as_ref().and_then(|profile| profile.secret().ok());
    let options = match &profile {
        Some(profile) => db.read(|conn| profile.upload_options(conn))?,
        None => UploadOptions::default(),
    };
    Ok(ImageStorageSettings {
        target: profile.map(|profile| profile.target),
        enabled,
        secret,
        options,
    })
}

#[tauri::command]
pub async fn asset_host_image(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    url: String,
    target: Target,
) -> Result<String> {
    db.read(|conn| super::s3::Profile::active_for(conn, Some(&target)))?;
    let localized = if url.starts_with("asset://") {
        url
    } else {
        assets.localize_for(&db, &url, Some(&target)).await?
    };
    let hosted = assets
        .public_image_for(&db, &localized, Some(&target))
        .await?;
    let _ = app.emit("assets-changed", ());
    Ok(hosted)
}

#[tauri::command]
pub async fn asset_export(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    id: String,
) -> Result<bool> {
    let dialog = app
        .dialog()
        .file()
        .add_filter("Markdown ZIP", &["zip"])
        .set_file_name("article.zip");
    let destination = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|error| AppError::new("EXPORT_FAILED", error.to_string()))?;
    let Some(destination) = destination else {
        return Ok(false);
    };
    let path = destination
        .into_path()
        .map_err(|e| AppError::new("EXPORT_FAILED", e.to_string()))?;
    assets.export(&db, &id, &path).await?;
    Ok(true)
}

#[tauri::command]
pub fn cancel_asset_cleanup(assets: State<'_, Assets>) {
    assets.cancel_cleanup();
}
