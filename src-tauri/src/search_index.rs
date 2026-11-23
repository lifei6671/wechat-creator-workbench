use jieba_rs::Jieba;
use rusqlite::{Connection, OpenFlags, Row, TransactionBehavior, functions::FunctionFlags};
use std::{
    ops::Range,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

static JIEBA: LazyLock<Jieba> = LazyLock::new(Jieba::new);
// Update together with the pinned jieba-rs version, dictionary, or tokenization rules.
// A different signature keeps old tokens out of queries until the background rebuild switches.
const SIGNATURE: &str = "jieba-rs:0.11.0;cut:hmm;lines:v1;unicode-lower;ascii:v1";
const BATCH_SIZE: i64 = 32;
const TABLES: [&str; 2] = ["entries_words_fts", "entries_words_alt_fts"];

pub(crate) struct Token {
    pub word: String,
    pub range: Range<usize>,
}

// Keep the source boundaries identical for indexing and editor highlights.
pub(crate) fn tokens(text: &str) -> Vec<Token> {
    let mut result = Vec::new();
    let mut line_start = 0;
    for line in text.split_inclusive('\n') {
        for token in JIEBA.cut(line, true) {
            let mut part_start = 0;
            for (end, ch) in token
                .word
                .char_indices()
                .chain(std::iter::once((token.word.len(), ' ')))
            {
                if ch.is_whitespace() || (ch.is_ascii() && !ch.is_ascii_alphanumeric()) {
                    let part = &token.word[part_start..end];
                    if part.chars().any(char::is_alphanumeric) {
                        let start = line_start + token.byte_start + part_start;
                        result.push(Token {
                            word: part.to_lowercase(),
                            range: start..start + part.len(),
                        });
                    }
                    part_start = end + ch.len_utf8();
                }
            }
        }
        line_start += line.len();
    }
    result
}

pub(crate) fn words(text: &str) -> Vec<String> {
    let mut words: Vec<_> = tokens(text).into_iter().map(|token| token.word).collect();
    words.sort_unstable();
    words.dedup();
    words
}

pub(crate) fn match_query(words: &[String], operator: &str) -> String {
    words
        .iter()
        .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(operator)
}

pub(crate) fn register(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "workspace_search_tokens",
        1,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        |args| {
            let text = args.get::<String>(0)?;
            Ok(index_text(&text))
        },
    )
}

pub(crate) struct State {
    pub table: Option<&'static str>,
    pub generation: i64,
}

pub(crate) fn state(conn: &Connection) -> rusqlite::Result<State> {
    conn.query_row(
        "SELECT active_slot,signature,generation FROM search_index_state WHERE id=1",
        [],
        |row| {
            let slot: bool = row.get(0)?;
            let signature: String = row.get(1)?;
            Ok(State {
                table: (signature == SIGNATURE).then_some(TABLES[usize::from(slot)]),
                generation: row.get(2)?,
            })
        },
    )
}

pub(crate) fn prepare_empty(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE search_index_state SET signature=?1 WHERE id=1 AND building=0 AND signature<>?1
        AND NOT EXISTS(SELECT 1 FROM entries WHERE purged_at IS NULL)",
        [SIGNATURE],
    )?;
    Ok(())
}

fn index_text(text: &str) -> String {
    tokens(text)
        .into_iter()
        .map(|token| token.word)
        .collect::<Vec<_>>()
        .join(" ")
}

struct Source {
    rowid: i64,
    revision: i64,
    content: Option<(String, String)>,
}

struct Indexed {
    rowid: i64,
    revision: i64,
    words: Option<(String, String)>,
}

impl Source {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            rowid: row.get(0)?,
            revision: row.get(1)?,
            content: if row.get::<_, bool>(2)? {
                Some((row.get(3)?, row.get(4)?))
            } else {
                None
            },
        })
    }

    fn segment(self) -> Indexed {
        Indexed {
            rowid: self.rowid,
            revision: self.revision,
            words: self
                .content
                .map(|(title, body)| (index_text(&title), index_text(&body))),
        }
    }
}

struct Build {
    slot: bool,
    upper: i64,
    cursor: Option<i64>,
}

impl Build {
    fn begin(conn: &mut Connection) -> rusqlite::Result<Self> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = tx.query_row(
            "SELECT active_slot FROM search_index_state WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let slot = !active;
        let table = TABLES[usize::from(slot)];
        tx.execute_batch(&format!(
            "DROP TABLE {table};
            CREATE VIRTUAL TABLE {table} USING fts5(title_words, body_words, tokenize='ascii');
            DELETE FROM search_index_dirty;
            UPDATE search_index_state SET building=1 WHERE id=1;"
        ))?;
        let upper = tx.query_row("SELECT COALESCE(MAX(rowid),0) FROM entries", [], |r| {
            r.get(0)
        })?;
        tx.commit()?;
        Ok(Self {
            slot,
            upper,
            cursor: None,
        })
    }

    fn base(&self, conn: &Connection) -> rusqlite::Result<Vec<Source>> {
        let lower = if self.cursor.is_some() {
            " AND rowid>?2"
        } else {
            " AND ?2 IS NULL"
        };
        let mut statement = conn.prepare(&format!(
            "SELECT rowid,0,1,title,content_md FROM entries
            WHERE purged_at IS NULL AND rowid<=?1{lower} ORDER BY rowid LIMIT {BATCH_SIZE}"
        ))?;
        statement
            .query_map(rusqlite::params![self.upper, self.cursor], Source::read)?
            .collect()
    }

