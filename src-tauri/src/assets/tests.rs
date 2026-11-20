use super::*;
use crate::content::collections::{NodeContent, Position};
use std::io::Cursor;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn topic_screenshots_are_hidden_and_retained_until_the_last_reference_is_removed() {
    let (folder, db, assets) = setup();
    let collection =
        serde_json::to_value(db.save_collection(None, "研究图片", "").unwrap()).unwrap();
    let collection_id = collection["id"].as_str().unwrap();
    let bytes = png();
    let asset = assets.import(&db, "screenshot.png", &bytes).unwrap();
    db.create_collection_node(
        collection_id,
        NodeContent::Image {
            asset_id: asset.clone(),
        },
        serde_json::from_value::<Position>(serde_json::json!({ "x": 0, "y": 0 })).unwrap(),
    )
    .unwrap();
    assert!(assets.library(&db, 50).unwrap().items.is_empty());
    assets.cleanup(&db).await.unwrap();
    let url = format!("asset://{asset}");
    assert_eq!(assets.read(&db, &url).await.unwrap(), bytes);

    let assets = Assets::new(folder.path().join("assets"), &db).unwrap();
    let entry = db
        .create_external(
            crate::content::Kind::Article,
            crate::content::EntryPatch {
                content_md: Some(format!("![图]({url})")),
                ..Default::default()
            },
        )
        .unwrap();
    let library = assets.library(&db, 50).unwrap();
    assert_eq!(library.page, 0);
    assert_eq!(library.items[0].id, asset);
    db.delete_collection(collection_id).unwrap();
    assets.cleanup(&db).await.unwrap();
    assert_eq!(assets.read(&db, &url).await.unwrap(), bytes);

    let assets = Assets::new(folder.path().join("assets"), &db).unwrap();
    let entry_id = serde_json::to_value(entry).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    db.update_external(
        &entry_id,
        1,
        crate::content::EntryPatch {
            content_md: Some(String::new()),
            ..Default::default()
        },
    )
    .unwrap();
    assets.cleanup(&db).await.unwrap();
    assert_eq!(
        assets.read(&db, &url).await.unwrap_err().code(),
        "ASSET_MISSING"
    );
}

async fn serve_image(listener: TcpListener, bytes: Vec<u8>) {
    serve_image_response(&listener, "200 OK", "", &bytes).await;
}

async fn serve_image_response(
    listener: &TcpListener,
    status: &str,
    extra_headers: &str,
    bytes: &[u8],
) -> String {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        request.push(stream.read_u8().await.unwrap());
    }
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: image/png\r\nContent-Length: {}\r\n{extra_headers}Connection: close\r\n\r\n",
        bytes.len()
    );
    stream.write_all(headers.as_bytes()).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    stream.shutdown().await.unwrap();
    String::from_utf8(request).unwrap()
}

async fn image_origin(assets: &mut Assets) -> (TcpListener, String) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    assets.external_http = reqwest::Client::builder()
        .no_proxy()
        .resolve("images.example.test", address)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let url = format!("http://images.example.test:{}/sample.png", address.port());
    (listener, url)
}

