use super::ReviewResult;
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

pub(super) fn open(directory: &Path) -> Result<Connection> {
    std::fs::create_dir_all(directory).map_err(|_| storage_error())?;
    let conn =
        Connection::open(directory.join("review-cache.sqlite3")).map_err(|_| storage_error())?;
    conn.busy_timeout(Duration::from_secs(2))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS review_cache (
            cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, checked_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS review_usage (
            month TEXT PRIMARY KEY, known_tokens INTEGER NOT NULL DEFAULT 0,
            unknown_calls INTEGER NOT NULL DEFAULT 0, successful_calls INTEGER NOT NULL DEFAULT 0,
            cache_hits INTEGER NOT NULL DEFAULT 0);",
    )?;
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

pub(super) fn lookup(conn: &mut Connection, key: &str, now: i64) -> Result<Option<ReviewResult>> {
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

pub(super) fn save(conn: &mut Connection, key: Option<&str>, result: &ReviewResult) -> Result<()> {
    let tx = conn.transaction()?;
    prune(&tx, result.checked_at)?;
    if let Some(key) = key {
        let json = serde_json::to_string(result).map_err(|_| storage_error())?;
        tx.execute(
            "INSERT INTO review_cache VALUES(?1,?2,?3) ON CONFLICT(cache_key) DO UPDATE
            SET result_json=excluded.result_json,checked_at=excluded.checked_at",
            params![key, json, result.checked_at],
        )?;
    }
    tx.execute("INSERT INTO review_usage(month,known_tokens,unknown_calls,successful_calls)
        VALUES(strftime('%Y-%m',?1/1000.0,'unixepoch'),?2,?3,1) ON CONFLICT(month) DO UPDATE SET
        known_tokens=known_tokens+excluded.known_tokens,unknown_calls=unknown_calls+excluded.unknown_calls,
        successful_calls=successful_calls+1", params![result.checked_at,result.charged_tokens.unwrap_or(0) as i64,i64::from(result.charged_tokens.is_none())])?;
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

pub(super) fn clear(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM review_cache", [])?;
    Ok(())
}
