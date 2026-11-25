// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useImperativeHandle, type ComponentProps } from "react";
import type { Collection, Entry, EntryPage } from "../../../../packages/shared-types";
import { desktop, type AiHistoryItem, type AiStreamEvent } from "../desktop";
import { AiPanel } from "./AiPanel";
import { DesktopShell } from "./DesktopShell";
import type { DocumentEditor } from "./Document";
import type { CollectionCanvas } from "./CollectionCanvas";
import { readDocumentTabs, saveDocumentTabs, saveWorkspaceLayout } from "./preferences";
import { SaveQueue } from "../editor/save-queue";
import { commandKey } from "../labels";
import * as markdown from "../../../../packages/markdown-core";
import { emptyPublication, recommendationFingerprint } from "./wechat-publication";
import * as publishing from "./Publishing";
import { wechatThemes } from "../../../../packages/wechat-renderer";

const { editorQueues, editorClipboards } = vi.hoisted(() => ({
  editorQueues: new Map<string, SaveQueue>(),
  editorClipboards: new Map<string, ComponentProps<typeof DocumentEditor>["clipboard"]>(),
}));
vi.mock(import("./Document"), async importOriginal => ({
  ...await importOriginal(),
  DocumentEditor: ({ queue, display, onDisplayChange, clipboard }: ComponentProps<typeof DocumentEditor>) => {
    editorQueues.set(queue.entry.id, queue);
    editorClipboards.set(queue.entry.id, clipboard);
    return (
    <button data-document={queue.entry.id} data-links={display.convertLinks} data-body={queue.snapshot().fields.contentMd}
      onClick={() => onDisplayChange("convertLinks", !display.convertLinks)}>切换链接脚注</button>
    );
  },
}));

const { flushCanvas } = vi.hoisted(() => ({ flushCanvas: vi.fn<() => Promise<void>>() }));

vi.mock(import("./CollectionCanvas"), () => ({
  CollectionCanvas: ({ collection, onLoadArticle, onSaveArticle, onOpenEntry, canvasRef }: ComponentProps<typeof CollectionCanvas>) => {
    useImperativeHandle(collection.id === "canvas-open" ? canvasRef : null,
      () => ({ flush: flushCanvas, canApplySync: () => true, addEntry: async () => {}, clipboard: () => false, paste: () => false }));
    return <>
    <h1 data-canvas={collection.id}>{collection.title}</h1>
    {collection.id === "canvas-open" && <button type="button" id="open-canvas-article" onClick={() => onOpenEntry("from-canvas")}>打开文章</button>}
    {collection.id === "canvas-edit" && <button type="button" id="save-canvas-article" onClick={() => {
      void onLoadArticle("article-one").then(entry => onSaveArticle(entry.id, entry.version, { ...entry, contentMd: "## 从画布保存" }, "auto"));
    }}>保存卡片</button>}
    </>;
  },
}));

const workspaceId = "session-test";
const entry = (id: string, categoryId: string | null = null): Entry => ({
  id, categoryId, title: id, kind: "article", contentMd: "", status: "draft", createdAt: 0, updatedAt: 0, deletedAt: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, links: [],
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  editorQueues.clear();
  vi.spyOn(desktop, "wechatPublicationDefaults").mockResolvedValue({ schemaVersion: 1, recommendationCount: 5, recommendationAuthors: [], version: 0, updatedAt: 0 });
  vi.spyOn(desktop, "wechatRecommendations").mockImplementation(async input => ({ inputFingerprint: await recommendationFingerprint(input), items: [] }));
  vi.spyOn(desktop, "resolveWechatRecommendations").mockImplementation(async (_input, items) => ({ items, invalid: [] }));
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
  vi.spyOn(desktop, "syncActivity").mockResolvedValue(null);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue(null);
  vi.spyOn(desktop, "syncWake").mockResolvedValue();
  for (const event of ["onExit", "onHistory", "onHideRequested", "onSyncStatusChanged", "onWorkspaceChanged", "onTrashEmptied", "onAssetsChanged", "onBackupProgress", "onMcpStatusChanged"] as const) {
    vi.spyOn(desktop, event).mockResolvedValue(() => {});
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  flushSync(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  editorClipboards.clear();
});

function openTabs() {
  return [...container.querySelectorAll('.tabs [role="tab"]')].map(tab => tab.id.replace(/^tab-/, ""));
}

it.each([undefined, "name"])("uses relevance by default and preserves saved search sort %s", async saved => {
  if (saved) localStorage.setItem("workspace-search-sort", JSON.stringify(saved));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[aria-label="全文搜索"]')).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="全文搜索"]')!.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "公众号排版");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() => expect(vi.mocked(desktop.entries).mock.calls.some(([filter]) =>
    filter.workspaceSearch?.text === "公众号排版" && filter.sort === (saved ?? "relevance"))).toBe(true));
});

it.each(["entries", "matches"] as const)("refreshes %s pagination across a background search-index cutover", async pagination => {
  let generation = "0:literal";
  let failure = "";
  const hit = (text: string) => ({ line: 1, start: 0, text, ranges: [{ start: 0, end: 2 }],
    before: null, after: null, leading: false, trailing: false });
  let changed!: () => void;
  vi.mocked(desktop.onWorkspaceChanged).mockImplementation(async callback => { changed = callback; return () => {}; });
  vi.mocked(desktop.entries).mockImplementation(async filter => {
    if (!filter.workspaceSearch?.text) return { items: [], nextOffset: null };
    const continuation = !!filter.offset || !!filter.workspaceSearch.matchPage;
    if (continuation) generation = "1:words";
    const text = continuation ? "拒绝混入的旧分页" : generation === "0:literal" ? "字面结果" : "完整词级结果";
    return { items: [{ ...entry("manual"), searchMatches: { version: 1, indexGeneration: generation,
      items: [hit(text)], total: 2, nextOffset: pagination === "matches" ? 1 : null } }],
    nextOffset: pagination === "entries" ? 1 : null,
    search: { total: 2, clauses: [], indexGeneration: generation, indexing: generation === "0:literal" && !failure, error: failure } };
  });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[aria-label="全文搜索"]')).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="全文搜索"]')!.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "搜索");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const summary = () => container.querySelector(".workspace-search-summary > span")!;
  await vi.waitFor(() => expect(summary()?.textContent).toBe("正在载入…"));
  expect(summary().getAttribute("aria-busy")).toBe("true");
  expect(container.textContent).toContain("字面结果");
  failure = "搜索索引重建失败";
  flushSync(() => changed());
  await vi.waitFor(() => expect(summary().textContent).toBe(failure));
  expect(summary().getAttribute("role")).toBe("alert");
  expect(container.textContent).toContain("字面结果");
  failure = "";
  const more = container.querySelector<HTMLButtonElement>(pagination === "entries" ? ".load-more" : ".load-more-hits")!;
  flushSync(() => more.click());
  await vi.waitFor(() => expect(container.textContent).toContain("完整词级结果"));
  expect(container.textContent).not.toContain("拒绝混入的旧分页");
  expect(container.textContent).not.toContain("字面结果");
  expect(summary().textContent).toBe("2 篇笔记");
  expect(summary().hasAttribute("aria-busy")).toBe(false);
});

it("discards an old continuation arriving after the new search homepage in the same request epoch", async () => {
  let changed!: () => void;
  let refreshing = false;
  let home!: (page: EntryPage) => void;
  let more!: (page: EntryPage) => void;
  vi.mocked(desktop.onWorkspaceChanged).mockImplementation(async callback => { changed = callback; return () => {}; });
  const page = (id: string, indexGeneration: string): EntryPage => ({
    items: [entry(id)], nextOffset: 1, search: { total: 2, clauses: [], indexGeneration },
  });
  vi.mocked(desktop.entries).mockImplementation(async filter => {
    if (!filter.workspaceSearch?.text) return { items: [], nextOffset: null };
    if (filter.offset) return new Promise(resolve => { more = resolve; });
    if (refreshing) return new Promise(resolve => { home = resolve; });
    return page("字面首页", "0:literal");
  });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[aria-label="全文搜索"]')).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="全文搜索"]')!.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "搜索");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() => expect(container.querySelector("#entry-row-字面首页")).not.toBeNull());
  refreshing = true;
  flushSync(() => changed());
  await vi.waitFor(() => expect(home).toBeTypeOf("function"));
  flushSync(() => container.querySelector<HTMLButtonElement>(".load-more")!.click());
  await vi.waitFor(() => expect(more).toBeTypeOf("function"));
  await act(async () => home(page("词级首页", "1:words")));
  expect(container.querySelector("#entry-row-词级首页")).not.toBeNull();
  await act(async () => more(page("过期字面续页", "0:literal")));
  expect(container.querySelector("#entry-row-过期字面续页")).toBeNull();
  expect(container.querySelector("#entry-row-词级首页")).not.toBeNull();
});

it.each([
  ["folders", "copyTitle", false], ["folders", "copyPath", false],
  ["timeline", "copyTitle", false], ["timeline", "copyPath", false],
  ["tab", "copyPath", false], ["folders", "copyTitle", true],
  ["search", "copyPath", false], ["search", "copyTitle", true],
] as const)("keeps %s %s feedback visible after its menu closes (failure=%s)", async (surface, action, failure) => {
  vi.spyOn(desktop, "entry").mockResolvedValue(entry("manual"));
  let complete!: () => void;
  const copy = vi.spyOn(desktop, "copyText").mockReturnValue(new Promise<void>((resolve, reject) => {
    complete = () => failure ? reject(new Error("剪贴板暂不可用")) : resolve();
  }));
  if (surface === "tab" || surface === "search") saveDocumentTabs(workspaceId, { ids: ["manual"], activeId: "manual" });
  if (surface === "search") vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: filter.workspaceSearch?.text ? [{ ...entry("manual"), searchMatches: { version: 1, total: 1, nextOffset: null,
      items: [{ line: 1, start: 0, text: "manual", ranges: [{ start: 0, end: 6 }], before: null, after: null, leading: false, trailing: false }] } }] : [],
    nextOffset: null,
  }));
  flushSync(() => root.render(<DesktopShell />));
  if (surface === "timeline") {
    await vi.waitFor(() => expect(container.querySelector('[aria-label="文章时间流"]')).not.toBeNull());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="文章时间流"]')!.click());
  }
  if (surface === "search") {
    await vi.waitFor(() => expect(container.querySelector('[aria-label="全文搜索"]')).not.toBeNull());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="全文搜索"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "manual");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const selector = surface === "tab" ? "#tab-manual" : surface === "timeline" ? "#timeline-row-manual" : "#entry-row-manual";
  await vi.waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
  const trigger = () => container.querySelector<HTMLButtonElement>(selector)!;
  if (surface === "search") {
    expect(trigger().closest(".search-note-header")).not.toBeNull();
    expect(trigger().getAttribute("aria-current")).toBe("true");
  }
  const feedbackHost = () => surface === "timeline" ? trigger().closest<HTMLElement>(".timeline-entry")! : trigger();
  const label = action === "copyTitle" ? "复制标题" : "复制工作区路径";
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const openMenu = () => act(async () => {
    trigger().focus();
    trigger().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  });
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    const errorSlot = container.querySelector(".status-action-feedback");
    await openMenu();
    await act(async () => {
      const item = menuItems().find(item => item.textContent === label)!;
      if (surface === "tab") {
        item.focus();
        item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      } else item.click();
    });
    expect(copy).toHaveBeenCalledExactlyOnceWith(action === "copyTitle" ? "manual" : "目录 / manual");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(feedbackHost().dataset.feedbackState).toBe("pending");
    expect(feedbackHost().textContent).toContain("正在复制");
    if (surface !== "search") expect(feedbackHost().querySelector('.button-feedback-icon[data-state="pending"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(feedbackHost().dataset.feedbackState).toBe("pending");
    await openMenu();
    for (const item of menuItems().filter(item => ["复制标题", "复制工作区路径"].includes(item.textContent ?? ""))) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
      await act(async () => item.click());
    }
    expect(copy).toHaveBeenCalledOnce();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => complete());
    expect(feedbackHost().dataset.feedbackState).toBe(failure ? "error" : "success");
    expect(feedbackHost().textContent).toContain(failure ? "复制失败" : action === "copyTitle" ? "标题已复制" : "路径已复制");
    await openMenu();
    const resultItem = menuItems().find(item => item.textContent === label)!;
    expect(resultItem.getAttribute("aria-disabled")).toBe("true");
    await act(async () => resultItem.click());
    expect(copy).toHaveBeenCalledOnce();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => vi.advanceTimersByTime(999));
    expect(feedbackHost().dataset.feedbackState).toBe(failure ? "error" : "success");
    await act(async () => vi.advanceTimersByTime(1));
    expect(feedbackHost().dataset.feedbackState).toBeUndefined();
    expect(feedbackHost().textContent).toContain("manual");
    expect(container.querySelector(".status-action-feedback")).toBe(errorSlot);
    expect(errorSlot?.textContent).toBe(failure ? "剪贴板暂不可用" : "");
    await openMenu();
    expect(menuItems().find(item => item.textContent === label)?.getAttribute("aria-disabled")).not.toBe("true");
  } finally { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false); }
});

