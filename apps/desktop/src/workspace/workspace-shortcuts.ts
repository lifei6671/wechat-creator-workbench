import { commandKey } from "../labels";
import { defaultViewShortcut, isViewShortcut, matchesViewShortcut, sameShortcut, shortcutConflict, shortcutLabel, type RecordedShortcut, type ViewShortcut } from "./view-shortcut";

export const workspaceShortcutItems = [
  { id: "palette", label: "命令面板", code: "KeyK" },
  { id: "create", label: "新建笔记", code: "KeyN" },
  { id: "save", label: "保存版本", code: "KeyS" },
  { id: "searchAll", label: "全文搜索", code: "KeyF", shift: true },
  { id: "search", label: "查找与替换", code: "KeyF" },
  { id: "reading", label: "阅读模式", code: "KeyR" },
  { id: "copyMarkdown", label: "复制 Markdown 原文", code: "KeyC", shift: true },
  { id: "copyWechat", label: "复制公众号格式", code: "KeyC", alt: true },
] as const;
export type WorkspaceShortcutId = typeof workspaceShortcutItems[number]["id"];
export type WorkspaceShortcuts = Partial<Record<WorkspaceShortcutId, ViewShortcut>>;

export function workspaceShortcut(bindings: WorkspaceShortcuts, id: WorkspaceShortcutId): ViewShortcut {
  if (bindings[id] !== undefined) return bindings[id];
  const item = workspaceShortcutItems.find(item => item.id === id)!;
  const mac = commandKey === "⌘";
  return { code: item.code, ctrlKey: !mac, metaKey: mac, shiftKey: "shift" in item, altKey: "alt" in item };
}

export function isWorkspaceShortcuts(value: unknown): value is WorkspaceShortcuts {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([id, binding]) => workspaceShortcutItems.some(item => item.id === id) && isViewShortcut(binding));
}

export function readWorkspaceShortcuts(): WorkspaceShortcuts {
  const raw = localStorage.getItem("workspace-shortcuts");
  if (raw === null) return {};
  try { const value: unknown = JSON.parse(raw); return isWorkspaceShortcuts(value) ? value : {}; }
  catch { return {}; }
}

export function workspaceShortcutLabel(bindings: WorkspaceShortcuts, id: WorkspaceShortcutId): string | undefined {
  const value = workspaceShortcut(bindings, id);
  return value === "none" ? undefined : shortcutLabel(value);
}

export function workspaceShortcutConflict(id: WorkspaceShortcutId | "view", stroke: RecordedShortcut, bindings: WorkspaceShortcuts, view: ViewShortcut): boolean {
  if (workspaceShortcutItems.some(item => item.id !== id && sameShortcut(workspaceShortcut(bindings, item.id), stroke))
    || (id !== "view" && sameShortcut(view, stroke))) return true;
  if (workspaceShortcutItems.some(item => sameShortcut(workspaceShortcut({}, item.id), stroke)) || sameShortcut(defaultViewShortcut(), stroke)) return false;
  return shortcutConflict(stroke);
}

export function workspaceShortcutForEvent(bindings: WorkspaceShortcuts, event: KeyboardEvent): WorkspaceShortcutId | undefined {
  return workspaceShortcutItems.find(item => matchesViewShortcut(workspaceShortcut(bindings, item.id), event))?.id;
}
