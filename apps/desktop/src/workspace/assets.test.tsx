// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktop, type AssetLibrary, type AssetRow } from "../desktop";
import { AssetPanel, ImageStorageSettings } from "./Assets";

it("loads tiles near the viewport and keeps the selected thumbnail visible until its original decodes", async () => {
  const visible = new Map<Element, () => void>();
  const decode = new Map<string, () => void>();
  vi.stubGlobal("Image", class {
    src = "";
    decode() { return new Promise<void>(resolve => decode.set(this.src, resolve)); }
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      visible.set(target, () => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    disconnect() {}
  });
  let resizeMasonry!: (width: number) => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.classList.contains("asset-masonry")) {
        resizeMasonry = width => this.callback([{ contentRect: new DOMRect(0, 0, width, 0), target } as ResizeObserverEntry],
          this as unknown as ResizeObserver);
      }
    }
    disconnect() {}
  });
  const makeUrl = vi.fn().mockReturnValueOnce("blob:thumb-one").mockReturnValueOnce("blob:thumb-two")
    .mockReturnValueOnce("blob:full-one").mockReturnValueOnce("blob:full-two");
  const revokeUrl = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: makeUrl, revokeObjectURL: revokeUrl }));
  const row: AssetRow = {
    id: "one", name: "照片.png", width: 400, height: 200, bytes: 1700,
    uploadStatus: null, uploadError: null, cleanupError: null, publicUrl: "https://cdn.example.test/one.png",
  };
  const library = vi.spyOn(desktop, "assetLibrary").mockImplementation(async (page = 0) => ({
    items: page ? [{ ...row, id: "three", name: "图三.png" }] : [
      row, { ...row, id: "two", name: "图二.png", width: 200, height: 400 }, { ...row, id: "four", name: "图四.png" },
    ],
    target: null, page, hasNext: page === 0,
  }));
  vi.spyOn(desktop, "onAssetsChanged").mockResolvedValue(() => {});
  const small = vi.spyOn(desktop, "assetThumbnail").mockResolvedValue(new ArrayBuffer(1));
  const full = vi.spyOn(desktop, "assetRead").mockResolvedValue(new ArrayBuffer(2));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><AssetPanel onImport={vi.fn()} onInsert={vi.fn()}
      onCover={vi.fn()} onConfigure={vi.fn()} canInsert={false} canCover={false} /></Theme>));
    await vi.waitFor(() => expect(visible.size).toBe(3));
    expect(small).not.toHaveBeenCalled();
    flushSync(() => resizeMasonry(148));
    const tiles = container.querySelectorAll<HTMLButtonElement>(".asset-tile");
    const mediaHeights = () => Array.from(tiles, tile => tile.querySelector<HTMLElement>(".asset-tile-media")?.style.height);
    const coordinates = () => Array.from(tiles, tile => [tile.style.insetInlineStart, tile.style.insetBlockStart]);
    expect(mediaHeights()).toEqual(["32px", "128px", "32px"]);
    expect(coordinates()).toEqual([["0px", "0px"], ["76px", "0px"], ["0px", "64px"]]);
    const seeTile = (tile: HTMLButtonElement) => flushSync(() => visible.get(tile.querySelector(".asset-tile-media")!)!());
    seeTile(tiles[0]);
    await vi.waitFor(() => expect(tiles[0].querySelector("img")?.getAttribute("src")).toBe("blob:thumb-one"));
    expect(small).toHaveBeenCalledExactlyOnceWith("one");
    seeTile(tiles[1]);
    await vi.waitFor(() => expect(tiles[1].querySelector("img")?.getAttribute("src")).toBe("blob:thumb-two"));
    expect(mediaHeights()).toEqual(["32px", "128px", "32px"]);
    expect(coordinates()).toEqual([["0px", "0px"], ["76px", "0px"], ["0px", "64px"]]);
    flushSync(() => resizeMasonry(0));
    expect(coordinates()).toEqual([["0px", "0px"], ["76px", "0px"], ["0px", "64px"]]);
    const grid = container.querySelector(".asset-masonry")!;
    expect(grid.hasAttribute("data-large")).toBe(false);
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="切换为大缩略图"]')!.click());
    expect(grid.getAttribute("data-large")).toBe("true");
    expect(localStorage.getItem("asset-large-tiles")).toBe("true");
    expect(grid.querySelector(".asset-tile")).toBe(tiles[0]);
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="切换为小缩略图"]')!.click());
    expect(grid.hasAttribute("data-large")).toBe(false);
    expect(full).not.toHaveBeenCalled();
    const scroll = container.querySelector<HTMLDivElement>(".asset-scroll")!;
    scroll.scrollTop = 120;
    const preview = () => container.querySelector(".asset-details img");
    flushSync(() => tiles[0].click());
    expect(tiles[0].getAttribute("aria-pressed")).toBe("true");
    expect(preview()?.getAttribute("src")).toBe("blob:thumb-one");
    await vi.waitFor(() => expect(decode.has("blob:full-one")).toBe(true));
    expect(full).toHaveBeenCalledExactlyOnceWith("asset://one");
    expect(container.querySelector(".asset-dimensions")?.textContent).toContain("图床");
    flushSync(() => tiles[1].click());
    expect(tiles[1].getAttribute("aria-pressed")).toBe("true");
    expect(preview()?.getAttribute("src")).toBe("blob:thumb-two");
    expect(preview()?.getAttribute("alt")).toBe("图二.png");
    expect(scroll.scrollTop).toBe(120);
    expect(container.querySelectorAll(".asset-tile")[1]).toBe(tiles[1]);
    await vi.waitFor(() => expect(decode.has("blob:full-two")).toBe(true));
    await Promise.resolve(decode.get("blob:full-one")!());
    expect(preview()?.getAttribute("src")).toBe("blob:thumb-two");
    decode.get("blob:full-two")!();
    await vi.waitFor(() => expect(preview()?.getAttribute("src")).toBe("blob:full-two"));
    expect(full.mock.calls).toEqual([["asset://one"], ["asset://two"]]);
    expect(small.mock.calls).toEqual([["one"], ["two"]]);
    full.mockRejectedValueOnce(new Error("图片缺失"));
    flushSync(() => tiles[0].click());
    expect(preview()?.getAttribute("src")).toBe("blob:thumb-one");
    await vi.waitFor(() => expect(container.querySelector(".asset-placeholder")?.textContent).toBe("图片缺失"));
    const previous = () => container.querySelector<HTMLButtonElement>('[aria-label="上一页"]')!;
    const next = () => container.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!;
    expect(previous().disabled).toBe(true);
    flushSync(() => next().click());
    await vi.waitFor(() => expect(container.querySelector(".asset-masonry")?.textContent).toBe("图三.png"));
    expect(library).toHaveBeenCalledWith(1);
    expect(next().disabled).toBe(true);
    expect(container.querySelector(".asset-details")).not.toBeNull();
    expect(container.querySelector(".asset-placeholder")?.textContent).toBe("图片缺失");
    flushSync(() => previous().click());
    await vi.waitFor(() => expect(container.querySelector(".asset-masonry")?.textContent).toContain("图二.png"));
    expect(library).toHaveBeenLastCalledWith(0);
    expect(container.querySelector('.asset-tile[aria-pressed="true"]')?.textContent).toBe("照片.png");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.removeItem("asset-large-tiles");
  }
  expect(revokeUrl.mock.calls.map(call => call[0]).sort()).toEqual(["blob:full-one", "blob:full-two", "blob:thumb-one", "blob:thumb-two"]);
});