it.each([false, true])("resolves pasted local images through the active host only when automatic upload is %s", async autoUpload => {
  const target = { endpoint: "https://s3.example.test", region: "auto", bucket: "images", prefix: "workspace", publicBase: "https://images.example.test", autoUpload };
  vi.mocked(desktop.imageStorageTarget).mockResolvedValue(target);
  const hosted = "https://images.example.test/workspace/pasted.webp";
  const host = vi.spyOn(desktop, "hostImage").mockResolvedValue(hosted);
  const localize = vi.spyOn(desktop, "localizeImage").mockResolvedValue("asset://downloaded");
  saveDocumentTabs(workspaceId, { ids: ["auto-images"], activeId: "auto-images" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorClipboards.has("auto-images")).toBe(true));
  if (autoUpload) {
    await vi.waitFor(() => expect(editorClipboards.get("auto-images")!.localizeImage).toBeTypeOf("function"));
    const resolve = editorClipboards.get("auto-images")!.localizeImage!;
    expect(await resolve("asset://pasted")).toBe(hosted);
    expect(host).toHaveBeenCalledWith("asset://pasted", target);
    const external = "https://external.example.test/picture.png";
    expect(await resolve(external)).toBe(hosted);
    expect(host).toHaveBeenCalledWith(external, target);
    expect(await resolve(hosted)).toBe(hosted);
    expect(host).toHaveBeenCalledTimes(2);
  } else {
    expect(editorClipboards.get("auto-images")!.localizeImage).toBeUndefined();
    expect(host).not.toHaveBeenCalled();
  }
  expect(localize).not.toHaveBeenCalled();
});

it("clears all trash after confirmation and disables the clear icon when empty", async () => {
  let cleared = false;
  const trashed = { ...entry("trashed"), deletedAt: 1 };
  vi.spyOn(desktop, "entries").mockImplementation(async filter => ({ items: filter.deleted && !cleared ? [trashed] : [], nextOffset: null }));
  const empty = vi.spyOn(desktop, "emptyTrash").mockImplementation(async () => { cleared = true; return [trashed.id]; });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('button[aria-label="回收站"]')).not.toBeNull());
  expect(container.querySelector('button[aria-label="回收站"] svg')?.classList.contains("lucide-trash")).toBe(true);
  flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="回收站"]')!.click());
  await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>("#empty-trash")?.disabled).toBe(false));
  flushSync(() => container.querySelector<HTMLButtonElement>("#empty-trash")!.click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("无法恢复"));
  const dialog = () => document.querySelector('[role="dialog"]')!;
  flushSync(() => [...dialog().querySelectorAll("button")].find(button => button.textContent === "取消")!.click());
  expect(empty).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>("#empty-trash")!.click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  flushSync(() => [...dialog().querySelectorAll("button")].find(button => button.textContent === "清空回收站")!.click());
  await vi.waitFor(() => expect(empty).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>("#empty-trash")?.disabled).toBe(true));
  await vi.waitFor(() => expect(container.textContent).toContain("回收站为空"));
});

it("closes permanently removed tabs when the background trash cleaner reports them", async () => {
  saveDocumentTabs(workspaceId, { ids: ["old", "keep"], activeId: "old" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  let cleaned!: (ids: string[]) => void;
  vi.spyOn(desktop, "onTrashEmptied").mockImplementation(async callback => { cleaned = callback; return () => {}; });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(openTabs()).toEqual(["old", "keep"]));
  flushSync(() => cleaned(["old"]));
  await vi.waitFor(() => expect(openTabs()).toEqual(["keep"]));
  expect(container.querySelector('[role="tab"][aria-selected=true]')?.id).toBe("tab-keep");
});

const webClipping = `---
title: 剪藏文章
source: https://example.com/clipping
author: ["[[作者]]"]
published: 2026-11-18
created: 2026-11-20
description: 摘要
tags: [clippings]
---
**原始正文**

![[视频.mp4]]`;

it("creates and opens a clipped article when pasting in the workspace without an editor", async () => {
  vi.spyOn(desktop, "readClipboard").mockResolvedValue({ kind: "text", text: webClipping });
  const imported = vi.spyOn(desktop, "importClipping").mockResolvedValue({ entryId: "clipped", existing: false, deleted: false, unavailableImages: 0 });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector(".workspace-shell")).not.toBeNull());
  container.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(openTabs()).toContain("clipped"));
  expect(imported).toHaveBeenCalledExactlyOnceWith({
    title: "剪藏文章", contentMd: "**原始正文**\n\n![[视频.mp4]]", summary: "摘要", tags: ["clippings"],
    source: { url: "https://example.com/clipping", author: "作者", accountName: "example.com",
      originalPublishedAt: Date.parse("2026-11-18"), importedAt: Date.parse("2026-11-20") },
  }, null, false);
  expect(container.textContent).toContain("1 个本地附件缺少文件，已保留引用");
});

it("imports a rich clipboard clipping in a new tab and leaves the current article intact", async () => {
  saveDocumentTabs(workspaceId, { ids: ["original"], activeId: "original" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), contentMd: id === "original" ? "未覆盖的正文" : "新正文" }));
  vi.spyOn(desktop, "readClipboard").mockResolvedValue({ kind: "html", html: "<p>网页内容</p>", text: webClipping });
  vi.spyOn(desktop, "importClipping").mockResolvedValue({ entryId: "clipped", existing: false, deleted: false, unavailableImages: 2 });
  const saved = vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorClipboards.has("original")).toBe(true));
  editorQueues.get("original")!.edit({ contentMd: "未保存的正文" });
  expect(await editorClipboards.get("original")!.read()).toBe("");
  await vi.waitFor(() => expect(openTabs()).toEqual(["original", "clipped"]));
  expect(editorQueues.get("original")!.snapshot().fields.contentMd).toBe("未保存的正文");
  await vi.waitFor(() => expect(saved).toHaveBeenCalledWith("original", 1, expect.objectContaining({ contentMd: "未保存的正文" }), "auto"));
  expect(container.textContent).toContain("2 张图片未能下载，已保留原链接");
});

it("preserves plain-text paste and ordinary Markdown instead of importing them", async () => {
  saveDocumentTabs(workspaceId, { ids: ["original"], activeId: "original" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  const read = vi.spyOn(desktop, "readClipboard").mockResolvedValue({ kind: "text", text: webClipping });
  const imported = vi.spyOn(desktop, "importClipping");
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorClipboards.has("original")).toBe(true));
  expect(await editorClipboards.get("original")!.read(true)).toBe(webClipping);
  read.mockResolvedValue({ kind: "text", text: "# 普通 Markdown" });
  expect(await editorClipboards.get("original")!.read()).toBe("# 普通 Markdown");
  expect(imported).not.toHaveBeenCalled();
});

it("opens an already collected clipping without overwriting it and reports deleted sources", async () => {
  saveDocumentTabs(workspaceId, { ids: ["original"], activeId: "original" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  vi.spyOn(desktop, "readClipboard").mockResolvedValue({ kind: "text", text: webClipping });
  const imported = vi.spyOn(desktop, "importClipping").mockResolvedValue({ entryId: "existing", existing: true, deleted: false, unavailableImages: 0 });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorClipboards.has("original")).toBe(true));
  await editorClipboards.get("original")!.read();
  await vi.waitFor(() => expect(openTabs()).toContain("existing"));
  expect(container.querySelector(".workspace-toast")).toBeNull();
  imported.mockResolvedValue({ entryId: "deleted", existing: true, deleted: true, unavailableImages: 0 });
  await editorClipboards.get("existing")!.read();
  await vi.waitFor(() => expect(container.textContent).toContain("请先从回收站恢复"));
  expect(openTabs()).not.toContain("deleted");
});

it("keeps the writing pane itself from showing a scrollbar", async () => {
  saveDocumentTabs(workspaceId, { ids: ["article-one"], activeId: "article-one" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(openTabs()).toContain("article-one"));
  const writingPane = container.querySelector(".main-workspace")!.parentElement!;
  expect(getComputedStyle(writingPane).overflow).toBe("hidden");
});

it("preserves the open sidebar when the minimized workspace temporarily has no height", async () => {
  let reportNavigationSize!: () => void;
  vi.stubGlobal("ResizeObserver", class {
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe(target: Element) {
      if (target.id !== "navigation") return;
      reportNavigationSize = () => {
        const size = [{ inlineSize: navigationWidth, blockSize: workspaceHeight }];
        this.callback([{
          target, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
          contentRect: new DOMRectReadOnly(0, 0, navigationWidth, workspaceHeight),
        }], this);
      };
    }
    unobserve() {}
    disconnect() {}
  });
  saveWorkspaceLayout({ section: "folders", explorerOverride: true, timelineDirectory: "shown", focusMode: false, aiOpen: false });
  let workspaceHeight = 800;
  let navigationWidth = 430;
  flushSync(() => root.render(<DesktopShell />));
  const group = container.querySelector<HTMLDivElement>(".workspace-panels")!;
  const navigation = container.querySelector<HTMLDivElement>("#navigation")!;
  Object.defineProperties(group, {
    clientWidth: { get: () => workspaceHeight ? 1360 : 144 },
    clientHeight: { get: () => workspaceHeight },
  });
  Object.defineProperty(navigation, "offsetWidth", { get: () => navigationWidth });
  await vi.waitFor(() => expect(group.dataset.sidebarRestoring).toBeUndefined());
  flushSync(reportNavigationSize);

  workspaceHeight = navigationWidth = 0;
  flushSync(reportNavigationSize);
  workspaceHeight = 800;
  navigationWidth = 430;
  flushSync(reportNavigationSize);
  expect(container.querySelector("#hide-sidebar")).not.toBeNull();
  expect(JSON.parse(localStorage.getItem("workspace-layout")!).explorerOverride).toBe(true);

  navigationWidth = 0;
  flushSync(reportNavigationSize);
  expect(container.querySelector("#show-sidebar")).not.toBeNull();
  expect(JSON.parse(localStorage.getItem("workspace-layout")!).explorerOverride).toBe(false);
});

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

it.each([true, false])("saves pending edits on tray exit and cancels exit on failure (save succeeds: %s)", async succeeds => {
  let requestExit!: () => void;
  vi.mocked(desktop.onExit).mockImplementation(async callback => { requestExit = callback; return () => {}; });
  vi.spyOn(desktop, "beginExit").mockResolvedValue();
  const finish = vi.spyOn(desktop, "finishExit").mockResolvedValue();
  const cancel = vi.spyOn(desktop, "cancelExit").mockResolvedValue();
  let saveSucceeded!: (result: { version: number }) => void;
  let saveFailed!: (error: Error) => void;
  const save = vi.spyOn(desktop, "save").mockReturnValue(new Promise((resolve, reject) => {
    saveSucceeded = resolve;
    saveFailed = reject;
  }));
  saveDocumentTabs(workspaceId, { ids: ["tray-exit"], activeId: "tray-exit" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("tray-exit")).toBe(true));
  editorQueues.get("tray-exit")!.edit({ contentMd: "退出前的最后修改" });
  flushSync(requestExit);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][2].contentMd).toBe("退出前的最后修改");
  expect(finish).not.toHaveBeenCalled();
  if (succeeds) {
    saveSucceeded({ version: 2 });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
    expect(cancel).not.toHaveBeenCalled();
  } else {
    saveFailed(new Error("disk full"));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(finish).not.toHaveBeenCalled();
    expect(editorQueues.get("tray-exit")!.isDirty()).toBe(true);
    expect(container.textContent).toContain("有内容未保存");
  }
});

it.each(["success", "save failure", "installer failure", "cancel"])("saves before handing off an update and recovers on %s", async outcome => {
  vi.spyOn(desktop, "appInfo").mockResolvedValue({ name: "workbench", version: "0.1.0", platform: "windows", arch: "x86_64", updatesEnabled: true });
  vi.spyOn(desktop, "appUpdateStatus").mockResolvedValue({ phase: "ready", version: "0.2.0", downloaded: 100, total: 100, error: null });
  vi.spyOn(desktop, "onAppUpdateChanged").mockResolvedValue(() => {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ components: [], notices: "" }) }));
  vi.spyOn(desktop, "beginExit").mockResolvedValue();
  const finish = vi.spyOn(desktop, "finishExit").mockResolvedValue();
  const install = vi.spyOn(desktop, "appUpdateInstall");
  if (outcome === "installer failure") install.mockRejectedValue(new Error("安装器无法启动"));
  else install.mockResolvedValue();
  const cancel = vi.spyOn(desktop, "cancelExit").mockResolvedValue();
  let saveSucceeded!: (result: { version: number }) => void;
  let saveFailed!: (error: Error) => void;
  vi.spyOn(desktop, "save").mockReturnValue(new Promise((resolve, reject) => { saveSucceeded = resolve; saveFailed = reject; }));
  saveDocumentTabs(workspaceId, { ids: ["update-draft"], activeId: "update-draft" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("update-draft")).toBe(true));
  editorQueues.get("update-draft")!.edit({ contentMd: "安装前的最后修改" });
  flushSync(() => container.querySelector<HTMLButtonElement>('.status-bar [aria-label="设置"]')!.click());
  const nav = document.querySelector<HTMLButtonElement>('[aria-controls="settings-section-about"]')!;
  flushSync(() => nav.click());
  const installButton = await vi.waitFor(() => {
    const button = [...document.querySelectorAll("button")].find(button => button.textContent === "退出并安装");
    expect(button).toBeDefined(); return button!;
  });
  flushSync(() => installButton.click());
  await vi.waitFor(() => expect(desktop.save).toHaveBeenCalledOnce());
  expect(install).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  if (outcome === "cancel") flushSync(() => container.querySelector<HTMLButtonElement>(".exit-banner button")!.click());
  if (outcome === "save failure") saveFailed(new Error("磁盘已满"));
  else saveSucceeded({ version: 2 });
  if (outcome === "success") {
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce()); expect(cancel).not.toHaveBeenCalled();
  } else {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    if (outcome !== "installer failure") expect(install).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(document.body.textContent).toContain("安装器无法启动"));
    expect(container.querySelector(".exit-banner")).toBeNull();
    if (outcome === "save failure") expect(editorQueues.get("update-draft")!.isDirty()).toBe(true);
  }
  expect(finish).not.toHaveBeenCalled();
});

