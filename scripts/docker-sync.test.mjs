import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runContract } from "../apps/sync-server/tests/contract.mjs";

test("VPS distribution builds and runs directly in its Docker image", {
  skip: !process.env.RELEASE_DOCKER_TEST, timeout: 600_000,
}, async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const archive = readdirSync(join(root, "release-output")).find(name => name.endsWith("sync-vps.tar.gz"));
  assert.ok(archive);
  const directory = mkdtempSync(join(tmpdir(), "wcb-sync-container-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("tar", ["-xzf", join(root, "release-output", archive), "-C", directory]);
  const image = `wcb-sync-test:${randomBytes(8).toString("hex")}`;
  const run = args => execFileSync("docker", args, { encoding: "utf8", timeout: 480_000 });
  run(["build", "-t", image, join(directory, archive.slice(0, -7))]);
  let container;
  t.after(() => {
    if (container) run(["rm", "-f", container]);
    run(["image", "rm", "-f", image]);
  });
  const secret = randomBytes(32).toString("hex");
  container = run(["run", "-d", "--rm", "-p", "127.0.0.1::8787", "-e", `SETUP_SECRET=${secret}`, image]).trim();
  const [{ NetworkSettings: { Ports: ports } }] = JSON.parse(run(["inspect", container]));
  const url = `http://127.0.0.1:${ports["8787/tcp"][0].HostPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url + "/v1/meta")).ok) { ready = true; break; } }
    catch (error) { if (attempt === 99) throw new Error(`容器未就绪：${error}\n${run(["logs", container])}`); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, run(["logs", container]));
  await runContract(url, secret);
});
