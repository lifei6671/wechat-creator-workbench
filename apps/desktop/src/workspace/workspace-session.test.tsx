// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Collection, Entry, EntryPage } from "../../../../packages/shared-types";
import { desktop, type AiHistoryItem, type AiStreamEvent } from "../desktop";
import { AiPanel } from "./AiPanel";
import { DesktopShell } from "./DesktopShell";
import type { DocumentEditor } from "./Document";
import type { CollectionCanvas } from "./CollectionCanvas";
import { readDocumentTabs, saveDocumentTabs, saveWorkspaceLayout } from "./preferences";
import { SaveQueue } from "../editor/save-queue";
import * as markdown from "../../../../packages/markdown-core";

vi.mock(import("./Document"), async importOriginal => ({
  ...await importOriginal(),
  DocumentEditor: ({ queue, display, onDisplayChange }: ComponentProps<typeof DocumentEditor>) => (
    <button data-document={queue.entry.id} data-links={display.convertLinks} data-body={queue.snapshot().fields.contentMd}
      onClick={() => onDisplayChange("convertLinks", !display.convertLinks)}>切换链接脚注</button>
  ),
}));

vi.mock(import("./CollectionCanvas"), () => ({
  CollectionCanvas: ({ collection, onLoadArticle, onSaveArticle }: ComponentProps<typeof CollectionCanvas>) => <>
    <h1 data-canvas={collection.id}>{collection.title}</h1>
    {collection.id === "canvas-edit" && <button type="button" id="save-canvas-article" onClick={() => {
      void onLoadArticle("article-one").then(entry => onSaveArticle(entry.id, entry.version, { ...entry, contentMd: "## 从画布保存" }, "auto"));
    }}>保存卡片</button>}
  </>,
}));

