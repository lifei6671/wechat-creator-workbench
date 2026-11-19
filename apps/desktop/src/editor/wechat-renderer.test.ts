// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { parseWechat, renderWechat, type SourceFragment } from "../../../../packages/wechat-renderer";
import { graphic } from "../../../../packages/wechat-renderer/graphics";
import fixture from "../../../../fixtures/wechat-format.json?raw";

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
