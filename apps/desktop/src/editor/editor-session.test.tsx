// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { useRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EditorView } from "@milkdown/kit/prose/view";
import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor as RichEditor, type EditorCommand, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { Entry } from "../../../../packages/shared-types";
import { parseWechat, renderWechat } from "../../../../packages/wechat-renderer";
import { desktop, type AiHistoryItem, type AiStreamEvent, type AiThread } from "../desktop";
import { attachClipboard } from "./clipboard";
import { editHistory } from "./history";
import { SaveQueue } from "./save-queue";
import { captureAiIntent, matchesAiTarget, requestedProperties, type ChatSelection } from "../ai/context";
import { messageTimeLabel } from "../labels";
import { AiPanel } from "../workspace/AiPanel";
import formatFixtures from "../../../../fixtures/wechat-format.json";

// Formatting tests explicitly read each observed revision so the expected Markdown remains visible to assertions.
function MarkdownEditor({ onChange, ref, ...props }: Omit<ComponentProps<typeof RichEditor>, "onDocumentChanged"> & {
  onChange(id: string, revision: number, markdown: string): void;
}) {
  const editor = useRef<MarkdownEditorHandle>(null);
  return <RichEditor {...props} onDocumentChanged={(id, revision) => onChange(id, revision, editor.current!.captureMarkdown().markdown)}
    ref={value => {
      editor.current = value;
      if (typeof ref === "function") return ref(value);
      if (ref) ref.current = value;
    }} />;
}

const nativeHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
it("prepares one exact image replacement, blocks edits during handoff, and keeps a single undo item", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const source = "![第一张](asset://same)\n\n![第二张](asset://same)";
  try {
    flushSync(() => root.render(<RichEditor entryId="image-atomic" value={source} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(container.querySelectorAll(".rich-image-frame")).toHaveLength(2));
    const second = container.querySelectorAll(".rich-image-frame")[1];
    const event = new MouseEvent("contextmenu", { bubbles: true, button: 2 });
    second.dispatchEvent(event);
    const image = handle!.prepareContext(event);
    if (!image || typeof image !== "object" || !("kind" in image) || image.kind !== "image") throw new Error("missing image context");
    const prepared = handle!.prepareImageReplacement(image, "asset://output");
    expect(prepared.markdown).toBe("![第一张](asset://same)\n\n![第二张](asset://output)");
    expect(handle!.captureMarkdown().markdown).toBe(source);
    handle!.insert("处理中输入");
    expect(handle!.captureMarkdown().markdown).toBe(source);
    prepared.commit();
    expect(handle!.captureMarkdown().markdown).toBe(prepared.markdown);
    handle!.command("undo");
    expect(handle!.captureMarkdown().markdown).toBe(source);
    handle!.command("redo");
    expect(handle!.captureMarkdown().markdown).toBe(prepared.markdown);
    expect(() => handle!.prepareImageReplacement(image, "asset://stale")).toThrow("原图片已更改");
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("preserves safe embedded HTML through a partial rich clipboard copy and paste", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const io = { read: vi.fn(), write: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
  const source = '前文 <kbd>Ctrl</kbd>\n\n<div><strong>保留内容</strong><img src="asset://retained" alt="原图"></div>\n\n后文';
  try {
    flushSync(() => root.render(<RichEditor key="html-source" entryId="html-source" value={source} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.focus();
    const paragraphs = container.querySelectorAll(".ProseMirror > p");
    const first = paragraphs[0].firstChild!, last = paragraphs[paragraphs.length - 1].firstChild!;
    document.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.target().to).toBeGreaterThan(5));
    handle!.clipboard("copy", io);
    const html = io.write.mock.lastCall![1];
    expect(html).toContain("data-value");
    handle = null;
    flushSync(() => root.render(<RichEditor key="html-target" entryId="html-target" value="" readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    io.read.mockResolvedValue({ html });
    handle!.clipboard("paste", io);
    await handle!.pendingEdits();
    const pasted = handle!.captureMarkdown().markdown;
    expect(pasted).toContain("<kbd>Ctrl</kbd>");
    expect(pasted).toContain("<strong>保留内容</strong>");
    expect(pasted).toContain('src="asset://retained"');
    expect(pasted).not.toContain("嵌入的 HTML");
    expect(io.onError).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // The installed Milkdown block provider uses browser hit testing on pointer movement.
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  // jsdom lacks the Range geometry used by ProseMirror when undo and commands scroll.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [new DOMRect()] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (nativeHitTest) Object.defineProperty(document, "elementFromPoint", nativeHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

it("highlights the chosen workspace match in a folded section without editing the document", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  const line = "😀 这里的**高亮**出现在段落里，高亮再次出现。";
  const prefix = `# 第一节\n\n${line}\n\n# 第二节\n\n`;
  const body = prefix + line;
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="workspace-match" value={body} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const sections = container.querySelectorAll<HTMLButtonElement>("button.rich-heading-fold");
    sections[1].click();
    const paragraphs = [...container.querySelectorAll(".ProseMirror > p")].filter(p => p.textContent?.includes("高亮"));
    expect(paragraphs[1].hasAttribute("hidden")).toBe(true);
    const matches = [...line.matchAll(/高亮|段落/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
    expect(handle!.revealSearchHit({
      line: 7, start: prefix.length, text: line, ranges: matches,
      before: null, after: null, leading: false, trailing: false,
    })).toBe(true);
    expect(paragraphs[1].hasAttribute("hidden")).toBe(false);
    expect([...paragraphs[1].querySelectorAll(".workspace-search-highlight")].map(match => match.textContent)).toEqual(["高亮", "段落", "高亮"]);
    expect(paragraphs[0].querySelector(".workspace-search-highlight")).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(handle!.captureMarkdown().markdown).toBe(body);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("preserves the compact editor highlight when expanded matches interrupt Markdown syntax", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  const line = "`1` " + "x".repeat(220) + " [^1]";
  const body = line + "\n\n[^1]: A note";
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="expanded-workspace-match" value={body} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const markdown = handle!.captureMarkdown().markdown;
    expect(markdown).toMatch(/^`1` x+ \[\^1\]/);
    const end = markdown.indexOf("\n");
    const reference = markdown.indexOf("[^1]") + 2;
    const firstMatch = { start: 1, end: 2 };
    expect(handle!.revealSearchHit({
      line: 1, start: 0, text: markdown.slice(0, 180), ranges: [firstMatch],
      leading: false, trailing: true, before: null, after: null,
      expanded: {
        start: 0, text: markdown.slice(0, end), leading: false, trailing: false,
        ranges: [firstMatch, { start: reference, end: reference + 1 }],
      },
    }, true)).toBe(true);
    expect([...container.querySelectorAll(".workspace-search-highlight")].map(match => match.textContent)).toEqual(["1"]);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("notifies only document revisions and reads fresh Markdown for explicit document context", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="snapshot" value={"## 正文\n\n现有内容"} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    await select(container, 4, 4, handle!);
    const before = handle!.captureMarkdown();
    handle!.insert("末字");
    const snapshot = handle!.captureMarkdown();
    expect(snapshot.localRevision).toBeGreaterThan(before.localRevision);
    expect(changed).toHaveBeenCalledExactlyOnceWith("snapshot", snapshot.localRevision);
    expect(snapshot.markdown).toBe("## 正文\n\n现有内容末字");
    expect(handle!.captureContext("document")?.original).toBe(snapshot.markdown);
    expect(handle!.captureContext("section")?.original).toBe(snapshot.markdown);
    handle!.command("selectAll");
    handle!.command("selectAll");
    const write = vi.fn().mockResolvedValue(undefined);
    expect(handle!.clipboard("copy", { write, read: async () => "", onError: vi.fn() })).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith(snapshot.markdown);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each([false, true])("locates the drop boundary in a 1000-block article and preserves undo (folded=%s)", async folded => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const paragraphs = Array.from({ length: 1000 }, (_, index) => `区块 ${index}`);
  const body = (folded ? [...paragraphs.slice(0, 2), "## 长章节", ...paragraphs.slice(2)] : paragraphs).join("\n\n");
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")!;
  const onChange = vi.fn();
  const lookup = vi.spyOn(EditorView.prototype, "nodeDOM");
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="long-drag" value={body} active readOnly={false}
      onChange={onChange} onBlur={() => {}} ref={editor => { handle = editor; }} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    if (folded) container.querySelector<HTMLButtonElement>(".rich-heading-fold")!.click();
    const blocks = [...container.querySelectorAll<HTMLElement>(".ProseMirror > p")];
    expect(blocks).toHaveLength(1000);
    if (folded) {
      expect(blocks.filter(block => block.hidden)).toHaveLength(998);
      container.querySelector<HTMLElement>(".ProseMirror > h2")!.getBoundingClientRect = () => new DOMRect(25, 40, 400, 16);
    }
    let reads = 0;
    blocks.forEach((block, index) => {
      block.getBoundingClientRect = () => { reads++; return new DOMRect(25, index * 20, 400, 16); };
    });
    const scroller = container.querySelector<HTMLElement>(".editor-scroll")!;
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 500, 20_000);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (_x: number, y: number) => blocks[Math.floor(y / 20)] });
    const grip = container.querySelector<HTMLElement>('[aria-label="拖动区块"]')!;
    grip.setPointerCapture = vi.fn();
    grip.hasPointerCapture = () => true;
    grip.releasePointerCapture = vi.fn();
    const move = (type: string, y: number) => new PointerEvent(type, {
      bubbles: true, isPrimary: true, pointerId: 1, clientX: 50, clientY: y, cancelable: true,
    });
    blocks[0].dispatchEvent(move("pointermove", 2));
    await vi.waitFor(() => expect(grip.parentElement?.dataset.show).toBe("true"));
    grip.onpointerdown!(move("pointerdown", 2));
    reads = 0;
    lookup.mockClear();
    for (let index = 890; index < 990; index++) grip.onpointermove!(move("pointermove", folded ? 32 : index * 20 + 2));
    expect(reads).toBeLessThanOrEqual(1100);
    if (folded) expect(lookup.mock.calls.length).toBeLessThanOrEqual(300);
    const line = container.querySelector<HTMLElement>(".rich-block-drop-line")!;
    expect(line.hidden).toBe(false);
    expect(line.style.top).toBe(folded ? "40px" : "19780px");
    grip.onpointerup!(move("pointerup", folded ? 32 : 989 * 20 + 2));
    const paragraphsAfter = [...container.querySelectorAll(".ProseMirror > p")].map(block => block.textContent);
    if (folded) expect(paragraphsAfter.slice(0, 3)).toEqual(["区块 1", "区块 0", "区块 2"]);
    else expect(paragraphsAfter.slice(987, 990)).toEqual(["区块 988", "区块 0", "区块 989"]);
    handle!.command("undo");
    expect(container.querySelector(".ProseMirror > p")?.textContent).toBe("区块 0");
  } finally {
    lookup.mockRestore();
    Object.defineProperty(document, "elementFromPoint", hitTest);
    flushSync(() => root.unmount());
    container.remove();
  }
});

async function select(element: HTMLElement, from: number, to: number, handle: MarkdownEditorHandle) {
  const text = [...element.querySelector("p")!.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!;
  handle.focus();
  document.getSelection()!.setBaseAndExtent(text, from, text, to);
  document.dispatchEvent(new Event("selectionchange"));
  await vi.waitFor(() => expect(handle.target().original).toBe(text.textContent!.slice(from, to)));
}

it("keeps unhandled Tab in editable body text while leaving reverse navigation available", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const render = (readOnly: boolean) => flushSync(() => root.render(<MarkdownEditor
    entryId="body-tab" value="普通正文" readOnly={readOnly} onChange={onChange} onBlur={() => {}}
    ref={value => { handle = value; }} />));
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const body = container.querySelector<HTMLElement>(".ProseMirror")!;
    handle!.focus();
    const pressTab = (shiftKey = false) => body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", shiftKey, bubbles: true, cancelable: true,
    }));
    expect(pressTab()).toBe(false);
    expect(document.activeElement).toBe(body);
    expect(onChange).not.toHaveBeenCalled();
    expect(pressTab(true)).toBe(true);
    render(true);
    expect(pressTab()).toBe(true);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each([
  ["> 引用内容\n\n下一行", "> 引用内容下一行"],
  ["> 第一段\n>\n> 引用末段\n\n下一行", "> 第一段\n>\n> 引用末段下一行"],
  ["> > 嵌套引用\n\n下一行", "> > 嵌套引用下一行"],
  ["> **GitHub：** <https://example.com>\n\n**镜头效果预览：** <https://example.com/demo>", "> **GitHub：** <https://example.com>**镜头效果预览：** <https://example.com/demo>"],
])("joins text at a paragraph start into the preceding quote's last line (%s)", async (original, expected) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="join-quote-boundary" value={original} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const before = handle!.captureMarkdown().markdown;
    const paragraph = container.querySelector(".ProseMirror > p")!;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode()!;
    handle!.focus();
    document.getSelection()!.setBaseAndExtent(text, 0, text, 0);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.captureContext("section")?.original).not.toMatch(/^>/));
    const body = container.querySelector<HTMLElement>(".ProseMirror")!;
    expect(body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace", keyCode: 8, bubbles: true, cancelable: true,
    }))).toBe(false);
    expect(handle!.captureMarkdown().markdown).toBe(expected);
    handle!.command("undo");
    expect(handle!.captureMarkdown().markdown).toBe(before);
    handle!.command("redo");
    expect(handle!.captureMarkdown().markdown).toBe(expected);
    handle!.insert("插入点");
    expect(container.querySelector("blockquote")!.textContent).toContain("插入点");
    expect(container.querySelector(".ProseMirror > p")?.textContent ?? "").toBe("");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each([false, true])("joins the preceding quote when Backspace starts at the opening bold marker (footnotes=%s)", async convertLinks => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const original = "> **GitHub：** <https://example.com>\n\n**镜头效果预览：** <https://example.com/demo>";
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="quote-bold-boundary" value={original} convertLinks={convertLinks} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const before = handle!.captureMarkdown().markdown;
    handle!.focus();
    const bold = container.querySelector(".ProseMirror > p strong")!;
    document.getSelection()!.collapse(bold.firstChild!, 0);
    document.dispatchEvent(new Event("selectionchange"));
    const opener = await vi.waitFor(() => {
      const field = container.querySelector<HTMLInputElement>('.ProseMirror > p input[aria-label="加粗起始标记"]');
      expect(field?.value).toBe("**");
      return field!;
    });
    opener.focus();
    for (const [from, to] of [[1, 1], [0, 1]]) {
      opener.setSelectionRange(from, to);
      expect(opener.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Backspace", keyCode: 8, bubbles: true, cancelable: true,
      }))).toBe(true);
      expect(document.activeElement).toBe(opener);
    }
    opener.value = "*";
    opener.setSelectionRange(0, 0);
    expect(opener.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace", keyCode: 8, bubbles: true, cancelable: true,
    }))).toBe(true);
    opener.value = "**";
    opener.setSelectionRange(0, 0);
    expect(opener.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace", keyCode: 8, isComposing: true, bubbles: true, cancelable: true,
    }))).toBe(true);
    expect(handle!.captureMarkdown().markdown).toBe(before);
    expect(opener.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace", keyCode: 8, bubbles: true, cancelable: true,
    }))).toBe(false);
    expect(container.querySelector(".ProseMirror > p")?.textContent ?? "").toBe("");
    expect(container.querySelectorAll("blockquote p")).toHaveLength(1);
    expect(container.querySelectorAll("blockquote strong")).toHaveLength(2);
    expect(document.activeElement).toBe(container.querySelector(".ProseMirror"));
    const merged = handle!.captureMarkdown().markdown;
    expect(merged).toBe("> **GitHub：** <https://example.com>**镜头效果预览：** <https://example.com/demo>");
    handle!.command("undo");
    expect(handle!.captureMarkdown().markdown).toBe(before);
    handle!.command("redo");
    expect(handle!.captureMarkdown().markdown).toBe(merged);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each([false, true])("turns a quote prefix typed before a leading bold marker into a quote immediately (footnotes=%s)", async convertLinks => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const original = "**GitHub：** <https://example.com>\n\n在线演示";
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="quote-bold-prefix" value={original} convertLinks={convertLinks} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.focus();
    document.getSelection()!.collapse(container.querySelector("strong")!.firstChild!, 0);
    document.dispatchEvent(new Event("selectionchange"));
    const opener = await vi.waitFor(() => {
      const field = container.querySelector<HTMLInputElement>('input[aria-label="加粗起始标记"]');
      expect(field?.value).toBe("**");
      return field!;
    });
    opener.focus();
    opener.value = ">**";
    opener.setSelectionRange(1, 1);
    opener.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ">", bubbles: true }));
    expect(container.querySelector("blockquote")).toBeNull();
    opener.value = "> **";
    opener.setSelectionRange(2, 2);
    opener.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", data: " ", isComposing: true, bubbles: true }));
    expect(container.querySelector("blockquote")).toBeNull();
    opener.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: " ", bubbles: true }));
    expect(container.querySelector("blockquote strong")?.textContent).toBe("GitHub：");
    expect(container.querySelector("blockquote a")?.getAttribute("href")).toBe("https://example.com");
    expect(document.activeElement).toBe(container.querySelector(".ProseMirror"));
    expect(handle!.captureMarkdown().markdown).toBe("> **GitHub：** <https://example.com>\n\n在线演示");
    handle!.command("undo");
    expect(handle!.captureMarkdown().markdown).toBe(original);
    handle!.command("redo");
    expect(handle!.captureMarkdown().markdown).toBe("> **GitHub：** <https://example.com>\n\n在线演示");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each(["正文 **GitHub：**", "| **GitHub：** | 其他单元格 |\n| ----------- | ----- |\n| 内容          | 保留    |"])("keeps quote-prefix input within its paragraph boundary (%s)", async original => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="quote-prefix-boundary" value={original} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.focus();
    document.getSelection()!.collapse(container.querySelector("strong")!.firstChild!, 0);
    document.dispatchEvent(new Event("selectionchange"));
    const opener = await vi.waitFor(() => {
      const field = container.querySelector<HTMLInputElement>('input[aria-label="加粗起始标记"]');
      expect(field?.value).toBe("**");
      return field!;
    });
    const before = handle!.captureMarkdown().markdown;
    opener.focus();
    opener.value = "> **";
    opener.setSelectionRange(2, 2);
    opener.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: " ", bubbles: true }));
    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toContain("GitHub：");
    if (container.querySelector("table")) {
      expect(container.querySelector("th")?.textContent).toContain("> ");
      expect(handle!.captureMarkdown().markdown).toContain("其他单元格");
      handle!.command("undo");
    } else {
      expect(document.activeElement).toBe(opener);
    }
    expect(handle!.captureMarkdown().markdown).toBe(before);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("keeps a backward selection anchored after a quoted autolink and its generated footnote", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  const original = "前面的正文\n\n> **GitHub：** <https://example.com>\n\n后面的正文";
  let handle: MarkdownEditorHandle | null = null;
  const focus = vi.spyOn(EditorView.prototype, "focus");
  try {
    flushSync(() => root.render(<RichEditor entryId="quote-link-selection" value={original} convertLinks readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.focus();
    const view = focus.mock.contexts.at(-1) as EditorView;
    const paragraph = container.querySelector("blockquote p")!;
    const linkText = paragraph.querySelector("a .rich-link-footnoted")!.firstChild!;
    document.getSelection()!.collapse(linkText, linkText.textContent!.length);
    document.dispatchEvent(new Event("selectionchange"));
    const closing = await vi.waitFor(() => {
      const marker = paragraph.querySelector('[data-markdown=">"]');
      expect(marker).not.toBeNull();
      return marker!;
    });
    const end = [...paragraph.childNodes].indexOf(closing) + 1;
    const selection = document.getSelection()!;
    selection.collapse(paragraph, end);
    view.focus();
    expect(selection.anchorNode).toBe(paragraph);
    expect(selection.anchorOffset).toBe(end);
    const firstText = container.querySelector(".ProseMirror > p")!.firstChild!;
    selection.extend(firstText, 0);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.target().original).toBe("前面的正文\n\n> **GitHub：** <https://example.com>"));
    expect(handle!.captureMarkdown().markdown).toBe(original);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    focus.mockRestore();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each(["", "const value = 1;"])("deletes the preceding code block at a paragraph start without absorbing its text (%s)", async code => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const original = "```javascript\n" + (code ? code + "\n" : "") + "```\n\n代码之后的正文";
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<RichEditor entryId="delete-code-boundary" value={original} readOnly={false}
      ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const before = handle!.captureMarkdown().markdown;
    await select(container, 0, 0, handle!);
    const body = container.querySelector<HTMLElement>(".ProseMirror")!;
    expect(body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace", keyCode: 8, bubbles: true, cancelable: true,
    }))).toBe(false);
    expect(container.querySelector(".rich-code-block")).toBeNull();
    expect(handle!.captureMarkdown().markdown).toBe("代码之后的正文");
    handle!.command("undo");
    expect(handle!.captureMarkdown().markdown).toBe(before);
    handle!.command("redo");
    handle!.insert("开头");
    expect(handle!.captureMarkdown().markdown).toBe("开头代码之后的正文");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each(["原有正文", "```javascript\nconst value = 1;\n```"])("routes macOS menu undo and redo through editor history (%s)", async value => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const render = (readOnly = false) => flushSync(() => root.render(<RichEditor entryId="native-history" value={value} readOnly={readOnly}
    ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
  try {
    render();
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const before = handle!.captureMarkdown().markdown;
    handle!.focus();
    handle!.insert("新增");
    const after = handle!.captureMarkdown().markdown;
    expect(after).not.toBe(before);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      editHistory("undo");
      expect(handle!.captureMarkdown().markdown).toBe(after);
    } finally {
      focus.mockRestore();
    }
    editHistory("undo");
    expect(handle!.captureMarkdown().markdown).toBe(before);
    editHistory("redo");
    expect(handle!.captureMarkdown().markdown).toBe(after);
    render(true);
    editHistory("undo");
    expect(handle!.captureMarkdown().markdown).toBe(after);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("filters and runs editor slash commands without consuming IME confirmation", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let editor: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="slash" value="" active readOnly={false}
      ref={handle => { editor = handle; }} onChange={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(editor).not.toBeNull());
    editor!.focus();
    editor!.insert("/h2");
    const menu = container.querySelector<HTMLElement>(".rich-slash-menu")!;
    const editorDom = container.querySelector(".ProseMirror")!;
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect([...menu.querySelectorAll("button")].map(button => button.textContent)).toEqual([
      expect.stringContaining("标题 2"),
    ]);
    const key = (event: KeyboardEventInit) => editorDom.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...event }));
    key({ key: "Enter", isComposing: true });
    expect(editorDom.textContent).toContain("/h2");
    expect(menu.hidden).toBe(false);
    expect(key({ key: "Enter" })).toBe(false);
    editor!.insert("小标题");
    expect(editorDom.querySelector("h2")?.textContent).toContain("小标题");
    expect(menu.hidden).toBe(true);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("routes an image link inserted from the slash menu through the configured image storage", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const source = "https://example.com/image.png";
  const localizeImageLink = vi.fn().mockResolvedValue("asset://uploaded");
  const onChange = vi.fn();
  let editor: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="slash-image" value="" active readOnly={false}
      ref={handle => { editor = handle; }} localizeImageLink={localizeImageLink} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(editor).not.toBeNull());
    editor!.focus();
    editor!.insert("/图片");
    const menu = container.querySelector<HTMLElement>(".rich-slash-menu")!;
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    const item = menu.querySelector<HTMLButtonElement>(".rich-slash-item")!;
    expect(item.textContent).toContain("图片");
    item.click();
    menu.querySelector<HTMLInputElement>("input[type=url]")!.value = source;
    menu.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onChange.mock.lastCall?.[2]).toContain("asset://uploaded"));
    expect(localizeImageLink).toHaveBeenCalledExactlyOnceWith(source);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("formats chat timestamps by local calendar days", () => {
  const now = new Date(2026, 10, 16, 20);
  expect(messageTimeLabel(new Date(2026, 10, 16, 18, 10), now)).toBe("18:10");
  expect(messageTimeLabel(new Date(2026, 10, 15, 18, 10), now)).toBe("昨天 18:10");
  expect(messageTimeLabel(new Date(2026, 10, 14, 23, 59), now)).toBe("前天");
  expect(messageTimeLabel(new Date(2026, 10, 6, 15, 10), now)).toBe("11.06 15:10");
  expect(messageTimeLabel(new Date(2026, 11, 31, 0, 7), new Date(2027, 0, 1))).toBe("昨天 00:07");
});