it("saves the final document edit before confirming a tray hide without starting exit", async () => {
  let requestHide!: () => void;
  vi.mocked(desktop.onHideRequested).mockImplementation(async callback => { requestHide = callback; return () => {}; });
  const confirm = vi.spyOn(desktop, "confirmHide").mockResolvedValue();
  const beginExit = vi.spyOn(desktop, "beginExit").mockResolvedValue();
  const cancel = vi.spyOn(desktop, "cancelHide").mockResolvedValue();
  let finishSave!: (result: { version: number }) => void;
  const save = vi.spyOn(desktop, "save").mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
  saveDocumentTabs(workspaceId, { ids: ["last-edit"], activeId: "last-edit" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("last-edit")).toBe(true));
  editorQueues.get("last-edit")!.edit({ contentMd: "最后输入的几个字" });
  flushSync(() => requestHide());
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][2].contentMd).toBe("最后输入的几个字");
  expect(confirm).not.toHaveBeenCalled();
  finishSave({ version: 2 });
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(beginExit).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});

async function openPropertyTestEntry() {
  saveDocumentTabs(workspaceId, { ids: ["property-draft"], activeId: "property-draft" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), title: "A", summary: "原摘要" }));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("property-draft")).toBe(true));
  flushSync(() => container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!.click());
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-properties-button")!.click());
  return await vi.waitFor(() => {
    const title = container.querySelector<HTMLInputElement>('.properties-sidebar [name="title"]');
    expect(title).not.toBeNull(); return title!;
  });
}

function fillProperty(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
}
function blurProperty(input: HTMLElement) {
  flushSync(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}

it.each(["after failure", "while saving"])("persists a reverted property %s before saving another field", async timing => {
  let reject!: (error: Error) => void;
  const save = vi.spyOn(desktop, "save").mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockImplementation(async (_id, version) => ({ version: version + 1 }));
  const title = await openPropertyTestEntry();
  fillProperty(title, "B"); blurProperty(title);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  if (timing === "after failure") {
    reject(new Error("模拟保存失败"));
    await vi.waitFor(() => expect(container.textContent).toContain("模拟保存失败"));
  }
  fillProperty(title, "A"); blurProperty(title);
  if (timing === "while saving") reject(new Error("模拟保存失败"));
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(editorQueues.get("property-draft")!.isDirty()).toBe(false));
  expect(save.mock.lastCall![2].title).toBe("A");
  expect(title.value).toBe("A");
  const summary = container.querySelector<HTMLTextAreaElement>('.properties-sidebar [name="summary"]')!;
  fillProperty(summary, "新摘要"); blurProperty(summary);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  expect(save.mock.lastCall![2]).toMatchObject({ title: "A", summary: "新摘要" });
  expect(container.textContent).not.toContain("模拟保存失败");
});

it("skips a property persistence call when a draft returns to the unchanged queue value before blur", async () => {
  const save = vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  const title = await openPropertyTestEntry();
  fillProperty(title, "B"); fillProperty(title, "A"); blurProperty(title);
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")!.click());
  await vi.waitFor(() => expect(container.querySelector("#right-sidebar-ai-panel")?.hasAttribute("hidden")).toBe(false));
  expect(save).not.toHaveBeenCalled();
  expect(editorQueues.get("property-draft")!.isDirty()).toBe(false);
});

it.each(["success", "failure"])("flushes focused property drafts before tray hide with save %s", async outcome => {
  let requestHide!: () => void;
  vi.mocked(desktop.onHideRequested).mockImplementation(async callback => { requestHide = callback; return () => {}; });
  const confirm = vi.spyOn(desktop, "confirmHide").mockResolvedValue();
  const cancel = vi.spyOn(desktop, "cancelHide").mockResolvedValue();
  let resolve!: (value: { version: number }) => void;
  let reject!: (error: Error) => void;
  const save = vi.spyOn(desktop, "save").mockImplementation(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
  const title = await openPropertyTestEntry();
  flushSync(() => title.focus());
  fillProperty(title, "未失焦的标题");
  flushSync(() => { requestHide(); requestHide(); });
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.lastCall![2].title).toBe("未失焦的标题");
  expect(confirm).not.toHaveBeenCalled();
  if (outcome === "success") {
    resolve({ version: 2 });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(cancel).not.toHaveBeenCalled();
    expect(editorQueues.get("property-draft")!.isDirty()).toBe(false);
  } else {
    reject(new Error("磁盘已满"));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(confirm).not.toHaveBeenCalled();
    expect(title.value).toBe("未失焦的标题");
    expect(title.readOnly).toBe(false);
    expect(editorQueues.get("property-draft")!.isDirty()).toBe(true);
    expect(container.textContent).toContain("磁盘已满");
  }
});

it("cancels the tray hide and keeps save feedback when a document cannot be saved", async () => {
  let requestHide!: () => void;
  vi.mocked(desktop.onHideRequested).mockImplementation(async callback => { requestHide = callback; return () => {}; });
  const confirm = vi.spyOn(desktop, "confirmHide").mockResolvedValue();
  const cancel = vi.spyOn(desktop, "cancelHide").mockResolvedValue();
  vi.spyOn(desktop, "save").mockRejectedValue(new Error("disk full"));
  saveDocumentTabs(workspaceId, { ids: ["unsaved"], activeId: "unsaved" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("unsaved")).toBe(true));
  editorQueues.get("unsaved")!.edit({ contentMd: "保留在编辑缓冲" });
  flushSync(() => requestHide());
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(confirm).not.toHaveBeenCalled();
  expect(container.textContent).toContain("有文稿未能保存");
  expect(editorQueues.get("unsaved")!.isDirty()).toBe(true);
});

it("waits for the open canvas save before confirming a tray hide", async () => {
  let requestHide!: () => void;
  vi.mocked(desktop.onHideRequested).mockImplementation(async callback => { requestHide = callback; return () => {}; });
  const confirm = vi.spyOn(desktop, "confirmHide").mockResolvedValue();
  let saved!: () => void;
  flushCanvas.mockReset().mockReturnValue(new Promise(resolve => { saved = resolve; }));
  vi.mocked(desktop.collections).mockResolvedValue([{ id: "canvas-open", title: "画布", description: "", createdAt: 0, updatedAt: 0,
    nodeCount: 1, viewport: { x: 0, y: 0, zoom: 1 } }]);
  saveWorkspaceLayout({ section: "collections", explorerOverride: true, timelineDirectory: "shown", focusMode: false, aiOpen: false });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector("#collection-row-canvas-open")).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>("#collection-row-canvas-open")!.click());
  await vi.waitFor(() => expect(container.querySelector('[data-canvas="canvas-open"]')).not.toBeNull());
  flushSync(() => requestHide());
  await vi.waitFor(() => expect(flushCanvas).toHaveBeenCalledOnce());
  expect(confirm).not.toHaveBeenCalled();
  saved();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
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

it("flushes the still-editable canvas again after loading an article", async () => {
  const topic: Collection = { id: "canvas-open", title: "专题", description: "", createdAt: 0, updatedAt: 0, nodeCount: 1,
    viewport: { x: 0, y: 0, zoom: 1 } };
  vi.mocked(desktop.collections).mockResolvedValue([topic]);
  let open!: (value: Entry) => void, finishSave!: () => void;
  const load = vi.spyOn(desktop, "entry").mockReturnValue(new Promise<Entry>(resolve => { open = resolve; }));
  flushCanvas.mockReset().mockResolvedValueOnce().mockReturnValueOnce(new Promise<void>(resolve => { finishSave = resolve; }));
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const active = () => container.querySelector('[role="tab"][aria-selected="true"]')?.id;
  flushSync(() => root.render(<DesktopShell />));
  click('.sidebar-chrome [aria-label="专题"]');
  await vi.waitFor(() => expect(container.querySelector("#collection-row-canvas-open")).not.toBeNull());
  click("#collection-row-canvas-open");
  await vi.waitFor(() => expect(active()).toBe("collection-tab-canvas-open"));
  await vi.waitFor(() => expect(container.querySelector("#open-canvas-article")).not.toBeNull());
  click("#open-canvas-article");
  await vi.waitFor(() => expect(load).toHaveBeenCalledWith("from-canvas"));
  expect(flushCanvas).toHaveBeenCalledTimes(1);
  open(entry("from-canvas"));
  await vi.waitFor(() => expect(flushCanvas).toHaveBeenCalledTimes(2));
  expect(active()).toBe("collection-tab-canvas-open");
  finishSave();
  await vi.waitFor(() => expect(active()).toBe("tab-from-canvas"));
});

it("flushes the open canvas before replay and reloads a remotely changed canvas opened during replay", async () => {
  const topic: Collection = { id: "canvas-open", title: "旧标题", description: "", createdAt: 0, updatedAt: 0, nodeCount: 1,
    viewport: { x: 30, y: 25, zoom: 0.9 } };
  const other = { ...topic, id: "canvas-edit", title: "另一个专题" };
  vi.mocked(desktop.collections).mockResolvedValue([topic, other]);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const activity = vi.spyOn(desktop, "syncActivity").mockResolvedValue(null);
  vi.spyOn(desktop, "syncRun").mockResolvedValue();
  let finishReplay!: () => void;
  const replay = new Promise<void>(resolve => { finishReplay = resolve; });
  const apply = vi.spyOn(desktop, "syncApply").mockImplementation(async () => {
    await replay;
    vi.mocked(desktop.collections).mockResolvedValue([topic, { ...other, title: "云端标题" }]);
    return { changedCollections: [other.id], changedEntries: [] };
  });
  let finishSave!: () => void;
  flushCanvas.mockReset().mockReturnValue(new Promise<void>(resolve => { finishSave = resolve; }));
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(activity).toHaveBeenCalled());
  click('.sidebar-chrome [aria-label="专题"]');
  await vi.waitFor(() => expect(container.querySelector("#collection-row-canvas-open")).not.toBeNull());
  click("#collection-row-canvas-open");
  await vi.waitFor(() => expect(container.querySelector('[data-canvas="canvas-open"]')).not.toBeNull());
  activity.mockResolvedValue({ hasLocalContent: true, initialized: true, pending: false, incoming: true, issues: 0, phase: "idle", error: null, lastExchangeAt: 1 });
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(flushCanvas).toHaveBeenCalledOnce());
  expect(apply).not.toHaveBeenCalled();
  finishSave();
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  click("#collection-row-canvas-edit");
  const canvas = () => container.querySelector('[data-canvas="canvas-edit"]');
  await vi.waitFor(() => expect(canvas()?.textContent).toBe("另一个专题"));
  const original = canvas();
  finishReplay();
  await vi.waitFor(() => expect(canvas()?.textContent).toBe("云端标题"));
  expect(canvas()).not.toBe(original);
  expect(apply).toHaveBeenCalledOnce();
});

it("updates MCP dots from native events, exposes read errors and recovers", async () => {
  let changed!: () => void;
  let resolveInitial!: (value: Awaited<ReturnType<typeof desktop.mcpStatus>>) => void;
  vi.mocked(desktop.onMcpStatusChanged).mockImplementation(async callback => { changed = callback; return () => {}; });
  vi.mocked(desktop.mcpStatus).mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }));
  flushSync(() => root.render(<Theme><DesktopShell /></Theme>));
  const indicator = () => container.querySelector<HTMLButtonElement>(".status-mcp")!;
  expect(indicator().querySelector(".status-dot")?.getAttribute("data-state")).toBe("unknown");
  await vi.waitFor(() => expect(resolveInitial).toBeDefined());
  const status = { running: true, config: { enabled: true, port: 8787, permission: "read" as const }, error: null };
  resolveInitial(status);
  await vi.waitFor(() => expect(indicator().getAttribute("aria-label")).toBe("MCP（运行中）"));
  expect(indicator().textContent).toBe("");
  expect(indicator().querySelector(".status-dot")?.getAttribute("data-state")).toBe("success");
  vi.mocked(desktop.mcpStatus).mockRejectedValueOnce(new Error("服务读取失败"));
  flushSync(changed);
  await vi.waitFor(() => expect(indicator().getAttribute("aria-label")).toBe("MCP 状态异常：服务读取失败"));
  expect(indicator().querySelector(".status-dot")?.getAttribute("data-state")).toBe("error");
  vi.mocked(desktop.mcpStatus).mockResolvedValue({ ...status, running: false });
  flushSync(changed);
  await vi.waitFor(() => expect(indicator().getAttribute("aria-label")).toBe("MCP（未运行）"));
  expect(indicator().querySelector(".status-dot")?.getAttribute("data-state")).toBe("error");
  flushSync(() => indicator().click());
  await vi.waitFor(() => expect(document.querySelector('.settings-nav-item[aria-current="location"]')?.textContent).toBe("MCP 服务"));
});

