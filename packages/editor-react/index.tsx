import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type Ref } from "react";
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, parserCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { gfm, tableSchema } from "@milkdown/kit/preset/gfm";
import { closeHistory } from "@milkdown/kit/prose/history";
import { DOMParser, DOMSerializer, Fragment, Slice, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { cellAround, CellSelection, isInTable } from "@milkdown/kit/prose/tables";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { Transform } from "@milkdown/kit/prose/transform";
import { $prose, $view } from "@milkdown/kit/utils";
import { Tooltip } from "../ui-react/Tooltip";
import DOMPurify from "dompurify";
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-react";
import { getSearchState, replaceAll, replaceNext, search, SearchQuery, setSearchState } from "prosemirror-search";
import { runCommand, textEditingScope, type EditorCommand } from "./commands";
import { clipboardMarkdownCtx, hrefPattern, richCommonmark, richSchema } from "./schema";
import { imageContext, imagePattern, prepareImageContext, type EditorImages, type ImageContext } from "./image-view";
import { editorPresentation, showContextCaret } from "./presentation";
import { cellParagraph, isTableSlice, prepareTableContext, preservesTableSelection, replaceSelectedCells, runTableAction, tableView, type TableAction, type TableContext } from "./table-view";
import { codeView } from "./code-view";
import { footnoteDraft, FootnotePopover } from "./footnotes";
import { footnotedLinkNames, linkRangeAt, linksToFootnotes } from "./link-footnotes";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import "@milkdown/kit/prose/gapcursor/style/gapcursor.css";
import "./editor.css";

export type { EditorCommand } from "./commands";
export type { ImageContext } from "./image-view";
export type { TableAction, TableContext } from "./table-view";

export interface LinkContext { kind: "link"; scope: "body" | "cellText" | TableContext; convert(): void }

export interface EditorTarget {
  entryId: string;
  session: symbol;
  localRevision: number;
  from: number;
  to: number;
  original: string;
}

export interface MarkdownEditorHandle {
  focus(): void;
  search(): void;
  target(scope?: "document"): EditorTarget;
  insert(text: string): void;
  linkFootnoteMarkdown(source: string): string;
  hostImages?(upload: (src: string) => Promise<string>, eligible: (src: string) => boolean): Promise<number>;
  replaceTarget(target: EditorTarget, text: string): boolean;
  retryMissingImages(): void;
  hasSelection(): boolean;
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
  readOnly: boolean;
  active?: boolean;
  lineNumbers?: boolean;
  convertLinks?: boolean;
  title?: ReactNode;
  onChange(entryId: string, localRevision: number, markdown: string): void;
  onBlur(): void;
  onImages?(files: File[]): Promise<string>;
  onOpenLink?(url: string): Promise<void>;
}

type Range = { from: number; to: number };
type PastedImage = Range & { node: ProseNode; src: string };
const revision = new PluginKey<number>("workbenchRevision");
const documentLayout = new PluginKey("workbenchDocumentLayout");
const pasteProgress = new PluginKey("workbenchPasteProgress");
const embeddedImage = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i;

async function readPaste(io: ClipboardIO, plainText?: boolean): Promise<ClipboardContent> {
  const payload = await io.read(plainText);
  const { importImage } = io;
  if (plainText || typeof payload === "string" || !importImage || !/data:image\//i.test(payload.html)) return payload;
  const template = document.createElement("template");
  template.innerHTML = payload.html;
  const imported = new Map<string, Promise<string>>();
  await Promise.all([...template.content.querySelectorAll("img[src]")].map(async image => {
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

function htmlSlice(view: EditorView, html: string) {
  const richMetadata = [
    "data-type", "data-value", "data-label", "data-math", "data-display", "data-language",
    "data-item-type", "data-list-type", "data-spread", "data-checked", "data-workbench-src", "data-workbench-alt", "data-literal-callout",
  ];
  const fragment = DOMPurify.sanitize(html, {
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
  });
  for (const embedded of fragment.querySelectorAll('[data-type="html"], [data-type="html-block"]')) {
    embedded.replaceWith(embedded.textContent);
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
    const url = img.getAttribute("src");
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
  if (semanticHtml) return rich;
  const markdown = markdownSlice(editor, payload.text, true);
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

function lastBodyBlock(doc: ProseNode) {
  let end = doc.content.size;
  for (let index = doc.childCount - 1; index >= 0; index--) {
    const node = doc.child(index);
    if (node.type.name !== "footnote_definition") return { node, end };
    end -= node.nodeSize;
  }
  return { node: null, end };
}

function pastedImages(doc: ProseNode, from: number, to: number): PastedImage[] {
  const images: PastedImage[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "image" && pos >= from && pos + node.nodeSize <= to && /^https?:\/\//i.test(node.attrs.src)) {
      images.push({ node, from: pos, to: pos + node.nodeSize, src: node.attrs.src });
    }
  });
  return images;
}

function SearchButton({ label, ...props }: ComponentProps<"button"> & { label: string }) {
  return <Tooltip content={label}><button type="button" aria-label={label} {...props} /></Tooltip>;
}

function SearchBar({ view, readOnly, inputRef, subscribe, onClose }: {
  view: EditorView; readOnly: boolean; inputRef: Ref<HTMLInputElement>;
  subscribe(listener: () => void): () => void; onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(subscribe, () => view.state);
  const searchQuery = useMemo(() => new SearchQuery({ search: query, replace: replacement, caseSensitive, wholeWord, regexp }),
    [query, replacement, caseSensitive, wholeWord, regexp]);
  const close = () => { onClose(); view.focus(); };

  useEffect(() => {
    const previous = getSearchState(view.state)?.query;
    const changed = previous?.search !== searchQuery.search || previous.caseSensitive !== searchQuery.caseSensitive
      || previous.wholeWord !== searchQuery.wholeWord || previous.regexp !== searchQuery.regexp;
    const { state } = view;
    const tr = setSearchState(state.tr, searchQuery);
    if (changed && searchQuery.valid) {
      const match = searchQuery.findNext(state, state.selection.from) ?? searchQuery.findNext(state);
      if (match) tr.setSelection(TextSelection.create(state.doc, match.from, match.to));
    }
    view.dispatch(tr);
  }, [view, searchQuery]);
  useEffect(() => () => {
    if (!view.isDestroyed) view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: "" })));
  }, [view]);

  const matches = useMemo(() => {
    const results: Range[] = [];
    if (searchQuery.valid) {
      for (let pos = 0; pos <= state.doc.content.size;) {
        const match = searchQuery.findNext(state, pos);
        if (!match) break;
        results.push(match);
        pos = Math.max(match.to, match.from + 1);
      }
    }
    return results;
  }, [searchQuery, state.doc]);
  const active = matches.findIndex(match => match.from === state.selection.from && match.to === state.selection.to);

  function step(direction: -1 | 1) {
    if (!matches.length) return;
    const { state } = view;
    let index = (active + direction + matches.length) % matches.length;
    if (active < 0) {
      if (direction === 1) {
        index = matches.findIndex(match => match.from >= state.selection.to);
        if (index < 0) index = 0;
      } else {
        const following = matches.findIndex(match => match.to > state.selection.from);
        index = following > 0 ? following - 1 : matches.length - 1;
      }
    }
    const next = matches[index];
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, next.from, next.to)));
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
      if (event.target.name === "replacement") replaceNext(view.state, view.dispatch, view);
      else step(event.shiftKey ? -1 : 1);
    }
  }}>
    <div className="rich-search-row">
      {!readOnly && <SearchButton label={showReplace ? "收起替换" : "展开替换"}
        aria-expanded={showReplace} onClick={() => setShowReplace(!showReplace)}>
        {showReplace ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </SearchButton>}
      <div className="rich-search-field">
        <input ref={inputRef} autoFocus aria-label="查找" aria-invalid={Boolean(query) && !searchQuery.valid}
          placeholder="查找" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="rich-search-options">
          <SearchButton label="区分大小写" aria-pressed={caseSensitive} onClick={() => setCase(!caseSensitive)}><CaseSensitive size={15} /></SearchButton>
          <SearchButton label="全词匹配" aria-pressed={wholeWord} onClick={() => setWord(!wholeWord)}><WholeWord size={15} /></SearchButton>
          <SearchButton label="正则表达式" aria-pressed={regexp} onClick={() => setRegexp(!regexp)}><Regex size={15} /></SearchButton>
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
        <input name="replacement" aria-label="替换" placeholder="替换" value={replacement} onChange={event => setReplacement(event.target.value)} />
      </div>
      <div className="rich-search-actions">
        <SearchButton label="替换当前匹配" disabled={!matches.length} onClick={() => replaceNext(view.state, view.dispatch, view)}><Replace size={15} /></SearchButton>
        <SearchButton label="全部替换" disabled={!matches.length} onClick={() => replaceAll(view.state, view.dispatch, view)}><ReplaceAll size={15} /></SearchButton>
      </div>
    </div>}
  </div>;
}

