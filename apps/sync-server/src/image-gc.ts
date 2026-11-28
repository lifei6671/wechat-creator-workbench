import { hashPattern, id, integer, invalid, SyncError } from "./protocol.js";
import { query, type Database, type Identity } from "./storage.js";
import { checkIdentity, type Client } from "./sync.js";

export const IMAGE_GC_CAPABILITY = 1;
export const IMAGE_GC_WAIT_MS = 7 * 86400000;
export const IMAGE_GC_RECOVERY_MS = 30 * 86400000;

const authorized = `EXISTS(SELECT 1 FROM sync_identity s JOIN sync_devices d
 ON d.id=? AND d.token_hash=? AND d.revoked_at IS NULL WHERE s.instance_id=? AND s.epoch=? AND s.seed_status='ready')`;
const credentials = (client: Client) => [client.deviceId, client.tokenHash, client.instanceId, client.epoch] as const;
const unused = (alias = "image_gc_copies") => `${alias}.source_sha256 NOT IN(SELECT sha256 FROM image_gc_live_hashes)
 AND ${alias}.created_epoch=(SELECT epoch FROM sync_identity)
 AND NOT EXISTS(SELECT 1 FROM image_gc_checkpoints p JOIN sync_devices d ON d.id=p.device_id,
 json_each(p.roots_json) root WHERE d.revoked_at IS NULL AND root.value=${alias}.source_sha256)
 AND EXISTS(SELECT 1 FROM image_gc_render_assets r WHERE r.sha256=${alias}.source_sha256)`;
const unavailable = `c.state IN ('deleting','retired','restoring','expired','unknown') AND (
 (c.backend='private' AND EXISTS(SELECT 1 FROM image_gc_private_heads h WHERE h.copy_id=c.id))
 OR (c.backend='s3' AND NOT EXISTS(SELECT 1 FROM image_gc_jobs j WHERE j.copy_id=c.id AND j.restored_copy_id IS NOT NULL)))`;

async function requireClient(db: Database, client: Client) {
  const [row] = await query<Identity & { active: number }>(db, [`SELECT s.*,${authorized} AS active FROM sync_watermarks s`, ...credentials(client)]);
  checkIdentity(row, client);
  if (!row.active) throw new SyncError(401, "invalid_device");
  if (row.seed_status !== "ready") throw new SyncError(409, "workspace_not_ready");
  return row;
}

type Copy = {
  id: string; backend: "private" | "s3"; scope: string; object_key: string; generation: string;
  source_sha256: string; content_sha256: string; size_bytes: number; state: string; due_at: number | null;
};
type Round = { id: string; revision: number; cursor: number; candidates_json: string };

// Only called after ordinary synchronization is quiescent. No object-store I/O occurs in a DB batch.
export async function gcFeed(db: Database, client: Client, timestamp = Date.now()) {
  await requireClient(db, client);
  const roundId = crypto.randomUUID();
  const [, , , rounds, copies, jobs] = await db.batch([
    [`UPDATE image_gc_copies SET state='live',due_at=NULL WHERE state='waiting' AND NOT(${unused()}) AND ${authorized}`, ...credentials(client)],
    [`UPDATE image_gc_copies SET state='waiting',due_at=? WHERE state='live' AND managed=1 AND ${unused()} AND ${authorized}`,
      timestamp + IMAGE_GC_WAIT_MS, ...credentials(client)],
    [`INSERT INTO image_gc_rounds(id,revision,cursor,candidates_json,created_at)
     SELECT ?,revision,head_cursor,COALESCE((SELECT json_group_array(json_object('id',id,'generation',generation,'sha256',source_sha256) ORDER BY id)
       FROM image_gc_copies WHERE state='waiting' AND managed=1),'[]'),?
     FROM image_gc_state g CROSS JOIN sync_watermarks s WHERE ${authorized}
     AND NOT EXISTS(SELECT 1 FROM image_gc_rounds r WHERE r.revision=g.revision AND r.cursor=s.head_cursor
       AND r.candidates_json=COALESCE((SELECT json_group_array(json_object('id',id,'generation',generation,'sha256',source_sha256) ORDER BY id)
         FROM image_gc_copies WHERE state='waiting' AND managed=1),'[]'))`, roundId, timestamp, ...credentials(client)],
    ["SELECT r.* FROM image_gc_rounds r CROSS JOIN image_gc_state g CROSS JOIN sync_watermarks s WHERE r.revision=g.revision AND r.cursor=s.head_cursor ORDER BY r.created_at DESC,r.id DESC LIMIT 1"],
    ["SELECT c.*,p.public_url,p.object_version,EXISTS(SELECT 1 FROM image_gc_private_heads h WHERE h.copy_id=c.id) AS current FROM image_gc_copies c LEFT JOIN image_gc_public_locations p ON p.copy_id=c.id ORDER BY c.id"],
    ["SELECT id,copy_id,state,expires_at,error,restored_copy_id,backup_verified,removed_at FROM image_gc_jobs ORDER BY created_at,id"],
  ]);
  await requireClient(db, client);
  const round = rounds[0] as Round | undefined;
  if (!round) throw new SyncError(409, "gc_state_changed");
  return { capability: IMAGE_GC_CAPABILITY, roundId: round.id, revision: round.revision, cursor: round.cursor,
    candidates: JSON.parse(round.candidates_json) as { id: string; generation: string; sha256: string }[],
    jobs,
    copies: (copies as Copy[]).map(copy => ({ id: copy.id, backend: copy.backend, scope: copy.scope, key: copy.object_key,
      generation: copy.generation, sha256: copy.source_sha256, contentSha256: copy.content_sha256, bytes: copy.size_bytes,
      state: copy.state, dueAt: copy.due_at, current: Boolean((copy as Copy & {current:number}).current), createdAt: (copy as Copy & {created_at:number}).created_at, publicUrl: (copy as Copy & { public_url: string | null }).public_url, version: (copy as Copy & { object_version: string | null }).object_version })) };
}

