import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { createSlice } from "@milkdown/kit/ctx";
import { blockContainerTypes, blockquoteSchema, commonmark, htmlSchema, imageSchema, remarkHtmlTransformer } from "@milkdown/kit/preset/commonmark";
import { footnoteDefinitionSchema, footnoteReferenceSchema, tableCellSchema, tableHeaderSchema } from "@milkdown/kit/preset/gfm";
import { markRule } from "@milkdown/kit/prose";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { Node as ProseNode, TagParseRule } from "@milkdown/kit/prose/model";
import { Selection } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $inputRule, $markSchema, $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { remarkMarkHighlight } from "@ai-markdown/remark-mark-highlight";
import remarkMath from "remark-math";
import { renderMarkdown, sanitizeRenderedMarkdown } from "../markdown-core";
import { readCalloutMarker } from "../markdown-core/callouts";
import { editorIconButton, imageView, type EditorImages } from "./image-view";
import { documentLinkFootnotes, sentencePunctuation } from "./link-footnotes";

export const hrefPattern = /^(?:https?:\/\/|mailto:|#)/i;
export const richCommonmark = commonmark.filter(plugin => !remarkHtmlTransformer.includes(plugin));
export const clipboardMarkdownCtx = createSlice(false, "clipboardMarkdown");

type Tree = {
  type: string;
  value?: unknown;
  disclosureHeader?: string;
  url?: string;
  children?: Tree[];
  literalCallout?: boolean;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

// mdast uses the same node for both inline and block HTML. ProseMirror needs
// them in different groups to round-trip HTML inside paragraphs and containers.
const richNodes = $remark("workbenchRichNodes", ctx =>
  () => (tree: Tree, file: { value: unknown }) => {
    const source = String(file.value);
    const isClipboard = ctx.get(clipboardMarkdownCtx);
    const containers = ctx.get(blockContainerTypes.key);
    const nestedFootnotes: Tree[] = [];
    const visit = (parent: Tree) => {
      if (!parent.children) return;
      if (isClipboard) parent.children = parent.children.flatMap((child, index, siblings) => {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        const url = child.url;
        if (child.type !== "link" || !url || start === undefined || end === undefined || source.slice(start, end) !== url) return [child];
        const boundary = url.search(sentencePunctuation);
        // An implicit URL in pasted prose can absorb the rest of a Chinese sentence. Keep explicit and standalone URLs intact.
        const previous = siblings[index - 1];
        const prose = previous?.type === "text" && typeof previous.value === "string" && previous.value.split(/\r?\n/).at(-1)?.trim();
        if (boundary < 0 || !/[。！？；]$/.test(url) || !prose) return [child];
        const address = url.slice(0, boundary);
        return [{ ...child, url: address, children: [{ type: "text", value: address }] }, { type: "text", value: url.slice(boundary) }];
      });
      parent.children = parent.children.filter(child => {
        if (parent.type === "tableCell" && child.type === "html" && /^<br\s*\/?>$/i.test(String(child.value))) {
          child.type = "tableLineBreak";
        } else if (child.type === "html" && (containers.includes(parent.type) || parent.type === "githubDisclosure")) {
          child.type = "htmlBlock";
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (child.type === "blockquote" && child.children?.[0]?.type === "paragraph") {
          const first = child.children[0].children?.[0];
          const from = first?.position?.start.offset;
          if (first?.type === "text" && from !== undefined && readCalloutMarker(String(first.value))) {
            child.literalCallout = !readCalloutMarker(source.slice(from));
          }
        }
        if (child.type === "inlineMath" && start !== undefined && end !== undefined) {
          const expression = source.slice(start, end);
          if (/^\$+\s|\s\$+$/.test(expression)) {
            child.type = "text";
            child.value = expression;
          } else if (expression.startsWith("$$")) {
            child.type = "inlineDisplayMath";
          }
        }
        if (child.type === "footnoteDefinition" && parent !== tree) {
          nestedFootnotes.push(child);
          visit(child);
          return false;
        }
        const count = nestedFootnotes.length;
        visit(child);
        return nestedFootnotes.length === count || child.children?.length !== 0;
      });
    };
    // Keep the Markdown inside a disclosure in the editor's normal block schema.
    const children = tree.children ?? [];
    const disclosures: { index: number; header: string }[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type !== "html") continue;
      const html = String(child.value).trim();
      const previous = disclosures.at(-1);
      if (previous?.index === index - 1 && !/<summary(?=[\s>])/i.test(previous.header)
        && /^<summary(?:\s[^>]*)?>[\s\S]*?<\/summary>(?:\s*<br\s*\/?>\s*)*$/i.test(html)) {
        previous.header += "\n" + html;
        children.splice(index, 1);
        index--;
        continue;
      }
      if (/^<details(?:\s[^>]*)?>\s*(?:<summary(?:\s[^>]*)?>[\s\S]*?<\/summary>\s*)?(?:<br\s*\/?>\s*)*$/i.test(html)) {
        disclosures.push({ index, header: html });
      }
      const opening = /^<\/details>$/i.test(html) ? disclosures.pop() : undefined;
      if (!opening) continue;
      children.splice(opening.index, index - opening.index + 1, {
        type: "githubDisclosure", disclosureHeader: opening.header, children: children.slice(opening.index + 1, index),
      });
      index = opening.index;
    }
    visit(tree);
    tree.children?.push(...nestedFootnotes);
  });

const htmlInline = htmlSchema.extendSchema(base => ctx => ({
  ...base(ctx),
  toDOM: node => ["span", { "data-type": "html", "data-value": node.attrs.value }, "嵌入的 HTML"],
}));

const htmlBlock = $nodeSchema("html_block", () => ({
  group: "block",
  atom: true,
  attrs: { value: { default: "" } },
  toDOM: node => ["div", { "data-type": "html-block", "data-value": node.attrs.value }, "嵌入的 HTML"],
  parseDOM: [{ tag: 'div[data-type="html-block"]', getAttrs: dom => ({ value: dom.getAttribute("data-value") }) }],
  parseMarkdown: {
    match: node => node.type === "htmlBlock",
    runner: (state, node, type) => { state.addNode(type, { value: node.value }); },
  },
  toMarkdown: {
    match: node => node.type.name === "html_block",
    runner: (state, node) => { state.addNode("html", undefined, node.attrs.value); },
  },
}));

function disclosureDOM(header: string, githubRepo?: string) {
  const fragment = sanitizeRenderedMarkdown(header, { githubRepo, embedded: true });
  const dom = fragment.querySelector("details") ?? document.createElement("details");
  const summary = dom.querySelector(":scope > summary") ?? document.createElement("summary");
  if (!summary.textContent?.trim()) summary.textContent = "详细信息";
  summary.setAttribute("contenteditable", "false");
  const contentDOM = document.createElement("div");
  dom.className = "rich-disclosure";
  dom.replaceChildren(summary, contentDOM);
  return { dom, contentDOM };
}

const githubDisclosure = $nodeSchema("github_disclosure", () => ({
  group: "block",
  content: "block+",
  attrs: { header: { default: "<details>" } },
  toDOM: node => disclosureDOM(node.attrs.header),
  parseMarkdown: {
    match: node => node.type === "githubDisclosure",
    runner: (state, node, type) => state.openNode(type, { header: node.disclosureHeader }).next(node.children).closeNode(),
  },
  toMarkdown: {
    match: node => node.type.name === "github_disclosure",
    runner: (state, node) => state.addNode("html", undefined, node.attrs.header)
      .next(node.content).addNode("html", undefined, "</details>"),
  },
}));

type HtmlOptions = EditorImages & { githubRepo?: string; convertLinks?: boolean };

function projectedHtml(view: EditorView, pos: number | undefined, { convertLinks, githubRepo }: HtmlOptions) {
  const projected = convertLinks && pos !== undefined
    ? documentLinkFootnotes(view.state.doc, githubRepo).htmlEdits.find(edit => edit.from === pos)?.value : undefined;
  return projected?.replace(/<span data-workbench-footnote="(\d+)"><\/span>/g, "<sup>[^$1]</sup>");
}

function embeddedHtmlView(node: ProseNode, view: EditorView, getPos: () => number | undefined, getOptions: () => HtmlOptions): NodeView {
  const dom = document.createElement(node.isInline ? "span" : "div");
  dom.className = "rich-embedded-html";
  dom.contentEditable = "false";
  const disposals: (() => void)[] = [];
  let destroyed = false;
  let generation = 0;
  function render() {
    const current = ++generation;
    disposals.splice(0).forEach(dispose => dispose());
    const { githubRepo, resolveImage, convertLinks } = getOptions();
    const source = (!node.isInline ? projectedHtml(view, getPos(), { githubRepo, convertLinks }) : undefined) ?? node.attrs.value;
    dom.dataset.type = node.isInline ? "html" : "html-block";
    dom.dataset.value = node.attrs.value;
    const options = { githubRepo, embedded: true };
    const fragment = node.isInline ? sanitizeRenderedMarkdown(source, options) : renderMarkdown(source, options);
    dom.replaceChildren(fragment);
    if (!dom.firstChild && !node.isInline) dom.textContent = "嵌入的 HTML";
    if (resolveImage) for (const placeholder of dom.querySelectorAll<HTMLElement>("[data-image-url]")) {
      const { imageUrl, imageAlt } = placeholder.dataset;
      void resolveImage(imageUrl!).then(image => {
        if (destroyed || generation !== current) { image.dispose(); return; }
        disposals.push(image.dispose);
        const element = document.createElement("img");
        element.alt = imageAlt ?? "";
        element.draggable = false;
        element.src = image.src;
        placeholder.replaceWith(element);
      }, () => { /* Keep the image alternative if the resource is unavailable. */ });
    }
  }
  render();
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      render();
      return true;
    },
    stopEvent: event => event.target instanceof Element && Boolean(event.target.closest("summary")) && !event.target.closest("a[href]"),
    ignoreMutation: () => true,
    destroy() { destroyed = true; disposals.forEach(dispose => dispose()); },
  };
}

