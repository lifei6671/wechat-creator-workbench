import { MAX_PAGE_BYTES, sha256, SyncError, type operation } from "./protocol.js";
import { query, type Database, type Identity } from "./storage.js";

export type Client = { instanceId: string; epoch: string; deviceId: string };

export function checkIdentity(state: Identity, client: Client) {
  if (state.instance_id !== client.instanceId || state.epoch !== client.epoch) throw new SyncError(409, "reset_required");
}

function checkReady(state: Identity) {
  if (state.seed_status !== "ready") throw new SyncError(409, "workspace_not_ready");
}

function checkCursor(state: Identity, cursor: number) {
  if (cursor < state.min_cursor || cursor > state.head_cursor) throw new SyncError(409, "reset_required");
}

export function checkPush(state: Identity, client: Client, cursor: number) {
  checkIdentity(state, client);
  if (state.seed_status === "ready") checkCursor(state, cursor);
  else if (state.seed_status !== "seeding" || state.seed_device !== client.deviceId) checkReady(state);
}

export async function seed(db: Database, client: Client, action: "begin" | "finish") {
  const [rows] = await db.batch([[
    `UPDATE sync_identity SET seed_status = ?, seed_device = ?
     WHERE instance_id = ? AND epoch = ? AND (${action === "begin"
      ? "seed_status = 'empty' OR (seed_status = 'seeding' AND seed_device = ?)"
      : "seed_status IN ('seeding', 'ready') AND seed_device = ?"})
       AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND revoked_at IS NULL)
     RETURNING seed_status`,
    action === "begin" ? "seeding" : "ready", client.deviceId, client.instanceId, client.epoch,
    client.deviceId, client.deviceId,
  ]]);
  if (!rows.length) throw new SyncError(409, "seed_unavailable");
  return { seedStatus: action === "begin" ? "seeding" : "ready" };
}

type EntityVersion = { entityType: string; entityId: string; remoteRevision: number };
type Receipt = {
  request_hash: string;
  group_id: string;
  status: "applied" | "conflict" | "rejected";
  reason: string | null;
  versions_json: string;
  cursor: number | null;
};

const applyGate = `
  instance_id = ? AND epoch = ?
    AND ((seed_status = 'seeding' AND seed_device = ?) OR (seed_status = 'ready' AND ? BETWEEN min_cursor AND head_cursor))
    AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND revoked_at IS NULL)`;

