use super::{
    Binding, SyncConnection, connected, invalid_response, network_error, pause, response, send,
};
use crate::{
    assets::{Assets, sync as images},
    content::collections::sync as canvas,
    content::sync as entries,
    db::{AppError, Result, Workspace, id},
};
use reqwest::{Method, RequestBuilder, StatusCode};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::State;
use url::Url;

const MAX_BLOB: usize = 25 * 1024 * 1024;
const INLINE_BYTES: usize = 64 * 1024;
const MAX_ENTITY_BYTES: usize = 512 * 1024;
const MAX_GROUP: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Asset,
    Category,
    Entry,
    Collection,
    CollectionNode,
    CollectionEdge,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Category => "category",
            Self::Entry => "entry",
            Self::Collection => "collection",
            Self::CollectionNode => "collection_node",
            Self::CollectionEdge => "collection_edge",
        }
    }

    fn is_canvas(self) -> bool {
        matches!(
            self,
            Self::Collection | Self::CollectionNode | Self::CollectionEdge
        )
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Key {
    entity_type: Kind,
    entity_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entity {
    #[serde(flatten)]
    key: Key,
    remote_revision: i64,
    deleted_at: Option<i64>,
    payload: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    #[serde(flatten)]
    entity: Entity,
    cursor: i64,
    group_id: String,
    group_index: usize,
    group_size: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    server_instance_id: String,
    sync_epoch: String,
    changes: Vec<Change>,
    next_cursor: i64,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPage {
    server_instance_id: String,
    sync_epoch: String,
    entities: Vec<Entity>,
    next_after: Option<Key>,
    snapshot_start_cursor: Option<i64>,
    snapshot_end_cursor: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Mutation {
    #[serde(flatten)]
    key: Key,
    base_revision: i64,
    operation: String,
    payload: Option<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    operation_id: String,
    mutations: Vec<Mutation>,
}

#[derive(Deserialize)]
struct Receipt {
    results: Vec<Outcome>,
}

#[derive(Deserialize)]
struct Outcome {
    status: String,
    reason: Option<String>,
    versions: Option<Vec<Version>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    #[serde(flatten)]
    key: Key,
    remote_revision: i64,
}

struct Remote<'a> {
    sync: &'a SyncConnection,
    base: Url,
    token: String,
    binding: Binding,
}

impl<'a> Remote<'a> {
    async fn open(db: &Workspace, sync: &'a SyncConnection) -> Result<Self> {
        let (base, token) = connected(db, sync).await?;
        let binding = Binding::read(db)?.ok_or_else(|| AppError::invalid("请先连接同步服务"))?;
        Ok(Self {
            sync,
            base,
            token,
            binding,
        })
    }

    fn request(&self, method: Method, route: &str) -> Result<RequestBuilder> {
        let url = self.base.join(route).map_err(invalid_response)?;
        Ok(self
            .sync
            .client(&self.base)
            .request(method, url)
            .header("X-Sync-Instance", &self.binding.instance_id)
            .header("X-Sync-Epoch", &self.binding.epoch)
            .bearer_auth(&self.token))
    }

    fn check(&self, instance: &str, epoch: &str) -> Result<()> {
        if instance != self.binding.instance_id || epoch != self.binding.epoch {
            return Err(AppError::new("SYNC_RESET", "同步服务身份已变化"));
        }
        Ok(())
    }

    async fn seed(&self, action: &str) -> Result<()> {
        send(
            self.request(Method::POST, "v1/sync/seed")?
                .json(&json!({ "action": action })),
        )
        .await?;
        Ok(())
    }

    async fn upload(&self, hash: &str, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > MAX_BLOB {
            return Err(AppError::new("SYNC_SIZE", "单个同步附件不能超过 25 MiB"));
        }
        let route = blob_route(hash)?;
        let head = self
            .request(Method::HEAD, &route)?
            .send()
            .await
            .map_err(network_error)?;
        match head.status() {
            StatusCode::OK => return Ok(()),
            StatusCode::NOT_FOUND => {}
            StatusCode::CONFLICT => return Err(AppError::new("SYNC_RESET", "同步基线已失效")),
            _ => {
                return Err(AppError::new(
                    "SYNC_HTTP",
                    format!("无法检查同步附件（HTTP {}）", head.status()),
                ));
            }
        }
        send(self.request(Method::PUT, &route)?.body(bytes)).await?;
        Ok(())
    }

    async fn download(&self, hash: &str, size: i64) -> Result<Vec<u8>> {
        let size = usize::try_from(size)
            .ok()
            .filter(|size| *size <= MAX_BLOB)
            .ok_or_else(|| AppError::new("SYNC_SIZE", "同步附件长度无效"))?;
        let mut body = send(self.request(Method::GET, &blob_route(hash)?)?).await?;
        let mut data = Vec::with_capacity(size);
        while let Some(chunk) = body.chunk().await.map_err(network_error)? {
            if chunk.len() > size - data.len() {
                return Err(AppError::new("SYNC_BLOB", "同步附件长度与记录不一致"));
            }
            data.extend_from_slice(&chunk);
        }
        if data.len() != size || digest(&data) != hash {
            return Err(AppError::new("SYNC_BLOB", "同步附件摘要与记录不一致"));
        }
        Ok(data)
    }

    async fn hydrate(&self, entity: &mut Entity) -> Result<()> {
        let Some(hash) = entity.payload["contentBlobHash"].as_str() else {
            return Ok(());
        };
        if entity.payload["contentMd"].is_string() {
            return Ok(());
        }
        let size = entity.payload["contentBlobSize"]
            .as_i64()
            .ok_or_else(protocol_error)?;
        let bytes = self.download(hash, size).await?;
        entity.payload["contentMd"] =
            Value::String(String::from_utf8(bytes).map_err(invalid_response)?);
        Ok(())
    }

    async fn pull(&self, cursor: i64, through: Option<i64>) -> Result<Page> {
        let mut path = format!("v1/sync/pull?cursor={cursor}");
        if let Some(through) = through {
            use std::fmt::Write;
            write!(path, "&throughCursor={through}").expect("write to string");
        }
        let page: Page = response(self.request(Method::GET, &path)?).await?;
        self.check(&page.server_instance_id, &page.sync_epoch)?;
        if page.next_cursor < cursor || (page.has_more && page.next_cursor == cursor) {
            return Err(protocol_error());
        }
        Ok(page)
    }
}

fn blob_route(hash: &str) -> Result<String> {
    if !super::valid_token(hash) {
        return Err(protocol_error());
    }
    Ok(format!("v1/blobs/{hash}"))
}

fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn protocol_error() -> AppError {
    AppError::new("SYNC_PROTOCOL", "同步服务返回了无效的内容数据")
}

fn encode(value: &impl Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(invalid_response)
}

pub async fn synced_blob(db: &Workspace, hash: &str, size: i64) -> Result<Vec<u8>> {
    let sync = SyncConnection::new()?;
    let remote = Remote::open(db, &sync).await?;
    let result = remote.download(hash, size).await;
    if result
        .as_ref()
        .is_err_and(|error| error.code() == "SYNC_RESET")
    {
        pause(db)?;
    }
    result
}

pub fn record_category_delete(conn: &Connection, category: &str) -> Result<()> {
    let capture: bool =
        conn.query_row("SELECT capture FROM sync_progress", [], |row| row.get(0))?;
    if !capture {
        return Ok(());
    }
    let count: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM categories WHERE id=?1 OR parent_id=?1)
               +(SELECT COUNT(*) FROM entries WHERE category_id IN (SELECT id FROM categories WHERE id=?1 OR parent_id=?1))",
        [category], |row| row.get(0),
    )?;
    if count > MAX_GROUP as i64 {
        return Err(AppError::new(
            "SYNC_SIZE",
            "请先分批移出目录中的条目，再删除目录",
        ));
    }
    let batch = id();
    conn.execute(
        "UPDATE sync_dirty SET batch_id=?2 WHERE batch_id IN (
           SELECT batch_id FROM sync_dirty WHERE
             (entity_type='category' AND entity_id IN (SELECT id FROM categories WHERE id=?1 OR parent_id=?1))
             OR (entity_type='entry' AND entity_id IN
                (SELECT id FROM entries WHERE category_id IN (SELECT id FROM categories WHERE id=?1 OR parent_id=?1)))
        )", params![category,batch],
    )?;
    conn.execute("UPDATE sync_progress SET active_batch=?1", [batch])?;
    Ok(())
}

pub fn finish_category_delete(conn: &Connection) -> Result<()> {
    finish_delete(conn, "请先分批移出目录中的条目，再删除目录")
}

pub fn record_canvas_delete(conn: &Connection, target: &str, whole_canvas: bool) -> Result<()> {
    let capture: bool =
        conn.query_row("SELECT capture FROM sync_progress", [], |row| row.get(0))?;
    if !capture {
        return Ok(());
    }
    let batch = id();
    conn.execute(
        "WITH affected(entity_type,entity_id) AS (
           SELECT 'collection',id FROM collections WHERE ?2 AND id=?1
           UNION ALL SELECT 'collection_node',id FROM collection_nodes
             WHERE (?2 AND collection_id=?1) OR (NOT ?2 AND id=?1)
           UNION ALL SELECT 'collection_edge',id FROM collection_edges
             WHERE (?2 AND collection_id=?1) OR (NOT ?2 AND (source_node_id=?1 OR target_node_id=?1))
         )
         UPDATE sync_dirty SET batch_id=?3 WHERE batch_id IN (
           SELECT d.batch_id FROM sync_dirty d JOIN affected a USING(entity_type,entity_id)
         )", params![target,whole_canvas,batch],
    )?;
    conn.execute("UPDATE sync_progress SET active_batch=?1", [batch])?;
    Ok(())
}

pub fn finish_canvas_delete(conn: &Connection) -> Result<()> {
    finish_delete(conn, "请先分批删除卡片或连线，再删除专题或卡片")
}

