import { hashPattern, MAX_BLOB_BYTES, SyncError } from "./protocol.js";
import { query, type BlobStore, type Database, type Identity } from "./storage.js";
import { checkIdentity, type Client } from "./sync.js";
import { IMAGE_GC_RECOVERY_MS } from "./image-gc.js";

const authorized = `EXISTS(SELECT 1 FROM sync_identity s JOIN sync_devices d
 ON d.id=? AND d.token_hash=? AND d.revoked_at IS NULL WHERE s.instance_id=? AND s.epoch=?)`;
const credentials = (client: Client) => [client.deviceId, client.tokenHash, client.instanceId, client.epoch] as const;

export async function checkedBytes(source: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>, expected: string, size: number) {
  if (!hashPattern.test(expected) || !Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES) throw new SyncError(400, "invalid_gc_blob");
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(size);
  let length = 0;
  if (source instanceof Uint8Array) length = source.length;
  else {
  const reader = source.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (length + part.value.length > size) throw new SyncError(422, "gc_blob_size_mismatch");
      bytes.set(part.value, length);
      length += part.value.length;
    }
  } finally { await reader.cancel(); }
  }
  if (length !== size) throw new SyncError(422, "gc_blob_size_mismatch");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  if (hash !== expected) throw new SyncError(422, "gc_blob_checksum_mismatch");
  return bytes;
}

export type PrivateLocation = {
  id: string; scope: string; object_key: string; generation: string;
  source_sha256: string; content_sha256: string; size_bytes: number; managed: number; state: string;
  created_epoch: string;
};

export async function privateLocation(db: Database, hash: string) {
  const [location] = await query<PrivateLocation>(db, [
    "SELECT c.* FROM image_gc_private_heads h JOIN image_gc_copies c ON c.id=h.copy_id WHERE h.sha256=?", hash,
  ]);
  return location;
}

// Each upload has a fresh physical key, including a newly supplied copy of an expired logical hash.
// A previous request can therefore never overwrite the generation selected by a later restore.
export async function putManagedPrivate(db: Database, store: BlobStore, client: Client,
  hash: string, size: number, source: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>, timestamp = Date.now()) {
  const bytes = await checkedBytes(source, hash, size);
  const [state] = await query<Identity & { active: number }>(db, [`SELECT s.*,${authorized} AS active FROM sync_watermarks s`, ...credentials(client)]);
  checkIdentity(state, client);
  if (!state.active) throw new SyncError(401, "invalid_device");
  const copyId = crypto.randomUUID(), generation = crypto.randomUUID();
  const key = `wcbgc_${state.instance_id}_${state.workspace_id}_${state.epoch}_${generation}_${hash}`;
  const [reserved] = await db.batch([
    [`INSERT INTO image_gc_copies(id,backend,scope,object_key,generation,source_sha256,content_sha256,size_bytes,managed,state,created_at,created_epoch)
     SELECT ?,'private',?,?,?,?,?,?,1,'uploading',?,? WHERE ${authorized} RETURNING id`,
      copyId, `private:${state.instance_id}:${state.workspace_id}:${state.epoch}`, key, generation, hash, hash, size, timestamp, state.epoch, ...credentials(client)],
  ]);
  if (!reserved.length) throw new SyncError(401, "invalid_device");
  await store.put(key, size, bytes, hash);
  const readback = await store.get(key);
  if (!readback) throw new SyncError(503, "gc_blob_unavailable");
  await checkedBytes(readback, hash, size);
  const [committed] = await db.batch([
    [`UPDATE image_gc_copies SET state='live' WHERE id=? AND state='uploading' AND ${authorized} RETURNING id`, copyId, ...credentials(client)],
    [`UPDATE image_gc_jobs SET state='restored',restored_copy_id=? WHERE copy_id IN
     (SELECT copy_id FROM image_gc_private_heads WHERE sha256=?) AND EXISTS(SELECT 1 FROM image_gc_copies WHERE id=? AND state='live')`, copyId, hash, copyId],
    [`INSERT INTO image_gc_private_heads SELECT ?,? WHERE EXISTS(SELECT 1 FROM image_gc_copies WHERE id=? AND state='live')
     ON CONFLICT(sha256) DO UPDATE SET copy_id=excluded.copy_id`, hash, copyId, copyId],
    [`INSERT INTO sync_blobs SELECT ?,? WHERE EXISTS(SELECT 1 FROM image_gc_copies WHERE id=? AND state='live')
     ON CONFLICT(sha256) DO UPDATE SET size_bytes=excluded.size_bytes`, hash, size, copyId],
    ["UPDATE image_gc_state SET revision=revision+1 WHERE EXISTS(SELECT 1 FROM image_gc_copies WHERE id=? AND state='live')", copyId],
  ]);
  if (!committed.length) throw new SyncError(409, "gc_upload_superseded");
  return { copyId, generation, key };
}

