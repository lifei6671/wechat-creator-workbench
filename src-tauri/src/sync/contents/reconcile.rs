use super::{
    Applied, Entity, Key, Kind, Mutation, Operation, apply_group, encode, generation, in_outbox,
    invalid_response, issue, local_snapshot, merge, protocol_error, remember, revision,
};
use crate::db::{AppError, Result, id};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;

const GROUP_CONFLICT: &str = "同步操作组与云端版本不同，请处理整组变更";

fn target_matches(mutation: &Mutation, remote: Option<&Entity>) -> bool {
    let Some(remote) = remote else {
        return false;
    };
    if mutation.operation == "delete" {
        return remote.deleted_at.is_some() && (!mutation.payload.as_ref().is_some_and(|value| value["purgedAt"].is_i64())
            || remote.payload["purgedAt"].is_i64());
    }
    remote.deleted_at.is_none()
        && mutation
            .payload
            .as_ref()
            .is_some_and(|local| merge::same_content(mutation.key.entity_type, local.clone(), &remote.payload))
}

fn staged(conn: &Connection, key: &Key) -> Result<Option<Entity>> {
    let raw = conn
        .query_row(
            "SELECT payload_json FROM sync_bootstrap WHERE (entity_type,entity_id)=(?1,?2)",
            params![key.entity_type.key(), key.entity_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(invalid_response))
        .transpose()
}

/// Resolve an uncertain frozen group as a whole against the completed snapshot.
pub(super) fn outbox(conn: &Connection) -> Result<()> {
    let frozen = conn
        .query_row(
            "SELECT operation_json,generations_json,origin_device_id FROM sync_outbox WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((raw, generations, origin)) = frozen else {
        return Ok(());
    };
    let mut operation: Operation = serde_json::from_str(&raw).map_err(invalid_response)?;
    let generations: Vec<i64> = serde_json::from_str(&generations).map_err(invalid_response)?;
    if operation.mutations.len() != generations.len() {
        return Err(protocol_error());
    }
    let targets = operation
        .mutations
        .iter()
        .map(|mutation| staged(conn, &mutation.key))
        .collect::<Result<Vec<_>>>()?;
    if operation
        .mutations
        .iter()
        .zip(&targets)
        .all(|(mutation, remote)| {
            remote.as_ref().map_or(0, |entity| entity.remote_revision) == mutation.base_revision
        })
    {
        let current: String =
            conn.query_row("SELECT device_id FROM sync_binding WHERE id=1", [], |row| {
                row.get(0)
            })?;
        if origin != current {
            operation.operation_id = id();
            conn.execute(
                "UPDATE sync_outbox SET operation_json=?1,origin_device_id=?2 WHERE id=1",
                params![encode(&operation)?, current],
            )?;
        }
        return Ok(());
    }
    let converged = operation
        .mutations
        .iter()
        .zip(&targets)
        .all(|(mutation, remote)| target_matches(mutation, remote.as_ref()));
    for ((mutation, generation), remote) in
        operation.mutations.iter().zip(&generations).zip(&targets)
    {
        if converged {
            let remote = remote.as_ref().ok_or_else(protocol_error)?;
            remember(
                conn,
                &mutation.key,
                remote.remote_revision,
                remote.deleted_at.is_some(),
            )?;
            conn.execute(
                "DELETE FROM sync_dirty WHERE (entity_type,entity_id,generation)=(?1,?2,?3)",
                params![
                    mutation.key.entity_type.key(),
                    mutation.key.entity_id,
                    generation
                ],
            )?;
            conn.execute(
                "DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
                params![mutation.key.entity_type.key(), mutation.key.entity_id],
            )?;
        } else {
            issue(
                conn,
                &mutation.key,
                *generation,
                GROUP_CONFLICT,
                remote.as_ref(),
            )?;
        }
    }
    conn.execute("DELETE FROM sync_outbox", [])?;
    Ok(())
}

fn validate_history(conn: &Connection) -> Result<()> {
    let inconsistent = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_revisions r LEFT JOIN sync_bootstrap b
            ON (b.entity_type,b.entity_id)=(r.entity_type,r.entity_id)
            WHERE b.entity_id IS NULL OR b.revision<r.revision)",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if inconsistent {
        return Err(AppError::new(
            "SYNC_HISTORY",
            "云端历史缺少已知记录或版本倒退，已保留本地数据并暂停同步",
        ));
    }
    Ok(())
}

