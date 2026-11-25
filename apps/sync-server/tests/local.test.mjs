import { test } from "node:test";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unstable_dev } from "wrangler";
import assert from "node:assert/strict";
import Sqlite from "better-sqlite3";
import { issueRecoveryKey, listRecoveryDevices } from "../scripts/cloudflare-recovery.mjs";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { authenticate, claim, connect, createAccessKey, createRecoveryKey, join as joinWorkspace, recover, revoke } from "../dist/auth.js";
import { apply, lookupReceipt, pull, seed } from "../dist/sync.js";
import { identity } from "../dist/storage.js";
import { runContract } from "./contract.mjs";

const run = promisify(execFile);
const secret = () => randomBytes(32).toString("hex");
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "wcb-sync-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("unified connection migrates a claimed service once and does not bypass rotated keys", async (t) => {
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  const setup = secret(), original = secret(), replacement = secret();
  const old = await claim(db, setup, setup, original, "原设备");
  const state = await identity(db);
  const authorization = await authenticate(db, "Bearer " + original);
  const client = { instanceId: state.instance_id, epoch: state.epoch, deviceId: old.deviceId, tokenHash: authorization.tokenHash };
  await seed(db, client, "begin");
  await seed(db, client, "finish");
  const before = await identity(db);
  const joined = await connect(db, setup, setup, replacement, "重装设备", state.instance_id, state.epoch);
  assert.equal(joined.seedStatus, "ready");
  assert.notEqual(joined.deviceId, old.deviceId);
  assert.deepEqual(await identity(db), { ...before, access_hash: createHash("sha256").update(setup).digest("hex") });
  assert.deepEqual(await authenticate(db, "Bearer " + original), authorization);
  assert.deepEqual(await connect(db, undefined, setup, replacement, "重装设备", state.instance_id, state.epoch), joined);
  const { accessKey } = await createAccessKey(db, authorization);
  await assert.rejects(connect(db, setup, setup, secret(), "旧部署密钥", state.instance_id, state.epoch), { code: "invalid_access_key" });
  const third = await connect(db, setup, accessKey, secret(), "新设备", state.instance_id, state.epoch);
  await revoke(db, authorization, joined.deviceId);
  await assert.rejects(connect(db, setup, accessKey, replacement, "撤销设备", state.instance_id, state.epoch), { code: "invalid_access_key" });
  assert.notEqual(third.deviceId, joined.deviceId);
  const [[current]] = await db.batch([["SELECT access_hash FROM sync_identity"]]);
  const racingDb = { batch: async statements => {
    await createAccessKey(db, authorization);
    return db.batch(statements);
  } };
  await assert.rejects(connect(racingDb, setup, accessKey, secret(), "轮换期间接入", state.instance_id, state.epoch), { code: "invalid_access_key" });
  const [[after]] = await db.batch([["SELECT access_hash FROM sync_identity"]]);
  assert.notEqual(current.access_hash, after.access_hash);
});