type PrivateJob = PrivateLocation & Identity & {
  job_id: string; job_generation: string; job_state: string; backup_key: string | null;
  backup_verified: number; active: number;
};

async function privateJob(db: Database, client: Client, jobId: string) {
  const [job] = await query<PrivateJob>(db, [`SELECT c.*,s.instance_id,s.workspace_id,s.epoch,s.seed_status,
    j.id AS job_id,j.generation AS job_generation,j.state AS job_state,j.backup_key,j.backup_verified,
    ${authorized} AS active FROM image_gc_jobs j JOIN image_gc_copies c ON c.id=j.copy_id
    CROSS JOIN sync_watermarks s WHERE j.id=? AND c.backend='private'`, ...credentials(client), jobId]);
  if (!job) throw new SyncError(404, "gc_job_not_found");
  checkIdentity(job, client);
  if (!job.active) throw new SyncError(401, "invalid_device");
  if (job.seed_status !== "ready") throw new SyncError(409, "workspace_not_ready");
  const expected = `wcbgc_${job.instance_id}_${job.workspace_id}_${job.epoch}_${job.generation}_${job.content_sha256}`;
  if (!job.managed || job.created_epoch !== job.epoch || job.object_key !== expected
      || job.source_sha256 !== job.content_sha256 || job.job_generation !== job.generation) {
    throw new SyncError(409, "gc_object_identity_changed");
  }
  return job;
}

