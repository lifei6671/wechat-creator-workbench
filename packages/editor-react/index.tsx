import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type Ref } from "react";
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, parserCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { gfm, tableSchema } from "@milkdown/kit/preset/gfm";
import { closeHistory } from "@milkdown/kit/prose/history";
import { DOMParser, DOMSerializer, Fragment, Slice, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { cellAround, CellSelection, isInTable } from "@milkdown/kit/prose/tables";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { Transform } from "@milkdown/kit/prose/transform";
import { $prose, $useKeymap, $view } from "@milkdown/kit/utils";
import { DomTooltips, Tooltip } from "../ui-react/Tooltip";
import DOMPurify from "dompurify";
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-react";
import { SearchQuery, type SearchResult } from "prosemirror-search";
import { runCommand, textEditingScope, type EditorCommand } from "./commands";
import { clipboardMarkdownCtx, hrefPattern, richCommonmark, richSchema } from "./schema";
import { imageContext, imagePattern, prepareImageContext, type EditorImages, type ImageContext } from "./image-view";
import { editorPresentation, foldedSections, showContextCaret } from "./presentation";
import { editorOutline, lastBodyBlock } from "./outline";
import { cellParagraph, isTableSlice, prepareTableContext, preservesTableSelection, replaceSelectedCells, runTableAction, tableView, type TableAction, type TableContext } from "./table-view";
import { codeView } from "./code-view";
import { editorBlockTools } from "./slash-menu";
import { footnoteDraft, FootnotePopover } from "./footnotes";
import { documentLinkFootnotes, footnotedLinkTextRanges, linkRangeAt, linksToFootnotes } from "./link-footnotes";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import "@milkdown/kit/prose/gapcursor/style/gapcursor.css";
import "./editor.css";
import { inlineChangedBlocks, repairInlineStrong } from "./inline-changes";
import type { WorkspaceSearchHit } from "../shared-types";
import { locateSearchHit } from "./search-location";

export type { EditorCommand } from "./commands";
export type { ImageContext } from "./image-view";
export type { TableAction, TableContext } from "./table-view";
export type { OutlineItem, OutlinePlacement } from "./outline";

export interface LinkContext { kind: "link"; scope: "body" | "cellText" | TableContext; convert(): void }

export interface EditorTarget {
  entryId: string;
  session: symbol;
  localRevision: number;
  from: number;
  to: number;
  original: string;
  originalSlice: string;
}

export type AiContextScope = "selection" | "section" | "document";
export type AiEditorContext = EditorTarget & { scope: AiContextScope; headingPath: string[] };
export interface MarkdownSnapshot { markdown: string; localRevision: number }

type OutlineActions = ReturnType<typeof editorOutline>["actions"];

export interface MarkdownEditorHandle extends OutlineActions {
  focus(): void;
  search(): void;
  revealSearchHit(hit: WorkspaceSearchHit, showContext?: boolean): boolean;
  clearSearchHit(): void;
  target(scope?: "document"): EditorTarget;
  captureMarkdown(): MarkdownSnapshot;
  pendingEdits(): Promise<unknown> | undefined;
  captureDocumentMatch(): () => boolean;
  captureContext(scope: AiContextScope): AiEditorContext | null;
  selectionText(): string;
  matchesTarget(target: EditorTarget): boolean;
  subscribeSelection(listener: () => void): () => void;
  insert(text: string): void;
  linkFootnoteMarkdown(source: string): string;
  hostImages?(upload: (src: string) => Promise<string>, eligible: (src: string) => boolean, onTotal?: (total: number) => void): Promise<number>;
  replaceTarget(target: EditorTarget, text: string): boolean;
  retryMissingImages(): void;
  hasSelection(allowCells?: boolean): boolean;
  command(command: EditorCommand, value?: string): void;
  prepareContext(event: MouseEvent): LinkContext | ImageContext | TableContext | "code" | "cellText" | "object" | null;
  contextCaret?(visible: boolean): void;
  tableAction(action: TableAction): void;
  clipboard(action: ClipboardAction, io: ClipboardIO, target?: EventTarget | null, plainText?: boolean): boolean;
}

export type ClipboardAction = "copy" | "cut" | "paste";
type ClipboardContent = string | { html: string; text?: string | null };
export interface ClipboardIO {
  read(plainText?: boolean): Promise<ClipboardContent>;
  write(text: string, html?: string): Promise<void>;
  localizeImage?(url: string): Promise<string>;
  importImage?(file: File): Promise<string>;
  onError(error: unknown): void;
}

interface Props extends EditorImages {
  ref?: Ref<MarkdownEditorHandle>;
  entryId: string;
  value: string;
  githubRepo?: string;
  readOnly: boolean;
  active?: boolean;
  lineNumbers?: boolean;
  convertLinks?: boolean;
  localizeImageLink?(url: string): Promise<string>;
  title?: ReactNode;
  onDocumentChanged(entryId: string, localRevision: number): void;
  onBlur(): void;
  onEscape?(): void;
  onImages?(files: File[]): Promise<string>;
  onOpenLink?(url: string): Promise<void>;
}

type Range = { from: number; to: number };
type PastedImage = Range & { node: ProseNode; src: string };
const revision = new PluginKey<number>("workbenchRevision");
const documentLayout = new PluginKey("workbenchDocumentLayout");
const pasteProgress = new PluginKey("workbenchPasteProgress");
const searchHighlights = new PluginKey<DecorationSet>("workbenchSearchHighlights");
const workspaceSearchHighlights = new PluginKey<DecorationSet>("workspaceSearchHighlights");
const embeddedImage = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i;

async function readPaste(io: ClipboardIO, plainText?: boolean): Promise<ClipboardContent> {
  const payload = await io.read(plainText);
  const { importImage } = io;
  if (plainText || typeof payload === "string" || !importImage || !/data:image\//i.test(payload.html)) return payload;
  const template = document.createElement("template");
  template.innerHTML = payload.html;
  const imported = new Map<string, Promise<string>>();
  await Promise.all([...template.content.querySelectorAll("img[src]")].map(async image => {
    const original = image.getAttribute("data-workbench-src");
    if (original && imagePattern.test(original)) return;
    const source = image.getAttribute("src")!;
    const mime = embeddedImage.exec(source);
    if (!mime) return;
    let task = imported.get(source);
    if (!task) {
      task = (async () => {
        const bytes = Uint8Array.from(atob(source.slice(mime[0].length)), char => char.charCodeAt(0));
        const type = mime[1].toLowerCase();
        return importImage(new File([bytes], `粘贴图片.${type.split("/")[1]}`, { type }));
      })().catch(error => { io.onError(error); return source; });
      imported.set(source, task);
    }
    image.setAttribute("src", await task);
  }));
  return { ...payload, html: template.innerHTML };
}

function mapRange(range: Range, tr: Transaction): Range | undefined {
  let { from, to } = range;
  for (const map of tr.mapping.maps) {
    let overlaps = false;
    map.forEach((start, end) => {
      overlaps ||= from === to ? start < from && end > from : start < to && end > from;
    });
    if (overlaps) return undefined;
    const mappedFrom = map.map(from, 1);
    to = from === to ? mappedFrom : map.map(to, -1);
    from = mappedFrom;
  }
  return { from, to };
}

function markdownSlice(editor: Editor, text: string, clipboard = false) {
  if (!text) return Slice.empty;
  return editor.action(ctx => {
    const parse = ctx.get(parserCtx);
    if (!clipboard) return Slice.maxOpen(parse(text).content, false);
    ctx.set(clipboardMarkdownCtx, true);
    try { return Slice.maxOpen(parse(text).content, false); }
    finally { ctx.set(clipboardMarkdownCtx, false); }
  });
}

function unlinkFootnoteNames(tr: Transform, ranges: { from: number; to: number }[]) {
  const { doc } = tr;
  const linkType = doc.type.schema.marks.link;
  for (const { from, to } of ranges) {
    doc.nodesBetween(from, to, (node, pos) => {
      const link = linkType.isInSet(node.marks);
      if (link && !link.attrs.title && node.text === link.attrs.href) {
        tr.removeMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), link);
      }
    });
  }
}

