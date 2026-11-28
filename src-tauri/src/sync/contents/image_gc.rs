use super::{Operation, Remote, progress};
use crate::{
    assets::{
        Assets,
        version_cleanup::{Protection, scan_remote},
    },
    db::{Result, Workspace},
};
use reqwest::Method;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feed {
    capability: u32,
    round_id: String,
    revision: i64,
    cursor: i64,
    copies: Vec<Value>,
    candidates: Vec<Value>,
    jobs: Vec<Value>,
}

async fn post(remote: &Remote<'_>, route: &str, input: Value) -> Result<Value> {
    super::response(
        remote
            .request(Method::POST, &format!("v1/sync/image-gc/{route}"))?
            .json(&input),
    )
    .await
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// The durable barrier is installed before the complete scan and checkpoint. Later writes
// stay local until the ordinary push fence admits their references or restoration succeeds.
pub(super) async fn maintain(
    db: &Workspace,
    assets: &Assets,
    sync: &super::SyncConnection,
) -> Result<()> {
    maintain_mode(db, assets, sync, true).await
}
pub(super) async fn refresh(
    db: &Workspace,
    assets: &Assets,
    sync: &super::SyncConnection,
) -> Result<()> {
    maintain_mode(db, assets, sync, false).await
}
async fn maintain_mode(
    db: &Workspace,
    _assets: &Assets,
    sync: &super::SyncConnection,
    ack: bool,
) -> Result<()> {
    let remote = Remote::open(db, sync).await?;
    if remote.image_gc != 1 {
        return Ok(());
    }
    if !progress(db)?.0 && sync.meta(&remote.base).await?.seed_status != "ready" {
        return Ok(());
    }
    refresh_remote(db, &remote, ack).await
}

pub(super) async fn refresh_remote(db: &Workspace, remote: &Remote<'_>, ack: bool) -> Result<()> {
    if remote.image_gc != 1 {
        return Ok(());
    }
    let feed: Feed = super::response(remote.request(Method::GET, "v1/sync/image-gc")?).await?;
    if feed.capability != 1
        || feed.revision < 0
        || feed.cursor < 0
        || !super::super::valid_id(&feed.round_id)
    {
        return Err(super::protocol_error());
    }
    let roots=db.maintenance(|conn| {
        conn.execute("DELETE FROM image_gc_remote WHERE instance_id<>?1 OR epoch<>?2",params![remote.binding.instance_id,remote.binding.epoch])?;
        for copy in &feed.copies {
            let hash=copy["sha256"].as_str().filter(|h|valid_hash(h)).ok_or_else(super::protocol_error)?;
            let id=copy["id"].as_str().ok_or_else(super::protocol_error)?;
            let state=copy["state"].as_str().ok_or_else(super::protocol_error)?;
            crate::assets::version_cleanup::s3::import_remote(conn,copy,feed.jobs.iter().find(|job|job["copy_id"]==copy["id"]).unwrap_or(&Value::Null))?;
            conn.execute("INSERT INTO image_gc_remote VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(copy_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json",
                params![id,hash,state,remote.binding.instance_id,remote.binding.epoch,{
                    let mut payload=copy.clone();
                    payload["roundId"]=json!(feed.round_id);
                    payload["job"]=feed.jobs.iter().find(|job|job["copy_id"]==copy["id"]).cloned().unwrap_or(Value::Null);
                    payload.to_string()
                }])?;
        }
        // Resolve live replacements after importing the whole feed, independent of UUID order.
        conn.execute("UPDATE asset_locations AS l SET (object_key,public_url,content_sha256)=(SELECT c.object_key,c.public_url,c.content_sha256 FROM image_public_copies c WHERE c.sha256=l.sha256 AND c.profile_id=l.storage_profile_id AND c.state='live' ORDER BY c.id LIMIT 1),uploaded_at=?1,deleted_at=NULL WHERE l.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM image_public_copies c WHERE c.sha256=l.sha256 AND c.profile_id=l.storage_profile_id AND c.state='live')",[crate::db::now()])?;
        for candidate in &feed.candidates {
            let hash=candidate["sha256"].as_str().filter(|h|valid_hash(h)).ok_or_else(super::protocol_error)?;
            conn.execute("INSERT INTO image_gc_barriers VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(sha256) DO UPDATE SET instance_id=excluded.instance_id,epoch=excluded.epoch,round_id=excluded.round_id,revision=excluded.revision,cursor=excluded.cursor",
                params![hash,remote.binding.instance_id,remote.binding.epoch,feed.round_id,feed.revision,feed.cursor])?;
        }
        if !ack {return Ok(None);}
        let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_dirty) OR EXISTS(SELECT 1 FROM sync_outbox) OR EXISTS(SELECT 1 FROM sync_bootstrap)",[],|row|row.get(0))?;
        if pending {return Ok(None);}
        let roots=scan_remote(conn,crate::db::now())?.files.into_iter().filter(|file|
            file.reasons.iter().any(|reason| !matches!(reason,Protection::Missing)))
            .map(|file|file.sha256).collect::<BTreeSet<_>>();
        Ok(Some(roots))
    })?;
    let Some(roots) = roots else {
        return Ok(());
    };
    if progress(db)?.2 != feed.cursor {
        return Ok(());
    }
    post(
        remote,
        "checkpoint",
        json!({"roundId":feed.round_id,"revision":feed.revision,"cursor":feed.cursor,
        "capability":1,"complete":true,"barrierPersisted":true,"roots":roots}),
    )
    .await?;
    for candidate in &feed.candidates {
        let copy = feed
            .copies
            .iter()
            .find(|copy| copy["id"] == candidate["id"]);
        if copy.is_none_or(|copy| {
            copy["backend"] != "private"
                || copy["dueAt"]
                    .as_i64()
                    .is_none_or(|due| due > crate::db::now())
        }) {
            continue;
        }
        match post(
            remote,
            "delete",
            json!({"copyId":candidate["id"],"roundId":feed.round_id}),
        )
        .await
        {
            Ok(job) => {
                post(remote, "run", json!({"jobId":job["id"]})).await?;
            }
            Err(error) if error.code() == "SYNC_GC_NOT_ELIGIBLE" => {}
            Err(error) => return Err(error),
        }
        break;
    }
    for job in &feed.jobs {
        let Some(copy) = feed
            .copies
            .iter()
            .find(|copy| copy["id"] == job["copy_id"] && copy["backend"] == "private")
        else {
            continue;
        };
        let _ = copy;
        let state = job["state"].as_str().ok_or_else(super::protocol_error)?;
        if matches!(
            state,
            "claimed" | "backing_up" | "deleting" | "failed" | "unknown"
        ) {
            post(remote, "run", json!({"jobId":job["id"]})).await?;
            break;
        }
        if matches!(state, "retired" | "restored" | "expiring")
            && job["expires_at"]
                .as_i64()
                .is_some_and(|due| due <= crate::db::now())
        {
            match post(remote, "expire", json!({"jobId":job["id"]})).await {
                Err(error) if error.code() == "SYNC_GC_RETAINED" => continue,
                result => {
                    result?;
                }
            }
            break;
        }
    }
    Ok(())
}