const workspaceId = "session-test";
const entry = (id: string, categoryId: string | null = null): Entry => ({
  id, categoryId, title: id, kind: "article", contentMd: "", status: "draft", updatedAt: 0, deletedAt: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, links: [],
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(desktop, "library").mockResolvedValue({ workspaceId, tags: [], tagSuggestions: [], categories: [
    { id: "closed", parentId: null, sortOrder: 0, name: "已折叠", icon: "folder" },
    { id: "expanded", parentId: null, sortOrder: 1, name: "已展开", icon: "folder" },
  ] });
  vi.spyOn(desktop, "entries").mockImplementation(async filter => ({ items: filter.pinned || filter.categoryId ? [] : [entry("manual")], nextOffset: null }));
  vi.spyOn(desktop, "collections").mockResolvedValue([]);
  vi.spyOn(desktop, "imageStorageTarget").mockResolvedValue(null);
  vi.spyOn(desktop, "mcpStatus").mockResolvedValue({ running: false, config: { enabled: false, port: 8787, permission: "read" }, error: null });
  vi.spyOn(desktop, "restoreNotice").mockResolvedValue(null);
  for (const event of ["onExit", "onWorkspaceChanged", "onAssetsChanged", "onBackupProgress", "onMcpStatusChanged"] as const) {
    vi.spyOn(desktop, event).mockResolvedValue(() => {});
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openTabs() {
  return [...container.querySelectorAll('[role="tab"]')].map(tab => tab.id.replace(/^tab-/, ""));
}

it("creates and renames topics inline in the directory sidebar", async () => {
  const existing = { id: "existing", title: "未命名", description: "已有描述", createdAt: 0, updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 0 };
  vi.spyOn(desktop, "collections").mockResolvedValue([existing]);
  const save = vi.spyOn(desktop, "saveCollection").mockImplementation(async (id, title, description) => ({
    ...existing, id: id ?? "created", title, description,
  }));
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const input = () => container.querySelector<HTMLInputElement>('#collection-list input[aria-label="专题名称"]');
  const key = (key: string) => flushSync(() => input()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  const changeName = (value: string) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")).not.toBeNull());
  click("#hide-sidebar");
  click('[aria-label="命令面板"]');
  const command = [...document.querySelectorAll<HTMLButtonElement>('.command-row')].find(option => option.textContent === "新建专题")!;
  flushSync(() => command.click());
  await vi.waitFor(() => expect(input()).not.toBeNull());
  expect(container.querySelector("#show-sidebar")).toBeNull();
  expect(input()!.value).toBe("未命名 2");
  expect(input()!.closest("li")).toBe(container.querySelector("#collection-list")?.lastElementChild);
  expect(document.activeElement).toBe(input());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  key("Escape");
  expect(input()).toBeNull();
  expect(save).not.toHaveBeenCalled();

  const newContent = container.querySelector<HTMLButtonElement>('[aria-label="新建内容"]')!;
  flushSync(() => newContent.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const menuCreate = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "新建专题")!;
  flushSync(() => menuCreate.click());
  await vi.waitFor(() => expect(document.activeElement).toBe(input()));
  key("Escape");
  expect(save).not.toHaveBeenCalled();

  click('.tree-section-title[aria-controls="collection-list"]');
  click("#add-collection");
  expect(input()).not.toBeNull();
  changeName("新专题");
  key("Enter");
  await vi.waitFor(() => expect(container.querySelector('[data-canvas="created"]')?.textContent).toBe("新专题"));
  expect(save).toHaveBeenCalledExactlyOnceWith(null, "新专题", "");
  expect(container.querySelector("#collection-row-created")?.getAttribute("aria-current")).toBe("true");
  expect([...container.querySelectorAll("#collection-list .entry-row")].map(row => row.id)).toEqual([
    "collection-row-existing", "collection-row-created",
  ]);
  expect(container.querySelector("#collection-tab-created")?.getAttribute("aria-selected")).toBe("true");

  const existingRow = container.querySelector("#collection-row-existing")!;
  flushSync(() => existingRow.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "重命名")!;
  flushSync(() => rename.click());
  await vi.waitFor(() => expect(input()).not.toBeNull());
  expect(input()!.value).toBe("未命名");
  changeName("重命名专题");
  flushSync(() => container.querySelector<HTMLButtonElement>("#collection-row-created")!.focus());
  await vi.waitFor(() => expect(container.querySelector("#collection-row-existing")?.textContent).toBe("重命名专题"));
  expect(save).toHaveBeenLastCalledWith("existing", "重命名专题", "已有描述");
  expect(container.querySelector("#collection-row-created")?.getAttribute("aria-current")).toBe("true");
});

it("waits for the topic name committed on blur before closing the workspace", async () => {
  let requestExit!: () => void;
  vi.mocked(desktop.onExit).mockImplementation(async callback => { requestExit = callback; return () => {}; });
  vi.spyOn(desktop, "collections").mockResolvedValue([]);
  let resolveSave!: (collection: Collection) => void;
  const pending = new Promise<Collection>(resolve => { resolveSave = resolve; });
  const save = vi.spyOn(desktop, "saveCollection").mockReturnValue(pending);
  const beginExit = vi.spyOn(desktop, "beginExit").mockResolvedValue(undefined);
  const finishExit = vi.spyOn(desktop, "finishExit").mockResolvedValue(undefined);
  saveWorkspaceLayout({ section: "collections", explorerOverride: true, timelineDirectory: "shown", focusMode: false, aiOpen: false });
  flushSync(() => root.render(<DesktopShell />));
  const create = container.querySelector<HTMLButtonElement>("#add-collection")!;
  await vi.waitFor(() => expect(create.disabled).toBe(false));
  flushSync(() => create.click());
  expect(document.activeElement?.getAttribute("aria-label")).toBe("专题名称");
  flushSync(() => requestExit());
  await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(null, "未命名", ""));
  expect(beginExit).not.toHaveBeenCalled();
  resolveSave({ id: "saved-on-exit", title: "未命名", description: "", createdAt: 0, updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 0 });
  await vi.waitFor(() => expect(finishExit).toHaveBeenCalledOnce());
  expect(beginExit).toHaveBeenCalledOnce();
});

it("switches between and restores open topic and article tabs", async () => {
  const topics = ["topic-one", "topic-two"].map(id => ({ id, title: id, description: "", createdAt: 0, updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 0 }));
  vi.mocked(desktop.collections).mockResolvedValue(topics);
  saveDocumentTabs(workspaceId, { ids: ["article-one"], activeId: "article-one" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const active = () => container.querySelector('[role="tab"][aria-selected="true"]')?.id;
  const render = () => flushSync(() => root.render(<DesktopShell />));
  render();
  await vi.waitFor(() => expect(active()).toBe("tab-article-one"));
  click('.sidebar-chrome [aria-label="专题"]');
  await vi.waitFor(() => expect(container.querySelector("#collection-row-topic-one")).not.toBeNull());
  click("#collection-row-topic-one");
  await vi.waitFor(() => expect(active()).toBe("collection-tab-topic-one"));
  click("#collection-row-topic-two");
  await vi.waitFor(() => expect(active()).toBe("collection-tab-topic-two"));
  click("#tab-article-one");
  await vi.waitFor(() => expect(active()).toBe("tab-article-one"));
  expect(container.querySelector("#collection-tab-topic-one")).not.toBeNull();

  flushSync(() => root.unmount());
  root = createRoot(container);
  render();
  await vi.waitFor(() => expect(container.querySelector("#collection-tab-topic-two")).not.toBeNull());
  expect(active()).toBe("tab-article-one");
  click("#collection-tab-topic-one");
  expect(active()).toBe("collection-tab-topic-one");
  click('[aria-label="关闭 topic-one"]');
  expect(active()).toBe("collection-tab-topic-two");
  click('[aria-label="关闭 topic-two"]');
  expect(active()).toBe("tab-article-one");
  expect(container.querySelector('[id^="collection-tab-"]')).toBeNull();

  click('.sidebar-chrome [aria-label="专题"]');
  click("#collection-row-topic-one");
  click("#tab-article-one");
  click('[aria-label="关闭 article-one"]');
  await vi.waitFor(() => expect(active()).toBe("collection-tab-topic-one"));
});

it("keeps the canvas active after saving and refreshes the original article tab", async () => {
  const topic: Collection = { id: "canvas-edit", title: "专题", description: "", createdAt: 0, updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 1 };
  vi.mocked(desktop.collections).mockResolvedValue([topic]);
  const article = { ...entry("article-one"), contentMd: "原正文", version: 7 };
  vi.spyOn(desktop, "entry").mockResolvedValue(article);
  const save = vi.spyOn(desktop, "save").mockResolvedValue({ version: 8 });
  saveDocumentTabs(workspaceId, { ids: [article.id], activeId: article.id });
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[data-document="article-one"]')?.getAttribute("data-body")).toBe("原正文"));
  click('.sidebar-chrome [aria-label="专题"]');
  click("#collection-row-canvas-edit");
  await vi.waitFor(() => expect(container.querySelector("#save-canvas-article")).not.toBeNull());
  click("#save-canvas-article");
  await vi.waitFor(() => expect(container.querySelector('[data-document="article-one"]')?.getAttribute("data-body")).toBe("## 从画布保存"));
  expect(save).toHaveBeenCalledExactlyOnceWith(article.id, 7, expect.objectContaining({ contentMd: "## 从画布保存" }), "auto");
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("collection-tab-canvas-edit");
  click("#tab-article-one");
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("tab-article-one");
});

it("adds an article from its context menu without opening the topic", async () => {
  const topic = { id: "reading-list", title: "待研究", description: "", createdAt: 0, updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 0 };
  vi.mocked(desktop.collections).mockResolvedValue([topic]);
  vi.spyOn(desktop, "collectionCanvas").mockResolvedValue({ collection: topic, nodes: [], edges: [] });
  const add = vi.spyOn(desktop, "createCollectionNode").mockResolvedValue({
    id: "reference", collectionId: topic.id, kind: "entry", entryId: "manual", assetId: null, color: null, contentMd: "", entry: null,
    x: 24, y: 24, width: 320, height: 144, createdAt: 0, updatedAt: 0,
  });
  flushSync(() => root.render(<DesktopShell />));
  const row = await vi.waitFor(() => {
    const target = container.querySelector("#entry-row-manual");
    expect(target).not.toBeNull();
    return target!;
  });
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "加入专题")!;
  flushSync(() => { item.focus(); item.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  const destination = await vi.waitFor(() => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === topic.title);
    expect(option).toBeDefined();
    return option!;
  });
  flushSync(() => destination.click());
  await vi.waitFor(() => expect(add).toHaveBeenCalledExactlyOnceWith(topic.id, { kind: "entry", entryId: "manual" }, { x: 24, y: 24 }));
  await vi.waitFor(() => expect(container.textContent).toContain("已加入「待研究」"));
  expect(container.querySelector("#collection-tab-reading-list")).toBeNull();
});

it("restores pending article tabs while the user opens a topic", async () => {
  const topic = { id: "topic", title: "专题", description: "", createdAt: 0, updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 0 };
  vi.mocked(desktop.collections).mockResolvedValue([topic]);
  saveDocumentTabs(workspaceId, { ids: ["pending-article"], activeId: "pending-article" });
  let resolveEntry!: (value: Entry) => void;
  const load = vi.spyOn(desktop, "entry").mockReturnValue(new Promise<Entry>(resolve => { resolveEntry = resolve; }));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(load).toHaveBeenCalledWith("pending-article"));
  flushSync(() => container.querySelector<HTMLButtonElement>('.sidebar-chrome [aria-label="专题"]')!.click());
  await vi.waitFor(() => expect(container.querySelector("#collection-row-topic")).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>("#collection-row-topic")!.click());
  resolveEntry(entry("pending-article"));
  await vi.waitFor(() => expect(container.querySelector("#tab-pending-article")).not.toBeNull());
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("collection-tab-topic");
});

it.each([
  ["current", ["first", "manual"]],
  ["new-tab", ["first", "second", "manual"]],
] as const)("opens a clicked document using the saved %s preference", async (mode, expected) => {
  localStorage.setItem("document-open-mode", JSON.stringify(mode));
  saveDocumentTabs(workspaceId, { ids: ["first", "second"], activeId: "second" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("tab-second"));
  flushSync(() => container.querySelector<HTMLButtonElement>("#entry-row-manual")!.click());
  await vi.waitFor(() => expect(openTabs()).toEqual(expected));
  expect(readDocumentTabs(workspaceId)).toEqual({ ids: expected, activeId: "manual" });
});

it("restores the last sidebar and document views while keeping their defaults", async () => {
  localStorage.setItem("explorer", "true");
  localStorage.setItem("links-to-footnotes", "false");
  localStorage.setItem("view", JSON.stringify("edit"));
  saveDocumentTabs(workspaceId, { ids: ["first", "second"], activeId: "first" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const preview = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".status-bar button"))
    .find(button => button.textContent === "预览排版")!;
  const links = (id: string) => container.querySelector<HTMLElement>(`[data-document="${id}"]`)?.dataset.links;
  await vi.waitFor(() => expect(links("first")).toBe("false"));
  click('[data-document="first"]');
  expect(links("first")).toBe("true");
  expect(links("second")).toBe("false");
  flushSync(() => preview().click());
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("preview");
  click("#hide-sidebar");
  expect(container.querySelector("#show-sidebar")).not.toBeNull();
  click("#tab-second");
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("edit");
  click('.status-bar [aria-label="设置"]');
  await vi.waitFor(() => expect(document.querySelector("#explorer-visibility")?.getAttribute("aria-checked")).toBe("true"));
  expect(document.querySelector("#links-to-footnotes")?.getAttribute("aria-checked")).toBe("false");
  expect(document.querySelector("#preferred-view")?.textContent).toBe("编辑");
  expect(localStorage.getItem("links-to-footnotes")).toBe("false");
  expect(localStorage.getItem("explorer")).toBe("true");
  expect(localStorage.getItem("view")).toBe(JSON.stringify("edit"));

  flushSync(() => root.unmount());
  root = createRoot(container);
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(links("first")).toBe("true"));
  expect(links("second")).toBe("false");
  expect(container.querySelector("#show-sidebar")).not.toBeNull();
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("edit");
  click("#tab-first");
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("preview");
});

it("restores the timeline selection, its collapsed date and tree groups, and the manually hidden directory pane", async () => {
  const initial = await desktop.library();
  vi.mocked(desktop.library).mockResolvedValue({ ...initial, tags: [{ id: "wechat", name: "微信" }] });
  const row = { ...entry("时间流文章", "closed"), updatedAt: Date.now() };
  vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: filter.categoryId === "closed" && filter.includePreview && !filter.pinned ? [row] : [], nextOffset: null,
  }));
  const render = () => flushSync(() => root.render(<DesktopShell />));
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const expanded = (selector: string) => container.querySelector(selector)?.getAttribute("aria-expanded");
  const heading = () => container.querySelector(".timeline-heading h1")?.textContent;
  const group = ".timeline-group-toggle";
  render();
  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")).not.toBeNull());
  click('[aria-label="文章时间流"]');
  click("#folder-row-closed");
  await vi.waitFor(() => expect(expanded(group)).toBe("true"));
  click('.timeline-heading [aria-label="包含子目录"]');
  await vi.waitFor(() => expect(container.querySelector(".timeline-entries")?.getAttribute("aria-busy")).toBe("false"));
  click(group);
  click('[aria-controls="timeline-tags"]');
  click('[aria-controls="tree-directory-list"]');
  click("#hide-timeline-directory");
  expect(container.querySelector("#show-timeline-directory")).not.toBeNull();

  flushSync(() => root.unmount());
  root = createRoot(container);
  render();
  await vi.waitFor(() => expect(heading()).toBe("已折叠"));
  expect(container.querySelector("#show-timeline-directory")).not.toBeNull();
  expect(container.querySelector('.timeline-heading [aria-label="包含子目录"]')?.getAttribute("aria-pressed")).toBe("false");
  await vi.waitFor(() => expect(expanded(group)).toBe("false"));
  click("#show-timeline-directory");
  expect(expanded('[aria-controls="timeline-tags"]')).toBe("false");
  expect(expanded('[aria-controls="tree-directory-list"]')).toBe("false");
});

