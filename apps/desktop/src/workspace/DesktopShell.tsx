import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Button, Theme } from "@radix-ui/themes";
import { FilePenLine, Folder, Globe, Image, List, Search, Workflow } from "lucide-react";
import { Group, Panel, Separator, useGroupRef, usePanelRef } from "react-resizable-panels";
import type { Category, CategoryIcon, CategoryPlacement, Collection, Entry, EntryFields, EntryFilter, EntryPage, EntryRow, Library, SaveMode, SaveResult, TimelineSelection, WorkspaceSearchHit } from "../../../../packages/shared-types";
import type { ClipboardAction, ClipboardIO, ImageContext, MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { ChatSelection } from "../ai/context";
import { desktop, errorMessage, macTitleBar, windowsTitleBar, type ActiveImageStorage, type AiAgent, type AiAgentModel, type AiSelection, type AiSettings, type BackupSnapshot, type McpStatus, type SyncActivity, type SyncApplied, type SyncBinding, type UploadProgress } from "../desktop";
import { useButtonFeedback } from "../button-feedback";
import { installInputContextMenu } from "../input-context-menu";
import { SaveQueue, isConflict } from "../editor/save-queue";
import { attachClipboard, writeClipboard } from "../editor/clipboard";
import { editHistory } from "../editor/history";
import { parseWebClipping } from "../editor/web-clipping";
import { commandKey, untitled } from "../labels";
import { persist, SidebarToggleIcon, Tool, useStoredInitial } from "../ui";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { WorkspaceToast, type Notice } from "./WorkspaceToast";
import { readCollectionTabs, readDocumentTabs, readWorkspaceLayout, readWorkspaceNavigation, saveCollectionTabs, saveDocumentTabs, saveWorkspaceLayout,
  saveWorkspaceNavigation, workspacePreferences, type CollectionTabsPreference, type DocumentOpenMode, type DocumentOptions, type TimelineDirectory } from "./preferences";
import { Confirm, DeleteCategoryDialog, PropertiesDialog, RevisionsDialog } from "./Dialogs";
import { DocumentEditor, DocumentSaveError, DocumentTabs, DocumentToolbar, MarkdownPreview, type DocumentActions, type TabAction, type ViewMode } from "./Document";
import { StatusBar } from "./StatusBar";
import type { EditorDisplay } from "./EditorContextMenu";
import { Outline } from "./Outline";
import { CreateMenu, Explorer, type CategoryAction, type EntryRowAction, type ExplorerHandle, type RowActions, type Section } from "./Explorer";
import { McpSettings, SettingsDialog, WorkspaceSettings, type Appearance, type SettingsPage, type ViewShortcut } from "./Settings";
import { AboutPage } from "./About";
import { SyncSettings } from "./SyncSettings";
import { startSyncApplication } from "./sync-scheduler";
import { matchesViewShortcut } from "./view-shortcut";
import { flushSync } from "react-dom";
import { aiAvailability, ModelSettings } from "./AiSettings";
import { AiTargetPicker } from "./AiTargetPicker";
import { BackupPanel, backupDate, backupProgress, type PreparedBackup } from "./Backup";
import { MigrationPanel } from "./Migration";
import { AssetPanel, canHostImage, ImageStorageSettings, imageMarkdown } from "./Assets";
import { Timeline } from "./Timeline";
import { WindowControls, WindowDragRegion } from "./WindowTitle";
import { ImageViewer, LinkImportDialog, PublishImagesDialog, renderForPublication } from "./Publishing";
import { CollectionExplorer } from "./CollectionExplorer";
import type { CollectionCanvasHandle } from "./CollectionCanvas";
import type { RenderedWechat } from "../../../../packages/wechat-renderer";
import "./collection-canvas.css";

const AiPanel = lazy(() => import("./AiPanel").then(module => ({ default: module.AiPanel })));
const CollectionCanvas = lazy(() => import("./CollectionCanvas").then(module => ({ default: module.CollectionCanvas })));
const minimumDirectoryWidth = macTitleBar ? 300 : 192;
const minimumTimelineWidth = 416;
const minimumWritingWidth = 360;
const minimumNavigationWidth = 337;
const minimumAiWidth = 300;
const dividerWidth = 1;
const dividerHitTarget = { fine: 16, coarse: 24 };
const directoryTransitionMs = 200;

function hasWorkspaceSize(group: HTMLDivElement | null): group is HTMLDivElement {
  return Boolean(group?.clientWidth && group.clientHeight);
}

type Modal =
  | { type: "palette" | "reload" | "emptyTrash" }
  | { type: "properties" | "revisions"; id: string }
  | { type: "deleteCategory"; target: Category }
  | { type: "settings"; page: SettingsPage }
  | { type: "linkImport"; categoryId: string | null }
  | { type: "deleteCollection"; collection: Collection }
  | { type: "imageViewer"; src: string; alt: string }
  | { type: "publishImages"; images: RenderedWechat["images"] };

const destinations = [
  ["folders", Folder, "内容目录"], ["timeline", List, "文章时间流"], ["search", Search, "全文搜索"], ["assets", Image, "素材库"],
  ["imports", Globe, "导入的外部文章"], ["collections", Workflow, "专题"],
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
  const [initialLayout] = useState(readWorkspaceLayout);
  const [section, setSection] = useState<Section>(initialLayout.section);
  const [library, setLibrary] = useState<Library | null>(null);
  const workspaceId = library?.workspaceId;
  const collectionMode = section === "collections";
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [collectionTabs, setCollectionTabs] = useState<CollectionTabsPreference | null>(null);
  const activeCollectionId = collectionTabs?.activeId;
  const [collectionsError, setCollectionsError] = useState("");
  const [collectionsRetry, setCollectionsRetry] = useState(0);
  const [collectionsCollapsed, setCollectionsCollapsed] = useState(() => useStoredInitial("collection-list-collapsed", false));
  const [collectionDraft, setCollectionDraft] = useState<{ id?: string }>();
  const activeCollection = collections?.find(item => item.id === activeCollectionId);
  const openCollections = collectionTabs?.ids.flatMap(id => collections?.find(item => item.id === id) ?? []) ?? [];
  const collectionCanvas = useRef<CollectionCanvasHandle>(null);
  const [canvasRevisions, setCanvasRevisions] = useState(() => new Map<string, number>());
  function reloadCanvases(ids: string[]) {
    setCanvasRevisions(current => {
      const next = new Map(current);
      for (const id of ids) next.set(id, (next.get(id) ?? 0) + 1);
      return next;
    });
  }
  const collectionListRevision = useRef(0);
  const collectionWrites = useRef(new Set<Promise<unknown>>());
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const revision = collectionListRevision.current;
    setCollectionsError("");
    void desktop.collections().then(items => {
      if (!live || revision !== collectionListRevision.current) return;
      const stored = readCollectionTabs(workspaceId);
      const available = new Set(items.map(item => item.id));
      setCollectionTabs(current => {
        const previous = current ?? stored;
        const ids = previous.ids.filter(id => available.has(id));
        return { ids, activeId: ids.includes(previous.activeId ?? "") ? previous.activeId : ids[0] };
      });
      setCollections(items);
    }, error => { if (live && revision === collectionListRevision.current) setCollectionsError(errorMessage(error)); });
    return () => { live = false; };
  }, [collectionsRetry, workspaceId]);
  useEffect(() => {
    if (workspaceId && collectionTabs && collections) saveCollectionTabs(workspaceId, collectionTabs);
  }, [workspaceId, collectionTabs, collections]);
  const [navigationWorkspace, setNavigationWorkspace] = useState<string>();
  const [page, setPage] = useState<EntryPage | null>(null);
  const [categoryId, setCategoryId] = useState<string>();
  const [timelineSelection, setTimelineSelection] = useState<TimelineSelection>({ kind: "root" });
  const [timelineDirectory, setTimelineDirectory] = useState<TimelineDirectory>(initialLayout.timelineDirectory);
  const directoryMode = useRef(timelineDirectory);
  const [includeTimelineChildren, setIncludeTimelineChildren] = useState(true);
  const timelineFolder = timelineSelection.kind === "folder"
    ? library?.categories.find(category => category.id === timelineSelection.id) ?? null : null;
  const timelineTag = timelineSelection.kind === "tag"
    ? library?.tags.find(tag => tag.id === timelineSelection.id) ?? null : null;
  const timelineMode = section === "timeline";
  const timelineRoot = timelineSelection.kind === "root";
  const [expandedFolders, setExpandedFolders] = useState(() => useStoredInitial<string[]>("expanded-folders", []));
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searchSort, setSearchSort] = useState(() => useStoredInitial<NonNullable<EntryFilter["sort"]>>("workspace-search-sort", "name"));
  const [searchJump, setSearchJump] = useState<{ entryId: string; hit: WorkspaceSearchHit; version: number; showContext: boolean }>();
  const [selectedSearchHit, setSelectedSearchHit] = useState<{ entryId: string; start: number }>();
  const searchIntent = useRef(0);
  const [listError, setListError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [imageTarget, setImageTarget] = useState<ActiveImageStorage | null>(null);
  const [imageUpload, setImageUpload] = useState<(UploadProgress & { sessionId: number; src?: string }) | null>(null);
  const [assetsRevision, setAssetsRevision] = useState(0);
  const [mcpStatus, setMcpStatus] = useState<McpStatus>();
  const [mcpLoadError, setMcpLoadError] = useState("");
  const [tabSessions, setSessions] = useState<SaveQueue[] | null>(null);
  const [tabsRestored, setTabsRestored] = useState(false);
  const [tabSelection, setTabSelection] = useState<{ id: string; restored: boolean } | null>(null);
  const sessions = tabSessions ?? [];
  const activeId = tabSelection?.id ?? null;
  const [readingIds, setReadingIds] = useState<string[]>([]);
  const [documentOptions, setDocumentOptions] = useState(() => new Map<string, DocumentOptions>());
  const [modal, setModal] = useState<Modal | null>(null);
  const settingsPage = useRef<SettingsPage>("appearance");
  const syncSettingsBusy = useRef(false);
  const wakeAutomaticSync = useRef<(() => void) | undefined>(undefined);
  const [appearance, setAppearance] = useState(() => useStoredInitial<Appearance>("appearance", "system"));
  const [preferredView, setPreferredView] = useState<ViewMode>(() => useStoredInitial<string>("view", "") === "preview" ? "preview" : "edit");
  const [shortcut, setShortcut] = useState(() => useStoredInitial<ViewShortcut>("view-shortcut", "none"));
  const [downloadPastedImages, setDownloadPastedImages] = useState(() => useStoredInitial("download-pasted-images", false));
  const [defaultConvertLinks, setDefaultConvertLinks] = useState(() => useStoredInitial("links-to-footnotes", false));
  const [defaultOutline, setDefaultOutline] = useState(() => useStoredInitial("default-document-outline", false));
  const [documentOpenMode, setDocumentOpenMode] = useState<DocumentOpenMode>(() =>
    useStoredInitial<string>("document-open-mode", "") === "new-tab" ? "new-tab" : "current");
  const [folderLoading, setFolderLoading] = useState(() => useStoredInitial<"all" | "paged">("folder-loading", "paged"));
  const [folderPageSize, setFolderPageSize] = useState(() => useStoredInitial("folder-page-size", 60));
  const [editorDisplay, setEditorDisplay] = useState(() => useStoredInitial<Omit<EditorDisplay, "convertLinks">>("editor-display", {
    limitWidth: true, lineNumbers: false, showTitle: true,
  }));
  const [preferredExplorer, setPreferredExplorer] = useState(() => useStoredInitial<boolean | null>("explorer", null));
  const [explorerOverride, setExplorerOverride] = useState(initialLayout.explorerOverride);
  const [focusMode, setFocusMode] = useState(initialLayout.focusMode);
  const [locked, setLocked] = useState<string[]>([]);
  const [globalLock, setGlobalLock] = useState(false);
  const [exitMessage, setExitMessage] = useState("");
  const [publishing, setPublishing] = useState(false);
  const documentButtons = useButtonFeedback();
  const [exportedPath, setExportedPath] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [backupListRevision, setBackupListRevision] = useState(0);
  const [preparedBackup, setPreparedBackup] = useState<PreparedBackup | { ticket: string; migration: true } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [backupWorking, setBackupWorking] = useState<string | null>(null);
  const [migrationWorking, setMigrationWorking] = useState<"export" | "import" | null>(null);
  const [migrationFeedback, setMigrationFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [restoreRestarting, setRestoreRestarting] = useState(false);
  const [aiOverride, setAiOpen] = useState<boolean | null>(null);
  const aiOpen = aiOverride ?? initialLayout.aiOpen;
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
  const dark = appearance === "dark" || (appearance === "system" && systemDark);
  useLayoutEffect(() => {
    if (!macTitleBar) return;
    const color = dark ? "#111113" : "#fcfcfd";
    document.documentElement.style.setProperty("--workbench-bg", color);
    void desktop.setWindowBackground(color).catch(error => console.error(error));
  }, [dark]);
  const compact = useMedia("(width < 820px)");
  const defaultExplorer = preferredExplorer ?? !compact;
  const explorer = explorerOverride ?? defaultExplorer;
  const reading = activeId !== null && readingIds.includes(activeId);
  const timelineTooNarrow = useMedia(`(width < ${minimumTimelineWidth + minimumWritingWidth + minimumAiWidth + 2 * dividerWidth}px)`);
  const showAiPanel = aiOpen && !collectionMode && !focusMode && !reading && (aiOverride !== null || tabsRestored || tabSessions !== null)
    && (!timelineMode || !explorer || !timelineTooNarrow);
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
  const [editorHandlesRevision, refreshEditorHandles] = useState(0);
  const pendingEditorFocus = useRef<string | null>(null);
  const selecting = useRef(0);
  const viewIntent = useRef(0);
  const writing = useRef(new Set<Promise<unknown>>());
  const locking = useRef(new Set<string>());
  const exit = useRef<{ cancelled: boolean; restoring: boolean } | null>(null);
  const [{ directory: initialDirectoryWidth, navigation: initialNavigationWidth, timeline: initialTimelineWidth }] = useState(() => {
    const legacyDirectoryWidth = useStoredInitial("sidebar-width", 248);
    const legacyTimelineWidth = useStoredInitial("timeline-width", 0);
    const legacyWidth = legacyDirectoryWidth + (legacyTimelineWidth ? legacyTimelineWidth + dividerWidth : 0);
    const directory = Math.max(minimumDirectoryWidth, useStoredInitial("timeline-directory-width", legacyDirectoryWidth));
    const navigation = Math.max(minimumNavigationWidth, useStoredInitial("navigation-width", legacyWidth));
    const articleWidth = navigation - directory - dividerWidth;
    const timeline = useStoredInitial("timeline-article-width", legacyTimelineWidth || articleWidth);
    return {
      directory, navigation,
      timeline: Math.max(minimumTimelineWidth, timeline),
    };
  });
  const [directoryWidth, setDirectoryWidth] = useState(initialDirectoryWidth);
  const preferredDirectoryWidth = useRef(initialDirectoryWidth);
  const [initialSidebarSize] = useState(() => {
    if (!explorer || focusMode) return "0px";
    if (!timelineMode) return `${initialNavigationWidth}px`;
    return `${initialTimelineWidth + (timelineDirectory === "shown" ? directoryWidth + dividerWidth : 0)}px`;
  });
  const navigationWidth = useRef(initialNavigationWidth);
  const timelineWidth = useRef(initialTimelineWidth);
  const sidebarGroup = useRef<HTMLDivElement>(null);
  const writingChrome = useRef<HTMLElement>(null);
  const navigationElement = useRef<HTMLDivElement>(null);
  const layoutSuspended = useRef(false);
  const timelineLayoutReady = useRef(false);
  const directoryDrag = useRef<{ pointerId: number; startX: number; width: number; articleWidth: number; currentWidth: number }>(null);
  const directoryTransition = useRef(0);
  const [initialAiWidth] = useState(() => useStoredInitial("ai-sidebar-width", 350));
  const explorerTree = useRef<ExplorerHandle>(null);
  const sidebarPanel = usePanelRef();
  const aiSidebarPanel = usePanelRef();
  const workspacePanels = useGroupRef();
  const aiSidebarWidth = useRef(initialAiWidth);
  const searchInput = useRef<HTMLInputElement>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const refresh = () => setRefreshCount(count => count + 1);
  function linkImported(unavailableImages = 0) {
    refresh();
    if (unavailableImages) setNotice({ type: "info", text: `已导入文章，${unavailableImages} 张图片未能下载，已保留原链接。` });
  }
  const syncing = useRef(false);
  const [automaticSyncError, setAutomaticSyncError] = useState("");
  const [syncState, setSyncState] = useState<{ binding: SyncBinding | null; activity: SyncActivity | null }>();
  const [syncWaitingReason, setSyncWaitingReason] = useState<string>();

  async function flushWorkspaceForSync() {
    await Promise.all(writing.current);
    const failed = (await waitForCollectionWrites()).find(write => write.status === "rejected");
    if (failed) throw failed.reason;
    await collectionCanvas.current?.flush();
    const saved = await Promise.all([...queues.current.values()].map(queue => queue.flush()));
    if (saved.some(result => !result)) throw new Error("有文稿未能保存，请处理后重试");
  }

  async function applySync(operation: () => Promise<SyncApplied>) {
    flushSync(() => setGlobalLock(true));
    try {
      await flushWorkspaceForSync();
      const applied = await operation();
      const { changedEntries, changedCollections } = applied;
      const reopened = await Promise.all([...new Set(changedEntries)].flatMap(id => {
        const queue = queues.current.get(id);
        return queue ? [desktop.entry(id).then(entry => ({ queue, entry }))] : [];
      }));
      for (const { queue, entry } of reopened) {
        if (entry.purgedAt != null) removePurgedEntries([entry.id]);
        else if (!queue.isDirty() && queues.current.get(entry.id) === queue) install(entry, queue);
      }
      if (changedCollections.length) {
        collectionListRevision.current += 1;
        setCollectionsRetry(value => value + 1);
        reloadCanvases(changedCollections);
      }
      refresh();
      setAssetsRevision(revision => revision + 1);
      return applied;
    } finally {
      setGlobalLock(false);
    }
  }

  async function withSync<T>(operation: () => Promise<T>) {
    if (syncing.current || globalLock || exit.current) throw new Error("工作区正在处理其他操作");
    syncing.current = true;
    try {
      return await operation();
    } finally {
      syncing.current = false;
    }
  }

  async function runSync() {
    const applied = await withSync(async () => {
      await flushWorkspaceForSync();
      const applyIncoming = async () => {
        if (!exit.current && (await desktop.syncActivity())?.incoming) return applySync(desktop.syncApply);
      };
      try {
        await desktop.syncRun();
      } catch (error) {
        // Earlier pages can already be ready to apply. Keep the exchange error visible.
        await applyIncoming().catch(() => {});
        throw error;
      }
      return applyIncoming();
    });
    setAutomaticSyncError("");
    return applied?.mergeArchive;
  }

  async function rebuildSync() {
    const archive = await withSync(async () => {
      await desktop.syncRebuildStage();
      if (exit.current) throw new Error("工作区正在关闭");
      let archive = "";
      await applySync(async () => {
        const result = await desktop.syncRebuildApply();
        archive = result.recoveryArchive;
        return result;
      });
      return archive;
    });
    setAutomaticSyncError("");
    return archive;
  }

  const automaticSyncWaitingReason = useEffectEvent(() => {
    if (!tabsRestored) return "等待工作区加载完成";
    if (exit.current) return "等待工作区保存退出";
    if (syncing.current || globalLock || syncSettingsBusy.current) return "等待当前操作完成";
    const viewingSyncSettings = modal?.type === "settings" && settingsPage.current === "sync";
    if (modal && !viewingSyncSettings) return "等待关闭当前弹窗";
    if (document.querySelector('[role="alertdialog"]')) return "等待关闭确认对话框";
    const unsaved = [...queues.current.values()].filter(queue => queue.isDirty() || queue.isSaving());
    if (unsaved.length) return unsaved.some(queue => queue.saveError()) ? "等待重试文稿保存" : "等待文稿保存完成";
    if (!(collectionCanvas.current?.canApplySync() ?? true)) return "等待画布操作结束";
    if (!viewingSyncSettings && document.visibilityState === "visible" && document.hasFocus()
      && document.activeElement?.closest("[contenteditable=true],textarea,input,select")) return "等待结束编辑";
    return undefined;
  });
  const applyAutomaticSync = useEffectEvent(async () => {
    const waiting = automaticSyncWaitingReason();
    setSyncWaitingReason(waiting);
    if (waiting) return false;
    if (!(await desktop.syncActivity())?.incoming) return true;
    const latest = automaticSyncWaitingReason();
    setSyncWaitingReason(latest);
    if (latest) return false;
    await withSync(() => applySync(desktop.syncApply));
    return true;
  });
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    let request = 0;
    setSyncState(undefined);
    async function readSyncStatus() {
      const current = ++request;
      const [binding, activity] = await Promise.all([desktop.syncStatus(), desktop.syncActivity()]);
      if (live && current === request) {
        setSyncState({ binding, activity });
        setSyncWaitingReason(activity?.incoming ? automaticSyncWaitingReason() : undefined);
      }
      return activity;
    }
    const scheduler = startSyncApplication({
      read: readSyncStatus,
      apply: () => applyAutomaticSync(),
      report: error => setAutomaticSyncError(error ? errorMessage(error) : ""),
    });
    wakeAutomaticSync.current = scheduler.wake;
    const statusChanged = desktop.onSyncStatusChanged(() => {
      scheduler.wake();
      // Phase updates must remain visible while local replay holds the application loop.
      void readSyncStatus().catch(error => { if (live) setAutomaticSyncError(errorMessage(error)); });
    });
    void statusChanged.catch(error => setAutomaticSyncError(errorMessage(error)));
    let foreground = document.visibilityState === "visible" && document.hasFocus();
    const foregroundChanged = () => {
      const next = document.visibilityState === "visible" && document.hasFocus();
      const restored = next && !foreground;
      foreground = next;
      if (restored) void desktop.syncWake("foreground").catch(error => setAutomaticSyncError(errorMessage(error)));
      scheduler.wake();
    };
    const online = () => {
      void desktop.syncWake().catch(error => setAutomaticSyncError(errorMessage(error)));
      scheduler.wake();
    };
    window.addEventListener("focus", foregroundChanged);
    window.addEventListener("blur", foregroundChanged);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", foregroundChanged);
    document.addEventListener("focusin", scheduler.wake);
    document.addEventListener("focusout", scheduler.wake);
    return () => {
      live = false;
      scheduler.dispose();
      wakeAutomaticSync.current = undefined;
      void statusChanged.then(unlisten => unlisten(), () => {});
      window.removeEventListener("focus", foregroundChanged);
      window.removeEventListener("blur", foregroundChanged);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", foregroundChanged);
      document.removeEventListener("focusin", scheduler.wake);
      document.removeEventListener("focusout", scheduler.wake);
    };
  }, [workspaceId]);
  useEffect(() => { wakeAutomaticSync.current?.(); }, [modal, tabsRestored]);
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
    sort: section === "search" ? searchSort : undefined,
    limit: section === "search" ? 30 : undefined,
    deleted: section === "trash", externalImported: section === "imports", offset: 0,
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
  }, [caseSensitive, section, searchText, searchSort, filteredSection, refreshCount]);

  useLayoutEffect(() => {
    if (!searchJump || activeId !== searchJump.entryId || viewMode !== "edit" || collectionMode) return;
    const editor = handles.current.get(searchJump.entryId);
    const queue = queues.current.get(searchJump.entryId);
    if (!editor || !queue) return;
    if (queue.isDirty()) {
      showError("正文有尚未保存的修改，保存后可定位新结果");
    } else if (queue.snapshot().version !== searchJump.version || !editor.revealSearchHit(searchJump.hit, searchJump.showContext)) {
      setRefreshCount(count => count + 1);
      showError("笔记已更新，请点击刷新后的匹配行");
    } else {
      setSelectedSearchHit({ entryId: searchJump.entryId, start: searchJump.hit.start });
    }
    setSearchJump(undefined);
  }, [searchJump, activeId, viewMode, collectionMode, editorHandlesRevision, showError]);

  useEffect(() => { persist("expanded-folders", expandedFolders); }, [expandedFolders]);
  useEffect(() => { persist("editor-display", editorDisplay); }, [editorDisplay]);
  useEffect(() => {
    saveWorkspaceLayout({ section, explorerOverride, timelineDirectory, focusMode, aiOpen });
  }, [section, explorerOverride, timelineDirectory, focusMode, aiOpen]);

  useEffect(() => {
    let current = true;
    void desktop.library(timelineMode).then(result => { if (current) setLibrary(result); }, error => {
      if (current) setNotice({ type: "error", text: errorMessage(error) });
    });
    return () => { current = false; };
  }, [refreshCount, timelineMode]);

  useLayoutEffect(() => {
    if (!library || library.workspaceId === navigationWorkspace) return;
    const saved = readWorkspaceNavigation(library.workspaceId);
    const selection = saved.timelineSelection;
    const folders = library.categories;
    setCategoryId(folders.some(folder => folder.id === saved.categoryId) ? saved.categoryId : undefined);
    setTimelineSelection(
      (selection.kind === "folder" && !folders.some(folder => folder.id === selection.id))
      || (selection.kind === "tag" && !library.tags.some(tag => tag.id === selection.id))
        ? { kind: "root" } : selection,
    );
    setQuery(saved.query);
    setCaseSensitive(saved.caseSensitive);
    setIncludeTimelineChildren(saved.includeTimelineChildren);
    setNavigationWorkspace(library.workspaceId);
  }, [library, navigationWorkspace]);
  useEffect(() => {
    if (workspaceId && navigationWorkspace === workspaceId) {
      saveWorkspaceNavigation(workspaceId, { categoryId, timelineSelection, includeTimelineChildren, query, caseSensitive });
    }
  }, [workspaceId, navigationWorkspace, categoryId, timelineSelection, includeTimelineChildren, query, caseSensitive]);

  const restoreTabs = useEffectEvent(async (workspaceId: string, isCurrent: () => boolean) => {
    const saved = readDocumentTabs(workspaceId);
    if (selecting.current || exit.current) return;
    if (!saved?.ids.length) { setFocusMode(false); return; }
    try {
      const entries = await Promise.all(saved.ids.map(id => desktop.entry(id).catch((failure: unknown) => {
        if (typeof failure === "object" && failure !== null && "code" in failure && failure.code === "NOT_FOUND") return null;
        throw failure;
      })));
      if (!isCurrent() || selecting.current || exit.current) return;
      for (const entry of entries) {
        if (entry && entry.deletedAt === null) queues.current.set(entry.id, new SaveQueue(entry, desktop.save, refresh));
      }
      setReadingIds((saved.readingIds ?? []).filter(id => queues.current.has(id)));
      setDocumentOptions(new Map(Object.entries(saved.options ?? {}).filter(([id]) => queues.current.has(id))));
      setSessions([...queues.current.values()]);
      const first = queues.current.keys().next().value;
      if (!first) setFocusMode(false);
      select(saved.activeId && queues.current.has(saved.activeId) ? saved.activeId : first ?? null, true);
    } catch (error) {
      if (isCurrent() && !selecting.current && !exit.current) {
        setFocusMode(false);
        showError(error);
      }
    }
  });
  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    void restoreTabs(workspaceId, () => current).finally(() => {
      if (current) setTabsRestored(true);
    });
    return () => { current = false; };
  }, [workspaceId]);
  useEffect(() => {
    if (workspaceId && tabSessions) {
      saveDocumentTabs(workspaceId, {
        ids: tabSessions.map(tab => tab.entry.id), activeId,
        readingIds: readingIds.length ? readingIds : undefined,
        options: documentOptions.size ? Object.fromEntries(documentOptions) : undefined,
      });
    }
  }, [workspaceId, tabSessions, activeId, readingIds, documentOptions]);

  function more() {
    const offset = page?.nextOffset;
    if (offset == null) return;
    const epoch = filterEpoch.current;
    void desktop.entries({ ...filter, offset }).then(result => {
      if (epoch === filterEpoch.current) setPage(previous => previous?.nextOffset === offset
        ? { ...result, items: [...previous.items, ...result.items] } : previous);
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
        try { images.push(imageMarkdown(await desktop.assetImport(file, origin), file.name)); }
        catch (error) { errors.push(`${file.name || "图片"}：${errorMessage(error)}`); }
      }
      if (errors.length) {
        if (origin === "library") throw new Error(errors.join("；"));
        showError(errors.join("；"));
      }

      return images.length ? "\n" + images.join("\n") + "\n" : "";
    })();
    return trackAssetTask(job);
  }

  function trackAssetTask<T>(job: Promise<T>): Promise<T> {
    writing.current.add(job);
    return job.finally(() => writing.current.delete(job));
  }

  const trackCollectionWrite = useCallback(<T,>(job: Promise<T>) => {
    collectionWrites.current.add(job);
    return job.finally(() => collectionWrites.current.delete(job));
  }, []);
  const waitForCollectionWrites = useCallback(() => Promise.allSettled(collectionWrites.current), []);

  const localizeImage = (url: string) => {
    if (imageTarget?.autoUpload) {
      return canHostImage(imageTarget, url)
        ? trackAssetTask(desktop.hostImage(url, imageTarget))
        : Promise.resolve(url);
    }
    return url.startsWith("asset://") ? Promise.resolve(url) : trackAssetTask(desktop.localizeImage(url));
  };
  const editorClipboard: ClipboardIO = {
    write: writeClipboard,
    localizeImage: downloadPastedImages || imageTarget?.autoUpload ? localizeImage : undefined,
    importImage: async file => `asset://${await trackAssetTask(desktop.assetImport(file))}`,
    onError: showError,
    async read(plainText = false) {
      if (exit.current) return "";
      const result = await trackAssetTask(desktop.readClipboard(!plainText, !plainText));
      if (!result) return "";
      if (result.kind === "text") return !plainText && pasteWebClipping(result.text) ? "" : result.text;
      if (result.kind === "html") return !plainText && result.text && pasteWebClipping(result.text) ? "" : { html: result.html, text: result.text };
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
    const view = ++viewIntent.current;
    const superseded = () => ticket !== selecting.current || view !== viewIntent.current || exit.current;
    const replacing = !collectionMode && mode === "current" && active.current ? queues.current.get(active.current) : undefined;
    const canvas = collectionMode ? collectionCanvas.current : null;
    if (collectionMode) {
      await waitForCollectionWrites();
      await canvas?.flush();
      if (superseded()) return;
    }
    if (!queues.current.has(id)) {
      const entry = await desktop.entry(id);
      if (superseded()) return;
      if (entry.purgedAt != null) throw new Error("内容已永久删除");
      while (replacing && queues.current.get(replacing.entry.id) === replacing && !queues.current.has(id)) {
        const currentId = replacing.entry.id;
        if (locking.current.has(currentId)) throw new Error("当前标签页正在处理，请稍后再试");
        if (active.current === currentId) commitBreadcrumb();
        const saved = await replacing.flush();
        if (superseded()) return;
        if (queues.current.get(currentId) !== replacing || queues.current.has(id)) break;
        if (!saved) { select(currentId); return; }
        if (active.current === currentId) commitBreadcrumb();
        if (locking.current.has(currentId)) throw new Error("当前标签页正在处理，请稍后再试");
        const { revision, savedRevision } = replacing.snapshot();
        if (revision !== savedRevision) continue;
        install(entry, replacing);
      }
      if (!queues.current.has(id)) install(entry);
      if (canvas) {
        // The outgoing canvas stays editable while the article is loading.
        await canvas.flush();
        if (superseded()) return;
      }
    }
    if (collectionMode) switchSection("folders");
    revealFolder(queues.current.get(id)!.snapshot().fields.categoryId);
    if (active.current === id) document.getElementById(`tab-${id}`)?.closest(".tab")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    select(id);
  }

  function switchTab(id: string, onSwitched?: () => void) {
    const view = ++viewIntent.current;
    afterCanvasSaved(() => {
      if (view !== viewIntent.current) return;
      ++selecting.current;
      if (collectionMode) switchSection("folders");
      select(id);
      onSwitched?.();
    });
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
    if (id === active.current) {
      const neighbor = next[index + 1] ?? next[index - 1];
      select(neighbor ?? null);
      if (!neighbor && !collectionMode && activeCollectionId) switchSection("collections");
    }
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

  function afterCanvasSaved(action: () => void) {
    const canvas = collectionCanvas.current;
    if (!canvas) { action(); return; }
    void waitForCollectionWrites().then(() => canvas.flush()).then(() => {
      if (!exit.current) action();
    }, showError);
  }

  function navigate(next: Section, onNavigated?: () => void) {
    const view = ++viewIntent.current;
    const apply = () => {
      if (view !== viewIntent.current) return;
      switchSection(next);
      onNavigated?.();
    };
    if (next === "collections") apply();
    else afterCanvasSaved(apply);
  }

  function switchSection(next: Section) {
    if (next === "collections" && !collectionMode) {
      commitBreadcrumb();
      if (active.current) void queues.current.get(active.current)?.flush();
    }
    if ((section === "folders" || section === "timeline" || collectionMode) && next !== section) {
      const field = document.activeElement;
      if (field instanceof HTMLElement && field.closest(".folder-inline, .folder-icon-picker, .entry-inline")) field.blur();
      if (collectionMode) setCollectionDraft(undefined);
    }
    setSection(next);
    setFocusMode(false);
    if (!explorer) setExplorerOverride(true);
    if (next !== section) {
      setPage(null); setListError("");
    }
  }

  function chooseCollection(id: string) {
    setCollectionTabs(current => {
      const ids = current?.ids ?? [];
      return { ids: ids.includes(id) ? ids : [...ids, id], activeId: id };
    });
  }

  function openCollection(id: string) {
    const view = ++viewIntent.current;
    afterCanvasSaved(() => {
      if (view !== viewIntent.current) return;
      chooseCollection(id);
      switchSection("collections");
    });
  }

  function removeCollectionTab(id: string) {
    setCollectionTabs(current => {
      if (!current?.ids.includes(id)) return current;
      const index = current.ids.indexOf(id);
      const ids = current.ids.filter(tab => tab !== id);
      return { ids, activeId: current.activeId === id ? (ids[index] ?? ids[index - 1]) : current.activeId };
    });
  }

  function closeCollectionTab(id: string) {
    if (!collectionMode || activeCollectionId !== id) { removeCollectionTab(id); return; }
    const view = ++viewIntent.current;
    afterCanvasSaved(() => {
      removeCollectionTab(id);
      if (view === viewIntent.current && collectionTabs?.ids.length === 1 && active.current) switchSection("folders");
    });
  }

  function collapseCollections(collapsed: boolean) {
    setCollectionsCollapsed(collapsed);
    persist("collection-list-collapsed", collapsed);
  }

  function createCollection() {
    if (globalLock || exit.current) return;
    navigate("collections");
    collapseCollections(false);
    setCollectionDraft(current => current && !current.id ? current : {});
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
    navigate("search", () => requestAnimationFrame(() => searchInput.current?.focus()));
  }

  function invalidateSearch(clearHighlight: boolean) {
    ++filterEpoch.current;
    setPage(null);
    setListError("");
    if (clearHighlight) {
      ++searchIntent.current;
      if (selectedSearchHit) handles.current.get(selectedSearchHit.entryId)?.clearSearchHit();
      setSelectedSearchHit(undefined);
      setSearchJump(undefined);
    }
  }

  function openSearchHit(entryId: string, hit: WorkspaceSearchHit, version: number, showContext: boolean) {
    run(async () => {
      const ticket = selecting.current + 1;
      const view = viewIntent.current + 1;
      const intent = ++searchIntent.current;
      const isCurrent = () => intent === searchIntent.current && ticket === selecting.current && view === viewIntent.current &&
        active.current === entryId && !exit.current;
      await open(entryId);
      if (!isCurrent()) return;
      const queue = queues.current.get(entryId)!;
      if (!queue.isDirty() && queue.snapshot().version < version) {
        const latest = await desktop.entry(entryId);
        if (!isCurrent() || queues.current.get(entryId) !== queue) return;
        if (!queue.isDirty()) {
          handles.current.delete(entryId);
          queue.dispose();
          install(latest);
        }
      }
      updateDocumentOptions(entryId, { view: "edit" });
      setSearchJump({ entryId, hit, version, showContext });
    });
  }

  function toggleExplorer(event: MouseEvent<HTMLButtonElement>) {
    setExplorerOverride(!explorer);
    if (event.detail === 0) requestAnimationFrame(() => {
      document.getElementById(explorer ? "show-sidebar" : "hide-sidebar")?.focus({ preventScroll: true });
    });
  }

  function rememberAiWidth(width: number) {
    const pixels = Math.round(width);
    if (pixels >= minimumAiWidth) {
      aiSidebarWidth.current = pixels;
      persist("ai-sidebar-width", pixels);
    }
  }

  function changeDirectoryMode(mode: TimelineDirectory) {
    if (directoryMode.current === mode) return;
    directoryMode.current = mode;
    setTimelineDirectory(mode);
  }

  function fitTimelineDirectory(totalWidth: number) {
    if (directoryMode.current === "manual") return false;
    const fits = Math.round(totalWidth) >= preferredDirectoryWidth.current + dividerWidth + minimumTimelineWidth;
    changeDirectoryMode(fits ? "shown" : "auto");
    return fits;
  }

  function rememberTimelineWidth(totalWidth: number) {
    const fits = fitTimelineDirectory(totalWidth);
    const articleWidth = Math.round(totalWidth - (fits ? preferredDirectoryWidth.current + dividerWidth : 0));
    if (articleWidth >= minimumTimelineWidth) {
      timelineWidth.current = articleWidth;
      persist("timeline-article-width", articleWidth);
    }
  }

  function timelineNavigationWidth(layout = workspacePanels.current!.getLayout()) {
    const group = sidebarGroup.current!;
    const available = group.clientWidth - dividerWidth * group.querySelectorAll(":scope > [data-separator]").length;
    return available * layout.navigation / 100;
  }

  function preferredNavigationWidth() {
    return timelineMode
      ? timelineWidth.current + (directoryMode.current === "shown" ? preferredDirectoryWidth.current + dividerWidth : 0)
      : navigationWidth.current;
  }

  function maxTimelineNavigationWidth() {
    const available = sidebarGroup.current!.clientWidth - dividerWidth * (showAiPanel ? 2 : 1);
    const aiShare = showAiPanel ? workspacePanels.current!.getLayout()["ai-sidebar"] / 100 : 0;
    return available * (1 - aiShare) - minimumWritingWidth;
  }

  function stopDirectoryTransition() {
    window.clearTimeout(directoryTransition.current);
    if (sidebarGroup.current) delete sidebarGroup.current.dataset.timelineDirectoryMoving;
  }

  function toggleTimelineDirectory(restoreFocus: boolean) {
    const hidden = directoryMode.current !== "shown";
    const total = Math.round(timelineNavigationWidth());
    const maxWidth = maxTimelineNavigationWidth();
    let directory = preferredDirectoryWidth.current;
    if (hidden && sidebarGroup.current!.clientWidth) {
      directory = Math.min(directory, Math.floor(maxWidth - minimumTimelineWidth - dividerWidth));
      if (directory < minimumDirectoryWidth) {
        setNotice({ type: "info", text: "窗口宽度不足，无法展开目录栏" });
        return;
      }
      if (directory !== preferredDirectoryWidth.current) {
        preferredDirectoryWidth.current = directory;
        setDirectoryWidth(directory);
        persist("timeline-directory-width", directory);
      }
    }
    const directorySpace = directory + dividerWidth;
    const article = Math.max(minimumTimelineWidth, total - (hidden ? 0 : directorySpace));
    const width = hidden && maxWidth > 0 ? Math.min(article, maxWidth - directorySpace) : article;
    const group = sidebarGroup.current!;
    stopDirectoryTransition();
    group.dataset.timelineDirectoryMoving = "true";
    directoryTransition.current = window.setTimeout(() => {
      stopDirectoryTransition();
      if (timelineLayoutReady.current && !layoutSuspended.current && hasWorkspaceSize(group)) rememberTimelineWidth(timelineNavigationWidth());
    }, directoryTransitionMs + 20);
    changeDirectoryMode(hidden ? "shown" : "manual");
    timelineWidth.current = width;
    persist("timeline-article-width", width);
    sidebarPanel.current!.resize(width + (hidden ? directorySpace : 0));
    if (restoreFocus) requestAnimationFrame(() => {
      document.getElementById(hidden ? "hide-timeline-directory" : "show-timeline-directory")?.focus({ preventScroll: true });
    });
  }

  function resizeTimelineDirectory(requested: number, articleWidth: number) {
    const maxWidth = maxTimelineNavigationWidth() - articleWidth - dividerWidth;
    const width = Math.round(Math.max(minimumDirectoryWidth, Math.min(requested, maxWidth)));
    preferredDirectoryWidth.current = width;
    setDirectoryWidth(width);
    sidebarPanel.current!.resize(width + dividerWidth + articleWidth);
    return width;
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

  function saveCollection(collection: Collection | undefined, title: string, description: string) {
    const pending = waitForCollectionWrites();
    const canvas = collectionCanvas.current;
    const view = viewIntent.current;
    return trackCollectionWrite((async () => {
      await pending;
      await canvas?.flush();
      const saved = await desktop.saveCollection(collection?.id ?? null, title, description);
      collectionListRevision.current++;
      setCollections(current => collection ? current?.map(item => item.id === saved.id ? saved : item) ?? [] : [...(current ?? []), saved]);
      if (!collection && view === viewIntent.current && !exit.current) {
        try { await canvas?.flush(); }
        catch (error) { showError(error); return; }
        if (view === viewIntent.current && !exit.current) chooseCollection(saved.id);
      }
    })());
  }

  async function deleteCollection(collection: Collection) {
    await collectionCanvas.current?.flush();
    await waitForCollectionWrites();
    await trackCollectionWrite(desktop.deleteCollection(collection.id));
    collectionListRevision.current++;
    setCollections(current => current?.filter(item => item.id !== collection.id) ?? []);
    removeCollectionTab(collection.id);
  }

  function onOpenCollectionEntry(id: string) {
    run(() => open(id, "new-tab"));
  }

  async function loadCollectionArticle(id: string) {
    if (locking.current.has(id)) throw new Error("文章正在处理，请稍后再试");
    const queue = queues.current.get(id);
    if (queue && !await queue.flush()) throw queue.saveError();
    const entry = await desktop.entry(id);
    if (entry.deletedAt !== null) throw new Error("文章已移入回收站");
    return entry;
  }

  async function saveCollectionArticle(id: string, version: number, fields: EntryFields, mode: SaveMode): Promise<SaveResult> {
    if (locking.current.has(id)) throw new Error("文章正在处理，请稍后再试");
    let saved: SaveResult;
    await withEntryLock(id, async () => {
      const tab = queues.current.get(id);
      if (tab && !await tab.flush()) throw tab.saveError();
      saved = await desktop.save(id, version, fields, mode);
      if (tab && queues.current.get(id) === tab) {
        tab.dispose();
        install({ ...tab.entry, ...fields, version: saved.version });
      }
    });
    return saved!;
  }

  function addToCollection(entryId: string, collection: Collection) {
    if (globalLock || exit.current) return;
    const pending = waitForCollectionWrites();
    const isCurrentCanvas = collectionMode && activeCollectionId === collection.id;
    const live = isCurrentCanvas ? collectionCanvas.current : null;
    run(() => documentButtons.run(`addToCollection:${entryId}:${collection.id}`, () => trackCollectionWrite((async () => {
      await pending;
      if (live && collectionCanvas.current === live) await live.addEntry(entryId);
      else {
        const canvas = await desktop.collectionCanvas(collection.id);
        const { x, y, zoom } = canvas.collection.viewport;
        const position = { x: Math.round(-x / zoom) + 24, y: Math.round(-y / zoom) + 24 };
        const nodes = [...canvas.nodes].sort((first, second) => first.y - second.y);
        for (const node of nodes) {
          if (node.x < position.x + 336 && node.x + node.width + 16 > position.x &&
            node.y < position.y + 160 && node.y + node.height + 16 > position.y) position.y = node.y + node.height + 16;
        }
        await desktop.createCollectionNode(collection.id, { kind: "entry", entryId }, position);
        if (isCurrentCanvas) reloadCanvases([collection.id]);
      }

    })())));
  }

  function create(parent: string | null = currentFolder) {
    run(() => documentButtons.run(`create:${parent ?? "root"}`, async () => {
      const fields = parent ? {
        title: "", contentMd: "", status: "draft" as const, categoryId: parent, tags: [],
        summary: "", source: null, publishedAt: null, publishedUrl: "",
      } : undefined;
      activateCreated(await desktop.create("article", fields));
    }));
  }

  function importMarkdown(parent: string | null = currentFolder) {
    run(() => documentButtons.run(`importMarkdown:${parent ?? "root"}`, async () => {
      const result = await trackAssetTask(desktop.importMarkdown(parent));
      if (!result || exit.current) return false;
      activateCreated(result.entry);
      if (result.unavailableImages) showError(`已导入文档，${result.unavailableImages} 张图片未能加入上传队列。`);
    }));
  }

  function pasteWebClipping(text: string) {
    const parsed = parseWebClipping(text);
    if (!parsed) return false;
    const { unavailableAttachments, ...clipping } = parsed;
    const parent = currentFolder;
    run(async () => {
      const result = await trackAssetTask(desktop.importClipping(clipping, parent, downloadPastedImages));
      if (exit.current) return;
      if (result.deleted) throw new Error("该链接已收录，请先从回收站恢复");
      refresh();
      await open(result.entryId, "new-tab");
      const details: string[] = [];
      if (!result.existing && result.unavailableImages) details.push(`${result.unavailableImages} 张图片未能下载，已保留原链接`);
      if (!result.existing && unavailableAttachments.length) details.push(`${unavailableAttachments.length} 个本地附件缺少文件，已保留引用`);
      if (details.length) setNotice({ type: "info", text: `已导入剪藏文章，${details.join("；")}` });
    });
    return true;
  }

  function removePurgedEntries(ids: string[]) {
    for (const id of ids) if (queues.current.has(id)) remove(id);
    reloadCanvases(collectionTabs?.ids ?? []);
    refresh();
    setAssetsRevision(value => value + 1);
  }

  async function clearTrash() {
    flushSync(() => setGlobalLock(true));
    try {
      const ids = await desktop.emptyTrash();
      removePurgedEntries(ids);

    } finally { setGlobalLock(false); }
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
    return documentButtons.run("export", async () => {
      const path = await desktop.exportMarkdown(id);
      if (path) setExportedPath(path);
      return path || false;
    });
  }

  function entryAction(row: EntryRow, action: EntryRowAction, trigger = document.getElementById(`entry-row-${row.id}`)) {
    run(() => documentButtons.run(`${action}:${row.id}`, async () => {
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

        }
      }
    }));
  }

  function tabAction(id: string, action: TabAction) {
    const queue = queues.current.get(id)!;
    const trigger = document.getElementById(`tab-${id}`);
    switch (action) {
      case "closeOthers":
        switchTab(id, () => {
          setCollectionTabs({ ids: [] });
          run(() => closeTabs([...queues.current.keys()].filter(other => other !== id)));
        });
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
    if (value.type === "settings") settingsPage.current = value.page;
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
    else run(async () => {
      const hasChildren = library?.categories.some(category => category.parentId === target.id);
      const contents = await desktop.entries({ categoryId: target.id, exactCategory: true, deleted: false, offset: 0, limit: 1 });
      if (!hasChildren && !contents.items.length) await deleteCategory(target, false);
      else showModal({ type: "deleteCategory", target }, document.getElementById(`folder-row-${target.id}`));
    });
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

  async function deleteCategory(target: Category, trashContents: boolean) {
    const removed = new Set([target.id, ...(trashContents ? library?.categories ?? [] : []).filter(cat => cat.parentId === target.id).map(cat => cat.id)]);
    commitBreadcrumb();
    flushSync(() => setGlobalLock(true));
    try {
      const failed = (await waitForCollectionWrites()).find(write => write.status === "rejected");
      if (failed) throw failed.reason;
      await collectionCanvas.current?.flush();
      const saved = await Promise.all([...queues.current.values()].map(queue => queue.flush()));
      if (saved.some(result => !result)) throw new Error("文稿未能保存，请先处理保存错误");
      const moved = await desktop.deleteCategory(target.id, trashContents ? "trash" : "promote");
      for (const change of moved) {
        if (trashContents && queues.current.has(change.id)) remove(change.id);
        else queues.current.get(change.id)?.categoryMoved(change.categoryId, change.version);
      }
      if (categoryId && removed.has(categoryId)) setCategoryId(undefined);
      setTimelineSelection(selection => selection.kind === "folder" && removed.has(selection.id) ? { kind: "root" } : selection);
      setExpandedFolders(current => current.filter(id => !removed.has(id)));
      if (trashContents) reloadCanvases(collectionTabs?.ids ?? []);
      refresh();
    } finally { setGlobalLock(false); }
  }

  const copy = desktop.copyText;

  const selected = activeId ? queues.current.get(activeId) : undefined;
  const outlineOpen = (activeId ? documentOptions.get(activeId)?.outline : undefined) ?? defaultOutline;
  const outlineEditor = outlineOpen && viewMode === "edit" && activeId ? handles.current.get(activeId) : undefined;
  const displayFor = (id: string | null): EditorDisplay => ({
    ...editorDisplay, convertLinks: (id ? documentOptions.get(id)?.convertLinks : undefined) ?? defaultConvertLinks,
  });
  const display = displayFor(activeId);
  const projectLinks = display.convertLinks ? (activeId ? handles.current.get(activeId)?.linkFootnoteMarkdown ?? null : null) : undefined;
  const showLinkImport = (parent: string | null = currentFolder) => showModal({ type: "linkImport", categoryId: parent });
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
        await collectionCanvas.current?.flush();
        const saved = await Promise.all([...queues.current.values()].map(queue => queue.flush()));
        if (!saved.every(Boolean)) throw new Error("有稿件尚未保存，请处理后重新备份");
        return await desktop.createBackup();
      })());
      setBackupListRevision(value => value + 1);
      setBackupFeedback(result.warning ? { error: true, text: result.warning } : null);
      if (result.warning) setNotice({ type: "error", text: result.warning });
      return true;
    } catch (error) {
      setBackupFeedback({ error: true, text: errorMessage(error) });
      showError(error);
      return false;
    }
    finally { setBackupWorking(null); }
  }

  async function prepareBackup(workspace: string, snapshot: BackupSnapshot, workspaceLabel: string) {
    setBackupWorking(backupProgress.download);
    setBackupFeedback(null);
    try {
      const ticket = await trackAssetTask(desktop.prepareRestore(workspace, snapshot.name));
      if (exit.current) await desktop.discardRestore(ticket);
      else { setPreparedBackup({ ticket, snapshot, workspaceLabel }); return true; }
    } catch (error) {
      setBackupFeedback({ error: true, text: errorMessage(error) });
      showError(error);
      return false;
    }
    finally { setBackupWorking(null); }
  }

  async function transferWorkspace(action: "export" | "import") {
    setMigrationWorking(action);
    setMigrationFeedback(null);
    try {
      return await trackAssetTask((async () => {
        if (action === "export") {
          await collectionCanvas.current?.flush();
          const saved = await Promise.all([...queues.current.values()].map(queue => queue.flush()));
          if (!saved.every(Boolean)) throw new Error("有稿件尚未保存，请处理后重新导出");
          const path = await desktop.exportWorkspace(workspacePreferences());
          return path ? true : undefined;
        } else {
          const ticket = await desktop.importWorkspace();
          if (!ticket) return;
          if (exit.current) await desktop.discardRestore(ticket);
          else { setPreparedBackup({ ticket, migration: true }); return true; }
        }
      })());
    } catch (error) { setMigrationFeedback({ error: true, text: errorMessage(error) }); return false; }
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

  function openAi() {
    setFocusMode(false);
    if (timelineMode && timelineTooNarrow) setExplorerOverride(false);
    setAiOpen(true);
  }

  function toggleAi() {
    if (showAiPanel) setAiOpen(false);
    else openAi();
  }

  function publication(output: "clipboard" | "html") {
    if (!selected || publishing || exit.current) return;
    const key = output === "clipboard" ? "copyWechat" : "exportWechat";
    run(() => documentButtons.run(key, async () => {
      if (projectLinks === null) throw new Error("编辑器正在加载，请稍后重试");
      setPublishing(true);
      try {
        const { fields, revision } = selected.capture();
        const input = { output, revision, markdown: projectLinks?.(fields.contentMd) ?? fields.contentMd,
          themeId: fields.themeId, githubRepo: fields.source?.url };
        const { result, hosting, exportImages } = await renderForPublication(input);
        try {
          if (exit.current) return false;
          if (output === "html") {
            const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>公众号文章</title><body>${result.html}</body></html>`;
            return await desktop.exportWechatHtml(html, exportImages);
          }
          await desktop.copyHtml(result.html, result.text);
          if (!hosting && result.images.length) showModal({ type: "publishImages", images: result.images });
        } finally { result.dispose(); }
      } finally { setPublishing(false); }
    }));
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
    run(() => documentButtons.run("hostImages", async () => {
      setImageUpload({ sessionId, total: image ? 1 : 0, completed: 0 });
      try {
        const count = await trackAssetTask((async () => {
          if (!image) return editor.hostImages!(upload, src => canHostImage(target, src), total => update({ total }));
          image.setUploading(true);
          try { return image.replaceSource(await upload(image.src)) ? 1 : 0; }
          finally { image.setUploading(false); }
        })());
        if (count && !await origin.flush()) throw origin.snapshot().error ?? new Error("图片链接未能保存，请重试保存");
        return count > 0;
      } finally { setImageUpload(null); }
    }));
  }
  const actions: DocumentActions = {
    feedback: documentButtons, exportedPath, onRevealExport: () => run(() => documentButtons.run("revealExport", () => desktop.revealFile(exportedPath))),
    mode: viewMode, setMode: view, focusMode, onFocusMode: () => setFocusMode(value => !value),
    reading, onReading: toggleReading,
    outlineOpen, onOutline: checked => { if (activeId) updateDocumentOptions(activeId, { outline: checked }); },
    onPalette: () => showModal({ type: "palette" }),
    onAi: toggleAi, aiOpen: showAiPanel,
    onSave: () => {
      if (!reading && selected?.entry.deletedAt === null) {
        commitBreadcrumb();
        run(() => documentButtons.run("save", () => selected.flush({ manual: true, retry: true })));
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
      if (selected) run(() => documentButtons.run("exportAssets", async () => {
        if (!await selected.flush()) return false;
        return desktop.assetExport(selected.entry.id);
      }));
    },
    onExportWechat: () => publication("html"),
    onCopyWechat: () => publication("clipboard"),
    onCopyMarkdown: () => {
      if (selected) run(() => documentButtons.run("copyMarkdown", () => copy(selected.capture().fields.contentMd)));
    },
    onHostImages: selected && imageTarget ? () => hostDocumentImages(selected) : undefined,
    hostingImages: Boolean(imageUpload) || documentButtons.isLocked("hostImages"),
    publishing,
    onDelete: () => { if (selected) run(() => changeDeleted(selected.entry.id, selected.entry.deletedAt === null)); },
    onDraft: () => { if (selected) run(() => documentButtons.run("draft", () => saveConflictCopy(selected.entry.id))); },
    onCopy: () => {
      if (selected) run(() => documentButtons.run("copyMarkdown", () => copy(selected.capture().fields.contentMd)));
    },
    onReload: () => showModal({ type: "reload" }),
    onRetry: () => { if (selected) run(() => documentButtons.run("retrySave", () => selected.flush({ retry: true }))); },
  };
  function cycleView() { view(viewMode === "edit" ? "preview" : "edit"); }

  const commands: PaletteCommand[] = [
    { name: "新建笔记", keys: commandKey + "N", run: () => create() },
    { name: "新建专题", run: createCollection },
    { name: "导入链接", run: () => showLinkImport() },
    { name: "导入 Markdown", run: () => importMarkdown() },
    { name: "设置", run: () => openSettings() },
    { name: "MCP 服务设置", run: () => openSettings("mcp") },
    { name: "AI 代理设置", run: showModel },
    { name: "数据库备份", run: openBackups },
    ...(!reading && !collectionMode ? [{ name: "切换 AI 助手", run: toggleAi }] : []),
    { name: "全文搜索", keys: commandKey + "Shift+F", run: openSearch },
    { name: "打开内容目录", run: () => navigate("folders") },
    { name: "打开专题", run: () => navigate("collections") },
    { name: "打开回收站", run: () => navigate("trash") },
  ];
  if (selected && !collectionMode) commands.push(
    { name: reading ? "退出阅读模式" : "进入阅读模式", run: toggleReading },
    { name: "切换编辑视图", run: cycleView },
    { name: "查找与替换", keys: commandKey + "F", run: actions.onSearch },
    { name: "导出 Markdown", run: actions.onExport },
    { name: "复制公众号格式", run: actions.onCopyWechat },
    { name: "导出排版 HTML", run: actions.onExportWechat },
  );

  const shortcutEvent = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || exit.current || modal || event.defaultPrevented) return;
    if (selected && !collectionMode && matchesViewShortcut(shortcut, event)) {
      event.preventDefault();
      if (!event.repeat) cycleView();
      return;
    }
    const mod = commandKey === "⌘" ? event.metaKey : event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (event.altKey) return;
    const command = key === "k" && !event.shiftKey ? actions.onPalette
      : key === "n" && !event.shiftKey ? () => create()
        : key === "s" && !event.shiftKey && !collectionMode ? actions.onSave
          : key === "f" && event.shiftKey ? openSearch
            : key === "f" && selected && !collectionMode ? actions.onSearch : undefined;
    if (command) { event.preventDefault(); if (!event.repeat) command(); }
  });

  async function finishWorkspace(ticket?: string, updating = false) {
    if (exit.current) return;
    const attempt = { cancelled: false, restoring: ticket !== undefined };
    exit.current = attempt;
    let committed = false;
    (document.activeElement as HTMLElement | null)?.blur();
    setExitMessage(updating ? "正在保存并准备更新…" : attempt.restoring ? "正在保存并停止工作区…" : "正在保存并退出…");
    try {
      const failedWrite = (await waitForCollectionWrites()).find(write => write.status === "rejected");
      if (failedWrite) throw failedWrite.reason;
      await collectionCanvas.current?.flush();
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
        } else if (updating) {
          setRestoreRestarting(true);
          setExitMessage("正在安装更新…");
          await desktop.appUpdateInstall();
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
  const hiding = useRef(false);
  const hideEvent = useEffectEvent(async () => {
    if (hiding.current || exit.current) return;
    hiding.current = true;
    flushSync(() => setGlobalLock(true));
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      await flushWorkspaceForSync();
      await desktop.confirmHide();
    } catch (error) {
      await desktop.cancelHide();
      showError(error);
    } finally {
      hiding.current = false;
      setGlobalLock(false);
    }
  });
  const trashEmptiedEvent = useEffectEvent(removePurgedEntries);
  const clipboardEvent = useEffectEvent((action: ClipboardAction, target: EventTarget | null, plainText?: boolean) => {
    if (exit.current) return false;
    if (collectionMode) {
      const canvas = collectionCanvas.current;
      return (canvas?.clipboard(action, target, plainText) ?? false) || (action === "paste" && (canvas?.paste(target) ?? false));
    }
    const activeId = active.current;
    if (activeId && handles.current.get(activeId)?.clipboard(action, editorClipboard, target, plainText)) return true;
    if (action !== "paste" || plainText || modal || globalLock || (target instanceof Element
      && target.closest("input, textarea, [contenteditable=true], [role=dialog]"))) return false;
    run(async () => {
      const content = await trackAssetTask(desktop.readClipboard(false));
      if (!exit.current && content?.kind === "text") pasteWebClipping(content.text);
    });
    return true;
  });

  useEffect(() => {
    function shortcut(event: KeyboardEvent) { shortcutEvent(event); }
    function blur() { if (active.current) void queues.current.get(active.current)?.flush(); }
    function preventFileNavigation(event: DragEvent) {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    }
    const detachClipboard = attachClipboard((action, target, plainText) => clipboardEvent(action, target, plainText), showError);
    const listener = desktop.onExit(() => { void closingEvent(); });
    const historyRequested = desktop.onHistory(editHistory);
    const hideRequested = desktop.onHideRequested(() => { void hideEvent(); });
    const workspaceChanged = desktop.onWorkspaceChanged(() => setRefreshCount(count => count + 1));
    const trashEmptied = desktop.onTrashEmptied(ids => trashEmptiedEvent(ids));
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
    for (const subscription of [listener, historyRequested, hideRequested, workspaceChanged, trashEmptied, assetsChanged, backupChanged]) void subscription.catch(showError);
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
      void historyRequested.then(unlisten => unlisten(), () => {});
      void hideRequested.then(unlisten => unlisten(), () => {});
      void workspaceChanged.then(unlisten => unlisten(), () => {});
      void trashEmptied.then(unlisten => unlisten(), () => {});
      void assetsChanged.then(unlisten => unlisten(), () => {});
      void backupChanged.then(unlisten => unlisten(), () => {});
      void mcpChanged.then(unlisten => unlisten(), () => {});
    };
  }, []);

  const queue = selected;
  const showExplorer = explorer && !focusMode;
  const showTimelineDirectory = showExplorer && timelineMode && timelineDirectory === "shown";
  const restorePanelSizes = useEffectEvent((group: HTMLDivElement) => {
    const available = group.clientWidth - dividerWidth * (Number(showExplorer) + Number(showAiPanel));
    const navigationLimit = available - minimumWritingWidth - (showAiPanel ? minimumAiWidth : 0);
    const navigation = showExplorer ? Math.min(preferredNavigationWidth(), navigationLimit) : 0;
    const aiLimit = Math.min(available / 2, available - minimumWritingWidth - navigation);
    const ai = showAiPanel ? Math.min(aiSidebarWidth.current, aiLimit) : 0;
    workspacePanels.current!.setLayout({
      navigation: navigation / available * 100,
      writing: (available - navigation - ai) / available * 100,
      "ai-sidebar": ai / available * 100,
    });
  });
  useLayoutEffect(() => {
    const group = sidebarGroup.current!;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // Windows can report its minimized taskbar size while the WebView is still visible.
      if (!hasWorkspaceSize(group)) {
        layoutSuspended.current = true;
      } else if (layoutSuspended.current && !frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (!hasWorkspaceSize(group)) return;
        restorePanelSizes(group);
        layoutSuspended.current = false;
      });
    });
    observer.observe(group);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  useLayoutEffect(() => {
    if (!macTitleBar) return;
    const group = sidebarGroup.current!;
    const navigation = navigationElement.current!;
    // The panel's rendered width changes throughout the flex transition.
    const reserveTitlebarSpace = (width: number) => group.style.setProperty("--navigation-width", `${width}px`);
    reserveTitlebarSpace(navigation.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => reserveTitlebarSpace(entry.contentRect.width));
    observer.observe(navigation);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!windowsTitleBar) return;
    const group = sidebarGroup.current!;
    const chrome = writingChrome.current!;
    const reserveControls = () => {
      const space = group.getBoundingClientRect().right - chrome.getBoundingClientRect().right;
      chrome.style.setProperty("--chrome-trailing-space", `${space}px`);
    };
    reserveControls();
    const observer = new ResizeObserver(reserveControls);
    observer.observe(group, { box: "border-box" });
    observer.observe(chrome, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const panel = sidebarPanel.current!;
    const group = sidebarGroup.current!;
    const target = preferredNavigationWidth();
    timelineLayoutReady.current = false;
    if (!hasWorkspaceSize(group)) return;
    if (!showExplorer && panel.isCollapsed()) return;

    let frame = 0;
    let resize = 0;
    let settled = 0;
    group.dataset.sidebarRestoring = "true";
    const animate = showExplorer === panel.isCollapsed();
    if (animate) group.dataset.sidebarMoving = "true";
    const timer = animate ? window.setTimeout(() => { delete group.dataset.sidebarMoving; }, 220) : 0;
    const clear = () => {
      delete group.dataset.sidebarRestoring;
      delete group.dataset.sidebarMoving;
    };
    frame = requestAnimationFrame(() => {
      resize = requestAnimationFrame(() => {
        if (!hasWorkspaceSize(group)) { clear(); return; }
        if (showExplorer) panel.resize(target);
        else panel.collapse();
        settled = requestAnimationFrame(() => {
          delete group.dataset.sidebarRestoring;
          timelineLayoutReady.current = timelineMode && showExplorer;
          if (timelineLayoutReady.current && !layoutSuspended.current && hasWorkspaceSize(group)) rememberTimelineWidth(timelineNavigationWidth());
        });
      });
    });
    return () => {
      timelineLayoutReady.current = false;
      directoryDrag.current = null;
      stopDirectoryTransition();
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resize);
      cancelAnimationFrame(settled);
      clear();
    };
  }, [showExplorer, timelineMode, sidebarPanel]);
  useLayoutEffect(() => {
    const panel = aiSidebarPanel.current!;
    const group = sidebarGroup.current!;
    if (!hasWorkspaceSize(group)) return;
    if (showAiPanel !== panel.isCollapsed()) return;
    group.dataset.aiSidebarMoving = "true";
    if (showAiPanel && !showExplorer) {
      const available = group.clientWidth - dividerWidth;
      const aiShare = Math.min(50, aiSidebarWidth.current / available * 100);
      workspacePanels.current!.setLayout({ navigation: 0, writing: 100 - aiShare, "ai-sidebar": aiShare });
    } else if (showAiPanel) panel.resize(aiSidebarWidth.current);
    else if (showExplorer) {
      const available = group.clientWidth - dividerWidth;
      const width = Math.min(preferredNavigationWidth(), available - minimumWritingWidth);
      const share = width / available * 100;
      workspacePanels.current!.setLayout({ navigation: share, writing: 100 - share, "ai-sidebar": 0 });
    } else panel.collapse();
    const clear = () => { delete group.dataset.aiSidebarMoving; };
    const timer = window.setTimeout(clear, 270);
    const frame = requestAnimationFrame(() => {
      if (showAiPanel && !layoutSuspended.current && hasWorkspaceSize(group)) {
        const available = group.clientWidth - dividerWidth * group.querySelectorAll(":scope > [data-separator]").length;
        rememberAiWidth(available * workspacePanels.current!.getLayout()["ai-sidebar"] / 100);
      }
    });
    return () => { window.clearTimeout(timer); cancelAnimationFrame(frame); clear(); };
  }, [showAiPanel, showExplorer, aiSidebarPanel, workspacePanels]);
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
    openAi();
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
    canChat={canChat} canEdit={canEditWithAi} tagSuggestions={library?.tagSuggestions} onClose={closeAi} onSettings={showModel}
    canSend={() => !exit.current}
    trackWrite={trackAssetTask}
    selectionRequest={aiChatSelection?.sessionId === queue?.sessionId ? aiChatSelection?.selection : undefined}
    canWrite={(origin, editor) => !exit.current && !reading && active.current === origin.entry.id
      && queues.current.get(origin.entry.id) === origin && handles.current.get(origin.entry.id) === editor && !locking.current.has(origin.entry.id)} />;
  const toast = notice && <WorkspaceToast notice={notice} onReveal={path => run(() => desktop.revealFile(path))}
    onDismiss={target => setNotice(current => current === target ? null : current)} />;
  const workspaceNotice = modal?.type !== "settings" && toast;
  const rowActions: RowActions = {
    active: activeId, categories: library?.categories ?? [], readOnlyIds: [...readingIds, ...locked],
    treeLocked: globalLock, openMode: documentOpenMode, onOpen: (id, mode) => run(() => open(id, mode)),
    onRowAction: entryAction, onRenameEntry: renameEntry, onFolderError: showError, onMoveEntry: moveTreeEntry,
    collectionOptions: collections ?? [], onAddToCollection: addToCollection,
  };
  const hideSidebarButton = <Tool id="hide-sidebar" label="隐藏左侧栏" className="chrome-icon sidebar-toggle" onClick={toggleExplorer}>
    <SidebarToggleIcon expanded />
  </Tool>;
  const timelineDirectoryToggle = <Tool id={showTimelineDirectory ? "hide-timeline-directory" : "show-timeline-directory"}
    label={showTimelineDirectory ? "隐藏目录栏" : "展开目录栏"} className="chrome-icon sidebar-toggle"
    aria-expanded={showTimelineDirectory} aria-controls="timeline-directory" onClick={event => toggleTimelineDirectory(event.detail === 0)}>
    <SidebarToggleIcon expanded={showTimelineDirectory} />
  </Tool>;
  const navigationButtons = destinations.map(([target, Icon, label]) => <Tool key={target} label={label} className="chrome-icon"
    aria-current={target === section ? "page" : undefined} onClick={() => {
      if (target === "search") { openSearch(); return; }
      if (target === "folders" && section === "folders") revealFolder(null);
      navigate(target);
    }}>
    <Icon size={18} strokeWidth={1.8} />
  </Tool>);
  const sidebar = (
    <div className="sidebar-workspace" inert={!showExplorer || (timelineMode && !showTimelineDirectory)}>
      <nav className="sidebar-chrome chrome-band" aria-label="工作区导航">
        {(!timelineMode || showTimelineDirectory) && <>
          <div className="button-strip">{navigationButtons}</div>
          <WindowDragRegion onError={showError} />
          {!timelineMode && hideSidebarButton}
        </>}
      </nav>
      {section === "collections" ? <CollectionExplorer items={collections} activeId={activeCollectionId} error={collectionsError}
        locked={globalLock} collapsed={collectionsCollapsed} draft={collectionDraft} onToggle={() => collapseCollections(!collectionsCollapsed)}
        onSelect={id => { if (id !== activeCollectionId) openCollection(id); }} onCreate={createCollection} onRename={id => setCollectionDraft({ id })}
        onDelete={collection => showModal({ type: "deleteCollection", collection }, document.getElementById(`collection-row-${collection.id}`))}
        onSave={(collection, title) => saveCollection(collection, title, collection?.description ?? "")}
        onCloseEditor={() => setCollectionDraft(current => current === collectionDraft ? undefined : current)} onError={showError}
        onRetry={() => setCollectionsRetry(value => value + 1)} />
      : section === "assets" ? <AssetPanel onImport={files => importImages(files, "library")} onConfigure={() => openSettings("images")}
      canInsert={!reading && queue?.entry.deletedAt === null && !globalLock && !locked.includes(queue.entry.id)}
      canCover={!reading && Boolean(queue && queue.entry.deletedAt === null && !globalLock && !locked.includes(queue.entry.id))}
      onInsert={(id, name) => {
        if (viewMode === "preview") view("edit");
        if (active.current) handles.current.get(active.current)?.insert("\n" + imageMarkdown(id, name) + "\n");
      }}
      onCover={id => {
        if (queue) {
          queue.edit({ coverAssetId: id });
          return queue.flush();
        }
      }} />
      : <Explorer {...rowActions} ref={explorerTree} section={section} library={library} page={page}
        onEmptyTrash={() => showModal({ type: "emptyTrash" }, document.getElementById("empty-trash"))}
        activeFolder={queue?.entry.deletedAt === null ? queue.snapshot().fields.categoryId : undefined}
        timelineSelection={timelineSelection} onTimelineSelect={setTimelineSelection} includeTimelineChildren={includeTimelineChildren}
        directoryTrailingAction={showTimelineDirectory ? timelineDirectoryToggle : undefined}
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
        searchSort={searchSort} selectedSearchHit={selectedSearchHit} onSearchHit={openSearchHit}
        onSearchSort={sort => { setSearchSort(sort); persist("workspace-search-sort", sort); invalidateSearch(false); }}
        onQuery={value => { if (value !== query) { setQuery(value); invalidateSearch(true); } }}
        onCaseSensitive={value => { if (value !== caseSensitive) { setCaseSensitive(value); invalidateSearch(true); } }}
        onFolder={section === "timeline" ? toggleFolderExpanded : toggleFolder}
        onImportLink={showLinkImport} onImportMarkdown={importMarkdown}
        onCreate={create} onRevealFolder={revealFolder} onSaveFolder={saveFolder}
        onReorderFolder={reorderFolder} onReorderEntry={reorderEntry}
        onCategoryAction={categoryAction} onMore={more} />}
    </div>
  );
  return <Theme appearance={dark ? "dark" : "light"} accentColor="indigo"
    grayColor="slate" radius="small" scaling="95%" panelBackground="solid" className="theme-root">
    <div className="workspace-shell" data-mac-titlebar={macTitleBar || undefined} data-windows-titlebar={windowsTitleBar || undefined}
      inert={Boolean(exitMessage)}>
      <Group id="workspace-panels" className="workspace-panels" orientation="horizontal" elementRef={sidebarGroup} groupRef={workspacePanels}
        resizeTargetMinimumSize={dividerHitTarget}
        onLayoutChange={layout => {
          const group = sidebarGroup.current;
          if (timelineLayoutReady.current && !layoutSuspended.current && hasWorkspaceSize(group) && !group.dataset.timelineDirectoryMoving
            && !directoryDrag.current) fitTimelineDirectory(timelineNavigationWidth(layout));
        }}
        onLayoutChanged={layout => {
          const group = sidebarGroup.current;
          if (layoutSuspended.current || !hasWorkspaceSize(group) || group.dataset.timelineDirectoryMoving) return;
          const available = group.clientWidth - dividerWidth * (Number(showExplorer) + Number(showAiPanel));
          const moving = group.dataset.sidebarMoving || group.dataset.sidebarRestoring || group.dataset.aiSidebarMoving;
          if (showAiPanel && !moving) rememberAiWidth(available * layout["ai-sidebar"] / 100);
          if (!showExplorer || moving) return;
          const width = Math.round(available * layout.navigation / 100);
          if (timelineMode) {
            if (timelineLayoutReady.current && !directoryDrag.current) rememberTimelineWidth(width);
          } else if (width >= minimumNavigationWidth) {
            navigationWidth.current = width;
            persist("navigation-width", width);
          }
        }}>
          <Panel id="navigation" defaultSize={initialSidebarSize}
            minSize={timelineMode ? minimumTimelineWidth : minimumNavigationWidth}
            collapsible={!timelineMode || !showExplorer} collapsedSize="0px" panelRef={sidebarPanel} elementRef={navigationElement}
            style={{ overflow: "hidden" }} groupResizeBehavior="preserve-pixel-size"
            onResize={(size, _id, previous) => {
              if (!timelineMode && showExplorer && previous?.inPixels && !size.inPixels
                && !layoutSuspended.current && hasWorkspaceSize(sidebarGroup.current)
                && !sidebarGroup.current.dataset.sidebarRestoring) setExplorerOverride(false);
            }}>
            {timelineMode ? <div className="timeline-navigation">
              <div id="timeline-directory" style={{ flexBasis: showTimelineDirectory ? directoryWidth : 0 }}>
                {sidebar}
              </div>
              {showTimelineDirectory && <div id="resize-timeline-directory" role="separator" tabIndex={0}
                className="divider sidebar-divider navigation-divider timeline-directory-divider"
                aria-label="调整目录栏宽度" aria-controls="timeline-directory" aria-orientation="vertical"
                aria-valuenow={Math.round(directoryWidth / window.innerWidth * 100)} aria-valuetext={directoryWidth + " 像素"}
                onPointerDown={event => {
                  if (!event.isPrimary || event.button !== 0) return;
                  event.preventDefault();
                  stopDirectoryTransition();
                  event.currentTarget.focus({ preventScroll: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  directoryDrag.current = {
                    pointerId: event.pointerId, startX: event.clientX, width: directoryWidth, currentWidth: directoryWidth,
                    articleWidth: Math.round(timelineNavigationWidth()) - directoryWidth - dividerWidth,
                  };
                }}
                onPointerMove={event => {
                  const drag = directoryDrag.current;
                  if (drag?.pointerId !== event.pointerId) return;
                  const width = drag.width + event.clientX - drag.startX;
                  if (width < minimumDirectoryWidth / 2) {
                    persist("timeline-directory-width", drag.currentWidth);
                    directoryDrag.current = null;
                    toggleTimelineDirectory(true);
                  } else drag.currentWidth = resizeTimelineDirectory(width, drag.articleWidth);
                }}
                onLostPointerCapture={() => {
                  const drag = directoryDrag.current;
                  if (!drag) return;
                  directoryDrag.current = null;
                  persist("timeline-directory-width", drag.currentWidth);
                }}
                onKeyDown={event => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    toggleTimelineDirectory(true);
                    return;
                  }
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const articleWidth = Math.round(timelineNavigationWidth()) - directoryWidth - dividerWidth;
                  const step = event.shiftKey ? 40 : 16;
                  const width = resizeTimelineDirectory(directoryWidth + (event.key === "ArrowLeft" ? -step : step), articleWidth);
                  persist("timeline-directory-width", width);
                }} />}
              <div id="explorer" className="timeline-workspace" inert={!showExplorer}>
                  <Timeline root={timelineRoot} folder={timelineFolder} tag={timelineTag} untagged={timelineSelection.kind === "untagged"} tags={library?.tags ?? []}
                    workspaceId={navigationWorkspace === workspaceId ? workspaceId : undefined}
                    onSelectTag={(id, keyboard) => {
                      setTimelineSelection({ kind: "tag", id });
                      explorerTree.current?.revealTimelineTag(id, keyboard && timelineTag?.id !== id);
                    }}
                    includeChildren={includeTimelineChildren} onIncludeChildren={setIncludeTimelineChildren}
                    onPin={(id, pinned, scope) => run(async () => {
                      await desktop.setEntryPinned(id, pinned, scope);
                      refresh();
                    })}
                    revision={refreshCount} actions={rowActions} sidebarToggle={hideSidebarButton}
                    navigation={showTimelineDirectory ? undefined : <div className="button-strip">{navigationButtons}</div>}
                    directoryToggle={showTimelineDirectory ? undefined : timelineDirectoryToggle}
                    blankMenu={timelineFolder || timelineRoot ? {
                      disabled: globalLock || !library,
                      onCreate: () => create(currentFolder),
                      onImportLink: () => showLinkImport(currentFolder),
                      onImportMarkdown: () => importMarkdown(currentFolder),
                      onAddFolder: timelineFolder?.parentId ? undefined : () => explorerTree.current?.addFolder(currentFolder),
                    } : null} />
              </div>
            </div> : sidebar}
          </Panel>
          {showExplorer && <Separator className={`divider sidebar-divider${timelineMode ? " navigation-divider" : ""}`}
            disableDoubleClick aria-label={timelineMode ? "调整文章时间流宽度" : "调整资源导航宽度"}
            onPointerDown={timelineMode ? stopDirectoryTransition : undefined} />}
        <Panel id="writing" minSize={minimumWritingWidth} style={{ overflow: "hidden" }}>
          <main className="main-workspace" aria-label="写作工作区">
            <header className="workbench-chrome chrome-band" ref={writingChrome}>
              {!showExplorer && <Tool id="show-sidebar" className="chrome-icon sidebar-toggle restore-sidebar" label={focusMode ? "退出专注写作" : "显示左侧栏"}
                onClick={focusMode ? actions.onFocusMode : toggleExplorer}><SidebarToggleIcon /></Tool>}
              {(sessions.length > 0 || openCollections.length > 0) && <DocumentTabs sessions={sessions} activeId={collectionMode ? null : activeId}
                collections={openCollections} activeCollectionId={collectionMode ? activeCollectionId : undefined}
                onSwitchCollection={openCollection} onCloseCollection={closeCollectionTab} collectionOptions={collections ?? []}
                onAddToCollection={addToCollection} readingIds={readingIds} lockedIds={locked}
                categories={library?.categories ?? []} onMove={moveTreeEntry} onSwitch={switchTab} onClose={closeTab} onAction={tabAction}
                onReorder={reorderTab} onRename={renameEntry} onError={showError} />}
              {!focusMode && <CreateMenu onCreate={() => create()} onImportLink={() => showLinkImport()}
                onImportMarkdown={() => importMarkdown()}
                onCreateCollection={createCollection} disabled={globalLock} />}
              <WindowDragRegion onError={showError} />
              {!reading && !focusMode && !collectionMode && <Tool id="ai-panel-trigger" className="chrome-icon sidebar-toggle ai-panel-trigger"
                label={showAiPanel ? "隐藏 AI 侧栏" : "显示 AI 侧栏"} aria-expanded={showAiPanel}
                aria-controls="ai-sidebar" onClick={toggleAi}><SidebarToggleIcon side="right" expanded={showAiPanel} /></Tool>}
            </header>
            {collectionMode && <>
              {activeCollection ? <Suspense fallback={<div id="collection-canvas-panel" role="tabpanel"
                aria-labelledby={`collection-tab-${activeCollection.id}`} className="document-body collection-state"><span role="status">正在打开专题…</span></div>}>
                <CollectionCanvas key={`${activeCollection.id}:${canvasRevisions.get(activeCollection.id) ?? 0}`}
                  collection={activeCollection} dark={dark}
                  revision={refreshCount} articleLocked={globalLock} previewBlocked={Boolean(modal || exitMessage || globalLock)} clipboard={editorClipboard}
                  canvasRef={collectionCanvas} track={trackCollectionWrite} waitForWrites={waitForCollectionWrites}
                  onOpenEntry={onOpenCollectionEntry}
                  onLoadArticle={loadCollectionArticle} onSaveArticle={saveCollectionArticle} onArticleImages={importImages}
                  onDelete={() => showModal({ type: "deleteCollection", collection: activeCollection })}
                  downloadLinkImages={downloadPastedImages} onEntryCreated={linkImported} onError={showError} />
              </Suspense> : <div className="document-body">
                <div className="workbench-empty">
                  <Workflow size={25} strokeWidth={1.4} />
                  <h2>{collectionsError ? "无法读取专题" : !collections ? "正在读取专题…" : collections.length ? "选择专题" : "还没有专题"}</h2>
                  {collections?.length === 0 && <Button size="2" variant="soft" disabled={globalLock || Boolean(collectionsError)} onClick={createCollection}>新建专题</Button>}
                </div>
              </div>}
              {workspaceNotice}
            </>}
            <div className="workbench-document" hidden={collectionMode}>
            {queue ? <>
              <DocumentToolbar queue={queue} categories={library?.categories ?? []} actions={actions}
                locked={globalLock || locked.includes(queue.entry.id)}
                display={display} onDisplayChange={(option, checked) => updateEditorDisplay(queue.entry.id, option, checked)}
                onReveal={id => { navigate("folders"); revealDirectory(); revealFolder(id); }} />
              <div className="document-body" data-view={viewMode} data-outline-open={Boolean(outlineEditor) || undefined}
                id="document-body" role="tabpanel" aria-labelledby={`tab-${activeId}`}>
                <div className="editor-stack" hidden={viewMode === "preview"}>
                  {sessions.map(session => <DocumentEditor key={session.sessionId}
                    queue={session} active={!collectionMode && activeId === session.entry.id} reading={readingIds.includes(session.entry.id)}
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
                {outlineEditor && <Outline key={queue.sessionId} editor={outlineEditor}
                  readOnly={reading || Boolean(exitMessage) || globalLock || locked.includes(queue.entry.id) || queue.entry.deletedAt !== null}
                  onClose={() => {
                    actions.onOutline(false);
                    document.getElementById("document-action-trigger")?.focus();
                  }} />}
                {!collectionMode && workspaceNotice}
              </div>
              <DocumentSaveError key={queue.sessionId} queue={queue} actions={actions} />
            </> : <div className="document-body">
              <div className="workbench-empty">
                <FilePenLine size={25} strokeWidth={1.4} />
                <h2>还没有打开的内容</h2>
                <div className="button-strip workbench-empty-actions">
                  <Button size="2" variant="soft" onClick={() => create()}>新建笔记</Button>
                  <Button size="2" variant="soft" color="gray" onClick={() => showLinkImport()}>导入链接</Button>
                </div>
              </div>
              {!collectionMode && workspaceNotice}
            </div>}
            </div>
          </main>
        </Panel>
        {showAiPanel && <Separator className="divider ai-sidebar-divider"
          disableDoubleClick aria-label="调整 AI 侧栏宽度" />}
        <Panel id="ai-sidebar" defaultSize="0px" minSize={minimumAiWidth} maxSize="50%" collapsible collapsedSize="0px"
          panelRef={aiSidebarPanel} groupResizeBehavior="preserve-pixel-size" style={{ overflow: "hidden" }}
          onResize={(size, _id, previous) => {
            if (showAiPanel && previous?.inPixels && !size.inPixels && !layoutSuspended.current
              && hasWorkspaceSize(sidebarGroup.current) && !sidebarGroup.current.dataset.aiSidebarMoving) setAiOpen(false);
          }}>
          <div className="ai-sidebar" inert={!showAiPanel}>
            {(showAiPanel || aiVisited) && <Suspense fallback={null}>{aiPanel}</Suspense>}
          </div>
        </Panel>
      </Group>
      {windowsTitleBar && <WindowControls onError={showError} />}
      <StatusBar queue={collectionMode ? undefined : queue} actions={actions} trashActive={showExplorer && section === "trash"} settingsOpen={modal?.type === "settings"}
        syncBinding={syncState?.binding} syncActivity={syncState?.activity} syncError={automaticSyncError} syncWaitingReason={syncWaitingReason}
        onSync={trigger => openSettings("sync", trigger)}
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
        <SettingsDialog initialPage={modal.page} onPageChange={page => {
          if (settingsPage.current !== page) { settingsPage.current = page; wakeAutomaticSync.current?.(); }
        }}
          status={backupWorking ?? undefined} toast={notice?.type === "error" ? toast : undefined} onClose={closeModal} renderPage={page => {
          if (page === "about") return <AboutPage onInstall={() => finishWorkspace(undefined, true)} />;
          if (page === "model") return <ModelSettings settings={aiSettings} loadError={aiSettingsError}
            saving={savingAiSettings} onSave={saveAiSettings} />;
          if (page === "mcp") return <McpSettings status={mcpStatus} loadError={mcpLoadError} onStatus={setMcpStatus} />;
          if (page === "sync") return <SyncSettings onSync={runSync} onRebuild={rebuildSync} automaticError={automaticSyncError}
            waitingReason={syncWaitingReason} applicationBusy={globalLock} onBusyChange={busy => {
              syncSettingsBusy.current = busy; wakeAutomaticSync.current?.();
            }}
            onResolve={async (entityType, entityId, choice, remoteRevision, localGeneration) => {
              await applySync(() => desktop.syncResolve(entityType, entityId, choice, remoteRevision, localGeneration));
            }} />;
          if (page === "images") return <ImageStorageSettings track={trackAssetTask} />;
          if (page === "backups") return <BackupPanel busy={backupWorking !== null || migrationWorking !== null} progress={backupWorking ?? ""} feedback={backupFeedback}
            listRevision={backupListRevision} prepared={preparedBackup?.migration ? null : preparedBackup} onCreate={createBackup} onRestore={prepareBackup}
            onConfirmRestore={() => setConfirmRestore(true)} onDiscardRestore={discardPreparedRestore} />;
          if (page === "migration") return <MigrationPanel busy={backupWorking !== null || migrationWorking !== null}
            working={migrationWorking} feedback={migrationFeedback} prepared={preparedBackup?.migration === true}
            onTransfer={transferWorkspace} onConfirmRestore={() => setConfirmRestore(true)} onDiscardRestore={discardPreparedRestore} />;
          return <WorkspaceSettings page={page} appearance={appearance} shortcut={shortcut} preferredView={preferredView} explorer={defaultExplorer}
            downloadPastedImages={downloadPastedImages} convertLinks={defaultConvertLinks} defaultOutline={defaultOutline} documentOpenMode={documentOpenMode}
            folderLoading={folderLoading} folderPageSize={folderPageSize}
            onAppearance={value => { setAppearance(value); persist("appearance", value); }}
            onView={value => { setPreferredView(value); persist("view", value); }}
            onDownloadPastedImages={value => { setDownloadPastedImages(value); persist("download-pasted-images", value); }}
            onConvertLinks={value => { setDefaultConvertLinks(value); persist("links-to-footnotes", value); }}
            onDefaultOutline={value => { setDefaultOutline(value); persist("default-document-outline", value); }}
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
      {modal?.type === "linkImport" && <LinkImportDialog categoryId={modal.categoryId} downloadImages={downloadPastedImages}
        track={trackAssetTask} onClose={closeModal} onImported={linkImported} onOpen={id => {
        if (exit.current) return;
        closeModal();
        if (section !== "imports" && section !== "timeline") navigate("folders");
        run(() => open(id));
      }} />}
      {modal?.type === "deleteCollection" && <Confirm title="删除专题" text={`将删除「${modal.collection.title}」中的卡片和连线。引用的文章会保留。`}
        action="删除专题" onClose={closeModal} onConfirm={() => deleteCollection(modal.collection)} />}
      {modal?.type === "emptyTrash" && <Confirm title="清空回收站" text="将永久删除回收站中的全部内容及其历史版本，无法恢复。"
        action="清空回收站" onClose={closeModal} onConfirm={clearTrash} />}
      {modal?.type === "publishImages" && <PublishImagesDialog images={modal.images} onClose={closeModal} />}
      {modal?.type === "imageViewer" && <ImageViewer src={modal.src} alt={modal.alt} onClose={closeModal} />}
      {modal?.type === "palette" && <CommandPalette actions={commands} onClose={closeModal} onOpen={id => run(() => open(id))} />}
      {modal?.type === "properties" && <PropertiesDialog key={modal.id} id={modal.id} queue={queues.current.get(modal.id)}
        categories={library?.categories ?? []} tagSuggestions={library?.tagSuggestions ?? []}
        locked={globalLock || readingIds.includes(modal.id) || locked.includes(modal.id)}
        onSave={(entry, change) => trackAssetTask(saveEntryFields(entry, change))} onClose={closeModal} onOpen={id => run(() => open(id))}
        onOpenCollection={openCollection} />}
      {modal?.type === "revisions" && <RevisionsDialog id={modal.id} onClose={closeModal} onCopy={copy} />}
      {modal?.type === "deleteCategory" && <DeleteCategoryDialog target={modal.target}
        onClose={closeModal} onConfirm={trashContents => deleteCategory(modal.target, trashContents)} />}
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
  return <MarkdownPreview title={fields.title} markdown={fields.contentMd} themeId={fields.themeId} revision={revision}
    githubRepo={fields.source?.url} projectLinks={projectLinks} />;
}
