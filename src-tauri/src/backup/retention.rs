use super::store::Backup;
use crate::db::{Result, now, workspace_id};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

pub(super) fn scope(conn: &Connection) -> Result<Option<String>> {
    let target: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key='backup_target'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    target.map(|target| {
        let target:serde_json::Value=serde_json::from_str(&target).map_err(|_|crate::db::AppError::new("BACKUP_CONFIG","备份配置格式无效"))?;
        Ok(scope_for(&target,&workspace_id(conn)?))
    }).transpose()

}

pub(super) fn scope_for(target:&serde_json::Value, workspace:&str)->String {
    hex::encode(Sha256::digest(format!("{target}\0{workspace}").as_bytes()))
}

pub(crate) fn unknown(conn: &Connection) -> Result<bool> {
    if conn.query_row("SELECT EXISTS(SELECT 1 FROM backup_asset_manifests WHERE status='unverified')",[],|row|row.get::<_,bool>(0))? { return Ok(true); }
    if conn.query_row("SELECT EXISTS(SELECT 1 FROM app_settings WHERE key LIKE 'asset-backup-state:%' AND value='false')",[],|row|row.get::<_,bool>(0))? { return Ok(true); }
    if let Some(scope) = scope(conn)? {
        let known: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key=?1 AND value='true')",
            [format!("asset-backup-state:{scope}")],
            |row| row.get(0),
        )?;
        return Ok(!known);
    }
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM backup_records WHERE operation='backup' AND status='completed') AND NOT EXISTS(SELECT 1 FROM backup_asset_manifests)",[],|row|row.get(0))?)
}

pub(super) fn reserve(conn: &Connection, scope: &str, snapshot: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO backup_asset_manifests VALUES(?1,?2,'pending',?3)",
        params![scope, snapshot, now()],
    )?;
    conn.execute("INSERT INTO backup_asset_references SELECT ?1,?2,sha256 FROM assets WHERE sha256 IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM image_version_cleanup c WHERE c.sha256=assets.sha256 AND c.state IN ('removed','expired')) GROUP BY sha256",params![scope,snapshot])?;
    Ok(())
}

pub(super) fn exact(
    conn: &Connection,
    scope: &str,
    snapshot: &str,
    hashes: &[String],
) -> Result<()> {
    conn.execute(
        "DELETE FROM backup_asset_references WHERE scope=?1 AND snapshot=?2",
        params![scope, snapshot],
    )?;
    for hash in hashes {
        conn.execute(
            "INSERT INTO backup_asset_references VALUES(?1,?2,?3)",
            params![scope, snapshot, hash],
        )?;
    }
    Ok(())
}

pub(super) fn reconcile(conn: &Connection, scope: &str, remote: &[Backup]) -> Result<()> {
    let names: Vec<&str> = remote.iter().map(|item| item.name.as_str()).collect();
    let encoded = serde_json::to_string(&names).expect("backup names serialize");
    conn.execute("UPDATE backup_asset_manifests SET status='confirmed' WHERE scope=?1 AND status='pending' AND snapshot IN (SELECT value FROM json_each(?2))",params![scope,encoded])?;
    // An unacknowledged upload can still be in flight; never retire its protection from a listing alone.
    conn.execute("DELETE FROM backup_asset_manifests WHERE scope=?1 AND status IN ('confirmed','unverified') AND snapshot NOT IN (SELECT value FROM json_each(?2))",params![scope,encoded])?;
    let unknown: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM json_each(?2) r WHERE NOT EXISTS(SELECT 1 FROM backup_asset_manifests m WHERE m.scope=?1 AND m.snapshot=r.value AND m.status<>'unverified'))",params![scope,encoded],|row|row.get(0))?;
    conn.execute("INSERT INTO app_settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("asset-backup-state:{scope}"),if unknown {"false"}else{"true"}])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{assets::Assets, db::Workspace};
    #[test]
    fn exact_snapshot_manifest_protects_backup_assets_and_unknown_history_is_conservative() {
        let root = tempfile::tempdir().unwrap();
        let db = Workspace::open(&root.path().join("content.db")).unwrap();
        let assets = Assets::new(root.path().join("assets"), &db).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let image = assets.import(&db, "image.png", &png.into_inner()).unwrap();
        db.write(|tx| {
            tx.execute("INSERT INTO app_settings VALUES('backup_target','{}')", [])?;
            let scope = scope(tx)?.unwrap();
            assert!(unknown(tx)?);
            reserve(tx, &scope, "one.sqlite")?;
            let hash = tx.query_row("SELECT sha256 FROM assets WHERE id=?1", [image], |row| {
                row.get::<_, String>(0)
            })?;
            exact(tx, &scope, "one.sqlite", std::slice::from_ref(&hash))?;
            reconcile(
                tx,
                &scope,
                &[Backup {
                    name: "one.sqlite".into(),
                    created_at: 1,
                    bytes: 1,
                }],
            )?;
            assert!(!unknown(tx)?);
            assert_eq!(
                tx.query_row("SELECT sha256 FROM backup_asset_references", [], |row| {
                    row.get::<_, String>(0)
                })?,
                hash
            );
            reconcile(
                tx,
                &scope,
                &[Backup {
                    name: "unknown-old.sqlite".into(),
                    created_at: 0,
                    bytes: 1,
                }],
            )?;
            assert!(unknown(tx)?);
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM backup_asset_references", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                0
            );
            reserve(tx, &scope, "inflight.sqlite")?;
            reconcile(tx, &scope, &[])?;
            assert!(!unknown(tx)?);
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM backup_asset_references", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                1,
                "an upload absent from a concurrent listing can still be in flight"
            );
            Ok(())
        })
        .unwrap();
    }
}
