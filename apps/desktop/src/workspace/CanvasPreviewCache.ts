import { useCallback, useSyncExternalStore } from "react";
import { desktop } from "../desktop";

type PreviewImages = Readonly<{ image?: string; incoming?: string }>;
type PreviewEntry = {
  revision: number;
  images: PreviewImages;
  listeners: Set<() => void>;
  transition?: (commit: boolean) => void;
};
const emptyImages: PreviewImages = {};

export class CanvasPreviewCache {
  private entries = new Map<string, PreviewEntry>();

  constructor(readonly collectionId: string) {}

  private id(nodeId: string, url: string) {
    return JSON.stringify([nodeId, url]);
  }

  get(nodeId: string, url: string) {
    return this.entries.get(this.id(nodeId, url))?.images ?? emptyImages;
  }

  subscribe(nodeId: string, url: string, listener: () => void) {
    const id = this.id(nodeId, url);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { revision: 0, images: emptyImages, listeners: new Set() };
      this.entries.set(id, entry);
      const initial = entry;
      void desktop.canvasPreviewCacheRead({ collectionId: this.collectionId, nodeId, url })
        .then(bytes => this.load(id, initial, 0, bytes))
        .catch(error => console.warn("读取网页预览失败", error));
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        this.entries.delete(id);
        entry.transition?.(false);
        if (entry.images.image) URL.revokeObjectURL(entry.images.image);
      }
    };
  }

  async capture(nodeId: string, url: string, bytes: ArrayBuffer, signal?: AbortSignal) {
    const id = this.id(nodeId, url);
    const entry = this.entries.get(id);
    if (!entry || !bytes.byteLength || signal?.aborted) return false;
    entry.transition?.(false);
    return this.load(id, entry, ++entry.revision, bytes, signal);
  }

  finish(nodeId: string, url: string, source: string) {
    const entry = this.entries.get(this.id(nodeId, url));
    if (entry?.images.incoming === source) entry.transition?.(true);
  }

  private async load(id: string, entry: PreviewEntry, revision: number, bytes: ArrayBuffer, signal?: AbortSignal) {
    const live = () => this.entries.get(id) === entry && entry.revision === revision && !signal?.aborted;
    if (!bytes.byteLength || !live()) return false;
    const image = new Image();
    const source = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    image.src = source;
    try {
      await image.decode();
    } catch (error) {
      if (live()) console.warn("网页预览图片无效", error);
      URL.revokeObjectURL(source);
      return false;
    }
    if (!live()) {
      URL.revokeObjectURL(source);
      return false;
    }
    const previous = entry.images.image;
    if (signal && previous && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return new Promise<boolean>(resolve => {
        const cancel = () => finish(false);
        const finish = (commit: boolean) => {
          signal.removeEventListener("abort", cancel);
          const accepted = commit && live();
          entry.transition = undefined;
          entry.images = accepted ? { image: source } : { image: previous };
          entry.listeners.forEach(listener => listener());
          URL.revokeObjectURL(accepted ? previous : source);
          resolve(accepted);
        };
        entry.transition = finish;
        signal.addEventListener("abort", cancel, { once: true });
        entry.images = { image: previous, incoming: source };
        entry.listeners.forEach(listener => listener());
      });
    }
    entry.images = { image: source };
    entry.listeners.forEach(listener => listener());
    if (previous) URL.revokeObjectURL(previous);
    return true;
  }
}

export function useCanvasPreviewImages(cache: CanvasPreviewCache, nodeId: string, url: string) {
  const subscribe = useCallback((listener: () => void) => cache.subscribe(nodeId, url, listener), [cache, nodeId, url]);
  return useSyncExternalStore(subscribe, () => cache.get(nodeId, url));
}