fn finish_delete(conn: &Connection, message: &str) -> Result<()> {
    let Some(batch) = conn.query_row("SELECT active_batch FROM sync_progress", [], |row| {
        row.get::<_, Option<String>>(0)
    })?
    else {
        return Ok(());
    };
    let mut query =
        conn.prepare("SELECT entity_type,entity_id FROM sync_dirty WHERE batch_id=?1")?;
    let affected = query
        .query_map([batch], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let too_large = || AppError::new("SYNC_SIZE", message);
    if affected.len() > MAX_GROUP {
        return Err(too_large());
    }
    let force_blob = affected.len() > 1;
    let mut total = 512;
    for (kind, id) in affected {
        let entity_type = serde_json::from_value(Value::String(kind)).map_err(invalid_response)?;
        let key = Key {
            entity_type,
            entity_id: id,
        };
        let mut payload = local_snapshot(conn, &key)?.unwrap_or(Value::Null);
        offload_body(&mut payload, force_blob).map_err(|_| too_large())?;
        let size = encode(&payload)?.len();
        total += size + 512;
        if size > MAX_ENTITY_BYTES || total > 1024 * 1024 {
            return Err(too_large());
        }
    }
    conn.execute("UPDATE sync_progress SET active_batch=NULL", [])?;
    Ok(())
}

fn local_snapshot(conn: &Connection, key: &Key) -> Result<Option<Value>> {
    let id = &key.entity_id;
    match key.entity_type {
        Kind::Entry => entries::snapshot(conn, id),
        Kind::Collection => canvas::snapshot_topic(conn,id),
        Kind::CollectionNode => canvas::snapshot_card(conn,id),
        Kind::CollectionEdge => canvas::snapshot_link(conn,id),
        Kind::Asset => images::snapshot(conn,id)?.map(serde_json::to_value).transpose().map_err(invalid_response),
        Kind::Category => Ok(conn.query_row(
            "SELECT name,parent_id,sort_order,icon FROM categories WHERE id=?1",
            [id], |row| Ok(json!({
                "name": row.get::<_,String>(0)?, "parentId": row.get::<_,Option<String>>(1)?,
                "sortOrder": row.get::<_,i64>(2)?, "icon": row.get::<_,String>(3)?,
            })),
        ).optional()?),
    }
}

fn revision(conn: &Connection, key: &Key) -> Result<(i64, bool)> {
    Ok(conn
        .query_row(
            "SELECT revision,deleted FROM sync_revisions WHERE entity_type=?1 AND entity_id=?2",
            params![key.entity_type.key(), key.entity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, false)))
}

fn remember(conn: &Connection, key: &Key, revision: i64, deleted: bool) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_revisions VALUES (?1,?2,?3,?4)
        ON CONFLICT(entity_type,entity_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted",
        params![key.entity_type.key(),key.entity_id,revision,deleted],
    )?;
    Ok(())
}

const DIRTY_ORDER: &str = "CASE d.entity_type WHEN 'asset' THEN 0 WHEN 'category' THEN 1
    WHEN 'entry' THEN 2 WHEN 'collection' THEN 3 WHEN 'collection_node' THEN 4 ELSE 5 END,
    COALESCE((SELECT depth FROM categories WHERE d.entity_type='category' AND id=d.entity_id),3),
    COALESCE((SELECT kind='article' FROM entries WHERE d.entity_type='entry' AND id=d.entity_id),0),
    d.entity_id";

fn stage_outbox(db: &Workspace) -> Result<Option<(Operation, Vec<i64>)>> {
    db.write(|tx| {
        if let Some((action, versions)) = tx.query_row(
            "SELECT operation_json,generations_json FROM sync_outbox WHERE id=1",
            [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)),
        ).optional()? {
            return Ok(Some((serde_json::from_str(&action).map_err(invalid_response)?,
                serde_json::from_str(&versions).map_err(invalid_response)?)));
        }
        // A recovered local asset can be reused in a new draft after rebasing.
        tx.execute(
            "INSERT OR IGNORE INTO sync_dirty (entity_type,entity_id,generation)
             SELECT 'asset', requested.asset_id,1 FROM (
                SELECT a.asset_id FROM entry_assets a JOIN sync_dirty d ON d.entity_type='entry' AND d.entity_id=a.entry_id
                UNION
                SELECT e.cover_asset_id FROM entries e JOIN sync_dirty d ON d.entity_type='entry' AND d.entity_id=e.id
                WHERE e.cover_asset_id IS NOT NULL
                UNION
                SELECT n.asset_id FROM collection_nodes n JOIN sync_dirty d ON d.entity_type='collection_node' AND d.entity_id=n.id
                WHERE n.asset_id IS NOT NULL
             ) requested
             WHERE NOT EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='asset' AND r.entity_id=requested.asset_id)", [],
        )?;
        loop {
            let sql = format!(
                "SELECT d.entity_type,d.entity_id,d.batch_id FROM sync_dirty d
                 WHERE NOT EXISTS (SELECT 1 FROM sync_issues i WHERE
                    (i.entity_type,i.entity_id,i.generation)=(d.entity_type,d.entity_id,d.generation))
                 ORDER BY {DIRTY_ORDER} LIMIT 1"
            );
            let Some((kind,key,batch)) = tx.query_row(&sql, [], |row| Ok((
                row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?
            ))).optional()? else { return Ok(None); };
            let mut group = tx.prepare(
                "SELECT entity_type,entity_id,generation FROM sync_dirty
                 WHERE (entity_type,entity_id)=(?1,?2) OR (?3 IS NOT NULL AND batch_id=?3)
                 ORDER BY entity_type,entity_id"
            )?;
            let mut mutations = Vec::new();
            let mut generations = Vec::new();
            let mut queued_assets = false;
            for item in group.query_map(params![kind,key,batch], |row| Ok((
                row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?
            )))? {
                let (kind,id,generation) = item?;
                let entity_type = serde_json::from_value(Value::String(kind)).map_err(invalid_response)?;
                let key = Key { entity_type, entity_id: id };
                let payload = local_snapshot(tx,&key)?;
                if entity_type == Kind::CollectionNode && let Some(assets) = payload.as_ref().and_then(|value| value["assetIds"].as_array()) {
                    for asset in assets.iter().filter_map(Value::as_str) {
                        queued_assets |= tx.execute(
                            "INSERT OR IGNORE INTO sync_dirty (entity_type,entity_id,generation) SELECT 'asset',?1,1
                             WHERE NOT EXISTS(SELECT 1 FROM sync_revisions WHERE entity_type='asset' AND entity_id=?1)", [asset],
                        )? > 0;
                    }
                }
                let (base,was_deleted) = revision(tx,&key)?;
                if payload.is_none() && (base == 0 || was_deleted || entity_type == Kind::Asset) {
                    tx.execute("DELETE FROM sync_dirty WHERE (entity_type,entity_id)=(?1,?2)",
                        params![key.entity_type.key(),key.entity_id])?;
                    continue;
                }
                let missing = payload.as_ref().is_none_or(|payload| payload["deletedAt"].is_i64());
                let action = if missing { "delete" } else if was_deleted { "restore" } else { "upsert" };
                mutations.push(Mutation { key, base_revision: base, operation: action.into(), payload });
                generations.push(generation);
            }
            if mutations.is_empty() || queued_assets { continue; }
            let operation = Operation { operation_id: id(), mutations };
            tx.execute("INSERT INTO sync_outbox VALUES (1,?1,?2)", params![encode(&operation)?,encode(&generations)?])?;
            return Ok(Some((operation,generations)));
        }
    })
}

fn issue(
    conn: &Connection,
    key: &Key,
    generation: i64,
    reason: &str,
    remote: Option<&Entity>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_issues VALUES (?1,?2,?3,?4,?5)
        ON CONFLICT(entity_type,entity_id) DO UPDATE SET generation=excluded.generation,
          reason=excluded.reason,remote_json=COALESCE(excluded.remote_json,sync_issues.remote_json)",
        params![key.entity_type.key(),key.entity_id,generation,reason,remote.map(encode).transpose()?],
    )?;
    Ok(())
}

async fn prepare_uploads(
    db: &Workspace,
    assets: &Assets,
    remote: &Remote<'_>,
    operation: &mut Operation,
) -> Result<()> {
    let force_blob = operation.mutations.len() > 1;
    for mutation in &mut operation.mutations {
        let Some(data) = mutation.payload.as_mut() else {
            continue;
        };
        if mutation.key.entity_type == Kind::Asset {
            let asset = serde_json::from_value::<images::Snapshot>(data.clone())
                .map_err(invalid_response)?;
            if let Some(hash) = asset.sha256.as_deref() {
                let bytes = assets
                    .sync_upload_bytes(&mutation.key.entity_id, &asset, db)
                    .await?;
                remote.upload(hash, bytes).await?;
            }
        } else if let Some((hash, bytes)) = offload_body(data, force_blob)? {
            remote.upload(&hash, bytes).await?;
        }
        if encode(data)?.len() > MAX_ENTITY_BYTES {
            return Err(AppError::new(
                "SYNC_SIZE",
                "单个同步项目的元数据不能超过 512 KiB",
            ));
        }
    }
    Ok(())
}

fn offload_body(data: &mut Value, force: bool) -> Result<Option<(String, Vec<u8>)>> {
    let Some(body) = data["contentMd"]
        .as_str()
        .filter(|body| !body.is_empty() && (force || body.len() >= INLINE_BYTES))
    else {
        return Ok(None);
    };
    if body.len() > MAX_BLOB {
        return Err(AppError::new("SYNC_SIZE", "单个同步附件不能超过 25 MiB"));
    }
    let bytes = body.as_bytes().to_vec();
    let hash = digest(&bytes);
    let data = data.as_object_mut().ok_or_else(protocol_error)?;
    data.remove("contentMd");
    data.insert("contentBlobHash".into(), json!(hash));
    data.insert("contentBlobSize".into(), json!(bytes.len()));
    Ok(Some((hash, bytes)))
}

