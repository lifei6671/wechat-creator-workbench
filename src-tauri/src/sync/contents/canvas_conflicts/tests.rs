use super::*;

fn board(db: &Workspace, id: &str) -> Value {
    serde_json::to_value(db.collection_canvas(id).unwrap()).unwrap()
}

fn conflict(kind: Kind) -> (tempfile::TempDir, Workspace, Key, i64) {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
    let key = Key {
        entity_type: kind,
        entity_id: match kind {
            Kind::Collection => "topic",
            Kind::CollectionNode => "note",
            Kind::CollectionEdge => "edge",
            _ => unreachable!(),
        }
        .into(),
    };
    let generation = db.write(|tx| {
        tx.execute_batch(
            "INSERT INTO sync_binding (id,url,instance_id,epoch,device_id)
             VALUES (1,'http://localhost:1234/','instance','epoch','device');
             INSERT INTO collections (id,title,description,viewport_x,viewport_y,viewport_zoom,created_at,updated_at)
             VALUES ('topic','白板','本地说明',12,34,1.5,1,1);
             INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
             VALUES ('article','article','引用文章','draft','共享正文',1,1);
             INSERT INTO assets (id,kind,created_at,name) VALUES ('image','original',1,'图片');
             INSERT INTO collection_nodes (id,collection_id,kind,content_md,x,y,width,height,created_at,updated_at)
             VALUES ('note','topic','text','原始文字',10,20,400,250,1,1);
             INSERT INTO collection_nodes (id,collection_id,kind,entry_id,asset_id,external_url,created_at,updated_at) VALUES
             ('article-card','topic','entry','article',NULL,NULL,1,1),
             ('image-card','topic','image',NULL,'image',NULL,1,1),
             ('web-card','topic','web',NULL,NULL,'https://example.test/',1,1);
             INSERT INTO collection_edges VALUES ('edge','topic','note','image-card','原始连线',1);
             UPDATE sync_progress SET initialized=1;",
        )?;
        for (kind, table) in [(Kind::Collection,"collections"),(Kind::CollectionNode,"collection_nodes"),
            (Kind::CollectionEdge,"collection_edges"),(Kind::Entry,"entries"),(Kind::Asset,"assets")] {
            let mut q = tx.prepare(&format!("SELECT id FROM {table}"))?;
            for id in q.query_map([], |row| row.get::<_,String>(0))? {
                remember(tx, &Key {entity_type:kind,entity_id:id?}, 1, false)?;
            }
        }
        tx.execute("UPDATE sync_progress SET capture=1", [])?;
        let (sql, field) = match kind {
            Kind::Collection => ("UPDATE collections SET title='本地白板' WHERE id='topic'", "title"),
            Kind::CollectionNode => ("UPDATE collection_nodes SET content_md='本地文字' WHERE id='note'", "contentMd"),
            Kind::CollectionEdge => ("UPDATE collection_edges SET label='本地连线' WHERE id='edge'", "label"),
            _ => unreachable!(),
        };
        tx.execute(sql, [])?;
        let mut payload = local_snapshot(tx, &key)?.unwrap();
        payload[field] = json!("云端版本");
        let remote = Entity { key:key.clone(), payload, remote_revision:2, deleted_at:None };
        let current = generation(tx,&key)?.unwrap();
        issue(tx,&key,current,"检测到同一内容在多台设备修改",Some(&remote))?;
        tx.execute("INSERT INTO sync_inbox VALUES (1,'group',1,?1)",[encode(&remote)?])?;
        Ok(current)
    }).unwrap();
    (root, db, key, generation)
}