function plainSlice(view: EditorView, text: string) {
  const { schema } = view.state;
  return Slice.maxOpen(Fragment.from(text.split(/\r\n?|\n/).map(line =>
    schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined),
  )));
}

function nonRenderingHtmlToken(value: string) {
  return /^(?:<!--(?!>|->)(?:[^-]|-(?!-))*-->|<\?[^>]*\?>|<![a-z][^>]*>|<!\[CDATA\[[^>]*\]\]>)$/i.test(value.trim());
}

function htmlSlice(view: EditorView, html: string) {
  const richMetadata = [
    "data-type", "data-value", "data-label", "data-math", "data-display", "data-language",
    "data-item-type", "data-list-type", "data-spread", "data-checked", "data-workbench-src", "data-workbench-alt", "data-literal-callout",
  ];
  // XML safety normally removes comment terminators even inside data attributes.
  // Preserve only complete inert tokens in the editor's source metadata.
  const inertValues = new WeakMap<Node, string>();
  DOMPurify.addHook("beforeSanitizeAttributes", node => {
    if (node instanceof Element && ["html", "html-block"].includes(node.getAttribute("data-type") ?? "")) {
      const value = node.getAttribute("data-value");
      if (value !== null && nonRenderingHtmlToken(value)) inertValues.set(node, value);
    }
  });
  DOMPurify.addHook("afterSanitizeAttributes", node => {
    const value = inertValues.get(node);
    if (value !== undefined && node instanceof Element) node.setAttribute("data-value", value);
  });
  let fragment: DocumentFragment;
  try { fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "strong", "b", "em", "i", "s", "del", "strike", "mark",
      "code", "pre", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "div", "span", "sup", "img",
      "dl", "dt", "dd",
    ],
    ALLOWED_ATTR: [
      "href", "src", "alt", "title", "start", "class", "style",
      ...richMetadata,
    ],
    ADD_URI_SAFE_ATTR: richMetadata,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|#|asset:\/\/)/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  }); } finally {
    DOMPurify.removeHook("beforeSanitizeAttributes");
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
  for (const embedded of fragment.querySelectorAll('[data-type="html"], [data-type="html-block"]')) {
    const value = embedded.getAttribute("data-value");
    if (value === null) embedded.replaceWith(embedded.textContent);
    else {
      const inline = embedded.getAttribute("data-type") === "html";
      const closing = inline && /^<\/([a-z][\w-]*)\s*>$/i.exec(value.trim());
      // Non-rendering HTML tokens carry source text that DOMPurify otherwise discards.
      const inert = nonRenderingHtmlToken(value);
      let clean = inert ? value : DOMPurify.sanitize(closing ? `<${closing[1]}>` : value, {
        USE_PROFILES: { html: true }, FORBID_TAGS: ["style"], FORBID_ATTR: ["style"],
        ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|#|asset:\/\/)/i,
      });
      const opening = inline && /^<([a-z][\w-]*)\b/i.exec(value.trim());
      if (closing) clean = clean ? `</${closing[1].toLowerCase()}>` : "";
      else if (opening) {
        // Markdown stores inline opening/closing tags as separate tokens.
        const end = `</${opening[1].toLowerCase()}>`;
        if (clean.endsWith(end) && !value.trimEnd().toLowerCase().endsWith(end)) clean = clean.slice(0, -end.length);
      }
      embedded.setAttribute("data-value", clean);
    }
  }
  for (const pre of fragment.querySelectorAll<HTMLPreElement>("pre:not([data-language])")) {
    const classes = `${pre.className} ${pre.querySelector("code")?.className ?? ""}`;
    const language = /\blanguage-([\w+-]+)/.exec(classes)?.[1];
    if (language) pre.dataset.language = language;
  }
  for (const anchor of fragment.querySelectorAll("a[href]")) {
    if (!hrefPattern.test(anchor.getAttribute("href")!)) anchor.removeAttribute("href");
  }
  for (const img of fragment.querySelectorAll("img")) {
    const url = img.getAttribute("data-workbench-src") ?? img.getAttribute("src");
    if (!url || !imagePattern.test(url)) img.replaceWith(img.alt);
    else {
      const placeholder = document.createElement("span");
      placeholder.dataset.workbenchSrc = url;
      placeholder.dataset.workbenchAlt = img.alt;
      placeholder.title = img.title;
      img.replaceWith(placeholder);
    }
  }
  for (const img of fragment.querySelectorAll("[data-workbench-src]")) {
    if (!imagePattern.test(img.getAttribute("data-workbench-src")!)) img.removeAttribute("data-workbench-src");
  }
  return DOMParser.fromSchema(view.state.schema).parseSlice(fragment);
}

function clipboardSlice(editor: Editor, view: EditorView, payload: ClipboardContent, plainText?: boolean) {
  if (typeof payload === "string") return plainText ? plainSlice(view, payload) : markdownSlice(editor, payload, true);
  const rich = htmlSlice(view, payload.html);
  if (!payload.text) return rich;
  if (plainText) return plainSlice(view, payload.text);
  const compact = (text: string) => text.replace(/\s+/g, "");
  if (compact(rich.content.textBetween(0, rich.content.size, "\n")) !== compact(payload.text)) return rich;

  // Source editors may put the same Markdown on the clipboard as plain text and as HTML paragraphs or a pre block.
  const block = rich.content.firstChild;
  const code = rich.content.childCount === 1 && block?.type.name === "code_block";
  const codeLanguage = code ? String(block.attrs.language ?? "").toLowerCase() : "";
  if (codeLanguage === "md" || codeLanguage === "markdown") return markdownSlice(editor, payload.text, true);
  if (codeLanguage) return rich;
  let htmlParagraphs = true;
  rich.content.forEach(node => { htmlParagraphs &&= node.type.name === "paragraph"; });
  if (!htmlParagraphs && !code) return rich;
  let styled = false;
  let semanticHtml = false;
  rich.content.descendants(node => {
    styled ||= node.marks.length > 0;
    semanticHtml ||= (node.isInline && node.isAtom && !node.isText && node.type.name !== "hardbreak")
      || node.marks.some(mark => mark.type.name === "link" || mark.type.name === "inlineCode");
  });
  const markdown = markdownSlice(editor, payload.text, true);
  if (styled || semanticHtml) {
    let hasFootnote = false;
    markdown.content.descendants(node => {
      hasFootnote ||= node.type.name === "footnote_reference";
      return !hasFootnote;
    });
    // A parsed reference confirms matching Markdown footnote syntax in the clipboard text.
    if (hasFootnote) return markdown;
  }
  if (semanticHtml) return rich;
  if (styled && !code) {
    let hasHeading = false;
    let sourceBlocks = 0;
    markdown.content.forEach(node => {
      hasHeading ||= node.type.name === "heading";
      if (!["paragraph", "html", "html_block"].includes(node.type.name)) sourceBlocks++;
    });
    // Highlighted source retains its heading and other block markers as literal HTML paragraph text.
    return hasHeading && sourceBlocks > 1 ? markdown : rich;
  }

  let hasSyntax = false;
  markdown.content.descendants(node => {
    if (["html", "html_block"].includes(node.type.name)) return false;
    hasSyntax ||= (node.isBlock && node.type.name !== "paragraph") || node.marks.length > 0 || node.isAtom && !node.isText;
    return !hasSyntax;
  });
  return hasSyntax ? markdown : rich;
}

function textRange(view: EditorView): Range {
  const { from, to, $from } = view.state.selection;
  if (from === to && $from.parent.isTextblock) return { from: $from.start(), to: $from.end() };
  return { from, to };
}

