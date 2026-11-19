import { DOMSerializer, Fragment, Slice, type Mark, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { readCalloutMarker } from "../markdown-core/callouts";
import { codeHighlight } from "./code-view";
import { tableSelectionDecorations } from "./table-view";
import { hasLinkFootnoteContent, linksToFootnotes } from "./link-footnotes";
import { inlineChangedBlocks } from "./inline-changes";

type Section = { from: number; to: number };
type TextContext = { caretHeight?: number };
type PresentationState = { focused: boolean; folded: Map<number, Section>; context: TextContext | null };
type PresentationUpdate = { focused: boolean } | { toggle: number } | { context: TextContext | null };
const presentation = new PluginKey<PresentationState>("workbenchPresentation");

export function foldedSections(state: EditorState): ReadonlyMap<number, Section> | undefined {
  return presentation.getState(state)?.folded;
}

export function showContextCaret(view: EditorView, visible: boolean) {
  const { selection } = view.state;
  if (visible && (!view.editable || !(selection instanceof TextSelection))) return;
  const context: TextContext | null = visible ? {} : null;
  if (context && selection.empty) {
    const { top, bottom } = view.coordsAtPos(selection.head);
    context.caretHeight = bottom - top;
  }
  view.dispatch(view.state.tr.setMeta(presentation, { context } satisfies PresentationUpdate));
}

function sectionAfter(doc: ProseNode, pos: number): Section | undefined {
  const point = doc.resolve(pos);
  const heading = point.nodeAfter!;
  const from = pos + heading.nodeSize;
  let to = from;
  for (let index = point.index() + 1; index < point.parent.childCount; index++) {
    const sibling = point.parent.child(index);
    if (sibling.type === heading.type && sibling.attrs.level <= heading.attrs.level) break;
    if (to + sibling.nodeSize === doc.content.size && sibling.type.name === "paragraph" && !sibling.content.size) break;
    to += sibling.nodeSize;
  }
  if (to > from) return { from, to };
}

function foldButton(heading: number, folded: boolean, trailing = false) {
  return Decoration.widget(heading, (view, getPos) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = trailing ? "rich-heading-fold-end" : "rich-heading-fold";
    button.setAttribute("aria-label", folded ? "展开标题下的内容" : "折叠标题下的内容");
    button.setAttribute("aria-expanded", String(!folded));
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => {
      const point = view.state.doc.resolve(getPos()!);
      const headingPos = point.before();
      const section = sectionAfter(view.state.doc, headingPos)!;
      const tr = view.state.tr.setMeta(presentation, { toggle: headingPos } satisfies PresentationUpdate);
      const { from, to } = view.state.selection;
      if (!folded && from < section.to && to >= section.from) {
        tr.setSelection(TextSelection.create(tr.doc, point.end()));
      }
      const restoreFocus = document.activeElement === button;
      view.dispatch(tr);
      if (restoreFocus) (view.nodeDOM(headingPos) as HTMLElement).querySelector<HTMLButtonElement>(".rich-heading-fold")!.focus();
    };
    return button;
  }, { key: `fold-${folded}-${trailing}`, side: trailing ? 10 : -20, stopEvent: () => true, ignoreSelection: true });
}

function codeLineNumber(pos: number, line: number) {
  return Decoration.widget(pos, () => {
    const marker = document.createElement("span");
    marker.className = "rich-code-line-number";
    marker.dataset.editorLine = String(line);
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }, { key: `code-line-${line}`, side: -1, ignoreSelection: true });
}

