use crate::{
    content::Filter,
    db::{
        AppError, Result, SCHEMA_VERSION, Workspace, check_integrity, checkpoint, now,
        validate_backup_schema, workspace_id,
    },
};
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::NamedTempFile;

pub(super) struct Files {
    pub database: PathBuf,
    pub stage: PathBuf,
    pub incoming: PathBuf,
    pub marker: PathBuf,
    previous: PathBuf,
}

#[derive(Deserialize, Serialize)]
pub(super) struct PendingRestore {
    pub workspace: String,
    pub name: String,
    #[serde(default)]
    pub migration: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct RestoreNotice {
    pub failed: bool,
    pub message: String,
}

pub(super) fn file_error(error: std::io::Error) -> AppError {
    AppError::new("BACKUP_FILE", format!("无法处理数据库备份文件：{error}"))
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(file_error(error)),
    }
}

impl Files {
    pub(super) fn new(root: &Path) -> Result<Self> {
        let stage = root.join("staging");
        fs::create_dir_all(&stage).map_err(file_error)?;
        Ok(Self {
            database: root.join("content.db"),
            incoming: root.join("content.restore.db"),
            marker: root.join("content.restore.json"),
            previous: root.join("content.previous.db"),
            stage,
        })
    }

    pub(super) fn open(&self) -> Result<(Workspace, Option<RestoreNotice>)> {
        if !self.marker.try_exists().map_err(file_error)? {
            let db = if self.previous.try_exists().map_err(file_error)? {
                // The previous file can remain if the process stops after clearing the marker.
                Workspace::open_existing(&self.database)?
            } else {
                Workspace::open(&self.database)?
            };
            remove_if_present(&self.previous)?;
            remove_if_present(&self.incoming)?;
            return Ok((db, None));
        }

        let marker = fs::read(&self.marker).map_err(file_error)?;
        let pending: PendingRestore = serde_json::from_slice(&marker)
            .map_err(|_| AppError::new("BACKUP_MARKER", "无法读取待恢复数据库的标记"))?;
        let (db, notice) = match self.install(&pending) {
            Ok(db) => (
                db,
                RestoreNotice {
                    failed: false,
                    message: if pending.migration.is_some() {
                        "工作区已恢复"
                    } else {
                        "数据库已恢复"
                    }
                    .into(),
                },
            ),
            Err(error) => {
                let db = self.revert()?;
                (
                    db,
                    RestoreNotice {
                        failed: true,
                        message: format!("恢复失败，已保留原工作区。{error}"),
                    },
                )
            }
        };
        remove_if_present(&self.incoming)?;
        fs::remove_file(&self.marker).map_err(file_error)?;
        remove_if_present(&self.previous)?;
        self.discard_migration(&pending);
        Ok((db, Some(notice)))
    }

    fn install(&self, pending: &PendingRestore) -> Result<Workspace> {
        if let Some(stage) = self.migration_path(pending)? {
            super::migration::install_assets(&stage, &self.database.with_file_name("assets"))?;
        }
        if self.incoming.try_exists().map_err(file_error)? {
            validate_file(&self.incoming, &pending.workspace)?;
            if !self.previous.try_exists().map_err(file_error)? {
                seal_existing(&self.database)?;
                fs::rename(&self.database, &self.previous).map_err(file_error)?;
            }
            fs::rename(&self.incoming, &self.database).map_err(file_error)?;
        } else if !self.previous.try_exists().map_err(file_error)? {
            return Err(AppError::new("BACKUP_MISSING", "待恢复的快照不存在"));
        }
        validate_file(&self.database, &pending.workspace)?;
        let db = Workspace::open_existing(&self.database)?;
        db.entries(Filter::default())?;
        db.library()?;
        Ok(db)
    }

    fn revert(&self) -> Result<Workspace> {
        if self.previous.try_exists().map_err(file_error)? {
            // The original database was already sealed. These sidecars belong to the failed replacement.
            remove_if_present(&self.database.with_file_name("content.db-wal"))?;
            remove_if_present(&self.database.with_file_name("content.db-shm"))?;
            remove_if_present(&self.database)?;
            fs::rename(&self.previous, &self.database).map_err(file_error)?;
        }
        Workspace::open_existing(&self.database)
    }

    pub(super) fn write_marker(&self, pending: &PendingRestore) -> Result<()> {
        let directory = self
            .marker
            .parent()
            .expect("restore marker has a workspace directory");
        let mut file = NamedTempFile::new_in(directory).map_err(file_error)?;
        let marker = serde_json::to_vec(pending).expect("restore marker is serializable");
        file.write_all(&marker).map_err(file_error)?;
        file.as_file().sync_all().map_err(file_error)?;
        file.into_temp_path()
            .persist_noclobber(&self.marker)
            .map_err(|e| file_error(e.error))
    }

    pub(super) fn discard_marker(&self) -> Result<()> {
        fs::remove_file(&self.marker).map_err(file_error)
    }

