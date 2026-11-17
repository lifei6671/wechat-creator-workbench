// @vitest-environment jsdom
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { expect, it, vi } from "vitest";
import { desktop } from "./desktop";
import { installInputContextMenu } from "./input-context-menu";

it("routes the native menu's clipboard actions to the selected input", async () => {
  const callbacks = new Map<string, () => void>();
  const menuItems = new Map<string, { setEnabled: ReturnType<typeof vi.fn>; close(): Promise<void> }>();
  vi.spyOn(MenuItem, "new").mockImplementation(async options => {
    callbacks.set(options.text, () => options.action?.(options.text));
    const item = { setEnabled: vi.fn().mockResolvedValue(undefined), close: async () => {} };
    menuItems.set(options.text, item);
    return item as unknown as MenuItem;
  });
  const popup = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(Menu, "new").mockResolvedValue({ popup, close: async () => {} } as unknown as Menu);
  const copy = vi.spyOn(desktop, "copyText").mockResolvedValue(undefined);
  const read = vi.spyOn(desktop, "readClipboard").mockResolvedValue({ kind: "text", text: "替换文字" });
  const edit = vi.fn().mockReturnValue(true);
  Object.defineProperty(document, "execCommand", { value: edit, configurable: true });
  const input = document.createElement("input");
  input.value = "原始文字";
  document.body.append(input);
  const onError = vi.fn();
  const uninstall = installInputContextMenu(onError);
  try {
    input.focus();
    input.setSelectionRange(0, 2);
    const openMenu = () => input.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    expect(openMenu()).toBe(false);
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(1));
    expect(menuItems.get("剪切")?.setEnabled).toHaveBeenLastCalledWith(true);
    expect(menuItems.get("删除")?.setEnabled).toHaveBeenLastCalledWith(true);
    callbacks.get("剪切")!();
    await vi.waitFor(() => expect(edit).toHaveBeenCalledWith("delete"));
    expect(copy).toHaveBeenCalledExactlyOnceWith("原始");

    input.setSelectionRange(4, 4);
    openMenu();
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(2));
    expect(menuItems.get("复制")?.setEnabled).toHaveBeenLastCalledWith(false);
    expect(menuItems.get("删除")?.setEnabled).toHaveBeenLastCalledWith(false);
    expect(menuItems.get("粘贴")?.setEnabled).toHaveBeenLastCalledWith(true);
    callbacks.get("粘贴")!();
    await vi.waitFor(() => expect(edit).toHaveBeenCalledWith("insertText", false, "替换文字"));
    expect(read).toHaveBeenCalledExactlyOnceWith(false);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    uninstall();
    input.remove();
    Reflect.deleteProperty(document, "execCommand");
    vi.restoreAllMocks();
  }
});
