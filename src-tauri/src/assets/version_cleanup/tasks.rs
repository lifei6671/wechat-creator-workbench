use super::{Protection, RECOVERY_MS, WAIT_MS, scan};
use crate::assets::{Assets, local_error};
use crate::db::{AppError, Result, Workspace, id, now};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub(super) fn path(root: &Path, relative: &str) -> Result<PathBuf> {
    let value = Path::new(relative);
    if value
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || relative.is_empty()
    {
        return Err(AppError::new("IMAGE_CLEANUP_PATH", "图片回收路径无效"));
    }
    Ok(root.join(value))
}

fn checked(root: &Path, relative: &str, hash: &str, bytes: i64) -> Result<Vec<u8>> {
    let location = path(root, relative)?;
    let data = fs::read(location).map_err(local_error)?;
    if data.len() as i64 != bytes || hex::encode(Sha256::digest(&data)) != hash {
        return Err(AppError::new(
            "IMAGE_CLEANUP_CHANGED",
            "图片字节与回收记录不一致",
        ));
    }
    Ok(data)
}

pub(super) fn durable_write(root: &Path, relative: &str, data: &[u8]) -> Result<()> {
    let location = path(root, relative)?;
    let parent = location.parent().expect("relative file has parent");
    fs::create_dir_all(parent).map_err(local_error)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(local_error)?;
    file.write_all(data).map_err(local_error)?;
    file.as_file().sync_all().map_err(local_error)?;
    file.persist(&location)
        .map_err(|error| local_error(error.error))?;
    Ok(())
}

struct Job {
    id: String,
    hash: String,
    relative: String,
    bytes: i64,
    backup: String,
    paths: Vec<String>,
}

fn plan(conn: &Connection, timestamp: i64) -> Result<()> {
    for file in scan(conn, timestamp)?.files {
        if file.reasons.is_empty() {
            conn.execute("INSERT INTO image_version_cleanup(id,sha256,relative_path,bytes,state,created_at,due_at)
                SELECT ?1,?2,?3,?4,'waiting',?5,?6 WHERE NOT EXISTS
                (SELECT 1 FROM image_version_cleanup WHERE sha256=?2 AND state IN ('waiting','copying','removed','failed','expired'))",
                params![id(),file.sha256,file.path,file.bytes,timestamp,timestamp+WAIT_MS])?;
        } else {
            conn.execute(
                "UPDATE image_version_cleanup SET state='cancelled',error=NULL
                WHERE sha256=?1 AND state='waiting'",
                [&file.sha256],
            )?;
        }
    }
    Ok(())
}

