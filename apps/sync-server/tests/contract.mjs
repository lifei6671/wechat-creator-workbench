import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const deviceToken = () => randomBytes(32).toString("hex");
const category = (entityId, name, baseRevision = 0, parentId = null) => ({
  entityType: "category", entityId, baseRevision, operation: "upsert", payload: { name, parentId },
});
const entry = (entityId, contentMd, baseRevision = 0, categoryId = null) => ({
  entityType: "entry", entityId, baseRevision, operation: "upsert",
  payload: { kind: "article", title: "写作稿", contentMd, categoryId, folderSortOrder: 7 },
});
const operation = (...mutations) => ({ operationId: randomUUID(), mutations });

export async function runContract(base, setupSecret) {
  const request = async (path, method = "GET", headers = {}, data) => {
    const json = data !== undefined && !Buffer.isBuffer(data);
    let response;
    let bytes;
    try {
      response = await fetch(new URL("/v1/" + path, base), {
        method,
        headers: json ? { ...headers, "Content-Type": "application/json" } : headers,
        body: json ? JSON.stringify(data) : data,
      });
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new Error(method + " " + path + " transport failed", { cause: error });
    }
    const body = response.headers.get("content-type")?.includes("application/json") && bytes.length
      ? JSON.parse(bytes.toString("utf8"))
      : bytes;
    return { status: response.status, body, bytes: bytes.length, headers: response.headers };
  };
  const ok = async (expected, ...args) => {
    const res = await request(...args);
    assert.equal(res.status, expected, args[0] + " " + JSON.stringify(res.body).slice(0, 400));
    return res.body;
  };
  const meta = await ok(200, "meta");
  assert.equal(meta.protocolVersion, 1);
  assert.equal(meta.canvasSync, true);
  assert.equal(meta.connectionRecovery, true);
  assert.equal(meta.workspaceAccess, true);
  assert.equal(meta.claimed, false);
  await ok(401, "devices");
  await ok(401, "setup/claim", "POST", {}, { setupSecret: "0".repeat(64), name: "invalid" });
  const claimRequests = ["seed A", "seed B"].map((name) => ({ setupSecret, name, deviceToken: deviceToken() }));
  const claims = await Promise.all(claimRequests.map((input) => request("setup/claim", "POST", {}, input)));
  assert.deepEqual(claims.map(({ status }) => status).sort(), [201, 409]);
  const firstIndex = claims.findIndex(({ status }) => status === 201);
  const first = claims[firstIndex].body;
  assert.deepEqual(await ok(201, "setup/claim", "POST", {}, claimRequests[firstIndex]), first);
  const headers = (token) => ({
    Authorization: "Bearer " + token,
    "X-Sync-Instance": meta.serverInstanceId,
    "X-Sync-Epoch": meta.syncEpoch,
  });
  const a = headers(claimRequests[firstIndex].deviceToken);
  assert.equal((await ok(409, "devices/" + first.deviceId, "DELETE", a)).error, "device_required");
  const previousAccess = await ok(201, "access-key", "POST", a);
  const { accessKey } = await ok(201, "access-key", "POST", a);
  await ok(401, "devices/join", "POST", {}, {
    accessKey: previousAccess.accessKey, name: "expired key", deviceToken: deviceToken(),
  });
  const joinRequest = { accessKey, name: "peer", deviceToken: deviceToken() };
  const [second, retried] = await Promise.all([
    ok(201, "devices/join", "POST", {}, joinRequest),
    ok(201, "devices/join", "POST", {}, joinRequest),
  ]);
  assert.deepEqual(retried, second);
  const b = headers(joinRequest.deviceToken);
  assert.equal((await ok(200, "devices", "GET", b)).devices.length, 2);
  await ok(200, "sync/seed", "POST", a, { action: "begin" });
  await ok(200, "sync/seed", "POST", a, { action: "begin" });
  assert.equal((await ok(409, "devices/" + first.deviceId, "DELETE", b)).error, "device_required");
  await ok(409, "sync/seed", "POST", b, { action: "begin" });
  await ok(409, "sync/bootstrap", "GET", b);
  const push = async (who, ...operations) => (await ok(200, "sync/push", "POST", who, {
    protocolVersion: 1, cursor: 0, operations,
  })).results;
  const seed = operation(category("root", "Topics"), entry("draft", "初稿", 0, "root"));
  const [initial] = await push(a, seed);
  assert.equal(initial.status, "applied");
  assert.equal(initial.cursor, 2);
  assert.equal((await push(a, seed))[0].status, "already_applied");
  await ok(200, "sync/seed", "POST", a, { action: "finish" });
  await ok(200, "sync/seed", "POST", a, { action: "finish" });

  const [page1, early] = await Promise.all([
    ok(200, "sync/pull?cursor=0&limit=1", "GET", b),
    ok(200, "sync/bootstrap?limit=1", "GET", b),
  ]);
  assert.equal(page1.changes[0].groupSize, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(early.snapshotStartCursor, 2);
  assert.equal(early.nextAfter.entityId, "root");
  const [added] = await push(a, operation(category("a", "Added during scan")));
  assert.equal(added.status, "applied");

  const edits = await Promise.all([
    push(a, operation(entry("draft", "甲端正文", 1, "root"))),
    push(b, operation(entry("draft", "乙端正文", 1, "root"))),
  ]);
  assert.deepEqual(edits.map(([result]) => result.status).sort(), ["applied", "conflict"]);
  const part2 = await ok(200, "sync/pull?cursor=1&limit=1", "GET", b);
  assert.equal(part2.changes[0].groupId, page1.changes[0].groupId);
  assert.equal(part2.changes[0].groupIndex, 1);
  assert.equal(part2.changes[0].remoteRevision, 1);
  assert.equal(part2.changes[0].payload.contentMd, "初稿");
  const latest = await ok(200, "sync/bootstrap?afterType=category&afterId=root", "GET", b);
  assert.equal(latest.snapshotEndCursor, 4);
  assert.equal(latest.entities.find(({ entityId }) => entityId === "draft").remoteRevision, 2);
  const catchup = await ok(200, "sync/pull?cursor=2&throughCursor=4", "GET", b);
  assert.deepEqual(catchup.changes.map(({ entityId }) => entityId), ["a", "draft"]);

  const [reuse] = await push(a, { ...seed, mutations: [category("wrong", "wrong payload")] });
  assert.equal(reuse.reason, "operation_id_reused");
  const [blocked, independent] = await push(b,
    operation(category("side", "side effect"), entry("draft", "will roll back", 1, "root")),
    operation(category("other", "Independent")));
  assert.equal(blocked.status, "conflict");
  assert.equal(independent.status, "applied");
  await ok(404, "sync/entities/category/side", "GET", b);

  const [duplicate] = await push(b, operation(category("another", "topics")));
  assert.equal(duplicate.reason, "category_name_conflict");
  assert(duplicate.versions.some(({ entityId }) => entityId === "root"));
  const removeRoot = { entityType: "category", entityId: "root", baseRevision: 1, operation: "delete" };
  const [inUse] = await push(a, operation(removeRoot));
  assert.equal(inUse.reason, "category_in_use");
  const [moved] = await push(a, operation(removeRoot, entry("draft", "已迁移", 2, "other")));
  assert.equal(moved.status, "applied");
  assert((await ok(200, "sync/entities/category/root", "GET", b)).deletedAt);
  assert.equal((await ok(200, "sync/entities/entry/draft", "GET", b)).payload.folderSortOrder, 7);
  const [deleted] = await push(a, operation({ entityType: "entry", entityId: "draft", baseRevision: 3, operation: "delete" }));
  assert.equal(deleted.status, "applied");
  assert.equal((await ok(200, "sync/entities/entry/draft", "GET", b)).payload.contentMd, "已迁移");
  const [restored] = await push(a, operation({ ...entry("draft", "已恢复", 4), operation: "restore" }));
  assert.equal(restored.status, "applied");

  const content = Buffer.from("多字节长文。".repeat(5000));
  const hash = digest(content);
  const long = entry("long", "");
  delete long.payload.contentMd;
  Object.assign(long.payload, { contentBlobHash: hash, contentBlobSize: content.length });
  assert.equal((await push(a, operation(long)))[0].reason, "blob_missing");
  assert.equal((await ok(422, "blobs/" + "0".repeat(64), "PUT", a, content)).error, "blob_checksum_mismatch");
  await ok(204, "blobs/" + hash, "PUT", a, content);
  const head = await request("blobs/" + hash, "HEAD", b);
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), content.length);
  assert.equal(head.bytes, 0);
  assert.equal(digest(await ok(200, "blobs/" + hash, "GET", b)), hash);
  assert.equal((await push(a, operation(long)))[0].status, "applied");
  const illustrated = entry("illustrated", "![图](asset://private-image)");
  illustrated.payload.assetIds = ["private-image"];
  illustrated.payload.coverAssetId = "private-image";
  assert.equal((await push(a, operation(illustrated)))[0].reason, "asset_missing");
  const image = {
    entityType: "asset", entityId: "private-image", baseRevision: 0, operation: "upsert",
    payload: { name: "image.png", kind: "original", sha256: hash, bytes: content.length, mimeType: "image/png" },
  };
  assert.equal((await push(a, operation(illustrated, image)))[0].status, "applied");
  assert.equal((await ok(200, "sync/entities/asset/private-image", "GET", b)).payload.sha256, hash);
  const derived = { ...image, entityId: "derived-a", payload: { ...image.payload, kind: "derived", sourceKey: "render-key" } };
  assert.equal((await push(a, operation(derived)))[0].status, "applied");
  assert.equal((await push(b, operation({ ...derived, entityId: "derived-b" })))[0].reason, "derived_asset_conflict");
  const credited = entry("credited-a", "引用内容");
  credited.payload.source = { url: "https://example.test/credited" };
  assert.equal((await push(a, operation(credited)))[0].status, "applied");
  assert.equal((await push(b, operation({ ...credited, entityId: "credited-b" })))[0].status, "applied");
  const trash = entry("trash", "在离线时移入回收站", 0, "trash-folder");
  const [trashed] = await push(a, operation(category("trash-folder", "Trash notes"), { ...trash, operation: "delete" }));
  assert.equal(trashed.status, "applied");
  const savedTrash = await ok(200, "sync/entities/entry/trash", "GET", b);
  assert(savedTrash.deletedAt);
  assert.equal(savedTrash.payload.contentMd, "在离线时移入回收站");
  const moveTrash = { ...entry("trash", "在离线时移入回收站", 1), operation: "delete" };
  const removeTrashFolder = { entityType: "category", entityId: "trash-folder", baseRevision: 1, operation: "delete" };
  assert.equal((await push(a, operation(removeTrashFolder, moveTrash)))[0].status, "applied");
  const movedTrash = await ok(200, "sync/entities/entry/trash", "GET", b);
  assert(movedTrash.deletedAt);
  assert.equal(movedTrash.payload.categoryId, null);

  const topic = (entityId) => ({ entityType: "collection", entityId, baseRevision: 0, operation: "upsert",
    payload: { title: "专题", description: "素材与思路", createdAt: 1, updatedAt: 1 } });
  const card = (entityId, fields) => ({ entityType: "collection_node", entityId, baseRevision: 0, operation: "upsert",
    payload: { collectionId: "topic", x: -14.5, y: 22, width: 320, height: 200, createdAt: 1, updatedAt: 1, contentMd: "", ...fields } });
  const edge = (entityId, sourceNodeId, targetNodeId) => ({ entityType: "collection_edge", entityId, baseRevision: 0, operation: "upsert",
    payload: { collectionId: "topic", sourceNodeId, targetNodeId, label: "下一步", createdAt: 1 } });
  const remove = (mutation) => ({ entityType: mutation.entityType, entityId: mutation.entityId, baseRevision: 1, operation: "delete" });
  const openTopic = topic("topic");
  const note = card("note", { kind: "text", contentMd: "提纲" });
  const screenshot = card("shot", { kind: "image", assetId: "private-image" });
  const link = edge("arrow", "note", "shot");
  assert.equal((await push(a, operation(note)))[0].reason, "collection_missing");
  assert.equal((await push(a, operation(link, screenshot, note, openTopic)))[0].status, "applied");
  assert.equal((await ok(200, "sync/entities/collection_node/shot", "GET", b)).payload.assetId, "private-image");
  const canvas = await ok(200, "sync/bootstrap?afterType=collection&afterId=topic", "GET", b);
  assert(canvas.entities.some(item => item.entityType === "collection_edge" && item.entityId === "arrow"));
  const foreign = card("foreign", { kind: "text", collectionId: "other-topic" });
  assert.equal((await push(b, operation(topic("other-topic"), foreign)))[0].status, "applied");
  assert.equal((await push(b, operation(edge("foreign-arrow", "note", "foreign"))))[0].reason, "canvas_endpoint_missing");
  assert.equal((await push(b, operation({ ...note, baseRevision: 1, payload: { ...note.payload, collectionId: "other-topic" } })))[0].reason, "canvas_parent_changed");
  assert.equal((await push(b, operation(card("bad-shot", { kind: "image", assetId: "missing" }))))[0].reason, "asset_missing");
  assert.equal((await push(b, operation(card("bad-entry", { kind: "entry", entryId: "missing" }))))[0].reason, "source_entry_missing");
  const offloaded = card("long-note", { kind: "text", contentBlobHash: hash, contentBlobSize: content.length, assetIds: ["private-image"] });
  delete offloaded.payload.contentMd;
  assert.equal((await push(b, operation(offloaded)))[0].status, "applied");
  assert.equal((await push(a, operation(remove(note))))[0].reason, "canvas_in_use");
  const [partial] = await push(a, operation(remove(openTopic), remove(link), remove(note), remove(screenshot)));
  assert.equal(partial.reason, "canvas_in_use");
  assert.equal((await ok(200, "sync/entities/collection_edge/arrow", "GET", b)).deletedAt, null);
  const [deletedCanvas] = await push(a, operation(remove(openTopic), remove(link), remove(note), remove(screenshot), remove(offloaded)));
  assert.equal(deletedCanvas.status, "applied");
  const canvasDelete = await ok(200, "sync/pull?cursor=" + (deletedCanvas.cursor - 5), "GET", b);
  assert.equal(canvasDelete.changes.length, 5);
  assert.equal(new Set(canvasDelete.changes.map(item => item.groupId)).size, 1);
  assert(canvasDelete.changes.every(item => item.deletedAt !== null && item.groupSize === 5));

  await ok(401, "blobs/" + hash);
  await ok(409, "blobs/" + hash, "GET", { ...b, "X-Sync-Epoch": "old" });
  const largeBlob = Buffer.alloc(25 * 1024 * 1024, 0xab);
  const largeHash = digest(largeBlob);
  await ok(204, "blobs/" + largeHash, "PUT", a, largeBlob);
  assert.equal(digest(await ok(200, "blobs/" + largeHash, "GET", b)), largeHash);

  const metadata = "中".repeat(158_000);
  let start = 0;
  for (let index = 0; index < 5; index++) {
    const one = entry("wide-" + index, "body");
    one.payload.summary = metadata;
    const [result] = await push(a, operation(one));
    assert.equal(result.status, "applied");
    if (index === 0) start = result.cursor - 1;
  }
  const wide = await request("sync/pull?cursor=" + start, "GET", b);
  assert.equal(wide.status, 200, JSON.stringify(wide.body).slice(0, 200));
  assert(wide.bytes < 2 * 1024 * 1024);
  assert.equal(wide.body.changes.length, 4);
  assert.equal(wide.body.hasMore, true);
  const remainder = await ok(200, "sync/pull?cursor=" + wide.body.nextCursor, "GET", b);
  assert.equal(remainder.changes.length, 1);
  assert.equal(remainder.hasMore, false);
  assert.equal((await ok(409, "sync/pull?cursor=99999", "GET", a)).error, "reset_required");
  const peerKey = await ok(201, "recovery-key", "POST", b);
  await ok(204, "devices/" + second.deviceId, "DELETE", a);
  await ok(401, "blobs/" + hash, "GET", b);
  await ok(401, "sync/pull", "GET", b);
  const draftBeforeRecovery = await ok(200, "sync/entities/entry/draft", "GET", a);
  await ok(401, "recovery-key", "POST");
  const oldKey = await ok(201, "recovery-key", "POST", a);
  const { recoveryKey } = await ok(201, "recovery-key", "POST", a);
  const recoveryInput = (key) => ({ recoveryKey: key, name: "重新安装", deviceToken: deviceToken() });
  for (const key of [oldKey.recoveryKey, peerKey.recoveryKey, setupSecret]) {
    assert.equal((await ok(401, "recover", "POST", {}, recoveryInput(key))).error, "invalid_recovery_key");
  }
  const attempts = [recoveryInput(recoveryKey), recoveryInput(recoveryKey)];
  const recovered = await Promise.all(attempts.map(input => request("recover", "POST", {}, input)));
  assert.deepEqual(recovered.map(result => result.status).sort(), [200, 401]);
  const winner = recovered.findIndex(result => result.status === 200);
  assert.equal(recovered[winner].body.deviceId, first.deviceId);
  await ok(401, "recover", "POST", {}, attempts[winner]);
  await ok(401, "devices", "GET", a);
  await ok(401, "recovery-key", "POST", a);
  const recoveredHeaders = headers(attempts[winner].deviceToken);
  const deviceList = await ok(200, "devices", "GET", recoveredHeaders);
  assert.deepEqual(deviceList.devices.filter(device => !device.revokedAt).map(device => device.deviceId), [first.deviceId]);
  assert.equal(deviceList.devices.find(device => device.deviceId === first.deviceId).name, "重新安装");
  assert.deepEqual(await ok(200, "meta"), { ...meta, claimed: true, seedStatus: "ready" });
  assert.deepEqual(await ok(200, "sync/entities/entry/draft", "GET", recoveredHeaders), draftBeforeRecovery);
  assert.equal(digest(await ok(200, "blobs/" + hash, "GET", recoveredHeaders)), hash);
  return { instanceId: meta.serverInstanceId, credentials: recoveredHeaders, retainedHash: hash, pageBytes: wide.bytes };
}
