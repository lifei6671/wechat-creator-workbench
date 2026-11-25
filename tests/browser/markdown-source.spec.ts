import { expect, test, type Page } from "@playwright/test";

async function selectSource(page: Page, text: string) {
  await page.locator("[data-markdown-source]").evaluate((element, text) => {
    const from = element.textContent!.indexOf(text);
    if (from < 0) throw new Error(`Missing source: ${text}`);
    const point = (offset: number): [Node, number] => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (offset <= node.textContent!.length) return [node, offset];
        offset -= node.textContent!.length;
      }
      throw new Error("Missing source selection boundary");
    };
    const [start, startOffset] = point(from), [end, endOffset] = point(from + text.length);
    document.getSelection()!.setBaseAndExtent(start, startOffset, end, endOffset);
    document.dispatchEvent(new Event("selectionchange"));
  }, text);
}

for (const footnotes of [false, true]) test(`select, remove and edit nested Markdown markers (footnotes=${footnotes})`, async ({ page }) => {
  await page.goto(`/tests/markdown-source.html${footnotes ? "?footnotes" : ""}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const editor = page.locator(".ProseMirror");
  await editor.locator("h1 strong").click();
  await editor.locator('[data-markdown="# "]').click();
  const source = editor.locator("[data-markdown-source]");
  await expect(source).toContainText('# **[老实写作业');
  // A real keyboard deletion spans block and inline delimiters together.
  await selectSource(page, "# **[");
  await page.keyboard.press("Backspace");
  await expect.poll(() => page.evaluate(() => window.markdown())).toMatch(/^老实写作业/);
  await selectSource(page, "](https://linux.do/t/topic/3223667)**");
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "外部控件" }).click();
  await expect(editor.locator("h1, strong, a")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("老实写作业，很枯燥吧？ | Panache 开源全平台手写生成工具\n\n后文");
});

test("edits a link destination and heading level and preserves source through undo", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('# **[标题](https://example.com)**\n\n后文'));
  const editor = page.locator(".ProseMirror");
  await editor.locator("h1 strong").click();
  await editor.locator('.rich-strong-delimiter').first().click();
  await selectSource(page, "https://example.com");
  await page.keyboard.insertText("https://example.org/new");
  await selectSource(page, "# ");
  await page.keyboard.insertText("## ");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe('## **[标题](https://example.org/new)**\n\n后文');
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => page.evaluate(() => window.markdown())).toContain('https://example.org/new');
  await page.getByRole("button", { name: "外部控件" }).click();
  await expect(editor.locator('a[href="https://example.org/new"]')).toHaveText("标题");
});

for (const [source, marker] of [["> **引用**", "> "], ["- **列表**", "- "], ["- [ ] 任务", "- [ ] "], ["*斜体* 与 ~~删除~~", "*"]]) {
  test(`edits markers in ${source}`, async ({ page }) => {
    await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent(source + "\n\n后文"));
    const editor = page.locator(".ProseMirror");
    await editor.locator("strong, em, li p").first().click();
    const canonical = source.replace(/^- /, "* ");
    await editor.locator(".rich-markdown-syntax").filter({ hasText: marker }).first().click();
    await expect(editor.locator("[data-markdown-source]")).toContainText(canonical);
    await selectSource(page, canonical);
    await page.keyboard.insertText("已改为正文");
    await editor.locator(":scope > p").last().click();
    await expect(editor.locator("[data-markdown-source]")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.markdown())).toBe("已改为正文\n\n后文");
  });
}

test("supports keyboard entry, source paste, line breaks and undo after restoring formatting", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('## 标题\n\n后文'));
  const editor = page.locator(".ProseMirror");
  await editor.locator("h2").click();
  await editor.focus();
  await expect(editor.locator('[data-markdown="## "]')).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(editor.locator("[data-markdown-source]")).toHaveText("## 标题");
  await page.keyboard.press("ControlOrMeta+a");
  await page.evaluate(() => window.pasteSource("**新标题**"));
  await expect(editor.locator("[data-markdown-source]")).toHaveText("**新标题**");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("下一行");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("**新标题**\n下一行\n\n后文");
  await editor.locator(":scope > p").last().click();
  await expect(editor.locator("strong")).toHaveText("新标题");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => page.evaluate(() => window.markdown())).not.toContain("下一行");
});

test("places the caret at a later repeated delimiter and supports a mouse selection across markers", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('**第一段** 和 **第二段**\n\n后文'));
  const editor = page.locator(".ProseMirror");
  await editor.locator("strong").last().click();
  await expect(editor.locator(".rich-strong-delimiter").first()).toBeVisible();
  await editor.locator("strong").last().click();
  await expect(editor.locator('.rich-strong-delimiter input').first()).toHaveAttribute("data-position", "7");
  await editor.locator('.rich-strong-delimiter').first().click();
  await expect.poll(() => page.locator("[data-markdown-source]").evaluate(element => {
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.anchorNode!, selection.anchorOffset);
    return range.toString().length;
  })).toBe(10);
  await page.keyboard.insertText("这里");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("**第一段** 和 这里**第二段**\n\n后文");
  const box = await editor.locator("[data-markdown-source]").boundingBox();
  await page.mouse.move(box!.x + 1, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 1, box!.y + box!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()!.toString())).toBe("**第一段** 和 这里**第二段**");
  await page.keyboard.press("Backspace");
  await page.getByRole("button", { name: "外部控件" }).click();
  await expect(editor.locator(":scope > p").first()).toHaveText("");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("<br />\n\n后文");
});

test("allows deleting code fences together with their language", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('```js\nconst x = 1;\n```\n\n后文'));
  const editor = page.locator(".ProseMirror");
  await editor.locator("code").click();
  await editor.locator(".rich-code-fence-open").click({ position: { x: 2, y: 5 } });
  await expect(editor.locator("[data-markdown-source]")).toContainText("```js");
  await selectSource(page, "```js\n");
  await page.keyboard.press("Backspace");
  await selectSource(page, "\n```");
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "外部控件" }).click();
  await expect(editor.locator("pre")).toHaveCount(0);
  await expect(editor.locator(":scope > p").first()).toHaveText("const x = 1;");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("const x \\= 1;\n\n后文");
});

