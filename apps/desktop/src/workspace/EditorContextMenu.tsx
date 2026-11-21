import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Button, ContextMenu, Dialog, TextField } from "@radix-ui/themes";
import {
  Bold, CaseSensitive, Clipboard, ClipboardType, CloudUpload, Code2, Copy, FileCode2, FileDown, Heading, ImageMinus, Italic, Link2, List, ListOrdered,
  ListPlus, Minus, Pilcrow, Quote, Redo2, Ruler, Scan, Scissors, Sigma, Sparkles, Strikethrough, Table2, Undo2,
} from "lucide-react";
import type { ClipboardIO, EditorCommand, ImageContext, LinkContext, MarkdownEditorHandle, TableContext } from "../../../../packages/editor-react";
import type { ChatSelection } from "../ai/context";
import { desktop } from "../desktop";
import { TableContextMenu } from "./TableContextMenu";

export interface EditorDisplay {
  limitWidth: boolean;
  lineNumbers: boolean;
  showTitle: boolean;
  convertLinks: boolean;
}

export const editorDisplayItems = [
  ["limitWidth", "限制行宽", Ruler],
  ["lineNumbers", "行号", ListOrdered],
  ["showTitle", "页面内标题", CaseSensitive],
  ["convertLinks", "链接转脚注", FileCode2],
] as const;