export async function gcRunPrivateJob(db: Database, store: BlobStore, client: Client, jobId: string, timestamp = Date.now()) {
  if (!store.remove) throw new SyncError(501, "gc_storage_unsupported");
  const job = await privateJob(db, client, jobId);
  if (job.state === "retired" || job.state === "expired") return { retired: true };
  if (!["deleting", "unknown"].includes(job.state)) throw new SyncError(409, "gc_job_changed");
  const backup = `wcbgc_recycle_${job.instance_id}_${job.workspace_id}_${job.epoch}_${job.job_id}_${job.content_sha256}`;
  if (job.backup_key && job.backup_key !== backup) throw new SyncError(409, "gc_backup_identity_changed");
  let deleteIssued = false;
  try {
    const original = await store.head(job.object_key);
    const [reserved] = await db.batch([
      [`UPDATE image_gc_jobs SET backup_key=?,state=CASE WHEN state='restored' THEN state ELSE 'backing_up' END,error=NULL
       WHERE id=? AND generation=? AND state IN ('claimed','backing_up','deleting','failed','unknown','restored') AND ${authorized} RETURNING id`,
        backup, jobId, job.generation, ...credentials(client)],
    ]);
    if (!reserved.length) throw new SyncError(409, "gc_job_changed");
    if (!job.backup_verified) {
      const source = await store.get(job.object_key);
      if (!source) throw new SyncError(409, "gc_source_missing");
      const bytes = await checkedBytes(source, job.content_sha256, job.size_bytes);
      await store.put(backup, bytes.length, bytes, job.content_sha256);
    }
    const readback = await store.get(backup);
    if (!readback) throw new SyncError(503, "gc_backup_missing");
    await checkedBytes(readback, job.content_sha256, job.size_bytes);
    const [granted] = await db.batch([
      [`UPDATE image_gc_jobs SET backup_verified=1,state=CASE WHEN state='restored' THEN state ELSE 'deleting' END
       WHERE id=? AND generation=? AND backup_key=? AND state IN ('backing_up','deleting','restored') AND ${authorized} RETURNING id`,
        jobId, job.generation, backup, ...credentials(client)],
    ]);
    if (!granted.length) throw new SyncError(409, "gc_job_changed");
    const current = await store.head(job.object_key);
    if (current && (!original || current.size !== job.size_bytes ||
        (original.version !== undefined && current.version !== original.version))) throw new SyncError(409, "gc_object_identity_changed");
    if (current && original?.version === undefined) {
      const source = await store.get(job.object_key);
      if (!source) throw new SyncError(409, "gc_object_identity_changed");
      await checkedBytes(source, job.content_sha256, job.size_bytes);
    }
    deleteIssued = true;
    if (current) await store.remove(job.object_key);
    if (await store.head(job.object_key)) throw new SyncError(503, "gc_delete_uncertain");
    const [completed] = await db.batch([
      [`UPDATE image_gc_jobs SET state=CASE WHEN state IN ('restoring','restored') THEN state ELSE 'retired' END,
        removed_at=?,expires_at=?,error=NULL WHERE id=? AND generation=? AND backup_verified=1
        AND state IN ('deleting','restoring','restored') AND ${authorized} RETURNING id`,
        timestamp, timestamp + IMAGE_GC_RECOVERY_MS, jobId, job.generation, ...credentials(client)],
      ["UPDATE image_gc_copies SET state='retired' WHERE id=? AND generation=? AND EXISTS(SELECT 1 FROM image_gc_jobs WHERE id=? AND state IN ('retired','restoring','restored'))",
        job.id, job.generation, jobId],
    ]);
    if (!completed.length) throw new SyncError(409, "gc_job_changed");
    return { retired: true };
  } catch (error) {
    await db.batch([
      [`UPDATE image_gc_jobs SET state=?,error=? WHERE id=? AND state NOT IN ('restoring','restored','expiring','expired') AND ${authorized}`,
        deleteIssued ? "unknown" : "failed", error instanceof SyncError ? error.code : "gc_storage_failed", jobId, ...credentials(client)],
      [`UPDATE image_gc_copies SET state='unknown' WHERE id=? AND generation=? AND ?=1
       AND EXISTS(SELECT 1 FROM image_gc_jobs WHERE id=? AND state='unknown') AND ${authorized}`,
        job.id, job.generation, Number(deleteIssued), jobId, ...credentials(client)],
    ]);
    throw error;
  }
}