it("keeps the AI pane hidden while the saved reading tab loads", async () => {
  saveDocumentTabs(workspaceId, { ids: ["saved"], activeId: "saved", readingIds: ["saved"] });
  saveWorkspaceLayout({ section: "timeline", explorerOverride: null, timelineDirectory: "shown", focusMode: false, aiOpen: true });
  let resolveEntry!: (value: Entry) => void;
  const load = vi.spyOn(desktop, "entry").mockReturnValue(new Promise<Entry>(resolve => { resolveEntry = resolve; }));
  const aiDivider = () => container.querySelector('[aria-label="调整 AI 侧栏宽度"]');
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(load).toHaveBeenCalledWith("saved"));
  expect(aiDivider()).toBeNull();
  resolveEntry(entry("saved"));
  const reading = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>('[aria-label="退出阅读模式"]');
    expect(button).not.toBeNull();
    return button!;
  });
  expect(aiDivider()).toBeNull();
  flushSync(() => reading.click());
  expect(aiDivider()).not.toBeNull();
});

it("browses a folder and its descendants in the timeline while opening the document in the existing editor", async () => {
  const initial = await desktop.library();
  vi.mocked(desktop.library).mockResolvedValue({ ...initial, categories: [...initial.categories,
    { id: "child", parentId: "closed", sortOrder: 0, name: "子目录", icon: "folder" },
  ] });
  const first = { ...entry("父目录文章", "closed"), updatedAt: new Date(2025, 2, 7, 10).getTime(),
    preview: { summary: "父目录摘要", image: null } };
  const second = { ...entry("子目录文章", "child"), updatedAt: new Date(2025, 3, 7, 10).getTime(),
    preview: { summary: "子目录摘要", image: "asset://one" } };
  let firstPageMore = true;
  const setPin = vi.spyOn(desktop, "setEntryPinned").mockImplementation(async (_id, pinned) => { second.pinned = pinned; });
  vi.mocked(desktop.entries).mockImplementation(async filter => {
    if (!filter.includePreview) return { items: filter.exactCategory && !filter.categoryId ? [entry("旧目录内容")] : [], nextOffset: null };
    if (filter.pinned) return { items: second.pinned && !filter.exactCategory && filter.categoryId !== "expanded" ? [second] : [], nextOffset: null };
    if (filter.categoryId === "expanded") return { items: [], nextOffset: null };
    if (filter.categoryId === "closed" && filter.exactCategory) return { items: [first], nextOffset: null };
    if (filter.categoryId === "closed" && filter.offset === 0) return (filter.limit ?? 0) > 60
      ? { items: second.pinned ? [first] : [second, first], nextOffset: null } : { items: [second], nextOffset: 1 };
    if (filter.categoryId === "closed" && firstPageMore) {
      firstPageMore = false;
      throw new Error("分页读取失败");
    }
    return { items: filter.categoryId === "closed" ? [first] : [second, first], nextOffset: null };
  });
  vi.spyOn(desktop, "entry").mockResolvedValue(second);
  flushSync(() => root.render(<DesktopShell />));
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const rows = () => [...container.querySelectorAll<HTMLElement>(".timeline-entry")];
  const openRow = (index: number) => rows()[index].querySelector<HTMLButtonElement>(".timeline-entry-open")!;
  const titles = () => rows().map(row => row.querySelector("strong")!.textContent);
  await vi.waitFor(() => expect(container.querySelector('[data-tree-id="旧目录内容"]')).not.toBeNull());
  click('.sidebar-chrome [aria-label="文章时间流"]');
  expect(container.querySelector(".timeline-pane")).not.toBeNull();
  expect(container.querySelector(".timeline-entries")).not.toBeNull();
  expect(container.querySelector("#timeline-root-folder")?.getAttribute("aria-current")).toBe("true");
  expect(container.querySelector(".timeline-folders")?.textContent).not.toContain("全部文章");
  expect(desktop.entries).toHaveBeenCalledWith(expect.objectContaining({ exactCategory: true, includePreview: true }));
  expect(container.querySelector(".sidebar-chrome #hide-sidebar")).toBeNull();
  expect(container.querySelector(".timeline-chrome #hide-sidebar")).not.toBeNull();
  expect(container.querySelector('[data-tree-kind="entry"]')).toBeNull();
  const branch = container.querySelector<HTMLUListElement>("#folder-closed")!;
  const folderToggle = 'button.timeline-folder-toggle[aria-controls="folder-closed"]';
  expect(branch.hasAttribute("inert")).toBe(true);
  click(folderToggle);
  expect(branch.hasAttribute("inert")).toBe(false);
  expect(container.querySelector(".timeline-folder-title h1")?.textContent).toBe("根目录");
  click(folderToggle);
  expect(branch.hasAttribute("inert")).toBe(true);
  click("#folder-row-closed");
  await vi.waitFor(() => expect(titles()).toEqual(["子目录文章"]));
  expect(branch.hasAttribute("inert")).toBe(true);
  expect(container.querySelector("#folder-row-closed")?.hasAttribute("aria-expanded")).toBe(false);
  expect(container.querySelector(".timeline-folder-title h1")?.textContent).toBe("已折叠");
  expect(container.querySelector(".timeline-folder-title svg")).not.toBeNull();
  click(folderToggle);
  click("#folder-row-closed");
  expect(branch.hasAttribute("inert")).toBe(false);
  expect(container.querySelector("#folder-closed")).toBe(branch);
  expect(titles()).toEqual(["子目录文章"]);
  expect(desktop.entries).toHaveBeenCalledWith(expect.objectContaining({
    categoryId: "closed", exactCategory: false, sort: "updated", kind: "article", includePreview: true, pinned: false,
  }));
  expect(rows()[0].textContent).toContain("子目录摘要");
  expect(rows()[0].querySelector(".timeline-cover")).not.toBeNull();
  expect(rows()[0].querySelector("time")?.dateTime).toBe(new Date(second.updatedAt).toISOString());
  const more = [...container.querySelectorAll("button")].find(button => button.textContent === "加载更多")!;
  more.focus();
  flushSync(() => more.click());
  await vi.waitFor(() => expect(more.textContent).toBe("重试"));
  expect(document.activeElement).toBe(more);
  flushSync(() => more.click());
  await vi.waitFor(() => expect(titles()).toEqual(["子目录文章", "父目录文章"]));
  expect(document.activeElement).toBe(openRow(1));
  flushSync(() => openRow(0).click());
  await vi.waitFor(() => expect(container.querySelector('[data-document="子目录文章"]')).not.toBeNull());
  expect(container.querySelector("#folder-row-closed")?.getAttribute("aria-current")).toBe("true");
  expect(openRow(0).getAttribute("aria-current")).toBe("true");
  const dateGroup = rows()[0].closest(".timeline-group")!;
  const dateToggle = dateGroup.querySelector<HTMLButtonElement>(".timeline-group-toggle")!;
  flushSync(() => dateToggle.click());
  expect(dateToggle.getAttribute("aria-expanded")).toBe("false");
  expect(dateGroup.querySelector("ul")?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector(".sidebar-chrome #hide-timeline-directory")).toBeNull();
  click(".directory-tools #hide-timeline-directory");
  expect(container.querySelector("#timeline-directory .sidebar-workspace")?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector(".timeline-workspace")?.hasAttribute("inert")).toBe(false);
  const timelineNav = container.querySelector(".timeline-chrome .button-strip")!;
  expect(timelineNav.parentElement?.querySelector("#show-timeline-directory")).toBeNull();
  expect(timelineNav.firstElementChild?.getAttribute("aria-label")).toBe("内容目录");
  const timelineTitle = container.querySelector(".timeline-folder-title")!;
  expect(timelineTitle.firstElementChild?.id).toBe("show-timeline-directory");
  expect(timelineTitle.firstElementChild?.nextElementSibling?.tagName).toBe("svg");
  expect(container.querySelector(".timeline-group")).toBe(dateGroup);
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("show-timeline-directory"));
  click("#show-timeline-directory");
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("hide-timeline-directory"));
  expect(container.querySelector("#timeline-directory .sidebar-workspace")?.hasAttribute("inert")).toBe(false);
  expect(container.querySelector("#folder-row-closed")?.getAttribute("aria-current")).toBe("true");
  click("#hide-sidebar");
  expect(container.querySelector(".sidebar-workspace")?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector(".timeline-workspace")?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector('[data-document="子目录文章"]')).not.toBeNull();
  click("#show-sidebar");
  expect(container.querySelector(".timeline-workspace")?.hasAttribute("inert")).toBe(false);
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("hide-sidebar"));
  expect(dateToggle.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => dateToggle.click());
  const pin = () => rows()[0].closest("li")!.querySelector<HTMLButtonElement>(".timeline-pin")!;
  pin().focus();
  flushSync(() => pin().click());
  await vi.waitFor(() => expect(rows()[0].closest("ul")?.getAttribute("aria-label")).toBe("已固定"));
  expect(titles()).toEqual(["子目录文章", "父目录文章"]);
  expect(setPin).toHaveBeenLastCalledWith(second.id, true);
  expect(document.activeElement).toBe(openRow(0));
  pin().focus();
  flushSync(() => pin().click());
  await vi.waitFor(() => expect(container.querySelector('.timeline-group ul[aria-label="已固定"]')).toBeNull());
  expect(titles()).toEqual(["子目录文章", "父目录文章"]);
  expect(document.activeElement).toBe(openRow(0));
  expect(setPin).toHaveBeenLastCalledWith(second.id, false);
  click('.timeline-pane [aria-label="包含子目录"]');
  await vi.waitFor(() => expect(titles()).toEqual(["父目录文章"]));
  expect(desktop.entries).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "closed", exactCategory: true }));
  click("#folder-row-expanded");
  await vi.waitFor(() => expect(container.querySelector(".timeline-entries")?.textContent).toBe("暂无文章"));
  click('.sidebar-chrome [aria-label="内容目录"]');
  expect(container.querySelector(".timeline-pane")).toBeNull();
  expect(container.querySelector(".sidebar-chrome #hide-sidebar")).not.toBeNull();
  expect(container.querySelector('[data-document="子目录文章"]')).not.toBeNull();
});

