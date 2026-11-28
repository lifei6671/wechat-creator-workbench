use super::*;
use crate::db::now;
use rusqlite::params;
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Workspace, super::super::Assets) {
    let (directory, db, assets) = super::super::tests::setup();
    db.write(|tx| {
        tx.execute("UPDATE sync_progress SET capture=0", [])?;
        tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('article','article','文章','draft','',0,0)", [])?;
        tx.execute("INSERT INTO assets(id,sha256,mime_type,relative_path,kind,bytes,created_at,name,width,height,retain_on_exit)
            VALUES('source','source-hash','image/png','source.png','original',20,0,'原图',10,10,0)", [])?;
        tx.execute("INSERT INTO image_projects(id,origin_entry_id,base_asset_id,scene_json,created_at,updated_at) VALUES('project','article','source','{}',0,0)", [])?;
        tx.execute("INSERT INTO image_project_assets VALUES('project','source')", [])?;
        for index in 0..8 {
            let id = format!("render-{index}");
            let output = format!("output-{index}");
            tx.execute("INSERT INTO assets(id,sha256,mime_type,relative_path,kind,source_key,bytes,created_at,name,width,height,retain_on_exit)
                VALUES(?1,?2,'image/png',?3,'original',?4,100,?5,'成品',10,10,0)",
                params![output, format!("hash-{index}"), format!("file-{index}.png"), format!("image-render:{id}"), now()-40*DAY_MS+index])?;
            tx.execute("INSERT INTO image_renders VALUES(?1,'project','{}','scene',?2,'[\"source\"]','{}','konva-2',?3)", params![id,output,now()-40*DAY_MS+index])?;
        }
        Ok(())
    }).unwrap();
    (directory, db, assets)
}

#[test]
fn distinguishes_originals_and_keeps_latest_five_without_self_rooting_all_history() {
    let (_directory, db, assets) = fixture();
    let preview = assets.image_version_preview(&db).unwrap();
    assert_eq!(preview.files.len(), 8);
    assert_eq!(preview.reclaimable_bytes, 300);
    for index in 0..8 {
        let item = preview
            .files
            .iter()
            .find(|item| item.asset_id == format!("output-{index}"))
            .unwrap();
        assert_eq!(item.reasons.is_empty(), index < 3);
    }
    db.write(|tx| {
        tx.execute(
            "UPDATE assets SET sha256='source-hash' WHERE id='output-0'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let preview = assets.image_version_preview(&db).unwrap();
    assert!(
        preview
            .files
            .iter()
            .find(|item| item.asset_id == "output-0")
            .unwrap()
            .reasons
            .contains(&Protection::Original)
    );
}

#[test]
fn references_covers_recovery_and_transitive_render_dependencies_keep_shared_bytes() {
    let (_directory, db, assets) = fixture();
    db.write(|tx| {
        tx.execute("UPDATE entries SET content_md='![图片](asset://output-0)',cover_asset_id='output-1' WHERE id='article'", [])?;
        tx.execute("UPDATE image_renders SET asset_ids_json='[\"output-2\"]' WHERE id='render-7'", [])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        assets.image_version_preview(&db).unwrap().reclaimable_bytes,
        0
    );
}

#[test]
fn uploaded_synced_and_unknown_backup_versions_are_not_candidates() {
    let (_directory, db, assets) = fixture();
    db.write(|tx| {
        tx.execute("INSERT INTO asset_public_protection VALUES('hash-0',0)", [])?;
        tx.execute(
            "INSERT INTO sync_revisions(entity_type,entity_id,revision,deleted) VALUES('asset','output-1',1,0)",
            [],
        )?;
        tx.execute(
            "UPDATE assets SET created_at=?1 WHERE id='output-2'",
            [now()],
        )?;
        // Version age comes from the immutable render, not a mutable asset timestamp.
        Ok(())
    })
    .unwrap();
    let preview = assets.image_version_preview(&db).unwrap();
    assert_eq!(preview.reclaimable_bytes, 100);
    assert!(
        preview
            .files
            .iter()
            .find(|item| item.asset_id == "output-0")
            .unwrap()
            .reasons
            .contains(&Protection::Public)
    );
    assert!(
        preview
            .files
            .iter()
            .find(|item| item.asset_id == "output-1")
            .unwrap()
            .reasons
            .contains(&Protection::Synced)
    );
    db.write(|tx| {
        tx.execute(
            "INSERT INTO backup_asset_manifests VALUES('scope','unknown','unverified',0)",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        assets.image_version_preview(&db).unwrap().reclaimable_bytes,
        0
    );
}

#[test]
fn shared_hashes_are_counted_once_and_malformed_dependencies_stop_the_scan() {
    let (_directory, db, assets) = fixture();
    db.write(|tx| {
        tx.execute("UPDATE assets SET sha256='hash-0' WHERE id='output-1'", [])?;
        Ok(())
    })
    .unwrap();
    let preview = assets.image_version_preview(&db).unwrap();
    assert_eq!(preview.files.len(), 7);
    assert_eq!(preview.reclaimable_bytes, 200);
    db.write(|tx| {
        tx.execute(
            "UPDATE image_renders SET asset_ids_json=?1 WHERE id='render-0'",
            [json!({"invalid":true}).to_string()],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        assets.image_version_preview(&db).err().unwrap().code(),
        "ASSET_REFERENCES"
    );
}

fn byte_fixture() -> (tempfile::TempDir, Workspace, super::super::Assets) {
    let (directory, db, assets) = fixture();
    db.write(|conn| {
        for index in 0..8 {
            let data = format!("rendered image bytes {index}").into_bytes();
            let hash = hex::encode(Sha256::digest(&data));
            std::fs::create_dir_all(&assets.root).unwrap();
            std::fs::write(assets.root.join(format!("file-{index}.png")), &data).unwrap();
            conn.execute(
                "UPDATE assets SET sha256=?2,bytes=?3 WHERE id=?1",
                params![format!("output-{index}"), hash, data.len() as i64],
            )?;
        }
        Ok(())
    })
    .unwrap();
    (directory, db, assets)
}

#[test]
fn automatically_waits_backs_up_and_restores_before_accepting_a_new_reference() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    assets.maintain_image_versions(&db, stamp).unwrap();
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT count(*) FROM image_version_cleanup WHERE state='waiting'",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        3
    );
    assert!(assets.root.join("file-0.png").exists());
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS - 1)
        .unwrap();
    assert!(assets.root.join("file-0.png").exists());
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS)
        .unwrap();
    let (output,backup) = db.read(|conn|Ok(conn.query_row("SELECT a.id,c.backup_path FROM image_version_cleanup c JOIN assets a ON a.sha256=c.sha256 WHERE c.state='removed'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?)).unwrap();
    assert!(assets.root.join(&backup).exists());
    db.write(|conn| {
        conn.execute(
            "UPDATE entries SET content_md=?1 WHERE id='article'",
            [format!("![图](asset://{output})")],
        )?;
        Ok(())
    })
    .unwrap();
    let restored = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [output],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert!(assets.root.join(restored).exists());
    assert_eq!(
        db.read(|conn| Ok(
            conn.query_row("SELECT count(*) FROM image_renders", [], |r| r
                .get::<_, i64>(0))?
        ))
        .unwrap(),
        8
    );
}

#[test]
fn new_reference_cancels_automatic_waiting_and_undo_is_kept_for_the_connection() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    assets.maintain_image_versions(&db, stamp).unwrap();
    db.write(|conn| {
        super::super::references::sync_entry(conn, "article", "![图](asset://output-0)")?;
        super::super::references::sync_entry(conn, "article", "")?;
        Ok(())
    })
    .unwrap();
    let file = assets
        .image_version_preview(&db)
        .unwrap()
        .files
        .into_iter()
        .find(|f| f.asset_id == "output-0")
        .unwrap();
    assert!(file.reasons.contains(&Protection::Session));
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS)
        .unwrap();
    assert!(assets.root.join("file-0.png").exists());
}

#[test]
fn corrupt_bytes_stop_deletion_and_expiry_never_accepts_a_broken_reference() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    assets.maintain_image_versions(&db, stamp).unwrap();
    db.write(|conn|{conn.execute("UPDATE image_version_cleanup SET due_at=?1 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-0')",[stamp-WAIT_MS])?;Ok(())}).unwrap();
    std::fs::write(assets.root.join("file-0.png"), b"changed").unwrap();
    assert_eq!(
        assets
            .maintain_image_versions(&db, stamp)
            .unwrap_err()
            .code(),
        "IMAGE_CLEANUP_CHANGED"
    );
    assert!(assets.root.join("file-0.png").exists());
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS)
        .unwrap();
    let output = db.read(|conn|Ok(conn.query_row("SELECT a.id FROM assets a JOIN image_version_cleanup c ON c.sha256=a.sha256 WHERE c.state='removed'",[],|r|r.get::<_,String>(0))?)).unwrap();
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS + RECOVERY_MS)
        .unwrap();
    let result = db.write(|conn| {
        conn.execute(
            "UPDATE entries SET content_md=?1 WHERE id='article'",
            [format!("![图](asset://{output})")],
        )?;
        Ok(())
    });
    assert_eq!(result.unwrap_err().code(), "IMAGE_VERSION_EXPIRED");
    let draft =
        json!({"title":"未提交草稿","contentMd":format!("保留新写的文字 ![图](asset://{output})")})
            .to_string();
    db.write(|conn| {
        conn.execute("INSERT INTO editor_recovery(entry_id,session_id,entry_kind,base_version,local_revision,fields_json,updated_at)
            VALUES('article','draft-session','article',1,1,?1,?2)",params![draft,now()])?;
        Ok(())
    }).unwrap();
    db.write(|conn| {
        conn.execute(
            "UPDATE entries SET title='其他正常修改' WHERE id='article'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT fields_json FROM editor_recovery WHERE session_id='draft-session'",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap()
        .contains("保留新写的文字")
    );
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT content_md FROM entries WHERE id='article'",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        ""
    );
}

#[tokio::test]
async fn publishing_and_externalizing_keep_previous_versions_even_after_article_changes() {
    let (_directory, db, assets) = fixture();
    db.write(|conn| {
        super::super::references::sync_entry(conn, "article", "![图](asset://output-0)")?;
        conn.execute(
            "UPDATE entries SET status='published' WHERE id='article'",
            [],
        )?;
        conn.execute(
            "UPDATE entries SET status='draft',content_md='' WHERE id='article'",
            [],
        )?;
        super::super::references::sync_entry(conn, "article", "")?;
        Ok(())
    })
    .unwrap();
    protect_external(
        &db,
        &assets,
        "https://example.invalid/picture asset://output-1",
    )
    .await
    .unwrap();
    let preview = assets.image_version_preview(&db).unwrap();
    for id in ["output-0", "output-1"] {
        assert!(
            preview
                .files
                .iter()
                .find(|f| f.asset_id == id)
                .unwrap()
                .reasons
                .contains(&Protection::Published)
        );
    }
}

#[test]
fn expires_without_blacklisting_verified_same_bytes_supplied_later() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    assets.maintain_image_versions(&db, stamp).unwrap();
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS)
        .unwrap();
    let (output,hash)=db.read(|conn|Ok(conn.query_row("SELECT a.id,c.sha256 FROM assets a JOIN image_version_cleanup c ON c.sha256=a.sha256 WHERE c.state='removed'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?)).unwrap();
    let bytes = format!(
        "rendered image bytes {}",
        output.strip_prefix("output-").unwrap()
    )
    .into_bytes();
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS + RECOVERY_MS)
        .unwrap();
    std::fs::write(assets.root.join("new-original.png"), &bytes).unwrap();
    db.write(|conn| {
        conn.execute("INSERT INTO assets(id,sha256,mime_type,relative_path,kind,bytes,created_at,name,width,height) VALUES('new-original',?1,'image/png','new-original.png','original',?2,?3,'新原图',10,10)",params![hash,bytes.len() as i64,now()])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT count(*) FROM assets WHERE id='new-original'",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        1
    );
    let path = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [output],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert_eq!(std::fs::read(assets.root.join(path)).unwrap(), bytes);
}

#[test]
fn removes_every_verified_physical_alias_and_retries_a_temporary_backup_failure() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    let bytes = std::fs::read(assets.root.join("file-0.png")).unwrap();
    std::fs::write(assets.root.join("file-1.png"), &bytes).unwrap();
    db.write(|conn|{conn.execute("UPDATE assets SET sha256=(SELECT sha256 FROM assets WHERE id='output-0'),bytes=?1 WHERE id='output-1'",[bytes.len() as i64])?;Ok(())}).unwrap();
    assets.maintain_image_versions(&db, stamp).unwrap();
    db.write(|conn|{conn.execute("UPDATE image_version_cleanup SET due_at=?1,created_at=0 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-0')",[stamp])?;Ok(())}).unwrap();
    let blocked = assets.root.join(".image-version-recycle");
    std::fs::write(&blocked, b"temporary obstruction").unwrap();
    assert_eq!(
        assets
            .maintain_image_versions(&db, stamp)
            .unwrap_err()
            .code(),
        "ASSET_FILE"
    );
    assert!(assets.root.join("file-0.png").exists());
    assert!(assets.root.join("file-1.png").exists());
    std::fs::remove_file(&blocked).unwrap();
    assets.maintain_image_versions(&db, stamp + DAY_MS).unwrap();
    assert!(!assets.root.join("file-0.png").exists());
    assert!(!assets.root.join("file-1.png").exists());
    db.write(|conn| {
        conn.execute(
            "UPDATE entries SET content_md='![旧图](asset://output-1)' WHERE id='article'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let paths = db
        .read(|conn| {
            let mut q = conn.prepare(
                "SELECT DISTINCT relative_path FROM assets WHERE id IN ('output-0','output-1')",
            )?;
            Ok(q.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(paths.len(), 1);
    assert_eq!(std::fs::read(assets.root.join(&paths[0])).unwrap(), bytes);
}

#[test]
fn recoverable_snapshot_keeps_older_dependency_backup_until_the_snapshot_is_restored() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    db.write(|conn| {
        conn.execute(
            "UPDATE image_renders SET asset_ids_json='[\"output-0\"]' WHERE id='render-1'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assets.maintain_image_versions(&db, stamp).unwrap();
    db.write(|conn|{
        conn.execute("UPDATE image_version_cleanup SET due_at=?1,created_at=0 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-0')",[stamp])?;
        conn.execute("UPDATE image_version_cleanup SET due_at=?1,created_at=1 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-1')",[stamp+DAY_MS])?;
        Ok(())
    }).unwrap();
    assets.maintain_image_versions(&db, stamp).unwrap();
    assets.maintain_image_versions(&db, stamp + DAY_MS).unwrap();
    let backup=db.read(|conn|Ok(conn.query_row("SELECT backup_path FROM image_version_cleanup WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-0')",[],|r|r.get::<_,String>(0))?)).unwrap();
    assets
        .maintain_image_versions(&db, stamp + RECOVERY_MS)
        .unwrap();
    assert!(assets.root.join(backup).exists());
    db.write(|conn| {
        conn.execute(
            "UPDATE entries SET content_md='![恢复](asset://output-1)' WHERE id='article'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    for id in ["output-0", "output-1"] {
        let path = db
            .read(|conn| {
                Ok(
                    conn.query_row("SELECT relative_path FROM assets WHERE id=?1", [id], |r| {
                        r.get::<_, String>(0)
                    })?,
                )
            })
            .unwrap();
        assert!(assets.root.join(path).exists());
    }
}

#[test]
fn interrupted_removal_restores_bytes_before_committing_a_new_reference() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    assets.maintain_image_versions(&db, stamp).unwrap();
    db.write(|conn|{
        conn.execute("UPDATE image_version_cleanup SET due_at=?1 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-0')",[stamp])?;
        conn.execute_batch("CREATE TEMP TRIGGER cleanup_fault BEFORE UPDATE OF relative_path ON assets WHEN NEW.relative_path IS NULL BEGIN SELECT RAISE(ABORT,'simulated commit failure'); END;")?;
        Ok(())
    }).unwrap();
    assert!(assets.maintain_image_versions(&db, stamp).is_err());
    assert!(!assets.root.join("file-0.png").exists());
    db.write(|conn| {
        conn.execute_batch("DROP TRIGGER cleanup_fault;")?;
        conn.execute(
            "UPDATE entries SET content_md='![恢复](asset://output-0)' WHERE id='article'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(assets.root.join("file-0.png").exists());
}

#[test]
fn expired_recovery_roots_do_not_keep_a_shared_hash_dependency_cycle_forever() {
    let (_directory, db, _assets) = fixture();
    let stamp = now();
    db.write(|conn| {
        conn.execute("UPDATE assets SET sha256='hash-0' WHERE id='output-2'",[])?;
        conn.execute("UPDATE image_renders SET asset_ids_json='[\"output-0\"]' WHERE id='render-1'",[])?;
        conn.execute("UPDATE image_renders SET asset_ids_json='[\"output-1\"]' WHERE id='render-2'",[])?;
        for index in 0..2 {
            conn.execute("INSERT INTO image_version_cleanup(id,sha256,relative_path,bytes,state,created_at,due_at,backup_path,removed_at,expires_at)
                VALUES(?1,?2,?3,100,'removed',0,0,?4,?5,?6)",params![format!("job-{index}"),format!("hash-{index}"),format!("file-{index}.png"),format!("backup-{index}.bin"),stamp,stamp+DAY_MS])?;
        }
        conn.execute("UPDATE assets SET relative_path=NULL WHERE sha256 IN ('hash-0','hash-1')",[])?;
        Ok(())
    }).unwrap();
    let active = db.read(|conn| scan(conn, stamp)).unwrap();
    assert!(
        active
            .files
            .iter()
            .filter(|file| file.sha256 == "hash-0" || file.sha256 == "hash-1")
            .all(|file| file.reasons.contains(&Protection::Backup))
    );
    let expired = db.read(|conn| scan(conn, stamp + DAY_MS)).unwrap();
    assert!(
        expired
            .files
            .iter()
            .filter(|file| file.sha256 == "hash-0" || file.sha256 == "hash-1")
            .all(|file| !file.reasons.contains(&Protection::Backup))
    );
}

#[tokio::test]
async fn browsing_thumbnails_does_not_resurrect_versions_or_permanently_keep_automatic_restores() {
    let (directory, db, assets) = byte_fixture();
    let stamp = now();
    let bytes = super::super::tests::png();
    std::fs::write(assets.root.join("file-0.png"), &bytes).unwrap();
    db.write(|conn| {
        conn.execute(
            "UPDATE assets SET sha256=?1,bytes=?2 WHERE id='output-0'",
            params![hex::encode(Sha256::digest(&bytes)), bytes.len() as i64],
        )?;
        Ok(())
    })
    .unwrap();
    assets.thumbnail(&db, "output-0").await.unwrap();
    assert!(
        assets
            .image_version_preview(&db)
            .unwrap()
            .files
            .iter()
            .find(|file| file.asset_id == "output-0")
            .unwrap()
            .reasons
            .is_empty()
    );
    assets.maintain_image_versions(&db, stamp).unwrap();
    db.write(|conn|{conn.execute("UPDATE image_version_cleanup SET created_at=0 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-0')",[])?;Ok(())}).unwrap();
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS)
        .unwrap();
    assets.thumbnail(&db, "output-0").await.unwrap();
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT state FROM image_version_cleanup WHERE created_at=0",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "removed"
    );
    assert_eq!(assets.read(&db, "asset://output-0").await.unwrap(), bytes);
    assert!(
        !assets
            .image_version_preview(&db)
            .unwrap()
            .files
            .iter()
            .find(|file| file.asset_id == "output-0")
            .unwrap()
            .reasons
            .contains(&Protection::Retained)
    );
    let root = assets.root.clone();
    drop(assets);
    drop(db);
    let db = Workspace::open(&directory.path().join("content.db")).unwrap();
    let assets = super::super::Assets::new(root, &db).unwrap();
    assert!(
        assets
            .image_version_preview(&db)
            .unwrap()
            .files
            .iter()
            .find(|file| file.asset_id == "output-0")
            .unwrap()
            .reasons
            .is_empty()
    );
}

#[test]
fn a_parent_waiting_on_backup_keeps_its_input_recoverable_even_after_thirty_days() {
    let (_directory, db, assets) = byte_fixture();
    let stamp = now();
    db.write(|conn| {
        conn.execute(
            "UPDATE image_renders SET asset_ids_json='[\"output-0\"]' WHERE id='render-1'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assets.maintain_image_versions(&db, stamp).unwrap();
    db.write(|conn|{
        conn.execute("UPDATE image_version_cleanup SET created_at=0,due_at=?1 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-0')",[stamp])?;
        conn.execute("UPDATE image_version_cleanup SET created_at=1,due_at=?1 WHERE sha256=(SELECT sha256 FROM assets WHERE id='output-1')",[stamp+DAY_MS])?;
        Ok(())
    }).unwrap();
    assets.maintain_image_versions(&db, stamp).unwrap();
    let parent = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM image_version_cleanup WHERE created_at=1",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    let block = assets.root.join(".image-version-recycle").join(parent);
    std::fs::write(&block, b"temporary backup obstruction").unwrap();
    assert!(assets.maintain_image_versions(&db, stamp + DAY_MS).is_err());
    db.write(|conn| {
        conn.execute(
            "UPDATE image_version_cleanup SET attempts=3 WHERE created_at=1",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assets
        .maintain_image_versions(&db, stamp + RECOVERY_MS)
        .unwrap();
    let state = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT state FROM image_version_cleanup WHERE created_at=0",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert_eq!(state, "removed");
    std::fs::remove_file(block).unwrap();
    db.write(|conn| {
        conn.execute(
            "UPDATE image_version_cleanup SET attempts=0,due_at=?1 WHERE created_at=1",
            [stamp + RECOVERY_MS + DAY_MS],
        )?;
        Ok(())
    })
    .unwrap();
    assets
        .maintain_image_versions(&db, stamp + RECOVERY_MS + DAY_MS)
        .unwrap();
    db.write(|conn| {
        conn.execute(
            "UPDATE entries SET content_md='![恢复父成品](asset://output-1)' WHERE id='article'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(assets.root.join("file-0.png").exists());
    assert!(assets.root.join("file-1.png").exists());
}

#[tokio::test]
async fn externally_protecting_an_available_legacy_url_does_not_require_expired_local_raw_bytes() {
    let (_root, db, assets) = byte_fixture();
    let stamp = now();
    assets.maintain_image_versions(&db, stamp).unwrap();
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS)
        .unwrap();
    assets
        .maintain_image_versions(&db, stamp + WAIT_MS + RECOVERY_MS)
        .unwrap();
    let expired=db.read(|conn|Ok(conn.query_row("SELECT a.id FROM assets a JOIN image_version_cleanup c ON c.sha256=a.sha256 WHERE c.state='expired' LIMIT 1",[],|row|row.get::<_,String>(0))?)).unwrap();
    let url = "https://cdn.example.test/retained.webp";
    db.write(|conn|{
        conn.execute("INSERT INTO storage_profiles VALUES('legacy-public','images','https://s3.example.test','auto','images','','https://cdn.example.test','test')",[])?;
        conn.execute("INSERT INTO asset_locations(sha256,storage_profile_id,object_key,public_url,uploaded_at) SELECT sha256,'legacy-public','retained.webp',?1,1 FROM assets WHERE id=?2",rusqlite::params![url,expired])?;Ok(())
    }).unwrap();
    assert_eq!(
        protect_external(&db, &assets, &format!("![图]({url})"))
            .await
            .unwrap(),
        format!("![图]({url})")
    );
    db.write(|conn| {
        conn.execute("UPDATE entries SET title='仍可编辑' WHERE id='article'", [])?;
        Ok(())
    })
    .unwrap();
    assert!(
        db.write(|conn| {
            let body = format!("![旧原图](asset://{expired})");
            conn.execute(
                "UPDATE entries SET content_md=?1 WHERE id='article'",
                [&body],
            )?;
            super::super::references::sync_entry(conn, "article", &body)
        })
        .is_err()
    );
}