export function MarkdownEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
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
  useLayoutEffect(() => viewRef.current?.setProps({ editable: () => !props.readOnly }), [props.readOnly, props.lineNumbers, props.convertLinks]);

  useEffect(() => {
    const { entryId, value, ref } = latest.current;
    let markdown = value;
    const element = host.current!;
    const session = Symbol(entryId);
    const pending = new Map<symbol, Range>();
    const pastes = new Map<symbol, { offset: number; key: string }>();
    let pasteSequence = 0;
    const failedImages = new Set<() => void>();
    let disposed = false;
    let detachRef: (() => void) | undefined;
    const publish = (doc: ProseNode) => {
      const { node, end } = lastBodyBlock(doc);
      if (node?.type.name === "paragraph" && !node.content.size) {
        const content = doc.content.cut(0, end - node.nodeSize).append(doc.content.cut(end));
        if (!content.size) return "";
        doc = doc.copy(content);
      }
      return editor.action(ctx => ctx.get(serializerCtx)(doc).replace(/\n$/, ""));
    };
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
      void operation().then(value => {
        const mapped = pending.get(id);
        if (mapped && isWritable(view) && (!view.composing || duringComposition)) consume(mapped, value);
      }).catch(error => { if (!disposed) onError?.(error); }).finally(() => {
        pending.delete(id);
        if (pastes.delete(id) && !disposed) view.dispatch(view.state.tr.setMeta(pasteProgress, true));
      });
    }

    function localizePastedImages(view: EditorView, images: PastedImage[], io: ClipboardIO, beforeLayout = view.state.doc) {
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
        const task = downloads.get(src) ?? io.localizeImage!(src).catch(error => {
          if (!disposed) io.onError(error);
          return src;
        });
        downloads.set(src, task);
        track(view, { from, to }, () => task, ({ from }, url) => {
          if (url === src) return;
          const current = view.state.doc.nodeAt(from);
          if (current?.type.name === "image" && current.attrs.src === src) {
            view.dispatch(view.state.tr.setNodeAttribute(from, "src", url).setMeta("addToHistory", false));
          }
        }, io.onError, { duringComposition: true });
      }
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
                if (text) view.dispatch(view.state.tr.replaceRange(from, to, markdownSlice(editor, text)));
              }, latest.current.onError);
              return true;
            },
          },
        }));
      })
      .use(richCommonmark).use(gfm).use(history).use(richSchema(() => latest.current, failedImages))
      .use($view(codeBlockSchema.node, () => codeView))
      .use($view(tableSchema.node, ctx => (_node, view, getPos) => tableView(ctx, view, getPos)))
      .use($prose(() => search()))
      .use($prose(() => new Plugin({
        key: documentLayout,
        appendTransaction(transactions, _old, state) {
          if (!transactions.some(tr => tr.docChanged)) return null;
          return normalizeDocument(state);
        },
      })))
      .use($prose(() => editorPresentation(() => latest.current)))
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
            for (const listener of searchListeners.current) listener();
            const localRevision = revision.getState(view.state)!;
            if (localRevision === revision.getState(previous)) return;
            markdown = publish(view.state.doc);
            latest.current.onChange(entryId, localRevision, markdown);
          },
        }),
      })));

    const targetText = (view: EditorView, { from, to }: Range) =>
      from === to ? "" : publish(view.state.doc.cut(from, to));

    void editor.create().then(() => {
      if (disposed) { void editor.destroy(); return; }
      const view = editor.action(ctx => ctx.get(editorViewCtx));
      const unlink = view.state.tr;
      unlinkFootnoteNames(unlink, footnotedLinkNames(view.state.doc));
      if (unlink.docChanged) view.dispatch(unlink.setMeta(documentLayout, true).setMeta("addToHistory", false));
      const normalized = normalizeDocument(view.state, true);
      if (normalized) view.dispatch(normalized);
      viewRef.current = view;
      const handle: MarkdownEditorHandle = {
        focus: () => view.focus(),
        search: () => {
          if (searchInput.current) searchInput.current.focus();
          else setSearchView(view);
        },
        target: scope => {
          const { from, to } = scope === "document" ? { from: 0, to: view.state.doc.content.size } : view.state.selection;
          return { entryId, session, localRevision: revision.getState(view.state)!, from, to,
            original: scope === "document" ? markdown : targetText(view, { from, to }) };
        },
        insert: text => {
          if (isWritable(view)) view.dispatch(view.state.tr.replaceSelection(markdownSlice(editor, text)));
        },
        linkFootnoteMarkdown(source) {
          if (disposed) return source;
          const doc = source === markdown ? view.state.doc : editor.action(ctx => ctx.get(parserCtx)(source));
          const { edits, definitions, missing, existingNames, definitionNames } = linksToFootnotes(new Slice(doc.content, 0, 0), doc, "document");
          const tr = new Transform(doc);
          unlinkFootnoteNames(tr, [...existingNames, ...definitionNames]);
          for (const { from, to, content } of edits) {
            tr.replaceWith(tr.mapping.map(from), tr.mapping.map(to), content);
          }
          for (const { position, text } of missing) tr.insert(tr.mapping.map(position), doc.type.schema.text(text));
          if (definitions.length) tr.insert(tr.doc.content.size, definitions);
          return tr.docChanged ? publish(tr.doc) : source;
        },
        async hostImages(upload, eligible) {
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
        replaceTarget: (target, text) => {
          if (!isWritable(view) || target.entryId !== entryId || target.session !== session
            || target.localRevision !== revision.getState(view.state)) return false;
          const slice = markdownSlice(editor, text);
          const whole = target.from === 0 && target.to === view.state.doc.content.size;
          const tr = view.state.tr.replaceRange(target.from, target.to, whole ? new Slice(slice.content, 0, 0) : slice);
          view.dispatch(closeHistory(tr));
          view.dispatch(closeHistory(view.state.tr));
          return true;
        },
        hasSelection: () => !view.state.selection.empty,
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
            void io.write(markdown).catch(io.onError);
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
                  localizePastedImages(view, images, io);
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
              view.dispatch(tr);
              localizePastedImages(view, images, io, tr.doc);
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
      pending.clear();
      pastes.clear();
      detachRef?.();
      if (viewRef.current) { viewRef.current = null; void editor.destroy(); }
    };
  }, []);

  return <div className="editor-host">
    {searchView && <SearchBar view={searchView} readOnly={props.readOnly} inputRef={searchInput} subscribe={subscribeToSearch} onClose={() => setSearchView(null)} />}
    {footnote && props.active !== false && !props.readOnly && <FootnotePopover draft={footnote} onClose={() => setFootnote(null)} />}
    <div className="editor-scroll">{props.title}<div className="rich-editor" ref={host} /></div>
  </div>;
}
