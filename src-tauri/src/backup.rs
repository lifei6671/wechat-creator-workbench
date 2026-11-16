mod migration;
mod restore;
mod store;

use crate::{
    assets::Assets,
    db::{AppError, Result, Workspace, id, now, workspace_id},
    wechat_import::Imports,
};
use restore::{Files, PendingRestore, RestoreNotice, file_error};
use serde::Serialize;
use std::path::Path;
use store::{Backup, Secret, Settings, Target, UploadResult};
use tauri::{AppHandle, Emitter, State};
use tempfile::NamedTempFile;
use tokio::sync::Mutex;

pub struct Backups {
    files: Files,
    prepared: Mutex<Option<(String, PendingRestore)>>,
    notice: Option<RestoreNotice>,
}

impl Backups {
    pub fn open(root: &Path) -> Result<(Workspace, Self)> {
        let files = Files::new(root)?;
        let (db, notice) = files.open()?;
        Ok((
            db,
            Self {
                files,
                prepared: Mutex::new(None),
                notice,
            },
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettings {
    #[serde(flatten)]
    settings: Settings,
    current_workspace: String,
}

fn progress(app: &AppHandle, stage: &'static str) {
    let _ = app.emit_to("main", "backup-progress", stage);
}

#[tauri::command]
pub fn backup_settings(db: State<'_, Workspace>) -> Result<BackupSettings> {
    Ok(BackupSettings {
        settings: store::settings(&db)?,
        current_workspace: db.read(workspace_id)?,
    })
}

#[tauri::command]
pub fn backup_configure(
    db: State<'_, Workspace>,
    target: Target,
    secret: Option<Secret>,
) -> Result<()> {
    store::configure(&db, target, secret)
}

#[tauri::command]
pub fn backup_use_image_storage(db: State<'_, Workspace>) -> Result<()> {
    let profile = db
        .read(crate::assets::s3::Profile::active)?
        .ok_or_else(|| AppError::invalid("请先启用 S3 图床"))?;
    let secret = profile.secret()?;
    let target = profile.target;
    store::configure(
        &db,
        Target {
            endpoint: target.endpoint,
            region: target.region,
            bucket: target.bucket,
            prefix: target.prefix,
        },
        Some(secret),
    )
}

#[tauri::command]
pub async fn backup_workspaces(db: State<'_, Workspace>) -> Result<Vec<String>> {
    store::store(&db)?.workspaces().await
}

#[tauri::command]
pub async fn backup_list(db: State<'_, Workspace>, workspace: String) -> Result<Vec<Backup>> {
    store::store(&db)?.list(&workspace).await
}

#[tauri::command]
pub async fn backup_create(
    app: AppHandle,
    db: State<'_, Workspace>,
    backups: State<'_, Backups>,
) -> Result<UploadResult> {
    let _operation = backups.prepared.lock().await;
    let workspace = db.read_running(workspace_id)?;
    let store = store::store(&db)?;
    progress(&app, "snapshot");
    let source = backups.files.database.clone();
    let stage = backups.files.stage.clone();
    let worker_workspace = workspace.clone();
    let file = tokio::task::spawn_blocking(move || {
        let file = NamedTempFile::new_in(stage)
            .map_err(file_error)?
            .into_temp_path();
        restore::make_snapshot(&source, &file, &worker_workspace)?;
        Ok::<_, AppError>(file)
    })
    .await
    .map_err(|error| AppError::new("BACKUP_SNAPSHOT", error.to_string()))??;
    progress(&app, "upload");
    let result = store.upload(&workspace, &file).await?;
    db.maintenance(|tx| {
        tx.execute(
            "INSERT INTO backup_records VALUES (?1,'backup',?2,'completed',?3,?4)",
            rusqlite::params![id(), result.backup.name, result.warning, now()],
        )?;
        Ok(())
    })?;
    Ok(result)
}

#[tauri::command]
pub async fn backup_prepare_restore(
    app: AppHandle,
    db: State<'_, Workspace>,
    backups: State<'_, Backups>,
    workspace: String,
    name: String,
) -> Result<String> {
    let mut prepared = backups.prepared.lock().await;
    db.read_running(|_| Ok(()))?;
    let store = store::store(&db)?;
    let file = NamedTempFile::new_in(&backups.files.stage)
        .map_err(file_error)?
        .into_temp_path();
    progress(&app, "download");
    store.download(&workspace, &name, &file).await?;
    progress(&app, "validate");
    let incoming = backups.files.incoming.clone();
    let pending = tokio::task::spawn_blocking(move || {
        let pending = PendingRestore {
            workspace,
            name,
            migration: None,
        };
        restore::prepare_file(&file, &pending)?;
        file.persist(&incoming)
            .map_err(|error| file_error(error.error))?;
        Ok::<_, AppError>(pending)
    })
    .await
    .map_err(|error| AppError::new("BACKUP_VALIDATE", error.to_string()))??;
    let ticket = id();
    if let Some((_, previous)) = prepared.replace((ticket.clone(), pending)) {
        backups.files.discard_migration(&previous);
    }
    Ok(ticket)
}

#[tauri::command]
pub async fn backup_discard_restore(backups: State<'_, Backups>, ticket: String) -> Result<()> {
    let mut prepared = backups.prepared.lock().await;
    if let Some((current, pending)) = prepared.as_ref()
        && current == &ticket
    {
        std::fs::remove_file(&backups.files.incoming).map_err(file_error)?;
        backups.files.discard_migration(pending);
        *prepared = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn backup_export_workspace(
    app: AppHandle,
    db: State<'_, Workspace>,
    backups: State<'_, Backups>,
    preferences: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<Option<String>> {
    let _guard = backups.prepared.lock().await;
    let workspace = db.read_running(workspace_id)?;
    let Some(path) = crate::assets::publishing::destination(
        &app,
        "工作区迁移包",
        "zip",
        "微信创作工作台-迁移.zip",
    )
    .await?
    else {
        return Ok(None);
    };
    let database = backups.files.database.clone();
    let stage = backups.files.stage.clone();
    let saved = tokio::task::spawn_blocking(move || {
        migration::export(&database, &stage, &workspace, &path, &preferences)?;
        Ok::<_, AppError>(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| AppError::new("MIGRATION_EXPORT", error.to_string()))??;
    Ok(Some(saved))
}

#[tauri::command]
pub fn backup_take_preferences(
    db: State<'_, Workspace>,
) -> Result<Option<std::collections::BTreeMap<String, serde_json::Value>>> {
    use rusqlite::OptionalExtension;
    db.write(|tx| {
        let value: Option<String> = tx
            .query_row(
                "SELECT value FROM app_settings WHERE key='migration_preferences'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(value) = value else {
            return Ok(None);
        };
        tx.execute(
            "DELETE FROM app_settings WHERE key='migration_preferences'",
            [],
        )?;
        serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| AppError::invalid("迁移的界面设置无效"))
    })
}

#[tauri::command]
pub async fn backup_import_workspace(
    app: AppHandle,
    db: State<'_, Workspace>,
    backups: State<'_, Backups>,
) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    db.read_running(|_| Ok(()))?;
    let mut prepared = backups.prepared.lock().await;
    let dialog = app.dialog().file().add_filter("工作区迁移包", &["zip"]);
    let Some(path) = tokio::task::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|error| AppError::new("MIGRATION_IMPORT", error.to_string()))?
    else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|error| AppError::new("MIGRATION_IMPORT", error.to_string()))?;
    let stage = backups.files.stage.clone();
    let incoming = backups.files.incoming.clone();
    let pending = tokio::task::spawn_blocking(move || migration::prepare(&path, &stage, &incoming))
        .await
        .map_err(|error| AppError::new("MIGRATION_IMPORT", error.to_string()))??;
    let ticket = id();
    if let Some((_, old)) = prepared.replace((ticket.clone(), pending)) {
        backups.files.discard_migration(&old);
    }
    Ok(Some(ticket))
}

#[tauri::command]
pub async fn backup_commit_restore(
    app: AppHandle,
    backups: State<'_, Backups>,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    imports: State<'_, Imports>,
    ticket: String,
) -> Result<()> {
    let prepared = backups.prepared.lock().await;
    let (_, pending) = prepared
        .as_ref()
        .filter(|(current, _)| current == &ticket)
        .ok_or_else(|| AppError::new("BACKUP_PREPARED", "请重新下载并校验要恢复的快照"))?;
    tokio::join!(assets.wait_uploads(), imports.wait_idle());
    let mut marked = false;
    if let Err(error) = db.close_for_restore(|| {
        backups.files.write_marker(pending)?;
        marked = true;
        Ok(())
    }) {
        if marked {
            backups.files.discard_marker()?;
        }
        return Err(error);
    }
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub fn backup_restore_notice(backups: State<'_, Backups>) -> Option<RestoreNotice> {
    backups.notice.clone()
}
