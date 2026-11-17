// @vitest-environment jsdom
import { useState } from "react";
import { ContextMenu, Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktop } from "../desktop";
import { CreateMenu, Explorer } from "./Explorer";
import { MoveEntryMenu } from "./MoveEntryMenu";
import { WorkspaceSearch } from "./WorkspaceSearch";

it("lists move destinations by folder hierarchy and selects the intended child", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onMove = vi.fn();
  const folders = [
    { id: "articles", name: "文章", parentId: null, icon: "folder", sortOrder: 0 },
    { id: "material", name: "资料", parentId: null, icon: "folder", sortOrder: 1 },
    { id: "drafts", name: "草稿", parentId: "articles", icon: "folder", sortOrder: 0 },
    { id: "material-drafts", name: "草稿", parentId: "material", icon: "folder", sortOrder: 0 },
  ] as const;
  try {
    flushSync(() => root.render(<Theme><ContextMenu.Root>
      <ContextMenu.Trigger><button type="button">文档</button></ContextMenu.Trigger>
      <ContextMenu.Content><MoveEntryMenu categories={[...folders]} current="drafts" onMove={onMove} /></ContextMenu.Content>
    </ContextMenu.Root></Theme>));
    flushSync(() => container.querySelector("button")!.dispatchEvent(new MouseEvent("contextmenu", {
      button: 2, bubbles: true, cancelable: true,
    })));
    flushSync(() => document.querySelector('[role="menuitem"]')!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight", bubbles: true, cancelable: true,
    })));
    const items = await vi.waitFor(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".move-entry-submenu [role=menuitem]")];
      expect(rows.map(row => row.textContent)).toEqual(["根目录", "文章", "草稿", "资料", "草稿"]);
      return rows;
    });
    expect(items.filter(row => row.classList.contains("move-entry-child"))).toEqual([items[2], items[4]]);
    expect(items[2].querySelector(".move-entry-current")).not.toBeNull();
    expect(items[2].getAttribute("aria-label")).toBe("草稿，上级目录 文章（当前位置）");
    expect(items[4].getAttribute("aria-label")).toBe("草稿，上级目录 资料");
    flushSync(() => items[4].click());
    expect(onMove).toHaveBeenCalledExactlyOnceWith("material-drafts");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows search syntax on field focus and keeps focus when the panel opens", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Search() {
    const [query, onQuery] = useState("");
    return <><WorkspaceSearch query={query} onQuery={onQuery} caseSensitive={false} onCaseSensitive={vi.fn()} inputRef={null} />
      <button type="button" data-outside>工作区</button></>;
  }
  const operators = () => document.querySelector<HTMLElement>('[aria-label="搜索语法"]');
  try {
    flushSync(() => root.render(<Theme><Search /></Theme>));
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(operators()?.querySelectorAll("button")).toHaveLength(6);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(operators()?.querySelector("button"));
    flushSync(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(operators()).toBeNull());
    expect(document.activeElement).toBe(input);
    flushSync(() => input.click());
    expect(operators()).not.toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-outside]")!.focus());
    expect(operators()).toBeNull();
    flushSync(() => input.focus());
    expect(operators()).not.toBeNull();
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "关键词");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(operators()).toBeNull();
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(JSON.parse(localStorage.getItem("workspace-search-history")!)).toEqual(["关键词"]);
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-outside]")!.focus());
    flushSync(() => input.focus());
    expect(operators()).not.toBeNull();
    expect(document.activeElement).toBe(input);
    flushSync(() => root.render(<Theme><Search key="reopened" /></Theme>));
    const recent = operators()?.querySelector<HTMLButtonElement>(".search-history-item")!;
    expect(recent?.textContent).toBe("关键词");
    flushSync(() => recent.click());
    const reopened = container.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!;
    expect(reopened.value).toBe("关键词");
    expect(document.activeElement).toBe(reopened);
    expect(operators()).toBeNull();
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reopened, "下一次搜索");
      reopened.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="清除搜索"]')!.click());
    expect(JSON.parse(localStorage.getItem("workspace-search-history")!)).toEqual(["下一次搜索", "关键词"]);
    flushSync(() => operators()?.querySelector<HTMLButtonElement>('[aria-label="清除搜索历史"]')!.click());
    expect(operators()?.querySelector(".search-history")).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    localStorage.removeItem("workspace-search-history");
  }
});

