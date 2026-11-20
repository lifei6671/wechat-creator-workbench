// @vitest-environment jsdom
import { expect, it } from "vitest";
import { isViewShortcut, matchesViewShortcut, shortcutConflict, shortcutLabel } from "./view-shortcut";
import { workspacePreferences } from "./preferences";

it("matches the exact physical chord and preserves the previous shortcut choices", () => {
  const chord = { code: "KeyJ", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false };
  expect(matchesViewShortcut(chord, new KeyboardEvent("keydown", { ...chord, key: "ĵ" }))).toBe(true);
  expect(matchesViewShortcut(chord, new KeyboardEvent("keydown", { ...chord, code: "", key: "j" }))).toBe(true);
  expect(matchesViewShortcut(chord, new KeyboardEvent("keydown", { ...chord, shiftKey: true }))).toBe(false);
  expect(matchesViewShortcut("none", new KeyboardEvent("keydown", chord))).toBe(false);
  expect(matchesViewShortcut("shift-m", new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, shiftKey: true }))).toBe(true);
  expect(shortcutLabel(chord)).toBe("Ctrl+Alt+J");
  const altGraph = new KeyboardEvent("keydown", chord);
  Object.defineProperty(altGraph, "getModifierState", { value: (key: string) => key === "AltGraph" });
  expect(matchesViewShortcut(chord, altGraph)).toBe(false);
});

it.each(["KeyE", "BracketLeft", "BracketRight", "Enter", ...Array.from({ length: 9 }, (_, index) => `Digit${index}`), "KeyC", "KeyX"])("rejects the editor binding %s during shortcut recording", code => {
  const altKey = code.startsWith("Digit") || code === "KeyC" || code === "KeyX";
  for (const mac of [false, true]) expect(shortcutConflict({ code, ctrlKey: !mac, metaKey: mac, altKey, shiftKey: false })).toBe(true);
});

it("keeps custom chords in workspace migration and rejects plain typing and occupied commands", () => {
  const chord = { code: "F8", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  localStorage.setItem("view-shortcut", JSON.stringify(chord));
  try { expect(workspacePreferences()["view-shortcut"]).toEqual(chord); }
  finally { localStorage.clear(); }
  expect(isViewShortcut(chord)).toBe(true);
  expect(isViewShortcut({ ...chord, code: "KeyJ" })).toBe(false);
  expect(isViewShortcut({ ...chord, ctrlKey: "true" })).toBe(false);
  expect(shortcutConflict({ ...chord, code: "KeyS", ctrlKey: true })).toBe(true);
  expect(shortcutConflict({ ...chord, code: "KeyB", ctrlKey: true })).toBe(true);
  expect(shortcutConflict(chord)).toBe(false);
});
