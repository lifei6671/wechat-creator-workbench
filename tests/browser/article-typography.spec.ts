import { expect, test } from "@playwright/test";

for (const appearance of ["light", "dark"]) for (const width of [360, 1200]) {
  test(`technology article: ${appearance}, width=${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tests/article-typography.html?appearance=${appearance}`);
    const editor = page.locator(".ProseMirror");
    await expect(editor.locator(".rich-image img")).toHaveCount(5);
    await expect(editor.locator(".rich-mermaid img")).toBeVisible({ timeout: 30_000 });
    await expect(editor.locator(".rich-formula img")).toHaveCount(2);
    await expect(editor.locator("figcaption")).toHaveText("图 2：通过独立 figcaption 明确保存图片说明。");
    expect(await editor.locator("figcaption").evaluate(element => getComputedStyle(element).fontSize)).toBe("13px");
    for (const reading of [false, true]) {
      await page.evaluate(reading => window.setArticleReading(reading), reading);
      await expect(editor).toHaveAttribute("contenteditable", String(!reading));
      const metrics = await editor.evaluate(root => {
        const style = getComputedStyle(root);
        function contrast(color: string, background: string) {
          const luminance = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number)
            .map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
            .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
          const a = luminance(color), b = luminance(background);
          return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        }
        const background = getComputedStyle(root.closest(".document-editor")!).backgroundColor;
        const image = root.querySelector<HTMLImageElement>('img[alt="小尺寸图片"]')!;
        const caption = image.closest(".rich-image")!.querySelector<HTMLElement>(".rich-image-caption")!;
        const firstImage = root.querySelector<HTMLElement>("p[data-image-block]")!;
        const code = root.querySelector<HTMLElement>(".rich-code-block pre")!;
        const table = root.querySelectorAll<HTMLElement>(".rich-table-scroll")[1];
        const headings = [...root.querySelectorAll<HTMLElement>(":scope > :is(h1,h2,h3,h4,h5,h6)")];
        const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href]:not([href^="#"])')];
        return {
          font: style.fontSize, lineHeight: style.lineHeight,
          contentWidth: root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          overflow: root.scrollWidth - root.clientWidth,
          headings: headings.map(heading => [getComputedStyle(heading).fontSize, getComputedStyle(heading).color]),
          firstMargin: getComputedStyle(headings[0]).marginTop,
          bodyContrast: contrast(style.color, background),
          linkContrast: contrast(getComputedStyle(links[0]).color, background),
          linkDecoration: getComputedStyle(links[0]).textDecorationLine,
          imageWidth: image.getBoundingClientRect().width, naturalWidth: image.naturalWidth,
          captionFont: getComputedStyle(caption).fontSize, captionAlign: getComputedStyle(caption).textAlign,
          captionColor: getComputedStyle(caption).color,
          captionCentered: Math.abs((caption.getBoundingClientRect().left + caption.getBoundingClientRect().right)
            - (image.getBoundingClientRect().left + image.getBoundingClientRect().right)),
          captionBelow: caption.getBoundingClientRect().top - image.getBoundingClientRect().bottom,
          imageCentered: Math.abs((firstImage.getBoundingClientRect().left + firstImage.getBoundingClientRect().right)
            - (firstImage.querySelector(".rich-image-media img")!.getBoundingClientRect().left + firstImage.querySelector(".rich-image-media img")!.getBoundingClientRect().right)),
          inlineImage: root.querySelector('img[alt="行内图标"]')!.closest("p")!.hasAttribute("data-image-block"),
          codeWhiteSpace: getComputedStyle(code).whiteSpace, codeOverflow: code.scrollWidth - code.clientWidth,
          tableOverflow: table.scrollWidth - table.clientWidth,
          tableScroll: getComputedStyle(table).overflowX,
          alignment: getComputedStyle(root.querySelectorAll("td")[1]).textAlign,
        };
      });
      expect(metrics.font).toBe("16px");
      expect(parseFloat(metrics.lineHeight)).toBeCloseTo(28.8, 1);
      expect(metrics.contentWidth).toBeLessThanOrEqual(800);
      expect(metrics.contentWidth).toBeGreaterThan(180);
      expect(metrics.overflow).toBeLessThanOrEqual(1);
      expect(metrics.headings.map(([size]) => size)).toEqual(["32px", "25px", "21px", "18px", "16px", "14px"]);
      expect(new Set(metrics.headings.map(([, color]) => color)).size).toBe(1);
      expect(metrics.firstMargin).toBe("0px");
      expect(metrics.bodyContrast).toBeGreaterThanOrEqual(4.5);
      expect(metrics.linkContrast).toBeGreaterThanOrEqual(4.5);
      expect(metrics.linkDecoration).toContain("underline");
      expect(metrics.imageWidth).toBeLessThanOrEqual(metrics.naturalWidth);
      expect(metrics.captionFont).toBe("13px");
      expect(metrics.captionAlign).toBe("center");
      expect(metrics.captionCentered).toBeLessThanOrEqual(1);
      expect(metrics.captionBelow).toBeGreaterThanOrEqual(8);
      expect(metrics.captionColor).not.toBe(metrics.headings[0][1]);
      expect(metrics.imageCentered).toBeLessThanOrEqual(1);
      expect(metrics.inlineImage).toBe(false);
      expect(metrics.codeWhiteSpace).toBe("pre");
      expect(metrics.codeOverflow).toBeGreaterThan(0);
      expect(metrics.tableScroll).toBe("auto");
      if (width === 360) expect(metrics.tableOverflow).toBeGreaterThan(0);
      expect(metrics.alignment).toBe("right");
    }
    await editor.locator('a[href="https://github.com/lifei6671/wechat-creator-workbench"]').click();
    await expect(page.locator("body")).toHaveAttribute("data-opened-link", "https://github.com/lifei6671/wechat-creator-workbench");
    await editor.locator(".rich-image").first().hover();
    await editor.getByRole("button", { name: "放大图片", exact: true }).first().click();
    await expect(page.locator("body")).toHaveAttribute("data-zoomed-image", "软件截图");
    expect(await page.evaluate(() => window.articleTest.markdown().markdown)).toBe(await page.evaluate(() => window.articleTest.source));
    expect(errors).toEqual([]);
    await page.screenshot({ path: `output/playwright/technology-${appearance}-${width}-${test.info().project.name}.png` });
  });
}

