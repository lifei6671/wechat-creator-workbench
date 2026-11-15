// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktop, type AssetRow } from "../desktop";
import { AssetPanel } from "./Assets";

it("loads small previews only near the viewport and reads the full image when selected", async () => {
  const visible = new Map<Element, () => void>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      visible.set(target, () => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const makeUrl = vi.fn().mockReturnValueOnce("blob:thumbnail").mockReturnValueOnce("blob:full");
  const revokeUrl = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: makeUrl, revokeObjectURL: revokeUrl }));
  const row: AssetRow = {
    id: "one", name: "照片.png", width: 400, height: 200, bytes: 1700,
    uploadStatus: null, uploadError: null, cleanupError: null, publicUrl: null,
  };
  vi.spyOn(desktop, "assetLibrary").mockResolvedValue({ items: [row, { ...row, id: "two", name: "图二.png" }], target: null });
  vi.spyOn(desktop, "onAssetsChanged").mockResolvedValue(() => {});
  const small = vi.spyOn(desktop, "assetThumbnail").mockResolvedValue(new ArrayBuffer(1));
  const full = vi.spyOn(desktop, "assetRead").mockResolvedValue(new ArrayBuffer(2));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><AssetPanel onImport={vi.fn()} onInsert={vi.fn()}
      onCover={vi.fn()} onConfigure={vi.fn()} canInsert={false} canCover={false} /></Theme>));
    await vi.waitFor(() => expect(visible.size).toBe(2));
    expect(small).not.toHaveBeenCalled();
    const tile = container.querySelector<HTMLButtonElement>(".asset-tile")!;
    flushSync(() => visible.get(tile.querySelector(".asset-tile-media")!)!());
    await vi.waitFor(() => expect(tile.querySelector("img")?.getAttribute("src")).toBe("blob:thumbnail"));
    expect(small).toHaveBeenCalledExactlyOnceWith("one");
    expect(full).not.toHaveBeenCalled();
    flushSync(() => tile.click());
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    await vi.waitFor(() => expect(container.querySelector(".asset-details img")?.getAttribute("src")).toBe("blob:full"));
    expect(full).toHaveBeenCalledExactlyOnceWith("asset://one");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  expect(revokeUrl.mock.calls.map(call => call[0]).sort()).toEqual(["blob:full", "blob:thumbnail"]);
});
