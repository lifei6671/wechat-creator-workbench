// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { Entry } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { SaveQueue } from "../editor/save-queue";
import { DocumentEditor, DocumentTabs, DocumentToolbar, MarkdownPreview, type DocumentActions } from "./Document";
import { Outline } from "./Outline";
import { LinkImportDialog } from "./Publishing";
import { PropertiesDialog } from "./Dialogs";
import { StatusBar } from "./StatusBar";

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
  vi.useRealTimers();
});

it("keeps saving busy through slow public validation, URL replacement and the final save", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const article = { ...entry("slow-image", "图片"), contentMd: "![图片](asset://imported)" };
  let finishSave!: (result: { version: number }) => void;
  const save = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>(() => new Promise(resolve => { finishSave = resolve; }));
  const queue = new SaveQueue(article, save, () => {});
  let editor: MarkdownEditorHandle | null = null;
  let finishCheck!: (url: string) => void;
  const check = vi.spyOn(desktop, "publicImage").mockReturnValue(new Promise(resolve => { finishCheck = resolve; }));
  vi.spyOn(desktop, "assetDetail").mockResolvedValue({
    id: "imported", name: "图片.png", width: 2, height: 3, bytes: 100,
    uploadStatus: null, uploadError: null, cleanupError: null, publicUrl: "https://images.example.test/imported.png",
  });
  vi.spyOn(desktop, "assetRead").mockRejectedValue(new Error("预览尚未载入"));
  vi.spyOn(desktop, "imageUploadProgress").mockResolvedValue(null);
  const noop = () => {};
  flushSync(() => root.render(<Theme>
    <DocumentEditor queue={queue} active locked={false} reading={false} display={display} onDisplayChange={noop}
      handle={value => { editor = value; }} onImages={async () => ""} clipboard={{ read: async () => "", write: async () => {}, onError: noop }}
      onImageZoom={noop} onError={noop} autoUploadImages assetRevision={0} />
    <StatusBar queue={queue} actions={{ mode: "edit", setMode: noop, focusMode: false, onFocusMode: noop, reading: false, publishing: false, onCopyWechat: noop }}
      trashActive={false} settingsOpen={false} mcpRunning={false} backupProgress={null} migrationProgress={null}
      imageStorageEnabled assetRevision={0} imageUpload={null} syncBinding={null} syncActivity={null}
      syncError="" onSync={noop} onMcp={noop} onPalette={noop} onTrash={noop} onSettings={noop} onError={noop} />
  </Theme>));
  await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  const tick = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const status = () => container.querySelector('.document-status > [role="status"]:not(.background-status)')!.textContent;
  await tick(1500);
  expect(queue.isDirty()).toBe(false);
  expect(queue.isSaving()).toBe(false);
  expect(status()).toBe("保存中…");
  await act(async () => { finishCheck("https://images.example.test/imported.png"); await editor!.pendingEdits(); });
  expect(queue.capture().fields.contentMd).toContain("https://images.example.test/imported.png");
  await tick(5000);
  expect(save).toHaveBeenCalledOnce();
  expect(status()).toBe("保存中…");
  await act(async () => finishSave({ version: 2 }));
  await tick(999);
  expect(status()).toBe("保存中…");
  await tick(1);
  expect(status()).toBe("已保存");
  queue.dispose();
});