test("keeps editor, selection, Markdown and diagrams while changing appearance and publication theme", async ({ page }) => {
  await page.goto("/tests/article-typography.html");
  const editor = page.locator(".ProseMirror");
  const paragraph = editor.locator(":scope > p").first();
  await expect(editor.locator(".rich-mermaid img")).toBeVisible({ timeout: 30_000 });
  await paragraph.click();
  await paragraph.evaluate(paragraph => {
    const range = document.createRange(); range.setStart(paragraph.firstChild!, 8); range.setEnd(paragraph.firstChild!, 12);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await expect.poll(() => page.evaluate(() => { const selection = window.articleTest.selection(); return selection.to - selection.from; })).toBe(4);
  const original = await page.evaluate(() => {
    window.articleTest.rememberDocument();
    Object.assign(window, { originalEditor: document.querySelector(".ProseMirror"), originalDiagram: document.querySelector(".rich-mermaid img") });
    return { selection: window.articleTest.selection(), snapshot: window.articleTest.markdown() };
  });
  for (const theme of ["gzh-zen-whitespace", "plainly-elegant", "plainly-tech"]) {
    await page.evaluate(theme => { window.articleTest.theme(theme); window.setArticleAppearance("dark"); }, theme);
    expect(await page.evaluate(() => window.articleTest.selection())).toEqual(original.selection);
    expect(await page.evaluate(() => window.articleTest.markdown())).toEqual(original.snapshot);
    expect(await page.evaluate(() => document.querySelector(".ProseMirror") === Reflect.get(window, "originalEditor"))).toBe(true);
    expect(await page.evaluate(() => document.querySelector(".rich-mermaid img") === Reflect.get(window, "originalDiagram"))).toBe(true);
  }
  await page.keyboard.type("回归输入");
  expect((await page.evaluate(() => window.articleTest.markdown())).markdown).toContain("回归输入");
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta" : "Control");
  await page.keyboard.press(`${modifier}+z`);
  expect(await page.evaluate(() => window.articleTest.matchesDocument())).toBe(true);
  await page.keyboard.press(`${modifier}+Shift+z`);
  expect((await page.evaluate(() => window.articleTest.markdown())).markdown).toContain("回归输入");
});

test("keeps table controls positioned after horizontal scrolling and retains cell editing", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto("/tests/article-typography.html");
  const table = page.locator(".rich-table").nth(1);
  await expect(page.locator(".rich-image img")).toHaveCount(5);
  await expect(page.locator(".rich-mermaid img")).toBeVisible({ timeout: 30_000 });
  await page.locator(".ProseMirror").focus();
  await expect(table.locator("td")).toHaveCount(8);
  await table.locator(".rich-table-scroll").evaluate(element => { element.scrollLeft = 250; });
  const cell = table.locator("td").nth(5);
  await cell.hover();
  const grip = table.locator(".rich-table-grip-column");
  await expect(grip).toBeVisible();
  const cellRect = (await cell.boundingBox())!, gripRect = (await grip.boundingBox())!;
  expect(Math.abs(gripRect.x + gripRect.width / 2 - cellRect.x - cellRect.width / 2)).toBeLessThan(1);
  await cell.locator("p").click({ position: { x: 3, y: 8 } });
  await expect.poll(() => page.evaluate(() => window.articleTest.selection().from)).toBeGreaterThan(1000);
  await page.keyboard.type("单元格输入");
  await expect(cell).toContainText("单元格输入");
  await page.evaluate(() => window.articleTest.table("columnAfter"));
  await expect(table.locator("td")).toHaveCount(9);
});

test("long articles keep the same document and editor while typing and switching appearance", async ({ page }) => {
  await page.goto("/tests/article-typography.html?long=1");
  const editor = page.locator(".ProseMirror");
  await expect.poll(() => editor.locator(":scope > p").count()).toBeGreaterThan(500);
  const samples = await editor.evaluate(root => {
    const samples: number[] = [];
    for (let index = 0; index < 20; index++) {
      const start = performance.now();
      window.setArticleAppearance(index % 2 ? "light" : "dark");
      root.getBoundingClientRect();
      samples.push(performance.now() - start);
      if (root !== document.querySelector(".ProseMirror")) throw new Error("Theme recreated editor");
    }
    return samples.sort((a, b) => a - b);
  });
  const lastParagraph = editor.locator(":scope > p").last();
  const originalLastParagraph = await lastParagraph.innerText();
  await lastParagraph.click();
  await lastParagraph.evaluate(paragraph => {
    const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.type("追加内容");
  await expect(lastParagraph).toHaveText(originalLastParagraph + "追加内容");
  expect(await page.evaluate(() => window.articleTest.markdown().markdown)).toContain(originalLastParagraph + "追加内容");
  console.log(`Long article theme/layout p95 (${test.info().project.name}): ${samples[18].toFixed(2)} ms`);
  test.info().annotations.push({ type: "theme-layout-p95-ms", description: samples[18].toFixed(2) });
});
