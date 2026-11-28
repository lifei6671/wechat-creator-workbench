use super::cleanup;
use crate::db::{Result, Workspace};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const DAY_MS: i64 = 24 * 60 * 60 * 1000;
pub(crate) const RECENT_MS: i64 = 30 * DAY_MS;
pub(crate) const WAIT_MS: i64 = 7 * DAY_MS;
pub(crate) const RECOVERY_MS: i64 = 30 * DAY_MS;
pub(crate) mod s3;
mod session;
mod tasks;
pub(crate) use tasks::restore as restore_for_read;
pub(crate) use tasks::restore_references;

pub(crate) fn prepare_connection(conn: &Connection) -> Result<()> {
    session::prepare(conn)?;
    Ok(())
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Protection {
    Original,
    Referenced,
    Latest,
    Recent,
    Retained,
    Published,
    Session,
    Public,
    Synced,
    Uploading,
    Backup,
    Missing,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFile {
    pub sha256: String,
    pub location: String,
    pub copy_id: Option<String>,
    pub asset_id: String,
    pub render_id: String,
    pub project_id: String,
    pub name: String,
    pub created_at: i64,
    pub bytes: i64,
    pub versions: usize,
    pub reasons: BTreeSet<Protection>,
    pub state: Option<String>,
    pub due_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub error: Option<String>,
    #[serde(skip)]
    pub(super) path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub revision: String,
    pub files: Vec<VersionFile>,
    pub reclaimable_bytes: i64,
}

struct Render {
    id: String,
    output: String,
    project: String,
    created: i64,
    inputs: BTreeSet<String>,
    name: String,
}

pub(crate) async fn protect_external(
    db: &Workspace,
    assets: &super::Assets,
    payload: &str,
) -> Result<String> {
    let urls = serde_json::to_string(&super::references::urls(payload)?)
        .map_err(|error| crate::db::AppError::new("ASSET_REFERENCES", error.to_string()))?;
    let hashes=db.maintenance(|conn| {
        let mut query=conn.prepare("SELECT DISTINCT a.sha256 FROM assets a WHERE a.sha256 IS NOT NULL AND (instr(?1,'asset://'||a.id)>0 OR a.sha256 IN (SELECT sha256 FROM asset_urls WHERE instr(?1,url)>0 OR url IN (SELECT value FROM json_each(?2)) UNION SELECT sha256 FROM image_gc_remote WHERE payload_json->>'$.publicUrl' IS NOT NULL AND instr(?1,payload_json->>'$.publicUrl')>0))")?;
        let hashes=query.query_map(rusqlite::params![payload,urls],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
        for hash in &hashes {conn.execute("INSERT OR IGNORE INTO image_version_protection VALUES(?1,'external','',?2)",rusqlite::params![hash,crate::db::now()])?;}
        Ok(hashes)
    })?;
    let rewritten = assets.restore_public_versions(db, payload).await?;
    crate::sync::contents::protect_image_versions(db, &hashes).await?;
    Ok(rewritten)
}

#[tauri::command]
pub fn image_version_status(
    db: tauri::State<'_, Workspace>,
    assets: tauri::State<'_, super::Assets>,
) -> Result<Preview> {
    assets.image_version_preview(&db)
}

#[tauri::command]
pub async fn image_version_keep(
    db: tauri::State<'_, Workspace>,
    assets: tauri::State<'_, super::Assets>,
    asset_id: String,
) -> Result<()> {
    db.write(|conn| {
        conn.execute("INSERT OR IGNORE INTO image_version_protection SELECT sha256,'manual',id,?2 FROM assets WHERE id=?1 AND sha256 IS NOT NULL",rusqlite::params![asset_id,crate::db::now()])?;
        conn.execute("UPDATE image_version_cleanup SET state='cancelled',error=NULL WHERE sha256 IN (SELECT sha256 FROM assets WHERE id=?1) AND state='waiting'",[&asset_id])?;
        Ok(())
    })?;
    retain_remote(&db, &assets, &asset_id).await
}

#[tauri::command]
pub async fn image_version_restore(
    db: tauri::State<'_, Workspace>,
    assets: tauri::State<'_, super::Assets>,
    asset_id: String,
) -> Result<()> {
    assets
        .read_canvas_original(&db, &format!("asset://{asset_id}"))
        .await?;
    retain_remote(&db, &assets, &asset_id).await?;
    db.write(|conn| {
        let hash: String = conn.query_row(
            "SELECT sha256 FROM assets WHERE id=?1",
            [&asset_id],
            |row| row.get(0),
        )?;
        tasks::restore(conn, &assets.root, &hash)?;
        conn.execute(
            "INSERT OR IGNORE INTO image_version_protection VALUES(?1,'restored',?2,?3)",
            rusqlite::params![hash, asset_id, crate::db::now()],
        )?;
        Ok(())
    })
}

async fn retain_remote(db: &Workspace, assets: &super::Assets, asset: &str) -> Result<()> {
    let (hash,urls)=db.read(|conn|{
        let hash:String=conn.query_row("SELECT sha256 FROM assets WHERE id=?1",[asset],|r|r.get(0))?;
        let mut query=conn.prepare("SELECT public_url FROM image_public_copies WHERE sha256=?1 AND state IN ('removed','deleting','restoring','superseded')")?;
        let urls=query.query_map([&hash],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((hash,urls))
    })?;
    assets.restore_public_versions(db, &urls.join("\n")).await?;
    crate::sync::contents::protect_image_versions(db, &BTreeSet::from([hash])).await
}

impl super::Assets {
    pub(super) fn spawn_version_cleanup(app: tauri::AppHandle) {
        use tauri::Manager;
        tauri::async_runtime::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(600));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                let app = app.clone();
                let worker_app = app.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let app = worker_app;
                    let db = app.state::<Workspace>();
                    app.state::<super::Assets>()
                        .maintain_image_versions(&db, crate::db::now())
                })
                .await;
                if matches!(&result, Ok(Ok(()))) {
                    let db = app.state::<Workspace>();
                    if let Err(error) = app
                        .state::<super::Assets>()
                        .maintain_public_versions(&db)
                        .await
                    {
                        eprintln!("public image version cleanup: {error}");
                    }
                }
                match result {
                    Ok(Err(error)) if error.code() == "EXIT_PENDING" => {}
                    Ok(Err(error)) => eprintln!("image version cleanup: {error}"),
                    Err(error) => {
                        eprintln!("image version cleanup worker: {error}");
                        return;
                    }
                    Ok(Ok(())) => {}
                }
            }
        });
    }

    pub fn image_version_preview(&self, db: &Workspace) -> Result<Preview> {
        db.read(|conn| {
            let mut preview=scan(conn,crate::db::now())?;
            let remote=scan_remote(conn,crate::db::now())?;
            let mut public=Vec::new();
            for file in preview.files.clone() {
                let mut query=conn.prepare("SELECT id,state,due_at,expires_at,error,bytes FROM image_public_copies WHERE sha256=?1 ORDER BY id")?;
                for copy in query.query_map([&file.sha256],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<i64>>(2)?,r.get::<_,Option<i64>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,i64>(5)?)))? {
                    let (id,state,due,expires,error,bytes)=copy?;
                    let mut row=remote.files.iter().find(|f|f.sha256==file.sha256).cloned().expect("same version scan");
                    row.copy_id=Some(id);row.location="s3".into();row.bytes=bytes;
                    if state=="legacy" {row.reasons.insert(Protection::Public);}
                    row.state=Some(match state.as_str(){"deleting"|"restoring"=>"copying","superseded"=>"restored","removed"=>"removed","expired"=>"expired",_=>state.as_str()}.to_owned());
                    row.due_at=due;row.expires_at=expires;row.error=error;public.push(row);
                }
                let mut query=conn.prepare("SELECT payload_json FROM image_gc_remote WHERE sha256=?1 AND payload_json->>'$.current'=1 AND payload_json->>'$.backend'='private'")?;
                for payload in query.query_map([&file.sha256],|r|r.get::<_,String>(0))? {
                    let data:serde_json::Value=serde_json::from_str(&payload?).map_err(|e|crate::db::AppError::new("ASSET_REFERENCES",e.to_string()))?;
                    if let Some(error)=data["job"]["error"].as_str() && let Some(local)=preview.files.iter_mut().find(|f|f.sha256==file.sha256) {local.error=Some(error.to_owned());}
                }
            }
            preview.files.extend(public);
            preview.revision=hex::encode(Sha256::digest(serde_json::to_vec(&preview.files).map_err(|e|crate::db::AppError::new("ASSET_REFERENCES",e.to_string()))?));
            Ok(preview)
        })
    }
}

