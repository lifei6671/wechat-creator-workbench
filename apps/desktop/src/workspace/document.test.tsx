// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { Entry } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { SaveQueue } from "../editor/save-queue";
import { DocumentEditor, DocumentTabs, DocumentToolbar, type DocumentActions } from "./Document";
import { Outline } from "./Outline";
import { WechatImportDialog } from "./Publishing";
import { PropertiesDialog } from "./Dialogs";

const display = { limitWidth: true, lineNumbers: false, showTitle: true, convertLinks: false };
const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const entry = (id: string, title: string): Entry => ({
  id, kind: "article", title, contentMd: "# 示例正文", status: "draft", categoryId: null, tags: [], summary: "",
  source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [],
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("moves complete outline sections through the save queue and restores them with one undo", async () => {
  const fence = String.fromCharCode(96).repeat(3);
  const beginning = ["## 重名", "正文[^ref]", "### 子节", "#### 孙节", "> ## 引用内标题\n>\n> 引用",
    "| 左 | 右 |\n| - | - |\n| 一 | 二 |", "![示例图片](https://example.com/image.png)"].join("\n\n");
  const second = "## 重名\n\n第二节";
  const third = ["##", "空标题正文", `${fence}js\nconst value = 1;\n${fence}`].join("\n\n");
  const footnote = "[^ref]: 脚注定义";
  const markdown = [beginning, second, third, footnote].join("\n\n");
  const save = vi.fn().mockResolvedValue({ version: 2 });
  const original = new SaveQueue({ ...entry("one", "原文"), contentMd: markdown }, save, vi.fn());
  let reopened: SaveQueue | undefined;
  const editor: { current: MarkdownEditorHandle | null } = { current: null };
  const restored: typeof editor = { current: null };
  const onError = vi.fn();
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [new DOMRect()] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  function renderEditor(queue: SaveQueue, handle: typeof editor, reading: boolean, active: boolean) {
    return <DocumentEditor key={queue.sessionId} queue={queue} active={active} locked={false} reading={reading}
      clipboard={{ read: vi.fn(), write: vi.fn(), onError }} display={display}
      onDisplayChange={vi.fn()} handle={value => { handle.current = value; }}
      onImages={vi.fn()} onImageZoom={vi.fn()} onError={onError} />;
  }
  function mount({ reading = false, switchDocument = false } = {}) {
    flushSync(() => root.render(<Theme>
      {renderEditor(original, editor, reading, !switchDocument)}
      {switchDocument && reopened && renderEditor(reopened, restored, false, true)}
      {!switchDocument && editor.current && <Outline editor={editor.current} readOnly={reading} onClose={vi.fn()} />}
    </Theme>));
  }
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".outline-heading")].filter(row => !row.closest("[inert]"));
  try {
    mount();
    await vi.waitFor(() => expect(editor.current).not.toBeNull());
    mount();
    const handle = editor.current!;
    const [first, duplicate, empty] = handle.getOutline();
    const child = first.children[0];
    expect(child.children[0].children[0].title).toBe("引用内标题");
    expect(first.id).not.toBe(duplicate.id);
    expect(rows().map(row => row.textContent)).toEqual(["重名", "子节", "孙节", "引用内标题", "重名", "空标题"]);
    const toggle = container.querySelector<HTMLButtonElement>('.outline-expand[aria-label="折叠 重名"]')!;
    flushSync(() => toggle.click());
    expect(rows().map(row => row.textContent)).toEqual(["重名", "重名", "空标题"]);
    const query = container.querySelector<HTMLInputElement>('[aria-label="搜索标题"]')!;
    flushSync(() => { setInput.call(query, "孙节"); query.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(rows().map(row => row.textContent)).toEqual(["重名", "子节", "孙节"]);
    expect(original.isDirty()).toBe(false);
    flushSync(() => query.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(rows().map(row => row.textContent)).toEqual(["重名", "重名", "空标题"]);
    expect(handle.moveOutlineSection(first, child, "after")).toBe(false);
    expect(handle.moveOutlineSection(first, duplicate, "before")).toBe(false);

    const fold = container.querySelector<HTMLButtonElement>(".rich-heading-fold")!;
    fold.click();
    expect(container.querySelector("h3")!.hidden).toBe(true);
    expect(handle.scrollToHeading(child)).toBe(true);
    expect(container.querySelector("h3")!.hidden).toBe(false);
    expect(handle.target().from).toBe(child.from + 1);
    expect(original.isDirty()).toBe(false);

    mount({ reading: true });
    expect(container.querySelector("[data-outline-grip]")).toBeNull();
    flushSync(() => rows()[1].click());
    expect(handle.target().from).toBe(duplicate.from + 1);
    expect(handle.moveOutlineSection(first, empty, "after")).toBe(false);
    mount();
    flushSync(() => expect(handle.moveOutlineSection(first, empty, "after")).toBe(true));
    expect(original.isDirty()).toBe(true);
    expect(handle.moveOutlineSection(first, empty, "after")).toBe(false);
    expect(await original.flush()).toBe(true);
    const moved = original.snapshot().fields.contentMd;
    expect(moved).toBe([second, third, beginning, footnote].join("\n\n"));
    expect(save.mock.lastCall![2].contentMd).toBe(moved);

    flushSync(() => handle.command("undo"));
    expect(handle.captureMarkdown().markdown).toBe(markdown);
    expect(handle.getOutline().map(item => [item.id, item.from, item.to]))
      .toEqual([first, duplicate, empty].map(item => [item.id, item.from, item.to]));
    const [backAtStart, , backAtEnd] = handle.getOutline();
    flushSync(() => expect(handle.moveOutlineSection(backAtEnd, backAtStart, "before")).toBe(true));
    expect(handle.captureMarkdown().markdown).toBe([third, beginning, second, footnote].join("\n\n"));
    flushSync(() => handle.command("undo"));
    expect(handle.captureMarkdown().markdown).toBe(markdown);
    reopened = new SaveQueue({ ...entry("two", "重新打开"), contentMd: moved }, vi.fn(), vi.fn());
    mount({ switchDocument: true });
    await vi.waitFor(() => expect(restored.current).not.toBeNull());
    expect(restored.current!.getOutline().map(item => [item.level, item.title])).toEqual([[2, "重名"], [2, ""], [2, "重名"]]);
    expect(container.querySelector('.document-editor:not([hidden]) table')?.textContent).toBe("左右一二");
    const [oldFirst, , oldThird] = handle.getOutline();
    expect(handle.moveOutlineSection(oldFirst, oldThird, "after")).toBe(false);
    const [newFirst, newSecond] = restored.current!.getOutline();
    expect(restored.current!.moveOutlineSection(first, newSecond, "after")).toBe(false);
    expect(restored.current!.getOutline()[0]).toBe(newFirst);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    original.dispose();
    reopened?.dispose();
  }
});

it("renames an inactive tab in place without implicitly selecting it", async () => {
  const first = new SaveQueue(entry("one", "第一篇"), vi.fn(), () => {});
  const second = new SaveQueue(entry("two", "第二篇"), vi.fn(), () => {});
  const onSwitch = vi.fn();
  const onAction = vi.fn();
  const onRename = vi.fn().mockResolvedValue(undefined);
  flushSync(() => root.render(<Theme><DocumentTabs sessions={[first, second]} activeId={null} categories={[]} onMove={vi.fn()}
    readingIds={[]} lockedIds={[]} onSwitch={onSwitch} onClose={vi.fn()} onAction={onAction}
    onReorder={vi.fn()} onRename={onRename} onError={vi.fn()} /></Theme>));
  flushSync(() => container.querySelector("#tab-two")!.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 18,
  })));
  const items = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
  expect(items.map(item => item.textContent)).not.toContain("打开所在目录");
  const action = items.find(item => item.textContent === "重命名")!;
  flushSync(() => action.click());
  await vi.waitFor(() => expect(container.querySelector('.tab input[aria-label="重命名文档"]')).not.toBeNull());
  const name = container.querySelector<HTMLInputElement>('.tab input[aria-label="重命名文档"]')!;
  expect(document.activeElement).toBe(name);
  flushSync(() => {
    setInput.call(name, " 第二篇新标题 ");
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onRename).toHaveBeenCalledExactlyOnceWith("two", "第二篇新标题");
  expect(onAction).not.toHaveBeenCalled();
  expect(onSwitch).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(container.querySelector("#tab-two")).not.toBeNull());
  first.dispose();
  second.dispose();
});

