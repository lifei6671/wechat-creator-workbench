import type { Transaction } from "@milkdown/kit/prose/state";
import { ReplaceStep } from "@milkdown/kit/prose/transform";

const classified = new WeakMap<Transaction, number[] | null>();

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
