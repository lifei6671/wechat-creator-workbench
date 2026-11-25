use super::*;

#[tokio::test]
async fn restored_original_can_requeue_a_rejected_initialization_asset() {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
    let asset_root = root.path().join("assets");
    let assets = Assets::new(asset_root.clone(), &db).unwrap();
    db.write(|tx| {
        tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://127.0.0.1:1/','instance','epoch','device'); UPDATE sync_progress SET capture=1,seeding=1;")?;
        Ok(())
    }).unwrap();
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let bytes = encoded.into_inner();
    let asset_id = assets.import(&db, "original.png", &bytes).unwrap();
    let relative = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [&asset_id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap();
    let path = asset_root.join(relative);
    // This file was created by the test inside its own temporary asset root.
    std::fs::remove_file(&path).unwrap();
    let sync = SyncConnection::new().unwrap();
    let remote = Remote {
        sync: &sync,
        base: Url::parse("http://127.0.0.1:1/").unwrap(),
        token: "isolated".into(),
        binding: Binding {
            url: "http://127.0.0.1:1/".into(),
            instance_id: "instance".into(),
            epoch: "epoch".into(),
            device_id: "device".into(),
            paused: false,
            pause_reason: None,
        },
    };
    assert!(push_one(&db, &assets, &remote, 0).await.unwrap());
    assert!(stage_outbox(&db).unwrap().is_none());
    retry_repaired_assets(&db, &assets).await.unwrap();
    assert!(stage_outbox(&db).unwrap().is_none());
    std::fs::write(&path, b"wrong original").unwrap();
    retry_repaired_assets(&db, &assets).await.unwrap();
    assert!(stage_outbox(&db).unwrap().is_none());
    let generation_before = db
        .read(|conn| {
            generation(
                conn,
                &Key {
                    entity_type: Kind::Asset,
                    entity_id: asset_id.clone(),
                },
            )
        })
        .unwrap();
    std::fs::write(&path, bytes).unwrap();
    // Restoring bytes does not itself change SQLite's dirty generation.
    assert_eq!(
        db.read(|conn| generation(
            conn,
            &Key {
                entity_type: Kind::Asset,
                entity_id: asset_id.clone()
            }
        ))
        .unwrap(),
        generation_before
    );
    retry_repaired_assets(&db, &assets).await.unwrap();
    assert!(stage_outbox(&db).unwrap().is_some());
}

#[test]
fn dependent_entries_only_retry_after_all_required_assets_are_acknowledged() {
    let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
    db.write(|tx| {
        tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://localhost/','i','e','d'); UPDATE sync_progress SET capture=1;
          INSERT INTO assets(id,name,kind,created_at) VALUES('a','A','original',1),('b','B','original',1);
          INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('first','article','First','draft','keep first',1,1),('second','article','Second','draft','keep second',1,1);
          INSERT INTO entry_assets VALUES('first','a'),('first','b'),('second','b');")?;
        for id in ["first", "second"] {
            let key = Key { entity_type: Kind::Entry, entity_id: id.into() };
            issue(tx, &key, generation(tx, &key)?.unwrap(), "云端缺少关联素材", None)?;
        }
        remember(tx, &Key { entity_type: Kind::Asset, entity_id: "a".into() }, 1, false)?;
        retry_asset_dependents(tx, &["a"])?;
        assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_,i64>(0))?, 2);
        remember(tx, &Key { entity_type: Kind::Asset, entity_id: "b".into() }, 1, false)?;
        retry_asset_dependents(tx, &["b"])?;
        assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row.get::<_,i64>(0))?, 0);
        assert_eq!(tx.query_row("SELECT COUNT(*) FROM sync_dirty WHERE entity_type='entry'", [], |row| row.get::<_,i64>(0))?, 2);
        assert_eq!(entries::snapshot(tx,"first")?.unwrap()["contentMd"], "keep first");
        Ok(())
    }).unwrap();
}

