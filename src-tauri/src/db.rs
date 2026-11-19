use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_version: Option<i64>,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            current_version: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_INPUT", message)
    }

    pub fn conflict(version: i64) -> Self {
        Self {
            current_version: Some(version),
            ..Self::new("VERSION_CONFLICT", "内容已有新版本")
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::QueryReturnedNoRows => Self::new("NOT_FOUND", "找不到这条记录"),
            error => Self::new("DATABASE", format!("数据库操作失败：{error}")),
        }
    }
}

#[derive(PartialEq)]
enum Phase {
    Running,
    SavingForExit,
    Cleaning,
    Exiting,
}

pub struct Workspace(Mutex<Database>);
pub struct Database {
    conn: Option<Connection>,
    phase: Phase,
    running: tokio_util::sync::CancellationToken,
}

fn closed() -> AppError {
    AppError::new("EXIT_PENDING", "数据库已关闭，应用正在重启")
}

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_initial.sql"),
    include_str!("../migrations/0002_assets.sql"),
    include_str!("../migrations/0003_wechat.sql"),
    include_str!("../migrations/0004_ai.sql"),
    include_str!("../migrations/0005_category_icons.sql"),
    include_str!("../migrations/0006_folder_icon_set.sql"),
    include_str!("../migrations/0007_wechat_import_origin.sql"),
    include_str!("../migrations/0008_entry_folder_order.sql"),
    include_str!("../migrations/0009_default_folders.sql"),
    include_str!("../migrations/0010_asset_retention.sql"),
    include_str!("../migrations/0011_hosted_image_hash.sql"),
    include_str!("../migrations/0012_ai_chat.sql"),
    include_str!("../migrations/0013_ai_conversations.sql"),
    include_str!("../migrations/0014_ai_current_thread.sql"),
    include_str!("../migrations/0015_entry_pins.sql"),
    include_str!("../migrations/0016_collection_canvas.sql"),
    include_str!("../migrations/0017_collection_node_color.sql"),
    include_str!("../migrations/0018_collection_node_custom_color.sql"),
    include_str!("../migrations/0019_collection_node_web.sql"),
    include_str!("../migrations/0020_sync.sql"),
    include_str!("../migrations/0021_content_sync.sql"),
    include_str!("../migrations/0022_canvas_sync.sql"),
    include_str!("../migrations/0023_timeline_entry_pins.sql"),
    include_str!("../migrations/0024_external_articles.sql"),
];
pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

impl Workspace {
    pub fn open(path: &Path) -> Result<Self> {
        Self::initialize(Connection::open(path)?)
    }

