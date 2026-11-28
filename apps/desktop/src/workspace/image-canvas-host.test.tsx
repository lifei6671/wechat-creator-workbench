// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownEditor, type ImageContext, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { Entry, ImageProject } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { SaveQueue } from "../editor/save-queue";
import { flushSaveBarriers } from "../editor/save-barriers";
import { useImageCanvasEditor } from "./ImageCanvasHost";
import type { ImageCanvasEditorProps } from "../image-canvas/ImageCanvasEditor";

vi.mock("../image-canvas/ImageCanvasEditor", () => ({ default: function Canvas(props: ImageCanvasEditorProps) {
  const [error, setError] = useState("");
  return <div className="image-canvas-dialog"><button onClick={() => {
    void props.onApply({ renderId: "render", outputAssetId: "output", src: "asset://output" })
      .then(props.onClose, failure => setError(failure.message));
  }}>确认应用</button><span role="alert">{error}</span></div>;
} }));

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("writes a hosted output after atomic apply, including undo during public validation (%s)", async undoDuringValidation => {
  const initial = "![配图](asset://original)";
  const entry: Entry = { id: "article", kind: "article", title: "配图", contentMd: initial, status: "draft", categoryId: null,
    tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 4, updatedAt: 0, deletedAt: null, links: [] };
  const save = vi.fn(async () => ({ version: 6 }));
  const queue = new SaveQueue(entry, save, vi.fn());
  vi.spyOn(desktop, "imageProjectOpen").mockResolvedValue({ id: "project", version: 1 } as ImageProject);
  const commit = vi.spyOn(desktop, "imageRenderCommit").mockResolvedValue({ renderId: "render", outputAssetId: "output", src: "asset://output", entryVersion: 5 });
  const hosted = "https://images.example.test/output.png";
  let verify!: (url: string) => void;
  const validation = new Promise<string>(done => { verify = done; });
  const resolve = vi.fn(() => validation);
  const readUpload = vi.fn(async (src: string) => ({ pending: false, publicUrl: src === "asset://output" ? hosted : undefined, preserveSource: src === "asset://output" }));
  const errors = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  function Harness() {
    const editor = useRef<MarkdownEditorHandle>(null);
    const canvas = useImageCanvasEditor(queue, editor, errors);
    return <><button onClick={() => {
      const frame = document.querySelector(".rich-image-frame")!;
      const event = new MouseEvent("contextmenu", { bubbles: true, button: 2 }); frame.dispatchEvent(event);
      const image = editor.current!.prepareContext(event);
      if (!image || typeof image !== "object" || !("kind" in image) || image.kind !== "image") throw new Error("missing image context");
      canvas.open(image);
    }}>打开画布</button><MarkdownEditor entryId={entry.id} value={initial} readOnly={false}
      readImageUploadState={readUpload} resolveHostedImage={resolve} onImageProcessingChange={queue.setProcessingImages} onError={errors}
      ref={value => { handle = value; editor.current = value; if (value) return queue.bindContentProvider(value.captureMarkdown); }}
      onDocumentChanged={(_id, revision) => queue.markContentDirty(revision)} onBlur={() => {}} />{canvas.element}</>;
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><Harness /></Theme>));
    await vi.waitFor(() => expect(container.querySelector(".rich-image-frame")).not.toBeNull());
    flushSync(() => container.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expect(container.querySelector(".image-canvas-dialog button")).not.toBeNull());
    flushSync(() => container.querySelector<HTMLButtonElement>(".image-canvas-dialog button")!.click());
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith("asset://output"));
    if (undoDuringValidation) {
      handle!.command("undo");
      expect(handle!.captureMarkdown().markdown).toBe(initial);
    }
    verify(hosted);
    if (undoDuringValidation) {
      await handle!.pendingEdits();
      expect(handle!.captureMarkdown().markdown).toBe(initial);
      handle!.command("redo");
    }
    const markdown = `![配图](${hosted}#wcb-image=output)`;
    await vi.waitFor(() => expect(handle!.captureMarkdown().markdown).toBe(markdown));
    await handle!.pendingEdits();
    expect(await queue.flush()).toBe(true);
    expect(commit).toHaveBeenCalledExactlyOnceWith("render", expect.objectContaining({ expectedVersion: 4, fields: expect.objectContaining({ contentMd: "![配图](asset://output)" }) }));
    expect(save).toHaveBeenCalledExactlyOnceWith("article", 5, expect.objectContaining({ contentMd: markdown }), "auto");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("asset://output");
    handle!.command("undo");
    expect(handle!.captureMarkdown().markdown).toBe(initial);
    handle!.command("redo");
    expect(handle!.captureMarkdown().markdown).toBe(markdown);
    expect(errors).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); queue.dispose(); container.remove(); await flushSaveBarriers(); }
});

