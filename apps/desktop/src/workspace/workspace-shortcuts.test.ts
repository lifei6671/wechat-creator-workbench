// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ command: "Ctrl+" }));
vi.mock("../labels", async original => ({ ...await original<typeof import("../labels")>(), get commandKey() { return platform.command; } }));
import { isWorkspaceShortcuts, readWorkspaceShortcuts, workspaceShortcut, workspaceShortcutConflict, workspaceShortcutForEvent, workspaceShortcutLabel } from "./workspace-shortcuts";
import { restoreWorkspacePreferences, workspacePreferences } from "./preferences";
import { defaultViewShortcut, matchesViewShortcut } from "./view-shortcut";

afterEach(() => { localStorage.clear(); platform.command = "Ctrl+"; });

it.each([false, true])("matches exact copy chords including Option-generated characters (mac=%s)", mac => {
  platform.command = mac ? "⌘" : "Ctrl+";
  const base = { ctrlKey: !mac, metaKey: mac, code: "KeyC", key: mac ? "ç" : "c" };
  expect(workspaceShortcutForEvent({}, new KeyboardEvent("keydown", { ...base, shiftKey: true }))).toBe("copyMarkdown");
  expect(workspaceShortcutForEvent({}, new KeyboardEvent("keydown", { ...base, altKey: true }))).toBe("copyWechat");
  expect(workspaceShortcutForEvent({}, new KeyboardEvent("keydown", base))).toBeUndefined();
  expect(workspaceShortcutForEvent({}, new KeyboardEvent("keydown", { ...base, altKey: true, shiftKey: true }))).toBeUndefined();
  expect(workspaceShortcutLabel({}, "copyWechat")).toBe(mac ? "⌘+Option+C" : "Ctrl+Alt+C");
  const graph = new KeyboardEvent("keydown", { ...base, altKey: true });
  Object.defineProperty(graph, "getModifierState", { value: (key: string) => key === "AltGraph" });
  expect(workspaceShortcutForEvent({}, graph)).toBeUndefined();
});

it.each([false, true])("defaults reading to Mod+R and preview to Mod+W without modifier collisions (mac=%s)", mac => {
  platform.command = mac ? "⌘" : "Ctrl+";
  const mod = { ctrlKey: !mac, metaKey: mac };
  expect(workspaceShortcutForEvent({}, new KeyboardEvent("keydown", { ...mod, code: "KeyR", key: "r" }))).toBe("reading");
  expect(workspaceShortcutForEvent({}, new KeyboardEvent("keydown", { ...mod, code: "KeyR", key: "r", shiftKey: true }))).toBeUndefined();
  expect(matchesViewShortcut(defaultViewShortcut(), new KeyboardEvent("keydown", { ...mod, code: "KeyW", key: "w" }))).toBe(true);
  expect(workspaceShortcutConflict("view", workspaceShortcut({}, "reading") as ReturnType<typeof defaultViewShortcut>, {}, defaultViewShortcut())).toBe(true);
  expect(workspaceShortcutConflict("reading", defaultViewShortcut(), {}, defaultViewShortcut())).toBe(true);
  expect(workspaceShortcutConflict("view", defaultViewShortcut(), {}, defaultViewShortcut())).toBe(false);
});

it("checks current bindings in both directions and frees previous workspace chords", () => {
  const custom = { code: "KeyJ", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false };
  expect(workspaceShortcutConflict("copyMarkdown", custom, { search: custom }, "none")).toBe(true);
  expect(workspaceShortcutConflict("search", custom, {}, custom)).toBe(true);
  expect(workspaceShortcutConflict("view", custom, { search: custom }, "none")).toBe(true);
  expect(workspaceShortcutConflict("save", workspaceShortcut({}, "save") as typeof custom, {}, "none")).toBe(false);
  expect(workspaceShortcutConflict("search", workspaceShortcut({}, "save") as typeof custom, { save: "none" }, "none")).toBe(false);
  expect(workspaceShortcutConflict("search", { ...custom, code: "KeyB", altKey: false }, {}, "none")).toBe(true);
  expect(workspaceShortcutConflict("copyWechat", workspaceShortcut({}, "copyWechat") as typeof custom, {}, "none")).toBe(false);
});

it("persists cleared and custom bindings through workspace migration", () => {
  const bindings = { copyMarkdown: "none", palette: { code: "F8", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } };
  localStorage.setItem("workspace-shortcuts", JSON.stringify(bindings));
  expect(readWorkspaceShortcuts()).toEqual(bindings);
  const saved = workspacePreferences();
  localStorage.clear();
  restoreWorkspacePreferences(saved);
  expect(readWorkspaceShortcuts()).toEqual(bindings);
  expect(workspaceShortcutLabel(readWorkspaceShortcuts(), "copyMarkdown")).toBeUndefined();
  expect(isWorkspaceShortcuts({ unknown: "none" })).toBe(false);
  localStorage.setItem("workspace-shortcuts", "broken");
  expect(readWorkspaceShortcuts()).toEqual({});
});
