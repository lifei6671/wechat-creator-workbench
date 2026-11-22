use super::{
    Applied, Entity, Kind, apply_entity, generation, invalid_response, issue, local_snapshot,
    protocol_error, queue_local_items, release_asset_aliases, remember,
};
use crate::{
    assets::references,
    backup::Backups,
    content::sync as entries,
    db::{Result, id, workspace_id},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

pub(super) fn baseline(conn: &Connection, backups: &Backups) -> Result<Applied> {
    let archive = backups.archive_sync_recovery(&workspace_id(conn)?)?;
    let mut changed = Applied {
        merge_archive: Some(archive.to_string_lossy().into_owned()),
        ..Applied::default()
    };
    preserve_distinct_images(conn, &mut changed)?;
    preserve_distinct_categories(conn, &mut changed)?;
    queue_local_items(conn)?;
    prepare_categories(conn)?;
    release_asset_aliases(conn)?;
    let mut imported_links = Vec::new();
    let mut staged = super::ordered_baseline(conn)?;
    for raw in staged.query_map([], |row| row.get::<_, String>(0))? {
        let entity: Entity = serde_json::from_str(&raw?).map_err(invalid_response)?;
        let key = &entity.key;
        if super::in_outbox(conn, key)? {
            continue;
        }
        let local = local_snapshot(conn, key)?;
        let deleted = entity.deleted_at.is_some();
        if let Some(local) = local {
            if key.entity_type == Kind::Entry && local["purgedAt"].is_i64() && !entity.payload["purgedAt"].is_i64() {
                remember(conn, key, entity.remote_revision, deleted)?;
                continue;
            }
            if key.entity_type == Kind::Asset
                && local["sha256"].is_string()
                && entity.payload["sha256"].is_null()
            {
                remember(conn, key, entity.remote_revision, false)?;
                continue;
            }
            if deleted && (key.entity_type == Kind::Category || key.entity_type.is_canvas()) {
                // The local folder or canvas can still contain items missing in the cloud.
                // Retain it and submit it against the known tombstone revision.
                remember(conn, key, entity.remote_revision, true)?;
                continue;
            }
            if (key.entity_type == Kind::Entry || key.entity_type.is_canvas() || key.entity_type == Kind::WechatPublicationDefaults)
                && !entity.payload["purgedAt"].is_i64()
                && !same_content(key.entity_type, local, &entity.payload)
            {
                issue(
                    conn,
                    key,
                    generation(conn, key)?.ok_or_else(protocol_error)?,
                    "首次合并发现两个版本，请选择要保留的内容",
                    Some(&entity),
                )?;
                continue;
            }
        }
        apply_entity(conn, &entity, &mut changed)?;
        conn.execute(
            "DELETE FROM sync_dirty WHERE (entity_type,entity_id)=(?1,?2)",
            params![key.entity_type.key(), key.entity_id],
        )?;
        if key.entity_type == Kind::Entry {
            imported_links.push((
                key.entity_id.clone(),
                serde_json::json!({
                    "sourceEntryIds": entity.payload["sourceEntryIds"]
                }),
            ));
            changed.changed_entries.push(key.entity_id.clone());
        }
    }
    for (id, links) in imported_links {
        entries::apply_links(conn, &id, &links)?;
    }
    Ok(changed)
}

pub(super) fn same_content(kind: Kind, mut local: Value, remote: &Value) -> bool {
    let mut remote = remote.clone();
    for payload in [&mut local, &mut remote] {
        if let Some(object) = payload.as_object_mut() {
            if kind == Kind::Category {
                object.entry("iconColor").or_insert(Value::Null);
            }
            if kind == Kind::Entry {
                object.entry("publicationPlatforms").or_insert_with(|| serde_json::json!([]));
                object.entry("wechatPublication").or_insert(Value::Null);
            }
            object.remove("updatedAt");
            object.remove("createdAt");
            object.remove("contentBlobHash");
            object.remove("contentBlobSize");
        }
    }
    local == remote
}

fn preserve_distinct_images(conn: &Connection, changed: &mut Applied) -> Result<()> {
    // Both devices may fill the same placeholder while offline with different bytes.
    // Give the local bytes their own image ID before importing the cloud's bytes.
    let mut query = conn.prepare(
        "SELECT a.id FROM assets a JOIN sync_bootstrap b ON b.entity_type='asset' AND b.entity_id=a.id
          WHERE a.sha256<>b.payload_json->>'$.payload.sha256'",
    )?;
    let collisions = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut renamed = BTreeMap::new();
    for old in collisions {
        let new = id();
        conn.execute(
            "INSERT INTO assets
                (id,sha256,mime_type,relative_path,kind,source_key,bytes,created_at,name,width,height,retain_on_exit)
             SELECT ?1,sha256,mime_type,relative_path,kind,NULL,bytes,created_at,name,width,height,retain_on_exit
             FROM assets WHERE id=?2",
            params![new, old],
        )?;
        let mut covers = conn.prepare(
            "UPDATE entries SET cover_asset_id=?1,version=version+1 WHERE cover_asset_id=?2 RETURNING id",
        )?;
        for entry in covers.query_map(params![new, old], |row| row.get(0))? {
            changed.changed_entries.push(entry?);
        }
        let mut images = conn.prepare(
            "UPDATE collection_nodes SET asset_id=?1 WHERE asset_id=?2 RETURNING collection_id",
        )?;
        for topic in images.query_map(params![new, old], |row| row.get(0))? {
            changed.changed_collections.insert(topic?);
        }
        conn.execute(
            "UPDATE jobs SET asset_id=?1 WHERE asset_id=?2",
            params![new, old],
        )?;
        renamed.insert(format!("asset://{old}"), format!("asset://{new}"));
    }
    if renamed.is_empty() {
        return Ok(());
    }
    let rewrite = |body: &str| -> Result<Option<String>> {
        let edits = references::image_edits(body, |url| Ok(renamed.get(url).cloned()))?;
        Ok((!edits.is_empty()).then(|| references::apply_image_edits(body, edits)))
    };
    let mut entries =
        conn.prepare("SELECT id,content_md FROM entries WHERE instr(content_md,'asset://')>0")?;
    let mut entry_edits = Vec::new();
    for row in entries.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, body) = row?;
        if let Some(body) = rewrite(&body)? {
            entry_edits.push((id, body));
        }
    }
    for (id, body) in entry_edits {
        conn.execute(
            "UPDATE entries SET content_md=?2,version=version+1 WHERE id=?1",
            params![id, body],
        )?;
        references::sync_entry(conn, &id, &body)?;
        changed.changed_entries.push(id);
    }
    let mut history = conn.prepare(
        "SELECT entry_id,version,content_md FROM entry_revisions WHERE instr(content_md,'asset://')>0",
    )?;
    let mut history_edits = Vec::new();
    for row in history.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (id, version, body) = row?;
        if let Some(body) = rewrite(&body)? {
            history_edits.push((id, version, body));
        }
    }
    for (id, version, body) in history_edits {
        conn.execute(
            "UPDATE entry_revisions SET content_md=?3 WHERE entry_id=?1 AND version=?2",
            params![id, version, body],
        )?;
    }
    let mut cards = conn.prepare(
        "SELECT id,collection_id,content_md FROM collection_nodes WHERE kind='text' AND instr(content_md,'asset://')>0",
    )?;
    let mut card_edits = Vec::new();
    for row in cards.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (id, topic, body) = row?;
        if let Some(body) = rewrite(&body)? {
            card_edits.push((id, topic, body));
        }
    }
    for (id, topic, body) in card_edits {
        conn.execute(
            "UPDATE collection_nodes SET content_md=?2 WHERE id=?1",
            params![id, body],
        )?;
        changed.changed_collections.insert(topic);
    }
    Ok(())
}

