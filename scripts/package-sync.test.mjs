import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runContract } from "../apps/sync-server/tests/contract.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("unpacked Cloudflare and VPS distributions run the same HTTP contract", {
  skip: !process.env.RELEASE_PACKAGE_TEST, timeout: 240_000,
}, async t => {
  const source = join(root, "apps/sync-server");
  const scratch = mkdtempSync(join(tmpdir(), "wcb-packaged-sync-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  for (const platform of ["cloudflare", "vps"]) {
    const archive = readdirSync(join(root, "release-output")).find(file => file.endsWith(`sync-${platform}.tar.gz`));
    assert.ok(archive);
    execFileSync("tar", ["-xzf", join(root, "release-output", archive), "-C", scratch]);
    const directory = join(scratch, archive.slice(0, -7));
    assert.equal(existsSync(join(directory, "src")), false);
    const version = JSON.parse(readFileSync(join(directory, "version.json"), "utf8"));
    assert.equal(version.protocol, 3);
    assert.equal(version.version, JSON.parse(readFileSync(join(directory, "package.json"))).version);
    assert.ok(JSON.parse(readFileSync(join(directory, "third-party.json"))).length > 0);
    const secret = randomBytes(32).toString("hex");
    if (platform === "cloudflare") {
      const { unstable_dev } = await import("../apps/sync-server/node_modules/wrangler/wrangler-dist/cli.js");
      const executable = join(source, "node_modules/wrangler/bin/wrangler.js");
      execFileSync(process.execPath, [executable, "d1", "migrations", "apply", "DB", "--local", "--persist-to", "state"], { cwd: directory, stdio: "pipe" });
      const worker = await unstable_dev(join(directory, "worker/cloudflare.js"), {
        config: join(directory, "wrangler.jsonc"), local: true, ip: "127.0.0.1", port: 0, persistTo: join(directory, "state"),
        vars: { SETUP_SECRET: secret }, experimental: { disableExperimentalWarning: true, disableDevRegistry: true }, logLevel: "warn",
      });
      try { await runContract(`http://127.0.0.1:${worker.port}`, secret); }
      finally { await worker.stop(); }
    } else {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      execFileSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: directory, stdio: "pipe", shell: process.platform === "win32", timeout: 120_000,
      });
      const listener = createServer();
      listener.listen(0, "127.0.0.1"); await once(listener, "listening");
      const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
      const child = spawn(process.execPath, ["dist/node.js"], { cwd: directory,
        env: { ...process.env, SETUP_SECRET: secret, DATA_DIR: join(directory, "data"), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
      try {
        for (let attempt = 0; attempt < 100 && !log.includes("listening"); attempt++) {
          if (child.exitCode !== null) throw new Error(log);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.match(log, /listening/);
        await runContract(`http://127.0.0.1:${port}`, secret);
      } finally { const ended = once(child, "exit"); child.kill(); await ended; }
    }
  }
});
