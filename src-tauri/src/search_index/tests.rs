use super::*;
use crate::{
    content::{Filter, WorkspaceSearch},
    db::Workspace,
};
use std::sync::mpsc;

fn workspace() -> (tempfile::TempDir, PathBuf, Workspace) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("content.db");
    let db = Workspace::open(&path).unwrap();
    (root, path, db)
}

fn source(db: &Workspace, id: &str, title: &str, body: &str) -> i64 {
    db.write(|tx| {
        tx.execute(
            "INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
            VALUES(?1,'article',?2,?3,'draft',100,100)",
            rusqlite::params![id, title, body],
        )?;
        Ok(tx.last_insert_rowid())
    })
    .unwrap()
}

fn stale(db: &Workspace) {
    db.write(|tx| {
        tx.execute(
            "UPDATE search_index_state SET signature='old' WHERE id=1",
            [],
        )?;
        Ok(())
    })
    .unwrap();
}

fn connection(path: &std::path::Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.busy_timeout(Duration::from_secs(2)).unwrap();
    register(&conn).unwrap();
    conn
}

fn finish_base(build: &mut Build, conn: &mut Connection) {
    loop {
        let rows = build.base(conn).unwrap();
        if rows.is_empty() {
            break;
        }
        build.cursor = rows.last().map(|row| row.rowid);
        build
            .write(conn, rows.into_iter().map(Source::segment).collect(), false)
            .unwrap();
    }
}

fn finish_dirty(build: &Build, conn: &mut Connection) {
    loop {
        let rows = build.dirty(conn).unwrap();
        if rows.is_empty() {
            break;
        }
        build
            .write(conn, rows.into_iter().map(Source::segment).collect(), true)
            .unwrap();
    }
}

fn posting(conn: &Connection, rowid: i64, text: &str) -> i64 {
    let table = state(conn).unwrap().table.expect("word index ready");
    conn.query_row(
        &format!("SELECT count(*) FROM {table} WHERE rowid=?1 AND {table} MATCH ?2"),
        rusqlite::params![rowid, match_query(&words(text), " AND ")],
        |r| r.get(0),
    )
    .unwrap()
}

