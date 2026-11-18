import { Channel, invoke } from "@tauri-apps/api/core";
import type { ThreadHistoryAdapter } from "@assistant-ui/react";
import type { AiContextScope } from "../../../packages/editor-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { SourceFragment } from "../../../packages/wechat-renderer";
import type {
  CanvasCardColor, CanvasEdge, CanvasGeometry, CanvasNode, CanvasNodeContent, CanvasPosition, CanvasViewport, Collection, CollectionCanvas,
  Category, CategoryIcon, CategoryPlacement, Entry, EntryFields, EntryFilter, EntryKind, EntryPage, Library, Revision, SaveMode, SaveResult,
} from "../../../packages/shared-types";

export interface ImageTarget { endpoint: string; region: string; bucket: string; prefix: string; publicBase: string }
export interface ImageSecret { accessKey: string; secretKey: string }
export interface ImageUploadOptions { filenameTemplate: string; quality: "original" | "high" | "standard" | "economy"; autoUpload: boolean }
export interface ActiveImageStorage extends ImageTarget { autoUpload: boolean }
export interface ExportImage { url: string; name: string }
export type BackupTarget = Omit<ImageTarget, "publicBase">;
export interface BackupSettings { target: BackupTarget | null; hasKey: boolean; currentWorkspace: string }
export interface BackupSnapshot { name: string; createdAt: number; bytes: number }
export type BackupStage = "snapshot" | "upload" | "download" | "validate";
export interface AssetRow {
  id: string; name: string; width: number | null; height: number | null; bytes: number | null;
  uploadStatus: "queued" | "running" | "retrying" | "completed" | "failed" | null;
  uploadError: string | null; cleanupError: string | null; publicUrl: string | null;
}
export interface AssetLibrary { items: AssetRow[]; target: ImageTarget | null; page: number; hasNext: boolean }
export interface UploadProgress { completed: number; total: number }
export interface WechatImportJob {
  id: string; url: string; status: "queued" | "running" | "completed" | "partial" | "needs_attention" | "failed";
  entryId: string | null; error: string | null; pendingImages: number;
}
export interface McpConfig { enabled: boolean; port: number; permission: "read" | "write" }
export interface McpStatus { config: McpConfig; running: boolean; error: string | null }
export interface SyncBinding { url: string; instanceId: string; epoch: string; deviceId: string; paused: boolean }
export interface SyncDevice { deviceId: string; name: string; createdAt: number; revokedAt: number | null }
export interface SyncDevices { currentDeviceId: string; devices: SyncDevice[] }
export interface SyncPairing { pairingToken: string; expiresAt: number }
export type SyncConnectMethod = "claim" | "pair";
export type SyncResolution = "cloud" | "local" | "copy";
export interface SyncApplied { changedEntries: string[]; changedCollections: string[] }
export interface SyncConflict {
  entityType: "entry" | "category" | "asset" | "collection" | "collection_node" | "collection_edge";
  entityId: string;
  reason: string;
  local: { title?: string; name?: string; contentMd?: string; label?: string } | null;
  remote: { title?: string; name?: string; contentMd?: string; label?: string } | null;
  resolvable: boolean;
  canKeepLocal: boolean;
  remoteRevision: number | null;
  localGeneration: number | null;
}
export type AiAgent = "codex" | "claude_code";
export type AiModelKind = "local" | "custom";
export type AiTarget = { kind: "agent"; id: AiAgent } | { kind: "model"; id: string };
export type AiSelection = { target: AiTarget; agentModel?: string };
export interface AiAgentModel { id: string; label: string }
export interface AiModelConfig { endpoint: string; model: string; timeoutSeconds: number }
export interface AiModel extends AiModelConfig { id: string; kind: AiModelKind; name: string }
export interface AiPreferences { enabled: boolean; defaultTarget: AiTarget | null; defaultAgentModel?: string }
export interface AiSettings {
  preferences: AiPreferences;
  models: AiModel[];
  agents: { id: AiAgent; installed: boolean }[];
}
export type AiOperation = "summary" | "titles" | "rewrite";
export type AiPropertyValues = Partial<Pick<EntryFields, "tags" | "summary" | "title">>;
export type AiPropertyField = keyof AiPropertyValues;
export interface AiTurn { user: string; assistant: string }
export type AiRequest = { id: string; title: string; text: string; prompt?: string } & Partial<AiSelection> & (
  { entryId: string; operation: AiOperation }
  | { entryId: string | null; operation: "chat"; prompt: string; history: AiTurn[];
    context?: { scope: AiContextScope; headingPath: string[] };
    properties?: { fields: AiPropertyField[]; tagSuggestions: string[] } }
);
export type AiResult = { candidates: string[]; description?: string } | { reply: string } | { properties: AiPropertyValues };
export type AiStreamEvent = { type: "started" } | { type: "delta"; text: string };
export type AiThread = { id: string; title: string; archived: boolean; updatedAt: number };
export type AiHistoryItem = Parameters<ThreadHistoryAdapter["append"]>[0];
export type AiProposalStatus = "pending" | "applied" | "rejected" | "conflicted";
type ClipboardContents = { kind: "text"; text: string }
  | { kind: "html"; html: string; text: string | null }
  | { kind: "images"; images: { id: string; name: string }[]; errors: string[] };