fn queue_untracked(conn: &Connection) -> Result<()> {
    for (kind, table) in [
        ("asset", "assets"),
        ("category", "categories"),
        ("entry", "entries"),
        ("collection", "collections"),
        ("collection_node", "collection_nodes"),
        ("collection_edge", "collection_edges"),
    ] {
        conn.execute(&format!(
            "INSERT OR IGNORE INTO sync_dirty (entity_type,entity_id,generation)
             SELECT ?1,id,1 FROM {table} t WHERE NOT EXISTS(SELECT 1 FROM sync_revisions r
                WHERE r.entity_type=?1 AND r.entity_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM sync_bootstrap b WHERE b.entity_type=?1 AND b.entity_id=t.id)"
        ), [kind])?;
    }
    Ok(())
}

fn prepare_categories(conn: &Connection, entities: &[Entity]) -> Result<()> {
    // Only folders that are actually being applied participate in a cloud name swap.
    let temporary = format!("sync-{}-", id());
    for entity in entities
        .iter()
        .filter(|entity| entity.key.entity_type == Kind::Category && entity.deleted_at.is_none())
    {
        conn.execute(
            "UPDATE categories SET name=?1 || id WHERE id=?2",
            params![temporary, entity.key.entity_id],
        )?;
    }
    for entity in entities
        .iter()
        .filter(|entity| entity.key.entity_type == Kind::Category && entity.deleted_at.is_none())
    {
        let name = entity.payload["name"].as_str().ok_or_else(protocol_error)?;
        let parent = entity.payload["parentId"].as_str();
        let local: Option<String> = conn.query_row(
            "SELECT id FROM categories c WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE
              AND id<>?3 AND NOT EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='category' AND r.entity_id=c.id)",
            params![parent,name,entity.key.entity_id], |row| row.get(0),
        ).optional()?;
        if let Some(local) = local {
            let key = Key {
                entity_type: Kind::Category,
                entity_id: local.clone(),
            };
            if !in_outbox(conn, &key)? {
                let next = merge::available_name(conn, parent, name, 1)?;
                conn.execute(
                    "UPDATE categories SET name=?1 WHERE id=?2",
                    params![next, local],
                )?;
            }
        }
    }
    Ok(())
}

type Pending<'a> = BTreeMap<(&'static str, &'a str), &'a Entity>;

fn pending<'a>(entities: &'a [Entity], kind: Kind, id: &str) -> Option<&'a Entity> {
    entities
        .iter()
        .find(|entity| entity.key.entity_type == kind && entity.key.entity_id == id)
}

