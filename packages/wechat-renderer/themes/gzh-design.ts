// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from gzh-design-skill, Copyright (C) 2026 甲木 × 摸鱼小李.
// Modified 2026-11-20: deterministic Markdown themes, Radix colors and desktop integration.
// Source and full license: ../SOURCES.md and LICENSE-GZH-DESIGN.

const sans = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";
const serif = "'Songti SC',SimSun,Georgia,serif";
const mono = "ui-monospace,Consolas,Monaco,monospace";

const palettes = [
  { id: "moyu-green", label: "摸鱼绿", accent: "#218358", ink: "#1a211e", text: "#5f6563", muted: "#63706b", line: "#adddc0", tint: "#e6f6eb", gap: 40, paragraph: 20, font: sans, chapter: "label" },
  { id: "red-white", label: "红白色系", accent: "#ce2c31", ink: "#211f26", text: "#646464", muted: "#838383", line: "#f4a9aa", tint: "#feebec", gap: 48, paragraph: 20, font: sans, chapter: "label" },
  { id: "graphite-minimal", label: "石墨极简", accent: "#646464", ink: "#202020", text: "#646464", muted: "#838383", line: "#d9d9d9", tint: "#f0f0f0", gap: 56, paragraph: 22, font: sans, chapter: "stack" },
  { id: "zen-whitespace", label: "留白禅意", accent: "#5f6563", ink: "#1a211e", text: "#5f6563", muted: "#7c8481", line: "#b8bcba", tint: "#eef1f0", gap: 64, paragraph: 26, font: serif, chapter: "center" },
  { id: "moyu-ticket", label: "摸鱼票据", accent: "#218358", ink: "#21201c", text: "#63635e", muted: "#82827c", line: "#bcbbb5", tint: "#f1f0ef", gap: 40, paragraph: 20, font: sans, chapter: "ticket" },
  { id: "olive-journal", label: "橄榄手记", accent: "#cc4e00", ink: "#1d211c", text: "#60655f", muted: "#7f847d", line: "#b9bcb8", tint: "#eff1ef", gap: 32, paragraph: 24, font: sans, chapter: "journal" },
] as const;

