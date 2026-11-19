use super::super::super::{ConnectWith, connect, create_access_key};
use super::super::{
    Resolution, SyncConnection, apply_received, apply_received_with_backup, exchange, resolve,
};
use crate::{assets::Assets, backup::Backups, db::Workspace};
use rusqlite::{Connection, params};
use std::io::Cursor;

fn populate(db: &Workspace, assets: &Assets, side: &str, color: [u8; 3]) -> (String, Vec<u8>) {
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2, 2, image::Rgb(color)))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let asset = assets.import(db, "同步附件.png", &png).unwrap();
    db.write(|tx| {
        let folder = format!("{side}-folder");
        let child = format!("{side}-child");
        let source = format!("{side}-url");
        let document = format!("{side}-doc");
        let reference = format!("{side}-ref");
        let topic = format!("{side}-topic");
        let entry_card = format!("{side}-entry-card");
        let image_card = format!("{side}-image-card");
        let shared_image_card = format!("{side}-shared-image-card");
        let edge = format!("{side}-edge");
        tx.execute("INSERT INTO categories (id,name,depth,sort_order,icon)
            VALUES (?1,'待发布',1,4,'folder')", [&folder])?;
        tx.execute("INSERT INTO categories (id,parent_id,name,depth,sort_order,icon)
            VALUES (?1,?2,'草稿',2,0,'folder')", params![child,folder])?;
        tx.execute("INSERT INTO sources VALUES (?1,'https://example.test/common-source',?2,?3,NULL,1)",
            params![source, format!("{side} 作者"), format!("{side} 账号")])?;
        tx.execute(
            "INSERT INTO assets (id,sha256,mime_type,relative_path,kind,bytes,created_at,name,width,height)
             SELECT 'shared-image',sha256,mime_type,relative_path,kind,bytes,created_at,name,width,height
             FROM assets WHERE id=?1",
            [&asset],
        )?;
        let body = format!("{side} 独有的正文\n\n![截图](asset://{asset})\n\n![独立填充](asset://shared-image)");
        tx.execute("INSERT INTO entries (id,kind,title,status,category_id,source_id,content_md,cover_asset_id,created_at,updated_at)
            VALUES (?1,'article','同名的独有文稿','draft',?2,?3,?4,?5,1,1)", params![document,child,source,body,asset])?;
        crate::assets::references::sync_entry(tx, &document, &body)?;
        tx.execute(
            "INSERT INTO entry_revisions VALUES (?1,1,?2,'manual',1)",
            params![document, body],
        )?;
        tx.execute("INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
            VALUES (?1,'reference','来源资料','unread','来源说明',1,1)", [&reference])?;
        tx.execute("INSERT INTO entry_links VALUES (?1,?2)", params![document,reference])?;
        for shared in ["shared-local", "shared-cloud", "shared-copy", "shared-identical"] {
            let text = if shared == "shared-identical" { "一样的正文" } else { side };
            tx.execute("INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
                VALUES (?1,'article',?1,'draft',?2,1,1)", params![shared,text])?;
        }
        tx.execute("INSERT INTO collections (id,title,description,created_at,updated_at)
            VALUES (?1,'本机专题','',1,1)", [&topic])?;
        tx.execute("INSERT INTO collection_nodes (id,collection_id,kind,entry_id,content_md,x,y,width,height,created_at,updated_at)
            VALUES (?1,?2,'entry',?3,'',0,0,120,100,1,1)", params![entry_card,topic,document])?;
        tx.execute("INSERT INTO collection_nodes (id,collection_id,kind,asset_id,content_md,x,y,width,height,created_at,updated_at)
            VALUES (?1,?2,'image',?3,'',140,0,120,100,1,1)", params![image_card,topic,asset])?;
        tx.execute("INSERT INTO collection_nodes (id,collection_id,kind,asset_id,content_md,x,y,width,height,created_at,updated_at)
            VALUES (?1,?2,'image','shared-image','',280,0,120,100,1,1)", params![shared_image_card,topic])?;
        tx.execute("INSERT INTO collection_edges (id,collection_id,source_node_id,target_node_id,label,created_at)
            VALUES (?1,?2,?3,?4,'配图',1)", params![edge,topic,entry_card,image_card])?;
        Ok(())
    }).unwrap();
    (asset, png)
}

#[tokio::test]
#[ignore = "requires an isolated fresh v1 service and a native system keyring"]
async fn first_join_merges_two_populated_workspaces() {
    let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
    let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
    let root = tempfile::tempdir().unwrap();
    let windows_path = root.path().join("windows");
    let mac_path = root.path().join("mac");
    let (windows, _) = Backups::open(&windows_path).unwrap();
    let (mac, mac_backups) = Backups::open(&mac_path).unwrap();
    let windows_assets = Assets::new(windows_path.join("assets"), &windows).unwrap();
    let mac_assets = Assets::new(mac_path.join("assets"), &mac).unwrap();
    let (windows_image, windows_png) = populate(&windows, &windows_assets, "windows", [12, 34, 56]);
    let (mac_image, mac_png) = populate(&mac, &mac_assets, "mac", [76, 54, 32]);
    let sync = SyncConnection::new().unwrap();
    let owner = connect(&windows, &sync, &url, "Windows", ConnectWith::Claim, &setup)
        .await
        .unwrap();
    exchange(&windows, &windows_assets, &sync).await.unwrap();
    let key = create_access_key(&windows, &sync).await.unwrap();
    let peer = connect(&mac, &sync, &url, "Mac", ConnectWith::Join, &key)
        .await
        .unwrap();
    exchange(&mac, &mac_assets, &sync).await.unwrap();
    let merged = apply_received_with_backup(&mac, Some(&mac_backups)).unwrap();

    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(merged.merge_archive.unwrap()).unwrap()).unwrap();
    assert!(archive.file_names().any(|name| name.starts_with("assets/")));
    let snapshot_path = root.path().join("before-merge.db");
    std::io::copy(
        &mut archive.by_name("content.db").unwrap(),
        &mut std::fs::File::create(&snapshot_path).unwrap(),
    )
    .unwrap();
    let before_merge = Connection::open(&snapshot_path).unwrap();
    let before: (bool, bool, String) = before_merge
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE id='mac-doc'),
                EXISTS(SELECT 1 FROM entries WHERE id='windows-doc'),
                (SELECT content_md FROM entries WHERE id='shared-local')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(before, (true, false, "mac".to_owned()));
    let drafts = mac
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM sync_issues WHERE entity_type='entry'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .unwrap();
    assert_eq!(drafts, 3);
    for (entry, choice) in [
        ("shared-local", Resolution::Local),
        ("shared-cloud", Resolution::Cloud),
        ("shared-copy", Resolution::Copy),
    ] {
        let (revision, generation) = mac.read(|tx| Ok(tx.query_row(
            "SELECT remote_json->>'$.remoteRevision', generation FROM sync_issues WHERE entity_type='entry' AND entity_id=?1",
            [entry], |row| Ok((row.get(0)?, row.get(1)?)),
        )?)).unwrap();
        resolve(&mac, entry, choice, revision, generation).unwrap();
    }
    exchange(&mac, &mac_assets, &sync).await.unwrap();
    apply_received(&mac).unwrap();
    exchange(&windows, &windows_assets, &sync).await.unwrap();
    apply_received(&windows).unwrap();

    for db in [&mac, &windows] {
        db.read(|tx| {
            let shared: (String, String, String, String) = tx.query_row(
                "SELECT (SELECT content_md FROM entries WHERE id='shared-local'),
                        (SELECT content_md FROM entries WHERE id='shared-cloud'),
                        (SELECT content_md FROM entries WHERE id='shared-copy'),
                        (SELECT content_md FROM entries WHERE title='shared-copy（冲突副本）')",
                [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            )?;
            assert_eq!(shared, ("mac".into(), "windows".into(), "windows".into(), "mac".into()));
            for (side, image, name) in [
                ("mac", &mac_image, "待发布（本机）"),
                ("windows", &windows_image, "待发布"),
            ] {
                let linked: (String, String, String, String, String) = tx.query_row(
                    "SELECT parent.name, e.cover_asset_id, s.source_url, l.source_entry_id, target.asset_id
                       FROM entries e
                       JOIN categories child ON child.id=e.category_id
                       JOIN categories parent ON parent.id=child.parent_id
                       JOIN sources s ON s.id=e.source_id
                       JOIN entry_links l ON l.article_id=e.id
                       JOIN collection_nodes card ON card.entry_id=e.id
                       JOIN collection_edges edge ON edge.source_node_id=card.id
                       JOIN collection_nodes target ON target.id=edge.target_node_id
                       WHERE e.id=?1",
                    [format!("{side}-doc")], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
                )?;
                assert_eq!(linked, (name.into(), image.clone(), "https://example.test/common-source".into(),
                    format!("{side}-ref"), image.clone()));
                let draft = crate::content::sync::snapshot(tx, &format!("{side}-doc"))?.unwrap();
                assert_eq!(draft["source"]["author"], format!("{side} 作者"));
                assert_eq!(draft["source"]["accountName"], format!("{side} 账号"));
            }
            Ok(())
        }).unwrap();
    }
    assert_eq!(
        mac_assets
            .read(&mac, &format!("asset://{windows_image}"))
            .await
            .unwrap(),
        windows_png
    );
    assert_eq!(
        windows_assets
            .read(&windows, &format!("asset://{mac_image}"))
            .await
            .unwrap(),
        mac_png
    );
    for (db, assets) in [(&mac, &mac_assets), (&windows, &windows_assets)] {
        let remapped = db
            .read(|tx| {
                let asset: String = tx.query_row(
                    "SELECT asset_id FROM collection_nodes WHERE id='mac-shared-image-card'",
                    [],
                    |row| row.get(0),
                )?;
                let body: String = tx.query_row(
                    "SELECT content_md FROM entries WHERE id='mac-doc'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(body.contains(&format!("asset://{asset}")));
                Ok(asset)
            })
            .unwrap();
        assert_ne!(remapped, "shared-image");
        assert_eq!(
            assets
                .read(db, &format!("asset://{remapped}"))
                .await
                .unwrap(),
            mac_png
        );
        assert_eq!(
            assets.read(db, "asset://shared-image").await.unwrap(),
            windows_png
        );
    }
    let local_history = mac
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT content_md FROM entry_revisions WHERE entry_id='mac-doc' AND version=1",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap();
    let remapped = mac
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT asset_id FROM collection_nodes WHERE id='mac-shared-image-card'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert!(local_history.contains(&format!("asset://{remapped}")));
    owner.key(&windows).unwrap().delete_credential().unwrap();
    peer.key(&mac).unwrap().delete_credential().unwrap();
}
