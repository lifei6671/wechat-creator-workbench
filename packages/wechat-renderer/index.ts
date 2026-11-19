import juice from "juice";
import dollarmath from "markdown-it-dollarmath";
import footnote from "markdown-it-footnote";
import type { PluginSimple } from "markdown-it";
import { createMarkdownParser, sanitizeRenderedMarkdown } from "../markdown-core";
import { theme as defaultTheme } from "./themes/wechat-default";
import { theme as elegant } from "./themes/wechat-elegant";
import { theme as tech } from "./themes/wechat-tech";
import type { GraphicKind } from "./graphics";

export const wechatThemes = [
  { id: "plainly-default", label: defaultTheme.name, styles: defaultTheme.styles },
  { id: "plainly-elegant", label: elegant.name, styles: elegant.styles },
  { id: "plainly-tech", label: tech.name, styles: tech.styles },
] as const;

export function wechatThemeId(id?: string | null) {
  return (wechatThemes.find(theme => theme.id === id) ?? wechatThemes[0]).id;
}

export type Output = "preview" | "clipboard" | "html";
export interface RenderInput { markdown: string; revision: number; themeId?: string | null; githubRepo?: string; output: Output }
export interface ImageResult { src: string | null; width: number; height: number }
export interface SourceFragment { kind: GraphicKind; source: string; line: number }
export interface RenderServices {
  signal?: AbortSignal;
  sources(markdown: string): Promise<SourceFragment[]>;
  image(url: string): Promise<ImageResult>;
  derive(kind: GraphicKind, source: string, bytes: Uint8Array): Promise<string>;
}
export interface RenderedWechat {
  revision: number;
  themeId: string;
  html: string;
  text: string;
  images: { url: string; alt: string }[];
  warnings: string[];
  dispose(): void;
}

export function parseWechat(markdown: string, sources: SourceFragment[], githubRepo?: string) {
  const parser = createMarkdownParser();
  const fragments: Omit<SourceFragment, "line">[] = [];
  const markerPrefix = `${crypto.randomUUID()}-`;
  const mark = (kind: GraphicKind, source: string) => {
    const index = fragments.push({ kind, source }) - 1;
    return `<span data-wechat-fragment="${markerPrefix}${index}"></span>`;
  };
  parser.use(footnote as unknown as PluginSimple);
  parser.renderer.rules.footnote_block_open = () => '<section class="footnotes">\n<h2 class="plainly-reference-title">参考资料</h2>\n<ol class="footnotes-list">\n';
  const openFootnote = parser.renderer.rules.footnote_open!;
  parser.renderer.rules.footnote_open = (tokens, index, options, env, self) => {
    const caption = self.rules.footnote_caption!(tokens, index, options, env, self);
    return `${openFootnote(tokens, index, options, env, self)}<span class="plainly-reference-number">${caption}</span>`;
  };
  parser.use(dollarmath, {
    allow_labels: false, allow_space: false, allow_digits: true, double_inline: true,
  });
  for (const [rule, kind, delimiter] of [
    ["math_inline", "math-inline", "$"], ["math_inline_double", "math-block", "$$"],
  ] as const) {
    const allowed = new Set(sources.filter(fragment => fragment.kind === kind).map(fragment => fragment.source));
    parser.renderer.rules[rule] = (tokens, index) => {
      const content = tokens[index].content;
      const source = content.trim();
      return allowed.has(source) ? mark(kind, source) : parser.utils.escapeHtml(`${delimiter}${content}${delimiter}`);
    };
  }
  const blockAt = (kind: GraphicKind, line: number | undefined) => sources.find(source => source.kind === kind && source.line === line);
  parser.renderer.rules.math_block = (tokens, index) => {
    const token = tokens[index];
    const fragment = blockAt("math-block", token.map?.[0]);
    return fragment ? mark(fragment.kind, fragment.source) : `<p>${parser.utils.escapeHtml(`$$${token.content}$$`)}</p>`;
  };
  const fence = parser.renderer.rules.fence!;
  parser.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const fragment = token.info.trim().split(/\s+/)[0] === "mermaid" ? blockAt("mermaid", token.map?.[0]) : undefined;
    return fragment ? mark(fragment.kind, fragment.source) : fence(tokens, index, options, env, self);
  };
  return { body: sanitizeRenderedMarkdown(parser.render(markdown), { githubRepo }), fragments, markerPrefix };
}

