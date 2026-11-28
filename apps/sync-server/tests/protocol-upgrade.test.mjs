import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { createApp } from "../dist/app.js";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { localFiles } from "../dist/adapters/local-files.js";

test("protocol 2 frozen receipts and offline operations replay unchanged after the protocol 3 migration", async t => {
  // The fixture was produced by the actual protocol-2 apply implementation at
  // sourceRevision, before the image migration existed, using synthetic credentials.
  const fixture = JSON.parse(await readFile(new URL("./protocol-2-upgrade-fixture.json", import.meta.url), "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "sync-protocol-upgrade-"));
  const path = join(directory, "sync.db");
  const legacy = new Sqlite(path);
  legacy.exec("CREATE TABLE sync_migrations (name TEXT PRIMARY KEY) STRICT");
  for (const name of fixture.migrations) {
    legacy.exec(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
    legacy.prepare("INSERT INTO sync_migrations VALUES (?)").run(name);
  }
  legacy.transaction(() => {
    for (const [table, rows] of Object.entries(fixture.rows)) for (const row of rows) {
      const columns = Object.keys(row);
      legacy.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
    }
  })();
  legacy.close();
  const db = openSqlite(path);
  t.after(() => db.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApp(db, await localFiles(join(directory, "blobs")), undefined);
  const identity = fixture.rows.sync_identity[0];
  const headers = { Authorization: "Bearer " + fixture.token, "X-Sync-Protocol": "3",
    "X-Sync-Instance": identity.instance_id, "X-Sync-Epoch": identity.epoch, "Content-Type": "application/json" };
  const request = async (path, body, overrides = {}) => {
    const response = await app.request("http://localhost/v1/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...overrides }, ...body === undefined ? {} : { body: JSON.stringify(body) } });
    return { status: response.status, body: await response.json() };
  };
  const meta = await request("meta");
  assert.equal(meta.body.protocolVersion, 3);
  assert.equal(meta.body.serverInstanceId, identity.instance_id);
  assert.equal(meta.body.syncEpoch, identity.epoch);
  assert.equal((await request("devices", undefined, { "X-Sync-Protocol": "2" })).status, 426);
  for (const [table, rows] of Object.entries(fixture.rows)) {
    const [current] = await db.batch([["SELECT * FROM " + table]]);
    assert.deepEqual(current, rows, table + " must survive migration unchanged");
  }
  const receipt = fixture.rows.sync_operations[0];
  const frozen = fixture.acknowledgedLost;
  assert.equal(createHash("sha256").update(JSON.stringify(frozen.mutations)).digest("hex"), receipt.request_hash);
  const lookup = operation => request("sync/receipts/lookup", { originDeviceId: "legacy-device", operation });
  const oldReceipt = await lookup(frozen);
  assert.equal(oldReceipt.status, 200);
  assert.equal(oldReceipt.body.status, "applied");
  assert.equal(oldReceipt.body.cursor, receipt.cursor);
  assert.deepEqual(oldReceipt.body.versions, JSON.parse(receipt.versions_json));
  const push = operation => request("sync/push", { protocolVersion: 3, cursor: receipt.cursor, operations: [operation] });
  assert.equal((await push(frozen)).body.results[0].status, "already_applied");
  assert.equal((await lookup(fixture.notSubmitted)).body.status, "not_found");
  assert.equal((await push(fixture.notSubmitted)).body.results[0].status, "applied");
  assert.equal((await push(fixture.notSubmitted)).body.results[0].status, "already_applied");
  assert.equal((await lookup(fixture.notSubmitted)).body.status, "applied");
  const [[counts], entities, receipts] = await db.batch([
    ["SELECT (SELECT COUNT(*) FROM sync_entities) AS entities, (SELECT COUNT(*) FROM sync_changes) AS changes, (SELECT COUNT(*) FROM sync_operations) AS receipts"],
    ["SELECT entity_id,revision,payload_json FROM sync_entities ORDER BY entity_id"],
    ["SELECT * FROM sync_operations WHERE operation_id=?", frozen.operationId],
  ]);
  assert.deepEqual(counts, { entities: 2, changes: 2, receipts: 2 });
  assert.ok(entities.every(entity => entity.revision === 1));
  assert.deepEqual(receipts, fixture.rows.sync_operations);
});
