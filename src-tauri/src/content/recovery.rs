use super::{Entry, Fields, Kind, SaveMode, insert_entry, save_in_transaction};
use crate::db::{AppError, Result, Workspace, now};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub session_id: String,
    pub local_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub entry_id: String,
    pub session_id: String,
    pub kind: Kind,
    pub base_version: i64,
    pub local_revision: i64,
    pub fields: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    entry_id: String,
    session_id: String,
    title: String,
    base_version: i64,
    local_revision: i64,
    updated_at: i64,
}

fn encoded_fields(fields: &Fields) -> Result<String> {
    let mut data =
        serde_json::to_value(fields).map_err(|_| AppError::invalid("无法保存恢复内容"))?;
    data["title"] = json!(fields.title);
    data["status"] = json!(fields.status);
    data["categoryId"] = json!(fields.category_id);
    Ok(data.to_string())
}

impl Workspace {
    pub fn put_editor_recovery(&self, draft: Draft) -> Result<()> {
        if uuid::Uuid::parse_str(&draft.session_id).is_err()
            || draft.local_revision < 1
            || draft.base_version < 1
        {
            return Err(AppError::invalid("恢复会话或修订号无效"));
        }
        let fields: Fields = serde_json::from_value(draft.fields)
            .map_err(|_| AppError::invalid("恢复内容格式无效"))?;
        let encoded = encoded_fields(&fields)?;
        self.save(|tx| {
            crate::assets::references::cancel_cleanup(tx,&fields.content_md)?;
            if let Some(cover)=&fields.cover_asset_id {
                tx.execute("DELETE FROM asset_cleanup_candidates WHERE sha256 IN (SELECT sha256 FROM assets WHERE id=?1)",[cover])?;
            }
            tx.execute("INSERT INTO editor_recovery(entry_id,session_id,entry_kind,base_version,local_revision,fields_json,updated_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7)
                ON CONFLICT(entry_id,session_id) DO UPDATE SET
                  base_version=MAX(editor_recovery.base_version,excluded.base_version),local_revision=excluded.local_revision,
                  fields_json=excluded.fields_json,updated_at=excluded.updated_at
                WHERE excluded.local_revision>editor_recovery.local_revision AND excluded.local_revision>editor_recovery.saved_revision",
                params![draft.entry_id,draft.session_id,draft.kind.key(),draft.base_version,draft.local_revision,encoded,now()])?;
            Ok(())
        })
    }