export async function gcRestorePrivate(db: Database, store: BlobStore, client: Client,
  hash: string, retain = false, timestamp = Date.now()) {
  if (!hashPattern.test(hash)) throw new SyncError(400, "invalid_hash");
  const [state] = await query<Identity & { active: number }>(db, [`SELECT s.*,${authorized} AS active FROM sync_watermarks s`, ...credentials(client)]);
  checkIdentity(state, client);
  if (!state.active) throw new SyncError(401, "invalid_device");
  const head = await privateLocation(db, hash);
  if (!head) throw new SyncError(404, "blob_not_found");
  if (["live", "waiting"].includes(head.state) && (!head.managed || head.created_epoch === state.epoch)) {
    if (retain) await db.batch([[`INSERT OR IGNORE INTO image_gc_protections SELECT ?,'restored',?,? WHERE ${authorized}`,
      hash, client.deviceId, timestamp, ...credentials(client)]]);
    await db.batch([[`DELETE FROM image_gc_protections WHERE sha256=? AND reason='restoring' AND ${authorized}`, hash, ...credentials(client)]]);
    return { copyId: head.id, generation: head.generation, key: head.object_key };
  }
  const intent = crypto.randomUUID();
  const [reserved] = await db.batch([
    [`INSERT INTO image_gc_protections SELECT ?,'restoring',?,? WHERE ${authorized}
     AND EXISTS(SELECT 1 FROM image_gc_private_heads WHERE sha256=? AND copy_id=?)
     AND NOT EXISTS(SELECT 1 FROM image_gc_jobs WHERE copy_id=? AND state='expiring') RETURNING sha256`,
      hash, intent, timestamp, ...credentials(client), hash, head.id, head.id],
    [`UPDATE image_gc_jobs SET state='restoring',error=NULL WHERE copy_id=? AND backup_verified=1
     AND state IN ('deleting','retired','failed','unknown','restoring')
     AND EXISTS(SELECT 1 FROM image_gc_protections WHERE owner=? AND reason='restoring')`, head.id, intent],
    [`UPDATE image_gc_copies SET state='restoring' WHERE id=?
     AND EXISTS(SELECT 1 FROM image_gc_protections WHERE owner=? AND reason='restoring')`, head.id, intent],
  ]);
  if (!reserved.length) throw new SyncError(409, "gc_restore_busy");
  try {
    let source = await store.get(head.object_key);
    if (!source) {
      const alternatives = await query<{ object_key: string }>(db, [
        `SELECT object_key FROM image_gc_copies WHERE backend='private' AND source_sha256=? AND content_sha256=? AND id<>?
         AND state NOT IN ('retired','expired') ORDER BY state='live' DESC,created_at DESC,id`, hash, head.content_sha256, head.id,
      ]);
      for (const alternative of alternatives) {
        source = await store.get(alternative.object_key);
        if (source) break;
      }
    }
    if (!source) {
      const [backup] = await query<{ id: string; state: string; backup_key: string | null; backup_verified: number }>(db, [
        "SELECT id,state,backup_key,backup_verified FROM image_gc_jobs WHERE copy_id=? AND generation=?", head.id, head.generation,
      ]);
      if (!backup || backup.state === "expired") throw new SyncError(410, "gc_recovery_expired");
      if (!backup.backup_verified || !backup.backup_key) throw new SyncError(409, "gc_backup_pending");
      const expected = `wcbgc_recycle_${state.instance_id}_${state.workspace_id}_${head.created_epoch}_${backup.id}_${head.content_sha256}`;
      if (backup.backup_key !== expected) throw new SyncError(409, "gc_backup_identity_changed");
      source = await store.get(backup.backup_key);
      if (!source) throw new SyncError(503, "gc_backup_missing");
    }
    const bytes = await checkedBytes(source, head.content_sha256, head.size_bytes);
    const restored = await putManagedPrivate(db, store, client, hash, bytes.length, bytes, timestamp);
    await db.batch([
      [`INSERT OR IGNORE INTO image_gc_protections SELECT ?,'restored',?,? WHERE ?=1 AND ${authorized}`,
        hash, client.deviceId, timestamp, Number(retain), ...credentials(client)],
      [`UPDATE image_gc_copies SET state=CASE
        WHEN EXISTS(SELECT 1 FROM image_gc_jobs WHERE copy_id=? AND removed_at IS NOT NULL) THEN 'retired'
        WHEN EXISTS(SELECT 1 FROM image_gc_jobs WHERE copy_id=?) THEN 'deleting' ELSE 'live' END
        WHERE id=? AND ${authorized}`, head.id, head.id, head.id, ...credentials(client)],
      [`DELETE FROM image_gc_protections WHERE reason='restoring' AND sha256=? AND ${authorized}`, hash, ...credentials(client)],
    ]);
    return restored;
  } catch (error) {
    const expired = error instanceof SyncError && error.code === "gc_recovery_expired";
    await db.batch([
      [`UPDATE image_gc_jobs SET error=? WHERE copy_id=? AND state IN ('restoring','expired') AND ${authorized}`,
        error instanceof SyncError ? error.code : "gc_restore_failed", head.id, ...credentials(client)],
      [`UPDATE image_gc_copies SET state=? WHERE id=? AND state='restoring' AND ?=1
       AND EXISTS(SELECT 1 FROM image_gc_private_heads WHERE sha256=? AND copy_id=?) AND ${authorized}`,
        head.state, head.id, Number(expired), hash, head.id, ...credentials(client)],
      [`DELETE FROM image_gc_protections WHERE reason='restoring' AND owner=? AND ?=1 AND ${authorized}`,
        intent, Number(expired), ...credentials(client)],
    ]);
    throw error;
  }
}

