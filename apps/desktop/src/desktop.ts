import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { SourceFragment } from "../../../packages/wechat-renderer";
import type {
  Category, CategoryIcon, CategoryPlacement, Entry, EntryFields, EntryFilter, EntryKind, EntryPage, Library, Revision, SaveMode, SaveResult,
} from "../../../packages/shared-types";

export interface ImageTarget { endpoint: string; region: string; bucket: string; prefix: string; publicBase: string }
export interface ImageSecret { accessKey: string; secretKey: string }
export interface ImageUploadOptions { filenameTemplate: string; quality: "original" | "high" | "standard" | "economy" }
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
export interface AssetLibrary { items: AssetRow[]; target: ImageTarget | null }
export interface WechatImportJob {
  id: string; url: string; status: "queued" | "running" | "completed" | "partial" | "needs_attention" | "failed";
  entryId: string | null; error: string | null; pendingImages: number;
}
export interface McpConfig { enabled: boolean; port: number; permission: "read" | "write" }
export interface McpStatus { config: McpConfig; running: boolean; error: string | null }
export type AiAgent = "codex" | "claude_code";
export type AiModelKind = "local" | "custom";
export type AiTarget = { kind: "agent"; id: AiAgent } | { kind: "model"; id: string };
export type AiSelection = { target: AiTarget; agentModel?: string };
export interface AiAgentModel { id: string; label: string }
export interface AiModelConfig { endpoint: string; model: string; timeoutSeconds: number }
export interface AiModel extends AiModelConfig { id: string; kind: AiModelKind; name: string }
export interface AiPreferences { enabled: boolean; defaultTarget: AiTarget | null }
export interface AiSettings {
  preferences: AiPreferences;
  models: AiModel[];
  agents: { id: AiAgent; installed: boolean }[];
}
export type AiOperation = "summary" | "titles" | "rewrite";
export interface AiTurn { user: string; assistant: string }
export type AiRequest = { id: string; title: string; text: string } & Partial<AiSelection> & (
  { entryId: string; operation: AiOperation }
  | { entryId: string | null; operation: "chat"; prompt: string; history: AiTurn[] }
);
export type AiResult = { candidates: string[] } | { reply: string; replacement: string | null };
export interface AiJob {
  id: string; entryId: string | null; operation: AiRequest["operation"]; model: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number; updatedAt: number; error: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
}
type ClipboardContents = { kind: "text"; text: string }
  | { kind: "html"; html: string; text: string | null }
  | { kind: "images"; images: { id: string; name: string }[]; errors: string[] };

export const windowsTitleBar = /Win/.test(navigator.platform);
export const nativeWindow = () => getCurrentWindow();

export const desktop = {
  openLink: (url: string) => openUrl(url),
  library: () => invoke<Library>("library"),
  entries: (filter: EntryFilter) => invoke<EntryPage>("entries", { filter }),
  entry: (id: string) => invoke<Entry>("get_entry", { id }),
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
  revisions: (id: string) => invoke<Revision[]>("revisions", { id }),
  exportMarkdown: (id: string) => invoke<string | null>("export_markdown", { id }),
  revealFile: (path: string) => revealItemInDir(path),
  copyText: (text: string) => invoke<void>("clipboard_write", { text }),
  readClipboard: (acceptImages: boolean, acceptHtml = false) =>
    invoke<ClipboardContents | null>("clipboard_read", { acceptImages, acceptHtml }),
  copyHtml: (html: string, text: string) => invoke<void>("clipboard_write_html", { html, text }),
  importWechat: (url: string, categoryId: string | null) => invoke<WechatImportJob>("wechat_import", { url, categoryId }),
  importMarkdown: (categoryId: string | null) => invoke<Entry | null>("import_markdown", { categoryId }),
  importJobs: () => invoke<WechatImportJob[]>("wechat_import_jobs"),
  retryWechatImages: (entry: string) => invoke<WechatImportJob>("wechat_retry_images", { entry }),
  wechatGraphics: (markdown: string) => invoke<SourceFragment[]>("wechat_graphics", { markdown }),
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
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
  aiGenerate: (request: AiRequest) => invoke<AiResult>("ai_generate", { request }),
  aiCancel: (id: string) => invoke<void>("ai_cancel", { id }),
  aiJobs: () => invoke<AiJob[]>("ai_jobs"),
  onAiStarted: (callback: (id: string) => void) => listen<string>("ai-job-started", event => callback(event.payload)),
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
  copyImage: (url: string) => invoke<void>("asset_copy_image", { url }),
  saveImage: (url: string) => invoke<boolean>("asset_save_image", { url }),
  exportWechatHtml: (html: string, images: ExportImage[]) => invoke<boolean>("wechat_export_html", { html, images }),
  onExit: (callback: () => void) => listen("workspace-exit-requested", callback),
  beginExit: () => invoke<void>("begin_exit"),
  cancelExit: () => invoke<void>("cancel_exit"),
  finishExit: () => invoke<void>("finish_exit"),
  cancelCleanup: () => invoke<void>("cancel_asset_cleanup"),
  assetLibrary: () => invoke<AssetLibrary>("asset_library"),
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
  imageStorageTarget: () => invoke<ImageTarget | null>("image_storage_target"),
  imageStorageTest: (target: ImageTarget, secret?: ImageSecret) => invoke<void>("image_storage_test", { target, secret }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}
