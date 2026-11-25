import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test("browser failures do not prevent native checks and both matrices remain required", () => {
  const { native, browser, desktop } = workflow.jobs;
  assert.ok(native, "Native checks must run in a separate job");
  assert.ok(browser, "Browser checks must run in a separate job");
  for (const job of [native, browser]) {
    assert.deepEqual(job.strategy.matrix.os, ["macos-latest", "windows-latest"]);
    assert.equal(job.needs, undefined);
  }
  const nativeRuns = native.steps.flatMap(step => step.run ?? []);
  for (const command of ["cargo clippy", "cargo test", "pnpm tauri build"]) assert.ok(nativeRuns.some(run => run.startsWith(command)));
  assert.ok(!nativeRuns.some(run => run.includes("test:browser")));
  assert.ok(browser.steps.some(step => step.run === "pnpm test:browser"));
  assert.ok(browser.steps.some(step => step.uses?.startsWith("actions/upload-artifact@") && step.if.includes("failure()")));
  assert.equal(desktop.name, "Desktop (${{ matrix.os }})");
  assert.deepEqual(desktop.needs, ["native", "browser"]);
  assert.ok(desktop.if.includes("always()"));
});

test("the existing Desktop gate fails on failed, cancelled or skipped prerequisite checks", () => {
  const step = workflow.jobs.desktop.steps.find(step => step.run);
  assert.ok(step.env.NATIVE.includes("needs.native.result"));
  assert.ok(step.env.BROWSER.includes("needs.browser.result"));
  for (const native of ["success", "failure", "cancelled", "skipped"]) {
    for (const browser of ["success", "failure", "cancelled", "skipped"]) {
      // Execute the actual cross-platform gate command rather than duplicate its logic.
      const result = spawnSync(step.run, { shell: true, env: { ...process.env, NATIVE: native, BROWSER: browser }, encoding: "utf8" });
      assert.equal(result.error, undefined);
      assert.equal(result.status === 0, native === "success" && browser === "success", `${native}/${browser}: ${result.stderr}`);
    }
  }
});
