import type { Node as ProseNode } from "@milkdown/kit/prose/model";

export type ReviewRange = { from: number; to: number };
export type ReviewProjection = {
  text: string;
  version: 1;
  runs: { textFrom: number; textTo: number; pmFrom: number; pmTo: number }[];
};
export type ReviewSnapshot = {
  entryId: string;
  session: symbol;
  generation: number;
  projection: ReviewProjection;
};
export type ReviewMark = { id: string; category: "ai_generated" | "ai_suspected"; range: ReviewRange | null };

export function projectReviewText(doc: ProseNode, selection?: ReviewRange): ReviewProjection {
  const parts: string[] = [];
  const runs: ReviewProjection["runs"] = [];
  let length = 0;
  let blocks = 0;
  const from = selection?.from ?? 0, to = selection?.to ?? doc.content.size;
  doc.descendants((node, pos) => {
    if (pos >= to || pos + node.nodeSize <= from) return false;
    if (node.type.name === "table" || node.type.name === "code_block") return false;
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
    const items: { text: string; from: number; to: number }[] = [];
    node.forEach((inline, offset) => {
      const start = pos + 1 + offset;
      const end = start + inline.nodeSize;
      if (end <= from || start >= to) return;
      if (inline.isText) {
        const a = Math.max(start, from), b = Math.min(end, to);
        items.push({ text: inline.text!.slice(a - start, b - start), from: a, to: b });
      } else if (inline.type.name === "hardbreak") {
        items.push({ text: "\n", from: start, to: end });
      }
    });
    if (items.length) {
      if (blocks++) { parts.push("\n\n"); length += 2; }
      for (const item of items) {
        parts.push(item.text);
        runs.push({ textFrom: length, textTo: length + item.text.length, pmFrom: item.from, pmTo: item.to });
        length += item.text.length;
      }
    }
    return false;
  });
  return { text: parts.join(""), version: 1, runs };
}

function boundary(text: string, at: number) {
  return !(at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]));
}

export function reviewRanges(projection: ReviewProjection, range: ReviewRange): ReviewRange[] {
  const { from, to } = range;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > projection.text.length || from >= to
    || !boundary(projection.text, from) || !boundary(projection.text, to)) return [];
  return projection.runs.flatMap(run => {
    const a = Math.max(from, run.textFrom), b = Math.min(to, run.textTo);
    return a < b ? [{ from: run.pmFrom + a - run.textFrom, to: run.pmFrom + b - run.textFrom }] : [];
  });
}
