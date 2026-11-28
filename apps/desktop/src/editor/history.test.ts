// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { editHistory } from "./history";

it("routes the native history menu to the active image canvas", () => {
  const canvas = document.body.appendChild(document.createElement("div"));
  canvas.className = "image-canvas-dialog";
  const button = canvas.appendChild(document.createElement("button"));
  const keys: Array<[string, boolean]> = [];
  canvas.addEventListener("keydown", event => keys.push([event.key, event.shiftKey]));
  try {
    button.focus();
    editHistory("undo"); editHistory("redo");
    expect(keys).toEqual([["z", false], ["z", true]]);
  } finally { canvas.remove(); }
});

it.each(["input", "textarea"])("keeps native field history and ignores readonly or unfocused targets (%s)", tag => {
  const field = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
  const command = vi.fn();
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
  document.body.append(field);
  try {
    field.focus();
    editHistory("undo");
    editHistory("redo");
    expect(command.mock.calls).toEqual([["undo"], ["redo"]]);
    command.mockClear();
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      editHistory("undo");
      editHistory("redo");
      expect(command).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
    }
    field.readOnly = true;
    editHistory("undo");
    field.readOnly = false;
    field.blur();
    editHistory("undo");
    expect(command).not.toHaveBeenCalled();
  } finally {
    field.remove();
    Reflect.deleteProperty(document, "execCommand");
  }
});