it("saves background image replacements through the live queue without losing edits or versions", async () => {
  const article = { ...entry("background", "后台图片"), contentMd: "![图片](asset://imported)" };
  const save = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>(async (_id, version) => ({ version: version + 1 }));
  const queue = new SaveQueue(article, save, () => {});
  let handle: MarkdownEditorHandle | null = null;
  let uploaded = false;
  let finish!: (url: string) => void;
  const publicImage = vi.spyOn(desktop, "publicImage").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  vi.spyOn(desktop, "assetDetail").mockImplementation(async () => ({
    id: "imported", name: "图片.png", width: 2, height: 3, bytes: 100,
    uploadStatus: uploaded ? null : "queued", uploadError: null, cleanupError: null,
    publicUrl: uploaded ? "https://images.example.test/imported.png" : null,
  }));
  vi.spyOn(desktop, "assetRead").mockRejectedValue(new Error("预览尚未载入"));
  const onError = vi.fn();
  const render = (assetRevision: number) => flushSync(() => root.render(<Theme><DocumentEditor queue={queue} active locked={false} reading={false}
    display={display} onDisplayChange={() => {}} handle={value => { handle = value; }} onImages={async () => ""}
    clipboard={{ read: async () => "", write: async () => {}, onError }} onImageZoom={() => {}} onError={onError}
    autoUploadImages assetRevision={assetRevision} /></Theme>));
  render(0);
  await vi.waitFor(() => expect(container.querySelector<HTMLElement>(".rich-image-upload")?.hidden).toBe(false));
  expect(publicImage).not.toHaveBeenCalled();
  uploaded = true;
  render(1);
  await vi.waitFor(() => expect(publicImage).toHaveBeenCalledWith("asset://imported"));
  handle!.insert("用户修改\n\n");
  expect(await queue.flush()).toBe(true);
  expect(save.mock.lastCall![1]).toBe(1);
  finish("https://images.example.test/imported.png");
  await handle!.pendingEdits();
  expect(await queue.flush()).toBe(true);
  expect(save.mock.lastCall![1]).toBe(2);
  expect(save.mock.lastCall![2].contentMd).toContain("用户修改");
  expect(save.mock.lastCall![2].contentMd).toContain("https://images.example.test/imported.png");
  expect(queue.saveError()).toBeNull();
  expect(onError).not.toHaveBeenCalled();
});

it("shows preview progress before rendering and gives each table a scroll region", async () => {
  let resolveGraphics!: (result: Awaited<ReturnType<typeof desktop.wechatGraphics>>) => void;
  const graphics = new Promise<Awaited<ReturnType<typeof desktop.wechatGraphics>>>(resolve => { resolveGraphics = resolve; });
  const renderGraphics = vi.spyOn(desktop, "wechatGraphics").mockReturnValue(graphics);
  vi.spyOn(desktop, "onAssetsChanged").mockResolvedValue(() => {});
  const markdown = "金额 $5\n\n| 左 | 右 |\n| - | - |\n| 一 | 二 |\n\n中间段落\n\n| 名称 |\n| - |\n| 第二张表 |";
  flushSync(() => root.render(<MarkdownPreview title="示例" markdown={markdown} revision={0} />));
  const preview = container.querySelector<HTMLElement>(".markdown-preview")!;
  expect(preview.getAttribute("aria-busy")).toBe("true");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("正在渲染预览");
  expect(renderGraphics).not.toHaveBeenCalled();

  await vi.waitFor(() => expect(renderGraphics).toHaveBeenCalledWith(markdown));
  expect(preview.shadowRoot!.querySelector("table")).toBeNull();
  resolveGraphics([]);
  await vi.waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
  expect(container.querySelector('[role="status"]')).toBeNull();
  const tables = [...preview.shadowRoot!.querySelectorAll("table")];
  expect(tables).toHaveLength(2);
  for (const table of tables) {
    expect(table.parentElement?.matches(".preview-table-scroll[tabindex='0']")).toBe(true);
  }
  expect(tables[0].parentElement?.nextElementSibling?.textContent).toBe("中间段落");
});

it("shows the rendered theme below the phone and updates it when the theme changes", async () => {
  vi.spyOn(desktop, "onAssetsChanged").mockResolvedValue(() => {});
  const mount = (themeId: string) => flushSync(() => root.render(<Theme appearance="dark"><MarkdownPreview title="示例" markdown="正文" themeId={themeId} revision={0} /></Theme>));
  mount("unknown-theme");
  const preview = container.querySelector<HTMLElement>(".markdown-preview")!;
  const label = container.querySelector<HTMLElement>(".preview-theme-label")!;
  await vi.waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
  expect(label.textContent).toBe("默认公众号风格");
  expect(label.parentElement?.previousElementSibling?.className).toBe("preview-phone");
  expect(container.querySelector(".preview-phone-screen")?.classList.contains("light")).toBe(true);
  expect(label.closest(".radix-themes")?.classList.contains("dark")).toBe(true);
  expect(preview.shadowRoot!.textContent).not.toContain("默认公众号风格");
  mount("gzh-moyu-green");
  await vi.waitFor(() => expect(label.textContent).toBe("摸鱼绿"));
  expect(label.getAttribute("aria-label")).toBe("公众号主题：摸鱼绿");
  expect(label.title).toBe("摸鱼绿");
  expect(container.querySelector(".markdown-preview")).toBe(preview);
});