fn preserve_distinct_categories(conn: &Connection, changed: &mut Applied) -> Result<()> {
    let mut query = conn.prepare("SELECT id,parent_id FROM categories ORDER BY depth,id")?;
    let folders = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut renamed = BTreeMap::new();
    for (folder, parent) in &folders {
        let raw: Option<String> = conn.query_row(
            "SELECT payload_json FROM sync_bootstrap WHERE entity_type='category' AND entity_id=?1
             AND payload_json->>'$.deletedAt' IS NULL", [folder], |row| row.get(0),
        ).optional()?;
        let Some(raw) = raw else {
            continue;
        };
        let mut remote: Entity = serde_json::from_str(&raw).map_err(invalid_response)?;
        remote.payload["parentId"] = serde_json::json!(remote.payload["parentId"].as_str());
        remote.payload["sortOrder"] =
            serde_json::json!(remote.payload["sortOrder"].as_i64().unwrap_or(0));
        remote.payload["icon"] =
            serde_json::json!(remote.payload["icon"].as_str().unwrap_or("folder"));
        let key = super::Key {
            entity_type: Kind::Category,
            entity_id: folder.clone(),
        };
        let local = local_snapshot(conn, &key)?.ok_or_else(protocol_error)?;
        if !same_content(Kind::Category, local.clone(), &remote.payload)
            || parent.as_ref().is_some_and(|id| renamed.contains_key(id))
        {
            let copy = id();
            let target_parent = parent.as_ref().map(|id| renamed.get(id).unwrap_or(id));
            let copied_parent = parent.as_ref().is_some_and(|id| renamed.contains_key(id));
            let name = available_name(
                conn,
                target_parent.map(String::as_str),
                local["name"].as_str().ok_or_else(protocol_error)?,
                u64::from(!copied_parent),
            )?;
            conn.execute(
                "INSERT INTO categories (id,parent_id,name,depth,sort_order,icon,icon_color)
                 SELECT ?1,?2,?3,depth,sort_order,icon,icon_color FROM categories WHERE id=?4",
                params![copy, target_parent, name, folder],
            )?;
            renamed.insert(folder.clone(), copy);
        }
    }
    // Move local-only children and article references before the original IDs receive cloud metadata.
    for (folder, parent) in &folders {
        if !renamed.contains_key(folder)
            && let Some(parent) = parent.as_ref().and_then(|id| renamed.get(id))
        {
            conn.execute(
                "UPDATE categories SET parent_id=?2 WHERE id=?1",
                params![folder, parent],
            )?;
        }
    }
    for (old, new) in renamed {
        let mut query =
            conn.prepare("SELECT id,folder_sort_order FROM entries WHERE category_id=?1")?;
        let articles = query
            .query_map([&old], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (article, order) in articles {
            conn.execute(
                "UPDATE entries SET category_id=?2,version=version+1 WHERE id=?1",
                params![article, new],
            )?;
            conn.execute(
                "UPDATE entries SET folder_sort_order=?2 WHERE id=?1",
                params![article, order],
            )?;
            changed.changed_entries.push(article);
        }
    }
    Ok(())
}

fn prepare_categories(conn: &Connection) -> Result<()> {
    // Temporarily clear the names of matching live folders so cloud name swaps
    // can be applied without tripping SQLite's sibling-name constraint.
    conn.execute(
        "UPDATE categories SET name=?1 || id WHERE id IN (
           SELECT entity_id FROM sync_bootstrap WHERE entity_type='category'
             AND payload_json->>'$.deletedAt' IS NULL
         )",
        [format!("sync-{}-", id())],
    )?;
    let mut children = conn.prepare(
        "SELECT c.id,c.name FROM categories c
         JOIN sync_bootstrap p ON p.entity_type='category' AND p.entity_id=c.parent_id
         WHERE p.payload_json->>'$.deletedAt' IS NULL
           AND p.payload_json->>'$.payload.parentId' IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sync_bootstrap b WHERE b.entity_type='category'
             AND b.entity_id=c.id AND b.payload_json->>'$.deletedAt' IS NULL)
         ORDER BY c.id",
    )?;
    let children = children
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (child, name) in children {
        let name = available_name(conn, None, &name, 0)?;
        conn.execute(
            "UPDATE categories SET parent_id=NULL,depth=1,name=?2 WHERE id=?1",
            params![child, name],
        )?;
    }
    let mut collisions = conn.prepare(
        "SELECT c.id,c.parent_id,c.name FROM categories c
         WHERE EXISTS(
           SELECT 1 FROM sync_bootstrap b WHERE b.entity_type='category'
             AND b.entity_id<>c.id AND b.payload_json->>'$.deletedAt' IS NULL
             AND b.payload_json->>'$.payload.parentId' IS c.parent_id
             AND b.payload_json->>'$.payload.name'=c.name COLLATE NOCASE
         ) ORDER BY c.id",
    )?;
    let collisions = collisions
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (folder, parent, name) in collisions {
        let candidate = available_name(conn, parent.as_deref(), &name, 1)?;
        conn.execute(
            "UPDATE categories SET name=?1 WHERE id=?2",
            params![candidate, folder],
        )?;
    }
    Ok(())
}

pub(super) fn available_name(
    conn: &Connection,
    parent: Option<&str>,
    name: &str,
    mut index: u64,
) -> Result<String> {
    let prefix: String = name.chars().take(120).collect();
    loop {
        let candidate = match index {
            0 => name.to_owned(),
            1 => format!("{prefix}（本机）"),
            _ => format!("{prefix}（本机 {index}）"),
        };
        let taken: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE)
                OR EXISTS(SELECT 1 FROM sync_bootstrap WHERE entity_type='category'
                    AND payload_json->>'$.deletedAt' IS NULL
                    AND payload_json->>'$.payload.parentId' IS ?1
                    AND payload_json->>'$.payload.name'=?2 COLLATE NOCASE)",
            params![parent, candidate],
            |row| row.get(0),
        )?;
        if !taken {
            return Ok(candidate);
        }
        index += 1;
    }
}
