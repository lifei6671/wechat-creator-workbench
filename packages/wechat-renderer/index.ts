import juice from "juice";
import dollarmath from "markdown-it-dollarmath";
import footnote from "markdown-it-footnote";
import type { PluginSimple } from "markdown-it";
import { createMarkdownParser, isWechatArticleLink, sanitizeRenderedMarkdown } from "../markdown-core";
import { theme as defaultTheme } from "./themes/wechat-default";
import { theme as elegant } from "./themes/wechat-elegant";
import { theme as tech } from "./themes/wechat-tech";
import { applyGzhDesign, gzhDesignThemes, wrapGzhLeaves } from "./themes/gzh-design";
import type { GraphicKind } from "./graphics";

export const wechatThemes = [
  { id: "plainly-default", label: defaultTheme.name, styles: defaultTheme.styles },
  { id: "plainly-elegant", label: elegant.name, styles: elegant.styles },
  { id: "plainly-tech", label: tech.name, styles: tech.styles },
  ...gzhDesignThemes,
] as const;

export function wechatThemeId(id?: string | null) {
  return (wechatThemes.find(theme => theme.id === id) ?? wechatThemes[0]).id;
}

function wechatThemeCss(theme: typeof wechatThemes[number]) {
  const calloutPadding = theme.id === "plainly-tech" ? "4px 12px" : "8px 12px";
  const styleRules = Object.entries(theme.styles).map(([selector, styles]) =>
    `${selector.split(",").map(part => `[class="plainly-article"]${part.trim() === "container" ? "" : ` ${part.trim()}`}`).join(",")}{${styles}}`);
  return styleRules.join("\n")
    + ".plainly-article mark{background-color:#fff7c2;color:inherit;}"
    + `.plainly-article blockquote.workbench-callout{padding:${calloutPadding};border:0;border-left:0.5px solid;font-style:normal;text-align:start;}`
    + ".plainly-article .workbench-callout .workbench-callout-title{padding:0;background:transparent !important;border-radius:0;font-weight:600;}.plainly-article .workbench-callout .workbench-callout-title strong{color:inherit !important;padding:0;background:transparent !important;}"
    + ".plainly-article .workbench-callout-tone-info{background-color:#e6f4fe !important;border-left-color:#8ec8f6;}.plainly-article .workbench-callout-tone-info .workbench-callout-title{color:#0d74ce !important;}"
    + ".plainly-article .workbench-callout-tone-warning{background-color:#fff7c2 !important;border-left-color:#e9c162;}.plainly-article .workbench-callout-tone-warning .workbench-callout-title{color:#ab6400 !important;}"
    + ".plainly-article .workbench-callout-tone-success{background-color:#e6f6eb !important;border-left-color:#adddc0;}.plainly-article .workbench-callout-tone-success .workbench-callout-title{color:#218358 !important;}"
    + ".plainly-article .workbench-callout-tone-danger{background-color:#feebec !important;border-left-color:#f4a9aa;}.plainly-article .workbench-callout-tone-danger .workbench-callout-title{color:#ce2c31 !important;}"
    + ".plainly-article .plainly-inline-math{display:inline-block;margin:0 2px;vertical-align:middle;width:auto;max-width:100%;border-radius:0;}"
    + ".plainly-article .plainly-reference-title{margin:28px 0 10px;padding:0;border:0;}"
    + ".plainly-article li.task-list-item{list-style:none;}.plainly-article .workbench-task-marker{display:inline-block;min-width:1em;margin-right:4px;}"
    + ".plainly-article .footnotes-list{list-style:none;margin:0;padding:0;}"
    + ".plainly-article .footnote-item{list-style:none;margin:4px 0;overflow-wrap:anywhere;}"
    + ".plainly-article .footnote-item>p:first-of-type{display:inline;margin:0 !important;}"
    + ".plainly-article .plainly-reference-number{display:inline-block;min-width:2.5em;color:#60646c;}"
    + ".plainly-article .footnotes-list a,.plainly-article .footnote-ref a{color:#60646c !important;border-bottom:0;text-decoration:none;}"
    + ".plainly-article table{width:100%;border-collapse:collapse;}.plainly-article .hljs-keyword,.plainly-article .hljs-title{color:#7047b8;}"
    + ".plainly-article .hljs-string{color:#367848;}.plainly-article .hljs-number{color:#a04e24;}.plainly-article .hljs-comment{color:#626a70;}";
}

