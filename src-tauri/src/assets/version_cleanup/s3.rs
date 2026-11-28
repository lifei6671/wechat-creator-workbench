use crate::{
    assets::{
        Assets,
        s3::{Profile, S3Storage, sdk_error},
    },
    db::{AppError, Result, Workspace, id, now, workspace_id},
};
use aws_sdk_s3::primitives::ByteStream;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) fn scope(profile: &Profile) -> String {
    hex::encode(Sha256::digest(format!(
        "{}\n{}",
        profile.target.endpoint, profile.target.bucket
    )))
}
pub(crate) struct Managed {
    pub id: String,
    pub key: String,
    pub generation: String,
}

pub(crate) async fn reserve(
    db: &Workspace,
    profile: &Profile,
    hash: &str,
    content: &str,
    size: usize,
    extension: &str,
) -> Result<Managed> {
    let existing=db.read(|conn|Ok(conn.query_row("SELECT id,object_key,generation FROM image_public_copies WHERE sha256=?1 AND profile_id=?2 AND content_sha256=?3 AND state='uploading' ORDER BY id LIMIT 1",params![hash,profile.id,content],|row|Ok(Managed{id:row.get(0)?,key:row.get(1)?,generation:row.get(2)?})).optional()?))?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let prefix = db.read(|conn| {
        Ok(profile
            .target
            .key(&workspace_id(conn)?, &format!("wcbgc/{}/", profile.id)))
    })?;
    let input = json!({"sha256":hash,"contentSha256":content,"scope":scope(profile),"prefix":prefix,"bytes":size,"format":extension});
    let remote = crate::sync::contents::image_public_request(db, "public/reserve", input).await?;
    let remote_managed = remote.is_some();
    let (copy, generation, key) = if let Some(value) = remote {
        (
            value["copyId"].as_str().ok_or_else(protocol)?.to_owned(),
            value["generation"]
                .as_str()
                .ok_or_else(protocol)?
                .to_owned(),
            value["key"].as_str().ok_or_else(protocol)?.to_owned(),
        )
    } else {
        let copy = id();
        let generation = id();
        let key = format!("{prefix}wcbgc-s3-{generation}.{extension}");
        (copy, generation, key)
    };
    // Old servers cannot coordinate public GC, so their new uploads remain conservatively protected.
    let bound = db.read(|conn| {
        Ok(
            conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_binding)", [], |row| {
                row.get::<_, bool>(0)
            })?,
        )
    })?;
    let managed = !(bound && !remote_managed);
    db.maintenance(|conn|{
        conn.execute("INSERT INTO image_public_copies(id,sha256,profile_id,scope,object_key,generation,content_sha256,bytes,public_url,state,remote) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![copy,hash,profile.id,scope(profile),key,generation,content,size as i64,profile.target.public_url(&key),if managed{"uploading"}else{"legacy"},remote_managed])?;
        if !managed {conn.execute("INSERT OR IGNORE INTO asset_public_protection VALUES(?1,?2)",params![hash,now()])?;}
        Ok(())
    })?;
    Ok(Managed {
        id: copy,
        key,
        generation,
    })
}
pub(crate) async fn resolve_upload(
    db: &Workspace,
    profile: &Profile,
    managed: &Managed,
) -> Result<()> {
    let (hash, size) = db.read(|conn| {
        Ok(conn.query_row(
            "SELECT content_sha256,bytes FROM image_public_copies WHERE id=?1",
            [&managed.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?)
    })?;
    let store = profile.provider()?;
    let bytes = match store.get(&managed.key).await {
        Ok(bytes) => bytes,
        Err(error) if error.code() == "S3_NOT_FOUND" => return Ok(()),
        Err(error) => return Err(error),
    };
    checksum(&bytes, &hash, size)?;
    let head = store
        .client
        .head_object()
        .bucket(&store.bucket)
        .key(&managed.key)
        .send()
        .await
        .map_err(|error| sdk_error("核验", &error))?;
    if head.metadata().and_then(|meta| meta.get("wcb-image-copy")) != Some(&managed.id)
        || head
            .metadata()
            .and_then(|meta| meta.get("wcb-image-generation"))
            != Some(&managed.generation)
    {
        return Err(AppError::new(
            "IMAGE_CLEANUP_CHANGED",
            "图床对象归属与登记记录不一致",
        ));
    }
    committed(db, managed, head.version_id().map(str::to_owned)).await
}

pub(crate) fn registered(
    db: &Workspace,
    profile: &Profile,
    hash: &str,
    key: &str,
) -> Result<Option<Managed>> {
    db.read(|conn|Ok(conn.query_row("SELECT id,object_key,generation FROM image_public_copies WHERE sha256=?1 AND profile_id=?2 AND object_key=?3 AND state='uploading'",params![hash,profile.id,key],|row|Ok(Managed{id:row.get(0)?,key:row.get(1)?,generation:row.get(2)?})).optional()?))
}
pub(crate) fn is_managed(db: &Workspace, profile: &Profile, hash: &str, key: &str) -> Result<bool> {
    db.read(|conn|Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM image_public_copies WHERE sha256=?1 AND profile_id=?2 AND object_key=?3)",params![hash,profile.id,key],|row|row.get(0))?))
}
fn protocol() -> AppError {
    AppError::new("IMAGE_CLEANUP_PROTOCOL", "图片回收服务返回的数据无效")
}
pub(crate) fn import_remote(conn: &rusqlite::Connection, copy: &Value, job: &Value) -> Result<()> {
    if copy["backend"] != "s3" {
        return Ok(());
    }
    let mut query = conn.prepare("SELECT id FROM storage_profiles WHERE purpose='images'")?;
    let ids = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let profile = ids
        .into_iter()
        .map(|id| Profile::read(conn, &id))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .find(|profile| scope(profile) == copy["scope"].as_str().unwrap_or(""));
    let Some(profile) = profile else {
        return Ok(());
    };
    let generated = profile
        .target
        .public_url(copy["key"].as_str().ok_or_else(protocol)?);
    let url = copy["publicUrl"].as_str().unwrap_or(&generated);
    let state = if job["restored_copy_id"].is_string() {
        "superseded"
    } else if job["state"] == "restoring" {
        "restoring"
    } else {
        match copy["state"].as_str() {
            Some("retired") => "removed",
            Some(state) => state,
            None => return Err(protocol()),
        }
    };
    let string = |field: &str| copy[field].as_str().ok_or_else(protocol);
    conn.execute("INSERT INTO image_public_copies(id,sha256,profile_id,scope,object_key,generation,content_sha256,bytes,public_url,object_version,state,remote,due_at,expires_at,job_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,?13,?14) ON CONFLICT(id) DO UPDATE SET job_id=COALESCE(excluded.job_id,job_id),expires_at=COALESCE(excluded.expires_at,expires_at),state=excluded.state",
        params![string("id")?,string("sha256")?,profile.id,string("scope")?,string("key")?,string("generation")?,string("contentSha256")?,copy["bytes"].as_i64().ok_or_else(protocol)?,url,copy["version"].as_str(),state,copy["dueAt"].as_i64(),job["expires_at"].as_i64(),job["id"].as_str()])?;
    if state == "uploading" {
        conn.execute("INSERT OR IGNORE INTO asset_locations(sha256,storage_profile_id,object_key,public_url,content_sha256) VALUES(?1,?2,?3,?4,?5)",params![string("sha256")?,profile.id,string("key")?,url,string("contentSha256")?])?;
    }
    if state == "live" || state == "waiting" {
        conn.execute("INSERT INTO asset_locations(sha256,storage_profile_id,object_key,public_url,uploaded_at,content_sha256) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(sha256,storage_profile_id) DO UPDATE SET object_key=excluded.object_key,public_url=excluded.public_url,uploaded_at=excluded.uploaded_at,deleted_at=NULL,content_sha256=excluded.content_sha256 WHERE asset_locations.deleted_at IS NOT NULL",
            params![string("sha256")?,profile.id,string("key")?,url,now(),string("contentSha256")?])?;
    } else if state != "uploading" {
        conn.execute("UPDATE asset_locations SET deleted_at=?3 WHERE sha256=?1 AND storage_profile_id=?2 AND object_key=?4",params![string("sha256")?,profile.id,now(),string("key")?])?;
    }
    conn.execute("INSERT OR IGNORE INTO asset_urls SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM asset_locations WHERE sha256=?2 AND storage_profile_id=?3)",params![url,string("sha256")?,profile.id])?;
    Ok(())
}
fn checksum(bytes: &[u8], hash: &str, size: i64) -> Result<()> {
    if bytes.len() as i64 != size || hex::encode(Sha256::digest(bytes)) != hash {
        return Err(AppError::new(
            "IMAGE_CLEANUP_CHANGED",
            "图床图片字节与登记记录不一致",
        ));
    }
    Ok(())
}
pub(crate) async fn put(
    store: &S3Storage,
    managed: &Managed,
    mime: &str,
    bytes: Vec<u8>,
) -> Result<Option<String>> {
    store
        .client
        .put_object()
        .bucket(&store.bucket)
        .key(&managed.key)
        .content_type(mime)
        .metadata("wcb-image-copy", &managed.id)
        .metadata("wcb-image-generation", &managed.generation)
        .body(ByteStream::from(bytes))
        .send()
        .await
        .map_err(|error| sdk_error("上传", &error))?;
    let head = store
        .client
        .head_object()
        .bucket(&store.bucket)
        .key(&managed.key)
        .send()
        .await
        .map_err(|error| sdk_error("核验", &error))?;
    if head.metadata().and_then(|map| map.get("wcb-image-copy")) != Some(&managed.id) {
        return Err(AppError::new(
            "IMAGE_CLEANUP_CHANGED",
            "图床对象归属与登记记录不一致",
        ));
    }
    Ok(head.version_id().map(str::to_owned))
}
pub(crate) async fn committed(
    db: &Workspace,
    managed: &Managed,
    version: Option<String>,
) -> Result<()> {
    let (remote, url) = db.read(|conn| {
        Ok(conn.query_row(
            "SELECT remote,public_url FROM image_public_copies WHERE id=?1",
            [&managed.id],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, String>(1)?)),
        )?)
    })?;
    if remote {
        crate::sync::contents::image_public_request(
            db,
            "public/commit",
            json!({"copyId":managed.id,"publicUrl":url,"version":version}),
        )
        .await?;
    }
    db.maintenance(|conn|{conn.execute("UPDATE image_public_copies SET state=CASE WHEN state='legacy' THEN state ELSE 'live' END,object_version=?2,error=NULL WHERE id=?1",params![managed.id,version])?;Ok(())})
}

