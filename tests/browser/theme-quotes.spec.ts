import { expect, test } from "@playwright/test";

const themes = [
  { id: "plainly-default", top: 16, bottom: 16, end: 16 },
  { id: "plainly-elegant", top: 20, bottom: 20, end: 20 },
  { id: "plainly-tech", top: 10, bottom: 10, end: 10 },
  { id: "gzh-moyu-green", top: 0, bottom: 20, end: 0 },
  { id: "gzh-red-white", top: 0, bottom: 20, end: 0 },
  { id: "gzh-graphite-minimal", top: 0, bottom: 22, end: 0 },
  { id: "gzh-zen-whitespace", top: 0, bottom: 26, end: 0 },
  { id: "gzh-moyu-ticket", top: 0, bottom: 20, end: 0 },
  { id: "gzh-olive-journal", top: 0, bottom: 24, end: 0 },
];

for (const { id } of [...themes, { id: "morandi" }]) test(`${id}: exported inline styles fill the client width without extra side gutters`, async ({ page }) => {
  await page.goto(`/tests/theme-quotes.html?theme=${id}&urls=1`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const measurements = await page.locator("[data-output]").evaluateAll(hosts => hosts.flatMap(host => {
    const root = host.shadowRoot!.querySelector<HTMLElement>("section")!;
    host.shadowRoot!.querySelector("style")!.remove();
    return [300, 677, 980].map(width => {
      (host as HTMLElement).style.width = `${width}px`;
      const style = getComputedStyle(root);
      return { output: (host as HTMLElement).dataset.output, width, actual: root.getBoundingClientRect().width,
        paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, marginLeft: style.marginLeft, marginRight: style.marginRight,
        fontSize: style.fontSize, paragraphLeft: root.querySelector("p")!.getBoundingClientRect().left - root.getBoundingClientRect().left };
    });
  }));
  for (const measurement of measurements) {
    expect(measurement.actual, `${id} ${measurement.output} ${measurement.width}`).toBeCloseTo(measurement.width, 1);
    expect(measurement.paragraphLeft).toBeCloseTo(0, 1);
    expect(measurement.paddingLeft).toBe("0px");
    expect(measurement.paddingRight).toBe("0px");
    expect(measurement.marginLeft).toBe("0px");
    expect(measurement.marginRight).toBe("0px");
    expect(parseFloat(measurement.fontSize)).toBeGreaterThanOrEqual(15);
  }
});

for (const theme of themes) test(`${theme.id}: long URLs continue after Chinese labels and reference numbers`, async ({ page }) => {
  await page.goto(`/tests/theme-quotes.html?theme=${theme.id}&urls=1`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  for (const width of [300, 380, 620]) {
    const metrics = await page.locator("[data-output]").evaluateAll((hosts, width) => hosts.map(host => {
      const article = host.shadowRoot!.querySelector<HTMLElement>("section")!;
      article.style.width = `${width}px`;
      article.style.boxSizing = "border-box";
      const firstRect = (node: Node, start = 0) => {
        if (node.nodeType !== Node.TEXT_NODE) node = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 1);
        return range.getBoundingClientRect();
      };
      const paragraph = article.querySelector("p")!;
      const label = paragraph.firstChild!;
      const url = paragraph.querySelector<HTMLElement>('span[style*="word-break"]')!;
      const number = article.querySelector('li > span')!;
      const reference = number.parentElement!.querySelector<HTMLElement>('span[style*="word-break"]')!;
      const english = document.createTreeWalker([...article.querySelectorAll("p")].find(p => p.textContent!.startsWith("English"))!, NodeFilter.SHOW_TEXT).nextNode()!;
      const word = document.createRange(), from = english.textContent!.indexOf("Distillation");
      word.setStart(english, from); word.setEnd(english, from + "Distillation".length);
      return { output: (host as HTMLElement).dataset.output,
        labelGap: Math.abs(firstRect(label).top - firstRect(url.firstChild!).top),
        referenceGap: Math.abs(firstRect(number.firstChild!).top - firstRect(reference.firstChild!).top),
        overflow: article.scrollWidth - article.clientWidth,
        wordLines: new Set([...word.getClientRects()].map(r => Math.round(r.top))).size,
        codeWrapped: article.querySelectorAll('code span[style*="word-break"]').length };
    }), width);
    for (const metric of metrics) {
      const context = `${theme.id} ${metric.output} width=${width}`;
      expect(metric.labelGap, context).toBeLessThan(1);
      expect(metric.referenceGap, context).toBeLessThan(1);
      expect(metric.overflow, context).toBeLessThanOrEqual(1);
      expect(metric.wordLines, context).toBe(1);
      expect(metric.codeWrapped, context).toBe(0);
    }
  }
});

for (const theme of themes) for (const newline of ["lf", "crlf"]) {
  test(`${theme.id} ${newline}: single/multiple quote paragraphs and all callouts`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/tests/theme-quotes.html?theme=${theme.id}&newline=${newline}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    const editor = page.locator(".ProseMirror");
    await expect(editor.locator(":scope > blockquote")).toHaveCount(15);
    await expect(editor.locator("blockquote[data-callout]")).toHaveCount(13);

    for (const reading of [false, true, false]) {
      await page.getByLabel("阅读模式").setChecked(reading);
      await expect(editor).toHaveAttribute("contenteditable", String(!reading));
      const measurements = await page.evaluate(() => {
        function measure(root: Element) {
          return [...root.querySelectorAll(":scope > blockquote")].map(quote => {
            const paragraphs = [...quote.querySelectorAll<HTMLElement>(":scope > p")];
            return paragraphs.map((paragraph, index) => {
              const style = getComputedStyle(paragraph);
              return {
                top: parseFloat(style.marginTop), bottom: parseFloat(style.marginBottom),
                gap: index ? paragraph.getBoundingClientRect().top - paragraphs[index - 1].getBoundingClientRect().bottom : null,
              };
            });
          });
        }
        return [measure(document.querySelector(".ProseMirror")!),
          ...[...document.querySelectorAll<HTMLElement>("[data-output]")].map(host => measure(host.shadowRoot!.querySelector("section")!))];
      });
      expect(measurements).toHaveLength(4);
      for (const [output, quotes] of measurements.entries()) {
        expect(quotes, `output ${output}, reading ${reading}`).toHaveLength(15);
        for (const [quoteIndex, paragraphs] of quotes.entries()) {
          expect(paragraphs).toHaveLength(quoteIndex === 0 ? 1 : 3);
          for (const [index, paragraph] of paragraphs.entries()) {
            if (output === 0) {
              expect(paragraph.top).toBe(0);
              expect(paragraph.bottom).toBe(index === paragraphs.length - 1 ? 0 : 18);
              if (paragraph.gap !== null) expect(paragraph.gap).toBeCloseTo(18, 1);
              continue;
            }
            expect(paragraph.top, `output ${output} quote ${quoteIndex} paragraph ${index} top`).toBe(theme.top);
            expect(paragraph.bottom, `output ${output} quote ${quoteIndex} paragraph ${index} bottom`)
              .toBe(index === paragraphs.length - 1 ? theme.end : theme.bottom);
            if (paragraph.gap !== null) expect(paragraph.gap).toBeCloseTo(Math.max(theme.top, theme.bottom), 1);
          }
        }
      }
    }
    await page.getByRole("button", { name: "核对原文" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-source-unchanged", "true");
    expect(errors).toEqual([]);
  });
}