const safeImage = imageSchema.extendSchema(base => ctx => {
  const schema = base(ctx);
  return {
    ...schema,
    parseDOM: [
      ...schema.parseDOM!,
      {
        tag: "span[data-workbench-src]",
        getAttrs: dom => ({
          src: dom.getAttribute("data-workbench-src"),
          alt: dom.getAttribute("data-workbench-alt") ?? "",
          title: dom.getAttribute("title") ?? "",
        }),
      },
    ],
    toDOM: node => ["span", {
      "data-workbench-src": node.attrs.src,
      "data-workbench-alt": node.attrs.alt,
      title: node.attrs.title,
    }, node.attrs.alt || "图片"],
  };
});

function validMath(value: string, inline: boolean) {
  return Boolean(value.trim()) && !value.includes("$$") && (!inline || !/[\r\n]/.test(value));
}

function mathNode(name: string, inline: boolean) {
  return $nodeSchema(name, () => ({
    group: inline ? "inline" : "block",
    inline,
    atom: true,
    attrs: { value: { default: "" }, display: { default: !inline } },
    toDOM: node => [
      inline ? "span" : "div",
      { "data-math": name, "data-value": node.attrs.value, "data-display": String(node.attrs.display) },
      "公式",
    ],
    parseDOM: [{
      tag: '[data-math="' + name + '"]',
      getAttrs: dom => {
        const value = dom.getAttribute("data-value") ?? "";
        return validMath(value, inline)
          ? { value, display: !inline || dom.getAttribute("data-display") === "true" }
          : false;
      },
    }],
    parseMarkdown: {
      match: node => inline ? ["inlineMath", "inlineDisplayMath"].includes(node.type) : node.type === "math",
      runner: (state, node, type) => {
        state.addNode(type, { value: node.value, display: !inline || node.type === "inlineDisplayMath" });
      },
    },
    toMarkdown: {
      match: node => node.type.name === name,
      runner: (state, node) => {
        if (inline && node.attrs.display && validMath(node.attrs.value, true)) {
          state.addNode("html", undefined, "$$" + node.attrs.value + "$$");
        }
        else state.addNode(inline ? "inlineMath" : "math", undefined, node.attrs.value);
      },
    },
  }));
}