it("offers the same creation commands and inserts a search operator at an editable position", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onImportMarkdown = vi.fn();
  function Search() {
    const [query, onQuery] = useState("测试");
    const [caseSensitive, onCaseSensitive] = useState(false);
    return <WorkspaceSearch {...{ query, onQuery, caseSensitive, onCaseSensitive }} inputRef={null} />;
  }
  try {
    flushSync(() => root.render(<Theme><Search /><CreateMenu onCreate={vi.fn()} onImportWechat={vi.fn()} onImportMarkdown={onImportMarkdown} /></Theme>));
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    flushSync(() => button("区分大小写").click());
    expect(button("区分大小写").getAttribute("aria-pressed")).toBe("true");
    const field = container.querySelector<HTMLInputElement>('input[aria-label="搜索笔记"]')!;
    flushSync(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    flushSync(() => button("搜索选项").click());
    const scoped = [...document.querySelectorAll<HTMLButtonElement>(".search-operator")].find(option => option.textContent!.startsWith("section:"))!;
    flushSync(() => scoped.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.value).toBe("测试 section:()");
    expect(field.selectionStart).toBe(field.value.length - 1);
    flushSync(() => button("新建内容").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const items = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
    expect(items.map(item => item.textContent)).toEqual(["新建笔记", "导入公众号文章", "导入 Markdown"]);
    flushSync(() => items[2].click());
    expect(onImportMarkdown).toHaveBeenCalledOnce();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("creates folders inline and sends the indicated folder reorder and entry move", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const observed = new Map<Element, () => void>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      observed.set(target, () => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    disconnect() {}
  });
  const pinIds = ["pin-a", "pin-b"];
  let pinned = pinIds;
  const entries = vi.spyOn(desktop, "entries").mockImplementation(async filter => {
    const all = filter.pinned ? pinned : filter.categoryId === "child" ? [] : filter.categoryId ? ["nested-entry", "another-entry"]
      : ["entry", ...pinIds.filter(id => !pinned.includes(id))];
    const offset = filter.offset!;
    const end = offset + filter.limit!;
    return {
      items: all.slice(offset, end).map(id => ({ id, title: "稿件", kind: "article", status: "draft", updatedAt: 0, deletedAt: null,
        categoryId: filter.categoryId ?? null, pinned: Boolean(filter.pinned) })),
      nextOffset: end < all.length ? end : null,
    };
  });
  const root = document.createElement("div");
  document.body.append(root);
  const render = createRoot(root);
  const onCreate = vi.fn();
  const onImportWechat = vi.fn();
  const onImportMarkdown = vi.fn();
  const onSaveFolder = vi.fn().mockResolvedValue(undefined);
  const onReorderFolder = vi.fn();
  const onReorderEntry = vi.fn();
  const onRenameEntry = vi.fn().mockResolvedValue(undefined);
  const onMoveEntry = vi.fn();
  const onOpen = vi.fn();
  const onRowAction = vi.fn();
  const onLocateCurrent = vi.fn();
  const onToggleAll = vi.fn();
  const previousSort = localStorage.getItem("directory-sort");
  const previousLocate = localStorage.getItem("directory-auto-locate");
  const previousPinCollapse = localStorage.getItem("directory-pins-collapsed");
  const previousDirectoryCollapse = localStorage.getItem("directory-collapsed");
  localStorage.removeItem("directory-sort");
  localStorage.removeItem("directory-auto-locate");
  localStorage.removeItem("directory-pins-collapsed");
  localStorage.removeItem("directory-collapsed");
  const position = (name: string) => root.querySelector<HTMLElement>(`[data-tree-id=${name}]`)!;
  const point = vi.fn();
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: point });
  function drag(name: string, target: HTMLElement, clientY = 0) {
    point.mockReturnValue(target);
    const event = new PointerEvent(name, { bubbles: true, cancelable: true, clientY, button: 0,
      buttons: name === "pointerup" ? 0 : 1, isPrimary: true, pointerId: 1, pointerType: "mouse" });
    flushSync(() => target.dispatchEvent(event));
  }
  function mount(loading: "all" | "paged", pageSize: number, revision = 0, expanded = ["one"], openMode: "current" | "new-tab" = "current", active = "nested-entry") {
    flushSync(() => render.render(<Theme><Explorer section="folders" active={active} openMode={openMode} readOnlyIds={[]} treeLocked={false}
      library={{ workspaceId: "test", tags: [], tagSuggestions: [], categories: [
        { id: "one", parentId: null, sortOrder: 0, name: "一", icon: "folder" },
        { id: "two", parentId: null, sortOrder: 1, name: "二", icon: "archive" },
        { id: "untitled", parentId: null, sortOrder: 2, name: "未命名", icon: "folder" },
        { id: "child", parentId: "one", sortOrder: 0, name: "子", icon: "book" },
      ] }} page={null} expanded={expanded} revision={revision} loading={loading} pageSize={pageSize} caseSensitive={false} query=""
      searchInputRef={null} listError="" onRetry={vi.fn()} onQuery={vi.fn()} onCaseSensitive={vi.fn()}
      onFolder={vi.fn()} onCreate={onCreate} onRevealFolder={vi.fn()}
      onImportWechat={onImportWechat} onImportMarkdown={onImportMarkdown}
      onSaveFolder={onSaveFolder} onFolderError={vi.fn()} onReorderFolder={onReorderFolder} onMoveEntry={onMoveEntry}
      onReorderEntry={onReorderEntry} onRenameEntry={onRenameEntry}
      onCategoryAction={vi.fn()} onOpen={onOpen} onToggleAll={onToggleAll} onLocateCurrent={onLocateCurrent} onRowAction={onRowAction} onMore={vi.fn()} /></Theme>));
  }
  try {
    mount("paged", 60);
    await vi.waitFor(() => expect(position("entry")).not.toBeNull());
    expect(root.querySelector(".folder-row[data-selected=true], .row-menu")).toBeNull();
    const pinToggle = root.querySelector<HTMLButtonElement>('[aria-controls="tree-pinned-list"]')!;
    const directoryToggle = root.querySelector<HTMLButtonElement>('[aria-controls="tree-directory-list"]')!;
    expect(directoryToggle.textContent).toBe("目录");
    flushSync(() => pinToggle.click());
    expect(pinToggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector("#tree-pinned-list")?.hasAttribute("inert")).toBe(true);
    expect(localStorage.getItem("directory-pins-collapsed")).toBe("true");
    flushSync(() => pinToggle.click());
    flushSync(() => directoryToggle.click());
    expect(directoryToggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector("#tree-directory-list")?.hasAttribute("inert")).toBe(true);
    expect(root.querySelector("#tree-pinned-list")?.hasAttribute("inert")).toBe(false);
    expect(localStorage.getItem("directory-collapsed")).toBe("true");
    flushSync(() => directoryToggle.click());
    expect(root.querySelector("#folder-row-one")?.getAttribute("aria-expanded")).toBe("true");
    expect(position("nested-entry").getAttribute("aria-current")).toBe("true");
    expect(root.querySelector("#folder-row-one")!.hasAttribute("title")).toBe(false);
    flushSync(() => root.querySelector<HTMLButtonElement>('[aria-label="全部折叠"]')!.click());
    expect(onToggleAll).toHaveBeenLastCalledWith(false);
    mount("paged", 60, 0, ["child"]);
    flushSync(() => root.querySelector<HTMLButtonElement>('[aria-label="全部展开"]')!.click());
    expect(onToggleAll).toHaveBeenLastCalledWith(true);
    mount("paged", 60);
    await vi.waitFor(() => expect(position("nested-entry")).not.toBeNull());
    const panel = root.querySelector<HTMLElement>(".explorer")!;
    panel.setPointerCapture = vi.fn();
    vi.spyOn(position("two"), "getBoundingClientRect").mockReturnValue(new DOMRect(10, 100, 200, 30));
    drag("pointerdown", position("one"));
    drag("pointermove", position("two"), 128);
    expect(panel.setPointerCapture).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(position("two").parentElement?.dataset.placement).toBe("after"));
    expect(root.querySelector(".tree-drag-ghost")?.textContent).toBe("一");
    drag("pointerup", position("two"), 128);
    expect(onReorderFolder).toHaveBeenCalledExactlyOnceWith("one", "two", "after");
    expect(root.querySelector(".tree-drag-ghost")).toBeNull();
    drag("pointerdown", position("one"));
    drag("pointermove", position("child"), 125);
    drag("pointerup", position("child"), 125);
    expect(onReorderFolder).toHaveBeenCalledTimes(1);

    drag("pointerdown", position("entry"));
    drag("pointermove", position("child"), 125);
    await vi.waitFor(() => expect(position("child").parentElement?.dataset.placement).toBe("inside"));
    drag("pointerup", position("child"), 125);
    expect(onMoveEntry).toHaveBeenCalledExactlyOnceWith("entry", "child");

    vi.spyOn(position("another-entry"), "getBoundingClientRect").mockReturnValue(new DOMRect(10, 170, 200, 30));
    drag("pointerdown", position("nested-entry"), 120);
    drag("pointermove", position("another-entry"), 172);
    await vi.waitFor(() => expect(position("another-entry").parentElement?.dataset.placement).toBe("before"));
    expect(root.querySelector(".tree-drag-ghost")?.textContent).toBe("稿件");
    drag("pointerup", position("another-entry"), 172);
    expect(onReorderEntry).toHaveBeenCalledExactlyOnceWith("nested-entry", "another-entry", "before");

    const menu = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const open = (selector = ".explorer-scroll") => flushSync(() => {
      const trigger = root.querySelector<HTMLElement>(selector)!;
      trigger.focus();
      trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    });
    open("#entry-row-pin-a");
    expect(menu()[0]?.textContent).toBe("取消置顶");
    flushSync(() => menu().find(item => item.textContent === "取消置顶")!.click());
    expect(onRowAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "pin-a" }), "unpin");
    open("#entry-row-nested-entry");
    expect(menu()[0]?.textContent).toBe("置顶");
    expect(position("nested-entry").dataset.menuTarget).toBe("true");
    flushSync(() => menu().find(item => item.textContent === "在新标签打开")!.click());
    expect(onOpen).toHaveBeenLastCalledWith("nested-entry", "new-tab");
    mount("paged", 60, 0, ["one"], "new-tab");
    open("#entry-row-nested-entry");
    flushSync(() => menu().find(item => item.textContent === "在当前标签打开")!.click());
    expect(onOpen).toHaveBeenLastCalledWith("nested-entry", "current");
    open("#entry-row-nested-entry");
    flushSync(() => menu().find(item => item.textContent === "重命名")!.click());
    await vi.waitFor(() => expect(root.querySelector(".tree-entry .entry-inline-name")).not.toBeNull());
    const title = root.querySelector<HTMLInputElement>(".entry-inline-name")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "新稿名");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.blur();
    });
    expect(onRenameEntry).toHaveBeenCalledExactlyOnceWith("nested-entry", "新稿名");
    await vi.waitFor(() => expect(title.isConnected).toBe(false));
    open("#entry-row-nested-entry");
    flushSync(() => menu().find(item => item.textContent === "重命名")!.click());
    await vi.waitFor(() => expect(root.querySelector(".entry-inline-name")).not.toBeNull());
    const rename = root.querySelector<HTMLInputElement>(".entry-inline-name")!;
    flushSync(() => rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(document.activeElement).toBe(position("nested-entry")));
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(document.querySelector(".entry-hover-card")).toBeNull();
    expect(onRenameEntry).toHaveBeenCalledTimes(1);
    open("#folder-row-one");
    expect(position("one").dataset.menuTarget).toBe("true");
    expect(menu().map(item => item.textContent)).toEqual(["新建笔记", "导入公众号文章", "导入 Markdown", "新建子目录", "编辑名称和图标", "上移", "下移", "删除目录"]);
    expect(menu().slice(-3).every(item => Boolean(item.querySelector("svg")))).toBe(true);
    flushSync(() => menu()[1].click());
    expect(onImportWechat).toHaveBeenLastCalledWith("one");
    expect(position("one").dataset.menuTarget).toBeUndefined();
    open("#folder-row-child");
    flushSync(() => menu().find(item => item.textContent === "导入 Markdown")!.click());
    expect(onImportMarkdown).toHaveBeenLastCalledWith("child");
    open();
    expect(menu().map(item => item.textContent)).toEqual(["新建笔记", "导入公众号文章", "导入 Markdown", "新建目录"]);
    flushSync(() => menu().find(item => item.textContent === "导入 Markdown")!.click());
    expect(onImportMarkdown).toHaveBeenLastCalledWith(null);
    open();
    flushSync(() => menu().find(item => item.textContent === "新建目录")!.click());
    await vi.waitFor(() => expect(root.querySelector('input[aria-label="目录名称"]')).not.toBeNull());
    const name = root.querySelector<HTMLInputElement>('input[aria-label="目录名称"]')!;
    expect(name).not.toBeNull();
    expect(name.value).toBe("未命名 2");
    expect(name.closest("li")).toBe(root.querySelector("#tree-directory-list")?.lastElementChild);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(name.disabled).toBe(false);
    expect(document.activeElement).toBe(name);
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "项目资料");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => root.querySelector<HTMLButtonElement>('[aria-label="选择目录图标"]')!.click());
    const icon = document.querySelector<HTMLButtonElement>('[aria-label="项目"][aria-pressed]')!;
    expect(document.querySelectorAll(".folder-icon-choice")).toHaveLength(32);
    flushSync(() => icon.click());
    expect(icon.getAttribute("aria-pressed")).toBe("true");
    expect(onSaveFolder).not.toHaveBeenCalled();
    flushSync(() => root.querySelector<HTMLButtonElement>("#folder-row-one")!.focus());
    expect(onSaveFolder).toHaveBeenCalledExactlyOnceWith(null, null, "项目资料", "rocket");
    await vi.waitFor(() => expect(name.isConnected).toBe(false));
    await vi.waitFor(() => expect(document.querySelector(".folder-icon-picker")).toBeNull());
    // Radix restores focus on a timer when the picker is unmounted.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));

    open("#folder-row-one");
    flushSync(() => menu().find(item => item.textContent === "新建子目录")!.click());
    await vi.waitFor(() => expect(root.querySelector('input[aria-label="目录名称"]')).not.toBeNull());
    const childName = root.querySelector<HTMLInputElement>('input[aria-label="目录名称"]')!;
    expect(childName.closest("li")).toBe(root.querySelector("#folder-one")?.lastElementChild);
    expect(childName.value).toBe("未命名");
    const iconTrigger = root.querySelector<HTMLButtonElement>('[aria-label="选择目录图标"]')!;
    flushSync(() => iconTrigger.focus());
    flushSync(() => iconTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(childName.isConnected).toBe(false);
    expect(onSaveFolder).toHaveBeenCalledTimes(1);

    mount("paged", 1);
    await vi.waitFor(() => expect(position("another-entry")).toBeNull());
    const loadMore = root.querySelector("#folder-one .load-more")!;
    await vi.waitFor(() => expect(observed.has(loadMore)).toBe(true));
    const first = position("nested-entry");
    observed.get(loadMore)!();
    await vi.waitFor(() => expect(position("another-entry")).not.toBeNull());
    expect(position("nested-entry")).toBe(first);
    expect(entries).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "one", offset: 1, limit: 1 }));
    mount("paged", 1, 1);
    await vi.waitFor(() => expect(entries).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "one", offset: 0, limit: 2 })));
    mount("all", 1, 1);
    await vi.waitFor(() => expect(entries).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "one", offset: 0, limit: 2_147_483_647 })));
    expect(root.querySelector("#folder-one .load-more")).toBeNull();

    const sorter = root.querySelector<HTMLButtonElement>('[aria-label="排序"]')!;
    flushSync(() => sorter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const sorted = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find(item => item.textContent === "编辑时间（从新到旧）")!;
    flushSync(() => sorted.click());
    await vi.waitFor(() => {
      expect(entries).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "one", sort: "updated" }));
      expect(position("another-entry")).not.toBeNull();
    });
    drag("pointerdown", position("nested-entry"), 120);
    drag("pointermove", position("another-entry"), 172);
    await vi.waitFor(() => expect(root.querySelector(".tree-drag-ghost")).not.toBeNull());
    expect(position("another-entry").parentElement?.dataset.placement).toBeUndefined();
    drag("pointerup", position("another-entry"), 172);
    expect(onReorderEntry).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".folder-tree")?.firstElementChild?.classList.contains("tree-pinned")).toBe(true);
    vi.spyOn(position("pin-b"), "getBoundingClientRect").mockReturnValue(new DOMRect(10, 70, 200, 30));
    drag("pointerdown", position("pin-a"), 30);
    drag("pointermove", position("pin-b"), 95);
    drag("pointerup", position("pin-b"), 95);
    expect(onReorderEntry).toHaveBeenLastCalledWith("pin-a", "pin-b", "after");
    drag("pointerdown", position("pin-a"), 30);
    drag("pointermove", position("child"), 125);
    drag("pointerup", position("child"), 125);
    drag("pointerdown", position("entry"), 180);
    drag("pointermove", position("pin-b"), 90);
    drag("pointerup", position("pin-b"), 90);
    expect(onMoveEntry).toHaveBeenCalledTimes(1);
    expect(onReorderEntry).toHaveBeenCalledTimes(2);

    drag("pointerdown", position("entry"));
    drag("pointermove", position("child"), 125);
    await vi.waitFor(() => expect(position("child").parentElement?.dataset.placement).toBe("inside"));
    drag("pointerup", position("child"), 125);
    expect(onMoveEntry).toHaveBeenCalledTimes(2);
    expect(onMoveEntry).toHaveBeenLastCalledWith("entry", "child");

    const rootTree = root.querySelector<HTMLElement>(".folder-tree")!;
    drag("pointerdown", position("nested-entry"), 120);
    drag("pointermove", rootTree, 230);
    await vi.waitFor(() => expect(root.querySelector(".explorer-scroll")?.getAttribute("data-root-drop")).toBe("true"));
    drag("pointerup", rootTree, 230);
    expect(onMoveEntry).toHaveBeenLastCalledWith("nested-entry", null);

    mount("all", 1, 1, ["one"], "current", "pin-a");
    flushSync(() => pinToggle.click());
    expect(pinToggle.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => root.querySelector<HTMLButtonElement>('[aria-label="自动定位当前文件"]')!.click());
    await vi.waitFor(() => expect(onLocateCurrent).toHaveBeenCalledTimes(1));
    expect(pinToggle.getAttribute("aria-expanded")).toBe("true");
    const scrollToPinned = vi.fn();
    position("pin-a").scrollIntoView = scrollToPinned;
    const expansion = Object.assign(new Event("transitionend", { bubbles: true }), { propertyName: "grid-template-rows" });
    flushSync(() => root.querySelector(".tree-pinned .tree-section-content")!.dispatchEvent(expansion));
    expect(scrollToPinned).toHaveBeenCalledWith({ block: "nearest" });
    pinned = ["pin-b"];
    mount("all", 1, 2, ["one"], "current", "pin-a");
    await vi.waitFor(() => {
      expect(onLocateCurrent).toHaveBeenCalledTimes(2);
      expect(position("pin-a").hasAttribute("data-tree-pinned")).toBe(false);
    });
  } finally {
    flushSync(() => render.unmount());
    root.remove();
    entries.mockRestore();
    if (previousSort === null) localStorage.removeItem("directory-sort");
    else localStorage.setItem("directory-sort", previousSort);
    if (previousLocate === null) localStorage.removeItem("directory-auto-locate");
    else localStorage.setItem("directory-auto-locate", previousLocate);
    if (previousPinCollapse === null) localStorage.removeItem("directory-pins-collapsed");
    else localStorage.setItem("directory-pins-collapsed", previousPinCollapse);
    if (previousDirectoryCollapse === null) localStorage.removeItem("directory-collapsed");
    else localStorage.setItem("directory-collapsed", previousDirectoryCollapse);
    if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
    vi.unstubAllGlobals();
  }
});