export async function gcCheckpoint(db: Database, client: Client, input: Record<string, unknown>, timestamp = Date.now()) {
  const round = id(input.roundId), revision = integer(input.revision), cursor = integer(input.cursor);
  if (input.capability !== IMAGE_GC_CAPABILITY || input.complete !== true || input.barrierPersisted !== true
      || !Array.isArray(input.roots) || input.roots.some(hash => typeof hash !== "string" || !hashPattern.test(hash))
      || new Set(input.roots).size !== input.roots.length) invalid("invalid_gc_checkpoint");
  const roots = JSON.stringify(input.roots);
  const [rows] = await db.batch([
    [`INSERT INTO image_gc_checkpoints(device_id,round_id,revision,cursor,capability,roots_json,created_at)
     SELECT ?,?,?,?,?,?,? FROM image_gc_rounds r CROSS JOIN image_gc_state g CROSS JOIN sync_watermarks s
     WHERE r.id=? AND r.revision=? AND g.revision=? AND r.cursor=? AND s.head_cursor=? AND ${authorized}
     ON CONFLICT(device_id) DO UPDATE SET round_id=excluded.round_id,revision=excluded.revision,cursor=excluded.cursor,
       capability=excluded.capability,roots_json=excluded.roots_json,created_at=excluded.created_at RETURNING device_id`,
      client.deviceId, round, revision, cursor, IMAGE_GC_CAPABILITY, roots, timestamp, round, revision, revision, cursor, cursor, ...credentials(client)],
  ]);
  await requireClient(db, client);
  if (!rows.length) throw new SyncError(409, "gc_checkpoint_stale");
  return { accepted: true };
}

export async function gcProtect(db: Database, client: Client, hashes: string[], owner: string, timestamp = Date.now()) {
  if (!hashes.length || hashes.some(hash => !hashPattern.test(hash)) || new Set(hashes).size !== hashes.length) invalid("invalid_gc_protection");
  id(owner);
  const encoded = JSON.stringify(hashes);
  const [rows] = await db.batch([
    [`INSERT OR IGNORE INTO image_gc_protections(sha256,reason,owner,created_at)
     SELECT value,'external',?,? FROM json_each(?) WHERE ${authorized}
     AND NOT EXISTS(SELECT 1 FROM image_gc_copies c WHERE c.source_sha256 IN(SELECT value FROM json_each(?))
       AND ${unavailable}) RETURNING sha256`,
      owner, timestamp, encoded, ...credentials(client), encoded],
  ]);
  await requireClient(db, client);
  const [blocked] = await query<{ blocked: number }>(db, [`SELECT EXISTS(SELECT 1 FROM image_gc_copies c WHERE source_sha256 IN(SELECT value FROM json_each(?)) AND ${unavailable}) AS blocked`, encoded]);
  if (blocked.blocked) throw new SyncError(409, "gc_restore_required");
  return { protected: hashes.length, added: rows.length };
}

