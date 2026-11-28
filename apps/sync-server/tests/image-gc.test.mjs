import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { authenticate, claim, connect } from "../dist/auth.js";
import { identity } from "../dist/storage.js";
import { seed, apply } from "../dist/sync.js";
import { gcImportHistory, gcFeed, gcCheckpoint, gcProtect, gcBeginDelete, IMAGE_GC_WAIT_MS, IMAGE_GC_RECOVERY_MS } from "../dist/image-gc.js";
import { putManagedPrivate, privateLocation, gcRunPrivateJob, gcRestorePrivate, gcExpirePrivate } from "../dist/image-gc-store.js";
import { reservePublic, commitPublic, backupPublic, completePublic, publicBackup, restoredPublic, expirePublic } from "../dist/image-gc-s3.js";
import { createApp } from "../dist/app.js";
import { localFiles } from "../dist/adapters/local-files.js";

async function fixture(t, devices = 1) {
  const db = openSqlite(":memory:"); t.after(() => db.close());
  const key = randomBytes(32).toString("hex"), firstToken = randomBytes(32).toString("hex");
  const claimed = await claim(db, key, key, firstToken, "A");
  const state = await identity(db);
  const auth = await authenticate(db, `Bearer ${firstToken}`);
  const client = { instanceId: state.instance_id, epoch: state.epoch, deviceId: claimed.deviceId, tokenHash: auth.tokenHash };
  await seed(db, client, "begin"); await seed(db, client, "finish");
  let second;
  if (devices === 2) {
    const token = randomBytes(32).toString("hex");
    const joined = await connect(db, key, key, token, "B", state.instance_id, state.epoch);
    const authorization = await authenticate(db, `Bearer ${token}`);
    second = { ...client, deviceId: joined.deviceId, tokenHash: authorization.tokenHash };
  }
  const now = Date.now(), old = now - 40 * 86400000;
  const hash = index => index.toString(16).padStart(64, "0");
  const entity = (type, id, payload) => ["INSERT INTO sync_entities VALUES(?,?,1,?,NULL,?)", type, id, JSON.stringify(payload), old];
  await db.batch([
    entity("asset", "source", { sha256: "f".repeat(64), kind: "original", sourceKey: null, bytes: 100, width: 10, height: 10 }),
    entity("entry", "article", { status: "draft", contentMd: "", assetIds: [], coverAssetId: null }),
    entity("image_project", "project", { baseAssetId: "source", assetIds: ["source"] }),
    ...Array.from({ length: 8 }, (_, index) => [
      entity("asset", `output-${index}`, { sha256: hash(index), kind: "original", sourceKey: `image-render:render-${index}`, bytes: 100, width: 10, height: 10 }),
      entity("image_render", `render-${index}`, { projectId: "project", outputAssetId: `output-${index}`, assetIds: ["source"], createdAt: old + index }),
    ]).flat(),
    ["INSERT INTO image_gc_copies VALUES('copy-0','s3','test-bucket','unique-key','generation-1',?,?,100,1,'live',?,NULL,?)", hash(0), hash(0), old, state.epoch],
  ]);
  return { db, client, second, now, hash, firstToken };
}
const checkpoint = (db, client, feed, roots = []) => gcCheckpoint(db, client, {
  roundId: feed.roundId, revision: feed.revision, cursor: feed.cursor,
  capability: 1, complete: true, barrierPersisted: true, roots,
});

