use crate::db::{AppError, Result, Workspace};
use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    phase: Phase,
    version: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Ready,
    Installing,
}

#[derive(Default)]
struct Package {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct AppUpdater {
    status: Mutex<UpdateStatus>,
    package: AsyncMutex<Package>,
}

impl AppUpdater {
    fn change(&self, app: &AppHandle, edit: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
        let mut status = self.status.lock().expect("update status lock poisoned");
        edit(&mut status);
        let view = status.clone();
        if let Err(error) = app.emit_to("main", "app-update-changed", &view) {
            eprintln!("Could not send update status: {error}");
        }
        view
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    platform: &'static str,
    arch: &'static str,
    updates_enabled: bool,
}

fn configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|value| value.as_str())
        .is_some_and(|key| !key.is_empty())
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        updates_enabled: configured(&app),
    }
}

#[tauri::command]
pub fn app_update_status(updater: State<'_, AppUpdater>) -> UpdateStatus {
    updater
        .status
        .lock()
        .expect("update status lock poisoned")
        .clone()
}

fn update_error(error: impl std::fmt::Display) -> AppError {
    AppError::new("APP_UPDATE", format!("应用更新失败：{error}"))
}

fn newer_stable(current: &semver::Version, candidate: &semver::Version) -> bool {
    candidate.pre.is_empty() && candidate > current
}

#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    updater: State<'_, AppUpdater>,
) -> Result<UpdateStatus> {
    let mut package = updater
        .package
        .try_lock()
        .map_err(|_| update_error("更新操作正在进行"))?;
    if package.bytes.is_some() {
        return Ok(app_update_status(updater.clone()));
    }
    if !configured(&app) {
        return Err(update_error("当前构建未配置更新签名"));
    }
    updater.change(&app, |status| {
        *status = UpdateStatus {
            phase: Phase::Checking,
            ..Default::default()
        }
    });
    let result = async {
        app.updater_builder()
            .timeout(Duration::from_secs(30))
            .version_comparator(|current, release| newer_stable(&current, &release.version))
            .build()?
            .check()
            .await
    }
    .await;
    match result {
        Ok(mut update) => {
            if let Some(update) = update.as_mut() {
                update.timeout = Some(Duration::from_secs(300));
            }
            if let Some(update) = &update
                && update.download_url.scheme() != "https"
            {
                let error = update_error("更新包必须使用 HTTPS 下载地址");
                updater.change(&app, |status| {
                    status.phase = Phase::Idle;
                    status.error = Some(error.to_string());
                });
                return Err(error);
            }
            let view = updater.change(&app, |status| {
                status.phase = if update.is_some() {
                    Phase::Available
                } else {
                    Phase::Current
                };
                status.version = update.as_ref().map(|item| item.version.clone());
            });
            package.update = update;
            Ok(view)
        }
        Err(error) => {
            updater.change(&app, |status| {
                status.phase = Phase::Idle;
                status.error = Some(error.to_string());
            });
            Err(update_error(error))
        }
    }
}

#[tauri::command]
pub async fn app_update_download(
    app: AppHandle,
    updater: State<'_, AppUpdater>,
) -> Result<UpdateStatus> {
    let mut package = updater
        .package
        .try_lock()
        .map_err(|_| update_error("更新操作正在进行"))?;
    let update = package
        .update
        .as_ref()
        .ok_or_else(|| update_error("请先检查更新"))?;
    if package.bytes.is_some() {
        return Ok(app_update_status(updater.clone()));
    }
    updater.change(&app, |status| {
        status.phase = Phase::Downloading;
        status.error = None;
        status.downloaded = 0;
        status.total = None;
    });
    match update
        .download(
            |bytes, total| {
                updater.change(&app, |status| {
                    status.downloaded += bytes as u64;
                    status.total = total;
                });
            },
            || {},
        )
        .await
    {
        Ok(bytes) => {
            package.bytes = Some(bytes);
            Ok(updater.change(&app, |status| status.phase = Phase::Ready))
        }
        Err(error) => {
            updater.change(&app, |status| {
                status.phase = Phase::Available;
                status.error = Some(error.to_string());
            });
            Err(update_error(error))
        }
    }
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    updater: State<'_, AppUpdater>,
    db: State<'_, Workspace>,
    assets: State<'_, crate::assets::Assets>,
) -> Result<()> {
    let package = updater
        .package
        .try_lock()
        .map_err(|_| update_error("更新操作正在进行"))?;
    let update = package
        .update
        .as_ref()
        .ok_or_else(|| update_error("请先下载更新"))?;
    let bytes = package
        .bytes
        .as_ref()
        .ok_or_else(|| update_error("更新包尚未下载并校验"))?;
    db.prepare_update_install()?;
    #[cfg(windows)]
    {
        use tauri_plugin_window_state::{AppHandleExt, StateFlags};
        app.save_window_state(
            StateFlags::all().difference(StateFlags::DECORATIONS | StateFlags::VISIBLE),
        )
        .map_err(update_error)?;
    }
    updater.change(&app, |status| {
        status.phase = Phase::Installing;
        status.error = None;
    });
    if let Err(error) = assets.cleanup_for_update(&db).await {
        eprintln!("素材清理失败：{error}");
    }
    // Windows exits inside install after the installer has started. macOS restarts below.
    db.finish_exit();
    if let Err(error) = update.install(bytes) {
        db.cancel_exit();
        updater.change(&app, |status| {
            status.phase = Phase::Ready;
            status.error = Some(error.to_string());
        });
        return Err(update_error(error));
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_only_to_newer_stable_semantic_versions() {
        let current = semver::Version::parse("1.9.0").unwrap();
        for (version, expected) in [
            ("1.10.0", true),
            ("2.0.0", true),
            ("1.9.0", false),
            ("1.8.9", false),
            ("2.0.0-rc.1", false),
        ] {
            assert_eq!(
                newer_stable(&current, &semver::Version::parse(version).unwrap()),
                expected
            );
        }
    }

    #[test]
    fn installer_requires_saved_workspace_and_can_return_to_editing_after_failure() {
        let directory = tempfile::tempdir().unwrap();
        let db = Workspace::open(&directory.path().join("workspace.db")).unwrap();
        assert_eq!(
            db.prepare_update_install().unwrap_err().code(),
            "UPDATE_PHASE"
        );
        db.begin_exit();
        db.prepare_update_install().unwrap();
        db.finish_exit();
        assert!(db.exit_committed());
        db.cancel_exit();
        assert!(!db.exit_committed());
        db.set_setting("update-test", &true).unwrap();
        assert_eq!(db.setting::<bool>("update-test").unwrap(), Some(true));
    }
}