export async function apply(db: Database, client: Client, cursor: number, input: ReturnType<typeof operation>) {
  const mutations = JSON.stringify(input.mutations);
  const digest = await sha256(mutations);
  const groupId = crypto.randomUUID();
  const now = Date.now();
  const key = [client.epoch, client.deviceId, input.operationId] as const;
  const [, , , , , , receiptRows, stateRows] = await db.batch([
    [`INSERT INTO sync_pending
        (entity_type, entity_id, base_revision, revision, operation, payload_json, deleted_at, group_index)
      SELECT m.value ->> '$.entityType', m.value ->> '$.entityId', m.value ->> '$.baseRevision',
        COALESCE(e.revision, 0) + 1,
        CASE WHEN m.value ->> '$.operation' = 'delete' AND m.value ->> '$.entityType' = 'entry'
              AND m.value ->> '$.payload' IS NOT NULL
          THEN CASE WHEN e.deleted_at IS NULL THEN 'upsert' ELSE 'restore' END
          ELSE m.value ->> '$.operation' END,
        CASE WHEN m.value ->> '$.operation' = 'delete'
          THEN COALESCE(NULLIF(m.value -> '$.payload', 'null'),
               CASE WHEN e.entity_type = 'entry' THEN e.payload_json ELSE '{}' END)
          ELSE m.value -> '$.payload' END,
        CASE WHEN m.value ->> '$.operation' = 'delete' THEN ? ELSE NULL END,
        CAST(m.key AS INTEGER)
      FROM json_each(?) m
      CROSS JOIN sync_watermarks
      LEFT JOIN sync_entities e ON (e.entity_type, e.entity_id) = (m.value ->> '$.entityType', m.value ->> '$.entityId')
      WHERE ${applyGate}
        AND NOT EXISTS (SELECT 1 FROM sync_operations WHERE (epoch, device_id, operation_id) = (?, ?, ?))`,
      now, mutations, client.instanceId, client.epoch, client.deviceId, cursor, client.deviceId, ...key],
    [`INSERT INTO sync_operations (epoch, device_id, operation_id, request_hash, group_id, status, reason, versions_json)
      SELECT ?, ?, ?, ?, ?,
        CASE WHEN reason IS NULL THEN 'applied'
          WHEN reason IN ('category_missing', 'blob_missing', 'asset_missing', 'source_entry_missing',
            'collection_missing', 'canvas_endpoint_missing', 'canvas_parent_changed') THEN 'rejected' ELSE 'conflict' END,
        reason,
        (SELECT json_group_array(json_object('entityType', entity_type, 'entityId', entity_id,
          'remoteRevision', revision) ORDER BY group_index, entity_id)
         FROM (
           SELECT p.entity_type, p.entity_id, p.group_index,
             CASE WHEN reason IS NULL THEN p.revision ELSE COALESCE(e.revision, 0) END AS revision
           FROM sync_pending p LEFT JOIN sync_entities e ON (p.entity_type, p.entity_id) = (e.entity_type, e.entity_id)
           UNION ALL
           SELECT DISTINCT e.entity_type, e.entity_id, 2147483647, e.revision
           FROM sync_pending p JOIN sync_entities e
             ON e.entity_type = 'category' AND e.deleted_at IS NULL
             AND json_extract(e.payload_json, '$.parentId') IS json_extract(p.payload_json, '$.parentId')
             AND json_extract(e.payload_json, '$.name') = json_extract(p.payload_json, '$.name') COLLATE NOCASE
           WHERE reason = 'category_name_conflict' AND p.entity_type = 'category' AND p.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM sync_pending x WHERE (x.entity_type, x.entity_id) = (e.entity_type, e.entity_id))
         ))
      FROM (
        SELECT COALESCE(reason, dependency_reason, canvas_reason) AS reason
        FROM sync_validation CROSS JOIN sync_article_dependencies CROSS JOIN sync_canvas_dependencies
      ) WHERE EXISTS (SELECT 1 FROM sync_pending)`, ...key, digest, groupId],
    [`INSERT INTO sync_entities (entity_type, entity_id, revision, payload_json, deleted_at, updated_at)
      SELECT entity_type, entity_id, revision, payload_json, deleted_at, ?
      FROM sync_pending WHERE EXISTS (SELECT 1 FROM sync_operations WHERE group_id = ? AND status = 'applied')
      ON CONFLICT (entity_type, entity_id) DO UPDATE
      SET revision = excluded.revision, payload_json = excluded.payload_json,
        deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`, now, groupId],
    [`INSERT INTO sync_changes
        (entity_type, entity_id, revision, operation, payload_json, deleted_at, group_id, group_index, group_size, changed_at)
      SELECT entity_type, entity_id, revision, CASE WHEN deleted_at IS NOT NULL THEN 'delete' ELSE 'upsert' END,
        payload_json, deleted_at, ?, group_index, (SELECT COUNT(*) FROM sync_pending), ?
      FROM sync_pending WHERE EXISTS (SELECT 1 FROM sync_operations WHERE group_id = ? AND status = 'applied')
      ORDER BY group_index`, groupId, now, groupId],
    [`UPDATE sync_operations SET cursor = (SELECT MAX(cursor) FROM sync_changes)
      WHERE (epoch, device_id, operation_id) = (?, ?, ?) AND group_id = ? AND status = 'applied'`, ...key, groupId],
    ["DELETE FROM sync_pending"],
    ["SELECT * FROM sync_operations WHERE (epoch, device_id, operation_id) = (?, ?, ?)", ...key],
    [`SELECT sync_watermarks.*, EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND revoked_at IS NULL) AS active
      FROM sync_watermarks`, client.deviceId],
  ]);
  const state = stateRows[0] as Identity & { active: number };
  checkPush(state, client, cursor);
  if (!state.active) throw new SyncError(401, "invalid_device");
  const receipt = receiptRows[0] as Receipt;
  if (receipt.request_hash !== digest) {
    return { operationId: input.operationId, status: "rejected", reason: "operation_id_reused" };
  }
  return {
    operationId: input.operationId,
    status: receipt.status === "applied" && receipt.group_id !== groupId ? "already_applied" : receipt.status,
    ...receipt.reason === null ? {} : { reason: receipt.reason },
    versions: JSON.parse(receipt.versions_json) as EntityVersion[],
    ...receipt.cursor === null ? {} : { cursor: receipt.cursor },
  };
}

