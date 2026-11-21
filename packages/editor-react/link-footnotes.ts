import { Fragment, Slice, type Mark, type Node as ProseNode, type ResolvedPos } from "@milkdown/kit/prose/model";
import { Transform } from "@milkdown/kit/prose/transform";
import MarkdownIt from "markdown-it";
import { footnoteLabels } from "./footnotes";
import { isWechatArticleLink, sanitizeRenderedMarkdown } from "../markdown-core";

const sourceLink = /^(?:https?:\/\/|mailto:)/i;
export const sentencePunctuation = /[。！？；，、：）】》」』]/g;
const linkify = new MarkdownIt().linkify.set({ fuzzyLink: false, fuzzyEmail: false });

function linkMark(node: ProseNode) {
  return node.marks.find(mark => mark.type.name === "link" && sourceLink.test(mark.attrs.href));
}

export function hasLinkFootnoteContent(block: ProseNode): boolean {
  if (block.type.name === "footnote_definition") return true;
  if (block.type.name === "github_disclosure" && /\bhref\s*=/i.test(block.attrs.header)) return true;
  if ((block.type.name === "html" || block.type.name === "html_block") && /\bhref\s*=/i.test(block.attrs.value)) return true;
  let found = false;
  block.descendants(node => {
    if (!found) found = node.type.name === "footnote_reference" || node.marks.some(mark => mark.type.name === "link")
      || ((node.type.name === "html" || node.type.name === "html_block") && /\bhref\s*=/i.test(node.attrs.value))
      || (node.type.name === "github_disclosure" && /\bhref\s*=/i.test(node.attrs.header))
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
  const names = new Map<string, { name: string; addressOnly: boolean; address: { from: number; to: number } }>();
  const definitionText: { from: number; to: number }[] = [];
  doc.forEach((node, position) => {
    if (node.type.name !== "footnote_definition") return;
    const paragraph = node.firstChild;
    if (!paragraph) return;
    const address = paragraph.lastChild;
    if (!address?.text) return;
    const markedAddress = linkMark(address)?.attrs.href === address.text;
    const plain = !markedAddress && address.marks.some(mark => mark.type.name === "link") ? null
      : /^(?:(.+)： ?)?((?:https?:\/\/|mailto:)\S+)$/i.exec(paragraph.textContent);
    if (!markedAddress && !plain) return;
    const href = plain ? plain[2] : address.text;
    const prefix = paragraph.textContent.slice(0, -href.length);
    const name = plain ? plain[1] ?? href
      : /： ?$/.test(prefix) ? prefix.replace(/： ?$/, "") : prefix === "" ? href : null;
    if (name) {
      const from = position + 2 + paragraph.content.size - href.length;
      names.set(node.attrs.label.toUpperCase(), { name, addressOnly: prefix === "",
        address: { from, to: from + href.length } });
      if (prefix) definitionText.push({ from: position + 2, to: position + 2 + prefix.length });
    }
  });
  const ranges: { from: number; to: number; addressOnly: boolean }[] = [];
  const missing: { position: number; text: string }[] = [];
  if (!names.size) return { ranges, missing, definitionText };
  doc.descendants((node, pos) => {
    if (node.type.name === "footnote_definition") return false;
    if (node.type.name !== "footnote_reference") return;
    const note = names.get(node.attrs.label.toUpperCase());
    if (!note) return;
    const { parent, parentOffset } = doc.resolve(pos);
    const text = parent.textBetween(0, parentOffset, "", "\ufffc");
    const preceding = text.trimEnd();
    definitionText.push(note.address);
    if (preceding.endsWith(note.name)) {
      const to = pos - parentOffset + preceding.length;
      ranges.push({ from: to - note.name.length, to, addressOnly: note.addressOnly });
    } else if (note.addressOnly) {
      missing.push({ position: pos, text: `${text && !/\s$/.test(text) ? " " : ""}${note.name}` });
    }
  });
  return { ranges, missing, definitionText };
}

export function footnotedLinkTextRanges(doc: ProseNode) {
  const { ranges, definitionText } = footnotedLinks(doc);
  return [...ranges, ...definitionText];
}

export function linksToFootnotes(slice: Slice, doc: ProseNode, input: "marked" | "document" = "marked", githubRepo?: string) {
  const { paragraph, footnote_reference, footnote_definition } = doc.type.schema.nodes;
  const schema = doc.type.schema;
  const definitions: ProseNode[] = [];
  const edits: { from: number; to: number; content: Fragment }[] = [];
  const definitionEdits: { from: number; to: number; content: Fragment; extraText: string }[] = [];
  const htmlEdits: { from: number; attr: "value" | "header"; value: string; labels: string[] }[] = [];
  const { ranges: existingNames, missing, definitionText } = input === "document" ? footnotedLinks(doc) : { ranges: [], missing: [], definitionText: [] };
  const alreadyFootnoted = (from: number, to: number) => existingNames.some(range => from < range.to && range.from < to);
  let allocate: ReturnType<typeof footnoteLabels> | undefined;
  const caption = (nodes: ProseNode[]) => nodes.map(node => node.type.name === "image" ? node.attrs.alt || "图片" : node.textContent).join("").trim();

  function reference(link: Mark, text = "") {
    const label = (allocate ??= footnoteLabels(doc, slice.content))();
    const content = schema.text(text ? `${text}： ${link.attrs.href}` : link.attrs.href);
    definitions.push(footnote_definition.create({ label }, paragraph.create(null, content)));
    return footnote_reference.create({ label });
  }

  function convert(fragment: Fragment, start: number, inDefinition = false): Fragment {
    const children: ProseNode[] = [];
    let run: ProseNode[] = [];
    let link: Mark | undefined;
    let runStart = 0;
    let skipUntil = 0;
    function flush() {
      if (!link) return;
      const outputStart = children.length;
      const href = String(link.attrs.href);
      const bare = !link.attrs.title && run.every(node => node.isText) && run.map(node => node.text).join("") === href;
      const plain = run.map(node => node.mark(link!.removeFromSet(node.marks)));
      const extraText = inDefinition && !bare ? `： ${href}` : "";
      children.push(...plain);
      if (inDefinition) {
        if (extraText) children.push(schema.text(extraText));
      } else children.push(reference(link, bare ? "" : caption(run)));
      if (input === "document") {
        const to = run.reduce((pos, node) => pos + node.nodeSize, runStart);
        const edit = { from: runStart, to, content: Fragment.fromArray(children.slice(outputStart)) };
        if (inDefinition) definitionEdits.push({ ...edit, extraText });
        else edits.push(edit);
      }
      run = [];
      link = undefined;
    }
    fragment.forEach((node, offset, index) => {
      if (index < skipUntil) return;
      const position = start + offset;
      if (input === "document" && (node.type.name === "html_block" || node.type.name === "github_disclosure")) {
        flush();
        const attr = node.type.name === "github_disclosure" ? "header" : "value";
        const template = document.createElement("template");
        template.innerHTML = node.attrs[attr];
        const labels: string[] = [];
        let changed = false;
        for (const anchor of template.content.querySelectorAll("a[href]")) {
          const visible = sanitizeRenderedMarkdown(anchor.outerHTML, { githubRepo, embedded: true });
          const href = visible.querySelector("a")?.getAttribute("href");
          if (!href || !sourceLink.test(href) || isWechatArticleLink(href)) continue;
          const name = visible.textContent?.trim() || "";
          const plain = document.createElement("span");
          plain.append(...anchor.childNodes);
          anchor.replaceWith(plain);
          if (inDefinition) {
            if (name !== href) plain.after(document.createTextNode(`： ${href}`));
          } else {
            const label = reference(schema.marks.link.create({ href }), name === href ? "" : name).attrs.label;
            labels.push(label);
            const marker = document.createElement("span");
            marker.setAttribute("data-workbench-footnote", label);
            plain.after(marker);
          }
          changed = true;
        }
        if (changed) {
          const value = attr === "header" ? template.innerHTML.replace(/<\/details>\s*$/i, "") : template.innerHTML;
          htmlEdits.push({ from: position, attr, value, labels });
        }
        if (attr === "value") { children.push(node); return; }
      }
      if (input === "document" && node.type.name === "html" && /^<a(?=[\s>])/i.test(node.attrs.value)) {
        const template = document.createElement("template");
        template.innerHTML = node.attrs.value;
        const href = sanitizeRenderedMarkdown(template.innerHTML, { githubRepo, embedded: true }).querySelector("a")?.getAttribute("href");
        if (href && sourceLink.test(href) && !isWechatArticleLink(href)) {
          let end = offset + node.nodeSize;
          for (let last = index + 1; last < fragment.childCount; last++) {
            const closing = fragment.child(last);
            if (closing.type.name === "html" && /^<\/a\s*>$/i.test(closing.attrs.value)) {
              flush();
              const content = fragment.cut(offset + node.nodeSize, end);
              const body: ProseNode[] = [];
              content.forEach(child => body.push(child));
              const name = caption(body);
              const extraText = inDefinition && name !== href ? `： ${href}` : "";
              if (inDefinition) { if (extraText) body.push(schema.text(extraText)); }
              else body.push(reference(schema.marks.link.create({ href }), name === href ? "" : name));
              children.push(...body);
              const edit = { from: position, to: start + end + closing.nodeSize, content: Fragment.fromArray(body) };
              if (inDefinition) definitionEdits.push({ ...edit, extraText });
              else edits.push(edit);
              skipUntil = last + 1;
              return;
            }
            if (closing.type.name === "html" && /^<a(?=[\s>])/i.test(closing.attrs.value)) break;
            end += closing.nodeSize;
          }
        }
      }
      const mark = node.isInline ? linkMark(node) : undefined;
      const next = input === "document" && mark && isWechatArticleLink(mark.attrs.href) ? undefined
        : mark && !mark.attrs.title && mark.attrs.href === node.text && alreadyFootnoted(position, position + node.nodeSize) ? undefined : mark;
      if (!next || !link?.eq(next)) flush();
      if (next) {
        if (!link) runStart = position;
        link = next;
        run.push(node);
      } else if (node.content.size && !node.type.spec.code) {
        children.push(node.copy(convert(node.content, position + 1, inDefinition || node.type === footnote_definition)));
      } else if (input !== "marked" && !inDefinition && node.text && !node.marks.some(mark => mark.type.name === "link" || mark.type.spec.code)) {
        const matches = linkify.match(node.text.replace(sentencePunctuation, " "))?.filter(match => sourceLink.test(match.url) && !isWechatArticleLink(match.url));
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
  return { slice: definitions.length || definitionEdits.length ? new Slice(content, slice.openStart, slice.openEnd) : slice, definitions, edits, definitionEdits, htmlEdits, missing, existingNames, definitionText };
}

const documentPlans = new WeakMap<ProseNode, { githubRepo?: string; plan: ReturnType<typeof linksToFootnotes> }>();
export function documentLinkFootnotes(doc: ProseNode, githubRepo?: string) {
  let cached = documentPlans.get(doc);
  if (!cached || cached.githubRepo !== githubRepo) {
    const normalized = new Transform(doc);
    if (githubRepo) doc.descendants((node, pos) => {
      const link = node.marks.find(mark => mark.type.name === "link");
      if (!link || sourceLink.test(link.attrs.href)) return;
      const anchor = document.createElement("a");
      anchor.setAttribute("href", link.attrs.href);
      const href = sanitizeRenderedMarkdown(anchor.outerHTML, { githubRepo, embedded: true }).querySelector("a")?.getAttribute("href");
      if (href && sourceLink.test(href)) normalized.removeMark(pos, pos + node.nodeSize, link)
        .addMark(pos, pos + node.nodeSize, link.type.create({ ...link.attrs, href }));
    });
    cached = { githubRepo, plan: linksToFootnotes(new Slice(normalized.doc.content, 0, 0), normalized.doc, "document", githubRepo) };
    documentPlans.set(doc, cached);
  }
  return cached.plan;
}
