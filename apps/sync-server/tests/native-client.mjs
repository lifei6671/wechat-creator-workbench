import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../dist/app.js";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { localFiles } from "../dist/adapters/local-files.js";

const cases = [
  "claim_join_and_reconnect_using_real_service",
  "articles_and_private_images_between_workspaces",
  "canvases_between_workspaces",
  "first_join_merges_two_populated_workspaces",
  "blob_group_receipt_survives_response_loss_and_device_reregistration",
  "recover_only_device_into_fresh_workspace",
  "reinstall_with_same_connection_key_restores_and_continues_two_way_sync",
  "initialization_resumes_after_original_repair_and_keeps_other_devices_waiting",
];
const selected = process.argv[2] ? [process.argv[2]] : cases;
if (selected.some(name => !cases.includes(name))) throw new Error("Unknown native acceptance case");
for (const testName of selected) {
  console.log("Native acceptance: " + testName);
  // A fresh service and keyring identities are exclusive to this native acceptance run.
  const directory = await mkdtemp(join(tmpdir(), "wechat-native-sync-"));
  const setup = randomBytes(32).toString("hex");
  const db = openSqlite(join(directory, "sync.db"));
  const app = createApp(db, await localFiles(join(directory, "blobs")), setup);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const child = spawn("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked",
      testName, "--", "--ignored", "--nocapture"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, WCB_SYNC_TEST_URL: `http://127.0.0.1:${server.address().port}/`, WCB_SYNC_TEST_SETUP: setup },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const [code] = await once(child, "exit");
    if (code !== 0) process.exitCode = code ?? 1;
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}