test("automatic remote planning waits for every device checkpoint and the full grace period", async t => {
  const { db, client, second, now } = await fixture(t, 2);
  const first = await gcFeed(db, client, now);
  const other = await gcFeed(db, second, now);
  assert.equal(first.roundId, other.roundId);
  assert.equal(first.candidates.length, 1);
  await checkpoint(db, client, first);
  await assert.rejects(gcBeginDelete(db, client, "copy-0", first.roundId, now + IMAGE_GC_WAIT_MS), { code: "gc_not_eligible" });
  await checkpoint(db, second, other);
  await assert.rejects(gcBeginDelete(db, client, "copy-0", first.roundId, now + IMAGE_GC_WAIT_MS - 1), { code: "gc_not_eligible" });
  const job = await gcBeginDelete(db, client, "copy-0", first.roundId, now + IMAGE_GC_WAIT_MS);
  assert.equal(job.generation, "generation-1");
  assert.equal(job.copy_id, "copy-0");
  await assert.rejects(gcProtect(db, client, ["0".repeat(64)], "clipboard"), { code: "gc_restore_required" });
});
test("external protection cancels waiting before delivery and cannot race an admitted deletion", async t => {
  const { db, client, now, hash } = await fixture(t);
  const feed = await gcFeed(db, client, now);
  await checkpoint(db, client, feed);
  await gcProtect(db, client, [hash(0)], "clipboard");
  await assert.rejects(gcBeginDelete(db, client, "copy-0", feed.roundId, now + IMAGE_GC_WAIT_MS), { code: "gc_not_eligible" });
  const [[copy]] = await db.batch([["SELECT state FROM image_gc_copies WHERE id='copy-0'"]]);
  assert.equal(copy.state, "live");
});
test("a reference change invalidates completed device checkpoints", async t => {
  const { db, client, now } = await fixture(t);
  const feed = await gcFeed(db, client, now);
  await checkpoint(db, client, feed);
  await db.batch([["UPDATE sync_entities SET payload_json=json_set(payload_json,'$.assetIds',json('[\"output-0\"]')) WHERE entity_type='entry' AND entity_id='article'"]]);
  await assert.rejects(gcBeginDelete(db, client, "copy-0", feed.roundId, now + IMAGE_GC_WAIT_MS), { code: "gc_not_eligible" });
  assert.equal((await gcFeed(db, client, now + IMAGE_GC_WAIT_MS)).candidates.length, 0);
});

test("a permanent protection keeps recursive render inputs as well as the delivered output", async t => {
  const { db, client, now, hash } = await fixture(t);
  await db.batch([["UPDATE sync_entities SET payload_json=json_set(payload_json,'$.assetIds',json('[\"output-0\"]')) WHERE entity_type='image_render' AND entity_id='render-1'"]]);
  await gcProtect(db, client, [hash(1)], "clipboard");
  assert.equal((await gcFeed(db, client, now)).candidates.length, 0);
});

test("verified bytes can restore an expired logical hash into a new key and a late old-key delete cannot erase it", async t => {
  const { db, client, now } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "wcb-gc-store-"));
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await localFiles(directory);
  const bytes = Buffer.from("immutable image bytes"), hash = createHash("sha256").update(bytes).digest("hex");
  const first = await putManagedPrivate(db, store, client, hash, bytes.length, new Response(bytes).body);
  assert.notEqual(first.key, hash);
  await db.batch([
    ["UPDATE image_gc_copies SET state='expired' WHERE id=?", first.copyId],
    ["INSERT INTO image_gc_rounds VALUES('old-round',0,0,'[]',0)"],
    ["INSERT INTO image_gc_jobs(id,copy_id,generation,round_id,executor,state,created_at) VALUES('old-job',?,?,'old-round',?,'expired',0)", first.copyId, first.generation, client.deviceId],
  ]);
  const restored = await putManagedPrivate(db, store, client, hash, bytes.length, new Response(bytes).body, now + 1);
  assert.notEqual(restored.key, first.key);
  assert.notEqual(restored.generation, first.generation);
  await store.remove(first.key);
  const location = await privateLocation(db, hash);
  assert.equal(location.object_key, restored.key);
  assert.deepEqual(Buffer.from(await new Response(await store.get(location.object_key)).arrayBuffer()), bytes);
  await gcProtect(db, client, [hash], "clipboard");
});

