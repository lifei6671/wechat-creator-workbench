#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod ai;
mod assets;
mod backup;
mod canvas_preview_cache;
mod canvas_webview;
mod clipboard;
mod commands;
mod content;
mod db;
mod github_import;
mod graphics;
mod link_import;
mod mcp;
mod secrets;
mod sync;
mod updater;
mod wechat_import;
mod window_lifecycle;

use ai::conversations::*;
use ai::{
    AiService, ai_agent_models, ai_cancel, ai_chat_stream, ai_generate, ai_jobs, ai_test_target,
    settings::*,
};
use assets::{Assets, commands::*, publishing::*};
use backup::{
    Backups, backup_commit_restore, backup_configure, backup_create, backup_discard_restore,
    backup_export_workspace, backup_import_workspace, backup_list, backup_prepare_restore,
    backup_restore_notice, backup_settings, backup_take_preferences, backup_use_image_storage,
    backup_workspaces,
};
use canvas_preview_cache::canvas_preview_cache_read;
use canvas_webview::{canvas_webview, canvas_webview_page, canvas_webview_snapshot};
use clipboard::{clipboard_read, clipboard_write, clipboard_write_html};
use commands::*;
use content::trash::{empty_trash, trash_retention};
use db::Workspace;
use graphics::gpu_acceleration;
use link_import::{import_clipping, import_link};
use mcp::{McpServer, mcp_save, mcp_status, mcp_token};
use sync::contents::{
    sync_activity, sync_apply, sync_conflicts, sync_rebuild_apply, sync_rebuild_stage,
    sync_resolve, sync_run,
};
use sync::{
    sync_connect, sync_connection_info, sync_create_access_key, sync_create_recovery_key,
    sync_default_device_name, sync_devices, sync_generate_secret, sync_reauthorize, sync_recover,
    sync_revoke_device, sync_status, sync_wake,
};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;
use updater::{
    AppUpdater, app_info, app_update_check, app_update_download, app_update_install,
    app_update_status,
};
use wechat_import::{Imports, wechat_retry_images};
use window_lifecycle::{
    app_hide_cancel, app_hide_confirm, close_to_tray, close_workspace, restore_window,
};

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(window_lifecycle::macos_instance());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            use tauri::menu::{Menu, MenuItem, MenuItemKind};

            let menu = Menu::default(app)?;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(edit) = item
                    && edit.text()? == "Edit"
                {
                    // Native undo uses WebKit's history, which misses editor transactions such as paste.
                    for (index, id, label, shortcut) in [
                        (0, "workspace-undo", "撤销", "CmdOrCtrl+Z"),
                        (1, "workspace-redo", "重做", "CmdOrCtrl+Shift+Z"),
                    ] {
                        edit.remove_at(index)?;
                        edit.insert(
                            &MenuItem::with_id(app, id, label, true, Some(shortcut))?,
                            index,
                        )?;
                    }
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            let action = match event.id.as_ref() {
                "workspace-undo" => "undo",
                "workspace-redo" => "redo",
                _ => return,
            };
            if let Err(error) = request_history(app, action) {
                eprintln!("Could not request editor history action: {error}");
            }
        });
    let window_state_flags = StateFlags::all().difference(StateFlags::DECORATIONS);
    let window_state =
        tauri_plugin_window_state::Builder::default().with_state_flags(window_state_flags);
    #[cfg(windows)]
    let window_state = window_state
        .with_state_flags(window_state_flags.difference(StateFlags::VISIBLE))
        .skip_initial_state("main");
    let app = builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            restore_window(app);
        }))
        .plugin(window_state.build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?.join("workspace");
            std::fs::create_dir_all(&dir)?;
            let (db, backups) = Backups::open(&dir)?;
            app.manage(backups);
            let mut assets = Assets::new(dir.join("assets"), &db)?;
            if let Ok(cache) = app.path().app_cache_dir() {
                assets = assets
                    .with_image_cache(&cache.join("remote-images"))
                    .with_thumbnail_cache(cache.join("asset-thumbnails"));
            }
            app.manage(assets);
            app.manage(Imports::new(&db)?);
            app.manage(AiService::new(&db)?);
            app.manage(db);
            app.manage(McpServer::default());
            app.manage(AppUpdater::default());
            app.manage(sync::SyncConnection::new()?);
            app.manage(window_lifecycle::HideRequest::default());
            app.manage(canvas_webview::PreviewState::default());
            #[cfg(windows)]
            graphics::create_main_window(app)?;
            #[cfg(any(windows, target_os = "macos"))]
            window_lifecycle::create_tray(app)?;
            #[cfg(target_os = "macos")]
            graphics::align_main_titlebar(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle
                    .state::<McpServer>()
                    .start(&handle, &handle.state::<Workspace>())
                    .await;
            });
            Assets::spawn(app.handle().clone());
            sync::scheduler::spawn(app.handle().clone());
            content::trash::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            app_update_status,
            app_update_check,
            app_update_download,
            app_update_install,
            library,
            entries,
            get_entry,
            create_entry,
            import_markdown,
            list_collections,
            save_collection,
            delete_collection,
            get_collection_canvas,
            canvas_webview,
            canvas_webview_page,
            canvas_webview_snapshot,
            canvas_preview_cache_read,
            create_collection_node,
            update_collection_node_text,
            update_collection_node_color,
            update_collection_node_geometry,
            delete_collection_node,
            convert_collection_text,
            create_collection_edge,
            update_collection_edge,
            delete_collection_edge,
            save_collection_viewport,
            list_entry_collections,
            save_entry,
            set_deleted,
            empty_trash,
            trash_retention,
            save_category,
            delete_category,
            move_category,
            reorder_category,
            reorder_entry,
            set_entry_pinned,
            revisions,
            export_markdown,
            begin_exit,
            cancel_exit,
            finish_exit,
            gpu_acceleration,
            close_to_tray,
            asset_import,
            asset_library,
            asset_detail,
            asset_upload_progress,
            asset_thumbnail,
            asset_read,
            asset_localize_image,
            asset_upload,
            image_storage_save,
            image_storage_test,
            image_storage_settings,
            image_storage_target,
            asset_host_image,
            asset_export,
            cancel_asset_cleanup,
            clipboard_read,
            clipboard_write,
            import_link,
            import_clipping,
            wechat_retry_images,
            clipboard_write_html,
            asset_derive,
            asset_info,
            asset_public,
            asset_copy_image,
            asset_save_image,
            wechat_export_html,
            wechat_graphics,
            mcp_status,
            mcp_save,
            mcp_token,
            sync_status,
            sync_default_device_name,
            sync_connect,
            sync_recover,
            sync_reauthorize,
            sync_connection_info,
            sync_wake,
            app_hide_confirm,
            app_hide_cancel,
            sync_devices,
            sync_create_access_key,
            sync_create_recovery_key,
            sync_revoke_device,
            sync_generate_secret,
            sync_run,
            sync_activity,
            sync_apply,
            sync_rebuild_stage,
            sync_rebuild_apply,
            sync_conflicts,
            sync_resolve,
            ai_settings,
            ai_agent_versions,
            ai_agent_models,
            ai_save_preferences,
            ai_model_has_key,
            ai_save_model,
            ai_delete_model,
            ai_test_target,
            ai_generate,
            ai_chat_stream,
            ai_threads_list,
            ai_thread_get,
            ai_thread_create,
            ai_thread_update,
            ai_thread_delete,
            ai_messages_list,
            ai_message_save,
            ai_proposal_status,
            ai_cancel,
            ai_jobs,
            backup_settings,
            backup_configure,
            backup_use_image_storage,
            backup_export_workspace,
            backup_import_workspace,
            backup_take_preferences,
            backup_workspaces,
            backup_list,
            backup_create,
            backup_prepare_restore,
            backup_discard_restore,
            backup_commit_restore,
            backup_restore_notice,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Err(error) = close_workspace(window) {
                        eprintln!("Could not close workspace window: {error:?}");
                    }
                }
                #[cfg(windows)]
                WindowEvent::Resized(_) if matches!(window.is_visible(), Ok(true)) => {
                    if let Err(error) = graphics::ensure_usable_window_size(window) {
                        eprintln!("Could not restore usable workspace bounds: {error}");
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("could not start the desktop workspace");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            restore_window(app);
        }
        if let RunEvent::ExitRequested { api, .. } = event
            && !app.state::<Workspace>().exit_committed()
        {
            api.prevent_exit();
            request_exit(app);
        }
    });
}