it("keeps the AI sidebar toggle in the writing header when the panel opens or closes", async () => {
  vi.spyOn(desktop, "aiSettings").mockResolvedValue({ preferences: { enabled: false, defaultTarget: null }, models: [], agents: [] });
  flushSync(() => root.render(<DesktopShell />));
  const toggle = container.querySelector<HTMLButtonElement>(".workbench-chrome #ai-panel-trigger")!;
  expect(toggle.getAttribute("aria-label")).toBe("显示 AI 侧栏");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => toggle.click());
  expect(toggle.getAttribute("aria-label")).toBe("隐藏 AI 侧栏");
  expect(container.querySelector(".ai-sidebar")?.hasAttribute("inert")).toBe(false);
  await vi.waitFor(() => expect(container.querySelector(".ai-panel")).not.toBeNull());
  flushSync(() => container.querySelector(".ai-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".ai-sidebar")?.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(toggle);
  expect(container.querySelector(".workbench-chrome #ai-panel-trigger")).toBe(toggle);
});

it("keeps timeline results visible until a folder or tag query settles and ignores superseded results", async () => {
  const library = await desktop.library();
  vi.mocked(desktop.library).mockResolvedValue({ ...library, tags: [{ id: "wechat", name: "微信" }] });
  const date = Date.now();
  const shared = { ...entry("shared"), title: "共用文章", updatedAt: date, preview: { summary: "", image: "asset://cover" } };
  const rootArticle = { ...entry("root-only"), title: "根目录专属文章", updatedAt: date };
  function deferredPage() {
    let resolve!: (page: EntryPage) => void;
    const promise = new Promise<EntryPage>(complete => { resolve = complete; });
    return { promise, resolve };
  }
  const superseded = deferredPage();
  const tagPage = deferredPage();
  const tagPins = deferredPage();
  vi.mocked(desktop.entries).mockImplementation(async filter => {
    if (!filter.includePreview) return { items: [], nextOffset: null };
    if (filter.tagIds?.includes("wechat")) return filter.pinned ? tagPins.promise : tagPage.promise;
    if (filter.pinned) return { items: [], nextOffset: null };
    if (filter.categoryId === "closed") return superseded.promise;
    return { items: [shared, rootArticle], nextOffset: null };
  });
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const heading = () => container.querySelector(".timeline-heading h1")?.textContent;
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")).not.toBeNull());
  click('.sidebar-chrome [aria-label="文章时间流"]');
  await vi.waitFor(() => expect(container.querySelector("#timeline-row-root-only")).not.toBeNull());
  const list = container.querySelector<HTMLDivElement>(".timeline-entries")!;
  const sharedRow = container.querySelector("#timeline-row-shared")!;
  const cover = sharedRow.closest(".timeline-entry")!.querySelector(".timeline-cover");
  expect(cover).not.toBeNull();
  list.scrollTop = 80;
  click("#folder-row-closed");
  expect(heading()).toBe("根目录");
  expect(list.getAttribute("aria-busy")).toBe("true");
  expect(list.closest("[inert]")).not.toBeNull();
  expect(list.textContent).toContain("根目录专属文章");
  expect(list.textContent).not.toContain("正在加载");
  click("#timeline-tag-wechat");
  tagPage.resolve({ items: [shared], nextOffset: null });
  await Promise.resolve();
  expect(heading()).toBe("根目录");
  expect(list.scrollTop).toBe(80);
  tagPins.resolve({ items: [{ ...entry("tag-pin"), title: "标签置顶文章", updatedAt: date }], nextOffset: null });
  await vi.waitFor(() => expect(heading()).toBe("微信"));
  expect(list.textContent).toContain("标签置顶文章");
  expect(list.textContent).not.toContain("根目录专属文章");
  expect(list.closest("[inert]")).toBeNull();
  expect(list.scrollTop).toBe(0);
  expect(container.querySelector(".timeline-entries")).toBe(list);
  expect(container.querySelector("#timeline-row-shared")).toBe(sharedRow);
  expect(sharedRow.closest(".timeline-entry")!.querySelector(".timeline-cover")).toBe(cover);
  superseded.resolve({ items: [entry("迟到的目录文章")], nextOffset: null });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(heading()).toBe("微信");
  expect(list.textContent).not.toContain("迟到的目录文章");
});

it("shows timeline article tags and navigates by counted folders and tags", async () => {
  const baseline = await desktop.library();
  vi.mocked(desktop.library).mockResolvedValue({ ...baseline,
    categories: [...baseline.categories, { id: "child", parentId: "closed", name: "子目录", icon: "folder", sortOrder: 0 }],
    tags: [{ id: "wechat", name: "微信" }],
    articleCounts: { root: 1, folders: { closed: 1, child: 2 }, tags: { wechat: 1 }, untagged: 2 },
  });
  const tagged = { ...entry("有标签的文章", "closed"), preview: { summary: "", image: null, tags: ["微信", "笔记"] } };
  const untagged = entry("无标签的文章", "child");
  vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: !filter.includePreview || filter.pinned ? [] : filter.untagged ? [untagged] : [tagged],
    nextOffset: null,
  }));
  flushSync(() => root.render(<DesktopShell />));
  const click = (query: string) => flushSync(() => container.querySelector<HTMLButtonElement>(query)!.click());
  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")).not.toBeNull());
  click('.sidebar-chrome [aria-label="文章时间流"]');
  const count = (selector: string) => container.querySelector(`${selector} .timeline-count`)?.textContent;
  expect(vi.mocked(desktop.library)).toHaveBeenCalledWith(true);
  await vi.waitFor(() => expect(count("#folder-row-closed")).toBe("3"));
  expect(count("#folder-row-expanded")).toBe("0");
  expect(container.querySelector("#timeline-tags")?.textContent).toBe("微信1无标签2");
  expect(container.querySelector("#timeline-root-folder")?.getAttribute("aria-current")).toBe("true");
  click("#folder-row-closed");
  await vi.waitFor(() => {
    expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("已折叠");
    expect(container.querySelector(".timeline-entry-tags")?.textContent).toBe("微信笔记");
  });
  expect(count("#folder-row-child")).toBe("2");
  expect(container.querySelector(".timeline-entry-tags")?.nextElementSibling?.tagName).toBe("TIME");
  click('.timeline-heading [aria-label="包含子目录"]');
  expect(count("#folder-row-closed")).toBe("1");
  const [wechatRow, untaggedRow] = container.querySelectorAll<HTMLButtonElement>(".timeline-tag-row");
  click('[aria-controls="timeline-tags"]');
  expect(container.querySelector("#timeline-tags")?.hasAttribute("inert")).toBe(true);
  const readArticle = vi.spyOn(desktop, "entry");
  await vi.waitFor(() => expect(container.querySelector(".timeline-entries")?.getAttribute("aria-busy")).toBe("false"));
  click(".timeline-entry-tags button");
  expect(wechatRow.getAttribute("aria-current")).toBe("true");
  expect(container.querySelector("#timeline-tags")?.hasAttribute("inert")).toBe(false);
  await vi.waitFor(() => expect(document.activeElement).toBe(wechatRow));
  expect(readArticle).not.toHaveBeenCalled();
  expect(container.querySelector("#folder-row-closed")?.getAttribute("aria-current")).toBeNull();
  await vi.waitFor(() => expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("微信"));
  expect(container.querySelector('.timeline-heading [aria-label="包含子目录"]')).toBeNull();
  await vi.waitFor(() => expect(desktop.entries).toHaveBeenCalledWith(expect.objectContaining({ tagIds: ["wechat"], categoryId: undefined })));
  flushSync(() => untaggedRow.click());
  await vi.waitFor(() => expect(container.querySelector(".timeline-entry strong")?.textContent).toBe("无标签的文章"));
  expect(desktop.entries).toHaveBeenCalledWith(expect.objectContaining({ untagged: true, tagIds: undefined }));
  click('[aria-controls="timeline-tags"]');
  expect(container.querySelector("#timeline-tags")?.hasAttribute("inert")).toBe(true);
});

