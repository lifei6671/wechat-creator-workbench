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
mod link_import;
mod graphics;
mod mcp;
mod secrets;
mod sync;
mod wechat_import;

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
use db::Workspace;
use link_import::import_link;
use graphics::gpu_acceleration;
use mcp::{McpServer, mcp_save, mcp_status, mcp_token};
use sync::contents::{
    sync_activity, sync_apply, sync_conflicts, sync_rebuild_apply, sync_rebuild_stage,
    sync_resolve, sync_run,
};
use sync::{
    sync_connect, sync_create_pairing, sync_devices, sync_generate_secret, sync_revoke_device,
    sync_status,
};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;
use wechat_import::{Imports, wechat_retry_images};

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_window("main")
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
            app.manage(sync::SyncConnection::new()?);
            app.manage(canvas_webview::PreviewState::default());
            #[cfg(windows)]
            graphics::create_main_window(app)?;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            asset_import,
            asset_library,
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
            sync_connect,
            sync_devices,
            sync_create_pairing,
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
