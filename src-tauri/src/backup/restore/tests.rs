use super::*;

fn populate(path: &Path, title: &str) -> (Workspace, String) {
    let db = Workspace::open(path).unwrap();
    db.write(|tx| {
        tx.execute(
            "INSERT INTO entries (id,kind,title,content_md,status,created_at,updated_at)
            VALUES ('entry','article',?1,'正文','draft',0,0)",
            [title],
        )?;
        Ok(())
    })
    .unwrap();
    let workspace = db.read(workspace_id).unwrap();
    (db, workspace)
}

fn title(db: &Workspace) -> String {
    db.read(|conn| {
        Ok(
            conn.query_row("SELECT title FROM entries WHERE id='entry'", [], |row| {
                row.get(0)
            })?,
        )
    })
    .unwrap()
}

#[test]
fn online_backup_includes_uncheckpointed_wal_and_produces_a_standalone_database() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("content.db");
    let (_live, workspace) = populate(&path, "WAL 中的内容");
    assert!(
        fs::metadata(root.path().join("content.db-wal"))
            .unwrap()
            .len()
            > 0
    );
    let snapshot = NamedTempFile::new_in(root.path()).unwrap().into_temp_path();
    make_snapshot(&path, &snapshot, &workspace).unwrap();
    let conn = Connection::open_with_flags(&snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    let recovered: String = conn
        .query_row("SELECT title FROM entries WHERE id='entry'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(mode, "delete");
    assert_eq!(recovered, "WAL 中的内容");
}

#[test]
fn stage_migrates_old_schema_and_pauses_restored_jobs() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("legacy.sqlite");
    let conn = Connection::open(&path).unwrap();
    let migration = include_str!("../../../migrations/0001_initial.sql")
        .replace("\r\n", "\n")
        .replace('\n', "\r\n");
    conn.execute_batch(&migration).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    let workspace = crate::db::id();
    conn.execute(
        "INSERT INTO app_settings VALUES ('workspace_id',?1)",
        [&workspace],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO categories(id,parent_id,name,depth,sort_order) VALUES
        ('root',NULL,'选题',1,0), ('child','root','访谈',2,0);
        INSERT INTO entries(id,kind,title,content_md,status,category_id,created_at,updated_at)
        VALUES ('article','article','分类文章','正文','draft','child',0,0);
        INSERT INTO jobs(id,kind,status,created_at,updated_at) VALUES
        ('image','import_image','queued',0,0), ('s3','upload','running',0,0),
        ('llm','ai','running',0,0), ('cleanup','cleanup','failed',0,0)",
    )
    .unwrap();
    drop(conn);
    let pending = PendingRestore {
        workspace,
        name: "legacy.sqlite".into(),
    };
    prepare_file(&path, &pending).unwrap();
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(workspace_id(&conn).unwrap(), pending.workspace);
    assert_eq!(
        conn.pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    let (category, parent, icon): (String, String, String) = conn
        .query_row(
            "SELECT c.id,c.parent_id,c.icon FROM categories c JOIN entries e ON e.category_id=c.id
         WHERE e.id='article'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (category.as_str(), parent.as_str(), icon.as_str()),
        ("child", "root", "folder")
    );
    let mut stmt = conn
        .prepare("SELECT id,status FROM jobs ORDER BY id")
        .unwrap();
    let statuses = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        statuses,
        [
            ("image".into(), "failed".into()),
            ("llm".into(), "cancelled".into()),
            ("s3".into(), "failed".into())
        ]
    );
}