it("scopes the timeline blank-area menu and its actions to the selected folder", async () => {
  const article = entry("文章", "closed");
  const initial = await desktop.library();
  const child = { id: "child", name: "子目录", parentId: "closed", sortOrder: 0, icon: "folder" } as const;
  vi.mocked(desktop.library).mockResolvedValue({
    ...initial, categories: [...initial.categories, child], tags: [{ id: "wechat", name: "微信" }],
  });
  const create = vi.spyOn(desktop, "create").mockResolvedValue(entry("新笔记", "closed"));
  const importMarkdown = vi.spyOn(desktop, "importMarkdown").mockResolvedValue(null);
  const saveFolder = vi.spyOn(desktop, "saveCategory").mockResolvedValue({ ...child, id: "created-child", name: "未命名" });
  vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: filter.includePreview && (filter.categoryId === "closed" || filter.tagIds?.includes("wechat")) && !filter.pinned ? [article] : [],
    nextOffset: null,
  }));
  flushSync(() => root.render(<DesktopShell />));
  flushSync(() => container.querySelector<HTMLButtonElement>('.sidebar-chrome [aria-label="文章时间流"]')!.click());
  const openMenu = (selector: string) => flushSync(() => container.querySelector(selector)!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const menuItems = () => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  async function closeMenu() {
    flushSync(() => menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(menu()).toBeNull());
  }

  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")).not.toBeNull());
  openMenu(".timeline-folders");
  expect(menu()).toBeNull();
  openMenu(".timeline-content");
  expect(menu()?.getAttribute("aria-label")).toBe("文章区操作");
  await closeMenu();

  flushSync(() => container.querySelector<HTMLButtonElement>("#timeline-tag-wechat")!.click());
  await vi.waitFor(() => expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("微信"));
  openMenu(".timeline-content");
  expect(menu()).toBeNull();
  openMenu(".timeline-entry");
  expect(menuItems()[0].textContent).toBe("置顶");
  await closeMenu();
  flushSync(() => [...container.querySelectorAll<HTMLButtonElement>(".timeline-tag-row")].at(-1)!.click());
  openMenu(".timeline-content");
  expect(menu()).toBeNull();

  openMenu("#folder-row-closed");
  expect(menu()?.getAttribute("aria-label")).toBe("文件夹操作");
  await closeMenu();
  flushSync(() => container.querySelector<HTMLButtonElement>("#folder-row-closed")!.click());
  await vi.waitFor(() => expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("已折叠"));
  openMenu(".timeline-entry");
  expect(menuItems()[0].textContent).toBe("置顶");
  await closeMenu();

  vi.useFakeTimers();
  try {
    flushSync(() => container.querySelector(".timeline-entry")!.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerType: "touch",
    })));
    flushSync(() => vi.advanceTimersByTime(700));
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(menuItems()[0].textContent).toBe("置顶");
  } finally { vi.useRealTimers(); }
  await closeMenu();

  openMenu(".timeline-entries");
  expect(menu()?.getAttribute("aria-label")).toBe("文章区操作");
  expect(menuItems().map(item => item.textContent)).toEqual(["新建笔记", "导入公众号文章", "导入 Markdown", "导入 GitHub README", "新建目录"]);
  flushSync(() => menuItems().find(item => item.textContent === "新建笔记")!.click());
  await vi.waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith("article", expect.objectContaining({ categoryId: "closed" })));
  openMenu(".timeline-content");
  flushSync(() => menuItems().find(item => item.textContent === "导入 Markdown")!.click());
  await vi.waitFor(() => expect(importMarkdown).toHaveBeenCalledExactlyOnceWith("closed"));
  openMenu(".timeline-content");
  flushSync(() => menuItems().find(item => item.textContent === "新建目录")!.click());
  const subfolderInput = () => container.querySelector<HTMLInputElement>("#folder-closed .folder-inline-name");
  await vi.waitFor(() => {
    expect(subfolderInput()).not.toBeNull();
    expect(document.activeElement).toBe(subfolderInput());
  });
  flushSync(() => subfolderInput()!.form!.requestSubmit());
  await vi.waitFor(() => expect(saveFolder).toHaveBeenCalledExactlyOnceWith(null, "closed", "未命名", "folder"));

  flushSync(() => container.querySelector<HTMLButtonElement>("#add-root-folder")!.click());
  expect(subfolderInput()).not.toBeNull();
  flushSync(() => subfolderInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  flushSync(() => container.querySelector<HTMLButtonElement>("#folder-row-child")!.click());
  expect(container.querySelector<HTMLButtonElement>("#add-root-folder")!.disabled).toBe(true);
  await vi.waitFor(() => expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("子目录"));
  openMenu(".timeline-content");
  expect(menuItems().map(item => item.textContent)).toEqual(["新建笔记", "导入公众号文章", "导入 Markdown", "导入 GitHub README"]);
  flushSync(() => menuItems().find(item => item.textContent === "导入 Markdown")!.click());
  await vi.waitFor(() => expect(importMarkdown).toHaveBeenLastCalledWith("child"));
});

