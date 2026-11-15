import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

export function createMarkdownParser() {
  const parser = new MarkdownIt({ html: true });
  parser.renderer.rules.heading_open = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    if (token.map) token.attrSet("data-line", String(token.map[0] + 1));
    return renderer.renderToken(tokens, index, options);
  };
  return parser;
}
const markdown = createMarkdownParser();
const tags = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  "strong", "b", "em", "i", "s", "del", "code", "pre", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "a", "div", "span", "section", "sub", "sup", "img",
];

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

export function renderMarkdown(markdownText: string): DocumentFragment {
  return sanitizeRenderedMarkdown(markdown.render(markdownText));
}

export function sanitizeRenderedMarkdown(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ["href", "src", "alt", "title", "start", "id", "data-line", "data-wechat-fragment", "class"],
    ADD_URI_SAFE_ATTR: ["data-line", "start", "id", "data-wechat-fragment", "class"],
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
