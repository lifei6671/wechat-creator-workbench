use crate::db::{AppError, Result, Workspace, id, now};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    id: String,
    title: String,
    archived: bool,
    updated_at: i64,
}

fn thread_row(row: &Row<'_>) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: row.get(0)?,
        title: row.get(1)?,
        archived: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn not_found() -> AppError {
    AppError::new("NOT_FOUND", "找不到该对话或修改提案")
}

#[tauri::command]
pub fn ai_threads_list(db: State<'_, Workspace>, entry_id: Option<String>) -> Result<Vec<Thread>> {
    list_threads(&db, entry_id.as_deref())
}

fn list_threads(db: &Workspace, entry_id: Option<&str>) -> Result<Vec<Thread>> {
    db.read(|conn| {
        let mut statement = conn.prepare(
            "SELECT id,title,archived,updated_at FROM ai_threads
             WHERE entry_id IS ?1 AND (archived=0 OR EXISTS(SELECT 1 FROM ai_messages WHERE thread_id=ai_threads.id))
             ORDER BY updated_at DESC,rowid DESC",
        )?;
        Ok(statement.query_map([entry_id], thread_row)?.collect::<rusqlite::Result<_>>()?)
    })
}

#[tauri::command]
pub fn ai_thread_get(
    db: State<'_, Workspace>,
    entry_id: Option<String>,
    thread_id: String,
) -> Result<Thread> {
    db.read(|conn| {
        conn.query_row(
            "SELECT id,title,archived,updated_at FROM ai_threads WHERE id=?1 AND entry_id IS ?2",
            params![thread_id, entry_id],
            thread_row,
        )
        .optional()?
        .ok_or_else(not_found)
    })
}

#[tauri::command]
pub fn ai_thread_create(db: State<'_, Workspace>, entry_id: Option<String>) -> Result<String> {
    create_thread(&db, entry_id.as_deref())
}

fn create_thread(db: &Workspace, entry_id: Option<&str>) -> Result<String> {
    let thread_id = id();
    db.write(|tx| {
        let inserted = tx.execute(
            "INSERT INTO ai_threads (id,entry_id,created_at,updated_at)
             SELECT ?1,?2,?3,?3 WHERE ?2 IS NULL OR EXISTS(SELECT 1 FROM entries WHERE id=?2 AND deleted_at IS NULL)",
            params![thread_id, entry_id, now()],
        )?;
        if inserted == 0 { return Err(not_found()); }
        archive_other_threads(tx, &thread_id)?;
        Ok(thread_id)
    })
}

#[tauri::command]
pub fn ai_thread_update(
    db: State<'_, Workspace>,
    thread_id: String,
    title: Option<String>,
    archived: Option<bool>,
) -> Result<()> {
    update_thread(&db, &thread_id, title.as_deref(), archived)
}

fn update_thread(
    db: &Workspace,
    thread_id: &str,
    title: Option<&str>,
    archived: Option<bool>,
) -> Result<()> {
    let title = title.map(str::trim);
    if title.is_some_and(|title| title.is_empty() || title.chars().count() > 100) {
        return Err(AppError::invalid("对话名称须为 1 至 100 个字符"));
    }
    db.write(|tx| {
        let changed = tx.execute(
            "UPDATE ai_threads SET title=COALESCE(?2,title),archived=COALESCE(?3,archived) WHERE id=?1",
            params![thread_id, title, archived],
        )?;
        if changed == 0 { return Err(not_found()); }
        if archived == Some(false) {
            archive_other_threads(tx, thread_id)?;
        }
        Ok(())
    })
}

fn archive_other_threads(tx: &Transaction<'_>, current: &str) -> Result<()> {
    tx.execute(
        "UPDATE ai_threads SET archived=1
         WHERE archived=0 AND id<>?1 AND entry_id IS (SELECT entry_id FROM ai_threads WHERE id=?1)",
        [current],
    )?;
    Ok(())
}

#[tauri::command]
pub fn ai_thread_delete(db: State<'_, Workspace>, thread_id: String) -> Result<()> {
    db.write(|tx| {
        tx.execute("DELETE FROM ai_threads WHERE id=?1", [thread_id])?;
        Ok(())
    })
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    parent_id: Option<String>,
    message: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Proposal {
    id: String,
    entry_id: String,
    base_version: i64,
    local_revision: u32,
    from: u32,
    to: u32,
    original_markdown: String,
    original_slice_hash: String,
    replacement_markdown: String,
    description: String,
}

#[tauri::command]
pub fn ai_messages_list(db: State<'_, Workspace>, thread_id: String) -> Result<Vec<HistoryItem>> {
    list_messages(&db, &thread_id)
}

fn list_messages(db: &Workspace, thread_id: &str) -> Result<Vec<HistoryItem>> {
    db.read(|conn| {
        let mut statement = conn.prepare(
            "SELECT m.parent_id,m.content_json,p.status FROM ai_messages m
             LEFT JOIN ai_edit_proposals p ON p.message_id=m.id
             WHERE m.thread_id=?1 ORDER BY m.seq",
        )?;
        let mut rows = statement.query([thread_id])?;
        let mut messages = Vec::new();
        while let Some(row) = rows.next()? {
            let json: String = row.get(1)?;
            let mut message: Value = serde_json::from_str(&json)
                .map_err(|_| AppError::new("AI_HISTORY", "无法读取已保存的对话消息"))?;
            if let Some(status) = row.get::<_, Option<String>>(2)? {
                message["metadata"]["custom"]["proposal"]["status"] = status.into();
            }
            messages.push(HistoryItem {
                parent_id: row.get(0)?,
                message,
            });
        }
        Ok(messages)
    })
}

#[tauri::command]
pub fn ai_message_save(
    db: State<'_, Workspace>,
    thread_id: String,
    item: HistoryItem,
) -> Result<()> {
    save_message(&db, &thread_id, item)
}

fn save_message(db: &Workspace, thread_id: &str, item: HistoryItem) -> Result<()> {
    let message = item.message;
    let invalid = || AppError::invalid("对话消息无效");
    let message_id = message["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(invalid)?;
    let role = message["role"]
        .as_str()
        .filter(|role| matches!(*role, "user" | "assistant"))
        .ok_or_else(invalid)?;
    if !message["content"].is_array() || !message["createdAt"].is_string() {
        return Err(invalid());
    }
    let json = message.to_string();
    let proposal: Option<Proposal> = message["metadata"]["custom"]
        .get("proposal")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|_| invalid())?;
    db.write(|tx| {
        let entry: Option<String> = tx.query_row("SELECT entry_id FROM ai_threads WHERE id=?1", [thread_id], |row| row.get(0))
            .optional()?.ok_or_else(not_found)?;
        if let Some(parent) = item.parent_id.as_deref() {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_messages WHERE id=?1 AND thread_id=?2)",
                params![parent, thread_id], |row| row.get(0),
            )?;
            if !exists || parent == message_id { return Err(invalid()); }
        }
        let stamp = now();
        let changed = tx.execute(
            "INSERT INTO ai_messages(id,thread_id,parent_id,role,content_json,created_at) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET content_json=excluded.content_json
             WHERE ai_messages.thread_id=excluded.thread_id AND ai_messages.role=excluded.role AND ai_messages.parent_id IS excluded.parent_id",
            params![message_id, thread_id, item.parent_id, role, json, stamp],
        )?;
        if changed == 0 { return Err(invalid()); }
        if let Some(p) = proposal {
            if role != "assistant" || entry.as_deref() != Some(p.entry_id.as_str()) {
                return Err(invalid());
            }
            tx.execute(
                "INSERT INTO ai_edit_proposals(id,thread_id,message_id,entry_id,base_version,local_revision,target_from,target_to,
                 original_markdown,original_slice_hash,replacement_markdown,description,status,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',?13,?13)
                 ON CONFLICT(message_id) DO NOTHING",
                params![p.id, thread_id, message_id, p.entry_id, p.base_version, p.local_revision, p.from, p.to,
                    p.original_markdown, p.original_slice_hash, p.replacement_markdown, p.description, stamp],
            )?;
        }
        tx.execute("UPDATE ai_threads SET updated_at=?2 WHERE id=?1", params![thread_id, stamp])?;
        Ok(())
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProposalStatus {
    Applied,
    Rejected,
    Conflicted,
}

#[tauri::command]
pub fn ai_proposal_status(
    db: State<'_, Workspace>,
    proposal_id: String,
    status: ProposalStatus,
) -> Result<()> {
    update_status(&db, &proposal_id, status)
}

fn update_status(db: &Workspace, proposal_id: &str, status: ProposalStatus) -> Result<()> {
    let status = match status {
        ProposalStatus::Applied => "applied",
        ProposalStatus::Rejected => "rejected",
        ProposalStatus::Conflicted => "conflicted",
    };
    let update = |tx: &rusqlite::Transaction<'_>| {
        let changed = tx.execute(
            "UPDATE ai_edit_proposals SET status=?2,updated_at=?3 WHERE id=?1 AND status IN ('pending',?2)",
            params![proposal_id, status, now()],
        )?;
        if changed == 0 {
            return Err(AppError::new("AI_PROPOSAL_STATE", "修改提案已处理或不存在"));
        }
        Ok(())
    };
    if status == "applied" {
        db.save(update)
    } else {
        db.write(update)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finishing_and_resuming_keep_one_current_thread_per_scope() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let db = Workspace::open(&path).unwrap();
        db.write(|tx| {
            tx.execute(
                "INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
                 VALUES ('doc','article','标题','','draft',0,0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let article = create_thread(&db, Some("doc")).unwrap();
        let general = create_thread(&db, None).unwrap();
        save_message(
            &db,
            &general,
            HistoryItem {
                parent_id: None,
                message: json!({
                    "id":"message", "role":"user", "content":[{"type":"text","text":"原问题"}],
                    "createdAt":"2026-11-16T08:00:00.000Z"
                }),
            },
        )
        .unwrap();
        drop(db);

        let db = Workspace::open(&path).unwrap();
        let previous_run = list_threads(&db, None).unwrap();
        assert_eq!(previous_run[0].id, general);
        assert!(!previous_run[0].archived);
        let empty = create_thread(&db, None).unwrap();
        assert_eq!(list_threads(&db, None).unwrap().len(), 2);
        update_thread(&db, &general, None, Some(false)).unwrap();
        let threads = list_threads(&db, None).unwrap();
        assert_eq!(
            threads.len(),
            1,
            "empty historical conversations stay hidden"
        );
        assert_eq!(threads[0].id, general);
        assert!(!threads[0].archived);
        assert_eq!(
            list_messages(&db, &general).unwrap()[0].message["id"],
            "message"
        );
        assert!(list_messages(&db, &empty).unwrap().is_empty());
        let threads = list_threads(&db, Some("doc")).unwrap();
        assert_eq!(threads[0].id, article);
        assert!(!threads[0].archived);
    }

    #[test]
    fn messages_and_proposal_survive_reopen_and_cannot_cross_threads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let db = Workspace::open(&path).unwrap();
        db.write(|tx| {
            tx.execute(
                "INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
                VALUES ('doc','article','标题','原文','draft',0,0)",
                [],
            )?;
            tx.execute(
                "INSERT INTO ai_threads(id,entry_id,created_at,updated_at)
                VALUES ('draft','doc',0,0),('general',NULL,0,0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let user = json!({
            "id":"u", "role":"user", "content":[{"type":"text","text":"请润色"}],
            "createdAt":"2026-11-16T08:00:00.000Z", "metadata":{"custom":{}},
        });
        save_message(
            &db,
            "draft",
            HistoryItem {
                parent_id: None,
                message: user.clone(),
            },
        )
        .unwrap();
        assert!(
            save_message(
                &db,
                "general",
                HistoryItem {
                    parent_id: None,
                    message: user
                }
            )
            .is_err()
        );
        let assistant = json!({
            "id":"a", "role":"assistant", "content":[], "status":{"type":"complete","reason":"stop"},
            "createdAt":"2026-11-16T08:00:00.000Z", "metadata":{"custom":{"proposal":{
                "id":"p","entryId":"doc","baseVersion":1,"localRevision":0,"from":1,"to":3,
                "originalMarkdown":"原文","originalSliceHash":"fixture","replacementMarkdown":"新版","description":"润色",
                "status":"pending",
            }}},
        });
        let item = || HistoryItem {
            parent_id: Some("u".into()),
            message: assistant.clone(),
        };
        assert!(save_message(&db, "general", item()).is_err());
        save_message(&db, "draft", item()).unwrap();
        db.begin_exit();
        assert!(update_status(&db, "p", ProposalStatus::Rejected).is_err());
        update_status(&db, "p", ProposalStatus::Applied).unwrap();
        db.cancel_exit();
        save_message(&db, "draft", item()).unwrap();
        assert!(update_status(&db, "p", ProposalStatus::Rejected).is_err());
        drop(db);

        let db = Workspace::open(&path).unwrap();
        let items = list_messages(&db, "draft").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].message["id"], "u");
        assert_eq!(items[1].parent_id.as_deref(), Some("u"));
        let proposal = &items[1].message["metadata"]["custom"]["proposal"];
        assert_eq!(proposal["status"], "applied");
        assert_eq!(proposal["replacementMarkdown"], "新版");
        assert!(list_messages(&db, "general").unwrap().is_empty());
        db.write(|tx| {
            let content: String =
                tx.query_row("SELECT content_md FROM entries WHERE id='doc'", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(content, "原文");
            tx.execute("DELETE FROM ai_threads WHERE id='draft'", [])?;
            let count: i64 = tx.query_row("SELECT count(*) FROM ai_edit_proposals", [], |row| {
                row.get(0)
            })?;
            assert_eq!(count, 0);
            Ok(())
        })
        .unwrap();
        assert!(list_messages(&db, "draft").unwrap().is_empty());
    }
}