it("updates the status bar through sync phases and opens sync settings from it", async () => {
  let changed!: () => void;
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { changed = callback; return () => {}; });
  vi.mocked(desktop.syncStatus).mockResolvedValue({ url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false });
  const state = { hasLocalContent: true, initialized: true, pending: false, incoming: false, issues: 0,
    phase: "downloading" as const, error: null, lastExchangeAt: 1 };
  vi.mocked(desktop.syncActivity).mockResolvedValue(state);
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [] });
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  flushSync(() => root.render(<Theme><DesktopShell /></Theme>));
  const indicator = () => container.querySelector<HTMLButtonElement>(".status-sync")!;
  await vi.waitFor(() => expect(indicator()?.getAttribute("aria-label")).toBe("同步设置：正在下载"));
  expect(indicator().textContent).toBe("");
  expect(indicator().querySelector(".status-dot")?.getAttribute("data-state")).toBe("busy");
  vi.mocked(desktop.syncActivity).mockResolvedValue({ ...state, phase: "merging" });
  flushSync(changed);
  await vi.waitFor(() => expect(indicator()?.getAttribute("aria-label")).toBe("同步设置：正在合并"));
  vi.mocked(desktop.syncActivity).mockResolvedValue({ ...state, phase: "idle", issues: 1 });
  flushSync(changed);
  await vi.waitFor(() => expect(indicator()?.getAttribute("aria-label")).toBe("同步设置：有内容需要处理"));
  vi.mocked(desktop.syncActivity).mockResolvedValue({ ...state, phase: "idle" });
  flushSync(changed);
  await vi.waitFor(() => expect(indicator()?.getAttribute("aria-label")).toBe("同步设置：已同步"));
  expect(indicator().querySelector(".status-dot")?.getAttribute("data-state")).toBe("success");
  flushSync(() => indicator().click());
  await vi.waitFor(() => expect(document.querySelector('.settings-nav-item[aria-current="location"]')?.textContent).toBe("同步"));
});

it("applies while viewing sync settings and explains waits for other pages and confirmations", async () => {
  let incoming = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { listeners.add(callback); return () => listeners.delete(callback); });
  vi.mocked(desktop.syncStatus).mockResolvedValue({ url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false });
  vi.mocked(desktop.syncActivity).mockImplementation(async () => ({ hasLocalContent: true, initialized: true, pending: false, incoming,
    issues: 0, phase: "idle", error: null, lastExchangeAt: 1 }));
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [{ deviceId: "peer", name: "另一台电脑", createdAt: 0, revokedAt: null }] });
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  const apply = vi.spyOn(desktop, "syncApply").mockImplementation(async () => {
    incoming = false;
    queueMicrotask(notify);
    return { changedEntries: [], changedCollections: [] };
  });
  flushSync(() => root.render(<Theme><DesktopShell /></Theme>));
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：已同步"));
  flushSync(() => container.querySelector<HTMLButtonElement>(".status-sync")!.click());
  const address = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("#sync-bound-url");
    expect(input).not.toBeNull();
    return input!;
  });
  address.focus();
  await new Promise(requestAnimationFrame);
  incoming = true;
  flushSync(notify);
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：已同步"));
  expect(document.querySelector(".settings-dialog")).not.toBeNull();

  const nav = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav-item")].find(button => button.textContent === name)!;
  flushSync(() => nav("通用").click());
  incoming = true;
  flushSync(notify);
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：等待关闭当前弹窗"));
  expect(apply).toHaveBeenCalledOnce();

  flushSync(() => nav("同步").click());
  flushSync(() => document.querySelector<HTMLDetailsElement>(".sync-advanced")!.open = true);
  const revoke = [...document.querySelectorAll<HTMLButtonElement>(".sync-settings button")].find(button => button.textContent === "撤销")!;
  flushSync(() => revoke.click());
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  flushSync(notify);
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：等待关闭确认对话框"));
  expect(apply).toHaveBeenCalledOnce();
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === "取消")!;
  flushSync(() => cancel.click());
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
  flushSync(notify);
  await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
});

it("waits for a sync settings operation and disables actions during automatic replay", async () => {
  let incoming = false;
  let finishInfo!: (info: { url: string; accessKey: string }) => void;
  let finishApply!: () => void;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { listeners.add(callback); return () => listeners.delete(callback); });
  vi.mocked(desktop.syncStatus).mockResolvedValue({ url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false });
  vi.mocked(desktop.syncActivity).mockImplementation(async () => ({ hasLocalContent: true, initialized: true, pending: false, incoming,
    issues: 0, phase: "idle", error: null, lastExchangeAt: 1 }));
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [] });
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  vi.spyOn(desktop, "syncConnectionInfo").mockImplementation(() => new Promise(resolve => { finishInfo = resolve; }));
  vi.spyOn(desktop, "copyText").mockResolvedValue();
  const apply = vi.spyOn(desktop, "syncApply").mockImplementation(async () => {
    await new Promise<void>(resolve => { finishApply = resolve; });
    incoming = false;
    return { changedEntries: [], changedCollections: [] };
  });
  flushSync(() => root.render(<Theme><DesktopShell /></Theme>));
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：已同步"));
  flushSync(() => container.querySelector<HTMLButtonElement>(".status-sync")!.click());
  const copy = await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".sync-settings button")].find(button => button.textContent === "复制连接信息");
    expect(button).toBeDefined();
    return button!;
  });
  vi.useFakeTimers();
  flushSync(() => copy.click());
  incoming = true;
  flushSync(notify);
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：等待当前操作完成"));
  expect(apply).not.toHaveBeenCalled();
  finishInfo({ url: "https://sync.example.test", accessKey: "test-key" });
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(copy.disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(copy.disabled).toBe(true);
  finishApply();
  await vi.waitFor(() => expect(copy.disabled).toBe(false));
});

it("does not replay again when a phase read finishes after its own replay", async () => {
  let changed!: () => void;
  let holdPhaseRead = false;
  let releasePhaseRead!: () => void;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { changed = callback; return () => {}; });
  const binding = { url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false };
  vi.mocked(desktop.syncStatus).mockImplementation(async () => {
    if (holdPhaseRead) await new Promise<void>(resolve => { releasePhaseRead = resolve; });
    return binding;
  });
  const state = { hasLocalContent: true, initialized: true, pending: false, incoming: false, issues: 1,
    phase: "idle" as const, error: null, lastExchangeAt: 1 };
  vi.mocked(desktop.syncActivity).mockResolvedValue(state);
  const apply = vi.spyOn(desktop, "syncApply").mockImplementation(async () => {
    holdPhaseRead = true;
    changed();
    holdPhaseRead = false;
    return { changedEntries: [], changedCollections: [] };
  });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：有内容需要处理"));
  vi.mocked(desktop.syncActivity).mockResolvedValue({ ...state, incoming: true });
  flushSync(changed);
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  // Let the application loop finish before releasing its own delayed status read.
  await new Promise(resolve => setTimeout(resolve, 30));
  releasePhaseRead();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(apply).toHaveBeenCalledOnce();
});

it("requests one foreground check per restoration and leaves startup and online wake semantics intact", async () => {
  let focused = true;
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(desktop.syncActivity).toHaveBeenCalled());
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(desktop.syncWake).not.toHaveBeenCalled();

  focused = false;
  window.dispatchEvent(new Event("blur"));
  focused = true;
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  expect(desktop.syncWake).toHaveBeenCalledExactlyOnceWith("foreground");

  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  focused = false;
  window.dispatchEvent(new Event("blur"));
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(desktop.syncWake).toHaveBeenCalledTimes(1);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(desktop.syncWake).toHaveBeenCalledTimes(2);
  expect(vi.mocked(desktop.syncWake).mock.calls).toEqual([["foreground"], ["foreground"]]);
  window.dispatchEvent(new Event("online"));
  expect(desktop.syncWake).toHaveBeenLastCalledWith();
  expect(desktop.syncWake).toHaveBeenCalledTimes(3);
});

it("checks the remote on restoration while unsaved input keeps downloaded changes deferred", async () => {
  let focused = false;
  let statusChanged!: () => void;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { statusChanged = callback; return () => {}; });
  vi.mocked(desktop.syncStatus).mockResolvedValue({ url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false });
  vi.mocked(desktop.syncActivity).mockResolvedValue({ hasLocalContent: true, initialized: true, pending: true, incoming: false,
    issues: 0, phase: "idle", error: null, lastExchangeAt: 1 });
  const apply = vi.spyOn(desktop, "syncApply").mockResolvedValue({ changedEntries: [], changedCollections: [] });
  vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  saveDocumentTabs(workspaceId, { ids: ["foreground-edit"], activeId: "foreground-edit" });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("foreground-edit")).toBe(true));
  const queue = editorQueues.get("foreground-edit")!;
  queue.edit({ contentMd: "仍在输入的本地正文" });
  vi.mocked(desktop.syncActivity).mockResolvedValue({ hasLocalContent: true, initialized: true, pending: true, incoming: true,
    issues: 0, phase: "idle", error: null, lastExchangeAt: 1 });
  const input = container.appendChild(document.createElement("input"));
  input.focus();
  focused = true;
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(desktop.syncWake).toHaveBeenCalledExactlyOnceWith("foreground"));
  expect(apply).not.toHaveBeenCalled();
  expect(queue.snapshot().fields.contentMd).toBe("仍在输入的本地正文");
  expect(queue.isDirty()).toBe(true);
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：等待文稿保存完成"));

  await queue.flush();
  statusChanged();
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：等待结束编辑"));
  expect(apply).not.toHaveBeenCalled();
  input.blur();
  statusChanged();
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(desktop.syncWake).toHaveBeenCalledOnce();
});