it("switches WeChat preview appearance without rerendering content or changing scroll position", async () => {
  vi.spyOn(desktop, "onAssetsChanged").mockResolvedValue(() => {});
  const graphics = vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  const mount = (themeId: string) => flushSync(() => root.render(<Theme appearance="light"><MarkdownPreview title="示例" markdown="正文 $5\n\n> 引用" themeId={themeId} revision={0} /></Theme>));
  mount("gzh-moyu-green");
  const preview = container.querySelector<HTMLElement>(".markdown-preview")!;
  await vi.waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
  const article = preview.shadowRoot!.querySelector("article > div")!;
  const light = article.innerHTML;
  preview.scrollTop = 120;
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.preview-appearance button')];
  const [bright, dark] = buttons;
  expect(bright.getAttribute("aria-pressed")).toBe("true");
  flushSync(() => dark.click());
  expect(dark.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector(".preview-phone-screen")?.classList.contains("dark")).toBe(true);
  expect(article.innerHTML).not.toBe(light);
  expect(preview.scrollTop).toBe(120);
  expect(graphics).toHaveBeenCalledTimes(1);
  flushSync(() => bright.click());
  expect(article.innerHTML).toBe(light);
  flushSync(() => dark.click());
  mount("gzh-red-white");
  await vi.waitFor(() => expect(container.querySelector(".preview-theme-label")?.textContent).toBe("红白色系"));
  const darkText = (article.firstElementChild as HTMLElement).style.color;
  expect(container.querySelector(".preview-phone-screen")?.classList.contains("dark")).toBe(true);
  flushSync(() => bright.click());
  expect((article.firstElementChild as HTMLElement).style.color).not.toBe(darkText);
  flushSync(() => dark.click());
  flushSync(() => bright.click());
  const restored = article.innerHTML;
  flushSync(() => dark.click());
  flushSync(() => bright.click());
  expect(article.innerHTML).toBe(restored);
  expect(container.querySelector(".markdown-preview")).toBe(preview);
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
      {!switchDocument && editor.current && <Outline editor={editor.current} readOnly={reading} />}
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

it("replaces the current tab without an exit visual and still animates a later explicit close", () => {
  const first = new SaveQueue(entry("one", "第一篇"), vi.fn(), () => {});
  const second = new SaveQueue(entry("two", "第二篇"), vi.fn(), () => {});
  const third = new SaveQueue(entry("three", "第三篇"), vi.fn(), () => {});
  const next = new SaveQueue(entry("next", "新文章"), vi.fn(), () => {});
  const replacement = { from: "two", to: "next" };
  function render(sessions: SaveQueue[], replaced?: typeof replacement) {
    flushSync(() => root.render(<Theme><DocumentTabs sessions={sessions} replacement={replaced} activeId={sessions[1].entry.id} categories={[]}
      readingIds={[]} lockedIds={[]} onMove={vi.fn()} onSwitch={vi.fn()} onClose={vi.fn()} onAction={vi.fn()}
      onReorder={vi.fn()} onRename={vi.fn()} onError={vi.fn()} /></Theme>));
  }
  render([first, second, third]);
  render([first, third]);
  expect(container.querySelector(".tab-exiting")?.textContent).toBe("第二篇");
  render([first, second, third]);
  expect(container.querySelector(".tab-exiting")).toBeNull();
  render([first, next, third], replacement);
  expect([...container.querySelectorAll(".tabs > .tab")].map(tab => tab.getAttribute("data-tab-id"))).toEqual(["one", "next", "three"]);
  expect(container.querySelector(".tab-exiting")).toBeNull();
  render([first, next, third, second], replacement);
  render([first, next, third], replacement);
  expect(container.querySelector(".tab-exiting")?.textContent).toBe("第二篇");
  for (const queue of [first, second, third, next]) queue.dispose();
});

it("keeps only noninteractive exit visuals after tabs close and honors reduced motion", async () => {
  const first = new SaveQueue(entry("one", "第一篇"), vi.fn(), () => {});
  const second = new SaveQueue(entry("two", "第二篇"), vi.fn(), () => {});
  const collection = { id: "canvas", title: "专题", description: "", createdAt: 0, updatedAt: 0, viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 0 };
  function render(sessions: SaveQueue[], withCollection = false) {
    flushSync(() => root.render(<Theme><DocumentTabs sessions={sessions} activeId="one" categories={[]}
      collections={withCollection ? [collection] : []} readingIds={[]} lockedIds={[]} onMove={vi.fn()}
      onSwitch={vi.fn()} onClose={vi.fn()} onAction={vi.fn()} onReorder={vi.fn()} onRename={vi.fn()} onError={vi.fn()} /></Theme>));
  }
  render([first, second], true);
  render([first]);
  second.dispose();
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect([...container.querySelectorAll(".tab-exiting")].map(tab => tab.textContent)).toEqual(["第二篇", "专题"]);
  expect(container.querySelector('.tab-exiting button')).toBeNull();
  await vi.waitFor(() => expect(container.querySelector('.tab-exiting')).toBeNull());
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  render([first, second], true);
  render([first]);
  expect(container.querySelector('.tab-exiting')).toBeNull();
  first.dispose();
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
    Object.defineProperty(list.parentElement, "clientWidth", { value: 332 });
    list.getBoundingClientRect = () => new DOMRect(0, 0, 280, 32);
    secondRow.getBoundingClientRect = () => new DOMRect(130, 0, 150, 32);
    list.setPointerCapture = vi.fn();
    list.scrollBy = vi.fn();
    flushSync(() => imitateResize.mock.calls[0][0]([], {} as ResizeObserver));
    const next = container.querySelector<HTMLButtonElement>('[aria-label="向右滚动标签页"]')!;
    expect(container.querySelector('[aria-label="向左滚动标签页"]')).toBeNull();
    expect(next.closest(".tab-scroll-slot")).toBe(list.nextElementSibling);
    const startSlot = list.previousElementSibling;
    const endSlot = list.nextElementSibling;
    next.click();
    expect(list.scrollBy).toHaveBeenCalledWith({ left: 182, behavior: "smooth" });
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 18, cancelable: true }));
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 12, cancelable: true }));
    expect(list.scrollLeft).toBe(0);
    await vi.waitFor(() => expect(list.scrollLeft).toBe(30));
    list.scrollLeft = 132;
    flushSync(() => list.dispatchEvent(new Event("scroll")));
    expect(container.querySelector('[aria-label="向右滚动标签页"]')).toBeNull();
    const previous = container.querySelector<HTMLButtonElement>('[aria-label="向左滚动标签页"]')!;
    expect(previous.closest(".tab-scroll-slot")).toBe(list.previousElementSibling);
    expect(list.previousElementSibling).toBe(startSlot);
    expect(list.nextElementSibling).toBe(endSlot);
    previous.click();
    expect(list.scrollBy).toHaveBeenLastCalledWith({ left: -182, behavior: "smooth" });

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