#[tokio::test]
async fn network_failure_keeps_the_frozen_operation_and_dirty_generation() {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
    let assets = Assets::new(root.path().join("assets"), &db).unwrap();
    db.write(|tx| {
        tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://127.0.0.1:1/','instance','epoch','device'); UPDATE sync_progress SET capture=1,seeding=1;")?;
        Ok(())
    }).unwrap();
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    assets
        .import(&db, "original.png", &encoded.into_inner())
        .unwrap();
    let (operation, generations) = stage_outbox(&db).unwrap().unwrap();
    let frozen = encode(&operation).unwrap();
    let sync = SyncConnection::new().unwrap();
    let remote = Remote {
        sync: &sync,
        base: Url::parse("http://127.0.0.1:1/").unwrap(),
        token: "isolated".into(),
        binding: Binding {
            url: "http://127.0.0.1:1/".into(),
            instance_id: "instance".into(),
            epoch: "epoch".into(),
            device_id: "device".into(),
            paused: false,
            pause_reason: None,
        },
    };
    assert!(push_one(&db, &assets, &remote, 0).await.is_err());
    retry_repaired_assets(&db, &assets).await.unwrap();
    let retried = stage_outbox(&db).unwrap().unwrap();
    assert_eq!(encode(&retried.0).unwrap(), frozen);
    assert_eq!(retried.1, generations);
    assert_eq!(activity(&db).unwrap().unwrap().issues, 0);
}

#[tokio::test]
#[ignore = "requires an isolated fresh v2 service and native system keyring"]
async fn initialization_resumes_after_original_repair_and_keeps_other_devices_waiting() {
    use crate::sync::{ConnectWith, connect, create_recovery_key};
    struct Credentials(Vec<keyring::Entry>);
    impl Drop for Credentials {
        fn drop(&mut self) {
            for key in &self.0 {
                let _ = key.delete_credential();
            }
        }
    }
    let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
    let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("writer.sqlite")).unwrap();
    let peer = Workspace::open(&root.path().join("peer.sqlite")).unwrap();
    let asset_root = root.path().join("assets");
    let assets = Assets::new(asset_root.clone(), &db).unwrap();
    let peer_assets = Assets::new(root.path().join("peer-assets"), &peer).unwrap();
    let sync = SyncConnection::new().unwrap();
    let mut credentials = Credentials(Vec::new());
    let binding = connect(&db, &sync, &url, "Writer", ConnectWith::Join, &setup)
        .await
        .unwrap();
    credentials.0.push(binding.key(&db).unwrap());
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let bytes = encoded.into_inner();
    let id = assets.import(&db, "original.png", &bytes).unwrap();
    db.write(|tx| {
        tx.execute_batch("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('good','article','Good','draft','keep good',1,1);")?;
        tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('illustrated','article','Illustrated','draft',?1,1,1)", [format!("![original](asset://{id})")])?;
        crate::assets::references::sync_entry(tx,"illustrated",&format!("![original](asset://{id})"))?;
        Ok(())
    }).unwrap();
    let path = db
        .read(|conn| {
            Ok(asset_root.join(conn.query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [&id],
                |row| row.get::<_, String>(0),
            )?))
        })
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        run(&db, &assets, &sync).await.unwrap_err().code(),
        "SYNC_INITIALIZATION_BLOCKED"
    );
    let state = activity(&db).unwrap().unwrap();
    assert!(!state.initialized && state.pending_count >= 1 && state.rejected_count >= 1);
    assert!(state.blocking_issue.is_some());
    let good = Key {
        entity_type: Kind::Entry,
        entity_id: "good".into(),
    };
    assert_eq!(db.read(|conn| revision(conn, &good)).unwrap().0, 1);
    let second = connect(&peer, &sync, &url, "Peer", ConnectWith::Join, &setup)
        .await
        .unwrap();
    credentials.0.push(second.key(&peer).unwrap());
    assert_eq!(
        run(&peer, &peer_assets, &sync).await.unwrap_err().code(),
        "SYNC_WAITING_SEED"
    );
    let recovery = create_recovery_key(&db, &sync).await.unwrap();
    binding.key(&db).unwrap().delete_credential().unwrap();
    let recovered = connect(
        &db,
        &sync,
        &url,
        "Recovered writer",
        ConnectWith::Recover,
        &recovery,
    )
    .await
    .unwrap();
    assert_eq!(recovered.device_id, binding.device_id);
    assert_eq!(recovered.epoch, binding.epoch);
    assert!(!progress(&db).unwrap().0);
    assert!(activity(&db).unwrap().unwrap().pending_count >= 1);
    std::fs::write(&path, b"damaged file").unwrap();
    assert_eq!(assets.import_to_library(&db, "recovered.png", &bytes).unwrap(), id);
    retry_repaired_assets(&db, &assets).await.unwrap();
    run(&db, &assets, &sync).await.unwrap();
    assert!(progress(&db).unwrap().0);
    assert_eq!(db.read(|conn| revision(conn, &good)).unwrap().0, 1);
    assert_eq!(activity(&db).unwrap().unwrap().pending_count, 0);
    assert_eq!(activity(&db).unwrap().unwrap().issues, 0);
    let persisted = db
        .setting::<(String, String, i64)>("sync-last-success")
        .unwrap()
        .unwrap();
    assert_eq!(
        (persisted.0, persisted.1),
        (binding.instance_id, binding.epoch)
    );
    run(&peer, &peer_assets, &sync).await.unwrap();
    apply_received(&peer).unwrap();
    assert_eq!(
        peer.read(|conn| entries::snapshot(conn, "good"))
            .unwrap()
            .unwrap()["contentMd"],
        "keep good"
    );
    assert_eq!(
        peer_assets
            .read_image(&peer, &format!("asset://{id}"), false)
            .await
            .unwrap(),
        bytes
    );
}


