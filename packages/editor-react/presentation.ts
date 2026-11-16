import { DOMSerializer, Fragment, Slice, type Mark, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { readCalloutMarker } from "../markdown-core/callouts";
import { codeHighlight } from "./code-view";
import { tableSelectionDecorations } from "./table-view";
import { linksToFootnotes } from "./link-footnotes";

type Section = { from: number; to: number };
type TextContext = { caretHeight?: number };
type PresentationState = { focused: boolean; folded: Map<number, Section>; context: TextContext | null };
type PresentationUpdate = { focused: boolean } | { toggle: number } | { context: TextContext | null };
const presentation = new PluginKey<PresentationState>("workbenchPresentation");

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

function blockDecorations(doc: ProseNode, folded: Map<number, Section>, lineNumbers: boolean) {
  const decorations: Decoration[] = [];
  for (const section of folded.values()) {
    for (let pos = section.from; pos < section.to;) {
      const end = pos + doc.nodeAt(pos)!.nodeSize;
      decorations.push(Decoration.node(pos, end, { hidden: "" }));
      pos = end;
    }
  }
  let line = 1;
  doc.descendants((node, pos, parent) => {
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

function delimiters(mark: Mark, text: string): [string, string] {
  switch (mark.type.name) {
    case "strong": return ["**", "**"];
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

function syntaxAtCaret(state: EditorState) {
  const { $head, empty } = state.selection;
  if ($head.parent.type.name === "code_block") {
    return [Decoration.node($head.before(), $head.after(), { class: "rich-code-active" }, { codeSource: true })];
  }
  if (!empty || !$head.parent.isTextblock) return [];
  const decorations: Decoration[] = [];
  const block = $head.parent;
  const start = $head.start();
  const add = (pos: number, text: string, side: number, task = false) => {
    decorations.push(Decoration.widget(pos, () => {
      const marker = document.createElement("span");
      marker.className = "rich-markdown-syntax";
      marker.dataset.markdown = text;
      if (task) marker.dataset.markdownTask = "";
      marker.setAttribute("aria-hidden", "true");
      return marker;
    }, { key: `syntax-${side}-${text}`, side, ignoreSelection: true }));
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
  active.forEach(({ mark, from, to }, index) => {
    const [open, close] = delimiters(mark, block.textBetween(from - start, to - start));
    add(from, open, index + 1);
    add(to, close, -index - 1);
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

export function editorPresentation(options: () => { readOnly: boolean; lineNumbers?: boolean; convertLinks?: boolean }) {
  let cached: { doc: ProseNode; folded: Map<number, Section>; lineNumbers: boolean; blocks: DecorationSet } | undefined;
  let linkNotes: { doc: ProseNode; decorations: Decoration[] } | undefined;
  return new Plugin<PresentationState>({
    key: presentation,
    state: {
      init: () => ({ focused: false, folded: new Map(), context: null }),
      apply(tr, current) {
        const update = tr.getMeta(presentation) as PresentationUpdate | undefined;
        const focused = update && "focused" in update ? update.focused : current.focused;
        let folded = current.folded;
        if (update && "toggle" in update) {
          const pos = update.toggle;
          folded = new Map(folded);
          if (!folded.delete(pos)) folded.set(pos, sectionAfter(tr.doc, pos)!);
        } else if (folded.size && tr.docChanged) {
          folded = new Map();
          for (const pos of current.folded.keys()) {
            const mapped = tr.mapping.mapResult(pos + 1, -1);
            const point = tr.doc.resolve(mapped.pos);
            if (mapped.deletedAcross || point.parent.type.name !== "heading") continue;
            const heading = point.before();
            const section = sectionAfter(tr.doc, heading);
            if (section) folded.set(heading, section);
          }
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
        const decorations = tableSelectionDecorations(state);
        if (convertLinks) {
          if (linkNotes?.doc !== doc) linkNotes = { doc, decorations: linkFootnoteDecorations(doc) };
          decorations.push(...linkNotes.decorations);
        }
        if ((focused || context) && !readOnly) decorations.push(...syntaxAtCaret(state));
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
        return decorations.length ? cached.blocks.add(doc, decorations) : cached.blocks;
      },
      handleDOMEvents: {
        focus(view) { view.dispatch(view.state.tr.setMeta(presentation, { focused: true } satisfies PresentationUpdate)); return false; },
        blur(view) { view.dispatch(view.state.tr.setMeta(presentation, { focused: false } satisfies PresentationUpdate)); return false; },
      },
    },
  });
}