const editorStyles = new Map<string, Readonly<Record<string, string>>>();
export function wechatEditorStyles(id?: string | null) {
  const theme = wechatThemes.find(theme => theme.id === id) ?? wechatThemes[0];
  const cached = editorStyles.get(theme.id);
  if (cached) return cached;
  const template = document.createElement("template");
  const headings = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const article = document.createElement("section");
  article.className = "plainly-article";
  article.innerHTML = `<p>正文</p>${headings.map(name => `<${name}>标题</${name}>`).join("")}<blockquote><p>引用</p><p>引用末段</p></blockquote><blockquote class="workbench-callout workbench-callout-tone-info"><p>提示</p><p>提示末段</p></blockquote><ul><li>紧密列表</li><li><p>松散列表</p></li></ul><ol><li>有序列表</li></ol><table><thead><tr><th>表头</th></tr></thead><tbody><tr><td>单元格</td></tr></tbody></table><pre><code class="language-javascript">const value = 1;</code></pre><section><h2 class="plainly-reference-title">参考资料</h2></section>`;
  if ("layout" in theme && theme.layout === "gzh-design") applyGzhDesign(article);
  template.innerHTML = juice.inlineContent(article.outerHTML, wechatThemeCss(theme), { preserveImportant: true });
  const variables: Record<string, string> = {};
  function box(name: string, style: CSSStyleDeclaration) {
    for (const property of ["margin", "padding"] as const) {
      variables[`--article-${name}-${property}-block`] = `${style.getPropertyValue(`${property}-top`) || "0px"} ${style.getPropertyValue(`${property}-bottom`) || "0px"}`;
      variables[`--article-${name}-${property}-inline`] = `${style.getPropertyValue(`${property}-left`) || "0px"} ${style.getPropertyValue(`${property}-right`) || "0px"}`;
    }
    for (const property of ["width", "style"] as const) {
      variables[`--article-${name}-border-${property}`] = ["top", "right", "bottom", "left"]
        .map(side => style.getPropertyValue(`border-${side}-${property}`) || (property === "width" ? "0px" : "none")).join(" ");
    }
    const background = style.backgroundColor;
    variables[`--article-${name}-background`] = !background || background === "initial" || background === "transparent" || background === "rgba(0, 0, 0, 0)"
      ? "transparent" : "var(--article-quote)";
    variables[`--article-${name}-text-align`] = style.textAlign || "inherit";
    variables[`--article-${name}-font-style`] = style.fontStyle || "inherit";
    variables[`--article-${name}-border-radius`] = style.borderRadius || "0px";
  }
  for (const name of [...headings, "p", "blockquote", "ul", "ol", "li", "table", "th", "td"]) {
    box(name, template.content.querySelector<HTMLElement>(name)!.style);
  }
  const cell = template.content.querySelector<HTMLElement>("td")!.style;
  if (cell.backgroundColor === "rgb(255, 255, 255)") variables["--article-td-background"] = "var(--app-bg)";
  const header = template.content.querySelector<HTMLElement>("th")!.style;
  variables["--article-th-font-weight"] = header.fontWeight || "bold";
  variables["--article-th-color"] = header.color === "rgb(255, 255, 255)" ? "var(--gray-1)" : "inherit";
  if (header.backgroundColor === "rgb(128, 128, 128)") variables["--article-th-background"] = "var(--gray-9)";
  const listParagraph = template.content.querySelector<HTMLElement>("li > p")!.style;
  variables["--article-list-paragraph-margin-block"] = `${listParagraph.marginTop || "0px"} ${listParagraph.marginBottom || "0px"}`;
  const pre = template.content.querySelector<HTMLElement>("pre")!;
  const frame = pre.closest<HTMLElement>(".gzh-code") ?? pre;
  box("code-frame", frame.style);
  if (theme.id === "plainly-default") {
    variables["--article-code-frame-background"] = "var(--gray-3)";
    variables["--article-th-background"] = "var(--gray-3)";
  }
  variables["--article-code-padding"] = pre.style.padding;
  variables["--article-code-padding-top"] = pre.style.paddingTop;
  variables["--article-code-padding-left"] = pre.style.paddingLeft;
  variables["--article-code-padding-right"] = pre.style.paddingRight;
  const codeLabel = frame.querySelector<HTMLElement>(".gzh-code-label");
  variables["--article-code-label-padding"] = codeLabel?.style.padding || "0px";
  variables["--article-code-label-border"] = codeLabel ? `${codeLabel.style.borderBottomWidth} ${codeLabel.style.borderBottomStyle} var(--article-rule)` : "0px none";
  variables["--article-code-label-line-height"] = codeLabel?.style.lineHeight || (template.content.firstElementChild as HTMLElement).style.lineHeight || "normal";
  variables["--article-quote-paragraph-end"] = template.content.querySelector<HTMLElement>("blockquote > p:last-child")!.style.marginBottom || "0px";
  const quoteParagraph = template.content.querySelector<HTMLElement>("blockquote > p")!.style;
  variables["--article-quote-paragraph-margin-block"] = `${quoteParagraph.marginTop} ${quoteParagraph.marginBottom}`;
  const callout = template.content.querySelector<HTMLElement>(".workbench-callout")!.style;
  variables["--article-callout-padding-block"] = `${callout.paddingTop} ${callout.paddingBottom}`;
  const reference = template.content.querySelector<HTMLElement>(".plainly-reference-title")!.style;
  variables["--article-reference-margin"] = reference.margin;
  variables["--article-reference-padding"] = reference.padding;
  editorStyles.set(theme.id, variables);
  return variables;
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

function checkWechatLinks(root: ParentNode) {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href")!;
    if (!href.startsWith("#") && !isWechatArticleLink(href)) {
      throw new Error("检测到未转为脚注的外部链接，请启用“链接转脚注”并检查后重试");
    }
  }
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
  parser.core.ruler.before("inline", "workbench_html_footnotes", state => {
    const tokens: typeof state.tokens = [];
    for (const token of state.tokens) {
      if (token.type !== "html_block" || !token.content.includes("data-workbench-footnote")) { tokens.push(token); continue; }
      let offset = 0;
      for (const match of token.content.matchAll(/<span data-workbench-footnote="(\d+)"><\/span>/g)) {
        if (match.index > offset) {
          const html = new state.Token("html_block", "", 0);
          html.content = token.content.slice(offset, match.index);
          tokens.push(html);
        }
        const reference = new state.Token("inline", "", 0);
        reference.content = `[^${match[1]}]`;
        reference.children = [];
        tokens.push(reference);
        offset = match.index + match[0].length;
      }
      const remaining = new state.Token("html_block", "", 0);
      remaining.content = token.content.slice(offset);
      tokens.push(remaining);
    }
    state.tokens = tokens;
  });
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
  if (input.output === "clipboard") checkWechatLinks(article);
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
    const gzhDesign = "layout" in theme && theme.layout === "gzh-design";
    if (gzhDesign) applyGzhDesign(article);
    const template = document.createElement("template");
    template.innerHTML = juice.inlineContent(article.outerHTML, wechatThemeCss(theme), { removeStyleTags: true, preserveImportant: true });
    // Plainly's WeChat converter supplies an explicit width attribute for full-width tables.
    for (const table of template.content.querySelectorAll("table")) {
      if (table.style.width === "100%" && !table.hasAttribute("width")) table.setAttribute("width", "100%");
    }
    if (input.output === "clipboard") {
      checkWechatLinks(template.content);
      for (const anchor of template.content.querySelectorAll("a")) {
        if (isWechatArticleLink(anchor.getAttribute("href") ?? "")) continue;
        const span = document.createElement("span");
        for (const attribute of Array.from(anchor.attributes)) {
          if (attribute.name !== "href") span.setAttribute(attribute.name, attribute.value);
        }
        span.append(...anchor.childNodes);
        anchor.replaceWith(span);
      }
    }
    if (gzhDesign) wrapGzhLeaves(template.content);
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