async function privateFixture(t) {
  const base = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "wcb-gc-private-"));
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await localFiles(directory);
  const bytes = Buffer.from("private immutable render"), hash = createHash("sha256").update(bytes).digest("hex");
  await base.db.batch([["UPDATE sync_entities SET payload_json=json_set(payload_json,'$.sha256',?) WHERE entity_type='asset' AND entity_id='output-0'", hash]]);
  const copy = await putManagedPrivate(base.db, store, base.client, hash, bytes.length, new Response(bytes).body);
  const feed = await gcFeed(base.db, base.client, base.now);
  await checkpoint(base.db, base.client, feed);
  const job = await gcBeginDelete(base.db, base.client, copy.copyId, feed.roundId, base.now + IMAGE_GC_WAIT_MS);
  return { ...base, store, bytes, hash, copy, job };
}

test("private retirement requires a verified byte backup and remains resumable after readback failure", async t => {
  const { db, client, store, copy, job, now, hash } = await privateFixture(t);
  let removed = 0;
  const corrupt = { ...store,
    get: key => key.startsWith("wcbgc_recycle_") ? Promise.resolve(new Response("corrupt").body) : store.get(key),
    remove: async key => { removed++; await store.remove(key); },
  };
  await assert.rejects(gcRunPrivateJob(db, corrupt, client, job.id, now + IMAGE_GC_WAIT_MS), { code: "gc_blob_size_mismatch" });
  assert.equal(removed, 0);
  assert.ok(await store.head(copy.key));
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  assert.equal(await store.head(copy.key), null);
  const [[saved]] = await db.batch([["SELECT * FROM image_gc_jobs WHERE id=?", job.id]]);
  assert.equal(saved.backup_verified, 1);
  assert.ok(await store.head(saved.backup_key));
  assert.equal((await privateLocation(db, hash)).state, "retired");
});

test("a delete already in flight only removes its retired generation after a new verified copy becomes current", { timeout: 30000 }, async t => {
  const { db, client, store, copy, job, now, bytes, hash } = await privateFixture(t);
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  const slow = { ...store, remove: async key => { begin(); await resumed; await store.remove(key); } };
  const deleting = gcRunPrivateJob(db, slow, client, job.id, now + IMAGE_GC_WAIT_MS);
  await Promise.race([started, deleting.then(() => { throw new Error("delete did not enter object I/O"); })]);
  let restored;
  try { restored = await putManagedPrivate(db, store, client, hash, bytes.length, new Response(bytes).body); }
  finally { release(); }
  await deleting;
  assert.equal(await store.head(copy.key), null);
  const head = await privateLocation(db, hash);
  assert.equal(head.id, restored.copyId);
  assert.deepEqual(Buffer.from(await new Response(await store.get(head.object_key)).arrayBuffer()), bytes);
  await gcProtect(db, client, [hash], "clipboard");
});

test("restoration reads verified recovery bytes and publishes a new current generation", async t => {
  const { db, client, store, copy, job, now, hash, bytes } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  const restored = await gcRestorePrivate(db, store, client, hash, true);
  assert.notEqual(restored.key, copy.key);
  const head = await privateLocation(db, hash);
  assert.equal(head.id, restored.copyId);
  assert.deepEqual(Buffer.from(await new Response(await store.get(head.object_key)).arrayBuffer()), bytes);
  const [[pins]] = await db.batch([["SELECT count(*) AS count FROM image_gc_protections WHERE reason='restoring'"]]);
  assert.equal(pins.count, 0);
});

test("an expired recovery remains expired after a failed restore rather than staying in progress", async t => {
  const { db, client, store, job, now, hash } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  const [[saved]] = await db.batch([["SELECT backup_key FROM image_gc_jobs WHERE id=?", job.id]]);
  await store.remove(saved.backup_key);
  await db.batch([
    ["UPDATE image_gc_jobs SET state='expired',backup_key=NULL,backup_verified=0 WHERE id=?", job.id],
    ["UPDATE image_gc_copies SET state='expired' WHERE id=(SELECT copy_id FROM image_gc_jobs WHERE id=?)", job.id],
  ]);
  await assert.rejects(gcRestorePrivate(db, store, client, hash), { code: "gc_recovery_expired" });
  assert.equal((await privateLocation(db, hash)).state, "expired");
  const [[pins]] = await db.batch([["SELECT count(*) AS count FROM image_gc_protections WHERE reason='restoring'"]]);
  assert.equal(pins.count, 0);
});

