import { id, integer, invalid, KiB, record, sha256, SyncError } from "./protocol.js";

const utf8 = new TextEncoder();
const colorPattern = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid("invalid_image_scene");
}

function number(value: unknown, minimum = -Infinity, maximum = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid("invalid_image_geometry");
  return value;
}

function color(value: unknown) {
  if (typeof value !== "string" || !colorPattern.test(value)) invalid("invalid_image_color");
}

function dimensions(width: number, height: number) {
  if (!width || !height || width > 16000 || height > 16000 || width * height > 40_000_000) invalid("invalid_image_dimensions");
}

// RFC 8785: JSON.stringify supplies ECMAScript number/string serialization;
// scene object keys are restricted to ASCII names by the schema below.
export function canonicalImageScene(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalImageScene).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonicalImageScene(object[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export async function imageSceneHash(value: unknown): Promise<string> {
  return sha256(canonicalImageScene(value));
}

/** The scene is the source of truth for references, including off-artboard layers. */
export function imageSceneAssetIds(value: unknown): string[] {
  const scene = record(value);
  keys(scene, ["schemaVersion", "artboard", "layers", "layout"]);
  if (scene.schemaVersion !== 1 || !Array.isArray(scene.layers) || scene.layers.length > 100) invalid("invalid_image_scene");
  if (utf8.encode(JSON.stringify(scene)).byteLength > 384 * KiB) throw new SyncError(413, "image_scene_too_large");
  const artboard = record(scene.artboard);
  keys(artboard, ["width", "height", "background", "cornerRadius"]);
  if (Object.hasOwn(artboard, "cornerRadius")) number(artboard.cornerRadius, 0, 8000);
  dimensions(integer(artboard.width), integer(artboard.height));
  const refs = new Set<string>();
  const background = record(artboard.background);
  switch (background.type) {
    case "transparent": keys(background, ["type"]); break;
    case "solid": keys(background, ["type", "color"]); color(background.color); break;
    case "linear-gradient": {
      keys(background, ["type", "angle", "stops"]);
      number(background.angle, -3600, 3600);
      if (!Array.isArray(background.stops) || background.stops.length < 2 || background.stops.length > 16) invalid("invalid_image_background");
      let previous = -1;
      for (const value of background.stops) {
        const stop = record(value);
        keys(stop, ["offset", "color"]);
        const offset = number(stop.offset, 0, 1);
        if (offset < previous) invalid("invalid_image_background");
        previous = offset;
        color(stop.color);
      }
      break;
    }
    case "image":
      keys(background, ["type", "assetId", "fit"]);
      refs.add(id(background.assetId));
      if (background.fit !== "cover" && background.fit !== "contain") invalid("invalid_image_background");
      break;
    default: invalid("invalid_image_background");
  }
  const layers = new Set<string>();
  for (const value of scene.layers) {
    const layer = record(value);
    keys(layer, ["id", "assetId", "x", "y", "width", "height", "rotation", "flipX", "flipY", "opacity", "crop", "cornerRadius", "shadow"]);
    const layerId = id(layer.id);
    if (layers.has(layerId)) invalid("invalid_image_layer");
    layers.add(layerId);
    refs.add(id(layer.assetId));
    for (const field of ["x", "y"]) number(layer[field], -1_000_000, 1_000_000);
    number(layer.rotation, -3600, 3600);
    number(layer.width, 0.01, 16000);
    number(layer.height, 0.01, 16000);
    number(layer.opacity, 0, 1);
    number(layer.cornerRadius, 0, 8000);
    if (typeof layer.flipX !== "boolean" || typeof layer.flipY !== "boolean") invalid("invalid_image_layer");
    const crop = record(layer.crop);
    keys(crop, ["x", "y", "width", "height"]);
    number(crop.x, 0, 16000); number(crop.y, 0, 16000);
    number(crop.width, 0.01, 16000); number(crop.height, 0.01, 16000);
    const shadow = record(layer.shadow);
    keys(shadow, ["color", "blur", "offsetX", "offsetY", "opacity"]);
    color(shadow.color);
    number(shadow.blur, 0, 1000); number(shadow.opacity, 0, 1);
    number(shadow.offsetX, -1000, 1000); number(shadow.offsetY, -1000, 1000);
  }
  const layout = record(scene.layout);
  keys(layout, ["mode", "gap", "padding", "columns", "align", "size"]);
  if (typeof layout.mode !== "string" || !["free", "horizontal", "vertical", "grid"].includes(layout.mode)
      || typeof layout.align !== "string" || !["start", "center", "end"].includes(layout.align)) invalid("invalid_image_layout");
  number(layout.gap, 0, 16000); number(layout.padding, 0, 16000); number(layout.size, 0, 16000);
  if (integer(layout.columns) < 1 || Number(layout.columns) > 100) invalid("invalid_image_layout");
  return [...refs].sort();
}

export function validateImagePayload(type: "image_project" | "image_render", payload: Record<string, unknown>) {
  const refs = imageSceneAssetIds(payload.scene);
  if (!Array.isArray(payload.assetIds) || payload.assetIds.some(value => typeof value !== "string")
      || new Set(payload.assetIds).size !== payload.assetIds.length
      || JSON.stringify(payload.assetIds) !== JSON.stringify(refs)) invalid("invalid_image_references");
  integer(payload.createdAt);
  if (type === "image_project") {
    keys(payload, ["originEntryId", "baseAssetId", "scene", "assetIds", "createdAt", "updatedAt"]);
    id(payload.originEntryId); id(payload.baseAssetId); integer(payload.updatedAt);
  } else {
    keys(payload, ["projectId", "scene", "sceneHash", "outputAssetId", "assetIds", "exportOptions", "rendererVersion", "createdAt"]);
    id(payload.projectId); id(payload.outputAssetId);
    if (typeof payload.sceneHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.sceneHash)
        || typeof payload.rendererVersion !== "string" || !payload.rendererVersion.trim() || payload.rendererVersion.length > 64) invalid("invalid_image_render");
    const options = record(payload.exportOptions);
    keys(options, ["format", "scale", "quality", "jpegBackground"]);
    if (typeof options.format !== "string" || !["png", "jpeg", "webp"].includes(options.format)
        || (options.scale !== 1 && options.scale !== 2)) invalid("invalid_image_export");
    number(options.quality, 0, 1); color(options.jpegBackground);
    const artboard = record(record(payload.scene).artboard);
    dimensions(Number(artboard.width) * options.scale, Number(artboard.height) * options.scale);
  }
}
