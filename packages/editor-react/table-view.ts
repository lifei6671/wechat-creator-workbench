import type { Ctx } from "@milkdown/kit/ctx";
import { addRowWithAlignment } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode, Schema, Slice } from "@milkdown/kit/prose/model";
import { Fragment } from "@milkdown/kit/prose/model";
import { Selection, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import {
  addColumn, cellAround, CellSelection, deleteColumn, deleteRow, deleteTable, isInTable, moveTableColumn, moveTableRow,
  selectedRect, TableMap, type TableRect,
} from "@milkdown/kit/prose/tables";
import { Decoration, type EditorView, type NodeView } from "@milkdown/kit/prose/view";

export interface TableContext {
  row: number;
  column: number;
  rows: number;
  columns: number;
  selectedCells?: true;
}

export type TableAction =
  | "rowBefore" | "rowAfter" | "rowUp" | "rowDown" | "rowDelete"
  | "columnBefore" | "columnAfter" | "columnLeft" | "columnRight" | "columnDelete"
  | "alignLeft" | "alignCenter" | "alignRight" | "sortAscending" | "sortDescending" | "clearCells" | "delete";

export function preservesTableSelection(view: EditorView, target: EventTarget | null) {
  const cell = target instanceof Element && target.closest("td, th");
  if (!cell || !view.dom.contains(cell)) return false;
  const point = cellAround(view.state.doc.resolve(view.posAtDOM(cell, 0)));
  const { selection } = view.state;
  if (selection instanceof CellSelection) return selection.ranges.some(range => range.$from.pos - 1 === point?.pos);
  return selection instanceof TextSelection && !selection.empty
    && cellAround(selection.$from)?.pos === point?.pos && cellAround(selection.$to)?.pos === point?.pos;
}

export function prepareTableContext(view: EditorView, event: MouseEvent): TableContext | null {
  const mouse = event.button === 2 || event.ctrlKey;
  if (mouse) {
    const cell = event.target instanceof Element && event.target.closest("td, th");
    if (!cell || !view.dom.contains(cell)) return null;
    if (!preservesTableSelection(view, cell)) {
      const pos = view.posAtDOM(cell, 0);
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos), 1)));
    }
  }
  if (!isInTable(view.state)) return null;
  const { selection } = view.state;
  if (selection instanceof TextSelection && !selection.empty) return null;
  const { left, top, map } = selectedRect(view.state);
  return { row: top, column: left, rows: map.height, columns: map.width, selectedCells: selection instanceof CellSelection || undefined };
}

export function tableSelectionDecorations(state: EditorState) {
  const { selection } = state;
  if (!(selection instanceof CellSelection)) return [];
  const { tableStart, map, left, right, top, bottom } = selectedRect(state);
  const decorations: Decoration[] = [];
  selection.forEachCell((cell, pos) => {
    const rect = map.findCell(pos - tableStart);
    const edges = [
      rect.left === left && "left", rect.right === right && "right",
      rect.top === top && "top", rect.bottom === bottom && "bottom",
    ].filter(Boolean).join(" ");
    decorations.push(Decoration.node(pos, pos + cell.nodeSize, { "data-selection-edge": edges }));
  });
  return decorations;
}

export function isTableSlice(slice: Slice) {
  const role = slice.content.firstChild?.type.spec.tableRole;
  return role === "table" ? slice.content.childCount === 1 : Boolean(role);
}

export function cellParagraph(schema: Schema, slice: Slice) {
  const { paragraph, table_line_break: lineBreak } = schema.nodes;
  const content: ProseNode[] = [];
  function append(child: ProseNode) {
    if (child.type.name === "hardbreak") content.push(lineBreak.create());
    else if (child.isText && child.text!.includes("\n")) {
      child.text!.split("\n").forEach((line, index) => {
        if (index) content.push(lineBreak.create());
        if (line) content.push(schema.text(line, child.marks));
      });
    } else content.push(child);
  }
  let hasBlock = false;
  slice.content.descendants(node => {
    if (node.isInline) {
      append(node);
      return false;
    }
    if (!node.isTextblock) return true;
    if (hasBlock || content.length) content.push(lineBreak.create());
    hasBlock = true;
    node.forEach(append);
    return false;
  });
  return content.length ? paragraph.create(null, content) : null;
}

