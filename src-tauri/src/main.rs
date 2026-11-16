#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod ai;
mod assets;
mod backup;
mod clipboard;
mod commands;
mod content;
mod db;
mod mcp;
mod secrets;
mod wechat_import;

use ai::{AiService, ai_cancel, ai_generate, ai_jobs, ai_test_target, settings::*};
use assets::{Assets, commands::*, publishing::*};
use backup::{
    Backups, backup_commit_restore, backup_configure, backup_create, backup_discard_restore,
    backup_export_workspace, backup_import_workspace, backup_list, backup_prepare_restore,
    backup_restore_notice, backup_settings, backup_take_preferences, backup_use_image_storage,
    backup_workspaces,
};
use clipboard::{clipboard_read, clipboard_write, clipboard_write_html};
use commands::*;
use db::Workspace;
use mcp::{McpServer, mcp_save, mcp_status, mcp_token};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;
use wechat_import::{Imports, wechat_import, wechat_import_jobs, wechat_retry_images};

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main")
                && let Err(error) = window.unminimize().and_then(|()| window.set_focus())
            {
                eprintln!("Could not focus workspace: {error}");
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all().difference(StateFlags::DECORATIONS))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
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
            app.manage(Assets::new(dir.join("assets"), &db)?);
            app.manage(Imports::new(&db)?);
            app.manage(AiService::new(&db)?);
            app.manage(db);
            app.manage(McpServer::default());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle
                    .state::<McpServer>()
                    .start(&handle, &handle.state::<Workspace>())
                    .await;
            });
            Assets::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library,
            entries,
            get_entry,
            create_entry,
            import_markdown,
            save_entry,
            set_deleted,
            save_category,
            delete_category,
            move_category,
            reorder_category,
            reorder_entry,
            revisions,
            export_markdown,
            begin_exit,
            cancel_exit,
            finish_exit,
            asset_import,
            asset_library,
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
            wechat_import,
            wechat_retry_images,
            wechat_import_jobs,
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
            ai_settings,
            ai_agent_versions,
            ai_save_preferences,
            ai_model_has_key,
            ai_save_model,
            ai_delete_model,
            ai_test_target,
            ai_generate,
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_exit(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("could not start the desktop workspace");

    app.run(|app, event| {
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

fn request_exit(app: &tauri::AppHandle) {
    if let Err(error) = app.emit_to("main", "workspace-exit-requested", ()) {
        eprintln!("Could not request workspace exit: {error}");
    }
}