#[test]
fn canvas_cloud_and_copy_preserve_graph_and_queue_only_local_copies() {
    for kind in [Kind::Collection, Kind::CollectionNode, Kind::CollectionEdge] {
        for choice in [Resolution::Cloud, Resolution::Copy] {
            let (_root, db, key, generation) = conflict(kind);
            let copying = matches!(choice, Resolution::Copy);
            let before = board(&db, "topic");
            let changed = resolve(&db, &key, choice, 2, generation).unwrap();
            assert!(changed.changed_collections.contains("topic"));
            db.read(|conn| {
                let original = local_snapshot(conn, &key)?.unwrap();
                let field = match kind {
                    Kind::Collection => "title",
                    Kind::CollectionNode => "contentMd",
                    _ => "label",
                };
                assert_eq!(original[field], "云端版本");
                assert_eq!(super::super::generation(conn, &key)?, None);
                assert_eq!(revision(conn, &key)?.0, 2);
                assert_eq!(
                    conn.query_row("SELECT COUNT(*) FROM sync_issues", [], |r| r
                        .get::<_, i64>(0))?,
                    0
                );
                assert_eq!(
                    conn.query_row("SELECT COUNT(*) FROM sync_inbox", [], |r| r
                        .get::<_, i64>(0))?,
                    0
                );
                Ok(())
            })
            .unwrap();
            if copying {
                let copy = changed
                    .changed_collections
                    .iter()
                    .find(|id| id.as_str() != "topic")
                    .unwrap();
                let saved = board(&db, copy);
                assert_eq!(
                    saved["collection"]["title"],
                    format!(
                        "{}（冲突副本）",
                        before["collection"]["title"].as_str().unwrap()
                    )
                );
                assert_eq!(
                    saved["collection"]["viewport"],
                    json!({"x":12.0,"y":34.0,"zoom":1.5})
                );
                assert_eq!(saved["nodes"].as_array().unwrap().len(), 4);
                assert_eq!(saved["edges"].as_array().unwrap().len(), 1);
                let note = saved["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|n| n["kind"] == "text")
                    .unwrap();
                let image = saved["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|n| n["kind"] == "image")
                    .unwrap();
                assert_eq!(
                    note["contentMd"],
                    if kind == Kind::CollectionNode {
                        "本地文字"
                    } else {
                        "原始文字"
                    }
                );
                assert_eq!(image["assetId"], "image");
                assert_eq!(
                    saved["nodes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|n| n["kind"] == "entry")
                        .unwrap()["entryId"],
                    "article"
                );
                assert_eq!(
                    saved["nodes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|n| n["kind"] == "web")
                        .unwrap()["externalUrl"],
                    "https://example.test/"
                );
                assert_eq!(saved["edges"][0]["sourceNodeId"], note["id"]);
                assert_eq!(saved["edges"][0]["targetNodeId"], image["id"]);
                db.read(|conn| {
                    assert_eq!(
                        conn.query_row("SELECT COUNT(*) FROM sync_dirty", [], |r| r
                            .get::<_, i64>(0))?,
                        6
                    );
                    Ok(())
                })
                .unwrap();
            } else {
                assert_eq!(db.list_collections().unwrap().len(), 1);
            }
        }
    }
}

#[test]
fn local_resolution_rebases_for_upload_without_replacing_local_content() {
    for kind in [Kind::Collection, Kind::CollectionNode, Kind::CollectionEdge] {
        let (_root, db, key, generation) = conflict(kind);
        let before = db.read(|conn| local_snapshot(conn, &key)).unwrap();
        resolve(&db, &key, Resolution::Local, 2, generation).unwrap();
        db.read(|conn| {
            assert_eq!(local_snapshot(conn, &key)?, before);
            assert_eq!(revision(conn, &key)?.0, 2);
            assert_eq!(super::super::generation(conn, &key)?, Some(generation));
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM sync_issues", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
    }
}

#[test]
fn stale_or_inflight_canvas_choices_leave_both_versions_untouched() {
    let (_root, db, key, generation) = conflict(Kind::CollectionNode);
    assert_eq!(
        resolve(&db, &key, Resolution::Copy, 2, generation + 1)
            .err()
            .unwrap()
            .code(),
        "SYNC_CONFLICT_CHANGED"
    );
    assert_eq!(
        resolve(&db, &key, Resolution::Cloud, 3, generation)
            .err()
            .unwrap()
            .code(),
        "SYNC_CONFLICT_CHANGED"
    );
    db.write(|tx| {
        tx.execute("DELETE FROM sync_issues", [])?;
        Ok(())
    })
    .unwrap();
    super::super::stage_outbox(&db).unwrap().unwrap();
    db.write(|tx| {
        let raw: String =
            tx.query_row("SELECT payload_json FROM sync_inbox", [], |row| row.get(0))?;
        let remote: Entity = serde_json::from_str(&raw).map_err(invalid_response)?;
        issue(tx, &key, generation, "待确认的上传", Some(&remote))
    })
    .unwrap();
    assert_eq!(
        resolve(&db, &key, Resolution::Copy, 2, generation)
            .err()
            .unwrap()
            .code(),
        "SYNC_IN_FLIGHT"
    );
    assert_eq!(db.list_collections().unwrap().len(), 1);
    assert_eq!(
        board(&db, "topic")["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "note")
            .unwrap()["contentMd"],
        "本地文字"
    );
}

#[test]
fn cloud_delete_copies_the_local_graph_before_replaying_the_atomic_deletion() {
    let (_root, db, key, generation) = conflict(Kind::CollectionNode);
    db.write(|tx| {
        let remote = Entity {
            key: key.clone(),
            payload: json!({}),
            remote_revision: 2,
            deleted_at: Some(3),
        };
        let edge = Entity {
            key: Key {
                entity_type: Kind::CollectionEdge,
                entity_id: "edge".into(),
            },
            payload: json!({}),
            remote_revision: 2,
            deleted_at: Some(3),
        };
        tx.execute("DELETE FROM sync_inbox", [])?;
        tx.execute(
            "INSERT INTO sync_inbox VALUES (1,'delete',2,?1)",
            [encode(&edge)?],
        )?;
        tx.execute(
            "INSERT INTO sync_inbox VALUES (2,'delete',2,?1)",
            [encode(&remote)?],
        )?;
        issue(tx, &key, generation, "云端已删除卡片", Some(&remote))?;
        Ok(())
    })
    .unwrap();
    assert!(resolve(&db, &key, Resolution::Local, 2, generation).is_err());
    let changed = resolve(&db, &key, Resolution::Copy, 2, generation).unwrap();
    let original = board(&db, "topic");
    assert!(
        !original["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == "note")
    );
    assert!(original["edges"].as_array().unwrap().is_empty());
    let copy = changed
        .changed_collections
        .iter()
        .find(|id| id.as_str() != "topic")
        .unwrap();
    let saved = board(&db, copy);
    assert_eq!(saved["nodes"].as_array().unwrap().len(), 4);
    assert_eq!(saved["edges"].as_array().unwrap().len(), 1);
}

#[test]
fn cloud_choices_wait_for_the_remaining_conflicts_in_an_atomic_group() {
    let (_root, db, key, generation) = conflict(Kind::CollectionNode);
    let edge_key = Key {
        entity_type: Kind::CollectionEdge,
        entity_id: "edge".into(),
    };
    let edge_generation = db
        .write(|tx| {
            tx.execute(
                "UPDATE collection_edges SET label='本地新连线' WHERE id='edge'",
                [],
            )?;
            let mut remote = Entity {
                key: edge_key.clone(),
                payload: canvas::snapshot_link(tx, "edge")?.unwrap(),
                remote_revision: 2,
                deleted_at: None,
            };
            remote.payload["label"] = json!("云端新连线");
            let current = super::super::generation(tx, &edge_key)?.unwrap();
            issue(tx, &edge_key, current, "同时修改", Some(&remote))?;
            tx.execute("UPDATE sync_inbox SET group_size=2", [])?;
            tx.execute(
                "INSERT INTO sync_inbox VALUES (2,'group',2,?1)",
                [encode(&remote)?],
            )?;
            Ok(current)
        })
        .unwrap();
    assert!(
        resolve(&db, &key, Resolution::Cloud, 2, generation)
            .unwrap()
            .changed_collections
            .is_empty()
    );
    assert_eq!(
        board(&db, "topic")["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "note")
            .unwrap()["contentMd"],
        "本地文字"
    );
    assert!(
        resolve(&db, &edge_key, Resolution::Cloud, 2, edge_generation)
            .unwrap()
            .changed_collections
            .contains("topic")
    );
    let result = board(&db, "topic");
    assert_eq!(
        result["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "note")
            .unwrap()["contentMd"],
        "云端版本"
    );
    assert_eq!(result["edges"][0]["label"], "云端新连线");
}

#[test]
fn failed_replay_rolls_back_the_copy_and_the_conflict_choice_together() {
    let (_root, db, key, generation) = conflict(Kind::CollectionNode);
    db.write(|tx| {
        tx.execute("INSERT INTO sync_inbox VALUES (2,'broken',1,'{')", [])?;
        Ok(())
    })
    .unwrap();
    assert!(resolve(&db, &key, Resolution::Copy, 2, generation).is_err());
    assert_eq!(db.list_collections().unwrap().len(), 1);
    db.read(|conn| {
        assert_eq!(
            local_snapshot(conn, &key)?.unwrap()["contentMd"],
            "本地文字"
        );
        assert_eq!(super::super::generation(conn, &key)?, Some(generation));
        assert_eq!(revision(conn, &key)?.0, 1);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_issues", [], |r| r
                .get::<_, i64>(0))?,
            1
        );
        Ok(())
    })
    .unwrap();
}
