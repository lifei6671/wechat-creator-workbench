// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { renderMarkdown } from "../../../../packages/markdown-core";
import { calloutLabels, calloutTone } from "../../../../packages/markdown-core/callouts";
import { renderWechat } from "../../../../packages/wechat-renderer";

it.each(["preview", "clipboard", "html"] as const)("renders task states as static symbols in %s", async output => {
  const source = "- [x] 已完成 **加粗**\n- [ ] 待办\n  - [X] 嵌套已完成\n- [ ]\t制表符待办\n- 普通列表\n\n不是任务 [x] 文本\n\n`- [x] 代码`";
  const result = await renderWechat({ markdown: source, revision: 1, output }, { sources: vi.fn(), image: vi.fn(), derive: vi.fn() });
  try {
    const template = document.createElement("template");
    template.innerHTML = result.html;
    expect(template.content.querySelectorAll("input, label, button")).toHaveLength(0);
    const tasks = [...template.content.querySelectorAll("li")].filter(node => node.style.listStyle === "none");
    expect(tasks).toHaveLength(4);
    expect(tasks[0].textContent).toContain("☑");
    expect(tasks[1].textContent).toContain("☐");
    expect(tasks[2].textContent).toContain("☑");
    expect(tasks[3].textContent).toContain("☐");
    expect(tasks[3].textContent).toContain("制表符待办");
    expect(template.content.textContent).toContain("不是任务 [x] 文本");
    expect(template.content.querySelector("code")?.textContent).toBe("- [x] 代码");
    expect(template.content.querySelector("strong")?.textContent).toBe("加粗");
    expect(result.text).toContain("☑");
  } finally { result.dispose(); }
});

it("keeps task markup inert through the shared HTML sanitizer", () => {
  const fragment = renderMarkdown('- [ ] <script>alert(1)</script>安全\n- [x] <img src="javascript:alert(1)" onerror="alert(2)">');
  expect(fragment.querySelectorAll("input, script, [onerror], [onclick]")).toHaveLength(0);
  expect(fragment.textContent).toContain("☐");
  expect(fragment.textContent).toContain("☑");
});

it.each(["plainly-default", "plainly-elegant", "gzh-zen-whitespace"])("preserves every callout tone in %s", async themeId => {
  const kinds = Object.keys(calloutLabels) as (keyof typeof calloutLabels)[];
  const markdown = kinds.map(kind => `> [!${kind.toUpperCase()}]\n> 正文`).join("\n\n");
  const expected = { info: ["#e6f4fe", "#0d74ce"], warning: ["#fff7c2", "#ab6400"], success: ["#e6f6eb", "#218358"], danger: ["#feebec", "#ce2c31"] };
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ markdown, themeId, revision: 1, output }, { sources: vi.fn(), image: vi.fn(), derive: vi.fn() });
    try {
      const template = document.createElement("template");
      template.innerHTML = result.html;
      const quotes = [...template.content.querySelectorAll<HTMLElement>("blockquote")];
      expect(quotes).toHaveLength(kinds.length);
      quotes.forEach((quote, index) => {
        const tone = calloutTone(kinds[index]);
        const color = document.createElement("span").style;
        color.backgroundColor = expected[tone][0];
        color.color = expected[tone][1];
        expect(quote.style.backgroundColor).toBe(color.backgroundColor);
        expect(quote.querySelector<HTMLElement>("strong")?.style.color).toBe(color.color);
        expect(quote.style.textAlign).toBe("start");
        expect(quote.style.fontStyle).toBe("normal");
        expect(quote.style.borderTopWidth).toBe("0px");
        expect(quote.style.borderBottomWidth).toBe("0px");
        expect(quote.textContent).toContain(calloutLabels[kinds[index]]);
      });
    } finally { result.dispose(); }
  }
});
