import type { ClipboardAction, ClipboardIO } from "../../../../packages/editor-react";
import { desktop } from "../desktop";

type HandleEditorClipboard = (action: ClipboardAction, target: EventTarget | null, plainText?: boolean) => boolean;

export function attachClipboard(editor: HandleEditorClipboard, onError: ClipboardIO["onError"]) {
  function handle(action: ClipboardAction, event: Event, plainText?: boolean) {
    event.preventDefault();
    event.stopPropagation();
    if (editor(action, event.target, plainText)) return;

    const field = event.target;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
      && field.selectionStart !== null && field.selectionEnd !== null) {
      const { selectionStart, selectionEnd, value } = field;
      const sameSelection = () => document.activeElement === field && field.value === value
        && field.selectionStart === selectionStart && field.selectionEnd === selectionEnd;
      const editable = !field.readOnly && !field.disabled;
      if (action === "paste" && editable) {
        void desktop.readClipboard(false).then(result => {
          if (result?.kind === "text" && result.text && sameSelection()) {
            document.execCommand("insertText", false, result.text);
          }
        }).catch(onError);
      } else if (action !== "paste" && selectionStart !== selectionEnd) {
        void desktop.copyText(value.slice(selectionStart, selectionEnd)).then(() => {
          if (action === "cut" && editable && sameSelection()) document.execCommand("delete");
        }).catch(onError);
      }
    } else if (action === "copy") {
      const selection = document.getSelection()?.toString();
      if (selection) void desktop.copyText(selection).catch(onError);
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || event.altKey) return;
    const modified = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if ((modified && key === "v") || (event.shiftKey && !modified && key === "insert")) {
      handle("paste", event, modified && event.shiftKey);
    }
    else if ((modified && !event.shiftKey && key === "c") || (event.ctrlKey && key === "insert")) handle("copy", event);
    else if ((modified && !event.shiftKey && key === "x") || (event.shiftKey && !modified && key === "delete")) handle("cut", event);
  }

  const actions = ["copy", "cut", "paste"] as const;
  const listeners = actions.map(action => (event: Event) => handle(action, event));
  document.addEventListener("keydown", keydown, true);
  actions.forEach((action, index) => document.addEventListener(action, listeners[index], true));
  return () => {
    document.removeEventListener("keydown", keydown, true);
    actions.forEach((action, index) => document.removeEventListener(action, listeners[index], true));
  };
}