pub(super) async fn prepare_references(
    db: &Workspace,
    assets: &Assets,
    remote: &Remote<'_>,
    operation: &Operation,
) -> Result<()> {
    if remote.image_gc != 1 {
        return Ok(());
    }
    let mut ids = BTreeSet::new();
    for mutation in &operation.mutations {
        if !matches!(
            mutation.key.entity_type,
            super::Kind::Entry | super::Kind::CollectionNode | super::Kind::ImageProject
        ) {
            continue;
        }
        let Some(data) = mutation.payload.as_ref() else {
            continue;
        };
        for id in data["assetIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            ids.insert(id.to_owned());
        }
        for field in ["coverAssetId", "assetId", "baseAssetId"] {
            if let Some(id) = data[field].as_str() {
                ids.insert(id.to_owned());
            }
        }
    }
    let hashes=db.read(|conn| {
        let mut hashes=BTreeSet::new();
        for id in &ids {
            let mut query=conn.prepare("WITH RECURSIVE refs(id) AS (SELECT ?1 UNION SELECT a.value FROM refs r JOIN image_renders x ON x.output_asset_id=r.id,json_each(x.asset_ids_json) a) SELECT DISTINCT a.sha256 FROM refs r JOIN assets a ON a.id=r.id JOIN image_gc_remote g ON g.sha256=a.sha256 WHERE g.state NOT IN ('live','waiting') AND ((g.payload_json->>'$.backend'='private' AND g.payload_json->>'$.current'=1) OR (g.payload_json->>'$.backend'='s3' AND g.payload_json->>'$.job.restored_copy_id' IS NULL))")?;
            hashes.extend(query.query_map([id],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok(hashes)
    })?;
    for hash in hashes {
        let urls=db.read(|conn|{let mut query=conn.prepare("SELECT public_url FROM image_public_copies WHERE sha256=?1 AND state IN ('removed','deleting','restoring')")?;Ok(query.query_map([&hash],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)})?;
        assets.restore_public_versions(db, &urls.join("\n")).await?;
        post(remote, "restore", json!({"sha256":hash,"retain":false})).await?;
    }
    Ok(())
}

pub(crate) async fn protect(db: &Workspace, hashes: &BTreeSet<String>) -> Result<()> {
    let hashes=db.read(|conn|{
        let mut result=BTreeSet::new();
        for hash in hashes {if conn.query_row("SELECT EXISTS(SELECT 1 FROM image_gc_barriers WHERE sha256=?1) OR EXISTS(SELECT 1 FROM image_public_copies WHERE sha256=?1 AND remote=1)",[hash],|row|row.get::<_,bool>(0))? {result.insert(hash.clone());}}
        Ok(result)
    })?;
    if hashes.is_empty() {
        return Ok(());
    }
    if super::super::Binding::read(db)?.is_none() {
        return Ok(());
    }
    let sync = super::SyncConnection::new()?;
    let remote = Remote::open(db, &sync).await?;
    if remote.image_gc != 1 {
        return Ok(());
    }
    for hash in &hashes {
        post(&remote, "restore", json!({"sha256":hash,"retain":false}))
            .await
            .or_else(|error| {
                if error.code() == "SYNC_BLOB_NOT_FOUND" {
                    Ok(Value::Null)
                } else {
                    Err(error)
                }
            })?;
    }
    post(
        &remote,
        "protect",
        json!({"hashes":hashes,"owner":crate::db::id()}),
    )
    .await?;
    Ok(())
}

pub(crate) async fn public_request(
    db: &Workspace,
    route: &str,
    input: Value,
) -> Result<Option<Value>> {
    if super::super::Binding::read(db)?.is_none() {
        return Ok(None);
    }
    let sync = super::SyncConnection::new()?;
    let remote = Remote::open(db, &sync).await?;
    if remote.image_gc != 1 {
        return Ok(None);
    }
    Ok(Some(post(&remote, route, input).await?))
}
pub(crate) async fn public_backup(
    db: &Workspace,
    job: &str,
    bytes: Option<Vec<u8>>,
) -> Result<Vec<u8>> {
    let sync = super::SyncConnection::new()?;
    let remote = Remote::open(db, &sync).await?;
    if remote.image_gc != 1 {
        return Err(crate::db::AppError::new(
            "SYNC_SERVER_UPDATE",
            "同步服务不支持图片回收",
        ));
    }
    let request = remote.request(
        if bytes.is_some() {
            Method::PUT
        } else {
            Method::GET
        },
        &format!("v1/sync/image-gc/public/backup/{job}"),
    )?;
    let response = super::send(if let Some(bytes) = bytes {
        request.body(bytes)
    } else {
        request
    })
    .await?;
    Ok(response
        .bytes()
        .await
        .map_err(super::network_error)?
        .to_vec())
}

pub(crate) async fn restore_blob(db: &Workspace, hash: &str) -> Result<()> {
    let known=db.read(|conn|Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM image_gc_remote g JOIN sync_binding b ON b.instance_id=g.instance_id AND b.epoch=g.epoch WHERE g.sha256=?1 AND g.payload_json->>'$.backend'='private')",[hash],|row|row.get::<_,bool>(0))?))?;
    if !known {
        return Ok(());
    }
    public_request(db, "restore", json!({"sha256":hash,"retain":false})).await?;
    Ok(())
}

pub(super) async fn history_only(
    db: &Workspace,
    remote: &Remote<'_>,
    asset_id: &str,
    data: &Value,
) -> Result<bool> {
    if remote.image_gc != 1
        || !data["sourceKey"]
            .as_str()
            .is_some_and(|key| key.starts_with("image-render:"))
    {
        return Ok(false);
    }
    let Some(hash) = data["sha256"].as_str() else {
        return Ok(false);
    };
    let retired=db.read(|conn|{
        let file=scan_remote(conn,crate::db::now())?.files.into_iter().find(|file|file.sha256==hash);
        let unused=file.is_some_and(|f|f.reasons.iter().all(|reason|matches!(reason,Protection::Missing|Protection::Backup)));
        if !unused{return Ok((false,false));}
        let cloud:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM image_gc_remote WHERE sha256=?1 AND state IN ('deleting','retired','expired','restoring') AND payload_json->>'$.current'=1)",[hash],|r|r.get(0))?;
        let local:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM image_version_cleanup WHERE sha256=?1 AND state='expired') AND EXISTS(SELECT 1 FROM sync_progress WHERE seeding=1)",[hash],|r|r.get(0))?;
        Ok((cloud,local))
    })?;
    if retired.0 {
        return Ok(true);
    }
    if retired.1 {
        post(remote,"import",json!({"assetId":asset_id,"sha256":hash,"sourceKey":data["sourceKey"],"bytes":data["bytes"]})).await?;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
#[path = "image_gc_tests.rs"]
mod tests;