it("marks joined topics and updates the menu after adding an article without opening the topic", async () => {
  const topic = { id: "reading-list", title: "待研究", description: "", createdAt: 0, updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 }, nodeCount: 0 };
  const joined = { ...topic, id: "research", title: "数据采集", nodeCount: 1 };
  vi.mocked(desktop.collections).mockResolvedValue([joined, topic]);
  const memberships = vi.spyOn(desktop, "entryCollections").mockResolvedValue([joined]);
  vi.spyOn(desktop, "collectionCanvas").mockResolvedValue({ collection: topic, nodes: [], edges: [] });
  const add = vi.spyOn(desktop, "createCollectionNode").mockResolvedValue({
    id: "reference", collectionId: topic.id, kind: "entry", entryId: "manual", assetId: null, color: null, contentMd: "", externalUrl: null, entry: null,
    x: 24, y: 24, width: 320, height: 144, createdAt: 0, updatedAt: 0,
  });
  flushSync(() => root.render(<DesktopShell />));
  const row = await vi.waitFor(() => {
    const target = container.querySelector("#entry-row-manual");
    expect(target).not.toBeNull();
    return target!;
  });
  const openSubmenu = () => {
    flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "加入专题")!;
    flushSync(() => { item.focus(); item.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  };
  const option = (title: string) => [...document.querySelectorAll<HTMLElement>('.add-to-collection-submenu [role="menuitem"]')]
    .find(item => item.textContent === title);
  expect(memberships).not.toHaveBeenCalled();
  openSubmenu();
  await vi.waitFor(() => expect(option(joined.title)?.getAttribute("aria-label")).toBe("数据采集（已加入）"));
  expect(memberships).toHaveBeenCalledExactlyOnceWith("manual");
  expect(option(joined.title)?.querySelector(".collection-entry-current")).not.toBeNull();
  const destination = await vi.waitFor(() => {
    const item = option(topic.title);
    expect(item).toBeDefined();
    expect(item!.querySelector(".collection-entry-current")).toBeNull();
    return item!;
  });
  flushSync(() => destination.click());
  await vi.waitFor(() => expect(add).toHaveBeenCalledExactlyOnceWith(topic.id, { kind: "entry", entryId: "manual" }, { x: 24, y: 24 }));
  expect(container.querySelector(".workspace-toast")).toBeNull();
  expect(container.querySelector("#collection-tab-reading-list")).toBeNull();
  memberships.mockResolvedValue([joined, topic]);
  openSubmenu();
  await vi.waitFor(() => expect(option(topic.title)?.getAttribute("aria-label")).toBe("待研究（已加入）"));
  expect(option(topic.title)?.querySelector(".collection-entry-current")).not.toBeNull();
  expect(memberships).toHaveBeenCalledTimes(2);
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
  ["current", false, ["first", "manual"]],
  ["new-tab", false, ["first", "second", "manual"]],
  ["current", true, ["first", "second", "manual"]],
  ["new-tab", true, ["first", "second", "manual"]],
] as const)("opens a clicked document using %s with modifier=%s", async (mode, modifier, expected) => {
  localStorage.setItem("document-open-mode", JSON.stringify(mode));
  saveDocumentTabs(workspaceId, { ids: ["first", "second"], activeId: "second" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe("tab-second"));
  flushSync(() => container.querySelector<HTMLButtonElement>("#entry-row-manual")!.dispatchEvent(new MouseEvent("click", {
    bubbles: true, [commandKey === "⌘" ? "metaKey" : "ctrlKey"]: modifier,
  })));
  await vi.waitFor(() => expect(openTabs()).toEqual(expected));
  expect(container.querySelectorAll(".tabs > .tab")).toHaveLength(expected.length);
  expect(container.querySelector(".tab-exiting")).toBeNull();
  expect(readDocumentTabs(workspaceId)).toEqual({ ids: expected, activeId: "manual" });
  expect(localStorage.getItem("document-open-mode")).toBe(JSON.stringify(mode));
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
  const screen = container.querySelector<HTMLElement>('[role="region"][aria-label="公众号排版预览"]');
  expect(screen?.tabIndex).toBe(0);
  expect(screen?.shadowRoot?.querySelector("article > h1:first-child")?.textContent).toBe("first");
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

it.each([
  [new Date(2026, 10, 22, 14), ["今天", "昨天", "前天", "本周", "上周", "11月", "10月"]],
  [new Date(2026, 10, 23, 14), ["今天", "昨天", "前天", "上周", "11月", "10月"]],
  [new Date(2026, 0, 1, 14), ["今天", "昨天", "前天", "本周", "上周", "2025年12月", "2025年11月"]],
] as const)("keeps timeline creation-date groups and order after editing on %s", async (today, labels) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(today);
  const articles = [0, 1, 2, 3, 6, 7, 8, 13, 14, 40].map(daysAgo => {
    const createdAt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, 9).getTime();
    return { ...entry(`day-${daysAgo}`), createdAt, updatedAt: createdAt };
  });
  let refresh!: () => void;
  vi.mocked(desktop.onWorkspaceChanged).mockImplementation(async callback => { refresh = callback; return () => {}; });
  let reads = 0;
  vi.mocked(desktop.entries).mockImplementation(async filter => {
    if (!filter.includePreview || filter.pinned) return { items: [], nextOffset: null };
    reads++;
    return { items: [...articles].sort((a, b) => filter.sort === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt), nextOffset: null };
  });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('.sidebar-chrome [aria-label="文章时间流"]')).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>('.sidebar-chrome [aria-label="文章时间流"]')!.click());
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".timeline-entry-open")];
  await vi.waitFor(() => expect(rows()).toHaveLength(articles.length));
  const groups = () => [...container.querySelectorAll(".timeline-group ul")].map(group => ({
    label: group.getAttribute("aria-label"), titles: [...group.querySelectorAll("strong")].map(title => title.textContent),
  }));
  expect(groups().map(group => group.label)).toEqual(labels);
  const initialGroups = groups();
  const previousReads = reads;
  articles.forEach((article, index) => { article.updatedAt = Date.now() + index * 1000; });
  flushSync(() => refresh());
  await vi.waitFor(() => expect(reads).toBeGreaterThan(previousReads));
  await vi.waitFor(() => expect(container.querySelector(".timeline-entries")?.getAttribute("aria-busy")).toBe("false"));
  expect(groups()).toEqual(initialGroups);
  expect(rows().map(row => row.id)).toEqual(articles.map(article => `timeline-row-${article.id}`));
  expect([...container.querySelectorAll<HTMLTimeElement>(".timeline-entry time")].map(time => time.dateTime))
    .toEqual(articles.map(article => new Date(article.createdAt).toISOString()));
});

it("restores the timeline selection, its collapsed date and tree groups, and the manually hidden directory pane", async () => {
  const initial = await desktop.library();
  vi.mocked(desktop.library).mockResolvedValue({ ...initial, tags: [{ id: "wechat", name: "微信" }] });
  const row = { ...entry("时间流文章", "closed"), createdAt: Date.now(), updatedAt: Date.now() };
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
  const aiDivider = () => container.querySelector('[aria-label="调整右侧栏宽度"]');
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
  const first = { ...entry("父目录文章", "closed"), createdAt: new Date(2025, 2, 7, 10).getTime(), updatedAt: Date.now(),
    preview: { summary: "父目录摘要", image: null } };
  const second = { ...entry("子目录文章", "child"), createdAt: new Date(2025, 3, 7, 10).getTime(), updatedAt: Date.now(),
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
    categoryId: "closed", exactCategory: false, sort: "created", kind: "article", includePreview: true, pinned: false,
  }));
  expect(rows()[0].textContent).toContain("子目录摘要");
  expect(rows()[0].querySelector(".timeline-cover")).not.toBeNull();
  expect(rows()[0].querySelector("time")?.dateTime).toBe(new Date(second.createdAt).toISOString());
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
  expect(setPin).toHaveBeenLastCalledWith(second.id, true, { kind: "folder", id: "closed" });
  expect(document.activeElement).toBe(openRow(0));
  pin().focus();
  flushSync(() => pin().click());
  await vi.waitFor(() => expect(container.querySelector('.timeline-group ul[aria-label="已固定"]')).toBeNull());
  expect(titles()).toEqual(["子目录文章", "父目录文章"]);
  expect(document.activeElement).toBe(openRow(0));
  expect(setPin).toHaveBeenLastCalledWith(second.id, false, { kind: "folder", id: "closed" });
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

it("keeps folder, tag, and content-directory pins independent", async () => {
  const library = await desktop.library();
  vi.mocked(desktop.library).mockResolvedValue({ ...library, tags: [{ id: "wechat", name: "微信" }] });
  const article = { ...entry("shared", "closed"), pinned: true };
  const pins = new Set<string>();
  const setPin = vi.spyOn(desktop, "setEntryPinned").mockImplementation(async (_id, pinned, scope) => {
    const key = JSON.stringify(scope);
    if (pinned) pins.add(key);
    else pins.delete(key);
  });
  vi.mocked(desktop.entries).mockImplementation(async filter => {
    if (!filter.timelineScope) return { items: filter.pinned ? [article] : [], nextOffset: null };
    const matches = filter.categoryId === "closed" || filter.tagIds?.includes("wechat");
    const pinned = pins.has(JSON.stringify(filter.timelineScope));
    return { items: matches && filter.pinned === pinned ? [{ ...article, pinned }] : [], nextOffset: null };
  });
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const label = () => container.querySelector(".timeline-pin")?.getAttribute("aria-label");
  const fixedRow = () => container.querySelector('ul[aria-label="已固定"] #timeline-row-shared');
  const directoryPin = () => container.querySelector("#tree-pinned-list #entry-row-shared");
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(directoryPin()).not.toBeNull());
  click('.sidebar-chrome [aria-label="文章时间流"]');
  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")).not.toBeNull());
  click("#folder-row-closed");
  await vi.waitFor(() => expect(label()).toBe("置顶"));
  click(".timeline-pin");
  await vi.waitFor(() => expect(fixedRow()).not.toBeNull());
  click("#timeline-tag-wechat");
  await vi.waitFor(() => expect(label()).toBe("置顶"));
  expect(fixedRow()).toBeNull();

  flushSync(() => container.querySelector(".timeline-entry")!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
  ));
  const pinItem = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(pinItem.textContent).toBe("置顶");
  flushSync(() => pinItem.click());
  await vi.waitFor(() => expect(fixedRow()).not.toBeNull());

  click("#folder-row-closed");
  await vi.waitFor(() => expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("已折叠"));
  expect(label()).toBe("取消置顶");
  click(".timeline-pin");
  await vi.waitFor(() => expect(fixedRow()).toBeNull());
  click("#timeline-tag-wechat");
  await vi.waitFor(() => expect(fixedRow()).not.toBeNull());
  expect(label()).toBe("取消置顶");
  click('.sidebar-chrome [aria-label="内容目录"]');
  await vi.waitFor(() => expect(directoryPin()).not.toBeNull());
  expect(setPin.mock.calls).toEqual([
    [article.id, true, { kind: "folder", id: "closed" }],
    [article.id, true, { kind: "tag", id: "wechat" }],
    [article.id, false, { kind: "folder", id: "closed" }],
  ]);
});

it("keeps the right sidebar toggle in the writing header when the AI panel opens or closes", async () => {
  vi.spyOn(desktop, "aiSettings").mockResolvedValue({ preferences: { enabled: false, defaultTarget: null }, models: [], agents: [] });
  flushSync(() => root.render(<DesktopShell />));
  const toggle = container.querySelector<HTMLButtonElement>(".workbench-chrome #ai-panel-trigger")!;
  expect(toggle.getAttribute("aria-label")).toBe("显示右侧栏");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => toggle.click());
  expect(toggle.getAttribute("aria-label")).toBe("隐藏右侧栏");
  expect(container.querySelector(".ai-sidebar")?.hasAttribute("inert")).toBe(false);
  await vi.waitFor(() => expect(container.querySelector(".ai-panel")).not.toBeNull());
  flushSync(() => container.querySelector(".ai-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".ai-sidebar")?.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(toggle);
  expect(container.querySelector(".workbench-chrome #ai-panel-trigger")).toBe(toggle);
});

it.each(["edit", "preview"])("keeps the %s view when opening WeChat settings", async mode => {
  localStorage.setItem("view", JSON.stringify(mode));
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["wechat-view"], activeId: "wechat-view" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  vi.spyOn(desktop, "save").mockImplementation(async (_id, version) => ({ version: version + 1 }));
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("wechat-view")).toBe(true));
  flushSync(() => container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!.click());
  const wechat = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>("#right-sidebar-wechat-button");
    expect(button).not.toBeNull(); expect(button!.disabled).toBe(false); return button!;
  });
  flushSync(() => wechat.click());
  await vi.waitFor(() => expect(container.querySelector(".wechat-publishing-panel")).not.toBeNull());
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe(mode);
});

it("restores document outline preferences in the shared sidebar and closes through its main toggle", async () => {
  saveDocumentTabs(workspaceId, { ids: ["outline-first", "outline-second"], activeId: "outline-first",
    options: { "outline-first": { outline: true }, "outline-second": { outline: false } } });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  const selected = () => container.querySelector("#right-sidebar-outline-button")?.getAttribute("aria-pressed");
  await vi.waitFor(() => expect(selected()).toBe("true"));
  expect(container.querySelector(".document-body .document-outline")).toBeNull();
  flushSync(() => container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!.click());
  await vi.waitFor(() => expect(readDocumentTabs(workspaceId)?.options?.["outline-first"].outline).toBe(false));
  flushSync(() => container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!.click());
  await vi.waitFor(() => expect(selected()).toBe("true"));
  flushSync(() => container.querySelector<HTMLButtonElement>("#tab-outline-second")!.click());
  await vi.waitFor(() => expect(selected()).toBeUndefined());
  flushSync(() => container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!.click());
  await vi.waitFor(() => expect(selected()).toBe("true"));
  await vi.waitFor(() => expect(readDocumentTabs(workspaceId)?.options?.["outline-second"].outline).toBe(true));
});

it("uses the existing default outline setting to open the right sidebar", async () => {
  localStorage.setItem("default-document-outline", "true");
  saveDocumentTabs(workspaceId, { ids: ["outline-default"], activeId: "outline-default" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector("#right-sidebar-outline-button")?.getAttribute("aria-pressed")).toBe("true"));
  expect(container.querySelector("#ai-panel-trigger")?.getAttribute("aria-expanded")).toBe("true");
});

it("toggles the current WeChat sidebar and restores it through the shared header button", async () => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["wechat-toggle"], activeId: "wechat-toggle" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("wechat-toggle")).toBe(true));
  expect(container.querySelector('[aria-label="公众号"]')).toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!;
  flushSync(() => toggle.click());
  const wechat = container.querySelector<HTMLButtonElement>('#right-sidebar-wechat-button')!;
  expect(wechat.textContent).toBe("");
  expect(wechat.querySelector('svg[aria-hidden="true"] path')).not.toBeNull();
  flushSync(() => wechat.click());
  await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
  expect(toggle.getAttribute("aria-label")).toBe("隐藏右侧栏");
  expect(toggle.querySelector("svg rect[fill=currentColor]")).not.toBeNull();
  expect(wechat.getAttribute("aria-pressed")).toBe("true");
  flushSync(() => toggle.click());
  await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  expect(toggle.getAttribute("aria-label")).toBe("显示右侧栏");
  expect(container.querySelector(".wechat-publishing-panel")).toBeNull();
  flushSync(() => toggle.click());
  await vi.waitFor(() => expect(container.querySelector(".wechat-publishing-panel")).not.toBeNull());
  expect(toggle.getAttribute("aria-label")).toBe("隐藏右侧栏");
  expect(container.querySelector(".ai-sidebar")?.hasAttribute("inert")).toBe(true);
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")!.click());
  await vi.waitFor(() => expect(container.querySelector("#right-sidebar-ai-panel")?.hasAttribute("hidden")).toBe(false));
  expect(container.querySelector(".ai-sidebar")?.hasAttribute("inert")).toBe(false);
  expect(container.querySelector(".wechat-publishing-panel")).toBeNull();
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-properties-button")!.click());
  await vi.waitFor(() => expect(container.querySelector(".properties-sidebar")).not.toBeNull());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("cancels a pending properties load when the shared sidebar is closed and reopened", async () => {
  saveDocumentTabs(workspaceId, { ids: ["open-note"], activeId: "open-note" });
  let finishLoad!: (value: Entry) => void;
  vi.spyOn(desktop, "entry").mockImplementation(id => id === "manual"
    ? new Promise(resolve => { finishLoad = resolve; }) : Promise.resolve(entry(id)));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("open-note")).toBe(true));
  const toggle = container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!;
  flushSync(() => toggle.click());
  const row = await vi.waitFor(() => {
    const node = container.querySelector("#entry-row-manual"); expect(node).not.toBeNull(); return node!;
  });
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  flushSync(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "内容属性")!.click());
  expect(container.querySelector("#right-sidebar-properties-button")?.getAttribute("aria-busy")).toBe("true");
  flushSync(() => toggle.click());
  flushSync(() => toggle.click());
  expect(container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")?.disabled).toBe(false);
  finishLoad(entry("manual"));
  await Promise.resolve();
  expect(container.querySelector("#right-sidebar-ai-button")?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector(".properties-sidebar")).toBeNull();
});