function blockDecorations(doc: ProseNode, folded: Map<number, Section>, lineNumbers: boolean, from = 0, to = doc.content.size) {
  const decorations: Decoration[] = [];
  for (const section of folded.values()) {
    for (let pos = Math.max(from, section.from); pos < Math.min(to, section.to);) {
      const end = pos + doc.nodeAt(pos)!.nodeSize;
      decorations.push(Decoration.node(pos, end, { hidden: "" }));
      pos = end;
    }
  }
  let line = 1;
  doc.nodesBetween(from, to, (node, pos, parent) => {
    const name = node.type.name;
    const list = name === "bullet_list" || name === "ordered_list";
    const attrs: Record<string, string> = {};
    if (name === "blockquote" && !node.attrs.literalCallout && node.firstChild?.type.name === "paragraph") {
      const paragraph = node.firstChild;
      const first = paragraph.firstChild;
      const callout = first?.isText && !first.marks.length && readCalloutMarker(first.text!);
      if (callout) {
        attrs["data-callout"] = callout.kind;
        const start = pos + 2;
        let headerEnd = paragraph.content.size;
        paragraph.forEach((child, offset) => {
          if (child.type.name === "hardbreak" && headerEnd === paragraph.content.size) {
            headerEnd = offset;
            decorations.push(Decoration.node(start + offset, start + offset + child.nodeSize, { class: "rich-callout-break" }));
          }
        });
        const prefix = callout.marker.length + (first.text!.slice(callout.marker.length).match(/^\s*/)?.[0].length ?? 0);
        decorations.push(Decoration.inline(start, start + headerEnd, { class: "rich-callout-title" }));
        decorations.push(Decoration.inline(start, start + prefix, {
          class: "rich-callout-marker",
          ...(prefix === headerEnd ? { "data-callout-label": callout.label } : {}),
        }));
      }
    }
    if (name === "code_block") decorations.push(...codeHighlight(node, pos + 1));
    if (lineNumbers && name === "code_block") {
      attrs.class = "rich-numbered-code";
      let start = pos + 1;
      for (const sourceLine of node.textContent.split("\n")) {
        decorations.push(codeLineNumber(start, line++));
        start += sourceLine.length + 1;
      }
    } else if (lineNumbers && (name === "list_item" || (parent === doc && !list))) {
      attrs["data-editor-line"] = String(line++);
    }
    if (name === "heading") {
      const point = doc.resolve(pos);
      const next = point.parent.maybeChild(point.index() + 1);
      if (next && (next.type !== node.type || next.attrs.level > node.attrs.level)) {
        const collapsed = folded.has(pos);
        attrs.class = "rich-foldable-heading";
        decorations.push(foldButton(pos + 1, collapsed));
        if (collapsed) decorations.push(foldButton(pos + node.nodeSize - 1, true, true));
      }
    }
    if (Object.keys(attrs).length) decorations.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    return !node.isTextblock && name !== "table";
  });
  return DecorationSet.create(doc, decorations);
}

const visibleMarks = new Set(["strong", "emphasis", "strike_through", "highlight", "inlineCode", "link"]);
type StrongDelimiter = { mark: Mark; from: number; to: number; opening: boolean; token: string };
type DelimiterWidget = (view: EditorView, source: StrongDelimiter) => HTMLElement;
function isDelimiterInput(view: EditorView, target: EventTarget | null) {
  return target instanceof HTMLInputElement && target.closest(".rich-strong-delimiter") && view.dom.contains(target);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function movePastDelimiter(doc: ProseNode, pos: number, direction: -1 | 1) {
  const point = doc.resolve(pos);
  const text = (direction < 0 ? point.nodeBefore : point.nodeAfter)?.text;
  const length = text ? graphemes.segment(text).containing(direction < 0 ? text.length - 1 : 0)?.segment.length ?? 1 : 1;
  const next = pos + direction * length;
  return next >= 0 && next <= doc.content.size ? Selection.findFrom(doc.resolve(next), direction, true) : null;
}

function delimiters(mark: Mark, text: string): [string, string] {
  switch (mark.type.name) {
    case "strong": return mark.attrs.marker === "_" ? ["__", "__"] : ["**", "**"];
    case "emphasis": return ["*", "*"];
    case "strike_through": return ["~~", "~~"];
    case "highlight": return ["==", "=="];
    case "inlineCode": {
      const ticks = "`".repeat(1 + Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length)));
      const pad = text.startsWith("`") || text.endsWith("`") || (/^ .+ $/.test(text) && Boolean(text.trim())) ? " " : "";
      return [ticks + pad, pad + ticks];
    }
    default: {
      const href = String(mark.attrs.href);
      if (!mark.attrs.title && href === text) return ["<", ">"];
      const destination = /[\s()]/.test(href) ? `<${href.replace(/>/g, "\\>")}>` : href;
      const title = mark.attrs.title ? ` ${JSON.stringify(mark.attrs.title)}` : "";
      return ["[", `](${destination}${title})`];
    }
  }
}