fn claim(conn: &Connection, timestamp: i64) -> Result<Option<Job>> {
    let job = conn.query_row("SELECT id,sha256,relative_path,bytes,COALESCE(backup_path,'.image-version-recycle/'||id||'/'||sha256||'.bin')
        FROM image_version_cleanup WHERE state='copying' OR (state='waiting' AND due_at<=?1) OR (state='failed' AND attempts<3 AND due_at<=?1 AND error LIKE 'ASSET_FILE:%')
        ORDER BY created_at,id LIMIT 1", [timestamp], |row| Ok(Job {
            id:row.get(0)?,hash:row.get(1)?,relative:row.get(2)?,bytes:row.get(3)?,backup:row.get(4)?,paths:Vec::new(),
        })).optional()?;
    let mut job = job;
    if let Some(job) = &mut job {
        let mut query=conn.prepare("SELECT DISTINCT relative_path FROM assets WHERE sha256=?1 AND relative_path IS NOT NULL
            UNION SELECT value FROM image_version_cleanup c,json_each(c.paths_json) WHERE c.id=?2")?;
        job.paths = query
            .query_map(params![job.hash, job.id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !job.paths.contains(&job.relative) {
            job.paths.push(job.relative.clone());
        }
        let paths = serde_json::to_string(&job.paths).expect("path list serializes");
        conn.execute(
            "UPDATE image_version_cleanup SET paths_json=?2,attempts=attempts+1 WHERE id=?1",
            params![job.id, paths],
        )?;
        conn.execute("UPDATE image_version_cleanup SET state='copying',backup_path=?2,expires_at=COALESCE(expires_at,?3),error=NULL WHERE id=?1",params![job.id,job.backup,timestamp+RECOVERY_MS])?;
    }
    Ok(job)
}

pub(crate) fn restore(conn: &Connection, root: &Path, hash: &str) -> Result<bool> {
    let job = conn.query_row("SELECT id,relative_path,bytes,backup_path,state FROM image_version_cleanup
        WHERE sha256=?1 AND state IN ('copying','removed','failed','expired') ORDER BY created_at DESC LIMIT 1",[hash],|row|Ok((
            row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?,
        ))).optional()?;
    let Some((id, relative, bytes, backup, state)) = job else {
        return Ok(false);
    };
    let source = path(root, &relative)?;
    if state == "expired" && !source.try_exists().map_err(local_error)? {
        let mut query=conn.prepare("SELECT DISTINCT relative_path FROM assets WHERE sha256=?1 AND relative_path IS NOT NULL")?;
        let paths = query
            .query_map([hash], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut supplied = false;
        for location in paths {
            if path(root, &location)?.try_exists().map_err(local_error)? {
                let data = checked(root, &location, hash, bytes)?;
                durable_write(root, &relative, &data)?;
                supplied = true;
                break;
            }
        }
        if !supplied {
            return Err(AppError::new(
                "IMAGE_VERSION_EXPIRED",
                "旧版图片已超过回收保留期，无法恢复原成品",
            ));
        }
    }
    if source.try_exists().map_err(local_error)? {
        checked(root, &relative, hash, bytes)?;
    } else {
        let backup =
            backup.ok_or_else(|| AppError::new("IMAGE_CLEANUP_BACKUP", "图片缺少回收副本"))?;
        let data = checked(root, &backup, hash, bytes)?;
        durable_write(root, &relative, &data)?;
    }
    conn.execute(
        "UPDATE assets SET relative_path=?2 WHERE sha256=?1",
        params![hash, relative],
    )?;
    conn.execute(
        "UPDATE image_version_cleanup SET state='restored',error=NULL WHERE id=?1",
        [&id],
    )?;
    Ok(true)
}

pub(crate) fn restore_references(conn: &Connection, root: &Path) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO asset_public_protection SELECT DISTINCT sha256,?1 FROM image_public_copies WHERE remote=0 AND EXISTS(SELECT 1 FROM sync_binding)",[now()])?;
    conn.execute("UPDATE image_public_copies SET state='legacy' WHERE remote=0 AND state IN ('uploading','live','waiting') AND EXISTS(SELECT 1 FROM sync_binding)",[])?;
    if !conn.query_row("SELECT EXISTS(SELECT 1 FROM image_version_cleanup WHERE state IN ('copying','removed','failed','expired'))",[],|row|row.get::<_,bool>(0))? {
        return Ok(());
    }
    let files = scan(conn, now())?.files;
    for file in files {
        if file
            .reasons
            .iter()
            .any(|reason| !matches!(reason, Protection::Missing | Protection::Backup))
            && let Err(error) = restore(conn, root, &file.sha256)
        {
            let strong = file.reasons.iter().any(|reason| {
                !matches!(
                    reason,
                    Protection::Missing
                        | Protection::Backup
                        | Protection::Referenced
                        | Protection::Session
                        | Protection::Public
                        | Protection::Synced
                        | Protection::Published
                        | Protection::Retained
                )
            });
            let (ids, hashes) = super::cleanup::committed_roots(conn)?;
            let ids = serde_json::to_string(&ids).expect("asset IDs serialize");
            let committed:bool=conn.query_row("WITH RECURSIVE used(id) AS (SELECT value FROM json_each(?1)
                    UNION SELECT j.value FROM image_renders r JOIN used u ON r.output_asset_id=u.id,json_each(r.asset_ids_json) j)
                    SELECT EXISTS(SELECT 1 FROM used JOIN assets a ON a.id=used.id WHERE a.sha256=?2)",params![ids,file.sha256],|row|row.get(0))?;
            if strong || committed || hashes.contains(&file.sha256) {
                return Err(error);
            }
            // An unresolved recovery draft must remain durable even when its image cannot be restored.
            // The same reference is rejected if submitted to normal content or an external output.
            conn.execute("UPDATE image_version_cleanup SET error=?2 WHERE sha256=?1 AND state IN ('failed','removed','expired')",params![file.sha256,error.to_string()])?;
        }
    }
    Ok(())
}