it("saves focused properties before switching modules and reflects subsequent editor changes", async () => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["inspector", "other"], activeId: "inspector" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), summary: "原摘要", contentMd: "保留正文" }));
  vi.spyOn(desktop, "aiThreads").mockResolvedValue([]);
  const save = vi.spyOn(desktop, "save").mockImplementation(async (_id, version) => ({ version: version + 1 }));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("inspector")).toBe(true));
  flushSync(() => container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!.click());
  await vi.waitFor(() => expect(container.querySelector("#right-sidebar-properties-button")).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-properties-button")!.click());
  const summary = await vi.waitFor(() => {
    const field = container.querySelector<HTMLTextAreaElement>('.properties-sidebar [name="summary"]'); expect(field).not.toBeNull(); return field!;
  });
  let finishProperty!: (value: {version:number}) => void;
  save.mockReturnValueOnce(new Promise(resolve => { finishProperty = resolve; }));
  flushSync(() => {
    summary.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "尚未失焦的摘要");
    summary.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")!.click();
  });
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith("inspector", expect.any(Number), expect.objectContaining({ summary: "尚未失焦的摘要", contentMd: "保留正文" }), "auto"));
  expect(container.querySelector(".properties-sidebar")).not.toBeNull();
  expect(container.querySelector("#right-sidebar-ai-button")?.getAttribute("aria-busy")).toBe("true");
  finishProperty({ version: 2 });
  await vi.waitFor(() => expect(container.querySelector("#right-sidebar-ai-panel")?.hasAttribute("hidden")).toBe(false));
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-properties-button")!.click());
  await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>('.properties-sidebar [name="summary"]')?.value).toBe("尚未失焦的摘要"));
  flushSync(() => editorQueues.get("inspector")!.edit({ title: "从编辑器更新的标题" }));
  await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('.properties-sidebar [name="title"]')?.value).toBe("从编辑器更新的标题"));
  const nextSummary = container.querySelector<HTMLTextAreaElement>('.properties-sidebar [name="summary"]')!;
  flushSync(() => {
    nextSummary.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(nextSummary, "切换文章前的摘要");
    nextSummary.dispatchEvent(new InputEvent("input", { bubbles: true }));
    editorQueues.get("inspector")!.edit({ contentMd: "编辑器中的最新正文" });
  });
  expect(nextSummary.value).toBe("切换文章前的摘要");
  flushSync(() => container.querySelector<HTMLButtonElement>("#tab-other")!.click());
  await vi.waitFor(() => expect(container.querySelector("#tab-other")?.getAttribute("aria-selected")).toBe("true"));
  expect(save).toHaveBeenLastCalledWith("inspector", expect.any(Number), expect.objectContaining({ summary: "切换文章前的摘要", contentMd: "编辑器中的最新正文" }), "auto");
  await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>('.properties-sidebar [name="summary"]')?.value).toBe("原摘要"));
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")!.click());
  await vi.waitFor(() => expect(container.querySelector("#right-sidebar-ai-button")?.getAttribute("aria-pressed")).toBe("true"));
  flushSync(() => container.querySelector<HTMLButtonElement>("#tab-inspector")!.click());
  await vi.waitFor(() => expect(container.querySelector("#tab-inspector")?.getAttribute("aria-selected")).toBe("true"));
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-properties-button")!.click());
  await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>('.properties-sidebar [name="summary"]')?.value).toBe("切换文章前的摘要"));
  const title = container.querySelector<HTMLInputElement>('.properties-sidebar [name="title"]')!;
  flushSync(() => {
    title.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "当前文章的标题");
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")!.click();
  });
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith("inspector", expect.any(Number), expect.objectContaining({ title: "当前文章的标题" }), "auto"));
});

it("keeps invalid properties visible when switching modules or documents", async () => {
  saveDocumentTabs(workspaceId, { ids: ["first", "second"], activeId: "first" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), source: { url: "https://example.com/article", author: "", accountName: "", originalPublishedAt: null, importedAt: null } }));
  const save = vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("first")).toBe(true));
  flushSync(() => container.querySelector<HTMLButtonElement>("#ai-panel-trigger")!.click());
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-properties-button")!.click());
  const source = await vi.waitFor(() => {
    const field = container.querySelector<HTMLInputElement>('.properties-sidebar [name="sourceUrl"]'); expect(field).not.toBeNull(); return field!;
  });
  flushSync(() => {
    source.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(source, "invalid-url");
    source.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")!.click();
  });
  await vi.waitFor(() => expect(container.querySelector(".properties-sidebar")?.textContent).toContain("HTTP"));
  expect(source.value).toBe("invalid-url");
  expect(container.querySelector("#right-sidebar-properties-button")?.getAttribute("aria-pressed")).toBe("true");
  flushSync(() => container.querySelector<HTMLButtonElement>("#tab-second")!.click());
  await Promise.resolve();
  expect(container.querySelector("#tab-first")?.getAttribute("aria-selected")).toBe("true");
  expect(save).not.toHaveBeenCalled();
  flushSync(() => container.querySelector<HTMLButtonElement>("#document-action-trigger")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  const focusItem = await vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "专注写作");
    expect(item).toBeDefined(); return item!;
  });
  flushSync(() => focusItem.click());
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  expect(container.querySelector(".properties-sidebar")).not.toBeNull();
  expect(source.value).toBe("invalid-url");
  expect(container.querySelector("#ai-panel-trigger")).not.toBeNull();
  flushSync(() => {
    source.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(source, "https://example.com/fixed");
    source.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>("#document-action-trigger")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  const retryFocus = await vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "专注写作");
    expect(item).toBeDefined(); return item!;
  });
  flushSync(() => retryFocus.click());
  await vi.waitFor(() => expect(container.querySelector(".properties-sidebar")).toBeNull());
  expect(container.querySelector("#show-sidebar")?.getAttribute("aria-label")).toBe("退出专注写作");
  expect(save).toHaveBeenLastCalledWith("first", expect.any(Number), expect.objectContaining({ source: expect.objectContaining({ url: "https://example.com/fixed" }) }), "auto");
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
  expect(menuItems().map(item => item.textContent)).toEqual(["新建笔记", "导入链接", "导入 Markdown", "新建目录"]);
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
  await vi.waitFor(() => expect(saveFolder).toHaveBeenCalledExactlyOnceWith(null, "closed", "未命名", "folder", null));

  flushSync(() => container.querySelector<HTMLButtonElement>("#add-root-folder")!.click());
  expect(subfolderInput()).not.toBeNull();
  flushSync(() => subfolderInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  flushSync(() => container.querySelector<HTMLButtonElement>("#folder-row-child")!.click());
  expect(container.querySelector<HTMLButtonElement>("#add-root-folder")!.disabled).toBe(true);
  await vi.waitFor(() => expect(container.querySelector(".timeline-heading h1")?.textContent).toBe("子目录"));
  openMenu(".timeline-content");
  expect(menuItems().map(item => item.textContent)).toEqual(["新建笔记", "导入链接", "导入 Markdown"]);
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
  const save = vi.spyOn(desktop, "save").mockImplementation(async (_id, version) => ({ version: version + 1 }));
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
    const field = document.querySelector<HTMLTextAreaElement>(".properties-sidebar textarea[name=summary]");
    expect(field?.value).toBe(target.summary);
    return field!;
  });
  expect(summary.form!.querySelector('[type="submit"]')).toBeNull();
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "更新列表文章的摘要");
    summary.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  flushSync(() => summary.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(target.id, 3, expect.objectContaining({
    summary: "更新列表文章的摘要",
  }), "auto"));
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "再次更新摘要");
    summary.dispatchEvent(new InputEvent("input", { bubbles: true }));
    summary.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(target.id, 4, expect.objectContaining({ summary: "再次更新摘要" }), "auto"));
  expect(document.querySelector('[aria-label="关闭右侧栏"]')).toBeNull();
  flushSync(() => document.querySelector<HTMLButtonElement>('#ai-panel-trigger')!.click());
  await vi.waitFor(() => expect(document.querySelector(".properties-sidebar")).toBeNull());
  expect(openTabs()).toEqual(["open-note"]);
});

it("saves and closes an unopened article's properties when the article is deleted", async () => {
  const target = { ...entry("closed-delete"), summary: "原摘要", version: 3 };
  let persistedVersion = target.version;
  vi.spyOn(desktop, "entry").mockImplementation(async id => id === target.id ? { ...target, version: persistedVersion } : entry(id));
  vi.mocked(desktop.entries).mockResolvedValue({ items: [target], nextOffset: null });
  const save = vi.spyOn(desktop, "save").mockImplementation(async () => ({ version: ++persistedVersion }));
  const remove = vi.spyOn(desktop, "setDeleted").mockResolvedValue({ ...target, deletedAt: 1, version: 5 });
  flushSync(() => root.render(<DesktopShell />));
  const row = await vi.waitFor(() => {
    const node = container.querySelector("#entry-row-closed-delete"); expect(node).not.toBeNull(); return node!;
  });
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  flushSync(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "内容属性")!.click());
  const summary = await vi.waitFor(() => {
    const field = container.querySelector<HTMLTextAreaElement>('.properties-sidebar [name="summary"]'); expect(field).not.toBeNull(); return field!;
  });
  flushSync(() => {
    summary.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "删除前保留的摘要");
    summary.dispatchEvent(new InputEvent("input", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true }));
  });
  flushSync(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "移入回收站")!.click());
  await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(target.id, 4, true));
  expect(save).toHaveBeenCalledExactlyOnceWith(target.id, 3, expect.objectContaining({ summary: "删除前保留的摘要" }), "auto");
  await vi.waitFor(() => expect(container.querySelector(".properties-sidebar")).toBeNull());
  expect(openTabs()).not.toContain(target.id);
});

it("keeps the new article's property draft when an earlier deletion finishes", async () => {
  saveDocumentTabs(workspaceId, { ids: ["open-note", "second"], activeId: "open-note" });
  const target = entry("delete-pending");
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), source: { url: "https://example.com/original", author: "", accountName: "", originalPublishedAt: null, importedAt: null } }));
  vi.mocked(desktop.entries).mockResolvedValue({ items: [target], nextOffset: null });
  let finishDelete!: (value: Entry) => void;
  const remove = vi.spyOn(desktop, "setDeleted").mockReturnValue(new Promise(resolve => { finishDelete = resolve; }));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("second")).toBe(true));
  const row = await vi.waitFor(() => {
    const node = container.querySelector("#entry-row-delete-pending"); expect(node).not.toBeNull(); return node!;
  });
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  flushSync(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "内容属性")!.click());
  await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('.properties-sidebar [name="title"]')?.value).toBe(target.id));
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  flushSync(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "移入回收站")!.click());
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
  flushSync(() => container.querySelector<HTMLButtonElement>("#tab-second")!.click());
  await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('.properties-sidebar [name="title"]')?.value).toBe("second"));
  const source = container.querySelector<HTMLInputElement>('.properties-sidebar [name="sourceUrl"]')!;
  flushSync(() => {
    source.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(source, "invalid-url");
    source.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await act(async () => { finishDelete({ ...target, deletedAt: 1, version: 2 }); });
  expect(container.querySelector<HTMLInputElement>('.properties-sidebar [name="title"]')?.value).toBe("second");
  expect(container.querySelector<HTMLInputElement>('.properties-sidebar [name="sourceUrl"]')?.value).toBe("invalid-url");
  flushSync(() => container.querySelector<HTMLButtonElement>("#right-sidebar-ai-button")!.click());
  await vi.waitFor(() => expect(container.querySelector(".properties-sidebar")?.textContent).toContain("HTTP"));
  expect(container.querySelector("#right-sidebar-properties-button")?.getAttribute("aria-pressed")).toBe("true");
});

