use super::{Assets, local_error, references, s3::Profile};
use crate::db::{AppError, Result, Workspace, id, now};
use rusqlite::{Connection, params};
use std::{collections::BTreeSet, path::Path};

struct Group {
    hash: String,
    paths: Vec<String>,
    targets: Vec<(Profile, String)>,
    keep_sync_asset: bool,
}

impl Assets {
    pub fn cancel_cleanup(&self) {
        self.cleanup_stopped.cancel();
    }

    pub async fn cleanup(&self, db: &Workspace) -> Result<()> {
        self.uploads_stopped.cancel();
        self.cleanup_for_update(db).await
    }

    pub async fn cleanup_for_update(&self, db: &Workspace) -> Result<()> {
        let _uploads = self.upload_gate.lock().await;
        db.maintenance(|tx| {
            tx.execute(
                "UPDATE jobs SET status='failed', error='退出时已取消，可手动重试', updated_at=?1
                 WHERE kind='upload' AND status IN ('queued','retrying')",
                [now()],
            )?;
            Ok(())
        })?;
        if self
            .uncertain_upload
            .load(std::sync::atomic::Ordering::Relaxed)
            || self.cleanup_stopped.is_cancelled()
        {
            return Ok(());
        }

        let groups = db.maintenance(|tx| {
            let (mut references, mut retained) = referenced(tx)?;
            let mut synced = tx.prepare(
                "SELECT a.id FROM assets a WHERE
                   EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='asset' AND r.entity_id=a.id)
                   OR EXISTS(SELECT 1 FROM sync_dirty d WHERE d.entity_type='asset' AND d.entity_id=a.id)",
            )?;
            for asset in synced.query_map([], |row| row.get::<_, String>(0))? {
                references.insert(asset?);
            }
            let mut pinned = tx.prepare(
                "SELECT DISTINCT sha256 FROM assets WHERE retain_on_exit=1 AND sha256 IS NOT NULL",
            )?;
            for hash in pinned.query_map([], |row| row.get::<_, String>(0))? {
                retained.insert(hash?);
            }
            tx.execute(
                "DELETE FROM jobs WHERE kind='cleanup' AND status<>'completed' AND sha256 IS NULL",
                [],
            )?;
            for hash in &retained {
                tx.execute(
                    "DELETE FROM jobs WHERE kind='cleanup' AND sha256=?1 AND status<>'completed'",
                    [hash],
                )?;
            }
            let mut placeholders = tx.prepare("SELECT id FROM assets WHERE sha256 IS NULL")?;
            let placeholders = placeholders
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for id in placeholders {
                if !references.contains(&id) {
                    tx.execute(
                        "DELETE FROM jobs WHERE kind='import_image' AND asset_id=?1",
                        [&id],
                    )?;
                    tx.execute("DELETE FROM assets WHERE id=?1", [&id])?;
                }
            }
            groups(tx, &retained)
        })?;
        for group in groups {
            if self.cleanup_stopped.is_cancelled() {
                return Ok(());
            }
            if !self
                .remove_group(db, &group, async |profile, key| {
                    profile.provider()?.delete(key).await
                })
                .await?
            {
                return Ok(());
            }
        }
        if !self.cleanup_stopped.is_cancelled() {
            self.remove_unrecorded(db)?;
        }
        Ok(())
    }

    async fn remove_group(
        &self,
        db: &Workspace,
        group: &Group,
        delete: impl AsyncFn(&Profile, &str) -> Result<()>,
    ) -> Result<bool> {
        let hash = &group.hash;
        db.maintenance(|tx| {
            tx.execute(
                "INSERT INTO jobs (id,kind,status,sha256,created_at,updated_at) VALUES (?1,'cleanup','running',?2,?3,?3)
                 ON CONFLICT(sha256) WHERE kind='cleanup' DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at",
                params![id(), hash, now()],
            )?;
            Ok(())
        })?;
        let result = async {
            let mut failed = None;
            for (profile, key) in &group.targets {
                if self.cleanup_stopped.is_cancelled() {
                    return Err(AppError::new("CLEANUP_CANCELLED", "剩余素材清理已取消"));
                }
                let outcome = tokio::select! {
                    biased;
                    outcome = delete(profile, key) => outcome,
                    () = self.cleanup_stopped.cancelled() => Err(AppError::new("CLEANUP_CANCELLED", "剩余素材清理已取消")),
                };
                if let Err(error) = &outcome
                    && matches!(error.code(), "S3_TIMEOUT" | "S3_NETWORK" | "CLEANUP_CANCELLED") {
                    db.maintenance(|tx| {
                        tx.execute("UPDATE asset_locations SET uploaded_at=NULL WHERE sha256=?1 AND storage_profile_id=?2",
                            params![hash, profile.id])?;
                        Ok(())
                    })?;
                }
                match outcome {
                    Ok(()) => db.maintenance(|tx| {
                        tx.execute("UPDATE asset_locations SET deleted_at=?3 WHERE sha256=?1 AND storage_profile_id=?2",
                            params![hash, profile.id, now()])?;
                        Ok(())
                    })?,
                    Err(error) if matches!(error.code(), "S3_PERMISSION" | "S3_TIMEOUT" | "CLEANUP_CANCELLED") => return Err(error),
                    Err(error) => { failed.get_or_insert(error); }
                }
            }
            if let Some(error) = failed { return Err(error); }
            if self.cleanup_stopped.is_cancelled() {
                return Err(AppError::new("CLEANUP_CANCELLED", "剩余素材清理已取消"));
            }
            if !group.keep_sync_asset {
                for path in &group.paths {
                    remove_file(&self.root.join(path))?;
                }
            }
            db.maintenance(|tx| {
                tx.execute("DELETE FROM jobs WHERE sha256=?1 AND kind='upload' AND status<>'completed'", [hash])?;
                if !group.keep_sync_asset {
                    tx.execute("DELETE FROM jobs WHERE kind='import_image' AND asset_id IN (SELECT id FROM assets WHERE sha256=?1)", [hash])?;
                    tx.execute("DELETE FROM assets WHERE sha256=?1", [hash])?;
                }
                tx.execute("DELETE FROM asset_locations WHERE sha256=?1", [hash])?;
                tx.execute("UPDATE jobs SET status='completed',error=NULL,updated_at=?2 WHERE kind='cleanup' AND sha256=?1", params![hash, now()])?;
                Ok(())
            })
        }.await;
        if let Err(error) = result {
            let can_continue = !matches!(
                error.code(),
                "CLEANUP_CANCELLED" | "S3_PERMISSION" | "S3_TIMEOUT"
            );
            db.maintenance(|tx| {
                tx.execute("UPDATE jobs SET status='failed',error=?2,updated_at=?3 WHERE kind='cleanup' AND sha256=?1",
                    params![hash, error.to_string(), now()])?;
                Ok(())
            })?;
            return Ok(can_continue);
        }
        Ok(true)
    }

    fn remove_unrecorded(&self, db: &Workspace) -> Result<()> {
        if !self.root.exists() {
            return Ok(());
        }
        let recorded = db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT relative_path FROM assets WHERE relative_path IS NOT NULL",
            )?;
            Ok(stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()?)
        })?;
        for item in walkdir::WalkDir::new(&self.root)
            .min_depth(3)
            .max_depth(3)
            .follow_links(false)
        {
            if self.cleanup_stopped.is_cancelled() {
                break;
            }
            let item = item.map_err(|e| AppError::new("ASSET_FILE", e.to_string()))?;
            if !item.file_type().is_file() {
                continue;
            }
            let path = item.path();
            let relative = path
                .strip_prefix(&self.root)
                .expect("walk remains under asset root")
                .to_string_lossy()
                .replace('\\', "/");
            let Some((hash, extension)) = item
                .file_name()
                .to_str()
                .and_then(|name| name.rsplit_once('.'))
            else {
                continue;
            };
            if hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                && matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp")
                && relative == format!("{}/{}/{}.{extension}", &hash[..2], &hash[2..4], hash)
                && !recorded.contains(&relative)
            {
                remove_file(path)?;
            }
        }
        Ok(())
    }
}