#[tokio::test]
async fn public_image_previews_cache_on_disk_without_creating_assets() {
    let (folder, db, mut assets) = setup();
    let cache = folder.path().join("image-cache");
    assets = assets.with_image_cache(&cache);
    let (listener, url) = image_origin(&mut assets).await;
    let bytes = png();
    let request = serve_image_response(
        &listener,
        "200 OK",
        "Cache-Control: max-age=3600\r\n",
        &bytes,
    );
    let (loaded, repeated, _) =
        tokio::join!(assets.read(&db, &url), assets.read(&db, &url), request);
    assert_eq!(loaded.unwrap(), bytes);
    assert_eq!(repeated.unwrap(), bytes);
    drop(listener);
    drop(assets);
    let assets = Assets::new(folder.path().join("assets"), &db)
        .unwrap()
        .with_image_cache(&cache);
    assert_eq!(assets.read(&db, &url).await.unwrap(), bytes);
    assert!(assets.library(&db, 0).unwrap().items.is_empty());
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
async fn external_svg_badges_are_cached_and_imported_as_png() {
    let (folder, db, assets) = setup();
    let mut assets = assets.with_image_cache(&folder.path().join("image-cache"));
    let (listener, url) = image_origin(&mut assets).await;
    let url = url.strip_suffix(".png").unwrap();
    let local_image = folder.path().join("never-read.png");
    std::fs::write(&local_image, png()).unwrap();
    let data_image = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png());
    let badge = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="4" onload="alert(1)">
            <rect width="2" height="4" fill="#0f0"/>
            <script>alert(1)</script>
            <image href="{}" x="3" width="2" height="4"/>
            <image href="data:image/png;base64,{data_image}" x="6" width="2" height="4"/>
        </svg>"##,
        url::Url::from_file_path(&local_image).unwrap(),
    );
    let (preview, _) = tokio::join!(
        assets.read(&db, url),
        serve_image_response(
            &listener,
            "200 OK",
            "Cache-Control: max-age=3600\r\n",
            badge.as_bytes()
        )
    );
    let preview = preview.unwrap();
    assert_eq!(image_header(&preview).unwrap(), (ImageFormat::Png, 10, 4));
    let image = image::load_from_memory(&preview).unwrap().to_rgba8();
    assert_eq!(image.get_pixel(0, 0).0, [0, 255, 0, 255]);
    assert_eq!(image.get_pixel(3, 2).0[3], 0);
    assert_eq!(image.get_pixel(6, 2).0[3], 0);

    drop(listener);
    let markdown =
        format!("[![徽标]({url})](https://github.com/example/repo)\n\n<img src=\"{url}\">");
    let (imported, unavailable) = assets
        .import_link_images(&db, markdown, true)
        .await
        .unwrap();
    assert_eq!(unavailable, 0);
    assert!(!imported.contains(url));
    let references = references::urls(&imported).unwrap();
    assert_eq!(references.len(), 1);
    let image = references.first().unwrap();
    assert!(image.starts_with("asset://"));
    assert_eq!(assets.read(&db, image).await.unwrap(), preview);
}

#[tokio::test]
async fn external_svg_limits_reject_dtd_and_oversized_images() {
    let dtd = br#"<!DOCTYPE svg [<!ENTITY external SYSTEM "file:///example.txt">]>
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="4"><text>&external;</text></svg>"#;
    let oversized = br#"<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="1"/>"#;
    assert_eq!(
        remote_image::normalize(dtd.to_vec())
            .await
            .unwrap_err()
            .code(),
        "IMAGE_FORMAT"
    );
    assert_eq!(
        remote_image::normalize(oversized.to_vec())
            .await
            .unwrap_err()
            .code(),
        "IMAGE_SIZE"
    );
}

#[tokio::test]
async fn public_image_cache_validates_stale_images_and_honors_no_store() {
    let (folder, db, assets) = setup();
    let mut assets = assets.with_image_cache(&folder.path().join("image-cache"));
    let (listener, url) = image_origin(&mut assets).await;
    let bytes = png();
    let (first, _) = tokio::join!(
        assets.read(&db, &url),
        serve_image_response(
            &listener,
            "200 OK",
            "Cache-Control: max-age=0\r\nETag: \"v1\"\r\n",
            &bytes
        ),
    );
    assert_eq!(first.unwrap(), bytes);
    let (revalidated, request) = tokio::join!(
        assets.read(&db, &url),
        serve_image_response(
            &listener,
            "304 Not Modified",
            "Cache-Control: max-age=3600\r\nETag: \"v1\"\r\n",
            &[]
        ),
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("if-none-match: \"v1\"")
    );
    assert_eq!(revalidated.unwrap(), bytes);
    assert_eq!(assets.read(&db, &url).await.unwrap(), bytes);

    let (refreshed, request) = tokio::join!(
        assets.read_image(&db, &url, true),
        serve_image_response(&listener, "200 OK", "Cache-Control: no-store\r\n", &bytes),
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("cache-control: no-cache")
    );
    assert!(!request.to_ascii_lowercase().contains("if-none-match:"));
    assert_eq!(refreshed.unwrap(), bytes);
    drop(listener);
    assert_eq!(
        assets.read(&db, &url).await.unwrap_err().code(),
        "IMAGE_NETWORK"
    );
}