test("receipt lookup survives cursor expiry and revoked origins without writing or changing the receipt", async (t) => {
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  const setup = secret(), a = secret(), b = secret();
  const state = await identity(db);
  const [first, second] = await Promise.all([a, b].map((token, i) => connect(db, setup, setup, token, "device-" + i, state.instance_id, state.epoch)));
  const [authA, authB] = await Promise.all([a, b].map(token => authenticate(db, "Bearer " + token)));
  const client = { instanceId: state.instance_id, epoch: state.epoch, deviceId: first.deviceId, tokenHash: authA.tokenHash };
  const peer = { ...client, deviceId: second.deviceId, tokenHash: authB.tokenHash };
  await seed(db, client, "begin");
  const operation = { operationId: "receipt", mutations: [{ entityType: "category", entityId: "folder",
    baseRevision: 0, operation: "upsert", payload: { name: "目录", parentId: null } }] };
  const applied = await apply(db, client, 0, operation);
  const conflicting = { ...operation, operationId: "conflict" };
  const conflict = await apply(db, client, 0, conflicting);
  await seed(db, client, "finish");
  await revoke(db, authB, first.deviceId);
  await db.batch([["UPDATE sync_identity SET min_cursor = 1"]]);
  await assert.rejects(pull(db, peer, 0, undefined, 100), { code: "reset_required", reason: "cursor_expired" });
  assert.deepEqual(await lookupReceipt(db, peer, first.deviceId, operation), applied);
  assert.deepEqual(await lookupReceipt(db, peer, first.deviceId, conflicting), conflict);
  const before = await db.batch([["SELECT * FROM sync_operations ORDER BY operation_id"], ["SELECT * FROM sync_entities"]]);
  await assert.rejects(lookupReceipt(db, peer, first.deviceId, { ...operation,
    mutations: [{ ...operation.mutations[0], baseRevision: 1 }] }), { code: "operation_id_reused" });
  assert.equal((await lookupReceipt(db, peer, first.deviceId, { ...operation, operationId: "absent" })).status, "not_found");
  assert.deepEqual(await db.batch([["SELECT * FROM sync_operations ORDER BY operation_id"], ["SELECT * FROM sync_entities"]]), before);
  await assert.rejects(lookupReceipt(db, { ...peer, epoch: "old" }, first.deviceId, operation), { reason: "epoch_changed" });
  await assert.rejects(lookupReceipt(db, { ...peer, instanceId: "old" }, first.deviceId, operation), { reason: "instance_changed" });
  await assert.rejects(pull(db, peer, 2, undefined, 100), { reason: "cursor_ahead" });
});

test("upgrading a populated sync database preserves the device and cloud data", async (t) => {
  const path = join(await scratch(t), "sync.db");
  const legacy = new Sqlite(path);
  try {
    legacy.exec("CREATE TABLE sync_migrations (name TEXT PRIMARY KEY) STRICT");
    const migrations = ["0001_sync.sql", "0002_article_dependencies.sql", "0003_canvas_dependencies.sql"];
    for (const name of migrations) {
      legacy.exec(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
      legacy.prepare("INSERT INTO sync_migrations VALUES (?)").run(name);
    }
    legacy.exec(`
      INSERT INTO sync_devices (id, name, token_hash, created_at) VALUES ('old', '原设备', 'old-hash', 1);
      UPDATE sync_identity SET claimed = 1, claim_device = 'old', seed_status = 'ready';
      INSERT INTO sync_entities (entity_type, entity_id, revision, payload_json, updated_at)
      VALUES ('entry', 'draft', 7, '{"contentMd":"原文"}', 1);
    `);
  } finally {
    legacy.close();
  }
  const db = openSqlite(path);
  try {
    const [[device], [draft], [identity]] = await db.batch([
      ["SELECT id, token_hash, recovery_hash, admin_recovery_hash, admin_recovery_expires_at FROM sync_devices"],
      ["SELECT revision, payload_json FROM sync_entities"],
      ["SELECT claimed, claim_device, seed_status FROM sync_identity"],
    ]);
    assert.deepEqual(device, { id: "old", token_hash: "old-hash", recovery_hash: null,
      admin_recovery_hash: null, admin_recovery_expires_at: null });
    assert.deepEqual(draft, { revision: 7, payload_json: '{"contentMd":"原文"}' });
    assert.deepEqual(identity, { claimed: 1, claim_device: "old", seed_status: "ready" });
  } finally {
    db.close();
  }
});

test("ordinary asset validation does not scan existing asset payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wcb-sync-validation-"));
  const path = join(directory, "validation.db");
  openSqlite(path).close();
  const conn = new Sqlite(path);
  t.after(() => {
    conn.close();
    return rm(directory, { recursive: true, force: true });
  });
  const insert = conn.prepare("INSERT INTO sync_entities VALUES ('asset', ?, 1, ?, NULL, 1)");
  conn.transaction(() => {
    for (let i = 0; i < 1_000; i++) insert.run("asset-" + i, JSON.stringify({ kind: "original" }));
  })();
  conn.exec("INSERT INTO sync_blobs VALUES ('hash', 1)");
  conn.prepare("INSERT INTO sync_pending VALUES ('asset', 'new', 0, 1, 'upsert', ?, NULL, 0)")
    .run(JSON.stringify({ kind: "original", sha256: "hash", bytes: 1 }));
  let inspected = 0;
  conn.function("json_extract", { deterministic: true }, (value, path) => {
    inspected++;
    return JSON.parse(value)[path.slice(2)] ?? null;
  });
  assert.deepEqual(conn.prepare("SELECT * FROM sync_article_dependencies").get(), { dependency_reason: null });
  assert.ok(inspected < 20, `ordinary asset inspected ${inspected} JSON fields`);
  conn.exec("DELETE FROM sync_blobs");
  assert.deepEqual(conn.prepare("SELECT * FROM sync_article_dependencies").get(), { dependency_reason: "blob_missing" });
  conn.exec("UPDATE sync_pending SET payload_json = '{\"kind\":\"derived\",\"sourceKey\":\"render\",\"sha256\":\"hash\"}'");
  conn.prepare("UPDATE sync_entities SET payload_json = ? WHERE entity_id = 'asset-999'")
    .run(JSON.stringify({ kind: "derived", sourceKey: "render", sha256: "hash" }));
  assert.deepEqual(conn.prepare("SELECT * FROM sync_article_dependencies").get(), { dependency_reason: "derived_asset_conflict" });
});

