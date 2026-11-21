use super::super::super::{ConnectWith, SyncConnection, connect};
use super::super::{Outcome, Version, apply_outcome, apply_received, stage_outbox, wire_operation};
use super::super::{
    Receipt, Remote, exchange, lookup_outbox, prepare_uploads, progress, response, send,
};
use super::super::{Resolution, resolve};
use super::*;
use crate::assets::Assets;
use crate::db::Workspace;
use reqwest::Method;
use serde_json::json;

#[test]
fn a_recoverable_cloud_deletion_does_not_acknowledge_a_permanent_purge() {
    let key = Key { entity_type: Kind::Entry, entity_id: "purged".into() };
    let mutation = Mutation { key: key.clone(), base_revision: 1, operation: "delete".into(),
        payload: Some(json!({"purgedAt":2,"deletedAt":1})) };
    let mut remote = Entity { key, payload: json!({"deletedAt":1}), remote_revision: 2, deleted_at: Some(1) };
    assert!(!target_matches(&mutation,Some(&remote)));
    remote.payload["purgedAt"] = json!(3);
    assert!(target_matches(&mutation,Some(&remote)));
}

fn workspace() -> (tempfile::TempDir, Workspace) {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
    db.write(|tx| {
        tx.execute_batch(
            "INSERT INTO sync_binding (id,url,instance_id,epoch,device_id)
            VALUES (1,'http://localhost:1234/','instance','epoch','old-device');
            INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
            VALUES ('draft','article','Draft','draft','original',1,1),
                   ('other','article','Other','draft','unchanged',1,1);
            UPDATE sync_progress SET initialized=1,cursor=4;",
        )?;
        for (kind, table) in [(Kind::Category, "categories"), (Kind::Entry, "entries")] {
            let mut query = tx.prepare(&format!("SELECT id FROM {table}"))?;
            for row in query.query_map([], |row| row.get::<_, String>(0))? {
                let key = Key {
                    entity_type: kind,
                    entity_id: row?,
                };
                let entity = Entity {
                    payload: local_snapshot(tx, &key)?.unwrap(),
                    key,
                    remote_revision: 1,
                    deleted_at: None,
                };
                remember(tx, &entity.key, 1, false)?;
                tx.execute(
                    "INSERT INTO sync_bootstrap VALUES (?1,?2,1,?3)",
                    params![kind.key(), entity.key.entity_id, encode(&entity)?],
                )?;
            }
        }
        tx.execute("UPDATE sync_progress SET capture=1", [])?;
        Ok(())
    })
    .unwrap();
    (root, db)
}

fn cloud(db: &Workspace, id: &str, content: &str, revision: i64) {
    db.write(|tx| {
        let key = Key {entity_type:Kind::Entry,entity_id:id.into()};
        let mut remote = staged(tx,&key)?.unwrap();
        remote.payload["contentMd"] = json!(content);
        remote.remote_revision = revision;
        tx.execute("UPDATE sync_bootstrap SET revision=?1,payload_json=?2 WHERE entity_type='entry' AND entity_id=?3",
            params![revision,encode(&remote)?,id])?;
        Ok(())
    }).unwrap();
}

fn apply_snapshot(db: &Workspace) -> Result<Applied> {
    db.write(|tx| {
        tx.execute("UPDATE sync_progress SET bootstrap_cursor=20", [])?;
        Ok(())
    })?;
    apply_received(db)
}

