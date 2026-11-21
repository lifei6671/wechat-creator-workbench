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
  vi.spyOn(desktop, "assetDetail").mockImplementation(async id => id === "two" ? { ...row, id, name: "图二.png", width: 200, height: 400 } : row);
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
  vi.spyOn(desktop, "assetDetail").mockImplementation(async id => id === first.id ? first : second);
  const listeners = new Set<() => void>();
  const assetsChanged = () => listeners.forEach(callback => callback());
  vi.spyOn(desktop, "onAssetsChanged").mockImplementation(async callback => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
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
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[value="test"]')?.disabled).toBe(false), { timeout: 1600 });
    submit("test");
    await vi.waitFor(() => expect(container.querySelector('.image-storage-feedback[data-error="true"]')?.textContent).toBe("测试失败"));
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[value="save"]')?.disabled).toBe(false), { timeout: 1600 });
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


it("refreshes an off-page selection through upload failure, retry and completion without replacing its preview", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
  const revoke = vi.fn();
  let urls = 0;
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: () => `blob:asset-${++urls}`, revokeObjectURL: revoke,
  }));
  let first: AssetRow = {
    id: "uploading", name: "正在上传.png", width: 400, height: 200, bytes: 1700,
    uploadStatus: "running", uploadError: null, cleanupError: null, publicUrl: null,
  };
  const second: AssetRow = { ...first, id: "second", name: "另一页.png", uploadStatus: null };
  const target = { endpoint: "https://s3.example.test", region: "auto", bucket: "images", prefix: "", publicBase: "https://cdn.example.test" };
  const library = vi.spyOn(desktop, "assetLibrary").mockImplementation(async (page = 0) => ({
    items: [page ? second : first], target, page, hasNext: page === 0,
  }));
  const detail = vi.spyOn(desktop, "assetDetail").mockImplementation(async id => id === first.id ? first : second);
  const listeners = new Set<() => void>();
  const changed = () => flushSync(() => listeners.forEach(listener => listener()));
  vi.spyOn(desktop, "onAssetsChanged").mockImplementation(async listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  const read = vi.spyOn(desktop, "assetRead").mockResolvedValue(new ArrayBuffer(2));
  const copy = vi.spyOn(desktop, "copyText").mockResolvedValue(undefined);
  const upload = vi.spyOn(desktop, "assetUpload").mockImplementation(async () => {
    first = { ...first, uploadStatus: "retrying", uploadError: null };
    changed();
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const preview = () => container.querySelector<HTMLImageElement>(".asset-details img");
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>(".asset-controls button")]
    .find(button => button.textContent === text);
  try {
    flushSync(() => root.render(<Theme><AssetPanel onImport={vi.fn()} onInsert={vi.fn()} onCover={vi.fn()}
      onConfigure={vi.fn()} canInsert={false} canCover={false} /></Theme>));
    const tile = await vi.waitFor(() => {
      const tile = container.querySelector<HTMLButtonElement>(".asset-tile");
      expect(tile).not.toBeNull(); return tile!;
    });
    flushSync(() => tile.click());
    await vi.waitFor(() => expect(preview()?.alt).toBe(first.name));
    const image = preview();
    const details = container.querySelector(".asset-details");
    expect(button("上传")?.disabled).toBe(true);
    let finishList!: (value: AssetLibrary) => void;
    library.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
    first = { ...first, uploadStatus: "failed", uploadError: "上传连接失败" };
    changed();
    await vi.waitFor(() => expect(button("重试上传")?.disabled).toBe(false));
    flushSync(() => tile.click());
    expect(button("重试上传")?.disabled).toBe(false);
    expect(container.querySelector(".asset-details [role=alert]")?.textContent).toBe("上传连接失败");
    finishList({ items: [first], target, page: 0, hasNext: true });
    first = { ...first, uploadStatus: "running", uploadError: null };
    changed();
    await vi.waitFor(() => expect(button("上传")?.disabled).toBe(true));
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click());
    await vi.waitFor(() => expect(container.querySelector(".asset-tile")?.textContent).toBe(second.name));
    expect(library).toHaveBeenLastCalledWith(1);
    first = { ...first, uploadStatus: "failed", uploadError: "上传连接失败" };
    changed();
    await vi.waitFor(() => expect(button("重试上传")?.disabled).toBe(false));
    expect(container.querySelector(".asset-details [role=alert]")?.textContent).toBe("上传连接失败");
    expect(preview()).toBe(image);
    flushSync(() => button("重试上传")!.click());
    await vi.waitFor(() => expect(container.querySelector(".asset-dimensions")?.textContent).toContain("等待重试"));
    expect(upload).toHaveBeenCalledExactlyOnceWith(first.id);
    expect(container.querySelector<HTMLButtonElement>('.asset-controls button[data-feedback-state="success"]')?.disabled).toBe(true);
    expect(container.querySelector(".asset-details [role=alert]")).toBeNull();
    first = { ...first, uploadStatus: null, publicUrl: "https://cdn.example.test/done.png" };
    changed();
    await vi.waitFor(() => expect(button("复制图床链接")).toBeDefined());
    expect(container.querySelector(".asset-dimensions")?.textContent).toContain("图床");
    expect(container.querySelector(".asset-details")).toBe(details);
    expect(preview()).toBe(image);
    expect(read).toHaveBeenCalledExactlyOnceWith("asset://uploading");
    expect(revoke).not.toHaveBeenCalled();
    flushSync(() => button("复制图床链接")!.click());
    expect(copy).toHaveBeenCalledWith(first.publicUrl);

    let oldResult!: (row: AssetRow) => void;
    detail.mockImplementationOnce(() => new Promise(resolve => { oldResult = resolve; }));
    changed();
    first = { ...first, publicUrl: "https://cdn.example.test/newer.png" };
    changed();
    await vi.waitFor(() => expect(detail).toHaveBeenLastCalledWith(first.id));
    oldResult({ ...first, publicUrl: null, uploadStatus: "running" });
    await new Promise(resolve => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(button("复制图床链接")?.disabled).toBe(false), { timeout: 1600 });
    flushSync(() => button("复制图床链接")!.click());
    expect(copy).toHaveBeenLastCalledWith(first.publicUrl);

    let oldSelection!: (row: AssetRow) => void;
    detail.mockImplementationOnce(() => new Promise(resolve => { oldSelection = resolve; }));
    changed();
    flushSync(() => container.querySelector<HTMLButtonElement>(".asset-tile")!.click());
    await vi.waitFor(() => expect(preview()?.alt).toBe(second.name));
    oldSelection(first);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(preview()?.alt).toBe(second.name);
    expect(button("复制图床链接")).toBeUndefined();
    expect(read).toHaveBeenLastCalledWith("asset://second");
    detail.mockRejectedValueOnce(new Error("详情读取失败"));
    changed();
    await vi.waitFor(() => expect(container.querySelector(".asset-details [role=alert]")?.textContent).toBe("详情读取失败"));
    expect(preview()?.alt).toBe(second.name);
    changed();
    await vi.waitFor(() => expect(container.querySelector(".asset-details [role=alert]")).toBeNull());
    detail.mockResolvedValueOnce(null);
    changed();
    await vi.waitFor(() => expect(container.querySelector(".asset-details")).toBeNull());
  } finally {
    flushSync(() => root.unmount());
    await Promise.resolve();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  expect(listeners.size).toBe(0);
});


it("preserves an image import failure after the library refresh succeeds", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let refresh!: () => void;
  vi.spyOn(desktop, "onAssetsChanged").mockImplementation(async callback => { refresh = callback; return () => {}; });
  const read = vi.spyOn(desktop, "assetLibrary").mockResolvedValue({ items: [], page: 0, hasNext: false, target: null });
  const importImages = vi.fn().mockRejectedValue(new Error("图片无法导入，请检查文件"));
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><AssetPanel onImport={importImages} onInsert={vi.fn()} onCover={vi.fn()}
      onConfigure={vi.fn()} canInsert={false} canCover={false} /></Theme>));
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File(["image"], "sample.png", { type: "image/png" })] });
    flushSync(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("图片无法导入，请检查文件"));
    const calls = read.mock.calls.length;
    refresh();
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(calls));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("图片无法导入，请检查文件");
    expect(importImages).toHaveBeenCalledOnce();
  } finally { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