type WebPreviewBounds = CanvasGeometry & { clip: CanvasGeometry; layoutWidth: number };
export type CanvasPreviewKey = { collectionId: string; nodeId: string; url: string };
export type CanvasWebPage = { url: string; x: number; y: number };
type CanvasWebview = { action: "open"; url: string; session: number; bounds: WebPreviewBounds; zoom: number }
  | { action: "bounds"; bounds: WebPreviewBounds | null; zoom: number; resume: boolean; restoreScroll?: boolean }
  | { action: "cover"; rememberScroll?: boolean } | { action: "reveal" | "close" };

export const windowsTitleBar = /Win/.test(navigator.platform);
export const nativeWindow = () => getCurrentWindow();

export const desktop = {
  openLink: (url: string) => openUrl(url),
  gpuAcceleration: (enabled?: boolean) => invoke<boolean>("gpu_acceleration", { enabled }),
  library: (includeArticleCounts = false) => invoke<Library>("library", { includeArticleCounts }),
  entries: (filter: EntryFilter) => invoke<EntryPage>("entries", { filter }),
  entry: (id: string) => invoke<Entry>("get_entry", { id }),
  collections: () => invoke<Collection[]>("list_collections"),
  saveCollection: (id: string | null, title: string, description: string) =>
    invoke<Collection>("save_collection", { id, title, description }),
  deleteCollection: (id: string) => invoke<void>("delete_collection", { id }),
  collectionCanvas: (collectionId: string) => invoke<CollectionCanvas>("get_collection_canvas", { collectionId }),
  canvasWebview: (preview: CanvasWebview) => invoke<boolean>("canvas_webview", { preview }),
  canvasWebviewPage: (session: number, restore?: CanvasWebPage) =>
    invoke<CanvasWebPage | null>("canvas_webview_page", { session, restore }),
  canvasWebviewSnapshot: (rememberScroll: boolean, cache?: CanvasPreviewKey) =>
    invoke<ArrayBuffer>("canvas_webview_snapshot", { rememberScroll, cache }),
  canvasPreviewCacheRead: (key: CanvasPreviewKey) => invoke<ArrayBuffer>("canvas_preview_cache_read", { key }),
  onCanvasWebState: (callback: (event: "loading" | "loaded" | "escape") => void, session: number) =>
    listen<{ session: number; event: "loading" | "loaded" | "escape" }>("canvas-web-state", ({ payload }) => {
      if (payload.session === session) callback(payload.event);
    }),
  onCanvasWebTitle: (callback: (session: number, title: string) => void) =>
    listen<{ session: number; title: string }>("canvas-web-title", ({ payload }) => callback(payload.session, payload.title)),
  createCollectionNode: (collectionId: string, content: CanvasNodeContent, position: CanvasPosition) =>
    invoke<CanvasNode>("create_collection_node", { collectionId, content, position }),
  updateCollectionNodeText: (nodeId: string, contentMd: string) =>
    invoke<void>("update_collection_node_text", { nodeId, contentMd }),
  updateCollectionNodeColor: (nodeId: string, color: CanvasCardColor | null) =>
    invoke<void>("update_collection_node_color", { nodeId, color }),
  updateCollectionNodeGeometry: (updates: (CanvasGeometry & { nodeId: string })[]) =>
    invoke<void>("update_collection_node_geometry", { updates }),
  deleteCollectionNode: (nodeId: string) => invoke<void>("delete_collection_node", { nodeId }),
  convertCollectionText: (nodeId: string) => invoke<CanvasNode>("convert_collection_text", { nodeId }),
  createCollectionEdge: (collectionId: string, sourceNodeId: string, targetNodeId: string, label: string) =>
    invoke<CanvasEdge>("create_collection_edge", { collectionId, sourceNodeId, targetNodeId, label }),
  updateCollectionEdge: (edgeId: string, label: string) => invoke<void>("update_collection_edge", { edgeId, label }),
  deleteCollectionEdge: (edgeId: string) => invoke<void>("delete_collection_edge", { edgeId }),
  saveCollectionViewport: (collectionId: string, viewport: CanvasViewport) =>
    invoke<void>("save_collection_viewport", { collectionId, viewport }),
  entryCollections: (entryId: string) => invoke<Collection[]>("list_entry_collections", { entryId }),
  importGitHub: (url: string, categoryId: string | null) =>
    invoke<{ entryId: string; existing: boolean; deleted: boolean }>("github_import", { url, categoryId }),
  create: (kind: EntryKind, fields?: EntryFields, sourceEntryId?: string) => invoke<Entry>("create_entry", { kind, fields, sourceEntryId }),
  save: (id: string, expectedVersion: number, fields: EntryFields, mode: SaveMode) =>
    invoke<SaveResult>("save_entry", { id, expectedVersion, fields, mode }),
  setDeleted: (id: string, expectedVersion: number, deleted: boolean) => invoke<Entry>("set_deleted", { id, expectedVersion, deleted }),
  saveCategory: (id: string | null, parentId: string | null, name: string, icon: CategoryIcon) =>
    invoke<Category>("save_category", { id, parentId, name, icon }),
  deleteCategory: (id: string) => invoke<{ id: string; categoryId: string | null; version: number }[]>("delete_category", { id }),
  moveCategory: (id: string, up: boolean) => invoke<void>("move_category", { id, up }),
  reorderCategory: (id: string, anchor: string, placement: CategoryPlacement) =>
    invoke<void>("reorder_category", { id, anchor, placement }),
  reorderEntry: (id: string, anchor: string, placement: CategoryPlacement) =>
    invoke<void>("reorder_entry", { id, anchor, placement }),
  setEntryPinned: (id: string, pinned: boolean) => invoke<void>("set_entry_pinned", { id, pinned }),
  revisions: (id: string) => invoke<Revision[]>("revisions", { id }),
  exportMarkdown: (id: string) => invoke<string | null>("export_markdown", { id }),
  revealFile: (path: string) => revealItemInDir(path),
  copyText: (text: string) => invoke<void>("clipboard_write", { text }),
  readClipboard: (acceptImages: boolean, acceptHtml = false) =>
    invoke<ClipboardContents | null>("clipboard_read", { acceptImages, acceptHtml }),
  copyHtml: (html: string, text: string) => invoke<void>("clipboard_write_html", { html, text }),
  importWechat: (url: string, categoryId: string | null) => invoke<WechatImportJob>("wechat_import", { url, categoryId }),
  importMarkdown: (categoryId: string | null) => invoke<{ entry: Entry; unavailableImages: number } | null>("import_markdown", { categoryId }),
  importJobs: () => invoke<WechatImportJob[]>("wechat_import_jobs"),
  retryWechatImages: (entry: string) => invoke<WechatImportJob>("wechat_retry_images", { entry }),
  wechatGraphics: (markdown: string) => invoke<SourceFragment[]>("wechat_graphics", { markdown }),
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
  syncStatus: () => invoke<SyncBinding | null>("sync_status"),
  syncConnect: (url: string, name: string, method: SyncConnectMethod, code: string, rebuild?: boolean) =>
    invoke<SyncBinding>("sync_connect", { url, name, method, code, rebuild }),
  syncDevices: () => invoke<SyncDevices>("sync_devices"),
  syncCreatePairing: () => invoke<SyncPairing>("sync_create_pairing"),
  syncRevokeDevice: (deviceId: string) => invoke<void>("sync_revoke_device", { deviceId }),
  syncGenerateSecret: () => invoke<string>("sync_generate_secret"),
  syncRun: () => invoke<void>("sync_run"),
  syncActivity: () => invoke<{ pending: boolean; incoming: boolean } | null>("sync_activity"),
  syncApply: () => invoke<SyncApplied>("sync_apply"),
  syncRebuildStage: () => invoke<void>("sync_rebuild_stage"),
  syncRebuildApply: () => invoke<SyncApplied & { recoveryArchive: string }>("sync_rebuild_apply"),
  syncConflicts: () => invoke<SyncConflict[]>("sync_conflicts"),
  syncResolve: (entityType: SyncConflict["entityType"], entityId: string, choice: SyncResolution, remoteRevision: number, localGeneration: number) =>
    invoke<SyncApplied>("sync_resolve", { entityType, entityId, choice, remoteRevision, localGeneration }),
  onMcpStatusChanged: (callback: () => void) => listen("mcp-status-changed", callback),
  saveMcp: (config: McpConfig) => invoke<McpStatus>("mcp_save", { config }),
  mcpToken: (rotate: boolean) => invoke<void>("mcp_token", { rotate }),
  onWorkspaceChanged: (callback: () => void) => listen("workspace-changed", callback),
  aiSettings: () => invoke<AiSettings>("ai_settings"),
  aiAgentVersions: () => invoke<[AiAgent, string | null][]>("ai_agent_versions"),
  aiAgentModels: () => invoke<[AiAgent, AiAgentModel[]][]>("ai_agent_models"),
  saveAiPreferences: (preferences: AiPreferences) => invoke<AiSettings>("ai_save_preferences", { preferences }),
  aiModelHasKey: (id: string) => invoke<boolean>("ai_model_has_key", { id }),
  saveAiModel: (id: string | null, kind: AiModelKind, name: string, config: AiModelConfig, apiKey?: string) =>
    invoke<AiSettings>("ai_save_model", { id, kind, name, config, apiKey }),
  deleteAiModel: (id: string) => invoke<AiSettings>("ai_delete_model", { id }),
  testAiTarget: (target: AiTarget) => invoke<void>("ai_test_target", { probe: { kind: "saved", target } }),
  testAiModel: (modelKind: AiModelKind, id: string | null, config: AiModelConfig, apiKey?: string) =>
    invoke<void>("ai_test_target", { probe: { kind: "draft", modelKind, id, config, apiKey } }),
  aiChatStream: (threadId: string, request: AiRequest, onEvent: (event: AiStreamEvent) => void) =>
    invoke<AiResult>("ai_chat_stream", { threadId, request, channel: new Channel(onEvent) }),
  aiCancel: (id: string) => invoke<void>("ai_cancel", { id }),
  aiThreads: (entryId: string | null) => invoke<AiThread[]>("ai_threads_list", { entryId }),
  aiThread: (entryId: string | null, threadId: string) => invoke<AiThread>("ai_thread_get", { entryId, threadId }),
  aiCreateThread: (entryId: string | null) => invoke<string>("ai_thread_create", { entryId }),
  aiUpdateThread: (threadId: string, change: { title?: string; archived?: boolean }) =>
    invoke<void>("ai_thread_update", { threadId, ...change }),
  aiDeleteThread: (threadId: string) => invoke<void>("ai_thread_delete", { threadId }),
  aiMessages: (threadId: string) => invoke<AiHistoryItem[]>("ai_messages_list", { threadId }),
  aiSaveMessage: (threadId: string, { parentId, message }: AiHistoryItem) =>
    invoke<void>("ai_message_save", { threadId, item: { parentId, message } }),
  aiProposalStatus: (proposalId: string, status: Exclude<AiProposalStatus, "pending">) =>
    invoke<void>("ai_proposal_status", { proposalId, status }),
  backupSettings: () => invoke<BackupSettings>("backup_settings"),
  configureBackup: (target: BackupTarget, secret?: ImageSecret) => invoke<void>("backup_configure", { target, secret }),
  backupUseImageStorage: () => invoke<void>("backup_use_image_storage"),
  exportWorkspace: (preferences: Record<string, unknown>) => invoke<string | null>("backup_export_workspace", { preferences }),
  importWorkspace: () => invoke<string | null>("backup_import_workspace"),
  takeMigratedPreferences: () => invoke<Record<string, unknown> | null>("backup_take_preferences"),
  backupWorkspaces: () => invoke<string[]>("backup_workspaces"),
  backupList: (workspace: string) => invoke<BackupSnapshot[]>("backup_list", { workspace }),
  createBackup: () => invoke<{ backup: BackupSnapshot; warning: string | null }>("backup_create"),
  prepareRestore: (workspace: string, name: string) => invoke<string>("backup_prepare_restore", { workspace, name }),
  discardRestore: (ticket: string) => invoke<void>("backup_discard_restore", { ticket }),
  commitRestore: (ticket: string) => invoke<void>("backup_commit_restore", { ticket }),
  restoreNotice: () => invoke<{ failed: boolean; message: string } | null>("backup_restore_notice"),
  onBackupProgress: (callback: (stage: BackupStage) => void) => listen<BackupStage>("backup-progress", event => callback(event.payload)),
  deriveImage: (kind: string, source: string, bytes: Uint8Array) => invoke<string>("asset_derive", { kind, source, png: Array.from(bytes) }),
  assetInfo: (url: string) => invoke<{ id: string; name: string } | null>("asset_info", { url }),
  publicImage: (url: string) => invoke<string>("asset_public", { url }),
  hostImage: (url: string, target: ImageTarget) => invoke<string>("asset_host_image", { url, target }),
  imageUploadProgress: (markdown: string) => invoke<UploadProgress | null>("asset_upload_progress", { markdown }),
  copyImage: (url: string) => invoke<void>("asset_copy_image", { url }),
  saveImage: (url: string) => invoke<boolean>("asset_save_image", { url }),
  exportWechatHtml: (html: string, images: ExportImage[]) => invoke<boolean>("wechat_export_html", { html, images }),
  onExit: (callback: () => void) => listen("workspace-exit-requested", callback),
  beginExit: () => invoke<void>("begin_exit"),
  cancelExit: () => invoke<void>("cancel_exit"),
  finishExit: () => invoke<void>("finish_exit"),
  cancelCleanup: () => invoke<void>("cancel_asset_cleanup"),
  assetLibrary: (page = 0) => invoke<AssetLibrary>("asset_library", { page }),
  onAssetsChanged: (callback: () => void) => listen("assets-changed", callback),
  assetImport: async (file: File, origin: "attachment" | "library" = "attachment") => {
    if (file.size > 20 * 1024 * 1024) throw new Error("单张图片不能超过 20 MB");
    return invoke<string>("asset_import", await file.arrayBuffer(), {
      headers: { "x-asset-name": encodeURIComponent(file.name), "x-asset-origin": origin },
    });
  },
  assetRead: (url: string, retry = false) => invoke<ArrayBuffer>("asset_read", { url, retry }),
  assetThumbnail: (id: string) => invoke<ArrayBuffer>("asset_thumbnail", { id }),
  localizeImage: (url: string) => invoke<string>("asset_localize_image", { url }),
  assetUpload: (id: string) => invoke<void>("asset_upload", { id }),
  assetExport: (id: string) => invoke<boolean>("asset_export", { id }),
  imageStorageSave: (target: ImageTarget | null, secret?: ImageSecret, options?: ImageUploadOptions) => invoke<void>("image_storage_save", { target, secret, options }),
  imageStorageSettings: () => invoke<{ target: ImageTarget | null; enabled: boolean; secret: ImageSecret | null; options: ImageUploadOptions }>("image_storage_settings"),
  imageStorageTarget: () => invoke<ActiveImageStorage | null>("image_storage_target"),
  imageStorageTest: (target: ImageTarget, secret?: ImageSecret) => invoke<void>("image_storage_test", { target, secret }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}