it.each([false, true])("integrates the exact editor node with a single native entry commit (removed=%s)", async removed => {
  const initial = "![第一张](asset://same)\n\n![第二张](asset://same)";
  const entry: Entry = { id: "article", kind: "article", title: "配图文章", contentMd: initial, status: "draft", categoryId: null,
    tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 4, updatedAt: 0, deletedAt: null, links: [] };
  const originalSave = vi.fn();
  const queue = new SaveQueue(entry, originalSave, vi.fn());
  const project = { id: "project", originEntryId: "article", baseAssetId: "same", version: 1 } as ImageProject;
  const openProject = vi.spyOn(desktop, "imageProjectOpen").mockResolvedValue(project);
  const commit = vi.spyOn(desktop, "imageRenderCommit").mockResolvedValue({ renderId: "render", outputAssetId: "output", src: "asset://output", entryVersion: 5 });
  let handle: MarkdownEditorHandle | null = null, target: ImageContext;
  const errors = vi.fn();
  function Harness() {
    const editor = useRef<MarkdownEditorHandle>(null);
    const canvas = useImageCanvasEditor(queue, editor, errors);
    return <><button onClick={() => {
      const frame = document.querySelectorAll(".rich-image-frame")[1];
      const event = new MouseEvent("contextmenu", { bubbles: true, button: 2 }); frame.dispatchEvent(event);
      const image = editor.current!.prepareContext(event);
      if (!image || typeof image !== "object" || !("kind" in image) || image.kind !== "image") throw new Error("missing context");
      target = image; canvas.open(image);
    }}>打开画布</button><MarkdownEditor entryId={entry.id} value={initial} readOnly={false}
      ref={value => { handle = value; editor.current = value; if (value) return queue.bindContentProvider(value.captureMarkdown); }}
      onDocumentChanged={(_id, revision) => queue.markContentDirty(revision)} onBlur={() => {}} />{canvas.element}</>;
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><Harness /></Theme>));
    await vi.waitFor(() => expect(container.querySelectorAll(".rich-image-frame")).toHaveLength(2));
    flushSync(() => container.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expect(container.querySelector(".image-canvas-dialog button")).not.toBeNull());
    expect(openProject).toHaveBeenCalledExactlyOnceWith("article", "asset://same");
    if (removed) target!.remove();
    flushSync(() => container.querySelector<HTMLButtonElement>(".image-canvas-dialog button")!.click());
    if (removed) {
      await vi.waitFor(() => expect(container.querySelector('[role="alert"]')!.textContent).toContain("原图片已更改"));
      expect(commit).not.toHaveBeenCalled();
      expect(handle!.captureMarkdown().markdown).toBe("![第一张](asset://same)");
    } else {
      await vi.waitFor(() => expect(handle!.captureMarkdown().markdown).toBe("![第一张](asset://same)\n\n![第二张](asset://output)"));
      expect(commit).toHaveBeenCalledExactlyOnceWith("render", expect.objectContaining({ id: "article", expectedVersion: 4,
        fields: expect.objectContaining({ title: "配图文章", contentMd: "![第一张](asset://same)\n\n![第二张](asset://output)" }) }));
      expect(await queue.flush()).toBe(true);
      expect(originalSave).not.toHaveBeenCalled();
      handle!.command("undo");
      expect(handle!.captureMarkdown().markdown).toBe(initial);
    }
    expect(errors).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); queue.dispose(); container.remove(); await flushSaveBarriers(); }
});