it.each(["folders", "timeline"] as const)("opens properties for a closed article from the %s row menu", async mode => {
  const target = { ...entry("closed-note"), summary: "列表文章的摘要", version: 3 };
  saveDocumentTabs(workspaceId, { ids: ["open-note"], activeId: "open-note" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => id === target.id ? target : entry(id));
  vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: filter.exactCategory && !filter.pinned ? [target] : [], nextOffset: null,
  }));
  const save = vi.spyOn(desktop, "save").mockResolvedValue({ version: 4 });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(openTabs()).toEqual(["open-note"]));
  if (mode === "timeline") {
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="文章时间流"]')!.click());
    flushSync(() => container.querySelector<HTMLButtonElement>("#timeline-root-folder")!.click());
  }
  const row = await vi.waitFor(() => {
    const node = container.querySelector(`#${mode === "timeline" ? "timeline" : "entry"}-row-${target.id}`);
    expect(node).not.toBeNull();
    return node!;
  });
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  const last = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].at(-1)!;
  expect(last.textContent).toBe("内容属性");
  flushSync(() => last.click());
  const summary = await vi.waitFor(() => {
    const field = document.querySelector<HTMLTextAreaElement>(".properties-panel textarea[name=summary]");
    expect(field?.value).toBe(target.summary);
    return field!;
  });
  summary.value = "更新列表文章的摘要";
  flushSync(() => summary.form!.requestSubmit());
  await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(target.id, 3, expect.objectContaining({
    summary: "更新列表文章的摘要",
  }), "auto"));
  await vi.waitFor(() => expect(document.querySelector(".properties-panel")).toBeNull());
  expect(openTabs()).toEqual(["open-note"]);
});