#[cfg(test)]
#[test]
fn registered_commands_are_available_to_the_desktop_window() {
    let source = include_str!("main.rs");
    let (_, handler) = source
        .split_once(".invoke_handler(tauri::generate_handler![")
        .unwrap();
    let commands = handler.split_once("])").unwrap().0;
    let permissions: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
    for command in commands
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        assert!(
            include_str!("../build.rs").contains(&format!("\"{command}\"")),
            "missing build command {command}"
        );
        let permission = format!("allow-{}", command.replace('_', "-"));
        assert!(
            permissions["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == permission.as_str()),
            "missing {permission}"
        );
    }
}

#[cfg(target_os = "macos")]
fn request_history(app: &tauri::AppHandle, action: &'static str) -> tauri::Result<()> {
    use objc2::{MainThreadMarker, sel};
    use objc2_app_kit::{NSApplication, NSView};
    use objc2_web_kit::WKWebView;

    let main = app.get_webview("main").expect("main webview exists");
    let handle = app.clone();
    main.with_webview(move |platform| {
        // Tauri supplies the live WKWebView on the AppKit main thread.
        let main = unsafe { &*platform.inner().cast::<WKWebView>() };
        let application = NSApplication::sharedApplication(MainThreadMarker::from(main));
        if let Some(window) = application.keyWindow()
            && let Some(responder) = window.firstResponder()
            && let Some(view) = responder.downcast_ref::<NSView>()
            && view.isDescendantOf(main)
        {
            // Emit after with_webview releases the runtime's webview lock.
            tauri::async_runtime::spawn(async move {
                if let Err(error) = handle.emit_to("main", "workspace-history-requested", action) {
                    eprintln!("Could not send editor history action: {error}");
                }
            });
        } else {
            let selector = if action == "undo" {
                sel!(undo:)
            } else {
                sel!(redo:)
            };
            // A nil target preserves AppKit's native responder-chain dispatch for other webviews.
            unsafe { application.sendAction_to_from(selector, None, None) };
        }
    })
}

fn request_exit(app: &tauri::AppHandle) {
    if let Err(error) = app.emit_to("main", "workspace-exit-requested", ()) {
        eprintln!("Could not request workspace exit: {error}");
        restore_window(app);
    }
}
