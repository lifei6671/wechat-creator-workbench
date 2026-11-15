import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Button, Theme } from "@radix-ui/themes";
import { FilePenLine, FolderOpen, Images, ListFilter, Newspaper, Search, Settings, Sparkles, Trash2 } from "lucide-react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import type { Category, CategoryIcon, CategoryPlacement, Entry, EntryFields, EntryFilter, EntryPage, EntryRow, Library } from "../../../../packages/shared-types";
import type { ClipboardAction, ClipboardIO, MarkdownEditorHandle } from "../../../../packages/editor-react";
import { desktop, errorMessage, windowsTitleBar, type AiOperation, type BackupSnapshot } from "../desktop";
import { SaveQueue, isConflict } from "../editor/save-queue";
import { attachClipboard } from "../editor/clipboard";
import { commandKey, untitled } from "../labels";
import { persist, Tool, useStoredInitial } from "../ui";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { WorkspaceToast, type Notice } from "./WorkspaceToast";
import { Confirm, EntryLocationDialog, PropertiesDialog, RevisionsDialog } from "./Dialogs";
import { DocumentEditor, DocumentStatus, DocumentTabs, DocumentToolbar, MarkdownPreview, type DocumentActions, type TabAction, type ViewMode } from "./Document";
import type { EditorDisplay } from "./EditorContextMenu";
import { CreateMenu, Explorer, type CategoryAction, type EntryRowAction, type Section } from "./Explorer";
import { McpSettings, ModelSettings, SettingsDialog, WorkspaceSettings, type Appearance, type SettingsPage, type ViewShortcut } from "./Settings";
import { AiPanel, useAiAssistant } from "./AiPanel";
import { BackupPanel, backupDate, backupProgress, type PreparedBackup } from "./Backup";
import { AssetPanel, ImageStorageSettings, imageMarkdown } from "./Assets";
import { WindowControls, WindowDragRegion } from "./WindowTitle";
import { ImageViewer, PublishImagesDialog, WechatImportDialog, renderForPublication } from "./Publishing";
import type { RenderedWechat } from "../../../../packages/wechat-renderer";

type Modal =
  | { type: "palette" | "properties" | "reload" }
  | { type: "revisions"; id: string }
  | { type: "move"; entry: Entry }
  | { type: "deleteCategory"; target: Category }
  | { type: "settings"; page: SettingsPage }
  | { type: "wechatImport"; categoryId: string | null }
  | { type: "imageViewer"; src: string; alt: string }
  | { type: "publishImages"; images: RenderedWechat["images"] };

const destinations = [
  ["folders", FolderOpen, "内容目录"], ["search", Search, "全文搜索"], ["assets", Images, "素材库"],
  ["imports", Newspaper, "已导入的公众号文章"],
] as const;

