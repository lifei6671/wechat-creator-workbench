use crate::assets::references;
use rusqlite::{Connection, functions::FunctionFlags};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

pub(super) fn prepare(conn: &Connection) -> rusqlite::Result<()> {
    let references = Arc::new(Mutex::new(BTreeSet::<String>::new()));
    let pinned = Arc::clone(&references);
    conn.create_scalar_function(
        "image_session_pin",
        1,
        FunctionFlags::SQLITE_UTF8,
        move |ctx| {
            if let Some(value) = ctx.get::<Option<String>>(0)? {
                pinned
                    .lock()
                    .expect("image session lock poisoned")
                    .insert(format!("asset://{value}"));
            }
            Ok(true)
        },
    )?;
    let pinned = Arc::clone(&references);
    conn.create_scalar_function(
        "image_session_pin_markdown",
        1,
        FunctionFlags::SQLITE_UTF8,
        move |ctx| {
            if let Some(value) = ctx.get::<Option<String>>(0)? {
                let urls = references::urls(&value)
                    .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
                let mut pinned = pinned.lock().expect("image session lock poisoned");
                pinned.extend(urls);
                pinned.extend(
                    references::derived_keys(&value)
                        .into_iter()
                        .map(|key| format!("source:{key}")),
                );
            }
            Ok(true)
        },
    )?;
    conn.create_scalar_function(
        "image_session_has",
        1,
        FunctionFlags::SQLITE_UTF8,
        move |ctx| {
            let value = ctx.get::<Option<String>>(0)?;
            Ok(value.is_some_and(|value| {
                references
                    .lock()
                    .expect("image session lock poisoned")
                    .contains(&value)
            }))
        },
    )?;
    // TEMP triggers live only on this connection and never enter database backups.
    conn.execute_batch("CREATE TEMP TRIGGER image_session_entry BEFORE DELETE ON main.entry_assets BEGIN
        SELECT image_session_pin(OLD.asset_id); END;
        CREATE TEMP TRIGGER image_session_cover BEFORE UPDATE OF cover_asset_id ON main.entries BEGIN
        SELECT image_session_pin(OLD.cover_asset_id); END;
        CREATE TEMP TRIGGER image_session_project BEFORE DELETE ON main.image_project_assets BEGIN
        SELECT image_session_pin(OLD.asset_id); END;
        CREATE TEMP TRIGGER image_session_node_update BEFORE UPDATE OF content_md,asset_id ON main.collection_nodes BEGIN
        SELECT image_session_pin(OLD.asset_id); SELECT image_session_pin_markdown(OLD.content_md); END;
        CREATE TEMP TRIGGER image_session_node_delete BEFORE DELETE ON main.collection_nodes BEGIN
        SELECT image_session_pin(OLD.asset_id); SELECT image_session_pin_markdown(OLD.content_md); END;
        CREATE TEMP TRIGGER image_session_revision BEFORE DELETE ON main.entry_revisions BEGIN
        SELECT image_session_pin_markdown(OLD.content_md); END;
        CREATE TEMP TRIGGER image_session_recovery_update BEFORE UPDATE OF fields_json ON main.editor_recovery BEGIN
        SELECT image_session_pin_markdown(OLD.fields_json->>'$.contentMd');
        SELECT image_session_pin(OLD.fields_json->>'$.coverAssetId'); END;
        CREATE TEMP TRIGGER image_session_recovery_delete BEFORE DELETE ON main.editor_recovery BEGIN
        SELECT image_session_pin_markdown(OLD.fields_json->>'$.contentMd');
        SELECT image_session_pin(OLD.fields_json->>'$.coverAssetId'); END;")?;
    Ok(())
}
