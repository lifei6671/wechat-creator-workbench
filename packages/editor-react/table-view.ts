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
    case "rowUp": if (top > 0) moveRow(top - 1); break;
    case "rowDown": if (bottom < map.height) moveRow(top + 1); break;
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

// Milkdown Crepe 7.23 table controls, scaled to fit the editor toolbar.
const plusIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13H13V18C13 18.55 12.55 19 12 19C11.45 19 11 18.55 11 18V13H6C5.45 13 5 12.55 5 12C5 11.45 5.45 11 6 11H11V6C11 5.45 11.45 5 12 5C12.55 5 13 5.45 13 6V11H18C18.55 11 19 11.45 19 12C19 12.55 18.55 13 18 13Z"/></svg>`;
const dragIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 9.83366C3.35833 9.83366 3.23961 9.78571 3.14383 9.68983C3.04794 9.59394 3 9.47516 3 9.33349C3 9.19171 3.04794 9.07299 3.14383 8.97733C3.23961 8.88155 3.35833 8.83366 3.5 8.83366H12.5C12.6417 8.83366 12.7604 8.8816 12.8562 8.97749C12.9521 9.07338 13 9.19216 13 9.33383C13 9.4756 12.9521 9.59433 12.8562 9.68999C12.7604 9.78577 12.6417 9.83366 12.5 9.83366H3.5ZM3.5 7.16699C3.35833 7.16699 3.23961 7.11905 3.14383 7.02316C3.04794 6.92727 3 6.80849 3 6.66683C3 6.52505 3.04794 6.40633 3.14383 6.31066C3.23961 6.21488 3.35833 6.16699 3.5 6.16699H12.5C12.6417 6.16699 12.7604 6.21494 12.8562 6.31083C12.9521 6.40671 13 6.52549 13 6.66716C13 6.80894 12.9521 6.92766 12.8562 7.02333C12.7604 7.1191 12.6417 7.16699 12.5 7.16699H3.5Z"/></svg>`;

type TableAxis = "row" | "column";
type TableDrag = {
  axis: TableAxis;
  from: number;
  node: ProseNode;
  size: number;
  grip: HTMLButtonElement;
  pointerId: number;
  startX: number;
  startY: number;
};
const edgeSnap = 8;

function nearEdge(pointer: number, start: number, end: number) {
  const before = Math.abs(pointer - start);
  const after = Math.abs(pointer - end);
  if (Math.min(before, after) > Math.min(edgeSnap, (end - start) / 3)) return undefined;
  return before <= after ? 0 : 1;
}