const mathInline = mathNode("math_inline", true);
const mathBlock = mathNode("math_block", false);
const math = $remark("workbenchMath", () => remarkMath);
const mathInlineInput = $inputRule(ctx => new InputRule(/(?<![\\$])\$([^$\r\n]+)\$$/, (state, match, start, end) => {
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const code = state.schema.marks.inlineCode;
  // Milkdown's custom input-rule runner does not check inline code marks.
  if (marks.some(mark => mark.type === code) || state.doc.rangeHasMark(start, end, code)) return null;
  const doc = ctx.get(parserCtx)(match[0]);
  const block = doc.childCount === 1 ? doc.firstChild : null;
  const formula = block?.type === state.schema.nodes.paragraph && block.childCount === 1 ? block.firstChild : null;
  if (formula?.type !== state.schema.nodes.math_inline) return null;
  return state.tr.replaceWith(start, end, formula.mark(marks));
}));
const blockquote = blockquoteSchema.extendSchema(base => ctx => {
  const original = base(ctx);
  return {
    ...original,
    attrs: { literalCallout: { default: false } },
    parseDOM: [{ tag: "blockquote", getAttrs: dom => ({ literalCallout: dom.hasAttribute("data-literal-callout") }) }],
    toDOM: node => ["blockquote", node.attrs.literalCallout ? { "data-literal-callout": "" } : {}, 0],
    parseMarkdown: {
      ...original.parseMarkdown,
      runner: (state, node, type) => state.openNode(type, { literalCallout: Boolean(node.literalCallout) }).next(node.children).closeNode(),
    },
    toMarkdown: {
      ...original.toMarkdown,
      runner: (state, node) => {
        const paragraph = node.firstChild;
        const first = paragraph?.type.name === "paragraph" && paragraph.firstChild;
        const callout = first && first.isText && !first.marks.length && readCalloutMarker(first.text!);
        if (!callout) return original.toMarkdown.runner(state, node);
        // Emit the marker literally so remark does not escape a callout as a shortcut reference link.
        state.openNode("blockquote").openNode("paragraph")
          .addNode("html", undefined, (node.attrs.literalCallout ? "\\" : "") + callout.marker)
          .next(paragraph!.content.cut(callout.marker.length)).closeNode()
          .next(node.content.cut(paragraph!.nodeSize)).closeNode();
      },
    },
  };
});
const footnoteReference = footnoteReferenceSchema.extendSchema(base => ctx => ({
  ...base(ctx), toDOM: node => ["sup", { "data-type": "footnote_reference", "data-label": node.attrs.label }, `[^${node.attrs.label}]`],
}));
const footnoteDefinition = footnoteDefinitionSchema.extendSchema(base => ctx => ({
  ...base(ctx), toDOM: node => ["dl", { "data-type": "footnote_definition", "data-label": node.attrs.label },
    ["dt", `[^${node.attrs.label}]:`], ["dd", 0]],
}));
const highlightSyntax = $remark("workbenchHighlight", () => remarkMarkHighlight);
const highlight = $markSchema("highlight", () => ({
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", 0],
  parseMarkdown: {
    match: node => node.type === "mark",
    runner: (state, node, type) => { state.openMark(type).next(node.children).closeMark(type); },
  },
  toMarkdown: {
    match: mark => mark.type.name === "highlight",
    runner: (state, mark) => { state.withMark(mark, "mark"); },
  },
}));
const highlightInput = $inputRule(ctx => markRule(/(?<![\\=])==(?![=\s])([^\r\n]+?)(?<![=\s])==$/, highlight.type(ctx)));