it("shows a tab insertion marker and scrolls overflow by arrow or wheel", async () => {
  const first = new SaveQueue(entry("one", "第一篇"), vi.fn(), () => {});
  const second = new SaveQueue(entry("two", "第二篇"), vi.fn(), () => {});
  const onReorder = vi.fn();
  const imitateResize = vi.fn<(event: ResizeObserverCallback) => void>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { imitateResize(callback); }
    observe() {} disconnect() {}
  });
  flushSync(() => root.render(<Theme><DocumentTabs sessions={[first, second]} activeId={"one"} categories={[]} onMove={vi.fn()}
    readingIds={[]} lockedIds={[]} onSwitch={vi.fn()} onClose={vi.fn()} onAction={vi.fn()}
    onReorder={onReorder} onRename={vi.fn()} onError={vi.fn()} /></Theme>));
  const list = container.querySelector<HTMLDivElement>(".tabs")!;
  const firstTab = container.querySelector<HTMLButtonElement>("#tab-one")!;
  const secondTab = container.querySelector<HTMLButtonElement>("#tab-two")!;
  const secondRow = secondTab.closest<HTMLElement>(".tab")!;
  try {
    Object.defineProperties(list, { scrollWidth: { value: 412 }, clientWidth: { value: 280 } });
    Object.defineProperty(list.parentElement, "clientWidth", { value: 324 });
    list.getBoundingClientRect = () => new DOMRect(0, 0, 280, 32);
    secondRow.getBoundingClientRect = () => new DOMRect(130, 0, 150, 32);
    list.setPointerCapture = vi.fn();
    list.scrollBy = vi.fn();
    flushSync(() => imitateResize.mock.calls[0][0]([], {} as ResizeObserver));
    const next = container.querySelector<HTMLButtonElement>('[aria-label="向右滚动标签页"]')!;
    expect(container.querySelector('[aria-label="向左滚动标签页"]')).toBeNull();
    next.click();
    expect(list.scrollBy).toHaveBeenCalledWith({ left: 182, behavior: "smooth" });
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 18, cancelable: true }));
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 12, cancelable: true }));
    expect(list.scrollLeft).toBe(0);
    await vi.waitFor(() => expect(list.scrollLeft).toBe(30));
    list.scrollLeft = 132;
    flushSync(() => list.dispatchEvent(new Event("scroll")));
    expect(container.querySelector('[aria-label="向右滚动标签页"]')).toBeNull();
    expect(container.querySelector('[aria-label="向左滚动标签页"]')).not.toBeNull();

    const drag = (name: string, node: Element, x: number, buttons: number) => flushSync(() => node.dispatchEvent(
      new PointerEvent(name, { bubbles: true, button: 0, buttons, pointerId: 1, isPrimary: true, clientX: x, clientY: 14 }),
    ));
    drag("pointerdown", firstTab, 30, 1);
    drag("pointermove", secondTab, 245, 1);
    await vi.waitFor(() => expect(secondRow.dataset.placement).toBe("after"));
    expect(container.querySelector(".tab-drag-ghost")?.textContent).toBe("第一篇");
    drag("pointerup", secondTab, 245, 0);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("one", "two", "after");
  } finally {
    first.dispose();
    second.dispose();
  }
});