test("a Cloudflare administrator can recover the only device without existing keys", async (t) => {
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  const execute = async (sql) => (await db.batch([[sql]]))[0];
  assert.deepEqual(await listRecoveryDevices(execute), []);
  const setup = secret(), original = secret();
  const { deviceId } = await claim(db, setup, setup, original, "原设备");
  const beforeSeed = await identity(db);
  const oldDevice = await authenticate(db, "Bearer " + original);
  const client = { instanceId: beforeSeed.instance_id, epoch: beforeSeed.epoch, deviceId, tokenHash: oldDevice.tokenHash };
  await seed(db, client, "begin");
  await apply(db, client, 0, { operationId: "initial-folder", mutations: [
    { entityType: "category", entityId: "folder", baseRevision: 0,
      operation: "upsert", payload: { name: "已有目录", parentId: null } },
  ] });
  await seed(db, client, "finish");
  const before = await identity(db);
  const entities = "SELECT * FROM sync_entities";
  const records = await execute(entities);
  const [device] = await listRecoveryDevices(execute);
  assert.deepEqual(Object.keys(device), ["id", "name", "createdAt"]);
  assert.equal(device.id, deviceId);
  await assert.rejects(issueRecoveryKey(execute, "missing"), /找不到可恢复的设备/);

  const expired = await issueRecoveryKey(execute, deviceId);
  await execute("UPDATE sync_devices SET admin_recovery_expires_at = unixepoch() WHERE id = '" + deviceId + "'");
  await assert.rejects(recover(db, expired.recoveryKey, secret(), "重装后"), { code: "invalid_recovery_key" });
  const superseded = await issueRecoveryKey(execute, deviceId);
  const current = await issueRecoveryKey(execute, deviceId);
  await assert.rejects(recover(db, superseded.recoveryKey, secret(), "重装后"), { code: "invalid_recovery_key" });
  assert.deepEqual(await authenticate(db, "Bearer " + original), oldDevice);

  const replacements = [secret(), secret()];
  const outcomes = await Promise.allSettled(replacements.map(token => recover(db, current.recoveryKey, token, "重装后")));
  const winner = outcomes.findIndex(outcome => outcome.status === "fulfilled");
  assert.notEqual(winner, -1);
  assert.deepEqual(outcomes[winner].value, { deviceId });
  assert.equal(outcomes[1 - winner].reason.code, "invalid_recovery_key");
  await assert.rejects(authenticate(db, "Bearer " + original), { code: "invalid_device" });
  assert.equal((await authenticate(db, "Bearer " + replacements[winner])).id, deviceId);
  assert.deepEqual(await listRecoveryDevices(execute), [{ ...device, name: "重装后" }]);
  assert.deepEqual(await identity(db), before);
  assert.deepEqual(await execute(entities), records);
  assert.deepEqual(await execute("SELECT recovery_hash, admin_recovery_hash, admin_recovery_expires_at FROM sync_devices"), [
    { recovery_hash: null, admin_recovery_hash: null, admin_recovery_expires_at: null },
  ]);
});