// Markdown tables have one slot per cell. Apply that contract to pasted or dropped HTML as well.
const tableCellRule = (tag: "td" | "th"): TagParseRule => ({
  tag, getAttrs: dom => ({ alignment: dom.style.textAlign || "left" }),
});
const markdownTableCell = tableCellSchema.extendSchema(base => ctx => ({ ...base(ctx), parseDOM: [tableCellRule("td")] }));
const markdownTableHeader = tableHeaderSchema.extendSchema(base => ctx => ({ ...base(ctx), parseDOM: [tableCellRule("th")] }));
const tableLineBreak = $nodeSchema("table_line_break", () => ({
  inline: true,
  group: "inline",
  selectable: false,
  leafText: () => "\n",
  parseDOM: [{ tag: "br", context: "table_cell/paragraph/|table_header/paragraph/", priority: 60 }],
  toDOM: () => ["br"],
  parseMarkdown: {
    match: node => node.type === "tableLineBreak",
    runner: (state, _node, type) => { state.addNode(type); },
  },
  toMarkdown: {
    match: node => node.type.name === "table_line_break",
    runner: state => { state.addNode("html", undefined, "<br>"); },
  },
}));

function formulaView(node: ProseNode, view: EditorView, getPos: () => number | undefined, parse: (source: string) => ProseNode): NodeView {
  const dom = document.createElement(node.isInline ? "span" : "div");
  dom.className = "rich-formula";
  dom.contentEditable = "false";
  const rendered = document.createElement("span");
  rendered.textContent = "公式";
  const trigger = node.isInline ? document.createElement("button") : editorIconButton("编辑公式源码", "source");
  trigger.type = "button";
  trigger.classList.add("rich-formula-trigger");
  trigger.setAttribute("aria-label", "编辑公式源码");
  const field = document.createElement(node.isInline ? "input" : "textarea");
  field.className = "rich-formula-source";
  field.setAttribute("aria-label", "公式 Markdown 源码");
  field.spellcheck = false;
  field.hidden = true;
  if (node.isInline) dom.append(rendered, trigger, field);
  else {
    const preview = document.createElement("div");
    preview.className = "rich-graphic-preview";
    trigger.classList.add("rich-graphic-edit");
    preview.onmousedown = event => { if (event.button === 0) event.preventDefault(); };
    preview.onclick = openSource;
    preview.append(rendered, trigger);
    dom.append(field, preview);
  }
  const error = document.createElement("span");
  error.className = "inline-error rich-formula-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  dom.append(error);
  let imageUrl: string | undefined;
  let destroyed = false;
  void import("../wechat-renderer/graphics")
    .then(({ graphic }) => graphic(node.attrs.display ? "math-block" : "math-inline", node.attrs.value))
    .then(({ blob }) => {
      if (destroyed) return;
      imageUrl = URL.createObjectURL(blob);
      const img = document.createElement("img");
      img.alt = node.attrs.value;
      img.src = imageUrl;
      rendered.replaceChildren(img);
    })
    .catch(() => { if (!destroyed) rendered.textContent = "公式无法显示"; });

  function openSource() {
    if (!view.editable || !field.hidden) return;
    const delimiter = node.attrs.display ? "$$" : "$";
    const fence = node.isInline ? delimiter : "$$\n";
    field.value = fence + node.attrs.value + (node.isInline ? delimiter : "\n$$");
    field.setCustomValidity("");
    field.removeAttribute("aria-invalid");
    error.hidden = true;
    rendered.hidden = node.isInline;
    trigger.hidden = node.isInline;
    trigger.tabIndex = -1;
    field.hidden = false;
    field.focus();
    field.setSelectionRange(fence.length, fence.length + node.attrs.value.length);
  }

  function finishSource(save: boolean, restoreFocus: boolean) {
    if (field.hidden) return;
    const source = field.value.trim();
    const complete = node.isInline || /^\$\$[ \t]*\n[\s\S]+\n\$\$$/.test(source);
    const doc = save && complete ? parse(source) : null;
    const block = doc?.childCount === 1 ? doc.firstChild : null;
    const expression = node.isInline && block?.type.name === "paragraph" && block.childCount === 1 ? block.firstChild : block;
    const formula = expression?.type === node.type && validMath(expression.attrs.value, node.isInline) ? expression : null;
    if (save && !formula && view.editable) {
      const message = node.isInline ? "请用 $ 包住行内公式" : "请在块公式前后各写一行 $$";
      field.setCustomValidity(message);
      field.setAttribute("aria-invalid", "true");
      error.textContent = message;
      error.hidden = false;
      if (restoreFocus) field.reportValidity();
      return;
    }
    field.hidden = true;
    error.hidden = true;
    field.removeAttribute("aria-invalid");
    rendered.hidden = false;
    trigger.hidden = false;
    trigger.tabIndex = 0;
    const pos = getPos();
    if (pos === undefined || !view.editable) return;
    const tr = view.state.tr;
    if (formula && !formula.sameMarkup(node)) tr.setNodeMarkup(pos, undefined, formula.attrs);
    if (restoreFocus) tr.setSelection(Selection.near(tr.doc.resolve(pos + node.nodeSize)));
    if (tr.docChanged || restoreFocus) view.dispatch(tr);
    if (restoreFocus) view.focus();
  }

  trigger.onfocus = trigger.onclick = openSource;
  field.oninput = () => { field.setCustomValidity(""); field.removeAttribute("aria-invalid"); error.hidden = true; };
  field.onblur = () => finishSource(true, false);
  field.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    const confirm = event.key === "Enter" && (node.isInline || event.ctrlKey || event.metaKey);
    if (!confirm && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finishSource(confirm, true);
  };
  return {
    dom,
    stopEvent: event => event.target === field || event.target === trigger,
    ignoreMutation: () => true,
    destroy() { destroyed = true; if (imageUrl) URL.revokeObjectURL(imageUrl); },
  };
}