export async function gcExpirePrivate(db: Database, store: BlobStore, client: Client, jobId: string, timestamp = Date.now()) {
  if (!store.remove) throw new SyncError(501, "gc_storage_unsupported");
  const job = await privateJob(db, client, jobId);
  if (job.job_state === "expired") return { expired: true };
  const expected = `wcbgc_recycle_${job.instance_id}_${job.workspace_id}_${job.epoch}_${job.job_id}_${job.content_sha256}`;
  if (!job.backup_key || job.backup_key !== expected) throw new SyncError(409, "gc_backup_identity_changed");
  const [claimed] = await db.batch([
    [`UPDATE image_gc_jobs AS j SET state='expiring',error=NULL WHERE j.id=? AND j.generation=?
     AND j.backup_verified=1 AND j.expires_at<=? AND (j.state IN ('retired','restored','expiring')
       OR (j.state='unknown' AND j.error='gc_expire_uncertain')) AND ${authorized}
     AND ((j.restored_copy_id IS NOT NULL AND EXISTS(SELECT 1 FROM image_gc_private_heads h
       JOIN image_gc_copies c ON c.id=h.copy_id WHERE h.sha256=? AND c.state='live' AND c.created_epoch=?))
       OR (NOT EXISTS(SELECT 1 FROM image_gc_live_hashes WHERE sha256=?)
         AND NOT EXISTS(SELECT 1 FROM image_gc_checkpoints p JOIN sync_devices d ON d.id=p.device_id,json_each(p.roots_json) root
           WHERE d.revoked_at IS NULL AND root.value=?)
         AND NOT EXISTS(SELECT 1 FROM image_gc_recovery_hashes r WHERE r.sha256=? AND r.origin_copy_id<>j.copy_id))) RETURNING id`,
      jobId, job.generation, timestamp, ...credentials(client), job.source_sha256, job.epoch,
      job.source_sha256, job.source_sha256, job.source_sha256],
  ]);
  if (!claimed.length) throw new SyncError(409, "gc_recovery_retained");
  try {
    const head = await privateLocation(db, job.source_sha256);
    if (head && head.id !== job.id && head.state === "live") {
      const source = await store.get(head.object_key);
      if (!source) throw new SyncError(503, "gc_restored_copy_unavailable");
      await checkedBytes(source, job.content_sha256, job.size_bytes);
    }
    const backup = await store.get(job.backup_key);
    if (backup) {
      await checkedBytes(backup, job.content_sha256, job.size_bytes);
      await store.remove(job.backup_key);
    }
    if (await store.head(job.backup_key)) throw new SyncError(503, "gc_expire_uncertain");
    const [completed] = await db.batch([
      [`UPDATE image_gc_jobs SET state='expired',backup_key=NULL,backup_verified=0,error=NULL
       WHERE id=? AND generation=? AND state='expiring' AND ${authorized} RETURNING id`, jobId, job.generation, ...credentials(client)],
      ["UPDATE image_gc_copies SET state='expired' WHERE id=? AND EXISTS(SELECT 1 FROM image_gc_jobs WHERE id=? AND state='expired')", job.id, jobId],
    ]);
    if (!completed.length) throw new SyncError(409, "gc_job_changed");
    return { expired: true };
  } catch (error) {
    await db.batch([[`UPDATE image_gc_jobs SET error=? WHERE id=? AND state='expiring' AND ${authorized}`,
      error instanceof SyncError ? error.code : "gc_expire_failed", jobId, ...credentials(client)]]);
    throw error;
  }
}
