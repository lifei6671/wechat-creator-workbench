use super::{Assets, by_id, hosted_location, local_error, references};
use crate::db::{AppError, Result, Workspace};
use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tauri::{Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    kind: String,
    id: String,
    title: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    name: String,
    state: String,
    can_restore: bool,
    references: Vec<Reference>,
}

fn attach(output: &mut BTreeMap<String, Vec<Reference>>, id: &str, reference: &Reference) {
    let items = output.entry(id.into()).or_default();
    if !items
        .iter()
        .any(|item| item.kind == reference.kind && item.id == reference.id)
    {
        items.push(reference.clone());
    }
}

fn locations(conn: &Connection) -> Result<BTreeMap<String, Vec<Reference>>> {
    let mut output = BTreeMap::new();
    let mut by_hash = BTreeMap::<String, Vec<String>>::new();
    let mut by_source = BTreeMap::<String, Vec<String>>::new();
    let mut query = conn.prepare("SELECT id,sha256,source_key FROM assets")?;
    for row in query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (id, hash, source) = row?;
        if let Some(hash) = hash {
            by_hash.entry(hash).or_default().push(id.clone());
        }
        if let Some(source) = source {
            by_source.entry(source).or_default().push(id);
        }
    }
    let mut aliases = BTreeMap::<String, Vec<String>>::new();
    let mut query = conn.prepare("SELECT url,sha256 FROM asset_urls")?;
    for row in query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (url, hash) = row?;
        if let Some(ids) = by_hash.get(&hash) {
            aliases.entry(url).or_default().extend(ids.clone());
        }
    }
    let mut query=conn.prepare("SELECT 'entry',id,title,content_md FROM entries
        UNION ALL SELECT 'entry',e.id,e.title,r.content_md FROM entry_revisions r JOIN entries e ON e.id=r.entry_id
        UNION ALL SELECT 'collection',c.id,c.title,n.content_md FROM collection_nodes n JOIN collections c ON c.id=n.collection_id WHERE n.kind='text'
        UNION ALL SELECT 'entry',entry_id,fields_json->>'$.title',fields_json->>'$.contentMd' FROM editor_recovery WHERE fields_json IS NOT NULL")?;
    for row in query.query_map([], |row| {
        Ok((
            Reference {
                kind: row.get(0)?,
                id: row.get(1)?,
                title: row.get(2)?,
            },
            row.get::<_, String>(3)?,
        ))
    })? {
        let (reference, body) = row?;
        for url in references::urls(&body)? {
            if let Some(id) = url.strip_prefix("asset://") {
                attach(&mut output, id, &reference);
            }
            if let Some(ids) = aliases.get(&url) {
                for id in ids {
                    attach(&mut output, id, &reference);
                }
            }
        }
        for key in references::derived_keys(&body) {
            if let Some(ids) = by_source.get(&key) {
                for id in ids {
                    attach(&mut output, id, &reference);
                }
            }
        }
    }
    let mut query=conn.prepare("SELECT 'entry',id,title,cover_asset_id FROM entries WHERE cover_asset_id IS NOT NULL
        UNION ALL SELECT 'collection',c.id,c.title,n.asset_id FROM collection_nodes n JOIN collections c ON c.id=n.collection_id WHERE n.asset_id IS NOT NULL
        UNION ALL SELECT 'entry',entry_id,fields_json->>'$.title',fields_json->>'$.coverAssetId' FROM editor_recovery WHERE fields_json->>'$.coverAssetId' IS NOT NULL")?;
    for row in query.query_map([], |row| {
        Ok((
            Reference {
                kind: row.get(0)?,
                id: row.get(1)?,
                title: row.get(2)?,
            },
            row.get::<_, String>(3)?,
        ))
    })? {
        let (reference, id) = row?;
        attach(&mut output, &id, &reference);
    }
    Ok(output)
}

impl Assets {
    pub fn integrity(&self, db: &Workspace) -> Result<Vec<Item>> {
        let (rows,mut refs)=db.read_running(|conn| {
            let mut query=conn.prepare("SELECT a.id,a.name,a.relative_path,a.sha256,a.bytes,
                EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='asset' AND r.entity_id=a.id AND r.deleted=0),
                EXISTS(SELECT 1 FROM asset_locations l WHERE l.sha256=a.sha256 AND l.uploaded_at IS NOT NULL AND l.deleted_at IS NULL)
                FROM assets a ORDER BY a.created_at DESC,a.id")?;
            let rows=query.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<i64>>(4)?,row.get::<_,bool>(5)?,row.get::<_,bool>(6)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((rows,locations(conn)?))
        })?;
        let mut checked = BTreeMap::<(std::path::PathBuf, String), String>::new();
        let mut output = Vec::with_capacity(rows.len());
        for (id, name, path, hash, bytes, synced, hosted) in rows {
            let mut state = if synced {
                "sync"
            } else if hosted {
                "hosted"
            } else {
                "missing"
            }
            .to_owned();
            if let (Some(relative), Some(hash)) = (path, hash) {
                let file = self.root.join(relative);
                let key = (file.clone(), hash.clone());
                if let Some(known) = checked.get(&key) {
                    state = known.clone();
                } else {
                    match std::fs::metadata(&file) {
                        Ok(metadata) => {
                            state = if i64::try_from(metadata.len()).ok() != bytes {
                                "corrupt"
                            } else if crate::backup::verify_asset_file(&file, &hash).is_ok() {
                                "local"
                            } else {
                                "corrupt"
                            }
                            .into();
                            checked.insert(key, state.clone());
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(local_error(error)),
                    }
                }
            }
            output.push(Item {
                id: id.clone(),
                name,
                state,
                can_restore: synced || hosted,
                references: refs.remove(&id).unwrap_or_default(),
            });
        }
        for (id, references) in refs {
            output.push(Item {
                name: id.clone(),
                id,
                state: "missing".into(),
                can_restore: false,
                references,
            });
        }
        Ok(output)
    }

    pub async fn recover_original(&self, db: &Workspace, id: &str) -> Result<()> {
        let _gate = self.upload_gate.lock().await;
        let (snapshot, hosted) = db.read_running(|conn| {
            let snapshot = super::sync::snapshot(conn, id)?
                .ok_or_else(|| AppError::new("ASSET_MISSING", "素材记录已不存在"))?;
            let hosted = hosted_location(conn, &by_id(conn, id)?)?.is_some();
            Ok((snapshot, hosted))
        })?;
        let hash = snapshot
            .sha256
            .as_deref()
            .ok_or_else(|| AppError::new("ASSET_MISSING", "此素材没有可校验的原图记录"))?;
        let relative = snapshot
            .relative()?
            .ok_or_else(|| AppError::new("ASSET_MISSING", "此素材没有原图路径"))?;
        let file = super::AssetFile {
            id: id.into(),
            hash: Some(hash.into()),
            path: Some(relative.clone()),
        };
        let sync_result = self.read_synced_file(db, &file).await;
        match sync_result {
            Ok(Some(_)) => {}
            Err(error) if !hosted => return Err(error),
            _ if hosted => {
                let bytes = self.read_remote_file(db, &file).await?;
                if hex::encode(Sha256::digest(&bytes)) != hash
                    || i64::try_from(bytes.len()).ok() != snapshot.bytes
                {
                    return Err(AppError::new(
                        "ASSET_CHANGED",
                        "远端副本与原图摘要不一致，无法恢复原图",
                    ));
                }
                self.cache_original(&relative, &bytes)?;
            }
            _ => return Err(AppError::new("ASSET_MISSING", "找不到可恢复的原图副本")),
        }
        db.write(|tx| {
            tx.execute(
                "UPDATE assets SET relative_path=?2 WHERE id=?1 AND sha256=?3 AND relative_path IS NOT ?2",
                params![id, relative, hash],
            )?;
            Ok(())
        })
    }
}

#[tauri::command]
pub async fn asset_integrity(app: tauri::AppHandle) -> Result<Vec<Item>> {
    tokio::task::spawn_blocking(move || app.state::<Assets>().integrity(&app.state::<Workspace>()))
        .await
        .map_err(|_| AppError::new("ASSET_CHECK", "素材检查任务已中断"))?
}
#[tauri::command]
pub async fn asset_recover_original(
    app: tauri::AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    id: String,
) -> Result<()> {
    assets.recover_original(&db, &id).await?;
    use tauri::Emitter;
    let _ = app.emit("assets-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_snapshot_missing_and_corrupt_originals_are_located_without_changing_content() {
        let (root, db, assets) = super::super::tests::setup();
        let id = assets
            .import(&db, "original.png", &super::super::tests::png())
            .unwrap();
        let file = db.read(|conn| by_id(conn, &id)).unwrap();
        let path = assets.root.join(file.path.unwrap());
        db.write(|tx|{
            tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('article','article','Article','draft',?1,1,1)",[format!("![image](asset://{id})")])?;
            references::sync_entry(tx,"article",&format!("![image](asset://{id})"))?;
            tx.execute("INSERT INTO entry_revisions VALUES('article',1,?1,'manual',1)",[format!("![history](asset://{id})")])?;
            Ok(())
        }).unwrap();
        assert_eq!(assets.integrity(&db).unwrap()[0].state, "local");
        let snapshot = root.path().join("old-snapshot.sqlite");
        db.read(|conn| {
            let mut destination = Connection::open(&snapshot)?;
            let backup = rusqlite::backup::Backup::new(conn, &mut destination)?;
            backup.run_to_completion(100, std::time::Duration::from_millis(0), None)?;
            Ok(())
        })
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        let restored = Workspace::open_existing(&snapshot).unwrap();
        let missing = assets.integrity(&restored).unwrap();
        assert_eq!(missing[0].state, "missing");
        assert!(!missing[0].can_restore);
        assert_eq!(missing[0].references[0].id, "article");
        std::fs::write(&path, b"wrong original").unwrap();
        assert_eq!(assets.integrity(&restored).unwrap()[0].state, "corrupt");
        restored
            .read(|conn| {
                assert_eq!(
                    conn.query_row(
                        "SELECT content_md FROM entries WHERE id='article'",
                        [],
                        |row| row.get::<_, String>(0)
                    )?,
                    format!("![image](asset://{id})")
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn missing_asset_index_is_reported_from_recovery_and_canvas_references() {
        let (_root, db, assets) = super::super::tests::setup();
        db.write(|tx|{
            tx.execute_batch("INSERT INTO collections(id,title,created_at,updated_at) VALUES('topic','Topic',1,1);
                INSERT INTO collection_nodes(id,collection_id,kind,content_md,created_at,updated_at) VALUES('note','topic','text','![gone](asset://lost-original)',1,1)")?;
            Ok(())
        }).unwrap();
        let result = assets.integrity(&db).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "lost-original");
        assert_eq!(result[0].state, "missing");
        assert_eq!(result[0].references[0].kind, "collection");
        assert_eq!(result[0].references[0].id, "topic");
    }
}
