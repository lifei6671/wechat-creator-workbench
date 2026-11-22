import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate, claim, connect, createAccessKey, createRecoveryKey, join, listDevices, recover, revoke, type DeviceAuthorization } from "./auth.js";
import {
  entityType, hashPattern, id, integer, invalid, MAX_BLOB_BYTES, MAX_PUSH_BYTES,
  operation, queryInteger, record, SyncError, text, PROTOCOL_VERSION,
} from "./protocol.js";
import { identity, query, type BlobStore, type Database, type Identity } from "./storage.js";
import { apply, bootstrap, checkIdentity, checkPush, getEntity, lookupReceipt, pull, seed, type Client } from "./sync.js";

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
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof SyncError) return c.json({ error: error.code, ...error.reason ? { reason: error.reason } : {} }, error.status);
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
      unifiedConnect: true, operationReceiptLookup: true, seedDeviceId: state.seed_device,
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
      } catch (error) {
        if (!(error instanceof SyncError)) throw error;
        results.push({ index, status: "rejected", reason: error.code });
        continue;
      }
      results.push({ index, ...await apply(db, c.get("client"), cursor, parsed) });
    }
    return c.json({ results });
  });
  app.post("/v1/sync/receipts/lookup", limitBody(MAX_PUSH_BYTES), async (c) => {
    const input = await json(c);
    return c.json(await lookupReceipt(db, c.get("client"), id(input.originDeviceId), operation(input.operation)));
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
  app.put("/v1/blobs/:sha256", async (c) => {
    const hash = c.req.param("sha256");
    if (!hashPattern.test(hash)) invalid("invalid_hash");
    const contentLength = c.req.header("Content-Length");
    if (contentLength === undefined) throw new SyncError(411, "length_required");
    const size = queryInteger(contentLength, 0);
    if (size > MAX_BLOB_BYTES) throw new SyncError(413, "blob_too_large");
    const source = c.req.raw.body;
    if (!source) invalid("missing_blob");
    await blobs.put(hash, size, source);
    const client = c.get("client");
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
    const isHead = c.req.raw.method === "HEAD";
    const body = isHead ? null : await blobs.get(hash);
    if (!isHead && !body) throw new SyncError(503, "blob_unavailable");
    c.header("Content-Type", "application/octet-stream");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Length", String(object.size_bytes));
    return body ? c.body(body) : c.body(null);
  });
  return app;
}