fn reject_outbox(
    db: &Workspace,
    operation: &Operation,
    generations: &[i64],
    reason: &str,
) -> Result<()> {
    db.write(|tx| {
        for (mutation, generation) in operation.mutations.iter().zip(generations) {
            issue(tx, &mutation.key, *generation, reason, None)?;
        }
        tx.execute("DELETE FROM sync_outbox", [])?;
        Ok(())
    })
}

async fn push_one(
    db: &Workspace,
    assets: &Assets,
    remote: &Remote<'_>,
    cursor: i64,
) -> Result<bool> {
    let Some((mut operation, generations)) = stage_outbox(db)? else {
        return Ok(false);
    };
    if let Err(error) = prepare_uploads(db, assets, remote, &mut operation).await {
        if matches!(error.code(), "SYNC_SIZE" | "SYNC_ASSET" | "ASSET_MISSING") {
            reject_outbox(db, &operation, &generations, &error.to_string())?;
            return Ok(true);
        }
        return Err(error);
    }
    let encoded = encode(&json!({"protocolVersion":1,"cursor":cursor,"operations":[operation]}))?;
    if operation.mutations.len() > MAX_GROUP || encoded.len() > 1024 * 1024 {
        reject_outbox(db, &operation, &generations, "变更组超过服务限制")?;
        return Ok(true);
    }
    let Receipt { results } = response(
        remote
            .request(Method::POST, "v1/sync/push")?
            .header("Content-Type", "application/json")
            .body(encoded),
    )
    .await?;
    let result = results.into_iter().next().ok_or_else(protocol_error)?;
    db.write(|tx| {
        match result.status.as_str() {
            "applied" | "already_applied" => {
                let versions = result.versions.as_ref().ok_or_else(protocol_error)?;
                if versions.len() != operation.mutations.len() { return Err(protocol_error()); }
                for ((version,mutation),generation) in versions.iter().zip(&operation.mutations).zip(&generations) {
                    let key = &mutation.key;
                    if version.key.entity_id != key.entity_id || version.key.entity_type != key.entity_type
                        || version.remote_revision <= mutation.base_revision {
                        return Err(protocol_error());
                    }
                    remember(tx,key,version.remote_revision,mutation.operation=="delete")?;
                    tx.execute("DELETE FROM sync_dirty WHERE (entity_type,entity_id,generation)=(?1,?2,?3)",
                        params![key.entity_type.key(),key.entity_id,generation])?;
                    tx.execute("DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
                        params![key.entity_type.key(),key.entity_id])?;
                }
            }
            "conflict" | "rejected" => {
                let reason = match result.reason.as_deref() {
                    Some("category_name_conflict") => "云端已有同名目录，请修改本地目录名称",
                    Some("category_in_use") => "云端目录仍有条目或子目录",
                    Some("category_missing") => "云端缺少关联目录",
                    Some("asset_missing" | "blob_missing") => "云端缺少关联素材",
                    Some("source_entry_missing") => "云端缺少关联条目",
                    Some("collection_missing") => "云端缺少关联专题",
                    Some("canvas_endpoint_missing") => "云端缺少连线引用的卡片",
                    Some("canvas_in_use") => "云端仍有相关卡片或连线，删除未同步",
                    Some("source_url_conflict") => "云端已有同一来源链接，请修改本地稿件的来源",
                    Some("derived_asset_conflict") => "云端已有同一派生图",
                    Some("revision_conflict") => "内容已在另一台设备修改",
                    _ => "同步提交被拒绝",
                };
                for (mutation,generation) in operation.mutations.iter().zip(&generations) {
                    issue(tx,&mutation.key,*generation,reason,None)?;
                }
            }
            _ => return Err(protocol_error()),
        }
        tx.execute("DELETE FROM sync_outbox", [])?;
        Ok(())
    })?;
    Ok(true)
}

fn progress(db: &Workspace) -> Result<(bool, bool, i64, Option<i64>)> {
    db.read(|conn| {
        Ok(conn.query_row(
            "SELECT initialized,seeding,cursor,bootstrap_cursor FROM sync_progress",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?)
    })
}

fn queue_existing(db: &Workspace) -> Result<()> {
    db.write(|tx| {
        tx.execute_batch(
            "INSERT INTO sync_dirty SELECT 'asset',id,1,NULL FROM assets;
             INSERT INTO sync_dirty SELECT 'category',id,1,NULL FROM categories;
             INSERT INTO sync_dirty SELECT 'entry',id,1,NULL FROM entries;
             INSERT INTO sync_dirty SELECT 'collection',id,1,NULL FROM collections;
             INSERT INTO sync_dirty SELECT 'collection_node',id,1,NULL FROM collection_nodes;
             INSERT INTO sync_dirty SELECT 'collection_edge',id,1,NULL FROM collection_edges;
             UPDATE sync_progress SET capture=1,seeding=1",
        )?;
        Ok(())
    })
}

fn empty_local(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM entries) AND NOT EXISTS (SELECT 1 FROM assets)
         AND NOT EXISTS (SELECT 1 FROM collections)
         AND (SELECT COUNT(*) FROM categories)=3
         AND (SELECT COUNT(*) FROM categories WHERE parent_id IS NULL AND
            (id,name,sort_order,icon) IN (
              ('builtin-articles','文章',0,'file'),
              ('builtin-ideas','灵感',1,'lightbulb'),
              ('builtin-references','资料',2,'book')
            ))=3",
        [],
        |row| row.get(0),
    )?)
}

fn require_empty(conn: &Connection) -> Result<()> {
    if empty_local(conn)? {
        return Ok(());
    }
    Err(AppError::new(
        "SYNC_LOCAL_DATA",
        "本地和云端都有内容，请使用空工作区同步云端数据",
    ))
}

async fn bootstrap(db: &Workspace, remote: &Remote<'_>) -> Result<()> {
    db.read(require_empty)?;
    download_baseline(db, remote).await
}

async fn download_baseline(db: &Workspace, remote: &Remote<'_>) -> Result<()> {
    db.write(|tx| {
        tx.execute_batch(
            "DELETE FROM sync_bootstrap; UPDATE sync_progress SET bootstrap_cursor=NULL",
        )?;
        Ok(())
    })?;
    let mut after: Option<Key> = None;
    let mut start = None;
    let end = loop {
        let path = if let Some(after) = &after {
            if !super::valid_id(&after.entity_id) {
                return Err(protocol_error());
            }
            format!(
                "v1/sync/bootstrap?afterType={}&afterId={}",
                after.entity_type.key(),
                after.entity_id
            )
        } else {
            "v1/sync/bootstrap".into()
        };
        let page: BootstrapPage = response(remote.request(Method::GET, &path)?).await?;
        remote.check(&page.server_instance_id, &page.sync_epoch)?;
        start = start.or(page.snapshot_start_cursor);
        for mut entity in page.entities {
            remote.hydrate(&mut entity).await?;
            stage_bootstrap(db, &entity)?;
        }
        after = page.next_after;
        if after.is_none() {
            break page.snapshot_end_cursor.ok_or_else(protocol_error)?;
        }
    };
    let mut cursor = start.ok_or_else(protocol_error)?;
    while cursor < end {
        let page = remote.pull(cursor, Some(end)).await?;
        if page.next_cursor <= cursor || page.next_cursor > end {
            return Err(protocol_error());
        }
        for mut change in page.changes {
            remote.hydrate(&mut change.entity).await?;
            stage_bootstrap(db, &change.entity)?;
        }
        cursor = page.next_cursor;
    }
    db.write(|tx| {
        tx.execute("UPDATE sync_progress SET bootstrap_cursor=?1", [end])?;
        Ok(())
    })
}

fn stage_bootstrap(db: &Workspace, entity: &Entity) -> Result<()> {
    db.write(|tx| {
        tx.execute(
            "INSERT INTO sync_bootstrap VALUES (?1,?2,?3,?4)
            ON CONFLICT(entity_type,entity_id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json
            WHERE excluded.revision>sync_bootstrap.revision",
            params![entity.key.entity_type.key(),entity.key.entity_id,entity.remote_revision,encode(entity)?],
        )?;
        Ok(())
    })
}

async fn download_changes(db: &Workspace, remote: &Remote<'_>, mut cursor: i64) -> Result<()> {
    loop {
        let page = remote.pull(cursor, None).await?;
        let more = page.has_more;
        for mut change in page.changes {
            if change.group_size < 1
                || change.group_size as usize > MAX_GROUP
                || change.group_index >= change.group_size as usize
                || change.cursor <= cursor
                || change.cursor > page.next_cursor
            {
                return Err(protocol_error());
            }
            let (known, _) = db.read(|conn| revision(conn, &change.entity.key))?;
            if change.entity.remote_revision > known {
                remote.hydrate(&mut change.entity).await?;
            }
            db.write(|tx| {
                tx.execute(
                    "INSERT OR IGNORE INTO sync_inbox VALUES (?1,?2,?3,?4)",
                    params![
                        change.cursor,
                        change.group_id,
                        change.group_size,
                        encode(&change.entity)?
                    ],
                )?;
                Ok(())
            })?;
        }
        cursor = page.next_cursor;
        db.write(|tx| {
            tx.execute("UPDATE sync_progress SET cursor=?1", [cursor])?;
            Ok(())
        })?;
        if !more {
            return Ok(());
        }
    }
}

async fn exchange(db: &Workspace, assets: &Assets, sync: &SyncConnection) -> Result<()> {
    let remote = Remote::open(db, sync).await?;
    db.write(|tx| {
        tx.execute("DELETE FROM sync_issues WHERE remote_json IS NULL", [])?;
        Ok(())
    })?;
    let (initialized, mut seeding, cursor, staged) = progress(db)?;
    if !initialized {
        let meta = sync.meta(&remote.base).await?;
        remote.check(&meta.server_instance_id, &meta.sync_epoch)?;
        if !seeding && meta.seed_status != "ready" {
            remote.seed("begin").await?;
            queue_existing(db)?;
            seeding = true;
        }
        if seeding {
            while push_one(db, assets, &remote, cursor).await? {}
            let pending = db.read(|conn| {
                Ok(
                    conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_dirty)", [], |row| {
                        row.get::<_, bool>(0)
                    })?,
                )
            })?;
            if pending {
                return Ok(());
            }
            remote.seed("finish").await?;
            db.write(|tx| {
                tx.execute("UPDATE sync_progress SET initialized=1,seeding=0", [])?;
                Ok(())
            })?;
        } else {
            if staged.is_none() {
                bootstrap(db, &remote).await?;
            }
            return Ok(());
        }
    }
    let has_outbox = db.read(|conn| {
        Ok(
            conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox)", [], |row| {
                row.get::<_, bool>(0)
            })?,
        )
    })?;
    if has_outbox {
        push_one(db, assets, &remote, cursor).await?;
    }
    download_changes(db, &remote, cursor).await?;
    let (_, _, cursor, _) = progress(db)?;
    while push_one(db, assets, &remote, cursor).await? {}
    download_changes(db, &remote, cursor).await
}

