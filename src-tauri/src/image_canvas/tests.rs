use super::*;
use image::{ImageEncoder, codecs::jpeg::JpegEncoder, metadata::Orientation};
use std::io::Cursor;

fn fixture() -> (tempfile::TempDir, Workspace, Assets, Vec<u8>) {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
    db.write(|tx|{tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES ('article','article','标题','draft','原始正文',1,1)",[])?;Ok(())}).unwrap();
    let assets = Assets::new(root.path().join("assets"), &db).unwrap();
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 6)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    (root, db, assets, bytes.into_inner())
}
fn options() -> Value {
    json!({"format":"png","scale":1,"quality":0.9,"jpegBackground":"#ffffff"})
}
#[test]
fn artboard_radius_is_optional_validated_and_retained() {
    let original = initial_scene("asset", 8, 6, 1);
    let original_hash = scene_hash(&original).unwrap();
    assert!(scene_assets(&original).is_ok());
    assert!(original["artboard"].get("cornerRadius").is_none());
    let mut rounded = original.clone();
    rounded["artboard"]["cornerRadius"] = json!(32.5);
    assert_eq!(scene_assets(&rounded).unwrap(), scene_assets(&original).unwrap());
    assert_ne!(scene_hash(&rounded).unwrap(), original_hash);
    assert_eq!(scene_hash(&original).unwrap(), original_hash);
    for invalid in [json!(-1), json!(8001), json!(null), json!("20"), json!(true)] {
        rounded["artboard"]["cornerRadius"] = invalid;
        assert!(scene_assets(&rounded).is_err());
    }
}
#[test]
fn canonical_scene_numbers_match_ecmascript() {
    let value: Value = serde_json::from_str(r#"{"z":1.0,"a":[-0.0,1e-7,0.000001,1e21]}"#).unwrap();
    assert_eq!(
        String::from_utf8(serde_json_canonicalizer::to_vec(&value).unwrap()).unwrap(),
        r#"{"a":[0,1e-7,0.000001,1e+21],"z":1}"#
    );
    let value: Value = serde_json::from_str(
        r#"{"z":[1.0,-0,1e-7,0.000001,333333333.33333329,1e30,4.50,2e-3,1e-27],"a":"\u000f\n"}"#,
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(serde_json_canonicalizer::to_vec(&value).unwrap()).unwrap(),
        r#"{"a":"\u000f\n","z":[1,0,1e-7,0.000001,333333333.3333333,1e+30,4.5,0.002,1e-27]}"#
    );
}

#[test]
fn all_exif_scene_transforms_preserve_display_pixels_in_raw_crop_coordinates() {
    let mut raw = image::RgbaImage::new(3, 2);
    for (x, y, pixel) in raw.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x + y * 3) as u8, 0, 0, 255]);
    }
    for orientation in 1..=8 {
        let scene = initial_scene("asset", 3, 2, orientation);
        let layer = &scene["layers"][0];
        let mut expected = image::DynamicImage::ImageRgba8(raw.clone());
        expected.apply_orientation(Orientation::from_exif(orientation).unwrap());
        assert_eq!(scene["artboard"]["width"], expected.width());
        assert_eq!(scene["artboard"]["height"], expected.height());
        assert_eq!(layer["crop"], json!({"x":0,"y":0,"width":3,"height":2}));
        for (x, y, pixel) in raw.enumerate_pixels() {
            let mut px = f64::from(x) + 0.5;
            let mut py = f64::from(y) + 0.5;
            if layer["flipX"] == true {
                px = 3. - px;
            }
            if layer["flipY"] == true {
                py = 2. - py;
            }
            let (rx, ry) = match layer["rotation"].as_i64().unwrap() {
                90 => (-py, px),
                180 => (-px, -py),
                270 => (py, -px),
                _ => (px, py),
            };
            let dx = (rx + layer["x"].as_f64().unwrap()).floor() as u32;
            let dy = (ry + layer["y"].as_f64().unwrap()).floor() as u32;
            assert_eq!(
                expected.to_rgba8().get_pixel(dx, dy),
                pixel,
                "orientation={orientation},pixel={x},{y}"
            );
        }
    }
}
fn exif_jpeg(width: u32, height: u32, orientation: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = JpegEncoder::new(&mut bytes);
    encoder
        .set_exif_metadata(vec![
            b'I',
            b'I',
            42,
            0,
            8,
            0,
            0,
            0,
            1,
            0,
            0x12,
            1,
            3,
            0,
            1,
            0,
            0,
            0,
            orientation,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ])
        .unwrap();
    encoder
        .write_image(
            &vec![100; width as usize * height as usize * 3],
            width,
            height,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    bytes
}
#[tokio::test]
async fn exif_input_uses_raw_decode_representation_without_changing_original_file() {
    let (_root, db, assets, _bytes) = fixture();
    let original = exif_jpeg(8, 6, 6);
    let input = assets
        .import_canvas(&db, "拍摄照片.jpg", &original)
        .unwrap();
    let src = format!("asset://{input}");
    let decoded = assets.read_canvas(&db, &src).await.unwrap();
    assert_eq!(decoded.len(), original.len());
    assert_eq!(assets::canvas_orientation(&decoded).unwrap(), 1);
    assert_eq!(assets::image_header(&decoded).unwrap().1, 8);
    assert_eq!(
        assets.read_canvas_original(&db, &src).await.unwrap(),
        original
    );
    let project = open_project(&db, &assets, "article", &src).await.unwrap();
    assert_eq!(project["scene"]["artboard"]["width"], 6);
    assert_eq!(project["scene"]["artboard"]["height"], 8);
    assert_eq!(project["scene"]["layers"][0]["crop"]["width"], 8);
    assert_eq!(project["scene"]["layers"][0]["rotation"], 90);
}
#[tokio::test]
#[ignore = "manual 40 megapixel image capacity check"]
async fn large_exif_jpeg_keeps_encoded_size_for_canvas_decode() {
    let (_root, db, assets, _bytes) = fixture();
    let original = exif_jpeg(8000, 5000, 6);
    let input = assets.import_canvas(&db, "大图.jpg", &original).unwrap();
    let start = std::time::Instant::now();
    let decoded = assets
        .read_canvas(&db, &format!("asset://{input}"))
        .await
        .unwrap();
    assert_eq!(decoded.len(), original.len());
    assert_eq!(assets::canvas_orientation(&decoded).unwrap(), 1);
    println!(
        "40MP JPEG encoded bytes={}, canvas decode preparation={:?}",
        decoded.len(),
        start.elapsed()
    );
}
fn entry(version: i64, src: &str) -> Value {
    json!({"id":"article","expectedVersion":version,"fields":{
        "title":"标题","status":"draft","categoryId":null,"contentMd":format!("![图片]({src})"),"coverAssetId":null,"themeId":null,
        "tags":[],"summary":"","source":null,"publishedAt":null,"publishedUrl":"","customProperties":[],"publicationPlatforms":[],"wechatPublication":null
    }})
}
#[tokio::test]
async fn automatic_hosting_queues_output_and_hosted_links_restore_exact_snapshots() {
    let (_root, db, assets, bytes) = fixture();
    db.write(|tx| {
        tx.execute_batch("INSERT INTO storage_profiles VALUES ('test-images','images','https://s3.example.test','auto','images','','https://cdn.example.test','test-images');
          INSERT INTO app_settings VALUES ('image_storage_profile','test-images');
          INSERT INTO app_settings VALUES ('image_upload:test-images','{\"autoUpload\":true}');")?;
        Ok(())
    }).unwrap();
    let input = assets.import_canvas(&db, "原图", &bytes).unwrap();
    let p = open_project(&db, &assets, "article", &format!("asset://{input}"))
        .await
        .unwrap();
    let first_id = crate::db::id();
    let first = prepare_render(
        &db,
        &assets,
        &first_id,
        p["id"].as_str().unwrap(),
        1,
        &options(),
        &bytes,
    )
    .unwrap();
    let request = entry(1, first["src"].as_str().unwrap());
    commit_render(&db, &first_id, Some(request.clone())).unwrap();
    commit_render(&db, &first_id, Some(request)).unwrap();
    let mut next_scene = p["scene"].clone();
    next_scene["layers"][0]["opacity"] = json!(0.5);
    save_project(&db, p["id"].as_str().unwrap(), 1, &next_scene).unwrap();
    let next_id = crate::db::id();
    let next = prepare_render(
        &db,
        &assets,
        &next_id,
        p["id"].as_str().unwrap(),
        2,
        &options(),
        &bytes,
    )
    .unwrap();
    commit_render(&db, &next_id, None).unwrap();
    let public = "https://cdn.example.test/output.png";
    db.write(|tx| {
        assert_eq!(tx.query_row("SELECT count(*) FROM jobs WHERE kind='upload' AND status='queued'", [], |row| row.get::<_, i64>(0))?, 1);
        tx.execute("INSERT INTO asset_locations(sha256,storage_profile_id,object_key,public_url,uploaded_at) SELECT sha256,'test-images','output.png',?1,1 FROM assets WHERE id=?2",
            params![public, first["outputAssetId"].as_str()])?;
        tx.execute("INSERT INTO asset_urls(url,sha256,storage_profile_id) SELECT ?1,sha256,'test-images' FROM assets WHERE id=?2",
            params![public, first["outputAssetId"].as_str()])?;
        Ok(())
    }).unwrap();
    // Hosting locations are device-local; recovering a synced render cannot rely on them.
    db.write(|tx| {
        tx.execute("DELETE FROM asset_urls", [])?;
        Ok(())
    })
    .unwrap();
    for (output, expected, article) in [
        (&first, &p["scene"], "first-copy"),
        (&next, &next_scene, "second-copy"),
    ] {
        let hosted = format!(
            "{public}#wcb-image={}",
            output["outputAssetId"].as_str().unwrap()
        );
        assert_eq!(assets.read(&db, &hosted).await.unwrap(), bytes);
        let reopened = open_project(&db, &assets, article, &hosted).await.unwrap();
        assert_eq!(reopened["baseAssetId"], output["outputAssetId"]);
        assert_eq!(reopened["scene"], *expected);
        for markdown in [
            format!("![成品]({hosted})"),
            format!("<img src=\"{hosted}\" alt=\"成品\">"),
        ] {
            db.write(|tx| {
                assets::references::sync_entry(tx, "article", &markdown)?;
                let referenced = tx.query_row(
                    "SELECT asset_id FROM entry_assets WHERE entry_id='article'",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(referenced, output["outputAssetId"].as_str().unwrap());
                assert_eq!(
                    tx.query_row(
                        "SELECT count(*) FROM entry_assets WHERE entry_id='article'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )?,
                    1
                );
                Ok(())
            })
            .unwrap();
        }
    }
    for bad in [
        format!("{public}#wcb-image=missing"),
        format!("{public}#wcb-image=../outside"),
        format!("{public}#wcb-image={input}"),
    ] {
        assert!(open_project(&db, &assets, "article", &bad).await.is_err());
    }
    assert_eq!(
        db.read(|conn| assets::canvas_output_id(conn, public))
            .unwrap(),
        None
    );
    assert!(
        assets::references::urls(&format!("`![代码]({public}#wcb-image=code-only)`"))
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn input_drafts_are_stable_private_and_versioned() {
    let (_root, db, assets, bytes) = fixture();
    db.write(|tx|{tx.execute_batch("INSERT INTO storage_profiles VALUES ('test-images','images','https://s3.example.test','auto','images','','https://cdn.example.test','test-images');INSERT INTO app_settings VALUES ('image_storage_profile','test-images');INSERT INTO app_settings VALUES ('image_upload:test-images','{\"autoUpload\":true}');")?;Ok(())}).unwrap();
    let asset = assets.import_canvas(&db, "原图", &bytes).unwrap();
    let p = open_project(&db, &assets, "article", &format!("asset://{asset}"))
        .await
        .unwrap();
    let again = open_project(&db, &assets, "article", &format!("asset://{asset}"))
        .await
        .unwrap();
    assert_eq!(p["id"], again["id"]);
    let mut scene = p["scene"].clone();
    scene["layers"][0]["x"] = json!(12);
    let saved = save_project(&db, p["id"].as_str().unwrap(), 1, &scene).unwrap();
    assert_eq!(saved["version"], 2);
    assert_eq!(
        save_project(&db, p["id"].as_str().unwrap(), 1, &p["scene"])
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT count(*) FROM jobs WHERE kind='upload'",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        0
    );
    assert!(assets.is_referenced(&db, &asset).unwrap());
    let mut bad = scene.clone();
    bad["layers"][0]["crop"]["width"] = json!(9);
    assert!(save_project(&db, p["id"].as_str().unwrap(), 2, &bad).is_err());
    assert_eq!(
        db.read(|conn| project(conn, p["id"].as_str().unwrap()))
            .unwrap()["version"],
        2
    );
}
#[tokio::test]
async fn apply_is_atomic_idempotent_and_each_output_keeps_its_identity() {
    let (_root, db, assets, bytes) = fixture();
    let input = assets.import_canvas(&db, "原图", &bytes).unwrap();
    let p = open_project(&db, &assets, "article", &format!("asset://{input}"))
        .await
        .unwrap();
    let pid = p["id"].as_str().unwrap();
    let render = crate::db::id();
    let prepared = prepare_render(&db, &assets, &render, pid, 1, &options(), &bytes).unwrap();
    let src = prepared["src"].as_str().unwrap();
    assert_eq!(assets.read(&db, src).await.unwrap(), bytes);
    assert_eq!(
        db.read(|conn| Ok(
            conn.query_row("SELECT count(*) FROM image_renders", [], |r| r
                .get::<_, i64>(0))?
        ))
        .unwrap(),
        0
    );
    let stale = entry(99, src);
    assert_eq!(
        commit_render(&db, &render, Some(stale)).unwrap_err().code(),
        "VERSION_CONFLICT"
    );
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT content_md FROM entries WHERE id='article'",
                [],
                |r| r.get::<_, String>(0)
            )?,
            "原始正文"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM image_renders", [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        Ok(())
    })
    .unwrap();
    let request = entry(1, src);
    let result = commit_render(&db, &render, Some(request.clone())).unwrap();
    assert_eq!(result["entryVersion"], 2);
    assert_eq!(commit_render(&db, &render, Some(request)).unwrap(), result);
    assert!(commit_render(&db, &render, None).is_err());
    let second = crate::db::id();
    let next = prepare_render(&db, &assets, &second, pid, 1, &options(), &bytes).unwrap();
    commit_render(&db, &second, None).unwrap();
    assert_ne!(prepared["outputAssetId"], next["outputAssetId"]);
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT count(DISTINCT output_asset_id) FROM image_renders",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(DISTINCT relative_path) FROM assets",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        Ok(())
    })
    .unwrap();
}
#[tokio::test]
async fn reopening_old_output_uses_immutable_snapshot_and_survives_origin_deletion() {
    let (_root, db, assets, bytes) = fixture();
    let input = assets.import_canvas(&db, "原图", &bytes).unwrap();
    let p = open_project(&db, &assets, "article", &format!("asset://{input}"))
        .await
        .unwrap();
    let pid = p["id"].as_str().unwrap();
    let render = crate::db::id();
    let old = prepare_render(&db, &assets, &render, pid, 1, &options(), &bytes).unwrap();
    commit_render(&db, &render, None).unwrap();
    let mut modified = p["scene"].clone();
    modified["layers"][0]["rotation"] = json!(90);
    save_project(&db, pid, 1, &modified).unwrap();
    db.write(|tx| {
        tx.execute("UPDATE entries SET deleted_at=9 WHERE id='article'", [])?;
        tx.execute("UPDATE image_projects SET deleted_at=9 WHERE id=?1", [pid])?;
        Ok(())
    })
    .unwrap();
    let restored = open_project(&db, &assets, "other-article", old["src"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(restored["scene"], p["scene"]);
    assert_ne!(restored["id"], p["id"]);
    let mut altered = db
        .read(|conn| render_snapshot(conn, &render))
        .unwrap()
        .unwrap();
    altered["scene"]["layers"][0]["x"] = json!(1);
    assert!(
        db.write(|tx| apply_render(tx, &render, &altered, None))
            .is_err()
    );
    assert!(assets.is_referenced(&db, &input).unwrap());
}
#[tokio::test]
async fn staged_output_rejects_wrong_dimensions_and_reused_render_parameters() {
    let (_root, db, assets, bytes) = fixture();
    let input = assets.import_canvas(&db, "原图", &bytes).unwrap();
    let p = open_project(&db, &assets, "article", &format!("asset://{input}"))
        .await
        .unwrap();
    let pid = p["id"].as_str().unwrap();
    let render = crate::db::id();
    let mut two = options();
    two["scale"] = json!(2);
    assert!(prepare_render(&db, &assets, &render, pid, 1, &two, &bytes).is_err());
    prepare_render(&db, &assets, &render, pid, 1, &options(), &bytes).unwrap();
    let mut changed = options();
    changed["quality"] = json!(0.5);
    assert!(prepare_render(&db, &assets, &render, pid, 1, &changed, &bytes).is_err());
    assert_eq!(
        prepare_render(&db, &assets, &render, pid, 9, &options(), &bytes)
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
}

#[tokio::test]
async fn abandoned_prepared_files_expire_after_grace_without_touching_originals() {
    let (root, db, assets, bytes) = fixture();
    let input = assets.import_canvas(&db, "原图", &bytes).unwrap();
    let project = open_project(&db, &assets, "article", &format!("asset://{input}"))
        .await
        .unwrap();
    let mut image = image::RgbaImage::new(8, 6);
    image.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    let render = crate::db::id();
    prepare_render(
        &db,
        &assets,
        &render,
        project["id"].as_str().unwrap(),
        1,
        &options(),
        &output.into_inner(),
    )
    .unwrap();
    let path = db
        .write(|tx| {
            tx.execute(
                "UPDATE image_render_staging SET created_at=?1",
                [now() - 8 * 24 * 60 * 60 * 1000],
            )?;
            Ok(tx.query_row(
                "SELECT relative_path FROM image_render_staging WHERE id=?1",
                [&render],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert!(root.path().join("assets").join(&path).exists());
    db.begin_exit();
    db.start_cleaning();
    assets.cleanup_for_update(&db).await.unwrap();
    assert!(!root.path().join("assets").join(path).exists());
    assert_eq!(
        assets.read(&db, &format!("asset://{input}")).await.unwrap(),
        bytes
    );
    assert_eq!(
        db.read(|conn| Ok(conn.query_row(
            "SELECT count(*) FROM image_render_staging",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        0
    );
}