it("renames through the focused breadcrumb and updates the editor theme without remounting it", async () => {
  const save = vi.fn().mockResolvedValue({ version: 2 });
  const queue = new SaveQueue(entry("one", "原标题"), save, () => {});
  const noop = () => {};
  const actions: DocumentActions = {
    mode: "edit", setMode: noop, focusMode: false, reading: false, onReading: noop, onFocusMode: noop,
    outlineOpen: false, onOutline: noop,
    onPalette: noop, onAi: noop, aiOpen: false, onSave: noop, onSearch: noop, onProperties: noop, onSavedVersions: noop,
    onExport: noop, onExportAssets: noop, onExportWechat: noop, onCopyWechat: noop,
    publishing: false, onDelete: noop, onDraft: noop, onCopy: noop, onReload: noop, onRetry: noop,
  };
  const mount = (locked = false) => flushSync(() => root.render(<Theme>
    <DocumentToolbar queue={queue} categories={[]} actions={actions} onReveal={noop}
      display={display} onDisplayChange={noop} locked={locked} />
    <DocumentEditor queue={queue} active locked={locked} reading={false} clipboard={{ read: vi.fn(), write: vi.fn(), onError: noop }}
      display={display} onDisplayChange={noop} handle={noop} onImages={vi.fn()} onImageZoom={noop} onError={noop} />
  </Theme>));
  try {
    mount();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="内容标题"]')!;
    const update = (value: string, key: string) => flushSync(() => {
      input.focus();
      setInput.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    });
    update("放弃修改", "Escape");
    expect(queue.snapshot().fields.title).toBe("原标题");
    update(" 新标题 ", "Enter");
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("one", 1, expect.objectContaining({ title: "新标题" }), "auto"));
    const editor = container.querySelector<HTMLElement>(".document-editor")!;
    await vi.waitFor(() => expect(editor.querySelector(".ProseMirror")).not.toBeNull());
    const body = editor.querySelector(".ProseMirror");
    const scroll = editor.querySelector(".editor-scroll")!;
    expect(scroll.contains(editor.querySelector(".writing-title"))).toBe(true);
    expect(scroll.contains(body)).toBe(true);
    expect(editor.dataset.wechatTheme).toBe("plainly-default");
    flushSync(() => queue.edit({ themeId: "plainly-elegant" }));
    expect(editor.dataset.wechatTheme).toBe("plainly-elegant");
    expect(editor.querySelector(".ProseMirror")).toBe(body);
    mount(true);
    expect(container.querySelector('input[aria-label="内容标题"]')).toBeNull();
  } finally {
    queue.dispose();
  }
});

