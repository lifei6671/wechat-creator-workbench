use super::*;
use crate::sync::{ConnectWith, connect, create_access_key};
use std::io::Cursor;

fn scene(asset: &str) -> Value {
    json!({"schemaVersion":1,"artboard":{"width":8,"height":6,"background":{"type":"transparent"}},"layers":[{"id":"layer","assetId":asset,"x":0,"y":0,"width":8,"height":6,"rotation":0,"flipX":false,"flipY":false,"opacity":1,"crop":{"x":0,"y":0,"width":8,"height":6},"cornerRadius":0,"shadow":{"color":"#000000","blur":0,"offsetX":0,"offsetY":0,"opacity":0}}],"layout":{"mode":"free","gap":24,"padding":0,"columns":2,"align":"center","size":0}})
}
fn fixture() -> (tempfile::TempDir, Workspace, Assets, String, Value) {
    let dir = tempfile::tempdir().unwrap();
    let db = Workspace::open(&dir.path().join("workspace.sqlite")).unwrap();
    let assets = Assets::new(dir.path().join("assets"), &db).unwrap();
    db.write(|tx|{tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES (1,'http://localhost:1234/','instance','epoch','device');UPDATE sync_progress SET initialized=1,capture=1;")?;Ok(())}).unwrap();
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 6)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let input = assets
        .import_canvas(&db, "原图", &bytes.into_inner())
        .unwrap();
    let payload = json!({"originEntryId":"article","baseAssetId":input,"scene":scene(&input),"assetIds":[input],"createdAt":1,"updatedAt":1});
    db.write(|tx| crate::image_canvas::apply_project(tx, "project", &payload, None))
        .unwrap();
    (dir, db, assets, input, payload)
}
fn acknowledge(db: &Workspace, operation: &Operation, generations: &[i64]) {
    let outcome = Outcome {
        status: "applied".into(),
        reason: None,
        versions: Some(
            operation
                .mutations
                .iter()
                .map(|m| Version {
                    key: m.key.clone(),
                    remote_revision: m.base_revision + 1,
                })
                .collect(),
        ),
    };
    db.write(|tx| apply_outcome(tx, operation, generations, &outcome))
        .unwrap();
}
#[test]
fn output_group_waits_for_inputs_and_project_identity() {
    let (_dir, db, _assets, input, payload) = fixture();
    let hash = hex::encode(Sha256::digest(
        serde_json_canonicalizer::to_vec(&payload["scene"]).unwrap(),
    ));
    let render = json!({"projectId":"project","scene":payload["scene"],"sceneHash":hash,"outputAssetId":"000-output","assetIds":[input],"exportOptions":{"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"},"rendererVersion":"konva-1","createdAt":1});
    db.write(|tx|{
        tx.execute("UPDATE sync_progress SET active_batch='output-group'",[])?;
        tx.execute("INSERT INTO assets(id,sha256,mime_type,relative_path,kind,source_key,bytes,created_at,name,width,height) SELECT '000-output',sha256,mime_type,relative_path,'original','image-render:render',bytes,1,'成品',width,height FROM assets WHERE id=?1",[&input])?;
        crate::image_canvas::apply_render(tx,"render",&render,None)?;
        tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES ('article','article','标题','draft','![图片](asset://000-output)',1,1)",[])?;
        crate::assets::references::sync_entry(tx,"article","![图片](asset://000-output)")?;
        tx.execute("UPDATE sync_progress SET active_batch=NULL",[])?;Ok(())
    }).unwrap();
    let (first, generations) = stage_outbox(&db).unwrap().unwrap();
    assert_eq!(first.mutations.len(), 1);
    assert_eq!(first.mutations[0].key.entity_id, input);
    acknowledge(&db, &first, &generations);
    let (second, generations) = stage_outbox(&db).unwrap().unwrap();
    assert_eq!(second.mutations.len(), 1);
    assert_eq!(second.mutations[0].key.entity_type, Kind::ImageProject);
    acknowledge(&db, &second, &generations);
    let (final_group, generations) = stage_outbox(&db).unwrap().unwrap();
    assert_eq!(final_group.mutations.len(), 3);
    assert!(
        final_group
            .mutations
            .iter()
            .any(|m| m.key.entity_type == Kind::ImageRender)
    );
    assert!(
        final_group
            .mutations
            .iter()
            .any(|m| m.key.entity_type == Kind::Entry)
    );
    acknowledge(&db, &final_group, &generations);
    assert!(stage_outbox(&db).unwrap().is_none());
}
#[test]
fn project_conflict_copy_remains_reachable_without_rewriting_render_snapshots() {
    let (_dir, db, _assets, _input, payload) = fixture();
    let key = Key {
        entity_type: Kind::ImageProject,
        entity_id: "project".into(),
    };
    let mut cloud = payload.clone();
    cloud["scene"]["layers"][0]["x"] = json!(100);
    let remote = Entity {
        key: key.clone(),
        remote_revision: 2,
        deleted_at: None,
        payload: cloud,
    };
    let local_generation = db
        .write(|tx| {
            let current = generation(tx, &key)?.unwrap();
            issue(tx, &key, current, "同时修改", Some(&remote))?;
            Ok(current)
        })
        .unwrap();
    let changed =
        image_conflicts::resolve(&db, &key, Resolution::Copy, 2, local_generation).unwrap();
    assert_eq!(changed.changed_image_projects.len(), 2);
    db.read(|conn| {
        let copy = conn.query_row(
            "SELECT project_id FROM image_editor_state WHERE origin_entry_id='article'",
            [],
            |r| r.get::<_, String>(0),
        )?;
        assert_ne!(copy, "project");
        assert_eq!(
            crate::image_canvas::project_snapshot(conn, &copy)?.unwrap()["scene"],
            payload["scene"]
        );
        assert_eq!(
            crate::image_canvas::project_snapshot(conn, "project")?.unwrap()["scene"],
            remote.payload["scene"]
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated fresh v3 service and a native system keyring"]
async fn image_canvas_projects_renders_and_private_inputs_between_workspaces() {
    let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
    let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
    let root = tempfile::tempdir().unwrap();
    let a = Workspace::open(&root.path().join("a.sqlite")).unwrap();
    let b_folder = root.path().join("b");
    let (b, b_backups) = crate::backup::Backups::open(&b_folder).unwrap();
    let a_assets = Assets::new(root.path().join("assets-a"), &a).unwrap();
    let b_assets = Assets::new(b_folder.join("assets"), &b).unwrap();
    let sync = SyncConnection::new().unwrap();
    let first = connect(&a, &sync, &url, "图片画布 A", ConnectWith::Claim, &setup)
        .await
        .unwrap();
    let access = create_access_key(&a, &sync).await.unwrap();
    let second = connect(&b, &sync, &url, "图片画布 B", ConnectWith::Join, &access)
        .await
        .unwrap();
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 6)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let bytes = bytes.into_inner();
    let source = a_assets.import_canvas(&a, "私有原图", &bytes).unwrap();
    a.write(|tx|{tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES ('article','article','画布文章','draft',?1,1,1)",[format!("![原图](asset://{source})")])?;crate::assets::references::sync_entry(tx,"article",&format!("![原图](asset://{source})"))?;Ok(())}).unwrap();
    let project =
        crate::image_canvas::open_project(&a, &a_assets, "article", &format!("asset://{source}"))
            .await
            .unwrap();
    let project_id = project["id"].as_str().unwrap();
    let mut frozen = project["scene"].clone();
    frozen["layers"][0]["x"] = json!(0.000001);
    frozen["layers"][0]["y"] = json!(1e-7);
    crate::image_canvas::save_project(&a, project_id, 1, &frozen).unwrap();
    let options = json!({"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"});
    let render = crate::db::id();
    let output = crate::image_canvas::prepare_render(
        &a, &a_assets, &render, project_id, 2, &options, &bytes,
    )
    .unwrap();
    let body = format!("![成品]({})", output["src"].as_str().unwrap());
    let entry = json!({"id":"article","expectedVersion":1,"fields":{"title":"画布文章","status":"draft","categoryId":null,"contentMd":body,"coverAssetId":null,"themeId":null,"tags":[],"summary":"","source":null,"publishedAt":null,"publishedUrl":"","customProperties":[],"publicationPlatforms":[],"wechatPublication":null}});
    crate::image_canvas::commit_render(&a, &render, Some(entry)).unwrap();
    exchange(&a, &a_assets, &sync).await.unwrap();
    apply_received(&a).unwrap();
    exchange(&b, &b_assets, &sync).await.unwrap();
    apply_received(&b).unwrap();
    let remote_project = b
        .read(|conn| crate::image_canvas::project_snapshot(conn, project_id))
        .unwrap()
        .unwrap();
    assert_eq!(remote_project["scene"], frozen);
    let remote_render = b
        .read(|conn| crate::image_canvas::render_snapshot(conn, &render))
        .unwrap()
        .unwrap();
    assert_eq!(remote_render["scene"], frozen);
    let original_path = b
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [&source],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert!(!b_folder.join("assets").join(&original_path).exists());
    b_assets.prepare_synced_workspace_export(&b).await.unwrap();
    assert_eq!(
        std::fs::read(b_folder.join("assets").join(&original_path)).unwrap(),
        bytes
    );
    assert_eq!(
        b.read(|conn| entries::snapshot(conn, "article"))
            .unwrap()
            .unwrap()["contentMd"],
        body
    );
    assert_eq!(
        b_assets
            .read(&b, output["src"].as_str().unwrap())
            .await
            .unwrap(),
        bytes
    );
    assert_eq!(
        b_assets
            .read(&b, &format!("asset://{source}"))
            .await
            .unwrap(),
        bytes
    );
    let reopened = crate::image_canvas::open_project(
        &b,
        &b_assets,
        "article",
        output["src"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(reopened["scene"], frozen);
    assert_ne!(reopened["id"], project["id"]);
    let mut edited = frozen.clone();
    edited["layers"][0]["x"] = json!(12.5);
    let branch = reopened["id"].as_str().unwrap();
    crate::image_canvas::save_project(&b, branch, 1, &edited).unwrap();
    let second_render = crate::db::id();
    let second_output = crate::image_canvas::prepare_render(
        &b,
        &b_assets,
        &second_render,
        branch,
        2,
        &options,
        &bytes,
    )
    .unwrap();
    crate::image_canvas::commit_render(&b, &second_render, None).unwrap();
    exchange(&b, &b_assets, &sync).await.unwrap();
    apply_received(&b).unwrap();
    exchange(&a, &a_assets, &sync).await.unwrap();
    apply_received(&a).unwrap();
    assert_eq!(
        a.read(|conn| crate::image_canvas::render_snapshot(conn, &second_render))
            .unwrap()
            .unwrap()["scene"],
        edited
    );
    assert_eq!(
        a.read(|conn| crate::image_canvas::render_snapshot(conn, &render))
            .unwrap()
            .unwrap()["scene"],
        frozen
    );
    assert_ne!(second_output["outputAssetId"], output["outputAssetId"]);
    assert!(a.read(conflicts).unwrap().is_empty());
    assert!(b.read(conflicts).unwrap().is_empty());
    b.write(|tx| {
        tx.execute(
            "UPDATE sync_binding SET paused=1,pause_reason='backup_restored'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    stage_recovery(&b, &sync).await.unwrap();
    std::fs::remove_file(b_folder.join("assets").join(&original_path)).unwrap();
    assert_eq!(
        b_assets
            .read_canvas_original(&b, &format!("asset://{source}"))
            .await
            .unwrap_err()
            .code(),
        "SYNC_PAUSED"
    );
    let recovery = recovery_remote(&b, &sync).await.unwrap();
    prepare_rebuild_image_projects(&b, &b_assets, &recovery)
        .await
        .unwrap();
    assert!(Binding::read(&b).unwrap().unwrap().paused);
    assert_eq!(
        std::fs::read(b_folder.join("assets").join(&original_path)).unwrap(),
        bytes
    );
    replace_baseline(&b, &b_backups).unwrap();
    assert!(!Binding::read(&b).unwrap().unwrap().paused);
    b.write(|tx| {
        tx.execute(
            "UPDATE sync_binding SET paused=1,pause_reason='backup_restored'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    stage_recovery(&b, &sync).await.unwrap();
    let mut missing = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        8,
        6,
        image::Rgba([255, 0, 0, 255]),
    ))
    .write_to(&mut missing, image::ImageFormat::Png)
    .unwrap();
    let missing_id = b_assets
        .import_canvas(&b, "尚未上传的原图", &missing.into_inner())
        .unwrap();
    crate::image_canvas::open_project(
        &b,
        &b_assets,
        "offline-article",
        &format!("asset://{missing_id}"),
    )
    .await
    .unwrap();
    let missing_path = b
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [&missing_id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap();
    std::fs::remove_file(b_folder.join("assets").join(missing_path)).unwrap();
    let retained = |db: &Workspace| {
        db.read(|conn|Ok(conn.query_row("SELECT json_object('binding',(SELECT json_object('paused',paused,'reason',pause_reason,'epoch',epoch,'device',device_id) FROM sync_binding),'progress',(SELECT json_object('cursor',cursor,'bootstrap',bootstrap_cursor) FROM sync_progress),'bootstrap',(SELECT json_group_array(payload_json) FROM (SELECT payload_json FROM sync_bootstrap ORDER BY entity_type,entity_id)),'dirty',(SELECT json_group_array(json_array(entity_type,entity_id,generation,batch_id)) FROM (SELECT * FROM sync_dirty ORDER BY entity_type,entity_id)),'outbox',(SELECT operation_json FROM sync_outbox),'body',(SELECT content_md FROM entries WHERE id='article'),'projects',(SELECT json_group_array(json_array(id,scene_json,version,deleted_at)) FROM (SELECT * FROM image_projects ORDER BY id)))",[],|row|row.get::<_,String>(0))?)).unwrap()
    };
    let before = retained(&b);
    let recovery = recovery_remote(&b, &sync).await.unwrap();
    assert!(
        prepare_rebuild_image_projects(&b, &b_assets, &recovery)
            .await
            .is_err()
    );
    assert_eq!(retained(&b), before);
    first.key(&a).unwrap().delete_credential().unwrap();
    second.key(&b).unwrap().delete_credential().unwrap();
}

#[test]
fn full_reconciliation_accepts_new_render_with_an_existing_project_tombstone() {
    let (_dir, db, _assets, input, payload) = fixture();
    let asset_key = Key {
        entity_type: Kind::Asset,
        entity_id: input.clone(),
    };
    let project_key = Key {
        entity_type: Kind::ImageProject,
        entity_id: "project".into(),
    };
    db.write(|tx| {
        tx.execute("UPDATE sync_progress SET capture=0", [])?;
        tx.execute(
            "UPDATE image_projects SET deleted_at=2 WHERE id='project'",
            [],
        )?;
        tx.execute("DELETE FROM sync_dirty", [])?;
        remember(tx, &asset_key, 1, false)?;
        remember(tx, &project_key, 1, true)?;
        Ok(())
    })
    .unwrap();
    let input_meta = db
        .read(|conn| local_snapshot(conn, &asset_key))
        .unwrap()
        .unwrap();
    let mut output_meta = input_meta.clone();
    output_meta["sourceKey"] = json!("image-render:late-render");
    let hash = hex::encode(Sha256::digest(
        serde_json_canonicalizer::to_vec(&payload["scene"]).unwrap(),
    ));
    let render = json!({"projectId":"project","scene":payload["scene"],"sceneHash":hash,"outputAssetId":"late-output","assetIds":[input],"exportOptions":{"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"},"rendererVersion":"konva-1","createdAt":3});
    for entity in [
        Entity {
            key: asset_key,
            remote_revision: 1,
            deleted_at: None,
            payload: input_meta,
        },
        Entity {
            key: project_key,
            remote_revision: 1,
            deleted_at: Some(2),
            payload,
        },
        Entity {
            key: Key {
                entity_type: Kind::Asset,
                entity_id: "late-output".into(),
            },
            remote_revision: 1,
            deleted_at: None,
            payload: output_meta,
        },
        Entity {
            key: Key {
                entity_type: Kind::ImageRender,
                entity_id: "late-render".into(),
            },
            remote_revision: 1,
            deleted_at: None,
            payload: render.clone(),
        },
    ] {
        stage_bootstrap(&db, &entity).unwrap();
    }
    db.write(|tx| reconcile::baseline(tx)).unwrap();
    db.read(|conn| {
        assert!(conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM image_projects WHERE id='project'",
            [],
            |r| r.get::<_, bool>(0)
        )?);
        assert_eq!(
            crate::image_canvas::render_snapshot(conn, "late-render")?.unwrap(),
            render
        );
        assert!(conflicts(conn)?.is_empty());
        Ok(())
    })
    .unwrap();
}

#[test]
fn original_collision_cannot_retarget_project_during_first_merge_or_incremental_apply() {
    let root = tempfile::tempdir().unwrap();
    let (db, backups) = crate::backup::Backups::open(root.path()).unwrap();
    let assets = Assets::new(root.path().join("assets"), &db).unwrap();
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 6)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let input = assets
        .import_canvas(&db, "原图", &bytes.into_inner())
        .unwrap();
    let payload = json!({"originEntryId":"article","baseAssetId":input,"scene":scene(&input),"assetIds":[input],"createdAt":1,"updatedAt":1});
    db.write(|tx| crate::image_canvas::apply_project(tx, "project", &payload, None))
        .unwrap();
    let key = Key {
        entity_type: Kind::Asset,
        entity_id: input.clone(),
    };
    let original = db.read(|conn| local_snapshot(conn, &key)).unwrap().unwrap();
    let mut incoming = original.clone();
    incoming["sha256"] = json!("a".repeat(64));
    let remote = Entity {
        key: key.clone(),
        remote_revision: 2,
        deleted_at: None,
        payload: incoming,
    };
    stage_bootstrap(&db, &remote).unwrap();
    assert_eq!(
        db.write(|tx| merge::baseline(tx, &backups))
            .err()
            .unwrap()
            .code(),
        "IMAGE_ASSET_CONFLICT"
    );
    assert_eq!(
        db.write(|tx| apply_group(tx, vec![remote]))
            .err()
            .unwrap()
            .code(),
        "IMAGE_ASSET_CONFLICT"
    );
    db.read(|conn|{assert_eq!(local_snapshot(conn,&key)?.unwrap(),original);assert_eq!(crate::image_canvas::project_snapshot(conn,"project")?.unwrap(),payload);assert_eq!(conn.query_row("SELECT count(*) FROM image_project_assets WHERE project_id='project' AND asset_id=?1",[&input],|r|r.get::<_,i64>(0))?,1);assert_eq!(conn.query_row("SELECT count(*) FROM assets",[],|r|r.get::<_,i64>(0))?,1);assert_eq!(conn.query_row("SELECT count(*) FROM sync_bootstrap",[],|r|r.get::<_,i64>(0))?,1);Ok(())}).unwrap();
}