test("expired backup metadata does not hide another registered valid copy of the same bytes", async t => {
  const { db, client, store, job, now, hash, bytes, copy } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  await putManagedPrivate(db, store, client, hash, bytes.length, new Response(bytes).body);
  const [[saved]] = await db.batch([["SELECT backup_key FROM image_gc_jobs WHERE id=?", job.id]]);
  await store.remove(saved.backup_key);
  await db.batch([
    ["UPDATE image_gc_jobs SET state='expired',backup_key=NULL,backup_verified=0 WHERE id=?", job.id],
    ["UPDATE image_gc_copies SET state='expired' WHERE id=?", copy.copyId],
    ["UPDATE image_gc_private_heads SET copy_id=? WHERE sha256=?", copy.copyId, hash],
  ]);
  const restored = await gcRestorePrivate(db, store, client, hash);
  assert.deepEqual(Buffer.from(await new Response(await store.get(restored.key)).arrayBuffer()), bytes);
});

test("private recovery bytes expire after their retention period while immutable render metadata remains", async t => {
  const { db, client, store, job, now, hash } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  await assert.rejects(gcExpirePrivate(db, store, client, job.id, now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS - 1), { code: "gc_recovery_retained" });
  const [[saved]] = await db.batch([["SELECT backup_key FROM image_gc_jobs WHERE id=?", job.id]]);
  await gcExpirePrivate(db, store, client, job.id, now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS);
  assert.equal(await store.head(saved.backup_key), null);
  assert.equal((await privateLocation(db, hash)).state, "expired");
  const [[renders]] = await db.batch([["SELECT count(*) AS count FROM sync_entities WHERE entity_type='image_render'"]]);
  assert.equal(renders.count, 8);
  await assert.rejects(gcRestorePrivate(db, store, client, hash), { code: "gc_recovery_expired" });
});

test("recovery expiry and restoration cannot claim the same backup concurrently", { timeout: 30000 }, async t => {
  const { db, client, store, job, now, hash } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  const slow = { ...store, remove: async key => { begin(); await resumed; await store.remove(key); } };
  const expiring = gcExpirePrivate(db, slow, client, job.id, now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS);
  await Promise.race([started, expiring.then(() => { throw new Error("expiry did not enter object I/O"); })]);
  try { await assert.rejects(gcRestorePrivate(db, store, client, hash), { code: "gc_restore_busy" }); }
  finally { release(); }
  await expiring;
});

for (const parent of [true, false]) test(parent ? "a pending parent snapshot keeps its input recovery bytes" : "a pending public location keeps the raw output recovery bytes", async t => {
  const { db, client, store, job, now, hash, hash: source } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  const parentHash = parent ? "1".padStart(64, "0") : source;
  if (parent) await db.batch([["UPDATE sync_entities SET payload_json=json_set(payload_json,'$.assetIds',json('[\"output-0\"]')) WHERE entity_type='image_render' AND entity_id='render-1'"]]);
  await db.batch([["INSERT INTO image_gc_copies VALUES('pending-public','s3','other-bucket','other-key','other-generation',?,?,100,1,'waiting',?,0,?)",
    parentHash, parentHash, now, client.epoch]]);
  await assert.rejects(gcExpirePrivate(db, store, client, job.id, now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS), { code: "gc_recovery_retained" });
  await db.batch([["UPDATE image_gc_copies SET state='expired' WHERE id='pending-public'"]]);
  await gcExpirePrivate(db, store, client, job.id, now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS);
  assert.equal((await privateLocation(db, hash)).state, "expired");
});

test("normal sync cannot commit references after retirement and the same operation can retry after restore", async t => {
  const { db, client, store, copy, job, now, hash } = await privateFixture(t);
  const input = { operationId: "late-reference", mutations: [{ entityType: "entry", entityId: "article",
    baseRevision: 1, operation: "upsert", payload: { status: "draft", contentMd: "", assetIds: ["output-0"], coverAssetId: null } }] };
  const blocked = await apply(db, client, 0, input);
  assert.equal(blocked.reason, "gc_restore_required");
  const [[article]] = await db.batch([["SELECT payload_json FROM sync_entities WHERE entity_type='entry' AND entity_id='article'"]]);
  assert.deepEqual(JSON.parse(article.payload_json).assetIds, []);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  await gcRestorePrivate(db, store, client, hash);
  const accepted = await apply(db, client, 0, input);
  assert.equal(accepted.status, "applied");
});