    pub(super) fn migration_path(&self, pending: &PendingRestore) -> Result<Option<PathBuf>> {
        pending
            .migration
            .as_ref()
            .map(|name| {
                if !name.starts_with("migration-")
                    || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err(AppError::invalid("迁移暂存目录无效"));
                }
                Ok(self.stage.join(name))
            })
            .transpose()
    }

    pub(super) fn discard_migration(&self, pending: &PendingRestore) {
        match self.migration_path(pending) {
            Ok(Some(path)) => {
                if let Err(error) = fs::remove_dir_all(path)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    eprintln!("无法清理迁移暂存目录：{error}");
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("无法清理迁移暂存目录：{error}"),
        }
    }
}

fn seal_existing(path: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(2))?;
    checkpoint(&conn)?;
    conn.close().map_err(|(_, error)| error.into())
}

pub(super) fn make_snapshot(source: &Path, path: &Path, workspace: &str) -> Result<()> {
    let source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.busy_timeout(Duration::from_secs(2))?;
    let mut destination = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    if !matches!(
        Backup::new(&source, &mut destination)?.step(-1)?,
        StepResult::Done
    ) {
        return Err(AppError::new("BACKUP_BUSY", "数据库正在写入，请稍后重试"));
    }
    make_standalone(&destination)?;
    validate_connection(&destination, workspace)?;
    destination.close().map_err(|(_, error)| error.into())
}

pub(super) fn prepare_file(path: &Path, pending: &PendingRestore) -> Result<()> {
    let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_backup_schema(&source)?;
    check_integrity(&source)?;
    check_identity(&source, &pending.workspace)?;
    drop(source);

    let db = Workspace::open_existing(path)?;
    db.entries(Filter::default())?;
    db.library()?;
    db.write(|tx| {
        tx.execute("UPDATE sync_binding SET paused=1,pause_reason='backup_restored'", [])?;
        tx.execute("DELETE FROM jobs WHERE kind='cleanup'", [])?;
        tx.execute(
            "UPDATE jobs SET status='failed', error='恢复数据库后可手动重试', updated_at=?1
             WHERE kind IN ('upload','wechat_import','import_image') AND status IN ('queued','running','retrying')",
            [now()],
        )?;
        tx.execute(
            "UPDATE jobs SET status='cancelled', error='恢复数据库后可重新生成', updated_at=?1
             WHERE kind='ai' AND status IN ('queued','running','retrying')",
            [now()],
        )?;
        tx.execute("INSERT INTO backup_records VALUES (?1,'restore',?2,'completed',NULL,?3)",
            rusqlite::params![crate::db::id(), pending.name, now()])?;
        Ok(())
    })?;
    db.read(checkpoint)?;
    drop(db);

    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    make_standalone(&conn)?;
    validate_connection(&conn, &pending.workspace)?;
    conn.close().map_err(|(_, error)| error.into())
}

fn make_standalone(conn: &Connection) -> Result<()> {
    let mode: String = conn.query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))?;
    if mode != "delete" {
        return Err(AppError::new("BACKUP_BUSY", "无法生成独立的 SQLite 文件"));
    }
    Ok(())
}

fn validate_file(path: &Path, workspace: &str) -> Result<()> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_connection(&conn, workspace)
}

fn check_identity(conn: &Connection, workspace: &str) -> Result<()> {
    if workspace_id(conn)? != workspace {
        return Err(AppError::new("BACKUP_WORKSPACE", "快照与所选工作区不一致"));
    }
    Ok(())
}

fn validate_connection(conn: &Connection, workspace: &str) -> Result<()> {
    let version = validate_backup_schema(conn)?;
    if version != SCHEMA_VERSION {
        return Err(AppError::new(
            "BACKUP_SCHEMA",
            format!("快照数据库版本 {version} 不可直接打开"),
        ));
    }
    check_integrity(conn)?;
    check_identity(conn, workspace)?;
    validate_asset_paths(conn, workspace)?;
    Ok(())
}

fn validate_asset_paths(conn: &Connection, workspace: &str) -> Result<()> {
    let qualified = |hash: &str, name: &str| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
            && name.strip_prefix(hash).is_some_and(|extension| {
                matches!(extension, ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp")
            })
    };
    let invalid = || AppError::new("BACKUP_ASSET_PATH", "快照包含不属于此工作区的素材路径");
    let mut query =
        conn.prepare("SELECT sha256,relative_path FROM assets WHERE relative_path IS NOT NULL")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let hash: Option<String> = row.get(0)?;
        let path: String = row.get(1)?;
        let Some(hash) = hash else {
            return Err(invalid());
        };
        let Some((parent, name)) = path.rsplit_once('/') else {
            return Err(invalid());
        };
        if !qualified(&hash, name) || parent != format!("{}/{}", &hash[..2], &hash[2..4]) {
            return Err(invalid());
        }
    }
    let mut query = conn.prepare(
        "SELECT l.sha256,l.object_key,p.object_prefix FROM asset_locations l
        JOIN storage_profiles p ON p.id=l.storage_profile_id",
    )?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let hash: String = row.get(0)?;
        let key: String = row.get(1)?;
        let prefix: String = row.get(2)?;
        let expected = if prefix.is_empty() {
            workspace.to_owned()
        } else {
            format!("{prefix}/{workspace}")
        };
        let Some((parent, name)) = key.rsplit_once('/') else {
            return Err(invalid());
        };
        if parent != expected || !crate::assets::upload_format::original_name(name, &hash) {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
