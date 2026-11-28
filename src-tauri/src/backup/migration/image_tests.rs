use super::*;
use crate::{assets::Assets, backup::restore::Files, db::Workspace};
use serde_json::{Value, json};
use std::io::Cursor;

fn png(value: u8) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        8,
        6,
        image::Rgba([value, 0, 0, 255]),
    ))
    .write_to(&mut bytes, image::ImageFormat::Png)
    .unwrap();
    bytes.into_inner()
}

#[tokio::test]
async fn migration_preserves_recycled_bytes_and_accepts_expired_version_metadata() {
    let (root,files,db,media,project,_bytes)=workspace().await;
    let options=json!({"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"});
    let timestamp=crate::db::now();
    for index in 0..8 {
        let render=crate::db::id();
        crate::image_canvas::prepare_render(&db,&media,&render,project["id"].as_str().unwrap(),1,&options,&png(30+index)).unwrap();
        crate::image_canvas::commit_render(&db,&render,None).unwrap();
        db.write(|conn|{conn.execute("UPDATE image_renders SET created_at=?2 WHERE id=?1",rusqlite::params![render,timestamp-40*86400000+i64::from(index)])?;Ok(())}).unwrap();
    }
    media.maintain_image_versions(&db,timestamp).unwrap();
    media.maintain_image_versions(&db,timestamp+7*86400000).unwrap();
    media.prepare_synced_workspace_export(&db).await.unwrap();
    let recycled=assets(&files.database).unwrap().into_iter().find(|(path,_,_)|path.starts_with(".image-version-recycle/")).unwrap();
    let archive=root.path().join("recycled.zip");
    export(&files.database,&files.stage,&db.read(workspace_id).unwrap(),&archive,&BTreeMap::new()).unwrap();
    let target=tempfile::tempdir().unwrap();let target_files=Files::new(target.path()).unwrap();
    let pending=prepare(&archive,&target_files.stage,&target_files.incoming).unwrap();
    install_assets(&target_files.stage.join(pending.migration.unwrap()),&target.path().join("assets")).unwrap();
    assert!(target.path().join("assets").join(recycled.0).exists());
    media.maintain_image_versions(&db,timestamp+37*86400000).unwrap();
    db.set_setting("backup_target",&serde_json::json!({})).unwrap();
    media.prepare_synced_workspace_export(&db).await.unwrap();
    export(&files.database,&files.stage,&db.read(workspace_id).unwrap(),&root.path().join("expired.zip"),&BTreeMap::new()).unwrap();
}
async fn workspace() -> (tempfile::TempDir, Files, Workspace, Assets, Value, Vec<u8>) {
    let root = tempfile::tempdir().unwrap();
    let files = Files::new(root.path()).unwrap();
    let (db, _) = files.open().unwrap();
    let media = Assets::new(root.path().join("assets"), &db).unwrap();
    let bytes = png(10);
    let source = media.import_canvas(&db, "原图", &bytes).unwrap();
    let project =
        crate::image_canvas::open_project(&db, &media, "article", &format!("asset://{source}"))
            .await
            .unwrap();
    (root, files, db, media, project, bytes)
}
fn hosted(db: &Workspace, id: &str, url: &str, content_hash: Option<&str>) {
    let workspace = db.read(workspace_id).unwrap();
    db.write(|tx|{
        tx.execute("INSERT OR IGNORE INTO storage_profiles VALUES ('cdn','images','https://s3.example.test','auto','images','','https://cdn.example.test',?1)",[crate::db::id()])?;
        let hash=tx.query_row("SELECT sha256 FROM assets WHERE id=?1",[id],|r|r.get::<_,String>(0))?;
        tx.execute("INSERT OR REPLACE INTO asset_locations(sha256,storage_profile_id,object_key,public_url,uploaded_at,content_sha256) VALUES (?1,'cdn',?2,?3,1,?4)",rusqlite::params![hash,format!("{workspace}/2026-{hash}.png"),url,content_hash.unwrap_or(&hash)])?;Ok(())
    }).unwrap();
}
#[tokio::test]
async fn local_unsynced_project_cannot_export_a_compressed_hosted_copy_as_original() {
    let (root, files, db, media, project, _bytes) = workspace().await;
    let source = project["baseAssetId"].as_str().unwrap();
    let (path, hash, _) = assets(&files.database).unwrap().remove(0);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/original", listener.local_addr().unwrap());
    let compressed = png(80);
    let checksum = hex::encode(Sha256::digest(&compressed));
    hosted(&db, source, &url, Some(&checksum));
    fs::remove_file(root.path().join("assets").join(path)).unwrap();
    assert_eq!(
        db.read(|conn| Ok(
            conn.query_row("SELECT count(*) FROM sync_revisions", [], |r| r
                .get::<_, i64>(0))?
        ))
        .unwrap(),
        0
    );
    let served = compressed.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/original",
                axum::routing::get(move || async move { served }),
            ),
        )
        .await
        .unwrap();
    });
    assert_eq!(
        media
            .prepare_synced_workspace_export(&db)
            .await
            .unwrap_err()
            .code(),
        "ASSET_ORIGINAL_MISSING"
    );
    server.abort();
    let output = root.path().join("invalid.zip");
    assert_eq!(
        export(
            &files.database,
            &files.stage,
            &db.read(workspace_id).unwrap(),
            &output,
            &BTreeMap::new()
        )
        .unwrap_err()
        .code(),
        "MIGRATION_ASSET"
    );
    assert!(!output.exists());
    assert_ne!(hash, checksum);
}
#[tokio::test]
async fn exact_hosted_original_is_prefetched_for_local_unsynced_project() {
    let (root, files, db, media, project, bytes) = workspace().await;
    let source = project["baseAssetId"].as_str().unwrap();
    let (path, hash, _) = assets(&files.database).unwrap().remove(0);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/original", listener.local_addr().unwrap());
    hosted(&db, source, &url, None);
    fs::remove_file(root.path().join("assets").join(&path)).unwrap();
    db.write(|tx| {
        tx.execute("UPDATE assets SET relative_path=NULL WHERE id=?1", [source])?;
        Ok(())
    })
    .unwrap();
    let served = bytes.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/original",
                axum::routing::get(move || async move { served }),
            ),
        )
        .await
        .unwrap();
    });
    media.prepare_synced_workspace_export(&db).await.unwrap();
    db.write(|tx| {
        tx.execute(
            "INSERT INTO sync_revisions VALUES ('asset',?1,1,0)",
            [source],
        )?;
        Ok(())
    })
    .unwrap();
    fs::remove_file(root.path().join("assets").join(&path)).unwrap();
    media.prepare_synced_workspace_export(&db).await.unwrap();
    server.abort();
    assert_eq!(
        fs::read(root.path().join("assets").join(&path)).unwrap(),
        bytes
    );
    let output = root.path().join("complete.zip");
    export(
        &files.database,
        &files.stage,
        &db.read(workspace_id).unwrap(),
        &output,
        &BTreeMap::new(),
    )
    .unwrap();
    prepare(&output, &files.stage, &files.incoming).unwrap();
    assert!(
        assets(&files.incoming)
            .unwrap()
            .contains(&(path, hash, false))
    );
}
fn omit_entry(source: &Path, target: &Path, omit: &str) {
    let mut archive = ZipArchive::new(File::open(source).unwrap()).unwrap();
    let mut output = ZipWriter::new(File::create(target).unwrap());
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().unwrap().into_owned();
        if name == omit {
            continue;
        }
        output
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        io::copy(&mut entry, &mut output).unwrap();
    }
    output.finish().unwrap();
}
#[tokio::test]
async fn every_project_render_and_staging_dependency_is_mandatory_even_when_hosted() {
    let (root, files, db, media, project, _bytes) = workspace().await;
    let id = project["id"].as_str().unwrap();
    let background = media.import_canvas(&db, "背景", &png(20)).unwrap();
    let outside = media.import_canvas(&db, "画板外", &png(30)).unwrap();
    let staging_input = media.import_canvas(&db, "暂存输入", &png(40)).unwrap();
    let mut scene = project["scene"].clone();
    scene["artboard"]["background"] = json!({"type":"image","assetId":background,"fit":"cover"});
    let mut layer = scene["layers"][0].clone();
    layer["id"] = json!("outside");
    layer["assetId"] = json!(outside);
    layer["x"] = json!(1000);
    scene["layers"].as_array_mut().unwrap().push(layer);
    crate::image_canvas::save_project(&db, id, 1, &scene).unwrap();
    let options = json!({"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"});
    let render = crate::db::id();
    crate::image_canvas::prepare_render(&db, &media, &render, id, 2, &options, &png(50)).unwrap();
    crate::image_canvas::commit_render(&db, &render, None).unwrap();
    let mut staged = project["scene"].clone();
    staged["layers"][0]["assetId"] = json!(staging_input);
    crate::image_canvas::save_project(&db, id, 2, &staged).unwrap();
    let shared_output = png(60);
    let ordinary = media.import_canvas(&db, "普通图", &shared_output).unwrap();
    let stage = crate::db::id();
    crate::image_canvas::prepare_render(&db, &media, &stage, id, 3, &options, &shared_output)
        .unwrap();
    crate::image_canvas::save_project(&db, id, 3, &project["scene"]).unwrap();
    db.write(|tx| {
        tx.execute("UPDATE image_projects SET deleted_at=10 WHERE id=?1", [id])?;
        Ok(())
    })
    .unwrap();
    let ids = db
        .read(|conn| {
            let mut query = conn.prepare("SELECT id FROM assets")?;
            Ok(query
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    for asset in ids {
        hosted(&db, &asset, "https://cdn.example.test/image", None);
    }
    let required = assets(&files.database).unwrap();
    assert_eq!(required.len(), 6);
    assert!(required.iter().all(|(_, _, hosted)| !*hosted));
    assert!(
        db.read(crate::image_canvas::required_asset_ids)
            .unwrap()
            .iter()
            .all(|id| id != &ordinary)
    );
    let package = root.path().join("complete.zip");
    export(
        &files.database,
        &files.stage,
        &db.read(workspace_id).unwrap(),
        &package,
        &BTreeMap::new(),
    )
    .unwrap();
    prepare(&package, &files.stage, &files.incoming).unwrap();
    for (index, (path, _, _)) in required.iter().enumerate() {
        let broken = root.path().join(format!("missing-{index}.zip"));
        omit_entry(&package, &broken, &format!("assets/{path}"));
        assert!(
            prepare(&broken, &files.stage, &files.incoming).is_err(),
            "missing engineering file {path}"
        );
    }
    let base = project["baseAssetId"].as_str().unwrap();
    let base_path = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [base],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap();
    db.write(|tx| {
        tx.execute("UPDATE assets SET relative_path=NULL WHERE id=?1", [base])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        assets(&files.database).unwrap_err().code(),
        "MIGRATION_ASSET"
    );
    db.write(|tx| {
        tx.execute(
            "UPDATE assets SET relative_path=?2 WHERE id=?1",
            rusqlite::params![base, base_path],
        )?;
        Ok(())
    })
    .unwrap();
    db.write(|tx| {
        tx.execute(
            "UPDATE image_render_staging SET relative_path='../escape.png'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        export(
            &files.database,
            &files.stage,
            &db.read(workspace_id).unwrap(),
            &root.path().join("unsafe.zip"),
            &BTreeMap::new()
        )
        .unwrap_err()
        .code(),
        "BACKUP_ASSET_PATH"
    );
}

#[tokio::test]
async fn legacy_migration_package_without_image_canvas_tables_is_still_accepted() {
    let (root, files, db, _media, _project, _bytes) = workspace().await;
    let legacy = root.path().join("legacy.db");
    File::create(&legacy).unwrap();
    let identity = db.read(workspace_id).unwrap();
    make_snapshot(&files.database, &legacy, &identity).unwrap();
    let old = Connection::open(&legacy).unwrap();
    old.execute_batch("DROP TABLE image_project_assets;DROP TABLE image_render_receipts;DROP TABLE image_renders;DROP TABLE image_render_staging;DROP TABLE image_editor_state;DROP TABLE image_projects;").unwrap();
    old.execute_batch("DROP TRIGGER image_published_old;DROP TRIGGER image_published_deleted;DROP TRIGGER image_published_link;DROP TRIGGER image_published_cover;DROP TABLE image_version_cleanup;DROP TABLE image_version_protection;").unwrap();
    old.execute_batch("DROP TRIGGER protect_public_asset_insert;DROP TRIGGER protect_public_asset_update;DROP TABLE image_public_copies;DROP TABLE image_gc_remote;DROP TABLE image_gc_barriers;").unwrap();
    let lifecycle=include_str!("../../../migrations/0037_asset_lifecycle.sql");
    old.execute_batch(&lifecycle[lifecycle.find("CREATE TRIGGER protect_public_asset_insert").unwrap()..lifecycle.find("CREATE TABLE backup_asset_manifests").unwrap()]).unwrap();
    old.pragma_update(None, "user_version", 37)
        .unwrap();
    drop(old);
    assert_eq!(
        crate::db::validate_backup_schema(&Connection::open(&legacy).unwrap()).unwrap(),
        37
    );
    let package = root.path().join("legacy.zip");
    let mut output_file = File::create(&package).unwrap();
    let mut archive = ZipWriter::new(&mut output_file);
    write_entry(&mut archive, "content.db", &legacy).unwrap();
    for (path, _, _) in assets(&legacy).unwrap() {
        write_entry(
            &mut archive,
            &format!("assets/{path}"),
            &root.path().join("assets").join(path),
        )
        .unwrap();
    }
    archive.finish().unwrap();
    drop(output_file);
    prepare(&package, &files.stage, &files.incoming).unwrap();
    assert_eq!(
        crate::db::validate_backup_schema(&Connection::open(&files.incoming).unwrap()).unwrap(),
        crate::db::SCHEMA_VERSION
    );
}


#[tokio::test]
async fn migration_keeps_locally_referenced_raw_bytes_even_when_cloud_history_is_retired() {
    let (root,files,db,media,project,_)=workspace().await;
    let mut selected=String::new();
    for index in 0..8 {
        let render=crate::db::id();
        let prepared=crate::image_canvas::prepare_render(&db,&media,&render,project["id"].as_str().unwrap(),1,&json!({"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"}),&png(60+index)).unwrap();
        crate::image_canvas::commit_render(&db,&render,None).unwrap();
        db.write(|conn|{conn.execute("UPDATE image_renders SET created_at=?2 WHERE id=?1",rusqlite::params![render,crate::db::now()-40*86400000+index as i64])?;Ok(())}).unwrap();
        if index==0 {selected=prepared["outputAssetId"].as_str().unwrap().to_owned();}
    }
    let (hash,relative)=db.read(|conn|Ok(conn.query_row("SELECT sha256,relative_path FROM assets WHERE id=?1",[&selected],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?)).unwrap();
    db.write(|conn|{
        let payload=json!({"backend":"private","current":true,"state":"retired","sha256":hash});
        conn.execute("INSERT INTO image_gc_remote VALUES('retired-copy',?1,'retired','instance','epoch',?2)",rusqlite::params![hash,payload.to_string()])?;
        conn.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('offline','article','离线引用','draft',?1,0,0)",[format!("![旧图](asset://{selected})")])?;
        crate::assets::references::sync_entry(conn,"offline",&format!("![旧图](asset://{selected})"))
    }).unwrap();
    assert!(assets(&files.database).unwrap().iter().any(|(path,h,hosted)|path==&relative&&h==&hash&&!*hosted));
    let package=root.path().join("offline-reference.zip");export(&files.database,&files.stage,&db.read(workspace_id).unwrap(),&package,&BTreeMap::new()).unwrap();
    let target=tempfile::tempdir().unwrap();let dest=Files::new(target.path()).unwrap();
    let pending=prepare(&package,&dest.stage,&dest.incoming).unwrap();install_assets(&dest.stage.join(pending.migration.unwrap()),&target.path().join("assets")).unwrap();
    let imported=Workspace::open_existing(&dest.incoming).unwrap();
    assert_eq!(imported.read(|conn|Ok(conn.query_row("SELECT relative_path FROM assets WHERE id=?1",[&selected],|r|r.get::<_,Option<String>>(0))?)).unwrap(),Some(relative.clone()));
    assert_eq!(std::fs::read(target.path().join("assets").join(relative)).unwrap(),png(60));
}
