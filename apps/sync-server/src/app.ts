import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate, claim, connect, createAccessKey, createRecoveryKey, join, listDevices, recover, revoke, type DeviceAuthorization } from "./auth.js";
import {
  entityType, hashPattern, id, integer, invalid, MAX_BLOB_BYTES, MAX_PUSH_BYTES,
  operation, queryInteger, record, SyncError, text, PROTOCOL_VERSION,
} from "./protocol.js";
import { identity, query, type BlobStore, type Database, type Identity } from "./storage.js";
import { apply, bootstrap, checkIdentity, checkPush, getEntity, lookupReceipt, pull, seed, type Client } from "./sync.js";
import { validateContentBlobs } from "./content-blobs.js";
import { diagnoseEntities } from "./diagnostics.js";
import { reservePublic, commitPublic, backupPublic, completePublic, publicBackup, restoredPublic, expirePublic } from "./image-gc-s3.js";
import { gcFeed, gcCheckpoint, gcProtect, gcBeginDelete, gcImportHistory } from "./image-gc.js";
import { privateLocation, putManagedPrivate, gcRunPrivateJob, gcRestorePrivate, gcExpirePrivate } from "./image-gc-store.js";

type Variables = { device: DeviceAuthorization; client: Client; identity: Identity };
type Route = Context<{ Variables: Variables }>;

async function json(c: Route) {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) invalid("invalid_json");
    throw error;
  }
  return record(value);
}

