// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import type { Entry } from "../../../../packages/shared-types";
import { renderWechat, wechatEditorStyles, wechatThemes } from "../../../../packages/wechat-renderer";
import { DocumentEditor } from "../workspace/Document";
import { SaveQueue } from "./save-queue";

vi.mock("../../../../packages/editor-react", () => ({ MarkdownEditor: () => <div className="rich-editor" /> }));
vi.mock("../workspace/EditorContextMenu", () => ({ EditorContextMenu: ({ children }: { children: ReactNode }) => children }));

it.each(wechatThemes)("takes spacing and heading decoration from the $id publication theme", async theme => {
  const markdown = ["正文", ...Array.from({ length: 6 }, (_, index) => `${"#".repeat(index + 1)} 标题`),
    "> 引用第一段\n>\n> 引用最后一段", "> [!NOTE]\n> 提示正文", "- 列表第一项\n- 列表第二项", "1. 有序第一项\n2. 有序第二项",
    "| 表头 |\n| --- |\n| 单元格 |", "```javascript\nconst value = 1;\n```", "正文脚注[^1]", "[^1]: 纯文本来源"].join("\n\n");
  const result = await renderWechat({ markdown, themeId: theme.id, revision: 1, output: "preview" }, {
    sources: vi.fn(), derive: vi.fn(), image: vi.fn(),
  });
  try {
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const spacing = wechatEditorStyles(theme.id);
    for (const name of ["h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "ul", "ol", "li", "table", "th", "td"]) {
      const { style } = template.content.querySelector<HTMLElement>(name)!;
      for (const property of ["margin", "padding"]) {
        const expected = ["top", "bottom"].map(side => style.getPropertyValue(`${property}-${side}`) || "0px").join(" ");
        expect(spacing[`--article-${name}-${property}-block`], `${name} ${property}`).toBe(expected);
      }
      if (/^h[1-6]$/.test(name) || ["blockquote", "th", "td"].includes(name)) {
        expect(spacing[`--article-${name}-padding-inline`]).toBe(`${style.paddingLeft || "0px"} ${style.paddingRight || "0px"}`);
        for (const property of ["width", "style"]) {
          const expected = ["top", "right", "bottom", "left"]
            .map(side => style.getPropertyValue(`border-${side}-${property}`) || (property === "width" ? "0px" : "none")).join(" ");
          expect(spacing[`--article-${name}-border-${property}`]).toBe(expected);
        }
        expect(spacing[`--article-${name}-text-align`]).toBe(style.textAlign || "inherit");
        expect(spacing[`--article-${name}-font-style`]).toBe(style.fontStyle || "inherit");
      }
    }
    const last = template.content.querySelector<HTMLElement>("blockquote > p:last-child")!;
    expect(spacing["--article-quote-paragraph-end"]).toBe(last.style.marginBottom);
    const first = template.content.querySelector<HTMLElement>("blockquote > p")!;
    expect(spacing["--article-quote-paragraph-margin-block"]).toBe(`${first.style.marginTop} ${first.style.marginBottom}`);
    const callout = template.content.querySelectorAll<HTMLElement>("blockquote")[1];
    expect(spacing["--article-callout-padding-block"]).toBe(`${callout.style.paddingTop} ${callout.style.paddingBottom}`);
    const reference = [...template.content.querySelectorAll<HTMLElement>("h2")].find(node => node.textContent === "参考资料")!;
    expect(spacing["--article-reference-margin"]).toBe(reference.style.margin);
    expect(spacing["--article-reference-padding"]).toBe(reference.style.padding);
    const pre = template.content.querySelector<HTMLElement>("pre")!;
    const frame = pre.parentElement === template.content.firstElementChild ? pre : pre.parentElement!;
    expect(spacing["--article-code-padding"]).toBe(pre.style.padding);
    expect(spacing["--article-code-frame-margin-block"]).toBe(`${frame.style.marginTop || "0px"} ${frame.style.marginBottom || "0px"}`);
    for (const property of ["width", "style"]) {
      const expected = ["top", "right", "bottom", "left"]
        .map(side => frame.style.getPropertyValue(`border-${side}-${property}`) || (property === "width" ? "0px" : "none")).join(" ");
      expect(spacing[`--article-code-frame-border-${property}`]).toBe(expected);
    }
  } finally { result.dispose(); }
});

it.each(["preview", "clipboard", "html"] as const)("halves the technical theme's quote whitespace in %s output", async output => {
  const result = await renderWechat({ markdown: "> 第一段\n>\n> 第二段\n\n> [!NOTE]\n> 提示正文", themeId: "plainly-tech", revision: 1, output }, {
    sources: vi.fn(), derive: vi.fn(), image: vi.fn(),
  });
  try {
    const template = document.createElement("template");
    template.innerHTML = result.html;
    for (const quote of template.content.querySelectorAll<HTMLElement>("blockquote")) {
      expect(quote.style.marginTop).toBe("8px");
      expect(quote.style.marginBottom).toBe("8px");
      expect(quote.style.paddingTop).toBe("4px");
      expect(quote.style.paddingBottom).toBe("4px");
      for (const paragraph of quote.querySelectorAll("p")) {
        expect(paragraph.style.marginTop).toBe("10px");
        expect(paragraph.style.marginBottom).toBe("10px");
      }
    }
    const styles = wechatEditorStyles("plainly-tech");
    expect(styles["--article-blockquote-margin-block"]).toBe("8px 8px");
    expect(styles["--article-blockquote-padding-block"]).toBe("4px 4px");
    expect(styles["--article-quote-paragraph-margin-block"]).toBe("10px 10px");
    expect(styles["--article-callout-padding-block"]).toBe("4px 4px");
  } finally { result.dispose(); }
});

it("uses the default theme spacing for unknown or missing theme identifiers", () => {
  expect(wechatEditorStyles("missing-theme")).toEqual(wechatEditorStyles("plainly-default"));
  expect(wechatEditorStyles(null)).toEqual(wechatEditorStyles("plainly-default"));
});

it("keeps transparent gradient bases transparent while retaining filled theme headings", () => {
  expect(wechatEditorStyles("plainly-tech")["--article-h2-background"]).toBe("transparent");
  expect(wechatEditorStyles("gzh-moyu-ticket")["--article-h2-background"]).toBe("var(--article-quote)");
  expect(wechatEditorStyles("plainly-elegant")["--article-blockquote-background"]).toBe("transparent");
});

it("updates the existing document's spacing when its theme changes without editing its Markdown", () => {
  const entry: Entry = { id: "spacing", kind: "article", title: "标题", contentMd: "## 正文标题\n\n> 引用内容", status: "draft",
    categoryId: null, coverAssetId: null, themeId: "plainly-default", tags: [], summary: "", source: null,
    publishedAt: null, publishedUrl: "", customProperties: [], version: 1, createdAt: 0, updatedAt: 0, deletedAt: null, links: [] };
  const commit = vi.fn();
  const queue = new SaveQueue(entry, commit, vi.fn());
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const props: ComponentProps<typeof DocumentEditor> = { queue, active: true, locked: false, reading: false,
    clipboard: { read: vi.fn(), write: vi.fn(), onError: vi.fn() },
    display: { limitWidth: true, lineNumbers: false, showTitle: false, convertLinks: false }, onDisplayChange: vi.fn(),
    handle: vi.fn(), onImages: vi.fn(), onImageZoom: vi.fn(), onError: vi.fn() };
  try {
    flushSync(() => root.render(<DocumentEditor {...props} />));
    const documentEditor = container.querySelector<HTMLElement>(".document-editor")!;
    expect(documentEditor.style.getPropertyValue("--article-h2-padding-block")).toBe("0px 0px");
    flushSync(() => queue.edit({ themeId: "plainly-tech" }));
    expect(container.querySelector(".document-editor")).toBe(documentEditor);
    expect(documentEditor.style.getPropertyValue("--article-h2-padding-block")).toBe("4px 4px");
    expect(documentEditor.style.getPropertyValue("--article-h2-border-width")).toBe("0px 0px 0px 5px");
    expect(documentEditor.style.getPropertyValue("--article-h3-border-width")).toBe("0px 0px 0px 3px");
    flushSync(() => root.render(<DocumentEditor {...props} reading />));
    expect(documentEditor.style.getPropertyValue("--article-h2-padding-block")).toBe("4px 4px");
    flushSync(() => queue.edit({ themeId: "gzh-moyu-ticket" }));
    expect(documentEditor.style.getPropertyValue("--article-h2-border-width")).toBe("0.5px 0.5px 0.5px 0.5px");
    expect(documentEditor.style.getPropertyValue("--article-h2-border-style")).toBe("dashed dashed dashed dashed");
    expect(documentEditor.style.getPropertyValue("--article-h2-background")).toBe("var(--article-quote)");
    flushSync(() => queue.edit({ themeId: "gzh-graphite-minimal" }));
    expect(documentEditor.style.getPropertyValue("--article-h1-border-width")).toBe("0px 0px 0px 0px");
    expect(documentEditor.style.getPropertyValue("--article-h2-border-width")).toBe("0px 0px 0.5px 0px");
    expect(documentEditor.style.getPropertyValue("--article-h2-background")).toBe("transparent");
    expect(queue.snapshotFields().contentMd).toBe(entry.contentMd);
    expect(commit).not.toHaveBeenCalled();
  } finally { queue.dispose(); flushSync(() => root.unmount()); container.remove(); }
});