export const gzhDesignThemes = palettes.map(palette => {
  const { accent, ink, text, line, tint, gap, paragraph, font, chapter } = palette;
  const styles: Record<string, string> = {
    container: `max-width:677px;margin:0 auto;padding:8px 16px 28px;box-sizing:border-box;color:${text};font-family:${sans};font-size:15px;line-height:1.9;letter-spacing:0.3px;overflow-wrap:break-word;`,
    h1: `margin:24px 0;font-size:20px;font-weight:700;line-height:1.5;color:${ink};font-family:${font};`,
    h2: `margin:${gap}px 0 24px;padding:0 0 12px;border-bottom:0.5px solid ${line};font-size:20px;font-weight:700;line-height:1.5;color:${ink};font-family:${font};`,
    h3: `margin:28px 0 16px;font-size:15px;font-weight:700;color:${ink};line-height:1.9;font-family:${font};`,
    "h4, h5, h6": `margin:24px 0 12px;font-size:15px;font-weight:700;line-height:1.9;color:${ink};`,
    p: `margin:0 0 ${paragraph}px;font-size:15px;line-height:1.9;`,
    strong: `font-weight:600;color:${ink};`,
    ".gzh-emphasis": `border-bottom:0.5px solid ${accent};font-weight:600;color:${ink};`,
    mark: `background-color:${tint} !important;color:${ink};`,
    a: `color:${accent};text-decoration:none;border-bottom:0.5px solid ${line};overflow-wrap:anywhere;`,
    blockquote: `margin:24px 0;padding:16px 18px;background-color:${tint};border:0.5px solid ${line};font-style:normal;`,
    "blockquote > p:last-child": "margin-bottom:0;",
    ul: "margin:0 0 20px;padding-left:24px;",
    ol: "margin:0 0 20px;padding-left:24px;",
    li: "margin:8px 0;line-height:1.9;",
    code: `font-family:${mono};font-size:12px;color:${accent};background-color:${tint};padding:2px 5px;border-radius:3px;`,
    ".gzh-code": `margin:24px 0;background-color:${tint};border:0.5px solid ${line};overflow-x:auto;`,
    ".gzh-code-label": `margin:0;padding:6px 12px;font-size:12px;font-family:${mono};color:${palette.muted};border-bottom:0.5px solid ${line};`,
    pre: `margin:0;padding:12px;font-family:${mono};font-size:12px;line-height:1.7;overflow-x:auto;white-space:pre;`,
    "pre code": `padding:0;background-color:transparent;color:${ink};font-size:12px;line-height:1.7;white-space:pre;`,
    img: "max-width:100%;height:auto;display:block;margin:24px auto;",
    table: "width:100%;margin:24px 0;border-collapse:collapse;font-size:15px;",
    th: `padding:8px;text-align:left;background-color:${tint};border:0.5px solid ${line};font-weight:600;`,
    td: `padding:8px;text-align:left;border:0.5px solid ${line};`,
    hr: `margin:40px 0;border:0;border-top:0.5px solid ${line};`,
    ".gzh-chapter-number": `display:inline-block;margin-right:12px;padding:2px 8px;background-color:${accent};color:#ffffff;font-size:20px;line-height:1.5;font-weight:700;`,
    ".hljs-keyword, .hljs-title": "color:#6550b9 !important;",
    ".hljs-string": "color:#218358 !important;",
    ".hljs-number": "color:#cc4e00 !important;",
    ".hljs-comment": "color:#838383 !important;",
  };
  if (chapter === "stack") styles[".gzh-chapter-number"] = `display:block;margin:0 0 8px;color:${palette.muted};font-size:20px;line-height:1.5;font-weight:500;letter-spacing:2px;`;
  if (chapter === "center") {
    styles.h2 += "text-align:center;";
    styles[".gzh-chapter-number"] = `display:block;margin:0 0 12px;color:${accent};font-size:12px;font-weight:500;letter-spacing:3px;`;
    styles.blockquote = `margin:32px 0;padding:24px 8px;border-top:0.5px solid ${line};border-bottom:0.5px solid ${line};text-align:center;font-family:${serif};color:${ink};`;
  }
  if (chapter === "ticket") styles.h2 += `padding:12px;border:0.5px dashed ${accent};background-color:${tint};`;
  if (chapter === "journal") styles[".gzh-chapter-number"] = `display:inline-block;margin-right:14px;padding-right:14px;border-right:0.5px solid ${line};color:${ink};font-size:20px;line-height:1.5;font-weight:700;`;
  return { id: `gzh-${palette.id}`, label: palette.label, styles, layout: "gzh-design" as const };
});

export function applyGzhDesign(article: HTMLElement) {
  const chapters = article.querySelectorAll<HTMLElement>(":scope > h2");
  chapters.forEach((heading, index) => {
    const title = heading.textContent?.trim() ?? "";
    if (/^(?:第[一二三四五六七八九十百\d]+[章节部分]|[\d一二三四五六七八九十]+[.、．）)]\s*|\d+\s+)/u.test(title)) return;
    const number = document.createElement("span");
    number.className = "gzh-chapter-number";
    number.textContent = /^(?:写在最后|结语|结尾|尾声|总结)$/u.test(title) ? "∞" : String(index + 1).padStart(2, "0");
    heading.prepend(number);
  });
  for (const strong of article.querySelectorAll("p strong, li strong")) {
    if (strong.closest("pre, code, .workbench-callout-title")) continue;
    const emphasis = document.createElement("span");
    emphasis.className = "gzh-emphasis";
    strong.replaceWith(emphasis);
    emphasis.append(strong);
  }
  for (const pre of article.querySelectorAll("pre")) {
    const block = document.createElement("section");
    block.className = "gzh-code";
    const language = Array.from(pre.querySelector("code")?.classList ?? []).find(name => name.startsWith("language-"))?.slice(9);
    pre.replaceWith(block);
    if (language) {
      const label = document.createElement("p");
      label.className = "gzh-code-label";
      label.textContent = language;
      block.append(label);
    }
    block.append(pre);
  }
  for (const element of article.querySelectorAll("div, details, summary")) {
    const replacement = document.createElement(element.tagName === "SUMMARY" ? "p" : "section");
    for (const attribute of element.attributes) if (attribute.name !== "open") replacement.setAttribute(attribute.name, attribute.value);
    replacement.append(...element.childNodes);
    element.replaceWith(replacement);
  }
}

export function wrapGzhLeaves(article: DocumentFragment) {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (!node.textContent?.trim()) continue;
    const leaf = document.createElement("span");
    leaf.setAttribute("leaf", "");
    node.replaceWith(leaf);
    leaf.append(node);
  }
}
