import { test } from "node:test";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unstable_dev } from "wrangler";
import assert from "node:assert/strict";
import Sqlite from "better-sqlite3";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { authenticate, claim, createAccessKey, createRecoveryKey, join as joinWorkspace, recover, revoke } from "../dist/auth.js";
import { apply, seed } from "../dist/sync.js";
import { identity } from "../dist/storage.js";
import { runContract } from "./contract.mjs";

const run = promisify(execFile);
const secret = () => randomBytes(32).toString("hex");
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "wcb-sync-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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
      ["SELECT id, token_hash, recovery_hash FROM sync_devices"],
      ["SELECT revision, payload_json FROM sync_entities"],
      ["SELECT claimed, claim_device, seed_status FROM sync_identity"],
    ]);
    assert.deepEqual(device, { id: "old", token_hash: "old-hash", recovery_hash: null });
    assert.deepEqual(draft, { revision: 7, payload_json: '{"contentMd":"原文"}' });
    assert.deepEqual(identity, { claimed: 1, claim_device: "old", seed_status: "ready" });
  } finally {
    db.close();
  }
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
    const { pageBytes } = await runContract("http://127.0.0.1:" + worker.port, value);
    t.diagnostic("UTF-8 pull response bytes: " + pageBytes);
  } finally {
    await worker.stop();
  }
});