fn apply_entity(conn: &Connection, entity: &Entity, changed: &mut Applied) -> Result<()> {
    let id = &entity.key.entity_id;
    let data = &entity.payload;
    if !super::valid_id(id) || entity.remote_revision <= 0 {
        return Err(protocol_error());
    }
    match entity.key.entity_type {
        Kind::Asset => {
            let snapshot = serde_json::from_value(data.clone()).map_err(invalid_response)?;
            images::apply(conn, id, &snapshot)?;
        }
        Kind::Entry => entries::apply(conn, id, data, entity.deleted_at)?,
        Kind::Collection | Kind::CollectionNode | Kind::CollectionEdge => {
            let deleted = entity.deleted_at.is_some();
            let topic = match entity.key.entity_type {
                Kind::Collection => canvas::apply_topic(conn, id, data, deleted)?,
                Kind::CollectionNode => canvas::apply_card(conn, id, data, deleted)?,
                Kind::CollectionEdge => canvas::apply_link(conn, id, data, deleted)?,
                _ => unreachable!(),
            };
            changed.changed_collections.extend(topic);
        }
        Kind::Category if entity.deleted_at.is_some() => {
            conn.execute("DELETE FROM categories WHERE id=?1", [id])?;
        }
        Kind::Category => {
            let name = data["name"].as_str().ok_or_else(protocol_error)?;
            let parent = data["parentId"].as_str();
            conn.execute(
                "INSERT INTO categories (id,name,parent_id,depth,sort_order,icon)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,depth=excluded.depth,
                  sort_order=excluded.sort_order,icon=excluded.icon",
                params![id,name,parent,if parent.is_some(){2}else{1},
                    data["sortOrder"].as_i64().unwrap_or(0),data["icon"].as_str().unwrap_or("folder")],
            )?;
        }
    }
    remember(
        conn,
        &entity.key,
        entity.remote_revision,
        entity.deleted_at.is_some(),
    )?;
    Ok(())
}

fn apply_order(conn: &Connection, entity: &Entity) -> Result<u8> {
    Ok(match entity.key.entity_type {
        Kind::Asset => 0,
        Kind::Category if entity.deleted_at.is_none() && entity.payload["parentId"].is_null() => 1,
        Kind::Category if entity.deleted_at.is_none() => 2,
        Kind::Entry => 3,
        Kind::Collection if entity.deleted_at.is_none() => 6,
        Kind::CollectionNode if entity.deleted_at.is_none() => 7,
        Kind::CollectionEdge => 8,
        Kind::CollectionNode => 9,
        Kind::Collection => 10,
        Kind::Category => {
            let child = conn
                .query_row(
                    "SELECT parent_id IS NOT NULL FROM categories WHERE id=?1",
                    [&entity.key.entity_id],
                    |row| row.get::<_, bool>(0),
                )
                .optional()?
                .unwrap_or(false);
            if child { 4 } else { 5 }
        }
    })
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    changed_entries: Vec<String>,
    changed_collections: std::collections::BTreeSet<String>,
}

impl Applied {
    fn extend(&mut self, other: Self) {
        self.changed_entries.extend(other.changed_entries);
        self.changed_collections.extend(other.changed_collections);
    }
}

fn apply_group(conn: &Connection, entities: Vec<Entity>) -> Result<Applied> {
    let mut ordered = Vec::with_capacity(entities.len());
    for entity in entities {
        ordered.push((apply_order(conn, &entity)?, entity));
    }
    ordered.sort_by_key(|(rank, _)| *rank);
    let mut changed = Applied::default();
    for (_, entity) in &ordered {
        apply_entity(conn, entity, &mut changed)?;
    }
    for (_, entity) in ordered {
        if entity.key.entity_type == Kind::Entry {
            entries::apply_links(conn, &entity.key.entity_id, &entity.payload)?;
            changed.changed_entries.push(entity.key.entity_id);
        }
    }
    Ok(changed)
}

