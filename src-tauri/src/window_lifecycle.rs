use crate::db::{AppError, Result, Workspace};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State, Window};

#[derive(Default)]
pub struct HideRequest(AtomicBool);

#[tauri::command]
pub fn app_hide_confirm(
    window: Window,
    pending: State<'_, HideRequest>,
    sync: State<'_, crate::sync::SyncConnection>,
) -> Result<()> {
    if !pending.0.swap(false, Ordering::AcqRel) {
        return Ok(());
    }
    #[cfg(any(windows, target_os = "macos"))]
    hide_in_tray(&window)?;
    sync.wake();
    Ok(())
}

#[tauri::command]
pub fn app_hide_cancel(pending: State<'_, HideRequest>) {
    pending.0.store(false, Ordering::Release);
}

#[cfg(target_os = "macos")]
mod macos_instance;
#[cfg(target_os = "macos")]
pub use macos_instance::macos_instance;

const CLOSE_TO_TRAY: &str = "close_to_tray";

#[tauri::command]
pub fn close_to_tray(db: State<'_, Workspace>, enabled: Option<bool>) -> Result<bool> {
    close_to_tray_preference(&db, enabled)
}

fn close_to_tray_preference(db: &Workspace, enabled: Option<bool>) -> Result<bool> {
    if let Some(enabled) = enabled {
        db.set_setting(CLOSE_TO_TRAY, &enabled)?;
        return Ok(enabled);
    }
    Ok(db.setting(CLOSE_TO_TRAY)?.unwrap_or(true))
}

pub fn close_workspace(window: &Window) -> Result<()> {
    #[cfg(any(windows, target_os = "macos"))]
    if close_to_tray_preference(&window.state::<Workspace>(), None)? {
        let pending = window.state::<HideRequest>();
        if !pending.0.swap(true, Ordering::AcqRel)
            && let Err(error) = window.emit("app-hide-requested", ())
        {
            pending.0.store(false, Ordering::Release);
            return Err(window_error(error));
        }
        return Ok(());
    }
    crate::request_exit(window.app_handle());
    Ok(())
}

fn window_error(error: tauri::Error) -> AppError {
    AppError::new("WINDOW", format!("无法操作工作台窗口：{error}"))
}

#[cfg(any(windows, target_os = "macos"))]
const TRAY_ID: &str = "workspace";

#[cfg(any(windows, target_os = "macos"))]
pub fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let open = MenuItem::with_id(app, "workspace-open", "打开工作台", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "workspace-quit", "退出工作台", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().expect("application icon").clone())
        .tooltip("微信创作工作台")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "workspace-open" => restore_window(app),
            "workspace-quit" => crate::request_exit(app),
            _ => {}
        })
        .build(app)?;
    tray.set_visible(cfg!(target_os = "macos"))
}

#[cfg(any(windows, target_os = "macos"))]
fn hide_in_tray(window: &Window) -> Result<()> {
    let tray = window
        .app_handle()
        .tray_by_id(TRAY_ID)
        .expect("workspace tray");
    tray.set_visible(true).map_err(window_error)?;
    if let Err(error) = window.hide() {
        #[cfg(windows)]
        if let Err(error) = tray.set_visible(false) {
            eprintln!("Could not hide the workspace tray icon: {error}");
        }
        return Err(window_error(error));
    }
    Ok(())
}

pub fn restore_window(app: &AppHandle) {
    if let Some(pending) = app.try_state::<HideRequest>() {
        pending.0.store(false, Ordering::Release);
    }
    let Some(window) = app.get_window("main") else {
        return;
    };
    let restore = || -> tauri::Result<()> {
        if window.is_minimized()? {
            window.unminimize()?;
        }
        #[cfg(windows)]
        crate::graphics::ensure_usable_window_size(&window)?;
        window.show()?;
        #[cfg(windows)]
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            tray.set_visible(false)?;
        }
        window.set_focus()
    };
    if let Err(error) = restore() {
        eprintln!("Could not restore workspace window: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_to_tray_defaults_on_and_persists_changes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspace.db");
        let db = Workspace::open(&path).unwrap();
        assert!(close_to_tray_preference(&db, None).unwrap());
        assert!(!close_to_tray_preference(&db, Some(false)).unwrap());
        drop(db);
        let db = Workspace::open(&path).unwrap();
        assert!(!close_to_tray_preference(&db, None).unwrap());
        assert!(close_to_tray_preference(&db, Some(true)).unwrap());
        assert!(close_to_tray_preference(&db, None).unwrap());
    }
}
