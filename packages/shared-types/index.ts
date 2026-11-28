export type * from "./image-canvas";
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

export type CustomProperty = { key: string } & (
  { kind: "text" | "date"; value: string } | { kind: "tags"; value: string[] }
);

export interface PublicationPlatform { platform: string; url: string }

export interface WechatRecommendation { entryId: string; title: string; url: string }
export interface WechatPublication {
  schemaVersion: 1;
  recommendations: {
    enabled: boolean;
    mode: "auto" | "manual";
    countOverride: number | null;
    inputFingerprint: string | null;
    items: WechatRecommendation[];
  };
}
export interface WechatPublicationDefaults {
  schemaVersion: 1;
  recommendationCount: number;
  recommendationAuthors: string[];
  version: number;
  updatedAt: number;
}
export interface WechatRecommendationInput {
  entryId: string;
  title: string;
  summary: string;
  tags: string[];
  contentMd: string;
  categoryId: string | null;
  status: EntryStatus;
  publishedAt: number | null;
  count: number;
  authors: string[];
}
export interface WechatCandidate extends WechatRecommendation {
  summary: string;
  tags: string[];
  publishedAt: number | null;
}
export interface WechatCandidatePage { items: WechatCandidate[]; nextOffset: number | null }
export interface WechatRecommendationResult { inputFingerprint: string; items: WechatRecommendation[] }
export interface WechatResolvedRecommendations {
  items: WechatRecommendation[];
  invalid: { entryId: string; message: string }[];
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
  publicationPlatforms?: PublicationPlatform[];
  wechatPublication?: WechatPublication | null;
  customProperties?: CustomProperty[];
}

export interface EntryRow {
  id: string;
  kind: EntryKind;
  title: string;
  status: EntryStatus;
  createdAt?: number;
  updatedAt: number;
  deletedAt: number | null;
  purgedAt?: number | null;
  categoryId: string | null;
  pinned?: boolean;
  preview?: { summary: string; image: string | null; tags?: string[] };
  searchMatches?: WorkspaceSearchMatches;
}
export interface Entry extends EntryRow, EntryFields {
  version: number;
  links: EntryRow[];
}
export const entrySortOrders = ["name", "nameDesc", "updated", "updatedAsc", "created", "createdAsc"] as const;
export type EntrySortOrder = typeof entrySortOrders[number];
export type TimelineSelection = { kind: "folder" | "tag"; id: string } | { kind: "root" | "untagged" };
export interface EntryFilter {
  sort?: EntrySortOrder | "relevance";
  pinned?: boolean;
  timelineScope?: TimelineSelection;
  kind?: EntryKind;
  categoryId?: string;
  exactCategory?: boolean;
  includePreview?: boolean;
  tagIds?: string[];
  untagged?: boolean;
  query?: string;
  workspaceSearch?: { text: string; caseSensitive: boolean; matchPage?: { entryId: string; offset: number } };
  deleted: boolean;
  wechatImported?: boolean;
  externalImported?: boolean;
  offset: number;
  limit?: number;
}
export interface WorkspaceSearchSnippet {
  start: number;
  text: string;
  ranges: { start: number; end: number }[];
  leading: boolean;
  trailing: boolean;
}
export interface WorkspaceSearchHit extends WorkspaceSearchSnippet {
  line: number;
  expanded?: WorkspaceSearchSnippet;
  before: string | null;
  after: string | null;
}
export interface WorkspaceSearchMatches { version: number; indexGeneration?: string; items: WorkspaceSearchHit[]; total: number; nextOffset: number | null }
export interface WorkspaceSearchInfo {
  total: number;
  indexing?: boolean;
  indexGeneration?: string;
  error?: string;
  clauses: {
    field: "text" | "content" | "file" | "path" | "tag" | "line" | "section" | "status" | "summary" | "source" | "unknownProperty";
    terms: string[];
  }[];
}
export interface EntryPage { items: EntryRow[]; nextOffset: number | null; search?: WorkspaceSearchInfo }
export type CategoryIcon =
  | "folder" | "lightbulb" | "book" | "file" | "bookmark" | "newspaper" | "archive" | "star"
  | "code" | "terminal" | "globe" | "link" | "image" | "camera" | "video" | "music"
  | "mic" | "podcast" | "headphones" | "pen" | "notebook" | "clipboard" | "briefcase" | "graduation"
  | "flask" | "cpu" | "rocket" | "sparkles" | "heart" | "calendar" | "list" | "tag";
export type CategoryPlacement = "before" | "after";
export interface Category { id: string; parentId: string | null; name: string; sortOrder: number; icon: CategoryIcon; iconColor?: CanvasCardColor | null }
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
export interface RecoveryCommit { sessionId: string; localRevision: number }
export interface RecoveryDraft extends RecoveryCommit { entryId: string; kind: EntryKind; baseVersion: number; fields: EntryFields }
export interface RecoverySummary extends RecoveryCommit { entryId: string; title: string; baseVersion: number; updatedAt: number }
export interface AppError {
  code: "DATABASE" | "INTEGRITY" | "INVALID_INPUT" | "NOT_FOUND" | "VERSION_CONFLICT" | "EXIT_PENDING" | "EXPORT_FAILED";
  message: string;
  currentVersion?: number;
}
export type CanvasPosition = { x: number; y: number };
export type CanvasViewport = CanvasPosition & { zoom: number };
export type CanvasGeometry = CanvasPosition & { width: number; height: number };

export interface Collection {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  viewport: CanvasViewport;
  nodeCount: number;
}

export type CanvasNodeContent =
  | { kind: "entry"; entryId: string }
  | { kind: "image"; assetId: string }
  | { kind: "text"; contentMd: string }
  | { kind: "web"; url: string };

export type CanvasCardColor = "red" | "orange" | "amber" | "green" | "blue" | "violet" | `#${string}`;

export type CanvasNode = CanvasGeometry & {
  id: string;
  collectionId: string;
  kind: CanvasNodeContent["kind"];
  entryId: string | null;
  assetId: string | null;
  assetName?: string | null;
  color: CanvasCardColor | null;
  contentMd: string;
  externalUrl: string | null;
  createdAt: number;
  updatedAt: number;
  entry: Pick<EntryRow, "title" | "kind" | "deletedAt"> & { summary: string; sourcePlatform: string | null } | null;
};

export interface CanvasEdge {
  id: string;
  collectionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  createdAt: number;
}

export interface CollectionCanvas {
  collection: Collection;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