fn remove_file(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(local_error(error)),
    }
}

const ENTRY_BODIES: &str =
    "SELECT content_md FROM entries UNION ALL SELECT content_md FROM entry_revisions";

pub(super) fn referenced(conn: &Connection) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    let (mut ids, mut hashes) = markdown_references(
        conn,
        &format!(
            "{ENTRY_BODIES} UNION ALL SELECT content_md FROM collection_nodes WHERE kind='text'"
        ),
    )?;
    let mut screenshots = conn.prepare(
        "SELECT DISTINCT a.id,a.sha256 FROM collection_nodes n JOIN assets a ON a.id=n.asset_id",
    )?;
    for item in screenshots.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })? {
        let (id, hash) = item?;
        ids.insert(id);
        hashes.extend(hash);
    }
    Ok((ids, hashes))
}

pub(super) fn entry_references(conn: &Connection) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    markdown_references(conn, ENTRY_BODIES)
}

fn markdown_references(
    conn: &Connection,
    sql: &str,
) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    let mut urls = BTreeSet::new();
    let mut derived = BTreeSet::new();
    let mut bodies = conn.prepare(sql)?;
    for body in bodies.query_map([], |row| row.get::<_, String>(0))? {
        let body = body?;
        urls.extend(references::urls(&body)?);
        derived.extend(references::derived_keys(&body));
    }
    let mut ids = urls
        .iter()
        .filter_map(|url| url.strip_prefix("asset://").map(str::to_owned))
        .collect::<BTreeSet<_>>();
    let mut covers = conn
        .prepare("SELECT DISTINCT cover_asset_id FROM entries WHERE cover_asset_id IS NOT NULL")?;
    for cover in covers.query_map([], |row| row.get::<_, String>(0))? {
        ids.insert(cover?);
    }
    let mut hashes = BTreeSet::new();
    let mut known =
        conn.prepare("SELECT id,sha256,source_key FROM assets WHERE sha256 IS NOT NULL")?;
    for file in known.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (id, hash, key) = file?;
        if ids.contains(&id) || key.as_ref().is_some_and(|key| derived.contains(key)) {
            hashes.insert(hash);
        }
    }
    let mut aliases = conn.prepare("SELECT url,sha256 FROM asset_urls")?;
    for alias in aliases.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (url, hash) = alias?;
        if urls.contains(&url) {
            hashes.insert(hash);
        }
    }
    Ok((ids, hashes))
}