fn generation(conn: &Connection, key: &Key) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT generation FROM sync_dirty WHERE (entity_type,entity_id)=(?1,?2)",
            params![key.entity_type.key(), key.entity_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn apply_received(db: &Workspace) -> Result<Applied> {
    db.write(|tx| {
        if tx.query_row("SELECT paused FROM sync_binding WHERE id=1", [], |row| {
            row.get::<_, bool>(0)
        })? {
            return Err(AppError::new("SYNC_PAUSED", "同步连接已暂停"));
        }
        let (capture, bootstrap): (bool, Option<i64>) = tx.query_row(
            "SELECT capture,bootstrap_cursor FROM sync_progress",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        tx.execute("UPDATE sync_progress SET capture=0", [])?;
        let mut changed = Applied::default();
        if let Some(cursor) = bootstrap {
            require_empty(tx)?;
            // The built-in directory rows are pristine here. Replacing them as a set
            // avoids unique-name collisions when the cloud has renamed two directories.
            tx.execute("DELETE FROM categories", [])?;
            changed.extend(apply_baseline(tx)?);
            tx.execute("DELETE FROM sync_bootstrap", [])?;
            tx.execute(
                "UPDATE sync_progress SET initialized=1,bootstrap_cursor=NULL,cursor=?1",
                [cursor],
            )?;
        }
        let mut query = tx.prepare(
            "SELECT group_id FROM sync_inbox GROUP BY group_id
             HAVING COUNT(*)=MAX(group_size) ORDER BY MIN(cursor)",
        )?;
        let groups = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for group in groups {
            let mut query = tx
                .prepare("SELECT payload_json FROM sync_inbox WHERE group_id=?1 ORDER BY cursor")?;
            let mut mutations = Vec::new();
            let mut blocked = false;
            for encoded in query.query_map([&group], |row| row.get::<_, String>(0))? {
                let entity: Entity = serde_json::from_str(&encoded?).map_err(invalid_response)?;
                let (base, _) = revision(tx, &entity.key)?;
                if entity.remote_revision <= base {
                    continue;
                }
                if let Some(generation) = generation(tx, &entity.key)?
                    && !matching_canvas_delete(tx, &entity)?
                {
                    issue(
                        tx,
                        &entity.key,
                        generation,
                        "检测到同一内容在多台设备修改",
                        Some(&entity),
                    )?;
                    blocked = true;
                }
                mutations.push(entity);
            }
            if blocked {
                continue;
            }
            tx.execute_batch("SAVEPOINT sync_apply_group")?;
            match apply_group(tx, mutations.clone()) {
                Ok(items) => {
                    changed.extend(items);
                    for entity in &mutations {
                        if entity.key.entity_type.is_canvas() && entity.deleted_at.is_some() {
                            tx.execute(
                                "DELETE FROM sync_dirty WHERE (entity_type,entity_id)=(?1,?2)",
                                params![entity.key.entity_type.key(), entity.key.entity_id],
                            )?;
                        }
                        tx.execute(
                            "DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
                            params![entity.key.entity_type.key(), entity.key.entity_id],
                        )?;
                    }
                    tx.execute("DELETE FROM sync_inbox WHERE group_id=?1", [&group])?;
                    tx.execute_batch("RELEASE sync_apply_group")?;
                }
                Err(error) => {
                    tx.execute_batch("ROLLBACK TO sync_apply_group; RELEASE sync_apply_group")?;
                    for entity in &mutations {
                        issue(tx, &entity.key, 0, &error.to_string(), Some(entity))?;
                    }
                }
            }
        }
        tx.execute(
            "UPDATE sync_progress SET capture=?1",
            [capture || bootstrap.is_some()],
        )?;
        Ok(changed)
    })
}

fn matching_canvas_delete(conn: &Connection, entity: &Entity) -> Result<bool> {
    if !entity.key.entity_type.is_canvas()
        || entity.deleted_at.is_none()
        || local_snapshot(conn, &entity.key)?.is_some()
    {
        return Ok(false);
    }
    // Let an in-flight receipt retire before clearing the shared local tombstone.
    Ok(!in_outbox(conn, &entity.key)?)
}

fn apply_baseline(conn: &Connection) -> Result<Applied> {
    let mut entities = conn.prepare(
        "SELECT payload_json FROM sync_bootstrap ORDER BY CASE
           WHEN entity_type='asset' THEN 0
           WHEN entity_type='category' AND payload_json->>'$.payload.parentId' IS NULL THEN 1
           WHEN entity_type='category' THEN 2
           WHEN entity_type='entry' THEN 3
           WHEN entity_type='collection' AND payload_json->>'$.deletedAt' IS NULL THEN 4
           WHEN entity_type='collection_node' AND payload_json->>'$.deletedAt' IS NULL THEN 5
           WHEN entity_type='collection_edge' THEN 6
           WHEN entity_type='collection_node' THEN 7
           ELSE 8 END, entity_id",
    )?;
    let mut changed = Applied::default();
    for row in entities.query_map([], |row| row.get::<_, String>(0))? {
        let entity: Entity = serde_json::from_str(&row?).map_err(invalid_response)?;
        apply_entity(conn, &entity, &mut changed)?;
    }
    let mut entries =
        conn.prepare("SELECT payload_json FROM sync_bootstrap WHERE entity_type='entry'")?;
    for row in entries.query_map([], |row| row.get::<_, String>(0))? {
        let entity: Entity = serde_json::from_str(&row?).map_err(invalid_response)?;
        entries::apply_links(conn, &entity.key.entity_id, &entity.payload)?;
        changed.changed_entries.push(entity.key.entity_id);
    }
    Ok(changed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncActivity {
    pending: bool,
    incoming: bool,
}

#[tauri::command]
pub fn sync_activity(db: State<'_, Workspace>) -> Result<Option<SyncActivity>> {
    db.read(|conn| {
        Ok(conn.query_row(
            "SELECT NOT initialized OR EXISTS(SELECT 1 FROM sync_outbox)
                OR EXISTS(SELECT 1 FROM sync_dirty d WHERE NOT EXISTS (
                    SELECT 1 FROM sync_issues i WHERE
                       (i.entity_type,i.entity_id,i.generation)=(d.entity_type,d.entity_id,d.generation)
                )), bootstrap_cursor IS NOT NULL OR EXISTS(SELECT 1 FROM sync_inbox GROUP BY group_id
                    HAVING COUNT(*)=MAX(group_size))
             FROM sync_progress WHERE EXISTS(SELECT 1 FROM sync_binding WHERE paused=0)",
            [], |row| Ok(SyncActivity {pending:row.get(0)?,incoming:row.get(1)?}),
        ).optional()?)
    })
}

async fn recovery_remote<'a>(db: &Workspace, sync: &'a SyncConnection) -> Result<Remote<'a>> {
    let binding = Binding::read(db)?
        .filter(|binding| binding.paused)
        .ok_or_else(|| AppError::invalid("同步连接未暂停"))?;
    let base = super::service_url(&binding.url)?;
    let meta = sync.meta(&base).await?;
    let reauth = || AppError::new("SYNC_REAUTH", "请重新配对此设备，再建立同步基线");
    if !binding.matches(&meta) {
        return Err(reauth());
    }
    if meta.seed_status != "ready" {
        return Err(AppError::new("SYNC_NOT_READY", "云端工作区尚未完成初始化"));
    }
    let token = super::Credential::read(&binding.key(db)?)?
        .active
        .ok_or_else(reauth)?;
    Ok(Remote {
        sync,
        base,
        token,
        binding,
    })
}

async fn stage_recovery(db: &Workspace, sync: &SyncConnection) -> Result<()> {
    let remote = recovery_remote(db, sync).await?;
    match download_baseline(db, &remote).await {
        Err(error) if error.code() == "SYNC_CREDENTIAL" => Err(AppError::new(
            "SYNC_REAUTH",
            "请重新配对此设备，再建立同步基线",
        )),
        result => result,
    }
}

#[tauri::command]
pub async fn sync_rebuild_stage(
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
) -> Result<()> {
    let _guard = sync.gate.lock().await;
    stage_recovery(&db, &sync).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rebuilt {
    recovery_archive: String,
    #[serde(flatten)]
    changed: Applied,
}

fn replace_baseline(db: &Workspace, backups: &crate::backup::Backups) -> Result<Rebuilt> {
    db.write(|tx| {
        let cursor = tx.query_row(
            "SELECT bootstrap_cursor FROM sync_progress
             WHERE EXISTS(SELECT 1 FROM sync_binding WHERE paused=1)",
            [], |row| row.get::<_,Option<i64>>(0),
        ).optional()?.flatten().ok_or_else(|| AppError::invalid("请先完整下载云端同步基线"))?;
        let workspace_id = crate::db::workspace_id(tx)?;
        // The write transaction excludes concurrent local changes. The backup opens
        // a separate read connection before this transaction mutates the workspace.
        let archive = backups.archive_sync_recovery(&workspace_id)?;
        tx.execute_batch(
            "UPDATE sync_progress SET capture=0;
             UPDATE entries SET category_id=NULL, source_id=NULL, version=version+1;
             DELETE FROM categories;
             DELETE FROM collection_edges;
             DELETE FROM collection_nodes;
             DELETE FROM sync_revisions;
             DELETE FROM sync_dirty;
             DELETE FROM sync_inbox;
             DELETE FROM sync_outbox;
             DELETE FROM sync_issues;"
        )?;
        let mut affected = tx.prepare(
            "UPDATE entries SET deleted_at=COALESCE(deleted_at,?1)
             WHERE NOT EXISTS(SELECT 1 FROM sync_bootstrap b WHERE b.entity_type='entry' AND b.entity_id=entries.id)
             RETURNING id"
        )?;
        let changed_entries = affected.query_map([crate::db::now()], |row| row.get::<_,String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(affected);
        let mut removed = tx.prepare(
            "DELETE FROM collections WHERE NOT EXISTS(SELECT 1 FROM sync_bootstrap b
               WHERE b.entity_type='collection' AND b.entity_id=collections.id AND b.payload_json->>'$.deletedAt' IS NULL)
             RETURNING id",
        )?;
        let changed_collections = removed.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        let mut changed = Applied { changed_entries,changed_collections };
        // Local aliases may refer to identical derived bytes. Keep their files for
        // local-only content and allow the cloud's canonical metadata to be inserted.
        tx.execute(
            "UPDATE assets SET source_key=NULL WHERE kind='derived' AND EXISTS(
                SELECT 1 FROM sync_bootstrap b WHERE b.entity_type='asset' AND b.entity_id<>assets.id
                  AND b.payload_json->>'$.payload.kind'='derived'
                  AND b.payload_json->>'$.payload.sha256'=assets.sha256
                  AND b.payload_json->>'$.payload.sourceKey'=assets.source_key
             )", [],
        )?;
        changed.extend(apply_baseline(tx)?);
        tx.execute_batch("DELETE FROM sync_bootstrap; UPDATE sync_binding SET paused=0")?;
        tx.execute(
            "UPDATE sync_progress SET capture=1,seeding=0,initialized=1,cursor=?1,bootstrap_cursor=NULL,active_batch=NULL",
            [cursor],
        )?;
        Ok(Rebuilt {recovery_archive:archive.to_string_lossy().into_owned(),changed})
    })
}

#[tauri::command]
pub async fn sync_rebuild_apply(
    app: tauri::AppHandle,
    sync: State<'_, SyncConnection>,
) -> Result<Rebuilt> {
    use tauri::Manager;
    let _guard = sync.gate.lock().await;
    let db = app.state::<Workspace>();
    // Re-check the service epoch immediately before committing the staged snapshot.
    let remote = recovery_remote(&db, &sync).await?;
    super::fetch_devices(sync.client(&remote.base), &remote.base, &remote.token).await?;
    tokio::task::spawn_blocking(move || {
        replace_baseline(
            &app.state::<Workspace>(),
            &app.state::<crate::backup::Backups>(),
        )
    })
    .await
    .map_err(|_| AppError::new("SYNC_RECOVERY", "同步基线重建任务已中断"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    #[serde(flatten)]
    key: Key,
    reason: String,
    local: Option<Value>,
    remote: Option<Value>,
    resolvable: bool,
    can_keep_local: bool,
    remote_revision: Option<i64>,
    local_generation: Option<i64>,
}

#[tauri::command]
pub async fn sync_run(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    sync: State<'_, SyncConnection>,
) -> Result<()> {
    let _guard = sync.gate.lock().await;
    let result = exchange(&db, &assets, &sync).await;
    if result
        .as_ref()
        .is_err_and(|error| error.code() == "SYNC_RESET")
    {
        pause(&db)?;
    }
    result
}

#[tauri::command]
pub async fn sync_apply(
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
) -> Result<Applied> {
    let _guard = sync.gate.lock().await;
    apply_received(&db)
}

#[tauri::command]
pub fn sync_conflicts(db: State<'_, Workspace>) -> Result<Vec<Conflict>> {
    db.read(|conn| {
        let mut query = conn.prepare("SELECT entity_type,entity_id,reason,remote_json FROM sync_issues ORDER BY entity_type,entity_id")?;
        query.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,
            row.get::<_,Option<String>>(3)?)))?.map(|row| {
            let (kind,id,reason,remote) = row?;
            let entity_type = serde_json::from_value(Value::String(kind)).map_err(invalid_response)?;
            let key = Key {entity_type,entity_id:id};
            let local = local_snapshot(conn,&key)?;
            let remote = remote.map(|remote| serde_json::from_str::<Entity>(&remote)).transpose().map_err(invalid_response)?;
            let local_generation = generation(conn,&key)?;
            let remote_revision = remote.as_ref().map(|entity| entity.remote_revision);
            let resolvable = entity_type == Kind::Entry && local_generation.is_some() && remote.is_some();
            let can_keep_local = entity_type.is_canvas() && local_generation.is_some()
                && remote.as_ref().is_some_and(|entity| entity.deleted_at.is_none());
            Ok(Conflict { key,reason,local,remote:remote.map(|entity| entity.payload),resolvable,can_keep_local,remote_revision,local_generation })
        }).collect()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    Cloud,
    Local,
    Copy,
}

#[tauri::command]
pub async fn sync_resolve(
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
    entity_type: Kind,
    entity_id: String,
    choice: Resolution,
    remote_revision: i64,
    local_generation: i64,
) -> Result<Applied> {
    let _guard = sync.gate.lock().await;
    if entity_type == Kind::Entry {
        return resolve(&db, &entity_id, choice, remote_revision, local_generation);
    }
    if !entity_type.is_canvas() || !matches!(choice, Resolution::Local) {
        return Err(AppError::invalid("此同步冲突不支持所选处理方式"));
    }
    keep_canvas_local(
        &db,
        &Key {
            entity_type,
            entity_id,
        },
        remote_revision,
        local_generation,
    )?;
    Ok(Applied::default())
}

fn in_outbox(conn: &Connection, key: &Key) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_outbox o JOIN json_each(o.operation_json,'$.mutations') m
         WHERE m.value->>'$.entityType'=?1 AND m.value->>'$.entityId'=?2)",
        params![key.entity_type.key(), key.entity_id],
        |row| row.get(0),
    )?)
}

