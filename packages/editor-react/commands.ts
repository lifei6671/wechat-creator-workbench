import { commandsCtx, type Editor } from "@milkdown/kit/core";
import { insertTableCommand } from "@milkdown/kit/preset/gfm";
import { setBlockType, toggleMark, wrapIn } from "@milkdown/kit/prose/commands";
import { redo, undo } from "@milkdown/kit/prose/history";
import { wrapInList } from "@milkdown/kit/prose/schema-list";
import { AllSelection, TextSelection, type Command, type EditorState } from "@milkdown/kit/prose/state";
import { cellAround } from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";
import { hrefPattern } from "./schema";

export type EditorCommand =
  | "bold" | "italic" | "strike" | "inlineCode" | "paragraph" | "heading1" | "heading2" | "heading3"
  | "bulletList" | "orderedList" | "taskList" | "quote" | "table" | "footnote" | "horizontalRule"
  | "codeBlock" | "mathBlock" | "selectAll" | "selectCellText" | "undo" | "redo" | "link";

export function textEditingScope(state: EditorState) {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return null;
  const { $from } = selection;
  const kind: "code" | "cellText" | null = $from.parent.type.name === "code_block" ? "code" : cellAround($from) ? "cellText" : null;
  return kind && { kind, from: $from.start(), to: $from.end() };
}

function insertFootnote(view: EditorView) {
  const { state } = view;
  const { footnote_reference, footnote_definition, paragraph } = state.schema.nodes;
  const labels = new Set<string>();
  state.doc.descendants(node => {
    if (node.type === footnote_reference || node.type === footnote_definition) labels.add(node.attrs.label);
  });
  let index = 1;
  while (labels.has(String(index))) index++;
  const attrs = { label: String(index) };
  const tr = state.tr.insert(state.selection.to, footnote_reference.create(attrs));
  const end = tr.doc.content.size;
  tr.insert(end, footnote_definition.create(attrs, paragraph.create()));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 2)).scrollIntoView());
}

const setTaskList: Command = (state, dispatch) => {
  const { bullet_list, ordered_list, list_item } = state.schema.nodes;
  const { $from } = state.selection;
  const inList = [...Array($from.depth).keys()].some(index => {
    const type = $from.node(index + 1).type;
    return type === bullet_list || type === ordered_list;
  });
  const setChecked = (tr: typeof state.tr) => {
    const { from, to } = tr.selection;
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === list_item && node.attrs.checked === null) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
      }
    });
    dispatch?.(tr);
  };
  if (inList) { setChecked(state.tr); return true; }
  return wrapInList(bullet_list)(state, setChecked);
};

export function runCommand(editor: Editor, view: EditorView, name: EditorCommand, value?: string) {
  const { state, dispatch } = view;
  const { nodes, marks } = state.schema;
  if (name === "selectAll" || name === "selectCellText") {
    const scope = textEditingScope(state);
    if (name === "selectCellText" && scope?.kind !== "cellText") return;
    view.focus();
    dispatch(state.tr.setSelection(scope && (scope.kind === "code" || name === "selectCellText")
      ? TextSelection.create(state.doc, scope.from, scope.to) : new AllSelection(state.doc)));
    return;
  }
  if (!view.editable) return;
  view.focus();
  const commands: Partial<Record<EditorCommand, Command>> = {
    bold: toggleMark(marks.strong),
    italic: toggleMark(marks.emphasis),
    strike: toggleMark(marks.strike_through),
    inlineCode: toggleMark(marks.inlineCode),
    paragraph: setBlockType(nodes.paragraph),
    heading1: setBlockType(nodes.heading, { level: 1 }),
    heading2: setBlockType(nodes.heading, { level: 2 }),
    heading3: setBlockType(nodes.heading, { level: 3 }),
    bulletList: wrapInList(nodes.bullet_list),
    orderedList: wrapInList(nodes.ordered_list),
    taskList: setTaskList,
    quote: wrapIn(nodes.blockquote),
    codeBlock: setBlockType(nodes.code_block),
    undo,
    redo,
  };
  const command = commands[name];
  if (command) { command(state, dispatch, view); return; }
  switch (name) {
    case "link": {
      const href = value?.trim();
      if (!href || !hrefPattern.test(href)) return;
      if (state.selection.empty) dispatch(state.tr.replaceSelectionWith(state.schema.text(href, [marks.link.create({ href })]), false));
      else dispatch(state.tr.removeMark(state.selection.from, state.selection.to, marks.link)
        .addMark(state.selection.from, state.selection.to, marks.link.create({ href })));
      break;
    }
    case "table":
      editor.action(ctx => ctx.get(commandsCtx).call(insertTableCommand.key));
      break;
    case "footnote":
      insertFootnote(view);
      break;
    case "horizontalRule":
      dispatch(state.tr.replaceSelectionWith(nodes.hr.create()).scrollIntoView());
      break;
    case "mathBlock":
      dispatch(state.tr.replaceSelectionWith(nodes.math_block.create({ value: value?.trim() || "x" })).scrollIntoView());
      break;
  }
}
