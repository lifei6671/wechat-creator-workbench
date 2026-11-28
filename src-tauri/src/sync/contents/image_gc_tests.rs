use super::*;
use crate::sync::{ConnectWith, connect, create_access_key};
use std::io::Cursor;

#[tokio::test]
#[ignore = "requires an isolated fresh sync service from native-client.mjs"]
async fn automatic_private_cleanup_between_devices_restores_an_offline_pending_reference() {
    let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
    let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
    let root = tempfile::tempdir().unwrap();
    let a = Workspace::open(&root.path().join("a.db")).unwrap();
    let b = Workspace::open(&root.path().join("b.db")).unwrap();
    let a_assets = Assets::new(root.path().join("assets-a"), &a).unwrap();
    let b_assets = Assets::new(root.path().join("assets-b"), &b).unwrap();
    let sync = super::super::SyncConnection::new().unwrap();
    let first = connect(&a, &sync, &url, "GC A", ConnectWith::Claim, &setup)
        .await
        .unwrap();
    let access = create_access_key(&a, &sync).await.unwrap();
    let second = connect(&b, &sync, &url, "GC B", ConnectWith::Join, &access)
        .await
        .unwrap();
    struct Credentials<'a>(&'a Workspace, super::super::super::Binding);
    impl Drop for Credentials<'_> {
        fn drop(&mut self) {
            let _ = self.1.key(self.0).unwrap().delete_credential();
        }
    }
    let _first = Credentials(&a, first);
    let _second = Credentials(&b, second);
    let mut original = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 6)
        .write_to(&mut original, image::ImageFormat::Png)
        .unwrap();
    let source = a_assets
        .import_canvas(&a, "原图", original.get_ref())
        .unwrap();
    a.write(|conn|{conn.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('article','article','原图','draft',?1,0,0)",[format!("![原图](asset://{source})")])?;crate::assets::references::sync_entry(conn,"article",&format!("![原图](asset://{source})"))}).unwrap();
    let project =
        crate::image_canvas::open_project(&a, &a_assets, "article", &format!("asset://{source}"))
            .await
            .unwrap();
    let project_id = project["id"].as_str().unwrap();
    let mut expected = std::collections::BTreeMap::new();
    for index in 0..8 {
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            6,
            image::Rgba([index + 1, 40, 90, 255]),
        ))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
        let render = crate::db::id();
        let result = crate::image_canvas::prepare_render(
            &a,
            &a_assets,
            &render,
            project_id,
            1,
            &json!({"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"}),
            png.get_ref(),
        )
        .unwrap();
        crate::image_canvas::commit_render(&a, &render, None).unwrap();
        let output = result["outputAssetId"].as_str().unwrap().to_owned();
        a.write(|conn| {
            conn.execute(
                "UPDATE image_renders SET created_at=?2 WHERE id=?1",
                params![render, crate::db::now() - 40 * 86400000 + index as i64],
            )?;
            Ok(())
        })
        .unwrap();
        expected.insert(output, png.into_inner());
    }
    super::super::exchange(&a, &a_assets, &sync).await.unwrap();
    super::super::apply_received(&a).unwrap();
    super::super::exchange(&b, &b_assets, &sync).await.unwrap();
    super::super::apply_received(&b).unwrap();
    super::maintain(&a, &a_assets, &sync).await.unwrap();
    let remote = Remote::open(&a, &sync).await.unwrap();
    let feed: Feed =
        super::super::response(remote.request(Method::GET, "v1/sync/image-gc").unwrap())
            .await
            .unwrap();
    assert_eq!(feed.candidates.len(), 3);
    super::maintain(&b, &b_assets, &sync).await.unwrap();
    let target = feed.candidates[0]["sha256"].as_str().unwrap();
    let output = b
        .read(|conn| {
            Ok(
                conn.query_row("SELECT id FROM assets WHERE sha256=?1", [target], |row| {
                    row.get::<_, String>(0)
                })?,
            )
        })
        .unwrap();
    // B accepted the durable barrier, then edits locally without contacting the service.
    b.write(|conn|{conn.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('offline','article','离线草稿','draft',?1,0,0)",[format!("![旧版](asset://{output})")])?;crate::assets::references::sync_entry(conn,"offline",&format!("![旧版](asset://{output})"))}).unwrap();
    reqwest::Client::new()
        .post(format!("{}__test/gc-due", url))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    super::maintain(&a, &a_assets, &sync).await.unwrap();
    let retired: Feed =
        super::super::response(remote.request(Method::GET, "v1/sync/image-gc").unwrap())
            .await
            .unwrap();
    assert!(
        retired
            .copies
            .iter()
            .any(|copy| copy["sha256"] == target && copy["state"] == "retired")
    );
    assert_eq!(
        a.read(|conn| Ok(
            conn.query_row("SELECT count(*) FROM image_renders", [], |r| r
                .get::<_, i64>(0))?
        ))
        .unwrap(),
        8
    );
    super::super::exchange(&b, &b_assets, &sync).await.unwrap();
    super::super::apply_received(&b).unwrap();
    let bytes = b_assets
        .read_canvas_original(&b, &format!("asset://{output}"))
        .await
        .unwrap();
    assert_eq!(bytes, *expected.get(&output).unwrap());
    let restored: Feed =
        super::super::response(remote.request(Method::GET, "v1/sync/image-gc").unwrap())
            .await
            .unwrap();
    let new = restored
        .copies
        .iter()
        .find(|copy| copy["sha256"] == target && copy["current"] == true)
        .unwrap();
    assert_eq!(new["state"], "live");
    assert_ne!(new["id"], feed.candidates[0]["id"]);
    super::super::exchange(&a, &a_assets, &sync).await.unwrap();
    super::super::apply_received(&a).unwrap();
    assert!(
        a.read(|conn| Ok(conn.query_row(
            "SELECT content_md FROM entries WHERE id='offline'",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap()
        .contains(&output)
    );
}

#[tokio::test]
#[ignore = "requires the isolated sync service and S3 emulator"]
async fn managed_s3_remote_retirement_converges_before_another_device_exports() {
    let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
    let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
    let base = url.trim_end_matches('/');
    let root = tempfile::tempdir().unwrap();
    let a = Workspace::open(&root.path().join("a.db")).unwrap();
    let b = Workspace::open(&root.path().join("b.db")).unwrap();
    let a_assets = Assets::new(root.path().join("a-assets"), &a).unwrap();
    let b_assets = Assets::new(root.path().join("b-assets"), &b).unwrap();
    let sync = super::super::SyncConnection::new().unwrap();
    let first = connect(&a, &sync, &url, "Public A", ConnectWith::Claim, &setup)
        .await
        .unwrap();
    let access = create_access_key(&a, &sync).await.unwrap();
    let second = connect(&b, &sync, &url, "Public B", ConnectWith::Join, &access)
        .await
        .unwrap();
    struct Keys<'a>(&'a Workspace, super::super::super::Binding);
    impl Drop for Keys<'_> {
        fn drop(&mut self) {
            let _ = self.1.key(self.0).unwrap().delete_credential();
            if let Ok(ids) = self.0.read(|conn| {
                let mut q = conn.prepare("SELECT credential_ref FROM storage_profiles")?;
                Ok(q.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            }) {
                for id in ids {
                    let _ =
                        keyring::Entry::new("io.github.lifei6671.wechat-creator-workbench.s3", &id)
                            .unwrap()
                            .delete_credential();
                }
            }
        }
    }
    let _a = Keys(&a, first);
    let _b = Keys(&b, second);
    for (db, assets) in [(&a, &a_assets), (&b, &b_assets)] {
        assets
            .configure(
                db,
                Some(crate::assets::s3::Target {
                    endpoint: base.into(),
                    region: "auto".into(),
                    bucket: "gc-bucket".into(),
                    prefix: "integration".into(),
                    public_base: format!("{base}/gc-bucket"),
                }),
                Some(crate::assets::s3::Secret {
                    access_key: "test".into(),
                    secret_key: "test-secret".into(),
                }),
                Some(crate::assets::upload_format::UploadOptions {
                    quality: crate::assets::upload_format::Quality::Standard,
                    ..Default::default()
                }),
            )
            .unwrap();
    }
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 6)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let source = a_assets.import_canvas(&a, "原图", png.get_ref()).unwrap();
    a.write(|conn|{conn.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('article','article','原图','draft',?1,0,0)",[format!("![原图](asset://{source})")])?;crate::assets::references::sync_entry(conn,"article",&format!("![原图](asset://{source})"))}).unwrap();
    let project =
        crate::image_canvas::open_project(&a, &a_assets, "article", &format!("asset://{source}"))
            .await
            .unwrap();
    let mut output = String::new();
    for index in 0..8 {
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            6,
            image::Rgba([index + 1, 100, 20, 255]),
        ))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
        let render = crate::db::id();
        let result = crate::image_canvas::prepare_render(
            &a,
            &a_assets,
            &render,
            project["id"].as_str().unwrap(),
            1,
            &json!({"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"}),
            png.get_ref(),
        )
        .unwrap();
        crate::image_canvas::commit_render(&a, &render, None).unwrap();
        a.write(|conn| {
            conn.execute(
                "UPDATE image_renders SET created_at=?2 WHERE id=?1",
                params![render, crate::db::now() - 40 * 86400000 + index as i64],
            )?;
            Ok(())
        })
        .unwrap();
        if index == 0 {
            output = result["outputAssetId"].as_str().unwrap().to_owned();
        }
    }
    crate::assets::version_cleanup::s3::acceptance_upload(&a_assets, &a, &output)
        .await
        .unwrap();
    let (copy, old, hash, content) = a
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT id,public_url,sha256,content_sha256 FROM image_public_copies",
                [],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )?)
        })
        .unwrap();
    assert_ne!(hash, content);
    super::super::exchange(&a, &a_assets, &sync).await.unwrap();
    super::super::apply_received(&a).unwrap();
    super::super::exchange(&b, &b_assets, &sync).await.unwrap();
    super::super::apply_received(&b).unwrap();
    assert!(
        b.read(|conn| Ok(conn.query_row(
            "SELECT state IN ('live','waiting') FROM image_public_copies WHERE id=?1",
            [&copy],
            |r| r.get::<_, bool>(0)
        )?))
        .unwrap()
    );
    super::maintain(&a, &a_assets, &sync).await.unwrap();
    super::maintain(&b, &b_assets, &sync).await.unwrap();
    reqwest::Client::new()
        .post(format!("{base}/__test/gc-s3-due"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    super::maintain(&a, &a_assets, &sync).await.unwrap();
    a_assets.maintain_public_versions(&a).await.unwrap();
    super::refresh(&b, &b_assets, &sync).await.unwrap();
    assert_eq!(
        b.read(|conn| Ok(conn.query_row(
            "SELECT state FROM image_public_copies WHERE id=?1",
            [&copy],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "removed"
    );
    let delivered =
        crate::assets::version_cleanup::protect_external(&b, &b_assets, &format!("![旧版]({old})"))
            .await
            .unwrap();
    assert!(!delivered.contains(&old));
    let current = b
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT public_url FROM asset_locations WHERE sha256=?1 AND deleted_at IS NULL",
                [&hash],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert!(delivered.contains(&current));
    let bytes = reqwest::get(&current)
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(super::super::digest(&bytes), content);
    assert_eq!(
        reqwest::get(&old).await.unwrap().status(),
        reqwest::StatusCode::NOT_FOUND
    );
    super::refresh(&a, &a_assets, &sync).await.unwrap();
    assert_eq!(
        a.read(|conn| Ok(conn.query_row(
            "SELECT state FROM image_public_copies WHERE id=?1",
            [&copy],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "superseded"
    );
    assert!(
        a.read(|conn| Ok(conn.query_row(
            "SELECT deleted_at IS NULL FROM asset_locations WHERE sha256=?1",
            [&hash],
            |r| r.get::<_, bool>(0)
        )?))
        .unwrap()
    );
    for _ in 0..3 {
        super::maintain(&a, &a_assets, &sync).await.unwrap();
        super::maintain(&b, &b_assets, &sync).await.unwrap();
    }
    let jobs: Vec<String> = reqwest::Client::new()
        .post(format!("{base}/__test/gc-expiry-queue"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    super::maintain(&a, &a_assets, &sync).await.unwrap();
    let states: Vec<Value> = reqwest::get(format!("{base}/__test/gc-expiry-status"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        states.iter().find(|job| job["id"] == jobs[0]).unwrap()["state"],
        "retired"
    );
    assert_eq!(
        states.iter().find(|job| job["id"] == jobs[1]).unwrap()["state"],
        "expired"
    );
    let expired=a.read(|conn|Ok(conn.query_row("SELECT a.relative_path FROM assets a JOIN image_gc_remote g ON g.sha256=a.sha256 WHERE g.payload_json->>'$.job.id'=?1 AND g.payload_json->>'$.backend'='private'",[&jobs[1]],|r|r.get::<_,String>(0))?)).unwrap();
    std::fs::remove_file(root.path().join("a-assets").join(expired)).unwrap();
    a.maintenance(|conn| {
        conn.execute("DELETE FROM image_gc_remote", [])?;
        conn.execute(
            "UPDATE sync_binding SET paused=1,pause_reason='backup_restored'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    super::super::stage_recovery(&a, &sync).await.unwrap();
    let recovery = super::super::recovery_remote(&a, &sync).await.unwrap();
    super::super::prepare_rebuild_image_projects(&a, &a_assets, &recovery)
        .await
        .unwrap();
}