test("expiry resumes an already committed claim after a lost response", async t => {
  const { db, client, store, job, now, hash } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  let once = true;
  const lost = { batch: async statements => {
    const rows = await db.batch(statements);
    if (once && statements[0][0].includes("UPDATE image_gc_jobs AS j")) { once = false; throw Error("lost response after claim"); }
    return rows;
  } };
  await assert.rejects(gcExpirePrivate(lost, store, client, job.id, now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS));
  await assert.rejects(gcRestorePrivate(db, store, client, hash), { code: "gc_restore_busy" });
  assert.equal((await gcExpirePrivate(db, store, client, job.id, now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS)).expired, true);
});
test("successful restore retry releases previous transient restore intents", async t => {
  const { db, client, store, job, now, hash } = await privateFixture(t);
  await gcRunPrivateJob(db, store, client, job.id, now + IMAGE_GC_WAIT_MS);
  await assert.rejects(gcRestorePrivate(db, { ...store, get: async () => { throw Error("transient read"); } }, client, hash));
  await gcRestorePrivate(db, store, client, hash);
  const [[pins]] = await db.batch([["SELECT count(*) AS count FROM image_gc_protections WHERE reason='restoring'"]]);
  assert.equal(pins.count, 0);
});

test("managed public copies keep encoded bytes distinct from raw hashes and restore to a new generation", async t => {
  const { db,client,now,hash }=await fixture(t);
  const dir=await mkdtemp(join(tmpdir(),"wcb-public-gc-"));assert.equal(resolve(dirname(dir)),resolve(tmpdir()));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=await localFiles(dir),bytes=Buffer.from("compressed WebP payload"),content=createHash("sha256").update(bytes).digest("hex");
  const input={sha256:hash(0),contentSha256:content,bytes:bytes.length,scope:"a".repeat(64),prefix:"work/images",format:"webp"};
  const copy=await reservePublic(db,client,input);
  assert.deepEqual(await reservePublic(db,client,input),copy);
  await commitPublic(db,client,{copyId:copy.copyId,publicUrl:"https://images.example/"+copy.key,version:null});
  const feed=await gcFeed(db,client,now);await checkpoint(db,client,feed);
  const job=await gcBeginDelete(db,client,copy.copyId,feed.roundId,now+IMAGE_GC_WAIT_MS);
  await assert.rejects(backupPublic(db,store,client,job.id,new Response("corrupt").body),{code:"gc_blob_size_mismatch"});
  assert.equal((await backupPublic(db,store,client,job.id,new Response(bytes).body)).deleteAuthorized,true);
  assert.equal((await backupPublic(db,store,client,job.id,new Response(bytes).body)).deleteAuthorized,true);
  await completePublic(db,client,{jobId:job.id});
  assert.deepEqual(Buffer.from(await publicBackup(db,store,client,job.id)),bytes);
  const restored=await reservePublic(db,client,input);assert.notEqual(restored.key,copy.key);
  await commitPublic(db,client,{copyId:restored.copyId,publicUrl:"https://images.example/"+restored.key,version:"v2"});
  await restoredPublic(db,client,{jobId:job.id,copyId:restored.copyId});
  await restoredPublic(db,client,{jobId:job.id,copyId:restored.copyId});
  await gcProtect(db,client,[hash(0)],"external-public");
  await db.batch([["UPDATE image_gc_jobs SET expires_at=0 WHERE id=?",job.id]]);
  assert.equal((await expirePublic(db,store,client,job.id)).expired,true);
  const [[location]]=await db.batch([["SELECT * FROM image_gc_copies WHERE id=?",restored.copyId]]);
  assert.equal(location.state,"live");assert.equal(location.content_sha256,content);
  await gcProtect(db,client,[hash(0)],"external-after-expiry");
});
test("public mutation batches reject credentials revoked after request authentication", async t => {
  const { db,client,hash }=await fixture(t);
  const copy=await reservePublic(db,client,{sha256:hash(0),contentSha256:hash(0),bytes:100,scope:"a".repeat(64),prefix:"work",format:"webp"});
  let checked=false;
  const raced={batch:async statements=>{
    if(!checked&&statements[0][0].includes("INSERT INTO image_gc_authorization")) {checked=true;await db.batch([["UPDATE sync_devices SET revoked_at=1 WHERE id=?",client.deviceId]]);}
    return db.batch(statements);
  }};
  await assert.rejects(commitPublic(raced,client,{copyId:copy.copyId,publicUrl:"https://images.example/"+copy.key,version:null}),{code:"invalid_device"});
  const [[row]]=await db.batch([["SELECT state FROM image_gc_copies WHERE id=?",copy.copyId]]);assert.equal(row.state,"uploading");
});