type EntityRow = {
  entity_type: string;
  entity_id: string;
  revision: number;
  payload_json: string;
  deleted_at: number | null;
};

function entity(row: EntityRow) {
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    remoteRevision: row.revision,
    deletedAt: row.deleted_at,
    payload: JSON.parse(row.payload_json) as unknown,
  };
}

export async function getEntity(db: Database, type: string, key: string) {
  const [row] = await query<EntityRow>(db, ["SELECT * FROM sync_entities WHERE (entity_type, entity_id) = (?, ?)", type, key]);
  if (!row) throw new SyncError(404, "entity_not_found");
  return entity(row);
}

export async function bootstrap(db: Database, client: Client, afterType: string, afterId: string, limit: number) {
  const [states, rows] = await db.batch([
    ["SELECT * FROM sync_watermarks"],
    [`WITH candidates AS MATERIALIZED (
        SELECT entity_type, entity_id, length(CAST(payload_json AS BLOB)) + 1024 AS bytes
        FROM sync_entities WHERE (entity_type, entity_id) > (?, ?)
        ORDER BY entity_type, entity_id LIMIT ?
      ), sized AS (
        SELECT *, SUM(bytes) OVER (ORDER BY entity_type, entity_id) AS total FROM candidates
      )
      SELECT e.*, (SELECT COUNT(*) FROM candidates) AS scanned
      FROM sized JOIN sync_entities e USING (entity_type, entity_id)
      WHERE sized.total <= ? ORDER BY sized.entity_type, sized.entity_id LIMIT ?`,
      afterType, afterId, limit + 1, MAX_PAGE_BYTES, limit],
  ]);
  const state = states[0] as Identity;
  checkIdentity(state, client);
  checkReady(state);
  const page = rows as (EntityRow & { scanned: number })[];
  const last = page.at(-1);
  const hasMore = last !== undefined && last.scanned > page.length;
  return {
    serverInstanceId: state.instance_id,
    syncEpoch: state.epoch,
    entities: page.map(entity),
    nextAfter: hasMore ? { entityType: last.entity_type, entityId: last.entity_id } : null,
    ...afterType === "" ? { snapshotStartCursor: state.head_cursor } : {},
    ...hasMore ? {} : { snapshotEndCursor: state.head_cursor },
  };
}

type ChangeRow = EntityRow & {
  cursor: number;
  operation: "upsert" | "delete";
  group_id: string;
  group_index: number;
  group_size: number;
  scanned: number;
};

export async function pull(db: Database, client: Client, cursor: number, through: number | undefined, limit: number) {
  const [states, rows] = await db.batch([
    ["SELECT * FROM sync_watermarks"],
    [`WITH candidates AS MATERIALIZED (
        SELECT cursor, length(CAST(payload_json AS BLOB)) + 1024 AS bytes
        FROM sync_changes WHERE cursor > ? AND cursor <= COALESCE(?, 9223372036854775807)
        ORDER BY cursor LIMIT ?
      ), sized AS (
        SELECT *, SUM(bytes) OVER (ORDER BY cursor) AS total FROM candidates
      )
      SELECT c.*, (SELECT COUNT(*) FROM candidates) AS scanned
      FROM sized JOIN sync_changes c USING (cursor)
      WHERE sized.total <= ? ORDER BY sized.cursor LIMIT ?`,
      cursor, through ?? null, limit + 1, MAX_PAGE_BYTES, limit],
  ]);
  const state = states[0] as Identity;
  checkIdentity(state, client);
  checkReady(state);
  checkCursor(state, cursor);
  if (through !== undefined) checkCursor(state, through);
  const page = rows as ChangeRow[];
  const last = page.at(-1);
  return {
    serverInstanceId: state.instance_id,
    syncEpoch: state.epoch,
    changes: page.map((row) => ({
      ...entity(row), cursor: row.cursor, operation: row.operation,
      groupId: row.group_id, groupIndex: row.group_index, groupSize: row.group_size,
    })),
    nextCursor: last?.cursor ?? cursor,
    hasMore: last !== undefined && last.scanned > page.length,
  };
}