it("shows only the current import result in the dialog", async () => {
  const history = vi.spyOn(desktop, "importJobs").mockResolvedValue([]);
  const importNow = vi.spyOn(desktop, "importWechat").mockResolvedValue({
    id: "job", url: "https://mp.weixin.qq.com/s/demo", status: "partial", entryId: "entry", error: null, pendingImages: 2,
  });
  const onOpen = vi.fn();
  const onImported = vi.fn();
  flushSync(() => root.render(<Theme><WechatImportDialog categoryId="folder" onClose={vi.fn()} track={job => job} onOpen={onOpen} onImported={onImported} /></Theme>));
  expect(history).not.toHaveBeenCalled();
  const input = document.querySelector<HTMLInputElement>('input[type="url"]')!;
  flushSync(() => {
    setInput.call(input, "https://mp.weixin.qq.com/s/demo");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(document.querySelector(".wechat-job")?.textContent).toContain("补图（2）"));
  expect(importNow).toHaveBeenCalledExactlyOnceWith("https://mp.weixin.qq.com/s/demo", "folder");
  expect(onImported).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
  expect(document.querySelectorAll(".wechat-job")).toHaveLength(1);
});

it("keeps the source and publishing fields available on an imported note", () => {
  const note = entry("imported", "导入的笔记");
  note.source = { url: "https://mp.weixin.qq.com/s/demo", author: "作者", accountName: "公众号",
    originalPublishedAt: null, importedAt: null };
  const queue = new SaveQueue(note, vi.fn().mockResolvedValue({ version: 2 }), vi.fn());
  try {
    flushSync(() => root.render(<Theme><PropertiesDialog id={note.id} queue={queue} categories={[]} tagSuggestions={[]}
      locked={false} onClose={vi.fn()} onOpen={vi.fn()}
      onSave={async (_, change) => { queue.edit(change); await queue.flush({ retry: true }); }} /></Theme>));
    const source = document.querySelector<HTMLInputElement>('input[name="sourceUrl"]')!;
    const published = document.querySelector<HTMLInputElement>('input[name="publishedUrl"]')!;
    expect(source.value).toBe(note.source.url);
    setInput.call(published, "https://mp.weixin.qq.com/s/published");
    flushSync(() => published.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(queue.snapshot().fields.source).toEqual(note.source);
    expect(queue.snapshot().fields.publishedUrl).toBe("https://mp.weixin.qq.com/s/published");
  } finally { queue.dispose(); }
});
