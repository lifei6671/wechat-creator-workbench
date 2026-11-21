// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { parseWechat, renderWechat, wechatThemeId, wechatThemes, type SourceFragment } from "../../../../packages/wechat-renderer";
import { graphic } from "../../../../packages/wechat-renderer/graphics";
import fixture from "../../../../fixtures/wechat-format.json?raw";

const gzhThemes = wechatThemes.filter(theme => theme.id.startsWith("gzh-"));

it.each(wechatThemes)("omits the article background for $label in every output while preserving content highlights", async theme => {
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ themeId: theme.id, output, revision: 0, markdown: "## 章节\n\n==高亮== 与 `代码`\n\n> 引用" },
      { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const article = template.content.firstElementChild as HTMLElement;
    expect(article.style.backgroundColor).toBe("");
    expect(article.style.backgroundImage).toBe("");
    expect(article.querySelector("mark")?.style.backgroundColor).not.toBe("");
    expect(article.querySelector("code")?.style.backgroundColor).not.toBe("");
    result.dispose();
  }
});

it.each(gzhThemes)("renders $label consistently for preview, clipboard and HTML", async theme => {
  const markdown = "# 主标题\n\n引言含有 **关键观点** 与 ==高亮==。\n\n## 开始使用\n\n> 原始引用\n\n### 小节\n\n- 列表项\n\n## 2. 已编号\n\n## 写在最后\n\n![动图](asset://gif)\n\n| 名称 | 值 |\n| --- | --- |\n| 原文 | 保留 |\n\n脚注[^n]\n\n[^n]: 来源 https://example.test/source";
  const rendered = [];
  for (const output of ["preview", "clipboard", "html"] as const) {
    const image = vi.fn(async () => ({ src: "https://images.test/picture.gif", width: 80, height: 60 }));
    const result = await renderWechat({ markdown, themeId: theme.id, output, revision: 3 }, { image, sources: vi.fn(), derive: vi.fn() });
    expect(wechatThemeId(theme.id)).toBe(theme.id);
    expect(result.themeId).toBe(theme.id);
    expect(result.images).toEqual([{ url: "asset://gif", alt: "动图" }]);
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const headings = template.content.querySelectorAll("h2");
    expect(Array.from(headings, heading => heading.textContent)).toEqual(["01开始使用", "2. 已编号", "∞写在最后", "参考资料"]);
    expect(headings[0].hasAttribute("data-line")).toBe(output === "preview");
    expect(template.content.querySelector("strong")?.parentElement?.style.borderBottomWidth).toBe("0.5px");
    expect(template.content.querySelector("table")?.getAttribute("width")).toBe("100%");
    expect(template.content.querySelector("img")?.getAttribute("src")).toBe("https://images.test/picture.gif");
    expect(template.content.querySelector('a[href="#fn1"]')).not.toBeNull();
    expect(template.content.querySelector('[id="fn1"]')).not.toBeNull();
    expect(result.html).not.toMatch(/<style|<script|\bclass=|var\(--|undefined/);
    expect(template.content.querySelectorAll("[leaf]").length).toBeGreaterThan(10);
    for (const node of template.content.querySelectorAll("*")) {
      for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) expect(node.hasAttribute("leaf")).toBe(true);
    }
    if (output !== "preview") expect(result.html).not.toContain("data-");
    for (const heading of template.content.querySelectorAll("[data-line]")) heading.removeAttribute("data-line");
    rendered.push(template.innerHTML);
    result.dispose();
  }
  expect(new Set(rendered).size).toBe(1);
});