test("preserves footnotes and inline images when restoring an edited block", async ({ page }) => {
  const source = '**正文**[^1] ![图片](https://example.com/image.png)\n\n后文\n\n[^1]: 脚注内容';
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent(source));
  const editor = page.locator(".ProseMirror");
  await editor.locator("strong").click();
  await editor.locator('.rich-strong-delimiter').first().click();
  await expect(editor.locator("[data-markdown-source]")).toContainText("[^1]");
  await selectSource(page, "正文");
  await page.keyboard.insertText("修改正文");
  await page.getByRole("button", { name: "外部控件" }).click();
  await expect(editor.locator('sup[data-type="footnote_reference"]')).toHaveCount(1);
  await expect(editor.locator('dl[data-type="footnote_definition"]')).toHaveCount(1);
  await expect(editor.locator('.rich-image')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.markdown())).toContain("![图片](https://example.com/image.png)");
  await expect.poll(() => page.evaluate(() => window.markdown())).toContain("**修改正文**[^1]");
});

test("restores formatting when reading mode changes without a blur", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('## **标题**\n\n后文'));
  const editor = page.locator(".ProseMirror");
  await editor.locator("strong").click();
  await editor.locator('[data-markdown="## "]').click();
  await expect(editor.locator("[data-markdown-source]")).toHaveCount(1);
  await page.evaluate(() => window.setReading(true));
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(editor.locator("[data-markdown-source]")).toHaveCount(0);
  await expect(editor.locator("h2 strong")).toHaveText("标题");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("## **标题**\n\n后文");
});

