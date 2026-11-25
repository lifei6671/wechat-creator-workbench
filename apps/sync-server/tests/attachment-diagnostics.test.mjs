import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { localFiles } from "../dist/adapters/local-files.js";
import { r2Blobs } from "../dist/adapters/r2.js";
import { diagnoseEntities } from "../dist/diagnostics.js";

const bytes = Buffer.from("private image fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
const stream = () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });

for (const adapter of ["local files", "R2"]) test(`attachment diagnostics check real metadata through ${adapter}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "wcb-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  let object = null, reads = 0, heads = 0, unavailable = false;
  const blobs = adapter === "local files" ? await localFiles(directory) : r2Blobs({
    async put(_hash, body) { object = Buffer.from(await new Response(body).arrayBuffer()); return { size: object.length }; },
    async head() { heads++; if (unavailable) throw new Error("secret storage credential"); return object === null ? null : { size: object.length }; },
    async get() { reads++; throw new Error("image body must not be downloaded"); },
  });
  const payload = { kind: "original", name: "Private image", sha256: hash, bytes: bytes.length, mimeType: "image/png" };
  await db.batch([["INSERT INTO sync_entities VALUES('asset','image',7,?,NULL,1)", JSON.stringify(payload)]]);
  const before = await db.batch([["SELECT * FROM sync_entities"], ["SELECT * FROM sync_identity"], ["SELECT * FROM sync_operations"]]);
  const check = async expected => {
    const result = await diagnoseEntities(db, blobs, "", "");
    assert.deepEqual(result, { checked: 1, issues: expected ? [{ entityType: "asset", entityId: "image", remoteRevision: 7, error: expected, field: "sha256" }] : [], nextAfter: null });
    assert.deepEqual(await db.batch([["SELECT * FROM sync_entities"], ["SELECT * FROM sync_identity"], ["SELECT * FROM sync_operations"]]), before);
    assert.ok(!JSON.stringify(result).includes("secret"));
  };
  await check("blob_missing");
  await db.batch([["INSERT INTO sync_blobs VALUES(?,?)", hash, bytes.length]]);
  await check("blob_object_missing");
  await blobs.put(hash, bytes.length, stream());
  await check(null);
  if (adapter === "local files") await writeFile(join(directory, hash), "short");
  else object = Buffer.from("short");
  await check("blob_object_size_mismatch");
  if (adapter === "R2") {
    unavailable = true;
    await check("blob_storage_unavailable");
    assert.equal(reads, 0);
    assert.equal(heads, 4);
  }
});

test("attachment diagnostic failure preserves pagination and never exposes storage errors", async t => {
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  await db.batch([["INSERT INTO sync_blobs VALUES(?,?)", hash, bytes.length], ...Array.from({ length: 101 }, (_, i) => [
    "INSERT INTO sync_entities VALUES('asset',?,1,?,NULL,1)", "image-" + String(i).padStart(3,"0"),
    JSON.stringify({ kind: "original", name: "Image", sha256: hash, bytes: bytes.length, mimeType: "image/png" }),
  ])]);
  let reads = 0;
  const blobs = { async head() { throw new Error("secret bucket credentials"); }, async get() { reads++; throw new Error("must use metadata"); }, async put() { throw new Error("read only"); } };
  const page = await diagnoseEntities(db, blobs, "", "");
  assert.equal(page.checked, 100);
  assert.equal(page.issues.length, 100);
  assert.deepEqual(page.nextAfter, { entityType: "asset", entityId: "image-099" });
  assert.ok(page.issues.every(issue => issue.error === "blob_storage_unavailable"));
  const last = await diagnoseEntities(db, blobs, page.nextAfter.entityType, page.nextAfter.entityId);
  assert.equal(last.checked, 1);
  assert.equal(last.nextAfter, null);
  assert.equal(reads, 0);
  assert.ok(!JSON.stringify(page).includes("secret"));
});


for (const failure of ["get", "stream"]) test(`Markdown diagnostic keeps pagination when ${failure} fails after successful head`, async t => {
  const db = openSqlite(":memory:");
  t.after(() => db.close());
  await db.batch([["INSERT INTO sync_blobs VALUES(?,?)", hash, bytes.length],
    ["INSERT INTO sync_entities VALUES('entry','markdown',2,?,NULL,1)", JSON.stringify({ kind: "article", title: "Draft", contentBlobHash: hash, contentBlobSize: bytes.length })]]);
  const blobs = {
    async head() { return { size: bytes.length }; },
    async get() {
      if (failure === "get") throw new Error("secret storage details");
      return new ReadableStream({ start(controller) { controller.error(new Error("secret stream details")); } });
    },
    async put() { throw new Error("read only"); },
  };
  const result = await diagnoseEntities(db, blobs, "", "");
  assert.deepEqual(result, { checked: 1, issues: [{ entityType: "entry", entityId: "markdown", remoteRevision: 2,
    error: "blob_storage_unavailable", field: "contentBlobHash" }], nextAfter: null });
});
