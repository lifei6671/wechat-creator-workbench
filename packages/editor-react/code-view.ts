import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Decoration, type EditorView, type NodeView } from "@milkdown/kit/prose/view";
import highlighter from "highlight.js/lib/common";
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
  const label = document.createElement("span");
  label.className = "rich-code-language";
  label.contentEditable = "false";
  const input = document.createElement("input");
  input.setAttribute("aria-label", "代码块语言");
  input.placeholder = "语言";
  input.spellcheck = false;
  input.autocomplete = "off";
  open.classList.add("rich-code-fence-open");
  open.removeAttribute("aria-hidden");
  open.append(input);
  pre.append(label, open, contentDOM, close);
  dom.append(pre);

  function render() {
    const language = node.attrs.language;
    let length = 3;
    for (const ticks of node.textContent.matchAll(/`+/g)) length = Math.max(length, ticks[0].length + 1);
    const fence = "`".repeat(length);
    pre.dataset.language = language;
    open.dataset.markdown = fence;
    close.dataset.markdown = fence;
    label.textContent = language || "纯文本";
    input.value = language;
  }
  render();

  input.oninput = () => input.setCustomValidity("");
  input.onblur = () => {
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
    update(next) {
      if (node.type !== next.type) return false;
      if (!node.eq(next)) { node = next; render(); }
      return true;
    },
    stopEvent: event => event.target === input,
    ignoreMutation: mutation => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
  };
}