#[tokio::test]
async fn public_image_cache_applies_new_directives_from_last_modified_validation() {
    let (folder, db, assets) = setup();
    let cache = folder.path().join("image-cache");
    let mut assets = assets.with_image_cache(&cache);
    let (listener, url) = image_origin(&mut assets).await;
    let bytes = png();
    let stamp = "Wed, 21 Oct 2015 07:28:00 GMT";
    let headers = format!("Date: {stamp}\r\nLast-Modified: {stamp}\r\n");
    let (loaded, _) = tokio::join!(
        assets.read(&db, &url),
        serve_image_response(&listener, "200 OK", &headers, &bytes),
    );
    assert_eq!(loaded.unwrap(), bytes);
    let (validated, request) = tokio::join!(
        assets.read(&db, &url),
        serve_image_response(
            &listener,
            "304 Not Modified",
            "Cache-Control: no-store\r\n",
            &[]
        ),
    );
    assert!(request.to_ascii_lowercase().contains(&format!(
        "if-modified-since: {}",
        stamp.to_ascii_lowercase()
    )));
    assert_eq!(validated.unwrap(), bytes);
    let count = || {
        Connection::open(cache.join("images.sqlite3"))
            .unwrap()
            .query_row("SELECT count(*) FROM images", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    };
    assert_eq!(count(), 0);

    let (loaded, _) = tokio::join!(
        assets.read(&db, &url),
        serve_image_response(
            &listener,
            "200 OK",
            "Cache-Control: max-age=3600\r\nAge: 18446744073709551615\r\n",
            &bytes
        ),
    );
    assert_eq!(loaded.unwrap(), bytes);
    assert_eq!(count(), 0);
}

#[tokio::test]
async fn public_image_cache_refetches_when_a_304_validator_does_not_match() {
    let (folder, db, assets) = setup();
    let mut assets = assets.with_image_cache(&folder.path().join("image-cache"));
    let (listener, url) = image_origin(&mut assets).await;
    let bytes = png();
    let (loaded, _) = tokio::join!(
        assets.read(&db, &url),
        serve_image_response(
            &listener,
            "200 OK",
            "Cache-Control: max-age=0\r\nETag: \"v1\"\r\n",
            &bytes
        ),
    );
    assert_eq!(loaded.unwrap(), bytes);
    let mut updated = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(3, 2)
        .write_to(&mut updated, ImageFormat::Png)
        .unwrap();
    let updated = updated.into_inner();
    let origin = async {
        let request =
            serve_image_response(&listener, "304 Not Modified", "ETag: \"v2\"\r\n", &[]).await;
        assert!(
            request
                .to_ascii_lowercase()
                .contains("if-none-match: \"v1\"")
        );
        let request = serve_image_response(
            &listener,
            "200 OK",
            "Cache-Control: max-age=3600\r\nETag: \"v2\"\r\n",
            &updated,
        )
        .await;
        assert!(!request.to_ascii_lowercase().contains("if-none-match:"));
    };
    let (loaded, ()) = tokio::join!(assets.read(&db, &url), origin);
    assert_eq!(loaded.unwrap(), updated);
}

#[tokio::test]
async fn hosted_webp_fallback_uses_its_own_digest_and_extension() {
    let (folder, db, media) = setup();
    let cache = folder.path().join("asset-thumbnails");
    let media = media.with_thumbnail_cache(cache.clone());
    let original = png();
    let mut encoded = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(3, 2)
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
        (original.clone(), false),
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
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            serve_image_response(&listener, "200 OK", "", &hosted).await;
        }
    });
    let stale_name = media
        .read_export_file(&db, &file, &original_name)
        .await
        .unwrap_err();
    assert_eq!(stale_name.code(), "EXPORT_FAILED");
    let fallback = media.thumbnail(&db, &id).await.unwrap();
    assert_eq!(
        image_header(&fallback).unwrap(),
        (ImageFormat::Png, 160, 107)
    );
    server.await.unwrap();
    assert!(!cache.exists());

    std::fs::write(media.root.join(file.path.unwrap()), &original).unwrap();
    let preview = media.thumbnail(&db, &id).await.unwrap();
    assert_eq!(
        image_header(&preview).unwrap(),
        (ImageFormat::Png, 107, 160)
    );
    assert_eq!(std::fs::read_dir(cache).unwrap().count(), 1);
}