    pub fn editor_recoveries(&self) -> Result<Vec<Summary>> {
        self.read(|conn| {
            let mut query = conn.prepare("SELECT entry_id,session_id,fields_json->>'$.title',base_version,local_revision,updated_at
                FROM editor_recovery WHERE fields_json IS NOT NULL AND local_revision>saved_revision ORDER BY updated_at DESC,entry_id")?;
            Ok(query.query_map([], |row| Ok(Summary { entry_id:row.get(0)?,session_id:row.get(1)?,title:row.get(2)?,
                base_version:row.get(3)?,local_revision:row.get(4)?,updated_at:row.get(5)? }))?.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    pub fn editor_recovery_fields(&self, entry_id: &str, session_id: &str) -> Result<Value> {
        self.read(|conn| {
            let fields: String = conn.query_row("SELECT fields_json FROM editor_recovery WHERE entry_id=?1 AND session_id=?2 AND fields_json IS NOT NULL",
                params![entry_id,session_id], |row| row.get(0))?;
            serde_json::from_str(&fields).map_err(|_| AppError::new("RECOVERY_DATA", "无法读取恢复内容"))
        })
    }

    pub fn discard_editor_recovery(
        &self,
        entry_id: &str,
        session_id: &str,
        revision: i64,
    ) -> Result<()> {
        self.save(|tx| {
            tx.execute(
                "UPDATE editor_recovery SET saved_revision=MAX(saved_revision,?3),fields_json=NULL
                WHERE entry_id=?1 AND session_id=?2 AND local_revision<=?3",
                params![entry_id, session_id, revision],
            )?;
            Ok(())
        })
    }

    pub fn restore_editor_recovery(
        &self,
        entry_id: &str,
        session_id: &str,
        revision: i64,
        copy: bool,
    ) -> Result<Entry> {
        self.save(|tx| {
            let (kind, base_version, encoded): (String,i64,String) = tx.query_row(
                "SELECT entry_kind,base_version,fields_json FROM editor_recovery WHERE entry_id=?1 AND session_id=?2 AND local_revision=?3 AND fields_json IS NOT NULL",
                params![entry_id,session_id,revision], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            let mut fields: Fields = serde_json::from_str(&encoded).map_err(|_| AppError::new("RECOVERY_DATA", "无法读取恢复内容"))?;
            let commit = Commit { session_id:session_id.into(),local_revision:revision };
            if !copy {
                save_in_transaction(tx,entry_id,base_version,fields,SaveMode::Manual,Some(&commit))?;
                return super::get_entry(tx,entry_id);
            }
            if let Some(category) = &fields.category_id
                && !tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id=?1)", [category], |row| row.get::<_, bool>(0))? {
                fields.category_id = None;
            }
            if let Some(source) = &fields.source {
                let mut url = super::http_url(&source.url)?;
                url.set_fragment(None);
                if super::web_reference(tx, url.as_str())?.is_some() {
                    fields.source = None;
                }
            }
            let kind = Kind::from_key(&kind);
            fields.status = kind.statuses()[0].into();
            fields.published_at = None;
            fields.published_url.clear();
            let entry = insert_entry(tx,kind,fields,None)?;
            tx.execute("UPDATE editor_recovery SET saved_revision=local_revision,fields_json=NULL WHERE entry_id=?1 AND session_id=?2 AND local_revision=?3",
                params![entry_id,session_id,revision])?;
            Ok(entry)
        })
    }

    // Called once before the application's IPC and background writers are started.
    pub fn prune_completed_editor_recovery(&self) -> Result<()> {
        self.write(|tx| {
            let mut query = tx.prepare("SELECT entry_id,session_id,fields_json FROM editor_recovery WHERE fields_json IS NOT NULL AND EXISTS(SELECT 1 FROM entries e WHERE e.id=entry_id)")?;
            let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for (entry_id,session_id,fields) in rows {
                if encoded_fields(&super::get_entry(tx,&entry_id)?.fields)? == fields {
                    tx.execute("UPDATE editor_recovery SET fields_json=NULL WHERE entry_id=?1 AND session_id=?2",params![entry_id,session_id])?;
                }
            }
            tx.execute("DELETE FROM editor_recovery WHERE fields_json IS NULL", [])?;
            Ok(())
        })
    }
}

pub(super) fn acknowledge(
    conn: &Connection,
    entry_id: &str,
    version: i64,
    commit: &Commit,
) -> Result<()> {
    if uuid::Uuid::parse_str(&commit.session_id).is_err() || commit.local_revision < 1 {
        return Err(AppError::invalid("恢复会话或修订号无效"));
    }
    conn.execute("INSERT INTO editor_recovery(entry_id,session_id,entry_kind,base_version,local_revision,saved_revision,updated_at)
        VALUES(?1,?2,(SELECT kind FROM entries WHERE id=?1),?3,?4,?4,?5)
        ON CONFLICT(entry_id,session_id) DO UPDATE SET base_version=MAX(editor_recovery.base_version,excluded.base_version),
          saved_revision=MAX(editor_recovery.saved_revision,excluded.saved_revision),
          fields_json=CASE WHEN editor_recovery.local_revision<=excluded.saved_revision THEN NULL ELSE editor_recovery.fields_json END",
        params![entry_id,commit.session_id,version,commit.local_revision,now()])?;
    Ok(())
}

#[tauri::command]
pub async fn editor_recovery_put(state: State<'_, Workspace>, draft: Draft) -> Result<()> {
    state.put_editor_recovery(draft)
}
#[tauri::command]
pub async fn editor_recovery_list(state: State<'_, Workspace>) -> Result<Vec<Summary>> {
    state.editor_recoveries()
}
#[tauri::command]
pub async fn editor_recovery_get(
    state: State<'_, Workspace>,
    entry_id: String,
    session_id: String,
) -> Result<Value> {
    state.editor_recovery_fields(&entry_id, &session_id)
}
#[tauri::command]
pub async fn editor_recovery_discard(
    state: State<'_, Workspace>,
    entry_id: String,
    session_id: String,
    local_revision: i64,
) -> Result<()> {
    state.discard_editor_recovery(&entry_id, &session_id, local_revision)
}
#[tauri::command]
pub async fn editor_recovery_restore(
    state: State<'_, Workspace>,
    entry_id: String,
    session_id: String,
    local_revision: i64,
    copy: bool,
) -> Result<Entry> {
    state.restore_editor_recovery(&entry_id, &session_id, local_revision, copy)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fields(body: &str) -> Value {
        json!({"title":"Draft","contentMd":body,"status":"draft","categoryId":null,"tags":[],"summary":"", "source":null,"publishedAt":null,"publishedUrl":""})
    }
    fn draft(session: &str, revision: i64, body: &str) -> Draft {
        Draft {
            entry_id: "entry".into(),
            session_id: session.into(),
            kind: Kind::Article,
            base_version: 1,
            local_revision: revision,
            fields: fields(body),
        }
    }
    fn setup(db: &Workspace) {
        db.write(|tx| {
            tx.execute_batch("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at) VALUES('entry','article','Official','draft','saved body',1,1);
                INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'http://localhost/','i','e','d'); UPDATE sync_progress SET capture=1;")?;
            Ok(())
        }).unwrap();
    }
    #[test]
    fn out_of_order_drafts_and_old_save_never_remove_a_newer_recovery() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        setup(&db);
        let session = crate::db::id();
        db.put_editor_recovery(draft(&session, 3, "latest"))
            .unwrap();
        db.put_editor_recovery(draft(&session, 2, "older")).unwrap();
        let commit = Commit {
            session_id: session.clone(),
            local_revision: 1,
        };
        db.save_entry_with_recovery(
            "entry",
            1,
            serde_json::from_value(fields("save 1")).unwrap(),
            SaveMode::Auto,
            Some(&commit),
        )
        .unwrap();
        db.put_editor_recovery(draft(&session, 2, "late old"))
            .unwrap();
        assert_eq!(
            db.editor_recovery_fields("entry", &session).unwrap()["contentMd"],
            "latest"
        );
        assert_eq!(db.editor_recoveries().unwrap()[0].base_version, 2);
        let restored = db
            .restore_editor_recovery("entry", &session, 3, false)
            .unwrap();
        assert_eq!(restored.fields.content_md, "latest");
        assert!(db.editor_recoveries().unwrap().is_empty());
        db.put_editor_recovery(draft(&session, 3, "delayed already saved"))
            .unwrap();
        assert!(db.editor_recoveries().unwrap().is_empty());
    }
    #[test]
    fn save_before_draft_arrival_and_new_sessions_cannot_resurrect_or_replace_content() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        setup(&db);
        let old = crate::db::id();
        let new = crate::db::id();
        let commit = Commit {
            session_id: old.clone(),
            local_revision: 4,
        };
        db.save_entry_with_recovery(
            "entry",
            1,
            serde_json::from_value(fields("saved")).unwrap(),
            SaveMode::Auto,
            Some(&commit),
        )
        .unwrap();
        db.put_editor_recovery(draft(&old, 4, "late saved body"))
            .unwrap();
        assert!(db.editor_recoveries().unwrap().is_empty());
        db.put_editor_recovery(draft(&new, 1, "new session"))
            .unwrap();
        db.put_editor_recovery(draft(&old, 3, "late old session"))
            .unwrap();
        assert_eq!(db.editor_recoveries().unwrap().len(), 1);
        assert_eq!(
            db.editor_recovery_fields("entry", &new).unwrap()["contentMd"],
            "new session"
        );
        db.read(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM sync_dirty", [], |row| row
                    .get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM sync_dirty WHERE entity_type='editor_recovery'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn conflict_and_failed_database_transaction_keep_recovery_and_official_body() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        setup(&db);
        let session = crate::db::id();
        db.put_editor_recovery(draft(&session, 1, "unsaved"))
            .unwrap();
        db.save_entry(
            "entry",
            1,
            serde_json::from_value(fields("remote update")).unwrap(),
            SaveMode::External,
        )
        .unwrap();
        assert_eq!(
            db.restore_editor_recovery("entry", &session, 1, false)
                .err()
                .unwrap()
                .code(),
            "VERSION_CONFLICT"
        );
        db.write(|tx| { tx.execute_batch("CREATE TRIGGER fail_recovery BEFORE UPDATE ON editor_recovery BEGIN SELECT RAISE(ABORT,'test disk failure'); END;")?; Ok(()) }).unwrap();
        let commit = Commit {
            session_id: session.clone(),
            local_revision: 1,
        };
        assert_eq!(
            db.save_entry_with_recovery(
                "entry",
                2,
                serde_json::from_value(fields("failed write")).unwrap(),
                SaveMode::Auto,
                Some(&commit)
            )
            .err()
            .unwrap()
            .code(),
            "DATABASE"
        );
        assert_eq!(
            db.get_entry("entry").unwrap().fields.content_md,
            "remote update"
        );
        assert_eq!(
            db.editor_recovery_fields("entry", &session).unwrap()["contentMd"],
            "unsaved"
        );
        db.write(|tx| {
            tx.execute_batch("DROP TRIGGER fail_recovery")?;
            Ok(())
        })
        .unwrap();
        let copy = db
            .restore_editor_recovery("entry", &session, 1, true)
            .unwrap();
        assert_ne!(copy.row.id, "entry");
        assert_eq!(copy.fields.content_md, "unsaved");
        assert_eq!(
            db.get_entry("entry").unwrap().fields.content_md,
            "remote update"
        );
    }
    #[test]
    fn source_conflict_after_restart_can_be_saved_as_a_draft_without_changing_the_original() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspace.sqlite");
        let session = crate::db::id();
        let mut imported_fields = fields("imported body");
        imported_fields["source"] = json!({"url":"https://example.com/article", "author":"原作者", "accountName":"来源", "originalPublishedAt":123, "importedAt":456});
        {
            let db = Workspace::open(&path).unwrap();
            setup(&db);
            let imported = db
                .save_entry(
                    "entry",
                    1,
                    serde_json::from_value(imported_fields.clone()).unwrap(),
                    SaveMode::Manual,
                )
                .unwrap();
            let mut recovery = draft(&session, 1, "未保存的正文😀\n\n第二段");
            recovery.base_version = imported.version;
            recovery.fields["source"] = imported_fields["source"].clone();
            recovery.fields["source"]["url"] = json!("https://example.com/article#section");
            recovery.fields["summary"] = json!("恢复摘要");
            recovery.fields["tags"] = json!(["恢复标签"]);
            db.put_editor_recovery(recovery).unwrap();
            let mut remote = db.get_entry("entry").unwrap().fields;
            remote.content_md = "remote update".into();
            db.save_entry("entry", imported.version, remote, SaveMode::External)
                .unwrap();
        }
        let db = Workspace::open(&path).unwrap();
        assert_eq!(
            db.restore_editor_recovery("entry", &session, 1, false)
                .err()
                .unwrap()
                .code(),
            "VERSION_CONFLICT"
        );
        assert_eq!(
            db.editor_recovery_fields("entry", &session).unwrap()["contentMd"],
            "未保存的正文😀\n\n第二段"
        );
        let copy = db
            .restore_editor_recovery("entry", &session, 1, true)
            .unwrap();
        assert_ne!(copy.row.id, "entry");
        assert_eq!(copy.fields.content_md, "未保存的正文😀\n\n第二段");
        assert_eq!(copy.fields.title, "Draft");
        assert_eq!(copy.fields.summary, "恢复摘要");
        assert_eq!(copy.fields.tags, ["恢复标签"]);
        assert!(copy.fields.source.is_none());
        let original = db.get_entry("entry").unwrap();
        assert_eq!(original.fields.content_md, "remote update");
        assert_eq!(
            original.fields.source.unwrap().url,
            "https://example.com/article"
        );
        assert!(db.editor_recoveries().unwrap().is_empty());
        assert_eq!(
            db.create_entry(
                Kind::Article,
                Some(serde_json::from_value(imported_fields).unwrap()),
                None
            )
            .err()
            .unwrap()
            .code(),
            "INVALID_INPUT"
        );
    }

    #[test]
    fn saving_recovery_as_a_draft_keeps_an_unclaimed_source() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        setup(&db);
        let session = crate::db::id();
        let mut recovery = draft(&session, 1, "unsaved body");
        recovery.fields["source"] = json!({"url":"https://example.com/unclaimed#section", "author":"原作者", "accountName":"来源", "originalPublishedAt":123, "importedAt":456});
        db.put_editor_recovery(recovery).unwrap();
        let copy = db
            .restore_editor_recovery("entry", &session, 1, true)
            .unwrap();
        assert_eq!(copy.fields.content_md, "unsaved body");
        let source = copy.fields.source.unwrap();
        assert_eq!(source.url, "https://example.com/unclaimed");
        assert_eq!(source.author, "原作者");
        assert_eq!(source.imported_at, Some(456));
        assert_eq!(
            db.get_entry("entry").unwrap().fields.content_md,
            "saved body"
        );
        assert!(db.editor_recoveries().unwrap().is_empty());
    }

    #[test]
    fn startup_prunes_only_confirmed_or_identical_drafts_and_stale_discard_keeps_new_content() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        setup(&db);
        let identical = crate::db::id();
        let latest = crate::db::id();
        let current = db.get_entry("entry").unwrap();
        let canonical: Value =
            serde_json::from_str(&encoded_fields(&current.fields).unwrap()).unwrap();
        let mut same = draft(&identical, 1, "saved body");
        same.fields = canonical;
        db.put_editor_recovery(same).unwrap();
        db.put_editor_recovery(draft(&latest, 3, "latest")).unwrap();
        db.discard_editor_recovery("entry", &latest, 2).unwrap();
        db.prune_completed_editor_recovery().unwrap();
        assert_eq!(db.editor_recoveries().unwrap().len(), 1);
        assert_eq!(
            db.editor_recovery_fields("entry", &latest).unwrap()["contentMd"],
            "latest"
        );
    }
    #[test]
    fn reopen_preserves_deleted_document_recovery_and_allows_a_new_draft() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspace.sqlite");
        let session = crate::db::id();
        {
            let db = Workspace::open(&path).unwrap();
            setup(&db);
            db.put_editor_recovery(draft(&session, 2, "recover after restart"))
                .unwrap();
            db.write(|tx| {
                tx.execute("DELETE FROM entries WHERE id='entry'", [])?;
                Ok(())
            })
            .unwrap();
        }
        let db = Workspace::open(&path).unwrap();
        assert_eq!(db.editor_recoveries().unwrap().len(), 1);
        let entry = db
            .restore_editor_recovery("entry", &session, 2, true)
            .unwrap();
        assert_eq!(entry.fields.content_md, "recover after restart");
        assert!(db.editor_recoveries().unwrap().is_empty());
    }
}