function SidebarToggleIcon({ expanded = false }: { expanded?: boolean }) {
  return <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden="true">
    <rect x="1.5" y="2.25" width="15" height="13.5" rx="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    {expanded ? <rect x="3.25" y="4" width="3.5" height="10" rx="0.9" fill="currentColor" />
      : <path d="M5 4.5v9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />}
  </svg>;
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function DesktopShell() {
  const [section, setSection] = useState<Section>("folders");
  const [library, setLibrary] = useState<Library | null>(null);
  const [page, setPage] = useState<EntryPage | null>(null);
  const [categoryId, setCategoryId] = useState<string>();
  const [expandedFolders, setExpandedFolders] = useState(() => useStoredInitial<string[]>("expanded-folders", []));
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [listError, setListError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sessions, setSessions] = useState<SaveQueue[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [readingIds, setReadingIds] = useState<string[]>([]);
  const [singlePaneIds, setSinglePaneIds] = useState<string[]>([]);
  const [modal, setModal] = useState<Modal | null>(null);
  const [appearance, setAppearance] = useState(() => useStoredInitial<Appearance>("appearance", "system"));
  const [preferredView, setPreferredView] = useState<ViewMode>(() => useStoredInitial<string>("view", "") === "preview" ? "preview" : "edit");
  const [shortcut, setShortcut] = useState(() => useStoredInitial<ViewShortcut>("view-shortcut", "none"));
  const [downloadPastedImages, setDownloadPastedImages] = useState(() => useStoredInitial("download-pasted-images", false));
  const [folderLoading, setFolderLoading] = useState(() => useStoredInitial<"all" | "paged">("folder-loading", "paged"));
  const [folderPageSize, setFolderPageSize] = useState(() => useStoredInitial("folder-page-size", 60));
  const [editorDisplay, setEditorDisplay] = useState(() => useStoredInitial<EditorDisplay>("editor-display", {
    limitWidth: true, lineNumbers: false, showTitle: true,
  }));
  const [preferredExplorer, setExplorer] = useState(() => useStoredInitial<boolean | null>("explorer", null));
  const [focusMode, setFocusMode] = useState(false);
  const [locked, setLocked] = useState<string[]>([]);
  const [globalLock, setGlobalLock] = useState(false);
  const [exitMessage, setExitMessage] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [backupListRevision, setBackupListRevision] = useState(0);
  const [preparedBackup, setPreparedBackup] = useState<PreparedBackup | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [backupWorking, setBackupWorking] = useState<string | null>(null);
  const [restoreRestarting, setRestoreRestarting] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const assistant = useAiAssistant();
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const compact = useMedia("(width < 820px)");
  const explorer = preferredExplorer ?? !compact;
  const reading = activeId !== null && readingIds.includes(activeId);
  const viewMode = reading || focusMode || (activeId !== null && singlePaneIds.includes(activeId)) ? "edit" : preferredView;
  const queues = useRef(new Map<string, SaveQueue>());
  const active = useRef<string | null>(null);
  const handles = useRef(new Map<string, MarkdownEditorHandle>());
  const pendingEditorFocus = useRef<string | null>(null);
  const selecting = useRef(0);
  const writing = useRef(new Set<Promise<unknown>>());
  const locking = useRef(new Set<string>());
  const exit = useRef<{ cancelled: boolean; restoring: boolean } | null>(null);
  const [initialSidebarWidth] = useState(() => useStoredInitial("sidebar-width", 248));
  const [initialSidebarSize] = useState(() => explorer ? `${initialSidebarWidth}px` : "0px");
  const sidebarWidth = useRef(initialSidebarWidth);
  const sidebarGroup = useRef<HTMLDivElement>(null);
  const sidebarPanel = usePanelRef();
  const searchInput = useRef<HTMLInputElement>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const refresh = () => setRefreshCount(count => count + 1);
  const showError = useCallback((error: unknown) => setNotice({ type: "error", text: errorMessage(error) }), []);
  function updateEditorDisplay(option: keyof EditorDisplay, checked: boolean) {
    setEditorDisplay(display => ({ ...display, [option]: checked }));
  }

  const searchText = section === "search" ? query : "";
  const filteredSection = section === "search" || section === "trash" || section === "imports";
  const filter: EntryFilter = {
    workspaceSearch: section === "search" ? { text: searchText, caseSensitive } : undefined,
    deleted: section === "trash", wechatImported: section === "imports", offset: 0,
  };
  const liveFilter = useEffectEvent(() => filter);
  const filterEpoch = useRef(0);
  useEffect(() => {
    const epoch = ++filterEpoch.current;
    if (!filteredSection || (section === "search" && !searchText.trim())) return;
    const timer = setTimeout(() => {
      void desktop.entries(liveFilter()).then(result => {
        if (filterEpoch.current === epoch) { setPage(result); setListError(""); }
      }, error => {
        if (filterEpoch.current === epoch) setListError(errorMessage(error));
      });
    }, searchText.length > 0 ? 160 : 0);
    return () => { ++filterEpoch.current; clearTimeout(timer); };
  }, [caseSensitive, section, searchText, filteredSection, refreshCount]);

  useEffect(() => { persist("expanded-folders", expandedFolders); }, [expandedFolders]);
  useEffect(() => { persist("editor-display", editorDisplay); }, [editorDisplay]);

  useEffect(() => {
    let current = true;
    void desktop.library().then(result => { if (current) setLibrary(result); }, error => {
      if (current) setNotice({ type: "error", text: errorMessage(error) });
    });
    return () => { current = false; };
  }, [refreshCount]);

  function more() {
    const offset = page?.nextOffset;
    if (offset == null) return;
    const epoch = filterEpoch.current;
    void desktop.entries({ ...filter, offset }).then(result => {
      if (epoch === filterEpoch.current) setPage(previous => previous?.nextOffset === offset
        ? { items: [...previous.items, ...result.items], nextOffset: result.nextOffset } : previous);
    }, error => { if (epoch === filterEpoch.current) setListError(errorMessage(error)); });
  }

  function run(operation: () => Promise<unknown>) {
    if (exit.current) return;
    const job = operation();
    writing.current.add(job);
    void job.catch(error => setNotice({ type: "error", text: errorMessage(error) }))
      .finally(() => writing.current.delete(job));
  }

  function importImages(files: File[], origin: "attachment" | "library" = "attachment"): Promise<string> {
    if (exit.current) return Promise.resolve("");
    const job = (async () => {
      const images: string[] = [];
      const errors: string[] = [];
      for (const file of files) {
        if (exit.current) break;
        try { images.push(imageMarkdown(await desktop.assetImport(file, origin), file.name)); }
        catch (error) { errors.push(`${file.name || "图片"}：${errorMessage(error)}`); }
      }
      if (errors.length) showError(errors.join("；"));
      else if (images.length) setNotice({ type: "info", text: `已导入 ${images.length} 张图片` });
      return images.length && !exit.current ? "\n" + images.join("\n") + "\n" : "";
    })();
    return trackAssetTask(job);
  }

  function trackAssetTask<T>(job: Promise<T>): Promise<T> {
    writing.current.add(job);
    return job.finally(() => writing.current.delete(job));
  }

  const editorClipboard: ClipboardIO = {
    write: (text, html) => html ? desktop.copyHtml(html, text) : desktop.copyText(text),
    localizeImage: downloadPastedImages ? url => trackAssetTask(desktop.localizeImage(url)) : undefined,
    importImage: async file => `asset://${await trackAssetTask(desktop.assetImport(file))}`,
    onError: showError,
    async read(plainText = false) {
      if (exit.current) return "";
      const result = await trackAssetTask(desktop.readClipboard(!plainText, !plainText));
      if (!result || exit.current) return "";
      if (result.kind === "text") return result.text;
      if (result.kind === "html") return { html: result.html, text: result.text };
      if (result.errors.length) showError(result.errors.join("；"));
      const images = result.images.map(image => imageMarkdown(image.id, image.name));
      return images.length ? "\n" + images.join("\n") + "\n" : "";
    },
  };

  function commitBreadcrumb() {
    const field = document.activeElement;
    if (field instanceof HTMLInputElement && field.classList.contains("path-title-input")) field.blur();
  }

  function select(id: string | null) {
    const previous = active.current;
    if (id === previous) return;
    commitBreadcrumb();
    if (pendingEditorFocus.current !== id) pendingEditorFocus.current = null;
    if (previous) void queues.current.get(previous)?.flush();
    active.current = id;
    setActiveId(id);
  }

  function install(entry: Entry) {
    const queue = new SaveQueue(entry, desktop.save, refresh);
    queues.current.set(entry.id, queue);
    setSessions([...queues.current.values()]);
    return queue;
  }

  async function open(id: string) {
    const ticket = ++selecting.current;
    const existing = queues.current.get(id);
    if (existing) {
      revealFolder(existing.snapshot().fields.categoryId);
    } else {
      const entry = await desktop.entry(id);
      if (ticket !== selecting.current) return;
      if (!queues.current.has(id)) install(entry);
      revealFolder(entry.categoryId);
    }
    select(id);
  }

  function switchTab(id: string) {
    ++selecting.current;
    select(id);
  }

  function reorderTab(id: string, anchor: string, placement: CategoryPlacement) {
    const tab = queues.current.get(id);
    if (!tab) return;
    const order = [...queues.current.values()].filter(queue => queue.entry.id !== id);
    const index = order.findIndex(queue => queue.entry.id === anchor);
    if (index < 0) return;
    order.splice(index + Number(placement === "after"), 0, tab);
    queues.current = new Map(order.map(queue => [queue.entry.id, queue]));
    setSessions(order);
  }

  function remove(id: string) {
    const next = [...queues.current.keys()];
    const index = next.indexOf(id);
    queues.current.get(id)!.dispose();
    queues.current.delete(id);
    setReadingIds(current => current.filter(item => item !== id));
    setSinglePaneIds(current => current.filter(item => item !== id));
    setSessions([...queues.current.values()]);
    if (id === active.current) select(next[index + 1] ?? next[index - 1] ?? null);
  }

  async function withEntryLock(id: string, operation: () => Promise<void>) {
    if (locking.current.has(id)) return;
    if (id === active.current) commitBreadcrumb();
    locking.current.add(id);
    setLocked([...locking.current]);
    try { await operation(); }
    finally {
      locking.current.delete(id);
      setLocked([...locking.current]);
    }
  }

  function closeTab(id: string) {
    run(() => closeTabs([id]));
  }

  async function closeTabs(ids: string[]) {
    for (const id of ids) {
      const queue = queues.current.get(id);
      if (!queue) continue;
      let saved = true;
      await withEntryLock(id, async () => {
        saved = await queue.flush();
        if (saved) remove(id);
        else select(id);
      });
      if (!saved) break;
    }
  }

  function navigate(next: Section) {
    if (section === "folders" && next !== section) {
      const field = document.activeElement;
      if (field instanceof HTMLElement && field.closest(".folder-inline, .folder-icon-picker, .entry-inline")) field.blur();
    }
    setSection(next);
    setFocusMode(false);
    if (!explorer) { setExplorer(true); persist("explorer", true); }
    if (next !== section) {
      setPage(null); setListError("");
    }
  }

  function view(mode: ViewMode) {
    if (reading) setReadingIds(current => current.filter(id => id !== activeId));
    if (focusMode && mode !== "edit") setFocusMode(false);
    if (activeId !== null) setSinglePaneIds(current => current.filter(id => id !== activeId));
    setPreferredView(mode);
    persist("view", mode);
  }

  function toggleReading() {
    if (!activeId) return;
    commitBreadcrumb();
    setReadingIds(current => reading ? current.filter(id => id !== activeId) : [...current, activeId]);
  }

  function openSearch() {
    navigate("search");
    requestAnimationFrame(() => searchInput.current?.focus());
  }

  function toggleExplorer(event: MouseEvent<HTMLButtonElement>) {
    setExplorer(!explorer);
    persist("explorer", !explorer);
    if (event.detail === 0) requestAnimationFrame(() => {
      document.getElementById(explorer ? "show-sidebar" : "hide-sidebar")?.focus({ preventScroll: true });
    });
  }

  function revealFolder(id: string | null, parentId = library?.categories.find(category => category.id === id)?.parentId) {
    setCategoryId(id ?? undefined);
    if (id) setExpandedFolders(current => {
      if (current.includes(id) && (!parentId || current.includes(parentId))) return current;
      return [...new Set([...current, ...(parentId ? [parentId] : []), id])];
    });
  }

  function toggleFolder(id: string) {
    setCategoryId(id);
    setExpandedFolders(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  function activateCreated(entry: Entry) {
    ++selecting.current;
    navigate("folders");
    revealFolder(entry.categoryId);
    pendingEditorFocus.current = entry.id;
    install(entry);
    if (preferredView !== "edit") setSinglePaneIds(current => [...current, entry.id]);
    select(entry.id);
    refresh();
  }

  function registerEditor(id: string, handle: MarkdownEditorHandle | null) {
    if (!handle) { handles.current.delete(id); return; }
    handles.current.set(id, handle);
    if (pendingEditorFocus.current === id && active.current === id && !exit.current) {
      pendingEditorFocus.current = null;
      handle.focus();
    }
  }

  const currentFolder = section === "folders" ? categoryId ?? null : null;

  function create(parent: string | null = currentFolder) {
    run(async () => {
      const fields = parent ? {
        title: "", contentMd: "", status: "draft" as const, categoryId: parent, tags: [],
        summary: "", source: null, publishedAt: null, publishedUrl: "",
      } : undefined;
      activateCreated(await desktop.create("article", fields));
    });
  }

  function importMarkdown(parent: string | null = currentFolder) {
    run(async () => {
      const entry = await trackAssetTask(desktop.importMarkdown(parent));
      if (entry && !exit.current) activateCreated(entry);
    });
  }

  async function saveConflictCopy(id: string) {
    const queue = queues.current.get(id);
    if (queue && isConflict(queue.snapshot().error)) {
      await withEntryLock(id, async () => {
        const fields = queue.snapshot().fields;
        const draft = await desktop.create("article", {
          ...fields, status: "draft", source: null, publishedAt: null, publishedUrl: "",
        });
        remove(id);
        activateCreated(draft);
        setNotice({ type: "info", text: "当前笔记已另存为副本" });
      });
    }
  }

  async function changeDeleted(id: string, deleted: boolean) {
    await withEntryLock(id, async () => {
      const queue = queues.current.get(id);
      if (queue && !await queue.flush()) { select(id); return; }
      const entry = await desktop.setDeleted(id, queue?.snapshot().version ?? (await desktop.entry(id)).version, deleted);
      if (queue) remove(id);
      if (!deleted && queue) {
        install(entry);
        select(id);
      }
      setNotice({ type: "info", text: deleted ? "已移入回收站" : "已恢复内容" });
      refresh();
    });
  }

  async function currentEntry(id: string): Promise<Entry> {
    const queue = queues.current.get(id);
    if (!queue) return desktop.entry(id);
    const { version, fields } = queue.snapshot();
    return { ...queue.entry, ...fields, version };
  }

  async function exportMarkdown(id: string) {
    const queue = queues.current.get(id);
    if (queue && !await queue.flush()) { select(id); return; }
    if (await desktop.exportMarkdown(id)) setNotice({ type: "info", text: "Markdown 已导出" });
  }

  function entryAction(row: EntryRow, action: EntryRowAction, trigger = document.getElementById(`entry-row-${row.id}`)) {
    run(async () => {
      switch (action) {
        case "delete": case "restore": return changeDeleted(row.id, action === "delete");
        case "export": return exportMarkdown(row.id);
        case "history": showModal({ type: "revisions", id: row.id }, trigger); return;
        case "move": showModal({ type: action, entry: await currentEntry(row.id) }, trigger); return;
        case "duplicate": {
          const entry = await currentEntry(row.id);
          activateCreated(await desktop.create("article", {
            ...entry, title: `${entry.title || untitled} 副本`, status: "draft",
            source: null, publishedAt: null, publishedUrl: "",
          }, entry.kind === "article" ? undefined : entry.id));
          return;
        }
        case "copyTitle": case "copyPath": {
          const entry = await currentEntry(row.id);
          const title = entry.title || untitled;
          if (action === "copyTitle") await desktop.copyText(title);
          else {
            const folder = library?.categories.find(category => category.id === entry.categoryId);
            const parent = library?.categories.find(category => category.id === folder?.parentId);
            await desktop.copyText(["目录", parent?.name, folder?.name, title].filter(Boolean).join(" / "));
          }
          setNotice({ type: "info", text: action === "copyTitle" ? "已复制标题" : "已复制工作区路径" });
        }
      }
    });
  }

  function tabAction(id: string, action: TabAction) {
    const queue = queues.current.get(id)!;
    const trigger = document.getElementById(`tab-${id}`);
    switch (action) {
      case "closeOthers":
        switchTab(id);
        run(() => closeTabs([...queues.current.keys()].filter(other => other !== id)));
        break;
      case "reading":
        switchTab(id);
        setReadingIds(current => current.includes(id) ? current.filter(other => other !== id) : [...current, id]);
        break;
      case "properties":
        switchTab(id);
        showModal({ type: "properties" }, trigger);
        break;
      case "search":
        switchTab(id);
        if (!focusMode && !readingIds.includes(id) && !singlePaneIds.includes(id) && preferredView === "preview") {
          setPreferredView("edit");
          persist("view", "edit");
        }
        requestAnimationFrame(() => handles.current.get(id)?.search());
        break;
      case "folder":
        switchTab(id);
        navigate("folders");
        revealFolder(queue.snapshot().fields.categoryId);
        break;
      default:
        entryAction(queue.entry, action, trigger);
    }
  }

  async function changeEntryLocation(entry: Entry, change: Partial<Pick<EntryFields, "title" | "categoryId">>) {
    const queue = queues.current.get(entry.id);
    if (queue) {
      queue.edit(change);
      if (!await queue.flush({ retry: true })) throw queue.snapshot().error;
    } else {
      await desktop.save(entry.id, entry.version, { ...entry, ...change }, "auto");
      refresh();
    }
    if (change.categoryId !== undefined && entry.id === active.current) revealFolder(change.categoryId);
  }

  function renameEntry(id: string, title: string) {
    return trackAssetTask(withEntryLock(id, async () => {
      await changeEntryLocation(await currentEntry(id), { title });
    }));
  }

  function showModal(value: Modal, trigger?: HTMLElement | null) {
    focusOrigin.current = trigger ?? (document.activeElement as HTMLElement | null);
    setModal(value);
  }

  function closeModal() {
    setModal(null);
    setConfirmRestore(false);
    const origin = focusOrigin.current;
    requestAnimationFrame(() => {
      if (origin?.isConnected && origin !== document.body && document.activeElement === document.body) origin.focus();
    });
  }

  function categoryAction(target: Category, action: CategoryAction) {
    if (action === "up" || action === "down") run(async () => { await desktop.moveCategory(target.id, action === "up"); refresh(); });
    else showModal({ type: "deleteCategory", target }, document.getElementById(`folder-row-${target.id}`));
  }

  async function saveFolder(id: string | null, parent: string | null, name: string, icon: CategoryIcon) {
    const folder = await trackAssetTask(desktop.saveCategory(id, parent, name, icon));
    if (!id) revealFolder(folder.id, folder.parentId);
    refresh();
  }

  function reorderFolder(id: string, anchor: string, placement: CategoryPlacement) {
    run(async () => { await desktop.reorderCategory(id, anchor, placement); refresh(); });
  }

  function reorderEntry(id: string, anchor: string, placement: CategoryPlacement) {
    run(async () => { await desktop.reorderEntry(id, anchor, placement); refresh(); });
  }

  function moveTreeEntry(id: string, folder: string | null) {
    run(() => withEntryLock(id, async () => {
      await changeEntryLocation(await currentEntry(id), { categoryId: folder });
      if (active.current !== id) revealFolder(folder);
    }));
  }

  async function deleteCategory(target: Category) {
    const removed = new Set([target.id, ...(library?.categories ?? []).filter(cat => cat.parentId === target.id).map(cat => cat.id)]);
    const affected = [...queues.current.values()].filter(queue => {
      const category = queue.snapshot().fields.categoryId;
      return category && removed.has(category);
    });
    commitBreadcrumb();
    setGlobalLock(true);
    try {
      const results = await Promise.all(affected.map(queue => queue.flush()));
      if (!results.every(Boolean)) throw new Error("关联内容未能保存，请先处理保存错误");
      const moved = await desktop.deleteCategory(target.id);
      for (const change of moved) {
        queues.current.get(change.id)?.categoryMoved(change.categoryId, change.version);
      }
      if (categoryId && removed.has(categoryId)) setCategoryId(undefined);
      setExpandedFolders(current => current.filter(id => !removed.has(id)));
      refresh();
    } finally { setGlobalLock(false); }
  }

  const copy = desktop.copyText;

  const selected = activeId ? queues.current.get(activeId) : undefined;
  const showWechatImport = (parent: string | null = currentFolder) => showModal({ type: "wechatImport", categoryId: parent });
  const openSettings = (page: SettingsPage = "appearance", trigger?: HTMLElement) => {
    showModal({ type: "settings", page }, trigger ?? (modal?.type === "palette" ? focusOrigin.current : undefined));
  };
  const showModel = () => openSettings("model");
  const openBackups = () => openSettings("backups");

  async function createBackup() {
    setBackupWorking("正在保存当前稿件…");
    setBackupFeedback(null);
    try {
      const result = await trackAssetTask((async () => {
        const saved = await Promise.all([...queues.current.values()].map(queue => queue.flush()));
        if (!saved.every(Boolean)) throw new Error("有稿件尚未保存，请处理后重新备份");
        return await desktop.createBackup();
      })());
      setBackupListRevision(value => value + 1);
      const text = result.warning ?? "数据库已备份";
      setBackupFeedback({ error: Boolean(result.warning), text });
      setNotice({ type: result.warning ? "error" : "info", text });
    } catch (error) {
      setBackupFeedback({ error: true, text: errorMessage(error) });
      showError(error);
    }
    finally { setBackupWorking(null); }
  }

  async function prepareBackup(workspace: string, snapshot: BackupSnapshot, workspaceLabel: string) {
    setBackupWorking(backupProgress.download);
    setBackupFeedback(null);
    try {
      const ticket = await trackAssetTask(desktop.prepareRestore(workspace, snapshot.name));
      if (exit.current) await desktop.discardRestore(ticket);
      else setPreparedBackup({ ticket, snapshot, workspaceLabel });
    } catch (error) {
      setBackupFeedback({ error: true, text: errorMessage(error) });
      showError(error);
    }
    finally { setBackupWorking(null); }
  }

  function toggleAi() {
    if (focusMode) { setFocusMode(false); setAiOpen(true); }
    else setAiOpen(value => !value);
  }

  function publication(output: "clipboard" | "html") {
    if (!selected || publishing || exit.current) return;
    const { fields, revision } = selected.snapshot();
    const input = { output, revision, markdown: fields.contentMd, themeId: fields.themeId };
    setPublishing(true);
    run(async () => {
      try {
        const { result, hosting } = await renderForPublication(input);
        try {
          if (exit.current) return;
          if (output === "html") {
            const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>公众号文章</title><body>${result.html}</body></html>`;
            if (await desktop.exportWechatHtml(html, result.images.map(image => image.url))) {
              setNotice({ type: "info", text: "排版 HTML 已导出" });
            }
          } else {
            await desktop.copyHtml(result.html, result.text);
            if (!hosting && result.images.length) showModal({ type: "publishImages", images: result.images });
            else setNotice({ type: "info", text: "公众号格式已复制到剪贴板" });
          }
        } finally { result.dispose(); }
      } finally { setPublishing(false); }
    });
  }
  const actions: DocumentActions = {
    mode: viewMode, setMode: view, focusMode, onFocusMode: () => setFocusMode(value => !value),
    reading, onReading: toggleReading,
    onPalette: () => showModal({ type: "palette" }),
    onAi: toggleAi, aiOpen: aiOpen && !focusMode && !reading,
    onSave: () => {
      if (!reading && selected?.entry.deletedAt === null) {
        commitBreadcrumb();
        run(() => selected.flush({ manual: true, retry: true }));
      }
    },
    onSearch: () => {
      if (!selected) return;
      if (viewMode === "preview") view("edit");
      requestAnimationFrame(() => handles.current.get(selected.entry.id)?.search());
    },
    onProperties: () => showModal({ type: "properties" }, document.getElementById("document-action-trigger")),
    onSavedVersions: () => { if (selected) showModal({ type: "revisions", id: selected.entry.id }, document.getElementById("document-action-trigger")); },
    onExport: () => { if (selected) run(() => exportMarkdown(selected.entry.id)); },
    onExportAssets: () => {
      if (selected) run(async () => {
        if (await selected.flush() && await desktop.assetExport(selected.entry.id)) {
          setNotice({ type: "info", text: "已导出 Markdown 压缩包" });
        }
      });
    },
    onExportWechat: () => publication("html"),
    onCopyWechat: () => publication("clipboard"),
    publishing,
    onDelete: () => { if (selected) run(() => changeDeleted(selected.entry.id, selected.entry.deletedAt === null)); },
    onDraft: () => { if (selected) run(() => saveConflictCopy(selected.entry.id)); },
    onCopy: () => {
      if (selected) run(async () => { await copy(selected.snapshot().fields.contentMd); setNotice({ type: "info", text: "已复制当前正文" }); });
    },
    onReload: () => showModal({ type: "reload" }),
    onRetry: () => { if (selected) run(() => selected.flush({ retry: true })); },
  };
  function cycleView() { view(viewMode === "edit" ? "preview" : "edit"); }

  const commands: PaletteCommand[] = [
    { name: "新建笔记", keys: commandKey + "N", run: () => create() },
    { name: "导入公众号文章", run: () => showWechatImport() },
    { name: "导入 Markdown", run: () => importMarkdown() },
    { name: "设置", run: () => openSettings() },
    { name: "MCP 服务设置", run: () => openSettings("mcp") },
    { name: "AI 模型设置", run: showModel },
    { name: "数据库备份", run: openBackups },
    ...(!reading ? [{ name: "切换 AI 助手", run: toggleAi }] : []),
    { name: "全文搜索", keys: commandKey + "Shift+F", run: openSearch },
    { name: "打开内容目录", run: () => navigate("folders") },
    { name: "打开回收站", run: () => navigate("trash") },
  ];
  if (selected) commands.push(
    { name: reading ? "退出阅读模式" : "进入阅读模式", run: toggleReading },
    { name: "切换编辑视图", run: cycleView },
    { name: "查找与替换", keys: commandKey + "F", run: actions.onSearch },
    { name: "导出 Markdown", run: actions.onExport },
    { name: "复制公众号格式", run: actions.onCopyWechat },
    { name: "导出排版 HTML", run: actions.onExportWechat },
  );

  const shortcutEvent = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || exit.current || modal || event.defaultPrevented) return;
    const mod = commandKey === "⌘" ? event.metaKey : event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (event.altKey) {
      if (shortcut !== "alt-v" || event.code !== "KeyV" || event.shiftKey || !selected) return;
      event.preventDefault(); cycleView(); return;
    }
    const command = key === "k" && !event.shiftKey ? actions.onPalette
      : key === "n" && !event.shiftKey ? () => create()
        : key === "s" && !event.shiftKey ? actions.onSave
          : key === "f" && event.shiftKey ? openSearch
            : key === "f" && selected ? actions.onSearch
              : key === "m" && event.shiftKey && shortcut === "shift-m" && selected ? cycleView : undefined;
    if (command) { event.preventDefault(); if (!event.repeat) command(); }
  });

  async function finishWorkspace(ticket?: string) {
    if (exit.current) return;
    const attempt = { cancelled: false, restoring: ticket !== undefined };
    exit.current = attempt;
    let committed = false;
    (document.activeElement as HTMLElement | null)?.blur();
    setExitMessage(attempt.restoring ? "正在保存并停止工作区…" : "正在保存并退出…");
    try {
      await desktop.beginExit();
      await Promise.allSettled(writing.current);
      const all = [...queues.current.values()];
      const results = await Promise.all(all.map(queue => queue.flush()));
      if (!attempt.cancelled && results.every(Boolean)) {
        if (ticket !== undefined) {
          setRestoreRestarting(true);
          setExitMessage("正在等待任务结束并重启…");
          await desktop.commitRestore(ticket);
          committed = true;
        } else {
          committed = true;
          setCleaning(true);
          setExitMessage("正在清理未引用的素材…");
          await desktop.finishExit();
        }
        return;
      }
      if (!attempt.cancelled) {
        select(all[results.indexOf(false)].entry.id);
        setNotice({ type: "error", text: attempt.restoring ? "有内容未保存，恢复已停止" : "有内容未保存，工作台仍保持打开" });
      }
      await desktop.cancelExit();
    } catch (error) {
      if (!committed) await desktop.cancelExit();
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      if (!committed) {
        if (ticket !== undefined) closeModal();
        exit.current = null;
        setExitMessage("");
        setRestoreRestarting(false);
      }
    }
  }
  const closingEvent = useEffectEvent(() => finishWorkspace());
  const clipboardEvent = useEffectEvent((action: ClipboardAction, target: EventTarget | null, plainText?: boolean) => {
    const activeId = active.current;
    if (!activeId || exit.current) return false;
    return handles.current.get(activeId)?.clipboard(action, editorClipboard, target, plainText) ?? false;
  });

  useEffect(() => {
    function shortcut(event: KeyboardEvent) { shortcutEvent(event); }
    function blur() { if (active.current) void queues.current.get(active.current)?.flush(); }
    function preventFileNavigation(event: DragEvent) {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    }
    const detachClipboard = attachClipboard((action, target, plainText) => clipboardEvent(action, target, plainText), showError);
    const listener = desktop.onExit(() => { void closingEvent(); });
    const workspaceChanged = desktop.onWorkspaceChanged(() => setRefreshCount(count => count + 1));
    const assetsChanged = desktop.onAssetsChanged(() => {
      for (const handle of handles.current.values()) handle.retryMissingImages();
    });
    const backupChanged = desktop.onBackupProgress(stage => setBackupWorking(current => current ? backupProgress[stage] : current));
    void desktop.restoreNotice().then(value => {
      if (value) setNotice({ type: value.failed ? "error" : "info", text: value.message });
    }, showError);
    for (const subscription of [listener, workspaceChanged, assetsChanged, backupChanged]) void subscription.catch(showError);
    window.addEventListener("keydown", shortcut);
    window.addEventListener("blur", blur);
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      detachClipboard();
      window.removeEventListener("keydown", shortcut);
      window.removeEventListener("blur", blur);
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
      void listener.then(unlisten => unlisten(), () => {});
      void workspaceChanged.then(unlisten => unlisten(), () => {});
      void assetsChanged.then(unlisten => unlisten(), () => {});
      void backupChanged.then(unlisten => unlisten(), () => {});
    };
  }, []);

  const queue = selected;
  const showExplorer = explorer && !focusMode;
  useLayoutEffect(() => {
    const panel = sidebarPanel.current!;
    const group = sidebarGroup.current!;
    if (showExplorer !== panel.isCollapsed()) return;
    group.dataset.sidebarMoving = "true";
    if (showExplorer) panel.resize(`${sidebarWidth.current}px`);
    else panel.collapse();
    const clear = () => { delete group.dataset.sidebarMoving; };
    const timer = window.setTimeout(clear, 220);
    return () => { window.clearTimeout(timer); clear(); };
  }, [showExplorer, sidebarPanel]);
  const origin = assistant.task ? queues.current.get(assistant.task.request.entryId) : undefined;
  const canGenerate = Boolean(!reading && queue?.entry.deletedAt === null && !globalLock && !locked.includes(queue.entry.id));
  function generateAi(operation: AiOperation) {
    if (exit.current || !queue || reading) return;
    const editor = handles.current.get(queue.entry.id);
    if (editor) assistant.start(queue, editor, operation);
  }
  function closeAi() {
    setAiOpen(false);
    document.getElementById(queue ? "document-action-trigger" : "ai-panel-trigger")?.focus();
  }
  const aiPanel = aiOpen && !focusMode && !reading && <AiPanel assistant={assistant} origin={origin}
    canGenerate={canGenerate} onGenerate={generateAi} onClose={closeAi} onSettings={showModel} onApply={candidate => {
      if (exit.current || globalLock || !origin || locked.includes(origin.entry.id) || readingIds.includes(origin.entry.id)) return;
      const editor = handles.current.get(origin.entry.id);
      if (editor) assistant.apply(candidate, origin, editor);
    }} />;
  return <Theme appearance={appearance === "system" ? systemDark ? "dark" : "light" : appearance} accentColor="indigo"
    grayColor="slate" radius="small" scaling="95%" panelBackground="solid" className="theme-root">
    <div className="workspace-shell" inert={Boolean(exitMessage)}>
      <Group id="workspace-panels" className="workspace-panels" orientation="horizontal" elementRef={sidebarGroup}
        onLayoutChanged={() => { if (showExplorer) persist("sidebar-width", sidebarWidth.current); }}>
          <Panel id="explorer" defaultSize={initialSidebarSize} minSize="192px" collapsible collapsedSize="0px" panelRef={sidebarPanel}
            style={{ overflow: "hidden" }} groupResizeBehavior="preserve-pixel-size"
            onResize={size => {
              if (!showExplorer) return;
              if (size.inPixels > 0) sidebarWidth.current = size.inPixels;
              else if (!sidebarGroup.current?.dataset.sidebarMoving) { setExplorer(false); persist("explorer", false); }
            }}>
            <div className="sidebar-workspace" inert={!showExplorer}>
              <nav className="sidebar-chrome chrome-band" aria-label="工作区导航">
                <div className="button-strip">
                  {destinations.map(([target, Icon, label]) => <Tool key={target} label={label} className="chrome-icon"
                    aria-current={target === section ? "page" : undefined} onClick={() => target === "search" ? openSearch() : navigate(target)}>
                    <Icon size={17} strokeWidth={1.65} />
                  </Tool>)}
                </div>
                <WindowDragRegion onError={showError} />
                <Tool id="hide-sidebar" label="隐藏左侧栏" className="chrome-icon" onClick={toggleExplorer}><SidebarToggleIcon expanded /></Tool>
              </nav>
              {section === "assets" ? <AssetPanel onImport={files => importImages(files, "library")} onConfigure={() => openSettings("images")}
              canInsert={!reading && queue?.entry.deletedAt === null && !globalLock && !locked.includes(queue.entry.id)}
              canCover={!reading && Boolean(queue && queue.entry.deletedAt === null && !globalLock && !locked.includes(queue.entry.id))}
              onInsert={(id, name) => {
                if (viewMode === "preview") view("edit");
                if (active.current) handles.current.get(active.current)?.insert("\n" + imageMarkdown(id, name) + "\n");
              }}
              onCover={id => {
                if (queue) {
                  queue.edit({ coverAssetId: id });
                  void queue.flush().then(saved => {
                    if (saved) setNotice({ type: "info", text: "已设置封面" });
                  });
                }
              }} />
              : <Explorer section={section} library={library} page={page} active={activeId} readOnlyIds={[...readingIds, ...locked]}
                treeLocked={globalLock} categoryId={categoryId}
                expanded={expandedFolders} revision={refreshCount} loading={folderLoading} pageSize={folderPageSize} caseSensitive={caseSensitive}
                query={query} searchInputRef={searchInput} listError={listError} onRetry={refresh}
                onQuery={value => { setQuery(value); setPage(null); }}
                onCaseSensitive={value => { setCaseSensitive(value); setPage(null); }}
                onFolder={toggleFolder} onRoot={() => revealFolder(null)}
                onImportWechat={showWechatImport} onImportMarkdown={importMarkdown}
                onCreate={create} onRevealFolder={revealFolder} onSaveFolder={saveFolder} onFolderError={showError}
                onReorderFolder={reorderFolder} onReorderEntry={reorderEntry} onRenameEntry={renameEntry} onMoveEntry={moveTreeEntry}
                onCategoryAction={categoryAction}
                onOpen={id => run(() => open(id))} onRowAction={entryAction} onMore={more} />}
              <footer className="sidebar-footer">
                <span>微信创作工作台</span>
                <div className="button-strip">
                  <Tool label="回收站" className="chrome-icon" aria-current={section === "trash" ? "page" : undefined}
                    onClick={() => navigate(section === "trash" ? "folders" : "trash")}><Trash2 size={15} strokeWidth={1.65} /></Tool>
                  <Tool label="设置" className="chrome-icon" aria-haspopup="dialog" aria-expanded={modal?.type === "settings"}
                    onClick={event => openSettings("appearance", event.currentTarget)}><Settings size={16} strokeWidth={1.65} /></Tool>
                </div>
              </footer>
            </div>
          </Panel>
          <Separator className="divider sidebar-divider" hidden={!showExplorer} disabled={!showExplorer}
            disableDoubleClick aria-label="调整资源导航宽度" />
        <Panel id="writing" minSize="360px">
          <main className="main-workspace" aria-label="写作工作区">
            <header className="workbench-chrome chrome-band">
              {!showExplorer && <Tool id="show-sidebar" className="chrome-icon restore-sidebar" label={focusMode ? "退出专注写作" : "显示左侧栏"}
                onClick={focusMode ? actions.onFocusMode : toggleExplorer}><SidebarToggleIcon /></Tool>}
              {sessions.length > 0 && <DocumentTabs sessions={sessions} activeId={activeId} readingIds={readingIds} lockedIds={locked}
                onSwitch={switchTab} onClose={closeTab} onAction={tabAction} onReorder={reorderTab} onRename={renameEntry} onError={showError} />}
              {!focusMode && <CreateMenu onCreate={() => create()} onImportWechat={() => showWechatImport()}
                onImportMarkdown={() => importMarkdown()} disabled={globalLock} />}
              <WindowDragRegion onError={showError} />
              {windowsTitleBar && <WindowControls onError={showError} />}
            </header>
            {queue ? <>
              <DocumentToolbar queue={queue} categories={library?.categories ?? []} actions={actions}
                locked={globalLock || locked.includes(queue.entry.id)}
                display={editorDisplay} onDisplayChange={updateEditorDisplay}
                onReveal={id => { navigate("folders"); revealFolder(id); }} />
              <div className="document-body" data-view={viewMode} id="document-body" role="tabpanel" aria-labelledby={`tab-${activeId}`}>
                <div className="editor-stack" hidden={viewMode === "preview"}>
                  {sessions.map(session => <DocumentEditor key={session.sessionId}
                    queue={session} active={activeId === session.entry.id} reading={readingIds.includes(session.entry.id)}
                    display={editorDisplay} onDisplayChange={updateEditorDisplay}
                    locked={Boolean(exitMessage) || globalLock || locked.includes(session.entry.id)} clipboard={editorClipboard}
                    handle={handle => registerEditor(session.entry.id, handle)}
                    onImages={importImages} onError={showError}
                    onImageZoom={(image, trigger) => showModal({ type: "imageViewer", ...image }, trigger)} />)}
                </div>
                {viewMode === "preview" && <div className="preview-stack"><ActivePreview key={activeId} queue={queue} /></div>}
                {aiPanel}
              </div>
              <DocumentStatus key={activeId} queue={queue} actions={actions} />
            </> : <>
              <div className="section-bar empty-toolbar">
                <Tool className="chrome-icon" label={`命令面板（${commandKey}K）`} onClick={actions.onPalette}><ListFilter size={16} /></Tool>
                {!focusMode && <Tool className="chrome-icon" id="ai-panel-trigger" label="AI 助手" aria-expanded={actions.aiOpen} onClick={toggleAi}><Sparkles size={16} /></Tool>}
              </div>
              <div className="document-body"><div className="workbench-empty">
                <FilePenLine size={25} strokeWidth={1.4} />
                <h2>还没有打开的内容</h2>
                <div className="button-strip workbench-empty-actions">
                  <Button size="2" variant="soft" onClick={() => create()}>新建笔记</Button>
                  <Button size="2" variant="soft" color="gray" onClick={() => showWechatImport()}>导入公众号文章</Button>
                </div>
              </div>{aiPanel}</div>
            </>}
            {backupWorking && modal?.type !== "settings" && <div className="notice" role="status">{backupWorking}</div>}
            {notice && !backupWorking && <WorkspaceToast notice={notice}
              onDismiss={target => setNotice(current => current === target ? null : current)} />}
          </main>
        </Panel>
      </Group>
    </div>
    {exitMessage && <div className="exit-banner" role="status"><span>{exitMessage}</span>{!restoreRestarting && <Button size="1" variant="soft" onClick={() => {
      if (cleaning) {
        void desktop.cancelCleanup().catch(showError);
        setExitMessage("正在结束清理…");
        return;
      }
      exit.current!.cancelled = true;
      setExitMessage(exit.current!.restoring ? "正在取消恢复…" : "正在取消退出…");
    }}>{cleaning ? "停止清理并退出" : exit.current?.restoring ? "取消恢复" : "继续编辑"}</Button>}</div>}
    {!exitMessage && <>
      {modal?.type === "settings" && <>
        <SettingsDialog initialPage={modal.page} status={backupWorking ?? undefined} onClose={closeModal} renderPage={page => {
          if (page === "model") return <ModelSettings />;
          if (page === "mcp") return <McpSettings />;
          if (page === "images") return <ImageStorageSettings track={trackAssetTask} />;
          if (page === "backups") return <BackupPanel busy={backupWorking !== null} progress={backupWorking ?? ""} feedback={backupFeedback}
            listRevision={backupListRevision} prepared={preparedBackup} onCreate={createBackup} onRestore={prepareBackup}
            onConfirmRestore={() => setConfirmRestore(true)} onDiscardRestore={() => { if (preparedBackup) run(async () => {
              await desktop.discardRestore(preparedBackup.ticket);
              setPreparedBackup(null);
            }); }} />;
          return <WorkspaceSettings page={page} appearance={appearance} shortcut={shortcut} preferredView={preferredView} explorer={explorer}
            downloadPastedImages={downloadPastedImages} folderLoading={folderLoading} folderPageSize={folderPageSize}
            onAppearance={value => { setAppearance(value); persist("appearance", value); }}
            onView={value => { setPreferredView(value); persist("view", value); }}
            onDownloadPastedImages={value => { setDownloadPastedImages(value); persist("download-pasted-images", value); }}
            onFolderLoading={value => { setFolderLoading(value); persist("folder-loading", value); }}
            onFolderPageSize={value => { setFolderPageSize(value); persist("folder-page-size", value); }}
            onExplorer={value => { setExplorer(value); persist("explorer", value); }}
            onShortcut={value => { setShortcut(value); persist("view-shortcut", value); }} />;
        }} />
        {confirmRestore && preparedBackup && <Confirm title="恢复数据库"
          text={`将使用 ${preparedBackup.workspaceLabel} 在 ${backupDate(preparedBackup.snapshot.createdAt)} 的备份替换当前数据库并重启。恢复后仅保留快照中的内容。图片需从本地文件或图床读取。`}
          action="恢复并重启" onClose={() => { setConfirmRestore(false); requestAnimationFrame(() => document.getElementById("backup-restore-trigger")?.focus()); }}
          onConfirm={() => finishWorkspace(preparedBackup.ticket)} />}
      </>}
      {modal?.type === "wechatImport" && <WechatImportDialog categoryId={modal.categoryId}
        track={trackAssetTask} onClose={closeModal} onImported={refresh} onOpen={id => {
        if (exit.current) return;
        closeModal();
        if (section !== "imports") navigate("folders");
        run(() => open(id));
      }} />}
      {modal?.type === "publishImages" && <PublishImagesDialog images={modal.images} onClose={closeModal} />}
      {modal?.type === "imageViewer" && <ImageViewer src={modal.src} alt={modal.alt} onClose={closeModal} />}
      {modal?.type === "palette" && <CommandPalette actions={commands} onClose={closeModal} onOpen={id => run(() => open(id))} />}
      {modal?.type === "properties" && queue && <PropertiesDialog queue={queue} categories={library?.categories ?? []}
        tagSuggestions={library?.tagSuggestions ?? []} locked={reading || globalLock || locked.includes(queue.entry.id)} onClose={closeModal} onOpen={id => run(() => open(id))} />}
      {modal?.type === "revisions" && <RevisionsDialog id={modal.id} onClose={closeModal} onCopy={copy} />}
      {modal?.type === "move" && <EntryLocationDialog entry={modal.entry}
        categories={library?.categories ?? []} onClose={closeModal}
        onSave={categoryId => trackAssetTask(changeEntryLocation(modal.entry, { categoryId }))} />}
      {modal?.type === "deleteCategory" && <Confirm title="删除文件夹" text={modal.target.parentId ? "其中的内容将移到上一级文件夹。" : "子文件夹也将删除，其中的内容将移到根目录。"}
        action="删除文件夹" onClose={closeModal} onConfirm={() => deleteCategory(modal.target)} />}
      {modal?.type === "reload" && queue && <Confirm title="重新加载内容" text="重新加载将丢弃这篇内容尚未保存的修改。"
        action="重新加载" onClose={closeModal} onConfirm={async () => {
          const entry = await desktop.entry(queue.entry.id);
          queue.dispose();
          install(entry);
        }} />}
    </>}
  </Theme>;
}

function ActivePreview({ queue }: { queue: SaveQueue }) {
  const { fields, revision } = useSyncExternalStore(queue.subscribe, queue.snapshot);
  return <MarkdownPreview markdown={fields.contentMd} themeId={fields.themeId} revision={revision} />;
}
