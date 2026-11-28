export type ImageBackground =
  | { type: "transparent" }
  | { type: "solid"; color: string }
  | { type: "linear-gradient"; angle: number; stops: { offset: number; color: string }[] }
  | { type: "image"; assetId: string; fit: "cover" | "contain" };

export interface ImageLayer {
  id: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  crop: { x: number; y: number; width: number; height: number };
  cornerRadius: number;
  shadow: { color: string; blur: number; offsetX: number; offsetY: number; opacity: number };
}

export interface ImageScene {
  schemaVersion: 1;
  artboard: { width: number; height: number; background: ImageBackground; cornerRadius?: number };
  layers: ImageLayer[];
  layout: {
    mode: "free" | "horizontal" | "vertical" | "grid";
    gap: number;
    padding: number;
    columns: number;
    align: "start" | "center" | "end";
    size: number;
  };
}

export interface ImageProject {
  id: string;
  originEntryId: string;
  baseAssetId: string;
  scene: ImageScene;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  animatedInput?: boolean;
}

export interface ImageExportOptions {
  format: "png" | "jpeg" | "webp";
  scale: 1 | 2;
  quality: number;
  jpegBackground: string;
}

export interface ImageCanvasAsset { id: string; url: string; width: number; height: number; name?: string; animated?: boolean; orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 }
export interface PreparedImageRender { renderId: string; outputAssetId: string; src: string }
export interface ImageRenderResult extends PreparedImageRender { entryVersion?: number }