it("selects the root by default and only queries unfiled articles", async () => {
  const baseline = await desktop.library();
  vi.mocked(desktop.library).mockResolvedValue({
    ...baseline, articleCounts: { root: 2, folders: { closed: 1 }, tags: {}, untagged: 3 },
  });
  const notes = [entry("根目录笔记"), entry("根目录置顶笔记")];
  vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: filter.includePreview && filter.exactCategory && !filter.categoryId ? [notes[filter.pinned ? 1 : 0]] : [],
    nextOffset: null,
  }));
  const create = vi.spyOn(desktop, "create").mockResolvedValue(entry("新建根目录笔记"));
  flushSync(() => root.render(<DesktopShell />));
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="文章时间流"]')!.click());
  const rootFolder = await vi.waitFor(() => {
    const row = container.querySelector<HTMLButtonElement>("#timeline-root-folder");
    expect(row?.querySelector(".timeline-count")?.textContent).toBe("2");
    return row!;
  });
  expect(container.querySelector("#tree-directory-list > li:first-child")?.contains(rootFolder)).toBe(true);
  expect(rootFolder.getAttribute("aria-current")).toBe("true");
  expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("根目录");
  expect(container.querySelector('.timeline-heading [aria-label="包含子目录"]')).toBeNull();
  await vi.waitFor(() => expect([...container.querySelectorAll(".timeline-entry strong")].map(title => title.textContent))
    .toEqual(["根目录置顶笔记", "根目录笔记"]));
  for (const pinned of [false, true]) expect(desktop.entries).toHaveBeenCalledWith(expect.objectContaining({
    categoryId: undefined, exactCategory: true, kind: "article", pinned,
  }));
  flushSync(() => container.querySelector(".timeline-content")!.dispatchEvent(new MouseEvent("contextmenu", {
    button: 2, bubbles: true, cancelable: true,
  })));
  const createItem = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
    .find(item => item.textContent === "新建笔记")!;
  flushSync(() => createItem.click());
  await vi.waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith("article", undefined));
});

it.each(["completed", "partial"] as const)("opens a %s WeChat import without leaving the timeline folder", async status => {
  const imported = entry("公众号文章", "closed");
  const url = "https://mp.weixin.qq.com/s/demo";
  let saved = false;
  const importWechat = vi.spyOn(desktop, "importWechat").mockImplementation(async () => {
    saved = true;
    return {
      id: "wechat-import", url, entryId: imported.id, status, error: null,
      pendingImages: status === "partial" ? 1 : 0,
    };
  });
  vi.spyOn(desktop, "entry").mockResolvedValue(imported);
  vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: saved && filter.includePreview && filter.categoryId === "closed" && !filter.pinned ? [imported] : [], nextOffset: null,
  }));

  flushSync(() => root.render(<DesktopShell />));
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="文章时间流"]')!.click());
  const folder = await vi.waitFor(() => {
    const row = container.querySelector<HTMLButtonElement>("#folder-row-closed");
    expect(row).not.toBeNull();
    return row!;
  });
  flushSync(() => folder.click());
  if (status === "completed") {
    await vi.waitFor(() => expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("已折叠"));
    flushSync(() => container.querySelector(".timeline-content")!.dispatchEvent(new MouseEvent("contextmenu", {
      button: 2, bubbles: true, cancelable: true,
    })));
  }
  const launch = [...document.querySelectorAll<HTMLElement>(status === "completed"
    ? '[role="menuitem"]' : ".workbench-empty-actions button")].find(button => button.textContent === "导入公众号文章")!;
  flushSync(() => launch.click());
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="url"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, url);
  flushSync(() => field.dispatchEvent(new InputEvent("input", { bubbles: true })));
  flushSync(() => field.form!.requestSubmit());
  await vi.waitFor(() => expect(importWechat).toHaveBeenCalledExactlyOnceWith(url, "closed"));

  if (status === "partial") {
    const open = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".wechat-job button")].find(item => item.textContent === "打开笔记");
      expect(button).toBeDefined();
      return button!;
    });
    flushSync(() => open.click());
  }

  await vi.waitFor(() => expect(container.querySelector('[data-document="公众号文章"]')).not.toBeNull());
  expect(container.querySelector('.sidebar-chrome [aria-label="文章时间流"]')?.getAttribute("aria-current")).toBe("page");
  expect(container.querySelector(".timeline-folder-title h1")?.textContent).toBe("已折叠");
  await vi.waitFor(() => expect(container.querySelector(".timeline-entry")?.textContent).toContain(imported.title));
});

it("restores ordered live tabs and the active document without changing expanded folders", async () => {
  saveDocumentTabs(workspaceId, { ids: ["second", "missing", "first", "recycled"], activeId: "first" });
  localStorage.setItem("expanded-folders", JSON.stringify(["expanded"]));
  localStorage.setItem("directory-auto-locate", "true");
  vi.spyOn(desktop, "entry").mockImplementation(async id => {
    if (id === "missing") throw { code: "NOT_FOUND" };
    if (id === "recycled") return { ...entry(id), deletedAt: 5 };
    return entry(id, "closed");
  });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("tab-first"));
  expect(openTabs()).toEqual(["second", "first"]);
  expect(container.querySelector("#folder-row-closed")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("#folder-row-expanded")?.getAttribute("aria-expanded")).toBe("true");
  expect(readDocumentTabs(workspaceId)).toEqual({ ids: ["second", "first"], activeId: "first" });
  flushSync(() => container.querySelector<HTMLButtonElement>("#tab-second")!.click());
  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")?.getAttribute("aria-expanded")).toBe("true"));
  expect(readDocumentTabs(workspaceId)?.activeId).toBe("second");
});

it("keeps an explicit open when an older startup tab load resolves later", async () => {
  saveDocumentTabs(workspaceId, { ids: ["saved"], activeId: "saved" });
  let resolveSaved!: (value: Entry) => void;
  const saved = new Promise<Entry>(resolve => { resolveSaved = resolve; });
  const load = vi.spyOn(desktop, "entry").mockImplementation(id => id === "saved" ? saved : Promise.resolve(entry(id)));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(load).toHaveBeenCalledWith("saved"));
  expect(readDocumentTabs(workspaceId)?.activeId).toBe("saved");
  const row = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>('[data-tree-id="manual"]');
    expect(button).not.toBeNull();
    return button!;
  });
  flushSync(() => row.click());
  await vi.waitFor(() => expect(openTabs()).toEqual(["manual"]));
  resolveSaved(entry("saved"));
  await saved;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(openTabs()).toEqual(["manual"]);
  expect(readDocumentTabs(workspaceId)).toEqual({ ids: ["manual"], activeId: "manual" });
});

