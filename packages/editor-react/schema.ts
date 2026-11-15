import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { blockContainerTypes, commonmark, htmlSchema, imageSchema, remarkHtmlTransformer } from "@milkdown/kit/preset/commonmark";
import { tableCellSchema, tableHeaderSchema } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode, TagParseRule } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import remarkMath from "remark-math";
import { imageView, type EditorImages } from "./image-view";

export const hrefPattern = /^(?:https?:\/\/|mailto:|#)/i;
export const richCommonmark = commonmark.filter(plugin => !remarkHtmlTransformer.includes(plugin));

type Tree = {
  type: string;
  value?: unknown;
  children?: Tree[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

// mdast uses the same node for both inline and block HTML. ProseMirror needs
// them in different groups to round-trip HTML inside paragraphs and containers.
const richNodes = $remark("workbenchRichNodes", ctx =>
  () => (tree: Tree, file: { value: unknown }) => {
    const source = String(file.value);
    const containers = ctx.get(blockContainerTypes.key);
    const visit = (parent: Tree) => {
      for (const child of parent.children ?? []) {
        if (parent.type === "tableCell" && child.type === "html" && /^<br\s*\/?>$/i.test(String(child.value))) {
          child.type = "tableLineBreak";
        } else if (child.type === "html" && containers.includes(parent.type)) {
          child.type = "htmlBlock";
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (child.type === "inlineMath" && start !== undefined && end !== undefined) {
          const expression = source.slice(start, end);
          if (/^\$+\s|\s\$+$/.test(expression)) {
            child.type = "text";
            child.value = expression;
          } else if (expression.startsWith("$$")) {
            child.type = "inlineDisplayMath";
          }
        }
        visit(child);
      }
    };
    visit(tree);
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

function formulaView(node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement(node.isInline ? "span" : "div");
  dom.className = "rich-formula";
  dom.contentEditable = "false";
  const rendered = document.createElement("span");
  rendered.textContent = "公式";
  dom.append(rendered);
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

  dom.ondblclick = () => {
    if (!view.editable || dom.querySelector("input")) return;
    const input = document.createElement("input");
    input.setAttribute("aria-label", "公式");
    input.value = node.attrs.value;
    rendered.hidden = true;
    dom.append(input);
    input.focus();
    input.select();
    input.oninput = () => input.setCustomValidity("");
    input.onblur = () => { input.remove(); rendered.hidden = false; };
    input.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { view.focus(); return; }
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = input.value.trim();
      if (!validMath(value, node.isInline)) {
        input.setCustomValidity("请输入公式内容，不含美元符号分隔线");
        input.reportValidity();
        return;
      }
      const pos = getPos();
      if (pos !== undefined && view.editable) {
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value }));
      }
      view.focus();
    };
  };
  return {
    dom,
    stopEvent: event => event.target instanceof HTMLInputElement,
    ignoreMutation: () => true,
    destroy() { destroyed = true; if (imageUrl) URL.revokeObjectURL(imageUrl); },
  };
}

export function richSchema(getOptions: () => EditorImages, failedImages: Set<() => void>) {
  return [
    math, richNodes, htmlInline, htmlBlock, safeImage, mathInline, mathBlock, markdownTableCell, markdownTableHeader, tableLineBreak,
    $view(imageSchema.node, ctx => (node, view, getPos) =>
      imageView(node, view, getPos, ctx.get(parserCtx), ctx.get(serializerCtx), getOptions, failedImages)),
    $view(mathInline.node, () => formulaView),
    $view(mathBlock.node, () => formulaView),
  ].flat(2);
}
