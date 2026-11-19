use crate::db::{AppError, Result};
use std::{
    fs::{self, File},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::align_main_titlebar;

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
    use tauri_plugin_window_state::{StateFlags, WindowExt};

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
    let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?.visible(false);
    if !gpu_preference(&marker_path(app.handle())?, None)? {
        // Supplying arguments replaces Wry's defaults, including its autoplay policy.
        let args = config.additional_browser_args.as_deref().unwrap_or(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required",
        );
        window = window.additional_browser_args(&format!("{args} --disable-gpu"));
    }
    let window = window.build()?;
    set_window_small_icon(window.hwnd()?)?;
    // Validate the normal bounds before showing the window or restoring maximized state.
    window.restore_state(StateFlags::SIZE | StateFlags::POSITION)?;
    ensure_usable_window_size(&window.as_ref().window())?;
    window.restore_state(StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)?;
    if config.visible {
        window.show()?;
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn ensure_usable_window_size(window: &tauri::Window) -> tauri::Result<()> {
    if window.is_minimized()? || window.is_maximized()? || window.is_fullscreen()? {
        return Ok(());
    }
    let config = window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == window.label())
        .expect("main window configuration");
    let minimum = tauri::LogicalSize::new(
        config.min_width.unwrap_or(0.0),
        config.min_height.unwrap_or(0.0),
    )
    .to_physical::<u32>(window.scale_factor()?);
    let size = window.inner_size()?;
    if size.width < minimum.width || size.height < minimum.height {
        window.set_size(tauri::LogicalSize::new(config.width, config.height))?;
        window.center()?;
    }
    Ok(())
}

#[cfg(windows)]
fn set_window_small_icon(hwnd: windows::Win32::Foundation::HWND) -> windows::core::Result<()> {
    use tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID;
    use windows::{
        Win32::{
            Foundation::{HINSTANCE, LPARAM, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::{
                HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
                WindowsAndMessaging::{
                    ICON_SMALL, IMAGE_ICON, LR_SHARED, LoadImageW, SM_CXSMICON, SM_CYSMICON,
                    SendMessageW, WM_SETICON,
                },
            },
        },
        core::PCWSTR,
    };

    // Loading the embedded icon preserves its native mask for shell consumers.
    // The window is live and Windows owns the shared handle for this resource.
    unsafe {
        let instance = GetModuleHandleW(PCWSTR::null())?;
        let dpi = GetDpiForWindow(hwnd);
        let icon = LoadImageW(
            Some(HINSTANCE(instance.0)),
            PCWSTR::from_raw(usize::from(WINDOWS_APP_ICON_RESOURCE_ID) as *const u16),
            IMAGE_ICON,
            GetSystemMetricsForDpi(SM_CXSMICON, dpi),
            GetSystemMetricsForDpi(SM_CYSMICON, dpi),
            LR_SHARED,
        )?;
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_SMALL as usize)),
            Some(LPARAM(icon.0 as isize)),
        );
    }
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
