import { parseDocument, isMap } from "yaml";
import MarkdownIt from "markdown-it";
import type { Source } from "../../../../packages/shared-types";

export interface WebClipping {
  title: string;
  contentMd: string;
  source: Source;
  summary: string;
  tags: string[];
  unavailableAttachments: string[];
}

export function parseWebClipping(text: string): WebClipping | null {
  let markdown = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  // A rich-text copy of Markdown may escape the whole clipping, including its delimiters.
  if (markdown.startsWith("\\---\\\n")) {
    markdown = markdown.replace(/\\$/gm, "").replace(/\\(?=[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "")
      .replace(/&#(?:x20|32);/gi, " ");
  }
  const header = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(markdown);
  if (!header || !/^title\s*:/m.test(header[1]) || !/^source\s*:/m.test(header[1])) return null;
  const document = parseDocument(header[1]);
  if (document.errors.length) throw new Error(`剪藏属性格式有误：${document.errors[0].message}`);
  if (!isMap(document.contents)) throw new Error("剪藏属性须为 YAML 键值表");
  const properties: Record<string, unknown> = document.toJS();
  const scalar = (key: string) => {
    const value = properties[key];
    if (value == null) return "";
    if (typeof value !== "string") throw new Error(`剪藏属性「${key}」须为文本`);
    return value.trim();
  };
  const list = (key: string) => {
    const value = properties[key];
    if (value == null) return [];
    const values = Array.isArray(value) ? value : [value];
    if (!values.every(item => typeof item === "string")) throw new Error(`剪藏属性「${key}」须为文本或文本列表`);
    return values.map(item => item.trim()).filter(Boolean);
  };
  const date = (key: string) => {
    const value = scalar(key);
    if (!value) return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || (/^\d{4}-\d{2}-\d{2}$/.test(value)
      && new Date(timestamp).toISOString().slice(0, 10) !== value)) throw new Error(`剪藏属性「${key}」的日期无效`);
    return timestamp;
  };
  const title = scalar("title");
  if (!title) throw new Error("剪藏标题不能为空");
  let address: URL;
  try { address = new URL(scalar("source")); }
  catch { throw new Error("剪藏来源须为有效的网页链接"); }
  if (!["http:", "https:"].includes(address.protocol)) throw new Error("剪藏来源只支持 HTTP 或 HTTPS 链接");
  address.hash = "";
  const contentMd = markdown.slice(header[0].length).replace(/^\n+/, "");
  const unavailableAttachments = new Set<string>();
  for (const block of new MarkdownIt().parse(contentMd, {})) {
    for (const token of block.children ?? []) {
      if (token.type !== "text") continue;
      for (const match of token.content.matchAll(/!\[\[([^\]\n]+)\]\]/g)) unavailableAttachments.add(match[1]);
    }
  }
  return {
    title, contentMd, summary: scalar("description"),
    tags: list("tags").map(tag => tag.replace(/^#/, "")),
    source: {
      url: address.href,
      author: list("author").map(author => author.replace(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/, (_, name, alias) => alias ?? name)).join("、"),
      accountName: scalar("site") || address.hostname,
      originalPublishedAt: date("published"), importedAt: date("created"),
    },
    unavailableAttachments: [...unavailableAttachments],
  };
}
