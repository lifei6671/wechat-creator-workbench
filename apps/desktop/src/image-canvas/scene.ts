import type { ImageCanvasAsset, ImageLayer, ImageScene } from "../../../../packages/shared-types";

export const MAX_LAYERS = 100;
export const MAX_SIDE = 16000;
export const MAX_PIXELS = 40_000_000;

export function validateOutput(scene: ImageScene, scale = 1) {
  const { width, height } = scene.artboard;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width * scale > MAX_SIDE || height * scale > MAX_SIDE || width * height * scale * scale > MAX_PIXELS) {
    throw new Error("输出边长不能超过 16000 px，面积不能超过 4000 万像素，请调整画板尺寸或导出倍率");
  }
  if (scene.layers.length > MAX_LAYERS) throw new Error("每个画布最多添加 100 张图片");
  if (new TextEncoder().encode(JSON.stringify(scene)).byteLength > 384 * 1024) throw new Error("画布内容超过保存上限，请减少图片数量");
}

export function orientationTransform(width: number, height: number, orientation: ImageCanvasAsset["orientation"] = 1) {
  const transform = { x: 0, y: 0, rotation: 0, flipX: false, flipY: false,
    displayWidth: orientation >= 5 ? height : width, displayHeight: orientation >= 5 ? width : height };
  switch (orientation) {
    case 2: transform.flipX = true; break;
    case 3: transform.x = width; transform.y = height; transform.rotation = 180; break;
    case 4: transform.flipY = true; break;
    case 5: transform.x = height; transform.rotation = 90; transform.flipY = true; break;
    case 6: transform.x = height; transform.rotation = 90; break;
    case 7: transform.y = width; transform.rotation = 270; transform.flipY = true; break;
    case 8: transform.y = width; transform.rotation = 270; break;
  }
  return transform;
}

export function newImageLayer(asset: ImageCanvasAsset, x = 0, y = 0): ImageLayer {
  const transform = orientationTransform(asset.width, asset.height, asset.orientation);
  return { id: crypto.randomUUID(), assetId: asset.id, x: x + transform.x, y: y + transform.y, width: asset.width, height: asset.height,
    crop: { x: 0, y: 0, width: asset.width, height: asset.height }, rotation: transform.rotation, flipX: transform.flipX, flipY: transform.flipY,
    opacity: 1, cornerRadius: 0, shadow: { color: "#1c2024", blur: 24, offsetX: 0, offsetY: 12, opacity: 0 } };
}

export function appendImages(scene: ImageScene, assets: ImageCanvasAsset[], selected: string[]) {
  if (scene.layers.length + assets.length > MAX_LAYERS) throw new Error("每个画布最多添加 100 张图片");
  let x = scene.artboard.width + 80;
  const additions = assets.map(asset => {
    const layer = newImageLayer(asset);
    const original = layerBounds(layer), ratio = Math.min(1, 720 / original.width);
    layer.width *= ratio; layer.height *= ratio;
    layer.x *= ratio; layer.y *= ratio;
    const bounds = layerBounds(layer);
    layer.x += x - bounds.x; layer.y += 70 - bounds.y;
    x += bounds.width + 48;
    return layer;
  });
  return { scene: { ...scene, layout: { ...scene.layout, mode: "free" as const }, layers: [...scene.layers, ...additions] },
    selected: [...selected.filter(id => scene.layers.some(layer => layer.id === id)), ...additions.map(layer => layer.id)] };
}