fn edit(db: &Workspace, id: &str, content: &str) {
    db.write(|tx| {
        tx.execute(
            "UPDATE entries SET content_md=?1 WHERE id=?2",
            params![content, id],
        )?;
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn regression_frozen_oversized_outbox_is_rejected_without_blocking_later_edits() {
    for later_edit in [false, true] {
        let (_root, db) = workspace();
        db.write(|tx| {
            tx.execute(
                "UPDATE entries SET summary=?1 WHERE id='draft'",
                ["x".repeat(super::super::MAX_ENTITY_BYTES + 1)],
            )?;
            Ok(())
        })
        .unwrap();
        let (frozen, generations) = stage_outbox(&db).unwrap().unwrap();
        if later_edit {
            db.write(|tx| {
                tx.execute(
                    "UPDATE entries SET summary='',content_md='newer edit' WHERE id='draft'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        }
        let sync = SyncConnection::new().unwrap();
        let remote = Remote {
            sync: &sync,
            base: "http://127.0.0.1:1/".parse().unwrap(),
            token: String::new(),
            binding: super::super::Binding::read(&db).unwrap().unwrap(),
        };
        assert!(!lookup_outbox(&db, &remote).await.unwrap());
        db.read(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT generation FROM sync_issues WHERE entity_id='draft'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                generations[0]
            );
            Ok(())
        })
        .unwrap();
        if later_edit {
            let (next, _) = stage_outbox(&db).unwrap().unwrap();
            assert_ne!(next.operation_id, frozen.operation_id);
            assert_eq!(
                next.mutations[0].payload.as_ref().unwrap()["contentMd"],
                "newer edit"
            );
            wire_operation(&next).unwrap();
        } else {
            assert!(stage_outbox(&db).unwrap().is_none());
            edit(&db, "other", "independent edit");
            assert_eq!(
                stage_outbox(&db).unwrap().unwrap().0.mutations[0]
                    .key
                    .entity_id,
                "other"
            );
        }
    }
}

#[test]
fn complete_reconciliation_preserves_local_edits_and_applies_cloud_updates() {
    let (_root, db) = workspace();
    edit(&db, "draft", "local pending");
    cloud(&db, "other", "remote update", 2);
    db.write(|tx| {
        tx.execute_batch(
            "INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
            VALUES ('local-only','article','Local only','draft','keep me',1,1)",
        )?;
        Ok(())
    })
    .unwrap();
    let changed = apply_snapshot(&db).unwrap();
    assert_eq!(changed.changed_entries, vec!["other"]);
    db.read(|conn| {
        assert_eq!(
            local_snapshot(
                conn,
                &Key {
                    entity_type: Kind::Entry,
                    entity_id: "draft".into()
                }
            )?
            .unwrap()["contentMd"],
            "local pending"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sync_dirty WHERE entity_type='entry'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            2
        );
        assert_eq!(
            conn.query_row("SELECT cursor FROM sync_progress", [], |row| row
                .get::<_, i64>(0))?,
            20
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn cloud_tombstones_remove_unchanged_folder_and_canvas_in_dependency_order() {
    let (_root, db) = workspace();
    db.write(|tx| {
        tx.execute_batch("UPDATE sync_progress SET capture=0;
            INSERT INTO categories (id,name,depth,sort_order,icon) VALUES ('folder','Folder',1,4,'folder');
            UPDATE entries SET category_id='folder' WHERE id='draft';
            INSERT INTO collections (id,title,created_at,updated_at) VALUES ('topic','Topic',1,1);
            INSERT INTO collection_nodes (id,collection_id,kind,created_at,updated_at)
                VALUES ('card-a','topic','text',1,1),('card-b','topic','text',1,1);
            INSERT INTO collection_edges VALUES ('edge','topic','card-a','card-b','',1);")?;
        for (kind,id) in [(Kind::Category,"folder"),(Kind::Collection,"topic"),
            (Kind::CollectionNode,"card-a"),(Kind::CollectionNode,"card-b"),(Kind::CollectionEdge,"edge")] {
            let key=Key {entity_type:kind,entity_id:id.into()};
            remember(tx,&key,1,false)?;
            let remote=Entity {key,payload:json!({}),remote_revision:2,deleted_at:Some(2)};
            tx.execute("INSERT INTO sync_bootstrap VALUES (?1,?2,2,?3)",params![kind.key(),id,encode(&remote)?])?;
        }
        tx.execute("UPDATE sync_progress SET capture=1",[])?;
        Ok(())
    }).unwrap();
    cloud(&db, "draft", "original", 2);
    apply_snapshot(&db).unwrap();
    db.read(|conn| {
        for table in ["collections", "collection_nodes", "collection_edges"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM categories WHERE id='folder'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_dirty", [], |row| row
                .get::<_, i64>(0))?,
            0
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn missing_tombstone_rolls_back_then_persists_history_pause() {
    let (_root, db) = workspace();
    edit(&db, "draft", "keep local");
    db.write(|tx| {
        tx.execute(
            "DELETE FROM sync_bootstrap WHERE entity_type='entry' AND entity_id='other'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let error = apply_snapshot(&db).err().unwrap();
    assert_eq!(error.code(), "SYNC_HISTORY");
    db.read(|conn| {
        let state = conn.query_row(
            "SELECT paused,pause_reason,(SELECT cursor FROM sync_progress) FROM sync_binding",
            [],
            |row| {
                Ok((
                    row.get::<_, bool>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?;
        assert_eq!(state, (true, "history_inconsistent".into(), 4));
        assert!(
            generation(
                conn,
                &Key {
                    entity_type: Kind::Entry,
                    entity_id: "draft".into()
                }
            )?
            .is_some()
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn lower_revision_pauses_without_rewriting_outbox_or_local_data() {
    let (_root, db) = workspace();
    edit(&db, "draft", "pending");
    let (operation, _) = stage_outbox(&db).unwrap().unwrap();
    cloud(&db, "other", "rollback", 0);
    assert_eq!(apply_snapshot(&db).err().unwrap().code(), "SYNC_HISTORY");
    assert_eq!(
        stage_outbox(&db).unwrap().unwrap().0.operation_id,
        operation.operation_id
    );
}

#[test]
fn registration_repackages_group_once_without_changing_frozen_bases_or_generations() {
    let (_root, db) = workspace();
    edit(&db, "draft", "frozen");
    let (old, generations) = stage_outbox(&db).unwrap().unwrap();
    edit(&db, "draft", "later edit");
    db.write(|tx| {
        tx.execute("UPDATE sync_binding SET device_id='new-device'", [])?;
        outbox(tx)?;
        Ok(())
    })
    .unwrap();
    let (new, new_generations) = stage_outbox(&db).unwrap().unwrap();
    assert_ne!(old.operation_id, new.operation_id);
    assert_eq!(
        encode(&old.mutations).unwrap(),
        encode(&new.mutations).unwrap()
    );
    assert_eq!(generations, new_generations);
    db.write(|tx| {
        outbox(tx)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        stage_outbox(&db).unwrap().unwrap().0.operation_id,
        new.operation_id
    );
}

#[test]
fn matched_receipt_only_acknowledges_frozen_generation_and_does_not_lower_versions() {
    let (_root, db) = workspace();
    edit(&db, "draft", "frozen");
    let (operation, generations) = stage_outbox(&db).unwrap().unwrap();
    edit(&db, "draft", "later");
    db.write(|tx| {
        remember(tx, &operation.mutations[0].key, 5, false)?;
        let result = Outcome {
            status: "applied".into(),
            reason: None,
            versions: Some(vec![Version {
                key: operation.mutations[0].key.clone(),
                remote_revision: 2,
            }]),
        };
        apply_outcome(tx, &operation, &generations, &result)?;
        assert_eq!(revision(tx, &operation.mutations[0].key)?.0, 5);
        assert!(generation(tx, &operation.mutations[0].key)?.unwrap() > generations[0]);
        Ok(())
    })
    .unwrap();
}

#[test]
fn partial_group_convergence_stays_blocked_as_a_whole() {
    let (_root, db) = workspace();
    db.write(|tx| {
        tx.execute("UPDATE sync_progress SET active_batch='atomic-group'", [])?;
        Ok(())
    })
    .unwrap();
    edit(&db, "draft", "local-one");
    edit(&db, "other", "local-two");
    let (operation, _) = stage_outbox(&db).unwrap().unwrap();
    assert_eq!(operation.mutations.len(), 2);
    cloud(&db, "draft", "local-one", 2);
    cloud(&db, "other", "remote-two", 2);
    apply_snapshot(&db).unwrap();
    db.read(|conn| {
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_dirty", [], |row| row
                .get::<_, i64>(0))?,
            2
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row
                .get::<_, i64>(0))?,
            2
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row
                .get::<_, i64>(0))?,
            0
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn push_and_receipt_wire_forms_are_identical_for_forced_and_long_bodies() {
    let short = Mutation {
        key: Key {
            entity_type: Kind::Entry,
            entity_id: "short".into(),
        },
        base_revision: 1,
        operation: "upsert".into(),
        payload: Some(json!({"contentMd":"short"})),
    };
    let mut long = short.clone();
    long.key.entity_id = "long".into();
    long.payload = Some(json!({"contentMd":"x".repeat(70*1024)}));
    let operation = Operation {
        operation_id: "op".into(),
        mutations: vec![short, long],
    };
    let (push, bodies) = wire_operation(&operation).unwrap();
    let (lookup, _) = wire_operation(&operation).unwrap();
    assert_eq!(encode(&push).unwrap(), encode(&lookup).unwrap());
    assert_eq!(bodies.len(), 2);
    assert!(
        push.mutations
            .iter()
            .all(|mutation| mutation.payload.as_ref().unwrap()["contentMd"].is_null())
    );
    assert_eq!(
        operation.mutations[0].payload.as_ref().unwrap()["contentMd"],
        "short"
    );
}

fn deleted_folder(db: &Workspace) {
    db.write(|tx| {
        tx.execute_batch("UPDATE sync_progress SET capture=0;
            INSERT INTO categories (id,name,depth,sort_order,icon) VALUES ('folder','Folder',1,4,'folder');
            UPDATE entries SET category_id='folder' WHERE id='draft';
            UPDATE sync_progress SET capture=1;")?;
        let key=Key {entity_type:Kind::Category,entity_id:"folder".into()};
        remember(tx,&key,1,false)?;
        let remote=Entity {key,payload:json!({}),remote_revision:2,deleted_at:Some(2)};
        tx.execute("INSERT INTO sync_bootstrap VALUES ('category','folder',2,?1)",[encode(&remote)?])?;
        Ok(())
    }).unwrap();
    cloud(db, "draft", "original", 2);
}

#[test]
fn folder_deletion_waits_for_dirty_entry_without_blocking_independent_updates() {
    let (_root, db) = workspace();
    deleted_folder(&db);
    edit(&db, "draft", "local edit in deleted folder");
    cloud(&db, "other", "independent remote update", 2);
    let applied = apply_snapshot(&db).unwrap();
    assert!(applied.changed_entries.contains(&"other".into()));
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT category_id,content_md FROM entries WHERE id='draft'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            )?,
            ("folder".into(), "local edit in deleted folder".into())
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row
                .get::<_, i64>(0))?,
            2
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(
        resolve(&db, "draft", Resolution::Local, 2, 1)
            .err()
            .unwrap()
            .code(),
        "SYNC_DIRECTORY"
    );
    let copied = resolve(&db, "draft", Resolution::Copy, 2, 1).unwrap();
    assert_eq!(copied.changed_entries.len(), 2);
    db.read(|conn| {
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM categories WHERE id='folder'",[],|row| row.get::<_,i64>(0))?,0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM sync_issues",[],|row| row.get::<_,i64>(0))?,0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM entries WHERE content_md='local edit in deleted folder' AND category_id IS NULL",[],|row| row.get::<_,i64>(0))?,1);
        Ok(())
    }).unwrap();
}

#[test]
fn folder_deletion_preserves_a_new_local_child_until_it_is_moved() {
    let (_root, db) = workspace();
    deleted_folder(&db);
    db.write(|tx| {
        tx.execute("INSERT INTO categories (id,parent_id,name,depth,sort_order,icon) VALUES ('local-child','folder','Local child',2,0,'folder')",[])?;
        Ok(())
    }).unwrap();
    apply_snapshot(&db).unwrap();
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT parent_id FROM categories WHERE id='local-child'",
                [],
                |row| row.get::<_, String>(0)
            )?,
            "folder"
        );
        assert!(
            generation(
                conn,
                &Key {
                    entity_type: Kind::Category,
                    entity_id: "local-child".into()
                }
            )?
            .is_some()
        );
        Ok(())
    })
    .unwrap();
    db.write(|tx| {
        tx.execute(
            "UPDATE categories SET parent_id=NULL,depth=1 WHERE id='local-child'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    apply_received(&db).unwrap();
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM categories WHERE id='folder'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM categories WHERE id='local-child'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            1
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn cloud_topic_deletion_preserves_dirty_and_new_local_cards_and_edges() {
    let (_root, db) = workspace();
    db.write(|tx| {
        tx.execute_batch("UPDATE sync_progress SET capture=0;
            INSERT INTO collections (id,title,created_at,updated_at) VALUES ('topic','Topic',1,1);
            INSERT INTO collection_nodes (id,collection_id,kind,content_md,created_at,updated_at)
                VALUES ('card-a','topic','text','original card',1,1),('card-b','topic','text','other card',1,1);
            INSERT INTO collection_edges VALUES ('old-edge','topic','card-a','card-b','',1);")?;
        for (kind,id) in [(Kind::Collection,"topic"),(Kind::CollectionNode,"card-a"),
            (Kind::CollectionNode,"card-b"),(Kind::CollectionEdge,"old-edge")] {
            let key=Key {entity_type:kind,entity_id:id.into()};
            remember(tx,&key,1,false)?;
            let remote=Entity {key,payload:json!({}),remote_revision:2,deleted_at:Some(2)};
            tx.execute("INSERT INTO sync_bootstrap VALUES (?1,?2,2,?3)",params![kind.key(),id,encode(&remote)?])?;
        }
        tx.execute_batch("UPDATE sync_progress SET capture=1;
            UPDATE collection_nodes SET content_md='keep dirty card' WHERE id='card-a';
            INSERT INTO collection_nodes (id,collection_id,kind,content_md,created_at,updated_at)
                VALUES ('local-card','topic','text','keep new card',1,1);
            INSERT INTO collection_edges VALUES ('new-edge','topic','local-card','card-b','new link',1);")?;
        Ok(())
    }).unwrap();
    cloud(&db, "other", "independent update", 2);
    let changed = apply_snapshot(&db).unwrap();
    assert!(changed.changed_entries.contains(&"other".into()));
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT content_md FROM collection_nodes WHERE id='card-a'",
                [],
                |row| row.get::<_, String>(0)
            )?,
            "keep dirty card"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM collection_nodes", [], |row| row
                .get::<_, i64>(0))?,
            3
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM collection_edges WHERE id='new-edge'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM collections WHERE id='topic'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            1
        );
        Ok(())
    })
    .unwrap();
    // The user has retained what they need and explicitly removes the local cards.
    db.delete_collection_node("card-a").unwrap();
    db.delete_collection_node("local-card").unwrap();
    apply_received(&db).unwrap();
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM collections WHERE id='topic'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM collection_nodes", [], |row| row
                .get::<_, i64>(0))?,
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_issues", [], |row| row
                .get::<_, i64>(0))?,
            0
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated fresh v1 service and a native system keyring"]
async fn blob_group_receipt_survives_response_loss_and_device_reregistration() {
    struct Credentials(Vec<keyring::Entry>);
    impl Drop for Credentials {
        fn drop(&mut self) {
            for entry in &self.0 {
                let _ = entry.delete_credential();
            }
        }
    }
    let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
    let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("writer.sqlite")).unwrap();
    let peer = Workspace::open(&root.path().join("peer.sqlite")).unwrap();
    let assets = Assets::new(root.path().join("writer-assets"), &db).unwrap();
    let peer_assets = Assets::new(root.path().join("peer-assets"), &peer).unwrap();
    let sync = SyncConnection::new().unwrap();
    let mut credentials = Credentials(Vec::new());
    let original = connect(
        &db,
        &sync,
        &url,
        "Original writer",
        ConnectWith::Join,
        &setup,
    )
    .await
    .unwrap();
    credentials.0.push(original.key(&db).unwrap());
    db.write(|tx| {
        tx.execute_batch(
            "INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
            VALUES ('short-body','article','Short','draft','initial short',1,1),
                   ('long-body','article','Long','draft','initial long',1,1)",
        )?;
        Ok(())
    })
    .unwrap();
    exchange(&db, &assets, &sync).await.unwrap();
    let peer_binding = connect(
        &peer,
        &sync,
        &url,
        "Second device",
        ConnectWith::Join,
        &setup,
    )
    .await
    .unwrap();
    credentials.0.push(peer_binding.key(&peer).unwrap());

    let long_body = "长正文回执测试。".repeat(12_000);
    let short_body = "short body forced into a blob by the atomic group";
    db.write(|tx| {
        tx.execute("UPDATE sync_progress SET active_batch='receipt-group'", [])?;
        tx.execute(
            "UPDATE entries SET content_md=?1 WHERE id='short-body'",
            [short_body],
        )?;
        tx.execute(
            "UPDATE entries SET content_md=?1 WHERE id='long-body'",
            [&long_body],
        )?;
        tx.execute("UPDATE sync_progress SET active_batch=NULL", [])?;
        Ok(())
    })
    .unwrap();
    let (operation, generations) = stage_outbox(&db).unwrap().unwrap();
    assert_eq!(operation.mutations.len(), 2);
    let original_frozen = encode(&operation).unwrap();
    let remote = Remote::open(&db, &sync).await.unwrap();
    let wire = prepare_uploads(&db, &assets, &remote, &operation)
        .await
        .unwrap();
    assert!(wire.mutations.iter().all(|mutation| {
        mutation.payload.as_ref().unwrap()["contentBlobHash"].is_string()
            && mutation.payload.as_ref().unwrap()["contentMd"].is_null()
    }));
    let receipt: Receipt =
        response(remote.request(Method::POST, "v1/sync/push").unwrap().json(
            &json!({"protocolVersion":1,"cursor":progress(&db).unwrap().2,"operations":[wire]}),
        ))
        .await
        .unwrap();
    assert_eq!(receipt.results[0].status, "applied");
    // Deliberately leave the durable outbox untouched, as when the response is lost.
    edit(
        &db,
        "short-body",
        "newer local edit after the frozen upload",
    );
    assert_eq!(
        encode(&stage_outbox(&db).unwrap().unwrap().0).unwrap(),
        original_frozen
    );
    let peer_remote = Remote::open(&peer, &sync).await.unwrap();
    send(
        peer_remote
            .request(
                Method::DELETE,
                &format!("v1/devices/{}", original.device_id),
            )
            .unwrap(),
    )
    .await
    .unwrap();
    let registered = connect(
        &db,
        &sync,
        &url,
        "Reauthorized writer",
        ConnectWith::Join,
        &setup,
    )
    .await
    .unwrap();
    assert_ne!(registered.device_id, original.device_id);
    db.read(|conn| {
        assert_eq!(
            conn.query_row("SELECT origin_device_id FROM sync_outbox", [], |row| row
                .get::<_, String>(
                0
            ))?,
            original.device_id
        );
        Ok(())
    })
    .unwrap();

    let current_remote = Remote::open(&db, &sync).await.unwrap();
    assert!(!lookup_outbox(&db, &current_remote).await.unwrap());
    db.read(|conn| {
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row
                .get::<_, i64>(0))?,
            0
        );
        for (index, mutation) in operation.mutations.iter().enumerate() {
            assert_eq!(revision(conn, &mutation.key)?.0, 2);
            if mutation.key.entity_id == "short-body" {
                assert!(generation(conn, &mutation.key)?.unwrap() > generations[index]);
            } else {
                assert!(generation(conn, &mutation.key)?.is_none());
            }
        }
        Ok(())
    })
    .unwrap();
    exchange(&db, &assets, &sync).await.unwrap();
    exchange(&peer, &peer_assets, &sync).await.unwrap();
    apply_received(&peer).unwrap();
    peer.read(|conn| {
        assert_eq!(
            local_snapshot(
                conn,
                &Key {
                    entity_type: Kind::Entry,
                    entity_id: "short-body".into()
                }
            )?
            .unwrap()["contentMd"],
            "newer local edit after the frozen upload"
        );
        assert_eq!(
            local_snapshot(
                conn,
                &Key {
                    entity_type: Kind::Entry,
                    entity_id: "long-body".into()
                }
            )?
            .unwrap()["contentMd"],
            long_body
        );
        Ok(())
    })
    .unwrap();
}