fn resolution_target(
    conn: &Connection,
    key: &Key,
    remote_revision: i64,
    local_generation: i64,
) -> Result<Entity> {
    let paused: bool = conn.query_row("SELECT paused FROM sync_binding", [], |row| row.get(0))?;
    if paused {
        return Err(AppError::new("SYNC_PAUSED", "同步连接已暂停"));
    }
    if in_outbox(conn, key)? {
        return Err(AppError::new("SYNC_IN_FLIGHT", "请先完成该项的上传重试"));
    }
    let changed = || {
        AppError::new(
            "SYNC_CONFLICT_CHANGED",
            "冲突内容已变化，请重新查看同步冲突",
        )
    };
    let raw: String = conn.query_row(
        "SELECT remote_json FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2) AND remote_json IS NOT NULL",
        params![key.entity_type.key(),key.entity_id], |row| row.get(0),
    ).optional()?.ok_or_else(changed)?;
    let remote: Entity = serde_json::from_str(&raw).map_err(invalid_response)?;
    if remote.remote_revision != remote_revision || generation(conn, key)? != Some(local_generation)
    {
        return Err(changed());
    }
    Ok(remote)
}

fn keep_canvas_local(
    db: &Workspace,
    key: &Key,
    remote_revision: i64,
    local_generation: i64,
) -> Result<()> {
    db.write(|tx| {
        let remote = resolution_target(tx, key, remote_revision, local_generation)?;
        if remote.deleted_at.is_some() {
            return Err(AppError::invalid("云端已删除此项，请先保留本地内容"));
        }
        remember(tx, key, remote_revision, false)?;
        tx.execute(
            "DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",
            params![key.entity_type.key(), key.entity_id],
        )?;
        Ok(())
    })
}

