import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export function imageScene(assetId = "image-canvas-input") {
  return {
    schemaVersion: 1,
    artboard: { width: 1, height: 1, background: { type: "transparent" } },
    layers: [{ id: "layer-a", assetId, x: 0, y: 0, width: 1, height: 1, rotation: 0,
      flipX: false, flipY: false, opacity: 1, crop: { x: 0, y: 0, width: 1, height: 1 },
      cornerRadius: 0, shadow: { color: "#000000", blur: 0, offsetX: 0, offsetY: 0, opacity: 0 } }],
    layout: { mode: "free", gap: 0, padding: 0, columns: 2, align: "center", size: 0 },
  };
}

export async function runImageCanvasContract({ ok, push, a, b, lookup, deviceId }) {
  const { imageSceneHash } = await import("../dist/image-canvas.js");
  const mutation = (entityType, entityId, payload, baseRevision = 0, operation = "upsert") =>
    ({ entityType, entityId, payload, baseRevision, operation });
  const operation = (...mutations) => ({ operationId: randomUUID(), mutations });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=", "base64");
  const hash = createHash("sha256").update(png).digest("hex");
  await ok(204, "blobs/" + hash, "PUT", a, png);
  const asset = (id, sourceKey = null) => mutation("asset", id,
    { kind: "original", name: "画布图片", sha256: hash, bytes: png.length, width: 1, height: 1, mimeType: "image/png", sourceKey });
  const scene = imageScene();
  scene.artboard.cornerRadius = 0.5;
  const project = { originEntryId: "deleted-origin", baseAssetId: "image-canvas-input", scene,
    assetIds: ["image-canvas-input"], createdAt: 1, updatedAt: 1 };
  assert.equal((await push(a, operation(mutation("image_project", "missing-input-project", project))))[0].reason, "asset_missing");
  assert.equal((await push(a, operation(asset("image-canvas-input"), mutation("image_project", "image-canvas-project", project))))[0].status, "applied");
  assert.equal((await ok(200, "sync/entities/image_project/image-canvas-project", "GET", b)).payload.scene.artboard.cornerRadius, 0.5);
  assert.equal((await push(a, operation(mutation("image_project", "missing-base-project", { ...project, baseAssetId: "missing-base" }))))[0].reason, "asset_missing");
  assert.equal((await push(a, operation(mutation("asset", "image-canvas-placeholder", { name: "缺少原图", kind: "original", sha256: null }),
    mutation("image_project", "placeholder-base-project", { ...project, baseAssetId: "image-canvas-placeholder" }))))[0].reason, "asset_missing");
  await ok(404, "sync/entities/asset/image-canvas-placeholder", "GET", b);
  const inputAsset = (await ok(200, "sync/entities/asset/image-canvas-input", "GET", b)).payload;
  for (const [field, value] of Object.entries({ sha256: "f".repeat(64), bytes: png.length + 1,
    mimeType: "image/jpeg", width: 2, height: 2, kind: "derived", sourceKey: "different-input" })) {
    const companion = mutation("entry", "image-immutable-" + field, { kind: "article", title: "不应写入", contentMd: "原子组", assetIds: ["image-canvas-input"] });
    const change = operation(mutation("asset", "image-canvas-input", { ...inputAsset, [field]: value }, 1), companion);
    assert.equal((await push(a, change))[0].reason, "image_asset_immutable", field);
    assert.equal((await lookup(b, deviceId, change)).status, "not_found");
    await ok(404, "sync/entities/entry/" + companion.entityId, "GET", b);
    assert.deepEqual((await ok(200, "sync/entities/asset/image-canvas-input", "GET", b)).payload, inputAsset);
  }
  const renamedInput = { ...inputAsset, name: "原图新名称", retainOnExit: true };
  assert.equal((await push(a, operation(mutation("asset", "image-canvas-input", renamedInput, 1))))[0].status, "applied");
  assert.deepEqual((await ok(200, "sync/entities/asset/image-canvas-input", "GET", b)).payload, renamedInput);
  // A base-only dependency stays immutable even when its project is a tombstone.
  const baseScene = { ...scene, layers: [] };
  assert.equal((await push(a, operation(asset("image-canvas-base-only"), mutation("image_project", "image-base-only-project",
    { ...project, baseAssetId: "image-canvas-base-only", scene: baseScene, assetIds: [] }))))[0].status, "applied");
  assert.equal((await push(a, operation(mutation("image_project", "image-base-only-project", undefined, 1, "delete"))))[0].status, "applied");
  const discardBase = operation(mutation("asset", "image-canvas-base-only", { ...asset("unused").payload, sha256: null }, 1));
  assert.equal((await push(a, discardBase))[0].reason, "image_asset_immutable");
  assert.equal((await lookup(b, deviceId, discardBase)).status, "not_found");
  const options = { format: "png", scale: 1, quality: 0.9, jpegBackground: "#ffffff" };
  const sceneHash = await imageSceneHash(scene);
  const render = { projectId: "image-canvas-project", scene, sceneHash, outputAssetId: "image-canvas-output",
    assetIds: ["image-canvas-input"], exportOptions: options, rendererVersion: "1", createdAt: 2 };
  const entry = mutation("entry", "image-canvas-article", { kind: "article", title: "可编辑图片", contentMd: "![图片](asset://image-canvas-output)", assetIds: ["image-canvas-output"] });
  const before = await ok(200, "sync/bootstrap?afterType=image_render&afterId=zzzz", "GET", b);
  const applyOperation = operation(asset("image-canvas-output", "image-render:image-canvas-render"),
    mutation("image_render", "image-canvas-render", render), entry);
  const wrongHash = operation(asset("image-canvas-output", "image-render:image-canvas-render"),
    mutation("image_render", "image-canvas-render", { ...render, sceneHash: "0".repeat(64) }), entry);
  assert.equal((await push(a, wrongHash))[0].reason, "invalid_image_scene_hash");
  assert.equal((await lookup(b, deviceId, wrongHash)).status, "not_found");
  await ok(404, "sync/entities/asset/image-canvas-output", "GET", b);
  await ok(404, "sync/entities/entry/image-canvas-article", "GET", b);
  const applied = (await push(a, applyOperation))[0];
  assert.equal(applied.status, "applied");
  assert.equal((await push(a, applyOperation))[0].status, "already_applied");
  assert.equal((await lookup(b, deviceId, applyOperation)).status, "applied");
  const page = await ok(200, "sync/pull?cursor=" + before.snapshotEndCursor, "GET", b);
  const group = page.changes.filter(change => ["image-canvas-output", "image-canvas-render", "image-canvas-article"].includes(change.entityId));
  assert.equal(group.length, 3);
  assert.equal(new Set(group.map(change => change.groupId)).size, 1);
  assert.deepEqual(group.map(change => change.groupIndex), [0, 1, 2]);
  assert.ok(group.every(change => change.groupSize === 3));
  assert.deepEqual((await ok(200, "sync/entities/image_render/image-canvas-render", "GET", b)).payload, render);
  const changedScene = { ...scene, artboard: { ...scene.artboard, background: { type: "solid", color: "#ffeedd" } } };
  assert.equal((await push(b, operation(mutation("image_project", "image-canvas-project", { ...project, scene: changedScene, updatedAt: 3 }, 1))))[0].status, "applied");
  assert.equal((await push(a, operation(mutation("image_project", "image-canvas-project", { ...project, updatedAt: 4 }, 1))))[0].reason, "revision_conflict");
  assert.deepEqual((await ok(200, "sync/entities/image_render/image-canvas-render", "GET", a)).payload.scene, scene);
  const immutable = await push(a, operation(mutation("image_render", "image-canvas-render", { ...render, scene: changedScene, sceneHash: await imageSceneHash(changedScene) }, 1),
    mutation("entry", "image-canvas-article", { ...entry.payload, title: "不可部分应用" }, 1)));
  assert.equal(immutable[0].reason, "image_render_immutable");
  assert.equal((await ok(200, "sync/entities/entry/image-canvas-article", "GET", b)).payload.title, "可编辑图片");
  const crop = structuredClone(scene);
  crop.layers[0].crop.width = 2;
  assert.equal((await push(a, operation(mutation("image_project", "bad-crop-project", { ...project, scene: crop }))))[0].reason, "invalid_image_crop");
  crop.layers[0].crop.width = 1;
  crop.layers[0].crop.x = 0.0005;
  assert.equal((await push(a, operation(mutation("image_project", "crop-rounding-project", { ...project, scene: crop }))))[0].status, "applied");
  assert.equal((await push(a, operation(asset("image-canvas-wrong-output", "image-render:wrong"),
    mutation("image_render", "image-canvas-wrong-render", { ...render, outputAssetId: "image-canvas-wrong-output" }))))[0].reason, "image_render_output_mismatch");
  await ok(404, "sync/entities/asset/image-canvas-wrong-output", "GET", b);
  const tampered = asset("image-canvas-output", "image-render:other-render"); tampered.baseRevision = 1;
  const tamperedOutput = operation(tampered);
  assert.equal((await push(a, tamperedOutput))[0].reason, "image_asset_immutable");
  assert.equal((await lookup(b, deviceId, tamperedOutput)).status, "not_found");
  assert.equal((await push(a, operation(mutation("image_project", "image-canvas-project", undefined, 2, "delete"))))[0].status, "applied");
  const tombstone = await ok(200, "sync/entities/image_project/image-canvas-project", "GET", b);
  assert.ok(tombstone.deletedAt);
  assert.deepEqual(tombstone.payload.scene, changedScene);
  // A frozen scene remains usable after deleting its original article and project.
  const copiedRender = { ...render, outputAssetId: "image-canvas-copy-output", createdAt: 5 };
  assert.equal((await push(b, operation(asset("image-canvas-copy-output", "image-render:image-canvas-copy-render"),
    mutation("image_render", "image-canvas-copy-render", copiedRender))))[0].status, "applied");
  assert.equal((await ok(200, "sync/entities/image_render/image-canvas-copy-render", "GET", a)).payload.sceneHash, sceneHash);
  const renderOnlyScene = imageScene("image-canvas-render-only-input");
  const renderOnly = { ...render, projectId: "image-base-only-project", scene: renderOnlyScene,
    sceneHash: await imageSceneHash(renderOnlyScene), outputAssetId: "image-canvas-render-only-output", assetIds: ["image-canvas-render-only-input"] };
  assert.equal((await push(a, operation(asset("image-canvas-render-only-input"),
    asset("image-canvas-render-only-output", "image-render:image-canvas-render-only"),
    mutation("image_render", "image-canvas-render-only", renderOnly))))[0].status, "applied");
  const replaceRenderInput = operation(mutation("asset", "image-canvas-render-only-input", { ...inputAsset, width: 2 }, 1));
  assert.equal((await push(a, replaceRenderInput))[0].reason, "image_asset_immutable");
  assert.equal((await lookup(b, deviceId, replaceRenderInput)).status, "not_found");
  assert.equal((await push(a, operation(asset("image-canvas-orphan-output", "image-render:image-canvas-orphan-render"),
    mutation("image_render", "image-canvas-orphan-render", { ...render, projectId: "missing", outputAssetId: "image-canvas-orphan-output" }))))[0].reason, "image_project_missing");
  await ok(404, "sync/entities/asset/image-canvas-orphan-output", "GET", b);
  const snapshot = await ok(200, "sync/bootstrap?afterType=entry&afterId=zzzz", "GET", b);
  assert.ok(snapshot.entities.some(entity => entity.entityType === "image_project" && entity.deletedAt !== null));
  assert.ok(snapshot.entities.some(entity => entity.entityType === "image_render" && entity.entityId === "image-canvas-render"));
  assert.deepEqual(await ok(200, "blobs/" + hash, "GET", b), png);
}
