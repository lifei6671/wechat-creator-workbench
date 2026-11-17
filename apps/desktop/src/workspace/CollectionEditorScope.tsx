import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { ContextMenu } from "@radix-ui/themes";
import { Clipboard, Copy, Redo2, Scan, Scissors, Undo2 } from "lucide-react";
import { editClipboardField } from "../editor/clipboard";

export function CollectionEditorScope({ onLeave, className, ...props }: Omit<ComponentProps<"div">, "onBlur" | "onFocus" | "onContextMenu"> & {
  onLeave(): void;
}) {
  const blur = useRef(0);
  useLayoutEffect(() => () => cancelAnimationFrame(blur.current), []);
  return <div {...props} className={`collection-inline-editor nodrag nopan nowheel ${className ?? ""}`}
    onFocus={() => cancelAnimationFrame(blur.current)} onBlur={event => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      cancelAnimationFrame(blur.current);
      // Menus and editor popovers can move focus into a portal in the same frame.
      blur.current = requestAnimationFrame(onLeave);
    }} onContextMenu={event => {
      event.preventDefault();
      event.stopPropagation();
    }} />;
}

export function CollectionTextEditor({ value, onChange, onLeave, onError }: {
  value: string;
  onChange(value: string): void;
  onLeave(): void;
  onError(error: unknown): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const afterMenu = useRef<(() => void) | undefined>(undefined);
  const outside = useRef(false);
  const [selection, setSelection] = useState(false);
  return <CollectionEditorScope className="collection-text-editor" onLeave={onLeave}>
    <ContextMenu.Root onOpenChange={open => { if (open) outside.current = false; }}>
      <ContextMenu.Trigger onContextMenu={() => setSelection(input.current!.selectionStart !== input.current!.selectionEnd)}>
        <textarea ref={input} data-canvas-text-editor className="collection-card-input" aria-label="文本卡片 Markdown"
          autoFocus defaultValue={value} onChange={event => onChange(event.currentTarget.value)}
          onKeyDown={event => {
            if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Escape") {
              event.stopPropagation();
              event.currentTarget.blur();
            }
          }} />
      </ContextMenu.Trigger>
      <ContextMenu.Content size="1" aria-label="文本编辑操作" onInteractOutside={() => { outside.current = true; }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const action = afterMenu.current;
          afterMenu.current = undefined;
          if (outside.current && !action) onLeave();
          else if (input.current) { input.current.focus(); action?.(); }
        }}>
        <ContextMenu.Item disabled={!selection} onSelect={() => {
          afterMenu.current = () => { void editClipboardField(input.current!, "cut").catch(onError); };
        }}><Scissors size={15} />剪切</ContextMenu.Item>
        <ContextMenu.Item disabled={!selection} onSelect={() => {
          afterMenu.current = () => { void editClipboardField(input.current!, "copy").catch(onError); };
        }}><Copy size={15} />复制</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => {
          afterMenu.current = () => { void editClipboardField(input.current!, "paste").catch(onError); };
        }}><Clipboard size={15} />粘贴</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => { afterMenu.current = () => input.current?.select(); }}><Scan size={15} />全选</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={() => { afterMenu.current = () => document.execCommand("undo"); }}><Undo2 size={15} />撤销</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => { afterMenu.current = () => document.execCommand("redo"); }}><Redo2 size={15} />重做</ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  </CollectionEditorScope>;
}
