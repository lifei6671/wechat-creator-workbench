import { describe, expect, it } from "vitest";
import type { ImageScene } from "../../../../packages/shared-types";
import { newImageLayer } from "./scene";
import { artboardRadius, outputDecodeSize, outputLayers } from "./renderer";

function scene(): ImageScene {
  const image = newImageLayer({ id: "photo", url: "asset://photo", width: 8000, height: 5000 });
  return { schemaVersion: 1, artboard: { width: 1000, height: 1000, background: { type: "transparent" } },
    layers: [{ ...image, width: 200, height: 125 }], layout: { mode: "free", gap: 0, padding: 0, columns: 2, align: "center", size: 0 } };
}

describe("output resource budget", () => {
  it("keeps old artboards square and clamps the outer radius to the shorter side", () => {
    const original = scene();
    expect(artboardRadius(original)).toBe(0);
    original.artboard.cornerRadius = 64;
    expect(artboardRadius(original)).toBe(64);
    original.artboard.height = 20;
    expect(artboardRadius(original)).toBe(10);
    expect(original.artboard.cornerRadius).toBe(64);
  });
  it("keeps only output-intersecting layers while accounting for visible shadows", () => {
    const original = scene(), first = original.layers[0];
    original.layers.push({ ...first, id: "outside", x: 2000 });
    original.layers.push({ ...first, id: "shadow", x: 1010, shadow: { ...first.shadow, opacity: 0.5, blur: 20 } });
    original.layers.push({ ...first, id: "invisible", opacity: 0 });
    expect(outputLayers(original).map(layer => layer.id)).toEqual([first.id, "shadow"]);
    expect(original.layers).toHaveLength(4);
  });
  it("decodes thumbnail collages at their actual output resolution, including 2x and crop magnification", () => {
    const original = scene();
    expect(outputDecodeSize(original, "photo", 8000, 5000, 1)).toBe(200);
    expect(outputDecodeSize(original, "photo", 8000, 5000, 2)).toBe(400);
    original.layers[0].crop = { x: 0, y: 0, width: 4000, height: 2500 };
    expect(outputDecodeSize(original, "photo", 8000, 5000, 2)).toBe(800);
    original.artboard.background = { type: "image", assetId: "photo", fit: "cover" };
    expect(outputDecodeSize(original, "photo", 8000, 5000, 2)).toBe(3200);
  });
});