export function richSchema(getOptions: () => HtmlOptions, failedImages: Set<() => void>) {
  return [
    math, highlightSyntax, highlight, highlightInput, richNodes, htmlInline, htmlBlock, githubDisclosure, safeImage, mathInline, mathBlock, mathInlineInput,
    markdownTableCell, markdownTableHeader, tableLineBreak, blockquote, footnoteReference, footnoteDefinition,
    $view(htmlInline.node, () => (node, view, getPos) => embeddedHtmlView(node, view, getPos, getOptions)),
    $view(htmlBlock.node, () => (node, view, getPos) => embeddedHtmlView(node, view, getPos, getOptions)),
    $view(githubDisclosure.node, () => (node, view, getPos) => {
      function render() {
        const options = getOptions();
        return disclosureDOM(projectedHtml(view, getPos(), options) ?? node.attrs.header, options.githubRepo);
      }
      const { dom, contentDOM } = render();
      return {
        dom, contentDOM,
        update(next) {
          if (next.type !== node.type || next.attrs.header !== node.attrs.header) return false;
          node = next;
          dom.replaceChild(render().dom.firstChild!, dom.firstChild!);
          return true;
        },
        stopEvent: event => event.target instanceof Element && Boolean(event.target.closest("summary")) && !event.target.closest("a[href]"),
        ignoreMutation: mutation => mutation.type === "attributes" && mutation.target === dom && mutation.attributeName === "open",
      };
    }),
    $view(imageSchema.node, ctx => (node, view, getPos) =>
      imageView(node, view, getPos, ctx.get(parserCtx), ctx.get(serializerCtx), getOptions, failedImages)),
    $view(mathInline.node, ctx => (node, view, getPos) => formulaView(node, view, getPos, ctx.get(parserCtx))),
    $view(mathBlock.node, ctx => (node, view, getPos) => formulaView(node, view, getPos, ctx.get(parserCtx))),
  ].flat(2);
}