test("replacing device credentials blocks writes from requests already authorized with the old credentials", async (t) => {
  const db = openSqlite(join(await scratch(t), "sync.db"));
  try {
    const setup = secret(), original = secret(), replacement = secret();
    const { deviceId } = await claim(db, setup, setup, original, "原设备");
    const oldAuthorization = await authenticate(db, "Bearer " + original);
    const { accessKey } = await createAccessKey(db, oldAuthorization);
    const peer = await joinWorkspace(db, accessKey, secret(), "另一台设备");
    const third = await joinWorkspace(db, accessKey, secret(), "第三台设备");
    assert.notEqual(third.deviceId, peer.deviceId);
    const state = await identity(db);
    const oldClient = { instanceId: state.instance_id, epoch: state.epoch, deviceId, tokenHash: oldAuthorization.tokenHash };
    await seed(db, oldClient, "begin");
    const { recoveryKey } = await createRecoveryKey(db, oldAuthorization);
    await recover(db, recoveryKey, replacement, "重装后");
    await assert.rejects(createAccessKey(db, oldAuthorization), { code: "invalid_device" });
    await assert.rejects(createRecoveryKey(db, oldAuthorization), { code: "invalid_device" });
    await assert.rejects(revoke(db, oldAuthorization, peer.deviceId), { code: "invalid_device" });
    await assert.rejects(seed(db, oldClient, "finish"), { code: "seed_unavailable" });

    const current = await authenticate(db, "Bearer " + replacement);
    const client = { ...oldClient, tokenHash: current.tokenHash };
    await seed(db, client, "finish");
    const operation = {
      operationId: "new-folder",
      mutations: [{ entityType: "category", entityId: "new-folder", baseRevision: 0,
        operation: "upsert", payload: { name: "新目录", parentId: null } }],
    };
    await assert.rejects(apply(db, oldClient, 0, operation), { code: "invalid_device" });
    assert.equal((await apply(db, client, 0, operation)).status, "applied");
  } finally {
    db.close();
  }
});

test("Node HTTP + VPS SQLite + local files", { timeout: 120_000 }, async (t) => {
  const value = secret();
  const child = spawn(process.execPath, ["dist/node.js"], {
    env: { ...process.env, SETUP_SECRET: value, DATA_DIR: await scratch(t), PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const [output] = await once(child.stdout, "data");
    const port = String(output).match(/port (\d+)/)?.[1];
    const { pageBytes } = await runContract("http://127.0.0.1:" + port, value);
    t.diagnostic("UTF-8 pull response bytes: " + pageBytes);
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

test("Workers + local D1/R2 bindings", { timeout: 120_000 }, async (t) => {
  const directory = await scratch(t);
  const value = secret();
  await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply",
    "DB", "--local", "--persist-to", directory]);
  const worker = await unstable_dev("src/cloudflare.ts", {
    local: true, ip: "127.0.0.1", port: 0, persistTo: directory, vars: { SETUP_SECRET: value },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    logLevel: "warn",
  });
  try {
    const base = "http://127.0.0.1:" + worker.port;
    const { pageBytes, credentials, retainedHash } = await runContract(base, value);
    t.diagnostic("UTF-8 pull response bytes: " + pageBytes);
    const check = async error => {
      const response = await fetch(base + "/v1/sync/diagnostics", { headers: { ...credentials, "X-Sync-Protocol": "2" } });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.ok(result.issues.some(issue => issue.entityId === "private-image" && issue.error === error), JSON.stringify(result));
    };
    const object = "wechat-workbench-sync-blobs/" + retainedHash;
    await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "r2", "object", "delete", object, "--local", "--persist-to", directory]);
    await check("blob_object_missing");
    const broken = join(directory, "broken-image.bin");
    await writeFile(broken, "short");
    await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "r2", "object", "put", object, "--file", broken, "--local", "--persist-to", directory]);
    await check("blob_object_size_mismatch");
  } finally {
    await worker.stop();
  }
});