export function EditorContextMenu({ editor, clipboard, readOnly, display, onDisplayChange, onError, onLeave, canHost, hostBusy, uploadingSource, onHostImage, onAddSelectionToChat, children }: {
  editor: RefObject<MarkdownEditorHandle | null>;
  clipboard: ClipboardIO;
  readOnly: boolean;
  display?: EditorDisplay;
  onDisplayChange?(option: keyof EditorDisplay, checked: boolean): void;
  onError(error: unknown): void;
  onLeave?(): void;
  canHost?(src: string): boolean;
  hostBusy?: boolean;
  uploadingSource?: string;
  onHostImage?(image: ImageContext): void;
  onAddSelectionToChat?(selection: ChatSelection): void;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState(false);
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState<"display" | "body" | "code" | "cellText" | "object" | TableContext | ImageContext>("body");
  const [linkContext, setLinkContext] = useState<LinkContext | null>(null);
  const [addLink, setAddLink] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const linkOrigin = useRef<MarkdownEditorHandle | null>(null);
  const afterMenuClose = useRef<(() => void) | null>(null);
  const focusOutside = useRef(false);
  const uploadingImage = typeof menu === "object" && "kind" in menu && menu.src === uploadingSource && menu.isUploading();

  function command(action: EditorCommand, value?: string) {
    editor.current?.command(action, value);
  }

  function finishContextAction(event: Event) {
    const action = afterMenuClose.current;
    afterMenuClose.current = null;
    if (onLeave && !addLink) {
      event.preventDefault();
      if (focusOutside.current && !action) onLeave();
      else if (!action) editor.current?.focus();
    }
    if (action) { event.preventDefault(); action(); }
  }
  const menuFocus = {
    onCloseAutoFocus: finishContextAction,
    onInteractOutside: () => { focusOutside.current = true; },
  };

  const convertLinkItem = !readOnly && linkContext && <ContextMenu.Item onSelect={() => { afterMenuClose.current = linkContext.convert; }}>
    <FileCode2 size={15} />将链接转为脚注
  </ContextMenu.Item>;

  function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("address")).trim();
    if (!/^(?:https?:\/\/|mailto:)/i.test(address) || !URL.canParse(address)) {
      setInvalid(true);
      return;
    }
    linkOrigin.current?.command("link", address);
    setAddLink(false);
  }

  return <>
    <ContextMenu.Root onOpenChange={open => {
      if (open) focusOutside.current = false;
      else editor.current?.contextCaret?.(false);
    }}>
      <ContextMenu.Trigger onContextMenu={event => {
        const target = event.target as Element;
        setLinkContext(null);
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          event.preventDefault();
          return;
        }
        const body = event.currentTarget.querySelector<HTMLElement>(".ProseMirror");
        if (display && body && (event.button === 2 || event.ctrlKey) && !target.closest(".ProseMirror > *")) {
          const { left, right, width } = body.getBoundingClientRect();
          const { paddingLeft, paddingRight } = getComputedStyle(body);
          if (width && (event.clientX < left + parseFloat(paddingLeft) || event.clientX > right - parseFloat(paddingRight))) {
            setMenu("display");
            return;
          }
        }
        const handle = editor.current;
        let context: NonNullable<ReturnType<MarkdownEditorHandle["prepareContext"]>> | "body" = handle?.prepareContext(event.nativeEvent) ?? "body";
        if (typeof context === "object" && "kind" in context && context.kind === "link") {
          setLinkContext(context);
          context = context.scope;
        }
        if (context === "body" || context === "code" || context === "cellText") handle?.contextCaret?.(true);
        setMenu(context);
        setReady(Boolean(handle));
        setSelected(handle?.hasSelection() ?? false);
      }}>
        <div className="editor-area">{children}</div>
      </ContextMenu.Trigger>
      {typeof menu === "object" ? ("kind" in menu ? <ContextMenu.Content size="1" aria-label="图片操作" {...menuFocus}>
        <ContextMenu.Item disabled={!menu.available} onSelect={() => { void desktop.copyImage(menu.src).catch(onError); }}><Copy size={15} />复制图片</ContextMenu.Item>
        <ContextMenu.Item disabled={!menu.available} onSelect={() => { void desktop.saveImage(menu.src).catch(onError); }}><FileDown size={15} />另存为</ContextMenu.Item>
        {!readOnly && (uploadingImage || (menu.isCurrent() && canHost?.(menu.src))) && <ContextMenu.Item disabled={uploadingImage || hostBusy}
          onSelect={() => onHostImage?.(menu)}>
          {uploadingImage ? <span className="image-upload-menu-spinner rich-progress" aria-hidden="true" /> : <CloudUpload size={15} />}
          {uploadingImage ? "正在上传…" : "上传到图床"}
        </ContextMenu.Item>}
        {!readOnly && <ContextMenu.Item onSelect={menu.remove}><ImageMinus size={15} />移除图片</ContextMenu.Item>}
      </ContextMenu.Content> : <TableContextMenu table={menu} readOnly={readOnly} convertLinkItem={convertLinkItem} {...menuFocus}
        onAction={action => editor.current?.tableAction(action)} onClipboard={action => editor.current?.clipboard(action, clipboard)} />)
      : menu === "object" ? <ContextMenu.Content size="1" aria-label="内容块操作" {...menuFocus}>
        {!readOnly && <ContextMenu.Item onSelect={() => editor.current?.clipboard("cut", clipboard)}><Scissors size={15} />剪切</ContextMenu.Item>}
        <ContextMenu.Item onSelect={() => editor.current?.clipboard("copy", clipboard)}><Copy size={15} />复制</ContextMenu.Item>
      </ContextMenu.Content>
      : menu === "display" && display ? <ContextMenu.Content size="1" className="editor-display-menu" aria-label="编辑区显示选项">
        {editorDisplayItems.map(([option, label, Icon]) => <ContextMenu.CheckboxItem key={option} checked={display[option]}
          onCheckedChange={checked => onDisplayChange?.(option, checked)}><Icon size={15} />{label}</ContextMenu.CheckboxItem>)}
      </ContextMenu.Content> : <ContextMenu.Content size="1" className="body-context-menu"
        {...menuFocus}
        aria-label={menu === "code" ? "代码块操作" : menu === "cellText" ? "单元格文字操作" : "正文编辑操作"}>
        {!readOnly && menu !== "code" && <>
          {selected && onAddSelectionToChat && <ContextMenu.Item onSelect={() => {
            const selection = editor.current?.captureContext("selection");
            if (!selection?.original.trim()) return;
            const { original, headingPath } = selection;
            afterMenuClose.current = () => onAddSelectionToChat({ original, headingPath });
          }}>
            <Sparkles size={15} />将所选内容添加到聊天
          </ContextMenu.Item>}
          {convertLinkItem}
          <ContextMenu.Item disabled={!ready} onSelect={() => {
            linkOrigin.current = editor.current;
            setInvalid(false);
            setAddLink(true);
          }}><Link2 size={15} />插入链接</ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger disabled={!ready}><Bold size={15} />文本格式</ContextMenu.SubTrigger>
            <ContextMenu.SubContent>
              <ContextMenu.Item onSelect={() => command("bold")}><Bold size={15} />粗体</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("italic")}><Italic size={15} />斜体</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("strike")}><Strikethrough size={15} />删除线</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("inlineCode")}><Code2 size={15} />行内代码</ContextMenu.Item>
            </ContextMenu.SubContent>
          </ContextMenu.Sub>
          {menu === "body" && <>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger disabled={!ready}><Pilcrow size={15} />段落设置</ContextMenu.SubTrigger>
            <ContextMenu.SubContent>
              <ContextMenu.Item onSelect={() => command("paragraph")}><Pilcrow size={15} />正文</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("heading1")}><Heading size={15} />一级标题</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("heading2")}><Heading size={15} />二级标题</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("heading3")}><Heading size={15} />三级标题</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("heading4")}><Heading size={15} />四级标题</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("heading5")}><Heading size={15} />五级标题</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("heading6")}><Heading size={15} />六级标题</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onSelect={() => command("bulletList")}><List size={15} />无序列表</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("orderedList")}><List size={15} />有序列表</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("taskList")}><List size={15} />任务列表</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("quote")}><Quote size={15} />引用</ContextMenu.Item>
            </ContextMenu.SubContent>
          </ContextMenu.Sub>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger disabled={!ready}><ListPlus size={15} />插入</ContextMenu.SubTrigger>
            <ContextMenu.SubContent>
              <ContextMenu.Item onSelect={() => {
                const origin = editor.current;
                afterMenuClose.current = () => { if (origin && origin === editor.current) origin.command("footnote"); };
              }}><FileCode2 size={15} />脚注</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("table")}><Table2 size={15} />表格</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("horizontalRule")}><Minus size={15} />分隔线</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onSelect={() => command("codeBlock")}><Code2 size={15} />代码块</ContextMenu.Item>
              <ContextMenu.Item onSelect={() => command("mathBlock")}><Sigma size={15} />数学块</ContextMenu.Item>
            </ContextMenu.SubContent>
          </ContextMenu.Sub>
          </>}
          <ContextMenu.Separator />
        </>}
        {!readOnly && (selected || menu === "body") && <ContextMenu.Item disabled={!selected}
          onSelect={() => editor.current?.clipboard("cut", clipboard)}><Scissors size={15} />剪切</ContextMenu.Item>}
        {(selected || menu === "body") && <ContextMenu.Item disabled={!selected} onSelect={() => editor.current?.clipboard("copy", clipboard)}><Copy size={15} />复制</ContextMenu.Item>}
        {!readOnly && <>
          <ContextMenu.Item disabled={!ready} onSelect={() => editor.current?.clipboard("paste", clipboard)}><Clipboard size={15} />粘贴</ContextMenu.Item>
          {menu !== "code" && <ContextMenu.Item disabled={!ready} onSelect={() => editor.current?.clipboard("paste", clipboard, undefined, true)}><ClipboardType size={15} />以纯文本形式粘贴</ContextMenu.Item>}
        </>}
        <ContextMenu.Item disabled={!ready} onSelect={() => command(menu === "cellText" ? "selectCellText" : "selectAll")}><Scan size={15} />
          {menu === "code" ? "全选代码" : menu === "cellText" ? "全选单元格文字" : "全选"}
        </ContextMenu.Item>
        {!readOnly && menu === "body" && <>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={!ready} onSelect={() => command("undo")}><Undo2 size={15} />撤销</ContextMenu.Item>
          <ContextMenu.Item disabled={!ready} onSelect={() => command("redo")}><Redo2 size={15} />重做</ContextMenu.Item>
        </>}
      </ContextMenu.Content>}
    </ContextMenu.Root>
    {addLink && <Dialog.Root open onOpenChange={setAddLink}>
      <Dialog.Content maxWidth="400px" aria-describedby={undefined} onCloseAutoFocus={event => {
        event.preventDefault();
        linkOrigin.current?.focus();
      }}>
        <Dialog.Title>插入链接</Dialog.Title>
        <form className="dialog-form" onSubmit={link}>
          <label>链接地址<TextField.Root name="address" placeholder="https://" autoFocus required /></label>
          {invalid && <p className="inline-error" role="alert">请输入有效的网址或邮件链接</p>}
          <div className="dialog-actions">
            <Dialog.Close><Button type="button" variant="soft" color="gray">取消</Button></Dialog.Close>
            <Button type="submit">插入</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>}
  </>;
}
