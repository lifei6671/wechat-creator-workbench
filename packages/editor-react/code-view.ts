import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, type EditorView, type NodeView } from "@milkdown/kit/prose/view";
import highlighter from "highlight.js/lib/common";
import { editorIconButton } from "./image-view";
import powershell from "highlight.js/lib/languages/powershell";

highlighter.registerLanguage("powershell", powershell);

type CodeToken = { from: number; to: number; className: string };
const codeTokens = new WeakMap<ProseNode, CodeToken[]>();

function tokenize(node: ProseNode): CodeToken[] {
  const language = node.attrs.language.toLowerCase();
  if (!highlighter.getLanguage(language) || !node.textContent) return [];
  const markup = document.createElement("template");
  markup.innerHTML = highlighter.highlight(node.textContent, { language, ignoreIllegals: true }).value;
  const tokens: CodeToken[] = [];
  let pos = 0;
  function visit(parent: ParentNode) {
    for (const child of parent.childNodes) {
      if (!(child instanceof HTMLElement)) {
        pos += child.textContent!.length;
        continue;
      }
      const from = pos;
      visit(child);
      if (from < pos) tokens.push({ from, to: pos, className: child.className });
    }
  }
  visit(markup.content);
  return tokens;
}

export function codeHighlight(node: ProseNode, start: number) {
  let tokens = codeTokens.get(node);
  if (!tokens) {
    tokens = tokenize(node);
    codeTokens.set(node, tokens);
  }
  return tokens.map(token => Decoration.inline(start + token.from, start + token.to, { class: token.className }));
}

export function codeView(initial: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView {
  let node = initial;
  const dom = document.createElement("div");
  dom.className = "rich-code-block";
  const pre = document.createElement("pre");
  const contentDOM = document.createElement("code");
  const open = document.createElement("span");
  const close = document.createElement("span");
  for (const fence of [open, close]) {
    fence.contentEditable = "false";
    fence.className = "rich-code-fence";
    fence.setAttribute("aria-hidden", "true");
  }
  const label = document.createElement("button");
  label.type = "button";
  label.className = "rich-code-language";
  label.contentEditable = "false";
  const passiveLabel = document.createElement("span");
  passiveLabel.className = "rich-code-language rich-code-language-passive";
  passiveLabel.contentEditable = "false";
  const input = document.createElement("input");
  input.setAttribute("aria-label", "代码块语言");
  input.placeholder = "语言";
  input.spellcheck = false;
  input.autocomplete = "off";
  open.classList.add("rich-code-fence-open");
  open.removeAttribute("aria-hidden");
  const openTicks = document.createTextNode("");
  open.append(openTicks, input);
  const header = document.createElement("div");
  header.className = "rich-code-header";
  header.contentEditable = "false";
  header.append(label, passiveLabel);
  pre.append(header, open, contentDOM, close);
  const diagram = document.createElement("div");
  diagram.className = "rich-mermaid rich-graphic-preview";
  diagram.contentEditable = "false";
  const diagramContent = document.createElement("span");
  const editDiagram = editorIconButton("编辑 Mermaid 源码", "source");
  editDiagram.classList.add("rich-graphic-edit");
  diagram.append(diagramContent, editDiagram);
  dom.append(pre, diagram);
  let diagramUrl: string | undefined;
  let source: string | null | undefined;
  let drawing: number | undefined;
  let diagramVersion = 0;
  let editing = false;

  function focusCode() {
    const pos = getPos();
    if (pos === undefined || !view.editable) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
    view.focus();
  }
  diagram.onclick = focusCode;
  diagram.onmousedown = event => { if (event.button === 0) event.preventDefault(); };
  label.onclick = () => {
    if (!view.editable) return;
    dom.classList.add("rich-code-language-editing");
    focusCode();
    input.focus();
    input.select();
  };

  function clearDiagram() {
    if (diagramUrl) URL.revokeObjectURL(diagramUrl);
    diagramUrl = undefined;
  }

  function renderDiagram(next: string | null) {
    if (next === source) return;
    source = next;
    const ticket = ++diagramVersion;
    window.clearTimeout(drawing);
    diagram.hidden = !next;
    diagram.removeAttribute("data-failed");
    if (!next) { clearDiagram(); return; }
    if (!diagramUrl) diagramContent.textContent = "正在渲染 Mermaid…";
    drawing = window.setTimeout(() => {
      void import("../wechat-renderer/graphics").then(({ graphic }) => graphic("mermaid", next)).then(({ blob }) => {
        if (ticket !== diagramVersion) return;
        drawing = undefined;
        clearDiagram();
        diagramUrl = URL.createObjectURL(blob);
        const image = document.createElement("img");
        image.alt = "Mermaid 图表";
        image.src = diagramUrl;
        diagramContent.replaceChildren(image);
      }).catch(() => {
        if (ticket !== diagramVersion) return;
        drawing = undefined;
        clearDiagram();
        diagram.dataset.failed = "";
        diagramContent.textContent = "Mermaid 图表无法显示";
      });
    }, 180);
  }

  function render() {
    const language = node.attrs.language;
    dom.dataset.language = language;
    let length = 3;
    for (const ticks of node.textContent.matchAll(/`+/g)) length = Math.max(length, ticks[0].length + 1);
    const fence = "`".repeat(length);
    pre.dataset.language = language;
    open.dataset.markdown = fence;
    close.dataset.markdown = fence;
    openTicks.data = fence;
    close.textContent = fence;
    label.textContent = language || "纯文本";
    passiveLabel.textContent = label.textContent;
    label.setAttribute("aria-label", `修改代码块语言（${label.textContent}）`);
    input.value = language;
    if (language.toLowerCase() !== "mermaid") renderDiagram(null);
    else if (!editing) renderDiagram(node.textContent);
  }
  render();

  input.oninput = () => input.setCustomValidity("");
  input.onpointerdown = input.onfocus = () => dom.classList.add("rich-code-language-editing");
  input.onblur = () => {
    dom.classList.remove("rich-code-language-editing");
    const language = input.value.trim();
    input.setCustomValidity("");
    const pos = getPos();
    if (pos !== undefined && view.editable && language !== node.attrs.language && !/[\s`]/.test(language)) {
      view.dispatch(view.state.tr.setNodeAttribute(pos, "language", language));
    } else input.value = node.attrs.language;
  };
  input.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.value = node.attrs.language;
      view.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (/[\s`]/.test(input.value.trim())) {
        input.setCustomValidity("请输入一个语言标识，例如 javascript");
        input.reportValidity();
      } else view.focus();
    }
  };

  return {
    dom, contentDOM,
    update(next, decorations) {
      if (node.type !== next.type) return false;
      const openSource = decorations.some(decoration => decoration.spec.codeSource === true);
      if (openSource && !editing && drawing !== undefined) {
        window.clearTimeout(drawing);
        drawing = undefined;
        diagramVersion++;
        source = undefined;
      }
      const refresh = editing !== openSource || !node.eq(next);
      editing = openSource;
      node = next;
      if (refresh) render();
      return true;
    },
    stopEvent: event => event.target === input || event.target === label || (event.target instanceof Node && diagram.contains(event.target)),
    ignoreMutation: mutation => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
    destroy() { diagramVersion++; window.clearTimeout(drawing); clearDiagram(); },
  };
}