it.each([true, false])("recovers property conflicts without losing drafts for an initially open=%s article", async initiallyOpen => {
  const target = { ...entry("property-conflict"), summary: "原摘要", publicationPlatforms: [{ platform: "CSDN", url: "https://example.com/post" }] };
  saveDocumentTabs(workspaceId, { ids: initiallyOpen ? [target.id] : [], activeId: initiallyOpen ? target.id : null });
  vi.spyOn(desktop, "entry").mockResolvedValue(target);
  vi.mocked(desktop.entries).mockResolvedValue({ items: [target], nextOffset: null });
  const save = vi.spyOn(desktop, "save").mockRejectedValue({ code: "VERSION_CONFLICT", currentVersion: 2, message: "内容版本已变化" });
  const create = vi.spyOn(desktop, "create").mockResolvedValue(entry("conflict-copy"));
  flushSync(() => root.render(<DesktopShell />));
  const row = await vi.waitFor(() => {
    const node = container.querySelector("#entry-row-property-conflict"); expect(node).not.toBeNull(); return node!;
  });
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  flushSync(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "内容属性")!.click());
  const summary = await vi.waitFor(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[name="summary"]'); expect(input).not.toBeNull(); return input!;
  });
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "冲突时保留的摘要");
    summary.dispatchEvent(new InputEvent("input", { bubbles: true }));
    summary.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await vi.waitFor(() => expect(document.querySelector(".properties-sidebar")?.textContent).toContain("内容版本已变化"));
  const title = document.querySelector<HTMLInputElement>('[name="title"]')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "关闭前的标题");
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('#ai-panel-trigger')!.click();
  });
  await vi.waitFor(() => expect(document.querySelector(".properties-sidebar")).toBeNull());
  expect(openTabs()).toContain(target.id);
  expect(editorQueues.get(target.id)!.snapshot().fields).toMatchObject({ title: "关闭前的标题", summary: "冲突时保留的摘要", publicationPlatforms: target.publicationPlatforms });
  expect(save).toHaveBeenCalledOnce();
  const copy = [...document.querySelectorAll<HTMLButtonElement>(".save-error button")].find(button => button.textContent === "另存为副本")!;
  expect(copy).toBeDefined();
  flushSync(() => copy.click());
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith("article", expect.objectContaining({ title: "关闭前的标题", summary: "冲突时保留的摘要", publicationPlatforms: target.publicationPlatforms })));
});

it("waits for an unopened article's unblurred property edits before exiting", async () => {
  const target = { ...entry("property-exit"), summary: "原摘要" };
  vi.spyOn(desktop, "entry").mockResolvedValue(target);
  vi.mocked(desktop.entries).mockResolvedValue({ items: [target], nextOffset: null });
  let requestExit!: () => void;
  vi.mocked(desktop.onExit).mockImplementation(async callback => { requestExit = callback; return () => {}; });
  let completeSave!: () => void;
  const save = vi.spyOn(desktop, "save").mockImplementation(() => new Promise(resolve => { completeSave = () => resolve({ version: 2 }); }));
  const begin = vi.spyOn(desktop, "beginExit").mockResolvedValue();
  const finish = vi.spyOn(desktop, "finishExit").mockResolvedValue();
  flushSync(() => root.render(<DesktopShell />));
  const row = await vi.waitFor(() => {
    const node = container.querySelector("#entry-row-property-exit"); expect(node).not.toBeNull(); return node!;
  });
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true })));
  const properties = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "内容属性")!;
  flushSync(() => properties.click());
  const summary = await vi.waitFor(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[name="summary"]'); expect(input).not.toBeNull(); return input!;
  });
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "退出前保存的摘要");
    summary.dispatchEvent(new InputEvent("input", { bubbles: true }));
    requestExit();
  });
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith(target.id, 1, expect.objectContaining({ summary: "退出前保存的摘要" }), "auto"));
  expect(begin).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  completeSave();
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
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

it.each(["completed", "partial", "article"] as const)("opens a %s link import without leaving the timeline folder", async status => {
  const article = status === "article";
  const imported = entry(article ? "外部文章" : "公众号文章", "closed");
  const url = article ? "https://example.com/article" : "https://mp.weixin.qq.com/s/demo";
  if (article) localStorage.setItem("download-pasted-images", "true");
  let saved = false;
  const importLink = vi.spyOn(desktop, "importLink").mockImplementation(async () => {
    saved = true;
    if (article) return { kind: "article", article: {
      entryId: imported.id, existing: false, deleted: false, unavailableImages: 1,
    }};
    return { kind: "wechat", job: {
      id: "wechat-import", url, entryId: imported.id, status, error: null,
      pendingImages: status === "partial" ? 1 : 0,
    }};
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
    ? '[role="menuitem"]' : ".workbench-empty-actions button")].find(button => button.textContent === "导入链接")!;
  flushSync(() => launch.click());
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="url"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, url);
  flushSync(() => field.dispatchEvent(new InputEvent("input", { bubbles: true })));
  flushSync(() => field.form!.requestSubmit());
  await vi.waitFor(() => expect(importLink).toHaveBeenCalledExactlyOnceWith(url, "closed", article));

  if (status === "partial") {
    const open = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".wechat-job button")].find(item => item.textContent === "打开笔记");
      expect(button).toBeDefined();
      return button!;
    });
    flushSync(() => open.click());
  }

  await vi.waitFor(() => expect(container.querySelector(`[data-document="${imported.id}"]`)).not.toBeNull());
  if (article) expect(container.textContent).toContain("1 张图片未能下载，已保留原链接");
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


it.each(["visible", "hidden"] as const)("applies downloaded changes without foreground focus when visibility is %s", async visibility => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
  let incoming = false;
  let notify!: () => void;
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async listener => { notify = listener; return () => {}; });
  vi.mocked(desktop.syncStatus).mockResolvedValue({ url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false });
  vi.mocked(desktop.syncActivity).mockImplementation(async () => ({ hasLocalContent: true, initialized: true, pending: false, incoming,
    issues: 0, phase: "idle", error: null, lastExchangeAt: 1 }));
  const apply = vi.spyOn(desktop, "syncApply").mockImplementation(async () => {
    incoming = false;
    queueMicrotask(notify);
    return { changedEntries: [], changedCollections: [] };
  });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：已同步"));
  incoming = true;
  const input = container.appendChild(document.createElement("input"));
  input.focus();
  notify();
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：已同步"));
});

it("reports pending uploads as processing upload tasks", async () => {
  vi.mocked(desktop.syncStatus).mockResolvedValue({ url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false });
  vi.mocked(desktop.syncActivity).mockResolvedValue({ hasLocalContent: true, initialized: true, pending: true, incoming: false,
    issues: 0, phase: "idle", error: null, lastExchangeAt: 1 });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector(".status-sync")?.getAttribute("aria-label")).toBe("同步设置：正在处理上传任务"));
});

it.each(["copyMarkdown", "copyWechat"] as const)("runs %s from its shortcut with current text, feedback and no editor formatting", async action => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["copy-key"], activeId: "copy-key" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), contentMd: "# 原文" }));
  vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const plain = vi.spyOn(desktop, "copyText").mockReturnValue(pending);
  const html = vi.spyOn(desktop, "copyHtml").mockReturnValue(pending);
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("copy-key")).toBe(true));
  flushSync(() => editorQueues.get("copy-key")!.edit({ contentMd: "# 当前草稿\n\n**未保存内容**" }));
  const target = container.appendChild(document.createElement("div")); target.contentEditable = "true";
  const format = vi.fn(); target.addEventListener("keydown", format);
  const stroke = { code: "KeyC", key: "C", [commandKey === "⌘" ? "metaKey" : "ctrlKey"]: true,
    shiftKey: action === "copyMarkdown", altKey: action === "copyWechat", bubbles: true, cancelable: true };
  const press = (extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { ...stroke, ...extra });
    flushSync(() => target.dispatchEvent(event)); return event;
  };
  expect(press({ isComposing: true }).defaultPrevented).toBe(false);
  expect(plain).not.toHaveBeenCalled(); expect(html).not.toHaveBeenCalled();
  format.mockClear();
  expect(press().defaultPrevented).toBe(true);
  const copied = action === "copyMarkdown" ? plain : html;
  await vi.waitFor(() => expect(copied).toHaveBeenCalledOnce());
  expect(format).not.toHaveBeenCalled();
  if (action === "copyMarkdown") expect(plain).toHaveBeenLastCalledWith("# 当前草稿\n\n**未保存内容**");
  else { expect(html.mock.lastCall![0]).toContain("<strong"); expect(html.mock.lastCall![1]).toContain("未保存内容"); }
  press(); press({ repeat: true });
  expect(copied).toHaveBeenCalledOnce();
  finish();
  await vi.waitFor(() => expect(container.querySelector(`[data-feedback-state="success"]`)).not.toBeNull());
  press(); expect(copied).toHaveBeenCalledOnce();
});

it("rejects a stale clipboard render after the recommendation list changes", async () => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["copy-stale"], activeId: "copy-stale" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  const copied = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  let finish!: (value: Awaited<ReturnType<typeof publishing.renderForPublication>>) => void;
  const render = vi.spyOn(publishing, "renderForPublication").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("copy-stale")).toBe(true));
  flushSync(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC", key: "c", altKey: true,
    [commandKey === "⌘" ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  const queue = editorQueues.get("copy-stale")!;
  const current = queue.capture().fields.wechatPublication ?? emptyPublication();
  flushSync(() => queue.edit({ wechatPublication: { ...current, recommendations: { ...current.recommendations, mode: "manual", enabled: false, items: [] } } }));
  const dispose = vi.fn();
  finish({ result: { html: "旧推荐", text: "旧推荐", revision: 1, themeId: "plainly-default", images: [], warnings: [], dispose }, hosting: false, exportImages: [] });
  await vi.waitFor(() => expect(container.textContent).toContain("文章或推荐内容已变化"));
  expect(copied).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});

it.each(wechatThemes)("copies $label through the inline renderer before writing HTML to the clipboard", async theme => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["copy-inline-theme"], activeId: "copy-inline-theme" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), themeId: theme.id,
    contentMd: "## 章节\n\n正文 **强调**。", wechatPublication: { ...emptyPublication(), recommendations: { ...emptyPublication().recommendations, enabled: false } },
  }));
  vi.spyOn(desktop, "save").mockImplementation(async (_id, version) => ({ version: version + 1 }));
  const copied = vi.spyOn(desktop, "copyHtml").mockResolvedValue();
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("copy-inline-theme")).toBe(true));
  flushSync(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC", key: "c", altKey: true,
    [commandKey === "⌘" ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(copied).toHaveBeenCalledOnce());
  const [html, text] = copied.mock.lastCall!;
  const template = document.createElement("template"); template.innerHTML = html;
  const article = template.content.firstElementChild as HTMLElement;
  expect(article.style.width).toBe("100%");
  expect(article.style.paddingLeft).toBe("0px");
  expect(article.style.paddingRight).toBe("0px");
  expect(article.querySelector("h2")?.style.fontSize).not.toBe("");
  expect(article.querySelector("strong")?.style.fontWeight).not.toBe("");
  expect(html).not.toMatch(/<style|<link|\sclass=|var\(/);
  expect(text).toContain("正文 强调。");
});

it.each(["article", "idea"] as const)("saves the selected preview theme for a %s without changing Markdown", async kind => {
  localStorage.setItem("links-to-footnotes", "false");
  localStorage.setItem("view", JSON.stringify("preview"));
  saveDocumentTabs(workspaceId, { ids: ["preview-theme"], activeId: "preview-theme" });
  const markdown = "# **原文**\n\n正文内容保持不变。";
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), kind, contentMd: markdown,
    wechatPublication: { ...emptyPublication(), recommendations: { ...emptyPublication().recommendations, enabled: false } },
  }));
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  const save = vi.spyOn(desktop, "save").mockImplementation(async (_id, version) => ({ version: version + 1 }));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>(".preview-theme-label")?.disabled).toBe(false));
  flushSync(() => container.querySelector<HTMLButtonElement>(".preview-theme-label")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await vi.waitFor(() => expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull());
  const theme = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === "莫兰迪")!;
  flushSync(() => theme.click());
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith("preview-theme", expect.any(Number), expect.objectContaining({ themeId: "morandi", contentMd: markdown }), "auto"));
  await vi.waitFor(() => expect(container.querySelector(".preview-theme-label")?.textContent).toBe("莫兰迪"));
  expect(editorQueues.get("preview-theme")!.snapshot().fields.contentMd).toBe(markdown);
});

it("previews a deleted article without generating or saving recommendations and can restore it", async () => {
  localStorage.setItem("links-to-footnotes", "false");
  localStorage.setItem("view", JSON.stringify("preview"));
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), deletedAt: 1 }));
  const save = vi.spyOn(desktop, "save").mockResolvedValue({ version: 2 });
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  const restore = vi.spyOn(desktop, "setDeleted").mockResolvedValue({ ...entry("deleted-preview"), version: 2 });
  vi.mocked(desktop.entries).mockResolvedValue({ items: [{ ...entry("deleted-preview"), deletedAt: 1 }], nextOffset: null });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(container.querySelector('[aria-label="回收站"]')).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="回收站"]')!.click());
  await vi.waitFor(() => expect(container.querySelector('#entry-row-deleted-preview')).not.toBeNull());
  flushSync(() => container.querySelector<HTMLButtonElement>('#entry-row-deleted-preview')!.click());
  await vi.waitFor(() => expect(container.querySelector('[aria-label="公众号排版预览"]')).not.toBeNull());
  expect(desktop.wechatRecommendations).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>(".preview-theme-label")?.disabled).toBe(true);
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "恢复");
  expect(button).toBeDefined();
  flushSync(() => button!.click());
  await vi.waitFor(() => expect(restore).toHaveBeenCalledWith("deleted-preview", 1, false));
});

