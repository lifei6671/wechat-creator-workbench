import { hashPattern, id, integer, invalid, SyncError } from "./protocol.js";
import { query, identity, type BlobStore, type Database, type Statement } from "./storage.js";
import { checkIdentity, type Client } from "./sync.js";
import { checkedBytes } from "./image-gc-store.js";
import { IMAGE_GC_RECOVERY_MS } from "./image-gc.js";

async function active(db: Database, client: Client) {
  const state=await identity(db); checkIdentity(state,client);
  const [device]=await query(db,["SELECT id FROM sync_devices WHERE id=? AND token_hash=? AND revoked_at IS NULL",client.deviceId,client.tokenHash]);
  if(!device) throw new SyncError(401,"invalid_device");
  return state;
}
async function batch(db:Database,client:Client,statements:Statement[]) {
  try {
    const rows=await db.batch([[`INSERT INTO image_gc_authorization SELECT 1,EXISTS(SELECT 1 FROM sync_identity s JOIN sync_devices d
      ON d.id=? AND d.token_hash=? AND d.revoked_at IS NULL WHERE s.instance_id=? AND s.epoch=?)`,client.deviceId,client.tokenHash,client.instanceId,client.epoch],
      ...statements,["DELETE FROM image_gc_authorization"]]);
    return rows.slice(1,-1);
  } catch(error) {await active(db,client);throw error;}
}
export async function reservePublic(db:Database,client:Client,input:Record<string,unknown>) {
  const state=await active(db,client);
  const source=input.sha256,content=input.contentSha256,scope=input.scope,prefix=input.prefix,format=input.format;
  if(typeof source!=="string"||!hashPattern.test(source)||typeof content!=="string"||!hashPattern.test(content)
    ||typeof scope!=="string"||!hashPattern.test(scope)||typeof prefix!=="string"||prefix.length>800
    ||prefix.split("/").some(part=>part===".."||part===".")||!['png','jpg','jpeg','webp','gif'].includes(String(format))) invalid("invalid_gc_location");
  const size=integer(input.bytes),copyId=crypto.randomUUID(),generation=crypto.randomUUID();
  if(size>25*1024*1024) invalid("invalid_gc_location");
  const namespace=`${prefix.replace(/\/$/,"")}/wcbgc-s3-${state.instance_id}-${state.epoch}-`;
  const key=`${namespace}${generation}.${format}`;
  const [,rows]=await batch(db,client,[[`INSERT INTO image_gc_copies(id,backend,scope,object_key,generation,source_sha256,content_sha256,size_bytes,managed,state,created_at,created_epoch)
    SELECT ?,'s3',?,?,?,?,?,?,1,'uploading',?,? FROM sync_identity s
    WHERE s.instance_id=? AND s.epoch=? AND EXISTS(SELECT 1 FROM sync_devices WHERE id=? AND token_hash=? AND revoked_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM image_gc_copies WHERE backend='s3' AND scope=? AND source_sha256=? AND content_sha256=? AND size_bytes=? AND state='uploading' AND created_epoch=? AND substr(object_key,1,length(?))=?)`,
    copyId,scope,key,generation,source,content,size,Date.now(),state.epoch,client.instanceId,client.epoch,client.deviceId,client.tokenHash,scope,source,content,size,state.epoch,namespace,namespace],
    ["SELECT id,generation,object_key FROM image_gc_copies WHERE backend='s3' AND scope=? AND source_sha256=? AND content_sha256=? AND size_bytes=? AND state='uploading' AND created_epoch=? AND substr(object_key,1,length(?))=? ORDER BY created_at,id LIMIT 1",scope,source,content,size,state.epoch,namespace,namespace]]);
  const row=rows[0] as {id:string;generation:string;object_key:string}|undefined;
  if(!row) throw new SyncError(409,"gc_upload_superseded");
  return {copyId:row.id,generation:row.generation,key:row.object_key};
}
export async function commitPublic(db:Database,client:Client,input:Record<string,unknown>) {
  await active(db,client);
  const copyId=id(input.copyId),url=input.publicUrl,version=input.version;
  if(typeof url!=="string"||url.length>4096||!/^https?:\/\//.test(url)||(version!==null&&typeof version!=="string")) invalid("invalid_gc_location");
  const [rows]=await batch(db,client,[[`UPDATE image_gc_copies SET state='live' WHERE id=? AND backend='s3' AND state IN ('uploading','live')
    AND created_epoch=? RETURNING id`,copyId,client.epoch],
    [`INSERT INTO image_gc_public_locations SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM image_gc_copies WHERE id=? AND state='live')
     ON CONFLICT(copy_id) DO UPDATE SET public_url=excluded.public_url,object_version=excluded.object_version`,copyId,url,version,copyId]]);
  if(!rows.length) throw new SyncError(409,"gc_upload_superseded");
  return {committed:true};
}
async function job(db:Database,client:Client,jobId:string) {
  const state=await active(db,client);
  const [row]=await query<{id:string;copy_id:string;generation:string;content_sha256:string;size_bytes:number;state:string;backup_key:string|null;backup_verified:number;created_epoch:string;removed_at:number|null;expires_at:number|null}>(db,
    ["SELECT j.*,c.content_sha256,c.size_bytes,c.created_epoch FROM image_gc_jobs j JOIN image_gc_copies c ON c.id=j.copy_id WHERE j.id=? AND c.backend='s3'",id(jobId)]);
  if(!row||row.created_epoch!==client.epoch) throw new SyncError(409,"gc_object_identity_changed");
  return {...row, key:`wcbgc_recycle_${state.instance_id}_${state.workspace_id}_${state.epoch}_${row.id}_${row.content_sha256}`};
}
export async function backupPublic(db:Database,store:BlobStore,client:Client,jobId:string,source:ReadableStream<Uint8Array>) {
  const j=await job(db,client,jobId);
  if(!['claimed','backing_up','failed','unknown','deleting'].includes(j.state)) throw new SyncError(409,"gc_job_changed");
  const bytes=await checkedBytes(source,j.content_sha256,j.size_bytes);
  await store.put(j.key,j.size_bytes,bytes,j.content_sha256);
  const read=await store.get(j.key); if(!read) throw new SyncError(503,"gc_backup_missing");
  await checkedBytes(read,j.content_sha256,j.size_bytes);
  const [rows]=await batch(db,client,[[`UPDATE image_gc_jobs SET backup_key=?,backup_verified=1,state='deleting',error=NULL
    WHERE id=? AND generation=? AND state IN ('claimed','backing_up','failed','unknown','deleting') RETURNING id`,j.key,j.id,j.generation]]);
  if(!rows.length) throw new SyncError(409,"gc_job_changed");
  return {deleteAuthorized:true,copyId:j.copy_id,generation:j.generation};
}
export async function completePublic(db:Database,client:Client,input:Record<string,unknown>) {
  const j=await job(db,client,id(input.jobId));
  const [rows]=await batch(db,client,[[`UPDATE image_gc_jobs SET state=CASE WHEN state IN ('restoring','restored') THEN state ELSE 'retired' END,removed_at=COALESCE(removed_at,?),expires_at=COALESCE(expires_at,?) WHERE id=? AND generation=?
    AND state IN ('deleting','retired','restoring','restored') AND backup_verified=1 RETURNING id`,Date.now(),Date.now()+IMAGE_GC_RECOVERY_MS,j.id,j.generation],
    ["UPDATE image_gc_copies SET state='retired' WHERE id=? AND EXISTS(SELECT 1 FROM image_gc_jobs WHERE id=? AND state IN ('retired','restoring','restored'))",j.copy_id,j.id]]);
  if(!rows.length) throw new SyncError(409,"gc_job_changed"); return {retired:true};
}
export async function publicBackup(db:Database,store:BlobStore,client:Client,jobId:string) {
  const j=await job(db,client,jobId);
  if(!j.backup_verified && !['expired','expiring'].includes(j.state)) throw new SyncError(409,"gc_backup_pending");
  const [claimed]=await batch(db,client,[[`UPDATE image_gc_jobs SET state='restoring' WHERE id=? AND backup_verified=1
    AND state IN ('retired','restoring','deleting') RETURNING id`,j.id]]);
  if(!claimed.length||j.backup_key!==j.key) throw new SyncError(410,"gc_recovery_expired");
  const body=await store.get(j.key); if(!body) throw new SyncError(503,"gc_backup_missing");
  return checkedBytes(body,j.content_sha256,j.size_bytes);
}
export async function restoredPublic(db:Database,client:Client,input:Record<string,unknown>) {
  const j=await job(db,client,id(input.jobId)),copy=id(input.copyId);
  const [rows]=await batch(db,client,[[`UPDATE image_gc_jobs SET state='restored',restored_copy_id=? WHERE id=?
    AND state IN ('restoring','restored') AND EXISTS(SELECT 1 FROM image_gc_copies c JOIN image_gc_copies old ON old.id=?
    WHERE c.id=? AND c.backend='s3' AND c.managed=1 AND c.state='live' AND c.scope=old.scope
    AND c.content_sha256=old.content_sha256 AND c.source_sha256=old.source_sha256 AND c.id<>old.id AND c.created_epoch=?) RETURNING id`,
    copy,j.id,j.copy_id,copy,client.epoch],
    ["UPDATE image_gc_copies SET state='retired' WHERE id=? AND EXISTS(SELECT 1 FROM image_gc_jobs WHERE id=? AND state='restored')",j.copy_id,j.id]]);
  if(!rows.length) throw new SyncError(409,"gc_job_changed"); return {restored:true};
}

export async function expirePublic(db:Database,store:BlobStore,client:Client,jobId:string) {
  const j=await job(db,client,jobId);
  if(j.state==='expired') return {expired:true};
  if(!store.remove) throw new SyncError(501,'gc_storage_unsupported');
  const [claimed]=await batch(db,client,[[`UPDATE image_gc_jobs AS j SET state='expiring' WHERE id=? AND backup_verified=1
    AND expires_at<=? AND state IN ('retired','restored','expiring') AND backup_key=?
    AND (EXISTS(SELECT 1 FROM image_gc_copies c WHERE c.id=j.restored_copy_id AND c.state='live')
      OR (NOT EXISTS(SELECT 1 FROM image_gc_live_hashes WHERE sha256=(SELECT source_sha256 FROM image_gc_copies WHERE id=j.copy_id))
       AND NOT EXISTS(SELECT 1 FROM image_gc_checkpoints p JOIN sync_devices d ON d.id=p.device_id,json_each(p.roots_json) root WHERE d.revoked_at IS NULL AND root.value=(SELECT source_sha256 FROM image_gc_copies WHERE id=j.copy_id))
       AND NOT EXISTS(SELECT 1 FROM image_gc_recovery_hashes r JOIN image_gc_copies c ON c.id=j.copy_id
       WHERE r.sha256=c.source_sha256 AND r.origin_copy_id<>j.copy_id))) RETURNING id`,j.id,Date.now(),j.key]]);
  if(!claimed.length) throw new SyncError(409,'gc_recovery_retained');
  const source=await store.get(j.key);
  if(source) {await checkedBytes(source,j.content_sha256,j.size_bytes);await store.remove(j.key);}
  if(await store.head(j.key)) throw new SyncError(503,'gc_expire_uncertain');
  await batch(db,client,[["UPDATE image_gc_jobs SET state='expired',backup_key=NULL,backup_verified=0,error=NULL WHERE id=? AND state='expiring'",j.id],
    ["UPDATE image_gc_copies SET state='expired' WHERE id=? AND EXISTS(SELECT 1 FROM image_gc_jobs WHERE id=? AND state='expired')",j.copy_id,j.id]]);
  return {expired:true};
}