it("preserves highlighted code whitespace and safe disclosure content in GZH themes", async () => {
  const source = 'const n = 1;\n\n\tconsole.log("a  b");\n  // 中文， punctuation: exact';
  const result = await renderWechat({ themeId: "gzh-moyu-ticket", output: "clipboard", revision: 1,
    markdown: '## 01 已有编号\n\n```js\n' + source + '\n```\n\n<details><summary>展开内容</summary>\n\n**安全正文** [链接](https://example.test)\n\n</details>\n\n<script>alert(1)</script><a href="javascript:alert(2)" onclick="alert(3)">外部内容</a>' },
    { image: vi.fn(async () => ({ src: null, width: 0, height: 0 })), sources: vi.fn(), derive: vi.fn() });
  const template = document.createElement("template");
  template.innerHTML = result.html;
  const code = template.content.querySelector("pre > code")!;
  expect(code.textContent).toBe(source + "\n");
  expect(code.querySelectorAll("span[style]").length).toBeGreaterThan(0);
  expect(code.parentElement?.style.whiteSpace).toBe("pre");
  expect(code.closest("section")?.querySelector("p")?.textContent).toBe("js");
  expect(template.content.querySelector("h2")?.textContent).toBe("01 已有编号");
  expect(template.content.querySelector("details, summary, div, script, [onerror]")).toBeNull();
  expect(result.html).not.toContain("javascript:");
  expect(template.content.textContent).toContain("展开内容");
  expect(template.content.querySelector('a[href="https://example.test"]')?.textContent).toBe("链接");
});