it("keeps the selected preview and its actions mounted while paging, then switches when another asset is selected", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
  let url = 0;
  const revokeUrl = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: () => `blob:preview-${++url}`, revokeObjectURL: revokeUrl,
  }));
  let first: AssetRow = {
    id: "first", name: "第一页.png", width: 400, height: 200, bytes: 1700,
    uploadStatus: null, uploadError: null, cleanupError: null, publicUrl: null,
  };
  const second = { ...first, id: "second", name: "第二页.png" };
  let finishPage!: (value: AssetLibrary) => void;
  const nextPage = new Promise<AssetLibrary>(resolve => { finishPage = resolve; });
  vi.spyOn(desktop, "assetLibrary").mockImplementation((page = 0) => page ? nextPage
    : Promise.resolve({ items: [first], target: null, page: 0, hasNext: true }));
  let assetsChanged!: () => void;
  vi.spyOn(desktop, "onAssetsChanged").mockImplementation(async callback => {
    assetsChanged = callback;
    return () => {};
  });
  const read = vi.spyOn(desktop, "assetRead").mockResolvedValue(new ArrayBuffer(2));
  const insert = vi.fn();
  const cover = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tile = () => container.querySelector<HTMLButtonElement>(".asset-tile")!;
  const preview = () => container.querySelector<HTMLImageElement>(".asset-details img");
  const turn = (label: string) => flushSync(() => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  try {
    flushSync(() => root.render(<Theme><AssetPanel onImport={vi.fn()} onInsert={insert}
      onCover={cover} onConfigure={vi.fn()} canInsert canCover /></Theme>));
    await vi.waitFor(() => expect(tile()?.textContent).toBe(first.name));
    flushSync(() => tile().click());
    await vi.waitFor(() => expect(preview()?.alt).toBe(first.name));
    const image = preview()!;
    const details = container.querySelector(".asset-details");
    const src = image.getAttribute("src");
    first = { ...first, width: 800 };
    assetsChanged();
    await vi.waitFor(() => expect(container.querySelector(".asset-dimensions")?.textContent).toContain("800 × 200"));
    turn("下一页");
    expect(container.querySelector(".asset-details")).toBe(details);
    expect(preview()).toBe(image);
    finishPage({ items: [second], target: null, page: 1, hasNext: false });
    await vi.waitFor(() => expect(tile().textContent).toBe(second.name));
    expect(container.querySelector(".asset-details")).toBe(details);
    expect(preview()).toBe(image);
    expect(preview()?.getAttribute("src")).toBe(src);
    expect(container.querySelector(".asset-dimensions")?.textContent).toContain("800 × 200");
    expect(revokeUrl).not.toHaveBeenCalledWith(src);
    expect(read).toHaveBeenCalledExactlyOnceWith("asset://first");
    flushSync(() => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "插入正文")!.click());
    expect(insert).toHaveBeenCalledExactlyOnceWith(first.id, first.name);
    flushSync(() => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "设为封面")!.click());
    expect(cover).toHaveBeenCalledExactlyOnceWith(first.id);
    flushSync(() => tile().click());
    await vi.waitFor(() => expect(preview()?.alt).toBe(second.name));
    expect(read).toHaveBeenLastCalledWith("asset://second");
    expect(revokeUrl).toHaveBeenCalledWith(src);
    const secondImage = preview();
    turn("上一页");
    await vi.waitFor(() => expect(tile().textContent).toBe(first.name));
    expect(preview()).toBe(secondImage);
    expect(preview()?.alt).toBe(second.name);
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    turn("下一页");
    await vi.waitFor(() => expect(tile().textContent).toBe(second.name));
    expect(tile().getAttribute("aria-pressed")).toBe("true");
    expect(preview()).toBe(secondImage);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("edits saved S3 credentials in place and disables hosting without clearing fields", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const target = { endpoint: "https://s3.example.test", region: "auto", bucket: "images", prefix: "photos", publicBase: "https://cdn.example.test" };
  const secret = { accessKey: "test-access", secretKey: "test-secret" };
  vi.spyOn(desktop, "imageStorageSettings").mockResolvedValue({ target, secret, enabled: true, options: { filenameTemplate: "", quality: "standard", autoUpload: false } });
  const test = vi.spyOn(desktop, "imageStorageTest").mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("测试失败"));
  const save = vi.spyOn(desktop, "imageStorageSave").mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><ImageStorageSettings track={job => job} /></Theme>));
    const access = await vi.waitFor(() => {
      const input = container.querySelector<HTMLInputElement>("#images-access");
      expect(input?.value).toBe(secret.accessKey);
      return input!;
    });
    expect(container.querySelector<HTMLInputElement>("#images-secret")?.type).toBe("password");
    expect(container.querySelector<HTMLInputElement>("#images-secret")?.value).toBe(secret.secretKey);
    expect(container.querySelector("output")?.textContent).toMatch(/\.webp$/);
    const submit = (value: string) => flushSync(() => container.querySelector<HTMLButtonElement>(`button[value="${value}"]`)!.click());
    submit("test");
    await vi.waitFor(() => expect(container.querySelector('button[value="test"]')?.textContent).toBe("测试通过"));
    expect(container.querySelector(".image-storage-feedback")?.textContent).toBe("");
    expect(test).toHaveBeenLastCalledWith(target, secret);
    const automatic = container.querySelector<HTMLButtonElement>("#image-auto-upload")!;
    expect(automatic.getAttribute("aria-checked")).toBe("false");
    flushSync(() => automatic.click());
    submit("save");
    await vi.waitFor(() => expect(container.querySelector('button[value="save"]')?.textContent).toBe("已保存"));
    expect(container.querySelector(".image-storage-feedback")?.textContent).toBe("");
    expect(save).toHaveBeenLastCalledWith(target, secret, { filenameTemplate: "", quality: "standard", autoUpload: true });
    submit("test");
    await vi.waitFor(() => expect(container.querySelector('.image-storage-feedback[data-error="true"]')?.textContent).toBe("测试失败"));
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    submit("save");
    await vi.waitFor(() => expect(container.querySelector('button[value="save"]')?.textContent).toBe("已保存"));
    expect(container.querySelector(".image-storage-feedback")?.textContent).toBe("");
    expect(save).toHaveBeenLastCalledWith(null, undefined, undefined);
    expect(container.querySelector("#images-access")).toBe(access);
    expect(access.value).toBe(secret.accessKey);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