function syntaxAtCaret(state: EditorState, delimiterWidget: DelimiterWidget) {
  const { $head, empty } = state.selection;
  if ($head.parent.type.name === "code_block") {
    return [Decoration.node($head.before(), $head.after(), { class: "rich-code-active" }, { codeSource: true })];
  }
  if (!empty || !$head.parent.isTextblock) return [];
  const decorations: Decoration[] = [];
  const block = $head.parent;
  const start = $head.start();
  const add = (pos: number, text: string, side: number, task = false, source?: StrongDelimiter) => {
    decorations.push(Decoration.widget(pos, view => {
      if (source) return delimiterWidget(view, source);
      const marker = document.createElement("span");
      marker.className = "rich-markdown-syntax";
      marker.dataset.markdown = text;
      // Generated text in these widgets can stall WebKit when it computes the visible text range.
      marker.textContent = text;
      if (task) marker.dataset.markdownTask = "";
      marker.setAttribute("aria-hidden", "true");
      return marker;
    }, { key: `syntax-${side}-${text}${source ? `-${source.from}-${source.to}` : ""}`, side, ignoreSelection: true,
      stopEvent: event => Boolean(source && event.target instanceof HTMLInputElement) }));
  };
  let quoteDepth = 0;
  let listItemDepth = 0;
  for (let depth = 1; depth < $head.depth; depth++) {
    const name = $head.node(depth).type.name;
    if (name === "blockquote") quoteDepth++;
    if (name === "list_item") listItemDepth = depth;
  }
  const quotePrefix = "> ".repeat(quoteDepth);
  if (quotePrefix) {
    add(start, quotePrefix, -12);
    if ($head.node($head.depth - 1).type.name === "blockquote" && $head.index($head.depth - 1) === 0) {
      decorations.push(Decoration.node(start - 1, $head.after(), { class: "rich-callout-source" }));
    }
  }
  if (listItemDepth) {
    const item = $head.node(listItemDepth);
    const listDepth = listItemDepth - 1;
    const list = $head.node(listDepth);
    let marker = list.type.name === "ordered_list" ? `${list.attrs.order + $head.index(listDepth)}. ` : "- ";
    const checked = item.attrs.checked;
    const task = checked != null;
    if (task) marker += checked ? "[x] " : "[ ] ";
    add($head.start(listItemDepth) + 1, marker, -11, task);
    decorations.push(Decoration.node($head.before(listItemDepth), $head.after(listItemDepth), { class: "rich-list-source" }));
  }
  if (block.type.name === "heading") add(start, "#".repeat(block.attrs.level) + " ", -10);

  const runs: { mark: Mark; from: number; to: number; order: number }[] = [];
  const last = new Map<string, typeof runs[number]>();
  block.forEach((child, offset) => {
    if (!child.isText) {
      if (quotePrefix && child.type.name === "hardbreak" && !child.attrs.isInline) {
        add(start + offset + child.nodeSize, quotePrefix, -12);
      }
      return;
    }
    const from = start + offset;
    const to = from + child.nodeSize;
    child.marks.forEach((mark, order) => {
      const name = mark.type.name;
      if (!visibleMarks.has(name)) return;
      const previous = last.get(name);
      if (previous?.to === from && previous.mark.eq(mark)) previous.to = to;
      else {
        const run = { mark, from, to, order };
        runs.push(run);
        last.set(name, run);
      }
    });
  });
  const active = runs.filter(({ from, to }) => from <= $head.pos && $head.pos <= to)
    .sort((a, b) => a.from - b.from || b.to - a.to || a.order - b.order);
  const openings = new Set(active.map(({ from }) => from));
  active.forEach(({ mark, from, to }, index) => {
    const [open, close] = delimiters(mark, block.textBetween(from - start, to - start));
    const strong = mark.type.name === "strong";
    // Keep adjacent closing markers before the next opening marker at the same document position.
    const closingSide = openings.has(to) ? -active.length - index - 1 : active.length - index;
    add(from, open, index - active.length, false, strong ? { mark, from, to, opening: true, token: open } : undefined);
    add(to, close, closingSide, false, strong ? { mark, from, to, opening: false, token: close } : undefined);
  });
  return decorations;
}