it("keeps legacy themes free of GZH chapter numbers and leaf wrappers", async () => {
  expect(gzhThemes).toHaveLength(6);
  const result = await renderWechat({ themeId: "plainly-default", output: "clipboard", revision: 1, markdown: "## 章节\n\n**原文**" },
    { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
  expect(result.html).not.toContain("leaf=");
  expect(result.text).toBe("章节\n\n原文");
});

it("uses the same formula and diagram source fragments as Rust retention", () => {
  const samples: { markdown: string; fragments: SourceFragment[] }[] = JSON.parse(fixture);
  for (const sample of samples) {
    expect(parseWechat(sample.markdown, sample.fragments).fragments, sample.markdown)
      .toEqual(sample.fragments.map(({ kind, source }) => ({ kind, source })));
  }
});

it("keeps adjacent GitHub disclosures and renders Markdown inside them in preview", async () => {
  const markdown = [
    "<details open=\"open\">\n<summary>下载</summary>\n<br/>",
    "下载说明",
    "</details>",
    "<details>\n<summary><strong>开源范围</strong></summary>\n<br/>",
    "**许可协议**，请从 [Releases](https://github.com/CM-idea/SnowAir/releases) 下载 `SnowAir.exe`。",
    "</details>",
  ].join("\n\n");
  const result = await renderWechat({ output: "preview", revision: 1, markdown },
    { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
  const template = document.createElement("template");
  template.innerHTML = result.html;
  const [download, license] = template.content.querySelectorAll("details");
  expect(download.open).toBe(true);
  expect(license.open).toBe(false);
  expect(license.querySelector("summary strong")?.textContent).toBe("开源范围");
  expect(license.querySelector("p strong")?.textContent).toBe("许可协议");
  expect(license.querySelector("p a")?.getAttribute("href")).toBe("https://github.com/CM-idea/SnowAir/releases");
  expect(license.querySelector("p code")?.textContent).toBe("SnowAir.exe");
});

it("inlines the theme, retains table width and replaces asset links in document order", async () => {
  const image = vi.fn(async (url: string) => ({ src: `https://images.test/${url.split("://")[1]}.png`, width: 120, height: 60 }));
  const result = await renderWechat({
    output: "clipboard", revision: 17, themeId: "retired-theme",
    markdown: "# 排版标题\n\n==高亮==\n\n|表|\n|-|\n|值|\n\n![首图](asset://one)\n\n<img src='asset://two' onerror='alert(1)'><script>alert(2)</script><span class='preview-image' data-wechat-fragment='0'>普通文字</span>",
  }, { image, derive: vi.fn(), sources: vi.fn() });
  expect(result.revision).toBe(17);
  expect(result.themeId).toBe("plainly-default");
  expect(result.images.map(image => image.url)).toEqual(["asset://one", "asset://two"]);
  const template = document.createElement("template");
  template.innerHTML = result.html;
  expect(template.content.querySelector("h1")?.style.fontSize).toBe("22px");
  expect(template.content.querySelector("mark")?.textContent).toBe("高亮");
  expect(template.content.querySelector("table")?.getAttribute("width")).toBe("100%");
  expect(template.content.querySelector("img")?.getAttribute("src")).toBe("https://images.test/one.png");
  expect(result.html).not.toMatch(/asset:\/\/|onerror|<script|data-line|<style/);
  expect(result.text).toContain("排版标题");
  expect(result.text).toContain("普通文字");
});

it("preserves footnote text and its two links in the clipboard HTML", async () => {
  const result = await renderWechat({ output: "clipboard", revision: 1,
    markdown: "正文[^n]。\n\n[^n]: 来源说明：<https://example.test/source>\n\n后续正文[^other]\n\n[^other]: 第二条" },
    { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
  expect(result.html).toContain('href="#fn1"');
  expect(result.html).toContain('id="fn1"');
  expect(result.html).toContain('href="#fnref1"');
  expect(result.html.indexOf("后续正文")).toBeLessThan(result.html.indexOf('id="fn1"'));
  expect(result.text).toContain("来源说明：https://example.test/source");
  const output = document.createElement("template");
  output.innerHTML = result.html;
  const references = output.content.querySelector(".plainly-article, section")?.lastElementChild;
  expect(references?.querySelector("h2")?.textContent).toBe("参考资料");
  expect(Array.from(references?.querySelectorAll("li > span") ?? [], item => item.textContent)).toEqual(["[1]", "[2]"]);
  expect(references?.querySelector('a[href="https://example.test/source"]')?.textContent).toBe("https://example.test/source");
});

it("renders info and warning callout titles and body with inline styles in the clipboard", async () => {
  const markdown = "> [!info]\n> 正文说明\n\n> [!WARNING] **注意**\n> 风险说明\n\n> 普通引用 [!INFO]\n\n> \\[!INFO]";
  const { body } = parseWechat(markdown, []);
  expect(body.querySelector(".workbench-callout-info strong")?.textContent).toBe("信息");
  expect(body.querySelector(".workbench-callout-warning strong strong")?.textContent).toBe("注意");
  expect(body.querySelector(".workbench-callout-warning br")?.nextSibling?.textContent).toContain("风险说明");
  expect(body.querySelectorAll("blockquote:not([class])")).toHaveLength(2);
  const result = await renderWechat({ output: "clipboard", revision: 1, markdown },
    { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
  const article = document.createElement("template");
  article.innerHTML = result.html;
  const [info, warning, quote] = article.content.querySelectorAll("blockquote");
  expect(info.style.backgroundColor).toBe("rgb(230, 244, 254)");
  expect(warning.style.backgroundColor).toBe("rgb(255, 247, 194)");
  expect(quote.textContent).toContain("普通引用 [!INFO]");
});

it("preserves prose between display formulas on the same line", () => {
  const { body } = parseWechat("$$a$$ 以及 $$b$$", [
    { kind: "math-block", source: "a", line: 0 }, { kind: "math-block", source: "b", line: 0 },
  ]);
  expect(body.textContent).toContain("以及");
});

it("prepares standalone SVG math with dimensions from the offline renderer", async () => {
  const result = await graphic("math-block", "\\frac{a}{b}");
  expect(result.blob.type).toBe("image/svg+xml");
  expect(result.width).toBeGreaterThan(5);
  expect(result.height).toBeGreaterThan(5);
  const source = await new Promise<string>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(result.blob);
  });
  const svg = new DOMParser().parseFromString(source, "image/svg+xml");
  expect([...svg.querySelectorAll("path")].some(path => !path.closest("defs"))).toBe(true);
});
