use super::{
    AssetLibrary, Assets,
    s3::{Secret, Target},
};
use crate::db::{AppError, Result, Workspace};
use crate::wechat_import::Imports;
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
) -> Result<()> {
    assets.configure(&db, target, secret)?;
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