fn groups(conn: &Connection, retained: &BTreeSet<String>) -> Result<Vec<Group>> {
    let mut hashes = conn.prepare("SELECT sha256 FROM assets WHERE sha256 IS NOT NULL UNION SELECT sha256 FROM asset_locations ORDER BY sha256")?;
    let hashes = hashes
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut paths = conn.prepare(
        "SELECT DISTINCT relative_path FROM assets WHERE sha256=?1 AND relative_path IS NOT NULL",
    )?;
    let mut locations = conn.prepare("SELECT storage_profile_id,object_key FROM asset_locations WHERE sha256=?1 AND deleted_at IS NULL ORDER BY storage_profile_id")?;
    let mut synced = conn.prepare(
        "SELECT EXISTS(SELECT 1 FROM assets a WHERE a.sha256=?1 AND (
             EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='asset' AND r.entity_id=a.id)
             OR EXISTS(SELECT 1 FROM sync_dirty d WHERE d.entity_type='asset' AND d.entity_id=a.id)
        ))",
    )?;
    let mut result = Vec::new();
    for hash in hashes.into_iter().filter(|hash| !retained.contains(hash)) {
        let files = paths
            .query_map([&hash], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut targets = Vec::new();
        for row in locations.query_map([&hash], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (profile, key) = row?;
            targets.push((Profile::read(conn, &profile)?, key));
        }
        let keep_sync_asset = synced.query_row([&hash], |row| row.get(0))?;
        if keep_sync_asset && targets.is_empty() {
            continue;
        }
        result.push(Group {
            hash,
            paths: files,
            targets,
            keep_sync_asset,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn update_cleanup_keeps_uploads_resumable_after_installer_failure() {
        let (_dir, db, assets) = super::super::tests::setup();
        db.write(|tx| {
            tx.execute("INSERT INTO storage_profiles VALUES ('images','images','https://s3.example.test','auto','bucket','','https://cdn.example.test','images')", [])?;
            tx.execute("INSERT INTO app_settings VALUES ('image_storage_profile','images')", [])?;
            Ok(())
        }).unwrap();
        db.begin_exit();
        db.prepare_update_install().unwrap();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(!assets.uploads_stopped.is_cancelled());
        db.finish_exit();
        db.cancel_exit();
        let asset = assets
            .import(&db, "after-update.png", &super::super::tests::png())
            .unwrap();
        assets.upload(&db, &asset).unwrap();
        assert!(super::super::claim(&db).unwrap().is_some());
        assets.cleanup(&db).await.unwrap();
        assert!(assets.uploads_stopped.is_cancelled());
    }

    #[test]
    fn text_cards_retain_images_and_derived_assets_until_the_last_reference_is_removed() {
        let (_dir, db, assets) = super::super::tests::setup();
        let bytes = super::super::tests::png();
        let asset = assets.import(&db, "专题.png", &bytes).unwrap();
        let derived = assets.derive(&db, "math-inline", "x^2", &bytes).unwrap();
        let file = db.read(|conn| super::super::by_id(conn, &asset)).unwrap();
        let hash = file.hash.unwrap();
        let derived_hash = db
            .read(|conn| super::super::by_id(conn, &derived))
            .unwrap()
            .hash
            .unwrap();
        db.write(|tx| {
            tx.execute("INSERT INTO collections(id,title,created_at,updated_at) VALUES ('topic','专题',0,0)", [])?;
            tx.execute("INSERT INTO collection_nodes(id,collection_id,kind,created_at,updated_at) VALUES ('note','topic','text',0,0)", [])?;
            tx.execute("INSERT INTO storage_profiles VALUES ('s','images','https://s3.example.test','test','bucket','','https://images.example.test','s')", [])?;
            tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key,uploaded_at) VALUES (?1,'s','topic.png',1)", [&hash])?;
            tx.execute("INSERT INTO asset_urls VALUES ('https://images.example.test/topic.png',?1,'s')", [&hash])?;
            tx.execute("UPDATE collection_nodes SET content_md=?1", [format!("![专题](asset://{asset})")])?;
            assert!(referenced(tx)?.0.contains(&asset));
            assert!(referenced(tx)?.1.contains(&hash));
            assert!(!entry_references(tx)?.0.contains(&asset));
            tx.execute("UPDATE collection_nodes SET content_md='![图床](https://images.example.test/topic.png)'", [])?;
            assert!(referenced(tx)?.1.contains(&hash));
            tx.execute("UPDATE collection_nodes SET content_md='公式 $x^2$'", [])?;
            assert!(referenced(tx)?.1.contains(&derived_hash));
            tx.execute("DELETE FROM collection_nodes WHERE id='note'", [])?;
            assert!(!referenced(tx)?.1.contains(&derived_hash));
            assert!(!referenced(tx)?.1.contains(&hash));
            Ok(())
        }).unwrap();
    }

    #[test]
    fn derived_images_follow_the_source_in_current_and_historical_bodies() {
        let (_dir, db, assets) = super::super::tests::setup();
        let id = assets
            .derive(&db, "math-inline", "x^2", &super::super::tests::png())
            .unwrap();
        let hash = db
            .read(|conn| super::super::by_id(conn, &id))
            .unwrap()
            .hash
            .unwrap();
        db.write(|tx| {
            tx.execute("INSERT INTO entries (id,kind,title,content_md,status,theme_id,created_at,updated_at)
                VALUES ('draft','article','','说明改了，公式仍是 $x^2$。','draft','plainly-tech',0,0)",[])?;
            assert!(referenced(tx)?.1.contains(&hash));
            tx.execute("UPDATE entries SET content_md='公式已换成 $y^2$。' WHERE id='draft'",[])?;
            assert!(!referenced(tx)?.1.contains(&hash));
            tx.execute("INSERT INTO entry_revisions VALUES ('draft',1,'公式还在历史中 $x^2$','manual',0)",[])?;
            assert!(referenced(tx)?.1.contains(&hash));
            Ok(())
        }).unwrap();
    }

    #[tokio::test]
    async fn partial_remote_failure_keeps_local_file_and_retries_only_remaining_target() {
        let (dir, db, assets) = super::super::tests::setup();
        let asset = assets
            .import(&db, "图片.png", &super::super::tests::png())
            .unwrap();
        let file = db.read(|conn| super::super::by_id(conn, &asset)).unwrap();
        let hash = file.hash.unwrap();
        let local = assets.root.join(file.path.unwrap());
        for id in ["a", "b"] {
            db.write(|tx| {
                tx.execute("INSERT INTO storage_profiles VALUES (?1,'images','https://s3.example.test','test','bucket','','https://images.example.test',?1)", [id])?;
                tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key) VALUES (?1,?2,?2)", params![hash, id])?;
                Ok(())
            }).unwrap();
        }
        let pending = || db.read(|conn| groups(conn, &BTreeSet::new())).unwrap();
        assert!(
            assets
                .remove_group(&db, &pending()[0], async |_, key| {
                    assert!(local.is_file());
                    if key == "b" {
                        Err(AppError::new("S3_SERVICE", "temporary failure"))
                    } else {
                        Ok(())
                    }
                })
                .await
                .unwrap()
        );
        assert_eq!(pending()[0].targets.len(), 1);
        assert_eq!(pending()[0].targets[0].1, "b");
        assets.remove_unrecorded(&db).unwrap();
        assert!(local.is_file());
        assets
            .remove_group(&db, &pending()[0], async |_, key| {
                assert_eq!(key, "b");
                assert!(local.is_file());
                Ok(())
            })
            .await
            .unwrap();
        assert!(!local.exists());
        assert!(pending().is_empty());
        drop(dir);
    }

    #[test]
    fn historical_registered_url_and_soft_deleted_cover_preserve_hash_group() {
        let (_dir, db, assets) = super::super::tests::setup();
        let asset = assets
            .import(&db, "图片.png", &super::super::tests::png())
            .unwrap();
        let file = db.read(|conn| super::super::by_id(conn, &asset)).unwrap();
        let hash = file.hash.unwrap();
        db.write(|tx| {
            tx.execute("INSERT INTO storage_profiles VALUES ('s','images','https://s3.example.test','test','bucket','','https://images.example.test','s')", [])?;
            tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key,uploaded_at,deleted_at) VALUES (?1,'s','key',1,2)", [&hash])?;
            tx.execute("INSERT INTO asset_urls VALUES ('https://images.example.test/old',?1,'s')", [&hash])?;
            tx.execute("INSERT INTO entries (id,kind,title,content_md,status,created_at,updated_at,cover_asset_id,deleted_at)
                VALUES ('draft','article','','','draft',0,0,?1,1)", [&asset])?;
            tx.execute("INSERT INTO entry_revisions VALUES ('draft',1,'![历史](https://images.example.test/old)','manual',0)", [])?;
            assert!(referenced(tx)?.1.contains(&hash));
            tx.execute("UPDATE entries SET cover_asset_id=NULL", [])?;
            assert!(referenced(tx)?.1.contains(&hash));
            tx.execute("DELETE FROM entry_revisions", [])?;
            assert!(!referenced(tx)?.1.contains(&hash));
            Ok(())
        }).unwrap();
    }

    #[tokio::test]
    async fn public_cleanup_preserves_the_sync_asset() {
        let (_dir, db, assets) = super::super::tests::setup();
        let id = assets
            .import(&db, "图片.png", &super::super::tests::png())
            .unwrap();
        let file = db.read(|conn| super::super::by_id(conn, &id)).unwrap();
        let hash = file.hash.unwrap();
        db.write(|tx| {
            tx.execute("INSERT INTO sync_revisions VALUES ('asset',?1,1,0)", [&id])?;
            tx.execute("INSERT INTO storage_profiles VALUES ('s','images','https://s3.example.test','test','bucket','','https://images.example.test','s')", [])?;
            tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key,uploaded_at) VALUES (?1,'s','key',1)", [&hash])?;
            Ok(())
        }).unwrap();
        let mut pending = db.read(|conn| groups(conn, &BTreeSet::new())).unwrap();
        let group = pending.pop().unwrap();
        assert!(group.keep_sync_asset);
        assert!(
            assets
                .remove_group(&db, &group, async |_, key| {
                    assert_eq!(key, "key");
                    Ok(())
                })
                .await
                .unwrap()
        );
        assert!(assets.root.join(file.path.unwrap()).is_file());
        assert!(db.read(|conn| super::super::by_id(conn, &id)).is_ok());
        assert!(
            db.read(|conn| groups(conn, &BTreeSet::new()))
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn timed_out_delete_keeps_target_for_cleanup_and_allows_reupload() {
        let (_dir, db, assets) = super::super::tests::setup();
        let id = assets
            .import(&db, "图片.png", &super::super::tests::png())
            .unwrap();
        let file = db.read(|conn| super::super::by_id(conn, &id)).unwrap();
        let hash = file.hash.unwrap();
        db.write(|tx| {
            tx.execute("INSERT INTO storage_profiles VALUES ('s','images','https://s3.example.test','test','bucket','','https://images.example.test','s')", [])?;
            tx.execute("INSERT INTO app_settings VALUES ('image_storage_profile','s')", [])?;
            tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key,public_url,uploaded_at) VALUES (?1,'s','key','https://images.example.test/key',1)", [&hash])?;
            Ok(())
        }).unwrap();
        let group = db
            .read(|conn| groups(conn, &BTreeSet::new()))
            .unwrap()
            .pop()
            .unwrap();
        assert!(
            !assets
                .remove_group(&db, &group, async |_, _| Err(AppError::new(
                    "S3_TIMEOUT",
                    "delayed response"
                )))
                .await
                .unwrap()
        );
        assert!(assets.root.join(file.path.unwrap()).is_file());
        db.read(|conn| {
            let location = conn.query_row(
                "SELECT object_key, uploaded_at, deleted_at FROM asset_locations WHERE sha256=?1",
                [&hash],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )?;
            assert_eq!(location, ("key".into(), None, None));
            Ok(())
        })
        .unwrap();
        assets.upload(&db, &id).unwrap();
        assert!(super::super::claim(&db).unwrap().is_some());
    }
}
