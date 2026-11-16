// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Entry } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { AiPanel } from "./AiPanel";
import { DesktopShell } from "./DesktopShell";
import type { DocumentEditor } from "./Document";
import { readDocumentTabs, saveDocumentTabs } from "./preferences";

vi.mock(import("./Document"), async importOriginal => ({
  ...await importOriginal(),
  DocumentEditor: ({ queue, display, onDisplayChange }: ComponentProps<typeof DocumentEditor>) => (
    <button data-document={queue.entry.id} data-links={display.convertLinks}
      onClick={() => onDisplayChange("convertLinks", !display.convertLinks)}>切换链接脚注</button>
  ),
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

it("keeps startup defaults independent of sidebar, view, and footnote changes", async () => {
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
  await vi.waitFor(() => expect(links("first")).toBe("false"));
  expect(container.querySelector("#show-sidebar")).toBeNull();
  expect(container.querySelector("#document-body")?.getAttribute("data-view")).toBe("edit");
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

it("starts with a blank AI sidebar even when SQLite returns a current thread and history", async () => {
  vi.spyOn(desktop, "aiThreads").mockResolvedValue([
    { id: "previous-run-active", title: "上次的对话", updatedAt: 1, archived: false },
    { id: "previous-run-history", title: "上次的历史", updatedAt: 0, archived: true },
  ]);
  const fetch = vi.spyOn(desktop, "aiThread");
  const load = vi.spyOn(desktop, "aiMessages");
  const deleteThread = vi.spyOn(desktop, "aiDeleteThread");
  flushSync(() => root.render(<Theme><AiPanel open target={{ label: "测试模型" }} targetPicker={null}
    canChat canEdit={false} canWrite={() => false} onClose={() => {}} onSettings={() => {}} /></Theme>));
  await vi.waitFor(() => expect(container.textContent).toContain("开始新对话"));
  const history = container.querySelector<HTMLButtonElement>('[aria-label="对话记录"]')!;
  flushSync(() => history.click());
  await vi.waitFor(() => expect(container.textContent).toContain("暂无对话"));
  expect(fetch).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(deleteThread).not.toHaveBeenCalled();
});
