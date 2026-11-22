use super::{Fields, Kind, get_entry, source_details, taxonomy, validate_fields};
use crate::db::{AppError, Result, now};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub fn preserve_local_revision(conn: &Connection, id: &str) -> Result<()> {
    super::record_revision(conn, id, "manual", now())
}

pub fn snapshot(conn: &Connection, id: &str) -> Result<Option<Value>> {
    let Some((folder, pin, imported, deleted, external)) = conn.query_row(
        "SELECT folder_sort_order,pinned_order,wechat_imported,deleted_at,external_imported FROM entries WHERE id=?1",
        [id],
        |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?,
                   row.get::<_, bool>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, bool>(4)?)),
    ).optional()? else { return Ok(None); };
    let entry = get_entry(conn, id)?;
    let mut data = serde_json::to_value(entry).map_err(invalid)?;
    let fields = data.as_object_mut().expect("entries serialize as objects");
    for key in ["id", "version", "links", "pinned"] {
        fields.remove(key);
    }
    fields.insert("folderSortOrder".into(), json!(folder));
    fields.insert("pinnedOrder".into(), json!(pin));
    fields.insert("wechatImported".into(), json!(imported));
    fields.insert("externalImported".into(), json!(external));
    fields.insert("deletedAt".into(), json!(deleted));
    for (key, sql) in [
        (
            "sourceEntryIds",
            "SELECT source_entry_id FROM entry_links WHERE article_id=?1 ORDER BY source_entry_id",
        ),
        (
            "assetIds",
            "SELECT asset_id FROM entry_assets WHERE entry_id=?1 ORDER BY asset_id",
        ),
    ] {
        let list = conn
            .prepare(sql)?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        fields.insert(key.into(), json!(list));
    }
    Ok(Some(data))
}

pub fn apply(conn: &Connection, id: &str, payload: &Value, deleted: Option<i64>) -> Result<()> {
    let purged = payload["purgedAt"].as_i64().or(conn.query_row(
        "SELECT purged_at FROM entries WHERE id=?1", [id], |row| row.get::<_,Option<i64>>(0),
    ).optional()?.flatten());
    let kind = match payload["kind"].as_str() {
        Some("article") => Kind::Article,
        Some("idea") => Kind::Idea,
        Some("reference") => Kind::Reference,
        _ => return Err(AppError::invalid("云端条目的类型无效")),
    };
    let mut data = payload.clone();
    if let Some(obj) = data.as_object_mut() {
        let defaults = Fields::empty(kind);
        for (key, value) in [
            ("status", json!(defaults.status)),
            ("tags", json!([])),
            ("summary", json!("")),
            ("publishedUrl", json!("")),
        ] {
            obj.entry(key).or_insert(value);
        }
        if let Some(source) = obj.get_mut("source").and_then(Value::as_object_mut) {
            source.entry("author").or_insert(json!(""));
            source.entry("accountName").or_insert(json!(""));
        }
    }
    let fields: Fields = serde_json::from_value(data).map_err(invalid)?;
    let saved = payload["updatedAt"].as_i64().unwrap_or_else(now);
    let source = validate_fields(conn, id, kind, &fields, saved, true)?;
    let properties = fields.encoded_properties()?;
    let publications = fields.encoded_publications()?;
    let wechat_publication = fields.encoded_wechat_publication()?;
    let external = payload["externalImported"].as_bool();
    conn.execute(
        "INSERT INTO entries (id,kind,title,content_md,status,category_id,source_id,summary,cover_asset_id,theme_id,
            created_at,updated_at,published_at,published_url,deleted_at,pinned_order,wechat_imported,external_imported,custom_properties,source_details,publication_platforms,wechat_publication)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,COALESCE(?18,0),COALESCE(?19,'[]'),?20,COALESCE(?21,'[]'),COALESCE(?22,'null'))
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,content_md=excluded.content_md,
            status=excluded.status,category_id=excluded.category_id,source_id=excluded.source_id,summary=excluded.summary,
            cover_asset_id=excluded.cover_asset_id,theme_id=excluded.theme_id,updated_at=excluded.updated_at,
            published_at=excluded.published_at,published_url=excluded.published_url,deleted_at=excluded.deleted_at,
            pinned_order=excluded.pinned_order,wechat_imported=excluded.wechat_imported,
            external_imported=COALESCE(?18,entries.external_imported),
            custom_properties=COALESCE(?19,entries.custom_properties),source_details=excluded.source_details,
            publication_platforms=COALESCE(?21,entries.publication_platforms),
            wechat_publication=COALESCE(?22,entries.wechat_publication),version=entries.version+1",
        params![id,kind.key(),fields.title,fields.content_md,fields.status,fields.category_id,source,fields.summary,
            fields.cover_asset_id,fields.theme_id,payload["createdAt"].as_i64().unwrap_or(saved),saved,
            fields.published_at,fields.published_url,deleted,payload["pinnedOrder"].as_i64(),
            payload["wechatImported"].as_bool().unwrap_or(false), external, properties, source_details(&fields, saved), publications, wechat_publication],
    )?;
    conn.execute(
        "UPDATE entries SET folder_sort_order=?2 WHERE id=?1",
        params![id, payload["folderSortOrder"].as_i64()],
    )?;
    taxonomy::replace_tags(conn, id, &fields.tags)?;
    crate::assets::references::sync_entry(conn, id, &fields.content_md)?;
    if let Some(timestamp) = purged { super::trash::purge_entry(conn, id, timestamp)?; }
    Ok(())
}

pub fn apply_links(conn: &Connection, id: &str, payload: &Value) -> Result<()> {
    if conn.query_row("SELECT purged_at IS NOT NULL FROM entries WHERE id=?1", [id], |row| row.get::<_,bool>(0))? {
        return Ok(());
    }
    conn.execute("DELETE FROM entry_links WHERE article_id=?1", [id])?;
    if let Some(ids) = payload["sourceEntryIds"].as_array() {
        for source in ids {
            let source = source
                .as_str()
                .ok_or_else(|| AppError::invalid("云端条目的来源关联无效"))?;
            conn.execute(
                "INSERT INTO entry_links VALUES (?1,?2)",
                params![id, source],
            )?;
        }
    }
    Ok(())
}

fn invalid(_: serde_json::Error) -> AppError {
    AppError::new("SYNC_PAYLOAD", "条目内容无法转换为同步数据")
}