export function layerBounds(layer: ImageLayer) {
  const radians = layer.rotation * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const points = [[0, 0], [layer.width, 0], [0, layer.height], [layer.width, layer.height]]
    .map(([x, y]) => ({ x: layer.x + x * cos - y * sin, y: layer.y + x * sin + y * cos }));
  const left = Math.min(...points.map(point => point.x)), top = Math.min(...points.map(point => point.y));
  const right = Math.max(...points.map(point => point.x)), bottom = Math.max(...points.map(point => point.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function rotateLayer(layer: ImageLayer, rotation: number): ImageLayer {
  const oldAngle = layer.rotation * Math.PI / 180, newAngle = rotation * Math.PI / 180;
  const centerX = layer.x + layer.width / 2 * Math.cos(oldAngle) - layer.height / 2 * Math.sin(oldAngle);
  const centerY = layer.y + layer.width / 2 * Math.sin(oldAngle) + layer.height / 2 * Math.cos(oldAngle);
  return { ...layer, rotation, x: centerX - layer.width / 2 * Math.cos(newAngle) + layer.height / 2 * Math.sin(newAngle),
    y: centerY - layer.width / 2 * Math.sin(newAngle) - layer.height / 2 * Math.cos(newAngle) };
}

export function rotateSceneImage(scene: ImageScene, id: string, rotation: number): ImageScene {
  const original = scene.layers.find(layer => layer.id === id)!;
  const bounds = layerBounds(original), padding = scene.layout.padding;
  const fit = scene.layers.length === 1 && Math.abs(bounds.x - padding) < 0.01 && Math.abs(bounds.y - padding) < 0.01
    && Math.abs(scene.artboard.width - bounds.width - padding * 2) < 0.01 && Math.abs(scene.artboard.height - bounds.height - padding * 2) < 0.01;
  const next = { ...scene, layers: scene.layers.map(layer => layer.id === id ? rotateLayer(layer, rotation) : layer) };
  return fit ? withPadding(next, padding) : next;
}

export function selectionBounds(layers: ImageLayer[]) {
  const bounds = layers.map(layerBounds);
  const x = Math.min(...bounds.map(value => value.x)), y = Math.min(...bounds.map(value => value.y));
  return { x, y, width: Math.max(...bounds.map(value => value.x + value.width)) - x,
    height: Math.max(...bounds.map(value => value.y + value.height)) - y };
}

export function sceneAssetIds(scene: ImageScene) {
  return [...new Set([...scene.layers.map(layer => layer.assetId), ...(scene.artboard.background.type === "image" ? [scene.artboard.background.assetId] : [])])];
}

export function layoutScene(scene: ImageScene, selected: string[], mode: "horizontal" | "vertical" | "grid",
  options: Partial<ImageScene["layout"]> = {}): ImageScene {
  const ids = new Set(selected);
  const layers = scene.layers.filter(layer => ids.has(layer.id));
  if (!layers.length) return scene;
  const layout = { ...scene.layout, ...options, mode };
  const { gap, padding, align } = layout;
  const size = options.size ?? (layout.size > 0 ? layout.size : Math.min(...layers.map(layer => mode === "horizontal" ? layerBounds(layer).height : layerBounds(layer).width)));
  layout.size = size;
  const columns = mode === "horizontal" ? layers.length : mode === "vertical" ? 1 : Math.min(layout.columns, layers.length);
  const scaled = layers.map(layer => {
    const bounds = layerBounds(layer);
    const ratio = size / (mode === "horizontal" ? bounds.height : bounds.width);
    return { ...layer, width: layer.width * ratio, height: layer.height * ratio };
  });
  const rows: ImageLayer[][] = [];
  for (let index = 0; index < scaled.length; index += columns) rows.push(scaled.slice(index, index + columns));
  let y = padding, boardWidth = 0;
  for (const row of rows) {
    let x = padding;
    const rowHeight = Math.max(...row.map(layer => layerBounds(layer).height));
    for (const layer of row) {
      const bounds = layerBounds({ ...layer, x: 0, y: 0 });
      layer.x = x - bounds.x;
      layer.y = y - bounds.y + (rowHeight - bounds.height) * (align === "center" ? 0.5 : align === "end" ? 1 : 0);
      x += bounds.width + gap;
    }
    boardWidth = Math.max(boardWidth, x - gap + padding);
    y += rowHeight + gap;
  }
  const replacements = new Map(scaled.map(layer => [layer.id, layer]));
  const result = { ...scene, layout, layers: scene.layers.map(layer => replacements.get(layer.id) ?? layer),
    artboard: { ...scene.artboard, width: Math.ceil(boardWidth - 1e-8), height: Math.ceil(y - gap + padding - 1e-8) } };
  validateOutput(result);
  return result;
}

export function withPadding(scene: ImageScene, padding: number): ImageScene {
  if (!scene.layers.length) return { ...scene, layout: { ...scene.layout, padding } };
  const bounds = selectionBounds(scene.layers);
  const dx = padding - bounds.x, dy = padding - bounds.y;
  const next = { ...scene, layout: { ...scene.layout, padding }, layers: scene.layers.map(layer => ({ ...layer, x: layer.x + dx, y: layer.y + dy })),
    artboard: { ...scene.artboard, width: Math.ceil(bounds.width + padding * 2 - 1e-8), height: Math.ceil(bounds.height + padding * 2 - 1e-8) } };
  validateOutput(next);
  return next;
}

export function moveLayers(scene: ImageScene, selected: string[], dx: number, dy: number): ImageScene {
  const ids = new Set(selected);
  return { ...scene, layout: { ...scene.layout, mode: "free" }, layers: scene.layers.map(layer => ids.has(layer.id) ? { ...layer, x: layer.x + dx, y: layer.y + dy } : layer) };
}

export function reorderLayers(scene: ImageScene, selected: string[], direction: "up" | "down" | "front" | "back"): ImageScene {
  const ids = new Set(selected);
  const layers = [...scene.layers];
  if (direction === "front") return { ...scene, layers: [...layers.filter(layer => !ids.has(layer.id)), ...layers.filter(layer => ids.has(layer.id))] };
  if (direction === "back") return { ...scene, layers: [...layers.filter(layer => ids.has(layer.id)), ...layers.filter(layer => !ids.has(layer.id))] };
  if (direction === "up") {
    for (let index = layers.length - 2; index >= 0; index--) if (ids.has(layers[index].id) && !ids.has(layers[index + 1].id)) [layers[index], layers[index + 1]] = [layers[index + 1], layers[index]];
  } else {
    for (let index = 1; index < layers.length; index++) if (ids.has(layers[index].id) && !ids.has(layers[index - 1].id)) [layers[index], layers[index - 1]] = [layers[index - 1], layers[index]];
  }
  return { ...scene, layers };
}

export function cropLayer(layer: ImageLayer, crop: ImageLayer["crop"]): ImageLayer {
  const sx = layer.width / layer.crop.width, sy = layer.height / layer.crop.height;
  const localX = layer.flipX ? (layer.crop.x + layer.crop.width - crop.x - crop.width) * sx : (crop.x - layer.crop.x) * sx;
  const localY = layer.flipY ? (layer.crop.y + layer.crop.height - crop.y - crop.height) * sy : (crop.y - layer.crop.y) * sy;
  const radians = layer.rotation * Math.PI / 180;
  return { ...layer, crop, x: layer.x + localX * Math.cos(radians) - localY * Math.sin(radians),
    y: layer.y + localX * Math.sin(radians) + localY * Math.cos(radians), width: crop.width * sx, height: crop.height * sy };
}