it("starts blank and only opens SQLite history and messages on request", async () => {
  const previous = [
    { id: "previous-run-active", title: "上次的对话", updatedAt: 1, archived: false },
    { id: "previous-run-history", title: "上次的历史", updatedAt: 0, archived: true },
  ];
  let resolveList!: (threads: typeof previous) => void;
  const list = vi.spyOn(desktop, "aiThreads").mockImplementation(() => new Promise(resolve => { resolveList = resolve; }));
  const fetch = vi.spyOn(desktop, "aiThread").mockImplementation(async (_entry, id) => previous.find(thread => thread.id === id)!);
  const load = vi.spyOn(desktop, "aiMessages").mockResolvedValue([]);
  const update = vi.spyOn(desktop, "aiUpdateThread").mockResolvedValue();
  const create = vi.spyOn(desktop, "aiCreateThread");
  const deleteThread = vi.spyOn(desktop, "aiDeleteThread");
  flushSync(() => root.render(<Theme><AiPanel open target={{ label: "测试模型" }} targetPicker={null}
    canChat canEdit={false} canWrite={() => false} onClose={() => {}} onSettings={() => {}} /></Theme>));
  await vi.waitFor(() => expect(container.textContent).toContain("开始新对话"));
  expect(list).not.toHaveBeenCalled();
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "未发送的草稿");
  flushSync(() => input.dispatchEvent(new InputEvent("input", { bubbles: true })));
  await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(false));
  const history = container.querySelector<HTMLButtonElement>('[aria-label="对话记录"]')!;
  flushSync(() => history.click());
  expect(container.textContent).toContain("正在读取对话");
  resolveList(previous);
  await vi.waitFor(() => expect(container.querySelectorAll(".ai-thread-list li")).toHaveLength(2));
  expect(fetch).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  flushSync(() => history.click());
  flushSync(() => history.click());
  const thread = await vi.waitFor(() => {
    const item = container.querySelector<HTMLButtonElement>(".ai-thread-name");
    expect(item?.textContent).toContain("上次的对话");
    return item!;
  });
  expect(list).toHaveBeenCalledExactlyOnceWith(null);
  flushSync(() => thread.click());
  await vi.waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith("previous-run-active"));
  expect(fetch).toHaveBeenCalledWith(null, "previous-run-active");
  await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith("previous-run-active", { archived: false }));
  const newThread = container.querySelector<HTMLButtonElement>('[aria-label="新对话"]')!;
  await vi.waitFor(() => expect(newThread.disabled).toBe(false));
  flushSync(() => newThread.click());
  await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith("previous-run-active", { archived: true }));
  await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(""));
  expect(create).not.toHaveBeenCalled();
  expect(deleteThread).not.toHaveBeenCalled();
});

it("bounds mounted AI sessions and Markdown renders while a hidden reply finishes saving", { timeout: 20_000 }, async () => {
  const queues = Array.from({ length: 12 }, (_, index) => new SaveQueue(entry(`cache-${index}`), vi.fn(), () => {}));
  vi.spyOn(desktop, "aiCreateThread").mockResolvedValue("cache-thread");
  vi.spyOn(desktop, "aiUpdateThread").mockResolvedValue();
  const list = vi.spyOn(desktop, "aiThreads");
  const fetch = vi.spyOn(desktop, "aiThread").mockResolvedValue({ id: "cache-thread", title: "请写长文", updatedAt: 1, archived: false });
  const saved: AiHistoryItem[] = [];
  const load = vi.spyOn(desktop, "aiMessages").mockImplementation(async () => saved);
  let emit!: (event: AiStreamEvent) => void;
  let finish!: (result: { reply: string }) => void;
  const chat = vi.spyOn(desktop, "aiChatStream").mockImplementation((_id, _request, onEvent) => {
    emit = onEvent;
    return new Promise(resolve => { finish = resolve; });
  });
  let saveReply!: () => void;
  const save = vi.spyOn(desktop, "aiSaveMessage").mockImplementation(async (_id, item) => {
    if (item.message.role === "assistant") await new Promise<void>(resolve => { saveReply = resolve; });
    saved.push(item);
  });
  const parse = vi.spyOn(markdown, "renderMarkdown");
  const mount = (queue: SaveQueue) => flushSync(() => root.render(<Theme><AiPanel open queue={queue}
    target={{ label: "测试模型" }} targetPicker={null} canChat canEdit={false}
    canWrite={() => false} onClose={() => {}} onSettings={() => {}} /></Theme>));
  const sessions = () => container.querySelectorAll(".ai-session");
  const active = () => container.querySelector(".ai-session:not([hidden])")!;
  try {
    mount(queues[0]);
    const input = await vi.waitFor(() => {
      const field = active()?.querySelector<HTMLTextAreaElement>("textarea");
      expect(field?.disabled).toBe(false);
      return field!;
    });
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "请写长文");
    flushSync(() => input.dispatchEvent(new InputEvent("input", { bubbles: true })));
    const button = await vi.waitFor(() => {
      const send = active().querySelector<HTMLButtonElement>('[aria-label="发送消息"]');
      expect(send?.disabled).toBe(false);
      return send!;
    });
    flushSync(() => button.click());
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    emit({ type: "started" });
    const paragraph = "**流式回复**，用于观察长文渲染更新频率。" + "这里模拟一段长篇中文回复。".repeat(8) + "\n\n";
    for (let i = 0; i < 100; i++) {
      emit({ type: "delta", text: paragraph });
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    expect(active().querySelector(".ai-message-markdown")?.textContent).toContain("流式回复");
    const rendersDuringStream = parse.mock.calls.length;
    expect(rendersDuringStream).toBeLessThan(30);
    for (const queue of queues.slice(1)) {
      mount(queue);
      await vi.waitFor(() => expect(active()?.querySelector(".ai-context")?.textContent).toBe(queue.entry.title));
    }
    expect(active().textContent).not.toContain("流式回复");
    await vi.waitFor(() => expect(sessions()).toHaveLength(5));
    const reply = paragraph.repeat(100) + "最终段落";
    finish({ reply });
    await vi.waitFor(() => expect(saveReply).toBeTypeOf("function"));
    const [savedThread, savedReply] = save.mock.calls.at(-1)!;
    expect(savedThread).toBe("cache-thread");
    expect(savedReply.message.status?.type).toBe("complete");
    expect(savedReply.message.content).toEqual([{ type: "text", text: reply }]);
    await vi.waitFor(() => expect(container.querySelector(".ai-message-markdown")?.textContent?.endsWith("最终段落\n")).toBe(true));
    expect(sessions()).toHaveLength(5);
    expect(saved).toHaveLength(1);
    saveReply();
    await vi.waitFor(() => expect(sessions()).toHaveLength(4));
    expect(saved).toHaveLength(2);
    mount(queues[0]);
    await vi.waitFor(() => expect(active().querySelector(".ai-message-markdown")?.textContent).toContain("最终段落"));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(queues[0].entry.id, "cache-thread");
    expect(load).toHaveBeenCalledExactlyOnceWith("cache-thread");
    expect(list).not.toHaveBeenCalled();
  } finally {
    for (const queue of queues) queue.dispose();
  }
});