it("binds an AI rewrite to the original session and range and gives it a separate undo step", async () => {
  const entry: Entry = { id: "draft", kind: "article", title: "标题",
    contentMd: "初稿 第一段 第二段\n\n![图](https://example.com/image.png)\n\n| 标题 | 链接 |\n| --- | --- |\n| 示例 | [参考](https://example.com) |\n\n~~~js\nconst value = 1;\n~~~\n\n补充[^note]\n\n[^note]: 脚注",
    status: "draft", categoryId: null,
    tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [] };
  const createQueue = (entry: Entry) => new SaveQueue(entry, vi.fn().mockResolvedValue({ version: 2 }), () => {});
  const original = createQueue(entry);
  const other = createQueue({ ...entry, id: "other" });
  const editorContainer = document.createElement("div");
  const root = createRoot(editorContainer);
  const handles = new Map<string, MarkdownEditorHandle>();
  document.body.append(editorContainer);
  flushSync(() => root.render([original, other].map(queue => <MarkdownEditor key={queue.sessionId}
    ref={instance => { if (instance) handles.set(queue.entry.id, instance); }} entryId={queue.entry.id}
    value={queue.entry.contentMd} readOnly={false} onChange={(_id, _revision, contentMd) => queue.edit({ contentMd })}
    onBlur={() => {}} />)));
  try {
    await vi.waitFor(() => expect(handles.size).toBe(2));
    const editor = editorContainer.querySelector<HTMLElement>(".ProseMirror")!;
    const handle = handles.get(entry.id)!;
    handle.insert("!");
    await select(editor, 4, 7, handle);
    const task = captureAiIntent("rewrite", "润色", "auto", original, handle);
    expect(task.request.text).toBe("第一段");
    expect(matchesAiTarget(task.target!, createQueue(entry))).toBe(false);
    expect(matchesAiTarget(task.target!, other)).toBe(false);
    await select(editor, 8, 11, handle);
    const before = original.snapshot().fields.contentMd;
    expect(matchesAiTarget(task.target!, original)).toBe(true);
    expect(handles.get(other.entry.id)!.replaceTarget(task.target!.context!, "新段落")).toBe(false);
    expect(handle.replaceTarget(task.target!.context!, "第一段\n\n## 标题")).toBe(false);
    expect(original.snapshot().fields.contentMd).toBe(before);
    expect(handle.replaceTarget(task.target!.context!, "新段落")).toBe(true);
    expect(original.snapshot().fields.contentMd).toBe(before.replace("第一段", "新段落"));
    expect(matchesAiTarget(task.target!, original)).toBe(false);
    handle.command("undo");
    expect(original.snapshot().fields.contentMd).toBe(before);
  } finally {
    original.dispose();
    other.dispose();
    flushSync(() => root.unmount());
    editorContainer.remove();
  }
});