it("keeps the last active tab at the scroll end as the workspace changes width", () => {
  const first = new SaveQueue(entry("one", "第一篇"), vi.fn(), () => {});
  const second = new SaveQueue(entry("two", "第二篇"), vi.fn(), () => {});
  let resize!: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {}
  });
  flushSync(() => root.render(<Theme><DocumentTabs sessions={[first, second]} activeId="two" categories={[]}
    readingIds={[]} lockedIds={[]} onMove={vi.fn()} onSwitch={vi.fn()} onClose={vi.fn()}
    onAction={vi.fn()} onReorder={vi.fn()} onRename={vi.fn()} onError={vi.fn()} /></Theme>));
  const viewport = container.querySelector<HTMLDivElement>(".tabs")!;
  const strip = viewport.parentElement!;
  let width = 310;
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width },
    scrollWidth: { get: () => Math.max(412, width) },
  });
  Object.defineProperty(strip, "clientWidth", { get: () => width + 52 });
  const resizeTo = (nextWidth: number) => {
    width = nextWidth;
    flushSync(() => resize([], {} as ResizeObserver));
  };
  try {
    resizeTo(310);
    expect(viewport.scrollLeft).toBe(102);
    expect(strip.children[1]).toBe(viewport);
    resizeTo(240);
    expect(viewport.scrollLeft).toBe(172);
    resizeTo(340);
    expect(viewport.scrollLeft).toBe(72);
    resizeTo(420);
    expect(viewport.scrollLeft).toBe(0);
    expect(strip.querySelector(".tab-scroll-slot")).toBeNull();
    expect(strip.firstElementChild).toBe(viewport);
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
    flushSync(() => queue.edit({ themeId: "gzh-zen-whitespace" }));
    expect(editor.dataset.wechatTheme).toBe("gzh-zen-whitespace");
    expect(editor.querySelector(".ProseMirror")).toBe(body);
    mount(true);
    expect(container.querySelector('input[aria-label="内容标题"]')).toBeNull();
  } finally {
    queue.dispose();
  }
});

