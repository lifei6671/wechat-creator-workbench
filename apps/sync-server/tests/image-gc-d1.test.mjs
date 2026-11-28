import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { unstable_dev } from "wrangler";
import { IMAGE_GC_WAIT_MS, IMAGE_GC_RECOVERY_MS } from "../dist/image-gc.js";

test("D1 and R2 execute checkpoint, verified retirement, generation restore and backup expiry", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "wcb-gc-d1-"));
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
  let worker;
  t.after(async () => { if (worker) await worker.stop(); await rm(directory, { recursive: true, force: true }); });
  await promisify(execFile)(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply", "DB", "--local", "--persist-to", directory]);
  const token = randomBytes(32).toString("hex");
  worker = await unstable_dev("tests/image-gc-worker.ts", {
    local: true, ip: "127.0.0.1", port: 0, persistTo: directory, vars: { GC_TEST_TOKEN: token },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true }, logLevel: "warn",
  });
  const base = `http://127.0.0.1:${worker.port}`;
  const headers = { Authorization: `Bearer ${token}` };
  async function rpc(action, value) {
    const response = await fetch(base + action, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  await rpc("/sql", [["UPDATE sync_identity SET claimed=1,seed_status='ready'"], ["INSERT INTO sync_devices(id,name,token_hash,created_at,revoked_at) VALUES('gc-device','GC device',?,0,NULL)", "a".repeat(64)]]);
  const [[state]] = await rpc("/sql", [["SELECT * FROM sync_watermarks"]]);
  const client = { instanceId: state.instance_id, epoch: state.epoch, deviceId: "gc-device", tokenHash: "a".repeat(64) };
  const bytes = Buffer.from("R2 owned immutable render"), hash = createHash("sha256").update(bytes).digest("hex");
  const now = Date.now(), old = now - 40 * 86400000;
  const entity = (type, id, payload) => ["INSERT INTO sync_entities VALUES(?,?,1,?,NULL,?)", type, id, JSON.stringify(payload), old];
  await rpc("/sql", [
    entity("asset", "source", { sha256: "f".repeat(64), kind: "original", sourceKey: null }),
    entity("image_project", "project", { baseAssetId: "source", assetIds: ["source"] }),
    ...Array.from({ length: 6 }, (_, index) => [
      entity("asset", `output-${index}`, { sha256: index ? index.toString().padStart(64, "0") : hash, sourceKey: `image-render:render-${index}` }),
      entity("image_render", `render-${index}`, { projectId: "project", outputAssetId: `output-${index}`, assetIds: ["source"], createdAt: old + index }),
    ]).flat(),
  ]);
  const uploaded = await fetch(base + "/put", { method: "POST", headers: { ...headers, "X-Test-Client": JSON.stringify(client), "X-Test-Hash": hash }, body: bytes });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const copy = await uploaded.json();
  const feed = await rpc("/feed", { client, timestamp: now });
  assert.equal(feed.candidates.length, 1);
  await rpc("/checkpoint", { client, roundId: feed.roundId, revision: feed.revision, cursor: feed.cursor, capability: 1, complete: true, barrierPersisted: true, roots: [] });
  const job = await rpc("/begin", { client, copyId: copy.copyId, roundId: feed.roundId, timestamp: now + IMAGE_GC_WAIT_MS });
  await rpc("/run", { client, jobId: job.id, timestamp: now + IMAGE_GC_WAIT_MS });
  assert.equal((await rpc("/location", { client, hash })).state, "retired");
  const restored = await rpc("/restore", { client, hash });
  assert.notEqual(restored.key, copy.key);
  await rpc("/expire", { client, jobId: job.id, timestamp: now + IMAGE_GC_WAIT_MS + IMAGE_GC_RECOVERY_MS });
  assert.equal((await rpc("/location", { client, hash })).id, restored.copyId);
  const encoded=Buffer.from("actual public encoding differs from raw");const encodedHash=createHash("sha256").update(encoded).digest("hex");
  const input={client,sha256:hash,contentSha256:encodedHash,bytes:encoded.length,scope:"b".repeat(64),prefix:"test/profile",format:"webp"};
  const publicCopy=await rpc("/public-reserve",input);assert.deepEqual(await rpc("/public-reserve",input),publicCopy);
  await rpc("/public-commit",{client,copyId:publicCopy.copyId,publicUrl:"https://images.example/"+publicCopy.key,version:null});
  const publicFeed=await rpc("/feed",{client,timestamp:now});
  await rpc("/checkpoint",{client,roundId:publicFeed.roundId,revision:publicFeed.revision,cursor:publicFeed.cursor,capability:1,complete:true,barrierPersisted:true,roots:[]});
  const publicJob=await rpc("/begin",{client,copyId:publicCopy.copyId,roundId:publicFeed.roundId,timestamp:now+IMAGE_GC_WAIT_MS});
  const backup={client,jobId:publicJob.id,encoded:encoded.toString("base64")};
  await rpc("/public-backup",backup);await rpc("/public-backup",backup);
  await rpc("/public-complete",{client,jobId:publicJob.id});
  assert.deepEqual(Buffer.from(await rpc("/public-read",{client,jobId:publicJob.id})),encoded);
  const replacement=await rpc("/public-reserve",input);assert.notEqual(replacement.key,publicCopy.key);
  await rpc("/public-commit",{client,copyId:replacement.copyId,publicUrl:"https://images.example/"+replacement.key,version:null});
  await rpc("/public-restored",{client,jobId:publicJob.id,copyId:replacement.copyId});
  await rpc("/sql",[["UPDATE image_gc_jobs SET expires_at=0 WHERE id=?",publicJob.id]]);
  assert.equal((await rpc("/public-expire",{client,jobId:publicJob.id})).expired,true);

});
