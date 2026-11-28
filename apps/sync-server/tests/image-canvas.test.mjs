import { test } from "node:test";
import assert from "node:assert/strict";
import { operation } from "../dist/protocol.js";
import { imageScene } from "./image-canvas-contract.mjs";
import { canonicalImageScene, imageSceneHash } from "../dist/image-canvas.js";

const project = scene => ({ originEntryId: "article", baseAssetId: "image-canvas-input", scene,
  assetIds: ["image-canvas-input"], createdAt: 1, updatedAt: 1 });
const input = payload => ({ operationId: "image-op", mutations: [{ entityType: "image_project", entityId: "project", baseRevision: 0, operation: "upsert", payload }] });

test("artboard corner radius is optional and survives the project wire format", async () => {
  const original = imageScene();
  const oldHash = await imageSceneHash(original);
  assert.deepEqual(operation(input(project(original))).mutations[0].payload.scene, original);
  assert.equal(Object.hasOwn(original.artboard, "cornerRadius"), false);
  const rounded = structuredClone(original); rounded.artboard.cornerRadius = 32.5;
  assert.equal(operation(input(project(rounded))).mutations[0].payload.scene.artboard.cornerRadius, 32.5);
  assert.notEqual(await imageSceneHash(rounded), oldHash);
  assert.equal(await imageSceneHash(original), oldHash);
  for (const radius of [-1, 8001, null, "20", true, Infinity]) {
    rounded.artboard.cornerRadius = radius;
    assert.throws(() => operation(input(project(rounded))), error => error.status === 400);
  }
});

test("image scenes derive every reference and reject local-only or oversized data", () => {
  const scene = imageScene();
  assert.deepEqual(operation(input(project(scene))).mutations[0].payload.scene, scene);
  for (const change of [
    value => { value.assetIds = []; },
    value => { value.scene.layers[0].assetId = "file:///private/image.png"; },
    value => { value.scene.layers.push({ ...value.scene.layers[0] }); },
    value => { value.scene.layers[0].x = Infinity; },
    value => { value.scene.layers[0].crop.width = 0; },
    value => { value.scene.layers[0].crop.width = 0.001; },
    value => { value.scene.layers[0].crop.y = 16001; },
    value => { value.scene.layers[0].width = 16001; },
    value => { value.scene.layers[0].x = 1000001; },
    value => { value.scene.layers[0].rotation = 3601; },
    value => { value.scene.layers[0].cornerRadius = 8001; },
    value => { value.scene.layers[0].shadow.blur = 1001; },
    value => { value.scene.layers[0].shadow.offsetX = -1001; },
    value => { value.scene.layout.mode = ["free"]; },
    value => { value.scene.layout.align = ["center"]; },
    value => { value.scene.layout.size = 16001; },
    value => { value.scene.layout.gap = 16001; },
    value => { value.scene.layout.padding = 16001; },
    value => { value.scene.artboard.background = { type: "linear-gradient", angle: 3601, stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }] }; },
    value => { value.scene.layers[0].opacity = 1.1; },
    value => { value.scene.artboard.width = 16001; },
    value => { value.scene.artboard.height = 16000; value.scene.artboard.width = 16000; },
    value => { value.scene.artboard.background = { type: "solid", color: "url(file:///private)" }; },
    value => { value.scene.viewport = { x: 0 }; },
    value => { value.scene.layers[0].url = "data:image/png;base64,private"; },
  ]) {
    const value = project(structuredClone(scene)); change(value);
    assert.throws(() => operation(input(value)), error => error.status === 400);
  }
  const background = project({ ...scene, artboard: { ...scene.artboard, background: { type: "image", assetId: "wallpaper", fit: "cover" } } });
  assert.throws(() => operation(input(background)), { code: "invalid_image_references" });
  background.assetIds.push("wallpaper");
  assert.equal(operation(input(background)).mutations[0].entityType, "image_project");
  background.assetIds.reverse();
  assert.throws(() => operation(input(background)), { code: "invalid_image_references" });
  const tooMany = imageScene();
  tooMany.layers = Array.from({ length: 101 }, (_, index) => ({ ...scene.layers[0], id: "layer-" + index }));
  assert.throws(() => operation(input(project(tooMany))), { code: "invalid_image_scene" });
  const oversized = imageScene();
  oversized.layers[0].x = 1;
  oversized.layers[0].extra = "x".repeat(384 * 1024);
  assert.throws(() => operation(input(project(oversized))), { code: "image_scene_too_large" });
});

test("image renders cannot be deleted and output scaling obeys the image capacity", () => {
  assert.throws(() => operation({ operationId: "delete", mutations: [{ entityType: "image_render", entityId: "render", baseRevision: 1, operation: "delete" }] }), { code: "invalid_operation" });
  const scene = imageScene(); scene.artboard.width = 10000;
  const render = { projectId: "project", scene, sceneHash: "a".repeat(64), outputAssetId: "output", assetIds: ["image-canvas-input"],
    exportOptions: { format: "webp", scale: 2, quality: 0.9, jpegBackground: "#fff" }, rendererVersion: "1", createdAt: 1 };
  assert.throws(() => operation({ operationId: "large", mutations: [{ entityType: "image_render", entityId: "render", baseRevision: 0, operation: "upsert", payload: render }] }), { code: "invalid_image_dimensions" });
  render.scene.artboard.width = 1;
  render.exportOptions.format = ["png"];
  assert.throws(() => operation({ operationId: "format", mutations: [{ entityType: "image_render", entityId: "render", baseRevision: 0, operation: "upsert", payload: render }] }), { code: "invalid_image_export" });
});

test("scene hashing uses RFC 8785 numbers and key order without changing scene values", async () => {
  const value = { z: [1.0, -0, 1e-7, 0.000001, 333333333.33333329, 1e30, 4.50, 2e-3, 1e-27], a: "\u000f\n" };
  const expected = '{"a":"\\u000f\\n","z":[1,0,1e-7,0.000001,333333333.3333333,1e+30,4.5,0.002,1e-27]}';
  assert.equal(canonicalImageScene(value), expected);
  assert.equal(await imageSceneHash(value), await imageSceneHash({ a: value.a, z: value.z }));
  assert.ok(Object.is(value.z[1], -0));
});
