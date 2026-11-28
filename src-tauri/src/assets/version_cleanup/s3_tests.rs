use super::*;
use crate::assets::s3::{Secret, Target};
use std::io::Cursor;

#[tokio::test]
#[ignore = "requires the isolated native-client S3 emulator"]
async fn managed_s3_cleanup_restores_an_inflight_generation_before_external_delivery() {
    let base = std::env::var("WCB_SYNC_TEST_URL")
        .unwrap()
        .trim_end_matches('/')
        .to_owned();
    let (root, db, assets) = crate::assets::tests::setup();
    let bytes = crate::assets::tests::png();
    let source = assets.import_canvas(&db, "原图", &bytes).unwrap();
    db.write(|conn|{
        conn.execute("UPDATE sync_progress SET capture=0",[])?;
        conn.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('article','article','测试','draft','',0,0)",[])?;
        conn.execute("INSERT INTO image_projects(id,origin_entry_id,base_asset_id,scene_json,created_at,updated_at) VALUES('project','article',?1,'{}',0,0)",[&source])?;
        conn.execute("INSERT INTO image_project_assets VALUES('project',?1)",[&source])?;Ok(())
    }).unwrap();
    let mut outputs = Vec::new();
    for index in 0..8 {
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            2,
            3,
            image::Rgba([index + 1, 20, 50, 255]),
        ))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
        let output = assets.import_canvas(&db, "成品", png.get_ref()).unwrap();
        outputs.push(output.clone());
        db.write(|conn| {
            conn.execute(
                "UPDATE assets SET source_key=?2,created_at=?3 WHERE id=?1",
                params![
                    output,
                    format!("image-render:render-{index}"),
                    now() - 40 * super::super::DAY_MS + index as i64
                ],
            )?;
            conn.execute(
                "INSERT INTO image_renders VALUES(?1,'project','{}','scene',?2,?3,'{}','konva',?4)",
                params![
                    format!("render-{index}"),
                    output,
                    json!([source]).to_string(),
                    now() - 40 * super::super::DAY_MS + index as i64
                ],
            )?;
            Ok(())
        })
        .unwrap();
    }
    assets
        .configure(
            &db,
            Some(Target {
                endpoint: base.clone(),
                region: "auto".into(),
                bucket: "gc-bucket".into(),
                prefix: "test".into(),
                public_base: format!("{base}/gc-bucket"),
            }),
            Some(Secret {
                access_key: "acceptance".into(),
                secret_key: "acceptance-secret".into(),
            }),
            None,
        )
        .unwrap();
    let profile = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT credential_ref FROM storage_profiles WHERE purpose='images'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap();
    struct Credential(String);
    impl Drop for Credential {
        fn drop(&mut self) {
            let _ = keyring::Entry::new("io.github.lifei6671.wechat-creator-workbench.s3", &self.0)
                .unwrap()
                .delete_credential();
        }
    }
    let _credential = Credential(profile);
    reqwest::Client::new()
        .post(format!("{base}/__test/gc-s3-fail-next-head"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assets.upload(&db, &outputs[0]).unwrap();
    let upload = crate::assets::claim(&db).unwrap().unwrap();
    let result = assets.perform_upload(&db, &upload).await;
    assert!(result.is_err());
    crate::assets::complete_upload(&db, &upload, result).unwrap();
    assets.upload(&db, &outputs[0]).unwrap();
    let retry = crate::assets::claim(&db).unwrap().unwrap();
    assert!(retry.registered);
    let result = assets.perform_upload(&db, &retry).await;
    result.as_ref().unwrap();
    crate::assets::complete_upload(&db, &retry, result).unwrap();
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT count(*) FROM image_public_copies",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        1
    );
    let (old, raw) = db
        .read(|conn| {
            Ok((
                conn.query_row("SELECT public_url FROM image_public_copies", [], |row| {
                    row.get::<_, String>(0)
                })?,
                conn.query_row(
                    "SELECT sha256 FROM assets WHERE id=?1",
                    [&outputs[0]],
                    |row| row.get::<_, String>(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT count(*) FROM asset_public_protection WHERE sha256=?1",
            [&raw],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        0
    );
    drop(assets);
    drop(db);
    let db = Workspace::open(&root.path().join("content.db")).unwrap();
    let assets = Assets::new(root.path().join("assets"), &db).unwrap();
    assets.maintain_public_versions(&db).await.unwrap();
    db.write(|conn| {
        conn.execute("UPDATE image_public_copies SET due_at=0", [])?;
        Ok(())
    })
    .unwrap();
    let http = reqwest::Client::new();
    http.post(format!("{base}/__test/gc-s3-pause"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let (deleted, delivered) = tokio::join!(assets.maintain_public_versions(&db), async {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let status: Value = http
                    .get(format!("{base}/__test/gc-s3-status"))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                if status["deleteWaiting"] == true {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let rewritten =
            super::super::protect_external(&db, &assets, &format!("![图片]({old})")).await;
        http.post(format!("{base}/__test/gc-s3-release"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        rewritten
    });
    deleted.unwrap();
    let delivered = delivered.unwrap();
    assert!(!delivered.contains(&old));
    assert_eq!(
        http.get(&old).send().await.unwrap().status(),
        reqwest::StatusCode::NOT_FOUND
    );
    let current = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT public_url FROM asset_locations WHERE sha256=?1 AND deleted_at IS NULL",
                [&raw],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert!(delivered.contains(&current));
    assert!(
        http.get(&current)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    db.write(|conn| {
        conn.execute(
            "UPDATE image_public_copies SET expires_at=0 WHERE state='superseded'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assets.maintain_public_versions(&db).await.unwrap();
    assert_eq!(db.read(|conn|Ok(conn.query_row("SELECT count(*) FROM image_public_copies WHERE state='superseded' AND backup_path IS NOT NULL",[],|r|r.get::<_,i64>(0))?)).unwrap(),0);
    // A legitimately retained backup must not starve the following unrelated expiry.
    for (index, asset) in [outputs[0].clone(), outputs[1].clone()].iter().enumerate() {
        let (hash, relative, profile) = db
            .read(|conn| {
                Ok((
                    conn.query_row("SELECT sha256 FROM assets WHERE id=?1", [asset], |r| {
                        r.get::<_, String>(0)
                    })?,
                    conn.query_row(
                        "SELECT relative_path FROM assets WHERE id=?1",
                        [asset],
                        |r| r.get::<_, String>(0),
                    )?,
                    conn.query_row("SELECT id FROM storage_profiles LIMIT 1", [], |r| {
                        r.get::<_, String>(0)
                    })?,
                ))
            })
            .unwrap();
        let data = std::fs::read(root.path().join("assets").join(relative)).unwrap();
        let content = hex::encode(Sha256::digest(&data));
        let id = format!("0{index}-expiry");
        let backup = format!(".image-version-recycle/public/{id}/{content}.bin");
        super::super::tasks::durable_write(&assets.root, &backup, &data).unwrap();
        db.write(|conn|{conn.execute("INSERT INTO image_public_copies(id,sha256,profile_id,scope,object_key,generation,content_sha256,bytes,public_url,state,remote,backup_path,expires_at) VALUES(?1,?2,?3,'test-scope',?1,?1,?4,?5,?1,'removed',0,?6,0)",params![id,hash,profile,content,data.len() as i64,backup])?;Ok(())}).unwrap();
    }
    assets.maintain_public_versions(&db).await.unwrap();
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT state FROM image_public_copies WHERE id='00-expiry'",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "removed"
    );
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT state FROM image_public_copies WHERE id='01-expiry'",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "expired"
    );
    // Expiry already claimed before an output attempt must finish despite its new retention pin.
    db.maintenance(|conn| {
        conn.execute(
            "UPDATE image_public_copies SET state='expiring' WHERE id='00-expiry'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        assets
            .restore_public_versions(&db, "00-expiry")
            .await
            .unwrap_err()
            .code(),
        "IMAGE_CLEANUP_BUSY"
    );
    assets.maintain_public_versions(&db).await.unwrap();
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT state FROM image_public_copies WHERE id='00-expiry'",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "expired"
    );
    // A retry with different encoded content allocates a new key and finishes the known old copy.
    http.post(format!("{base}/__test/gc-s3-fail-next-head"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assets.upload(&db, &outputs[2]).unwrap();
    let first = crate::assets::claim(&db).unwrap().unwrap();
    let result = assets.perform_upload(&db, &first).await;
    assert!(result.is_err());
    crate::assets::complete_upload(&db, &first, result).unwrap();
    let previous=db.read(|conn|Ok(conn.query_row("SELECT object_key FROM asset_locations WHERE sha256=(SELECT sha256 FROM assets WHERE id=?1)",[&outputs[2]],|r|r.get::<_,String>(0))?)).unwrap();
    let profile = db
        .read(|conn| Profile::read(conn, &first.profile.id))
        .unwrap();
    assets
        .configure(
            &db,
            Some(profile.target.clone()),
            None,
            Some(crate::assets::upload_format::UploadOptions {
                quality: crate::assets::upload_format::Quality::Standard,
                ..Default::default()
            }),
        )
        .unwrap();
    assets.upload(&db, &outputs[2]).unwrap();
    let retry = crate::assets::claim(&db).unwrap().unwrap();
    let result = assets.perform_upload(&db, &retry).await;
    result.as_ref().unwrap();
    crate::assets::complete_upload(&db, &retry, result).unwrap();
    let current=db.read(|conn|Ok(conn.query_row("SELECT object_key FROM asset_locations WHERE sha256=(SELECT sha256 FROM assets WHERE id=?1)",[&outputs[2]],|r|r.get::<_,String>(0))?)).unwrap();
    assert_ne!(current, previous);
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT count(*) FROM image_public_copies WHERE object_key IN (?1,?2) AND state='live'",
            params![current, previous],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        2
    );
    assert!(
        http.get(profile.target.public_url(&previous))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
}
