// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EditorView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { desktop } from "../desktop";
import { writeClipboard } from "./clipboard";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [new DOMRect()] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

async function mount(value: string, onImages?: (files: File[]) => Promise<string>) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const changed = vi.fn();
  flushSync(() => root.render(<MarkdownEditor entryId="clipboard-integration" value={value} readOnly={false} onImages={onImages}
    ref={editor => { handle = editor; }} onDocumentChanged={changed} onBlur={() => {}} />));
  await vi.waitFor(() => expect(handle).not.toBeNull());
  const focus = vi.spyOn(EditorView.prototype, "focus");
  handle!.focus();
  const view = focus.mock.contexts.at(-1) as EditorView;
  focus.mockRestore();
  return { container, view, handle: handle!, changed, dispose() { flushSync(() => root.unmount()); container.remove(); } };
}

it.each([false, true])("waits for final IME text before applying an async paste at its mapped position (plain=%s)", async plain => {
  const m = await mount("原稿");
  let resolve!: (text: string) => void;
  const io = { read: () => new Promise<string>(done => { resolve = done; }), write: vi.fn(), onError: vi.fn() };
  try {
    m.handle.clipboard("paste", io, undefined, plain);
    let settled = false;
    const pending = m.handle.pendingEdits()!.then(() => { settled = true; });
    const body = m.container.querySelector(".ProseMirror")!;
    body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    resolve("粘贴");
    await new Promise(done => setTimeout(done, 0));
    expect(settled).toBe(false);
    expect(m.handle.captureMarkdown().markdown).toBe("原稿");
    const text = [...body.querySelector("p")!.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent === "原稿")!;
    text.textContent = "中文原稿";
    document.getSelection()!.collapse(text, 2);
    body.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await pending;
    expect(m.handle.captureMarkdown().markdown).toBe("中文粘贴原稿");
    expect(m.handle.pendingEdits()).toBeUndefined();
    m.handle.command("undo");
    expect(m.handle.captureMarkdown().markdown).toBe("中文原稿");
    m.handle.command("redo");
    expect(m.handle.captureMarkdown().markdown).toBe("中文粘贴原稿");
    expect(io.onError).not.toHaveBeenCalled();
  } finally { m.dispose(); }
});

it("finishes an async cut after composition without deleting newly composed text", async () => {
  const m = await mount("剪切保留");
  let resolve!: () => void;
  const io = { read: vi.fn(), write: vi.fn(() => new Promise<void>(done => { resolve = done; })), onError: vi.fn() };
  try {
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, 3)));
    m.handle.clipboard("cut", io);
    const pending = m.handle.pendingEdits()!;
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 5)));
    const body = m.container.querySelector(".ProseMirror")!;
    body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    m.view.dispatch(m.view.state.tr.insertText("中文"));
    resolve();
    await new Promise(done => setTimeout(done, 0));
    expect(m.handle.captureMarkdown().markdown).toBe("剪切保留中文");
    body.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await pending;
    expect(io.write).toHaveBeenCalledWith("剪切", expect.any(String));
    expect(m.handle.captureMarkdown().markdown).toBe("保留中文");
    m.handle.command("undo");
    expect(m.handle.captureMarkdown().markdown).toBe("剪切保留中文");
    expect(io.onError).not.toHaveBeenCalled();
  } finally { m.dispose(); }
});

it("keeps an imported image pending until composition finishes", async () => {
  let resolve!: (text: string) => void;
  const imported = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const m = await mount("原稿", imported);
  const coords = vi.spyOn(m.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });
  try {
    const body = m.container.querySelector(".ProseMirror")!;
    const file = new File(["image"], "photo.png", { type: "image/png" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
    body.dispatchEvent(drop);
    expect(imported).toHaveBeenCalledWith([file]);
    const pending = m.handle.pendingEdits()!;
    body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    resolve("![图片](asset://imported)");
    await new Promise(done => setTimeout(done, 0));
    expect(m.handle.captureMarkdown().markdown).toBe("原稿");
    body.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await pending;
    expect(m.handle.captureMarkdown().markdown).toBe("![图片](asset://imported)原稿");
  } finally { coords.mockRestore(); m.dispose(); }
});

it.each(["changed range", "closed session"])("cancels a deferred paste when its %s invalidates the target", async invalidation => {
  const m = await mount("原稿");
  let resolve!: (text: string) => void;
  const io = { read: () => new Promise<string>(done => { resolve = done; }), write: vi.fn(), onError: vi.fn() };
  let disposed = false;
  try {
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, 3)));
    m.handle.clipboard("paste", io);
    const pending = m.handle.pendingEdits()!;
    const body = m.container.querySelector(".ProseMirror")!;
    body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    resolve("过期内容");
    await new Promise(done => setTimeout(done, 0));
    if (invalidation === "closed session") {
      m.dispose();
      disposed = true;
    } else {
      m.view.dispatch(m.view.state.tr.insertText("新稿", 1, 3));
      body.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    }
    await pending;
    if (!disposed) expect(m.handle.captureMarkdown().markdown).toBe("新稿");
    expect(io.onError).not.toHaveBeenCalled();
  } finally { if (!disposed) m.dispose(); }
});

it("copies real images externally and pastes portable HTML internally without reimporting its original asset", async () => {
  const original = '开头 ![原图](asset://photo "注释") 末尾';
  const m = await mount(original);
  const read = vi.spyOn(desktop, "assetRead").mockResolvedValue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer);
  const copy = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  const onError = vi.fn();
  const importImage = vi.fn();
  try {
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, m.view.state.doc.content.size - 1)));
    m.handle.clipboard("copy", { read: vi.fn(), write: writeClipboard, onError });
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(copy.mock.lastCall![0]).toContain('<img src="data:image/png;base64,');
    const html = copy.mock.lastCall![0];
    m.view.dispatch(m.view.state.tr.delete(1, m.view.state.doc.content.size - 1));
    m.handle.clipboard("paste", { read: async () => ({ html }), write: writeClipboard, importImage, onError });
    await m.handle.pendingEdits();
    expect(m.handle.captureMarkdown().markdown).toBe(original);
    expect(importImage).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  } finally { read.mockRestore(); copy.mockRestore(); m.dispose(); }
});

it("retains cut content and reports failure if its local image cannot be prepared for the clipboard", async () => {
  const original = "![图片](asset://missing)正文";
  const m = await mount(original);
  const failure = new Error("图片读取失败");
  const read = vi.spyOn(desktop, "assetRead").mockRejectedValue(failure);
  const copy = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  const onError = vi.fn();
  try {
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, m.view.state.doc.content.size - 1)));
    m.handle.clipboard("cut", { read: vi.fn(), write: writeClipboard, onError });
    await m.handle.pendingEdits();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(copy).not.toHaveBeenCalled();
    expect(m.handle.captureMarkdown().markdown).toBe(original);
  } finally { read.mockRestore(); copy.mockRestore(); m.dispose(); }
});