test("applies an image upload completed while its block is being edited as source", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?upload&source=' + encodeURIComponent('**正文** ![图片](asset://local)\n\n后文'));
  const editor = page.locator(".ProseMirror");
  await editor.locator("strong").click();
  await editor.locator('.rich-strong-delimiter').first().click();
  await expect(editor.locator("[data-markdown-source]")).toContainText("asset://local");
  await page.evaluate(() => window.completeUpload());
  await page.getByRole("button", { name: "外部控件" }).click();
  await expect.poll(() => page.evaluate(() => window.markdown())).toContain("![图片](https://example.com/uploaded.png)");
});

test("edits the selected marker in a later list item", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('- 第一项\n- 第二项\n\n后文'));
  const editor = page.locator(".ProseMirror");
  await editor.locator("li p").last().click();
  await expect(editor.locator(".rich-markdown-syntax").first()).toBeVisible();
  await editor.locator("li p").last().click();
  await editor.locator('[data-markdown="- "]').click();
  await page.keyboard.insertText("这里");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("* 第一项\n这里* 第二项\n\n后文");
});

for (const restoreBeforeResult of [false, true]) test(`keeps a manual image upload through source editing (restoreBeforeResult=${restoreBeforeResult})`, async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('**正文** ![图片](https://example.com/original.png)\n\n后文'));
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const editor = page.locator(".ProseMirror");
  await page.evaluate(() => window.startHostUpload());
  await editor.locator("strong").click();
  await editor.locator('.rich-strong-delimiter').first().click();
  await expect(editor.locator("[data-markdown-source]")).toHaveCount(1);
  await selectSource(page, "正文");
  await page.keyboard.insertText("修改正文");
  if (restoreBeforeResult) await page.getByRole("button", { name: "外部控件" }).click();
  expect(await page.evaluate(() => window.finishHostUpload())).toBe(1);
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("**修改正文** ![图片](https://example.com/hosted.png)\n\n后文");
});

test("does not apply a pending image upload after its source URL was changed", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('**正文** ![图片](https://example.com/original.png)\n\n后文'));
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const editor = page.locator(".ProseMirror");
  await page.evaluate(() => window.startHostUpload());
  await editor.locator("strong").click();
  await editor.locator('.rich-strong-delimiter').first().click();
  await selectSource(page, "https://example.com/original.png");
  await page.keyboard.insertText("https://example.com/changed.png");
  expect(await page.evaluate(() => window.finishHostUpload())).toBe(0);
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("**正文** ![图片](https://example.com/changed.png)\n\n后文");
});

for (const replacement of ["", "![", "只保留说明文字"]) test(`allows replacing image Markdown with ${JSON.stringify(replacement)}`, async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('![图](https://example.com/image.gif)\n\n后文'));
  const editor = page.locator(".ProseMirror");
  const button = editor.getByRole("button", { name: "图片源码", exact: true });
  await button.focus();
  await button.press("Enter");
  const field = editor.getByLabel("图片 Markdown 源码");
  await field.fill(replacement);
  await field.press("Enter");
  await expect(editor.locator(".rich-image")).toHaveCount(0);
  await expect(editor.locator('[role="alert"]')).toHaveCount(0);
  await expect(editor.locator(":scope > p").first()).toHaveText(replacement);
  await expect.poll(() => page.evaluate(() => window.markdown())).not.toContain("https://example.com/image.gif");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator(".rich-image")).toHaveCount(1);
});

test("moves past a closing bold marker to edit the space before a link", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('**官方网站：** <https://www.crossdesk.cn/>'));
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.locator("strong").evaluate(element => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    document.getSelection()!.collapse(text, text.textContent!.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => window.selectionFrom())).toBe(6);
  await page.keyboard.press("ArrowRight");
  await expect(editor.locator("[data-markdown-source]")).toHaveCount(1);
  await page.keyboard.insertText(" ");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("**官方网站：**  <https://www.crossdesk.cn/>");
  await selectSource(page, "**");
  await page.keyboard.press("Backspace");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("官方网站：**  <https://www.crossdesk.cn/>");
});

