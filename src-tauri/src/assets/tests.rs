use super::*;
use std::io::Cursor;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn serve_image(listener: TcpListener, bytes: Vec<u8>) {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        request.push(stream.read_u8().await.unwrap());
    }
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    stream.write_all(headers.as_bytes()).await.unwrap();
    stream.write_all(&bytes).await.unwrap();
    stream.shutdown().await.unwrap();
}

#[tokio::test]
async fn public_image_previews_do_not_create_assets() {
    let (folder, db, mut assets) = setup();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    assets.external_http = reqwest::Client::builder()
        .no_proxy()
        .resolve("images.example.test", address)
        .build()
        .unwrap();
    let url = format!("http://images.example.test:{}/sample.png", address.port());
    let bytes = png();
    let server = tokio::spawn(serve_image(listener, bytes.clone()));
    assert_eq!(assets.read(&db, &url).await.unwrap(), bytes);
    server.await.unwrap();
    assert!(assets.library(&db).unwrap().items.is_empty());
    assert!(!folder.path().join("assets").exists());

    let missing = assets.read(&db, "asset://missing").await.unwrap_err();
    assert_eq!(missing.code(), "ASSET_MISSING");

    let id = assets.import(&db, "sample.png", &bytes).unwrap();
    assert_eq!(
        assets.read(&db, &format!("asset://{id}")).await.unwrap(),
        bytes
    );
}

#[tokio::test]
async fn hosted_webp_fallback_uses_its_own_digest_and_extension() {
    let (folder, db, media) = setup();
    let original = png();
    let mut encoded = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut encoded, ImageFormat::WebP)
        .unwrap();
    let hosted = encoded.into_inner();
    let checksum = format!("{:x}", Sha256::digest(&hosted));
    let id = media.import(&db, "原图.png", &original).unwrap();
    let file = db.read(|conn| by_id(conn, &id)).unwrap();
    let original_name = db.read(|conn| media.export_name(conn, &file)).unwrap();
    assert!(original_name.ends_with(".png"));
    std::fs::remove_file(media.root.join(file.path.as_deref().unwrap())).unwrap();
    db.write(|tx| {
        tx.execute("INSERT INTO storage_profiles VALUES ('fallback','images','http://127.0.0.1','auto','images','','http://127.0.0.1',?1)", [crate::db::id()])?;
        Ok(())
    }).unwrap();
    for (bytes, export) in [
        (hosted.clone(), false),
        (original, false),
        (hosted.clone(), true),
    ] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}/image.webp", listener.local_addr().unwrap());
        db.write(|tx| {
            tx.execute("INSERT OR REPLACE INTO asset_locations (sha256,storage_profile_id,object_key,public_url,uploaded_at,content_sha256) VALUES (?1,'fallback','image.webp',?2,1,?3)", params![file.hash,url,checksum])?;
            Ok(())
        }).unwrap();
        let matches = bytes == hosted;
        let server = tokio::spawn(serve_image(listener, bytes));
        if export {
            let path = folder.path().join("hosted.md");
            media
                .export_markdown_file(&db, &format!("![图片](asset://{id})"), &path)
                .await
                .unwrap();
            server.await.unwrap();
            let name = format!("assets/{}.webp", file.hash.as_deref().unwrap());
            assert_eq!(
                std::fs::read_to_string(path).unwrap(),
                format!("![图片]({name})")
            );
            assert_eq!(std::fs::read(folder.path().join(name)).unwrap(), hosted);
            continue;
        }
        let downloaded = media.read_file(&db, &file).await;
        server.await.unwrap();
        if matches {
            assert_eq!(downloaded.unwrap(), hosted);
        } else {
            assert_eq!(downloaded.unwrap_err().code(), "ASSET_CHANGED");
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}/image.webp", listener.local_addr().unwrap());
    db.write(|tx| {
        tx.execute(
            "UPDATE asset_locations SET public_url=?1 WHERE storage_profile_id='fallback'",
            [url],
        )?;
        Ok(())
    })
    .unwrap();
    let server = tokio::spawn(serve_image(listener, hosted));
    let stale_name = media
        .read_export_file(&db, &file, &original_name)
        .await
        .unwrap_err();
    server.await.unwrap();
    assert_eq!(stale_name.code(), "EXPORT_FAILED");
}