export async function renderWechat(input: RenderInput, services: RenderServices): Promise<RenderedWechat> {
  const theme = wechatThemes.find(theme => theme.id === input.themeId) ?? wechatThemes[0];
  const sources = /\$|mermaid/.test(input.markdown) ? await services.sources(input.markdown) : [];
  services.signal?.throwIfAborted();
  const { body, fragments, markerPrefix } = parseWechat(input.markdown, sources, input.githubRepo);
  const article = document.createElement("section");
  article.className = "plainly-article";
  article.append(body);
  const images: RenderedWechat["images"] = [];
  const warnings: string[] = [];
  const blobUrls: string[] = [];
  const dispose = () => blobUrls.splice(0).forEach(url => URL.revokeObjectURL(url));

  function insertImage(node: Element, image: ImageResult, alt: string, inline = false) {
    if (!image.src) {
      const label = document.createElement("span");
      label.textContent = `[图片 ${images.length}${alt ? `：${alt}` : ""}]`;
      node.replaceWith(label);
      return;
    }
    const img = document.createElement("img");
    img.src = image.src;
    img.alt = alt;
    img.width = image.width;
    img.height = image.height;
    if (inline) img.className = "plainly-inline-math";
    node.replaceWith(img);
  }

  try {
    for (const node of article.querySelectorAll<HTMLElement>(`[data-wechat-fragment^="${markerPrefix}"],[data-image-alt]`)) {
      services.signal?.throwIfAborted();
      try {
        if (node.dataset.wechatFragment !== undefined) {
          const fragment = fragments[Number(node.dataset.wechatFragment.slice(markerPrefix.length))];
          const alt = fragment.kind === "mermaid" ? "Mermaid 图表" : fragment.source;
          const { graphic, graphicPng } = await import("./graphics");
          const { blob, width, height } = await graphic(fragment.kind, fragment.source);
          if (input.output === "preview") {
            const src = URL.createObjectURL(blob);
            blobUrls.push(src);
            insertImage(node, { src, width, height }, alt, fragment.kind === "math-inline");
          } else {
            const url = `asset://${await services.derive(fragment.kind, fragment.source, await graphicPng(blob, width, height))}`;
            images.push({ url, alt });
            const resolved = await services.image(url);
            insertImage(node, { ...resolved, width, height }, alt, fragment.kind === "math-inline");
          }
        } else {
          const { imageUrl: url, imageAlt: alt = "" } = node.dataset;
          if (!url) throw new Error("图片地址无效");
          images.push({ url, alt });
          insertImage(node, await services.image(url), alt);
        }
      } catch (error) {
        if (input.output !== "preview") throw error;
        services.signal?.throwIfAborted();
        const message = typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
        warnings.push(message);
        node.textContent = node.dataset.imageAlt !== undefined
          ? (node.dataset.imageAlt ? `图片缺失：${node.dataset.imageAlt}` : "图片缺失")
          : message;
        node.removeAttribute("data-wechat-fragment");
      }
    }

    const code = Array.from(article.querySelectorAll<HTMLElement>("pre > code"));
    services.signal?.throwIfAborted();
    if (code.some(node => Array.from(node.classList).some(cl => cl.startsWith("language-")))) {
      const { default: highlighter } = await import("highlight.js/lib/common");
      for (const node of code) {
        const language = Array.from(node.classList).find(cl => cl.startsWith("language-"))?.slice(9);
        if (language && highlighter.getLanguage(language)) {
          node.innerHTML = highlighter.highlight(node.textContent ?? "", { language, ignoreIllegals: true }).value;
        }
      }
    }
    const styleRules = Object.entries(theme.styles).map(([selector, styles]) =>
      `[class="plainly-article"]${selector === "container" ? "" : ` ${selector}`}{${styles}}`);
    const css = styleRules.join("\n")
      + ".plainly-article mark{background-color:#fff7c2;color:inherit;}"
      + ".plainly-article blockquote.workbench-callout{padding:8px 12px;border-left-width:0.5px;font-style:normal;}"
      + ".plainly-article blockquote.workbench-callout-info{background-color:#e6f4fe !important;border-left-color:#8ec8f6;}"
      + ".plainly-article blockquote.workbench-callout-warning{background-color:#fff7c2 !important;border-left-color:#e9c162;}"
      + ".plainly-article .workbench-callout-info .workbench-callout-title{color:#0d74ce;}.plainly-article .workbench-callout-warning .workbench-callout-title{color:#ab6400;}"
      + ".plainly-article .plainly-inline-math{display:inline-block;margin:0 2px;vertical-align:middle;width:auto;max-width:100%;border-radius:0;}"
      + ".plainly-article .plainly-reference-title{margin:28px 0 10px;padding:0;border:0;}"
      + ".plainly-article .footnotes-list{list-style:none;margin:0;padding:0;}"
      + ".plainly-article .footnote-item{list-style:none;margin:4px 0;overflow-wrap:anywhere;}"
      + ".plainly-article .footnote-item>p:first-of-type{display:inline;margin:0 !important;}"
      + ".plainly-article .plainly-reference-number{display:inline-block;min-width:2.5em;color:#60646c;}"
      + ".plainly-article .footnotes-list a,.plainly-article .footnote-ref a{color:#60646c !important;border-bottom:0;text-decoration:none;}"
      + ".plainly-article table{width:100%;border-collapse:collapse;}.plainly-article .hljs-keyword,.plainly-article .hljs-title{color:#7047b8;}"
      + ".plainly-article .hljs-string{color:#367848;}.plainly-article .hljs-number{color:#a04e24;}.plainly-article .hljs-comment{color:#626a70;}";
    const template = document.createElement("template");
    template.innerHTML = juice.inlineContent(article.outerHTML, css, { removeStyleTags: true, preserveImportant: true });
    // Plainly's WeChat converter supplies an explicit width attribute for full-width tables.
    for (const table of template.content.querySelectorAll("table")) {
      if (table.style.width === "100%" && !table.hasAttribute("width")) table.setAttribute("width", "100%");
    }
    for (const node of template.content.querySelectorAll("*")) {
      node.removeAttribute("class");
      for (const attribute of Array.from(node.attributes)) {
        if (attribute.name.startsWith("data-") && (input.output !== "preview" || attribute.name !== "data-line")) {
          node.removeAttribute(attribute.name);
        }
      }
    }
    const plain = article.cloneNode(true) as Element;
    for (const img of plain.querySelectorAll("img")) {
      img.replaceWith(document.createTextNode(img.alt || "[图片]"));
    }
    const text = Array.from(plain.children, child => child.textContent?.trim() ?? "").filter(Boolean).join("\n\n");
    return { revision: input.revision, themeId: theme.id, html: template.innerHTML, text, images, warnings, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
