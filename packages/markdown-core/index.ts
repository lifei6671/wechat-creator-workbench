import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";
import createDOMPurify from "dompurify";
import { renderCallouts } from "./callouts";

export function createMarkdownParser() {
  const parser = new MarkdownIt({ html: true }).use(mark).use(renderCallouts);
  parser.renderer.rules.heading_open = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    if (token.map) token.attrSet("data-line", String(token.map[0] + 1));
    return renderer.renderToken(tokens, index, options);
  };
  return parser;
}
const markdown = createMarkdownParser();
const DOMPurify = createDOMPurify(window);
const tags = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  "strong", "b", "em", "i", "s", "del", "mark", "code", "pre", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "a", "div", "span", "section", "sub", "sup", "img", "details", "summary",
];
const contentAttrs = ["href", "src", "alt", "title", "start", "open", "colspan", "rowspan"];
const rendererAttrs = ["id", "data-line", "data-wechat-fragment", "class"];
interface RenderOptions { githubRepo?: string; embedded?: boolean }

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

export function sanitizeRenderedMarkdown(html: string, { githubRepo, embedded }: RenderOptions = {}): DocumentFragment {
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
    ALLOWED_TAGS: tags,
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
