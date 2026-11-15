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

it("inlines the theme, retains table width and replaces asset links in document order", async () => {
  const image = vi.fn(async (url: string) => ({ src: `https://images.test/${url.split("://")[1]}.png`, width: 120, height: 60 }));
  const result = await renderWechat({
    output: "clipboard", revision: 17, themeId: "retired-theme",
    markdown: "# 排版标题\n\n|表|\n|-|\n|值|\n\n![首图](asset://one)\n\n<img src='asset://two' onerror='alert(1)'><script>alert(2)</script><span class='preview-image' data-wechat-fragment='0'>普通文字</span>",
  }, { image, derive: vi.fn(), sources: vi.fn() });
  expect(result.revision).toBe(17);
  expect(result.themeId).toBe("plainly-default");
  expect(result.images.map(image => image.url)).toEqual(["asset://one", "asset://two"]);
  const template = document.createElement("template");
  template.innerHTML = result.html;
  expect(template.content.querySelector("h1")?.style.fontSize).toBe("22px");
  expect(template.content.querySelector("table")?.getAttribute("width")).toBe("100%");
  expect(template.content.querySelector("img")?.getAttribute("src")).toBe("https://images.test/one.png");
  expect(result.html).not.toMatch(/asset:\/\/|onerror|<script|data-line|<style/);
  expect(result.text).toContain("排版标题");
  expect(result.text).toContain("普通文字");
});

it("preserves footnote text and its two links in the clipboard HTML", async () => {
  const result = await renderWechat({ output: "clipboard", revision: 1,
    markdown: "正文[^n]。\n\n[^n]: 来源说明。" }, { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
  expect(result.html).toContain('href="#fn1"');
  expect(result.html).toContain('id="fn1"');
  expect(result.html).toContain('href="#fnref1"');
  expect(result.text).toContain("来源说明。");
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
});