fn page(db: &Workspace, text: &str) -> serde_json::Value {
    serde_json::to_value(
        db.entries(Filter {
            workspace_search: Some(WorkspaceSearch {
                text: text.into(),
                case_sensitive: false,
                match_page: None,
            }),
            ..Filter::default()
        })
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn tokens_keep_original_bytes_and_line_boundaries() {
    let text = "😀公众号\r\n排版 CAFÉ WES-5.4.5 İ\n";
    let whole = tokens(text);
    let mut offset = 0;
    let mut lines = Vec::new();
    for line in text.split_inclusive('\n') {
        for token in tokens(line) {
            lines.push((
                token.word,
                token.range.start + offset..token.range.end + offset,
            ));
        }
        offset += line.len();
    }
    assert_eq!(
        whole
            .iter()
            .map(|t| (t.word.clone(), t.range.clone()))
            .collect::<Vec<_>>(),
        lines
    );
    for token in whole {
        assert_eq!(text[token.range].to_lowercase(), token.word);
    }
}

#[test]
fn concurrent_edits_purges_rowid_reuse_and_late_saves_are_caught_before_switch() {
    let (_root, path, db) = workspace();
    let edited = source(&db, "edited", "研究", "排版");
    let purged = source(&db, "purged", "清除", "旧资料");
    let reused = source(&db, "removed", "删除", "旧文档");
    stale(&db);
    let mut conn = connection(&path);
    let mut build = Build::begin(&mut conn).unwrap();
    let old_rows = build.base(&conn).unwrap();
    db.write(|tx| {
        tx.execute(
            "UPDATE entries SET content_md='写作',version=version+1 WHERE id='edited'",
            [],
        )?;
        tx.execute(
            "UPDATE entries SET purged_at=1,deleted_at=1 WHERE id='purged'",
            [],
        )?;
        tx.execute("DELETE FROM entries WHERE id='removed'", [])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(source(&db, "replacement", "新内容", "替换"), reused);
    build.cursor = old_rows.last().map(|row| row.rowid);
    build
        .write(
            &mut conn,
            old_rows.into_iter().map(Source::segment).collect(),
            false,
        )
        .unwrap();
    let pending = build.dirty(&conn).unwrap();
    db.write(|tx| {
        tx.execute(
            "UPDATE entries SET content_md='灵感',version=version+1 WHERE id='edited'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    build
        .write(
            &mut conn,
            pending.into_iter().map(Source::segment).collect(),
            true,
        )
        .unwrap();
    assert!(
        !build.switch(&mut conn).unwrap(),
        "newer queue revision must remain pending"
    );
    assert!(state(&conn).unwrap().table.is_none());
    finish_dirty(&build, &mut conn);
    let late = source(&db, "late", "晚到", "末次保存");
    assert!(
        !build.switch(&mut conn).unwrap(),
        "write between drain and switch must be caught"
    );
    finish_dirty(&build, &mut conn);
    assert!(build.switch(&mut conn).unwrap());
    assert_eq!(posting(&conn, edited, "灵感"), 1);
    assert_eq!(posting(&conn, edited, "写作"), 0);
    assert_eq!(posting(&conn, edited, "排版"), 0);
    assert_eq!(posting(&conn, purged, "旧资料"), 0);
    assert_eq!(posting(&conn, reused, "替换"), 1);
    assert_eq!(posting(&conn, reused, "旧文档"), 0);
    assert_eq!(posting(&conn, late, "末次保存"), 1);
    db.write(|tx| {
        tx.execute(
            "UPDATE entries SET content_md='完成后保存' WHERE id='replacement'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(posting(&conn, reused, "完成后保存"), 1);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM search_index_dirty", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        crate::db::validate_backup_schema(&conn).unwrap(),
        crate::db::SCHEMA_VERSION
    );
}

#[test]
fn source_segmentation_and_staging_writes_do_not_hold_the_foreground_mutex() {
    let (_root, path, db) = workspace();
    let id = source(&db, "note", "方法", "初稿");
    stale(&db);
    let mut conn = connection(&path);
    let mut build = Build::begin(&mut conn).unwrap();
    let raw = build.base(&conn).unwrap();
    db.write(|tx| {
        tx.execute("UPDATE entries SET content_md='编辑中' WHERE id='note'", [])?;
        Ok(())
    })
    .unwrap();
    let indexed: Vec<_> = raw.into_iter().map(Source::segment).collect();
    db.write(|tx| {
        tx.execute("UPDATE entries SET content_md='已保存' WHERE id='note'", [])?;
        Ok(())
    })
    .unwrap();
    build.cursor = Some(id);
    build.write(&mut conn, indexed, false).unwrap();
    finish_dirty(&build, &mut conn);
    assert!(build.switch(&mut conn).unwrap());
    assert_eq!(posting(&conn, id, "已保存"), 1);
}

#[test]
fn a_reader_keeps_one_generation_across_atomic_cutover() {
    let (_root, path, db) = workspace();
    source(&db, "note", "公众号", "排版");
    stale(&db);
    let mut builder = connection(&path);
    let mut build = Build::begin(&mut builder).unwrap();
    finish_base(&mut build, &mut builder);
    let mut reader = connection(&path);
    let snapshot = reader.transaction().unwrap();
    assert!(state(&snapshot).unwrap().table.is_none());
    assert!(build.switch(&mut builder).unwrap());
    assert!(
        state(&snapshot).unwrap().table.is_none(),
        "read transaction must retain its generation"
    );
    snapshot.commit().unwrap();
    assert!(state(&reader).unwrap().table.is_some());
}

#[test]
fn a_mid_build_snapshot_restarts_without_serving_partial_words() {
    let (root, path, db) = workspace();
    source(&db, "old", "公众号", "排版");
    stale(&db);
    let mut conn = connection(&path);
    let mut build = Build::begin(&mut conn).unwrap();
    finish_base(&mut build, &mut conn);
    source(&db, "later", "公众号", "排版");
    let snapshot_path = root.path().join("snapshot.db");
    let mut snapshot = Connection::open(&snapshot_path).unwrap();
    rusqlite::backup::Backup::new(&conn, &mut snapshot)
        .unwrap()
        .run_to_completion(128, Duration::from_millis(1), None)
        .unwrap();
    drop(snapshot);
    let restored = Workspace::open_existing(&snapshot_path).unwrap();
    assert_eq!(page(&restored, "公众号排版")["search"]["indexing"], true);
    assert_eq!(
        page(&restored, "公众号排版")["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let (send, receive) = mpsc::channel();
    restored
        .start_search_index(move || {
            let _ = send.send(());
        })
        .unwrap();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(restored.search_index_error(), None);
    let ready = page(&restored, "公众号排版");
    assert_eq!(ready["items"].as_array().unwrap().len(), 2);
    assert_eq!(ready["search"]["indexing"], false);
    assert_ne!(ready["search"]["indexGeneration"], "0:literal");
}

#[test]
fn a_failed_switch_preserves_literal_search_and_can_resume_after_cancel_exit() {
    let (_root, _path, db) = workspace();
    source(&db, "note", "公众号", "排版");
    stale(&db);
    db.write(|tx| {
        tx.execute_batch(
            "CREATE TRIGGER reject_switch BEFORE UPDATE OF active_slot ON search_index_state
            BEGIN SELECT RAISE(ABORT,'injected switch failure'); END;",
        )?;
        Ok(())
    })
    .unwrap();
    let (send, receive) = mpsc::channel();
    db.start_search_index(move || {
        let _ = send.send(());
    })
    .unwrap();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        db.search_index_error()
            .unwrap()
            .contains("injected switch failure")
    );
    let failed = page(&db, "排版");
    assert_eq!(failed["items"].as_array().unwrap().len(), 1);
    assert_eq!(failed["search"]["indexing"], false);
    assert!(
        failed["search"]["error"]
            .as_str()
            .unwrap()
            .contains("injected switch failure")
    );
    db.write(|tx| {
        tx.execute_batch("DROP TRIGGER reject_switch;")?;
        tx.execute("UPDATE entries SET content_md='新排版' WHERE id='note'", [])?;
        Ok(())
    })
    .unwrap();
    db.begin_exit();
    db.cancel_exit();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(db.search_index_error(), None);
    assert_eq!(
        page(&db, "公众号新排版")["items"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn restoring_closes_background_connections_before_replacing_the_database() {
    let (root, path, db) = workspace();
    for n in 0..64 {
        source(&db, &format!("note-{n}"), "公众号", &"排版内容".repeat(200));
    }
    stale(&db);
    db.start_search_index(|| {}).unwrap();
    db.begin_exit();
    db.close_for_restore(|| Ok(())).unwrap();
    std::fs::rename(&path, root.path().join("closed.db")).unwrap();
    db.cancel_exit();
    assert!(db.read(|_| Ok(())).is_err());
    assert!(
        !path.exists(),
        "cancelling after committed restore must not reopen the old path"
    );
}

#[test]
fn upgrading_an_old_workspace_defers_backfill_until_the_worker_starts() {
    let root=tempfile::tempdir().unwrap();
    let path=root.path().join("content.db");
    let conn=crate::db::legacy_database(&path,30).unwrap();
    conn.execute("INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
        VALUES('old','article','公众号','排版','draft',100,100)",[]).unwrap();
    drop(conn);
    let db = Workspace::open_existing(&path).unwrap();
    assert_eq!(page(&db, "公众号排版")["search"]["indexing"], true);
    assert_eq!(
        page(&db, "公众号排版")["items"].as_array().unwrap().len(),
        0
    );
    let (send, receive) = mpsc::channel();
    db.start_search_index(move || {
        let _ = send.send(());
    })
    .unwrap();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(db.search_index_error(), None);
    assert_eq!(
        page(&db, "公众号排版")["items"].as_array().unwrap().len(),
        1
    );
    db.read(|conn| {
        assert_eq!(
            crate::db::validate_backup_schema(conn)?,
            crate::db::SCHEMA_VERSION
        );
        let version: (i64, i64, i64) = conn.query_row(
            "SELECT version,created_at,updated_at FROM entries WHERE id='old'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(version, (1, 100, 100));
        Ok(())
    })
    .unwrap();
}
