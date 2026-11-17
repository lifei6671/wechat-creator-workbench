import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { desktop } from "./desktop";

type Field = HTMLInputElement | HTMLTextAreaElement;
type Action = "cut" | "copy" | "paste" | "delete";
const actions = { cut: "剪切", copy: "复制", paste: "粘贴", delete: "删除" } satisfies Record<Action, string>;
const fieldTypes = ["text", "search", "url", "tel", "email", "password", "number", "date"];

function selection(field: Field) {
  const { selectionStart: start, selectionEnd: end, value } = field;
  const text = start !== null && end !== null ? value.slice(start, end) : document.getSelection()?.toString() ?? "";
  return { start, end, text: value.includes(text) ? text : "" };
}

function pasteDate(field: HTMLInputElement, text: string) {
  const date = document.createElement("input");
  date.type = "date";
  date.value = text.trim();
  if (!date.value) throw new Error("请粘贴有效日期，格式为年-月-日。");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(field, date.value);
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
}

export function installInputContextMenu(onError: (error: unknown) => void) {
  let target: { field: Field; value: string; range: ReturnType<typeof selection> } | undefined;
  let menuPromise: Promise<{ menu: Menu; items: MenuItem[] }> | undefined;
  const actionsInOrder = Object.keys(actions) as Action[];

  async function perform(action: Action) {
    const source = target;
    if (!source) return;
    const { field, value, range } = source;
    const unchanged = () => {
      const current = selection(field);
      return target === source && field.isConnected && document.activeElement === field && !field.matches(":disabled")
        && field.value === value && current.start === range.start && current.end === range.end && current.text === range.text;
    };
    if (!unchanged() || action !== "copy" && field.readOnly) return;
    if (action === "copy" || action === "cut") {
      if (!range.text || field instanceof HTMLInputElement && field.type === "password") return;
      await desktop.copyText(range.text);
      if (action === "copy") return;
    }
    if (field.readOnly) return;
    if (action === "paste") {
      const clipboard = await desktop.readClipboard(false);
      if (clipboard?.kind !== "text" || !clipboard.text || !unchanged() || field.readOnly) return;
      if (field instanceof HTMLInputElement && field.type === "date") pasteDate(field, clipboard.text);
      // Native editing dispatches input and keeps the field's undo history.
      else if (!document.execCommand("insertText", false, clipboard.text)) throw new Error("无法粘贴到此输入框。");
    } else if (range.text && unchanged()) {
      if (!document.execCommand("delete")) throw new Error("无法删除选中的文字。");
    }
  }

  async function createMenu() {
    const items = await Promise.all(actionsInOrder.map(action => MenuItem.new({
      text: actions[action],
      action: () => {
        const source = target;
        void perform(action).catch(onError).finally(() => { if (target === source) target = undefined; });
      },
    })));
    return { menu: await Menu.new({ items }), items };
  }

  function open(event: MouseEvent) {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement && fieldTypes.includes(field.type))
      || field.matches(":disabled")) return;
    event.preventDefault();
    event.stopPropagation();
    field.focus({ preventScroll: true });
    const source = { field, value: field.value, range: selection(field) };
    target = source;
    const writable = !field.readOnly;
    const selected = Boolean(source.range.text);
    const copyable = selected && !(field instanceof HTMLInputElement && field.type === "password");
    const enabled = [writable && copyable, copyable, writable, writable && selected];
    const position = new LogicalPosition(event.clientX, event.clientY);
    menuPromise ??= createMenu();
    void menuPromise.then(async ({ menu, items }) => {
      if (target !== source) return;
      await Promise.all(items.map((item, index) => item.setEnabled(enabled[index])));
      if (target === source && document.activeElement === field) await menu.popup(position);
    }).catch(onError);
  }

  function clearTarget() { target = undefined; }

  document.addEventListener("contextmenu", open, true);
  document.addEventListener("focusout", clearTarget, true);
  return () => {
    document.removeEventListener("contextmenu", open, true);
    document.removeEventListener("focusout", clearTarget, true);
    clearTarget();
    void menuPromise?.then(({ menu, items }) => Promise.all([menu.close(), ...items.map(item => item.close())])).catch(onError);
  };
}