fn resolve(
    db: &Workspace,
    entry_id: &str,
    choice: Resolution,
    remote_revision: i64,
    local_generation: i64,
) -> Result<Applied> {
    let (mut changed, replay_group) = db.write(|tx| {
        let key = Key { entity_type: Kind::Entry, entity_id: entry_id.to_owned() };
        let remote = resolution_target(tx, &key, remote_revision, local_generation)?;
        let group: Option<String> = tx.query_row(
            "SELECT group_id FROM sync_inbox WHERE group_size>1 AND payload_json->>'$.entityType'='entry'
                AND payload_json->>'$.entityId'=?1 AND payload_json->>'$.remoteRevision'=?2",
            params![entry_id,remote_revision], |row| row.get(0),
        ).optional()?;
        let deleted_folder = if group.is_some() {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_inbox i JOIN entries e ON e.id=?1
                 WHERE i.group_id=?2 AND i.payload_json->>'$.entityType'='category'
                   AND i.payload_json->>'$.deletedAt' IS NOT NULL AND i.payload_json->>'$.entityId'=e.category_id)",
                params![entry_id,group], |row| row.get::<_,bool>(0),
            )?
        } else { false };
        if matches!(choice, Resolution::Local) && deleted_folder {
            return Err(AppError::new("SYNC_DIRECTORY", "请先将本地稿移出已被云端删除的目录"));
        }
        let mut changed = Applied::default();
        if matches!(choice,Resolution::Copy) {
            let mut local = entries::snapshot(tx,entry_id)?.ok_or_else(protocol_error)?;
            local["title"] = json!(format!("{}（冲突副本）",local["title"].as_str().unwrap_or("未命名")));
            local["source"] = Value::Null;
            if deleted_folder {
                local["categoryId"] = remote.payload["categoryId"].clone();
                local["folderSortOrder"] = Value::Null;
            }
            let copy_id = id();
            entries::apply(tx,&copy_id,&local,None)?;
            entries::apply_links(tx,&copy_id,&local)?;
            changed.changed_entries.push(copy_id);
        }
        if matches!(choice,Resolution::Local) {
            remember(tx,&remote.key,remote.remote_revision,remote.deleted_at.is_some())?;
        } else {
            if matches!(choice,Resolution::Cloud) {
                entries::preserve_local_revision(tx,entry_id)?;
            }
            if group.is_none() {
                tx.execute("UPDATE sync_progress SET capture=0", [])?;
                changed.extend(apply_group(tx,vec![remote])?);
                tx.execute("UPDATE sync_progress SET capture=1", [])?;
            }
            tx.execute("DELETE FROM sync_dirty WHERE entity_type='entry' AND entity_id=?1",[entry_id])?;
        }
        tx.execute("DELETE FROM sync_issues WHERE entity_type='entry' AND entity_id=?1",[entry_id])?;
        Ok((changed, group.is_some()))
    })?;
    if replay_group {
        changed.extend(apply_received(db)?);
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::super::{ConnectWith, Pairing, connect, register};
    use super::*;
    use crate::backup::Backups;

    #[test]
    fn oversized_canvas_deletion_leaves_its_cards_and_dirty_queue_intact() {
        let root = tempfile::tempdir().unwrap();
        let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
        db.write(|tx| {
            tx.execute_batch(
                "INSERT INTO collections (id,title,created_at,updated_at) VALUES ('topic','专题',1,1);
                 WITH RECURSIVE cards(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM cards WHERE id<256)
                 INSERT INTO collection_nodes (id,collection_id,kind,created_at,updated_at)
                   SELECT 'card-' || id,'topic','text',1,1 FROM cards;
                 UPDATE sync_progress SET capture=1,initialized=1",
            )?;
            Ok(())
        }).unwrap();
        assert_eq!(
            db.delete_collection("topic").unwrap_err().code(),
            "SYNC_SIZE"
        );
        let state = db.read(|conn| Ok(conn.query_row(
            "SELECT (SELECT count(*) FROM collections),(SELECT count(*) FROM collection_nodes),
                (SELECT count(*) FROM sync_dirty),active_batch FROM sync_progress",
            [], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,Option<String>>(3)?)),
        )?)).unwrap();
        assert_eq!(state, (1, 256, 0, None));
    }

    #[tokio::test]
    #[ignore = "requires an isolated fresh v1 service and a native system keyring"]
    async fn canvases_between_workspaces() {
        let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
        let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
        let root = tempfile::tempdir().unwrap();
        let a = Workspace::open(&root.path().join("a.sqlite")).unwrap();
        let b_path = root.path().join("b");
        let (b, backups) = Backups::open(&b_path).unwrap();
        let a_assets = Assets::new(root.path().join("assets-a"), &a).unwrap();
        let b_assets = Assets::new(b_path.join("assets"), &b).unwrap();
        let sync = SyncConnection::new().unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let png = png.into_inner();
        let screenshot = a_assets.import(&a, "专题截图.png", &png).unwrap();
        let markdown = format!(
            "![截图](asset://{screenshot})\n\n{}",
            "专题长文。".repeat(6_000)
        );
        a.write(|tx| {
            tx.execute_batch(
                "INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
                 VALUES ('article','article','来源文稿','draft','正文',1,1);
                 INSERT INTO collections (id,title,description,viewport_x,viewport_zoom,created_at,updated_at)
                 VALUES ('topic','同步专题','初始说明',140,1.5,1,1);
                 INSERT INTO collection_nodes (id,collection_id,kind,entry_id,external_url,created_at,updated_at) VALUES
                 ('entry-card','topic','entry','article',NULL,1,1),
                 ('web-card','topic','web',NULL,'https://example.test/project',1,1);",
            )?;
            tx.execute(
                "INSERT INTO collection_nodes (id,collection_id,kind,asset_id,content_md,created_at,updated_at) VALUES
                 ('shot','topic','image',?1,'',1,1),('note','topic','text',NULL,?2,1,1)",
                params![screenshot,markdown],
            )?;
            tx.execute("INSERT INTO collection_edges VALUES ('edge','topic','note','shot','参考',1)",[])?;
            Ok(())
        }).unwrap();
        let first = connect(&a, &sync, &url, "画布 A", ConnectWith::Claim, &setup)
            .await
            .unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        apply_received(&a).unwrap();
        let remote = Remote::open(&a, &sync).await.unwrap();
        let pairing: Pairing = response(remote.request(Method::POST, "v1/pairings").unwrap())
            .await
            .unwrap();
        let second = connect(
            &b,
            &sync,
            &url,
            "画布 B",
            ConnectWith::Pair,
            &pairing.pairing_token,
        )
        .await
        .unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        assert!(
            apply_received(&b)
                .unwrap()
                .changed_collections
                .contains("topic")
        );
        let read =
            |db: &Workspace| serde_json::to_value(db.collection_canvas("topic").unwrap()).unwrap();
        let initial = read(&b);
        assert_eq!(
            initial["collection"]["viewport"],
            json!({"x":0.0,"y":0.0,"zoom":1.0})
        );
        let nodes = initial["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 4);
        assert_eq!(
            nodes.iter().find(|n| n["id"] == "note").unwrap()["contentMd"],
            markdown
        );
        assert_eq!(
            nodes.iter().find(|n| n["id"] == "web-card").unwrap()["externalUrl"],
            "https://example.test/project"
        );
        assert_eq!(initial["edges"][0]["label"], "参考");
        assert_eq!(
            b_assets
                .read(&b, &format!("asset://{screenshot}"))
                .await
                .unwrap(),
            png
        );

        let viewport = json!({"x":-80.0,"y":35.0,"zoom":0.8});
        b.save_collection_viewport("topic", serde_json::from_value(viewport.clone()).unwrap())
            .unwrap();
        assert!(stage_outbox(&b).unwrap().is_none());
        a.update_collection_node_geometry(
            serde_json::from_value(json!([
                {"nodeId":"note","x":84.5,"y":-43,"width":400,"height":180}
            ]))
            .unwrap(),
        )
        .unwrap();
        a.update_collection_node_color("note", Some("#45abfd"))
            .unwrap();
        let (drag, _) = stage_outbox(&a).unwrap().unwrap();
        assert_eq!(drag.mutations.len(), 1);
        assert_eq!(drag.mutations[0].key.entity_id, "note");
        a.save_collection(Some("topic"), "改名专题", "修订说明")
            .unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        assert!(
            apply_received(&b)
                .unwrap()
                .changed_collections
                .contains("topic")
        );
        let edited = read(&b);
        assert_eq!(edited["collection"]["title"], "改名专题");
        assert_eq!(edited["collection"]["viewport"], viewport);
        let note = edited["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "note")
            .unwrap();
        assert_eq!(note["x"], 84.5);
        assert_eq!(note["color"], "#45abfd");

        a.update_collection_node_text("note", "A 的并发修改")
            .unwrap();
        b.update_collection_node_text("note", "B 的本地改稿")
            .unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        assert!(apply_received(&b).unwrap().changed_collections.is_empty());
        let key = Key {
            entity_type: Kind::CollectionNode,
            entity_id: "note".into(),
        };
        let conflict = || {
            b.read(|conn| {
            let raw:String = conn.query_row("SELECT remote_json FROM sync_issues WHERE entity_type='collection_node' AND entity_id='note'",[],|row|row.get(0))?;
            let remote:Entity=serde_json::from_str(&raw).map_err(invalid_response)?;
            Ok((remote.remote_revision, generation(conn,&key)?.unwrap(),remote.payload))
        }).unwrap()
        };
        let (version, generation, remote) = conflict();
        assert_eq!(remote["contentMd"], "A 的并发修改");
        assert_eq!(
            keep_canvas_local(&b, &key, version, generation + 1)
                .unwrap_err()
                .code(),
            "SYNC_CONFLICT_CHANGED"
        );
        keep_canvas_local(&b, &key, version, generation).unwrap();
        a.update_collection_node_text("note", "A 的更新版本")
            .unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        assert!(apply_received(&b).unwrap().changed_collections.is_empty());
        let (new_version, new_generation, remote) = conflict();
        assert!(new_version > version);
        assert_eq!(remote["contentMd"], "A 的更新版本");
        keep_canvas_local(&b, &key, new_version, new_generation).unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        assert!(
            apply_received(&a)
                .unwrap()
                .changed_collections
                .contains("topic")
        );
        assert_eq!(
            a.read(|conn| canvas::snapshot_card(conn, "note"))
                .unwrap()
                .unwrap()["contentMd"],
            "B 的本地改稿"
        );

        let local_edge = serde_json::to_value(
            b.create_collection_edge(
                "topic".into(),
                "note".into(),
                "entry-card".into(),
                "离线新增".into(),
            )
            .unwrap(),
        )
        .unwrap();
        let local_edge = local_edge["id"].as_str().unwrap();
        a.delete_collection_node("note").unwrap();
        let (delete, _) = stage_outbox(&a).unwrap().unwrap();
        assert_eq!(delete.mutations.len(), 2);
        assert!(
            delete
                .mutations
                .iter()
                .all(|mutation| mutation.operation == "delete")
        );
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        assert!(apply_received(&b).unwrap().changed_collections.is_empty());
        assert_eq!(read(&b)["nodes"].as_array().unwrap().len(), 4);
        assert_eq!(read(&b)["edges"].as_array().unwrap().len(), 2);
        b.delete_collection_edge(local_edge).unwrap();
        assert!(
            apply_received(&b)
                .unwrap()
                .changed_collections
                .contains("topic")
        );
        assert_eq!(read(&b)["nodes"].as_array().unwrap().len(), 3);
        assert!(read(&b)["edges"].as_array().unwrap().is_empty());

        b.save_collection(None, "未上传专题", "本地恢复副本")
            .unwrap();
        pause(&b).unwrap();
        stage_recovery(&b, &sync).await.unwrap();
        let rebuilt = replace_baseline(&b, &backups).unwrap();
        assert_eq!(rebuilt.changed.changed_collections.len(), 2);
        assert_eq!(b.list_collections().unwrap().len(), 1);
        assert_eq!(read(&b)["collection"]["viewport"], viewport);
        let (empty, archived) = Backups::open(&root.path().join("recovered")).unwrap();
        archived
            .queue_workspace_archive_for_test(std::path::Path::new(&rebuilt.recovery_archive))
            .unwrap();
        drop(empty);
        let (archive, _) = Backups::open(&root.path().join("recovered")).unwrap();
        assert_eq!(archive.list_collections().unwrap().len(), 2);
        assert!(stage_outbox(&b).unwrap().is_none());

        a.delete_collection("topic").unwrap();
        let (delete, _) = stage_outbox(&a).unwrap().unwrap();
        assert_eq!(delete.mutations.len(), 4);
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        assert!(
            apply_received(&b)
                .unwrap()
                .changed_collections
                .contains("topic")
        );
        assert!(b.list_collections().unwrap().is_empty());

        a.save_collection(
            None,
            "超过元数据上限",
            &"字".repeat(MAX_ENTITY_BYTES / 3 + 1),
        )
        .unwrap();
        a.save_collection(None, "独立专题", "").unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        apply_received(&b).unwrap();
        let synced = serde_json::to_value(b.list_collections().unwrap()).unwrap();
        assert_eq!(synced.as_array().unwrap().len(), 1);
        assert_eq!(synced[0]["title"], "独立专题");
        assert!(stage_outbox(&a).unwrap().is_none());
        first.key(&a).unwrap().delete_credential().unwrap();
        second.key(&b).unwrap().delete_credential().unwrap();
    }

    #[test]
    fn copying_a_conflict_does_not_retain_a_deleted_folder() {
        let root = tempfile::tempdir().unwrap();
        let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
        db.write(|tx| {
            tx.execute_batch(
                "INSERT INTO sync_binding VALUES (1,'https://sync.example.test','server','epoch','device',0);
                 INSERT INTO categories (id,name,depth,sort_order) VALUES ('f','目录',1,3);
                 INSERT INTO entries (id,kind,title,status,content_md,category_id,created_at,updated_at)
                 VALUES ('draft','article','文稿','draft','本地稿','f',1,1);
                 UPDATE sync_progress SET capture=1,initialized=1;
                 UPDATE entries SET version=2 WHERE id='draft';",
            )?;
            let mut payload = entries::snapshot(tx,"draft")?.unwrap();
            payload["categoryId"] = Value::Null;
            payload["contentMd"] = json!("云端稿");
            for (cursor, entity) in [
                Entity { key: Key {entity_type:Kind::Category,entity_id:"f".into()},
                         remote_revision:2,deleted_at:Some(2),payload:json!({}) },
                Entity { key: Key {entity_type:Kind::Entry,entity_id:"draft".into()},
                         remote_revision:2,deleted_at:None,payload },
            ].into_iter().enumerate() {
                tx.execute("INSERT INTO sync_inbox VALUES (?1,'group',2,?2)",params![cursor as i64 + 1,encode(&entity)?])?;
            }
            Ok(())
        }).unwrap();
        assert!(apply_received(&db).unwrap().changed_entries.is_empty());
        let changed = resolve(&db, "draft", Resolution::Copy, 2, 1).unwrap();
        assert_eq!(changed.changed_entries.len(), 2);
        db.read(|conn| {
            let copy = entries::snapshot(conn, &changed.changed_entries[0])?.unwrap();
            assert_eq!(copy["contentMd"], "本地稿");
            assert!(copy["categoryId"].is_null());
            let original = entries::snapshot(conn, "draft")?.unwrap();
            assert_eq!(original["contentMd"], "云端稿");
            assert!(original["categoryId"].is_null());
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM sync_inbox", [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn oversized_directory_delete_rolls_back_entry_moves() {
        let root = tempfile::tempdir().unwrap();
        let db = Workspace::open(&root.path().join("workspace.sqlite")).unwrap();
        db.write(|tx| {
            tx.execute("UPDATE sync_progress SET capture=1", [])?;
            tx.execute("INSERT INTO categories (id,name,depth,sort_order) VALUES ('folder','测试',1,3)", [])?;
            for id in ["one","two","three"] {
                tx.execute("INSERT INTO entries (id,kind,title,status,category_id,content_md,summary,created_at,updated_at)
                    VALUES (?1,'article','文稿','draft','folder','短正文',?2,1,1)",
                    params![id,"a".repeat(380_000)])?;
            }
            Ok(())
        }).unwrap();
        assert_eq!(
            db.delete_category("folder").err().unwrap().code(),
            "SYNC_SIZE"
        );
        db.read(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM categories WHERE id='folder'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM entries WHERE category_id='folder'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                3
            );
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an isolated fresh v1 service and a native system keyring"]
    async fn articles_and_private_images_between_workspaces() {
        let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
        let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
        let root = tempfile::tempdir().unwrap();
        let a = Workspace::open(&root.path().join("a.sqlite")).unwrap();
        let b_workspace = root.path().join("b");
        let (b, b_backups) = Backups::open(&b_workspace).unwrap();
        let a_assets = Assets::new(root.path().join("assets-a"), &a).unwrap();
        let b_root = b_workspace.join("assets");
        let b_assets = Assets::new(b_root.clone(), &b).unwrap();
        let sync = SyncConnection::new().unwrap();
        let first = connect(&a, &sync, &url, "文章工作区 A", ConnectWith::Claim, &setup)
            .await
            .unwrap();
        let first_key = first.key(&a).unwrap();
        let remote = Remote::open(&a, &sync).await.unwrap();
        let invitation: Pairing = response(remote.request(Method::POST, "v1/pairings").unwrap())
            .await
            .unwrap();
        let second = connect(
            &b,
            &sync,
            &url,
            "文章工作区 B",
            ConnectWith::Pair,
            &invitation.pairing_token,
        )
        .await
        .unwrap();
        let second_key = second.key(&b).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let png = png.into_inner();
        let asset = a_assets.import(&a, "同步图片.png", &png).unwrap();
        let markdown = format!(
            "![图](asset://{asset})\n\n{}",
            "同步长文内容。".repeat(5_000)
        );
        a.write(|tx| {
            tx.execute(
                "INSERT INTO categories (id,name,depth,sort_order,icon) VALUES ('sync-folder','计划',1,3,'folder')",[],
            )?;
            tx.execute("INSERT INTO entries (id,kind,title,status,category_id,content_md,cover_asset_id,
                created_at,updated_at,folder_sort_order) VALUES
                ('draft','article','示例','draft','sync-folder',?1,?2,1,1,7)",params![markdown,asset])?;
            crate::assets::references::sync_entry(tx,"draft",&markdown)?;
            tx.execute_batch(
                "INSERT INTO sources VALUES ('src','https://example.test/article','作者','账号',NULL,1);
                 INSERT INTO entries (id,kind,title,status,source_id,content_md,created_at,updated_at)
                 VALUES ('source-note','reference','来源','unread','src','来源正文',1,1);
                 INSERT INTO entry_links VALUES ('draft','source-note');
                 INSERT INTO tags VALUES ('tag','计划','计划');
                 INSERT INTO entry_tags VALUES ('draft','tag')",
            )?;
            Ok(())
        }).unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        apply_received(&a).unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        apply_received(&b).unwrap();
        let item = b
            .read(|conn| entries::snapshot(conn, "draft"))
            .unwrap()
            .unwrap();
        assert_eq!(item["contentMd"], markdown);
        assert_eq!(item["folderSortOrder"], 7);
        assert_eq!(item["coverAssetId"], asset);
        assert_eq!(item["tags"], json!(["计划"]));
        assert_eq!(item["sourceEntryIds"], json!(["source-note"]));
        let source = b
            .read(|conn| entries::snapshot(conn, "source-note"))
            .unwrap()
            .unwrap();
        assert_eq!(source["source"]["url"], "https://example.test/article");
        assert!(!b_root.exists() || std::fs::read_dir(&b_root).unwrap().next().is_none());
        let export = root.path().join("article.md");
        b_assets
            .export_markdown_file(&b, &markdown, &export)
            .await
            .unwrap();
        assert!(
            std::fs::read_to_string(export)
                .unwrap()
                .contains("(assets/")
        );
        assert_eq!(
            b_assets
                .read(&b, &format!("asset://{asset}"))
                .await
                .unwrap(),
            png
        );

        a.write(|tx| {
            tx.execute(
                "UPDATE entries SET content_md='A 的正文' WHERE id='draft'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let (frozen, _) = stage_outbox(&a).unwrap().unwrap();
        let (_, _, cursor, _) = progress(&a).unwrap();
        let remote = Remote::open(&a, &sync).await.unwrap();
        let receipt: Receipt = response(
            remote
                .request(Method::POST, "v1/sync/push")
                .unwrap()
                .json(&json!({"protocolVersion":1,"cursor":cursor,"operations":[frozen]})),
        )
        .await
        .unwrap();
        assert_eq!(receipt.results[0].status, "applied");
        a.write(|tx| {
            tx.execute(
                "UPDATE entries SET content_md='A 的最终正文' WHERE id='draft'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        b.write(|tx| {
            tx.execute(
                "UPDATE entries SET content_md='B 的离线正文' WHERE id='draft'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        apply_received(&b).unwrap();
        let local = b
            .read(|conn| entries::snapshot(conn, "draft"))
            .unwrap()
            .unwrap();
        assert_eq!(local["contentMd"], "B 的离线正文");
        let (saved_remote,saved_generation):(String,i64) = b.read(|conn| Ok(conn.query_row(
            "SELECT remote_json,generation FROM sync_issues WHERE entity_type='entry' AND entity_id='draft'",
            [], |row| Ok((row.get(0)?,row.get(1)?)),
        )?)).unwrap();
        let remote: Entity = serde_json::from_str(&saved_remote).unwrap();
        assert_eq!(remote.payload["contentMd"], "A 的最终正文");
        let copies = resolve(
            &b,
            "draft",
            Resolution::Copy,
            remote.remote_revision,
            saved_generation,
        )
        .unwrap();
        assert_eq!(copies.changed_entries.len(), 2);
        let copy = b
            .read(|conn| entries::snapshot(conn, &copies.changed_entries[0]))
            .unwrap()
            .unwrap();
        assert_eq!(copy["contentMd"], "B 的离线正文");
        a.delete_category("sync-folder").unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        apply_received(&b).unwrap();
        let folder: bool = b
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM categories WHERE id='sync-folder')",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(folder);

        let local_png = image::DynamicImage::new_rgb8(3, 2);
        let mut local_bytes = std::io::Cursor::new(Vec::new());
        local_png
            .write_to(&mut local_bytes, image::ImageFormat::Png)
            .unwrap();
        let local_bytes = local_bytes.into_inner();
        let local_asset = b_assets.import(&b, "离线图片.png", &local_bytes).unwrap();
        let local_body = format!("离线稿\n\n![图](asset://{local_asset})");
        b.write(|tx| {
            tx.execute(
                "INSERT INTO entries (id,kind,title,status,content_md,created_at,updated_at)
                 VALUES ('offline-draft','article','未同步文稿','draft',?1,1,1)",
                [&local_body],
            )?;
            crate::assets::references::sync_entry(tx, "offline-draft", &local_body)?;
            Ok(())
        })
        .unwrap();
        stage_outbox(&b).unwrap().unwrap();
        let source_archive = b_backups
            .archive_sync_recovery(&b.read(crate::db::workspace_id).unwrap())
            .unwrap();
        b_backups
            .queue_workspace_archive_for_test(&source_archive)
            .unwrap();
        drop(b);
        let (b, b_backups) = Backups::open(&b_workspace).unwrap();
        assert!(Binding::read(&b).unwrap().unwrap().paused);
        assert_eq!(
            exchange(&b, &b_assets, &sync).await.unwrap_err().code(),
            "SYNC_PAUSED"
        );
        let read_entry =
            |db: &Workspace, id: &str| db.read(|conn| entries::snapshot(conn, id)).unwrap();
        assert_eq!(
            read_entry(&a, "draft").unwrap()["contentMd"],
            "A 的最终正文"
        );
        assert!(read_entry(&a, "offline-draft").is_none());
        stage_recovery(&b, &sync).await.unwrap();
        let offline = read_entry(&b, "offline-draft").unwrap();
        assert_eq!(offline["contentMd"], local_body);
        assert!(offline["deletedAt"].is_null());

        let remote_a = Remote::open(&a, &sync).await.unwrap();
        let revoked = remote_a
            .request(Method::DELETE, &format!("v1/devices/{}", second.device_id))
            .unwrap()
            .send()
            .await
            .unwrap();
        assert!(revoked.status().is_success());
        assert_eq!(
            stage_recovery(&b, &sync).await.unwrap_err().code(),
            "SYNC_REAUTH"
        );
        b.write(|tx| {
            tx.execute("UPDATE sync_binding SET epoch='historical-epoch'", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            stage_recovery(&b, &sync).await.unwrap_err().code(),
            "SYNC_REAUTH"
        );
        let invitation: Pairing = response(remote_a.request(Method::POST, "v1/pairings").unwrap())
            .await
            .unwrap();
        let rebound = register(
            &b,
            &sync,
            &url,
            "恢复后的 B",
            ConnectWith::Pair,
            &invitation.pairing_token,
            true,
        )
        .await
        .unwrap();
        assert!(rebound.paused);
        assert_eq!(rebound.epoch, first.epoch);
        assert_ne!(rebound.device_id, second.device_id);
        stage_recovery(&b, &sync).await.unwrap();
        let rebuilt = replace_baseline(&b, &b_backups).unwrap();
        assert!(
            rebuilt
                .changed
                .changed_entries
                .contains(&"offline-draft".to_owned())
        );
        assert!(!Binding::read(&b).unwrap().unwrap().paused);
        assert_eq!(
            read_entry(&b, "draft").unwrap()["contentMd"],
            read_entry(&a, "draft").unwrap()["contentMd"]
        );
        assert!(!read_entry(&b, "offline-draft").unwrap()["deletedAt"].is_null());
        assert!(stage_outbox(&b).unwrap().is_none());

        let isolated = root.path().join("archive-check");
        let (empty, archive_backups) = Backups::open(&isolated).unwrap();
        archive_backups
            .queue_workspace_archive_for_test(std::path::Path::new(&rebuilt.recovery_archive))
            .unwrap();
        drop(empty);
        let (recovered, _) = Backups::open(&isolated).unwrap();
        assert!(Binding::read(&recovered).unwrap().unwrap().paused);
        let offline = read_entry(&recovered, "offline-draft").unwrap();
        assert_eq!(offline["contentMd"], local_body);
        assert!(offline["deletedAt"].is_null());
        assert_eq!(
            Assets::new(isolated.join("assets"), &recovered)
                .unwrap()
                .read(&recovered, &format!("asset://{local_asset}"))
                .await
                .unwrap(),
            local_bytes
        );

        b.write(|tx| {
            tx.execute(
                "UPDATE entries SET content_md=?1 WHERE id='draft'",
                [&local_body],
            )?;
            crate::assets::references::sync_entry(tx, "draft", &local_body)?;
            Ok(())
        })
        .unwrap();
        exchange(&b, &b_assets, &sync).await.unwrap();
        exchange(&a, &a_assets, &sync).await.unwrap();
        apply_received(&a).unwrap();
        assert_eq!(read_entry(&a, "draft").unwrap()["contentMd"], local_body);
        assert!(read_entry(&a, "offline-draft").is_none());
        assert_eq!(
            a_assets
                .read(&a, &format!("asset://{local_asset}"))
                .await
                .unwrap(),
            local_bytes
        );
        first_key.delete_credential().unwrap();
        second_key.delete_credential().unwrap();
    }
}
