use super::*;
use std::collections::BTreeMap;

pub(super) fn resolve(
    db: &Workspace,
    key: &Key,
    choice: Resolution,
    remote_revision: i64,
    local_generation: i64,
) -> Result<Applied> {
    db.write(|tx| {
        let remote = resolution_target(tx, key, remote_revision, local_generation)?;
        let mut changed = Applied::default();
        if matches!(choice, Resolution::Local) {
            if remote.deleted_at.is_some() {
                return Err(AppError::invalid(
                    "云端已删除此项，请另存白板副本以保留本地内容",
                ));
            }
            remember(tx, key, remote_revision, false)?;
        } else {
            if matches!(choice, Resolution::Copy) {
                let local = local_snapshot(tx, key)?
                    .ok_or_else(|| AppError::invalid("本地已删除此项，无法另存副本"))?;
                let topic = if key.entity_type == Kind::Collection {
                    key.entity_id.as_str()
                } else {
                    local["collectionId"].as_str().ok_or_else(protocol_error)?
                };
                changed.changed_collections.insert(copy_topic(tx, topic)?);
            }
            let grouped: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_inbox WHERE group_size>1
                 AND payload_json->>'$.entityType'=?1 AND payload_json->>'$.entityId'=?2
                 AND payload_json->>'$.remoteRevision'=?3)",
                params![key.entity_type.key(), key.entity_id, remote_revision],
                |row| row.get(0),
            )?;
            if !grouped {
                let capture: bool =
                    tx.query_row("SELECT capture FROM sync_progress", [], |row| row.get(0))?;
                tx.execute("UPDATE sync_progress SET capture=0", [])?;
                changed.extend(apply_group(tx, vec![remote])?);
                tx.execute("UPDATE sync_progress SET capture=?1", [capture])?;
            }
            tx.execute(
                "DELETE FROM sync_dirty WHERE (entity_type,entity_id)=(?1,?2)",
                params![key.entity_type.key(), key.entity_id],
            )?;
        }
        tx.execute(
            "DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
            params![key.entity_type.key(), key.entity_id],
        )?;
        changed.extend(apply_received_transaction(tx, None)?);
        Ok(changed)
    })
}

fn copy_topic(conn: &Connection, topic: &str) -> Result<String> {
    let copy = id();
    let mut data = canvas::snapshot_topic(conn, topic)?.ok_or_else(protocol_error)?;
    data["title"] = json!(format!(
        "{}（冲突副本）",
        data["title"].as_str().ok_or_else(protocol_error)?
    ));
    canvas::apply_topic(conn, &copy, &data, false)?;
    conn.execute(
        "UPDATE collections SET (viewport_x,viewport_y,viewport_zoom)=
         (SELECT viewport_x,viewport_y,viewport_zoom FROM collections WHERE id=?2) WHERE id=?1",
        params![copy, topic],
    )?;
    let mut nodes =
        conn.prepare("SELECT id FROM collection_nodes WHERE collection_id=?1 ORDER BY id")?;
    let mut renamed = BTreeMap::new();
    for node in nodes.query_map([topic], |row| row.get::<_, String>(0))? {
        let node = node?;
        let new_id = id();
        let mut data = canvas::snapshot_card(conn, &node)?.ok_or_else(protocol_error)?;
        data["collectionId"] = json!(copy);
        canvas::apply_card(conn, &new_id, &data, false)?;
        renamed.insert(node, new_id);
    }
    let mut edges =
        conn.prepare("SELECT id FROM collection_edges WHERE collection_id=?1 ORDER BY id")?;
    for edge in edges.query_map([topic], |row| row.get::<_, String>(0))? {
        let mut data = canvas::snapshot_link(conn, &edge?)?.ok_or_else(protocol_error)?;
        for field in ["sourceNodeId", "targetNodeId"] {
            let original = data[field].as_str().ok_or_else(protocol_error)?;
            data[field] = json!(renamed[original]);
        }
        data["collectionId"] = json!(copy);
        canvas::apply_link(conn, &id(), &data, false)?;
    }
    Ok(copy)
}

#[cfg(test)]
mod tests;