struct Copy {
    id: String,
    hash: String,
    profile: String,
    scope: String,
    key: String,
    generation: String,
    content: String,
    bytes: i64,
    state: String,
    remote: bool,
    backup: Option<String>,
    job: Option<String>,
}
fn copies(db: &Workspace) -> Result<Vec<Copy>> {
    db.read(|conn|{let mut query=conn.prepare("SELECT id,sha256,profile_id,scope,object_key,generation,content_sha256,bytes,state,remote,backup_path,job_id FROM image_public_copies WHERE state NOT IN ('legacy','uploading') ORDER BY id")?;
        Ok(query.query_map([],|r|Ok(Copy{id:r.get(0)?,hash:r.get(1)?,profile:r.get(2)?,scope:r.get(3)?,key:r.get(4)?,generation:r.get(5)?,content:r.get(6)?,bytes:r.get(7)?,state:r.get(8)?,remote:r.get(9)?,backup:r.get(10)?,job:r.get(11)?}))?.collect::<rusqlite::Result<_>>()?)})
}
fn check_binding(db: &Workspace, copy: &Copy) -> Result<()> {
    if !copy.remote {
        return Ok(());
    }
    let binding = db.read(|conn| {
        Ok(conn
            .query_row("SELECT instance_id,epoch FROM sync_binding", [], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .optional()?)
    })?;
    let matches = binding.is_some_and(|(instance, epoch)| {
        copy.key.rsplit('/').next().is_some_and(|name| {
            name.starts_with(&format!("wcbgc-s3-{instance}-{epoch}-{}.", copy.generation))
        })
    });
    if !matches {
        return Err(AppError::new(
            "IMAGE_CLEANUP_CONNECTION",
            "图片属于另一同步连接，请恢复原连接或重新导入图片",
        ));
    }
    Ok(())
}
fn profile(db: &Workspace, copy: &Copy) -> Result<Profile> {
    let p = db.read(|conn| Profile::read(conn, &copy.profile))?;
    if scope(&p) != copy.scope {
        return Err(AppError::new(
            "IMAGE_CLEANUP_CHANGED",
            "图床配置已变化，保留旧位置",
        ));
    }
    Ok(p)
}

impl Assets {
    pub(crate) async fn maintain_public_versions(&self, db: &Workspace) -> Result<()> {
        for copy in copies(db)? {
            if copy.remote && check_binding(db, &copy).is_err() {
                continue;
            }
            if copy.state == "expired" {
                if copy.remote && copy.backup.is_some() {
                    self.expire_public(db, &copy).await?;
                }
                continue;
            }
            if matches!(
                copy.state.as_str(),
                "removed" | "restored" | "superseded" | "expiring"
            ) {
                self.expire_public(db, &copy).await?;
                continue;
            }
            if copy.state == "restoring" {
                continue;
            }
            let candidate = db.read(|conn| {
                Ok(super::scan_remote(conn, now())?
                    .files
                    .into_iter()
                    .find(|f| f.sha256 == copy.hash)
                    .is_some_and(|f| {
                        f.reasons
                            .iter()
                            .all(|r| matches!(r, super::Protection::Missing))
                    }))
            })?;
            if !candidate {
                db.maintenance(|conn|{conn.execute("UPDATE image_public_copies SET state='live',due_at=NULL WHERE id=?1 AND state='waiting'",[&copy.id])?;Ok(())})?;
                continue;
            }
            let job = if copy.remote {
                let data = db.read(|conn| {
                    Ok(conn
                        .query_row(
                            "SELECT payload_json FROM image_gc_remote WHERE copy_id=?1",
                            [&copy.id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?)
                })?;
                let Some(data) = data else {
                    continue;
                };
                let data: Value = serde_json::from_str(&data).map_err(|_| protocol())?;
                if let Some(job) = data["job"]["id"].as_str() {
                    Some(job.to_owned())
                } else {
                    if data["state"] != "waiting"
                        || data["dueAt"].as_i64().is_none_or(|due| due > now())
                    {
                        continue;
                    }
                    let value = crate::sync::contents::image_public_request(
                        db,
                        "delete",
                        json!({"copyId":copy.id,"roundId":data["roundId"]}),
                    )
                    .await?;
                    Some(
                        value.ok_or_else(protocol)?["id"]
                            .as_str()
                            .ok_or_else(protocol)?
                            .to_owned(),
                    )
                }
            } else {
                let due=db.maintenance(|conn|{conn.execute("UPDATE image_public_copies SET state='waiting',due_at=?2 WHERE id=?1 AND state='live'",params![copy.id,now()+super::WAIT_MS])?;
                    Ok(conn.query_row("SELECT due_at FROM image_public_copies WHERE id=?1",[&copy.id],|row|row.get::<_,Option<i64>>(0))?)})?;
                if due.is_none_or(|due| due > now()) {
                    continue;
                }
                None
            };
            let result = self.recycle_public(db, &copy, job.as_deref()).await;
            if let Err(error) = &result {
                db.maintenance(|conn| {
                    conn.execute(
                        "UPDATE image_public_copies SET error=?2 WHERE id=?1",
                        params![copy.id, error.to_string()],
                    )?;
                    Ok(())
                })?;
            }
            result?;
            break;
        }
        Ok(())
    }

    async fn recycle_public(&self, db: &Workspace, copy: &Copy, job: Option<&str>) -> Result<()> {
        let p = profile(db, copy)?;
        let store = p.provider()?;
        let backup = format!(
            ".image-version-recycle/public/{}/{}.bin",
            copy.id, copy.content
        );
        let data = match store.get(&copy.key).await {
            Ok(data) => data,
            Err(error) if error.code() == "S3_NOT_FOUND" => {
                if let Some(job) = job {
                    crate::sync::contents::image_public_backup(db, job, None).await?
                } else {
                    std::fs::read(super::tasks::path(&self.root, &backup)?)
                        .map_err(crate::assets::local_error)?
                }
            }
            Err(error) => return Err(error),
        };
        checksum(&data, &copy.content, copy.bytes)?;
        super::tasks::durable_write(&self.root, &backup, &data)?;
        checksum(
            &std::fs::read(super::tasks::path(&self.root, &backup)?)
                .map_err(crate::assets::local_error)?,
            &copy.content,
            copy.bytes,
        )?;
        if let Some(job) = job {
            crate::sync::contents::image_public_backup(db, job, Some(data)).await?;
        }
        db.write(|conn|{
            let eligible=super::scan_remote(conn,now())?.files.into_iter().find(|file|file.sha256==copy.hash)
                .is_some_and(|file|file.reasons.iter().all(|r|matches!(r,super::Protection::Missing)));
            if !eligible && copy.state!="deleting" {return Err(AppError::new("IMAGE_CLEANUP_REFERENCED","图片已有新的引用，停止回收"));}
            conn.execute("UPDATE image_public_copies SET state='deleting',backup_path=?2,job_id=?3 WHERE id=?1",params![copy.id,backup,job])?;Ok(())
        })?;
        // Both key ownership and an exact version/ETag are checked immediately before removal.
        match store
            .client
            .head_object()
            .bucket(&store.bucket)
            .key(&copy.key)
            .send()
            .await
        {
            Ok(head) => {
                if head.metadata().and_then(|map| map.get("wcb-image-copy")) != Some(&copy.id)
                    || head
                        .metadata()
                        .and_then(|map| map.get("wcb-image-generation"))
                        != Some(&copy.generation)
                {
                    return Err(AppError::new(
                        "IMAGE_CLEANUP_CHANGED",
                        "图床对象归属已变化，停止回收",
                    ));
                }
                let etag = head.e_tag().ok_or_else(|| {
                    AppError::new("IMAGE_CLEANUP_CHANGED", "图床未提供对象校验标识")
                })?;
                let mut read = store
                    .client
                    .get_object()
                    .bucket(&store.bucket)
                    .key(&copy.key)
                    .if_match(etag);
                if let Some(version) = head.version_id().filter(|version| *version != "null") {
                    read = read.version_id(version);
                }
                let mut body = read
                    .send()
                    .await
                    .map_err(|error| sdk_error("复核", &error))?
                    .body;
                let mut verified = Vec::new();
                while let Some(chunk) = body
                    .try_next()
                    .await
                    .map_err(|error| AppError::new("S3_NETWORK", error.to_string()))?
                {
                    if verified.len().saturating_add(chunk.len()) > crate::assets::MAX_BYTES {
                        return Err(AppError::new("IMAGE_CLEANUP_CHANGED", "图床对象大小已变化"));
                    }
                    verified.extend_from_slice(&chunk);
                }
                checksum(&verified, &copy.content, copy.bytes)?;
                let mut delete = store
                    .client
                    .delete_object()
                    .bucket(&store.bucket)
                    .key(&copy.key);
                if let Some(version) = head.version_id().filter(|version| *version != "null") {
                    delete = delete.version_id(version);
                } else {
                    delete = delete.if_match(head.e_tag().ok_or_else(|| {
                        AppError::new("IMAGE_CLEANUP_CHANGED", "图床未提供对象校验标识")
                    })?);
                }
                delete
                    .send()
                    .await
                    .map_err(|error| sdk_error("删除", &error))?;
                // A versioned bucket may expose an older version after removal. Keep that location protected.
                match store
                    .client
                    .head_object()
                    .bucket(&store.bucket)
                    .key(&copy.key)
                    .send()
                    .await
                {
                    Ok(_) => {
                        return Err(AppError::new(
                            "IMAGE_CLEANUP_CHANGED",
                            "图床地址仍有对象，保留回收记录",
                        ));
                    }
                    Err(error) if sdk_error("核验", &error).code() == "S3_NOT_FOUND" => {}
                    Err(error) => return Err(sdk_error("核验", &error)),
                }
            }
            Err(error) if sdk_error("核验", &error).code() == "S3_NOT_FOUND" => {}
            Err(error) => return Err(sdk_error("核验", &error)),
        }
        if let Some(job) = job {
            crate::sync::contents::image_public_request(
                db,
                "public/complete",
                json!({"jobId":job}),
            )
            .await?;
        }
        db.maintenance(|conn|{
            conn.execute("UPDATE image_public_copies SET state=CASE WHEN state='superseded' THEN state ELSE 'removed' END,expires_at=?2,error=NULL WHERE id=?1",params![copy.id,now()+super::RECOVERY_MS])?;
            conn.execute("UPDATE asset_locations SET deleted_at=?3 WHERE sha256=?1 AND storage_profile_id=?2 AND object_key=?4",params![copy.hash,copy.profile,now(),copy.key])?;Ok(())
        })
    }

    async fn expire_public(&self, db: &Workspace, copy: &Copy) -> Result<()> {
        let eligible=db.read(|conn|Ok(conn.query_row("SELECT expires_at<=?2 AND state IN ('removed','superseded','expiring','expired') FROM image_public_copies WHERE id=?1",params![copy.id,now()],|row|row.get::<_,Option<bool>>(0))?.unwrap_or(false)))?;
        if !eligible {
            return Ok(());
        }
        if copy.state == "superseded" {
            let current=db.read(|conn|Ok(conn.query_row("SELECT object_key FROM image_public_copies WHERE scope=?1 AND sha256=?2 AND content_sha256=?3 AND state='live' ORDER BY id LIMIT 1",params![copy.scope,copy.hash,copy.content],|row|row.get::<_,String>(0)).optional()?))?.ok_or_else(||AppError::new("IMAGE_CLEANUP_REFERENCED","恢复副本尚未就绪"))?;
            let data = profile(db, copy)?.provider()?.get(&current).await?;
            checksum(&data, &copy.content, copy.bytes)?;
        }
        if copy.remote {
            match crate::sync::contents::image_public_request(
                db,
                "public/expire",
                json!({"jobId":copy.job}),
            )
            .await
            {
                Err(error) if error.code() == "SYNC_GC_RETAINED" => return Ok(()),
                result => {
                    result?;
                }
            }
        } else {
            let retained=db.write(|conn|{
                let protected=super::scan_remote(conn,now())?.files.into_iter().find(|f|f.sha256==copy.hash).is_some_and(|f|f.reasons.iter().any(|r|!matches!(r,super::Protection::Missing|super::Protection::Backup)));
                if protected&&!matches!(copy.state.as_str(),"superseded"|"expiring") {return Ok(true);}
                let claimed=conn.execute("UPDATE image_public_copies SET state='expiring' WHERE id=?1 AND state IN ('removed','superseded','expiring')",[&copy.id])?;Ok(claimed==0)
            })?;
            if retained {
                return Ok(());
            }
        }
        if let Some(backup) = &copy.backup {
            let location = super::tasks::path(&self.root, backup)?;
            if location.try_exists().map_err(crate::assets::local_error)? {
                checksum(
                    &std::fs::read(&location).map_err(crate::assets::local_error)?,
                    &copy.content,
                    copy.bytes,
                )?;
                std::fs::remove_file(location).map_err(crate::assets::local_error)?;
            }
        }
        db.maintenance(|conn|{conn.execute("UPDATE image_public_copies SET state=CASE WHEN state='superseded' THEN state ELSE 'expired' END,backup_path=NULL,expires_at=NULL,error=NULL WHERE id=?1",[&copy.id])?;Ok(())})
    }

    pub(crate) async fn restore_public_versions(
        &self,
        db: &Workspace,
        payload: &str,
    ) -> Result<String> {
        let mut rewritten = payload.to_owned();
        for copy in copies(db)? {
            let old = db.read(|conn| {
                Ok(conn.query_row(
                    "SELECT public_url FROM image_public_copies WHERE id=?1",
                    [&copy.id],
                    |row| row.get::<_, String>(0),
                )?)
            })?;
            if !rewritten.contains(&old) {
                continue;
            }
            check_binding(db, &copy)?;
            if copy.state == "expiring" {
                return Err(AppError::new(
                    "IMAGE_CLEANUP_BUSY",
                    "图片正在清理，请稍后重试",
                ));
            }
            if matches!(copy.state.as_str(), "superseded" | "expired") {
                let current=db.read(|conn|Ok(conn.query_row("SELECT public_url FROM image_public_copies WHERE scope=?1 AND sha256=?2 AND content_sha256=?3 AND state='live' ORDER BY id LIMIT 1",params![copy.scope,copy.hash,copy.content],|row|row.get::<_,String>(0)).optional()?))?;
                if let Some(current) = current {
                    rewritten = rewritten.replace(&old, &current);
                    continue;
                }
                return Err(AppError::new(
                    "IMAGE_VERSION_EXPIRED",
                    "旧图床地址已回收，且没有可用的同内容副本",
                ));
            }
            if !matches!(copy.state.as_str(), "deleting" | "removed" | "restoring") {
                continue;
            }
            db.write(|conn|{let count=conn.execute("UPDATE image_public_copies SET state='restoring' WHERE id=?1 AND state IN ('deleting','removed','restoring')",[&copy.id])?;
                if count==0{return Err(AppError::new("IMAGE_CLEANUP_BUSY","图片正在清理，请稍后重试"));}Ok(())})?;
            let p = profile(db, &copy)?;
            let data = if copy.remote {
                crate::sync::contents::image_public_backup(
                    db,
                    copy.job.as_deref().ok_or_else(protocol)?,
                    None,
                )
                .await?
            } else {
                std::fs::read(super::tasks::path(
                    &self.root,
                    copy.backup.as_deref().ok_or_else(protocol)?,
                )?)
                .map_err(crate::assets::local_error)?
            };
            checksum(&data, &copy.content, copy.bytes)?;
            let extension = copy.key.rsplit('.').next().ok_or_else(protocol)?;
            let next = reserve(db, &p, &copy.hash, &copy.content, data.len(), extension).await?;
            let store = p.provider()?;
            let (format, _, _) = crate::assets::image_header(&data)?;
            let version = put(&store, &next, format.to_mime_type(), data).await?;
            checksum(&store.get(&next.key).await?, &copy.content, copy.bytes)?;
            committed(db, &next, version).await?;
            if copy.remote {
                crate::sync::contents::image_public_request(
                    db,
                    "public/restored",
                    json!({"jobId":copy.job,"copyId":next.id}),
                )
                .await?;
            }
            let url = p.target.public_url(&next.key);
            db.maintenance(|conn|{
                conn.execute("UPDATE image_public_copies SET state='superseded' WHERE id=?1",[&copy.id])?;
                conn.execute("UPDATE asset_locations SET object_key=?3,public_url=?4,uploaded_at=?5,deleted_at=NULL,content_sha256=?6 WHERE sha256=?1 AND storage_profile_id=?2",params![copy.hash,copy.profile,next.key,url,now(),copy.content])?;
                conn.execute("INSERT OR IGNORE INTO asset_urls VALUES(?1,?2,?3)",params![url,copy.hash,copy.profile])?;Ok(())
            })?;
            rewritten = rewritten.replace(&old, &url);
        }
        Ok(rewritten)
    }
}

#[cfg(test)]
#[path = "s3_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) async fn acceptance_upload(assets: &Assets, db: &Workspace, asset: &str) -> Result<()> {
    assets.upload(db, asset)?;
    let upload = crate::assets::claim(db)?
        .ok_or_else(|| AppError::new("UPLOAD_MISSING", "缺少测试上传任务"))?;
    assets.perform_upload(db, &upload).await?;
    crate::assets::complete_upload(db, &upload, Ok(()))
}