fn local_references(conn: &Connection, sql: &str, target: &str) -> Result<Vec<String>> {
    Ok(conn
        .prepare(sql)?
        .query_map([target], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn dependencies_available(
    conn: &Connection,
    pending: &Pending<'_>,
    entity: &Entity,
) -> Result<bool> {
    let payload = &entity.payload;
    let fields: &[(Kind, &str)] = match entity.key.entity_type {
        Kind::Category => &[(Kind::Category, "parentId")],
        Kind::Entry => &[
            (Kind::Category, "categoryId"),
            (Kind::Asset, "coverAssetId"),
        ],
        Kind::CollectionNode => &[
            (Kind::Collection, "collectionId"),
            (Kind::Entry, "entryId"),
            (Kind::Asset, "assetId"),
        ],
        Kind::CollectionEdge => &[
            (Kind::Collection, "collectionId"),
            (Kind::CollectionNode, "sourceNodeId"),
            (Kind::CollectionNode, "targetNodeId"),
        ],
        _ => &[],
    };
    let mut references = fields
        .iter()
        .filter_map(|(kind, field)| payload[*field].as_str().map(|id| (*kind, id)))
        .collect::<Vec<_>>();
    for (field, kind) in [("assetIds", Kind::Asset), ("sourceEntryIds", Kind::Entry)] {
        if let Some(ids) = payload[field].as_array() {
            references.extend(
                ids.iter()
                    .filter_map(|value| value.as_str().map(|id| (kind, id))),
            );
        }
    }
    for (kind, id) in references {
        if let Some(target) = pending.get(&(kind.key(), id)) {
            if target.deleted_at.is_some() && kind != Kind::Entry {
                return Ok(false);
            }
        } else if local_snapshot(
            conn,
            &Key {
                entity_type: kind,
                entity_id: id.into(),
            },
        )?
        .is_none()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn blocked_by_references(conn: &Connection, entities: &[Entity], entity: &Entity) -> Result<bool> {
    let key = &entity.key;
    let deleted = entity.deleted_at.is_some();
    if !deleted {
        let map = entities
            .iter()
            .map(|entity| {
                (
                    (entity.key.entity_type.key(), entity.key.entity_id.as_str()),
                    entity,
                )
            })
            .collect::<Pending<'_>>();
        if !dependencies_available(conn, &map, entity)? {
            return Ok(true);
        }
    }
    match key.entity_type {
        Kind::Category if deleted || entity.payload["parentId"].is_string() => {
            let children = local_references(
                conn,
                "SELECT id FROM categories WHERE parent_id=?1",
                &key.entity_id,
            )?;
            if children.iter().any(|id| {
                pending(entities, Kind::Category, id).is_none_or(|child| {
                    child.deleted_at.is_none()
                        && child.payload["parentId"].as_str() == Some(&key.entity_id)
                })
            }) {
                return Ok(true);
            }
            if deleted {
                let entries = local_references(
                    conn,
                    "SELECT id FROM entries WHERE category_id=?1",
                    &key.entity_id,
                )?;
                if entries.iter().any(|id| {
                    pending(entities, Kind::Entry, id).is_none_or(|entry| {
                        entry.payload["categoryId"].as_str() == Some(&key.entity_id)
                    })
                }) {
                    return Ok(true);
                }
            }
        }
        Kind::Collection if deleted => {
            for (kind, sql) in [
                (
                    Kind::CollectionNode,
                    "SELECT id FROM collection_nodes WHERE collection_id=?1",
                ),
                (
                    Kind::CollectionEdge,
                    "SELECT id FROM collection_edges WHERE collection_id=?1",
                ),
            ] {
                let references = local_references(conn, sql, &key.entity_id)?;
                if references.iter().any(|id| {
                    pending(entities, kind, id).is_none_or(|entity| entity.deleted_at.is_none())
                }) {
                    return Ok(true);
                }
            }
        }
        Kind::CollectionNode if deleted => {
            let edges = local_references(
                conn,
                "SELECT id FROM collection_edges WHERE source_node_id=?1 OR target_node_id=?1",
                &key.entity_id,
            )?;
            if edges.iter().any(|id| {
                pending(entities, Kind::CollectionEdge, id).is_none_or(|edge| {
                    edge.deleted_at.is_none()
                        && (edge.payload["sourceNodeId"].as_str() == Some(&key.entity_id)
                            || edge.payload["targetNodeId"].as_str() == Some(&key.entity_id))
                })
            }) {
                return Ok(true);
            }
        }
        _ => {}
    }
    Ok(false)
}

fn apply_available(conn: &Connection, mut entities: Vec<Entity>) -> Result<Applied> {
    loop {
        let mut retained = Vec::new();
        for entity in &entities {
            if blocked_by_references(conn, &entities, entity)? {
                issue(
                    conn,
                    &entity.key,
                    0,
                    "关联内容仍有本地修改，请先处理相关冲突",
                    Some(entity),
                )?;
            } else {
                retained.push(entity.clone());
            }
        }
        if retained.len() == entities.len() {
            break;
        }
        entities = retained;
    }
    if entities.is_empty() {
        return Ok(Applied::default());
    }
    conn.execute_batch("SAVEPOINT sync_reconcile_dependencies")?;
    let result =
        prepare_categories(conn, &entities).and_then(|()| apply_group(conn, entities.clone()));
    match result {
        Ok(changed) => {
            for entity in &entities {
                conn.execute(
                    "DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
                    params![entity.key.entity_type.key(), entity.key.entity_id],
                )?;
            }
            conn.execute_batch("RELEASE sync_reconcile_dependencies")?;
            Ok(changed)
        }
        Err(error) => {
            conn.execute_batch(
                "ROLLBACK TO sync_reconcile_dependencies; RELEASE sync_reconcile_dependencies",
            )?;
            for entity in &entities {
                issue(conn, &entity.key, 0, &error.to_string(), Some(entity))?;
            }
            Ok(Applied::default())
        }
    }
}

pub(super) fn replay_deferred(conn: &Connection) -> Result<Applied> {
    let mut dirty_issues = conn.prepare("SELECT remote_json FROM sync_issues WHERE generation>0 AND reason<>?1 AND remote_json IS NOT NULL")?;
    let dirty_issues = dirty_issues
        .query_map([GROUP_CONFLICT], |row| row.get::<_, String>(0))?
        .map(|raw| serde_json::from_str::<Entity>(&raw?).map_err(invalid_response))
        .collect::<Result<Vec<_>>>()?;
    for entity in dirty_issues {
        let key = &entity.key;
        if in_outbox(conn, key)? {
            continue;
        }
        let Some(current) = generation(conn, key)? else {
            continue;
        };
        let local = local_snapshot(conn, key)?;
        let deleted = local
            .as_ref()
            .is_none_or(|payload| payload["deletedAt"].is_i64());
        let equal = if entity.deleted_at.is_some() {
            deleted && local.as_ref().is_none_or(|value| value["purgedAt"].is_i64() == entity.payload["purgedAt"].is_i64())
        } else {
            !deleted && local.is_some_and(|local| merge::same_content(key.entity_type, local, &entity.payload))
        };
        if equal {
            remember(
                conn,
                key,
                entity.remote_revision,
                entity.deleted_at.is_some(),
            )?;
            conn.execute(
                "DELETE FROM sync_dirty WHERE (entity_type,entity_id,generation)=(?1,?2,?3)",
                params![key.entity_type.key(), key.entity_id, current],
            )?;
            conn.execute(
                "DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
                params![key.entity_type.key(), key.entity_id],
            )?;
        }
    }
    let mut query = conn.prepare(
        "SELECT remote_json FROM sync_issues WHERE generation=0 AND remote_json IS NOT NULL",
    )?;
    let candidates = query
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|raw| serde_json::from_str::<Entity>(&raw?).map_err(invalid_response))
        .collect::<Result<Vec<_>>>()?;
    let mut entities = Vec::new();
    for entity in candidates {
        if generation(conn, &entity.key)?.is_some() || in_outbox(conn, &entity.key)? {
            continue;
        }
        if entity.remote_revision > revision(conn, &entity.key)?.0 {
            entities.push(entity);
        } else {
            conn.execute(
                "DELETE FROM sync_issues WHERE generation=0 AND (entity_type,entity_id)=(?1,?2)",
                params![entity.key.entity_type.key(), entity.key.entity_id],
            )?;
        }
    }
    apply_available(conn, entities)
}

pub(super) fn baseline(conn: &Connection) -> Result<Applied> {
    validate_history(conn)?;
    outbox(conn)?;
    queue_untracked(conn)?;
    let mut query = conn.prepare("SELECT payload_json FROM sync_bootstrap")?;
    let entities = query
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|raw| serde_json::from_str::<Entity>(&raw?).map_err(invalid_response))
        .collect::<Result<Vec<_>>>()?;
    let mut apply = Vec::new();
    for remote in entities {
        let key = &remote.key;
        if in_outbox(conn, key)? {
            continue;
        }
        if conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2) AND reason=?3)",
            params![key.entity_type.key(),key.entity_id,GROUP_CONFLICT], |row| row.get::<_,bool>(0),
        )? { continue; }
        let (known, _) = revision(conn, key)?;
        let Some(current_generation) = generation(conn, key)? else {
            if remote.remote_revision > known {
                apply.push(remote);
            }
            continue;
        };
        if remote.remote_revision == known {
            continue;
        }
        let local = local_snapshot(conn, key)?;
        let deleted = local
            .as_ref()
            .is_none_or(|value| value["deletedAt"].is_i64());
        let equivalent = if remote.deleted_at.is_some() {
            deleted && local.as_ref().is_none_or(|value| value["purgedAt"].is_i64() == remote.payload["purgedAt"].is_i64())
        } else {
            !deleted && local.is_some_and(|local| merge::same_content(key.entity_type, local, &remote.payload))
        };
        if equivalent {
            remember(
                conn,
                key,
                remote.remote_revision,
                remote.deleted_at.is_some(),
            )?;
            conn.execute(
                "DELETE FROM sync_dirty WHERE (entity_type,entity_id,generation)=(?1,?2,?3)",
                params![key.entity_type.key(), key.entity_id, current_generation],
            )?;
            conn.execute(
                "DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
                params![key.entity_type.key(), key.entity_id],
            )?;
        } else {
            issue(
                conn,
                key,
                current_generation,
                "完整对账发现本地和云端同时修改",
                Some(&remote),
            )?;
        }
    }
    apply_available(conn, apply)
}

#[cfg(test)]
mod tests;