#[tokio::test]
async fn configured_public_images_keep_their_url_and_are_not_stored_locally() {
    let (folder, db, assets) = setup();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let base = format!("http://{}/public", listener.local_addr().unwrap());
    db.write(|tx| {
        tx.execute("INSERT INTO storage_profiles VALUES ('image-test','images',?1,'auto','images','media',?1,'unused')", [&base])?;
        tx.execute("INSERT INTO app_settings VALUES ('image_storage_profile','image-test')", [])?;
        Ok(())
    }).unwrap();
    let url = format!("{base}/media/sample.png");
    let wrong_prefix = format!("{base}/media-other/sample.png");
    assert_eq!(assets.localize(&db, &url).await.unwrap(), url);
    assert_eq!(
        assets
            .localize(&db, &wrong_prefix)
            .await
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
    assert_eq!(
        assets.read(&db, &wrong_prefix).await.unwrap_err().code(),
        "INVALID_INPUT"
    );
    let bytes = png();
    let server = tokio::spawn(serve_image(listener, bytes.clone()));
    assert_eq!(assets.read(&db, &url).await.unwrap(), bytes);
    server.await.unwrap();
    assert_eq!(assets.public_image(&db, &url).await.unwrap(), url);
    let markdown = format!("![图]({url} \"图床说明\")");
    let output = folder.path().join("article.md");
    assets
        .export_markdown_file(&db, &markdown, &output)
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(output).unwrap(), markdown);
    assert!(!folder.path().join("assets").exists());
    let pinned = db.read(s3::Profile::active).unwrap().unwrap().target;
    let changed = s3::Target {
        bucket: "different-bucket".into(),
        ..pinned.clone()
    };
    assert_eq!(
        assets
            .public_image_for(&db, &url, Some(&changed))
            .await
            .unwrap_err()
            .code(),
        "S3_CHANGED"
    );
    assert_eq!(
        assets
            .store_image(&db, "外链.png", &png(), ImageOrigin::Hosting(&changed))
            .unwrap_err()
            .code(),
        "S3_CHANGED"
    );
    assert!(!folder.path().join("assets").exists());
    assets.configure(&db, None, None, None).unwrap();
    assert_eq!(
        assets
            .public_image_for(&db, &url, Some(&pinned))
            .await
            .unwrap_err()
            .code(),
        "S3_CHANGED"
    );
    let (saved, enabled) = Assets::settings_profile(&db).unwrap();
    assert!(!enabled);
    assert_eq!(saved.unwrap().target.public_base, base);
    assert!(!public_ip("::ffff:127.0.0.1".parse().unwrap()));
    assert!(!public_ip("169.254.169.254".parse().unwrap()));
    assert!(!public_ip("198.18.0.1".parse().unwrap()));
    assert!(!public_ip("2001:2::1".parse().unwrap()));
    assert!(!public_ip("2001:db8::1".parse().unwrap()));
    assert!(!public_ip("3fff:abc::1".parse().unwrap()));
    assert!(public_ip("8.8.8.8".parse().unwrap()));
}

#[test]
fn same_formula_and_diagram_fixtures_protect_their_source_keys() {
    #[derive(serde::Deserialize)]
    struct Fragment {
        kind: String,
        source: String,
        line: usize,
    }
    #[derive(serde::Deserialize)]
    struct Fixture {
        markdown: String,
        fragments: Vec<Fragment>,
    }
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("../../../fixtures/wechat-format.json")).unwrap();
    for fixture in fixtures {
        let sources = references::derived_sources(&fixture.markdown);
        assert_eq!(
            sources.len(),
            fixture.fragments.len(),
            "{}",
            fixture.markdown
        );
        for (source, fragment) in sources.iter().zip(&fixture.fragments) {
            assert_eq!(source.kind, fragment.kind);
            assert_eq!(source.source, fragment.source);
            assert_eq!(source.line, fragment.line);
        }
        let expected = fixture
            .fragments
            .iter()
            .map(|f| references::source_key(&f.kind, &f.source))
            .collect();
        assert_eq!(references::derived_keys(&fixture.markdown), expected);
    }
}