export function createApp(db: Database, blobs: BlobStore, setupSecret: string | undefined) {
  const app = new Hono<{ Variables: Variables }>();
  const logicalBlobs:BlobStore={...blobs,
    head:async hash=>{const location=await privateLocation(db,hash);return location&&!['live','waiting'].includes(location.state)?null:blobs.head(location?.object_key??hash);},
    get:async hash=>{const location=await privateLocation(db,hash);return location&&!['live','waiting'].includes(location.state)?null:blobs.get(location?.object_key??hash);},
  };
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof SyncError) return c.json({ error: error.code, ...error.reason ? { reason: error.reason } : {}, ...error.field ? { field: error.field } : {} }, error.status);
    console.error("Sync request failed", error);
    return c.json({ error: "internal_error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.use("/v1/*", async (c, next) => {
    if (c.req.path !== "/v1/meta" && c.req.header("X-Sync-Protocol") !== String(PROTOCOL_VERSION)) {
      throw new SyncError(426, "unsupported_protocol");
    }
    await next();
  });
  app.get("/v1/meta", async (c) => {
    const state = await identity(db);
    return c.json({
      protocolVersion: PROTOCOL_VERSION, serverInstanceId: state.instance_id, syncEpoch: state.epoch,
      claimed: Boolean(state.claimed), seedStatus: state.seed_status,
      canvasSync: true, connectionRecovery: true, workspaceAccess: true,
      unifiedConnect: true, operationReceiptLookup: true, seedDeviceId: state.seed_device, imageVersionGc: 1,
    });
  });

  const limitBody = (maxSize: number) => bodyLimit({
    maxSize, onError: (c) => c.json({ error: "request_too_large" }, 413),
  });
  const smallBody = limitBody(4096);
  app.post("/v1/connect", smallBody, async (c) => {
    const input = await json(c);
    return c.json(await connect(db, setupSecret, input.accessKey, input.deviceToken, text(input.name, 128),
      c.req.header("X-Sync-Instance") ?? "", c.req.header("X-Sync-Epoch") ?? ""));
  });
  app.post("/v1/setup/claim", smallBody, async (c) => {
    const input = await json(c);
    return c.json(await claim(db, setupSecret, input.setupSecret, input.deviceToken, text(input.name, 128)), 201);
  });
  app.post("/v1/devices/join", smallBody, async (c) => {
    const input = await json(c);
    return c.json(await join(db, input.accessKey, input.deviceToken, text(input.name, 128)), 201);
  });
  app.post("/v1/recover", smallBody, async (c) => {
    const input = await json(c);
    return c.json(await recover(db, input.recoveryKey, input.deviceToken, text(input.name, 128)), 200);
  });

  app.use("/v1/*", async (c, next) => {
    c.set("device", await authenticate(db, c.req.header("Authorization")));
    await next();
  });
  app.post("/v1/access-key", async (c) => c.json(await createAccessKey(db, c.get("device")), 201));
  app.post("/v1/recovery-key", async (c) => c.json(await createRecoveryKey(db, c.get("device")), 201));
  app.get("/v1/devices", async (c) => {
    const rows = await listDevices(db);
    return c.json({ currentDeviceId: c.get("device").id, devices: rows.map((row) => ({
      deviceId: row.id, name: row.name, createdAt: row.created_at, revokedAt: row.revoked_at,
    })) });
  });
  app.delete("/v1/devices/:id", async (c) => {
    await revoke(db, c.get("device"), id(c.req.param("id")));
    return c.body(null, 204);
  });

  for (const path of ["/v1/sync/*", "/v1/blobs/*"]) {
    app.use(path, async (c, next) => {
      const { id: deviceId, tokenHash } = c.get("device");
      const client = {
        instanceId: c.req.header("X-Sync-Instance") ?? "",
        epoch: c.req.header("X-Sync-Epoch") ?? "",
        deviceId, tokenHash,
      };
      const state = await identity(db);
      checkIdentity(state, client);
      c.set("client", client);
      c.set("identity", state);
      await next();
    });
  }
  app.post("/v1/sync/seed", smallBody, async (c) => {
    const { action } = await json(c);
    if (action !== "begin" && action !== "finish") invalid("invalid_seed_action");
    return c.json(await seed(db, c.get("client"), action));
  });
  app.post("/v1/sync/push", limitBody(MAX_PUSH_BYTES), async (c) => {
    const input = await json(c);
    if (input.protocolVersion !== PROTOCOL_VERSION) throw new SyncError(400, "unsupported_protocol");
    const cursor = integer(input.cursor);
    checkPush(c.get("identity"), c.get("client"), cursor);
    if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 20) {
      invalid("invalid_operation_count");
    }
    const results = [];
    for (const [index, value] of input.operations.entries()) {
      let parsed: ReturnType<typeof operation>;
      try {
        parsed = operation(value);
        await validateContentBlobs(db, logicalBlobs, parsed);
      } catch (error) {
        if (!(error instanceof SyncError) || error.status >= 500) throw error;
        results.push({ index, status: "rejected", reason: error.code, ...error.field ? { field: error.field } : {} });
        continue;
      }
      results.push({ index, ...await apply(db, c.get("client"), cursor, parsed) });
    }
    return c.json({ results });
  });
  app.post("/v1/sync/receipts/lookup", limitBody(MAX_PUSH_BYTES), async (c) => {
    const input = await json(c);
    return c.json(await lookupReceipt(db, c.get("client"), id(input.originDeviceId), operation(input.operation, false)));
  });
  app.get("/v1/sync/bootstrap", async (c) => {
    const afterType = c.req.query("afterType");
    const afterId = c.req.query("afterId");
    if ((afterType === undefined) !== (afterId === undefined)) invalid("invalid_after_key");
    const limit = Math.min(100, queryInteger(c.req.query("limit"), 100));
    if (limit === 0) invalid("invalid_limit");
    return c.json(await bootstrap(db, c.get("client"),
      afterType === undefined ? "" : entityType(afterType),
      afterId === undefined ? "" : id(afterId), limit));
  });
  app.get("/v1/sync/diagnostics", async c => {
    const afterType = c.req.query("afterType"), afterId = c.req.query("afterId");
    if ((afterType === undefined) !== (afterId === undefined)) invalid("invalid_after_key");
    return c.json(await diagnoseEntities(db, logicalBlobs, afterType === undefined ? "" : entityType(afterType),
      afterId === undefined ? "" : id(afterId)));
  });
  app.get("/v1/sync/pull", async (c) => {
    const cursor = queryInteger(c.req.query("cursor"), 0);
    const through = queryInteger(c.req.query("throughCursor"), Number.MAX_SAFE_INTEGER);
    const limit = Math.min(100, queryInteger(c.req.query("limit"), 100));
    if (!limit || through < cursor) invalid();
    return c.json(await pull(db, c.get("client"), cursor,
      c.req.query("throughCursor") === undefined ? undefined : through, limit));
  });
  app.get("/v1/sync/entities/:type/:id", async (c) => {
    if (c.get("identity").seed_status !== "ready") throw new SyncError(409, "workspace_not_ready");
    return c.json(await getEntity(db, entityType(c.req.param("type")), id(c.req.param("id"))));
  });
  app.post("/v1/sync/image-gc/import",smallBody,async c=>c.json(await gcImportHistory(db,c.get("client"),await json(c))));
  app.get("/v1/sync/image-gc", async c => c.json(await gcFeed(db, c.get("client"))));
  app.post("/v1/sync/image-gc/checkpoint", limitBody(MAX_PUSH_BYTES), async c =>
    c.json(await gcCheckpoint(db, c.get("client"), await json(c))));
  app.post("/v1/sync/image-gc/protect", limitBody(MAX_PUSH_BYTES), async c => {
    const input = await json(c);
    if (!Array.isArray(input.hashes) || input.hashes.some(hash => typeof hash !== "string")) invalid("invalid_gc_protection");
    return c.json(await gcProtect(db, c.get("client"), input.hashes as string[], id(input.owner)));
  });
  app.post("/v1/sync/image-gc/delete", smallBody, async c => {
    const input = await json(c);
    return c.json(await gcBeginDelete(db, c.get("client"), id(input.copyId), id(input.roundId)));
  });
  app.post("/v1/sync/image-gc/run", smallBody, async c =>
    c.json(await gcRunPrivateJob(db, blobs, c.get("client"), id((await json(c)).jobId))));
  app.post("/v1/sync/image-gc/restore", smallBody, async c => {
    const input = await json(c);
    if (typeof input.sha256 !== "string" || !hashPattern.test(input.sha256)) invalid("invalid_hash");
    return c.json(await gcRestorePrivate(db, blobs, c.get("client"), input.sha256, input.retain === true));
  });
  app.post("/v1/sync/image-gc/expire", smallBody, async c =>
    c.json(await gcExpirePrivate(db, blobs, c.get("client"), id((await json(c)).jobId))));
  app.post("/v1/sync/image-gc/public/reserve", smallBody, async c => c.json(await reservePublic(db,c.get("client"),await json(c))));
  app.post("/v1/sync/image-gc/public/commit", smallBody, async c => c.json(await commitPublic(db,c.get("client"),await json(c))));
  app.put("/v1/sync/image-gc/public/backup/:id", limitBody(MAX_BLOB_BYTES), async c => {
    const source=c.req.raw.body; if(!source) invalid("missing_blob");
    return c.json(await backupPublic(db,blobs,c.get("client"),id(c.req.param("id")),source));
  });
  app.get("/v1/sync/image-gc/public/backup/:id", async c => {
    const bytes=await publicBackup(db,blobs,c.get("client"),id(c.req.param("id")));
    c.header("Content-Type","application/octet-stream");return c.body(bytes);
  });
  app.post("/v1/sync/image-gc/public/complete", smallBody, async c => c.json(await completePublic(db,c.get("client"),await json(c))));
  app.post("/v1/sync/image-gc/public/restored", smallBody, async c => c.json(await restoredPublic(db,c.get("client"),await json(c))));
  app.post("/v1/sync/image-gc/public/expire",smallBody,async c=>c.json(await expirePublic(db,blobs,c.get("client"),id((await json(c)).jobId))));
  app.put("/v1/blobs/:sha256", async (c) => {
    const hash = c.req.param("sha256");
    if (!hashPattern.test(hash)) invalid("invalid_hash");
    const contentLength = c.req.header("Content-Length");
    if (contentLength === undefined) throw new SyncError(411, "length_required");
    const size = queryInteger(contentLength, 0);
    if (size > MAX_BLOB_BYTES) throw new SyncError(413, "blob_too_large");
    const source = c.req.raw.body;
    if (!source) invalid("missing_blob");
    const client = c.get("client");
    const current = await privateLocation(db, hash);
    if (c.req.header("X-Image-Version-Gc") === "1" || current?.managed) {
      await putManagedPrivate(db, blobs, client, hash, size, source);
      return c.body(null, 204);
    }
    await blobs.put(hash, size, source);
    const rows = await query<{ sha256: string }>(db, [
      `INSERT INTO sync_blobs
       SELECT ?, ? FROM sync_identity WHERE instance_id = ? AND epoch = ?
         AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND token_hash = ? AND revoked_at IS NULL)
       ON CONFLICT (sha256) DO UPDATE SET size_bytes = excluded.size_bytes RETURNING sha256`,
      hash, size, client.instanceId, client.epoch, client.deviceId, client.tokenHash,
    ]);
    if (!rows.length) {
      checkIdentity(await identity(db), client);
      throw new SyncError(401, "invalid_device");
    }
    return c.body(null, 204);
  });
  app.get("/v1/blobs/:sha256", async (c) => {
    const hash = c.req.param("sha256");
    if (!hashPattern.test(hash)) invalid("invalid_hash");
    const [object] = await query<{ size_bytes: number }>(db, ["SELECT size_bytes FROM sync_blobs WHERE sha256 = ?", hash]);
    if (!object) throw new SyncError(404, "blob_not_found");
    let location = await privateLocation(db, hash);
    if (location && !["live", "waiting"].includes(location.state)) throw new SyncError(410, "gc_restore_required");
    if (location?.managed && location.created_epoch !== c.get("client").epoch) {
      const old = await blobs.get(location.object_key);
      if (!old) throw new SyncError(503, "blob_unavailable");
      await putManagedPrivate(db, blobs, c.get("client"), hash, location.size_bytes, old);
      location = await privateLocation(db, hash);
    }
    const isHead = c.req.raw.method === "HEAD";
    const body = isHead ? null : await blobs.get(location?.object_key ?? hash);
    if (!isHead && !body) throw new SyncError(503, "blob_unavailable");
    c.header("Content-Type", "application/octet-stream");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Length", String(object.size_bytes));
    return body ? c.body(body) : c.body(null);
  });
  return app;
}
