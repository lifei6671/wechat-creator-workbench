import { describe, expect, it } from "vitest";
import type { ImageLayer, ImageScene } from "../../../../packages/shared-types";
import { appendImages, cropLayer, layerBounds, layoutScene, moveLayers, newImageLayer, reorderLayers, rotateSceneImage, sceneAssetIds, validateOutput, withPadding } from "./scene";

const layer = (id: string, width: number, height: number): ImageLayer => ({ ...newImageLayer({ id, url: `asset://${id}`, width, height }), id });
const scene = (layers: ImageLayer[]): ImageScene => ({ schemaVersion: 1, artboard: { width: 1000, height: 800, background: { type: "transparent" } }, layers,
  layout: { mode: "free", columns: 2, padding: 20, gap: 10, align: "center", size: 0 } });

describe("editable image layout", () => {
  it("fits selected photos without changing an unselected outside layer or crop", () => {
    const first = layer("a", 400, 200), second = layer("b", 100, 200), outside = { ...layer("c", 50, 50), x: 5000 };
    const original = scene([first, second, outside]);
    const next = layoutScene(original, ["b", "a"], "horizontal");
    expect(next.artboard).toMatchObject({ width: 550, height: 240 });
    expect(next.layers.map(value => value.x)).toEqual([20, 430, 5000]);
    expect(next.layers[2]).toBe(outside);
    expect(next.layers[0].crop).toEqual(first.crop);
    expect(original.layers[0].x).toBe(0);
  });
  it("preserves rotation and flips while aligning the visible image bounds", () => {
    const rotated = { ...layer("a", 400, 200), rotation: 90, flipX: true };
    const next = layoutScene(scene([rotated, layer("b", 100, 200)]), ["a", "b"], "vertical");
    const bounds = next.layers.map(layerBounds);
    expect(next.layers[0]).toMatchObject({ rotation: 90, flipX: true });
    expect(next.layers[0].width).toBeCloseTo(200); expect(next.layers[0].height).toBeCloseTo(100);
    expect(bounds[0].x).toBeCloseTo(20);
    expect(bounds[0].y).toBeCloseTo(20);
    expect(bounds[1].y).toBeCloseTo(230);
    expect(next.artboard.width).toBe(140);
  });
  it("uses row height for a grid and makes padding reversible through the scene value", () => {
    const arranged = layoutScene(scene([layer("a", 200, 400), layer("b", 400, 200), layer("c", 200, 200)]), ["a", "b", "c"], "grid");
    expect(arranged.artboard).toMatchObject({ width: 450, height: 650 });
    expect(arranged.layers[1].y).toBe(170);
    expect(arranged.layers[2].y).toBe(430);
    const padded = withPadding(arranged, 50);
    expect(padded.artboard).toMatchObject({ width: 510, height: 710 });
    expect(padded.layers[0].x).toBe(50);
  });
  it("maintains original coordinates when cropping rotated and flipped images", () => {
    const original = { ...layer("a", 400, 200), rotation: 90, flipX: true };
    const next = cropLayer(original, { x: 100, y: 50, width: 200, height: 100 });
    expect(next.width).toBe(200); expect(next.height).toBe(100);
    expect(next.x).toBeCloseTo(-50); expect(next.y).toBeCloseTo(100);
    expect(next.assetId).toBe(original.assetId);
  });
  it("retains selection order for stack operations and derives all dependencies", () => {
    const original = scene([layer("a", 20, 20), layer("b", 20, 20), layer("c", 20, 20)]);
    expect(reorderLayers(original, ["a", "b"], "up").layers.map(value => value.id)).toEqual(["c", "a", "b"]);
    const moved = moveLayers(original, ["a", "c"], 12, 24);
    expect(moved.layers.map(value => [value.x, value.y])).toEqual([[12, 24], [0, 0], [12, 24]]);
    expect(sceneAssetIds({ ...moved, artboard: { ...moved.artboard, background: { type: "image", assetId: "background", fit: "cover" } } })).toEqual(["a", "b", "c", "background"]);
  });
  it("counts export scaling against actual output memory and side limits", () => {
    const original = scene([layer("a", 20, 20)]);
    original.artboard = { ...original.artboard, width: 8000, height: 4000 };
    expect(() => validateOutput(original)).not.toThrow();
    expect(() => validateOutput(original, 2)).toThrow("4000 万像素");
    expect(() => layoutScene(original, ["a"], "horizontal", { size: 16000, padding: 20 })).toThrow();
  });
  it("rotates a fitted single image without clipping and preserves a custom artboard", () => {
    const original = scene([layer("a", 1000, 650)]);
    original.artboard = { width: 1000, height: 650, background: { type: "transparent" } };
    original.layout.padding = 0;
    const rotated = rotateSceneImage(original, "a", 90);
    expect(rotated.artboard).toMatchObject({ width: 650, height: 1000 });
    expect(layerBounds(rotated.layers[0]).x).toBeCloseTo(0);
    expect(layerBounds(rotated.layers[0]).y).toBeCloseTo(0);
    const custom = { ...original, artboard: { ...original.artboard, width: 1400, height: 1400 } };
    const free = rotateSceneImage(custom, "a", 90);
    expect(free.artboard).toEqual(custom.artboard);
    const before = layerBounds(original.layers[0]), after = layerBounds(free.layers[0]);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2);
  });
  it("keeps a stable layout dimension when switching repeatedly, including rotated images", () => {
    const first = layer("a", 1000, 650), second = { ...layer("b", 740, 900), rotation: 90 };
    let result = layoutScene(scene([first, second]), ["a", "b"], "horizontal");
    const horizontal = structuredClone(result);
    for (let index = 0; index < 20; index++) {
      result = layoutScene(result, ["a", "b"], "vertical");
      result = layoutScene(result, ["a", "b"], "horizontal");
    }
    expect(result.artboard).toEqual(horizontal.artboard);
    expect(result.layout.size).toBe(horizontal.layout.size);
    for (let index = 0; index < 2; index++) {
      expect(result.layers[index].width).toBeCloseTo(horizontal.layers[index].width);
      expect(result.layers[index].height).toBeCloseTo(horizontal.layers[index].height);
      expect(result.layers[index].rotation).toBe(horizontal.layers[index].rotation);
    }
  });
  it("adds oriented images outside the output and combines them with the existing selection", () => {
    const original = scene([layer("a", 1000, 650)]);
    const asset = { id: "b", url: "asset://b", width: 740, height: 900, orientation: 6 as const };
    const appended = appendImages(original, [asset], ["a"]);
    expect(appended.scene.artboard).toBe(original.artboard);
    expect(appended.scene.layers[0]).toBe(original.layers[0]);
    expect(appended.selected).toEqual(["a", appended.scene.layers[1].id]);
    const bounds = layerBounds(appended.scene.layers[1]);
    expect(bounds.x).toBeCloseTo(original.artboard.width + 80);
    expect(bounds.y).toBeCloseTo(70);
    expect(bounds.width).toBeCloseTo(720);
    expect(appended.scene.layers[1]).toMatchObject({ rotation: 90, crop: { x: 0, y: 0, width: 740, height: 900 } });
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("maps EXIF orientation %s in raw pixel coordinates", orientation => {
    const image = newImageLayer({ id: "photo", url: "asset://photo", width: 4, height: 2, orientation }, 10, 20);
    const bounds = layerBounds(image);
    expect(bounds.x).toBeCloseTo(10); expect(bounds.y).toBeCloseTo(20);
    expect(bounds.width).toBeCloseTo(orientation >= 5 ? 2 : 4);
    expect(bounds.height).toBeCloseTo(orientation >= 5 ? 4 : 2);
    expect(image.crop).toEqual({ x: 0, y: 0, width: 4, height: 2 });
    const rawTopLeft = { x: image.flipX ? image.width : 0, y: image.flipY ? image.height : 0 };
    const angle = image.rotation * Math.PI / 180;
    const x = image.x + rawTopLeft.x * Math.cos(angle) - rawTopLeft.y * Math.sin(angle) - 10;
    const y = image.y + rawTopLeft.x * Math.sin(angle) + rawTopLeft.y * Math.cos(angle) - 20;
    const expected = [[0, 0], [4, 0], [4, 2], [0, 2], [0, 0], [2, 0], [2, 4], [0, 4]][orientation - 1];
    expect(x).toBeCloseTo(expected[0]); expect(y).toBeCloseTo(expected[1]);
  });
});
