// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktop, type AssetRow } from "../desktop";
import { AssetPanel, ImageStorageSettings } from "./Assets";

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

it("edits saved S3 credentials in place and disables hosting without clearing fields", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const target = { endpoint: "https://s3.example.test", region: "auto", bucket: "images", prefix: "photos", publicBase: "https://cdn.example.test" };
  const secret = { accessKey: "test-access", secretKey: "test-secret" };
  vi.spyOn(desktop, "imageStorageSettings").mockResolvedValue({ target, secret, enabled: true, options: { filenameTemplate: "", quality: "standard" } });
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
    await vi.waitFor(() => expect(container.querySelector('.image-storage-feedback[data-error="false"]')?.textContent).toBe("上传、读取和删除均通过"));
    expect(test).toHaveBeenLastCalledWith(target, secret);
    submit("test");
    await vi.waitFor(() => expect(container.querySelector('.image-storage-feedback[data-error="true"]')?.textContent).toBe("测试失败"));
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    submit("save");
    await vi.waitFor(() => expect(container.querySelector('.image-storage-feedback[data-error="false"]')?.textContent).toBe("图床已停用"));
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