impl Assets {
    pub(crate) fn maintain_image_versions(&self, db: &Workspace, timestamp: i64) -> Result<()> {
        let job = db.write(|conn| {
            plan(conn, timestamp)?;
            claim(conn, timestamp)
        })?;
        if let Some(job) = job {
            let result = self.recycle_version(db, &job, timestamp);
            if let Err(error) = result {
                db.write(|conn| {
                    conn.execute("UPDATE image_version_cleanup SET state='failed',error=?2,due_at=?3 WHERE id=?1 AND state='copying'",params![job.id,error.to_string(),timestamp+super::DAY_MS])?;
                    Ok(())
                })?;
                return Err(error);
            }
        }
        self.expire_versions(db, timestamp)
    }

    fn recycle_version(&self, db: &Workspace, job: &Job, timestamp: i64) -> Result<()> {
        // Copy and sync bytes outside the workspace transaction. Recheck under its lock before unlink.
        let source = path(&self.root, &job.relative)?;
        if source.try_exists().map_err(local_error)? {
            let data = checked(&self.root, &job.relative, &job.hash, job.bytes)?;
            durable_write(&self.root, &job.backup, &data)?;
        }
        checked(&self.root, &job.backup, &job.hash, job.bytes)?;
        db.write(|conn| {
            let state:String = conn.query_row("SELECT state FROM image_version_cleanup WHERE id=?1",[&job.id],|row|row.get(0))?;
            if state != "copying" {return Ok(());}
            let eligible = scan(conn,timestamp)?.files.into_iter().any(|file| file.sha256==job.hash && file.reasons.is_empty());
            if !eligible {
                if !source.try_exists().map_err(local_error)? {
                    restore(conn,&self.root,&job.hash)?;
                } else {
                    conn.execute("UPDATE image_version_cleanup SET state='cancelled' WHERE id=?1",[&job.id])?;
                }
                return Ok(());
            }
            // Validate every physical alias before removing any of them.
            for relative in &job.paths {
                if path(&self.root,relative)?.try_exists().map_err(local_error)? {checked(&self.root,relative,&job.hash,job.bytes)?;}
            }
            for relative in &job.paths {
                let location=path(&self.root,relative)?;
                if location.try_exists().map_err(local_error)? {fs::remove_file(location).map_err(local_error)?;}
            }
            conn.execute("UPDATE assets SET relative_path=NULL WHERE sha256=?1",[&job.hash])?;
            conn.execute("UPDATE image_version_cleanup SET state='removed',removed_at=?2,expires_at=?3,error=NULL WHERE id=?1",
                params![job.id,timestamp,timestamp+RECOVERY_MS])?;
            Ok(())
        })
    }

    fn expire_versions(&self, db: &Workspace, timestamp: i64) -> Result<()> {
        db.write(|conn| {
            restore_references(conn,&self.root)?;
            let protected:Vec<_>=scan(conn,timestamp)?.files.into_iter().filter(|file| file.reasons.contains(&Protection::Backup)).map(|file|file.sha256).collect();
            let protected=serde_json::to_string(&protected).expect("hash list serializes");
            let job = conn.query_row("SELECT id,backup_path,sha256,bytes FROM image_version_cleanup WHERE state IN ('removed','restored','cancelled')
                AND expires_at<=?1 AND backup_path IS NOT NULL AND sha256 NOT IN (SELECT value FROM json_each(?2)) ORDER BY expires_at LIMIT 1",params![timestamp,protected],|row|Ok((
                    row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,
                ))).optional()?;
            if let Some((id,backup,hash,bytes)) = job {
                let location = path(&self.root,&backup)?;
                if location.try_exists().map_err(local_error)? {
                    checked(&self.root,&backup,&hash,bytes)?;
                    fs::remove_file(location).map_err(local_error)?;
                }
                conn.execute("UPDATE image_version_cleanup SET state=CASE WHEN state='removed' THEN 'expired' ELSE state END,backup_path=NULL WHERE id=?1",[id])?;
            }
            Ok(())
        })
    }
}