#[test]
fn filling_a_placeholder_checks_live_references_and_leaves_the_body_intact() {
    let (_folder, db, assets) = setup();
    db.write(|tx| {
        tx.execute("INSERT INTO assets(id,kind,created_at,name) VALUES ('placeholder','original',0,'图片')",[])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        assets.fill(&db, "placeholder", &png()).unwrap_err().code(),
        "ASSET_UNUSED"
    );
    let edited = "后来补写的段落[^图]\n\n[^图]: ![图](asset://placeholder)";
    db.write(|tx| {
        tx.execute("INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at) VALUES ('other','article','',?1,'draft',0,0)",[edited])?;
        references::sync_entry(tx,"other",edited)
    }).unwrap();
    assert_eq!(
        assets.fill(&db, "placeholder", &png()).unwrap(),
        "placeholder"
    );
    assert_eq!(db.export_text("other").unwrap().1, edited);
    assert!(
        db.read(|conn| by_id(conn, "placeholder"))
            .unwrap()
            .path
            .is_some()
    );
}

pub(super) fn setup() -> (tempfile::TempDir, Workspace, Assets) {
    let dir = tempfile::tempdir().unwrap();
    let db = Workspace::open(&dir.path().join("content.db")).unwrap();
    let assets = Assets::new(dir.path().join("assets"), &db).unwrap();
    (dir, db, assets)
}

pub(super) fn png() -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 3)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[tokio::test]
async fn library_thumbnail_is_small_and_keeps_original_bytes() {
    let (_directory, db, assets) = setup();
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        400,
        200,
        image::Rgba([92, 18, 6, 128]),
    ))
    .write_to(&mut bytes, ImageFormat::Png)
    .unwrap();
    let original = bytes.into_inner();
    let id = assets
        .import_to_library(&db, "素材.png", &original)
        .unwrap();
    let preview = assets.thumbnail(&db, &id).await.unwrap();
    assert_eq!(image_header(&preview).unwrap(), (ImageFormat::Png, 160, 80));
    let decoded = image::load_from_memory(&preview).unwrap().to_rgba8();
    assert_eq!(decoded.get_pixel(20, 20).0, [92, 18, 6, 128]);
    assert_eq!(
        assets.read(&db, &format!("asset://{id}")).await.unwrap(),
        original
    );
}

#[tokio::test]
async fn library_thumbnail_keeps_exif_display_orientation() {
    use image::{ImageEncoder, codecs::jpeg::JpegEncoder};

    let (_directory, db, assets) = setup();
    let mut original = Vec::new();
    let mut encoder = JpegEncoder::new(&mut original);
    // Little-endian TIFF header and an Orientation=6 entry (90° clockwise).
    encoder
        .set_exif_metadata(vec![
            b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ])
        .unwrap();
    encoder
        .write_image(
            &vec![100; 400 * 200 * 3],
            400,
            200,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    let id = assets
        .import_to_library(&db, "拍摄照片.jpg", &original)
        .unwrap();
    let preview = assets.thumbnail(&db, &id).await.unwrap();
    assert_eq!(image_header(&preview).unwrap(), (ImageFormat::Png, 80, 160));
}

#[tokio::test]
async fn exit_keeps_library_imports_and_cleans_unreferenced_attachments() {
    let (directory, db, assets) = setup();
    let bytes = png();
    let retained = assets.import(&db, "原附件.png", &bytes).unwrap();

    let mut other = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(3, 3)
        .write_to(&mut other, ImageFormat::Png)
        .unwrap();
    let removable = assets
        .import(&db, "未引用的附件.png", &other.into_inner())
        .unwrap();
    let path = db
        .read(|conn| by_id(conn, &removable))
        .unwrap()
        .path
        .unwrap();
    assert!(directory.path().join("assets").join(&path).exists());
    let hash = db
        .read(|conn| by_id(conn, &retained))
        .unwrap()
        .hash
        .unwrap();
    db.write(|tx| {
        tx.execute("INSERT INTO storage_profiles VALUES ('s','images','https://s3.example.test','test','bucket','','https://images.example.test','s')", [])?;
        tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key,public_url,uploaded_at,deleted_at) VALUES (?1,'s','key','https://images.example.test/key',1,NULL)", [&hash])?;
        tx.execute("INSERT INTO jobs(id,kind,status,sha256,error,created_at,updated_at) VALUES ('cleanup','cleanup','failed',?1,'远程删除失败',1,1)", [&hash])?;
        Ok(())
    }).unwrap();
    assert!(
        assets
            .library(&db)
            .unwrap()
            .items
            .iter()
            .any(|item| item.cleanup_error.is_some())
    );
    assert_eq!(
        assets.import_to_library(&db, "素材.png", &bytes).unwrap(),
        retained
    );
    assert_eq!(
        assets.import(&db, "粘贴的复用.png", &bytes).unwrap(),
        retained
    );
    assert!(
        assets
            .library(&db)
            .unwrap()
            .items
            .iter()
            .all(|item| item.cleanup_error.is_none())
    );

    assets.cleanup(&db).await.unwrap();
    assert_eq!(
        assets
            .read(&db, &format!("asset://{retained}"))
            .await
            .unwrap(),
        bytes
    );
    assert!(!directory.path().join("assets").join(path).exists());
    let library = assets.library(&db).unwrap();
    assert_eq!(library.items.len(), 1);
    assert_eq!(library.items[0].id, retained);
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM asset_locations WHERE sha256=?1 AND deleted_at IS NULL",
                [&hash],
                |row| row.get::<_, i64>(0)
            )?,
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM jobs WHERE id='cleanup'", [], |row| {
                row.get::<_, i64>(0)
            })?,
            0
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn shared_markdown_samples_count_only_actual_images() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        markdown: String,
        images: std::collections::BTreeSet<String>,
    }
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("../../../fixtures/asset-references.json")).unwrap();
    for sample in fixtures {
        assert_eq!(
            references::urls(&sample.markdown).unwrap(),
            sample.images,
            "{}",
            sample.markdown
        );
    }
}