    fn dirty(&self, conn: &Connection) -> rusqlite::Result<Vec<Source>> {
        let mut statement = conn.prepare(&format!(
            "SELECT d.entry_rowid,d.revision,
            e.rowid IS NOT NULL AND e.purged_at IS NULL,e.title,e.content_md
            FROM search_index_dirty d LEFT JOIN entries e ON e.rowid=d.entry_rowid
            ORDER BY d.entry_rowid LIMIT {BATCH_SIZE}"
        ))?;
        statement.query_map([], Source::read)?.collect()
    }

    fn write(
        &self,
        conn: &mut Connection,
        rows: Vec<Indexed>,
        acknowledge: bool,
    ) -> rusqlite::Result<()> {
        let table = TABLES[usize::from(self.slot)];
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        {
            let mut delete = tx.prepare(&format!("DELETE FROM {table} WHERE rowid=?1"))?;
            let mut insert = tx.prepare(&format!(
                "INSERT INTO {table}(rowid,title_words,body_words) VALUES(?1,?2,?3)"
            ))?;
            for row in rows {
                delete.execute([row.rowid])?;
                if let Some((title, body)) = row.words {
                    insert.execute(rusqlite::params![row.rowid, title, body])?;
                }
                if acknowledge {
                    tx.execute(
                        "DELETE FROM search_index_dirty WHERE entry_rowid=?1 AND revision=?2",
                        rusqlite::params![row.rowid, row.revision],
                    )?;
                }
            }
        }
        tx.commit()
    }

    fn switch(&self, conn: &mut Connection) -> rusqlite::Result<bool> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let pending: bool =
            tx.query_row("SELECT EXISTS(SELECT 1 FROM search_index_dirty)", [], |r| {
                r.get(0)
            })?;
        if pending {
            return Ok(false);
        }
        tx.execute("UPDATE search_index_state SET active_slot=?1,signature=?2,generation=generation+1,building=0 WHERE id=1",
            rusqlite::params![self.slot,SIGNATURE])?;
        tx.commit()?;
        Ok(true)
    }
}

fn rebuild(conn: &mut Connection, cancel: &CancellationToken) -> rusqlite::Result<bool> {
    if state(conn)?.table.is_some() {
        return Ok(false);
    }
    if cancel.is_cancelled() {
        return Ok(false);
    }
    let mut build = Build::begin(conn)?;
    loop {
        if cancel.is_cancelled() {
            return Ok(false);
        }
        let source = build.base(conn)?;
        if source.is_empty() {
            break;
        }
        let last = source.last().expect("nonempty source batch").rowid;
        let mut indexed = Vec::with_capacity(source.len());
        for row in source {
            if cancel.is_cancelled() {
                return Ok(false);
            }
            indexed.push(row.segment());
        }
        if cancel.is_cancelled() {
            return Ok(false);
        }
        build.write(conn, indexed, false)?;
        build.cursor = Some(last);
        thread::yield_now();
    }
    loop {
        if cancel.is_cancelled() {
            return Ok(false);
        }
        let source = build.dirty(conn)?;
        if source.is_empty() {
            if build.switch(conn)? {
                return Ok(true);
            }
            continue;
        }
        let mut indexed = Vec::with_capacity(source.len());
        for row in source {
            if cancel.is_cancelled() {
                return Ok(false);
            }
            indexed.push(row.segment());
        }
        if cancel.is_cancelled() {
            return Ok(false);
        }
        build.write(conn, indexed, true)?;
        thread::yield_now();
    }
}

pub(crate) struct Worker {
    path: PathBuf,
    notify: Arc<dyn Fn() + Send + Sync>,
    cancel: CancellationToken,
    handle: Option<JoinHandle<()>>,
    error: Arc<Mutex<Option<String>>>,
}

impl Worker {
    pub(crate) fn start(path: PathBuf, notify: impl Fn() + Send + Sync + 'static) -> Self {
        let mut worker = Self {
            path,
            notify: Arc::new(notify),
            cancel: CancellationToken::new(),
            handle: None,
            error: Arc::new(Mutex::new(None)),
        };
        worker.resume();
        worker
    }

    pub(crate) fn resume(&mut self) {
        if self.handle.is_some() {
            return;
        }
        self.cancel = CancellationToken::new();
        *self
            .error
            .lock()
            .expect("search worker error lock poisoned") = None;
        let (path, cancel, error, notify) = (
            self.path.clone(),
            self.cancel.clone(),
            self.error.clone(),
            self.notify.clone(),
        );
        let thread = thread::Builder::new()
            .name("word-index".into())
            .spawn(move || {
                let result = (|| {
                    let mut conn =
                        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
                    conn.busy_timeout(Duration::from_secs(2))?;
                    register(&conn)?;
                    rebuild(&mut conn, &cancel)
                })();
                match result {
                    Ok(true) => notify(),
                    Ok(false) => {}
                    Err(cause) => {
                        let message = format!("搜索索引重建失败，重启应用后重试：{cause}");
                        eprintln!("{message}");
                        *error.lock().expect("search worker error lock poisoned") = Some(message);
                        notify();
                    }
                }
            });
        match thread {
            Ok(handle) => self.handle = Some(handle),
            Err(cause) => {
                *self
                    .error
                    .lock()
                    .expect("search worker error lock poisoned") =
                    Some(format!("无法启动搜索索引重建：{cause}"));
                (self.notify)();
            }
        }
    }

    pub(crate) fn error(&self) -> Option<String> {
        self.error
            .lock()
            .expect("search worker error lock poisoned")
            .clone()
    }

    pub(crate) fn stop(&mut self) {
        self.cancel.cancel();
        if let Some(handle) = self.handle.take()
            && handle.join().is_err()
        {
            *self
                .error
                .lock()
                .expect("search worker error lock poisoned") =
                Some("搜索索引重建线程异常退出".into());
            (self.notify)();
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn rebuild_for_test(conn: &mut Connection) -> rusqlite::Result<()> {
    rebuild(conn, &CancellationToken::new()).map(|_| ())
}
