import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("optional distribution tests load without local sync-server build artifacts", t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "wcb-unbuilt-sync-tests-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  for (const file of ["scripts/docker-sync.test.mjs", "scripts/package-sync.test.mjs",
    "apps/sync-server/tests/contract.mjs", "apps/sync-server/tests/image-canvas-contract.mjs"]) {
    const target = join(scratch, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  const env = { ...process.env, RELEASE_PACKAGE_TEST: "", RELEASE_DOCKER_TEST: "" };
  delete env.NODE_TEST_CONTEXT;
  const result = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "scripts/docker-sync.test.mjs", "scripts/package-sync.test.mjs"], {
    cwd: scratch, encoding: "utf8", env,
  });
  assert.match(result, /skip(?:ped)? 2/);
});