#[tokio::test]
async fn publication_keeps_public_image_links_without_asset_records() {
    let (_folder, db, mut assets) = setup();
    image_profile(&db);
    let (listener, url) = image_origin(&mut assets).await;
    let bytes = png();
    let server = tokio::spawn(serve_image(listener, bytes.clone()));
    assert_eq!(assets.read(&db, &url).await.unwrap(), bytes);
    server.await.unwrap();

    assert_eq!(assets.public_image(&db, &url).await.unwrap(), url);
    assert!(assets.library(&db, 0).unwrap().items.is_empty());
    assert_eq!(
        assets
            .public_image(&db, "asset://missing")
            .await
            .unwrap_err()
            .code(),
        "ASSET_MISSING"
    );
    assert_eq!(
        assets
            .public_image(&db, "http://127.0.0.1/secret.png")
            .await
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
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

#[tokio::test]
async fn filling_a_placeholder_checks_live_references_and_leaves_the_body_intact() {
    let (_folder, db, assets) = setup();
    db.write(|tx| {
        tx.execute("INSERT INTO assets(id,kind,created_at,name) VALUES ('placeholder','original',0,'图片')",[])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        assets
            .fill(&db, "placeholder", png())
            .await
            .unwrap_err()
            .code(),
        "ASSET_UNUSED"
    );
    let edited = "后来补写的段落[^图]\n\n[^图]: ![图](asset://placeholder)";
    db.write(|tx| {
        tx.execute("INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at) VALUES ('other','article','',?1,'draft',0,0)",[edited])?;
        references::sync_entry(tx,"other",edited)
    }).unwrap();
    assert_eq!(
        assets.fill(&db, "placeholder", png()).await.unwrap(),
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

#[tokio::test]
async fn imported_svg_fills_the_original_asset_as_a_readable_png() {
    let (_folder, db, assets) = setup();
    let markdown = "![公众号图片](asset://svg-placeholder)";
    db.write(|tx| {
        tx.execute("INSERT INTO assets(id,kind,created_at,name) VALUES ('svg-placeholder','original',0,'公众号图片')", [])?;
        tx.execute("INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at) VALUES ('svg-entry','article','',?1,'draft',0,0)", [markdown])?;
        references::sync_entry(tx, "svg-entry", markdown)
    }).unwrap();
    let svg = br##"  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 540" width="1200" height="540"><rect width="1200" height="540" fill="#f00"/></svg>"##;
    assert_eq!(
        assets
            .fill(&db, "svg-placeholder", svg.to_vec())
            .await
            .unwrap(),
        "svg-placeholder"
    );
    let bytes = assets.read(&db, "asset://svg-placeholder").await.unwrap();
    assert_eq!(image_header(&bytes).unwrap(), (ImageFormat::Png, 1200, 540));
    assert_eq!(
        image::load_from_memory(&bytes)
            .unwrap()
            .to_rgba8()
            .get_pixel(20, 20)
            .0,
        [255, 0, 0, 255]
    );
    assert_eq!(db.export_text("svg-entry").unwrap().1, markdown);
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

fn image_profile(db: &Workspace) {
    db.write(|tx| {
        tx.execute("INSERT INTO storage_profiles VALUES ('test-images','images','https://s3.example.test','auto','images','','https://cdn.example.test','test-images')", [])?;
        tx.execute("INSERT INTO app_settings VALUES ('image_storage_profile','test-images')", [])?;
        Ok(())
    }).unwrap();
}

fn enable_auto_upload(db: &Workspace) {
    db.write(|tx| {
        tx.execute(
            "INSERT INTO app_settings VALUES ('image_upload:test-images', '{\"autoUpload\":true}')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn upload_progress_counts_only_distinct_tracked_images_in_the_document() {
    let (_folder, db, assets) = setup();
    image_profile(&db);
    let first = assets.import(&db, "一.png", &png()).unwrap();
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(5, 2)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    let second = assets.import(&db, "二.png", bytes.get_ref()).unwrap();
    let markdown = format!(
        "![原图](asset://{first})\n![重复的公开链接](https://cdn.example.test/one.png)\n\n<img src=\"asset://{second}\">\n\n![外链](https://example.test/other.png)"
    );
    assets.upload(&db, &first).unwrap();
    assert_eq!(
        upload_progress(&db, &markdown).unwrap(),
        Some(UploadProgress {
            completed: 0,
            total: 1
        })
    );
    db.write(|tx| {
        tx.execute("UPDATE jobs SET status='completed' WHERE asset_id=?1", [&first])?;
        tx.execute(
            "INSERT INTO asset_locations (sha256,storage_profile_id,object_key,public_url,uploaded_at)
             SELECT sha256,'test-images','one.png','https://cdn.example.test/one.png',1 FROM assets WHERE id=?1",
            [&first],
        )?;
        tx.execute(
            "INSERT INTO asset_urls SELECT public_url,sha256,storage_profile_id FROM asset_locations",
            [],
        )?;
        Ok(())
    }).unwrap();
    assert_eq!(upload_progress(&db, &markdown).unwrap(), None);
    assets.upload(&db, &second).unwrap();
    assert_eq!(
        upload_progress(&db, &markdown).unwrap(),
        Some(UploadProgress {
            completed: 1,
            total: 2
        })
    );
    assert_eq!(
        upload_progress(&db, &format!("![其他](asset://{first})")).unwrap(),
        None
    );
}

#[test]
fn new_images_upload_only_automatically_when_the_active_profile_enables_it() {
    let (_folder, db, assets) = setup();
    image_profile(&db);
    let local = assets.import(&db, "本地.png", &png()).unwrap();
    assert_eq!(assets.library(&db, 0).unwrap().items[0].upload_status, None);
    assets.upload(&db, &local).unwrap();
    assert_eq!(
        assets.library(&db, 0).unwrap().items[0]
            .upload_status
            .as_deref(),
        Some("queued")
    );

    enable_auto_upload(&db);
    let mut image = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(5, 2)
        .write_to(&mut image, ImageFormat::Png)
        .unwrap();
    let library_id = assets
        .import_to_library(&db, "素材.png", image.get_ref())
        .unwrap();
    let library = assets.library(&db, 0).unwrap();
    assert_eq!(
        library
            .items
            .iter()
            .find(|item| item.id == library_id)
            .unwrap()
            .upload_status
            .as_deref(),
        Some("queued")
    );
    let mut formula = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(5, 4)
        .write_to(&mut formula, ImageFormat::Png)
        .unwrap();
    let derived = assets
        .derive(&db, "math-inline", "x", formula.get_ref())
        .unwrap();
    db.read(|conn| {
        let queued: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM jobs WHERE asset_id=?1)",
            [&derived],
            |r| r.get(0),
        )?;
        assert!(!queued);
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn known_image_from_previous_profile_joins_the_active_upload_queue() {
    let (_folder, db, assets) = setup();
    image_profile(&db);
    let asset = assets.import(&db, "图片.png", &png()).unwrap();
    let url = "https://old.example.test/sample.png";
    db.write(|tx| {
        tx.execute("INSERT INTO storage_profiles VALUES ('old','images','https://old-s3.example.test','auto','old','','https://old.example.test','old')", [])?;
        tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key,public_url,uploaded_at) SELECT sha256,'old','key',?1,1 FROM assets WHERE id=?2", params![url,asset])?;
        tx.execute("INSERT INTO asset_urls SELECT ?1,sha256,'old' FROM assets WHERE id=?2", params![url,asset])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        assets.localize(&db, url).await.unwrap(),
        format!("asset://{asset}")
    );
    assert_eq!(assets.library(&db, 0).unwrap().items[0].upload_status, None);
    enable_auto_upload(&db);
    assert_eq!(
        assets.localize(&db, url).await.unwrap(),
        format!("asset://{asset}")
    );
    assert_eq!(
        assets.library(&db, 0).unwrap().items[0]
            .upload_status
            .as_deref(),
        Some("queued")
    );
}

#[tokio::test]
async fn exiting_cancels_documents_with_inflight_image_downloads() {
    let (folder, db, mut assets) = setup();
    image_profile(&db);
    enable_auto_upload(&db);
    let (server, url) = image_origin(&mut assets).await;
    let markdown = format!("![外链]({url})");
    let mut import = std::pin::pin!(assets.import_markdown_images(&db, &markdown, folder.path()));
    let socket = tokio::select! {
        connection = server.accept() => connection.unwrap().0,
        result = &mut import => panic!("import completed before making the request: {result:?}"),
    };
    db.begin_exit();
    let error = tokio::time::timeout(Duration::from_secs(1), &mut import)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code(), "EXIT_PENDING");
    drop(socket);
    db.cancel_exit();
}

#[tokio::test]
async fn imported_markdown_queues_remote_and_local_images_and_preserves_unavailable_links() {
    let (folder, db, mut assets) = setup();
    let source = folder.path().join("article");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("照片 1.png"), png()).unwrap();
    std::fs::write(folder.path().join("outside.png"), png()).unwrap();
    let (server, url) = image_origin(&mut assets).await;
    let body = format!(
        "![文档内](<照片 1.png> \"图片标题\")\n\n![外链]({url})\n\n![外部](../outside.png)\n\n`![字面]({url})`"
    );
    let (local, unavailable) = assets
        .import_markdown_images(&db, &body, &source)
        .await
        .unwrap();
    assert_eq!(unavailable, 1);
    let library = assets.library(&db, 0).unwrap();
    assert_eq!(library.items.len(), 1);
    let id = &library.items[0].id;
    assert!(local.contains(&format!(r#"![文档内](asset://{id} "图片标题")"#)));
    assert!(local.contains(&format!("![外链]({url})")));
    assert!(local.contains("![外部](../outside.png)"));
    assert!(library.items[0].upload_status.is_none());

    image_profile(&db);
    enable_auto_upload(&db);
    let mut remote = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(5, 4)
        .write_to(&mut remote, ImageFormat::Png)
        .unwrap();
    let (imported, _) = tokio::join!(
        assets.import_markdown_images(&db, &body, &source),
        serve_image_response(&server, "200 OK", "", remote.get_ref()),
    );
    let (imported, unavailable) = imported.unwrap();
    assert_eq!(unavailable, 1);
    assert!(imported.contains("![文档内](asset://"));
    assert!(imported.contains(" \"图片标题\")"));
    assert!(imported.contains("![外链](asset://"));
    assert!(imported.contains("![外部](../outside.png)"));
    assert!(imported.contains(&format!("`![字面]({url})`")));
    let library = assets.library(&db, 0).unwrap();
    assert_eq!(library.items.len(), 2);
    assert!(
        library
            .items
            .iter()
            .all(|row| row.upload_status.as_deref() == Some("queued"))
    );
}

#[tokio::test]
async fn link_import_downloads_images_only_when_enabled_and_preserves_unavailable_urls() {
    let (_folder, db, mut assets) = setup();
    image_profile(&db);
    let (server, url) = image_origin(&mut assets).await;
    let hosted = "https://cdn.example.test/hosted.png";
    let unavailable = "http://127.0.0.1/unavailable.png";
    let body = format!(
        "![原图]({url})\n\n<img src=\"{url}\">\n\n![图床]({hosted})\n\n![不可用]({unavailable})\n\n![相对路径](local.png)\n\n`![示例]({url})`"
    );
    let (untouched, failures) = assets
        .import_link_images(&db, body.clone(), false)
        .await
        .unwrap();
    assert_eq!(untouched, body);
    assert_eq!(failures, 0);
    assert!(assets.library(&db, 0).unwrap().items.is_empty());

    let bytes = png();
    let (rewritten, _) = tokio::join!(
        assets.import_link_images(&db, body, true),
        serve_image_response(&server, "200 OK", "", &bytes)
    );
    let (rewritten, failures) = rewritten.unwrap();
    assert_eq!(failures, 1);
    let library = assets.library(&db, 0).unwrap();
    assert_eq!(library.items.len(), 1);
    let local = format!("asset://{}", library.items[0].id);
    assert_eq!(assets.read(&db, &local).await.unwrap(), bytes);
    assert!(rewritten.contains(&format!("![原图]({local})")));
    assert!(rewritten.contains(&format!("<img src=\"{local}\">")));
    assert!(rewritten.contains(&format!("![图床]({hosted})")));
    assert!(rewritten.contains(&format!("![不可用]({unavailable})")));
    assert!(rewritten.contains("![相对路径](local.png)"));
    assert!(rewritten.contains(&format!("`![示例]({url})`")));
}

#[test]
fn asset_library_pages_are_disjoint_and_out_of_range_clamps_to_last_page() {
    let (_folder, db, assets) = setup();
    db.write(|tx| {
        let mut insert = tx
            .prepare("INSERT INTO assets (id,kind,created_at,name) VALUES (?1,'original',?2,?1)")?;
        for index in 0..51 {
            insert.execute(params![format!("asset-{index}"), index])?;
        }
        Ok(())
    })
    .unwrap();
    let first = assets.library(&db, 0).unwrap();
    let last = assets.library(&db, 99).unwrap();
    assert_eq!(first.page, 0);
    assert!(first.has_next);
    assert_eq!(first.items.len(), 48);
    assert_eq!(first.items[0].id, "asset-50");
    assert_eq!(last.page, 1);
    assert!(!last.has_next);
    assert_eq!(
        last.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["asset-2", "asset-1", "asset-0"]
    );
}

#[test]
fn asset_detail_refreshes_off_page_uploads_for_the_active_profile() {
    let (_folder, db, assets) = setup();
    image_profile(&db);
    let asset = assets
        .import_to_library(&db, "上传图片.png", &png())
        .unwrap();
    assets.upload(&db, &asset).unwrap();
    db.write(|tx| {
        let mut insert = tx
            .prepare("INSERT INTO assets (id,kind,created_at,name) VALUES (?1,'original',?2,?1)")?;
        for index in 0..48 {
            insert.execute(params![format!("other-{index}"), index])?;
        }
        Ok(())
    })
    .unwrap();
    assert!(
        assets
            .library(&db, 1)
            .unwrap()
            .items
            .iter()
            .all(|row| row.id != asset)
    );
    for status in ["queued", "running", "failed", "retrying"] {
        let error = (status == "failed").then_some("上传连接失败");
        db.write(|tx| {
            tx.execute(
                "UPDATE jobs SET status=?1,error=?2 WHERE kind='upload' AND asset_id=?3",
                params![status, error, asset],
            )?;
            Ok(())
        })
        .unwrap();
        let detail = assets.detail(&db, &asset).unwrap().unwrap();
        assert_eq!(detail.id, asset);
        assert_eq!(detail.upload_status.as_deref(), Some(status));
        assert_eq!(detail.upload_error.as_deref(), error);
        assert!(detail.public_url.is_none());
        let listed = assets.library(&db, 0).unwrap();
        let listed = listed.items.iter().find(|row| row.id == asset).unwrap();
        assert_eq!(
            serde_json::to_value(&detail).unwrap(),
            serde_json::to_value(listed).unwrap()
        );
    }
    db.write(|tx| {
        tx.execute("UPDATE jobs SET status='completed',error=NULL WHERE asset_id=?1", [&asset])?;
        tx.execute(
            "INSERT INTO asset_locations (sha256,storage_profile_id,object_key,public_url,uploaded_at)
             SELECT sha256,'test-images','done.png','https://cdn.example.test/done.png',1 FROM assets WHERE id=?1",
            [&asset],
        )?;
        tx.execute(
            "INSERT INTO jobs (id,kind,status,sha256,error,created_at,updated_at)
             SELECT 'cleanup','cleanup','failed',sha256,'远程清理失败',1,1 FROM assets WHERE id=?1",
            [&asset],
        )?;
        Ok(())
    })
    .unwrap();
    let detail = assets.detail(&db, &asset).unwrap().unwrap();
    assert!(detail.upload_status.is_none());
    assert!(detail.upload_error.is_none());
    assert_eq!(
        detail.public_url.as_deref(),
        Some("https://cdn.example.test/done.png")
    );
    assert_eq!(detail.cleanup_error.as_deref(), Some("远程清理失败"));
    db.write(|tx| {
        tx.execute("INSERT INTO storage_profiles VALUES ('other-images','images','https://other-s3.example.test','auto','images','','https://other-cdn.example.test','other-images')", [])?;
        tx.execute("UPDATE app_settings SET value='other-images' WHERE key='image_storage_profile'", [])?;
        Ok(())
    })
    .unwrap();
    assets.upload(&db, &asset).unwrap();
    let other = assets.detail(&db, &asset).unwrap().unwrap();
    assert!(other.public_url.is_none());
    assert_eq!(other.upload_status.as_deref(), Some("queued"));
    db.write(|tx| {
        tx.execute(
            "DELETE FROM app_settings WHERE key='image_storage_profile'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let local = assets.detail(&db, &asset).unwrap().unwrap();
    assert!(local.public_url.is_none());
    assert!(local.upload_status.is_none());
    assert_eq!(local.cleanup_error, detail.cleanup_error);
    assert!(assets.detail(&db, "missing").unwrap().is_none());
    db.write(|tx| {
        tx.execute("DELETE FROM assets WHERE id=?1", [&asset])?;
        Ok(())
    })
    .unwrap();
    assert!(assets.detail(&db, &asset).unwrap().is_none());
}

#[tokio::test]
async fn library_thumbnail_is_small_and_keeps_original_bytes() {
    let (directory, db, assets) = setup();
    let cache = directory.path().join("asset-thumbnails");
    let assets = assets.with_thumbnail_cache(cache.clone());
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
    let (first, second) = tokio::join!(assets.thumbnail(&db, &id), assets.thumbnail(&db, &id));
    let preview = first.unwrap();
    assert_eq!(second.unwrap(), preview);
    assert_eq!(image_header(&preview).unwrap(), (ImageFormat::Png, 160, 80));
    let decoded = image::load_from_memory(&preview).unwrap().to_rgba8();
    assert_eq!(decoded.get_pixel(20, 20).0, [92, 18, 6, 128]);
    assert_eq!(
        assets.read(&db, &format!("asset://{id}")).await.unwrap(),
        original
    );
    let hash = format!("{:x}", Sha256::digest(&original));
    assert_eq!(
        std::fs::read(cache.join(format!("v1-160-{hash}.png"))).unwrap(),
        preview
    );
    assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 1);
    assert_eq!(assets.library(&db, 0).unwrap().items.len(), 1);

    let file = db.read(|conn| by_id(conn, &id)).unwrap();
    std::fs::remove_file(assets.root.join(file.path.unwrap())).unwrap();
    let reopened = Assets::new(directory.path().join("assets"), &db)
        .unwrap()
        .with_thumbnail_cache(cache);
    assert_eq!(reopened.thumbnail(&db, &id).await.unwrap(), preview);
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
            .library(&db, 0)
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
            .library(&db, 0)
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
    let library = assets.library(&db, 0).unwrap();
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
