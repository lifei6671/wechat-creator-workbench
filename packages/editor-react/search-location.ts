import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { WorkspaceSearchSnippet } from "../shared-types";

type EditorRange = { from: number; to: number };
type Parse = (markdown: string) => ProseNode;

export function locateSearchHit(doc: ProseNode, parse: Parse, markdown: string, hit: WorkspaceSearchSnippet) {
  const start = hit.start;
  if (!markdown.startsWith(hit.text, start)) return null;
  const content = documentText(doc);
  if (!content.segments.length) return null;

  // The regular Markdown parser resolves escaped syntax, emphasis, tables and code for us.
  // Parse a temporary copy with markers and accept offsets only if its visible text is unchanged.
  if (!markdown.includes("\uE000")) {
    const pieces = [markdown.slice(0, start)];
    let offset = start;
    for (const [index, range] of hit.ranges.entries()) {
      pieces.push(markdown.slice(offset, start + range.start), marker(index * 2),
        markdown.slice(start + range.start, start + range.end), marker(index * 2 + 1));
      offset = start + range.end;
    }
    pieces.push(markdown.slice(offset));
    const probe = documentText(parse(pieces.join(""))).text;
    const offsets = new Map<number, number>();
    let removed = 0;
    const plain = probe.replace(/\uE000(\d+)\uE001/g, (marker, index, at) => {
      offsets.set(Number(index), at - removed);
      removed += marker.length;
      return "";
    });
    if (plain === content.text) {
      const ranges = hit.ranges.flatMap((_, index): EditorRange[] => {
        const from = offsets.get(index * 2), to = offsets.get(index * 2 + 1);
        return from !== undefined && to !== undefined && to > from
          ? [{ from: content.position(from, false), to: content.position(to, true) }] : [];
      });
      if (ranges.length) return { position: ranges[0].from, ranges };
    }
  }

  // A match such as a URL destination may have no corresponding text in the rich editor.
  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const preceding = documentText(parse(markdown.slice(0, lineStart))).text.length;
  return { position: content.position(preceding, false), ranges: [] };
}

function marker(index: number) {
  return `\uE000${index}\uE001`;
}

function documentText(doc: ProseNode) {
  const segments: { from: number; to: number; pos: number }[] = [];
  const chunks: string[] = [];
  let offset = 0;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const text = node.text!;
    chunks.push(text);
    segments.push({ from: offset, to: offset + text.length, pos });
    offset += text.length;
  });
  return {
    text: chunks.join(""),
    segments,
    position(offset: number, end: boolean) {
      const segment = segments.find(item => end ? offset <= item.to : offset < item.to) ?? segments.at(-1)!;
      return segment.pos + Math.min(offset, segment.to) - segment.from;
    },
  };
}
