import { commandKey } from "../labels";

export type RecordedShortcut = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;
export type ViewShortcut = "none" | "shift-m" | "alt-v" | RecordedShortcut;

const supportedCode = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|BracketLeft|BracketRight|Backslash|Slash|Semicolon|Quote|Comma|Period|Minus|Equal|Backquote)$/;

export function shortcutCode(event: Pick<KeyboardEvent, "code" | "key">): string {
  if (supportedCode.test(event.code)) return event.code;
  // Windows virtual key input can omit the physical code.
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  const punctuation: Record<string, string> = { " ": "Space", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
    "/": "Slash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "-": "Minus", "=": "Equal", "`": "Backquote" };
  return punctuation[event.key] ?? event.key;
}

export function isViewShortcut(value: unknown): value is ViewShortcut {
  if (value === "none" || value === "shift-m" || value === "alt-v") return true;
  if (!value || typeof value !== "object") return false;
  const stroke = value as RecordedShortcut;
  return typeof stroke.code === "string" && supportedCode.test(stroke.code)
    && [stroke.ctrlKey, stroke.metaKey, stroke.altKey, stroke.shiftKey].every(flag => typeof flag === "boolean")
    && (stroke.ctrlKey || stroke.metaKey || stroke.altKey || /^F\d+$/.test(stroke.code));
}

function normalized(value: Exclude<ViewShortcut, "none">): RecordedShortcut {
  if (typeof value !== "string") return value;
  const mac = commandKey === "⌘";
  return { code: value === "shift-m" ? "KeyM" : "KeyV", ctrlKey: !mac, metaKey: mac,
    shiftKey: value === "shift-m", altKey: value === "alt-v" };
}

export function matchesViewShortcut(value: ViewShortcut, event: KeyboardEvent): boolean {
  if (value === "none" || event.getModifierState("AltGraph")) return false;
  const stroke = normalized(value);
  return stroke.code === shortcutCode(event) && stroke.ctrlKey === event.ctrlKey && stroke.metaKey === event.metaKey
    && stroke.altKey === event.altKey && stroke.shiftKey === event.shiftKey;
}

export function shortcutConflict(stroke: RecordedShortcut): boolean {
  if (stroke.ctrlKey || stroke.metaKey) {
    if (!stroke.altKey && /^(Key[KNSFBIUZYACVXPWQRTLOHE]|Digit[0-9]|BracketLeft|BracketRight|Enter)$/.test(stroke.code)) return true;
    // Milkdown binds headings, lists, code blocks and strikethrough to Mod+Alt.
    if (stroke.altKey && /^(Digit[0-8]|Key[CX])$/.test(stroke.code)) return true;
  }
  return (stroke.altKey && ["F4", "Space"].includes(stroke.code)) || stroke.code === "F5"
    || (stroke.metaKey && stroke.code === "Space");
}

export function shortcutLabel(value: ViewShortcut): string {
  if (value === "none") return "未设置";
  const stroke = normalized(value);
  const keys: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Space: "Space", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Slash: "/", Semicolon: ";",
    Quote: "'", Comma: ",", Period: ".", Minus: "-", Equal: "=", Backquote: "`" };
  return [stroke.ctrlKey && "Ctrl", stroke.metaKey && (commandKey === "⌘" ? "⌘" : "Win"),
    stroke.altKey && (commandKey === "⌘" ? "Option" : "Alt"), stroke.shiftKey && "Shift",
    keys[stroke.code] ?? stroke.code.replace(/^(Key|Digit)/, "")].filter(Boolean).join("+");
}