test("managed HTTP blob mapping supports offloaded Markdown validation and diagnostics", async t => {
  const {db,client,firstToken}=await fixture(t);
  await db.batch([["DELETE FROM sync_entities"]]);
  const dir=await mkdtemp(join(tmpdir(),"wcb-gc-http-"));assert.equal(resolve(dirname(dir)),resolve(tmpdir()));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=await localFiles(dir),app=createApp(db,store,undefined);
  const headers={Authorization:`Bearer ${firstToken}`,"X-Sync-Protocol":"3","X-Sync-Instance":client.instanceId,"X-Sync-Epoch":client.epoch};
  const bytes=Buffer.from("多字节正文".repeat(16000)),hash=createHash("sha256").update(bytes).digest("hex");
  const upload=await app.request("http://localhost/v1/blobs/"+hash,{method:"PUT",headers:{...headers,"X-Image-Version-Gc":"1","Content-Length":String(bytes.length)},body:bytes});
  assert.equal(upload.status,204,await upload.text());
  assert.equal(await store.head(hash),null);
  const payload={kind:"article",title:"正文",contentBlobHash:hash,contentBlobSize:bytes.length};
  const pushed=await app.request("http://localhost/v1/sync/push",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({protocolVersion:3,cursor:0,operations:[{operationId:"managed-body",mutations:[{entityType:"entry",entityId:"large-body",baseRevision:0,operation:"upsert",payload}]}]})});
  assert.equal((await pushed.json()).results[0].status,"applied");
  const diagnostics=await app.request("http://localhost/v1/sync/diagnostics",{headers});
  assert.deepEqual((await diagnostics.json()).issues,[]);
  const read=await app.request("http://localhost/v1/blobs/"+hash,{headers});assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);
});
test("initialization imports unavailable derived history without inventing a readable blob", async t=>{
  const {db,client,hash}=await fixture(t);
  await db.batch([["DELETE FROM sync_entities"],["UPDATE sync_identity SET seed_status='seeding',seed_device=?",client.deviceId]]);
  await gcImportHistory(db,client,{assetId:"old-output",sha256:hash(99),sourceKey:"image-render:old-render",bytes:100});
  const result=await apply(db,client,0,{operationId:"import-old-output",mutations:[{entityType:"asset",entityId:"old-output",baseRevision:0,operation:"upsert",payload:{sha256:hash(99),bytes:100,kind:"original",sourceKey:"image-render:old-render",mimeType:"image/webp",width:10,height:10}}]});
  assert.equal(result.status,"applied");
  const [[count]]=await db.batch([["SELECT count(*) AS count FROM sync_blobs WHERE sha256=?",hash(99)]]);assert.equal(count.count,0);
  assert.equal((await privateLocation(db,hash(99))).state,"expired");
  const root=await apply(db,client,0,{operationId:"unavailable-is-not-useable",mutations:[{entityType:"entry",entityId:"new-article",baseRevision:0,operation:"upsert",payload:{kind:"article",title:"草稿",contentMd:"",assetIds:["old-output"]}}]});
  assert.equal(root.reason,"gc_restore_required");
});
