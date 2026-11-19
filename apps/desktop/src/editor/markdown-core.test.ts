// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderMarkdown } from "../../../../packages/markdown-core";
import fixture from "../../../../fixtures/asset-references.json?raw";

it("renders Markdown and strips scripts, event handlers and unsafe URLs from raw HTML", () => {
  const fragment = renderMarkdown([
    "# 标题", "", "**加粗**", "",
    '<a href="javascript:alert(1)" onclick="alert(1)">不安全链接</a>',
    '<a href="https://example.test">安全链接</a>',
    '<img src="https://example.test/tracker" alt="配图" onerror="alert(1)">',
    '<script>alert(1)</script><iframe src="https://example.test"></iframe>',
  ].join("\n"));
  expect(fragment.querySelector("h1")?.getAttribute("data-line")).toBe("1");
  expect(fragment.querySelector("strong")?.textContent).toBe("加粗");
  expect(fragment.querySelectorAll("[onclick], [onerror], script, iframe, img, [src]").length).toBe(0);
  expect([...fragment.querySelectorAll("a")].map(node => node.getAttribute("href"))).toEqual([null, "https://example.test"]);
  expect(fragment.textContent).toContain("图片：配图");
  expect(fragment.querySelector<HTMLElement>(".preview-image")?.dataset.imageUrl).toBe("https://example.test/tracker");
});

it("matches the shared Markdown image syntax fixtures", () => {
  const samples: { markdown: string; images: string[] }[] = JSON.parse(fixture);
  for (const { markdown, images } of samples) {
    const urls = Array.from(renderMarkdown(markdown).querySelectorAll<HTMLElement>("[data-image-url]"), image => image.dataset.imageUrl);
    expect(urls).toEqual(images);
  }
});

it("renders safe HTML disclosures and strips executable and display-spoofing markup", () => {
  const fragment = renderMarkdown([
    '<details open style="position:fixed" class="rich-editor" id="control">',
    "<summary>使用方法</summary>", "", "**运行**", "", "</details>", "",
    '<a href="javascript:alert(1)">不安全链接</a>',
    '<img src="file:///etc/passwd" srcset="https://example.test/logo.png" onerror="alert(1)">',
    '<form><input></form><svg><script>alert(1)</script></svg>',
  ].join("\n"), { githubRepo: "https://github.com/Owner/Repo", embedded: true });
  expect(fragment.querySelector("details[open] summary")?.textContent).toBe("使用方法");
  expect(fragment.querySelector("details strong")?.textContent).toBe("运行");
  expect(fragment.querySelector("[style], [onclick], [onerror], [id], [href], [src], [srcset], [data-image-url], .rich-editor, form, input, svg, script")).toBeNull();
});
