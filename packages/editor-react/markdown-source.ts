import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { closeHistory } from "@milkdown/kit/prose/history";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $nodeSchema } from "@milkdown/kit/utils";

// Keep the editable source in the document so selection, history and saving all
// use the same text, including incomplete Markdown while the author is typing.
export const markdownSource = $nodeSchema("markdown_source", () => ({
  group: "block", content: "text*", marks: "", code: true, defining: true,
  attrs: { level: { default: 0 }, images: { default: null } },
  toDOM: node => [node.attrs.level ? `h${node.attrs.level}` : "p",
    { "data-markdown-source": "", "data-source-images": node.attrs.images }, 0],
  parseDOM: [{ tag: "[data-markdown-source]", preserveWhitespace: "full",
    getAttrs: dom => ({ level: /^H[1-6]$/.test(dom.nodeName) ? Number(dom.nodeName[1]) : 0,
      images: dom.hasAttribute("data-source-images") ? Number(dom.getAttribute("data-source-images")) : null }) }],
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: node => node.type.name === "markdown_source",
    runner: (state, node) => { state.addNode("html", undefined, node.textContent); },
  },
}));

export const exitMarkdownSource = new PluginKey("exitMarkdownSource");

type MarkdownSyntax = {
  type: string;
  children?: MarkdownSyntax[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

export function markdownSourceEditing(parse: (source: string) => ProseNode, serialize: (doc: ProseNode) => string,
  normalize: (tr: Transaction) => Transaction, onRestore: () => void, parseSyntax: (source: string) => MarkdownSyntax) {
  const sourceImages = new Map<number, ProseNode[]>();
  const strongRanges = new WeakMap<ProseNode, { from: number; to: number }[]>();
  let sourceSequence = 0;
  function sourceNode(state: EditorState, text: string, blocks: ProseNode[]) {
    const images: ProseNode[] = [];
    for (const block of blocks) {
      if (block.type.name === "markdown_source") images.push(...(sourceImages.get(block.attrs.images) ?? []));
      else block.descendants(child => { if (child.type.name === "image") images.push(child); });
    }
    const imageKey = images.length ? ++sourceSequence : null;
    if (imageKey !== null) sourceImages.set(imageKey, images);
    const first = blocks[0];
    const level = first.type.name === "heading" || first.type.name === "markdown_source" ? first.attrs.level : 0;
    return state.schema.nodes.markdown_source.create({ level, images: imageKey }, text ? state.schema.text(text) : null);
  }

  function sourceText(node: ProseNode, doc: ProseNode) {
    return node.type.name === "markdown_source" ? node.textContent : serialize(doc.copy(Fragment.from(node))).replace(/\n$/, "");
  }
  function content(node: ProseNode, doc: ProseNode) {
    const definitions: ProseNode[] = [];
    doc.forEach(child => { if (child.type.name === "footnote_definition") definitions.push(child); });
    let parsedContent: Fragment;
    if (!definitions.length) parsedContent = parse(node.textContent).content;
    else {
      // Footnote references need their document definitions during parsing. Keep
      // that context before a boundary so unfinished source cannot consume it.
      const boundary = "<!--workbench-markdown-source-->";
      const context = serialize(doc.copy(Fragment.fromArray(definitions)));
      const parsed = parse(`${context}\n\n${boundary}\n\n${node.textContent}`);
      const blocks: ProseNode[] = [];
      let source = false;
      parsed.forEach(child => {
        if (!source && child.type.name === "html_block" && child.attrs.value.trim() === boundary) source = true;
        else if (source) blocks.push(child);
      });
      parsedContent = Fragment.fromArray(blocks);
    }
    // Presentation changes must preserve unchanged image identities used by
    // in-flight uploads. Changed or deleted image attributes do not match.
    const images = [...(sourceImages.get(node.attrs.images) ?? [])];
    function reuseImage(child: ProseNode): ProseNode {
      if (child.type.name === "image") {
        const index = images.findIndex(image => image.eq(child));
        return index < 0 ? child : images.splice(index, 1)[0];
      }
      if (!child.content.size) return child;
      const children: ProseNode[] = [];
      child.forEach(nested => children.push(reuseImage(nested)));
      return child.copy(Fragment.fromArray(children));
    }
    const blocks: ProseNode[] = [];
    parsedContent.forEach(child => blocks.push(reuseImage(child)));
    return Fragment.fromArray(blocks);
  }

  function restore(view: EditorView) {
    if (!view.editable) return;
    const tr = view.state.tr;
    view.state.doc.forEach((node, pos) => {
      if (node.type.name !== "markdown_source") return;
      const parsed = content(node, view.state.doc);
      tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize),
        parsed.size ? parsed : view.state.schema.nodes.paragraph.create());
    });
    if (tr.docChanged) view.dispatch(closeHistory(tr));
  }

  function open(view: EditorView, position: number, token: string, after = false) {
    const { state } = view;
    const point = state.doc.resolve(position);
    const block = point.node(1);
    if (block.type.name === "markdown_source") return;
    const from = point.before(1);
    const source = sourceText(block, state.doc);
    const node = sourceNode(state, source, [block]);
    const tr = closeHistory(state.tr).replaceWith(from, from + block.nodeSize, node);
    // Locate this occurrence when the block contains several identical markers.
    const probe = "\uE000";
    const probed = state.tr.insertText(probe, position);
    const anchor = serialize(state.schema.topNodeType.create(null, Fragment.from(probed.doc.nodeAt(from)!))).indexOf(probe);
    if (token.startsWith("- ")) token = "* " + token.slice(2);
    let offset = 0, distance = Infinity;
    for (let at = source.indexOf(token); at >= 0; at = source.indexOf(token, at + token.length)) {
      const next = Math.min(Math.abs(anchor - at), Math.abs(anchor - at - token.length));
      if (next < distance) { offset = at; distance = next; }
    }
    tr.setSelection(TextSelection.create(tr.doc, from + 1 + offset + (after ? token.length : 0)));
    view.dispatch(tr);
    view.focus();
  }

  function joinSource(view: EditorView, direction: -1 | 1, separator: string) {
    const { state } = view;
    const { $from } = state.selection;
    if ($from.depth !== 1) return false;
    const index = $from.index(0);
    const adjacent = state.doc.maybeChild(index + direction);
    const block = $from.parent;
    const editableBlock = (node: ProseNode) => ["paragraph", "heading", "markdown_source"].includes(node.type.name);
    if (!adjacent || !editableBlock(block) || !editableBlock(adjacent)) return false;
    let syntax = block.type.name !== "paragraph" || adjacent.type.name !== "paragraph";
    for (const node of [block, adjacent]) node.descendants(child => { syntax ||= child.marks.length > 0; });
    if (!syntax) return false;
    const blocks = direction < 0 ? [adjacent, block] : [block, adjacent];
    const first = sourceText(blocks[0], state.doc), second = sourceText(blocks[1], state.doc);
    const from = $from.before() - (direction < 0 ? adjacent.nodeSize : 0);
    const tr = closeHistory(state.tr).replaceWith(from, from + block.nodeSize + adjacent.nodeSize,
      sourceNode(state, first + separator + second, blocks));
    const offset = first.length + (direction > 0 ? separator.length : 0);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1 + offset)).scrollIntoView());
    return true;
  }

  function keydown(view: EditorView, event: KeyboardEvent) {
    if (!view.editable || view.composing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return false;
    const { $from, empty } = view.state.selection;
    const source = $from.parent.type.name === "markdown_source";
    if (source && event.key === "Enter") {
      view.dispatch(view.state.tr.insertText("\n").scrollIntoView());
      return true;
    }
    if (!empty || !$from.parent.isTextblock || event.shiftKey) return false;
    const start = $from.parentOffset === 0, end = $from.parentOffset === $from.parent.content.size;
    if (start && event.key === "Backspace" || end && event.key === "Delete") {
      return joinSource(view, event.key === "Backspace" ? -1 : 1, "");
    }
    if (source) {
      if (start && event.key === "ArrowLeft" || end && event.key === "ArrowRight") {
        return joinSource(view, event.key === "ArrowLeft" ? -1 : 1, "\n\n");
      }
      return false;
    }
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key) || event.key === "Home" && !start) return false;
    const block = view.nodeDOM($from.before()) as HTMLElement;
    const closing = event.key === "ArrowRight";
    const marker = [...block.querySelectorAll<HTMLElement>(".rich-markdown-syntax")].find(element =>
      view.posAtDOM(element, 0) === $from.pos && element.dataset.markdownClosing === String(closing));
    if (!marker) return false;
    open(view, $from.pos, marker.dataset.markdown!, closing);
    return true;
  }

  return new Plugin({
    appendTransaction(transactions, _old, state) {
      const exit = transactions.some(tr => tr.getMeta(exitMarkdownSource));
      if (!exit && !transactions.some(tr => tr.selectionSet)) return null;
      const tr = state.tr;
      state.doc.forEach((node, pos) => {
        if (node.type.name !== "markdown_source" || !exit && state.selection.from <= pos + node.nodeSize && state.selection.to > pos) return;
        const parsed = content(node, state.doc);
        tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize),
          parsed.size ? parsed : state.schema.nodes.paragraph.create());
      });
      return tr.docChanged ? exit ? normalize(tr) : tr : null;
    },
    view: () => ({ destroy: () => sourceImages.clear(), update(view, previous) {
      if (view.state.doc === previous.doc) return;
      let before = 0, after = 0;
      previous.doc.forEach(node => { if (node.type.name === "markdown_source") before++; });
      view.state.doc.forEach(node => { if (node.type.name === "markdown_source") after++; });
      if (after < before) onRestore();
    } }),
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.forEach((node, pos) => {
          if (node.type.name !== "markdown_source") return;
          let ranges = strongRanges.get(node);
          if (!ranges) {
            ranges = [];
            const visit = (syntax: MarkdownSyntax) => {
              if (syntax.type === "strong") {
                const from = syntax.position!.start.offset! + 2;
                const to = syntax.position!.end.offset! - 2;
                ranges!.push({ from, to });
              }
              syntax.children?.forEach(visit);
            };
            visit(parseSyntax(node.textContent));
            strongRanges.set(node, ranges);
          }
          for (const { from, to } of ranges) {
            decorations.push(Decoration.inline(pos + 1 + from, pos + 1 + to, { nodeName: "strong" }));
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
      handleDOMEvents: {
        keydown(view, event) {
          const handled = keydown(view, event);
          if (handled) event.preventDefault();
          return handled;
        },
        mousedown(view, event) {
          if (!view.editable || event.button !== 0 || !(event.target instanceof Element)) return false;
          const marker = event.target.closest<HTMLElement>(".rich-markdown-syntax, .rich-code-fence");
          if (!marker || event.target instanceof HTMLInputElement && marker.classList.contains("rich-code-fence")) return false;
          event.preventDefault();
          const code = marker.closest(".rich-code-block")?.querySelector("code");
          const position = code ? view.posAtDOM(code, marker.classList.contains("rich-code-fence-open") ? 0 : code.childNodes.length)
            : view.posAtDOM(marker, 0);
          open(view, position, marker.dataset.markdown!);
          return true;
        },
        blur(view, event) {
          if (!(event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget))) restore(view);
          return false;
        },
      },
    },
  });
}
