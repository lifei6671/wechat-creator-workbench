import { ContextMenu } from "@radix-ui/themes";
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowDownAZ, ArrowLeft, ArrowRight, ArrowUp, ArrowUpAZ,
  Clipboard, Columns2, Copy, Eraser, Plus, Rows2, Scissors, Trash2,
} from "lucide-react";
import type { ClipboardAction, TableAction, TableContext } from "../../../../packages/editor-react";

export function TableContextMenu({ table, readOnly, onAction, onClipboard }: {
  table: TableContext;
  readOnly: boolean;
  onAction(action: TableAction): void;
  onClipboard(action: ClipboardAction): void;
}) {
  const { row, column, rows, columns } = table;
  if (table.selectedCells) return <ContextMenu.Content size="1" className="table-context-menu" aria-label="单元格选区操作">
    {!readOnly && <ContextMenu.Item onSelect={() => onClipboard("cut")}><Scissors size={15} />剪切单元格</ContextMenu.Item>}
    <ContextMenu.Item onSelect={() => onClipboard("copy")}><Copy size={15} />复制单元格</ContextMenu.Item>
    {!readOnly && <>
      <ContextMenu.Item onSelect={() => onClipboard("paste")}><Clipboard size={15} />粘贴到选区</ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={() => onAction("alignLeft")}><AlignLeft size={15} />左对齐</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => onAction("alignCenter")}><AlignCenter size={15} />居中对齐</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => onAction("alignRight")}><AlignRight size={15} />右对齐</ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={() => onAction("clearCells")}><Eraser size={15} />清空选中的单元格</ContextMenu.Item>
    </>}
  </ContextMenu.Content>;
  return <ContextMenu.Content size="1" className="table-context-menu" aria-label="表格操作">
    {!readOnly && <>
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger><Rows2 size={15} />行</ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          <ContextMenu.Item disabled={row === 0} onSelect={() => onAction("rowBefore")}><Plus size={15} />在上方新增行</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => onAction("rowAfter")}><Plus size={15} />在下方新增行</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={row < 2} onSelect={() => onAction("rowUp")}><ArrowUp size={15} />向上移动行</ContextMenu.Item>
          <ContextMenu.Item disabled={row === 0 || row === rows - 1} onSelect={() => onAction("rowDown")}><ArrowDown size={15} />向下移动行</ContextMenu.Item>
          <ContextMenu.Item color="red" disabled={row === 0 || rows < 3} onSelect={() => onAction("rowDelete")}><Trash2 size={15} />删除行</ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger><Columns2 size={15} />列</ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          <ContextMenu.Item onSelect={() => onAction("columnBefore")}><Plus size={15} />在左侧新增列</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => onAction("columnAfter")}><Plus size={15} />在右侧新增列</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={column === 0} onSelect={() => onAction("columnLeft")}><ArrowLeft size={15} />向左移动列</ContextMenu.Item>
          <ContextMenu.Item disabled={column === columns - 1} onSelect={() => onAction("columnRight")}><ArrowRight size={15} />向右移动列</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onSelect={() => onAction("alignLeft")}><AlignLeft size={15} />左对齐</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => onAction("alignCenter")}><AlignCenter size={15} />居中对齐</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => onAction("alignRight")}><AlignRight size={15} />右对齐</ContextMenu.Item>
          <ContextMenu.Item color="red" disabled={columns === 1} onSelect={() => onAction("columnDelete")}><Trash2 size={15} />删除列</ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
      <ContextMenu.Separator />
      <ContextMenu.Item disabled={rows < 3} onSelect={() => onAction("sortAscending")}><ArrowDownAZ size={15} />按此列升序</ContextMenu.Item>
      <ContextMenu.Item disabled={rows < 3} onSelect={() => onAction("sortDescending")}><ArrowUpAZ size={15} />按此列降序</ContextMenu.Item>
    </>}
    <ContextMenu.Item onSelect={() => onClipboard("copy")}><Copy size={15} />复制单元格</ContextMenu.Item>
    {!readOnly && <>
      <ContextMenu.Separator />
      <ContextMenu.Item color="red" onSelect={() => onAction("delete")}><Trash2 size={15} />删除表格</ContextMenu.Item>
    </>}
  </ContextMenu.Content>;
}
