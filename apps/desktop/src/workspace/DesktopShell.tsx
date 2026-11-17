import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Button, Theme } from "@radix-ui/themes";
import { FilePenLine, FileText, Folder, Image, List, Search } from "lucide-react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import type { Category, CategoryIcon, CategoryPlacement, Entry, EntryFields, EntryFilter, EntryPage, EntryRow, Library } from "../../../../packages/shared-types";
import type { ClipboardAction, ClipboardIO, ImageContext, MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { ChatSelection } from "../ai/context";
import { desktop, errorMessage, windowsTitleBar, type ActiveImageStorage, type AiAgent, type AiAgentModel, type AiSelection, type AiSettings, type BackupSnapshot, type McpStatus, type UploadProgress } from "../desktop";
import { installInputContextMenu } from "../input-context-menu";
import { SaveQueue, isConflict } from "../editor/save-queue";
import { attachClipboard } from "../editor/clipboard";
import { commandKey, untitled } from "../labels";
import { persist, SidebarToggleIcon, Tool, useStoredInitial } from "../ui";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { WorkspaceToast, type Notice } from "./WorkspaceToast";
import { readDocumentTabs, saveDocumentTabs, workspacePreferences, type DocumentOpenMode } from "./preferences";
import { Confirm, PropertiesDialog, RevisionsDialog } from "./Dialogs";
import { DocumentEditor, DocumentSaveError, DocumentTabs, DocumentToolbar, MarkdownPreview, type DocumentActions, type TabAction, type ViewMode } from "./Document";
import { StatusBar } from "./StatusBar";
import type { EditorDisplay } from "./EditorContextMenu";
import { CreateMenu, Explorer, type CategoryAction, type EntryRowAction, type ExplorerHandle, type RowActions, type Section, type TimelineSelection } from "./Explorer";
import { McpSettings, SettingsDialog, WorkspaceSettings, type Appearance, type SettingsPage, type ViewShortcut } from "./Settings";
import { aiAvailability, ModelSettings } from "./AiSettings";
import { AiTargetPicker } from "./AiTargetPicker";
import { BackupPanel, backupDate, backupProgress, type PreparedBackup } from "./Backup";
import { MigrationPanel } from "./Migration";
import { AssetPanel, canHostImage, ImageStorageSettings, imageMarkdown } from "./Assets";
import { Timeline } from "./Timeline";
import { WindowControls, WindowDragRegion } from "./WindowTitle";
import { ImageViewer, PublishImagesDialog, WechatImportDialog, renderForPublication } from "./Publishing";
import type { RenderedWechat } from "../../../../packages/wechat-renderer";

const AiPanel = lazy(() => import("./AiPanel").then(module => ({ default: module.AiPanel })));
const minimumDirectoryWidth = 192;
const minimumTimelineWidth = 144;
const dividerWidth = 1;
const dividerHitTarget = { fine: 16, coarse: 24 };

type DocumentOptions = { view?: ViewMode; convertLinks?: boolean };

type Modal =
  | { type: "palette" | "reload" }
  | { type: "properties" | "revisions"; id: string }
  | { type: "deleteCategory"; target: Category }
  | { type: "settings"; page: SettingsPage }
  | { type: "wechatImport"; categoryId: string | null }
  | { type: "imageViewer"; src: string; alt: string }
  | { type: "publishImages"; images: RenderedWechat["images"] };

const destinations = [
  ["folders", Folder, "内容目录"], ["timeline", List, "文章时间流"], ["search", Search, "全文搜索"], ["assets", Image, "素材库"],
  ["imports", FileText, "已导入的公众号文章"],
] as const;

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
  const [timelineSelection, setTimelineSelection] = useState<TimelineSelection | null>(null);
  const [includeTimelineChildren, setIncludeTimelineChildren] = useState(true);
  const timelineFolder = timelineSelection?.kind === "folder"
    ? library?.categories.find(category => category.id === timelineSelection.id) ?? null : null;
  const timelineTag = timelineSelection?.kind === "tag"
    ? library?.tags.find(tag => tag.id === timelineSelection.id) ?? null : null;
  const timelineMode = section === "timeline";
  const timelineRoot = timelineSelection?.kind === "root";
  const [expandedFolders, setExpandedFolders] = useState(() => useStoredInitial<string[]>("expanded-folders", []));
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [listError, setListError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [imageTarget, setImageTarget] = useState<ActiveImageStorage | null>(null);
  const [imageUpload, setImageUpload] = useState<(UploadProgress & { sessionId: number; src?: string }) | null>(null);
  const [assetsRevision, setAssetsRevision] = useState(0);
  const [mcpStatus, setMcpStatus] = useState<McpStatus>();
  const [mcpLoadError, setMcpLoadError] = useState("");
  const [tabSessions, setSessions] = useState<SaveQueue[] | null>(null);
  const [tabSelection, setTabSelection] = useState<{ id: string; restored: boolean } | null>(null);
  const sessions = tabSessions ?? [];
  const activeId = tabSelection?.id ?? null;
  const [readingIds, setReadingIds] = useState<string[]>([]);
  const [documentOptions, setDocumentOptions] = useState(() => new Map<string, DocumentOptions>());
  const [modal, setModal] = useState<Modal | null>(null);
  const [appearance, setAppearance] = useState(() => useStoredInitial<Appearance>("appearance", "system"));
  const [preferredView, setPreferredView] = useState<ViewMode>(() => useStoredInitial<string>("view", "") === "preview" ? "preview" : "edit");
  const [shortcut, setShortcut] = useState(() => useStoredInitial<ViewShortcut>("view-shortcut", "none"));
  const [downloadPastedImages, setDownloadPastedImages] = useState(() => useStoredInitial("download-pasted-images", false));
  const [defaultConvertLinks, setDefaultConvertLinks] = useState(() => useStoredInitial("links-to-footnotes", false));
  const [documentOpenMode, setDocumentOpenMode] = useState<DocumentOpenMode>(() =>
    useStoredInitial<string>("document-open-mode", "") === "new-tab" ? "new-tab" : "current");
  const [folderLoading, setFolderLoading] = useState(() => useStoredInitial<"all" | "paged">("folder-loading", "paged"));
  const [folderPageSize, setFolderPageSize] = useState(() => useStoredInitial("folder-page-size", 60));
  const [editorDisplay, setEditorDisplay] = useState(() => useStoredInitial<Omit<EditorDisplay, "convertLinks">>("editor-display", {
    limitWidth: true, lineNumbers: false, showTitle: true,
  }));
  const [preferredExplorer, setPreferredExplorer] = useState(() => useStoredInitial<boolean | null>("explorer", null));
  const [explorerOverride, setExplorerOverride] = useState<boolean | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [locked, setLocked] = useState<string[]>([]);
  const [globalLock, setGlobalLock] = useState(false);
  const [exitMessage, setExitMessage] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [backupListRevision, setBackupListRevision] = useState(0);
  const [preparedBackup, setPreparedBackup] = useState<PreparedBackup | { ticket: string; migration: true } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [backupWorking, setBackupWorking] = useState<string | null>(null);
  const [migrationWorking, setMigrationWorking] = useState<"export" | "import" | null>(null);
  const [migrationFeedback, setMigrationFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [restoreRestarting, setRestoreRestarting] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiVisited, setAiVisited] = useState(false);
  useEffect(() => { if (aiOpen) setAiVisited(true); }, [aiOpen]);
  const [aiSettings, setAiSettings] = useState<AiSettings>();
  const [aiSettingsError, setAiSettingsError] = useState("");
  const [savingAiSettings, setSavingAiSettings] = useState(false);
  const aiSettingsWrite = useRef(false);
  const [agentCatalog, setAgentCatalog] = useState<Partial<Record<AiAgent, AiAgentModel[]>>>();
  const showAiConfiguration = aiOpen || modal?.type === "settings";
  useEffect(() => {
    if (!showAiConfiguration || savingAiSettings) return;
    let current = true;
    void desktop.aiSettings().then(settings => {
      if (current) { setAiSettings(settings); setAiSettingsError(""); }
    }, error => {
      if (current) setAiSettingsError(errorMessage(error));
    });
    return () => { current = false; };
  }, [showAiConfiguration, savingAiSettings]);
  const [aiChatSelection, setAiChatSelection] = useState<{ sessionId: number; selection: ChatSelection }>();
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const compact = useMedia("(width < 820px)");
  const defaultExplorer = preferredExplorer ?? !compact;
  const explorer = explorerOverride ?? defaultExplorer;
  const reading = activeId !== null && readingIds.includes(activeId);
  const showAiPanel = aiOpen && !focusMode && !reading;
  const loadAgentModels = showAiPanel && aiSettings?.preferences.enabled === true && aiSettings.agents.some(agent => agent.installed);
  useEffect(() => {
    if (!loadAgentModels) return;
    let current = true;
    void desktop.aiAgentModels().then(models => {
      if (current) setAgentCatalog(Object.fromEntries(models));
    }, () => { if (current) setAgentCatalog({}); });
    return () => { current = false; };
  }, [loadAgentModels]);
  const viewMode = reading || focusMode ? "edit" : (activeId ? documentOptions.get(activeId)?.view : undefined) ?? preferredView;
  const queues = useRef(new Map<string, SaveQueue>());
  const active = useRef<string | null>(null);
  const handles = useRef(new Map<string, MarkdownEditorHandle>());
  const [, refreshEditorHandles] = useState(0);
  const pendingEditorFocus = useRef<string | null>(null);
  const selecting = useRef(0);
  const writing = useRef(new Set<Promise<unknown>>());
  const locking = useRef(new Set<string>());
  const exit = useRef<{ cancelled: boolean; restoring: boolean } | null>(null);
  const [initialSidebarWidth] = useState(() => useStoredInitial("sidebar-width", 248));
  const [initialTimelineWidth] = useState(() => useStoredInitial("timeline-width", 320));
  const [initialSidebarSize] = useState(() => explorer ? `${initialSidebarWidth}px` : "0px");
  const sidebarWidth = useRef(initialSidebarWidth);
  const timelineWidth = useRef(initialTimelineWidth);
  const sidebarGroup = useRef<HTMLDivElement>(null);
  const timelineGroup = useRef<HTMLDivElement>(null);
  const previousTimelineMode = useRef(false);
  const timelineWidthsReady = useRef(false);
  const explorerTree = useRef<ExplorerHandle>(null);
  const sidebarPanel = usePanelRef();
  const directoryPanel = usePanelRef();
  const aiSidebarPanel = usePanelRef();
  const [initialAiWidth] = useState(() => useStoredInitial("ai-sidebar-width", 350));
  const aiSidebarWidth = useRef(initialAiWidth);
  const searchInput = useRef<HTMLInputElement>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const refresh = () => setRefreshCount(count => count + 1);
  const showError = useCallback((error: unknown) => setNotice({ type: "error", text: errorMessage(error) }), []);
  useEffect(() => installInputContextMenu(showError), [showError]);
  function updateDocumentOptions(id: string, patch: DocumentOptions) {
    setDocumentOptions(current => new Map(current).set(id, { ...current.get(id), ...patch }));
  }

  function updateEditorDisplay(id: string, option: keyof EditorDisplay, checked: boolean) {
    if (option === "convertLinks") updateDocumentOptions(id, { convertLinks: checked });
    else setEditorDisplay(display => ({ ...display, [option]: checked }));
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
    void desktop.library(timelineMode).then(result => { if (current) setLibrary(result); }, error => {
      if (current) setNotice({ type: "error", text: errorMessage(error) });
    });
    return () => { current = false; };
  }, [refreshCount, timelineMode]);

  const restoreTabs = useEffectEvent(async (workspaceId: string, isCurrent: () => boolean) => {
    const saved = readDocumentTabs(workspaceId);
    if (!saved?.ids.length || selecting.current || exit.current) return;
    try {
      const entries = await Promise.all(saved.ids.map(id => desktop.entry(id).catch((failure: unknown) => {
        if (typeof failure === "object" && failure !== null && "code" in failure && failure.code === "NOT_FOUND") return null;
        throw failure;
      })));
      if (!isCurrent() || selecting.current || exit.current) return;
      for (const entry of entries) {
        if (entry && entry.deletedAt === null) queues.current.set(entry.id, new SaveQueue(entry, desktop.save, refresh));
      }
      setSessions([...queues.current.values()]);
      const first = queues.current.keys().next().value;
      select(saved.activeId && queues.current.has(saved.activeId) ? saved.activeId : first ?? null, true);
    } catch (error) {
      if (isCurrent() && !selecting.current && !exit.current) showError(error);
    }
  });
  const workspaceId = library?.workspaceId;
  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    void restoreTabs(workspaceId, () => current);
    return () => { current = false; };
  }, [workspaceId]);
  useEffect(() => {
    if (workspaceId && tabSessions) {
      saveDocumentTabs(workspaceId, { ids: tabSessions.map(tab => tab.entry.id), activeId });
    }
  }, [workspaceId, tabSessions, activeId]);

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

  const localizeImage = (url: string) => trackAssetTask(desktop.localizeImage(url));
  const editorClipboard: ClipboardIO = {
    write: (text, html) => html ? desktop.copyHtml(html, text) : desktop.copyText(text),
    localizeImage: downloadPastedImages || imageTarget?.autoUpload ? localizeImage : undefined,
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

  function select(id: string | null, restored = false) {
    const previous = active.current;
    if (id === previous) return;
    commitBreadcrumb();
    if (pendingEditorFocus.current !== id) pendingEditorFocus.current = null;
    if (previous) void queues.current.get(previous)?.flush();
    active.current = id;
    setTabSelection(id === null ? null : { id, restored });
    if (id === null) setFocusMode(false);
  }

  function install(entry: Entry, replacing?: SaveQueue) {
    const queue = new SaveQueue(entry, desktop.save, refresh);
    if (replacing) {
      const order = [...queues.current.values()].map(tab => tab === replacing ? queue : tab);
      forgetTab(replacing.entry.id);
      queues.current = new Map(order.map(tab => [tab.entry.id, tab]));
    } else queues.current.set(entry.id, queue);
    setSessions([...queues.current.values()]);
    return queue;
  }

  async function open(id: string, mode = documentOpenMode) {
    const ticket = ++selecting.current;
    const replacing = mode === "current" && active.current ? queues.current.get(active.current) : undefined;
    if (!queues.current.has(id)) {
      const entry = await desktop.entry(id);
      if (ticket !== selecting.current || exit.current) return;
      while (replacing && queues.current.get(replacing.entry.id) === replacing && !queues.current.has(id)) {
        const currentId = replacing.entry.id;
        if (locking.current.has(currentId)) throw new Error("当前标签页正在处理，请稍后再试");
        if (active.current === currentId) commitBreadcrumb();
        const saved = await replacing.flush();
        if (ticket !== selecting.current || exit.current) return;
        if (queues.current.get(currentId) !== replacing || queues.current.has(id)) break;
        if (!saved) { select(currentId); return; }
        if (active.current === currentId) commitBreadcrumb();
        if (locking.current.has(currentId)) throw new Error("当前标签页正在处理，请稍后再试");
        const { revision, savedRevision } = replacing.snapshot();
        if (revision !== savedRevision) continue;
        install(entry, replacing);
      }
      if (!queues.current.has(id)) install(entry);
    }
    revealFolder(queues.current.get(id)!.snapshot().fields.categoryId);
    if (active.current === id) document.getElementById(`tab-${id}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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

  function forgetTab(id: string) {
    queues.current.get(id)!.dispose();
    queues.current.delete(id);
    setReadingIds(current => current.filter(item => item !== id));
    setDocumentOptions(current => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  function remove(id: string) {
    const next = [...queues.current.keys()];
    const index = next.indexOf(id);
    forgetTab(id);
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
    if ((section === "folders" || section === "timeline") && next !== section) {
      const field = document.activeElement;
      if (field instanceof HTMLElement && field.closest(".folder-inline, .folder-icon-picker, .entry-inline")) field.blur();
    }
    setSection(next);
    setFocusMode(false);
    if (!explorer) setExplorerOverride(true);
    if (next !== section) {
      setPage(null); setListError("");
    }
  }

  function view(mode: ViewMode) {
    if (reading) setReadingIds(current => current.filter(id => id !== activeId));
    if (focusMode && mode !== "edit") setFocusMode(false);
    if (activeId !== null) updateDocumentOptions(activeId, { view: mode });
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
    setExplorerOverride(!explorer);
    if (event.detail === 0) requestAnimationFrame(() => {
      document.getElementById(explorer ? "show-sidebar" : "hide-sidebar")?.focus({ preventScroll: true });
    });
  }

  function revealDirectory() {
    if (explorerTree.current) explorerTree.current.revealDirectory();
    else persist("directory-collapsed", false);
  }

  function revealFolder(id: string | null, parentId = library?.categories.find(category => category.id === id)?.parentId) {
    setCategoryId(id ?? undefined);
    if (id) setExpandedFolders(current => {
      if (current.includes(id) && (!parentId || current.includes(parentId))) return current;
      return [...new Set([...current, ...(parentId ? [parentId] : []), id])];
    });
  }

  function toggleFolderExpanded(id: string) {
    setExpandedFolders(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  function toggleFolder(id: string) {
    setCategoryId(id);
    toggleFolderExpanded(id);
  }

  function activateCreated(entry: Entry) {
    ++selecting.current;
    if (section !== "timeline") {
      navigate("folders");
      revealDirectory();
    }
    revealFolder(entry.categoryId);
    pendingEditorFocus.current = entry.id;
    install(entry);
    if (preferredView !== "edit") updateDocumentOptions(entry.id, { view: "edit" });
    select(entry.id);
    refresh();
  }

  function registerEditor(id: string, handle: MarkdownEditorHandle | null) {
    if (!handle) { handles.current.delete(id); return; }
    handles.current.set(id, handle);
    refreshEditorHandles(count => count + 1);
    if (pendingEditorFocus.current === id && active.current === id && !exit.current) {
      pendingEditorFocus.current = null;
      handle.focus();
    }
  }

  const currentFolder = section === "timeline" ? timelineFolder?.id ?? null : section === "folders" ? categoryId ?? null : null;

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
      const result = await trackAssetTask(desktop.importMarkdown(parent));
      if (!result || exit.current) return;
      activateCreated(result.entry);
      if (result.unavailableImages) showError(`已导入文档，${result.unavailableImages} 张图片未能加入上传队列。`);
    });
  }

  async function saveConflictCopy(id: string) {
    const queue = queues.current.get(id);
    if (queue && isConflict(queue.snapshot().error)) {
      await withEntryLock(id, async () => {
        const fields = queue.capture().fields;
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
    const { version, fields } = queue.capture();
    return { ...queue.entry, ...fields, version };
  }

  async function exportMarkdown(id: string) {
    const queue = queues.current.get(id);
    if (queue && !await queue.flush()) { select(id); return; }
    const path = await desktop.exportMarkdown(id);
    if (path) setNotice({ type: "info", text: "Markdown 已导出", path });
  }

  function entryAction(row: EntryRow, action: EntryRowAction, trigger = document.getElementById(`entry-row-${row.id}`)) {
    run(async () => {
      switch (action) {
        case "delete": case "restore": return changeDeleted(row.id, action === "delete");
        case "pin": case "unpin": await desktop.setEntryPinned(row.id, action === "pin"); refresh(); return;
        case "export": return exportMarkdown(row.id);
        case "history": showModal({ type: "revisions", id: row.id }, trigger); return;
        case "properties": showModal({ type: "properties", id: row.id }, trigger); return;
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
        showModal({ type: "properties", id }, trigger);
        break;
      case "search":
        switchTab(id);
        if (!focusMode && !readingIds.includes(id) && (documentOptions.get(id)?.view ?? preferredView) === "preview") {
          updateDocumentOptions(id, { view: "edit" });
        }
        requestAnimationFrame(() => handles.current.get(id)?.search());
        break;
      default:
        entryAction(queue.entry, action, trigger);
    }
  }

  async function saveEntryFields(entry: Entry, change: Partial<EntryFields>) {
    const queue = queues.current.get(entry.id);
    if (queue) {
      queue.edit(change);
      if (!await queue.flush({ retry: true })) throw queue.snapshot().error;
    } else {
      await desktop.save(entry.id, entry.version, { ...entry, ...change }, "auto");
      refresh();
    }
  }

  async function changeEntryLocation(entry: Entry, change: Partial<Pick<EntryFields, "title" | "categoryId">>) {
    await saveEntryFields(entry, change);
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
    run(() => trackAssetTask(withEntryLock(id, async () => {
      await changeEntryLocation(await currentEntry(id), { categoryId: folder });
      if (active.current !== id) revealFolder(folder);
    })));
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
      setTimelineSelection(selection => selection?.kind === "folder" && removed.has(selection.id) ? null : selection);
      setExpandedFolders(current => current.filter(id => !removed.has(id)));
      refresh();
    } finally { setGlobalLock(false); }
  }

  const copy = desktop.copyText;

  const selected = activeId ? queues.current.get(activeId) : undefined;
  const displayFor = (id: string | null): EditorDisplay => ({
    ...editorDisplay, convertLinks: (id ? documentOptions.get(id)?.convertLinks : undefined) ?? defaultConvertLinks,
  });
  const display = displayFor(activeId);
  const projectLinks = display.convertLinks ? (activeId ? handles.current.get(activeId)?.linkFootnoteMarkdown ?? null : null) : undefined;
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

  async function transferWorkspace(action: "export" | "import") {
    setMigrationWorking(action);
    setMigrationFeedback(null);
    try {
      await trackAssetTask((async () => {
        if (action === "export") {
          const saved = await Promise.all([...queues.current.values()].map(queue => queue.flush()));
          if (!saved.every(Boolean)) throw new Error("有稿件尚未保存，请处理后重新导出");
          const path = await desktop.exportWorkspace(workspacePreferences());
          if (path) setNotice({ type: "info", text: "工作区迁移包已导出" });
        } else {
          const ticket = await desktop.importWorkspace();
          if (!ticket) return;
          if (exit.current) await desktop.discardRestore(ticket);
          else setPreparedBackup({ ticket, migration: true });
        }
      })());
    } catch (error) { setMigrationFeedback({ error: true, text: errorMessage(error) }); }
    finally { setMigrationWorking(null); }
  }

  function discardPreparedRestore() {
    if (!preparedBackup) return;
    const { ticket } = preparedBackup;
    run(async () => {
      await desktop.discardRestore(ticket);
      setPreparedBackup(current => current?.ticket === ticket ? null : current);
    });
  }

  function toggleAi() {
    if (focusMode) { setFocusMode(false); setAiOpen(true); }
    else setAiOpen(value => !value);
  }

  function publication(output: "clipboard" | "html") {
    if (!selected || publishing || exit.current) return;
    if (projectLinks === null) { setNotice({ type: "info", text: "编辑器正在加载，请稍后重试" }); return; }
    setPublishing(true);
    run(async () => {
      try {
        const { fields, revision } = selected.capture();
        const input = { output, revision, markdown: projectLinks?.(fields.contentMd) ?? fields.contentMd, themeId: fields.themeId };
        const { result, hosting, exportImages } = await renderForPublication(input);
        try {
          if (exit.current) return;
          if (output === "html") {
            const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>公众号文章</title><body>${result.html}</body></html>`;
            if (await desktop.exportWechatHtml(html, exportImages)) {
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

  function hostDocumentImages(origin: SaveQueue, image?: ImageContext) {
    const target = imageTarget;
    if (!target || imageUpload || exit.current || locked.includes(origin.entry.id)) return;
    const editor = handles.current.get(origin.entry.id);
    if (!editor?.hostImages || (image && (!image.isCurrent() || !canHostImage(target, image.src)))) return;
    const sessionId = origin.sessionId;
    const update = (change: Partial<UploadProgress & { src?: string }>) => {
      setImageUpload(previous => previous?.sessionId === sessionId ? { ...previous, ...change } : previous);
    };
    const upload = async (src: string) => {
      update({ src });
      const url = await desktop.hostImage(src, target);
      setImageUpload(previous => previous?.sessionId === sessionId ? { ...previous, src: undefined, completed: previous.completed + 1 } : previous);
      return url;
    };
    setImageUpload({ sessionId, total: image ? 1 : 0, completed: 0 });
    run(async () => {
      try {
        const count = await trackAssetTask((async () => {
          if (!image) return editor.hostImages!(upload, src => canHostImage(target, src), total => update({ total }));
          image.setUploading(true);
          try { return image.replaceSource(await upload(image.src)) ? 1 : 0; }
          finally { image.setUploading(false); }
        })());
        if (count && !await origin.flush()) return;
        setNotice({ type: "info", text: count ? `已替换 ${count} 张图片为图床链接` : "没有需要替换的图片" });
      } finally { setImageUpload(null); }
    });
  }
  const actions: DocumentActions = {
    mode: viewMode, setMode: view, focusMode, onFocusMode: () => setFocusMode(value => !value),
    reading, onReading: toggleReading,
    onPalette: () => showModal({ type: "palette" }),
    onAi: toggleAi, aiOpen: showAiPanel,
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
    onProperties: () => {
      if (activeId) showModal({ type: "properties", id: activeId }, document.getElementById("document-action-trigger"));
    },
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
    onCopyMarkdown: () => {
      if (selected) run(async () => { await copy(selected.capture().fields.contentMd); setNotice({ type: "info", text: "Markdown 已复制" }); });
    },
    onHostImages: selected && imageTarget ? () => hostDocumentImages(selected) : undefined,
    hostingImages: Boolean(imageUpload),
    publishing,
    onDelete: () => { if (selected) run(() => changeDeleted(selected.entry.id, selected.entry.deletedAt === null)); },
    onDraft: () => { if (selected) run(() => saveConflictCopy(selected.entry.id)); },
    onCopy: () => {
      if (selected) run(async () => { await copy(selected.capture().fields.contentMd); setNotice({ type: "info", text: "已复制当前正文" }); });
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
    { name: "AI 代理设置", run: showModel },
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
      // An accepted proposal records its status after the associated draft save completes.
      await Promise.allSettled(writing.current);
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
    let mcpRequest = 0;
    function refreshMcp() {
      const request = ++mcpRequest;
      void desktop.mcpStatus().then(status => {
        if (request !== mcpRequest) return;
        setMcpStatus(status);
        setMcpLoadError("");
      }, error => {
        if (request === mcpRequest) setMcpLoadError(errorMessage(error));
      });
    }
    let live = true;
    const mcpChanged = desktop.onMcpStatusChanged(refreshMcp);
    void mcpChanged.then(() => { if (live) refreshMcp(); }, showError);
    let targetRequest = 0;
    function refreshImageTarget() {
      const request = ++targetRequest;
      void desktop.imageStorageTarget().then(target => { if (request === targetRequest) setImageTarget(target); }, showError);
    }
    refreshImageTarget();
    const assetsChanged = desktop.onAssetsChanged(() => {
      setAssetsRevision(revision => revision + 1);
      refreshImageTarget();
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
      live = false;
      mcpRequest++;
      targetRequest++;
      detachClipboard();
      window.removeEventListener("keydown", shortcut);
      window.removeEventListener("blur", blur);
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
      void listener.then(unlisten => unlisten(), () => {});
      void workspaceChanged.then(unlisten => unlisten(), () => {});
      void assetsChanged.then(unlisten => unlisten(), () => {});
      void backupChanged.then(unlisten => unlisten(), () => {});
      void mcpChanged.then(unlisten => unlisten(), () => {});
    };
  }, []);

  const queue = selected;
  const showExplorer = explorer && !focusMode;
  useLayoutEffect(() => {
    const panel = sidebarPanel.current!;
    const group = sidebarGroup.current!;
    const switchedView = previousTimelineMode.current !== timelineMode;
    previousTimelineMode.current = timelineMode;
    if (!showExplorer || switchedView) timelineWidthsReady.current = false;
    if (showExplorer !== panel.isCollapsed() && (!showExplorer || !switchedView)) return;
    const directoryWidth = sidebarWidth.current;
    const navigationWidth = directoryWidth + (timelineMode ? timelineWidth.current + dividerWidth : 0);
    group.dataset.sidebarMoving = "true";
    const frame = requestAnimationFrame(() => {
      if (showExplorer) panel.resize(navigationWidth);
      else panel.collapse();
    });
    const clear = () => { delete group.dataset.sidebarMoving; };
    const timer = window.setTimeout(() => {
      if (timelineMode && showExplorer) directoryPanel.current?.resize(directoryWidth);
      clear();
      timelineWidthsReady.current = timelineMode && showExplorer;
    }, 220);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      clear();
    };
  }, [showExplorer, timelineMode, sidebarPanel, directoryPanel]);
  useLayoutEffect(() => {
    const panel = aiSidebarPanel.current!;
    const group = sidebarGroup.current!;
    if (showAiPanel !== panel.isCollapsed()) return;
    group.dataset.aiSidebarMoving = "true";
    if (showAiPanel) panel.resize(`${aiSidebarWidth.current}px`);
    else panel.collapse();
    const clear = () => { delete group.dataset.aiSidebarMoving; };
    const timer = window.setTimeout(clear, 220);
    return () => { window.clearTimeout(timer); clear(); };
  }, [showAiPanel, aiSidebarPanel]);
  const aiDefaultTarget = aiSettings?.preferences.defaultTarget;
  const aiTarget = aiSettings ? aiAvailability(aiSettings) : { hint: aiSettingsError || "正在读取 AI 设置…" };
  const aiSelection = aiDefaultTarget && aiTarget.label
    ? { target: aiDefaultTarget, agentModel: aiSettings.preferences.defaultAgentModel } : undefined;
  const aiEditor = queue ? handles.current.get(queue.entry.id) : undefined;
  const canEditWithAi = Boolean(queue?.entry.deletedAt === null && aiEditor && !globalLock && !locked.includes(queue.entry.id));
  const canChat = Boolean(aiTarget.label && !savingAiSettings && !globalLock && (!queue || canEditWithAi));
  async function saveAiSettings(operation: () => Promise<AiSettings>) {
    if (aiSettingsWrite.current) throw new Error("正在保存 AI 设置");
    aiSettingsWrite.current = true;
    setSavingAiSettings(true);
    try {
      setAiSettings(await operation());
      setAiSettingsError("");
    } finally {
      aiSettingsWrite.current = false;
      setSavingAiSettings(false);
    }
  }
  function selectAiTarget({ target, agentModel }: AiSelection) {
    if (!aiSettings) return;
    void saveAiSettings(() => desktop.saveAiPreferences({
      ...aiSettings.preferences, defaultTarget: target, defaultAgentModel: agentModel,
    })).catch(showError);
  }
  function addSelectionToChat(session: SaveQueue, selection: ChatSelection) {
    if (exit.current || active.current !== session.entry.id || locking.current.has(session.entry.id)) return;
    setFocusMode(false);
    setAiOpen(true);
    setAiChatSelection({ sessionId: session.sessionId, selection });
  }
  function closeAi() {
    setAiOpen(false);
    document.getElementById("ai-panel-trigger")?.focus();
  }
  const aiPanel = <AiPanel open={showAiPanel} queue={queue} editor={aiEditor} target={aiTarget} selection={aiSelection}
    targetPicker={<AiTargetPicker settings={aiSettings} catalog={agentCatalog} selection={aiSelection}
      label={aiTarget.label ?? aiTarget.hint ?? "选择 AI 目标"} saving={savingAiSettings}
      onSelect={selectAiTarget} />}
    windowControls={showAiPanel && windowsTitleBar ? <WindowControls onError={showError} /> : undefined}
    canChat={canChat} canEdit={canEditWithAi} onClose={closeAi} onSettings={showModel}
    canSend={() => !exit.current}
    trackWrite={trackAssetTask}
    selectionRequest={aiChatSelection?.sessionId === queue?.sessionId ? aiChatSelection?.selection : undefined}
    canWrite={(origin, editor) => !exit.current && !reading && active.current === origin.entry.id
      && queues.current.get(origin.entry.id) === origin && handles.current.get(origin.entry.id) === editor && !locking.current.has(origin.entry.id)} />;
  const toast = notice && <WorkspaceToast notice={notice} onReveal={path => run(() => desktop.revealFile(path))}
    onDismiss={target => setNotice(current => current === target ? null : current)} />;
  const workspaceNotice = modal?.type !== "settings" && toast;
  function rememberTimelineWidths(directory: number, timeline: number) {
    sidebarWidth.current = directory;
    timelineWidth.current = timeline;
    persist("sidebar-width", directory);
    persist("timeline-width", timeline);
  }
  const rowActions: RowActions = {
    active: activeId, categories: library?.categories ?? [], readOnlyIds: [...readingIds, ...locked],
    treeLocked: globalLock, openMode: documentOpenMode, onOpen: (id, mode) => run(() => open(id, mode)),
    onRowAction: entryAction, onRenameEntry: renameEntry, onFolderError: showError, onMoveEntry: moveTreeEntry,
  };
  const hideSidebarButton = <Tool id="hide-sidebar" label="隐藏左侧栏" className="chrome-icon sidebar-toggle" onClick={toggleExplorer}>
    <SidebarToggleIcon expanded />
  </Tool>;
  const sidebar = (
    <div className="sidebar-workspace" inert={!showExplorer}>
      <nav className="sidebar-chrome chrome-band" aria-label="工作区导航">
        <div className="button-strip">
          {destinations.map(([target, Icon, label]) => <Tool key={target} label={label} className="chrome-icon"
            aria-current={target === section ? "page" : undefined} onClick={() => {
              if (target === "search") { openSearch(); return; }
              if (target === "folders" && section === "folders") revealFolder(null);
              navigate(target);
            }}>
            <Icon size={18} strokeWidth={1.8} />
          </Tool>)}
        </div>
        <WindowDragRegion onError={showError} />
        {!timelineMode && hideSidebarButton}
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
      : <Explorer {...rowActions} ref={explorerTree} section={section} library={library} page={page}
        activeFolder={queue?.entry.deletedAt === null ? queue.snapshot().fields.categoryId : undefined}
        timelineSelection={timelineSelection} onTimelineSelect={setTimelineSelection} includeTimelineChildren={includeTimelineChildren}
        preserveActiveFolder={tabSelection?.restored}
        onCreateCurrent={() => create()}
        onToggleAll={expand => setExpandedFolders(expand ? (library?.categories ?? []).map(folder => folder.id) : [])}
        onLocateCurrent={() => {
          if (queue?.entry.deletedAt !== null) return;
          const pinned = document.getElementById(`entry-row-${queue.entry.id}`);
          if (pinned?.hasAttribute("data-tree-pinned")) pinned.scrollIntoView({ block: "nearest" });
          else {
            revealDirectory();
            revealFolder(queue.snapshot().fields.categoryId);
          }
        }}
        expanded={expandedFolders} revision={refreshCount} loading={folderLoading} pageSize={folderPageSize} caseSensitive={caseSensitive}
        query={query} searchInputRef={searchInput} listError={listError} onRetry={refresh}
        onQuery={value => { setQuery(value); setPage(null); }}
        onCaseSensitive={value => { setCaseSensitive(value); setPage(null); }}
        onFolder={section === "timeline" ? toggleFolderExpanded : toggleFolder}
        onImportWechat={showWechatImport} onImportMarkdown={importMarkdown}
        onCreate={create} onRevealFolder={revealFolder} onSaveFolder={saveFolder}
        onReorderFolder={reorderFolder} onReorderEntry={reorderEntry}
        onCategoryAction={categoryAction} onMore={more} />}
    </div>
  );
  return <Theme appearance={appearance === "system" ? systemDark ? "dark" : "light" : appearance} accentColor="indigo"
    grayColor="slate" radius="small" scaling="95%" panelBackground="solid" className="theme-root">
    <div className="workspace-shell" inert={Boolean(exitMessage)}>
      <Group id="workspace-panels" className="workspace-panels" orientation="horizontal" elementRef={sidebarGroup}
        resizeTargetMinimumSize={dividerHitTarget}
        onLayoutChanged={layout => {
          const group = sidebarGroup.current;
          if (group && showExplorer && previousTimelineMode.current === timelineMode
            && !group.dataset.sidebarMoving && !group.dataset.aiSidebarMoving) {
            const available = group.clientWidth - dividerWidth * (showAiPanel ? 2 : 1);
            const width = Math.round(available * layout.explorer / 100);
            if (timelineMode && timelineWidthsReady.current && width >= minimumDirectoryWidth + minimumTimelineWidth + dividerWidth) {
              const directory = Math.min(sidebarWidth.current, width - minimumTimelineWidth - dividerWidth);
              rememberTimelineWidths(directory, width - directory - dividerWidth);
            } else if (!timelineMode && width >= minimumDirectoryWidth) {
              sidebarWidth.current = width;
              persist("sidebar-width", width);
            }
          }
          if (showAiPanel) persist("ai-sidebar-width", aiSidebarWidth.current);
        }}>
          <Panel id="explorer" defaultSize={initialSidebarSize}
            minSize={timelineMode ? minimumDirectoryWidth + minimumTimelineWidth + dividerWidth : minimumDirectoryWidth}
            collapsible collapsedSize="0px" panelRef={sidebarPanel}
            style={{ overflow: "hidden" }} groupResizeBehavior="preserve-pixel-size"
            onResize={size => {
              if (!showExplorer) return;
              if (sidebarGroup.current?.dataset.sidebarMoving) return;
              if (!size.inPixels) setExplorerOverride(false);
            }}>
            {timelineMode ? <Group id="navigation-panels" className="navigation-panels" orientation="horizontal"
              resizeTargetMinimumSize={dividerHitTarget}
              elementRef={timelineGroup} onLayoutChanged={layout => {
                const groupWidth = timelineGroup.current?.offsetWidth;
                if (!timelineWidthsReady.current || !showExplorer || !groupWidth || sidebarGroup.current?.dataset.aiSidebarMoving) return;
                const available = groupWidth - dividerWidth;
                const directory = Math.round(available * layout.directory / 100);
                rememberTimelineWidths(directory, available - directory);
              }}>
              <Panel id="directory" defaultSize={initialSidebarWidth} minSize={minimumDirectoryWidth} panelRef={directoryPanel}
                groupResizeBehavior="preserve-pixel-size" style={{ overflow: "hidden" }}>
                {sidebar}
              </Panel>
              {showExplorer && <Separator className="divider sidebar-divider navigation-divider" disableDoubleClick aria-label="调整目录栏宽度" />}
              <Panel id="timeline" minSize={minimumTimelineWidth} style={{ overflow: "hidden" }}>
                <div className="timeline-workspace" inert={!showExplorer}>
                  <Timeline root={timelineRoot} folder={timelineFolder} tag={timelineTag} untagged={timelineSelection?.kind === "untagged"} tags={library?.tags ?? []}
                    onSelectTag={(id, keyboard) => {
                      setTimelineSelection({ kind: "tag", id });
                      explorerTree.current?.revealTimelineTag(id, keyboard && timelineTag?.id !== id);
                    }}
                    includeChildren={includeTimelineChildren} onIncludeChildren={setIncludeTimelineChildren}
                    revision={refreshCount} actions={rowActions} sidebarToggle={hideSidebarButton} blankMenu={timelineFolder || timelineRoot ? {
                      disabled: globalLock || !library,
                      onCreate: () => create(currentFolder),
                      onImportWechat: () => showWechatImport(currentFolder),
                      onImportMarkdown: () => importMarkdown(currentFolder),
                      onAddFolder: timelineFolder?.parentId ? undefined : () => explorerTree.current?.addFolder(currentFolder),
                    } : null} />
                </div>
              </Panel>
            </Group> : sidebar}
          </Panel>
          {showExplorer && <Separator className={`divider sidebar-divider${timelineMode ? " navigation-divider" : ""}`}
            disableDoubleClick aria-label={timelineMode ? "调整文章时间流宽度" : "调整资源导航宽度"} />}
        <Panel id="writing" minSize="360px">
          <main className="main-workspace" aria-label="写作工作区">
            <header className="workbench-chrome chrome-band">
              {!showExplorer && <Tool id="show-sidebar" className="chrome-icon sidebar-toggle restore-sidebar" label={focusMode ? "退出专注写作" : "显示左侧栏"}
                onClick={focusMode ? actions.onFocusMode : toggleExplorer}><SidebarToggleIcon /></Tool>}
              {sessions.length > 0 && <DocumentTabs sessions={sessions} activeId={activeId} readingIds={readingIds} lockedIds={locked}
                categories={library?.categories ?? []} onMove={moveTreeEntry} onSwitch={switchTab} onClose={closeTab} onAction={tabAction}
                onReorder={reorderTab} onRename={renameEntry} onError={showError} />}
              {!focusMode && <CreateMenu onCreate={() => create()} onImportWechat={() => showWechatImport()}
                onImportMarkdown={() => importMarkdown()} disabled={globalLock} />}
              <WindowDragRegion onError={showError} />
              {!reading && !focusMode && <Tool id="ai-panel-trigger" className="chrome-icon sidebar-toggle ai-panel-trigger"
                label={showAiPanel ? "隐藏 AI 侧栏" : "显示 AI 侧栏"} aria-expanded={showAiPanel}
                aria-controls="ai-sidebar" onClick={toggleAi}><SidebarToggleIcon side="right" expanded={showAiPanel} /></Tool>}
              {!showAiPanel && windowsTitleBar && <WindowControls onError={showError} />}
            </header>
            {queue ? <>
              <DocumentToolbar queue={queue} categories={library?.categories ?? []} actions={actions}
                locked={globalLock || locked.includes(queue.entry.id)}
                display={display} onDisplayChange={(option, checked) => updateEditorDisplay(queue.entry.id, option, checked)}
                onReveal={id => { navigate("folders"); revealDirectory(); revealFolder(id); }} />
              <div className="document-body" data-view={viewMode} id="document-body" role="tabpanel" aria-labelledby={`tab-${activeId}`}>
                <div className="editor-stack" hidden={viewMode === "preview"}>
                  {sessions.map(session => <DocumentEditor key={session.sessionId}
                    queue={session} active={activeId === session.entry.id} reading={readingIds.includes(session.entry.id)}
                    display={displayFor(session.entry.id)} onDisplayChange={(option, checked) => updateEditorDisplay(session.entry.id, option, checked)}
                    locked={Boolean(exitMessage) || globalLock || locked.includes(session.entry.id)} clipboard={editorClipboard}
                    handle={handle => registerEditor(session.entry.id, handle)}
                    onImages={importImages} onError={showError} localizeImageLink={imageTarget?.autoUpload ? localizeImage : undefined}
                    onAddSelectionToChat={selection => addSelectionToChat(session, selection)}
                    canHost={src => canHostImage(imageTarget, src)} hostBusy={Boolean(imageUpload)}
                    uploadingSource={imageUpload?.sessionId === session.sessionId ? imageUpload.src : undefined}
                    onHostImage={image => hostDocumentImages(session, image)}
                    onImageZoom={(image, trigger) => showModal({ type: "imageViewer", ...image }, trigger)} />)}
                </div>
                {viewMode === "preview" && <div className="preview-stack"><ActivePreview key={queue.sessionId} queue={queue} projectLinks={projectLinks} /></div>}
                {workspaceNotice}
              </div>
              <DocumentSaveError key={queue.sessionId} queue={queue} actions={actions} />
            </> : <div className="document-body">
              <div className="workbench-empty">
                <FilePenLine size={25} strokeWidth={1.4} />
                <h2>还没有打开的内容</h2>
                <div className="button-strip workbench-empty-actions">
                  <Button size="2" variant="soft" onClick={() => create()}>新建笔记</Button>
                  <Button size="2" variant="soft" color="gray" onClick={() => showWechatImport()}>导入公众号文章</Button>
                </div>
              </div>
              {workspaceNotice}
            </div>}
          </main>
        </Panel>
        {showAiPanel && <Separator className="divider ai-sidebar-divider"
          disableDoubleClick aria-label="调整 AI 侧栏宽度" />}
        <Panel id="ai-sidebar" defaultSize="0px" minSize="300px" maxSize="50%" collapsible collapsedSize="0px"
          panelRef={aiSidebarPanel} groupResizeBehavior="preserve-pixel-size" style={{ overflow: "hidden" }}
          onResize={size => {
            if (showAiPanel && size.inPixels > 0) aiSidebarWidth.current = size.inPixels;
            else if (showAiPanel && !sidebarGroup.current?.dataset.aiSidebarMoving) setAiOpen(false);
          }}>
          <div className="ai-sidebar" inert={!showAiPanel}>
            {(showAiPanel || aiVisited) && <Suspense fallback={null}>{aiPanel}</Suspense>}
          </div>
        </Panel>
      </Group>
      <StatusBar queue={queue} actions={actions} trashActive={showExplorer && section === "trash"} settingsOpen={modal?.type === "settings"}
        mcpRunning={mcpStatus?.running} onMcp={trigger => openSettings("mcp", trigger)} backupProgress={backupWorking}
        migrationProgress={migrationWorking} assetRevision={assetsRevision} imageStorageEnabled={Boolean(imageTarget)}
        imageUpload={imageUpload?.sessionId === queue?.sessionId ? imageUpload : null} onError={showError}
        onPalette={trigger => showModal({ type: "palette" }, trigger)}
        onTrash={() => navigate("trash")}
        onSettings={trigger => openSettings("appearance", trigger)} />
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
        <SettingsDialog initialPage={modal.page} status={backupWorking ?? undefined} toast={toast} onClose={closeModal} renderPage={page => {
          if (page === "model") return <ModelSettings settings={aiSettings} loadError={aiSettingsError}
            saving={savingAiSettings} onSave={saveAiSettings} />;
          if (page === "mcp") return <McpSettings status={mcpStatus} loadError={mcpLoadError} onStatus={setMcpStatus} />;
          if (page === "images") return <ImageStorageSettings track={trackAssetTask} />;
          if (page === "backups") return <BackupPanel busy={backupWorking !== null || migrationWorking !== null} progress={backupWorking ?? ""} feedback={backupFeedback}
            listRevision={backupListRevision} prepared={preparedBackup?.migration ? null : preparedBackup} onCreate={createBackup} onRestore={prepareBackup}
            onConfirmRestore={() => setConfirmRestore(true)} onDiscardRestore={discardPreparedRestore} />;
          if (page === "migration") return <MigrationPanel busy={backupWorking !== null || migrationWorking !== null}
            working={migrationWorking} feedback={migrationFeedback} prepared={preparedBackup?.migration === true}
            onTransfer={action => void transferWorkspace(action)} onConfirmRestore={() => setConfirmRestore(true)} onDiscardRestore={discardPreparedRestore} />;
          return <WorkspaceSettings page={page} appearance={appearance} shortcut={shortcut} preferredView={preferredView} explorer={defaultExplorer}
            downloadPastedImages={downloadPastedImages} convertLinks={defaultConvertLinks} documentOpenMode={documentOpenMode}
            folderLoading={folderLoading} folderPageSize={folderPageSize}
            onAppearance={value => { setAppearance(value); persist("appearance", value); }}
            onView={value => { setPreferredView(value); persist("view", value); }}
            onDownloadPastedImages={value => { setDownloadPastedImages(value); persist("download-pasted-images", value); }}
            onConvertLinks={value => { setDefaultConvertLinks(value); persist("links-to-footnotes", value); }}
            onDocumentOpenMode={value => { setDocumentOpenMode(value); persist("document-open-mode", value); }}
            onFolderLoading={value => { setFolderLoading(value); persist("folder-loading", value); }}
            onFolderPageSize={value => { setFolderPageSize(value); persist("folder-page-size", value); }}
            onExplorer={value => { setPreferredExplorer(value); setExplorerOverride(null); persist("explorer", value); }}
            onShortcut={value => { setShortcut(value); persist("view-shortcut", value); }} />;
        }} />
        {confirmRestore && preparedBackup && <Confirm title={preparedBackup.migration ? "恢复工作区" : "恢复数据库"}
          text={preparedBackup.migration ? "将使用迁移包里的数据库和素材恢复工作区并重启。当前数据库会被替换。"
            : `将使用 ${preparedBackup.workspaceLabel} 在 ${backupDate(preparedBackup.snapshot.createdAt)} 的备份替换当前数据库并重启。恢复后仅保留快照中的内容。图片需从本地文件或图床读取。`}
          action="恢复并重启" onClose={() => {
            setConfirmRestore(false);
            const trigger = preparedBackup.migration ? "migration-restore-trigger" : "backup-restore-trigger";
            requestAnimationFrame(() => document.getElementById(trigger)?.focus());
          }}
          onConfirm={() => finishWorkspace(preparedBackup.ticket)} />}
      </>}
      {modal?.type === "wechatImport" && <WechatImportDialog categoryId={modal.categoryId}
        track={trackAssetTask} onClose={closeModal} onImported={refresh} onOpen={id => {
        if (exit.current) return;
        closeModal();
        if (section !== "imports" && section !== "timeline") navigate("folders");
        run(() => open(id));
      }} />}
      {modal?.type === "publishImages" && <PublishImagesDialog images={modal.images} onClose={closeModal} />}
      {modal?.type === "imageViewer" && <ImageViewer src={modal.src} alt={modal.alt} onClose={closeModal} />}
      {modal?.type === "palette" && <CommandPalette actions={commands} onClose={closeModal} onOpen={id => run(() => open(id))} />}
      {modal?.type === "properties" && <PropertiesDialog key={modal.id} id={modal.id} queue={queues.current.get(modal.id)}
        categories={library?.categories ?? []} tagSuggestions={library?.tagSuggestions ?? []}
        locked={globalLock || readingIds.includes(modal.id) || locked.includes(modal.id)}
        onSave={(entry, change) => trackAssetTask(saveEntryFields(entry, change))} onClose={closeModal} onOpen={id => run(() => open(id))} />}
      {modal?.type === "revisions" && <RevisionsDialog id={modal.id} onClose={closeModal} onCopy={copy} />}
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

function ActivePreview({ queue, projectLinks }: { queue: SaveQueue; projectLinks?: MarkdownEditorHandle["linkFootnoteMarkdown"] | null }) {
  const materialized = useSyncExternalStore(queue.subscribe, queue.snapshotFields);
  const { fields, revision } = useMemo(() => queue.capture(), [queue, materialized]);
  return <MarkdownPreview markdown={fields.contentMd} themeId={fields.themeId} revision={revision} projectLinks={projectLinks} />;
}
