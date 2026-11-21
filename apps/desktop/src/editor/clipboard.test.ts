// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { desktop } from "../desktop";
import { attachClipboard, writeClipboard } from "./clipboard";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
  ["image/jpeg", [255, 216, 255, 224]],
  ["image/gif", [71, 73, 70, 56, 57, 97]],
  ["image/webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
] as const)("copies local %s images as portable HTML while preserving their internal source", async (type, bytes) => {
  const read = vi.spyOn(desktop, "assetRead").mockResolvedValue(Uint8Array.from(bytes).buffer);
  const copy = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  await writeClipboard("图文", '<p><strong>图文</strong><span data-workbench-src="asset://photo" data-workbench-alt="原图" title="注释">原图</span>'
    + '<span data-workbench-src="asset://photo" data-workbench-alt="重复">重复</span><span data-workbench-src="https://example.com/photo.png" data-workbench-alt="外链">外链</span></p>');
  expect(read).toHaveBeenCalledExactlyOnceWith("asset://photo");
  const [html, text] = copy.mock.lastCall!;
  const content = document.createElement("div");
  content.innerHTML = html;
  const images = [...content.querySelectorAll("img")];
  const data = `data:${type};base64,${btoa(String.fromCharCode(...bytes))}`;
  expect(images.map(image => image.getAttribute("src"))).toEqual([data, data, "https://example.com/photo.png"]);
  expect(images[0].dataset.workbenchSrc).toBe("asset://photo");
  expect(images[0].alt).toBe("原图");
  expect(images[0].title).toBe("注释");
  expect(content.querySelector("strong")?.textContent).toBe("图文");
  expect(content.querySelector("span[data-workbench-src]")).toBeNull();
  expect(text).toBe("图文");
});

it("embeds rendered blob images in copied rich selections", async () => {
  const blob = new Blob(["image bytes"], { type: "image/png" });
  const fetchImage = vi.fn().mockResolvedValue({ blob: async () => blob });
  vi.stubGlobal("fetch", fetchImage);
  const copy = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  await writeClipboard("预览", '<img src="blob:preview" alt="预览">');
  expect(fetchImage).toHaveBeenCalledWith("blob:preview");
  expect(copy.mock.lastCall![0]).toContain(`src="data:image/png;base64,${btoa("image bytes")}"`);
});

it("reports image preparation failure without writing a degraded clipboard payload", async () => {
  const error = new Error("素材不可用");
  vi.spyOn(desktop, "assetRead").mockRejectedValue(error);
  const copy = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  await expect(writeClipboard("图片", '<span data-workbench-src="asset://missing">图片</span>')).rejects.toBe(error);
  expect(copy).not.toHaveBeenCalled();
});

it.each(["event", "shortcut"])("preserves links, bold and tables in non-editor rich copy through %s", async trigger => {
  const content = document.body.appendChild(document.createElement("div"));
  content.innerHTML = '<p><strong>加粗</strong><a href="https://example.com">来源</a></p><table><tbody><tr><td>单元格</td></tr></tbody></table>';
  const copy = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  const onError = vi.fn();
  const detach = attachClipboard(() => false, onError);
  try {
    document.getSelection()!.selectAllChildren(content);
    const event = trigger === "event" ? new Event("copy", { bubbles: true, cancelable: true })
      : new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    content.dispatchEvent(event);
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    const [html, text] = copy.mock.lastCall!;
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain('<a href="https://example.com">来源</a>');
    expect(html).toContain("<td>单元格</td>");
    expect(text).toBe("加粗来源单元格");
    expect(event.defaultPrevented).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  } finally { detach(); document.getSelection()!.removeAllRanges(); content.remove(); }
});

it("keeps formatting ancestors when the selection is wholly inside a bold link", async () => {
  const content = document.body.appendChild(document.createElement("div"));
  content.innerHTML = '<p><strong><a href="https://example.com">部分文字</a></strong></p>';
  const copy = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  const detach = attachClipboard(() => false, vi.fn());
  try {
    const text = content.querySelector("a")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 0, text, 2);
    content.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(copy.mock.lastCall![0]).toBe('<p><strong><a href="https://example.com">部分</a></strong></p>');
    expect(copy.mock.lastCall![1]).toBe("部分");
  } finally { detach(); document.getSelection()!.removeAllRanges(); content.remove(); }
});

it("keeps input field copy and Markdown-only clipboard writes as plain text", async () => {
  const input = document.body.appendChild(document.createElement("input"));
  input.value = "字段内容";
  const copy = vi.spyOn(desktop, "copyText").mockResolvedValue();
  const rich = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  const detach = attachClipboard(() => false, vi.fn());
  try {
    input.focus();
    input.setSelectionRange(0, 2);
    input.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    expect(copy).toHaveBeenCalledWith("字段");
    await writeClipboard("![图](asset://photo)");
    expect(copy).toHaveBeenLastCalledWith("![图](asset://photo)");
    expect(rich).not.toHaveBeenCalled();
  } finally { detach(); input.remove(); }
});
