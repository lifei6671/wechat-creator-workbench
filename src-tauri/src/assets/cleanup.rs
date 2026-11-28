use super::{Assets, local_error, references};
use crate::db::{Result, Workspace, id, now};
use rusqlite::{Connection, params};
use std::{collections::BTreeSet, path::Path};

const GRACE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

struct Group { hash: String, paths: Vec<String> }

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
            let retained = protected(tx)?;
            let stamp = now();
            for hash in &retained {
                tx.execute("DELETE FROM asset_cleanup_candidates WHERE sha256=?1", [hash])?;
            }
            let mut query = tx.prepare("SELECT DISTINCT sha256 FROM assets WHERE sha256 IS NOT NULL")?;
            let hashes = query.query_map([], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for hash in hashes.into_iter().filter(|hash| !retained.contains(hash)) {
                tx.execute("INSERT INTO asset_cleanup_candidates VALUES(?1,?2,?2) ON CONFLICT(sha256) DO UPDATE SET last_checked_at=excluded.last_checked_at",
                    params![hash,stamp])?;
            }
            groups(tx,&retained)
        })?;
        for group in groups {
            if self.cleanup_stopped.is_cancelled() { return Ok(()); }
            self.remove_group(db,&group)?;
        }
        if !self.cleanup_stopped.is_cancelled() { self.expire_canvas_staging(db)?; self.remove_orphaned_thumbnails(db)?; }
        Ok(())
    }

    fn expire_canvas_staging(&self, db:&Workspace)->Result<()> {
        db.cleanup_assets(|tx| {
            let cutoff=now()-GRACE_MS;
            let mut query=tx.prepare("SELECT DISTINCT sha256,relative_path FROM image_render_staging WHERE created_at<=?1")?;
            let expired=query.query_map([cutoff],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            tx.execute("DELETE FROM image_render_staging WHERE created_at<=?1",[cutoff])?;
            let retained=protected(tx)?;
            for (hash,path) in expired {
                if !retained.contains(&hash) && !tx.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE sha256=?1)",[&hash],|r|r.get::<_,bool>(0))? {
                    remove_file(&self.root.join(path))?;
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    fn remove_orphaned_thumbnails(&self, db: &Workspace) -> Result<()> {
        let Some(directory) = &self.thumbnail_cache else {
            return Ok(());
        };
        let files = match std::fs::read_dir(directory) {
            Ok(files) => files,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(local_error(error)),
        };
        let live = db.maintenance(|conn| {
            let mut query =
                conn.prepare("SELECT DISTINCT sha256 FROM assets WHERE sha256 IS NOT NULL")?;
            Ok(query
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()?)
        })?;
        let prefix = format!("v1-{}-", super::THUMBNAIL_SIZE);
        for file in files {
            if self.cleanup_stopped.is_cancelled() {
                break;
            }
            let file = file.map_err(local_error)?;
            if !file.file_type().map_err(local_error)?.is_file() {
                continue;
            }
            let name = file.file_name();
            let Some(hash) = name
                .to_str()
                .and_then(|name| name.strip_prefix(&prefix))
                .and_then(|name| name.strip_suffix(".png"))
            else {
                continue;
            };
            if hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && !live.contains(hash)
            {
                remove_file(&file.path())?;
            }
        }
        Ok(())
    }

    fn remove_group(&self, db: &Workspace, group: &Group) -> Result<()> {
        let result = db.cleanup_assets(|tx| {
            // Hold the workspace lock through the final reference check, file removal and commit.
            let retained = protected(tx)?;
            if retained.contains(&group.hash) {
                tx.execute("DELETE FROM asset_cleanup_candidates WHERE sha256=?1", [&group.hash])?;
                return Ok(());
            }
            let due = tx.query_row("SELECT EXISTS(SELECT 1 FROM asset_cleanup_candidates WHERE sha256=?1 AND first_unreferenced_at<=?2)",
                params![group.hash,now()-GRACE_MS], |row| row.get::<_,bool>(0))?;
            if !due || self.cleanup_stopped.is_cancelled() { return Ok(()); }
            for path in &group.paths { remove_file(&self.root.join(path))?; }
            tx.execute("DELETE FROM jobs WHERE asset_id IN (SELECT id FROM assets WHERE sha256=?1)", [&group.hash])?;
            tx.execute("DELETE FROM assets WHERE sha256=?1", [&group.hash])?;
            tx.execute("DELETE FROM asset_cleanup_candidates WHERE sha256=?1", [&group.hash])?;
            tx.execute("INSERT INTO jobs(id,kind,status,sha256,created_at,updated_at) VALUES(?1,'cleanup','completed',?2,?3,?3)
                ON CONFLICT(sha256) WHERE kind='cleanup' DO UPDATE SET status='completed',error=NULL,updated_at=excluded.updated_at",
                params![id(),group.hash,now()])?;
            Ok(())
        });
        if let Err(error) = result {
            db.maintenance(|tx| {
                tx.execute("INSERT INTO jobs(id,kind,status,sha256,error,created_at,updated_at) VALUES(?1,'cleanup','failed',?2,?3,?4,?4)
                    ON CONFLICT(sha256) WHERE kind='cleanup' DO UPDATE SET status='failed',error=excluded.error,updated_at=excluded.updated_at",
                    params![id(),group.hash,error.to_string(),now()])?;
                Ok(())
            })?;
            return Err(error);
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

const RECOVERY_PAYLOADS: &str = "SELECT fields_json AS payload FROM editor_recovery WHERE fields_json IS NOT NULL
    UNION ALL SELECT m.value->'$.payload' FROM sync_outbox o,json_each(o.operation_json,'$.mutations') m WHERE json_type(m.value,'$.payload')='object'
    UNION ALL SELECT payload_json->'$.payload' FROM sync_bootstrap
    UNION ALL SELECT payload_json->'$.payload' FROM sync_inbox
    UNION ALL SELECT remote_json->'$.payload' FROM sync_issues WHERE remote_json IS NOT NULL";

pub(super) fn referenced(conn: &Connection) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    reference_roots(conn, true)
}

pub(super) fn reference_roots(conn: &Connection, include_all_renders: bool) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    roots(conn,include_all_renders,true)
}

pub(super) fn committed_roots(conn: &Connection) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    roots(conn,false,false)
}

fn roots(conn: &Connection, include_all_renders: bool, include_recovery:bool) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    let bodies=if include_recovery {format!(
        "WITH recovery_payloads AS ({RECOVERY_PAYLOADS}) {ENTRY_BODIES} UNION ALL SELECT content_md FROM collection_nodes WHERE kind='text'
        UNION ALL SELECT payload->>'$.contentMd' FROM recovery_payloads WHERE json_type(payload,'$.contentMd')='text'"
    )} else {format!("{ENTRY_BODIES} UNION ALL SELECT content_md FROM collection_nodes WHERE kind='text'")};
    let (mut ids, mut hashes) = markdown_references(
        conn,
        &bodies,
    )?;
    let mut screenshots = conn.prepare(
        "SELECT DISTINCT a.id,a.sha256 FROM collection_nodes n JOIN assets a ON a.id=n.asset_id",
    )?;
    let engineering_sql = if include_all_renders {
        "SELECT asset_id FROM image_project_assets UNION SELECT output_asset_id FROM image_renders UNION SELECT value FROM image_renders,json_each(asset_ids_json) UNION SELECT output_asset_id FROM image_render_staging UNION SELECT value FROM image_render_staging,json_each(asset_ids_json)"
    } else {
        "SELECT asset_id FROM image_project_assets UNION SELECT output_asset_id FROM image_render_staging UNION SELECT value FROM image_render_staging,json_each(asset_ids_json)"
    };
    let mut engineering=conn.prepare(engineering_sql)?;
    for asset in engineering.query_map([],|row|row.get::<_,String>(0))? { ids.insert(asset?); }
    let mut staging=conn.prepare("SELECT sha256 FROM image_render_staging")?;
    for hash in staging.query_map([],|row|row.get::<_,String>(0))? { hashes.insert(hash?); }
    for item in screenshots.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })? {
        let (id, hash) = item?;
        ids.insert(id);
        hashes.extend(hash);
    }
    if include_recovery {
    let mut query=conn.prepare(&format!("WITH recovery_payloads AS ({RECOVERY_PAYLOADS}) SELECT payload FROM recovery_payloads WHERE payload IS NOT NULL"))?;
    for raw in query.query_map([],|row|row.get::<_,String>(0))? {
        let data:serde_json::Value=serde_json::from_str(&raw?).map_err(|_|crate::db::AppError::new("ASSET_REFERENCES","无法读取素材保护引用"))?;
        for field in ["coverAssetId","assetId"] { if let Some(id)=data[field].as_str() { ids.insert(id.into()); } }
        for id in data["assetIds"].as_array().into_iter().flatten().filter_map(serde_json::Value::as_str) { ids.insert(id.into()); }
        if let Some(hash)=data["sha256"].as_str() { hashes.insert(hash.into()); }
    }
    }
    let mut hash=conn.prepare_cached("SELECT sha256 FROM assets WHERE id=?1 AND sha256 IS NOT NULL")?;
    for id in &ids {
        use rusqlite::OptionalExtension;
        if let Some(hash)=hash.query_row([id],|row|row.get::<_,String>(0)).optional()? { hashes.insert(hash); }
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
    let mut aliases = conn.prepare("SELECT url,sha256 FROM asset_urls UNION SELECT payload_json->>'$.publicUrl',sha256 FROM image_gc_remote WHERE payload_json->>'$.publicUrl' IS NOT NULL")?;
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

fn protected(conn: &Connection) -> Result<BTreeSet<String>> {
    let (_,mut retained) = referenced(conn)?;
    let mut query = conn.prepare("SELECT sha256 FROM asset_public_protection UNION SELECT sha256 FROM backup_asset_references
        UNION SELECT a.sha256 FROM assets a WHERE a.sha256 IS NOT NULL AND (a.retain_on_exit=1
          OR EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='asset' AND r.entity_id=a.id)
          OR EXISTS(SELECT 1 FROM sync_dirty d WHERE d.entity_type='asset' AND d.entity_id=a.id))")?;
    retained.extend(query.query_map([], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
    if crate::backup::unknown_asset_protection(conn)? {
        let mut query = conn.prepare("SELECT DISTINCT sha256 FROM assets WHERE sha256 IS NOT NULL")?;
        retained.extend(query.query_map([], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    Ok(retained)
}

fn groups(conn: &Connection, retained: &BTreeSet<String>) -> Result<Vec<Group>> {
    let mut query=conn.prepare("SELECT sha256 FROM asset_cleanup_candidates WHERE first_unreferenced_at<=?1
        AND NOT EXISTS(SELECT 1 FROM asset_locations l WHERE l.sha256=asset_cleanup_candidates.sha256)")?;
    let hashes=query.query_map([now()-GRACE_MS],|row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result=Vec::new();
    for hash in hashes.into_iter().filter(|hash| !retained.contains(hash)) {
        let mut query=conn.prepare("SELECT DISTINCT relative_path FROM assets WHERE sha256=?1 AND relative_path IS NOT NULL")?;
        let paths=query.query_map([&hash],|row| row.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        result.push(Group { hash,paths });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recovery_draft_references_cancel_the_old_cleanup_deadline() {
        let(_dir,db,assets)=super::super::tests::setup();
        let id=assets.import(&db,"recovery.png",&super::super::tests::png()).unwrap();
        assets.cleanup_for_update(&db).await.unwrap();
        db.write(|tx|{tx.execute("UPDATE asset_cleanup_candidates SET first_unreferenced_at=?1",[now()-GRACE_MS-1])?;Ok(())}).unwrap();
        let draft=crate::content::recovery::Draft {entry_id:"deleted-original".into(),session_id:crate::db::id(),kind:crate::content::Kind::Article,base_version:1,local_revision:1,
            fields:serde_json::json!({"title":"Recovery","contentMd":format!("![image](asset://{id})"),"status":"draft","categoryId":null,"tags":[],"summary":"","source":null,"publishedAt":null,"publishedUrl":""})};
        let session=draft.session_id.clone();
        db.put_editor_recovery(draft).unwrap();
        db.read(|conn|{assert_eq!(conn.query_row("SELECT COUNT(*) FROM asset_cleanup_candidates",[],|row|row.get::<_,i64>(0))?,0);assert!(!protected(conn)?.is_empty());Ok(())}).unwrap();
        db.discard_editor_recovery("deleted-original",&session,1).unwrap();
        assets.cleanup_for_update(&db).await.unwrap();
        db.read(|conn|{assert!(conn.query_row("SELECT first_unreferenced_at>?1 FROM asset_cleanup_candidates",[now()-1000],|row|row.get::<_,bool>(0))?);Ok(())}).unwrap();
    }

    #[tokio::test]
    async fn failed_local_deletion_keeps_the_candidate_and_can_retry() {
        let(_dir,db,assets)=super::super::tests::setup();
        let id=assets.import(&db,"retry.png",&super::super::tests::png()).unwrap();
        let file=db.read(|conn|super::super::by_id(conn,&id)).unwrap();
        let path=assets.root.join(file.path.unwrap());
        assets.cleanup_for_update(&db).await.unwrap();
        db.write(|tx|{tx.execute("UPDATE asset_cleanup_candidates SET first_unreferenced_at=?1",[now()-GRACE_MS-1])?;Ok(())}).unwrap();
        std::fs::remove_file(&path).unwrap(); std::fs::create_dir(&path).unwrap();
        db.begin_exit();db.start_cleaning();
        assert!(assets.cleanup_for_update(&db).await.is_err());
        db.read(|conn|{assert_eq!(conn.query_row("SELECT COUNT(*) FROM asset_cleanup_candidates",[],|row|row.get::<_,i64>(0))?,1);assert_eq!(conn.query_row("SELECT status FROM jobs WHERE kind='cleanup'",[],|row|row.get::<_,String>(0))?,"failed");Ok(())}).unwrap();
        std::fs::remove_dir(&path).unwrap();std::fs::write(&path,super::super::tests::png()).unwrap();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(!path.exists());
        db.read(|conn|{assert_eq!(conn.query_row("SELECT status FROM jobs WHERE kind='cleanup'",[],|row|row.get::<_,String>(0))?,"completed");Ok(())}).unwrap();
    }

    #[tokio::test]
    async fn unreferenced_original_waits_seven_days_and_only_deletes_with_writers_frozen() {
        let (_dir, db, assets) = super::super::tests::setup();
        let id = assets.import(&db,"delayed.png",&super::super::tests::png()).unwrap();
        let file = db.read(|conn| super::super::by_id(conn,&id)).unwrap();
        let path = assets.root.join(file.path.unwrap());
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(path.exists(),"unreferenced originals must survive the grace period");
        db.maintenance(|tx| {
            tx.execute("UPDATE asset_cleanup_candidates SET first_unreferenced_at=?1",[now()-7*24*60*60*1000-1])?;
            Ok(())
        }).unwrap();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(path.exists(),"running writers must prevent physical deletion");
        db.begin_exit(); db.start_cleaning();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn regression_cleanup_removes_orphaned_thumbnails_and_keeps_live_shared_hashes() {
        let (dir, db, assets) = super::super::tests::setup();
        let cache = dir.path().join("缩略图 cache");
        let assets = assets.with_thumbnail_cache(cache.clone());
        let bytes = super::super::tests::png();
        let kept = assets.import_to_library(&db, "保留.png", &bytes).unwrap();
        assets.thumbnail(&db, &kept).await.unwrap();
        let hash = db
            .read(|conn| super::super::by_id(conn, &kept))
            .unwrap()
            .hash
            .unwrap();
        let live = cache.join(format!("v1-160-{hash}.png"));
        let orphan = cache.join(format!("v1-160-{}.png", "a".repeat(64)));
        let unrelated = cache.join("用户文件.png");
        std::fs::write(&orphan, b"stale").unwrap();
        std::fs::write(&unrelated, b"leave alone").unwrap();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(!orphan.exists());
        assert!(live.exists());
        assert!(unrelated.exists());
        db.write(|tx| {
            tx.execute("UPDATE assets SET retain_on_exit=0 WHERE id=?1", [&kept])?;
            Ok(())
        })
        .unwrap();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(live.exists());
        db.maintenance(|tx| { tx.execute("UPDATE asset_cleanup_candidates SET first_unreferenced_at=?1",[now()-GRACE_MS-1])?; Ok(()) }).unwrap();
        db.begin_exit(); db.start_cleaning();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(!live.exists());
        assert!(unrelated.exists());
    }

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
    async fn shared_remote_targets_remain_untouched_without_global_reference_evidence() {
        let (_dir,db,assets)=super::super::tests::setup();
        let asset=assets.import(&db,"shared.png",&super::super::tests::png()).unwrap();
        let file=db.read(|conn| super::super::by_id(conn,&asset)).unwrap();
        let hash=file.hash.unwrap();
        db.write(|tx| {
            for profile in ["a","b"] {
                tx.execute("INSERT INTO storage_profiles VALUES(?1,'images','https://s3.example.test','test','bucket','','https://images.example.test',?1)",[profile])?;
                tx.execute("INSERT INTO asset_locations(sha256,storage_profile_id,object_key) VALUES(?1,?2,?2)",params![hash,profile])?;
            }
            Ok(())
        }).unwrap();
        db.begin_exit(); db.start_cleaning();
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(assets.root.join(file.path.unwrap()).is_file());
        db.read(|conn| {
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM asset_locations WHERE deleted_at IS NULL",[],|row| row.get::<_,i64>(0))?,2);
            assert!(groups(conn,&BTreeSet::new())?.is_empty());
            Ok(())
        }).unwrap();
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
    async fn public_and_synced_images_stay_protected_even_after_losing_local_references() {
        let (_dir,db,assets)=super::super::tests::setup();
        let asset=assets.import(&db,"public.png",&super::super::tests::png()).unwrap();
        let file=db.read(|conn| super::super::by_id(conn,&asset)).unwrap();
        let hash=file.hash.unwrap();
        db.write(|tx| {
            tx.execute("INSERT INTO sync_revisions VALUES('asset',?1,1,0)",[&asset])?;
            tx.execute("INSERT INTO storage_profiles VALUES('s','images','https://s3.example.test','test','bucket','','https://images.example.test','s')",[])?;
            tx.execute("INSERT INTO asset_locations(sha256,storage_profile_id,object_key,public_url,uploaded_at) VALUES(?1,'s','key','https://images.example.test/key',1)",[&hash])?;
            Ok(())
        }).unwrap();
        db.begin_exit(); db.start_cleaning();
        // No remote delete is issued, so an unknown or timed-out prior delete cannot lose this local copy.
        assets.cleanup_for_update(&db).await.unwrap();
        assert!(assets.root.join(file.path.unwrap()).is_file());
        db.read(|conn| {
            assert!(protected(conn)?.contains(&hash));
            assert_eq!(conn.query_row("SELECT uploaded_at,deleted_at FROM asset_locations WHERE sha256=?1",[&hash],|row| Ok((row.get::<_,i64>(0)?,row.get::<_,Option<i64>>(1)?)))?,(1,None));
            Ok(())
        }).unwrap();
    }
}
