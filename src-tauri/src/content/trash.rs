use super::{Kind, get_entry};
use crate::db::{AppError, Result, Workspace, now};
use rusqlite::{Connection, OptionalExtension, params};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const RETENTION: &str = "trash_retention_days";
const DAY: i64 = 86_400_000;

fn retention(conn: &Connection) -> Result<u32> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key=?1",
            [RETENTION],
            |row| row.get(0),
        )
        .optional()?;
    value.map_or(Ok(7), |value| {
        serde_json::from_str(&value)
            .map_err(|_| AppError::new("SETTINGS", "无法读取回收站保留时间"))
    })
}

impl Workspace {
    pub fn trash_retention(&self, days: Option<u32>) -> Result<u32> {
        if let Some(days) = days {
            if ![0, 1, 7, 14, 30, 90].contains(&days) {
                return Err(AppError::invalid("不支持的回收站保留时间"));
            }
            self.set_setting(RETENTION, &days)?;
            return Ok(days);
        }
        self.read_running(retention)
    }

    pub fn empty_trash(&self) -> Result<Vec<String>> {
        self.write(|tx| purge_before(tx, None, now()))
    }

    pub(crate) fn cleanup_expired_trash(&self, timestamp: i64) -> Result<Vec<String>> {
        self.write(|tx| {
            let days = retention(tx)?;
            if days == 0 {
                return Ok(vec![]);
            }
            purge_before(tx, Some(timestamp - i64::from(days) * DAY), timestamp)
        })
    }
}

fn purge_before(conn: &Connection, cutoff: Option<i64>, timestamp: i64) -> Result<Vec<String>> {
    let ids = conn
        .prepare(
            "SELECT id FROM entries WHERE deleted_at IS NOT NULL AND purged_at IS NULL
        AND (?1 IS NULL OR deleted_at<=?1) ORDER BY id",
        )?
        .query_map([cutoff], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        purge_entry(conn, id, timestamp)?;
    }
    Ok(ids)
}