function linkFootnoteDecorations(doc: ProseNode) {
  const { edits, definitions, missing, existingNames } = linksToFootnotes(new Slice(doc.content, 0, 0), doc, "document");
  const decorations: Decoration[] = [];
  for (const { from, to, addressOnly } of existingNames) {
    if (addressOnly) decorations.push(Decoration.inline(from, to, { class: "rich-link-footnoted" }));
  }
  for (const { from, to, content } of edits) {
    decorations.push(Decoration.inline(from, to, { class: "rich-link-footnoted" }));
    const label = content.lastChild!.attrs.label;
    decorations.push(Decoration.widget(to, () => {
      const marker = document.createElement("sup");
      marker.className = "rich-link-citation";
      marker.textContent = `[^${label}]`;
      return marker;
    }, { side: 1, key: `link-citation-${label}`, ignoreSelection: true }));
  }
  for (const { position, text } of missing) {
    decorations.push(Decoration.widget(position, () => {
      const url = document.createElement("span");
      url.className = "rich-link-footnoted";
      url.textContent = text;
      return url;
    }, { side: -1, key: `legacy-link-${text}`, ignoreSelection: true }));
  }
  if (definitions.length) {
    decorations.push(Decoration.widget(doc.content.size, () => {
      const section = document.createElement("section");
      section.className = "rich-link-notes";
      const heading = document.createElement("h2");
      heading.textContent = "参考资料";
      section.append(heading, DOMSerializer.fromSchema(doc.type.schema).serializeFragment(Fragment.fromArray(definitions)));
      return section;
    }, { ignoreSelection: true }));
  }
  return decorations;
}