#[tokio::test]
#[ignore = "requires an isolated fresh service and a native system keyring"]
async fn failed_legacy_baseline_refetches_after_versioned_admin_repair() {
    use crate::sync::{ConnectWith, connect};
    struct Credentials(Vec<keyring::Entry>);
    impl Drop for Credentials {
        fn drop(&mut self) {
            for key in &self.0 { let _ = key.delete_credential(); }
        }
    }
    let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
    let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
    let root = tempfile::tempdir().unwrap();
    let writer = Workspace::open(&root.path().join("writer.sqlite")).unwrap();
    let reader_path = root.path().join("reader.sqlite");
    let reader = Workspace::open(&reader_path).unwrap();
    let assets = Assets::new(root.path().join("assets"), &writer).unwrap();
    let reader_assets = Assets::new(root.path().join("reader-assets"), &reader).unwrap();
    let sync = SyncConnection::new().unwrap();
    let mut credentials = Credentials(Vec::new());
    let binding = connect(&writer, &sync, &url, "Admin", ConnectWith::Join, &setup).await.unwrap();
    credentials.0.push(binding.key(&writer).unwrap());
    writer.write(|tx| {
        tx.execute_batch("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('legacy','article','Legacy','draft','preserved remote body',1,1)")?;
        Ok(())
    }).unwrap();
    run(&writer, &assets, &sync).await.unwrap();
    reqwest::Client::new().post(format!("{url}__test/legacy-invalid")).send().await.unwrap().error_for_status().unwrap();
    let binding = connect(&reader, &sync, &url, "Fresh reader", ConnectWith::Join, &setup).await.unwrap();
    credentials.0.push(binding.key(&reader).unwrap());
    run(&reader, &reader_assets, &sync).await.unwrap();
    assert!(apply_received(&reader).is_err());
    let failed_cursor = progress(&reader).unwrap().3.unwrap();
    assert!(!progress(&reader).unwrap().0);
    assert!(reader.read(|conn| entries::snapshot(conn, "legacy")).unwrap().is_none());
    writer.write(|tx| { tx.execute("UPDATE entries SET title='Repaired' WHERE id='legacy'", [])?; Ok(()) }).unwrap();
    run(&writer, &assets, &sync).await.unwrap();
    drop(reader);
    let reader = Workspace::open(&reader_path).unwrap();
    run(&reader, &reader_assets, &sync).await.unwrap();
    assert!(progress(&reader).unwrap().3.unwrap() > failed_cursor);
    apply_received(&reader).unwrap();
    assert!(progress(&reader).unwrap().0);
    let restored = reader.read(|conn| entries::snapshot(conn, "legacy")).unwrap().unwrap();
    assert_eq!(restored["title"], "Repaired");
    assert_eq!(restored["contentMd"], "preserved remote body");
    assert_eq!(reader.read(|conn| revision(conn, &Key { entity_type: Kind::Entry, entity_id: "legacy".into() })).unwrap(), (2, false));
}
