import { entrySortOrders, type TimelineSelection } from "../../../../packages/shared-types";
import { persist } from "../ui";
import type { ViewMode } from "./Document";
import type { Section } from "./Explorer";
import { isViewShortcut } from "./view-shortcut";

export type DocumentOpenMode = "current" | "new-tab";
export type DocumentOptions = { view?: ViewMode; convertLinks?: boolean; outline?: boolean };
export type TimelineDirectory = "shown" | "manual" | "auto";

type DocumentTabsPreference = {
  ids: string[];
  activeId: string | null;
  readingIds?: string[];
  options?: Record<string, DocumentOptions>;
};
const documentTabsKey = (workspaceId: string) => `document-tabs:${workspaceId}`;

function readPreference(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readDocumentTabs(workspaceId: string): DocumentTabsPreference | null {
  const value = record(readPreference(documentTabsKey(workspaceId)));
  if (!Array.isArray(value.ids) || !value.ids.every(id => typeof id === "string")) return null;
  const ids = [...new Set<string>(value.ids)];
  const activeId = typeof value.activeId === "string" && ids.includes(value.activeId) ? value.activeId : null;
  const storedOptions = record(value.options);
  const options = Object.fromEntries(ids.flatMap(id => {
    if (!Object.hasOwn(storedOptions, id)) return [];
    const { view, convertLinks, outline } = record(storedOptions[id]);
    const valid: DocumentOptions = {};
    if (view === "edit" || view === "preview") valid.view = view;
    if (typeof convertLinks === "boolean") valid.convertLinks = convertLinks;
    if (typeof outline === "boolean") valid.outline = outline;
    return Object.keys(valid).length ? [[id, valid] as const] : [];
  }));
  const storedReadingIds = value.readingIds;
  const readingIds = Array.isArray(storedReadingIds) ? ids.filter(id => storedReadingIds.includes(id)) : [];
  return {
    ids, activeId,
    ...(readingIds.length ? { readingIds } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

export function saveDocumentTabs(workspaceId: string, tabs: DocumentTabsPreference) {
  persist(documentTabsKey(workspaceId), tabs);
}

export type CollectionTabsPreference = { ids: string[]; activeId?: string };
const collectionTabsKey = (workspaceId: string) => `collection-tabs:${workspaceId}`;

export function readCollectionTabs(workspaceId: string): CollectionTabsPreference {
  const { ids, activeId } = record(readPreference(collectionTabsKey(workspaceId)));
  if (Array.isArray(ids)) {
    const open = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
    return { ids: open, activeId: typeof activeId === "string" && open.includes(activeId) ? activeId : undefined };
  }
  const previous = readPreference(`active-collection:${workspaceId}`);
  return typeof previous === "string" ? { ids: [previous], activeId: previous } : { ids: [] };
}

export function saveCollectionTabs(workspaceId: string, tabs: CollectionTabsPreference) {
  persist(collectionTabsKey(workspaceId), tabs);
}

const sections: readonly Section[] = ["folders", "timeline", "search", "assets", "trash", "imports", "collections"];
const layoutKey = "workspace-layout";

type WorkspaceLayout = {
  section: Section;
  explorerOverride: boolean | null;
  timelineDirectory: TimelineDirectory;
  focusMode: boolean;
  aiOpen: boolean;
};

export function readWorkspaceLayout(): WorkspaceLayout {
  const { section, explorerOverride, timelineDirectory, focusMode, aiOpen } = record(readPreference(layoutKey));
  return {
    section: sections.find(item => item === section) ?? "folders",
    explorerOverride: typeof explorerOverride === "boolean" ? explorerOverride : null,
    timelineDirectory: timelineDirectory === "manual" || timelineDirectory === "auto" ? timelineDirectory : "shown",
    focusMode: focusMode === true,
    aiOpen: aiOpen === true,
  };
}

export function saveWorkspaceLayout(layout: WorkspaceLayout) {
  persist(layoutKey, layout);
}

type WorkspaceNavigation = {
  categoryId?: string;
  timelineSelection: TimelineSelection;
  includeTimelineChildren: boolean;
  query: string;
  caseSensitive: boolean;
};
const navigationKey = (workspaceId: string) => `workspace-navigation:${workspaceId}`;

export function readWorkspaceNavigation(workspaceId: string): WorkspaceNavigation {
  const { categoryId, timelineSelection, includeTimelineChildren, query, caseSensitive } = record(readPreference(navigationKey(workspaceId)));
  const { kind, id } = record(timelineSelection);
  const selection: TimelineSelection = (kind === "folder" || kind === "tag") && typeof id === "string" ? { kind, id }
    : { kind: kind === "untagged" ? kind : "root" };
  return {
    categoryId: typeof categoryId === "string" ? categoryId : undefined,
    timelineSelection: selection,
    includeTimelineChildren: includeTimelineChildren !== false,
    query: typeof query === "string" ? query : "",
    caseSensitive: caseSensitive === true,
  };
}

export function saveWorkspaceNavigation(workspaceId: string, navigation: WorkspaceNavigation) {
  persist(navigationKey(workspaceId), navigation);
}

const allowed = {
  appearance: (v: unknown) => v === "system" || v === "light" || v === "dark",
  view: (v: unknown) => v === "edit" || v === "preview",
  "document-open-mode": (v: unknown) => v === "current" || v === "new-tab",
  "view-shortcut": isViewShortcut,
  "folder-loading": (v: unknown) => v === "all" || v === "paged",
  "folder-page-size": (v: unknown) => [20, 40, 60, 100, 200].includes(v as number),
  "directory-sort": (v: unknown) => v === "manual" || entrySortOrders.some(sort => sort === v),
  "directory-auto-locate": (v: unknown) => typeof v === "boolean",
  "directory-pins-collapsed": (v: unknown) => typeof v === "boolean",
  "directory-collapsed": (v: unknown) => typeof v === "boolean",
  "directory-tags-collapsed": (v: unknown) => typeof v === "boolean",
  explorer: (v: unknown) => typeof v === "boolean",
  "asset-large-tiles": (v: unknown) => typeof v === "boolean",
  "download-pasted-images": (v: unknown) => typeof v === "boolean",
  "links-to-footnotes": (v: unknown) => typeof v === "boolean",
  "default-document-outline": (v: unknown) => typeof v === "boolean",
  "expanded-folders": (v: unknown) => Array.isArray(v) && v.every(id => typeof id === "string"),
  "editor-display": (v: unknown) => Boolean(v && typeof v === "object" && ["limitWidth", "lineNumbers", "showTitle"]
    .every(key => typeof (v as Record<string, unknown>)[key] === "boolean")),
};

export function workspacePreferences(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, valid] of Object.entries(allowed)) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (valid(value)) result[key] = value;
    } catch { /* Invalid local preferences are left out of the archive. */ }
  }
  return result;
}

export function restoreWorkspacePreferences(values: Record<string, unknown> | null) {
  if (!values) return;
  for (const [key, valid] of Object.entries(allowed)) {
    if (valid(values[key])) localStorage.setItem(key, JSON.stringify(values[key]));
  }
}
