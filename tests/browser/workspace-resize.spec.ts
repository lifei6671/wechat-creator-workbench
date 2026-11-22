import { expect, test, type Page } from "@playwright/test";

async function mockNativeWindow(page: Page, platform: string) {
  await page.addInitScript(platform => {
    Object.defineProperty(navigator, "platform", { value: platform });
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command: string) => {
          if (command === "plugin:window|is_maximized") return false;
          if (command === "plugin:event|listen") return 1;
          if (command === "plugin:event|unlisten") return;
          throw new Error(`Unexpected native call: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    });
  }, platform);
}

for (const appearance of ["light", "dark"]) test(`highlights Windows minimize and maximize controls on hover in ${appearance}`, async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.addInitScript(appearance => localStorage.setItem("appearance", JSON.stringify(appearance)), appearance);
  await page.goto("/tests/workspace-resize.html?priority=1");
  const controls = page.getByRole("group", { name: "窗口控制", exact: true });
  const base = await controls.evaluate(element => getComputedStyle(element).backgroundColor);
  for (const name of ["最小化", "最大化"]) {
    const button = controls.getByRole("button", { name, exact: true });
    await button.hover();
    const colors = await button.evaluate(element => {
      const probe = document.createElement("span");
      probe.style.color = "var(--sand-4)";
      element.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { background: getComputedStyle(element).backgroundColor, expected };
    });
    expect(colors.background).toBe(colors.expected);
    expect(colors.background).not.toBe(base);
  }
});

for (const platform of ["Win32", "MacIntel"]) test(`keeps the workspace and sidebar alive while resizing on ${platform}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1360, height: 840 });
  await page.goto("/tests/workspace-resize.html");
  await expect(page.locator("#tab-resize")).toBeVisible();
  await expect(page.locator(".ai-panel")).toBeVisible();
  for (const width of [2258, 1000, 1360, 1100, 1120, 1800, 1000, 2258, 1360]) {
    await page.setViewportSize({ width, height: 840 });
  }
  await expect(page.locator(".workspace-shell"), errors.join("\n")).toBeVisible();
  if (!await page.locator("#right-sidebar-ai-button").isVisible()) await page.locator("#ai-panel-trigger").click();
  await expect.poll(async () => (await page.locator(".right-sidebar").boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
  for (const width of [2258, 1200, 1000, 1920, 1360]) {
    await page.setViewportSize({ width, height: 840 });
    await expect(page.locator(".workspace-shell"), errors.join("\n")).toBeVisible();
    for (const name of ["AI 助手", "内容属性", "公众号设置", "文档大纲"]) {
      await page.mouse.move(500, 400);
      await page.getByRole("button", { name, exact: true }).hover();
      await expect(page.getByRole("tooltip")).toHaveText(name);
      await page.setViewportSize({ width: width + 10, height: 850 });
      await expect(page.locator(".workspace-shell"), errors.join("\n")).toBeVisible();
      await page.getByRole("button", { name, exact: true }).click();
    }
  }
  expect(errors).toEqual([]);
});

for (const platform of ["Win32", "MacIntel"]) test(`uses the shared sidebar for outline navigation without changing WeChat view on ${platform}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1360, height: 840 });
  await page.goto("/tests/workspace-resize.html?priority=1");
  const body = page.locator("#document-body");
  await expect(body).toHaveAttribute("data-view", "preview");
  await page.getByRole("button", { name: "公众号设置", exact: true }).click();
  await expect(body).toHaveAttribute("data-view", "preview");
  await page.getByRole("button", { name: "文档大纲", exact: true }).click();
  const outline = page.locator(".right-sidebar .document-outline");
  await expect(outline).toBeVisible();
  await expect(body.locator(".document-outline")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "隐藏文档大纲", exact: true })).toHaveCount(0);
  const background = await page.locator(".right-sidebar").evaluate(element => getComputedStyle(element).backgroundColor);
  expect(await outline.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(background);
  await expect(outline.locator(".outline-heading")).toHaveText(["正文", "子节", "第二节"]);
  await page.getByRole("textbox", { name: "搜索标题", exact: true }).fill("子节");
  await expect(outline.locator(".outline-heading")).toHaveText(["正文", "子节"]);
  await page.getByRole("textbox", { name: "搜索标题", exact: true }).press("Escape");
  await outline.getByRole("button", { name: "第二节", exact: true }).click();
  await expect(body).toHaveAttribute("data-view", "edit");
  await expect(body.locator(".editor-stack")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest("h2")?.textContent)).toBe("## 第二节");
  await expect(outline.locator('[aria-current="location"]')).toHaveText("第二节");
  await page.getByRole("button", { name: "公众号设置", exact: true }).click();
  await expect(body).toHaveAttribute("data-view", "edit");
  await page.getByRole("button", { name: "文档大纲", exact: true }).click();
  await expect(outline).toBeVisible();
  await page.getByRole("button", { name: "隐藏右侧栏", exact: true }).click();
  await expect(outline).toHaveCount(0);
  await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await expect(outline).toBeVisible();
  await outline.getByRole("button", { name: "折叠 正文", exact: true }).click();
  await expect(outline.locator(".outline-heading:visible")).toHaveText(["正文", "第二节"]);
  await page.setViewportSize({ width: 1000, height: 840 });
  const last = (await page.getByRole("button", { name: "文档大纲", exact: true }).boundingBox())!;
  if (platform === "Win32") {
    const controls = (await page.getByRole("group", { name: "窗口控制", exact: true }).boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(controls.x);
  }
  const firstRow = outline.locator(".outline-row").filter({ has: page.getByRole("button", { name: "正文", exact: true }) });
  const lastRow = outline.locator(".outline-row").filter({ has: page.getByRole("button", { name: "第二节", exact: true }) });
  await firstRow.hover();
  const grip = (await firstRow.locator("[data-outline-grip]").boundingBox())!;
  const target = (await lastRow.boundingBox())!;
  const pointerX = grip.x + grip.width / 2;
  await page.mouse.move(pointerX, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(pointerX, target.y + target.height - 4, { steps: 5 });
  const indicator = outline.locator('.outline-drop-indicator');
  await expect(indicator).toBeVisible();
  await expect(outline.locator('.tree-drag-ghost')).toHaveCount(0);
  await page.mouse.move(pointerX, target.y + target.height + 48, { steps: 3 });
  await expect(indicator).toBeVisible();
  await expect(outline.locator('li[data-placement="after"] > .outline-row > .outline-heading')).toHaveText("第二节");
  const afterLine = (await indicator.boundingBox())!;
  const anchor = (await lastRow.locator('..').boundingBox())!;
  expect(afterLine.y + afterLine.height).toBeCloseTo(anchor.y + anchor.height, 0);
  expect(afterLine.height).toBeGreaterThan(0);
  expect(afterLine.height).toBeLessThanOrEqual(1);
  expect(afterLine.width).toBeGreaterThan(target.width * 0.75);
  const outlineBounds = (await outline.boundingBox())!;
  await page.screenshot({ path: test.info().outputPath('outline-insertion-after.png'),
    clip: { x: outlineBounds.x, y: outlineBounds.y, width: outlineBounds.width, height: Math.min(outlineBounds.height, 160) } });
  await page.mouse.move(pointerX - 20, target.y + target.height + 80, { steps: 2 });
  expect(await indicator.boundingBox()).toEqual(afterLine);
  await page.mouse.up();
  await expect(indicator).toHaveCount(0);
  await expect(outline.locator('.outline-list > ul > li > .outline-row > .outline-heading')).toHaveText(["第二节", "正文"]);
  await expect.poll(async () => (await body.locator('.document-editor:not([hidden]) .ProseMirror h2').allTextContents())
    .map(title => title.replace(/^#+\s*/, ""))).toEqual(["第二节", "正文"]);
  await firstRow.hover();
  const endGrip = (await firstRow.locator("[data-outline-grip]").boundingBox())!;
  await page.mouse.move(endGrip.x + endGrip.width / 2, endGrip.y + endGrip.height / 2);
  await page.mouse.down();
  await page.mouse.move(endGrip.x + endGrip.width / 2, endGrip.y + endGrip.height + 48, { steps: 3 });
  await expect(firstRow).toHaveAttribute('data-dragging', 'true');
  await expect(indicator).toHaveCount(0);
  await expect(outline.locator('.outline-list > ul > li > .outline-row > .outline-heading')).toHaveText(["第二节", "正文"]);
  const beforeRow = (await lastRow.boundingBox())!;
  const beforeAnchor = (await lastRow.locator('..').boundingBox())!;
  await page.mouse.move(endGrip.x + endGrip.width / 2, beforeRow.y + 4, { steps: 3 });
  await expect(outline.locator('li[data-placement="before"] > .outline-row > .outline-heading')).toHaveText("第二节");
  await expect(indicator).toBeVisible();
  const beforeLine = (await indicator.boundingBox())!;
  expect(beforeLine.y).toBeCloseTo(beforeAnchor.y, 0);
  const panel = (await outline.boundingBox())!;
  const freePointerY = Math.round(beforeRow.y + 10);
  await page.mouse.move(panel.x - 24, freePointerY, { steps: 2 });
  await expect(indicator).toHaveCount(0);
  await expect(firstRow).toHaveAttribute('data-dragging', 'true');
  await page.mouse.move(endGrip.x + endGrip.width / 2, beforeRow.y + 4, { steps: 2 });
  await expect(indicator).toBeVisible();
  await page.mouse.up();
  await expect(indicator).toHaveCount(0);
  await expect(outline.locator('.outline-list > ul > li > .outline-row > .outline-heading')).toHaveText(["正文", "第二节"]);
  expect(errors).toEqual([]);
});

for (const platform of ["Win32", "MacIntel"]) test(`preserves the left column and shrinks center before right on ${platform}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1600, height: 840 });
  await page.goto("/tests/workspace-resize.html?priority=1");
  await expect(page.locator(".ai-panel")).toBeVisible();
  const navigation = page.locator('#navigation[data-panel]');
  const writing = page.locator('#writing[data-panel]');
  const right = page.locator('#ai-sidebar[data-panel]');
  const widths = async () => Promise.all([navigation, writing, right].map(async panel => (await panel.boundingBox())!.width));
  await expect.poll(async () => (await widths()).map(Math.round)).toEqual([480, 698, 420]);
  for (const [width, expected] of [[1320, [480, 418, 420]], [1240, [480, 360, 398]], [1140, [480, 358, 300]], [1000, [480, 218, 300]], [1600, [480, 698, 420]]] as const) {
    await page.setViewportSize({ width, height: 840 });
    await expect.poll(async () => (await widths()).map(Math.round)).toEqual([...expected]);
    await expect(page.locator(".ai-panel")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("ai-sidebar-width"))).toBe("420");
    expect(await page.evaluate(() => localStorage.getItem("timeline-article-width"))).toBe("480");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  const separator = page.getByRole("separator", { name: "调整右侧栏宽度", exact: true });
  const bounds = (await separator.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 30, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.evaluate(() => localStorage.getItem("ai-sidebar-width")))).toBeGreaterThan(440);
  const preferred = Number(await page.evaluate(() => localStorage.getItem("ai-sidebar-width")));
  await page.setViewportSize({ width: 1000, height: 840 });
  await expect.poll(async () => (await widths()).map(Math.round)).toEqual([480, 218, 300]);
  await page.setViewportSize({ width: 1600, height: 840 });
  await expect.poll(async () => Math.round((await widths())[2])).toBe(preferred);
  await page.setViewportSize({ width: 1000, height: 840 });
  await expect.poll(async () => (await widths()).map(Math.round)).toEqual([480, 218, 300]);
  const leftSeparator = page.getByRole("separator", { name: "调整文章时间流宽度", exact: true });
  await leftSeparator.press("ArrowRight");
  await expect.poll(async () => Number(await page.evaluate(() => localStorage.getItem("timeline-article-width")))).toBeGreaterThan(480);
  const leftPreferred = Number(await page.evaluate(() => localStorage.getItem("timeline-article-width")));
  await page.setViewportSize({ width: 1000, height: 840 });
  await expect.poll(async () => Math.round((await widths())[0])).toBe(leftPreferred);
  await page.setViewportSize({ width: 1600, height: 840 });
  await expect.poll(async () => Math.round((await widths())[0])).toBe(leftPreferred);
  await expect.poll(async () => Math.round((await widths())[2])).toBe(preferred);
  expect(errors).toEqual([]);
});