export function replaceSelectedCells(view: EditorView, selection: CellSelection, paragraph = view.state.schema.nodes.paragraph.create()) {
  const tr = view.state.tr;
  selection.forEachCell((cell, pos) => {
    const start = tr.mapping.map(pos + 1);
    tr.replaceWith(start, start + cell.content.size, paragraph);
  });
  view.dispatch(tr);
}

export function runTableAction(ctx: Ctx, view: EditorView, action: TableAction) {
  const { state, dispatch } = view;
  if (!view.editable || !isInTable(state)) return;
  const rect = selectedRect(state);
  const { top, left, right, bottom, table, tableStart, map } = rect;
  const tr = state.tr;
  const moveRow = (to: number) => moveTableRow({ from: top, to })(state, dispatch);
  const moveColumn = (to: number) => moveTableColumn({ from: left, to })(state, dispatch);
  view.focus();
  switch (action) {
    case "clearCells": if (state.selection instanceof CellSelection) replaceSelectedCells(view, state.selection); break;
    case "rowBefore": if (top > 0) dispatch(addRowWithAlignment(ctx, tr, rect, top)); break;
    case "rowAfter": dispatch(addRowWithAlignment(ctx, tr, rect, bottom)); break;
    case "rowUp": if (top > 1) moveRow(top - 1); break;
    case "rowDown": if (top > 0 && bottom < map.height) moveRow(top + 1); break;
    case "rowDelete": if (top > 0 && bottom - top < map.height - 1) deleteRow(state, dispatch); break;
    case "columnBefore": dispatch(addColumn(tr, rect, left)); break;
    case "columnAfter": dispatch(addColumn(tr, rect, right)); break;
    case "columnLeft": if (left > 0) moveColumn(left - 1); break;
    case "columnRight": if (right < map.width) moveColumn(left + 1); break;
    case "columnDelete": if (right - left < map.width) deleteColumn(state, dispatch); break;
    case "delete": deleteTable(state, dispatch); break;
    case "alignLeft": case "alignCenter": case "alignRight": {
      const alignment = action.slice(5).toLowerCase();
      for (let row = 0; row < map.height; row++) {
        for (let col = left; col < right; col++) {
          const pos = map.map[row * map.width + col];
          const cell = table.nodeAt(pos)!;
          tr.setNodeMarkup(tableStart + pos, undefined, { ...cell.attrs, alignment });
        }
      }
      dispatch(tr);
      break;
    }
    case "sortAscending": case "sortDescending": {
      const rows: ProseNode[] = [];
      table.forEach((row, _, index) => { if (index) rows.push(row); });
      const order = action === "sortAscending" ? 1 : -1;
      rows.sort((a, b) => order * a.child(left).textContent.localeCompare(b.child(left).textContent, "zh-CN", { numeric: true }));
      const start = tableStart + table.firstChild!.nodeSize;
      tr.replaceWith(start, tableStart + table.content.size, Fragment.fromArray(rows));
      tr.setSelection(Selection.near(tr.doc.resolve(tableStart + 2), 1));
      dispatch(tr);
      break;
    }
  }
}

export function tableView(ctx: Ctx, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement("div");
  dom.className = "rich-table";
  const table = document.createElement("table");
  const contentDOM = table.createTBody();
  const columnTrack = document.createElement("div");
  columnTrack.className = "rich-table-column-track";
  columnTrack.contentEditable = "false";
  dom.append(table, columnTrack);

  for (const [kind, label] of [["column", "在末尾新增列"], ["row", "在末尾新增行"]] as const) {
    const button = document.createElement("button");
    button.className = `rich-table-add rich-table-add-${kind}`;
    button.type = "button";
    button.contentEditable = "false";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => {
      if (!view.editable) return;
      const tableStart = getPos()! + 1;
      const node = view.state.doc.nodeAt(tableStart - 1)!;
      const map = TableMap.get(node);
      const rect: TableRect = { map, table: node, tableStart, left: 0, top: 0, right: map.width, bottom: map.height };
      const tr = view.state.tr;
      if (kind === "column") addColumn(tr, rect, map.width);
      else addRowWithAlignment(ctx, tr, rect, map.height);
      view.dispatch(tr);
    };
    (kind === "column" ? columnTrack : dom).append(button);
  }

  return {
    dom, contentDOM,
    stopEvent: event => event.target instanceof HTMLButtonElement && event.target.classList.contains("rich-table-add"),
  };
}
