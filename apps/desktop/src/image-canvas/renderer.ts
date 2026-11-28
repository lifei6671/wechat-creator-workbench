import Konva from "konva";
import type { ImageCanvasAsset, ImageExportOptions, ImageLayer, ImageScene } from "../../../../packages/shared-types";
import { layerBounds, newImageLayer, orientationTransform, sceneAssetIds, validateOutput } from "./scene";

export interface ImageResource { image: ImageBitmap; width: number; height: number; orientation: NonNullable<ImageCanvasAsset["orientation"]>; dispose(): void }

export function artboardRadius(scene: ImageScene) {
  return Math.min(scene.artboard.cornerRadius ?? 0, scene.artboard.width / 2, scene.artboard.height / 2);
}

export async function decodeResource(bytes: ArrayBuffer, maxSize?: number | ((width: number, height: number) => number), orientation: NonNullable<ImageCanvasAsset["orientation"]> = 1,
  intrinsic?: { width: number; height: number }): Promise<ImageResource> {
  const blob = new Blob([bytes]);
  if (intrinsic) {
    const { width, height } = intrinsic;
    const target = typeof maxSize === "function" ? maxSize(width, height) : maxSize;
    const ratio = target ? Math.min(1, target / Math.max(width, height)) : 1;
    const image = await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(width * ratio)), resizeHeight: Math.max(1, Math.round(height * ratio)), resizeQuality: "high" });
    return { image, width, height, orientation, dispose: () => image.close() };
  }
  const original = await createImageBitmap(blob);
  const { width, height } = original;
  const targetSize = typeof maxSize === "function" ? maxSize(width, height) : maxSize;
  if (targetSize && Math.max(width, height) > targetSize) {
    try {
      const ratio = targetSize / Math.max(width, height);
      const image = await createImageBitmap(original, { resizeWidth: Math.max(1, Math.round(width * ratio)),
        resizeHeight: Math.max(1, Math.round(height * ratio)), resizeQuality: "high" });
      return { image, width, height, orientation, dispose: () => image.close() };
    } finally { original.close(); }
  }
  return { image: original, width, height, orientation, dispose: () => original.close() };
}

function requireImage(resources: Map<string, ImageResource>, id: string) {
  const image = resources.get(id);
  if (!image) throw new Error(`图片素材尚未载入：${id}`);
  return image;
}

export function imageNode(layer: ImageLayer, resource: ImageResource): Konva.Group {
  const { image, width, height } = resource;
  const sx = image.width / width, sy = image.height / height;
  const group = new Konva.Group({ id: layer.id, name: "image-layer", x: layer.x, y: layer.y,
    width: layer.width, height: layer.height, rotation: layer.rotation, opacity: layer.opacity });
  group.add(new Konva.Image({ image, width: layer.width, height: layer.height, cornerRadius: layer.cornerRadius,
    x: layer.flipX ? layer.width : 0, y: layer.flipY ? layer.height : 0,
    scaleX: layer.flipX ? -1 : 1, scaleY: layer.flipY ? -1 : 1,
    crop: { x: layer.crop.x * sx, y: layer.crop.y * sy, width: layer.crop.width * sx, height: layer.crop.height * sy },
    shadowColor: layer.shadow.color, shadowBlur: layer.shadow.blur, shadowOpacity: layer.shadow.opacity,
    shadowOffsetX: layer.shadow.offsetX * (layer.flipX ? -1 : 1), shadowOffsetY: layer.shadow.offsetY * (layer.flipY ? -1 : 1) }));
  return group;
}

export function backgroundNode(scene: ImageScene, resources: Map<string, ImageResource>): Konva.Shape | Konva.Group {
  const { width, height, background } = scene.artboard;
  if (background.type === "image") {
    const resource = requireImage(resources, background.assetId);
    const { displayWidth, displayHeight } = orientationTransform(resource.width, resource.height, resource.orientation);
    const factor = background.fit === "cover" ? Math.max(width / displayWidth, height / displayHeight) : Math.min(width / displayWidth, height / displayHeight);
    const group = new Konva.Group({ clipFunc(context) {
      context.beginPath();
      context.roundRect(0, 0, width, height, artboardRadius(scene));
      context.closePath();
    }, listening: false });
    const placed = new Konva.Group({ x: (width - displayWidth * factor) / 2, y: (height - displayHeight * factor) / 2, scaleX: factor, scaleY: factor });
    placed.add(imageNode(newImageLayer({ id: background.assetId, url: `asset://${background.assetId}`, width: resource.width,
      height: resource.height, orientation: resource.orientation }), resource));
    group.add(placed);
    return group;
  }
  const rectangle = new Konva.Rect({ width, height, cornerRadius: artboardRadius(scene), listening: false });
  if (background.type === "solid") rectangle.fill(background.color);
  if (background.type === "linear-gradient") {
    const radians = (background.angle - 90) * Math.PI / 180;
    const dx = Math.cos(radians), dy = Math.sin(radians);
    const distance = Math.abs(width * dx) / 2 + Math.abs(height * dy) / 2;
    rectangle.fillLinearGradientStartPoint({ x: width / 2 - dx * distance, y: height / 2 - dy * distance });
    rectangle.fillLinearGradientEndPoint({ x: width / 2 + dx * distance, y: height / 2 + dy * distance });
    rectangle.fillLinearGradientColorStops(background.stops.flatMap(stop => [stop.offset, stop.color]));
  }
  return rectangle;
}

