use super::*;

#[test]
fn shared_entity_contract_applies_without_partial_writes() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/sync-contract/entities.json"
    ))
    .unwrap();
    let templates = &fixtures["templates"];
    for sample in fixtures["cases"].as_array().unwrap() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let entity = |kind: &str, id: &str, payload: Value| Entity {
            key: Key {
                entity_type: serde_json::from_value(json!(kind)).unwrap(),
                entity_id: id.into(),
            },
            remote_revision: 1,
            deleted_at: None,
            payload,
        };
        db.write(|tx| {
            for (kind, id) in [
                ("collection", "topic"),
                ("collection_node", "node-a"),
                ("collection_node", "node-b"),
            ] {
                apply_entity(tx, &entity(kind, id, templates[kind].clone()), &mut Applied::default())?;
            }
            Ok(())
        }).unwrap();
        let kind = sample["entityType"].as_str().unwrap();
        let mut payload = templates[kind].clone();
        payload.as_object_mut().unwrap().extend(sample["payload"].as_object().unwrap().clone());
        let candidate = entity(kind, if kind == "wechat_publication_defaults" { "default" } else { "candidate" }, payload);
        let result = db.write(|tx| apply_entity(tx, &candidate, &mut Applied::default()));
        assert_eq!(result.is_ok(), sample["accept"].as_bool().unwrap(), "{}: {:?}", sample["name"], result.err());
        db.read(|conn| {
            assert_eq!(local_snapshot(conn, &candidate.key)?.is_some(), sample["accept"].as_bool().unwrap());
            if !sample["accept"].as_bool().unwrap() {
                assert_eq!(revision(conn, &candidate.key)?, (0, false));
            }
            Ok(())
        }).unwrap();
    }
}

#[test]
fn invalid_baseline_retains_staging_and_rolls_back_all_local_writes() {
    let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
    db.write(|tx| {
        tx.execute_batch("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://localhost/','i','e','d'); UPDATE sync_progress SET capture=1;")?;
        Ok(())
    }).unwrap();
    for (id, status) in [("good", "draft"), ("bad", "inbox")] {
        stage_bootstrap(&db, &Entity { key: Key { entity_type: Kind::Entry, entity_id: id.into() }, remote_revision: 1,
            deleted_at: None, payload: json!({"kind":"article","title":"原文","contentMd":"保留正文","status":status}) }).unwrap();
    }
    db.write(|tx| { tx.execute("UPDATE sync_progress SET bootstrap_cursor=2", [])?; Ok(()) }).unwrap();
    assert!(apply_received(&db).is_err());
    db.read(|conn| {
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get::<_,i64>(0))?, 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM sync_bootstrap", [], |row| row.get::<_,i64>(0))?, 2);
        assert_eq!(conn.query_row("SELECT initialized,capture,bootstrap_cursor FROM sync_progress", [], |row| Ok((row.get::<_,bool>(0)?,row.get::<_,bool>(1)?,row.get::<_,i64>(2)?)))?, (false,true,2));
        Ok(())
    }).unwrap();
}
