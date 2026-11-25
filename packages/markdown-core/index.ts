import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";
import { tasklist } from "@mdit/plugin-tasklist";
import createDOMPurify from "dompurify";
import { renderCallouts } from "./callouts";

export function createMarkdownParser() {
  const parser = new MarkdownIt({ html: true }).use(mark).use(renderCallouts).use(tasklist, { label: false });
  parser.core.ruler.before("task_list", "workbench_task_spacing", state => {
    state.tokens.forEach((token, index, tokens) => {
      if (token.type === "inline" && tokens[index - 1]?.type === "paragraph_open" && tokens[index - 2]?.type === "list_item_open") {
        token.content = token.content.replace(/^(\[[ xX]\])\t/, "$1 ");
      }
    });
  });
  parser.renderer.rules.checkbox_input = (tokens, index) => `<span class="workbench-task-marker">${tokens[index].attrGet("checked") ? "☑" : "☐"}</span>`;
  parser.renderer.rules.heading_open = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    if (token.map) token.attrSet("data-line", String(token.map[0] + 1));
    return renderer.renderToken(tokens, index, options);
  };
  return parser;
}
const markdown = createMarkdownParser();

export function isWechatArticleLink(href: string) {
  try {
    const destination = new URL(href);
    return /^(?:https?:)$/.test(destination.protocol) && destination.host === "mp.weixin.qq.com"
      && !destination.username && !destination.password;
  } catch { return false; }
}

const DOMPurify = createDOMPurify(window);
const tags = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  "strong", "b", "em", "i", "s", "del", "mark", "code", "pre", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "a", "div", "span", "section", "sub", "sup", "img", "details", "summary",
];
const contentAttrs = ["href", "src", "alt", "title", "start", "open", "colspan", "rowspan"];
const rendererAttrs = ["id", "data-line", "data-wechat-fragment", "class"];
interface RenderOptions { githubRepo?: string; embedded?: boolean; preserveFigures?: boolean }

export const footnoteId = /^fn(?:ref)?\d+(?::\d+)?$/;

DOMPurify.addHook("uponSanitizeAttribute", (_node, attribute) => {
  if (attribute.attrName === "href" && !/^(?:https?:\/\/|mailto:|#)/i.test(attribute.attrValue)) {
    attribute.keepAttr = false;
  }
  if (attribute.attrName === "src" && !/^(?:https?:\/\/|asset:\/\/)/i.test(attribute.attrValue)) {
    attribute.keepAttr = false;
  }
  if (attribute.attrName === "id" && !footnoteId.test(attribute.attrValue)) attribute.keepAttr = false;
});

export function renderMarkdown(markdownText: string, options?: RenderOptions): DocumentFragment {
  return sanitizeRenderedMarkdown(markdown.render(markdownText), options);
}

export function sanitizeRenderedMarkdown(html: string, { githubRepo, embedded, preserveFigures }: RenderOptions = {}): DocumentFragment {
  // Older GitHub imports saved relative HTML URLs without the README path.
  const repo = githubRepo?.match(/^https:\/\/github\.com\/(?!\.\.?\/)([\w.-]+\/(?!\.\.?(?:\/|$))[\w.-]+)\/?$/i)?.[1];
  if (repo) {
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const node of template.content.querySelectorAll("img[src], a[href]")) {
      const image = node.tagName === "IMG";
      const name = image ? "src" : "href";
      const value = node.getAttribute(name)!.trim();
      if (!value || /^(?:[a-z][\w+.-]*:|#)/i.test(value)) continue;
      const base = image ? `https://raw.githubusercontent.com/${repo}/HEAD/` : `https://github.com/${repo}/blob/HEAD/`;
      const path = value.startsWith("//") ? value : value.replace(/^\//, "");
      if (!URL.canParse(path, base)) continue;
      const url = new URL(path, base);
      if (value.startsWith("//") || url.href.startsWith(base)) node.setAttribute(name, url.href);
    }
    html = template.innerHTML;
  }
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: embedded || preserveFigures ? [...tags, "figure", "figcaption"] : tags,
    ALLOWED_ATTR: embedded ? contentAttrs : [...contentAttrs, ...rendererAttrs],
    ADD_URI_SAFE_ATTR: ["start", "open", "colspan", "rowspan", ...rendererAttrs],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|#|asset:\/\/)/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const img of fragment.querySelectorAll("img")) {
    const placeholder = document.createElement("span");
    placeholder.className = "preview-image";
    const url = img.getAttribute("src");
    if (url) placeholder.dataset.imageUrl = url;
    placeholder.dataset.imageAlt = img.alt;
    placeholder.textContent = img.alt ? `图片：${img.alt}` : "图片";
    img.replaceWith(placeholder);
  }
  return fragment;
}
