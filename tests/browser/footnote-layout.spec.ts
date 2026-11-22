import { expect, test } from "@playwright/test";

const themes = ["plainly-default", "plainly-elegant", "plainly-tech", "gzh-moyu-green", "gzh-red-white",
  "gzh-graphite-minimal", "gzh-zen-whitespace", "gzh-moyu-ticket", "gzh-olive-journal"];
const cases = [...themes.map(theme => ({ theme, newline: "lf" })), { theme: "plainly-tech", newline: "crlf" }];

for (const { theme, newline } of cases) test(`${theme} ${newline}: footnotes align and wrap naturally`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/tests/footnote-layout.html?theme=${theme}&newline=${newline}`);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(editor.locator('dl[data-type="footnote_definition"]')).toHaveCount(6);

  for (const width of [340, 840]) for (const zoom of [1, 1.25]) {
    await page.locator(".document-editor").evaluate((element, { width, zoom }) => {
      element.style.width = `${width}px`;
      element.style.zoom = String(zoom);
    }, { width, zoom });
    for (const reading of [false, true]) {
      await page.getByLabel("阅读模式").setChecked(reading);
      await expect(editor).toHaveAttribute("contenteditable", String(!reading));
      const rows = await editor.evaluate(root => {
        const lines = (range: Range) => [...new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)))];
        const textRange = (node: Node) => { const range = document.createRange(); range.selectNodeContents(node); return range; };
        function firstText(element: Element) {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) return walker.currentNode;
          throw new Error("Missing footnote text");
        }
        return [...root.querySelectorAll<HTMLElement>('dl[data-type="footnote_definition"]')].map(row => {
          const label = row.querySelector("dt")!;
          const body = row.querySelector("dd")!;
          const paragraph = body.querySelector("p")!;
          const first = textRange(firstText(paragraph));
          first.setEnd(first.startContainer, first.startOffset + 1);
          const words: number[] = [];
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            for (const match of walker.currentNode.textContent!.matchAll(/\b(?:Adversarial|Distillation|Research|Natural|wrapping|complete|English)\b/g)) {
              const range = document.createRange();
              range.setStart(walker.currentNode, match.index);
              range.setEnd(walker.currentNode, match.index + match[0].length);
              words.push(lines(range).length);
            }
          }
          const labelRange = textRange(label);
          return {
            label: row.dataset.label, labelLines: lines(labelRange).length,
            alignment: Math.abs(labelRange.getClientRects()[0].top - first.getClientRects()[0].top),
            rowOverflow: row.scrollWidth - row.clientWidth, bodyOverflow: body.scrollWidth - body.clientWidth,
            firstMargin: getComputedStyle(paragraph).marginTop,
            bodyWidth: body.getBoundingClientRect().width, rowWidth: row.getBoundingClientRect().width,
            paragraphLines: lines(textRange(paragraph)).length, words, breaks: body.querySelectorAll("br:not(.ProseMirror-trailingBreak)").length,
          };
        });
      });
      for (const row of rows) {
        const context = `${theme} ${newline} width=${width} zoom=${zoom} reading=${reading} label=${row.label}`;
        if (!row.label!.startsWith("https:")) expect(row.labelLines, context).toBe(1);
        expect(row.alignment, context).toBeLessThan(1);
        expect(row.firstMargin, context).toBe("0px");
        expect(row.rowOverflow, context).toBeLessThanOrEqual(1);
        expect(row.bodyOverflow, context).toBeLessThanOrEqual(1);
        expect(row.bodyWidth / row.rowWidth, context).toBeGreaterThan(0.5);
        if (["1", "2", "3"].includes(row.label!)) expect(row.paragraphLines, context).toBeGreaterThan(1);
        for (const wordLines of row.words) expect(wordLines, context).toBe(1);
        expect(row.breaks, context).toBe(row.label === "来源-2026" ? 1 : 0);
      }
    }
  }
  await page.getByRole("button", { name: "核对原文" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-source-unchanged", "true");
  expect(errors).toEqual([]);
});
