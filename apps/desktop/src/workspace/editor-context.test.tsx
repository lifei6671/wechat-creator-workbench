// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ClipboardIO, MarkdownEditorHandle } from "../../../../packages/editor-react";
import { desktop } from "../desktop";
import { EditorContextMenu } from "./EditorContextMenu";

function Body() {
  return <div className="ProseMirror" style={{ padding: "0 20px" }}><p className="test-body">示例内容</p></div>;
}

it("routes editor context actions and limits the reading menu", async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const editor = {
    current: {
      focus: vi.fn(), search: vi.fn(), target: vi.fn(), insert: vi.fn(), replaceTarget: vi.fn(),
      captureMarkdown: vi.fn(), captureDocumentMatch: vi.fn(),
      captureContext: vi.fn<MarkdownEditorHandle["captureContext"]>(), selectionText: vi.fn(), subscribeSelection: vi.fn(), matchesTarget: vi.fn(),
      retryMissingImages: vi.fn(),
      linkFootnoteMarkdown: vi.fn(),
      command: vi.fn(), tableAction: vi.fn(), prepareContext: vi.fn<MarkdownEditorHandle["prepareContext"]>().mockReturnValue(null),
      hasSelection: () => true, clipboard: vi.fn(), contextCaret: vi.fn(),
    } satisfies MarkdownEditorHandle,
  };
  const clipboard: ClipboardIO = { read: vi.fn(), write: vi.fn(), onError: vi.fn() };
  const display = { limitWidth: true, lineNumbers: false, showTitle: true, convertLinks: false };
  const onDisplayChange = vi.fn();
  const onHostImage = vi.fn();
  const onAddSelectionToChat = vi.fn();
  let hosting = false;
  let addToChat = false;

  const menuItems = () => [...document.querySelectorAll<HTMLElement>(".body-context-menu [role=menuitem]")];
  function openMenu(readOnly: boolean, selector = ".test-body", x = 150) {
    flushSync(() => root.render(<Theme>
      <EditorContextMenu editor={editor} clipboard={clipboard} readOnly={readOnly} display={display} onDisplayChange={onDisplayChange} onError={vi.fn()}
        canHost={() => true} hostBusy={hosting} uploadingSource={hosting ? "asset://image" : undefined} onHostImage={onHostImage}
        onAddSelectionToChat={addToChat ? onAddSelectionToChat : undefined}>
        <Body />
      </EditorContextMenu>
    </Theme>));
    container.querySelector(".ProseMirror")!.getBoundingClientRect = () => new DOMRect(0, 0, 360, 360);
    flushSync(() => container.querySelector(selector)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: 350, button: 2 }),
    ));
  }

  try {
    openMenu(false);
    expect(editor.current.prepareContext).toHaveBeenCalledTimes(1);
    expect(editor.current.contextCaret).toHaveBeenLastCalledWith(true);
    expect(menuItems().map(item => item.textContent)).toContain("插入");
    flushSync(() => menuItems().find(item => item.textContent === "以纯文本形式粘贴")!.click());
    expect(editor.current.clipboard).toHaveBeenCalledWith("paste", clipboard, undefined, true);
    expect(editor.current.contextCaret).toHaveBeenLastCalledWith(false);

    openMenu(true);
    expect(menuItems().map(item => item.textContent)).toEqual(["复制", "全选"]);
    flushSync(() => menuItems()[0].click());
    expect(editor.current.clipboard).toHaveBeenLastCalledWith("copy", clipboard);

    openMenu(false, ".ProseMirror");
    expect(menuItems().map(item => item.textContent)).toContain("插入");
    flushSync(() => document.querySelector(".body-context-menu")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));

    openMenu(true, ".ProseMirror", 10);
    const options = [...document.querySelectorAll<HTMLElement>(".editor-display-menu [role=menuitemcheckbox]")];
    expect(options.map(item => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["限制行宽", "true"], ["行号", "false"], ["页面内标题", "true"], ["链接转脚注", "false"],
    ]);
    expect(editor.current.prepareContext).toHaveBeenCalledTimes(3);
    flushSync(() => options[1].click());
    expect(onDisplayChange).toHaveBeenCalledWith("lineNumbers", true);
    openMenu(false, ".ProseMirror", 10);
    const convert = [...document.querySelectorAll<HTMLElement>(".editor-display-menu [role=menuitemcheckbox]")].find(item => item.textContent === "链接转脚注")!;
    flushSync(() => convert.click());
    expect(onDisplayChange).toHaveBeenCalledWith("convertLinks", true);

    editor.current.prepareContext.mockReturnValueOnce("cellText");
    openMenu(false);
    expect(menuItems().map(item => item.textContent)).toEqual([
      "插入链接", "文本格式", "剪切", "复制", "粘贴", "以纯文本形式粘贴", "全选单元格文字",
    ]);
    flushSync(() => menuItems().find(item => item.textContent === "全选单元格文字")!.click());
    expect(editor.current.command).toHaveBeenLastCalledWith("selectCellText", undefined);

    editor.current.prepareContext.mockReturnValueOnce("code");
    openMenu(false);
    expect(menuItems().map(item => item.textContent)).toEqual(["剪切", "复制", "粘贴", "全选代码"]);
    flushSync(() => menuItems().find(item => item.textContent === "粘贴")!.click());
    expect(editor.current.clipboard).toHaveBeenLastCalledWith("paste", clipboard);

    editor.current.prepareContext.mockReturnValueOnce({ row: 1, column: 0, rows: 3, columns: 2 });
    openMenu(false);
    expect(menuItems()).toHaveLength(0);
    const table = [...document.querySelectorAll<HTMLElement>(".table-context-menu [role=menuitem]")];
    expect(table.map(item => item.textContent)).toEqual(["行", "列", "按此列升序", "按此列降序", "复制单元格", "删除表格"]);
    flushSync(() => table[2].click());
    expect(editor.current.tableAction).toHaveBeenCalledWith("sortAscending");

    const image = { kind: "image" as const, src: "asset://image", available: true, isCurrent: () => true,
      isUploading: () => hosting, setUploading: vi.fn(), replaceSource: vi.fn(), remove: vi.fn() };
    const copy = vi.spyOn(desktop, "copyImage").mockResolvedValue(undefined);
    const save = vi.spyOn(desktop, "saveImage").mockResolvedValue(true);
    try {
      function openImage(readOnly: boolean) {
        editor.current.prepareContext.mockReturnValueOnce(image);
        openMenu(readOnly);
        expect(menuItems()).toHaveLength(0);
        return [...document.querySelectorAll<HTMLElement>('[aria-label="图片操作"] [role=menuitem]')];
      }
      let imageItems = openImage(false);
      expect(imageItems.map(item => item.textContent)).toEqual(["复制图片", "另存为", "上传到图床", "移除图片"]);
      flushSync(() => imageItems[0].click());
      expect(copy).toHaveBeenCalledExactlyOnceWith("asset://image");
      imageItems = openImage(true);
      expect(imageItems.map(item => item.textContent)).toEqual(["复制图片", "另存为"]);
      flushSync(() => imageItems[1].click());
      expect(save).toHaveBeenCalledExactlyOnceWith("asset://image");
      imageItems = openImage(false);
      flushSync(() => imageItems[2].click());
      expect(onHostImage).toHaveBeenCalledExactlyOnceWith(image);
      hosting = true;
      imageItems = openImage(false);
      expect(imageItems[2].textContent).toBe("正在上传…");
      expect(imageItems[2].getAttribute("aria-disabled")).toBe("true");
      expect(imageItems[2].querySelector(".rich-progress")).not.toBeNull();
      flushSync(() => imageItems[3].click());
      expect(image.remove).toHaveBeenCalledOnce();
    } finally { copy.mockRestore(); save.mockRestore(); }

    addToChat = true;
    editor.current.captureContext.mockReturnValueOnce({ entryId: "entry", session: Symbol(), localRevision: 0, from: 1, to: 3,
      original: "示例", originalSlice: "{}", scope: "selection", headingPath: ["章节"] });
    openMenu(false);
    const item = menuItems().find(item => item.textContent === "将所选内容添加到聊天");
    expect(item).toBeDefined();
    flushSync(() => item!.click());
    expect(editor.current.captureContext).toHaveBeenCalledExactlyOnceWith("selection");
    await vi.waitFor(() => expect(onAddSelectionToChat).toHaveBeenCalledExactlyOnceWith({ original: "示例", headingPath: ["章节"] }));
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
