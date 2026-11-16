import { entrySortOrders } from "../../../../packages/shared-types";

const allowed = {
  appearance: (v: unknown) => v === "system" || v === "light" || v === "dark",
  view: (v: unknown) => v === "edit" || v === "preview",
  "view-shortcut": (v: unknown) => v === "none" || v === "shift-m" || v === "alt-v",
  "folder-loading": (v: unknown) => v === "all" || v === "paged",
  "folder-page-size": (v: unknown) => [20, 40, 60, 100, 200].includes(v as number),
  "directory-sort": (v: unknown) => v === "manual" || entrySortOrders.some(sort => sort === v),
  "directory-auto-locate": (v: unknown) => typeof v === "boolean",
  explorer: (v: unknown) => typeof v === "boolean",
  "download-pasted-images": (v: unknown) => typeof v === "boolean",
  "links-to-footnotes": (v: unknown) => typeof v === "boolean",
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
