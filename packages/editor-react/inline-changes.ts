import { isHistoryTransaction } from "@milkdown/kit/prose/history";
import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { ReplaceStep } from "@milkdown/kit/prose/transform";
import type { EditorView } from "@milkdown/kit/prose/view";

const classified = new WeakMap<Transaction, number[] | null>();

export function insertCodeFence(view: EditorView, from: number, to: number, text: string) {
  if (from !== to || !/^`+$/.test(text) || view.composing) return false;
  const { state } = view;
  const point = state.doc.resolve(from);
  const block = point.parent;
  if (block.type.name !== "paragraph") return false;
  let adjacent = false;
  block.forEach((node, offset, index) => {
    if (!node.isText || node.text!.includes("`") || !node.marks.some(mark => mark.type.name === "inlineCode")) return;
    const leading = block.maybeChild(index - 1)?.text?.match(/`+$/)?.[0].length ?? 0;
    const trailing = block.maybeChild(index + 1)?.text?.match(/^`+/)?.[0].length ?? 0;
    const cursor = point.parentOffset;
    const opening = cursor >= offset - leading && cursor <= offset;
    if (opening || (cursor >= offset + node.nodeSize && cursor <= offset + node.nodeSize + trailing)) {
      adjacent = true;
    }
  });
  if (!adjacent) return false;
  // Keep added fence characters literal instead of letting the inline-code rule consume them.
  view.dispatch(state.tr.replaceWith(from, to, state.schema.text(text)).scrollIntoView());
  return true;
}

export function promoteCodeFence(state: EditorState) {
  const point = state.selection.$from;
  const block = point.parent;
  if (block.type.name !== "paragraph") return null;
  let result: Transaction | null = null;
  block.forEach((node, offset, index) => {
    if (result || !node.isText || node.text!.includes("`") || !node.marks.some(mark => mark.type.name === "inlineCode")) return;
    const leading = block.maybeChild(index - 1)?.text?.match(/`+$/)?.[0].length ?? 0;
    const trailing = block.maybeChild(index + 1)?.text?.match(/^`+/)?.[0].length ?? 0;
    if (leading !== 2 || trailing !== 2) return;
    const before = block.content.cut(0, offset - leading);
    const after = block.content.cut(offset + node.nodeSize + trailing);
    const content = Fragment.fromArray([
      ...(before.size ? [block.copy(before)] : []),
      state.schema.nodes.code_block.create(null, state.schema.text(node.text!)),
      ...(after.size ? [block.copy(after)] : []),
    ]);
    if (point.node(-1).canReplace(point.index(-1), point.index(-1) + 1, content)) {
      const tr = state.tr.replaceWith(point.before(), point.after(), content);
      const caret = point.before() + (before.size ? before.size + 2 : 0) + 1 + node.nodeSize;
      result = tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView();
    }
  });
  return result;
}

// Inline replacements keep the same top-level block indices and node types.
export function inlineChangedBlocks(transaction: Transaction): number[] | null {
  const cached = classified.get(transaction);
  if (cached !== undefined) return cached;
  const indices = new Set<number>();
  const inline = transaction.steps.every((step, index) => {
    if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd) return false;
    let inlineContent = true;
    step.slice.content.forEach(node => { inlineContent &&= node.isInline; });
    if (!inlineContent) return false;
    const before = transaction.docs[index];
    const from = before.resolve(step.from), to = before.resolve(step.to);
    if (!from.parent.isTextblock || !from.sameParent(to)) return false;
    indices.add(from.index(0));
    return true;
  });
  const result = inline ? [...indices] : null;
  classified.set(transaction, result);
  return result;
}

// Input rules run when the closing delimiter is typed. A whitespace edit can
// also turn existing literal delimiters into valid Markdown.
export function repairInlineStrong(transaction: Transaction, state: EditorState, parse: (source: string) => ProseNode) {
  const [step] = transaction.steps;
  if (transaction.steps.length !== 1 || !(step instanceof ReplaceStep)
    || transaction.getMeta("uiEvent") || transaction.getMeta("composition") != null || isHistoryTransaction(transaction)) return null;
  const $from = transaction.before.resolve(step.from);
  if (!$from.textOffset || $from.parent.type.spec.code) return null;
  const { parent } = $from;
  const index = $from.index();
  const node = parent.child(index);
  if (!node.isText || node.marks.some(mark => mark.type.spec.code || mark.type.name === "link")) return null;
  const text = node.text!;
  const start = $from.textOffset;
  const end = start + step.to - step.from;
  if (end > text.length || (!text.includes("**") && !text.includes("__"))) return null;
  const inserted = step.slice.content.firstChild;
  if (step.slice.size && (step.slice.openStart || step.slice.openEnd
    || step.slice.content.childCount !== 1 || !inserted?.isText)) return null;
  const replacement = inserted?.text ?? "";

  for (const match of text.matchAll(/(?<![\\*_])(\*\*|__)(?![*_])([^\r\n]+?)\1(?![*_])/g)) {
    const [source, delimiter, body] = match;
    const inner = match.index + delimiter.length;
    const close = match.index + source.length - delimiter.length;
    if (start < inner || end > close || body === body.trim()) continue;
    const repaired = text.slice(inner, start) + replacement + text.slice(end, close);
    if (!repaired || repaired !== repaired.trim()) continue;
    const before = text.charAt(match.index - 1) || parent.maybeChild(index - 1)?.text?.slice(-1) || "";
    const after = text.charAt(close + delimiter.length) || parent.maybeChild(index + 1)?.text?.charAt(0) || "";
    const prefix = "x " + before;
    const suffix = after + " x";
    const paragraph = parse(prefix + delimiter + repaired + delimiter + suffix).firstChild;
    const content = paragraph?.childCount === 3 ? paragraph.child(1) : null;
    const strong = content?.marks.find(mark => mark.type.name === "strong");
    if (content?.text !== repaired || !strong) continue;
    const from = step.from - start + match.index;
    const to = from + repaired.length + 2 * delimiter.length;
    return state.tr.delete(to - delimiter.length, to).delete(from, from + delimiter.length)
      .addMark(from, from + repaired.length, strong);
  }
  return null;
}
