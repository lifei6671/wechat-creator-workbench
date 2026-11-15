import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SourceFragment } from "../../../packages/wechat-renderer";
import type {
  Category, CategoryIcon, CategoryPlacement, Entry, EntryFields, EntryFilter, EntryKind, EntryPage, Library, Revision, SaveMode, SaveResult,
} from "../../../packages/shared-types";

export interface ImageTarget { endpoint: string; region: string; bucket: string; prefix: string; publicBase: string }
export interface ImageSecret { accessKey: string; secretKey: string }
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
export interface AiConfig { endpoint: string; model: string; timeoutSeconds: number }
export type AiOperation = "summary" | "titles" | "rewrite";
export interface AiRequest { id: string; entryId: string; operation: AiOperation; title: string; text: string }
export interface AiJob {
  id: string; entryId: string; operation: AiOperation; model: string;
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
  exportMarkdown: (id: string) => invoke<boolean>("export_markdown", { id }),
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
  aiSettings: () => invoke<{ config: AiConfig | null; hasKey: boolean }>("ai_settings"),
  saveAi: (config: AiConfig, apiKey?: string) => invoke<void>("ai_save_settings", { config, apiKey }),
  aiGenerate: (request: AiRequest) => invoke<{ candidates: string[] }>("ai_generate", { request }),
  aiCancel: (id: string) => invoke<void>("ai_cancel", { id }),
  aiJobs: () => invoke<AiJob[]>("ai_jobs"),
  onAiStarted: (callback: (id: string) => void) => listen<string>("ai-job-started", event => callback(event.payload)),
  backupSettings: () => invoke<BackupSettings>("backup_settings"),
  configureBackup: (target: BackupTarget, secret?: ImageSecret) => invoke<void>("backup_configure", { target, secret }),
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
  copyImage: (url: string) => invoke<void>("asset_copy_image", { url }),
  saveImage: (url: string) => invoke<boolean>("asset_save_image", { url }),
  exportWechatHtml: (html: string, urls: string[]) => invoke<boolean>("wechat_export_html", { html, urls }),
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
  imageStorageSave: (target: ImageTarget | null, secret?: ImageSecret) => invoke<void>("image_storage_save", { target, secret }),
  imageStorageTest: (target: ImageTarget, secret?: ImageSecret) => invoke<void>("image_storage_test", { target, secret }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}