function cellRange(selection: CellSelection) {
  return {
    from: Math.min(...selection.ranges.map(range => range.$from.pos - 1)),
    to: Math.max(...selection.ranges.map(range => range.$to.pos + 1)),
  };
}

function pastedImages(doc: ProseNode, from: number, to: number): PastedImage[] {
  const images: PastedImage[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "image" && pos >= from && pos + node.nodeSize <= to && /^(?:https?|asset):\/\//i.test(node.attrs.src)) {
      images.push({ node, from: pos, to: pos + node.nodeSize, src: node.attrs.src });
    }
  });
  return images;
}

function SearchButton({ label, ...props }: ComponentProps<"button"> & { label: string }) {
  return <Tooltip content={label}><button type="button" aria-label={label} {...props} /></Tooltip>;
}

type SearchSettings = { query: string; replacement: string; showReplace: boolean; caseSensitive: boolean; wholeWord: boolean; regexp: boolean };

function SearchBar({ view, readOnly, inputRef, subscribe, saved, onClose }: {
  view: EditorView; readOnly: boolean; inputRef: Ref<HTMLInputElement>;
  subscribe(listener: () => void): () => void; saved: { current: SearchSettings }; onClose(): void;
}) {
  const [settings, setSettings] = useState(saved.current);
  const { query, replacement, showReplace, caseSensitive, wholeWord, regexp } = settings;
  useLayoutEffect(() => { saved.current = settings; }, [saved, settings]);
  const overlay = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(subscribe, () => view.state);
  const searchQuery = useMemo(() => new SearchQuery({ search: query, caseSensitive, wholeWord, regexp }),
    [query, caseSensitive, wholeWord, regexp]);
  const close = () => { onClose(); view.focus(); };

  useEffect(() => {
    const { state } = view;
    if (!searchQuery.valid) return;
    const match = searchQuery.findNext(state, state.selection.from) ?? searchQuery.findNext(state);
    if (match) view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, match.from, match.to)));
  }, [view, searchQuery]);
  useEffect(() => () => {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(searchHighlights, DecorationSet.empty));
  }, [view]);

  const findMatches = useMemo(() => {
    const blocks = new WeakMap<ProseNode, SearchResult[]>();
    let previous: { doc: ProseNode; matches: SearchResult[] } | undefined;
    return (state: EditorState) => {
      if (previous?.doc === state.doc) return previous.matches;
      const results: SearchResult[] = [];
      if (searchQuery.valid) state.doc.forEach((node, offset) => {
        let matches = blocks.get(node);
        if (!matches) {
          matches = [];
          const end = offset + node.nodeSize;
          for (let pos = offset; pos < end;) {
            const match = searchQuery.findNext(state, pos, end);
            if (!match) break;
            if (match.from >= pos) matches.push({ ...match,
              from: match.from - offset, to: match.to - offset, matchStart: match.matchStart - offset });
            pos = Math.max(pos + 1, match.to, match.from + 1);
          }
          blocks.set(node, matches);
        }
        for (const match of matches) results.push({ ...match,
          from: match.from + offset, to: match.to + offset, matchStart: match.matchStart + offset });
      });
      previous = { doc: state.doc, matches: results };
      return results;
    };
  }, [searchQuery]);
  const matches = useMemo(() => findMatches(state), [findMatches, state.doc]);
  let low = 0, high = matches.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (matches[middle].from < state.selection.from) low = middle + 1;
    else high = middle;
  }
  const anchor = low;
  const active = matches[anchor]?.from === state.selection.from && matches[anchor].to === state.selection.to ? anchor : -1;
  const windowStart = Math.max(0, Math.floor(anchor / 100) * 100 - 50);
  useLayoutEffect(() => {
    if (view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) return;
    const window = matches.slice(windowStart, windowStart + 200);
    const highlights = window.map(({ from, to }, index) => Decoration.inline(from, to, {
      class: windowStart + index === active ? "ProseMirror-active-search-match" : "ProseMirror-search-match",
    }));
    if (active < 0 && !state.selection.empty && searchQuery.valid) {
      const { from, to } = state.selection;
      const selected = searchQuery.findNext(state, from);
      if (selected?.from === from && selected.to === to) {
        if (highlights.length === 200) highlights.pop();
        highlights.push(Decoration.inline(from, to, { class: "ProseMirror-active-search-match" }));
      }
    }
    view.dispatch(view.state.tr.setMeta(searchHighlights, DecorationSet.create(state.doc, highlights)));
  }, [view, state.doc, state.selection, matches, windowStart, active, searchQuery]);

  function step(direction: -1 | 1) {
    const { state } = view;
    const matches = findMatches(state);
    if (!matches.length) return;
    const active = matches.findIndex(match => match.from === state.selection.from && match.to === state.selection.to);
    const nextAnchor = matches.findIndex(match => match.from >= state.selection.from);
    const anchor = nextAnchor < 0 ? matches.length : nextAnchor;
    let index = (active + direction + matches.length) % matches.length;
    if (active < 0) {
      if (direction === 1) {
        index = matches.findIndex(match => match.from >= state.selection.to);
        if (index < 0) index = 0;
      } else {
        const previous = anchor - 1;
        index = previous >= 0 && matches[previous].to > state.selection.from ? previous - 1 : previous;
        if (index < 0) index = matches.length - 1;
      }
    }
    const next = matches[index];
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, next.from, next.to)));
  }

  function replace(all: boolean) {
    const { state } = view;
    const matches = findMatches(state);
    if (!matches.length) return;
    const current = all ? undefined : searchQuery.findNext(state, state.selection.from) ?? matches[0];
    if (current && (current.from !== state.selection.from || current.to !== state.selection.to)) {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, current.from, current.to)).scrollIntoView());
      return;
    }
    const replacements = new SearchQuery({ search: query, replace: replacement, caseSensitive, wholeWord, regexp });
    const targets = current ? [current] : matches.filter((match, index) => {
      const previous = matches[index - 1];
      return !previous || match.to > Math.max(previous.to, previous.from + 1);
    });
    const tr = state.tr;
    for (let i = targets.length - 1; i >= 0; i--) {
      for (const { from, to, insert } of replacements.getReplacements(state, targets[i]).reverse()) tr.replace(from, to, insert);
    }
    if (current) {
      const next = searchQuery.findNext(state, current.to) ?? searchQuery.findNext(state, 0, current.from);
      const from = next ? tr.mapping.map(next.from, 1) : current.from;
      const to = next ? tr.mapping.map(next.to, -1) : tr.mapping.map(current.to, 1);
      tr.setSelection(TextSelection.create(tr.doc, from, to)).scrollIntoView();
    }
    view.dispatch(tr);
  }

  useLayoutEffect(() => {
    const scroller = view.dom.closest<HTMLElement>(".editor-scroll")!;
    return () => { scroller.style.removeProperty("--find-clearance"); };
  }, [view]);
  useLayoutEffect(() => {
    if (active < 0) return;
    const scroller = view.dom.closest<HTMLElement>(".editor-scroll")!;
    const panel = overlay.current!;
    function reveal() {
      const viewport = scroller.getBoundingClientRect();
      if (!viewport.height) return;
      const visibleTop = Math.max(viewport.top, panel.getBoundingClientRect().bottom) + 8;
      const { from, to } = matches[active];
      const top = view.coordsAtPos(from).top;
      const bottom = view.coordsAtPos(to, -1).bottom;
      const visibleBottom = viewport.bottom - 28;
      if (top < visibleTop || bottom - top > visibleBottom - visibleTop) {
        const target = scroller.scrollTop + top - visibleTop;
        if (target < 0) {
          const padding = parseFloat(getComputedStyle(scroller).paddingBlockStart) || 0;
          scroller.style.setProperty("--find-clearance", `${padding - target}px`);
        }
        scroller.scrollTop = Math.max(0, target);
      } else if (bottom > visibleBottom) scroller.scrollTop += bottom - visibleBottom;
    }
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(panel);
    resize.observe(scroller);
    return () => resize.disconnect();
  }, [active, matches, view]);

  return <div ref={overlay} className="rich-search" role="search" aria-label="查找与替换" onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text") {
      event.preventDefault();
      if (event.target.name === "replacement") replace(false);
      else step(event.shiftKey ? -1 : 1);
    }
  }}>
    <div className="rich-search-row">
      {!readOnly && <SearchButton label={showReplace ? "收起替换" : "展开替换"}
        aria-expanded={showReplace} onClick={() => setSettings({ ...settings, showReplace: !showReplace })}>
        {showReplace ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </SearchButton>}
      <div className="rich-search-field">
        <input ref={inputRef} autoFocus aria-label="查找" aria-invalid={Boolean(query) && !searchQuery.valid}
          placeholder="查找" value={query} onChange={event => setSettings({ ...settings, query: event.target.value })} />
        <div className="rich-search-options">
          <SearchButton label="区分大小写" aria-pressed={caseSensitive} onClick={() => setSettings({ ...settings, caseSensitive: !caseSensitive })}><CaseSensitive size={15} /></SearchButton>
          <SearchButton label="全词匹配" aria-pressed={wholeWord} onClick={() => setSettings({ ...settings, wholeWord: !wholeWord })}><WholeWord size={15} /></SearchButton>
          <SearchButton label="正则表达式" aria-pressed={regexp} onClick={() => setSettings({ ...settings, regexp: !regexp })}><Regex size={15} /></SearchButton>
        </div>
      </div>
      <div className="rich-search-actions">
        <output className="rich-search-count" aria-label="当前匹配与总数">{query && (matches.length ? `${active + 1} / ${matches.length}` : "无匹配")}</output>
        <SearchButton label="上一处" disabled={!matches.length} onClick={() => step(-1)}><ChevronUp size={15} /></SearchButton>
        <SearchButton label="下一处" disabled={!matches.length} onClick={() => step(1)}><ChevronDown size={15} /></SearchButton>
        <SearchButton label="关闭查找" onClick={close}><X size={15} /></SearchButton>
      </div>
    </div>
    {!readOnly && showReplace && <div className="rich-search-row rich-replace-row">
      <div className="rich-search-field">
        <input name="replacement" aria-label="替换" placeholder="替换" value={replacement} onChange={event => setSettings({ ...settings, replacement: event.target.value })} />
      </div>
      <div className="rich-search-actions">
        <SearchButton label="替换当前匹配" disabled={!matches.length} onClick={() => replace(false)}><Replace size={15} /></SearchButton>
        <SearchButton label="全部替换" disabled={!matches.length} onClick={() => replace(true)}><ReplaceAll size={15} /></SearchButton>
      </div>
    </div>}
  </div>;
}