it("reports one owned save error and can exit after retrying without losing the draft", async () => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["publication-save-error"], activeId: "publication-save-error" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), wechatPublication: { schemaVersion: 1, recommendations: {
    enabled: true, mode: "manual", countOverride: null, inputFingerprint: null, items: [],
  } } }));
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  const save = vi.spyOn(desktop, "save").mockRejectedValueOnce(new Error("磁盘写入失败"))
    .mockImplementation(async (_id, version) => ({ version: version + 1 }));
  let requestExit!: () => void;
  vi.mocked(desktop.onExit).mockImplementation(async callback => { requestExit = callback; return () => {}; });
  vi.spyOn(desktop, "beginExit").mockResolvedValue();
  const finish = vi.spyOn(desktop, "finishExit").mockResolvedValue();
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("publication-save-error")).toBe(true));
  flushSync(() => container.querySelector<HTMLButtonElement>('#ai-panel-trigger')!.click());
  flushSync(() => container.querySelector<HTMLButtonElement>('#right-sidebar-wechat-button')!.click());
  const copy = () => container.querySelector<HTMLButtonElement>(".wechat-publishing-footer button")!;
  await vi.waitFor(() => expect(copy()?.disabled).toBe(false));
  const queue = editorQueues.get("publication-save-error")!;
  flushSync(() => queue.edit({ contentMd: "不能丢失的当前正文" }));
  flushSync(() => copy().click());
  await vi.waitFor(() => expect(container.querySelector(".save-error")?.textContent).toContain("磁盘写入失败"));
  await vi.waitFor(() => expect(copy().getAttribute("aria-busy")).toBeNull());
  expect([...container.querySelectorAll('[role="alert"]')].filter(element => element.textContent?.includes("磁盘写入失败"))).toHaveLength(1);
  expect(container.querySelector(".status-action-feedback")?.textContent).not.toContain("磁盘写入失败");
  expect(container.querySelector(".wechat-publishing-footer .action-error-slot")?.textContent).not.toContain("磁盘写入失败");
  const resolve = vi.mocked(desktop.resolveWechatRecommendations);
  resolve.mockClear();
  let finishRefresh!: (value: { items: []; invalid: [] }) => void;
  resolve.mockReturnValueOnce(new Promise(done => { finishRefresh = done; }));
  const retry = [...container.querySelectorAll<HTMLButtonElement>(".save-error button")].find(button => button.textContent === "重试保存")!;
  flushSync(() => retry.click());
  await vi.waitFor(() => expect(queue.isDirty()).toBe(false));
  await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
  expect(container.textContent).not.toContain("磁盘写入失败");
  expect(save).toHaveBeenLastCalledWith("publication-save-error", 1, expect.objectContaining({ contentMd: "不能丢失的当前正文" }), "auto");
  flushSync(() => queue.edit({ contentMd: "重试成功后继续输入的正文" }));
  await act(async () => { finishRefresh({ items: [], invalid: [] }); });
  expect(container.textContent).not.toContain("磁盘写入失败");
  flushSync(() => requestExit());
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  expect(save.mock.calls.at(-1)![2].contentMd).toBe("重试成功后继续输入的正文");
});

it.each(["edit", "preview"])("keeps publication controls stable while typing in %s mode and waits for autosave before background refresh", async view => {
  localStorage.setItem("links-to-footnotes", "false");
  localStorage.setItem("view", JSON.stringify(view));
  saveDocumentTabs(workspaceId, { ids: ["typing-publication"], activeId: "typing-publication" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), wechatPublication: { schemaVersion: 1, recommendations: {
    enabled: true, mode: "manual", countOverride: null, inputFingerprint: null, items: [],
  } } }));
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  const save = vi.spyOn(desktop, "save").mockImplementation(async (_id, version) => ({ version: version + 1 }));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("typing-publication")).toBe(true));
  flushSync(() => container.querySelector<HTMLButtonElement>('#ai-panel-trigger')!.click());
  flushSync(() => container.querySelector<HTMLButtonElement>('#right-sidebar-wechat-button')!.click());
  const copy = () => container.querySelector<HTMLButtonElement>(".wechat-publishing-footer button")!;
  await vi.waitFor(() => expect(copy()?.disabled).toBe(false));
  await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>(".wechat-recommendation-empty button")?.disabled).toBe(false));
  const queue = editorQueues.get("typing-publication")!;
  const resolve = vi.mocked(desktop.resolveWechatRecommendations);
  save.mockClear(); resolve.mockClear();
  vi.useFakeTimers();
  for (const contentMd of ["正", "正文", "正文输入中"]) {
    flushSync(() => queue.edit({ contentMd }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(save).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(copy().disabled).toBe(false);
    expect(container.querySelector('#tab-typing-publication .unsaved-dot')).not.toBeNull();
  }
  let finish!: (value: { items: []; invalid: [] }) => void;
  resolve.mockReturnValueOnce(new Promise(done => { finish = done; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][2].contentMd).toBe("正文输入中");
  expect(copy().disabled).toBe(false);
  await act(async () => { finish({ items: [], invalid: [] }); });
});

it("refreshes a previously invalid recommendation after a workspace change without reopening the sidebar", async () => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["reference-recovery"], activeId: "reference-recovery" });
  const recommendation = { entryId: "past", title: "往期文章", url: "https://mp.weixin.qq.com/s/past" };
  vi.spyOn(desktop, "entry").mockImplementation(async id => ({ ...entry(id), wechatPublication: { schemaVersion: 1, recommendations: {
    enabled: true, mode: "manual", countOverride: null, inputFingerprint: null, items: [recommendation],
  } } }));
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  let valid = false;
  let notify!: () => void;
  vi.mocked(desktop.onWorkspaceChanged).mockImplementation(async listener => { notify = listener; return () => {}; });
  vi.mocked(desktop.resolveWechatRecommendations).mockImplementation(async () => valid ? { items: [recommendation], invalid: [] }
    : { items: [], invalid: [{ entryId: "past", message: "文章尚不可用" }] });
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("reference-recovery")).toBe(true));
  flushSync(() => container.querySelector<HTMLButtonElement>('#ai-panel-trigger')!.click());
  const trigger = container.querySelector<HTMLButtonElement>('#right-sidebar-wechat-button')!;
  flushSync(() => trigger.click());
  const copy = () => container.querySelector<HTMLButtonElement>(".wechat-publishing-footer button")!;
  await vi.waitFor(() => expect(container.querySelector(".wechat-publishing-panel")?.textContent).toContain("文章尚不可用"));
  expect(copy().disabled).toBe(true);
  valid = true; flushSync(() => notify());
  await vi.waitFor(() => expect(copy().disabled).toBe(false));
  expect(desktop.wechatRecommendations).not.toHaveBeenCalled();
  expect(editorQueues.get("reference-recovery")!.capture().fields.wechatPublication?.recommendations.mode).toBe("manual");
});

it("uses persisted custom workspace keys and honors disabled defaults", async () => {
  localStorage.setItem("workspace-shortcuts", JSON.stringify({ palette: { code: "F8", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, create: "none" }));
  const create = vi.spyOn(desktop, "create");
  flushSync(() => root.render(<DesktopShell />));
  const press = (init: KeyboardEventInit) => flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })));
  press({ key: "k", code: "KeyK", ctrlKey: true });
  press({ key: "n", code: "KeyN", ctrlKey: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(create).not.toHaveBeenCalled();
  press({ key: "F8", code: "F8" });
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
});

it("toggles reading with Mod+R and preview with Mod+W without reloading or closing the current tab", async () => {
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["mode-keys"], activeId: "mode-keys" });
  const load = vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("mode-keys")).toBe(true));
  const mod = { ctrlKey: commandKey !== "⌘", metaKey: commandKey === "⌘" };
  const press = (code: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { ...mod, code, key: code.slice(-1).toLowerCase(), bubbles: true, cancelable: true, ...extra });
    flushSync(() => document.body.dispatchEvent(event)); return event;
  };
  const reading = () => container.querySelector(".reading-toggle")?.getAttribute("aria-pressed");
  expect(reading()).toBe("false");
  expect(press("KeyR").defaultPrevented).toBe(true);
  expect(reading()).toBe("true");
  press("KeyR", { repeat: true }); expect(reading()).toBe("true");
  press("KeyR"); expect(reading()).toBe("false");
  expect(press("KeyW").defaultPrevented).toBe(true);
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("preview");
  press("KeyW", { repeat: true });
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("preview");
  press("KeyW");
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("edit");
  expect(openTabs()).toEqual(["mode-keys"]);
  expect(load).toHaveBeenCalledOnce();
});

it("records workspace shortcuts in settings and applies them without restarting", async () => {
  flushSync(() => root.render(<DesktopShell />));
  flushSync(() => container.querySelector<HTMLButtonElement>('.status-bar [aria-label="设置"]')!.click());
  const record = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>("#shortcut-palette"); expect(button).not.toBeNull(); return button!;
  });
  flushSync(() => record.click());
  const input = document.querySelector<HTMLInputElement>("input#shortcut-palette")!;
  flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", code: "F8", bubbles: true, cancelable: true })));
  expect(JSON.parse(localStorage.getItem("workspace-shortcuts")!).palette.code).toBe("F8");
  expect(document.querySelector('input[aria-label="查找命令或笔记"]')).toBeNull();
  const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!;
  flushSync(() => close.click());
  await vi.waitFor(() => expect(document.querySelector('[aria-label="关闭设置"]')).toBeNull());
  await vi.waitFor(() => expect(container.querySelector('.status-bar [aria-label="设置"]')?.getAttribute("aria-expanded")).toBe("false"));
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", code: "F8", bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(document.querySelector('input[aria-label="查找命令或笔记"]')).not.toBeNull());
});

it("uses a recorded shortcut immediately without firing for a different chord or repeat", async () => {
  const chord = { code: "KeyJ", ctrlKey: true, metaKey: false, altKey: true, shiftKey: true };
  localStorage.setItem("view-shortcut", JSON.stringify(chord));
  saveDocumentTabs(workspaceId, { ids: ["custom-shortcut"], activeId: "custom-shortcut" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("custom-shortcut")).toBe(true));
  const preview = () => container.querySelector(".status-bar")?.textContent?.includes("继续编辑");
  expect(preview()).toBe(false);
  window.dispatchEvent(new KeyboardEvent("keydown", { ...chord, shiftKey: false, key: "j", bubbles: true, cancelable: true }));
  expect(preview()).toBe(false);
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { ...chord, key: "j", bubbles: true, cancelable: true })));
  expect(preview()).toBe(true);
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { ...chord, key: "j", repeat: true, bubbles: true, cancelable: true })));
  expect(preview()).toBe(true);
});

it("reassigns the released WeChat copy chord to view switching before editor formatting", async () => {
  const chord = { code: "KeyC", ctrlKey: commandKey !== "⌘", metaKey: commandKey === "⌘", altKey: true, shiftKey: false };
  localStorage.setItem("workspace-shortcuts", JSON.stringify({ copyWechat: "none" }));
  localStorage.setItem("view-shortcut", JSON.stringify(chord));
  localStorage.setItem("links-to-footnotes", "false");
  saveDocumentTabs(workspaceId, { ids: ["reassigned"], activeId: "reassigned" });
  vi.spyOn(desktop, "entry").mockImplementation(async id => entry(id));
  vi.spyOn(desktop, "wechatGraphics").mockResolvedValue([]);
  flushSync(() => root.render(<DesktopShell />));
  await vi.waitFor(() => expect(editorQueues.has("reassigned")).toBe(true));
  const target = container.appendChild(document.createElement("div")); target.contentEditable = "true";
  const format = vi.fn((event: KeyboardEvent) => event.preventDefault()); target.addEventListener("keydown", format);
  const event = new KeyboardEvent("keydown", { ...chord, key: "c", bubbles: true, cancelable: true });
  flushSync(() => target.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(format).not.toHaveBeenCalled();
  expect(container.querySelector(".status-bar")?.textContent).toContain("继续编辑");
});

it.each(["empty", "promote", "trash"] as const)("deletes a folder with the %s choice", async choice => {
  saveWorkspaceLayout({ section: "folders", explorerOverride: true, timelineDirectory: "shown", focusMode: false, aiOpen: false });
  if (choice !== "empty") vi.mocked(desktop.entries).mockImplementation(async filter => ({
    items: filter.categoryId === "closed" ? [entry("inside", "closed")] : [], nextOffset: null,
  }));
  const deleted = vi.spyOn(desktop, "deleteCategory").mockResolvedValue([]);
  flushSync(() => root.render(<Theme><DesktopShell /></Theme>));
  await vi.waitFor(() => expect(container.querySelector("#folder-row-closed")).not.toBeNull());
  flushSync(() => container.querySelector("#folder-row-closed")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
  const menuItem = await vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "删除目录");
    expect(item).toBeDefined(); return item!;
  });
  flushSync(() => menuItem.click());
  if (choice === "empty") {
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledExactlyOnceWith("closed", "promote"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    return;
  }
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(deleted).not.toHaveBeenCalled();
  const checkbox = dialog.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  if (choice === "trash") flushSync(() => checkbox.click());
  flushSync(() => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "删除文件夹")!.click());
  await vi.waitFor(() => expect(deleted).toHaveBeenCalledExactlyOnceWith("closed", choice));
});