for (const footnotes of [false, true]) for (const key of ["Backspace", "Delete"]) {
  test(`joins a bold label and URL across a paragraph boundary (${key}, footnotes=${footnotes})`, async ({ page }) => {
    await page.goto('/tests/markdown-source.html?' + (footnotes ? 'footnotes&' : '') + 'source='
      + encodeURIComponent('**网页版：**\n\n<https://web.crossdesk.cn/>'));
    const editor = page.locator(".ProseMirror");
    await editor.focus();
    const paragraph = editor.locator(":scope > p").nth(key === "Backspace" ? 1 : 0);
    await paragraph.evaluate((element, key) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      const nodes: Node[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const node = key === "Backspace" ? nodes[0] : nodes.at(-1)!;
      document.getSelection()!.collapse(node, key === "Backspace" ? 0 : node.textContent!.length);
      document.dispatchEvent(new Event("selectionchange"));
    }, key);
    await expect.poll(() => page.evaluate(() => window.selectionFrom())).toBe(key === "Backspace" ? 7 : 5);
    await page.keyboard.press(key);
    await expect(editor.locator("[data-markdown-source]")).toHaveText("**网页版：**<https://web.crossdesk.cn/>");
    await page.keyboard.insertText(" ");
    await expect.poll(() => page.evaluate(() => window.markdown())).toBe("**网页版：** <https://web.crossdesk.cn/>");
  });
}

test("moves before an opening angle bracket and edits the preceding paragraph breaks", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('**网页版：**\n\n<https://web.crossdesk.cn/>'));
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.locator("a").evaluate(element => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    document.getSelection()!.collapse(text, 0);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => window.selectionFrom())).toBe(7);
  await page.keyboard.press("ArrowLeft");
  await expect(editor.locator("[data-markdown-source]")).toHaveText("<https://web.crossdesk.cn/>");
  await page.keyboard.press("ArrowLeft");
  await expect(editor.locator("[data-markdown-source]")).toHaveText("**网页版：**\n\n<https://web.crossdesk.cn/>");
  await selectSource(page, "\n\n");
  await page.keyboard.press("Delete");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("**网页版：**<https://web.crossdesk.cn/>");
});

test("edits whitespace between adjacent inline formats after the closing marker", async ({ page }) => {
  await page.goto('/tests/markdown-source.html?source=' + encodeURIComponent('*前文*~~后文~~'));
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.locator("em").evaluate(element => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    document.getSelection()!.collapse(text, text.textContent!.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => window.selectionFrom())).toBe(3);
  await page.keyboard.press("ArrowRight");
  await expect(editor.locator("[data-markdown-source]")).toHaveText("*前文*~~后文~~");
  await page.keyboard.insertText(" ");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe("*前文* ~~后文~~");
});

for (const footnotes of [false, true]) test(`preserves bold styling while the caret edits the gap before a link (footnotes=${footnotes})`, async ({ page }) => {
  const markdown = '**官方网站：** <https://www.crossdesk.cn/>';
  await page.goto('/tests/markdown-source.html?' + (footnotes ? 'footnotes&' : '') + 'source=' + encodeURIComponent(markdown));
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  const weight = await editor.locator("strong").evaluate(element => getComputedStyle(element).fontWeight);
  await editor.locator("strong").evaluate(element => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    document.getSelection()!.collapse(text, text.textContent!.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => window.selectionFrom())).toBe(6);
  await page.keyboard.press("ArrowRight");
  const source = editor.locator("[data-markdown-source]");
  await expect(source).toHaveText(markdown);
  await expect(source.locator("strong")).toHaveText("官方网站：");
  expect(await source.locator("strong").evaluate(element => getComputedStyle(element).fontWeight)).toBe(weight);
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe(markdown);
  await page.keyboard.insertText(" ");
  await expect(source.locator("strong")).toHaveText("官方网站：");
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe('**官方网站：**  <https://www.crossdesk.cn/>');
  await selectSource(page, "**");
  await page.keyboard.press("Backspace");
  await expect(source.locator("strong")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.markdown())).toBe('官方网站：**  <https://www.crossdesk.cn/>');
});
