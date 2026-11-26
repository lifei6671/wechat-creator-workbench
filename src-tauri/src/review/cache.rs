use super::{ReviewContext, ReviewResult, ReviewScope, Summary};
use crate::db::{AppError, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{path::Path, time::Duration};

const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    month: String,
    known_tokens: i64,
    unknown_calls: i64,
    successful_calls: i64,
    cache_hits: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    id: String,
    title: String,
    scope: ReviewScope,
    checked_at: i64,
    summary: Summary,
}

pub(super) fn open(directory: &Path) -> Result<Connection> {
    std::fs::create_dir_all(directory).map_err(|_| storage_error())?;
    let mut conn =
        Connection::open(directory.join("review-cache.sqlite3")).map_err(|_| storage_error())?;
    conn.busy_timeout(Duration::from_secs(2))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS review_cache (
            cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, checked_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS review_usage (
            month TEXT PRIMARY KEY, known_tokens INTEGER NOT NULL DEFAULT 0,
            unknown_calls INTEGER NOT NULL DEFAULT 0, successful_calls INTEGER NOT NULL DEFAULT 0,
            cache_hits INTEGER NOT NULL DEFAULT 0);",
    )?;
    let version = tx.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    if version == 1 {
        tx.execute_batch(
            "ALTER TABLE review_cache DROP COLUMN title;
            ALTER TABLE review_cache DROP COLUMN scope;",
        )?;
    }
    if version < 2 {
        tx.execute_batch(
            "CREATE TABLE review_cache_articles (
                entry_id TEXT NOT NULL,
                cache_key TEXT NOT NULL REFERENCES review_cache(cache_key) ON DELETE CASCADE,
                title TEXT NOT NULL, scope TEXT NOT NULL,
                PRIMARY KEY(entry_id,cache_key));
            CREATE INDEX review_cache_articles_key ON review_cache_articles(cache_key);
            PRAGMA user_version=2;",
        )?;
    }
    tx.commit()?;
    Ok(conn)
}

pub(super) fn storage_error() -> AppError {
    AppError::new(
        "REVIEW_STORAGE",
        "无法保存本机审查记录；本次有效检测结果仍可查看，请勿仅因缓存失败重复请求",
    )
}

fn prune(conn: &Connection, now: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM review_cache WHERE checked_at < ?1",
        [now - RETENTION_MS],
    )?;
    conn.execute("DELETE FROM review_usage WHERE month < strftime('%Y-%m',?1/1000.0,'unixepoch','-11 months')", [now])?;
    Ok(())
}