pub(super) fn purge_entry(conn: &Connection, id: &str, timestamp: i64) -> Result<()> {
    // Keep only the deletion marker so canvas references and cloud synchronization cannot resurrect the body.
    let entry = get_entry(conn, id)?;
    let status = Kind::from_key(&entry.row.kind).statuses()[0];
    conn.execute("UPDATE entries SET title='',content_md='',summary='',category_id=NULL,source_id=NULL,
        cover_asset_id=NULL,theme_id=NULL,published_at=NULL,published_url='',custom_properties='[]',source_details=NULL,publication_platforms='[]',
        pinned_order=NULL,status=?2,purged_at=?3,deleted_at=COALESCE(deleted_at,?3),updated_at=?3,version=version+1
        WHERE id=?1", params![id, status, timestamp])?;
    for sql in [
        "DELETE FROM entry_revisions WHERE entry_id=?1",
        "DELETE FROM entry_assets WHERE entry_id=?1",
        "DELETE FROM entry_tags WHERE entry_id=?1",
        "DELETE FROM timeline_entry_pins WHERE entry_id=?1",
        "DELETE FROM entry_links WHERE article_id=?1",
        "DELETE FROM wechat_sources WHERE entry_id=?1",
        "DELETE FROM jobs WHERE entry_id=?1",
        "DELETE FROM ai_threads WHERE entry_id=?1",
    ] {
        conn.execute(sql, [id])?;
    }
    Ok(())
}

#[tauri::command]
pub fn trash_retention(db: State<'_, Workspace>, days: Option<u32>) -> Result<u32> {
    db.trash_retention(days)
}

#[tauri::command]
pub fn empty_trash(app: AppHandle, db: State<'_, Workspace>) -> Result<Vec<String>> {
    let ids = db.empty_trash()?;
    if !ids.is_empty() {
        let _ = app.emit("trash-emptied", &ids);
    }
    Ok(ids)
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(3600));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            match app.state::<Workspace>().cleanup_expired_trash(now()) {
                Ok(ids) if !ids.is_empty() => {
                    let _ = app.emit("trash-emptied", ids);
                }
                Err(error) if error.code() != "EXIT_PENDING" => {
                    eprintln!("Could not clean expired trash: {error}")
                }
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{EntryPatch, Filter};

    #[test]
    fn incoming_purge_scrubs_the_body_and_cannot_be_undone_by_an_old_snapshot() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let id = deleted(&db, 1);
        let mut snapshot = db
            .read(|conn| super::super::sync::snapshot(conn, &id))
            .unwrap()
            .unwrap();
        snapshot["purgedAt"] = serde_json::json!(2);
        db.write(|tx| super::super::sync::apply(tx, &id, &snapshot, Some(1)))
            .unwrap();
        assert!(db.get_entry(&id).unwrap().fields.content_md.is_empty());
        snapshot["purgedAt"] = serde_json::Value::Null;
        snapshot["contentMd"] = serde_json::json!("旧设备正文");
        db.write(|tx| super::super::sync::apply(tx, &id, &snapshot, None))
            .unwrap();
        let entry = db.get_entry(&id).unwrap();
        assert!(entry.fields.content_md.is_empty());
        assert!(entry.row.deleted_at.is_some() && entry.row.purged_at.is_some());
    }

    #[test]
    fn clearing_trash_keeps_shared_images_and_canvas_placeholders() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let id = deleted(&db, 1);
        let asset = crate::db::id();
        db.write(|tx| {
            tx.execute("INSERT INTO assets (id,kind,created_at,name) VALUES (?1,'original',1,'图片')",[&asset])?;
            tx.execute("INSERT INTO entry_assets VALUES (?1,?2)",params![id,asset])?;
            tx.execute("INSERT INTO collections (id,title,created_at,updated_at) VALUES ('canvas','画布',1,1)",[])?;
            tx.execute("INSERT INTO collection_nodes (id,collection_id,kind,entry_id,created_at,updated_at) VALUES ('card','canvas','entry',?1,1,1)",[&id])?;
            Ok(())
        }).unwrap();
        let live = db
            .create_external(
                Kind::Article,
                EntryPatch {
                    content_md: Some(format!("![共用](asset://{asset})")),
                    ..Default::default()
                },
            )
            .unwrap();
        db.empty_trash().unwrap();
        db.read(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM entry_assets WHERE entry_id=?1",
                    [&live.row.id],
                    |row| row.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_nodes WHERE entry_id=?1",
                    [&id],
                    |row| row.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM assets WHERE id=?1", [&asset], |row| {
                    row.get::<_, i64>(0)
                })?,
                1
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_failed_bulk_cleanup_rolls_back_all_documents() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let first = deleted(&db, 1);
        let second = deleted(&db, 2);
        let mut ids = [first, second];
        ids.sort();
        db.write(|tx| {
            tx.execute_batch(&format!("CREATE TRIGGER stop_purge BEFORE UPDATE OF purged_at ON entries WHEN NEW.id='{}' BEGIN SELECT RAISE(ABORT,'test failure'); END;",ids[1]))?;
            Ok(())
        }).unwrap();
        assert!(db.empty_trash().is_err());
        assert_eq!(
            db.entries(Filter {
                deleted: true,
                ..Filter::default()
            })
            .unwrap()
            .items
            .len(),
            2
        );
        assert_eq!(
            db.get_entry(&ids[0]).unwrap().fields.content_md,
            "永久删除正文"
        );
    }

    fn deleted(db: &Workspace, timestamp: i64) -> String {
        let entry = db
            .create_external(
                Kind::Article,
                EntryPatch {
                    title: Some("待清理文章".into()),
                    content_md: Some("永久删除正文".into()),
                    tags: Some(vec!["tag".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        let id = entry.row.id;
        db.set_deleted(&id, 1, true).unwrap();
        db.write(|tx| {
            tx.execute(
                "UPDATE entries SET deleted_at=?2 WHERE id=?1",
                params![id, timestamp],
            )?;
            Ok(())
        })
        .unwrap();
        id
    }

    #[test]
    fn retention_defaults_to_seven_days_and_is_persistent() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test.db");
        let db = Workspace::open(&path).unwrap();
        assert_eq!(db.trash_retention(None).unwrap(), 7);
        db.trash_retention(Some(30)).unwrap();
        drop(db);
        assert_eq!(
            Workspace::open(&path)
                .unwrap()
                .trash_retention(None)
                .unwrap(),
            30
        );
    }

    #[test]
    fn automatic_cleanup_uses_deletion_age_and_can_be_disabled() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let timestamp = 20 * DAY;
        let expired = deleted(&db, timestamp - 7 * DAY);
        let recent = deleted(&db, timestamp - 7 * DAY + 1);
        assert_eq!(db.cleanup_expired_trash(timestamp).unwrap(), [expired]);
        assert_eq!(
            db.entries(Filter {
                deleted: true,
                ..Filter::default()
            })
            .unwrap()
            .items[0]
                .id,
            recent
        );
        db.trash_retention(Some(0)).unwrap();
        assert!(
            db.cleanup_expired_trash(timestamp + 100 * DAY)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn clearing_trash_scrubs_content_and_history_without_removing_live_articles() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let id = deleted(&db, 1);
        let live = db
            .create_external(
                Kind::Article,
                EntryPatch {
                    title: Some("保留".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        db.write(|tx| {
            tx.execute(
                "INSERT INTO entry_revisions VALUES (?1,1,'旧正文','manual',1)",
                [&id],
            )?;
            tx.execute("UPDATE sync_progress SET capture=1 WHERE id=1", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(db.empty_trash().unwrap(), std::slice::from_ref(&id));
        assert!(db.empty_trash().unwrap().is_empty());
        assert!(
            db.entries(Filter {
                deleted: true,
                ..Filter::default()
            })
            .unwrap()
            .items
            .is_empty()
        );
        let entry = db.get_entry(&id).unwrap();
        assert!(entry.row.purged_at.is_some());
        assert!(entry.fields.content_md.is_empty() && entry.fields.tags.is_empty());
        assert!(db.revisions(&id).unwrap().is_empty());
        assert!(db.set_deleted(&id, entry.version, false).is_err());
        assert_eq!(db.get_entry(&live.row.id).unwrap().row.title, "保留");
        let snapshot = db
            .read(|conn| super::super::sync::snapshot(conn, &id))
            .unwrap()
            .unwrap();
        assert!(snapshot["purgedAt"].is_i64());
        assert_eq!(snapshot["contentMd"], "");
        assert!(db.read(|conn| Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_dirty WHERE entity_type='entry' AND entity_id=?1)",[&id],|row|row.get::<_,bool>(0))?)).unwrap());
    }
}