export function tableView(ctx: Ctx, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement("div");
  dom.className = "rich-table";
  const table = document.createElement("table");
  const contentDOM = table.createTBody();
  const scroller = document.createElement("div");
  scroller.className = "rich-table-scroll";
  scroller.append(table);
  const controls = document.createElement("div");
  controls.className = "rich-table-controls";
  controls.contentEditable = "false";
  const preview = document.createElement("div");
  preview.className = "rich-table-preview";
  preview.hidden = true;
  preview.inert = true;
  preview.setAttribute("aria-hidden", "true");
  const previewBody = preview.appendChild(document.createElement("table")).createTBody();
  dom.append(scroller, controls);
  controls.append(preview);
  let drag: TableDrag | undefined;

  function control(action: "add" | "grip", axis: TableAxis, label: string, icon: string) {
    const button = document.createElement("button");
    button.className = `rich-table-control rich-table-control-${axis} rich-table-${action}-${axis}`;
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    button.innerHTML = icon;
    button.hidden = true;
    controls.append(button);
    return button;
  }

  function setOffset(element: HTMLElement, axis: TableAxis, offset: number) {
    if (axis === "row") element.style.top = `${offset}px`;
    else element.style.left = `${offset}px`;
  }

  function axisControls(axis: TableAxis, noun: string) {
    let index = 0;
    let boundary = 0;
    const add = control("add", axis, `在此处插入${noun}`, plusIcon);
    const grip = control("grip", axis, `拖动${noun}排序`, dragIcon);
    const line = document.createElement("div");
    line.className = `rich-table-line rich-table-line-${axis}`;
    line.hidden = true;
    controls.append(line);

    add.onmousedown = event => event.preventDefault();
    add.onclick = () => {
      if (!view.editable || add.hidden) return;
      const tableStart = getPos()! + 1;
      const node = view.state.doc.nodeAt(tableStart - 1)!;
      const map = TableMap.get(node);
      const rect: TableRect = { map, table: node, tableStart, left: 0, top: 0, right: map.width, bottom: map.height };
      const tr = view.state.tr;
      if (axis === "column") addColumn(tr, rect, boundary);
      else addRowWithAlignment(ctx, tr, rect, boundary);
      hide();
      view.dispatch(tr);
    };
    grip.tabIndex = -1;
    grip.onpointerdown = event => {
      if (!event.isPrimary || event.button !== 0 || drag || !view.editable || grip.hidden) return;
      const origin = axis === "row" ? table.rows[index] : table.rows[0].cells[index];
      const { width, height } = origin.getBoundingClientRect();
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      drag = {
        axis, from: index, node: view.state.doc.nodeAt(getPos()!)!, size: axis === "row" ? height : width,
        grip, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      };
      window.addEventListener("keydown", cancelOnEscape, true);
      window.addEventListener("blur", resetDrag);
    };
    grip.onpointermove = updateDrag;
    grip.onpointerup = finishDrag;
    grip.onpointercancel = grip.onlostpointercapture = event => {
      if (drag?.pointerId === event.pointerId) resetDrag();
    };

    function hide() {
      add.hidden = grip.hidden = line.hidden = true;
    }
    function showLine(offset: number) {
      setOffset(line, axis, offset);
      line.hidden = false;
    }
    return {
      line, hide, showLine,
      showGrip(cellIndex: number, center: number) {
        index = cellIndex;
        setOffset(grip, axis, center);
        grip.hidden = false;
      },
      showInsert(at: number, offset: number) {
        boundary = at;
        setOffset(add, axis, offset);
        add.hidden = false;
        showLine(offset);
      },
    };
  }
  const rows = axisControls("row", "行");
  const columns = axisControls("column", "列");

  function hideControls() {
    rows.hide();
    columns.hide();
  }
  scroller.onscroll = () => { resetDrag(); hideControls(); };
  function resetDrag() {
    if (!drag) return;
    const { grip, pointerId } = drag;
    drag = undefined;
    window.removeEventListener("keydown", cancelOnEscape, true);
    window.removeEventListener("blur", resetDrag);
    if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId);
    preview.hidden = true;
    previewBody.replaceChildren();
    delete controls.dataset.dragAxis;
    hideControls();
  }
  function cancelOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    resetDrag();
  }

  function cellAt(target: EventTarget | null) {
    const cell = target instanceof Element ? target.closest<HTMLTableCellElement>("td, th") : null;
    return cell && contentDOM.contains(cell) ? cell : null;
  }
  dom.onpointermove = event => {
    const cell = cellAt(event.target);
    if (!cell || !view.editable || drag || event.buttons) return;
    const row = cell.parentElement as HTMLTableRowElement;
    const tableRect = dom.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowEdge = nearEdge(event.clientY, rowRect.top, rowRect.bottom);
    const columnEdge = nearEdge(event.clientX, cellRect.left, cellRect.right);
    hideControls();
    if (rowEdge === undefined && columnEdge === undefined) {
      rows.showGrip(row.rowIndex, rowRect.top - tableRect.top + rowRect.height / 2);
      columns.showGrip(cell.cellIndex, cellRect.left - tableRect.left + cellRect.width / 2);
      return;
    }
    if (rowEdge !== undefined && row.rowIndex + rowEdge > 0) {
      rows.showInsert(row.rowIndex + rowEdge, (rowEdge ? rowRect.bottom : rowRect.top) - tableRect.top);
    }
    if (columnEdge !== undefined) {
      columns.showInsert(cell.cellIndex + columnEdge, (columnEdge ? cellRect.right : cellRect.left) - tableRect.left);
    }
  };
  dom.onpointerleave = () => { if (!drag) hideControls(); };

  function renderPreview({ axis, from, size }: TableDrag, { width, height }: DOMRect) {
    const picked = axis === "row" ? [table.rows[from].cloneNode(true)] : Array.from(table.rows, row => {
      const copy = row.cloneNode(false);
      copy.appendChild(row.cells[from].cloneNode(true));
      return copy;
    });
    previewBody.replaceChildren(...picked);
    preview.style.width = `${axis === "row" ? width : size}px`;
    preview.style.height = `${axis === "row" ? size : height}px`;
  }
  function movePreview(event: PointerEvent, { axis, size }: TableDrag, bounds: DOMRect) {
    const pointer = axis === "row" ? event.clientY - bounds.top : event.clientX - bounds.left;
    const extent = axis === "row" ? bounds.height : bounds.width;
    setOffset(preview, axis, Math.max(-edgeSnap, Math.min(pointer - size / 2, extent - size + edgeSnap)));
    setOffset(preview, axis === "row" ? "column" : "row", 0);
    preview.hidden = false;
  }
  function dropTarget(event: PointerEvent, { axis, from }: TableDrag) {
    // Captured events target the handle, so test the pointer's actual location.
    if (!dom.contains(document.elementFromPoint(event.clientX, event.clientY))) return;
    const items = axis === "row" ? Array.from(table.rows) : Array.from(table.rows[0].cells);
    const pointer = axis === "row" ? event.clientY : event.clientX;
    for (const [index, item] of items.entries()) {
      const { top, left, width, height } = item.getBoundingClientRect();
      if (pointer < (axis === "row" ? top + height / 2 : left + width / 2)) {
        return { to: index > from ? index - 1 : index, edge: axis === "row" ? top : left };
      }
    }
    const last = items.at(-1)!.getBoundingClientRect();
    return { to: items.length - 1, edge: axis === "row" ? last.bottom : last.right };
  }
  function updateDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const pos = getPos();
    if (!view.editable || pos === undefined || view.state.doc.nodeAt(pos) !== drag.node) {
      resetDrag();
      return;
    }
    const bounds = dom.getBoundingClientRect();
    const { axis, from, startX, startY } = drag;
    if (preview.hidden) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < 5) return;
      controls.dataset.dragAxis = axis;
      renderPreview(drag, bounds);
    }
    movePreview(event, drag, bounds);
    const target = dropTarget(event, drag);
    const active = axis === "row" ? rows : columns;
    if (!target || target.to === from) active.line.hidden = true;
    else active.showLine(target.edge - (axis === "row" ? bounds.top : bounds.left));
  }
  function finishDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { axis, from, node } = drag;
    const pos = getPos();
    const target = !preview.hidden && view.editable && pos !== undefined && view.state.doc.nodeAt(pos) === node
      ? dropTarget(event, drag) : undefined;
    resetDrag();
    if (pos === undefined || !target || target.to === from) return;
    // ProseMirror's row and column range lookup uses the selection, even with an explicit table position.
    const cell = TableMap.get(node).positionAt(axis === "row" ? from : 0, axis === "column" ? from : 0, node);
    view.dispatch(view.state.tr.setSelection(new CellSelection(view.state.doc.resolve(pos + 1 + cell))));
    const move = axis === "row" ? moveTableRow : moveTableColumn;
    if (move({ from, to: target.to, pos: pos + 1 })(view.state, view.dispatch)) view.focus();
  }

  return {
    dom, contentDOM,
    stopEvent: event => event.target instanceof Node && controls.contains(event.target),
    ignoreMutation: mutation => mutation.type !== "selection" && controls.contains(mutation.target),
    destroy: resetDrag,
  };
}