/** Shared by the workspace and exported output; UI controls never enter this tree. */
export function buildScene(scene: ImageScene, resources: Map<string, ImageResource>, clip: boolean): Konva.Group {
  const group = new Konva.Group();
  group.add(backgroundNode(scene, resources));
  const images = new Konva.Group(clip ? { clipFunc(context) {
    context.beginPath();
    context.roundRect(0, 0, scene.artboard.width, scene.artboard.height, artboardRadius(scene));
    context.closePath();
  } } : {});
  for (const layer of scene.layers) images.add(imageNode(layer, requireImage(resources, layer.assetId)));
  group.add(images);
  return group;
}

export function outputLayers(scene: ImageScene): ImageLayer[] {
  return scene.layers.filter(layer => {
    if (!layer.opacity) return false;
    const bounds = layerBounds(layer);
    const margin = layer.shadow.opacity ? layer.shadow.blur * 3 + Math.max(Math.abs(layer.shadow.offsetX), Math.abs(layer.shadow.offsetY)) : 0;
    return bounds.x - margin < scene.artboard.width && bounds.x + bounds.width + margin > 0
      && bounds.y - margin < scene.artboard.height && bounds.y + bounds.height + margin > 0;
  });
}

export function outputDecodeSize(scene: ImageScene, assetId: string, width: number, height: number, scale: number, orientation: ImageCanvasAsset["orientation"] = 1): number {
  let ratio = Math.max(0, ...scene.layers.filter(layer => layer.assetId === assetId)
    .map(layer => Math.max(layer.width / layer.crop.width, layer.height / layer.crop.height) * scale));
  const { artboard } = scene;
  if (artboard.background.type === "image" && artboard.background.assetId === assetId) {
    const { displayWidth, displayHeight } = orientationTransform(width, height, orientation);
    const fit = artboard.background.fit === "cover" ? Math.max(artboard.width / displayWidth, artboard.height / displayHeight) : Math.min(artboard.width / displayWidth, artboard.height / displayHeight);
    ratio = Math.max(ratio, fit * scale);
  }
  return Math.max(1, Math.ceil(Math.max(width, height) * Math.min(1, ratio)));
}

export async function renderScene(scene: ImageScene, options: ImageExportOptions, read: (id: string) => Promise<ArrayBuffer>, info: (id: string) => Promise<ImageCanvasAsset>): Promise<Uint8Array> {
  validateOutput(scene, options.scale);
  const visibleScene = { ...scene, layers: outputLayers(scene) };
  const resources = new Map<string, ImageResource>();
  const output = new Konva.Group();
  let canvas: HTMLCanvasElement | undefined;
  try {
    // Decode one source at a time, retaining only the pixels required by this output.
    for (const id of sceneAssetIds(visibleScene)) {
      const [bytes, asset] = await Promise.all([read(id), info(id)]);
      resources.set(id, await decodeResource(bytes, (width, height) => outputDecodeSize(visibleScene, id, width, height, options.scale, asset.orientation), asset.orientation ?? 1, asset));
    }
    if (options.format === "jpeg") output.add(new Konva.Rect({ width: scene.artboard.width, height: scene.artboard.height, fill: options.jpegBackground }));
    output.add(buildScene(visibleScene, resources, true));
    const mimeType = `image/${options.format}`;
    canvas = output.toCanvas({ x: 0, y: 0, width: scene.artboard.width, height: scene.artboard.height, pixelRatio: options.scale });
    const blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, mimeType, options.quality));
    if (!blob || blob.type !== mimeType) throw new Error(`当前系统无法编码 ${options.format.toUpperCase()}，请选择其他格式`);
    if (blob.size > 20 * 1024 * 1024) throw new Error("生成的图片超过 20 MB，请调整画板尺寸或导出倍率");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    output.destroy();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    for (const resource of resources.values()) resource.dispose();
  }
}
