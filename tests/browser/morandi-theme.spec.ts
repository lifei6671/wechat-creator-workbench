import { expect, test } from "@playwright/test";

for (const appearance of ["light", "dark"]) for (const width of [390, 1200]) {
  test(`Morandi: ${appearance}, viewport ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/tests/morandi-theme.html?appearance=${appearance}`);
    const preview = page.getByRole("region", { name: "公众号排版预览" });
    await expect(preview).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
    await expect(page.locator(".preview-phone-screen")).toHaveClass(new RegExp(appearance));
    await expect(preview.locator('img[alt="Mermaid 图表"]')).toHaveCount(1);
    const screenshot = preview.locator('img[alt="软件截图"]');
    await expect(screenshot.locator("..").locator("span").last()).toHaveText("软件截图");
    const metrics = await preview.evaluate(host => {
      const root = host.shadowRoot!.querySelector<HTMLElement>("article > div > section")!;
      const background = getComputedStyle(host.closest(".preview-phone-screen")!).backgroundColor;
      function contrast(color: string, background: string) {
        const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const a = luminance(color), b = luminance(background);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      }
      const code = root.querySelector<HTMLElement>("pre")!;
      const prose = [...root.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,strong,em,a")].filter(node => !node.closest("pre"));
      return {
        rootColor: root.style.color, rootBackground: root.style.backgroundColor,
        contrast: prose.map(node => contrast(getComputedStyle(node).color, background)),
        codeContrast: [...code.querySelectorAll<HTMLElement>("code,code span")].map(node => contrast(getComputedStyle(node).color, getComputedStyle(code).backgroundColor)),
        font: getComputedStyle(root.querySelector("p")!).fontSize,
        lineHeight: getComputedStyle(root.querySelector("p")!).lineHeight,
        overflow: root.scrollWidth - root.clientWidth,
        headings: [...root.querySelectorAll<HTMLElement>(":scope > :is(h1,h2,h3,h4,h5,h6)")].slice(0, 6).map(node => getComputedStyle(node).fontSize),
        caption: [...root.querySelectorAll<HTMLElement>("p")].find(node => node.textContent?.startsWith("图 1："))?.style.fontSize,
        width: root.clientWidth,
      };
    });
    expect(metrics.rootColor).toBe("inherit");
    expect(["", "transparent"]).toContain(metrics.rootBackground);
    expect(Math.min(...metrics.contrast)).toBeGreaterThanOrEqual(4.5);
    expect(Math.min(...metrics.codeContrast)).toBeGreaterThanOrEqual(4.5);
    expect(metrics.font).toBe("16px");
    expect(parseFloat(metrics.lineHeight)).toBeCloseTo(29.6, 1);
    expect(metrics.headings).toEqual(["22px", "19px", "17px", "16px", "15px", "14px"]);
    expect(metrics.caption).toBe("13px");
    expect(metrics.overflow).toBeLessThanOrEqual(1);
    expect(metrics.width).toBeGreaterThan(200);
    const originalExport = await page.evaluate(() => window.morandiTest.export("html"));
    const requests = await page.evaluate(() => window.morandiTest.graphicRequests());
    const source = await page.evaluate(() => window.morandiTest.source);
    await preview.evaluate(host => { host.scrollTop = 120; Object.assign(window, { morandiSection: host.shadowRoot!.querySelector("article > div > section") }); });
    await page.evaluate(dark => window.morandiTest.setAppearance(dark ? "dark" : "light"), appearance === "light");
    await expect(page.locator(".preview-phone-screen")).toHaveClass(new RegExp(appearance === "dark" ? "light" : "dark"));
    expect(await page.evaluate(() => window.morandiTest.graphicRequests())).toBe(requests);
    expect(await preview.evaluate(host => host.shadowRoot!.querySelector("article > div > section") === Reflect.get(window, "morandiSection"))).toBe(true);
    expect(await preview.evaluate(host => host.scrollTop)).toBe(120);
    expect(await page.evaluate(() => window.morandiTest.export("html"))).toBe(originalExport);
    expect(await page.evaluate(() => window.morandiTest.source)).toBe(source);
    await page.evaluate(value => window.morandiTest.setAppearance(value), appearance as "light" | "dark");
    await preview.evaluate(host => { host.scrollTop = 0; });
    await page.screenshot({ path: `output/playwright/morandi-${appearance}-${width}-${test.info().project.name}.png` });
    expect(errors).toEqual([]);
  });
}

