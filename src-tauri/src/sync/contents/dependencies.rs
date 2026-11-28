use super::{Key, Kind, in_outbox, local_snapshot, revision};
use crate::db::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn dependency_issue(code: Option<&str>, reason: &str) -> bool {
    match code {
        Some(code) => matches!(
            code,
            "asset_missing"
                | "category_missing"
                | "source_entry_missing"
                | "collection_missing"
                | "canvas_endpoint_missing"
                | "blob_missing"
                | "gc_restore_required"
                | "image_project_missing"
        ),
        None => matches!(
            reason,
            "云端缺少关联素材"
                | "云端缺少关联目录"
                | "云端缺少关联条目"
                | "云端缺少关联专题"
                | "云端缺少连线引用的卡片"
                | "asset_missing"
                | "category_missing"
                | "source_entry_missing"
                | "collection_missing"
                | "canvas_endpoint_missing"
                | "blob_missing"
                | "gc_restore_required"
                | "image_project_missing"
                | "云端缺少关联图片工程"
        ),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RetrySource {
    AcknowledgedDependency,
    Manual,
}

fn retryable_rejection(code: Option<&str>) -> bool {
    matches!(
        code,
        Some(
            "category_name_conflict" | "source_url_conflict" | "category_in_use" | "canvas_in_use"
        )
    )
}

fn references(kind: Kind, data: &Value) -> Vec<(Key, bool)> {
    let mut refs = Vec::new();
    let mut add = |kind, id: Option<&str>, active| {
        if let Some(id) = id {
            refs.push((
                Key {
                    entity_type: kind,
                    entity_id: id.into(),
                },
                active,
            ));
        }
    };
    if kind == Kind::Category {
        add(Kind::Category, data["parentId"].as_str(), true);
    }
    if kind == Kind::Entry {
        add(Kind::Category, data["categoryId"].as_str(), true);
        add(Kind::Asset, data["coverAssetId"].as_str(), false);
        for id in data["sourceEntryIds"].as_array().into_iter().flatten() {
            add(Kind::Entry, id.as_str(), false);
        }
    }
    if kind==Kind::ImageProject { add(Kind::Asset,data["baseAssetId"].as_str(),false); }
    if kind==Kind::ImageRender {
        add(Kind::ImageProject,data["projectId"].as_str(),false);
        add(Kind::Asset,data["outputAssetId"].as_str(),false);
    }
    if matches!(kind, Kind::CollectionNode | Kind::CollectionEdge) {
        add(Kind::Collection, data["collectionId"].as_str(), true);
        if kind == Kind::CollectionNode {
            add(Kind::Entry, data["entryId"].as_str(), false);
            add(Kind::Asset, data["assetId"].as_str(), false);
        } else {
            add(Kind::CollectionNode, data["sourceNodeId"].as_str(), true);
            add(Kind::CollectionNode, data["targetNodeId"].as_str(), true);
        }
    }
    if matches!(kind, Kind::Entry | Kind::CollectionNode | Kind::ImageProject | Kind::ImageRender) {
        for id in data["assetIds"].as_array().into_iter().flatten() {
            add(Kind::Asset, id.as_str(), false);
        }
    }
    refs
}

pub(super) fn missing_image_dependency(conn:&Connection,keys:&[Key])->Result<Option<Kind>> {
    for key in keys.iter().filter(|k|matches!(k.entity_type,Kind::ImageProject|Kind::ImageRender)) {
        let Some(data)=local_snapshot(conn,key)? else {continue;};
        for (dependency,active) in references(key.entity_type,&data) {
            let (base,deleted)=revision(conn,&dependency)?;
            if !keys.iter().any(|key|key.entity_type==dependency.entity_type&&key.entity_id==dependency.entity_id)
                && (base==0 || active&&deleted) {
                conn.execute("INSERT OR IGNORE INTO sync_dirty(entity_type,entity_id,generation) SELECT ?1,?2,1 WHERE EXISTS(SELECT 1 FROM assets WHERE id=?2 AND ?1='asset') OR EXISTS(SELECT 1 FROM image_projects WHERE id=?2 AND ?1='image_project')",params![dependency.entity_type.key(),dependency.entity_id])?;
                return Ok(Some(dependency.entity_type));
            }
        }
    }
    Ok(None)
}

fn group_ready(conn: &Connection, keys: &[Key], source: RetrySource) -> Result<bool> {
    for key in keys {
        let issue = conn.query_row(
            "SELECT code,reason,remote_json IS NOT NULL FROM sync_issues WHERE entity_type=?1 AND entity_id=?2
             AND generation=(SELECT generation FROM sync_dirty WHERE entity_type=?1 AND entity_id=?2)",
            params![key.entity_type.key(), key.entity_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?)),
        ).optional()?;
        if issue.is_some_and(|(code, reason, remote)| {
            remote || !(dependency_issue(code.as_deref(), &reason)
                || source == RetrySource::Manual && retryable_rejection(code.as_deref()))
        }) || in_outbox(conn, key)?
        {
            return Ok(false);
        }
        let Some(data) = local_snapshot(conn, key)? else {
            continue;
        };
        if key.entity_type.is_canvas() && data["deletedAt"].is_i64() {
            continue;
        }
        for (dependency, active) in references(key.entity_type, &data) {
            let (version, deleted) = revision(conn, &dependency)?;
            let in_group = keys.iter().any(|key| {
                key.entity_type == dependency.entity_type && key.entity_id == dependency.entity_id
            });
            let proposed = if in_group {
                local_snapshot(conn, &dependency)?
            } else {
                None
            };
            if in_group {
                if proposed
                    .as_ref()
                    .is_none_or(|value| active && value["deletedAt"].is_i64())
                {
                    return Ok(false);
                }
            } else if version == 0 || active && deleted {
                return Ok(false);
            }
            if key.entity_type == Kind::Category && dependency.entity_type == Kind::Category {
                let parent = local_snapshot(conn, &dependency)?;
                if parent.is_some_and(|value| !value["parentId"].is_null()) {
                    return Ok(false);
                }
            }
            if dependency.entity_type == Kind::CollectionNode {
                let node = local_snapshot(conn, &dependency)?;
                if node.is_none_or(|value| value["collectionId"] != data["collectionId"]) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

use rusqlite::OptionalExtension;

fn retry_group(conn: &Connection, key: &Key, source: RetrySource) -> Result<()> {
    let mut query = conn.prepare(
        "SELECT entity_type,entity_id FROM sync_dirty WHERE (entity_type,entity_id)=(?1,?2)
         OR batch_id=(SELECT batch_id FROM sync_dirty WHERE entity_type=?1 AND entity_id=?2)",
    )?;
    let keys = query
        .query_map(params![key.entity_type.key(), key.entity_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .map(|row| {
            let (kind, id) = row?;
            Ok(Key {
                entity_type: serde_json::from_value(json!(kind))
                    .map_err(super::invalid_response)?,
                entity_id: id,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if group_ready(conn, &keys, source)? {
        for key in keys {
            conn.execute("DELETE FROM sync_issues WHERE entity_type=?1 AND entity_id=?2 AND remote_json IS NULL
                AND generation=(SELECT generation FROM sync_dirty WHERE entity_type=?1 AND entity_id=?2)",
                params![key.entity_type.key(),key.entity_id])?;
        }
    }
    Ok(())
}

/// Revisit only current blocked entities related to acknowledged keys, then their atomic groups.
pub(super) fn retry(conn: &Connection, acknowledged: &[Key]) -> Result<()> {
    for changed in acknowledged {
        let relation = match changed.entity_type {
            Kind::Asset => "(i.entity_type='entry' AND (EXISTS(SELECT 1 FROM entry_assets a WHERE a.entry_id=i.entity_id AND a.asset_id=?1)
                OR EXISTS(SELECT 1 FROM entries e WHERE e.id=i.entity_id AND e.cover_asset_id=?1)))
                OR (i.entity_type='collection_node' AND EXISTS(SELECT 1 FROM collection_nodes n WHERE n.id=i.entity_id
                  AND (n.asset_id=?1 OR (n.kind='text' AND instr(n.content_md,'asset://' || ?1)>0))))
                OR (i.entity_type='asset' AND EXISTS(SELECT 1 FROM assets a JOIN assets b ON a.sha256=b.sha256 WHERE a.id=i.entity_id AND b.id=?1))
                OR (i.entity_type='image_project' AND EXISTS(SELECT 1 FROM image_project_assets a WHERE a.project_id=i.entity_id AND a.asset_id=?1))
                OR (i.entity_type='image_render' AND EXISTS(SELECT 1 FROM image_renders r WHERE r.id=i.entity_id AND (r.output_asset_id=?1 OR EXISTS(SELECT 1 FROM json_each(r.asset_ids_json) WHERE value=?1))))",
            Kind::ImageProject => "i.entity_type='image_render' AND EXISTS(SELECT 1 FROM image_renders r WHERE r.id=i.entity_id AND r.project_id=?1)",
            Kind::Category => "(i.entity_type='entry' AND EXISTS(SELECT 1 FROM entries e WHERE e.id=i.entity_id AND e.category_id=?1))
                OR (i.entity_type='category' AND EXISTS(SELECT 1 FROM categories c WHERE c.id=i.entity_id AND c.parent_id=?1))",
            Kind::Entry => "(i.entity_type='entry' AND EXISTS(SELECT 1 FROM entry_links l WHERE l.article_id=i.entity_id AND l.source_entry_id=?1))
                OR (i.entity_type='collection_node' AND EXISTS(SELECT 1 FROM collection_nodes n WHERE n.id=i.entity_id AND n.entry_id=?1))",
            Kind::Collection => "(i.entity_type='collection_node' AND EXISTS(SELECT 1 FROM collection_nodes n WHERE n.id=i.entity_id AND n.collection_id=?1))
                OR (i.entity_type='collection_edge' AND EXISTS(SELECT 1 FROM collection_edges e WHERE e.id=i.entity_id AND e.collection_id=?1))",
            Kind::CollectionNode => "i.entity_type='collection_edge' AND EXISTS(SELECT 1 FROM collection_edges e WHERE e.id=i.entity_id AND (e.source_node_id=?1 OR e.target_node_id=?1))",
            _ => continue,
        };
        let mut query = conn.prepare(&format!(
            "SELECT i.entity_type,i.entity_id,i.code,i.reason FROM sync_issues i JOIN sync_dirty d
             ON (i.entity_type,i.entity_id,i.generation)=(d.entity_type,d.entity_id,d.generation)
             WHERE i.remote_json IS NULL AND (i.code IN ('asset_missing','category_missing','source_entry_missing','collection_missing','canvas_endpoint_missing','blob_missing','image_project_missing')
             OR (i.code IS NULL AND i.reason IN ('asset_missing','category_missing','source_entry_missing','collection_missing','canvas_endpoint_missing','blob_missing',
               '云端缺少关联素材','云端缺少关联目录','云端缺少关联条目','云端缺少关联专题','云端缺少连线引用的卡片','云端缺少关联图片工程'))) AND ({relation})"
        ))?;
        let candidates = query
            .query_map([&changed.entity_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (kind, id, code, reason) in candidates {
            if dependency_issue(code.as_deref(), &reason) {
                retry_group(
                    conn,
                    &Key {
                        entity_type: serde_json::from_value(json!(kind))
                            .map_err(super::invalid_response)?,
                        entity_id: id,
                    },
                    RetrySource::AcknowledgedDependency,
                )?;
            }
        }
    }
    Ok(())
}

/// Manual retry rechecks dependency failures and repairable business rejections as whole groups.
pub(super) fn retry_blocked(conn: &Connection) -> Result<()> {
    let mut query = conn.prepare(
        "SELECT entity_type,entity_id,code,reason FROM sync_issues WHERE remote_json IS NULL",
    )?;
    let keys = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (kind, id, code, reason) in keys {
        if !dependency_issue(code.as_deref(), &reason) && !retryable_rejection(code.as_deref()) {
            continue;
        }
        retry_group(
            conn,
            &Key {
                entity_type: serde_json::from_value(json!(kind))
                    .map_err(super::invalid_response)?,
                entity_id: id,
            },
            RetrySource::Manual,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Workspace;

    #[test]
    fn category_group_waits_for_every_dependency_and_keeps_conflicts_and_frozen_operations() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        db.write(|tx| {
            tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://localhost/','i','e','d');
                UPDATE sync_progress SET capture=1;
                INSERT INTO categories(id,name,depth,sort_order) VALUES('parent','Parent',1,0),('other','Other',1,1);
                INSERT INTO entries(id,kind,title,status,content_md,category_id,created_at,updated_at) VALUES
                 ('a','article','A','draft','keep a','parent',1,1),('b','article','B','draft','keep b','other',1,1);
                UPDATE sync_dirty SET batch_id='atomic' WHERE entity_type='entry';")?;
            let key = |kind, id: &str| Key { entity_type: kind, entity_id: id.into() };
            for id in ["a", "b"] {
                let key = key(Kind::Entry, id);
                super::super::issue(tx, &key, super::super::generation(tx, &key)?.unwrap(), "云端缺少关联目录", None)?;
                tx.execute("UPDATE sync_issues SET code='category_missing' WHERE entity_id=?1", [id])?;
            }
            super::super::remember(tx, &key(Kind::Category,"parent"), 1, false)?;
            retry(tx, &[key(Kind::Category,"parent")])?;
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_, i64>(0))?, 2);
            super::super::remember(tx, &key(Kind::Category,"other"), 1, true)?;
            retry(tx, &[key(Kind::Category,"other")])?;
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_, i64>(0))?, 2);
            super::super::remember(tx, &key(Kind::Category,"other"), 2, false)?;
            tx.execute("UPDATE sync_issues SET code='revision_conflict' WHERE entity_id='b'", [])?;
            retry(tx, &[key(Kind::Category,"other")])?;
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_, i64>(0))?, 2);
            tx.execute("UPDATE sync_issues SET code='category_missing' WHERE entity_id='b'", [])?;
            tx.execute("INSERT INTO sync_outbox(id,operation_json,generations_json,origin_device_id) VALUES(1,?1,'[1]','d')",
                [json!({"operationId":"frozen","mutations":[{"entityType":"entry","entityId":"b","baseRevision":0,"operation":"upsert","payload":{}}]}).to_string()])?;
            retry(tx, &[key(Kind::Category,"other")])?;
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_, i64>(0))?, 2);
            tx.execute("DELETE FROM sync_outbox", [])?;
            retry(tx, &[key(Kind::Category,"other")])?;
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_, i64>(0))?, 0);
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_dirty WHERE batch_id='atomic'", [], |row| row.get::<_, i64>(0))?, 2);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn editing_one_member_can_unblock_the_whole_dependency_group_on_manual_retry() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        db.write(|tx| {
            tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://localhost/','i','e','d');
                UPDATE sync_progress SET capture=1;
                INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES
                 ('a','article','A','draft','body a',1,1),('b','article','B','draft','body b',1,1),('source','article','Source','draft','source',1,1);
                INSERT INTO entry_links VALUES('a','source');
                UPDATE sync_dirty SET batch_id='atomic' WHERE entity_id IN ('a','b');")?;
            for id in ["a", "b"] {
                let key = Key { entity_type: Kind::Entry, entity_id: id.into() };
                super::super::issue(tx, &key, super::super::generation(tx, &key)?.unwrap(), "云端缺少关联条目", None)?;
            }
            retry_blocked(tx)?;
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_, i64>(0))?, 2);
            tx.execute("DELETE FROM entry_links WHERE article_id='a'", [])?;
            tx.execute("UPDATE entries SET title='Edited' WHERE id='a'", [])?;
            retry_blocked(tx)?;
            assert!(!tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_issues i JOIN sync_dirty d ON
                (i.entity_type,i.entity_id,i.generation)=(d.entity_type,d.entity_id,d.generation) WHERE d.batch_id='atomic')", [], |row| row.get::<_, bool>(0))?);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn explicit_blob_retry_keeps_generation_and_atomic_group_blockers() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        db.write(|tx| {
            tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://localhost/','i','e','d');
                UPDATE sync_progress SET capture=1;
                INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('a','article','A','draft','body',1,1);")?;
            let key = Key { entity_type: Kind::Entry, entity_id: "a".into() };
            let generation = super::super::generation(tx, &key)?.unwrap();
            super::super::issue(tx, &key, generation, "云端缺少关联素材", None)?;
            retry_blocked(tx)?;
            assert_eq!(super::super::generation(tx, &key)?, Some(generation));
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_, i64>(0))?, 0);
            Ok(())
        }).unwrap();
    }
}