export function editorPresentation(options: () => { readOnly: boolean; lineNumbers?: boolean; convertLinks?: boolean },
  replaceDelimiter: (state: EditorState, source: StrongDelimiter, value: string) => Transaction, isLive: () => boolean) {
  let mouseSyntax: { doc: ProseNode; decorations: Decoration[] } | null = null;
  let delimiterEdit: { field: HTMLInputElement; doc: ProseNode; decorations: Decoration[] } | null = null;
  let refreshFrame = 0;
  let cached: { doc: ProseNode; folded: Map<number, Section>; lineNumbers: boolean; blocks: DecorationSet } | undefined;
  let linkNotes: { doc: ProseNode; decorations: DecorationSet } | undefined;
  let combined: { blocks: DecorationSet; links: DecorationSet; set: DecorationSet } | undefined;
  function makeDelimiter(view: EditorView, source: StrongDelimiter) {
    const { token, from, to, opening } = source;
    const marker = document.createElement("span");
    marker.className = "rich-markdown-syntax rich-strong-delimiter";
    marker.dataset.markdown = token;
    const field = document.createElement("input");
    field.type = "text";
    field.size = token.length;
    field.tabIndex = -1;
    field.spellcheck = false;
    field.value = token;
    field.setAttribute("aria-label", opening ? "加粗起始标记" : "加粗结束标记");
    field.dataset.position = String(opening ? from : to);
    field.dataset.opening = String(opening);
    marker.append(field);

    function finish(save: boolean, restoreFocus: boolean, related?: EventTarget | null, direction?: -1 | 1) {
      if (delimiterEdit?.field !== field) return;
      const active = delimiterEdit;
      if (!isLive()) { delimiterEdit = null; return; }
      const { state } = view;
      const changed = save && state.doc === active.doc && !options().readOnly && field.value !== token;
      const focusInEditor = restoreFocus || (related instanceof Node && view.dom.contains(related));
      const tr = changed ? replaceDelimiter(state, source, field.value) : state.tr;
      if (restoreFocus && state.doc === active.doc) {
        const pos = opening ? tr.mapping.map(from, -1) : tr.mapping.map(to, 1);
        const selection = direction ? movePastDelimiter(tr.doc, pos, direction) : TextSelection.create(tr.doc, pos);
        if (!selection) return;
        tr.setSelection(selection);
      }
      delimiterEdit = null;
      if (!changed) field.value = token;
      view.dispatch(tr.setMeta(presentation, { focused: focusInEditor } satisfies PresentationUpdate));
      if (restoreFocus) view.focus();
    }

    field.onfocus = () => {
      const { state } = view;
      const held = delimiterEdit?.doc === state.doc ? delimiterEdit : mouseSyntax?.doc === state.doc ? mouseSyntax : null;
      delimiterEdit = { field, doc: state.doc,
        decorations: held?.decorations ?? syntaxAtCaret(state, makeDelimiter) };
    };
    field.onblur = event => {
      if (isDelimiterInput(view, event.relatedTarget)) {
        if (field.value !== token) finish(true, true);
      } else finish(true, false, event.relatedTarget);
    };
    field.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      const collapsed = field.selectionStart === field.selectionEnd
        && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      const atStart = collapsed && event.key === "ArrowLeft" && field.selectionStart === 0;
      const atEnd = collapsed && event.key === "ArrowRight" && field.selectionEnd === field.value.length;
      if (!atStart && !atEnd && event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      const direction = opening && atStart ? -1 : !opening && atEnd ? 1 : undefined;
      finish(event.key !== "Escape", true, null, direction);
    };
    return marker;
  }
  return new Plugin<PresentationState>({
    key: presentation,
    view(view) {
      const doc = view.dom.ownerDocument;
      const window = doc.defaultView!;
      const listeners = new AbortController();
      const finish = () => {
        if (!mouseSyntax || refreshFrame) return;
        refreshFrame = window.requestAnimationFrame(() => {
          refreshFrame = 0;
          mouseSyntax = null;
          if (isLive()) view.dispatch(view.state.tr);
        });
      };
      doc.addEventListener("mouseup", finish, { capture: true, signal: listeners.signal });
      doc.addEventListener("dragend", finish, { capture: true, signal: listeners.signal });
      window.addEventListener("blur", finish, { signal: listeners.signal });
      return { destroy() { listeners.abort(); window.cancelAnimationFrame(refreshFrame); } };
    },
    state: {
      init: () => ({ focused: false, folded: new Map(), context: null }),
      apply(tr, current) {
        const update = tr.getMeta(presentation) as PresentationUpdate | undefined;
        const focused = update && "focused" in update ? update.focused : current.focused;
        let folded = current.folded;
        const inline = tr.docChanged ? inlineChangedBlocks(tr) : null;
        if (update && "toggle" in update) {
          const pos = update.toggle;
          folded = new Map(folded);
          if (!folded.delete(pos)) folded.set(pos, sectionAfter(tr.doc, pos)!);
        } else if (folded.size && tr.docChanged) {
          folded = new Map();
          for (const [pos, range] of current.folded) {
            if (inline) {
              folded.set(tr.mapping.map(pos), { from: tr.mapping.map(range.from), to: tr.mapping.map(range.to) });
              continue;
            }
            const mapped = tr.mapping.mapResult(pos + 1, -1);
            const point = tr.doc.resolve(mapped.pos);
            if (mapped.deletedAcross || point.parent.type.name !== "heading") continue;
            const heading = point.before();
            const section = sectionAfter(tr.doc, heading);
            if (section) folded.set(heading, section);
          }
        }
        if (inline && cached?.doc === tr.before && cached.folded === current.folded && folded.size === current.folded.size
          && !(update && "toggle" in update)) {
          const extended = inline.filter(index => tr.doc.child(index).type.name !== "paragraph");
          if (!cached.lineNumbers || !extended.length) {
            let blocks = cached.blocks.map(tr.mapping, tr.doc);
            for (const index of extended) {
              const from = tr.doc.resolve(0).posAtIndex(index), to = from + tr.doc.child(index).nodeSize;
              const obsolete = blocks.find(from, to).filter(item => item.from >= from && item.to <= to
                && (item.from !== item.to || (item.from > from && item.to < to)));
              blocks = blocks.remove(obsolete).add(tr.doc, blockDecorations(tr.doc, folded, false, from, to).find());
            }
            cached = { ...cached, doc: tr.doc, folded, blocks };
          }
        }
        if (inline && linkNotes?.doc === tr.before && inline.every(index =>
          !hasLinkFootnoteContent(tr.before.child(index)) && !hasLinkFootnoteContent(tr.doc.child(index)))) {
          linkNotes = { doc: tr.doc, decorations: linkNotes.decorations.map(tr.mapping, tr.doc) };
        }
        if (tr.selectionSet) {
          const caret = tr.selection.head;
          for (const [pos, section] of folded) {
            if (caret <= section.from || caret >= section.to) continue;
            if (folded === current.folded) folded = new Map(folded);
            folded.delete(pos);
          }
        }
        const context = update && "context" in update ? update.context : current.context;
        return { focused, folded, context };
      },
    },
    props: {
      decorations(state) {
        const { doc } = state;
        const { focused, folded, context } = presentation.getState(state)!;
        const { readOnly, lineNumbers = false, convertLinks } = options();
        if (cached?.doc !== doc || cached.folded !== folded || cached.lineNumbers !== lineNumbers) {
          cached = { doc, folded, lineNumbers, blocks: blockDecorations(doc, folded, lineNumbers) };
        }
        let persistent = cached.blocks;
        if (convertLinks) {
          if (linkNotes?.doc !== doc) linkNotes = { doc, decorations: DecorationSet.create(doc, linkFootnoteDecorations(doc)) };
          const links = linkNotes.decorations;
          if (combined?.blocks !== persistent || combined.links !== links) {
            combined = { blocks: persistent, links, set: persistent.add(doc, links.find()) };
          }
          persistent = combined.set;
        }
        const decorations = tableSelectionDecorations(state);
        if (!readOnly) {
          if (delimiterEdit?.doc === doc) decorations.push(...delimiterEdit.decorations);
          else if (mouseSyntax?.doc === doc) decorations.push(...mouseSyntax.decorations);
          else if (focused || context) decorations.push(...syntaxAtCaret(state, makeDelimiter));
        }
        const caretHeight = context?.caretHeight;
        if (caretHeight !== undefined && !readOnly && state.selection instanceof TextSelection && state.selection.empty) {
          decorations.push(Decoration.widget(state.selection.head, () => {
            const caret = document.createElement("span");
            caret.className = "rich-context-caret";
            caret.setAttribute("aria-hidden", "true");
            caret.style.setProperty("--context-caret-height", `${caretHeight}px`);
            return caret;
          }, { key: `context-caret-${caretHeight}`, side: 1, ignoreSelection: true }));
        }
        return decorations.length ? persistent.add(doc, decorations) : persistent;
      },
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0 || !view.editable) return false;
          view.dom.ownerDocument.defaultView!.cancelAnimationFrame(refreshFrame);
          refreshFrame = 0;
          const { state } = view;
          const { focused, context } = presentation.getState(state)!;
          // Keep the text in place until the browser has finished measuring its selection.
          if (mouseSyntax?.doc !== state.doc) {
            mouseSyntax = { doc: state.doc, decorations: focused || context ? syntaxAtCaret(state, makeDelimiter) : [] };
          }
          return false;
        },
        keydown(view, event) {
          if (!view.editable || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
          const selection = view.dom.ownerDocument.getSelection();
          if (!selection?.isCollapsed || !selection.anchorNode || !view.dom.contains(selection.anchorNode)) return false;
          const position = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
          const opening = event.key === "ArrowLeft";
          const field = view.dom.querySelector<HTMLInputElement>(
            `.rich-strong-delimiter input[data-position="${position}"][data-opening="${opening}"]`,
          );
          if (!field) return false;
          field.focus();
          field.setSelectionRange(1, 1);
          event.preventDefault();
          return true;
        },
        focus(view) {
          if (isLive()) view.dispatch(view.state.tr.setMeta(presentation, { focused: true } satisfies PresentationUpdate));
          return false;
        },
        blur(view, event) {
          const target = event.relatedTarget;
          if (isLive() && !isDelimiterInput(view, target)) {
            view.dispatch(view.state.tr.setMeta(presentation, { focused: false } satisfies PresentationUpdate));
          }
          return false;
        },
      },
    },
  });
}