pub(crate) fn scan_remote(conn: &Connection, timestamp: i64) -> Result<Preview> {
    scan_mode(conn, timestamp, true)
}
pub(crate) fn backup_hashes(conn: &Connection) -> Result<BTreeSet<String>> {
    Ok(scan_remote(conn, crate::db::now())?
        .files
        .into_iter()
        .filter(|file| {
            file.reasons.iter().any(|reason| {
                !matches!(
                    reason,
                    Protection::Missing
                        | Protection::Public
                        | Protection::Synced
                        | Protection::Backup
                        | Protection::Published
                )
            })
        })
        .map(|file| file.sha256)
        .collect())
}

fn scan(conn: &Connection, timestamp: i64) -> Result<Preview> {
    scan_mode(conn, timestamp, false)
}
fn scan_mode(conn: &Connection, timestamp: i64, remote: bool) -> Result<Preview> {
    let mut query = conn.prepare("SELECT r.id,r.output_asset_id,r.project_id,r.created_at,r.asset_ids_json,COALESCE(e.title,'图片工程')
        FROM image_renders r LEFT JOIN image_projects p ON p.id=r.project_id LEFT JOIN entries e ON e.id=p.origin_entry_id
        ORDER BY r.created_at DESC,r.id DESC")?;
    let renders = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .map(|row| {
            let (id, output, project, created, inputs, name) = row?;
            let inputs = serde_json::from_str(&inputs).map_err(|error| {
                crate::db::AppError::new("ASSET_REFERENCES", format!("无法读取成品依赖：{error}"))
            })?;
            Ok(Render {
                id,
                output,
                project,
                created,
                inputs,
                name,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let (mut ids, root_hashes) = cleanup::reference_roots(conn, false)?;
    let mut query = conn.prepare("SELECT id,sha256,relative_path,bytes,source_key,retain_on_exit FROM assets WHERE sha256 IS NOT NULL")?;
    let assets = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let by_asset: BTreeMap<_, _> = assets
        .iter()
        .map(|asset| (asset.0.as_str(), asset))
        .collect();
    let by_output: BTreeMap<_, _> = renders.iter().map(|r| (r.output.as_str(), r)).collect();
    let mut per_project = BTreeMap::<&str, usize>::new();
    let mut direct = BTreeMap::<String, BTreeSet<Protection>>::new();
    for render in &renders {
        let rank = per_project.entry(&render.project).or_default();
        *rank += 1;
        if *rank <= 5 {
            direct
                .entry(render.output.clone())
                .or_default()
                .insert(Protection::Latest);
        }
        if timestamp.saturating_sub(render.created) < RECENT_MS {
            direct
                .entry(render.output.clone())
                .or_default()
                .insert(Protection::Recent);
        }
    }
    let mut protected = BTreeMap::<String, BTreeSet<Protection>>::new();
    for (id, hash, _, _, key, retained) in &assets {
        if !by_output
            .get(id.as_str())
            .is_some_and(|r| key.as_deref() == Some(format!("image-render:{}", r.id).as_str()))
        {
            protected
                .entry(hash.clone())
                .or_default()
                .insert(Protection::Original);
        }
        if *retained {
            protected
                .entry(hash.clone())
                .or_default()
                .insert(Protection::Retained);
        }
        if ids.contains(id) || root_hashes.contains(hash) {
            direct
                .entry(id.clone())
                .or_default()
                .insert(Protection::Referenced);
        }
        if conn.query_row(
            "SELECT image_session_has(?1) OR image_session_has(?2)",
            [
                Some(format!("asset://{id}")),
                key.as_ref().map(|key| format!("source:{key}")),
            ],
            |row| row.get::<_, bool>(0),
        )? {
            direct
                .entry(id.clone())
                .or_default()
                .insert(Protection::Session);
        }
    }
    for (sql, reason) in [
        (
            "SELECT sha256 FROM asset_public_protection UNION SELECT l.sha256 FROM asset_locations l WHERE NOT EXISTS(SELECT 1 FROM image_public_copies c WHERE c.sha256=l.sha256 AND c.profile_id=l.storage_profile_id AND c.object_key=l.object_key)",
            Protection::Public,
        ),
        (
            "SELECT a.sha256 FROM assets a WHERE (EXISTS(SELECT 1 FROM sync_binding) OR EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='asset' AND r.entity_id=a.id)) AND NOT EXISTS(SELECT 1 FROM image_gc_remote g JOIN sync_binding b ON b.instance_id=g.instance_id AND b.epoch=g.epoch WHERE g.sha256=a.sha256 AND g.state IN ('retired','expired') AND g.payload_json->>'$.backend'='private' AND g.payload_json->>'$.current'=1) AND NOT EXISTS(SELECT 1 FROM image_version_cleanup c WHERE c.sha256=a.sha256 AND c.state='expired')",
            Protection::Synced,
        ),
        (
            "SELECT sha256 FROM jobs WHERE kind='upload' AND status IN ('queued','running','retrying') UNION SELECT sha256 FROM image_public_copies WHERE state='uploading'",
            Protection::Uploading,
        ),
        (
            "SELECT sha256 FROM backup_asset_references",
            Protection::Backup,
        ),
        (
            "SELECT sha256 FROM image_version_protection WHERE reason='published' OR reason='external'",
            Protection::Published,
        ),
        (
            "SELECT sha256 FROM image_version_protection WHERE reason NOT IN ('published','external')",
            Protection::Retained,
        ),
        (
            "SELECT sha256 FROM asset_urls WHERE image_session_has(url)",
            Protection::Session,
        ),
    ] {
        if remote && reason == Protection::Synced {
            continue;
        }
        let mut query = conn.prepare(sql)?;
        for hash in query.query_map([], |row| row.get::<_, Option<String>>(0))? {
            if let Some(hash) = hash? {
                protected.entry(hash).or_default().insert(reason.clone());
            }
        }
    }
    // Recovery must retain the inputs of each still-recoverable snapshot, without rooting its own retired bytes.
    let mut query = conn.prepare(
        "SELECT sha256 FROM image_version_cleanup WHERE state IN ('waiting','copying','failed')
        OR (state='removed' AND backup_path IS NOT NULL AND expires_at>?1)",
    )?;
    let recoverable = query
        .query_map([timestamp], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let mut recovery_dependencies = BTreeSet::new();
    let public_recoverable = {
        let mut query=conn.prepare("SELECT DISTINCT sha256 FROM image_public_copies WHERE state IN ('uploading','live','waiting','deleting','restoring') OR (state='removed' AND expires_at>?1)")?;
        query
            .query_map([timestamp], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?
    };
    recovery_dependencies.extend(public_recoverable.iter().cloned());
    for render in &renders {
        let Some(asset) = by_asset.get(render.output.as_str()) else {
            continue;
        };
        if !recoverable.contains(&asset.1) && !public_recoverable.contains(&asset.1) {
            continue;
        }
        let mut inputs: Vec<_> = render.inputs.iter().cloned().collect();
        let mut seen = BTreeSet::new();
        while let Some(input) = inputs.pop() {
            if !seen.insert(input.clone()) {
                continue;
            }
            if let Some(value) = by_asset.get(input.as_str())
                && value.1 != asset.1
            {
                recovery_dependencies.insert(value.1.clone());
            }
            if let Some(dependency) = by_output.get(input.as_str()) {
                inputs.extend(dependency.inputs.iter().cloned());
            }
        }
    }
    // Traverse only versions reachable from real uses or retention policy; history metadata is not a root.
    ids.extend(direct.keys().cloned());
    for (id, hash, _, _, _, _) in &assets {
        if protected.contains_key(hash) {
            ids.insert(id.clone());
        }
    }
    let mut todo: Vec<_> = ids
        .into_iter()
        .map(|id| {
            let reasons: Vec<_> = direct
                .get(&id)
                .into_iter()
                .flatten()
                .chain(
                    by_asset
                        .get(id.as_str())
                        .and_then(|asset| protected.get(&asset.1))
                        .into_iter()
                        .flatten(),
                )
                .collect();
            let backup_only =
                !reasons.is_empty() && reasons.iter().all(|reason| **reason == Protection::Backup);
            (
                id,
                if backup_only {
                    Protection::Backup
                } else {
                    Protection::Referenced
                },
            )
        })
        .collect();
    let mut visited = BTreeSet::new();
    while let Some((id, reason)) = todo.pop() {
        if !visited.insert((id.clone(), reason.clone())) {
            continue;
        }
        if let Some(render) = by_output.get(id.as_str()) {
            for input in &render.inputs {
                direct
                    .entry(input.clone())
                    .or_default()
                    .insert(reason.clone());
                todo.push((input.clone(), reason.clone()));
            }
        }
    }
    for (id, hash, _, _, _, _) in &assets {
        if let Some(reasons) = direct.get(id) {
            protected
                .entry(hash.clone())
                .or_default()
                .extend(reasons.iter().cloned());
        }
    }
    let unknown_backup = crate::backup::unknown_asset_protection(conn)?;
    let mut grouped = BTreeMap::<String, VersionFile>::new();
    for render in &renders {
        let Some((_, hash, path, bytes, _, _)) = by_asset.get(render.output.as_str()).copied()
        else {
            return Err(crate::db::AppError::new(
                "ASSET_REFERENCES",
                "图片成品缺少素材记录",
            ));
        };
        let bytes = bytes
            .ok_or_else(|| crate::db::AppError::new("ASSET_REFERENCES", "图片成品缺少文件大小"))?;
        let item = grouped.entry(hash.clone()).or_insert_with(|| VersionFile {
            sha256: hash.clone(),
            location: "local".into(),
            copy_id: None,
            asset_id: render.output.clone(),
            render_id: render.id.clone(),
            project_id: render.project.clone(),
            name: render.name.clone(),
            created_at: render.created,
            bytes,
            versions: 0,
            state: None,
            due_at: None,
            expires_at: None,
            error: None,
            reasons: protected.get(hash).cloned().unwrap_or_default(),
            path: path.clone(),
        });
        item.versions += 1;
        if unknown_backup {
            item.reasons.insert(Protection::Backup);
        }
        if item.path.is_none() && path.is_some() {
            item.path = path.clone();
        }
        if path.is_none() {
            item.reasons.insert(Protection::Missing);
            if !remote && recovery_dependencies.contains(hash) {
                item.reasons.insert(Protection::Backup);
            }
        }
    }
    let mut files: Vec<_> = grouped.into_values().collect();
    for file in &mut files {
        use rusqlite::OptionalExtension;
        let job = conn.query_row("SELECT state,due_at,expires_at,error FROM image_version_cleanup WHERE sha256=?1 ORDER BY created_at DESC,id DESC LIMIT 1",[&file.sha256],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,Option<i64>>(2)?,row.get::<_,Option<String>>(3)?))).optional()?;
        if let Some((state, due, expires, error)) = job {
            file.state = Some(state);
            file.due_at = Some(due);
            file.expires_at = expires;
            file.error = error;
        }
    }
    let reclaimable_bytes = files
        .iter()
        .filter(|f| f.reasons.is_empty())
        .map(|f| f.bytes)
        .sum();
    let encoded = serde_json::to_vec(&files)
        .map_err(|error| crate::db::AppError::new("ASSET_REFERENCES", error.to_string()))?;
    Ok(Preview {
        revision: hex::encode(Sha256::digest(encoded)),
        files,
        reclaimable_bytes,
    })
}

#[cfg(test)]
mod tests;
