import { Fragment, Slice, type Mark, type Node as ProseNode, type ResolvedPos } from "@milkdown/kit/prose/model";
import MarkdownIt from "markdown-it";
import { footnoteLabels } from "./footnotes";

const sourceLink = /^(?:https?:\/\/|mailto:)/i;
export const sentencePunctuation = /[。！？；，、：）】》」』]/g;
const linkify = new MarkdownIt().linkify.set({ fuzzyLink: false, fuzzyEmail: false });

function linkMark(node: ProseNode) {
  return node.marks.find(mark => mark.type.name === "link" && sourceLink.test(mark.attrs.href));
}

export function hasLinkFootnoteContent(block: ProseNode): boolean {
  if (block.type.name === "footnote_definition") return true;
  let found = false;
  block.descendants(node => {
    if (!found) found = node.type.name === "footnote_reference" || !!linkMark(node)
      || (node.isText && /https?:\/\/|mailto:/i.test(node.text!));
    return !found;
  });
  return found;
}

export function inFootnote($pos: ResolvedPos) {
  for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type.name === "footnote_definition") return true;
  return false;
}

export function linkRangeAt($pos: ResolvedPos, href: string) {
  if (inFootnote($pos)) return null;
  const link = $pos.nodeAfter && linkMark($pos.nodeAfter);
  if (!link || link.attrs.href !== href) return null;
  let from = $pos.index(), to = from + 1;
  const { parent } = $pos;
  while (from > 0 && link.isInSet(parent.child(from - 1).marks)) from--;
  while (to < parent.childCount && link.isInSet(parent.child(to).marks)) to++;
  return { from: $pos.posAtIndex(from), to: $pos.posAtIndex(to) };
}

function footnotedLinks(doc: ProseNode) {
  const names = new Map<string, { name: string; addressOnly: boolean }>();
  const definitionNames: { from: number; to: number }[] = [];
  doc.forEach((node, position) => {
    if (node.type.name !== "footnote_definition") return;
    const paragraph = node.firstChild;
    if (!paragraph) return;
    const address = paragraph.lastChild;
    if (!address?.text || linkMark(address)?.attrs.href !== address.text) return;
    const prefix = paragraph.textContent.slice(0, -address.text.length);
    const name = prefix.endsWith("：") ? prefix.slice(0, -1) : prefix === "" ? address.text : null;
    if (name) {
      names.set(node.attrs.label.toUpperCase(), { name, addressOnly: prefix === "" });
      if (prefix) definitionNames.push({ from: position + 2, to: position + 2 + prefix.length });
    }
  });
  const ranges: { from: number; to: number; addressOnly: boolean }[] = [];
  const missing: { position: number; text: string }[] = [];
  if (!names.size) return { ranges, missing, definitionNames };
  doc.descendants((node, pos) => {
    if (node.type.name === "footnote_definition") return false;
    if (node.type.name !== "footnote_reference") return;
    const note = names.get(node.attrs.label.toUpperCase());
    if (!note) return;
    const { parent, parentOffset } = doc.resolve(pos);
    const text = parent.textBetween(0, parentOffset, "", "\ufffc");
    const preceding = text.trimEnd();
    if (preceding.endsWith(note.name)) {
      const to = pos - parentOffset + preceding.length;
      ranges.push({ from: to - note.name.length, to, addressOnly: note.addressOnly });
    } else if (note.addressOnly) {
      missing.push({ position: pos, text: `${text && !/\s$/.test(text) ? " " : ""}${note.name}` });
    }
  });
  return { ranges, missing, definitionNames };
}

export function footnotedLinkNames(doc: ProseNode) {
  return footnotedLinks(doc).ranges.filter(range => !range.addressOnly);
}

export function linksToFootnotes(slice: Slice, doc: ProseNode, input: "marked" | "document" = "marked") {
  const { paragraph, footnote_reference, footnote_definition } = doc.type.schema.nodes;
  const schema = doc.type.schema;
  const definitions: ProseNode[] = [];
  const edits: { from: number; to: number; content: Fragment }[] = [];
  const { ranges: existingNames, missing, definitionNames } = input === "document" ? footnotedLinks(doc) : { ranges: [], missing: [], definitionNames: [] };
  const alreadyFootnoted = (from: number, to: number) => existingNames.some(range => from < range.to && range.from < to);
  let allocate: ReturnType<typeof footnoteLabels> | undefined;

  function reference(link: Mark, text = "") {
    const label = (allocate ??= footnoteLabels(doc, slice.content))();
    const address = schema.text(link.attrs.href, [link]);
    const content = text ? [schema.text(`${text}：`), address] : address;
    definitions.push(footnote_definition.create({ label }, paragraph.create(null, content)));
    return footnote_reference.create({ label });
  }

  function convert(fragment: Fragment, start: number): Fragment {
    const children: ProseNode[] = [];
    let run: ProseNode[] = [];
    let link: Mark | undefined;
    let runStart = 0;
    function flush() {
      if (!link) return;
      const outputStart = children.length;
      const href = String(link.attrs.href);
      const bare = !link.attrs.title && run.every(node => node.isText) && run.map(node => node.text).join("") === href;
      const plain = run.map(node => node.mark(link!.removeFromSet(node.marks)));
      children.push(...plain, reference(link, bare ? "" : run.map(node => node.textContent).join("").trim()));
      if (input === "document") {
        const to = run.reduce((pos, node) => pos + node.nodeSize, runStart);
        edits.push({ from: runStart, to, content: Fragment.fromArray(children.slice(outputStart)) });
      }
      run = [];
      link = undefined;
    }
    fragment.forEach((node, offset) => {
      const position = start + offset;
      const mark = node.isInline ? linkMark(node) : undefined;
      const next = mark && !mark.attrs.title && mark.attrs.href === node.text && alreadyFootnoted(position, position + node.nodeSize) ? undefined : mark;
      if (!next || !link?.eq(next)) flush();
      if (next) {
        if (!link) runStart = position;
        link = next;
        run.push(node);
      } else if (node.content.size && node.type !== footnote_definition && !node.type.spec.code) {
        children.push(node.copy(convert(node.content, position + 1)));
      } else if (input !== "marked" && node.text && !node.marks.some(mark => mark.type.name === "link" || mark.type.spec.code)) {
        const matches = linkify.match(node.text.replace(sentencePunctuation, " "))?.filter(match => sourceLink.test(match.url));
        if (!matches?.length) { children.push(node); return; }
        let offset = 0;
        for (const { index, lastIndex, url } of matches) {
          if (alreadyFootnoted(position + index, position + lastIndex)) continue;
          if (offset < index) children.push(node.cut(offset, index));
          const visible = node.cut(index, lastIndex);
          const citation = reference(schema.marks.link.create({ href: url }));
          children.push(visible, citation);
          if (input === "document") edits.push({ from: position + index, to: position + lastIndex, content: Fragment.fromArray([visible, citation]) });
          offset = lastIndex;
        }
        if (offset < node.nodeSize) children.push(node.cut(offset));
      } else children.push(node);
    });
    flush();
    return Fragment.fromArray(children);
  }

  const content = convert(slice.content, 0);
  return { slice: definitions.length ? new Slice(content, slice.openStart, slice.openEnd) : slice, definitions, edits, missing, existingNames, definitionNames };
}