pub(super) fn lookup(
    conn: &mut Connection,
    key: &str,
    now: i64,
    context: Option<&ReviewContext>,
) -> Result<Option<ReviewResult>> {
    let tx = conn.transaction()?;
    prune(&tx, now)?;
    let json: Option<String> = tx
        .query_row(
            "SELECT result_json FROM review_cache WHERE cache_key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    let result = json
        .map(|json| serde_json::from_str::<ReviewResult>(&json).map_err(|_| storage_error()))
        .transpose()?;
    if result.is_some() {
        set_context(&tx, key, context)?;
        tx.execute("INSERT INTO review_usage(month,cache_hits) VALUES(strftime('%Y-%m',?1/1000.0,'unixepoch'),1)
            ON CONFLICT(month) DO UPDATE SET cache_hits=cache_hits+1", [now])?;
    }
    tx.commit()?;
    Ok(result.map(|mut result| {
        result.cache_hit = true;
        result.charged_tokens = Some(0);
        result.cached = true;
        result
    }))
}

pub(super) fn save(
    conn: &mut Connection,
    key: Option<&str>,
    result: &ReviewResult,
    context: Option<&ReviewContext>,
) -> Result<()> {
    let tx = conn.transaction()?;
    prune(&tx, result.checked_at)?;
    if let Some(key) = key {
        let json = serde_json::to_string(result).map_err(|_| storage_error())?;
        tx.execute(
            "INSERT INTO review_cache(cache_key,result_json,checked_at) VALUES(?1,?2,?3) ON CONFLICT(cache_key) DO UPDATE
            SET result_json=excluded.result_json,checked_at=excluded.checked_at",
            params![key, json, result.checked_at],
        )?;
        set_context(&tx, key, context)?;
    }
    tx.execute("INSERT INTO review_usage(month,known_tokens,unknown_calls,successful_calls)
        VALUES(strftime('%Y-%m',?1/1000.0,'unixepoch'),?2,?3,1) ON CONFLICT(month) DO UPDATE SET
        known_tokens=known_tokens+excluded.known_tokens,unknown_calls=unknown_calls+excluded.unknown_calls,
        successful_calls=successful_calls+1", params![result.checked_at,result.charged_tokens.unwrap_or(0) as i64,i64::from(result.charged_tokens.is_none())])?;
    tx.commit()?;
    Ok(())
}

fn set_context(conn: &Connection, key: &str, context: Option<&ReviewContext>) -> Result<()> {
    if let Some(context) = context {
        let scope = match context.scope {
            ReviewScope::Document => "document",
            ReviewScope::Selection => "selection",
        };
        conn.execute(
            "INSERT INTO review_cache_articles(entry_id,cache_key,title,scope) VALUES(?1,?2,?3,?4)
            ON CONFLICT(entry_id,cache_key) DO UPDATE SET title=excluded.title,scope=excluded.scope",
            params![context.entry_id, key, context.title, scope],
        )?;
    }
    Ok(())
}

pub(super) fn list(conn: &Connection, entry_id: &str, now: i64) -> Result<Vec<CacheEntry>> {
    prune(conn, now)?;
    let mut statement = conn.prepare(
        "SELECT c.cache_key,a.title,a.scope,c.checked_at,c.result_json
        FROM review_cache_articles a JOIN review_cache c ON c.cache_key=a.cache_key
        WHERE a.entry_id=?1 ORDER BY c.checked_at DESC,c.cache_key",
    )?;
    let rows = statement.query_map([entry_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    rows.map(|row| {
        let (id, title, scope, checked_at, json) = row?;
        let result: ReviewResult = serde_json::from_str(&json).map_err(|_| storage_error())?;
        let scope = match scope.as_str() {
            "document" => ReviewScope::Document,
            "selection" => ReviewScope::Selection,
            _ => return Err(storage_error()),
        };
        Ok(CacheEntry {
            id,
            title,
            scope,
            checked_at,
            summary: result.summary,
        })
    })
    .collect()
}

pub(super) fn delete(conn: &mut Connection, entry_id: &str, id: Option<&str>) -> Result<()> {
    let tx = conn.transaction()?;
    // Shared text can be cached once while each article owns its own visible record.
    tx.execute(
        "DELETE FROM review_cache WHERE cache_key IN (
            SELECT cache_key FROM review_cache_articles WHERE entry_id=?1 AND (?2 IS NULL OR cache_key=?2))
        AND NOT EXISTS (SELECT 1 FROM review_cache_articles a
            WHERE a.cache_key=review_cache.cache_key AND a.entry_id<>?1)",
        params![entry_id,id],
    )?;
    tx.execute(
        "DELETE FROM review_cache_articles WHERE entry_id=?1 AND (?2 IS NULL OR cache_key=?2)",
        params![entry_id, id],
    )?;
    tx.commit()?;
    Ok(())
}

pub(super) fn usage(conn: &Connection, now: i64) -> Result<Usage> {
    let month: String = conn.query_row(
        "SELECT strftime('%Y-%m',?1/1000.0,'unixepoch')",
        [now],
        |row| row.get(0),
    )?;
    Ok(conn.query_row("SELECT known_tokens,unknown_calls,successful_calls,cache_hits FROM review_usage WHERE month=?1", [&month], |row| {
        Ok(Usage { month: month.clone(), known_tokens: row.get(0)?, unknown_calls: row.get(1)?, successful_calls: row.get(2)?, cache_hits: row.get(3)? })
    }).optional()?.unwrap_or(Usage {month,known_tokens:0,unknown_calls:0,successful_calls:0,cache_hits:0}))
}

pub(super) fn clear(conn: &mut Connection, entry_id: Option<&str>) -> Result<()> {
    if let Some(entry_id) = entry_id {
        return delete(conn, entry_id, None);
    }
    conn.execute("DELETE FROM review_cache", [])?;
    Ok(())
}
