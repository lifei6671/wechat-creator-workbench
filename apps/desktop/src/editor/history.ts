export function editHistory(action: "undo" | "redo") {
  if (!document.hasFocus()) return;
  const target = document.activeElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (!target.readOnly && !target.disabled) document.execCommand(action);
  } else if (target instanceof HTMLElement && target.closest(".ProseMirror")) {
    target.dispatchEvent(new InputEvent("beforeinput", {
      inputType: action === "undo" ? "historyUndo" : "historyRedo",
      bubbles: true,
      cancelable: true,
    }));
  }
}