export function MarkdownEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const savedSearch = useRef<SearchSettings>({ query: "", replacement: "", showReplace: false, caseSensitive: false, wholeWord: false, regexp: false });
  const viewRef = useRef<EditorView>(null);
  const searchListeners = useRef(new Set<() => void>());
  const subscribeToSearch = useCallback((listener: () => void) => {
    searchListeners.current.add(listener);
    return () => { searchListeners.current.delete(listener); };
  }, []);
  const latest = useRef(props);
  const [searchView, setSearchView] = useState<EditorView | null>(null);
  const [footnote, setFootnote] = useState<ReturnType<typeof footnoteDraft>>(null);
  useEffect(() => { if (props.active === false || props.readOnly) setFootnote(null); }, [props.active, props.readOnly]);
  useLayoutEffect(() => { latest.current = props; }, [props]);
  useLayoutEffect(() => viewRef.current?.setProps({ editable: () => !props.readOnly }), [props.active, props.readOnly, props.lineNumbers, props.convertLinks]);

  useEffect(() => {
    const { entryId, value, ref } = latest.current;
    const outlineListeners = new Set<() => void>();
    let outline: ReturnType<typeof editorOutline> | undefined;
    let lastSnapshot: { doc: ProseNode; markdown: string; footnoteLinksNormalized?: boolean };
    const element = host.current!;
    const session = Symbol(entryId);
    const pending = new Map<symbol, Range>();
    const edits = new Set<Promise<void>>();
    const compositionWaiters = new Set<() => void>();
    let compositionTimer: ReturnType<typeof setTimeout> | undefined;
    function resumeCompositionEdits() {
      for (const resume of compositionWaiters) resume();
      compositionWaiters.clear();
    }
    const pastes = new Map<symbol, { offset: number; key: string }>();
    let pasteSequence = 0;
    const failedImages = new Set<() => void>();
    let disposed = false;
    let detachRef: (() => void) | undefined;
    function publish(doc: ProseNode) {
      const { node, end } = lastBodyBlock(doc);
      if (node?.type.name === "paragraph" && !node.content.size) {
        const content = doc.content.cut(0, end - node.nodeSize).append(doc.content.cut(end));
        if (!content.size) return "";
        doc = doc.copy(content);
      }
      return editor.action(ctx => ctx.get(serializerCtx)(doc).replace(/\n$/, ""));
    }
    function normalizeDocument(viewState: EditorView["state"], initializing = false) {
      const { doc, selection } = viewState;
      const { node, end } = lastBodyBlock(doc);
      const moved: { node: ProseNode; pos: number }[] = [];
      const tail = !node?.isTextblock || node.type.name === "code_block" ? viewState.schema.nodes.paragraph.create() : null;
      doc.forEach((child, pos) => {
        if (pos < end && child.type.name === "footnote_definition") moved.push({ node: child, pos });
      });
      if (!tail && !moved.length) return null;
      const tr = viewState.tr;
      for (const footnote of moved.slice().reverse()) tr.delete(footnote.pos, footnote.pos + footnote.node.nodeSize);
      const at = tr.mapping.map(end, -1);
      const blocks = moved.map(footnote => footnote.node);
      if (tail) blocks.unshift(tail);
      tr.insert(at, Fragment.fromArray(blocks));
      if (selection instanceof TextSelection) {
        let pos = at + (tail?.nodeSize ?? 0);
        for (const footnote of moved) {
          if (selection.from > footnote.pos && selection.to < footnote.pos + footnote.node.nodeSize) {
            tr.setSelection(TextSelection.create(tr.doc, pos + selection.anchor - footnote.pos, pos + selection.head - footnote.pos));
            break;
          }
          pos += footnote.node.nodeSize;
        }
      }
      if (initializing || !moved.length) tr.setMeta("addToHistory", false);
      return tr.setMeta(documentLayout, true);
    }
    const isWritable = (view: EditorView) => !disposed && view.editable;
    function showFootnote(view: EditorView, pos: number, label?: string) {
      if (isWritable(view)) {
        const draft = editor.action(ctx => footnoteDraft(view, pos, ctx.get(parserCtx), ctx.get(serializerCtx), label));
        if (draft) setFootnote(draft);
      }
    }

    function track<T>(view: EditorView, range: Range, operation: () => Promise<T>, consume: (range: Range, value: T) => void,
      onError?: (error: unknown) => void, { duringComposition = false, pasteOffset }: { duringComposition?: boolean; pasteOffset?: number } = {}) {
      if (!isWritable(view) || (view.composing && !duringComposition)) return;
      const id = Symbol();
      pending.set(id, range);
      if (pasteOffset !== undefined) {
        pastes.set(id, { offset: pasteOffset, key: `paste-${++pasteSequence}` });
        view.dispatch(view.state.tr.setMeta(pasteProgress, true));
      }
      const edit = operation().then(async value => {
        let deferred = false;
        while (!duringComposition && view.composing && isWritable(view) && pending.has(id)) {
          deferred = true;
          await new Promise<void>(resolve => compositionWaiters.add(resolve));
        }
        const mapped = pending.get(id);
        if (mapped && isWritable(view)) {
          if (deferred) view.dispatch(closeHistory(view.state.tr));
          consume(mapped, value);
          if (deferred) view.dispatch(closeHistory(view.state.tr));
        }
      }).catch(error => { if (!disposed) onError?.(error); }).finally(() => {
        edits.delete(edit);
        pending.delete(id);
        if (pastes.delete(id) && !disposed) view.dispatch(view.state.tr.setMeta(pasteProgress, true));
      });
      edits.add(edit);
    }

    function localizeImages(view: EditorView, images: PastedImage[], localize: (url: string) => Promise<string>,
      onError?: (error: unknown) => void, beforeLayout = view.state.doc) {
      if (!images.length) return;
      if (view.state.doc !== beforeLayout) {
        // Moving footnotes preserves node identity but can shift images to new positions.
        const inserted = new Map(images.map(image => [image.node, image.src]));
        images = [];
        view.state.doc.descendants((node, pos) => {
          const src = inserted.get(node);
          if (src) images.push({ node, from: pos, to: pos + node.nodeSize, src });
        });
      }
      const downloads = new Map<string, Promise<string>>();
      for (const { from, to, src } of images) {
        const task = downloads.get(src) ?? localize(src).catch(error => {
          if (!disposed) onError?.(error);
          return src;
        });
        downloads.set(src, task);
        track(view, { from, to }, () => task, ({ from }, url) => {
          if (url === src) return;
          const current = view.state.doc.nodeAt(from);
          if (current?.type.name === "image" && current.attrs.src === src) {
            view.dispatch(view.state.tr.setNodeAttribute(from, "src", url).setMeta("addToHistory", false));
          }
        }, onError, { duringComposition: true });
      }
    }

    function insertImageMarkdown(view: EditorView, target: Selection | Range, source: string, scroll = false) {
      const { localizeImageLink, onError } = latest.current;
      const tr = view.state.tr;
      const slice = markdownSlice(editor, source);
      if (target instanceof Selection) tr.replaceSelection(slice);
      else tr.replaceRange(target.from, target.to, slice);
      const images: PastedImage[] = [];
      if (localizeImageLink) tr.mapping.maps[0]?.forEach((_oldFrom, _oldTo, start, end) => {
        const remaining = tr.mapping.slice(1);
        if (start < end) images.push(...pastedImages(tr.doc, remaining.map(start, 1), remaining.map(end, -1)));
      });
      view.dispatch(scroll ? tr.scrollIntoView() : tr);
      if (localizeImageLink) localizeImages(view, images, localizeImageLink, onError, tr.doc);
    }

    const editor = Editor.make()
      .config(ctx => {
        ctx.inject(clipboardMarkdownCtx);
        ctx.set(rootCtx, element);
        ctx.set(defaultValueCtx, value);
        ctx.update(editorViewOptionsCtx, options => ({
          ...options,
          editable: () => !latest.current.readOnly,
          attributes: () => ({
            "aria-label": "正文", role: "textbox", "aria-multiline": "true", "aria-readonly": String(latest.current.readOnly),
          }),
          handleDOMEvents: {
            compositionend: () => {
              // Let ProseMirror flush the final composition mutations before using mapped ranges.
              clearTimeout(compositionTimer);
              compositionTimer = setTimeout(resumeCompositionEdits, 0);
              return false;
            },
            blur: () => { latest.current.onBlur(); return false; },
            mousedown: (view, event) => {
              if (event.button !== 2 || !preservesTableSelection(view, event.target)) return false;
              event.preventDefault();
              return true;
            },
            keydown: (view, event) => {
              if (view.composing || event.isComposing || event.keyCode === 229) return false;
              const selection = view.state.selection;
              if (view.editable && event.key === "Enter" && selection instanceof NodeSelection && selection.node.type.name === "footnote_reference") {
                event.preventDefault();
                showFootnote(view, selection.from, selection.node.attrs.label);
                return true;
              }
              if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a"
                && !(selection instanceof CellSelection) && (view.editable || textEditingScope(view.state)?.kind === "code")) {
                event.preventDefault();
                runCommand(editor, view, "selectAll");
                return true;
              }
              if (!view.editable || event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
                || view.state.selection instanceof CellSelection || !isInTable(view.state)) return false;
              event.preventDefault();
              view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.table_line_break.create()).scrollIntoView());
              return true;
            },
            click: (view, event) => {
              const target = event.target as HTMLElement;
              const note = target.closest<HTMLElement>('sup[data-type="footnote_reference"]');
              if (note && note.dataset.label && view.editable) {
                showFootnote(view, view.posAtDOM(note, 0), note.dataset.label);
                return true;
              }
              const link = target.closest<HTMLAnchorElement>("a[href]");
              if (link) {
                event.preventDefault();
                if (target.closest(".rich-link-footnoted") || link.querySelector(".rich-link-footnoted")) return true;
                const { onOpenLink, onError } = latest.current;
                const shortcut = /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
                if (shortcut && !event.altKey && onOpenLink && /^https?:\/\//i.test(link.getAttribute("href")!)) {
                  void onOpenLink(link.href).catch(error => onError?.(error));
                }
                return true;
              }
              const task = target.closest<HTMLElement>('li[data-item-type="task"]');
              if (view.editable && task && (target.hasAttribute("data-markdown-task") || (target === task && event.offsetX <= 16))) {
                const pos = view.posAtDOM(task, 0) - 1;
                const node = view.state.doc.nodeAt(pos)!;
                view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
                return true;
              }
              return false;
            },
            dragover: (view, event) => {
              if (!view.editable || !latest.current.onImages || !event.dataTransfer?.types.includes("Files")) return false;
              event.preventDefault();
              return true;
            },
            drop: (view, event) => {
              const files = Array.from(event.dataTransfer?.files ?? []);
              const insert = latest.current.onImages;
              if (!files.length || !insert) return false;
              event.preventDefault();
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
              track(view, { from: pos, to: pos }, () => insert(files), ({ from, to }, text) => {
                if (text) insertImageMarkdown(view, { from, to }, text);
              }, latest.current.onError);
              return true;
            },
          },
        }));
      })
      .use(richCommonmark).use(gfm).use(history).use(richSchema(() => latest.current, failedImages))
      .use($useKeymap("workbenchEditor", {
        DeletePreviousCodeBlock: {
          shortcuts: "Backspace",
          priority: 100,
          command: () => (state, dispatch, view) => {
            if (!view || !isWritable(view) || view.composing) return false;
            const cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
            if (!cursor || cursor.parentOffset || cursor.parent.type.name !== "paragraph") return false;
            const boundary = cursor.before();
            const previous = state.doc.resolve(boundary).nodeBefore;
            if (previous?.type.name !== "code_block") return false;
            dispatch?.(state.tr.delete(boundary - previous.nodeSize, boundary).scrollIntoView());
            return true;
          },
        },
        KeepFocusOnTab: {
          shortcuts: "Tab",
          priority: 0,
          command: () => (_state, _dispatch, view) =>
            !!view && isWritable(view) && !view.composing && view.hasFocus(),
        },
      }))
      .use($prose(() => editorBlockTools({
        canEdit: view => isWritable(view) && latest.current.active !== false,
        command: (view, name, value) => runCommand(editor, view, name, value),
        insertMarkdown: (view, source) => insertImageMarkdown(view, view.state.selection, source, true),
        insertImage: (view, src) => {
          const { schema, tr } = view.state;
          const { localizeImageLink, onError } = latest.current;
          tr.replaceSelectionWith(schema.nodes.image.create({ src, alt: "" }), false);
          const images: PastedImage[] = [];
          if (localizeImageLink) tr.mapping.maps[0]?.forEach((_from, _to, start, end) => {
            images.push(...pastedImages(tr.doc, start, end));
          });
          view.dispatch(tr);
          if (localizeImageLink) localizeImages(view, images, localizeImageLink, onError, tr.doc);
        },
        canImportImages: () => !!latest.current.onImages,
        importImages: (view, files) => {
          const insert = latest.current.onImages;
          if (!insert) return;
          const { from, to } = view.state.selection;
          track(view, { from, to }, () => insert(files), ({ from, to }, source) => {
            if (source) insertImageMarkdown(view, { from, to }, source, true);
          }, latest.current.onError);
        },
      })))
      .use($prose(() => new Plugin({
        props: { handleKeyDown(view, event) {
          const { onEscape } = latest.current;
          if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229
            || view.composing || !onEscape) return false;
          onEscape();
          return true;
        } },
      })))
      .use($view(codeBlockSchema.node, () => codeView))
      .use($view(tableSchema.node, ctx => (_node, view, getPos) => tableView(ctx, view, getPos)))
      .use($prose(ctx => new Plugin({
        appendTransaction(transactions, _old, state) {
          const transaction = transactions.at(-1);
          return transaction ? repairInlineStrong(transaction, state, source => ctx.get(parserCtx)(source)) : null;
        },
      })))
      .use($prose(() => new Plugin<DecorationSet>({
        key: searchHighlights,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, highlights) => tr.getMeta(searchHighlights) as DecorationSet | undefined
            ?? (tr.docChanged ? highlights.map(tr.mapping, tr.doc) : highlights),
        },
        props: { decorations: state => searchHighlights.getState(state) },
      })))
      .use($prose(() => new Plugin<DecorationSet>({
        key: workspaceSearchHighlights,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, highlights) => tr.getMeta(workspaceSearchHighlights) as DecorationSet | undefined
            ?? (tr.docChanged || tr.selectionSet ? DecorationSet.empty : highlights),
        },
        props: { decorations: state => workspaceSearchHighlights.getState(state) },
      })))
      .use($prose(() => new Plugin({
        key: documentLayout,
        appendTransaction(transactions, _old, state) {
          if (!transactions.some(tr => tr.docChanged && inlineChangedBlocks(tr) === null)) return null;
          return normalizeDocument(state);
        },
      })))
      .use($prose(ctx => editorPresentation(() => latest.current, (state, source, value) => {
        const { schema, doc } = state;
        const { mark, from, to, opening, token } = source;
        const unmarked: ProseNode[] = [];
        doc.slice(from, to).content.forEach(node => unmarked.push(node.mark(mark.removeFromSet(node.marks))));
        const paragraph = schema.nodes.paragraph.create(null, Fragment.fromArray(unmarked));
        const body = ctx.get(serializerCtx)(schema.topNodeType.create(null, paragraph)).replace(/\n$/, "");
        const inline = opening ? value + body + token : token + body + value;
        // Surround the fragment with text so a changed delimiter is still parsed as inline Markdown.
        const parsed = ctx.get(parserCtx)("x " + inline + " x");
        const block = parsed.firstChild;
        const content = parsed.childCount === 1 && block?.type === schema.nodes.paragraph
          ? block.content.cut(2, block.content.size - 2)
          : Fragment.from(schema.text(inline));
        return closeHistory(state.tr.replaceWith(from, to, content));
      }, () => !disposed)))
      .use($prose(() => new Plugin({
        key: pasteProgress,
        props: { decorations(state) {
          if (latest.current.readOnly || !pastes.size) return null;
          const widgets = [];
          for (const [id, { offset, key }] of pastes) {
            const range = pending.get(id);
            if (!range) continue;
            widgets.push(Decoration.widget(range.from + offset, () => {
              const marker = document.createElement("span");
              marker.className = "rich-paste-progress rich-progress";
              marker.setAttribute("role", "status");
              marker.textContent = "正在粘贴…";
              return marker;
            }, { key, side: -1, ignoreSelection: true }));
          }
          return DecorationSet.create(state.doc, widgets);
        } },
      })))
      .use($prose(() => new Plugin<number>({
        key: revision,
        state: {
          init: () => 0,
          apply: (tr, value) => {
            if (!tr.docChanged) return value;
            if (outlineListeners.size) outline?.mapTransaction(tr);
            for (const [id, range] of pending) {
              const mapped = mapRange(range, tr);
              if (mapped) pending.set(id, mapped);
              else pending.delete(id);
            }
            return tr.getMeta(documentLayout) ? value : value + 1;
          },
        },
        filterTransaction: tr => !tr.docChanged || !latest.current.readOnly || Boolean(tr.getMeta(documentLayout)),
        view: () => ({
          update(view, previous) {
            if (!view.composing || !view.editable) resumeCompositionEdits();
            if (view.state.doc !== previous.doc || !view.state.selection.eq(previous.selection)) {
              for (const listener of searchListeners.current) listener();
            }
            if (outlineListeners.size && (view.state.doc !== previous.doc || foldedSections(view.state) !== foldedSections(previous))) {
              for (const listener of outlineListeners) listener();
            }
            const localRevision = revision.getState(view.state)!;
            if (localRevision === revision.getState(previous)) return;
            latest.current.onDocumentChanged(entryId, localRevision);
          },
        }),
      })));

    const targetText = (view: EditorView, { from, to }: Range) =>
      from === to ? "" : publish(view.state.doc.cut(from, to));

    void editor.create().then(() => {
      if (disposed) { void editor.destroy(); return; }
      const view = editor.action(ctx => ctx.get(editorViewCtx));
      const unlink = view.state.tr;
      unlinkFootnoteNames(unlink, footnotedLinkTextRanges(view.state.doc));
      if (unlink.docChanged) view.dispatch(unlink.setMeta(documentLayout, true).setMeta("addToHistory", false));
      const normalized = normalizeDocument(view.state, true);
      if (normalized) view.dispatch(normalized);
      viewRef.current = view;
      lastSnapshot = { doc: view.state.doc, markdown: value, footnoteLinksNormalized: unlink.docChanged };
      outline = editorOutline(view, scroll.current!, listener => {
        outlineListeners.add(listener);
        return () => { outlineListeners.delete(listener); };
      }, () => !disposed && latest.current.active !== false);
      const handle: MarkdownEditorHandle = {
        ...outline.actions,
        pendingEdits: () => edits.size ? Promise.all(edits) : undefined,
        focus: () => view.focus(),
        search: () => {
          if (searchInput.current) searchInput.current.focus();
          else setSearchView(view);
        },
        revealSearchHit(hit, showContext = false) {
          if (disposed || latest.current.active === false) return false;
          const { state } = view;
          const parse = editor.action(ctx => ctx.get(parserCtx));
          const { markdown } = handle.captureMarkdown();
          const expanded = showContext && hit.expanded ? locateSearchHit(state.doc, parse, markdown, hit.expanded) : null;
          // A match in the wider snippet can fall inside Markdown syntax and prevent mapping the visible text.
          const location = expanded?.ranges.length ? expanded : locateSearchHit(state.doc, parse, markdown, hit);
          if (!location) return false;
          setSearchView(null);
          const highlights = location.ranges.map(({ from, to }) =>
            Decoration.inline(from, to, { class: "workspace-search-highlight" }));
          view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, location.position))
            .setMeta(workspaceSearchHighlights, DecorationSet.create(state.doc, highlights)));
          view.focus();
          const viewport = scroll.current!;
          const top = view.coordsAtPos(location.position).top;
          viewport.scrollTop += top - viewport.getBoundingClientRect().top - Math.min(120, viewport.clientHeight / 4);
          return true;
        },
        clearSearchHit() {
          if (!disposed && workspaceSearchHighlights.getState(view.state) !== DecorationSet.empty) {
            view.dispatch(view.state.tr.setMeta(workspaceSearchHighlights, DecorationSet.empty));
          }
        },
        captureMarkdown() {
          const { doc } = view.state;
          if (lastSnapshot.doc !== doc) lastSnapshot = { doc, markdown: publish(doc) };
          return { markdown: lastSnapshot.markdown, localRevision: revision.getState(view.state)! };
        },
        captureDocumentMatch() {
          const { doc } = view.state;
          return () => doc.eq(view.state.doc);
        },
        target: scope => {
          const { from, to } = scope === "document" ? { from: 0, to: view.state.doc.content.size } : view.state.selection;
          return { entryId, session, localRevision: revision.getState(view.state)!, from, to,
            original: scope === "document" ? handle.captureMarkdown().markdown : targetText(view, { from, to }),
            originalSlice: JSON.stringify(view.state.doc.slice(from, to).toJSON()) };
        },
        captureContext(scope) {
          const { doc, selection } = view.state;
          if (disposed || (scope === "selection" && (selection.empty || selection instanceof CellSelection))) return null;
          if (scope === "document") return { ...handle.target("document"), scope, headingPath: [] };
          const headings: { pos: number; level: number; text: string }[] = [];
          doc.forEach((node, pos) => {
            if (node.type.name === "heading") headings.push({ pos, level: node.attrs.level, text: node.textContent });
          });
          const path: typeof headings = [];
          for (const heading of headings) {
            if (heading.pos > selection.from) break;
            while (path.length && path.at(-1)!.level >= heading.level) path.pop();
            path.push(heading);
          }
          const headingPath = path.map(heading => heading.text);
          if (scope === "selection") return { ...handle.target(), scope, headingPath };
          const current = path.at(-1);
          const { $from } = selection;
          const from = current?.pos ?? (headings.length || !$from.depth ? 0 : $from.before(1));
          const to = current
            ? headings.find(heading => heading.pos > current.pos && heading.level <= current.level)?.pos ?? doc.content.size
            : headings[0]?.pos ?? ($from.depth ? $from.after(1) : doc.content.size);
          return { entryId, session, localRevision: revision.getState(view.state)!, from, to, scope, headingPath,
            original: targetText(view, { from, to }), originalSlice: JSON.stringify(doc.slice(from, to).toJSON()) };
        },
        subscribeSelection(listener) {
          searchListeners.current.add(listener);
          return () => { searchListeners.current.delete(listener); };
        },
        selectionText() {
          const { doc, selection } = view.state;
          return handle.hasSelection(false) ? doc.textBetween(selection.from, selection.to, " ") : "";
        },
        insert: text => {
          if (isWritable(view)) insertImageMarkdown(view, view.state.selection, text);
        },
        linkFootnoteMarkdown(source) {
          if (disposed) return source;
          const cached = lastSnapshot.doc === view.state.doc && source === lastSnapshot.markdown;
          const doc = cached
            ? view.state.doc : editor.action(ctx => ctx.get(parserCtx)(source));
          const { edits, definitionEdits, htmlEdits, definitions, missing, existingNames, definitionText } = documentLinkFootnotes(doc, latest.current.githubRepo);
          const tr = new Transform(doc);
          for (const { from, attr, value } of htmlEdits) tr.setNodeMarkup(from, undefined, { ...doc.nodeAt(from)!.attrs, [attr]: value });
          unlinkFootnoteNames(tr, [...existingNames, ...definitionText]);
          for (const { from, to, content } of [...edits, ...definitionEdits]) {
            tr.replaceWith(tr.mapping.map(from), tr.mapping.map(to), content);
          }
          for (const { position, text } of missing) tr.insert(tr.mapping.map(position), doc.type.schema.text(text));
          if (definitions.length) tr.insert(tr.doc.content.size, definitions);
          return tr.docChanged || cached && lastSnapshot.footnoteLinksNormalized ? publish(tr.doc) : source;
        },
        async hostImages(upload, eligible, onTotal) {
          if (!isWritable(view)) return 0;
          const original = new Set<ProseNode>();
          const uploads = new Map<string, { url: string; frames: ImageContext[] }>();
          view.state.doc.descendants((node, pos) => {
            if (node.type.name !== "image") return;
            const src: string = node.attrs.src;
            if (!eligible(src)) return;
            original.add(node);
            let group = uploads.get(src);
            if (!group) {
              group = { url: src, frames: [] };
              uploads.set(src, group);
            }
            const frame = imageContext(view.nodeDOM(pos));
            if (frame) group.frames.push(frame);
          });
          onTotal?.(uploads.size);
          for (const [src, group] of uploads) {
            if (!isWritable(view)) return 0;
            for (const frame of group.frames) frame.setUploading(true);
            try { group.url = await upload(src); }
            finally { for (const frame of group.frames) frame.setUploading(false); }
          }
          if (!isWritable(view)) return 0;
          const tr = closeHistory(view.state.tr);
          let count = 0;
          view.state.doc.descendants((node, pos) => {
            if (!original.has(node)) return;
            const { url } = uploads.get(node.attrs.src)!;
            if (url === node.attrs.src) return;
            tr.setNodeAttribute(pos, "src", url);
            count++;
          });
          if (count) view.dispatch(tr);
          return count;
        },
        matchesTarget: target => !disposed && target.entryId === entryId && target.session === session
          && target.localRevision === revision.getState(view.state)
          && target.originalSlice === JSON.stringify(view.state.doc.slice(target.from, target.to).toJSON()),
        replaceTarget: (target, text) => {
          if (!isWritable(view) || !handle.matchesTarget(target)) return false;
          const slice = markdownSlice(editor, text);
          const { doc } = view.state;
          const { from, to } = target;
          const whole = from === 0 && to === doc.content.size;
          const $from = doc.resolve(from), $to = doc.resolve(to);
          const block = slice.content.firstChild;
          if ($from.sameParent($to) && $from.parent.isTextblock && block) {
            if (block.type !== doc.type.schema.nodes.paragraph && block.type !== $from.parent.type) return false;
            for (let i = 0; i < block.childCount; i++) {
              if (!$from.parent.type.allowsMarks(block.child(i).marks)) return false;
            }
          }
          const tr = view.state.tr.replaceRange(from, to, whole ? new Slice(slice.content, 0, 0) : slice);
          let withinTarget = true;
          for (const map of tr.mapping.maps) {
            map.forEach((start, end) => { withinTarget &&= start >= from && end <= to; });
          }
          if (!withinTarget || (!tr.docChanged && text !== target.original)) return false;
          // A fitted slice can reparent adjacent text even when its step only covers the selection.
          if ((from > 0 && !doc.slice(0, from).eq(tr.doc.slice(0, tr.mapping.map(from, -1))))
            || (to < doc.content.size && !doc.slice(to, doc.content.size).eq(tr.doc.slice(tr.mapping.map(to, 1), tr.doc.content.size)))) return false;
          view.dispatch(closeHistory(tr));
          view.dispatch(closeHistory(view.state.tr));
          return true;
        },
        hasSelection: (allowCells = true) => !view.state.selection.empty
          && (allowCells || !(view.state.selection instanceof CellSelection)),
        retryMissingImages: () => { for (const retry of failedImages) retry(); },
        command: (name, value) => {
          if (disposed) return;
          if (name === "footnote") showFootnote(view, view.state.selection.to);
          else runCommand(editor, view, name, value);
        },
        tableAction: action => { if (!disposed) editor.action(ctx => runTableAction(ctx, view, action)); },
        prepareContext: event => {
          if (view.state.selection instanceof CellSelection
            && ((!event.ctrlKey && event.button !== 2) || preservesTableSelection(view, event.target))) {
            return prepareTableContext(view, event);
          }
          const image = prepareImageContext(view, event);
          if (image) return image;
          const { selection } = view.state;
          const target = event.button === 2 || event.ctrlKey ? event.target
            : selection instanceof NodeSelection ? view.nodeDOM(selection.from) : null;
          const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
          if (anchor && isWritable(view) && view.dom.contains(anchor)) {
            const { doc } = view.state;
            const range = linkRangeAt(doc.resolve(view.posAtDOM(anchor, 0)), anchor.getAttribute("href")!);
            if (range) {
              const { from, to } = range;
              if (!preservesTableSelection(view, anchor) && (selection.empty || selection.to <= from || selection.from >= to)) {
                view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from)));
              }
              const scope = prepareTableContext(view, event) ?? (textEditingScope(view.state)?.kind === "cellText" ? "cellText" : "body");
              return { kind: "link", scope, convert() {
                if (!isWritable(view) || latest.current.active === false || view.state.doc !== doc) return;
                const result = linksToFootnotes(doc.slice(from, to), doc);
                if (!result.definitions.length) return;
                const tr = closeHistory(view.state.tr).replace(from, to, result.slice);
                const caret = tr.mapping.map(to);
                tr.insert(tr.doc.content.size, result.definitions);
                view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(caret))));
                view.focus();
              } };
            }
          }
          const element = target instanceof Element ? target.closest(".rich-formula, hr") : null;
          if (element && view.dom.contains(element)) {
            const pos = view.posAtDOM(element, 0);
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
            return "object";
          }
          const table = prepareTableContext(view, event);
          if (table) return table;
          if ((event.button === 2 || event.ctrlKey) && event.target instanceof Element && !preservesTableSelection(view, event.target)) {
            const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const { empty, from, to } = view.state.selection;
            if (point && (empty || point.pos < from || point.pos > to)) {
              view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(point.pos))));
            }
          }
          return textEditingScope(view.state)?.kind ?? null;
        },
        contextCaret: visible => showContextCaret(view, visible),
        clipboard: (action, io, source, plainText) => {
          if (disposed || (source !== undefined && (
            !(source instanceof Node) || !view.dom.contains(source) || source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement
          ))) return false;
          if (view.composing) return true;
          if (source !== undefined && view.hasFocus() && view.state.selection instanceof TextSelection) {
            const selection = view.dom.ownerDocument.getSelection();
            if (selection?.anchorNode && selection.focusNode && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
              const { doc } = view.state;
              const anchor = doc.resolve(view.posAtDOM(selection.anchorNode, selection.anchorOffset));
              const head = doc.resolve(view.posAtDOM(selection.focusNode, selection.focusOffset));
              const domSelection = TextSelection.between(anchor, head);
              if (!view.state.selection.eq(domSelection)) view.dispatch(view.state.tr.setSelection(domSelection));
            }
          }
          const selected = view.state.selection;
          if (action === "copy" && view.editable && selected instanceof AllSelection) {
            void io.write(handle.captureMarkdown().markdown).catch(io.onError);
            return true;
          }
          if (selected instanceof CellSelection) {
            const range = cellRange(selected);
            const mapped = (from: number) => CellSelection.create(view.state.doc,
              from - range.from + selected.$anchorCell.pos, from - range.from + selected.$headCell.pos);
            if (action === "paste") {
              track(view, range, () => readPaste(io, plainText), ({ from }, payload) => {
                const slice = clipboardSlice(editor, view, payload, plainText);
                if (!slice.size) return;
                const pasteTable = isTableSlice(slice);
                const paragraph = pasteTable ? null : cellParagraph(view.state.schema, slice);
                if (!pasteTable && !paragraph) return;
                const selection = mapped(from);
                if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
                if (paragraph) replaceSelectedCells(view, selection, paragraph);
                else view.someProp("handlePaste", handle => handle(view, new ClipboardEvent("paste"), slice));
                const result = view.state.selection;
                if (!plainText && io.localizeImage && result instanceof CellSelection) {
                  const images = result.ranges.flatMap(({ $from, $to }) => pastedImages(view.state.doc, $from.pos, $to.pos));
                  localizeImages(view, images, io.localizeImage, io.onError);
                }
              }, io.onError, { pasteOffset: plainText ? undefined : 2 });
            } else {
              const { dom, text } = view.serializeForClipboard(selected.content());
              const write = () => io.write(text, dom.innerHTML);
              if (action === "copy") void write().catch(io.onError);
              else track(view, range, write, ({ from }) => replaceSelectedCells(view, mapped(from)), io.onError);
            }
            return true;
          }
          const scope = textEditingScope(view.state);
          if (action === "paste") {
            const asText = plainText || scope?.kind === "code";
            track(view, view.state.selection, () => readPaste(io, asText), ({ from, to }, payload) => {
              if (scope?.kind === "code") {
                const text = typeof payload === "string" ? payload : payload.text;
                if (text) view.dispatch(view.state.tr.insertText(text.replace(/\r\n?/g, "\n"), from, to));
                return;
              }
              const slice = clipboardSlice(editor, view, payload, plainText);
              if (!slice.size) return;
              const { doc, schema } = view.state;
              const cell = cellAround(doc.resolve(from));
              const inCell = cell && cell.pos === cellAround(doc.resolve(to))?.pos;
              const tr = view.state.tr;
              if (inCell) {
                const paragraph = cellParagraph(schema, slice);
                if (!paragraph) return;
                tr.replaceWith(from, to, paragraph.content);
              } else tr.replaceRange(from, to, slice);
              const images: PastedImage[] = [];
              if (!plainText && io.localizeImage) tr.mapping.maps[0]?.forEach((_oldFrom, _oldTo, start, end) => {
                if (start < end) images.push(...pastedImages(tr.doc, start, end));
              });
              view.dispatch(tr.setMeta("uiEvent", "paste"));
              if (io.localizeImage) localizeImages(view, images, io.localizeImage, io.onError, tr.doc);
            }, io.onError, { pasteOffset: asText ? undefined : 0 });
            return true;
          }
          if (action === "cut" && !isWritable(view)) return true;
          const range = textRange(view);
          const text = view.state.doc.textBetween(range.from, range.to, "\n", node =>
            node.type.name === "table_line_break" ? "\n"
              : node.attrs.alt || node.attrs.label || (node.type.name.startsWith("math_") ? node.attrs.value : ""),
          );
          let html: string | undefined;
          if (scope?.kind !== "code") {
            const wrapper = document.createElement("div");
            DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.slice(range.from, range.to).content, {}, wrapper);
            html = wrapper.innerHTML;
          }
          const write = () => io.write(text, html);
          if (action === "cut") {
            track(view, range, write, ({ from, to }) => view.dispatch(view.state.tr.deleteRange(from, to)), io.onError);
          } else {
            void write().catch(io.onError);
          }
          return true;
        },
      };
      if (typeof ref === "function") {
        const cleanup = ref(handle);
        detachRef = typeof cleanup === "function" ? cleanup : () => ref(null);
      } else if (ref) {
        ref.current = handle;
        detachRef = () => { ref.current = null; };
      }
    }).catch(error => { if (!disposed) latest.current.onError?.(error); });

    return () => {
      disposed = true;
      clearTimeout(compositionTimer);
      resumeCompositionEdits();
      pending.clear();
      pastes.clear();
      detachRef?.();
      if (viewRef.current) { viewRef.current = null; void editor.destroy(); }
    };
  }, []);

  return <div className="editor-host">
    {searchView && <SearchBar view={searchView} readOnly={props.readOnly} inputRef={searchInput} subscribe={subscribeToSearch} saved={savedSearch} onClose={() => setSearchView(null)} />}
    {footnote && props.active !== false && !props.readOnly && <FootnotePopover draft={footnote} onClose={() => setFootnote(null)} />}
    <div className="editor-scroll" ref={scroll}>{props.title}<div className="rich-editor" ref={host} /></div>
    <DomTooltips root={host} />
  </div>;
}