it("shows only the current import result in the dialog", async () => {
  const importNow = vi.spyOn(desktop, "importLink").mockResolvedValue({ kind: "wechat", job: {
    id: "job", url: "https://mp.weixin.qq.com/s/demo", status: "partial", entryId: "entry", error: null, pendingImages: 2,
  }});
  const onOpen = vi.fn();
  const onImported = vi.fn();
  flushSync(() => root.render(<Theme><LinkImportDialog categoryId="folder" downloadImages onClose={vi.fn()} track={job => job} onOpen={onOpen} onImported={onImported} /></Theme>));
  const input = document.querySelector<HTMLInputElement>('input[type="url"]')!;
  flushSync(() => {
    setInput.call(input, "https://mp.weixin.qq.com/s/demo");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(document.querySelector(".wechat-job")?.textContent).toContain("补图（2）"));
  expect(importNow).toHaveBeenCalledExactlyOnceWith("https://mp.weixin.qq.com/s/demo", "folder", true);
  expect(onImported).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
  expect(document.querySelectorAll(".wechat-job")).toHaveLength(1);
});

it("keeps the source and publishing fields available on an imported note", async () => {
  const note = entry("imported", "导入的笔记");
  note.source = { url: "https://mp.weixin.qq.com/s/demo", author: "作者", accountName: "公众号",
    originalPublishedAt: null, importedAt: null };
  const queue = new SaveQueue(note, vi.fn().mockResolvedValue({ version: 2 }), vi.fn());
  try {
    flushSync(() => root.render(<Theme><PropertiesDialog id={note.id} queue={queue} categories={[]} tagSuggestions={[]}
      locked={false} onClose={vi.fn()} onOpen={vi.fn()}
      onSave={async (_, change) => { queue.edit(change); await queue.flush({ retry: true }); }} /></Theme>));
    const source = document.querySelector<HTMLInputElement>('input[name="sourceUrl"]')!;
    expect(source.value).toBe(note.source.url);
    expect(document.querySelector('input[name="publishedUrl"]')).toBeNull();
    const add = document.querySelector(".property-add")!;
    flushSync(() => add.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    const option = await vi.waitFor(() => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(row => row.textContent === "发布平台");
      expect(item).toBeDefined();
      return item!;
    });
    flushSync(() => option.click());
    const platform = document.querySelector<HTMLInputElement>('[aria-label="发布平台 1"]')!;
    flushSync(() => {
      setInput.call(platform, "微信公众号");
      platform.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const published = document.querySelector<HTMLInputElement>('[aria-label="发布链接 1"]')!;
    flushSync(() => {
      setInput.call(published, "https://mp.weixin.qq.com/s/published");
      published.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => published.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(queue.snapshot().fields.source).toEqual(note.source);
    await vi.waitFor(() => expect(queue.snapshot().fields.publicationPlatforms).toEqual([{ platform: "微信公众号", url: "https://mp.weixin.qq.com/s/published" }]));
  } finally { queue.dispose(); }
});