#[tokio::test]
async fn repeated_import_keeps_one_file_and_exports_one_copy() {
    let (dir, db, assets) = setup();
    let bytes = png();
    assert_eq!(
        assets
            .import(&db, "invalid.png", b"not PNG")
            .unwrap_err()
            .code(),
        "IMAGE_FORMAT"
    );
    let asset = assets.import(&db, "图片.png", &bytes).unwrap();
    assert_eq!(assets.import(&db, "同一张.png", &bytes).unwrap(), asset);
    assert_eq!(
        assets.read(&db, &format!("asset://{asset}")).await.unwrap(),
        bytes
    );
    let body = format!(
        "![一](asset://{asset})\n\n![二][image]\n\n[image]: asset://{asset}\n\n> <div>\n> <img\n> src=' asset://{asset} ' \n> srcset='ignored.png'>\n> </div>"
    );
    db.write(|tx| {
        tx.execute(
            "INSERT INTO entries (id,kind,title,content_md,status,created_at,updated_at)
             VALUES ('draft','article','测试',?1,'draft',0,0)",
            [&body],
        )?;
        references::sync_entry(tx, "draft", &body)?;
        assert_eq!(
            tx.query_row("SELECT COUNT(*) FROM entry_assets", [], |r| r
                .get::<_, u32>(0))?,
            1
        );
        Ok(())
    })
    .unwrap();
    let path = dir.path().join("导出.zip");
    assets.export(&db, "draft", &path).await.unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    assert_eq!(archive.len(), 3);
    use std::io::Read;
    let mut markdown = String::new();
    archive
        .by_name("article.md")
        .unwrap()
        .read_to_string(&mut markdown)
        .unwrap();
    assert_eq!(markdown.matches("assets/").count(), 5);
    assert!(!markdown.contains("asset://"));
    assert!(markdown.contains("![二](assets/"));
    assert!(markdown.contains("\n> <img\n> src='assets/"));
    assert!(!markdown.contains("src='asset://"));
}

#[test]
fn opening_a_v1_database_runs_the_assets_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("content.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO app_settings VALUES ('workspace_id','old-workspace')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
    }
    let db = Workspace::open(&path).unwrap();
    assert_eq!(db.read(workspace_id).unwrap(), "old-workspace");
    let assets = Assets::new(dir.path().join("assets"), &db).unwrap();
    assert!(assets.import(&db, "新图片.png", &png()).is_ok());
}