export async function gcBeginDelete(db: Database, client: Client, copyId: string, roundId: string, timestamp = Date.now()) {
  id(copyId); id(roundId);
  const jobId = crypto.randomUUID();
  const [jobs] = await db.batch([
    [`INSERT INTO image_gc_jobs(id,copy_id,generation,round_id,executor,state,created_at)
     SELECT ?,c.id,c.generation,?,?,'claimed',? FROM image_gc_copies c CROSS JOIN image_gc_state g CROSS JOIN sync_watermarks s
     JOIN image_gc_rounds r ON r.id=? AND r.revision=g.revision AND r.cursor=s.head_cursor
     WHERE c.id=? AND c.state='waiting' AND c.managed=1 AND c.due_at<=? AND ${unused("c")}
     AND EXISTS(SELECT 1 FROM json_each(r.candidates_json) candidate WHERE candidate.value->>'$.id'=c.id AND candidate.value->>'$.generation'=c.generation)
     AND NOT EXISTS(SELECT 1 FROM sync_devices d WHERE d.revoked_at IS NULL AND NOT EXISTS(
       SELECT 1 FROM image_gc_checkpoints p WHERE p.device_id=d.id AND p.round_id=r.id AND p.revision=g.revision
         AND p.cursor=s.head_cursor AND p.capability=1)) AND ${authorized}
     ON CONFLICT(copy_id,generation) DO NOTHING RETURNING *`,
      jobId, roundId, client.deviceId, timestamp, roundId, copyId, timestamp, ...credentials(client)],
    ["UPDATE image_gc_copies SET state='deleting' WHERE id=? AND EXISTS(SELECT 1 FROM image_gc_jobs WHERE id=?)", copyId, jobId],
  ]);
  await requireClient(db, client);
  if (!jobs.length) throw new SyncError(409, "gc_not_eligible");
  return jobs[0];
}


// Import only unavailable derived history when initializing a new workspace. It does not
// manufacture a sync_blobs availability record; normal reference admission still rejects it.
export async function gcImportHistory(db:Database,client:Client,input:Record<string,unknown>) {
  const assetId=id(input.assetId),sourceKey=input.sourceKey,hash=input.sha256,size=integer(input.bytes);
  if(typeof sourceKey!=="string"||!sourceKey.startsWith("image-render:")||typeof hash!=="string"||!hashPattern.test(hash)) invalid("invalid_gc_import");
  id(sourceKey.slice(13));
  const [state]=await query<Identity & {active:number}>(db,[`SELECT s.*,EXISTS(SELECT 1 FROM sync_devices WHERE id=? AND token_hash=? AND revoked_at IS NULL) AS active FROM sync_watermarks s`,client.deviceId,client.tokenHash]);
  checkIdentity(state,client);if(!state.active)throw new SyncError(401,"invalid_device");
  const copy=crypto.randomUUID(),generation=crypto.randomUUID();
  const [rows]=await db.batch([[`INSERT INTO image_gc_imports SELECT ?,?,?,? FROM sync_identity s WHERE s.instance_id=? AND s.epoch=? AND s.seed_status='seeding' AND s.seed_device=?
    AND EXISTS(SELECT 1 FROM sync_devices WHERE id=? AND token_hash=? AND revoked_at IS NULL)
    ON CONFLICT(asset_id) DO UPDATE SET sha256=excluded.sha256,source_key=excluded.source_key,size_bytes=excluded.size_bytes RETURNING asset_id`,
    assetId,hash,sourceKey,size,client.instanceId,client.epoch,client.deviceId,client.deviceId,client.tokenHash],
    [`INSERT INTO image_gc_copies(id,backend,scope,object_key,generation,source_sha256,content_sha256,size_bytes,managed,state,created_at,created_epoch)
     SELECT ?,'private',?,?,?,?,?,?,0,'expired',?,? WHERE EXISTS(SELECT 1 FROM image_gc_imports WHERE asset_id=? AND sha256=?) AND NOT EXISTS(SELECT 1 FROM image_gc_private_heads WHERE sha256=?)`,
      copy,`private:${state.instance_id}:${state.workspace_id}:${state.epoch}`,`wcbgc_unavailable_${copy}`,generation,hash,hash,size,Date.now(),state.epoch,assetId,hash,hash],
    ["INSERT OR IGNORE INTO image_gc_private_heads SELECT ?,? WHERE EXISTS(SELECT 1 FROM image_gc_copies WHERE id=?)",hash,copy,copy]]);
  if(!rows.length) throw new SyncError(409,"gc_import_not_seeding");return {imported:true};
}
