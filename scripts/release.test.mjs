import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedFiles, injectVersion, manifest, releaseNotes, releaseVersion, verifyVersions } from "./release.mjs";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "wcb-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["src-tauri", "apps/sync-server", "docs/releases"]) mkdirSync(join(root, path), { recursive: true });
  for (const path of ["package.json", "src-tauri/tauri.conf.json", "apps/sync-server/package.json"]) {
    writeFileSync(join(root, path), JSON.stringify({ version: "0.1.0", dependencies: { foo: "1.0.0" } }));
  }
  writeFileSync(join(root, "apps/sync-server/package-lock.json"), JSON.stringify({ version: "0.1.0", packages: {
    "": { version: "0.1.0" }, "node_modules/foo": { version: "1.0.0" },
  } }));
  writeFileSync(join(root, "src-tauri/Cargo.toml"), '[package]\nname = "wechat-creator-workbench"\nversion = "0.1.0"\n\n[dependencies]\nfoo = "1"\n');
  writeFileSync(join(root, "src-tauri/Cargo.lock"), '[[package]]\nname = "foo"\nversion = "1.0.0"\n\n[[package]]\nname = "wechat-creator-workbench"\nversion = "0.1.0"\n');
  return root;
}

test("only stable canonical tags are accepted", () => {
  assert.equal(releaseVersion("v12.2.0"), "12.2.0");
  for (const tag of ["1.0.0", "v01.0.0", "v1.0.0-rc.1", "v1.0", "v1.0.0/evil"]) assert.throws(() => releaseVersion(tag));
});
test("injects only application versions and rejects drift", t => {
  const root = workspace(t);
  injectVersion(root, "v2.3.4");
  verifyVersions(root, "2.3.4");
  const lock = JSON.parse(readFileSync(join(root, "apps/sync-server/package-lock.json")));
  assert.equal(lock.packages["node_modules/foo"].version, "1.0.0");
  assert.match(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"), /name = "foo"\nversion = "1.0.0"/);
  writeFileSync(join(root, "package.json"), '{"version":"2.3.5"}');
  assert.throws(() => verifyVersions(root, "2.3.4"), /版本不一致/);
});
test("missing and placeholder release notes stop publication", t => {
  const root = workspace(t), file = join(root, "docs/releases/v2.0.0.md");
  assert.throws(() => releaseNotes(root, "v2.0.0"));
  writeFileSync(file, "# 更新\nTODO " + "详细中文变化".repeat(50));
  assert.throws(() => releaseNotes(root, "v2.0.0"), /占位/);
  writeFileSync(file, "# 更新\n" + "新增独立关于页，展示实际版本与本机架构。".repeat(12));
  assert.match(releaseNotes(root, "v2.0.0"), /独立关于页/);
});
test("manifest requires all desktop and server artifacts and matches their final names", t => {
  const root = workspace(t), tag = "v2.3.4";
  assert.throws(() => manifest(root, tag, "notes"), /缺失/);
  const signature = Buffer.from("untrusted comment: test signature\nnot-a-real-signature").toString("base64");
  for (const file of expectedFiles("2.3.4")) writeFileSync(join(root, file), file.endsWith(".sig") ? signature : "test fixture");
  const value = manifest(root, tag, "说明");
  assert.deepEqual(Object.keys(value.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
  assert.equal(value.notes, "说明");
  for (const item of Object.values(value.platforms)) assert.ok(expectedFiles("2.3.4").includes(item.url.split("/").at(-1)));
  writeFileSync(join(root, "CreatorWorkbench-2.3.4-windows-x64.exe.sig"), "bad signature");
  assert.throws(() => manifest(root, tag, "notes"), /签名格式/);
});