    pub fn open_existing(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let version = conn.pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))?;
        if !(1..=SCHEMA_VERSION).contains(&version) {
            return Err(AppError::new(
                "BACKUP_SCHEMA",
                format!("不支持数据库版本 {version}"),
            ));
        }
        Self::initialize(conn)
    }

    fn initialize(mut conn: Connection) -> Result<Self> {
        conn.busy_timeout(Duration::from_secs(2))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;

        let version = conn.pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))?;
        if !(0..=SCHEMA_VERSION).contains(&version) {
            return Err(AppError::new(
                "DATABASE",
                format!("不支持数据库版本 {version}"),
            ));
        }
        migrate(&mut conn, version, SCHEMA_VERSION)?;
        check_integrity(&conn)?;
        Ok(Self(Mutex::new(Database {
            conn: Some(conn),
            phase: Phase::Running,
            running: tokio_util::sync::CancellationToken::new(),
        })))
    }

    fn lock(&self) -> MutexGuard<'_, Database> {
        self.0.lock().expect("workspace database lock poisoned")
    }

    pub fn read<T>(&self, operation: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        operation(self.lock().conn.as_ref().ok_or_else(closed)?)
    }

    pub fn read_running<T>(&self, operation: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let db = self.lock();
        if db.phase != Phase::Running {
            return Err(AppError::new("EXIT_PENDING", "正在保存并退出"));
        }
        operation(db.conn.as_ref().ok_or_else(closed)?)
    }

    pub fn setting<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        self.read(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key=?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|_| AppError::new("SETTINGS", "无法读取已保存的设置"))
            })
            .transpose()
        })
    }

    pub fn set_setting<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.set_setting_with(key, value, || Ok(()))
    }

    pub fn set_setting_with<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        apply: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let value =
            serde_json::to_string(value).map_err(|_| AppError::new("SETTINGS", "无法保存设置"))?;
        self.write(|tx| {
            tx.execute("INSERT INTO app_settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
            apply()
        })
    }

    pub fn write<T>(&self, operation: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        self.transaction(false, operation)
    }

    pub fn save<T>(&self, operation: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        self.transaction(true, operation)
    }

    pub(crate) fn maintenance<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut db = self.lock();
        let tx = db
            .conn
            .as_mut()
            .ok_or_else(closed)?
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = operation(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    fn transaction<T>(
        &self,
        editor_save: bool,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut db = self.lock();
        if db.phase != Phase::Running && !(editor_save && db.phase == Phase::SavingForExit) {
            return Err(AppError::new("EXIT_PENDING", "正在保存并退出"));
        }
        let tx = db
            .conn
            .as_mut()
            .ok_or_else(closed)?
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = operation(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn begin_exit(&self) {
        let mut db = self.lock();
        db.phase = Phase::SavingForExit;
        db.running.cancel();
    }
    pub fn cancel_exit(&self) {
        let mut db = self.lock();
        db.phase = Phase::Running;
        if db.running.is_cancelled() {
            db.running = tokio_util::sync::CancellationToken::new();
        }
    }
    pub(crate) fn running_lifetime(&self) -> tokio_util::sync::CancellationToken {
        self.lock().running.clone()
    }
    pub fn start_cleaning(&self) {
        self.lock().phase = Phase::Cleaning;
    }
    pub fn finish_exit(&self) {
        self.lock().phase = Phase::Exiting;
    }
    pub fn exit_committed(&self) -> bool {
        self.lock().phase == Phase::Exiting
    }

    pub fn close_for_restore(&self, mark: impl FnOnce() -> Result<()>) -> Result<()> {
        let mut db = self.lock();
        if db.phase != Phase::SavingForExit {
            return Err(AppError::new(
                "RESTORE_PHASE",
                "请先保存并停止工作区，再重启恢复",
            ));
        }
        let conn = db.conn.as_ref().ok_or_else(closed)?;
        checkpoint(conn)?;
        mark()?;
        let conn = db
            .conn
            .take()
            .expect("workspace connection was checkpointed");
        if let Err((conn, error)) = conn.close() {
            db.conn = Some(conn);
            return Err(error.into());
        }
        db.phase = Phase::Exiting;
        Ok(())
    }
}

fn migrate(conn: &mut Connection, from: i64, to: i64) -> Result<()> {
    for (version, sql) in (from + 1..=to).zip(&MIGRATIONS[from as usize..to as usize]) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(sql)?;
        if version == 1 {
            tx.execute(
                "INSERT INTO app_settings VALUES ('workspace_id',?1)",
                [id()],
            )?;
        }
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn validate_backup_schema(conn: &Connection) -> Result<i64> {
    let version = conn.pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))?;
    if !(1..=SCHEMA_VERSION).contains(&version) {
        return Err(AppError::new(
            "BACKUP_SCHEMA",
            format!("不支持数据库版本 {version}"),
        ));
    }
    fn definitions(conn: &Connection) -> Result<Vec<(String, String, String)>> {
        let mut query = conn.prepare(
            "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name",
        )?;
        Ok(query
            .query_map([], |row| {
                let sql: String = row.get(2)?;
                Ok((row.get(0)?, row.get(1)?, sql.replace("\r\n", "\n")))
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
    let mut reference = Connection::open_in_memory()?;
    reference.pragma_update(None, "foreign_keys", true)?;
    migrate(&mut reference, 0, version)?;
    if definitions(conn)? != definitions(&reference)? {
        return Err(AppError::new(
            "BACKUP_SCHEMA",
            "快照的表、索引或触发器与工作台的数据库结构不一致",
        ));
    }
    Ok(version)
}

pub fn checkpoint(conn: &Connection) -> Result<()> {
    let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    if busy != 0 {
        return Err(AppError::new(
            "BACKUP_BUSY",
            "无法收尾数据库 WAL，请稍后重试",
        ));
    }
    Ok(())
}

pub fn check_integrity(conn: &Connection) -> Result<()> {
    let report: String = conn.pragma_query_value(None, "integrity_check", |row| row.get(0))?;
    let broken_reference: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |row| row.get(0),
    )?;
    if report != "ok" || broken_reference {
        return Err(AppError::new(
            "INTEGRITY",
            if report == "ok" {
                "数据库中的关联记录不完整".to_string()
            } else {
                report
            },
        ));
    }
    Ok(())
}

pub fn id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before Unix epoch")
        .as_millis() as i64
}

pub fn workspace_id(conn: &Connection) -> Result<String> {
    Ok(conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params!["workspace_id"],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn canvas_migration_enrolls_existing_items_without_resetting_the_sync_cursor() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        super::migrate(&mut conn, 0, 21).unwrap();
        conn.execute_batch(
            "UPDATE sync_progress SET capture=1,initialized=1,cursor=41;
             INSERT INTO collections (id,title,created_at,updated_at) VALUES ('topic','专题',1,1);
             INSERT INTO collection_nodes (id,collection_id,kind,created_at,updated_at) VALUES
                ('card-a','topic','text',1,1),('card-b','topic','text',1,1);
             INSERT INTO collection_edges VALUES ('edge','topic','card-a','card-b','备注',1);",
        )
        .unwrap();
        super::migrate(&mut conn, 21, super::SCHEMA_VERSION).unwrap();
        let (cursor, pending): (i64, i64) = conn
            .query_row(
                "SELECT cursor,(SELECT count(*) FROM sync_dirty) FROM sync_progress",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((cursor, pending), (41, 4));
    }
    use super::*;

    #[test]
    fn adding_custom_card_colors_preserves_existing_presets() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, 0, 17).unwrap();
        conn.execute_batch(
            "INSERT INTO collections(id,title,created_at,updated_at) VALUES ('topic','专题',0,0);
             INSERT INTO collection_nodes(id,collection_id,kind,color,created_at,updated_at)
             VALUES ('card','topic','text','blue',0,0);",
        )
        .unwrap();
        migrate(&mut conn, 17, SCHEMA_VERSION).unwrap();
        let (preset, custom): (String, Option<String>) = conn
            .query_row(
                "SELECT color, custom_color FROM collection_nodes WHERE id='card'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(preset, "blue");
        assert_eq!(custom, None);
        assert_eq!(validate_backup_schema(&conn).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn adding_web_cards_preserves_canvas_nodes_edges_and_foreign_keys() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&mut conn, 0, 18).unwrap();
        conn.execute_batch(
            "INSERT INTO collections(id,title,created_at,updated_at) VALUES ('topic','专题',0,0);
             INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
                 VALUES ('doc','article','文章','','draft',0,0);
             INSERT INTO assets(id,kind,sha256,created_at) VALUES ('asset','original','hash',0);
             INSERT INTO collection_nodes(id,collection_id,kind,entry_id,asset_id,content_md,x,width,color,custom_color,created_at,updated_at)
                 VALUES ('article','topic','entry','doc',NULL,'',12,384,'blue',NULL,0,0),
                        ('screenshot','topic','image',NULL,'asset','',20,240,NULL,'#abcdef',0,0),
                        ('note','topic','text',NULL,NULL,'# 文本',30,320,NULL,NULL,0,0);
             INSERT INTO collection_edges(id,collection_id,source_node_id,target_node_id,label,created_at)
                 VALUES ('first','topic','article','screenshot','参考',0), ('second','topic','screenshot','note','笔记',0);",
        ).unwrap();
        migrate(&mut conn, 18, SCHEMA_VERSION).unwrap();
        let preserved: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM collection_nodes WHERE external_url IS NULL AND (
                 (id='article' AND entry_id='doc' AND x=12 AND width=384 AND color='blue') OR
                 (id='screenshot' AND asset_id='asset' AND custom_color='#abcdef') OR
                 (id='note' AND content_md='# 文本'))",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, 3);
        let edges: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM collection_edges WHERE label IN ('参考','笔记')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(edges, 2);
        conn.execute_batch("DELETE FROM collection_nodes WHERE id='screenshot';")
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM collection_edges", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(validate_backup_schema(&conn).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn adding_ai_chat_preserves_saved_job_details() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, 0, 11).unwrap();
        conn.execute_batch(
            "INSERT INTO jobs(id,kind,status,created_at,updated_at) VALUES ('previous','ai','completed',1,2);
             INSERT INTO ai_job_details VALUES ('previous','titles','local-model',3,4,7);",
        )
        .unwrap();
        migrate(&mut conn, 11, SCHEMA_VERSION).unwrap();
        let details: (String, String, i64, i64, i64) = conn.query_row(
            "SELECT operation, model, input_tokens, output_tokens, total_tokens FROM ai_job_details WHERE job_id='previous'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(details, ("titles".into(), "local-model".into(), 3, 4, 7));
    }

    #[test]
    fn migration_separates_existing_current_threads_from_history() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, 0, 13).unwrap();
        conn.execute_batch(
            "INSERT INTO entries(id,kind,title,content_md,status,created_at,updated_at)
             VALUES ('doc','article','标题','','draft',0,0);
             INSERT INTO ai_threads(id,entry_id,title,archived,created_at,updated_at) VALUES
             ('general-old',NULL,'旧会话',0,1,3),('general-current',NULL,'当前会话',0,2,3),
             ('general-history',NULL,'已归档',1,5,5),('doc-current','doc','文章会话',0,1,3);
             INSERT INTO ai_messages(id,thread_id,role,content_json,created_at) VALUES
             ('old-message','general-old','user','{}',2);",
        )
        .unwrap();
        migrate(&mut conn, 13, SCHEMA_VERSION).unwrap();
        let current = conn
            .prepare("SELECT id FROM ai_threads WHERE archived=0 ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(current, ["doc-current", "general-current"]);
        let old_message: String = conn
            .query_row(
                "SELECT id FROM ai_messages WHERE thread_id='general-old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_message, "old-message");
    }

    #[test]
    fn legacy_assets_keep_present_originals_when_origin_is_unknown() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, 0, 9).unwrap();
        conn.execute_batch(
            "INSERT INTO assets(id, kind, sha256, created_at) VALUES
             ('original', 'original', 'hash', 0), ('derived', 'derived', 'other', 0),
             ('pending', 'original', NULL, 0);",
        )
        .unwrap();
        migrate(&mut conn, 9, SCHEMA_VERSION).unwrap();
        let mut kept = conn
            .prepare("SELECT id FROM assets WHERE retain_on_exit = 1")
            .unwrap();
        let ids = kept
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(ids, ["original"]);
        assert_eq!(validate_backup_schema(&conn).unwrap(), SCHEMA_VERSION);
    }
}
