import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { operation } from "../dist/protocol.js";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { authenticate, claim } from "../dist/auth.js";
import { identity } from "../dist/storage.js";
import { apply, seed } from "../dist/sync.js";
import { createApp } from "../dist/app.js";
import { localFiles } from "../dist/adapters/local-files.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const fixtures = JSON.parse(await readFile(new URL("../../../tests/fixtures/sync-contract/entities.json", import.meta.url), "utf8"));
const mutation = (entityType, entityId, payload) => ({ entityType, entityId, payload, baseRevision: 0, operation: "upsert" });
for (const sample of fixtures.cases) test(`shared entity contract: ${sample.name}`, async t => {
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  const key = randomBytes(32).toString("hex"), token = randomBytes(32).toString("hex");
  const device = await claim(db, key, key, token, "contract");
  const state = await identity(db), auth = await authenticate(db, "Bearer " + token);
  const client = { instanceId: state.instance_id, epoch: state.epoch, deviceId: device.deviceId, tokenHash: auth.tokenHash };
  await seed(db, client, "begin");
  const setup = operation({ operationId: "prerequisites", mutations: [
    mutation("collection", "topic", fixtures.templates.collection),
    mutation("collection_node", "node-a", fixtures.templates.collection_node),
    mutation("collection_node", "node-b", fixtures.templates.collection_node),
  ] });
  assert.equal((await apply(db, client, 0, setup)).status, "applied");
  const counts = () => db.batch([["SELECT (SELECT COUNT(*) FROM sync_entities) AS entities, (SELECT COUNT(*) FROM sync_changes) AS changes, (SELECT COUNT(*) FROM sync_operations) AS receipts"]]);
  const before = await counts();
  const input = { operationId: sample.name, mutations: [mutation(sample.entityType,
    sample.entityType === "wechat_publication_defaults" ? "default" : "candidate", { ...fixtures.templates[sample.entityType], ...sample.payload })] };
  if (sample.accept) {
    assert.equal((await apply(db, client, 0, operation(input))).status, "applied");
    const [[entity]] = await db.batch([["SELECT payload_json FROM sync_entities WHERE entity_type=? AND entity_id=?", sample.entityType, input.mutations[0].entityId]]);
    assert.deepEqual(JSON.parse(entity.payload_json), input.mutations[0].payload);
  } else {
    assert.throws(() => operation(input), error => error.code === sample.error && error.field === sample.field);
    assert.deepEqual(await counts(), before);
  }
});

test("HTTP rejects invalid UTF-8 Markdown blobs without accepting an entity or receipt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sync-utf8-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  const key = randomBytes(32).toString("hex"), token = randomBytes(32).toString("hex");
  const device = await claim(db, key, key, token, "contract");
  const state = await identity(db), auth = await authenticate(db, "Bearer " + token);
  const client = { instanceId: state.instance_id, epoch: state.epoch, deviceId: device.deviceId, tokenHash: auth.tokenHash };
  await seed(db, client, "begin");
  const blobs = await localFiles(directory), app = createApp(db, blobs, key);
  const headers = { Authorization: "Bearer " + token, "X-Sync-Protocol": "2", "X-Sync-Instance": state.instance_id, "X-Sync-Epoch": state.epoch };
  const bytes = Buffer.from([0xc3, 0x28]), hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal((await app.request("http://localhost/v1/blobs/" + hash, { method: "PUT", headers: { ...headers, "Content-Length": String(bytes.length) }, body: bytes })).status, 204);
  const input = { operationId: "bad-utf8", mutations: [mutation("entry", "candidate", { kind: "article", title: "正文", contentBlobHash: hash, contentBlobSize: bytes.length })] };
  const response = await app.request("http://localhost/v1/sync/push", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 2, cursor: 0, operations: [input] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].reason, "invalid_content_utf8");
  const [[counts]] = await db.batch([["SELECT (SELECT COUNT(*) FROM sync_entities) AS entities, (SELECT COUNT(*) FROM sync_operations) AS receipts"]]);
  assert.deepEqual(counts, { entities: 0, receipts: 0 });
  // Historical operations remain queryable after stricter payload validation.
  const legacy = operation({ operationId: "legacy-invalid", mutations: [mutation("entry", "legacy", { ...fixtures.templates.entry, status: "inbox" })] }, false);
  assert.equal((await apply(db, client, 0, legacy)).status, "applied");
  const receipt = await app.request("http://localhost/v1/sync/receipts/lookup", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ originDeviceId: device.deviceId, operation: legacy }) });
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json()).status, "applied");
  await db.batch([
    ["INSERT INTO sync_entities VALUES('entry','missing-text',1,?,NULL,1)", JSON.stringify({ kind: "article", title: "正文", contentBlobHash: "f".repeat(64), contentBlobSize: 1 })],
    ["INSERT INTO sync_entities VALUES('asset','missing-image',1,?,NULL,1)", JSON.stringify({ kind: "original", name: "图片", sha256: "f".repeat(64), bytes: 1, mimeType: "image/png" })],
  ]);
  const before = await db.batch([["SELECT * FROM sync_entities"], ["SELECT * FROM sync_operations"], ["SELECT * FROM sync_identity"]]);
  const diagnostics = await app.request("http://localhost/v1/sync/diagnostics", { headers });
  assert.equal(diagnostics.status, 200);
  assert.deepEqual(await diagnostics.json(), { checked: 3, issues: [
    { entityType: "asset", entityId: "missing-image", remoteRevision: 1, error: "blob_missing", field: "sha256" },
    { entityType: "entry", entityId: "legacy", remoteRevision: 1, error: "invalid_entry_status", field: "status" },
    { entityType: "entry", entityId: "missing-text", remoteRevision: 1, error: "blob_missing", field: "contentBlobHash" },
  ], nextAfter: null });
  assert.deepEqual(await db.batch([["SELECT * FROM sync_entities"], ["SELECT * FROM sync_operations"], ["SELECT * FROM sync_identity"]]), before);
});
