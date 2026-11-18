import { test } from "node:test";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unstable_dev } from "wrangler";
import { runContract } from "./contract.mjs";

const run = promisify(execFile);
const secret = () => randomBytes(32).toString("hex");
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "wcb-sync-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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
