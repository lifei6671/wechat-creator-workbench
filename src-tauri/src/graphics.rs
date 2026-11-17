use crate::db::{AppError, Result};
use std::{
    fs::{self, File},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

fn marker_path(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("disable-webview-gpu"))
        .map_err(|error| AppError::new("SETTINGS", format!("无法找到图形设置目录：{error}")))
}

fn gpu_preference(marker: &Path, enabled: Option<bool>) -> io::Result<bool> {
    match enabled {
        None => Ok(!marker.try_exists()?),
        Some(false) => {
            File::create(marker)?;
            Ok(false)
        }
        Some(true) => {
            match fs::remove_file(marker) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            Ok(true)
        }
    }
}

#[tauri::command]
pub fn gpu_acceleration(app: AppHandle, enabled: Option<bool>) -> Result<bool> {
    if !cfg!(windows) {
        return Err(AppError::new(
            "UNSUPPORTED",
            "此系统不支持修改 GPU 加速设置",
        ));
    }
    gpu_preference(&marker_path(&app)?, enabled)
        .map_err(|error| AppError::new("SETTINGS", format!("无法读取或保存图形设置：{error}")))
}

#[cfg(windows)]
pub fn create_main_window(app: &tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("main window configuration");
    if config.create {
        return Ok(());
    }
    let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
    if !gpu_preference(&marker_path(app.handle())?, None)? {
        // Supplying arguments replaces Wry's defaults, including its autoplay policy.
        let args = config.additional_browser_args.as_deref().unwrap_or(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required",
        );
        window = window.additional_browser_args(&format!("{args} --disable-gpu"));
    }
    window.build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_acceleration_defaults_on_and_persists_changes() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("disable-webview-gpu");

        assert!(gpu_preference(&marker, None).unwrap());
        assert!(gpu_preference(&marker, Some(true)).unwrap());
        assert!(!gpu_preference(&marker, Some(false)).unwrap());
        assert!(!gpu_preference(&marker, None).unwrap());
        assert!(gpu_preference(&marker, Some(true)).unwrap());
        assert!(gpu_preference(&marker, None).unwrap());
    }
}
