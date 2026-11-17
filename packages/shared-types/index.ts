export type EntryKind = "idea" | "reference" | "article";
export type EntryStatus = "inbox" | "planned" | "used" | "archived" | "unread" | "reviewed" | "draft" | "ready" | "published";
export const statuses: Record<EntryKind, readonly EntryStatus[]> = {
  idea: ["inbox", "planned", "used", "archived"],
  reference: ["unread", "reviewed", "used", "archived"],
  article: ["draft", "ready", "published", "archived"],
};

export interface Source {
  url: string;
  author: string;
  accountName: string;
  originalPublishedAt: number | null;
  importedAt: number | null;
}

export interface EntryFields {
  title: string;
  contentMd: string;
  status: EntryStatus;
  categoryId: string | null;
  coverAssetId?: string | null;
  themeId?: string | null;
  tags: string[];
  summary: string;
  source: Source | null;
  publishedAt: number | null;
  publishedUrl: string;
}

export interface EntryRow {
  id: string;
  kind: EntryKind;
  title: string;
  status: EntryStatus;
  createdAt?: number;
  updatedAt: number;
  deletedAt: number | null;
  categoryId: string | null;
  pinned?: boolean;
  preview?: { summary: string; image: string | null; tags?: string[] };
}
export interface Entry extends EntryRow, EntryFields {
  version: number;
  links: EntryRow[];
}
export const entrySortOrders = ["name", "nameDesc", "updated", "updatedAsc", "created", "createdAsc"] as const;
export interface EntryFilter {
  sort?: typeof entrySortOrders[number];
  pinned?: boolean;
  kind?: EntryKind;
  categoryId?: string;
  exactCategory?: boolean;
  includePreview?: boolean;
  tagIds?: string[];
  untagged?: boolean;
  query?: string;
  workspaceSearch?: { text: string; caseSensitive: boolean };
  deleted: boolean;
  wechatImported?: boolean;
  offset: number;
  limit?: number;
}
export interface EntryPage { items: EntryRow[]; nextOffset: number | null }
export type CategoryIcon =
  | "folder" | "lightbulb" | "book" | "file" | "bookmark" | "newspaper" | "archive" | "star"
  | "code" | "terminal" | "globe" | "link" | "image" | "camera" | "video" | "music"
  | "mic" | "podcast" | "headphones" | "pen" | "notebook" | "clipboard" | "briefcase" | "graduation"
  | "flask" | "cpu" | "rocket" | "sparkles" | "heart" | "calendar" | "list" | "tag";
export type CategoryPlacement = "before" | "after";
export interface Category { id: string; parentId: string | null; name: string; sortOrder: number; icon: CategoryIcon }
export interface Tag { id: string; name: string }
export interface Library {
  workspaceId: string;
  categories: Category[];
  tags: Tag[];
  tagSuggestions: string[];
  articleCounts?: { root: number; folders: Record<string, number>; tags: Record<string, number>; untagged: number };
}
export interface Revision { version: number; contentMd: string; reason: "manual" | "before_ai_replace"; createdAt: number }
export type SaveMode = "auto" | "manual" | "ai_replace";
export interface SaveResult { version: number }
export interface AppError {
  code: "DATABASE" | "INTEGRITY" | "INVALID_INPUT" | "NOT_FOUND" | "VERSION_CONFLICT" | "EXIT_PENDING" | "EXPORT_FAILED";
  message: string;
  currentVersion?: number;
}