#[test]
fn staging_rejects_unknown_schema_wrong_workspace_and_unscoped_assets() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("legacy.sqlite");
    let (db, workspace) = populate(&path, "候选");
    let mut pending = PendingRestore {
        workspace: crate::db::id(),
        name: "fixture.sqlite".into(),
    };
    assert_eq!(
        prepare_file(&path, &pending).unwrap_err().code(),
        "BACKUP_WORKSPACE"
    );
    pending.workspace = workspace;
    db.write(|tx| {
        tx.pragma_update(None, "user_version", SCHEMA_VERSION + 1)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        prepare_file(&path, &pending).unwrap_err().code(),
        "BACKUP_SCHEMA"
    );
    db.write(|tx| {
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.execute("INSERT INTO assets(id,kind,created_at,sha256,relative_path) VALUES ('asset','original',0,?1,'../content.db')", ["a".repeat(64)])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        validate_file(&path, &pending.workspace).unwrap_err().code(),
        "BACKUP_ASSET_PATH"
    );
    db.write(|tx| {
        tx.execute("UPDATE assets SET relative_path=NULL", [])?;
        tx.execute("INSERT INTO storage_profiles VALUES('image','images','https://example.test','auto','bucket','','https://example.test','local')", [])?;
        tx.execute("INSERT INTO asset_locations (sha256, storage_profile_id, object_key) VALUES (?1,'image',?2)",
            rusqlite::params!["a".repeat(64),format!("other/{}.png","a".repeat(64))])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        validate_file(&path, &pending.workspace).unwrap_err().code(),
        "BACKUP_ASSET_PATH"
    );
}

fn fixture() -> (tempfile::TempDir, Files, Workspace, String, PendingRestore) {
    let root = tempfile::tempdir().unwrap();
    let files = Files::new(root.path()).unwrap();
    let (db, original) = populate(&files.database, "本地稿件");
    let (incoming, workspace) = populate(&files.incoming, "备份稿件");
    drop(incoming);
    let pending = PendingRestore {
        workspace,
        name: "fixture.sqlite".into(),
    };
    prepare_file(&files.incoming, &pending).unwrap();
    (root, files, db, original, pending)
}

#[test]
fn restore_resumes_before_move_between_moves_and_after_promotion() {
    for phase in 0..3 {
        let (_root, files, db, _, pending) = fixture();
        assert_eq!(
            db.close_for_restore(|| files.write_marker(&pending))
                .unwrap_err()
                .code(),
            "RESTORE_PHASE"
        );
        assert!(!files.marker.exists());
        db.begin_exit();
        db.close_for_restore(|| files.write_marker(&pending))
            .unwrap();
        assert!(db.exit_committed());
        assert_eq!(db.read(workspace_id).unwrap_err().code(), "EXIT_PENDING");
        assert!(!files.database.with_file_name("content.db-wal").exists());
        if phase > 0 {
            fs::rename(&files.database, &files.previous).unwrap();
        }
        if phase > 1 {
            fs::rename(&files.incoming, &files.database).unwrap();
        }
        let (restored, notice) = files.open().unwrap();
        assert!(!notice.unwrap().failed);
        assert_eq!(restored.read(workspace_id).unwrap(), pending.workspace);
        assert_eq!(title(&restored), "备份稿件");
        assert!(!files.marker.exists());
        assert!(!files.previous.exists());
        assert!(!files.incoming.exists());
    }
}

#[test]
fn invalid_promoted_database_rolls_back_to_the_original() {
    let (_root, files, db, original, pending) = fixture();
    db.begin_exit();
    db.close_for_restore(|| files.write_marker(&pending))
        .unwrap();
    fs::rename(&files.database, &files.previous).unwrap();
    fs::rename(&files.incoming, &files.database).unwrap();
    fs::write(&files.database, b"corrupt candidate").unwrap();
    fs::write(
        files.database.with_file_name("content.db-wal"),
        b"invalid candidate WAL",
    )
    .unwrap();
    fs::write(
        files.database.with_file_name("content.db-shm"),
        b"invalid candidate SHM",
    )
    .unwrap();
    let (preserved, notice) = files.open().unwrap();
    assert!(notice.unwrap().failed);
    assert_eq!(preserved.read(workspace_id).unwrap(), original);
    assert_eq!(title(&preserved), "本地稿件");
    assert!(!files.marker.exists());
    assert!(!files.previous.exists());
}

#[test]
fn staging_rejects_missing_columns_and_broken_references_at_the_declared_version() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("candidate.sqlite");
    let (db, workspace) = populate(&path, "草稿");
    drop(db);
    let pending = PendingRestore {
        workspace,
        name: "fixture.sqlite".into(),
    };
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    conn.execute("UPDATE entries SET category_id='missing'", [])
        .unwrap();
    assert_eq!(
        prepare_file(&path, &pending).unwrap_err().code(),
        "INTEGRITY"
    );
    conn.execute("UPDATE entries SET category_id=NULL", [])
        .unwrap();
    conn.execute("ALTER TABLE entries DROP COLUMN summary", [])
        .unwrap();
    assert_eq!(
        prepare_file(&path, &pending).unwrap_err().code(),
        "BACKUP_SCHEMA"
    );
}
