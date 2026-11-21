// @vitest-environment jsdom
import { act } from "react";
import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { imageContext } from "../../../../packages/editor-react/image-view";
import { desktop } from "../desktop";
import { EditorContextMenu } from "./EditorContextMenu";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function mountImages(readOnly = false) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const editor = { current: null as MarkdownEditorHandle | null };
  const changed = vi.fn();
  const source = "![第一张](asset://one)\n\n![第二张](asset://two)";
  flushSync(() => root.render(<Theme><EditorContextMenu editor={editor} clipboard={{ read: vi.fn(), write: vi.fn(), onError: vi.fn() }}
    readOnly={readOnly} onError={vi.fn()}>
    <MarkdownEditor entryId="image-actions" ref={editor} value={source} readOnly={readOnly}
      resolveImage={async url => ({ src: url.replace("asset://", "https://images.test/") + ".png", dispose: vi.fn() })}
      onDocumentChanged={changed} onBlur={() => {}} />
  </EditorContextMenu></Theme>));
  await vi.waitFor(() => expect(container.querySelectorAll(".rich-image img")).toHaveLength(2));
  for (const [index, frame] of [...container.querySelectorAll<HTMLElement>(".rich-image-frame")].entries()) {
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => container.hidden || !frame.isConnected ? new DOMRect() : new DOMRect(80, 100 + index * 260, 240, 160));
  }
  const original = editor.current!.captureMarkdown().markdown;
  const slot = container.querySelector(".editor-action-feedback");
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return {
    container, slot, changed, editor, original,
    feedback: (src = "asset://one") => document.querySelector<HTMLElement>(`.editor-image-action-feedback[data-image-source="${src}"]`),
    async open(alt = "第一张") {
      await act(async () => container.querySelector(`img[alt="${alt}"]`)!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    },
    async select(label: string) {
      await act(async () => [...document.querySelectorAll<HTMLElement>('[aria-label="图片操作"] [role="menuitem"]')]
        .find(item => item.textContent === label)!.click());
    },
    async closeMenu() {
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

it.each([
  ["copy", "success", false], ["save", "success", true], ["save", "cancel", false],
  ["copy", "failure", true], ["save", "failure", false],
] as const)("shows image %s feedback outside the closed menu (%s, readOnly=%s)", async (action, outcome, readOnly) => {
  const request = deferred<boolean>();
  const copy = vi.spyOn(desktop, "copyImage").mockImplementation(async () => { await request.promise; });
  const save = vi.spyOn(desktop, "saveImage").mockReturnValue(request.promise);
  const view = await mountImages(readOnly);
  const label = action === "copy" ? "复制图片" : "另存为";
  const operation = action === "copy" ? copy : save;
  try {
    await view.open();
    await view.select(label);
    expect(operation).toHaveBeenCalledExactlyOnceWith("asset://one");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(view.feedback()).not.toBeNull();
    expect(view.feedback()!.style.visibility).not.toBe("hidden");
    expect(view.feedback()!.closest(".radix-themes")).not.toBeNull();
    const button = () => view.feedback()!.querySelector<HTMLButtonElement>("button")!;
    expect(button().dataset.feedbackState).toBe("pending");
    expect(button().textContent).toContain(action === "copy" ? "正在复制" : "正在保存");
    expect(button().querySelector('.button-feedback-icon[data-state="pending"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(button().getAttribute("aria-busy")).toBe("true");
    await view.open();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await act(async () => item.click());
    expect(operation).toHaveBeenCalledOnce();
    await view.closeMenu();
    await act(async () => outcome === "failure" ? request.reject(new Error("操作暂不可用")) : request.resolve(outcome !== "cancel"));
    if (outcome !== "cancel") {
      expect(button().dataset.feedbackState).toBe(outcome === "failure" ? "error" : "success");
      expect(button().textContent).toContain(outcome === "failure" ? "失败" : action === "copy" ? "已复制" : "已保存");
      expect(button().disabled).toBe(true);
      await view.open();
      const resultItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!;
      expect(resultItem.getAttribute("aria-disabled")).toBe("true");
      await view.closeMenu();
      await act(async () => vi.advanceTimersByTime(999));
      expect(view.feedback()).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(1));
    }
    expect(view.feedback()).toBeNull();
    expect(view.container.querySelector(".editor-action-feedback")).toBe(view.slot);
    expect(view.slot?.textContent).toBe(outcome === "failure" ? "操作暂不可用" : "");
    expect(view.editor.current!.captureMarkdown().markdown).toBe(view.original);
    expect(view.changed).not.toHaveBeenCalled();
    await view.open();
    expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)?.getAttribute("aria-disabled")).not.toBe("true");
  } finally { await view.unmount(); }
});

it("keeps simultaneous image actions attached to their own images and cleans up on unmount", async () => {
  const copy = deferred<boolean>(), firstSave = deferred<boolean>(), secondSave = deferred<boolean>();
  vi.spyOn(desktop, "copyImage").mockImplementation(async () => { await copy.promise; });
  vi.spyOn(desktop, "saveImage").mockImplementation(src => src === "asset://one" ? firstSave.promise : secondSave.promise);
  const view = await mountImages();
  let unmounted = false;
  try {
    await view.open(); await view.select("复制图片");
    await view.open(); await view.select("另存为");
    await view.open("第二张"); await view.select("另存为");
    expect(view.feedback()!.querySelectorAll("button")).toHaveLength(2);
    expect(view.feedback("asset://two")!.querySelectorAll("button")).toHaveLength(1);
    expect(view.feedback()!.style.transform).not.toBe(view.feedback("asset://two")!.style.transform);
    await act(async () => { view.container.hidden = true; window.dispatchEvent(new Event("scroll")); });
    expect(view.feedback()!.style.visibility).toBe("hidden");
    expect(view.feedback("asset://two")!.style.visibility).toBe("hidden");
    await act(async () => { view.container.hidden = false; window.dispatchEvent(new Event("scroll")); });
    expect(view.feedback()!.style.visibility).not.toBe("hidden");
    await act(async () => { copy.resolve(true); firstSave.resolve(false); });
    expect(view.feedback()!.textContent).toContain("已复制");
    expect(view.feedback()!.querySelectorAll("button")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(view.feedback()).toBeNull();
    expect(view.feedback("asset://two")!.querySelector("button")?.dataset.feedbackState).toBe("pending");
    expect(view.editor.current!.captureMarkdown().markdown).toBe(view.original);
    expect(view.changed).not.toHaveBeenCalled();
    await view.unmount(); unmounted = true;
    await act(async () => secondSave.resolve(true));
    expect(document.querySelector(".editor-image-action-feedback")).toBeNull();
  } finally { if (!unmounted) await view.unmount(); }
});

it("does not move pending feedback to another image when the original image is removed", async () => {
  const request = deferred<boolean>();
  vi.spyOn(desktop, "copyImage").mockImplementation(async () => { await request.promise; });
  const view = await mountImages();
  try {
    await view.open(); await view.select("复制图片");
    expect(view.feedback()!.style.visibility).not.toBe("hidden");
    const image = imageContext(view.container.querySelector(".rich-image"));
    expect(image).not.toBeNull();
    await act(async () => { image!.remove(); window.dispatchEvent(new Event("scroll")); });
    expect(view.container.querySelector('img[alt="第一张"]')).toBeNull();
    expect(view.container.querySelector('img[alt="第二张"]')).not.toBeNull();
    expect(view.feedback()?.style.visibility ?? "hidden").toBe("hidden");
    const afterRemoval = view.editor.current!.captureMarkdown().markdown;
    await act(async () => request.resolve(true));
    expect(view.feedback()).toBeNull();
    expect(view.feedback("asset://two")).toBeNull();
    expect(view.editor.current!.captureMarkdown().markdown).toBe(afterRemoval);
  } finally { await view.unmount(); }
});