it("streams chat across article switches and restores chat and selected-range proposals", { timeout: 15_000 }, async () => {
  const entry: Entry = { id: "chat-draft", kind: "article", title: "标题", contentMd: "开头\n\n## 一\n\n这段正文\n\n## 二\n\n其他段落",
    status: "draft", categoryId: null, tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "",
    version: 1, updatedAt: 0, deletedAt: null, links: [] };
  const commit = vi.fn(async (_id: string, version: number) => ({ version: version + 1 }));
  const queue = new SaveQueue(entry, commit, () => {});
  const other = new SaveQueue({ ...entry, id: "another" }, commit, () => {});
  const uncached = Array.from({ length: 4 }, (_, index) => new SaveQueue({ ...entry, id: `uncached-${index}`,
    title: `缓存测试 ${index}` }, commit, () => {}));
  const threads = new Map<string, AiThread>();
  const messages = new Map<string, AiHistoryItem[]>();
  const entryThreads = new Map<string | null, string[]>();
  const scope = vi.spyOn(desktop, "aiThreads").mockImplementation(async id => (entryThreads.get(id) ?? [])
    .map(thread => threads.get(thread)!).filter(thread => !thread.archived || messages.get(thread.id)?.length));
  vi.spyOn(desktop, "aiCreateThread").mockImplementation(async entryId => {
    const existing = entryThreads.get(entryId) ?? [];
    const id = "thread-" + entryId + (existing.length ? "-" + existing.length : "");
    for (const otherId of existing) threads.get(otherId)!.archived = true;
    entryThreads.set(entryId, [id, ...existing]);
    threads.set(id, { id, title: "", archived: false, updatedAt: Date.now() });
    messages.set(id, []);
    return id;
  });
  vi.spyOn(desktop, "aiThread").mockImplementation(async (_entryId, id) => threads.get(id)!);
  const removeThread = vi.spyOn(desktop, "aiDeleteThread").mockImplementation(async id => {
    threads.delete(id);
    messages.delete(id);
    for (const [entry, ids] of entryThreads) entryThreads.set(entry, ids.filter(thread => thread !== id));
  });
  const updateThread = vi.spyOn(desktop, "aiUpdateThread").mockImplementation(async (id, change) => {
    if (change.archived === false) {
      const siblings = [...entryThreads.values()].find(ids => ids.includes(id))!;
      for (const otherId of siblings) threads.get(otherId)!.archived = otherId !== id;
    }
    Object.assign(threads.get(id)!, change);
  });
  vi.spyOn(desktop, "aiMessages").mockImplementation(async id => structuredClone(messages.get(id) ?? []));
  let interruptedWrite = false;
  let blockedThreadWrites: string | undefined;
  const saveMessage = vi.spyOn(desktop, "aiSaveMessage").mockImplementation(async (thread, item) => {
    if (!interruptedWrite || thread === blockedThreadWrites) {
      interruptedWrite = true;
      throw new Error("对话写入暂时失败");
    }
    const saved = messages.get(thread)!;
    if (item.parentId) expect(saved.some(row => row.message.id === item.parentId)).toBe(true);
    saved.push(structuredClone({ parentId: item.parentId, message: item.message }));
  });
  const updateProposal = vi.spyOn(desktop, "aiProposalStatus").mockImplementation(async (id, status) => {
    for (const rows of messages.values()) for (const row of rows) {
      const proposal = row.message.metadata.custom.proposal as { id: string; status: string } | undefined;
      if (proposal?.id === id) proposal.status = status;
    }
  });
  let emit!: (event: AiStreamEvent) => void;
  let finish!: (reply: { reply: string }) => void;
  let fail!: (error: unknown) => void;
  const cancel = vi.spyOn(desktop, "aiCancel").mockImplementation(async () => fail({ code: "AI_CANCELLED", message: "生成已取消" }));
  const generate = vi.spyOn(desktop, "aiChatStream").mockImplementation((_id, request, onEvent) => {
    if (request.operation === "rewrite") {
      onEvent({ type: "started" });
      return Promise.resolve({ candidates: ["改写稿"], description: "精简措辞" });
    }
    if (request.operation === "chat" && request.properties) {
      return Promise.resolve(request.properties.fields.includes("title")
        ? { properties: { title: "新的文章标题" } }
        : { properties: { tags: [" markdown ", "写作", " 写作 ", "不采用"], summary: "新的文章摘要" } });
    }
    emit = onEvent;
    return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const digest = Object.getOwnPropertyDescriptor(crypto, "subtle");
  Object.defineProperty(crypto, "subtle", { configurable: true, value: webcrypto.subtle });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const editors = new Map<string, MarkdownEditorHandle>();
  const click = (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>(".ai-session:not([hidden]) button")]
      .find(node => node.getAttribute("aria-label") === label || node.textContent === label
        || node.querySelector(".ai-thread-title")?.textContent === label);
    expect(button, label).toBeDefined();
    expect(button!.disabled, label).toBe(false);
    flushSync(() => button!.click());
  };
  const send = async (text: string) => {
    const field = await vi.waitFor(() => {
      const input = container.querySelector<HTMLTextAreaElement>(".ai-session:not([hidden]) textarea[aria-label='消息']");
      expect(input?.disabled, "输入 " + text).toBe(false);
      return input!;
    });
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    flushSync(() => field.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>(".ai-session:not([hidden]) button[aria-label='发送消息']")?.disabled,
      "发送 " + text + " 时：" + field.value + " / " + activePanel().textContent).toBe(false));
    click("发送消息");
  };
  const render = (current: SaveQueue, key: number, selectionRequest?: ChatSelection) => flushSync(() => root.render(<Theme>
    {[queue, other].map(origin => <RichEditor key={origin.sessionId}
      ref={value => {
        if (!value) return;
        editors.set(origin.entry.id, value);
        return origin.bindContentProvider(value.captureMarkdown);
      }} entryId={origin.entry.id} value={origin.entry.contentMd}
      active={current === origin} readOnly={false} onDocumentChanged={(_id, revision) => origin.markContentDirty(revision)} onBlur={() => {}} />)}
    <AiPanel key={key} open queue={current} editor={editors.get(current.entry.id)} target={{ label: "测试模型" }} targetPicker={null}
      canChat canEdit tagSuggestions={["其他段落", "无关工作区标签"]} selectionRequest={selectionRequest}
      canWrite={target => target === current} onClose={() => {}} onSettings={() => {}} />
  </Theme>));
  const activePanel = () => container.querySelector(".ai-session:not([hidden])")!;
  const chooseRewrite = () => {
    const tools = activePanel().querySelector('[aria-label="写作工具"]')!;
    flushSync(() => tools.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "自定义改写");
    expect(item).toBeDefined();
    flushSync(() => item!.click());
  };
  try {
    render(queue, 1);
    await vi.waitFor(() => expect(editors.size).toBe(2));
    render(queue, 1);
    const editor = editors.get(entry.id)!;
    const selectRange = async (from: number, to: number) => {
      const line = container.querySelectorAll(".ProseMirror p")[1].firstChild!;
      editor.focus();
      document.getSelection()!.setBaseAndExtent(line, from, line, to);
      document.dispatchEvent(new Event("selectionchange"));
      await vi.waitFor(() => expect(editor.target().original).toBe(line.textContent!.slice(from, to)));
    };
    await selectRange(1, 1);
    expect(editor.captureContext("section")).toMatchObject({ headingPath: ["一"], original: "## 一\n\n这段正文" });
    await send("怎么改？");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0][1]).toMatchObject({ operation: "chat", text: "## 一\n\n这段正文",
      context: { scope: "section", headingPath: ["一"] } });
    expect(activePanel().querySelector(".ai-user-citation + .ai-user-message")?.previousElementSibling?.textContent).toBe("当前章节");
    emit({ type: "started" });
    emit({ type: "delta", text: "可以加" });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("可以加"));
    render(other, 1);
    expect(activePanel().textContent).not.toContain("可以加");
    expect(scope).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(activePanel().textContent).toContain("开始新对话"));
    click("对话记录");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("暂无对话"));
    expect(scope).toHaveBeenCalledExactlyOnceWith(other.entry.id);
    finish({ reply: "可以加一条例子。" });
    await vi.waitFor(() => expect(messages.get("thread-" + entry.id)).toHaveLength(2));
    render(queue, 1);
    await vi.waitFor(() => expect(activePanel().textContent).toContain("可以加一条例子。"));

    await send("举什么例子？");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][1]).toMatchObject({ history: [{ user: "怎么改？", assistant: "可以加一条例子。" }] });
    click("停止生成");
    emit({ type: "started" });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(generate.mock.calls[1][1].id));
    await vi.waitFor(() => expect(activePanel().textContent).toContain("已停止生成"));

    await selectRange(0, 4);
    chooseRewrite();
    const rewriteChip = () => activePanel().querySelector('button[aria-label^="退出改写选区"]');
    await vi.waitFor(() => expect(rewriteChip()?.textContent).toBe("这段正文×"));
    await selectRange(0, 2);
    await vi.waitFor(() => expect(rewriteChip()?.textContent).toBe("这段×"));
    await selectRange(0, 4);
    await send("只改选区");
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "rewrite", text: "这段正文" }));
    await vi.waitFor(() => expect(activePanel().textContent).toContain("精简措辞"));
    const rewriteQuote = activePanel().querySelector('blockquote[aria-label="所选内容"]');
    expect(rewriteQuote?.textContent).toBe("这段正文");
    expect(rewriteQuote?.nextElementSibling?.textContent).toBe("只改选区");
    expect(rewriteQuote?.parentElement?.querySelector(".ai-user-actions")?.textContent).not.toContain("选区");
    expect(queue.capture().fields.contentMd).toBe(entry.contentMd);
    const beforeEviction = activePanel();
    for (const current of uncached) {
      render(current, 1);
      await vi.waitFor(() => expect(activePanel()?.querySelector(".ai-context")?.textContent).toBe(current.entry.title));
    }
    await vi.waitFor(() => expect(beforeEviction.isConnected).toBe(false));
    render(queue, 1);
    commit.mockRejectedValueOnce(new Error("磁盘写入失败"));
    await vi.waitFor(() => expect([...activePanel().querySelectorAll("button")].find(node => node.textContent === "接受修改")?.disabled).toBe(false));
    click("接受修改");
    expect(queue.capture().fields.contentMd).toBe(entry.contentMd.replace("这段正文", "改写稿"));
    expect(updateProposal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(activePanel().textContent).toContain("正文已修改，保存失败"), { timeout: 2500 });
    expect(queue.capture().fields.contentMd).toContain("改写稿");
    expect(updateProposal).not.toHaveBeenCalled();
    await queue.flush({ retry: true });
    await vi.waitFor(() => expect(updateProposal).toHaveBeenCalledWith(generate.mock.calls.at(-1)![1].id, "applied"));
    expect(commit).toHaveBeenLastCalledWith(entry.id, 1, expect.objectContaining({ contentMd: expect.stringContaining("改写稿") }), "auto");
    editor.command("undo");
    expect(queue.capture().fields.contentMd).toBe(entry.contentMd);

    await selectRange(0, 4);
    chooseRewrite();
    await send("再拟一稿");
    await vi.waitFor(() => expect(messages.get("thread-" + entry.id)).toHaveLength(8));
    const undoneProposal = generate.mock.calls.at(-1)![1].id;
    const pendingAccept = () => [...activePanel().querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "接受修改");
    await vi.waitFor(() => expect(pendingAccept()?.disabled).toBe(false));
    flushSync(() => {
      pendingAccept()!.click();
      editor.command("undo");
    });
    await queue.flush();
    await vi.waitFor(() => expect(updateProposal).toHaveBeenCalledWith(undoneProposal, "conflicted"));
    expect(updateProposal).not.toHaveBeenCalledWith(undoneProposal, "applied");
    expect(queue.capture().fields.contentMd).toBe(entry.contentMd);
    click("对话记录");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("暂无对话"));
    click("对话记录");
    click("新对话");
    const firstThread = "thread-" + entry.id;
    await vi.waitFor(() => expect(threads.get(firstThread)?.archived).toBe(true));
    await vi.waitFor(() => expect(activePanel().textContent).not.toContain("精简措辞"));
    const savedThread = firstThread + "-1";
    blockedThreadWrites = savedThread;
    await send("另一轮对话");
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "chat", prompt: "另一轮对话", history: [] }));
    const reply = "新对话回复\n\n| 功能 | 状态 |\n| --- | --- |\n| 对话恢复 | 正常 |";
    finish({ reply });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("新对话回复"));
    const scroll = activePanel().querySelector('[role="region"][aria-label="表格"]');
    expect(scroll?.getAttribute("tabindex")).toBe("0");
    expect(scroll?.querySelector("table thead th")?.textContent).toBe("功能");
    expect(scroll?.querySelector("table tbody td")?.textContent).toBe("对话恢复");
    const copyText = vi.spyOn(desktop, "copyText").mockResolvedValue();
    const [copyUser, copyAssistant] = activePanel().querySelectorAll<HTMLButtonElement>('.ai-turn button[aria-label="复制"]');
    const timestamps = [copyUser.previousElementSibling, copyAssistant.previousElementSibling];
    expect(copyUser?.querySelector("svg.lucide-copy")).not.toBeNull();
    expect(copyAssistant?.querySelector("svg.lucide-copy")).not.toBeNull();
    flushSync(() => copyUser.click());
    await vi.waitFor(() => expect(copyUser.querySelector("svg.lucide-check")).not.toBeNull());
    expect(copyUser.parentElement?.querySelector('[role="status"]')?.textContent).toBe("已复制");
    expect(copyAssistant.getAttribute("aria-label")).toBe("复制");
    flushSync(() => copyAssistant.click());
    await vi.waitFor(() => expect(copyAssistant.querySelector("svg.lucide-check")).not.toBeNull());
    expect(copyText.mock.calls).toEqual([["另一轮对话"], [reply]]);
    await vi.waitFor(() => {
      expect(copyUser.getAttribute("aria-label")).toBe("复制");
      expect(copyAssistant.getAttribute("aria-label")).toBe("复制");
    }, { timeout: 1800 });
    click("对话记录");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("怎么改？"));
    expect(activePanel().textContent).not.toContain("另一轮对话");
    await vi.waitFor(() => expect(saveMessage.mock.calls.filter(([id]) => id === savedThread).length).toBeGreaterThanOrEqual(2));
    expect(messages.get(savedThread)).toHaveLength(0);
    blockedThreadWrites = undefined;
    click("怎么改？");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("可以加一条例子。"));
    expect(activePanel().querySelector('.ai-proposal-title [aria-label="已接受"] svg.lucide-check')).not.toBeNull();
    expect(updateThread).toHaveBeenCalledWith(firstThread, { archived: false });
    expect(threads.get(savedThread)?.archived).toBe(true);
    expect(messages.get(savedThread)).toHaveLength(2);
    for (const [index, time] of timestamps.entries()) {
      const date = messages.get(savedThread)![index].message.createdAt;
      expect(time?.getAttribute("datetime")).toBe(date.toISOString());
      expect(time?.textContent).toBe(messageTimeLabel(date));
    }
    await send("继续刚才的话题");
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)).toEqual([
      firstThread,
      expect.objectContaining({ prompt: "继续刚才的话题", history: [{ user: "怎么改？", assistant: "可以加一条例子。" }] }),
      expect.any(Function),
    ]));
    finish({ reply: "这是旧会话的续聊回复。" });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("这是旧会话的续聊回复。"));
    await vi.waitFor(() => expect(messages.get(firstThread)?.at(-1)?.message.content).toEqual([
      { type: "text", text: "这是旧会话的续聊回复。" },
    ]));

    const restoredCount = generate.mock.calls.length;
    render(queue, 2);
    await vi.waitFor(() => expect(activePanel().textContent).toContain("开始新对话"));
    click("对话记录");
    await vi.waitFor(() => expect(activePanel().querySelectorAll(".ai-thread-list li")).toHaveLength(2));
    click("怎么改？");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("这是旧会话的续聊回复。"));
    expect(activePanel().textContent).toContain("精简措辞");
    expect(activePanel().textContent).toContain("原选区已失效");
    expect(generate).toHaveBeenCalledTimes(restoredCount);

    const accepted = activePanel().querySelector('[aria-label="已接受"]')!.closest(".ai-suggestion")!;
    const regenerate = [...accepted.querySelectorAll("button")].find(button => button.textContent === "重新生成")!;
    await selectRange(2, 2);
    flushSync(() => regenerate.click());
    expect(activePanel().querySelector('[role="alert"]')?.textContent).toBe("请在正文中选中文字");
    expect(generate).toHaveBeenCalledTimes(restoredCount);
    await selectRange(2, 4);
    expect(regenerate.disabled).toBe(false);
    flushSync(() => regenerate.click());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(restoredCount + 1));
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "rewrite", prompt: "只改选区", text: "正文" });
    const regenerated = () => [...activePanel().querySelectorAll(".ai-suggestion")].at(-1)!;
    const discard = await vi.waitFor(() => {
      const button = [...regenerated().querySelectorAll("button")].find(item => item.textContent === "放弃");
      expect(button?.disabled).toBe(false);
      return button!;
    });
    expect([...regenerated().querySelectorAll("button")].find(button => button.textContent === "接受修改")?.disabled).toBe(false);
    expect(queue.capture().fields.contentMd).toBe(entry.contentMd);
    flushSync(() => discard.click());
    await vi.waitFor(() => expect(regenerated().querySelector('.ai-proposal-title [aria-label="已放弃"] svg.lucide-x')).not.toBeNull());
    expect(regenerated().textContent).not.toContain("已放弃");
    expect([...regenerated().querySelectorAll("button")].find(button => button.textContent === "重新生成")?.disabled).toBe(false);
    const count = generate.mock.calls.length;

    click("新对话");
    await vi.waitFor(() => expect(threads.get(firstThread)?.archived).toBe(true));
    render(queue, 3);
    await vi.waitFor(() => expect(activePanel().textContent).toContain("开始新对话"));
    click("对话记录");
    await vi.waitFor(() => expect(activePanel().querySelectorAll(".ai-thread-list time")).toHaveLength(2));
    click("删除对话：另一轮对话");
    await vi.waitFor(() => expect(removeThread).toHaveBeenCalledWith("thread-" + entry.id + "-1"));
    await vi.waitFor(() => expect(activePanel().querySelectorAll(".ai-thread-list li")).toHaveLength(1));
    expect(activePanel().textContent).toContain("怎么改？");
    click("删除对话：怎么改？");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("暂无对话"));
    expect(removeThread).toHaveBeenLastCalledWith("thread-" + entry.id);

    await selectRange(0, 2);
    const { original, headingPath } = editor.captureContext("selection")!;
    render(queue, 3, { original, headingPath });
    const removeSelection = "移除选区引用：这段";
    await vi.waitFor(() => expect(activePanel().querySelector(`[aria-label="${removeSelection}"]`)?.textContent).toBe("这段×"));
    expect(generate).toHaveBeenCalledTimes(count);
    expect(activePanel().querySelector('[aria-label="对话记录"]')?.getAttribute("aria-pressed")).toBe("false");
    click(removeSelection);
    expect(activePanel().textContent).toContain("不引用正文");

    render(queue, 3, { original, headingPath });
    await selectRange(3, 3);
    await send("解释这段");
    const attachedRequest = { operation: "chat", text: "这段", prompt: "解释这段", context: { scope: "selection", headingPath: ["一"] } };
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)?.[1]).toMatchObject(attachedRequest));
    expect(activePanel().querySelector('blockquote[aria-label="所选内容"]')?.textContent).toBe("这段");
    expect(activePanel().querySelector(`[aria-label="${removeSelection}"]`)).toBeNull();
    emit({ type: "delta", text: "截断前的内容" });
    const partial = "截断前的内容，且最后一段通过命令返回";
    fail({ code: "AI_TRUNCATED", message: "回复未完成，已达到模型输出长度限制", partial });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("回复未完成，已达到模型输出长度限制"));
    emit({ type: "delta", text: "，且最后一段通过命令返回" });
    const incompleteThread = generate.mock.calls.at(-1)![0];
    await vi.waitFor(() => expect(messages.get(incompleteThread)?.at(-1)?.message.content)
      .toEqual([{ type: "text", text: partial }]));
    expect(activePanel().textContent).toContain(partial);
    click("重试");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(count + 2));
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject(attachedRequest);
    finish({ reply: "解释完成" });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("解释完成"));

    const update = updateThread.getMockImplementation()!;
    let completeArchive: () => void;
    updateThread.mockImplementationOnce(async (id, change) => {
      await new Promise<void>(resolve => { completeArchive = resolve; });
      await update(id, change);
    });
    click("新对话");
    await vi.waitFor(() => expect(completeArchive).toBeTypeOf("function"));
    await selectRange(0, 2);
    render(queue, 3, { original, headingPath });
    completeArchive!();
    await vi.waitFor(() => {
      expect(activePanel().querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')?.disabled).toBe(false);
      expect(activePanel().textContent).not.toContain("解释完成");
      expect(activePanel().querySelector(`[aria-label="${removeSelection}"]`)).not.toBeNull();
    });

    chooseRewrite();
    await send("精简这一处");
    const latestProposalAction = (label: string) => [...regenerated().querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === label);
    await vi.waitFor(() => expect(latestProposalAction("放弃")?.disabled).toBe(false));
    flushSync(() => latestProposalAction("放弃")!.click());
    await vi.waitFor(() => expect(regenerated().querySelector('[aria-label="已放弃"]')).not.toBeNull());
    await selectRange(4, 4);
    flushSync(() => latestProposalAction("重新生成")!.click());
    await vi.waitFor(() => expect(latestProposalAction("接受修改")?.disabled).toBe(false));
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "rewrite", prompt: "精简这一处", text: "这段" });

    queue.edit({ tags: ["原有标签", "Markdown"] });
    expect(await queue.flush()).toBe(true);
    await send("给这篇文章补上标签和摘要");
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({
      entryId: entry.id, operation: "chat", context: { scope: "document" },
      properties: { fields: ["tags", "summary"], tagSuggestions: ["原有标签", "Markdown", "其他段落"] },
    }));
    expect([...activePanel().querySelectorAll(".ai-user-citation + .ai-user-message")].at(-1)?.previousElementSibling?.textContent).toBe("全文");
    const properties = () => [...activePanel().querySelectorAll(".ai-property-proposal")].at(-1)!;
    const apply = () => properties()?.querySelector<HTMLButtonElement>(".ai-proposal-actions button");
    await vi.waitFor(() => expect(apply()?.disabled).toBe(false));
    expect(generate.mock.calls.at(-1)?.[1].text).toContain("其他段落");
    expect(queue.snapshot().fields.summary).toBe("");
    expect(queue.snapshot().fields.tags).toEqual(["原有标签", "Markdown"]);
    const skip = [...properties().querySelectorAll("label")].find(label => label.textContent === "不采用")!;
    flushSync(() => skip.querySelector<HTMLButtonElement>('button[role="checkbox"]')!.click());
    commit.mockRejectedValueOnce(new Error("模拟属性保存失败"));
    flushSync(() => apply()!.click());
    await vi.waitFor(() => expect(apply()?.textContent).toBe("重试保存"));
    expect(queue.snapshot().fields.tags).toEqual(["原有标签", "Markdown", "写作"]);
    flushSync(() => apply()!.click());
    await vi.waitFor(() => expect(properties().textContent).toContain("已写入内容属性"));
    expect(commit.mock.calls.at(-1)?.[0]).toBe(entry.id);
    expect(queue.snapshot().fields).toMatchObject({ tags: ["原有标签", "Markdown", "写作"], summary: "新的文章摘要", title: entry.title });
    expect(other.snapshot().fields.tags).toEqual([]);

    await send("给当前文章换个标题");
    await vi.waitFor(() => expect(properties().textContent).toContain("新的文章标题"));
    await vi.waitFor(() => expect(apply()?.disabled).toBe(false));
    commit.mockRejectedValueOnce(new Error("模拟属性保存失败"));
    flushSync(() => apply()!.click());
    await vi.waitFor(() => expect(apply()?.textContent).toBe("重试保存"));
    queue.edit({ title: "手动修改后的标题" });
    expect(await queue.flush({ retry: true })).toBe(true);
    flushSync(() => apply()!.click());
    await vi.waitFor(() => expect(properties().textContent).toContain("属性已被修改，请重新生成"));
    expect(queue.snapshot().fields.title).toBe("手动修改后的标题");
    flushSync(() => apply()!.click());
    await vi.waitFor(() => expect(apply()?.textContent).toBe("写入内容属性"));
    await vi.waitFor(() => expect(apply()?.disabled).toBe(false));
    flushSync(() => apply()!.click());
    await vi.waitFor(() => expect(properties().textContent).toContain("已写入内容属性"));
    expect(queue.snapshot().fields).toMatchObject({ tags: ["原有标签", "Markdown", "写作"], summary: "新的文章摘要", title: "新的文章标题" });
  } finally {
    if (digest) Object.defineProperty(crypto, "subtle", digest); else Reflect.deleteProperty(crypto, "subtle");
    vi.restoreAllMocks();
    queue.dispose();
    other.dispose();
    for (const cached of uncached) cached.dispose();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("routes explicit property requests while keeping advice and how-to questions in chat", () => {
  expect(requestedProperties("帮我总结这篇文章的核心标签并填充到内容属性里。")).toEqual(["tags"]);
  expect(requestedProperties("为这篇文章生成标题、摘要和标签")).toEqual(["tags", "summary", "title"]);
  expect(requestedProperties("这篇文章适合哪些标签？")).toEqual([]);
  expect(requestedProperties("请问如何给文章添加标签？")).toEqual([]);
  expect(requestedProperties("你觉得怎么给这篇文章添加标签？")).toEqual([]);
  expect(requestedProperties("请不要更新这篇文章的标题和标签")).toEqual([]);
  expect(requestedProperties("给这篇文章加上标签，不要修改摘要和标题")).toEqual(["tags"]);
  expect(requestedProperties("给这篇文章补上摘要，但标题不要改")).toEqual(["summary"]);
});

it("rejects async targets after a document changes or its editor session closes", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  async function mount(session: number) {
    flushSync(() => root.render(<MarkdownEditor
      key={session} ref={value => { handle = value; }} entryId="same-entry"
      value="原稿" readOnly={false} onChange={onChange} onBlur={() => {}}
    />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    return handle!;
  }
  try {
    const first = await mount(1);
    const original = first.target();
    expect(first.replaceTarget(original, "修改")).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("same-entry", 1, "修改原稿");
    expect(first.replaceTarget(original, "过时结果")).toBe(false);
    const closed = first.target();
    const reopened = await mount(2);
    expect(first.replaceTarget(closed, "已关闭")).toBe(false);
    expect(reopened.target().localRevision).toBe(original.localRevision);
    expect(reopened.replaceTarget(original, "旧会话结果")).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("routes clipboard shortcuts to native callbacks and keeps async paste bound to the originating editor", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  let finish!: (text: string) => void;
  const clipboard = {
    read: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })),
    write: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  const detach = attachClipboard((action, target) => handle!.clipboard(action, clipboard, target), clipboard.onError);
  const onChange = vi.fn();
  async function mount(entryId: string) {
    flushSync(() => root.render(<MarkdownEditor key={entryId} ref={value => { handle = value; }} entryId={entryId}
      value="原稿" readOnly={false} onChange={onChange} onBlur={() => {}}
    />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(entryId));
  }
  function shortcut(key: string) {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
    container.querySelector(".ProseMirror")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  try {
    await mount("first");
    shortcut("v");
    expect(clipboard.read).toHaveBeenCalledOnce();
    expect(container.querySelector('.rich-paste-progress[role="status"]')?.textContent).toBe("正在粘贴…");
    expect(onChange).not.toHaveBeenCalled();
    handle!.insert("新文字");
    const pending = handle!.pendingEdits();
    expect(pending).toBeDefined();
    finish("![图](asset://asset)");
    await pending;
    expect(onChange).toHaveBeenLastCalledWith("first", 2, "新文字![图](asset://asset)原稿");
    expect(container.querySelector(".rich-paste-progress")).toBeNull();
    expect(handle!.pendingEdits()).toBeUndefined();

    shortcut("c");
    expect(clipboard.write).toHaveBeenCalledWith("新文字图原稿", expect.stringContaining("data-workbench-src"));

    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    await select(editor, 0, 2, handle!);
    shortcut("v");
    await select(editor, 1, 1, handle!);
    handle!.insert("保留");
    finish("不要覆盖");
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith("first", 3, "新保留文字![图](asset://asset)原稿");

    shortcut("v");
    await mount("second");
    onChange.mockClear();
    finish("![迟到的图](asset://late)");
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".rich-paste-progress")).toBeNull();
    const unavailable = new Error("剪贴板暂不可用");
    clipboard.read.mockRejectedValueOnce(unavailable);
    shortcut("v");
    await vi.waitFor(() => expect(clipboard.onError).toHaveBeenCalledWith(unavailable));
    await vi.waitFor(() => expect(container.querySelector(".rich-paste-progress")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    detach();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("routes Escape from the rich editor to its containing card", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onEscape = vi.fn();
  try {
    flushSync(() => root.render(<RichEditor entryId="card" value="正文" readOnly={false}
      onDocumentChanged={() => {}} onBlur={() => {}} onEscape={onEscape} />));
    await vi.waitFor(() => expect(container.querySelector(".ProseMirror")).not.toBeNull());
    const body = container.querySelector(".ProseMirror")!;
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
    expect(onEscape).toHaveBeenCalledOnce();
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, isComposing: true, bubbles: true }));
    expect(onEscape).toHaveBeenCalledOnce();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("shows rich structure and round-trips Markdown after editing an unrelated block", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onError = vi.fn();
  const markdown = [
    "引言", "# 标题", "**粗体** ~~删除~~", "- [ ] 待处理\n- [x] 已完成", "| 左 | 右 |\n| --- | ---: |\n| 一 | 二 |",
    "正文[^n] 和 <em>内嵌</em>。", "[^n]: 脚注", '<div onclick="alert(1)">保留 HTML</div>',
    ...formatFixtures.slice(0, 5).map(fixture => fixture.markdown),
    "另见[^q]。", "> [^q]: 引用内脚注", "脚注后正文",
  ].join("\n\n");
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="rich"
      value={markdown} readOnly={false} onChange={onChange} onError={onError} onBlur={() => {}} />));
    await vi.waitFor(() => {
      if (onError.mock.calls.length) throw onError.mock.calls[0][0];
      expect(handle).not.toBeNull();
    });
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    expect(editor.querySelector("h1")?.textContent).toBe("标题");
    expect(editor.querySelector("strong")?.textContent).toBe("粗体");
    expect(editor.querySelectorAll('li[data-item-type="task"]').length).toBe(2);
    expect(editor.querySelector("table tr:nth-child(2)")?.textContent).toBe("一二");
    expect(editor.querySelector("sup")?.textContent).toBe("[^n]");
    expect(editor.querySelector("blockquote dl")).toBeNull();
    expect(editor.lastElementChild?.textContent).toBe("[^q]:引用内脚注");
    expect(editor.querySelector('[data-type="html-block"]')?.textContent).toBe("保留 HTML");
    expect(editor.querySelector("[onclick], script")).toBeNull();
    expect(editor.textContent).not.toMatch(/\*\*粗体|<em>|# 标题/);
    expect(onChange).not.toHaveBeenCalled();
    handle!.insert("甲");
    const saved: string = onChange.mock.lastCall![2];
    expect(saved).toMatch(/^甲引言\n\n# 标题/m);
    expect(saved).toContain("**粗体** ~~删除~~");
    expect(saved).toContain("[x] 已完成");
    expect(saved).toMatch(/\|\s+一\s+\|\s+二\s+\|/);
    expect(saved).toContain("正文[^n] 和 <em>内嵌</em>。");
    expect(saved).toContain("[^n]: 脚注");
    expect(saved).toMatch(/脚注后正文[\s\S]+\[\^q\]: 引用内脚注$/);
    expect(saved).toContain('<div onclick="alert(1)">保留 HTML</div>');
    expect(saved).toContain("$x^2$");
    expect(saved).toContain("$$\n\\frac{a}{b}\n$$");
    expect(saved).toContain("$$a$$ 以及 $$b$$");
    expect(saved).toContain("保留 $ a $；公式 $b$。");
    expect(saved).toContain("> $$\n> x^2\n> $$");
    const fence = String.fromCharCode(96).repeat(3);
    expect(saved).toContain(fence + "mermaid\ngraph TD\nA --> B\n" + fence);
    expect(saved).toContain(fence + "text\n$$not_math$$\n" + fence);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("displays GitHub HTML images and disclosures without exposing executable content", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const release = vi.fn();
  const onError = vi.fn();
  const resolveImage = vi.fn().mockResolvedValue({ src: "blob:https://workbench.test/logo", dispose: release });
  const markdown = [
    "介绍",
    '<p><a href="./docs/guide.md"><img src="./assets/logo.png" alt="徽标" onerror="alert(1)"></a></p>',
    '<details><summary>使用方法</summary>\n\n**运行说明**\n\n</details>',
    '<table><tr><td>表格</td></tr></table>',
    '<script>alert(1)</script><iframe src="https://example.test"></iframe>',
  ].join("\n\n");
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="github-html" value={markdown} readOnly
      githubRepo="https://github.com/Owner/Repo" resolveImage={resolveImage} onError={onError}
      ref={editor => { handle = editor; }} onChange={vi.fn()} onBlur={() => {}} />));
    await vi.waitFor(() => {
      if (onError.mock.calls.length) throw onError.mock.calls[0][0];
      expect(container.querySelector('img[alt="徽标"]')?.getAttribute("src")).toBe("blob:https://workbench.test/logo");
    });
    expect(resolveImage.mock.calls).toEqual([["https://raw.githubusercontent.com/Owner/Repo/HEAD/assets/logo.png"]]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://github.com/Owner/Repo/blob/HEAD/docs/guide.md");
    expect(container.querySelector("details summary")?.textContent).toBe("使用方法");
    expect(container.querySelector("details strong")?.textContent).toBe("运行说明");
    expect(container.querySelector("td")?.textContent).toBe("表格");
    expect(container.querySelector("[onerror], script, iframe")).toBeNull();
    expect(handle!.captureMarkdown().markdown).toBe(markdown);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
});

it("edits Markdown inside a collapsed GitHub disclosure and preserves the wrapper on save", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onError = vi.fn();
  const onChange = vi.fn();
  const markdown = [
    "<details open>\n\n<summary>下载</summary>\n<br/>",
    "下载说明",
    "</details>",
    "<details onclick=\"alert(1)\">\n<summary><strong>开源范围</strong></summary>\n<br/>",
    "**许可协议**，请从 [Releases](https://github.com/CM-idea/SnowAir/releases) 下载 `SnowAir.exe`。",
    "</details>",
    "后续正文",
  ].join("\n\n");
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="disclosure" value={markdown} readOnly={false}
      ref={editor => { handle = editor; }} onChange={onChange} onError={onError} onBlur={() => {}} />));
    await vi.waitFor(() => {
      if (onError.mock.calls.length) throw onError.mock.calls[0][0];
      expect(handle).not.toBeNull();
    });
    const [download, license] = container.querySelectorAll<HTMLDetailsElement>(".rich-disclosure");
    expect(download.open).toBe(true);
    expect(download.querySelector("summary")?.textContent).toBe("下载");
    expect(license.open).toBe(false);
    expect(license.hasAttribute("onclick")).toBe(false);
    expect(license.querySelector("summary strong")?.textContent).toBe("开源范围");
    license.querySelector("summary")!.click();
    expect(license.open).toBe(true);
    expect(license.querySelector("p strong")?.textContent).toBe("许可协议");
    expect(license.querySelector("p a")?.getAttribute("href")).toBe("https://github.com/CM-idea/SnowAir/releases");
    const code = license.querySelector("p code")!;
    expect(code.textContent).toBe("SnowAir.exe");
    const text = [...license.querySelector("p")!.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!;
    handle!.focus();
    document.getSelection()!.setBaseAndExtent(text, 1, text, 3);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.selectionText()).toBe("请从"));
    handle!.insert("可直接前往");
    const saved: string = onChange.mock.lastCall![2];
    expect(saved).toContain("**许可协议**，可直接前往 [Releases]");
    expect(saved).toMatch(/<\/details>\n\n后续正文$/);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("pastes sanitized rich HTML, honors plain paste, and gates editing in read-only mode", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const clipboard = {
    read: vi.fn().mockResolvedValueOnce({
      html: '<p><strong>粗体</strong><a href="javascript:alert(1)">链接</a><img src="data:image/png,x" onerror="alert(1)" alt="坏图"><script>alert(1)</script></p>',
    }).mockResolvedValueOnce("**纯文本**"),
    write: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  let handle: MarkdownEditorHandle | null = null;
  function mount(readOnly: boolean) {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="clipboard"
      value="" readOnly={readOnly} onChange={onChange} onBlur={() => {}} />));
  }
  try {
    mount(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("clipboard", 1, "**粗体**链接坏图"));
    expect(editor.querySelector("strong")?.textContent).toBe("粗体");
    expect(editor.querySelector("a, img, script")).toBeNull();
    handle!.clipboard("paste", clipboard, undefined, true);
    await vi.waitFor(() => expect(editor.textContent).toBe("粗体链接坏图**纯文本**"));
    expect(clipboard.read).toHaveBeenLastCalledWith(true);
    expect(editor.querySelectorAll("strong")).toHaveLength(1);
    mount(true);
    const revision = handle!.target().localRevision;
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    handle!.command("selectAll");
    expect(handle!.hasSelection()).toBe(true);
    handle!.command("heading1");
    handle!.insert("隐藏输入");
    expect(handle!.replaceTarget(handle!.target(), "不应写入")).toBe(false);
    handle!.clipboard("cut", clipboard);
    handle!.clipboard("paste", clipboard);
    handle!.clipboard("copy", clipboard);
    expect(clipboard.read).toHaveBeenCalledTimes(2);
    expect(clipboard.write).toHaveBeenCalledExactlyOnceWith("粗体链接坏图**纯文本**", expect.stringContaining("<strong>粗体</strong>"));
    expect(handle!.target().localRevision).toBe(revision);
    expect(editor.querySelector("h1")).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each([
  ["**项目仓库： **", " ", "", "项目仓库："],
  ["__ 项目仓库：__", " ", "", "项目仓库："],
  ["**项目仓库： **", "仓库： ", "地址：", "项目地址："],
])("renders existing bold markup %s after replacing %j with %j", async (source, changed, replacement, title) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const tail = " https://github.com/example/repo";
  const clipboard = { read: async () => source + tail, write: vi.fn(), onError: vi.fn() };
  try {
    flushSync(() => root.render(<RichEditor entryId="repair-bold" value="" readOnly={false}
      onDocumentChanged={() => {}} onBlur={() => {}} ref={value => { handle = value; }} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector(".ProseMirror")!;
    const paragraphText = () => {
      const paragraph = editor.querySelector("p")?.cloneNode(true) as HTMLParagraphElement | undefined;
      paragraph?.querySelectorAll(".rich-markdown-syntax").forEach(marker => marker.remove());
      return paragraph?.textContent;
    };
    handle!.focus();
    expect(handle!.clipboard("paste", clipboard)).toBe(true);
    await vi.waitFor(() => expect(paragraphText()).toBe(source + tail));
    expect(editor.querySelector("strong")).toBeNull();
    const paragraph = editor.querySelector("p")!;
    const text = paragraph.firstChild as Text;
    const start = source.indexOf(changed);
    await select(editor as HTMLElement, start, start + changed.length, handle!);
    const later = Date.now() + 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      text.replaceData(start, changed.length, replacement);
      document.getSelection()!.collapse(text, start + replacement.length);
      await vi.waitFor(() => expect(editor.querySelector("strong")?.textContent).toBe(title));
    } finally {
      clock.mockRestore();
    }
    expect(editor.querySelector("a")?.getAttribute("href")).toBe(tail.trim());
    expect(handle!.captureMarkdown().markdown).toContain(source.replace(changed, replacement));
    handle!.command("undo");
    expect(editor.querySelector("strong")).toBeNull();
    expect(paragraphText()).toBe(source + tail);
    handle!.command("redo");
    expect(editor.querySelector("strong")?.textContent).toBe(title);
    expect(clipboard.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("renders Markdown copied with a plain HTML representation and keeps explicitly plain paste literal", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const source = "# 标题\n\n**目标：** 正文\n\n- 第一项";
  const read = vi.fn().mockResolvedValueOnce({
    html: "<div># 标题</div><div><br></div><div>**目标：** 正文</div><div>- 第一项</div>", text: source,
  }).mockResolvedValueOnce({ html: "<blockquote>已排版</blockquote>", text: "# 普通副本" })
    .mockResolvedValueOnce({ html: "<pre><code class='language-markdown'># 单块标题</code></pre>", text: "# 单块标题" })
    .mockResolvedValueOnce({ html: "<pre><code class='language-bash'># 字面注释</code></pre>", text: "# 字面注释" })
    .mockResolvedValueOnce({ html: "<p><span style='font-weight: 700'># 字面标记</span></p>", text: "# 字面标记" })
    .mockResolvedValueOnce({ html: "<p><strong># 标题</strong></p><p>**<strong>目标：</strong>** 正文</p><p><span style='font-style: italic'>- 第一项</span></p>", text: source })
    .mockResolvedValueOnce({ html: "<p><strong>1. 事项</strong></p><p><a href='https://example.com/'>详情</a></p>", text: "1. 事项\n\n详情" })
    .mockResolvedValueOnce({ html: "<p><strong># 专题</strong></p><p>- 项目</p><p><a href='https://example.com/'>详情</a></p>", text: "# 专题\n\n- 项目\n\n详情" })
    .mockResolvedValueOnce(source);
  const clipboard = { read, write: vi.fn(), onError: vi.fn() };
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="markdown-paste"
      value="" readOnly={false} onChange={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector(".ProseMirror")!;
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("h1")?.textContent).toBe("标题"));
    expect(editor.querySelector("strong")?.textContent).toBe("目标：");
    expect(editor.querySelector("li")?.textContent).toBe("第一项");

    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("blockquote")?.textContent).toBe("已排版"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("h1")?.textContent).toBe("单块标题"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector('pre[data-language="bash"] > code')?.textContent).toBe("# 字面注释"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("strong")?.textContent).toBe("# 字面标记"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("h1")?.textContent).toBe("标题"));
    expect(editor.querySelector("strong")?.textContent).toBe("目标：");
    expect(editor.querySelector("li")?.textContent).toBe("第一项");
    for (const label of ["1. 事项", "# 专题"]) {
      handle!.command("selectAll");
      handle!.clipboard("paste", clipboard);
      await vi.waitFor(() => expect(editor.querySelector("strong")?.textContent).toBe(label));
      expect(editor.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
      expect(editor.querySelector("h1, ol, ul")).toBeNull();
    }
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard, undefined, true);
    await vi.waitFor(() => expect(editor.querySelector("p")?.textContent).toBe("# 标题"));
    expect(editor.querySelector("h1, strong, li")).toBeNull();
    expect(clipboard.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("expands replace from the find overlay and returns focus to the editor on Escape", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const count = () => container.querySelector("output")?.textContent;
  const coordinates = vi.spyOn(EditorView.prototype, "coordsAtPos").mockImplementation(pos => ({
    top: pos > 10 ? 420 : 100, bottom: pos > 10 ? 440 : 120, left: 10, right: 40,
  }));
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  function enter(field: HTMLInputElement, value: string) {
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  try {
    flushSync(() => root.render(<Theme><MarkdownEditor ref={value => { handle = value; }} entryId="find"
      value={"段落 旧词\n\n再次出现 旧词"} readOnly={false} onChange={onChange} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const scroll = container.querySelector<HTMLElement>(".editor-scroll")!;
    scroll.getBoundingClientRect = () => new DOMRect(0, 0, 500, 350);
    flushSync(() => handle!.search());
    expect(document.activeElement).toBe(input("查找"));
    expect(input("替换")).toBeNull();
    expect(scroll.style.getPropertyValue("--find-clearance")).toBe("");
    enter(input("查找"), "旧词");
    expect(count()).toBe("1 / 2");
    flushSync(() => button("下一处").click());
    expect(count()).toBe("2 / 2");
    expect(scroll.scrollTop).toBeGreaterThan(0);
    flushSync(() => button("展开替换").click());
    flushSync(() => button("全部替换").focus());
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("全部替换"));
    enter(input("替换"), "新词");
    flushSync(() => button("全部替换").click());
    expect(onChange).toHaveBeenLastCalledWith("find", 1, "段落 新词\n\n再次出现 新词");
    expect(count()).toBe("无匹配");
    flushSync(() => button("关闭查找").focus());
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("关闭查找"));
    flushSync(() => button("关闭查找").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(container.querySelector('[role="search"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".ProseMirror"));
  } finally {
    coordinates.mockRestore();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("limits match decorations while navigation and replacement cover the entire document", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const body = Array.from({ length: 300 }, () => "第一处旧词，第二处旧词。").join("\n\n");
  let handle: MarkdownEditorHandle | null = null;
  const count = () => container.querySelector("output")?.textContent;
  const click = (label: string) => flushSync(() => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const enter = (label: string, value: string) => flushSync(() => {
    const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  try {
    flushSync(() => root.render(<Theme><RichEditor entryId="many-matches" value={body} readOnly={false}
      ref={editor => { handle = editor; }} onDocumentChanged={() => {}} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    flushSync(() => handle!.search());
    enter("查找", "旧词");
    expect(count()).toBe("1 / 600");
    expect(container.querySelectorAll(".ProseMirror-search-match, .ProseMirror-active-search-match").length).toBeLessThanOrEqual(200);
    click("上一处");
    expect(count()).toBe("600 / 600");
    expect(container.querySelector(".ProseMirror > p:last-child .ProseMirror-active-search-match")?.textContent).toBe("旧词");
    click("展开替换");
    enter("替换", "新词");
    click("全部替换");
    expect(handle!.captureMarkdown().markdown).toBe(body.replaceAll("旧词", "新词"));
    expect(count()).toBe("无匹配");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("highlights regex lookahead and replaces an overlapping match selected by the search", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const click = (label: string) => flushSync(() => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const enter = (label: string, value: string) => flushSync(() => {
    const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    flushSync(() => root.render(<Theme><RichEditor entryId="regex-search" value="foobar banana 😃" readOnly={false}
      ref={editor => { handle = editor; }} onDocumentChanged={() => {}} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    flushSync(() => handle!.search());
    click("正则表达式");
    enter("查找", "foo(?=bar)");
    expect(container.querySelector(".ProseMirror-active-search-match")?.textContent).toBe("foo");
    enter("查找", "(?=.)");
    expect(container.querySelector("output")?.textContent).toMatch(/\/ 15$/);
    click("关闭查找");
    await select(container, 10, 10, handle!);
    flushSync(() => handle!.search());
    enter("查找", "ana");
    expect(handle!.target()).toMatchObject({ from: 11, original: "ana" });
    click("展开替换");
    enter("替换", "X");
    click("替换当前匹配");
    expect(handle!.captureMarkdown().markdown).toBe("foobar banX 😃");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("recomputes following lines and link citations when a structured block is inserted at the top", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const lines = () => [...container.querySelectorAll<HTMLElement>(".rich-code-line-number")].map(node => Number(node.dataset.editorLine));
  const citations = () => [...container.querySelectorAll(".rich-link-citation")].map(node => node.textContent);
  try {
    flushSync(() => root.render(<RichEditor entryId="structural-decorations"
      value={"起始\n\n[后文](https://example.com/second)\n\n```js\nlet second = true;\n```"}
      readOnly={false} lineNumbers convertLinks ref={editor => { handle = editor; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const prior = lines();
    expect(prior).toHaveLength(1);
    expect(citations()).toEqual(["[^1]"]);
    await select(container, 0, 0, handle!);
    handle!.insert("[前文](https://example.com/first)\n\n```js\nlet first = true;\nlet ready = true;\n```\n\n引言");
    expect(lines()).toHaveLength(3);
    expect(lines().at(-1)).toBeGreaterThan(prior[0]);
    expect(citations()).toEqual(["[^1]", "[^2]"]);
    expect(container.querySelector(".rich-link-notes")?.textContent).toContain("前文");
    expect(container.querySelector(".rich-link-notes")?.textContent).toContain("后文");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("round-trips formula, task, callout and footnote metadata through native rich clipboard HTML", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const clipboard = {
    read: vi.fn(),
    write: vi.fn<(text: string, html?: string) => Promise<void>>().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  async function mount(entryId: string, markdown: string) {
    flushSync(() => root.render(<MarkdownEditor key={entryId} ref={value => { handle = value; }} entryId={entryId}
      value={markdown} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
  }
  try {
    const source = "- [x] 已完成\n\n==高亮== 与公式 $x^2$，详见[^1]。\n\n[^1]: 说明\n\n> \\[!INFO]\n\n末段正文";
    await mount("source", source);
    expect(container.querySelector(".ProseMirror")?.lastElementChild?.getAttribute("data-type")).toBe("footnote_definition");
    handle!.command("selectAll");
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write).toHaveBeenLastCalledWith(source);
    const editor = container.querySelector(".ProseMirror")!;
    const first = editor.querySelector("li p")!.firstChild!;
    const last = editor.querySelector("dl dd p")!.lastChild!;
    document.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.target().from).toBeGreaterThan(0));
    handle!.clipboard("copy", clipboard);
    const html = clipboard.write.mock.lastCall![1];
    expect(html).toContain('data-math="math_inline"');
    await mount("target", "目标原稿");
    clipboard.read.mockResolvedValue({ html: html +
      '<div data-type="html-block" data-value="&lt;script&gt;alert(1)&lt;/script&gt;">嵌入的 HTML</div>' +
      '<p><span data-math="math_inline" data-display="true" data-value="a$$&#10;&#10;&lt;img src=x onerror=1&gt;&#10;&#10;$$b">行内公式</span></p>' +
      '<div data-math="math_block" data-value="a&#10;$$&#10;http://example.com">块公式</div>' });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const markdown = onChange.mock.lastCall![2] as string;
    expect(markdown).toContain("[x] 已完成");
    expect(markdown).toContain("==高亮==");
    expect(markdown).toContain("$x^2$，详见[^1]");
    expect(markdown).toContain("> \\[!INFO]");
    expect(markdown.trimEnd().endsWith("[^1]: 说明")).toBe(true);
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("onerror");
    expect(markdown).not.toContain("http://example.com");
    expect(clipboard.onError).not.toHaveBeenCalled();
    handle!.command("undo");
    expect(onChange.mock.lastCall![2]).toBe("目标原稿");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("replaces only the original document images after all hosting URLs have resolved", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const original = "正文\n\n![一](asset://same)\n\n![二](asset://same)\n\n![三](asset://other)\n\n![已托管](https://cdn.example.test/photos/existing.png)";
  const choose = (src: string) => src.startsWith("asset://");
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="hosting" value={original} ref={value => { handle = value; }}
      readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const uploading = () => container.querySelectorAll(".rich-image-upload:not([hidden])").length;
    const fail = vi.fn().mockResolvedValueOnce("https://cdn.example.test/photos/same.png").mockRejectedValueOnce(new Error("上传失败"));
    const failedTask = handle!.hostImages!(fail, choose);
    expect(uploading()).toBe(2);
    await expect(failedTask).rejects.toThrow("上传失败");
    expect(uploading()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    const upload = vi.fn(async (src: string) => `https://cdn.example.test/photos/${src.slice(8)}.png`);
    const task = handle!.hostImages!(upload, choose);
    handle!.insert("新写的");
    expect(await task).toBe(3);
    expect(uploading()).toBe(0);
    expect(upload.mock.calls).toEqual([["asset://same"], ["asset://other"]]);
    expect(onChange.mock.lastCall![2]).toBe(`新写的${original.replaceAll("asset://same", "https://cdn.example.test/photos/same.png").replace("asset://other", "https://cdn.example.test/photos/other.png")}`);
    handle!.command("undo");
    expect(onChange.mock.lastCall![2]).toBe(`新写的${original}`);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("runs body format and insert commands while retaining the selected text on right click", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  async function mount(key: string) {
    flushSync(() => root.render(<MarkdownEditor key={key} ref={value => { handle = value; }} entryId={key}
      value="正文" readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(key));
    return container.querySelector<HTMLElement>(".ProseMirror")!;
  }
  try {
    const editor = await mount("marks");
    await select(editor, 0, 2, handle!);
    handle!.prepareContext(new MouseEvent("contextmenu", { button: 2 }));
    expect(handle!.target().original).toBe("正文");
    handle!.command("bold");
    expect(editor.querySelector("strong")?.textContent).toBe("正文");
    handle!.command("italic");
    expect(editor.querySelector("em")?.textContent).toBe("正文");
    handle!.command("strike");
    expect(editor.querySelector("del")?.textContent).toBe("正文");
    handle!.command("link", "https://example.com");
    expect(editor.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    handle!.command("link", "https://example.com/updated");
    expect(editor.querySelector("a")?.getAttribute("href")).toBe("https://example.com/updated");
    const blocks: [EditorCommand, string, RegExp][] = [
      ["heading2", "h2", /^## 正文$/],
      ["taskList", 'li[data-checked="false"]', /\[ \] 正文/],
      ["bulletList", "ul > li", /^[-*+] 正文$/],
      ["orderedList", "ol > li", /^1\. 正文$/],
      ["quote", "blockquote", /^> 正文$/],
      ["table", "table", /\|\s+\|/],
      ["horizontalRule", "hr", /(?:^|\n)(?:---|\*\*\*)(?:\n|$)/],
      ["codeBlock", "pre > code", /\x60\x60\x60\n正文\n\x60\x60\x60/],
      ["mathBlock", "div.rich-formula", /\$\$\nx\n\$\$/],
    ];
    for (const [command, selector, pattern] of blocks) {
      const body = await mount(command);
      handle!.command(command);
      expect(body.querySelector(selector), command).not.toBeNull();
      expect(onChange.mock.lastCall![2], command).toMatch(pattern);
    }
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("edits footnotes at their reference and writes the definition at the bottom on submit", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const input = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="脚注内容"]')!;
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".rich-footnote-actions button"))
    .find(node => node.textContent === label)!;
  function fill(text: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
    flushSync(() => input().dispatchEvent(new Event("input", { bubbles: true })));
  }
  try {
    flushSync(() => root.render(<Theme><MarkdownEditor ref={value => { handle = value; }} entryId="footnotes"
      value={"正文[^N]\n\n末段\n\n[^n]: 旧来源"} readOnly={false} onChange={onChange} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    await select(editor, 2, 2, handle!);
    flushSync(() => handle!.command("footnote"));
    expect(document.querySelector(".rich-footnote-popover code")?.textContent).toBe("[^1]:");
    expect(container.querySelector(".rich-footnote-anchor")).not.toBeNull();
    expect(editor.querySelectorAll("sup")).toHaveLength(1);
    fill("取消的内容");
    flushSync(() => button("取消").click());
    expect(onChange).not.toHaveBeenCalled();

    flushSync(() => handle!.command("footnote"));
    fill("**新来源**");
    expect(onChange).not.toHaveBeenCalled();
    flushSync(() => button("插入").click());
    expect(editor.querySelector("p sup")?.textContent).toBe("[^1]");
    expect(editor.lastElementChild?.textContent).toBe("[^1]:新来源");
    expect(onChange.mock.lastCall![2]).toBe("正文[^1][^N]\n\n末段\n\n[^n]: 旧来源\n\n[^1]: **新来源**");
    expect(editor.querySelector("p")?.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);

    flushSync(() => editor.querySelector<HTMLElement>('sup[data-label="N"]')!.click());
    expect(input().value).toBe("旧来源");
    expect(document.querySelector(".rich-footnote-popover code")?.textContent).toBe("[^n]:");
    fill("补充来源");
    flushSync(() => button("保存").click());
    expect(editor.querySelectorAll("sup")).toHaveLength(2);
    expect(onChange.mock.lastCall![2]).toContain("[^n]: 补充来源");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("opens the footnote editor after pasting syntax-highlighted Markdown without a heading", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const url = "https://example.com/source";
  const source = `出处[^资料]。\n\n[^资料]: ${url}`;
  const clipboard = {
    read: vi.fn().mockResolvedValue({
      text: source,
      html: `<p>出处<strong>[^资料]</strong>。</p><p><strong>[^资料]:</strong> <a href="${url}">${url}</a></p>`,
    }),
    write: vi.fn(),
    onError: vi.fn(),
  };
  try {
    flushSync(() => root.render(<Theme><MarkdownEditor ref={value => { handle = value; }} entryId="pasted-footnote"
      value="" readOnly={false} onChange={onChange} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.clipboard("paste", clipboard);
    const reference = () => container.querySelector<HTMLElement>('sup[data-type="footnote_reference"][data-label="资料"]');
    await vi.waitFor(() => expect(reference()).not.toBeNull());
    expect(container.querySelector('dl[data-label="资料"] a')?.getAttribute("href")).toBe(url);
    expect(onChange.mock.lastCall![2]).toContain("[^资料]:");
    flushSync(() => reference()!.click());
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="脚注内容"]')?.value).toContain(url);
    expect(clipboard.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("preserves callout markers and displays the complete Markdown source on formula focus", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "开头 $E = mc^2$\n\n> [!INFO]\n> 说明内容\n\n> [!warning] **注意**\n> 警告内容\n\n> \\[!INFO]\n\n$$\nx^2\n$$";
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="callouts-and-math"
      value={markdown} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    expect(editor.querySelector('[data-callout="info"] [data-callout-label]')?.getAttribute("data-callout-label")).toBe("信息");
    expect(editor.querySelector('[data-callout="warning"] strong')?.textContent).toBe("注意");
    expect(editor.querySelector("blockquote[data-literal-callout]:not([data-callout])")?.textContent).toBe("[!INFO]");
    const [inline, block] = editor.querySelectorAll<HTMLButtonElement>(".rich-formula-trigger");
    inline.focus();
    const field = editor.querySelector<HTMLInputElement>("input.rich-formula-source")!;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("$E = mc^2$");
    field.value = "$$不完整$";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(field.hidden).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    field.value = "$E = mc^3$";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onChange.mock.lastCall![2]).toBe(markdown.replace("mc^2", "mc^3"));
    block.focus();
    const area = editor.querySelector<HTMLTextAreaElement>("textarea.rich-formula-source")!;
    expect(document.activeElement).toBe(area);
    expect(block.tabIndex).toBe(-1);
    expect(area.value).toBe("$$\nx^2\n$$");
    expect(area.nextElementSibling?.className).toBe("rich-graphic-preview");
    area.value = "$$\nx^3\n$$";
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(area.hidden).toBe(true);
    expect(block.tabIndex).toBe(0);
    expect(onChange.mock.calls).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("converts a clicked link permanently and presents current and pasted links reversibly", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const clipboard = { read: vi.fn(), write: vi.fn(), onError: vi.fn() };
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "[另一篇](https://example.com/other) [**重点**内容](https://example.com/source) [文内](#heading)\n\n正文[^1]\n\n[^1]: 原脚注";
  const original = markdown.replace("[**重点**内容](https://example.com/source)", "**[重点](https://example.com/source)**[内容](https://example.com/source)");
  const render = (convertLinks: boolean) => flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }}
    entryId="link-footnotes" value={markdown} readOnly={false} convertLinks={convertLinks} onChange={onChange} onBlur={() => {}} />));
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    const target = editor.querySelector('a[href$="/source"]')!;
    const click = new MouseEvent("contextmenu", { button: 2, bubbles: true });
    target.dispatchEvent(click);
    const action = handle!.prepareContext(click);
    if (!action || typeof action !== "object" || !("kind" in action) || action.kind !== "link") throw new Error("expected link context");
    action.convert();
    const saved = () => onChange.mock.lastCall![2] as string;
    expect(saved()).toContain("[另一篇](https://example.com/other) **重点**内容[^2] [文内](#heading)");
    expect(saved()).toContain(String.raw`[^2]: 重点内容： https\://example.com/source`);
    expect(editor.lastElementChild?.querySelector("a")).toBeNull();
    expect(editor.lastElementChild?.textContent).toContain("重点内容： https://example.com/source");
    handle!.command("undo");
    expect(saved()).toBe(original);

    const preview = handle!.linkFootnoteMarkdown(original);
    expect(preview).toContain("另一篇[^2] **重点**内容[^3] [文内](#heading)");
    expect(preview).toContain("[^1]: 原脚注");
    expect(preview).toContain(String.raw`[^2]: 另一篇： https\://example.com/other`);
    expect(preview).toContain(String.raw`[^3]: 重点内容： https\://example.com/source`);
    expect(handle!.linkFootnoteMarkdown(preview)).toBe(preview);
    expect(saved()).toBe(original);

    const changes = onChange.mock.calls.length;
    render(true);
    expect(editor.querySelectorAll(".rich-link-citation")).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(changes);
    await select(editor, 0, 0, handle!);
    clipboard.read.mockResolvedValueOnce("[来源](https://example.com/md) [另一份](https://example.com/second)\n\n已有[^2]\n\n[^2]: [旧地址](https://example.com/existing)");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(saved()).toContain("[来源](https://example.com/md)"));
    const projected = () => handle!.linkFootnoteMarkdown(saved());
    expect(projected()).toMatch(/来源\[\^\d+\] 另一份\[\^\d+\]/);
    expect(saved()).toContain("[^2]: [旧地址](https://example.com/existing)");
    handle!.command("undo");
    expect(saved()).toBe(original);

    handle!.command("link", "https://example.com/inserted");
    expect(saved()).toContain("<https://example.com/inserted>");
    expect(projected()).toMatch(/\[\^\d+\]: https\\:\/\/example\.com\/inserted/);
    clipboard.read.mockResolvedValueOnce({ html: '<a href="https://example.com/rich">富文本链接</a>' });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(projected()).toMatch(/富文本链接\[\^\d+\]/));
    clipboard.read.mockResolvedValueOnce("https://example.com/bare");
    handle!.clipboard("paste", clipboard);
    const expectPlainNote = (url: string) => {
      expect(editor.querySelector(".rich-link-notes a")).toBeNull();
      expect([...editor.querySelectorAll(".rich-link-notes dd")].some(note => note.textContent?.endsWith(url))).toBe(true);
    };
    await vi.waitFor(() => expectPlainNote("https://example.com/bare"));
    expect(editor.querySelector(':scope > p a[href$="/bare"]')?.textContent).toContain("https://example.com/bare");
    clipboard.read.mockResolvedValueOnce("https://example.com/plain");
    handle!.clipboard("paste", clipboard, undefined, true);
    await vi.waitFor(() => expectPlainNote("https://example.com/plain"));
    clipboard.read.mockResolvedValueOnce({ html: "<p><strong>来源 https://example.com/中文，下一句富文本。</strong> <code>https://example.com/code</code></p>" });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expectPlainNote("https://example.com/中文"));
    expect(Array.from(editor.querySelectorAll(":scope > p")).some(node => /\[\^\d+\]，下一句富文本。/.test(node.textContent))).toBe(true);
    expect(editor.querySelector('code')?.textContent).toBe("https://example.com/code");
    clipboard.read.mockResolvedValueOnce("参考 https://example.com/plain-paragraph，下一句普通文本。");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expectPlainNote("https://example.com/plain-paragraph"));
    expect(projected()).toMatch(/\[\^\d+\]，下一句普通文本。/);
    const standalone = "https://example.com/资料，甲。";
    clipboard.read.mockResolvedValueOnce(standalone);
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expectPlainNote(standalone));
    const listUrl = "https://example.com/列表，甲。";
    const quoteUrl = "https://example.com/引文，甲。";
    clipboard.read.mockResolvedValueOnce(`- ${listUrl}\n\n> ${quoteUrl}`);
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => {
      expectPlainNote(listUrl);
      expectPlainNote(quoteUrl);
    });
    render(false);
    expect(editor.querySelector(".rich-link-notes")).toBeNull();
    expect(editor.querySelector(".rich-link-footnoted")).toBeNull();
    expect(clipboard.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each([
  { source: "[来源](https://example.test/资料?a=1&b=2#part)", url: "https://example.test/资料?a=1&b=2#part" },
  { source: "<https://example.test/bare>", url: "https://example.test/bare" },
  { source: "[https://mirror.test/name](https://redirect.test/destination)", url: "https://redirect.test/destination" },
  { source: "[联系](mailto:writer@example.test)", url: "mailto:writer@example.test" },
  { source: "[括号结尾](<https://example.test/a)>)", url: "https://example.test/a)" },
  { source: "[冒号结尾](<https://example.test/a:>)", url: "https://example.test/a:" },
].flatMap(sample => ["\n", "\r\n"].map(newline => ({ ...sample, newline }))))(
  "keeps converted footnote addresses plain after saving, reopening and rendering: $url newline=$newline",
  async ({ source, url, newline }) => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    let handle: MarkdownEditorHandle | null = null;
    const markdown = [source, "手动脚注[^manual]", "[^manual]: [查看原文](https://manual.test/source)"].join(newline + newline);
    async function mount(key: string, value: string) {
      handle = null;
      flushSync(() => root.render(<RichEditor key={key} entryId={key} value={value} readOnly={false}
        ref={editor => { handle = editor; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
      await vi.waitFor(() => expect(handle).not.toBeNull());
    }
    function checkNotes() {
      const note = container.querySelector('dl[data-label="1"] dd')!;
      expect(note.textContent?.endsWith(url)).toBe(true);
      expect(note.querySelector("a")).toBeNull();
      expect(container.querySelector('dl[data-label="manual"] a')).toBeNull();
      expect(container.querySelector('dl[data-label="manual"] dd')?.textContent).toContain("查看原文： https://manual.test/source");
    }
    try {
      await mount("source", markdown);
      const converted = handle!.linkFootnoteMarkdown(markdown);
      await mount("converted", converted);
      checkNotes();
      expect(handle!.linkFootnoteMarkdown(converted)).toBe(converted);
      handle!.insert("甲");
      const saved = handle!.captureMarkdown().markdown;
      await mount("saved", saved);
      checkNotes();
      expect(handle!.linkFootnoteMarkdown(saved)).toBe(saved);
      for (const output of ["preview", "clipboard", "html"] as const) {
        const result = await renderWechat({ markdown: saved, revision: 1, output, themeId: "gzh-moyu-ticket" },
          { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
        try {
          const template = document.createElement("template");
          template.innerHTML = result.html;
          const note = template.content.querySelector('li[id="fn1"]')!;
          expect(note.textContent).toContain(url);
          expect(note.querySelector('a[href^="http"], a[href^="mailto:"]')).toBeNull();
          if (output === "clipboard") {
            expect(template.content.querySelector("a")).toBeNull();
            expect(template.content.textContent).toContain("查看原文");
          } else {
            expect(template.content.querySelector('a[href="https://manual.test/source"]')).toBeNull();
            expect(template.content.textContent).toContain("查看原文： https://manual.test/source");
            expect(template.content.querySelector('a[href="#fn1"]')).not.toBeNull();
          }
        } finally { result.dispose(); }
      }
    } finally { flushSync(() => root.unmount()); container.remove(); }
  },
);

it("projects plain addresses from a legacy footnote without changing the untouched source", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const source = "来源[^1]\n\n[^1]: 来源：<https://example.test/source>";
  try {
    flushSync(() => root.render(<RichEditor entryId="legacy-footnote" value={source} readOnly={false}
      ref={editor => { handle = editor; }} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    expect(container.querySelector("dl a")).toBeNull();
    const projected = handle!.linkFootnoteMarkdown(source);
    expect(parseWechat(projected, []).body.querySelector('.footnotes a[href="https://example.test/source"]')).toBeNull();
    expect(projected).toContain(String.raw`https\://example.test/source`);
    expect(handle!.captureMarkdown().markdown).toBe(source);
    expect(handle!.captureMarkdown().localRevision).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("keeps exact destinations and URL-shaped link names across article conversion and reopening", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "显式链接 <https://example.com/a，b>。\n\n网址名称 [https://mirror.example/form](https://redirect.example/form)。\n\n行内代码 `https://example.com/ignored`。\n\n[^7]\n\n[^7]: <https://example.com/legacy>";
  async function mount(id: string, value: string, convertLinks = true) {
    flushSync(() => root.render(<MarkdownEditor key={id} ref={instance => { handle = instance; }} entryId={id}
      value={value} readOnly={false} convertLinks={convertLinks} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(id));
    return container.querySelector<HTMLElement>(".ProseMirror")!;
  }
  try {
    const editor = await mount("exact-link-target", markdown);
    await select(editor, 0, 4, handle!);
    const converted = handle!.linkFootnoteMarkdown(markdown);
    expect(handle!.target().original).toBe("显式链接");
    expect(editor.querySelector(":scope > p a")?.textContent).toContain("https://example.com/a，b");
    expect(converted).toContain("行内代码 `https://example.com/ignored`。");
    expect(converted).toContain(String.raw`[^1]: https\://example.com/a，b`);
    expect(editor.querySelector(":scope > p:nth-child(2)")?.textContent).toContain("https://mirror.example/form[^2]");
    expect(editor.querySelector(":scope > p:nth-child(4)")?.textContent).toContain("https://example.com/legacy[^7]");
    const addressText = document.createTreeWalker(editor.querySelector(":scope > p a")!, NodeFilter.SHOW_TEXT).nextNode()!;
    document.getSelection()!.setBaseAndExtent(addressText, 10, addressText, 10);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(Array.from(editor.querySelectorAll(":scope > p .rich-markdown-syntax"),
      marker => marker.getAttribute("data-markdown"))).toEqual(["<", ">"]));
    expect(onChange).not.toHaveBeenCalled();
    const reopened = await mount("reopened-link-target", converted, false);
    expect(reopened.querySelector(":scope > p")?.textContent).toBe("显式链接 https://example.com/a，b[^1]。");
    expect(reopened.querySelector(":scope > p:nth-child(2)")?.textContent).toContain("https://mirror.example/form[^2]");
    expect(reopened.querySelector(":scope > p:nth-child(2) a")).toBeNull();
    expect(reopened.querySelector('dl a[href="https://redirect.example/form"]')).toBeNull();
    expect(reopened.querySelector('dl[data-label="2"]')?.textContent).toContain("https://mirror.example/form： https://redirect.example/form");
    expect(handle!.linkFootnoteMarkdown(converted)).toBe(converted);
    const titled = await mount("titled-link-target", '[https://example.com](https://example.com "原有标题")[^cite]\n\n[^cite]: https://example.com：<https://example.com/source>');
    expect(titled.querySelector(":scope > p a")?.getAttribute("title")).toBe("原有标题");
    const rawDestination = "https://example.test/资料，甲";
    const original = await mount("implicit-link-target", rawDestination, false);
    expect(original.querySelector("a")?.getAttribute("href")).toBe(rawDestination);
    const repeated = "<https://example.test/a>[^1]\n\n[^1]: <https://example.test/a>";
    const projected = handle!.linkFootnoteMarkdown(repeated);
    const { body } = parseWechat(projected, []);
    expect(body.querySelector("p")?.querySelector('a[href^="http"]')).toBeNull();
    expect(body.querySelector("p")?.textContent).toBe("https://example.test/a[1]");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("adds rows and columns to the clicked table and persists column formatting and sorts", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "| 名称 | 数量 |\n| --- | --- |\n| 项目 10 | 10 |\n| 项目 2 | 2 |";
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="table-tools" value={markdown}
      readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const table = () => container.querySelector("table")!;
    const rowTexts = () => [...table().rows].map(row => [...row.cells].map(cell => cell.textContent));
    const hoverCell = (row: number, column: number, x = 50, y = 15) => {
      const width = table().rows[0].cells.length * 100;
      table().getBoundingClientRect = () => new DOMRect(20, 40, width, table().rows.length * 30);
      table().closest<HTMLElement>(".rich-table")!.getBoundingClientRect = () => new DOMRect(20, 40, width, table().rows.length * 30);
      [...table().rows].forEach((line, r) => {
        line.getBoundingClientRect = () => new DOMRect(20, 40 + r * 30, width, 30);
        [...line.cells].forEach((cell, c) => { cell.getBoundingClientRect = () => new DOMRect(20 + c * 100, 40 + r * 30, 100, 30); });
      });
      table().rows[row].cells[column].dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true, clientX: 20 + column * 100 + x, clientY: 40 + row * 30 + y,
      }));
    };
    hoverCell(2, 1, 99);
    container.querySelector<HTMLButtonElement>(".rich-table-add-column")!.click();
    hoverCell(2, 0, 50, 29);
    container.querySelector<HTMLButtonElement>(".rich-table-add-row")!.click();
    expect(rowTexts()).toEqual([["名称", "数量", ""], ["项目 10", "10", ""], ["项目 2", "2", ""], ["", "", ""]]);

    function context(row: number, column: number) {
      const cell = table().rows[row].cells[column];
      const capture = vi.fn((event: MouseEvent) => handle!.prepareContext(event));
      cell.addEventListener("contextmenu", capture, { once: true });
      cell.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true }));
      return capture.mock.results[0].value;
    }
    expect(context(1, 0)).toEqual({ row: 1, column: 0, rows: 4, columns: 3 });
    handle!.tableAction("alignCenter");
    expect([...table().rows].map(row => row.cells[0].style.textAlign)).toEqual(["center", "center", "center", "center"]);
    handle!.tableAction("sortAscending");
    expect(rowTexts().map(row => row[0])).toEqual(["名称", "", "项目 2", "项目 10"]);
    expect(onChange.mock.lastCall![2]).toMatch(/\| :[-]+: /);
    context(2, 1);
    handle!.tableAction("columnLeft");
    expect(rowTexts()[0]).toEqual(["数量", "名称", ""]);
    expect(rowTexts()[2]).toEqual(["2", "项目 2", ""]);

    function dragGrip(axis: "row" | "column", row: number, column: number, x = 20, y = 5,
      finish: "drop" | "cancel" | "outside" = "drop") {
      const grip = container.querySelector<HTMLButtonElement>(`.rich-table-grip-${axis}`)!;
      expect(grip.querySelector("svg")).not.toBeNull();
      expect(grip.hidden).toBe(false);
      const preview = container.querySelector<HTMLDivElement>(".rich-table-preview")!;
      const line = container.querySelector<HTMLDivElement>(`.rich-table-line-${axis}`)!;
      grip.setPointerCapture = vi.fn();
      grip.hasPointerCapture = () => true;
      grip.releasePointerCapture = vi.fn();
      const targetX = 20 + column * 100 + x, targetY = 40 + row * 30 + y;
      const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")!;
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: (pointerX: number) => pointerX === 1000 ? container : table().rows[row].cells[column],
      });
      const pointer = (type: string, clientX: number, clientY: number) => grip.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX, clientY,
      }));
      try {
        pointer("pointerdown", 20, 40);
        expect(grip.setPointerCapture).toHaveBeenCalledWith(1);
        pointer("pointermove", 22, 41);
        expect(preview.hidden).toBe(true);
        pointer("pointermove", targetX, targetY);
        expect(preview.hidden || line.hidden).toBe(false);
        const offset = preview.style.cssText;
        pointer("pointermove", 1000, 1000);
        expect(line.hidden).toBe(true);
        expect(preview.hidden).toBe(false);
        expect(preview.style.cssText).not.toBe(offset);
        if (finish === "cancel") {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
        }
        pointer("pointerup", finish === "outside" ? 1000 : targetX, finish === "outside" ? 1000 : targetY);
        expect(grip.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
        expect(preview.hidden).toBe(true);
      } finally {
        Object.defineProperty(document, "elementFromPoint", hitTest);
      }
    }
    handle!.command("selectAll");
    const beforeDrag = rowTexts();
    hoverCell(2, 1);
    dragGrip("row", 1, 1, 20, 5, "cancel");
    hoverCell(2, 1);
    dragGrip("row", 1, 1, 20, 5, "outside");
    expect(rowTexts()).toEqual(beforeDrag);
    hoverCell(2, 1);
    dragGrip("row", 1, 1);
    expect(rowTexts().slice(0, 3)).toEqual([["数量", "名称", ""], ["2", "项目 2", ""], ["", "", ""]]);
    hoverCell(1, 1);
    dragGrip("column", 1, 0);
    expect(rowTexts().slice(0, 2)).toEqual([["名称", "数量", ""], ["项目 2", "2", ""]]);
    hoverCell(0, 0, 99);
    expect(container.querySelector(".rich-table-grip-column")?.hasAttribute("hidden")).toBe(true);
    container.querySelector<HTMLButtonElement>(".rich-table-add-column")!.click();
    expect(rowTexts()[0]).toEqual(["名称", "", "数量", ""]);
    hoverCell(1, 0, 50, 1);
    container.querySelector<HTMLButtonElement>(".rich-table-add-row")!.click();
    expect(rowTexts().slice(0, 3)).toEqual([["名称", "", "数量", ""], ["", "", "", ""], ["项目 2", "", "2", ""]]);
    hoverCell(0, 0);
    dragGrip("row", 2, 0, 50, 25);
    expect(rowTexts().slice(0, 3)).toEqual([["", "", "", ""], ["项目 2", "", "2", ""], ["名称", "", "数量", ""]]);
    expect(table().rows[0].cells[0].tagName).toBe("TH");
    expect(table().rows[2].cells[0].tagName).toBe("TD");

    const pasteTable = (html: string) => {
      handle!.command("selectAll");
      handle!.clipboard("paste", { read: async () => ({ html }), write: vi.fn(), onError: vi.fn() });
    };
    pasteTable("<table><tr><th rowspan='2'>类别</th><th>数量</th></tr><tr><td colspan='2'>5</td></tr><tr><td>普通</td><td>2</td></tr></table>");
    await vi.waitFor(() => expect(rowTexts()).toEqual([["类别", "数量"], ["5", ""], ["普通", "2"]]));
    expect(context(2, 1)).toEqual({ row: 2, column: 1, rows: 3, columns: 2 });
    handle!.tableAction("sortDescending");
    expect(rowTexts().slice(1)).toEqual([["普通", "2"], ["5", ""]]);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("preserves dragged table selections and keeps newlines in table cells after reopening", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  async function mount(entryId: string, markdown: string, convertLinks = false) {
    flushSync(() => root.render(<MarkdownEditor key={entryId} ref={value => { handle = value; }} entryId={entryId}
      value={markdown} readOnly={false} convertLinks={convertLinks} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(entryId));
    return container.querySelector("table")!;
  }
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  try {
    const table = await mount("table-selection", "| 项目 | 数量 |\n| --- | --- |\n| 笔记 | 12 |\n| 文档 | 24 |");
    const left = table.rows[1].cells[0];
    const right = table.rows[1].cells[1];
    const markup = (cell: HTMLTableCellElement) => cell.querySelector("p")!.innerHTML.replace(/<img class="ProseMirror-separator" alt="">/g, "");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number) => x < 50 ? left : right });
    const fire = (type: string, target: Node, x: number, button = 0) =>
      target.dispatchEvent(new MouseEvent(type, { button, clientX: x, bubbles: true, cancelable: true }));
    const context = (cell: HTMLTableCellElement) => {
      const prepare = vi.fn((event: MouseEvent) => handle!.prepareContext(event));
      cell.addEventListener("contextmenu", prepare, { once: true });
      fire("contextmenu", cell, 60, 2);
      return prepare.mock.results[0].value;
    };
    handle!.focus();
    fire("mousedown", left, 10);
    fire("mousemove", right, 60);
    fire("mouseup", right, 60);
    expect(left.dataset.selectionEdge).toBe("left top bottom");
    expect(right.dataset.selectionEdge).toBe("right top bottom");
    fire("mousedown", right, 60, 2);
    expect(context(right)).toMatchObject({ row: 1, column: 0, selectedCells: true });
    const clipboard = { read: vi.fn(), write: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write.mock.lastCall![1]).toMatch(/<td[^>]*><p>笔记<\/p><\/td><td[^>]*><p>12/);
    handle!.tableAction("clearCells");
    expect([left.textContent, right.textContent]).toEqual(["", ""]);
    handle!.command("undo");
    for (const plainText of [false, true]) {
      fire("mousedown", left, 10);
      fire("mousemove", right, 60);
      fire("mouseup", right, 60);
      clipboard.read.mockResolvedValueOnce("甲\n乙\n\n丙");
      handle!.clipboard("paste", clipboard, undefined, plainText);
      const expected = plainText ? "甲<br>乙<br><br>丙" : "甲<br>乙<br>丙";
      await vi.waitFor(() => expect(markup(right)).toBe(expected));
      expect(markup(left)).toBe(expected);
      expect(table.rows).toHaveLength(3);
    }
    clipboard.read.mockResolvedValueOnce({ html: "<strong>格式</strong>", text: "格式" });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(right.querySelector("strong")?.textContent).toBe("格式"));
    expect(left.querySelector("strong")?.textContent).toBe("格式");
    handle!.command("undo");
    clipboard.read.mockResolvedValueOnce({ html: "<hr>" });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(clipboard.read).toHaveBeenCalledTimes(4));
    expect(markup(right)).toBe("甲<br>乙<br><br>丙");

    const p = table.rows[2].cells[0].querySelector("p")!;
    handle!.focus();
    document.getSelection()!.setBaseAndExtent(p.firstChild!, 0, p.firstChild!, 2);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.hasSelection()).toBe(true));
    expect(context(table.rows[2].cells[0])).toBe("cellText");
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write.mock.lastCall![0]).toBe("文档");
    document.getSelection()!.collapse(p.firstChild!, 2);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.hasSelection()).toBe(false));
    const enter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    p.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const saved = onChange.mock.lastCall![2] as string;
    expect(saved).toMatch(/文档<br>/);
    const reopened = await mount("reopened", saved);
    expect(reopened.rows).toHaveLength(3);
    expect(markup(reopened.rows[1].cells[0])).toBe("甲<br>乙<br><br>丙");
    expect(reopened.rows[2].cells[0].querySelector("br")).not.toBeNull();
    const trailing = container.querySelector<HTMLElement>(".ProseMirror > p:last-child")!;
    expect(trailing).not.toBeNull();
    handle!.focus();
    const start = handle!.target().from;
    document.getSelection()!.collapse(trailing, 0);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.target().from).toBeGreaterThan(start));
    handle!.insert("表格之后的文字");
    expect(trailing.textContent).toBe("表格之后的文字");
    expect(onChange.mock.lastCall![2]).toMatch(/\|\n\n表格之后的文字$/);

    const sources = await mount("table-links", "| 项目 | 数量 |\n| --- | --- |\n| 前 [甲](https://example.com/original) | 乙 |", true);
    const [first, second] = Array.from(sources.rows[1].cells);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number) => x < 50 ? first : second });
    handle!.focus();
    const tableAnchor = () => first.querySelector('a[href$="/original"]')!;
    function linkContext() {
      const event = new MouseEvent("contextmenu", { button: 2, bubbles: true });
      tableAnchor().dispatchEvent(event);
      return handle!.prepareContext(event);
    }
    expect(linkContext()).toMatchObject({ kind: "link", scope: { row: 1, column: 0 } });
    const precedingText = first.querySelector("p")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(precedingText, 0, precedingText, 1);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.hasSelection()).toBe(true));
    expect(linkContext()).toMatchObject({ kind: "link", scope: "cellText" });
    fire("mousedown", first, 10);
    fire("mousemove", second, 60);
    fire("mouseup", second, 60);
    clipboard.read.mockResolvedValueOnce("[出处](https://example.com/table)");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(sources.querySelectorAll('sup.rich-link-citation')).toHaveLength(2));
    expect(container.querySelector('.rich-link-notes dl dd')?.textContent).toBe("出处： https://example.com/table");
    expect(container.querySelector('.rich-link-notes dl a')).toBeNull();
    expect(onChange.mock.lastCall![2]).not.toContain("[^1]:");
    handle!.command("undo");
    expect(sources.querySelectorAll("sup.rich-link-citation")).toHaveLength(1);
    expect(container.querySelector(".rich-link-notes dl dd")?.textContent).toBe("甲： https://example.com/original");
    expect(container.querySelector(".rich-link-notes dl a")).toBeNull();
  } finally {
    if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("opens HTTP links only with the platform modifier and measures the context caret", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const openLink = vi.fn().mockResolvedValue(undefined);
  const platform = vi.spyOn(Navigator.prototype, "platform", "get");
  const measure = vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({ top: 20, bottom: 45, left: 10, right: 10 });
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="links" ref={value => { handle = value; }}
      value={"正文 [外链](https://example.com/) [锚点](#heading)"} readOnly={false} onOpenLink={openLink}
      onChange={vi.fn()} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const [link, anchor] = container.querySelectorAll("a");
    const click = (target: Element, options: MouseEventInit = {}) =>
      target.dispatchEvent(new MouseEvent("click", { ...options, bubbles: true, cancelable: true }));
    platform.mockReturnValue("Win32");
    expect(click(link)).toBe(false);
    click(link, { metaKey: true });
    expect(openLink).not.toHaveBeenCalled();
    expect(click(link, { ctrlKey: true })).toBe(false);
    click(anchor, { ctrlKey: true });
    platform.mockReturnValue("MacIntel");
    click(link, { ctrlKey: true });
    click(link, { metaKey: true });
    expect(openLink.mock.calls).toEqual([["https://example.com/"], ["https://example.com/"]]);
    handle!.contextCaret!(true);
    expect(container.querySelector<HTMLElement>(".rich-context-caret")?.style.getPropertyValue("--context-caret-height")).toBe("25px");
    handle!.contextCaret!(false);
    expect(container.querySelector(".rich-context-caret")).toBeNull();
    flushSync(() => root.render(<MarkdownEditor entryId="links" ref={value => { handle = value; }}
      value={"正文 [外链](https://example.com/) [锚点](#heading)"} readOnly onOpenLink={openLink}
      onChange={vi.fn()} onBlur={() => {}} />));
    for (const value of ["Win32", "MacIntel"]) {
      platform.mockReturnValue(value);
      click(link);
      click(anchor);
    }
    expect(openLink.mock.calls).toEqual(Array.from({ length: 4 }, () => ["https://example.com/"]));
  } finally {
    platform.mockRestore();
    measure.mockRestore();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("selects only the formula or divider when opening its context menu", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const clipboard = { read: vi.fn(), write: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="objects" ref={value => { handle = value; }}
      value={"前文\n\n---\n\n$$\nx^2\n$$\n\n后文"} readOnly={false} onChange={vi.fn()} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    for (const [selector, text, html] of [["hr", "", "<hr>"], [".rich-formula", "x^2", 'data-math="math_block"']]) {
      const element = container.querySelector(selector)!;
      const event = new MouseEvent("contextmenu", { button: 2 });
      let scope: ReturnType<MarkdownEditorHandle["prepareContext"]> | undefined;
      element.addEventListener("contextmenu", () => { scope = handle!.prepareContext(event); }, { once: true });
      element.dispatchEvent(event);
      expect(scope).toBe("object");
      handle!.clipboard("copy", clipboard);
      expect(clipboard.write.mock.lastCall![0]).toBe(text);
      expect(clipboard.write.mock.lastCall![1]).toContain(html);
    }
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("keeps code text in place while the mouse is selecting it", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onDocumentChanged = vi.fn();
  try {
    flushSync(() => root.render(<RichEditor ref={value => { handle = value; }} entryId="code-drag-selection"
      value={"第一段\n\n~~~text\n代码块也应支持拖选\n~~~"} readOnly={false} onDocumentChanged={onDocumentChanged} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const block = container.querySelector(".rich-code-block")!;
    const code = block.querySelector("code")!;
    const text = code.firstChild!;
    handle!.focus();
    expect(block.classList).not.toContain("rich-code-active");
    code.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    document.getSelection()!.setBaseAndExtent(text, 1, text, 6);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.selectionText()).toBe("码块也应支"));
    expect(block.classList).not.toContain("rich-code-active");
    code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await vi.waitFor(() => expect(block.classList).toContain("rich-code-active"));
    expect(handle!.selectionText()).toBe("码块也应支");
    expect(onDocumentChanged).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("shows fences while editing a code block and uses the chosen language after blur", async () => {
  const container = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(container, outside);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="language"
      value={"\x60\x60\x60javascript\nconst value = 1;\n\x60\x60\x60\n\n代码之后的正文"} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const block = container.querySelector(".rich-code-block")!;
    expect(block.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(block.querySelector(".rich-code-language")?.textContent).toBe("javascript");
    handle!.focus();
    expect(block.classList).toContain("rich-code-active");
    const selectAll = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    block.querySelector("code")!.dispatchEvent(selectAll);
    expect(selectAll.defaultPrevented).toBe(true);
    const clipboard = { read: vi.fn(), write: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write.mock.lastCall![0]).toBe("const value = 1;");
    handle!.contextCaret!(true);
    outside.focus();
    expect(block.classList).toContain("rich-code-active");
    expect(block.querySelector(".rich-context-caret")).toBeNull();
    handle!.contextCaret!(false);
    expect(block.classList).not.toContain("rich-code-active");
    handle!.focus();
    expect([...block.querySelectorAll<HTMLElement>(".rich-code-fence")].map(fence => fence.textContent)).toEqual(["\x60\x60\x60", "\x60\x60\x60"]);
    const input = block.querySelector<HTMLInputElement>("input")!;
    expect(input.closest(".rich-code-fence-open")).not.toBeNull();
    expect(input.value).toBe("javascript");
    input.focus();
    expect(document.activeElement).toBe(input);
    input.value = "typescript";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onChange.mock.lastCall![2]).toMatch(/^\x60\x60\x60typescript/);
    outside.focus();
    expect(block.classList).not.toContain("rich-code-active");
    expect(block.querySelector(".rich-code-language")?.textContent).toBe("typescript");
    expect(block.querySelector(".hljs-keyword")?.textContent).toBe("const");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    outside.remove();
  }
});

it("inserts pasted images with their document, then resolves external and local image URLs in place", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  let finishDownload: (url: string) => void;
  const pending = new Promise<string>(resolve => { finishDownload = resolve; });
  const external = "https://cdn.example.com/diagram.png";
  const owned = "https://images.example.com/workspace/cover.png";
  const localizeImage = vi.fn((url: string) => url === external ? pending : Promise.resolve(url));
  const importImage = vi.fn(async (_file: File) => "asset://embedded-graph");
  const io = {
    read: async () => ({
      html: `<h2>资料</h2><p>出处<sup data-type="footnote_reference" data-label="media">media</sup></p>`
        + '<dl data-type="footnote_definition" data-label="media"><dt>media</dt><dd><p>脚注来源</p></dd></dl>'
        + `<p><img src="${external}" alt="示意图" title="原注释"><img src="${owned}" alt="封面"><img src="data:image/png;base64,AAEC" alt="内嵌图"></p>`,
    }),
    write: vi.fn(), onError: vi.fn(), localizeImage, importImage,
  };
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="pasted-images"
      value="" readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.clipboard("paste", io);
    await vi.waitFor(() => expect(localizeImage).toHaveBeenCalledTimes(3));
    expect(localizeImage).toHaveBeenCalledWith("asset://embedded-graph");
    expect(importImage.mock.lastCall?.[0]).toMatchObject({ type: "image/png", size: 3 });
    expect(container.querySelector("h2")?.textContent).toBe("资料");
    expect(onChange.mock.lastCall![2]).toContain(external);
    expect(onChange.mock.lastCall![2]).toContain("![内嵌图](asset://embedded-graph)");
    expect(onChange.mock.lastCall![2]).toMatch(/\[\^media\]: 脚注来源$/);
    const editor = container.querySelector(".ProseMirror")!;
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    finishDownload!("asset://local-graph");
    await vi.waitFor(() => expect(onChange.mock.lastCall![2]).toContain('![示意图](asset://local-graph "原注释")'));
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(onChange.mock.lastCall![2]).toContain(`![封面](${owned})`);
    handle!.command("undo");
    expect(container.querySelector("h2")).toBeNull();
    handle!.command("redo");
    expect(onChange.mock.lastCall![2]).toContain("asset://local-graph");
    expect(io.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each(["paste", "insert", "html", "embedded", "external"] as const)("replaces a new image after automatic hosting through %s while keeping paste undoable", async method => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  let finish!: (url: string) => void;
  const hosted = new Promise<string>(resolve => { finish = resolve; });
  const resolveImage = vi.fn(() => hosted);
  const onError = vi.fn();
  const onChange = vi.fn();
  const imageUrl = method === "external" ? "https://external.example.test/image.png" : "asset://pasted";
  const source = `![粘贴图片](${imageUrl})`;
  const importImage = vi.fn(async () => "asset://pasted");
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="auto-hosted"
      value="" readOnly={false} localizeImageLink={resolveImage} onError={onError} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    if (method === "insert") handle!.insert(source);
    else handle!.clipboard("paste", {
      read: async () => method === "html" || method === "embedded"
        ? { html: `<p><img src="${method === "embedded" ? "data:image/png;base64,AAEC" : imageUrl}" alt="粘贴图片"></p>` }
        : source,
      write: vi.fn(), onError, localizeImage: resolveImage, importImage,
    });
    await vi.waitFor(() => expect(resolveImage).toHaveBeenCalledExactlyOnceWith(imageUrl));
    expect(importImage).toHaveBeenCalledTimes(method === "embedded" ? 1 : 0);
    expect(container.querySelector(".rich-image")).not.toBeNull();
    expect(onChange.mock.lastCall![2]).toContain(source);
    expect(container.querySelector<HTMLElement>(".rich-image-upload")?.hidden).toBe(false);
    finish("https://images.example.test/pasted.webp");
    await vi.waitFor(() => expect(onChange.mock.lastCall![2]).toContain("![粘贴图片](https://images.example.test/pasted.webp)"));
    handle!.command("undo");
    expect(container.querySelector(".rich-image")).toBeNull();
    handle!.command("redo");
    expect(onChange.mock.lastCall![2]).toContain("https://images.example.test/pasted.webp");
    expect(onError).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it.each([false, true])("shows queued imported images and replaces them after background upload (reading=%s)", async readOnly => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  let finish!: (url: string) => void;
  let uploaded = false;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const readImageUploadState = vi.fn(async () => uploaded ? { pending: false, publicUrl: "https://images.example.test/imported.png" } : { pending: true });
  const resolveHostedImage = vi.fn(() => pending);
  const processing = vi.fn();
  const onChange = vi.fn(), onError = vi.fn();
  const source = "正文\n\n![导入图片](asset://imported)\n\n`![示例](asset://imported)`";
  const render = (revision: number) => flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="background-import"
    value={source} readOnly={readOnly} uploadRevision={revision} readImageUploadState={readImageUploadState}
    resolveHostedImage={resolveHostedImage} onImageProcessingChange={processing} onError={onError} onChange={onChange} onBlur={() => {}} />));
  try {
    render(0);
    await vi.waitFor(() => expect(container.querySelector<HTMLElement>(".rich-image-upload")?.hidden).toBe(false));
    expect(handle!.captureMarkdown().markdown).toContain("![导入图片](asset://imported)");
    expect(resolveHostedImage).not.toHaveBeenCalled();
    expect(processing).toHaveBeenLastCalledWith(true);
    uploaded = true;
    render(1);
    await vi.waitFor(() => expect(resolveHostedImage).toHaveBeenCalledExactlyOnceWith("asset://imported"));
    expect(container.querySelector<HTMLElement>(".rich-image-upload")?.hidden).toBe(false);
    render(2);
    await vi.waitFor(() => expect(readImageUploadState.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(resolveHostedImage).toHaveBeenCalledOnce();
    expect(processing).toHaveBeenLastCalledWith(true);
    finish("https://images.example.test/imported.png");
    await handle!.pendingEdits();
    expect(handle!.captureMarkdown().markdown).toContain("![导入图片](https://images.example.test/imported.png)");
    expect(handle!.captureMarkdown().markdown).toContain("`![示例](asset://imported)`");
    expect(onChange.mock.lastCall![2]).toContain("https://images.example.test/imported.png");
    expect(container.querySelector<HTMLElement>(".rich-image-upload")?.hidden).toBe(true);
    expect(processing).toHaveBeenLastCalledWith(false);
    expect(onError).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it.each(["revision", "reenable"] as const)("retries public validation after transient failures through %s", async trigger => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const error = new Error("CDN 暂不可用");
  const resolveHostedImage = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error)
    .mockResolvedValue("https://images.example.test/imported.png");
  const readImageUploadState = vi.fn(async () => ({ pending: false, publicUrl: "https://images.example.test/imported.png" }));
  const onError = vi.fn();
  const render = (revision: number, enabled = true) => flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="retry-public"
    value="![图](asset://imported)" readOnly={false} uploadRevision={revision} readImageUploadState={enabled ? readImageUploadState : undefined}
    resolveHostedImage={resolveHostedImage} onError={onError} onChange={() => {}} onBlur={() => {}} />));
  try {
    render(0);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(handle!.captureMarkdown().markdown).toContain("asset://imported");
    if (trigger === "reenable") render(0, false);
    render(trigger === "revision" ? 1 : 0);
    await vi.waitFor(() => expect(resolveHostedImage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    if (trigger === "reenable") render(0, false);
    render(trigger === "revision" ? 2 : 0);
    await vi.waitFor(() => expect(handle!.captureMarkdown().markdown).toContain("https://images.example.test/imported.png"));
    expect(resolveHostedImage).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("replaces a hosted canvas output with its public URL while retaining editable render identity", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const resolveHostedImage = vi.fn(async () => "https://images.example.test/output.png");
  const readImageUploadState = vi.fn(async () => ({ pending: false, publicUrl: "https://images.example.test/output.png", preserveSource: true }));
  try {
    flushSync(() => root.render(<RichEditor ref={value => { handle = value; }} entryId="render-source"
      value="![可编辑成品](asset://render-output)" readOnly={false} readImageUploadState={readImageUploadState}
      resolveHostedImage={resolveHostedImage} onDocumentChanged={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(readImageUploadState).toHaveBeenCalled());
    await handle!.pendingEdits();
    expect(handle!.captureMarkdown().markdown).toBe("![可编辑成品](https://images.example.test/output.png#wcb-image=render-output)");
    expect(resolveHostedImage).toHaveBeenCalledExactlyOnceWith("asset://render-output");
    expect(container.querySelector<HTMLElement>(".rich-image-upload")?.hidden).toBe(true);
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it.each(["removed", "failed"] as const)("keeps imported images safe when background upload is %s", async outcome => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  let finish!: (url: string) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const resolveHostedImage = vi.fn(() => pending);
  const onChange = vi.fn(), onError = vi.fn();
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="background-safe"
      value="![图](asset://imported)" readOnly={false} readImageUploadState={async () => ({ pending: false, publicUrl: "https://images.example.test/imported.png" })}
      resolveHostedImage={resolveHostedImage} onError={onError} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(resolveHostedImage).toHaveBeenCalledOnce());
    if (outcome === "removed") {
      handle!.command("selectAll");
      handle!.insert("用户修改");
      finish("https://images.example.test/imported.png");
      await handle!.pendingEdits();
      expect(handle!.captureMarkdown().markdown).toBe("用户修改");
    } else {
      const error = new Error("公开图片校验失败");
      fail(error);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
      expect(handle!.captureMarkdown().markdown).toContain("asset://imported");
      expect(container.querySelector<HTMLElement>(".rich-image-upload")?.hidden).toBe(true);
    }
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it.each(["removed", "failed"] as const)("keeps the user's local image state when automatic hosting is %s", async outcome => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  let finish!: (url: string) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const resolveImage = vi.fn(() => pending);
  const onChange = vi.fn(), onError = vi.fn();
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="pending-host"
      value="" readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.clipboard("paste", { read: async () => "![图](asset://pasted)", write: vi.fn(), onError, localizeImage: resolveImage });
    await vi.waitFor(() => expect(resolveImage).toHaveBeenCalledOnce());
    if (outcome === "removed") {
      handle!.command("undo");
      finish("https://images.example.test/pasted.webp");
      await handle!.pendingEdits();
      expect(container.querySelector(".rich-image")).toBeNull();
      expect(onChange.mock.lastCall![2]).not.toContain("images.example.test");
    } else {
      const error = new Error("公开图片校验失败");
      fail(error);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
      expect(onChange.mock.lastCall![2]).toContain("asset://pasted");
    }
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("lets the caret enter and edit a bold delimiter without changing the surrounding text", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const changed = vi.fn();
  try {
    flushSync(() => root.render(<RichEditor ref={value => { handle = value; }} entryId="bold-delimiter"
      value={"前面正文\n\n**推荐阅读：**\n\n后面正文"} readOnly={false} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.focus();
    const bold = container.querySelector("strong")!;
    document.getSelection()!.collapse(bold.firstChild!, 1);
    document.dispatchEvent(new Event("selectionchange"));
    const opener = await vi.waitFor(() => {
      const field = container.querySelector<HTMLInputElement>('input[aria-label="加粗起始标记"]');
      expect(field?.value).toBe("**");
      return field!;
    });
    opener.focus();
    opener.setSelectionRange(1, 1);
    expect(document.activeElement).toBe(opener);
    expect(opener.selectionStart).toBe(1);
    expect(changed).not.toHaveBeenCalled();
    opener.value = "";
    opener.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(container.querySelector("strong")).toBeNull();
    expect([...container.querySelectorAll(".ProseMirror > p")].map(node => node.textContent))
      .toEqual(["前面正文", "推荐阅读：**", "后面正文"]);
    expect(changed).toHaveBeenCalledTimes(1);
    handle!.command("undo");
    expect(container.querySelector("strong")?.textContent).toBe("推荐阅读：");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("shows Markdown at the caret and folds only the selected heading section without changing the document", async () => {
  const container = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(container, outside);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "开头 **粗体** [**链接** 文本](https://example.com)\n\n## 第一节\n\n第一节正文\n\n#### 子标题\n\n子节正文\n\n## 第二节\n\n第二节正文\n\n> ~~~text\n> 首行代码\n> 次行代码\n> ~~~"
    + "\n\n> **第一段引用**\n>\n> 第二段引用  \n> 手动换行\n>\n> > ### 嵌套引用";
  const render = (lineNumbers: boolean, readOnly = false) => {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="presentation" value={markdown}
      lineNumbers={lineNumbers} readOnly={readOnly} onChange={onChange} onBlur={() => {}} />));
  };
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    const firstHeading = editor.querySelector("h2")!;
    const markers = () => [...editor.querySelectorAll<HTMLElement>(".rich-markdown-syntax")].map(node => node.dataset.markdown);
    function setCaret(text: Node, offset: number) {
      handle!.focus();
      document.getSelection()!.collapse(text, offset);
      document.dispatchEvent(new Event("selectionchange"));
    }

    expect(markers()).toEqual([]);
    setCaret(editor.querySelector("strong")!.firstChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["**", "**"]));
    setCaret(document.createTreeWalker(editor.querySelector("a")!, NodeFilter.SHOW_TEXT).nextNode()!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["[", "**", "**", "](https://example.com)"]));
    setCaret(firstHeading.lastChild!, 1);
    await vi.waitFor(() => expect(firstHeading.querySelector(".rich-markdown-syntax")?.textContent).toBe("## "));
    const quote = editor.querySelectorAll(":scope > blockquote")[1];
    const [firstQuote, secondQuote] = quote.querySelectorAll(":scope > p");
    const nestedHeading = quote.querySelector("blockquote h3")!;
    setCaret(firstQuote.querySelector("strong")!.firstChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> ", "**", "**"]));
    setCaret(secondQuote.lastChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> ", "> "]));
    setCaret(nestedHeading.lastChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> > ", "### "]));
    setCaret(editor.querySelector("p")!.firstChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual([]));
    setCaret(nestedHeading.lastChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> > ", "### "]));
    outside.focus();
    expect(markers()).toEqual([]);

    render(true);
    expect(firstHeading.dataset.editorLine).toBe("2");
    expect([...editor.querySelectorAll<HTMLElement>("blockquote pre .rich-code-line-number")].map(node => node.dataset.editorLine)).toEqual(["9", "10"]);
    firstHeading.querySelector<HTMLButtonElement>(".rich-heading-fold")!.click();
    expect([...editor.querySelectorAll(":scope > [hidden]")].map(node => node.textContent)).toEqual([
      "第一节正文", "子标题", "子节正文",
    ]);
    expect(firstHeading.querySelector(".rich-heading-fold")!.getAttribute("aria-expanded")).toBe("false");
    expect(editor.querySelectorAll("h2")[1].dataset.editorLine).toBe("6");
    expect(onChange).not.toHaveBeenCalled();

    setCaret(editor.querySelector("p")!.firstChild!, 1);
    await vi.waitFor(() => expect(handle!.target().from).toBe(2));
    handle!.insert("新增");
    expect(editor.querySelectorAll(":scope > [hidden]")).toHaveLength(3);
    firstHeading.querySelector<HTMLButtonElement>(".rich-heading-fold-end")!.click();
    expect(editor.querySelector(":scope > [hidden]")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);

    render(false, true);
    expect(editor.querySelector("[data-editor-line]")).toBeNull();
    setCaret(nestedHeading.lastChild!, 1);
    expect(markers()).toEqual([]);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    outside.remove();
  }
});

it("shows the active list item's Markdown marker and keeps its task state clickable", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "普通正文\n\n- 父项\n  - 子项\n\n4. 第一项\n5. 第二项\n\n- [ ] 待办";
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="list-source"
      value={markdown} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector(".ProseMirror")!;
    const marker = () => editor.querySelector<HTMLElement>(".rich-markdown-syntax");
    for (const [selector, prefix] of [["ul ul li > p", "- "], ["ol li + li > p", "5. "], ['li[data-checked="false"] > p', "- [ ] "]]) {
      const paragraph = editor.querySelector(selector)!;
      handle!.focus();
      document.getSelection()!.collapse(paragraph.lastChild!, 1);
      document.dispatchEvent(new Event("selectionchange"));
      await vi.waitFor(() => expect(marker()?.dataset.markdown).toBe(prefix));
      expect(editor.querySelectorAll("li.rich-list-source")).toHaveLength(1);
      expect(marker()?.parentElement).toBe(paragraph);
    }
    expect(onChange).not.toHaveBeenCalled();
    marker()!.click();
    expect(onChange.mock.lastCall![2]).toMatch(/[-*+] \[x\] 待办/);
    expect(marker()?.dataset.markdown).toBe("- [x] ");

    document.getSelection()!.collapse(editor.querySelector(":scope > p")!.firstChild!, 1);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(marker()).toBeNull());
    expect(editor.querySelector("li.rich-list-source")).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("uses the asset resolver without connecting the persisted URLs to image elements", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const disposeFirst = vi.fn();
  const disposeLate = vi.fn();
  const onError = vi.fn();
  const onChange = vi.fn();
  let finishLate!: (image: { src: string; dispose(): void }) => void;
  const resolveImage = vi.fn().mockResolvedValueOnce({ src: "blob:local", dispose: disposeFirst })
    .mockImplementationOnce(() => new Promise(resolve => { finishLate = resolve; }));
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="images"
      value={"![素材](asset://local)\n\n![图片](https://example.com/image.png)"}
      readOnly={false} resolveImage={resolveImage} onError={onError} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(resolveImage).toHaveBeenCalledTimes(2));
    expect(resolveImage.mock.calls).toEqual([["asset://local"], ["https://example.com/image.png"]]);
    expect([...container.querySelectorAll("img[src]")].map(node => node.getAttribute("src"))).toEqual(["blob:local"]);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
  finishLate({ src: "blob:late", dispose: disposeLate });
  await vi.waitFor(() => {
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeLate).toHaveBeenCalledOnce();
  });
  expect(onError).not.toHaveBeenCalled();
});

it.each([false, true])("shows alt below resolved images without changing Markdown in readOnly=%s", async readOnly => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const source = "![软件截图](asset://caption)\n\n![](asset://empty)";
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="captions" ref={value => { handle = value; }} value={source} readOnly={readOnly}
      resolveImage={async () => ({ src: "blob:caption", width: 120, height: 60, dispose() {} })}
      onChange={onChange} onError={error => { throw error; }} onBlur={() => {}} />));
    await vi.waitFor(() => expect(container.querySelectorAll(".rich-image img")).toHaveLength(2));
    const captions = [...container.querySelectorAll<HTMLElement>(".rich-image-caption")];
    expect(captions[0].textContent).toBe("软件截图");
    expect(captions[0].hidden).toBe(false);
    expect(captions[1].hidden).toBe(true);
    expect(container.querySelector<HTMLImageElement>(".rich-image img")?.alt).toBe("软件截图");
    expect(handle!.captureMarkdown().markdown.trim()).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("refreshes an unavailable image on asset change without editing Markdown or reloading its session", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onError = vi.fn();
  const missing = new Error("图片尚未保存");
  const dispose = vi.fn();
  const resolveImage = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({ src: "blob:recovered", dispose });
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="asset" ref={value => { handle = value; }} value="![插图](asset://pending)"
      readOnly={false} resolveImage={resolveImage} imageErrorMessage={error => (error as Error).message}
      onError={onError} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => {
      expect(handle).not.toBeNull();
      expect(container.querySelector(".rich-image-status")?.textContent).toContain(missing.message);
    });
    const target = handle!.target();
    handle!.retryMissingImages();
    await vi.waitFor(() => expect(container.querySelector(".rich-image img")?.getAttribute("src")).toBe("blob:recovered"));
    expect(handle!.target()).toEqual(target);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});

it("retries a failed external image from its own placeholder", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const url = "https://images.example.com/picture.png";
  const resolveImage = vi.fn().mockRejectedValueOnce(new Error("无法加载图片"))
    .mockResolvedValueOnce({ src: "blob:retried", dispose: vi.fn() });
  const onChange = vi.fn();
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="external-image" value={`![配图](${url})`}
      readOnly={false} resolveImage={resolveImage} onImageZoom={vi.fn()} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(container.querySelector(".rich-image-retry")).not.toBeNull());
    const retry = container.querySelector<HTMLButtonElement>(".rich-image-retry")!;
    retry.focus();
    retry.click();
    expect(resolveImage.mock.calls).toEqual([[url], [url, true]]);
    await vi.waitFor(() => expect(container.querySelector(".rich-image img")?.getAttribute("src")).toBe("blob:retried"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("放大图片");
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("zooms the selected image and commits valid Markdown when its line loses focus", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onImageZoom = vi.fn();
  const resolveImage = vi.fn(async (url: string) => ({ src: "blob:" + url, dispose() {} }));
  let handle: MarkdownEditorHandle | null = null;
  function render(readOnly: boolean) {
    flushSync(() => root.render(<MarkdownEditor entryId="image-tools"
      value={'图文示例\n\n![旧图](asset://old "说明")\n\n![另一张](asset://other)'}
      ref={value => { handle = value; }} readOnly={readOnly} resolveImage={resolveImage}
      onImageZoom={onImageZoom} onChange={onChange} onBlur={() => {}} />));
  }
  const sourceButton = () => container.querySelector<HTMLButtonElement>(".rich-image-source-toggle")!;
  const sourceField = () => container.querySelector<HTMLTextAreaElement>(".rich-image-source-editor textarea")!;
  try {
    render(false);
    const zoomButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!;
      expect(button?.disabled).toBe(false);
      return button;
    });
    zoomButton.click();
    expect(onImageZoom).toHaveBeenCalledWith({ src: "blob:asset://old", alt: "旧图" }, zoomButton);
    sourceButton().click();
    expect(sourceField().value).toBe('![旧图](asset://old "说明")');
    expect(handle!.clipboard("paste", { read: vi.fn(), write: vi.fn(), onError: vi.fn() }, sourceField())).toBe(false);
    sourceField().value = "![新图](asset://replacement)";
    sourceField().blur();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("image-tools", 1, "图文示例\n\n![新图](asset://replacement)\n\n![另一张](asset://other)");
    expect(sourceField().parentElement?.hidden).toBe(true);

    sourceButton().click();
    sourceField().value = "![取消](asset://replacement)";
    sourceField().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sourceField().parentElement?.hidden).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    render(true);
    sourceButton().click();
    expect(sourceField().parentElement?.hidden).toBe(true);

    const second = await vi.waitFor(() => {
      const element = container.querySelector<HTMLImageElement>('img[alt="另一张"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const contextEvent = new MouseEvent("contextmenu", { bubbles: true, button: 2 });
    second.dispatchEvent(contextEvent);
    const image = handle!.prepareContext(contextEvent);
    expect(image).toMatchObject({ kind: "image", src: "asset://other", available: true });
    if (typeof image !== "object" || !image || !("kind" in image) || image.kind !== "image") throw new Error("expected image context");
    image.remove();
    expect(onChange).toHaveBeenCalledTimes(1);
    render(false);
    image.remove();
    expect(onChange).toHaveBeenLastCalledWith("image-tools", 2, "图文示例\n\n![新图](asset://replacement)");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