test("selects publication styles from the preview footer without changing Markdown", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 950 });
  await page.goto("/tests/morandi-theme.html");
  const picker = page.getByRole("button", { name: /^公众号主题：/ });
  await expect(picker).toBeVisible({ timeout: 10_000 });
  const source = await page.evaluate(() => window.morandiTest.source);
  await picker.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemradio", { name: "莫兰迪", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "技术风格", exact: true }).click();
  await expect(picker).toHaveText("技术风格");
  await picker.click();
  await expect(page.getByRole("menuitemradio", { name: "技术风格", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "莫兰迪", exact: true }).click();
  await expect(picker).toHaveText("莫兰迪");
  expect(await page.evaluate(() => window.morandiTest.source)).toBe(source);
  for (const appearance of ["light", "dark"] as const) {
    await page.evaluate(value => window.morandiTest.setAppearance(value), appearance);
    await picker.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("animation-name", "none");
    await expect(menu).toHaveCSS("transition-duration", "0s");
    await expect(menu).toHaveCSS("transform", "none");
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ animations: "disabled", path: `output/playwright/preview-theme-picker-${appearance}-${test.info().project.name}.png` });
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
  }
  await page.goto("/tests/morandi-theme.html?locked=1");
  await expect(page.getByRole("button", { name: /^公众号主题：/ })).toBeDisabled();
});

test("Morandi reuses theme selection and manual preview appearance controls", async ({ page }) => {
  await page.goto("/tests/morandi-theme.html");
  const preview = page.getByRole("region", { name: "公众号排版预览" });
  await expect(preview).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await expect(page.locator(".preview-phone-screen")).toHaveClass(/dark/);
  await page.getByLabel("选择测试主题").selectOption("plainly-default");
  await expect(page.locator(".preview-theme-label")).toHaveText("默认公众号风格");
  await page.getByLabel("选择测试主题").selectOption("morandi");
  await expect(page.locator(".preview-theme-label")).toHaveText("莫兰迪");
  await expect(page.locator(".preview-phone-screen")).toHaveClass(/light/);
});

test("registers Morandi in the existing publication panel and preserves the saved Markdown", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html");
  const saved = page.getByTestId("saved");
  const original = JSON.parse((await saved.textContent())!);
  await page.getByRole("combobox", { name: "排版主题", exact: true }).click();
  await page.getByRole("option", { name: "莫兰迪", exact: true }).click();
  await expect.poll(async () => JSON.parse((await saved.textContent())!).themeId).toBe("morandi");
  expect(JSON.parse((await saved.textContent())!).contentMd).toBe(original.contentMd);
});

test("Morandi renders long articles through the existing renderer", async ({ page }) => {
  await page.goto("/tests/morandi-theme.html?long=1");
  const preview = page.getByRole("region", { name: "公众号排版预览" });
  await expect(preview).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  const durations: Record<string, number[]> = { "plainly-tech": [], morandi: [] };
  for (const theme of ["plainly-tech", "morandi", "plainly-tech", "morandi"]) {
    const start = performance.now();
    await page.evaluate(theme => window.morandiTest.setTheme(theme), theme);
    await expect(page.locator(".preview-theme-label")).toHaveText(theme === "morandi" ? "莫兰迪" : "技术风格", { timeout: 30_000 });
    durations[theme].push(performance.now() - start);
  }
  expect(await preview.locator("p").count()).toBeGreaterThan(400);
  console.log(`Warm long article render (${test.info().project.name}): ${JSON.stringify(durations)}`);
});
