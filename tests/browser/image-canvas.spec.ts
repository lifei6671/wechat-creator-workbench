import { expect, test, type Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.imageCanvasTest.snapshot());
function luminance(color: string) {
  const rgb = color.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
async function open(page: Page, query = "") {
  await page.goto(`/tests/image-canvas.html${query}`);
  await expect(page.getByRole("heading", { name: "编辑图片", exact: true })).toBeVisible();
  await expect(page.locator(".ic-error")).toHaveText("");
  await expect(page.getByRole("button", { name: "应用到文章", exact: true })).toBeEnabled();
}

test("exports WebP by default", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "WebP", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "复制成品", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).completed).toBe(1);
  expect((await snapshot(page)).output!.mime).toBe("webp");
});

for (const target of ["title", "padding", "keyboard"]) test(`returns from the whole top-left region (${target})`, async ({ page }) => {
  await open(page);
  await page.getByRole("slider", { name: "圆角", exact: true }).press("ArrowRight");
  const bar = (await page.locator(".ic-document-bar").boundingBox())!;
  const title = (await page.getByRole("heading", { name: "编辑图片", exact: true }).boundingBox())!;
  if (target === "keyboard") {
    await page.getByRole("button", { name: "返回正文", exact: true }).focus();
    await page.keyboard.press("Space");
  } else await page.mouse.click(target === "title" ? title.x + title.width / 2 : bar.x + bar.width - 6, bar.y + bar.height / 2);
  await expect(page.getByText("已返回正文", { exact: true })).toBeVisible();
  expect((await snapshot(page)).scene.layers[0].cornerRadius).toBe(1);
});

test("offers distinct light-to-dark palettes without flattening multicolor gradients", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  await open(page, "?visual=1");
  await page.getByRole("button", { name: "纯色", exact: true }).click();
  const solids = page.getByRole("button", { name: /^背景颜色 / });
  await expect(solids).toHaveCount(12);
  const solidBrightness = (await solids.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")!.match(/#[a-f0-9]{6}/)![0]))).map(luminance);
  expect(solidBrightness[0]).toBeGreaterThan(.8);
  expect(solidBrightness.at(-1)).toBeLessThan(.05);
  for (let index = 1; index < solidBrightness.length; index++) {
    expect(solidBrightness[index]).toBeLessThan(solidBrightness[index - 1]);
    expect(solidBrightness[index - 1] - solidBrightness[index]).toBeLessThan(.25);
  }
  await expect.poll(async () => (await snapshot(page)).scene.artboard.background).toEqual({ type: "solid", color: "#304384" });
  await page.locator(".ic-section").filter({ has: page.getByRole("heading", { name: "背景", exact: true }) }).screenshot({ path: `output/image-canvas-palette/solids-${test.info().project.name}.png` });
  await solids.nth(0).click();
  await expect.poll(async () => (await snapshot(page)).scene.artboard.background).toEqual({ type: "solid", color: "#faf9fb" });
  await page.getByRole("button", { name: "渐变", exact: true }).click();
  const gradients = page.getByRole("button", { name: /^渐变背景 / });
  await expect(gradients).toHaveCount(12);
  const gradientBrightness = (await gradients.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")!.match(/#[a-f0-9]{6}/g)!))).map(colors => colors.map(luminance));
  for (const stops of gradientBrightness) for (let index = 1; index < stops.length; index++) expect(stops[index]).toBeLessThan(stops[index - 1]);
  const averages = gradientBrightness.map(stops => stops.reduce((sum, value) => sum + value, 0) / stops.length);
  for (let index = 1; index < averages.length; index++) {
    expect(averages[index]).toBeLessThan(averages[index - 1]);
    expect(averages[index - 1] - averages[index]).toBeLessThan(.18);
  }
  await expect.poll(async () => (await snapshot(page)).scene.artboard.background).toMatchObject({ type: "linear-gradient", stops: [{ color: "#8da4ef" }, { color: "#3e63dd" }, { color: "#304384" }, { color: "#182449" }] });
  await page.locator(".ic-section").filter({ has: page.getByRole("heading", { name: "背景", exact: true }) }).screenshot({ path: `output/image-canvas-palette/gradients-${test.info().project.name}.png` });
  await gradients.nth(10).click();
  await expect.poll(async () => { const value = (await snapshot(page)).scene.artboard.background; return value.type === "linear-gradient" ? value.stops.length : 0; }).toBe(4);
  const background = (await snapshot(page)).scene.artboard.background;
  if (background.type !== "linear-gradient") throw new Error("missing gradient");
  expect(background.stops).toHaveLength(4);
  await page.getByLabel("背景起始颜色", { exact: true }).evaluate((element: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "#111927");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => (await snapshot(page)).scene.artboard.background).toEqual({ ...background, stops: background.stops.map((stop, index) => index === 0 ? { ...stop, color: "#111927" } : stop) });
  await expect(gradients.nth(10)).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("slider", { name: "四周留白", exact: true }).fill("80");
  await page.getByRole("button", { name: "复制成品", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).completed).toBe(1);
  const output = (await snapshot(page)).output!;
  expect(output.mime).toBe("webp");
  expect(output.topEdgePixel![2]).toBeGreaterThan(50);
  expect(luminance("#" + output.topEdgePixel!.slice(0, 3).map(channel => channel.toString(16).padStart(2, "0")).join(""))).toBeLessThan(.25);
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: "output/image-canvas-palette/night-1000.png" });
  await gradients.nth(0).click();
  await expect(gradients.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await snapshot(page)).scene.artboard.background).toMatchObject({ type: "linear-gradient", stops: [{ color: "#faf9fb" }, { color: "#e6f4fe" }, { color: "#c2e5ff" }, { color: "#acd8fc" }] });
  await page.screenshot({ path: "output/image-canvas-palette/light-1000.png" });
});

for (const scale of [1, 1.5, 2]) test(`centers the canvas title without font trimming at scale ${scale}`, async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1000, height: 640 }, deviceScaleFactor: scale });
  const page = await context.newPage();
  try {
    await open(page);
    const title = page.getByRole("heading", { name: "编辑图片", exact: true });
    const bar = (await page.locator(".ic-document-bar").boundingBox())!;
    const bounds = (await title.boundingBox())!;
    expect(Math.abs(bounds.y + bounds.height / 2 - bar.y - bar.height / 2)).toBeLessThanOrEqual(0.5);
    expect(await title.getAttribute("class")).toContain("rt-r-lt-normal");
    await page.locator(".ic-document-bar").screenshot({ path: `output/image-canvas-hosting/title-${browser.browserType().name()}-${scale}.png` });
  } finally { await context.close(); }
});

for (const dark of [false, true]) test(`previews the polished canvas with reference photos ${dark ? "dark" : "light"}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `?visual=1${dark ? "&dark=1" : ""}`);
  await page.getByRole("button", { name: "渐变", exact: true }).click();
  await page.getByRole("slider", { name: "四周留白", exact: true }).fill("80");
  await page.getByRole("slider", { name: "圆角", exact: true }).fill("20");
  await page.getByRole("button", { name: "画板设置", exact: true }).click();
  await page.getByRole("slider", { name: "圆角", exact: true }).fill("28");
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  await page.locator(".ic-inspector-heading").click({ position: { x: 8, y: 8 } });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: `output/image-canvas-polish/${dark ? "dark" : "light"}-1440.png` });
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: `output/image-canvas-polish/${dark ? "dark" : "light"}-1000.png` });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test(`opens from the actual image context menu without a small dialog or faded frame (${reducedMotion})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.goto("/tests/image-canvas.html?host=1");
  const image = page.locator(".rich-image-frame").first();
  await image.click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑图片", exact: true }).click();
  await expect(page.getByText("正在打开图片编辑…", { exact: true })).toBeVisible();
  const frames = await page.evaluate(async () => {
    const frames: Array<{ width: number; height: number; opacity: string }[]> = [];
    let active = true;
    function capture() {
      frames.push(Array.from(document.querySelectorAll('[role="dialog"]')).map(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, opacity: getComputedStyle(element).opacity };
      }));
      if (active) requestAnimationFrame(capture);
    }
    capture();
    window.imageCanvasTest.releaseOpen!();
    while (!document.querySelector(".ic-inspector")) await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    active = false;
    return frames;
  });
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) {
    expect(frame.length).toBeGreaterThan(0);
    for (const dialog of frame) expect(dialog).toEqual({ width: 1000, height: 640, opacity: "1" });
  }
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest(".image-canvas-dialog")))).toBe(true);
  await page.getByRole("button", { name: "返回正文", exact: true }).click();
  await expect(page.locator(".image-canvas-dialog")).toHaveCount(0);
  await image.click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑图片", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "属性面板" })).toBeVisible();
});

for (const dark of [false, true]) test(`keeps compact headers and every inspector control reachable at 1000x640 ${dark ? "dark" : "light"}`, async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  await open(page, dark ? "?dark=1" : "");
  await expect(page.locator(".ic-document-bar .lucide-arrow-left")).toBeVisible();
  for (const [selector, maxWidth] of [[".ic-document-bar", 155], [".ic-view-bar", 300]] as const) {
    const bounds = (await page.locator(selector).boundingBox())!;
    expect(bounds.height).toBe(40);
    expect(bounds.width).toBeLessThanOrEqual(maxWidth);
  }
  await page.getByRole("button", { name: "渐变", exact: true }).click();
  await page.getByRole("button", { name: "JPG", exact: true }).click();
  const scroll = page.locator(".ic-panel-scroll");
  expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  for (const label of ["图片宽度", "圆角", "阴影", "背景起始颜色", "JPEG 透明区域底色"]) {
    const control = page.getByLabel(label, { exact: true });
    await control.scrollIntoViewIfNeeded();
    expect(await control.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return hit === element || element.contains(hit);
    }), label).toBe(true);
  }
  await page.getByRole("slider", { name: "圆角", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("slider", { name: "圆角", exact: true }).press("End");
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].cornerRadius).toBe(100);
  const panel = (await page.locator(".ic-inspector").boundingBox())!;
  const footer = (await page.locator(".ic-export-panel").boundingBox())!;
  const body = (await scroll.boundingBox())!;
  expect(body.height).toBeGreaterThan(80);
  expect(body.y + body.height).toBeLessThanOrEqual(footer.y + 1);
  expect(footer.y + footer.height).toBeLessThanOrEqual(panel.y + panel.height);
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await page.locator(".ic-inspector-heading").click({ position: { x: 8, y: 8 } });
  await page.screenshot({ path: `output/image-canvas-compact/${dark ? "dark" : "light"}-1000.png` });
});

test("background rounding has its own saved value and undo history", async ({ page }) => {
  await open(page);
  await page.getByRole("slider", { name: "圆角", exact: true }).press("ArrowRight");
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].cornerRadius).toBe(1);
  await page.getByRole("button", { name: "画板设置", exact: true }).click();
  await expect(page.getByRole("slider", { name: "圆角", exact: true })).toHaveValue("0");
  await page.getByRole("slider", { name: "圆角", exact: true }).press("End");
  await expect.poll(async () => (await snapshot(page)).scene.artboard.cornerRadius).toBe(100);
  expect((await snapshot(page)).scene.layers[0].cornerRadius).toBe(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.artboard.cornerRadius ?? 0).toBe(0);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.artboard.cornerRadius).toBe(100);
});

for (const background of ["纯色", "渐变", "壁纸"]) test(`rounded backgrounds preserve preview transparency and PNG pixels (${background})`, async ({ page }) => {
  await open(page, background === "壁纸" ? "?background=1" : "");
  await page.getByRole("button", { name: "PNG", exact: true }).click();
  await page.getByRole("button", { name: "画板设置", exact: true }).click();
  if (background === "壁纸") await page.getByRole("combobox", { name: "背景图片铺放" }).selectOption("cover");
  else await page.getByRole("button", { name: background, exact: true }).click();
  await page.getByRole("slider", { name: "四周留白", exact: true }).press("End");
  await page.getByRole("slider", { name: "圆角", exact: true }).press("End");
  await expect.poll(async () => (await snapshot(page)).scene.artboard.cornerRadius).toBe(100);
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  await expect.poll(async () => page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".image-canvas-workspace canvas")!;
    const bounds = canvas.getBoundingClientRect();
    const caption = document.querySelector(".image-canvas-board-caption")!.getBoundingClientRect();
    const scale = parseFloat(document.querySelector<HTMLElement>(".image-canvas-app")!.style.getPropertyValue("--ic-view-scale"));
    const height = window.imageCanvasTest.snapshot().scene.artboard.height;
    return canvas.getContext("2d")!.getImageData(Math.round((caption.left - bounds.left + 2) * canvas.width / bounds.width),
      Math.round((caption.top - bounds.top - 12 - height * scale + 2) * canvas.height / bounds.height), 1, 1).data[3];
  })).toBeLessThanOrEqual(24);
  await page.getByRole("button", { name: "复制成品", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).completed).toBe(1);
  expect((await snapshot(page)).output!.cornerPixel![3]).toBe(0);
  expect((await snapshot(page)).output!.topEdgePixel![3]).toBe(255);
  expect((await snapshot(page)).scene.layers[0].cornerRadius).toBe(0);
});

test("rounded backgrounds use the selected JPEG matte", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "画板设置", exact: true }).click();
  await page.getByRole("button", { name: "渐变", exact: true }).click();
  await page.getByRole("slider", { name: "四周留白", exact: true }).press("End");
  await page.getByRole("slider", { name: "圆角", exact: true }).press("End");
  await page.getByRole("button", { name: "JPG", exact: true }).click();
  await page.getByRole("button", { name: "复制成品", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).completed).toBe(1);
  const output = (await snapshot(page)).output!;
  expect(output.mime).toBe("jpeg");
  expect(output.cornerPixel![3]).toBe(255);
  expect(output.cornerPixel!.slice(0, 3).every(channel => channel >= 250)).toBe(true);
});

test("crops original pixels and undoes the result without flattening the image", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "裁剪", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成裁剪" })).toBeEnabled();
  await page.getByRole("spinbutton", { name: "裁剪X 坐标" }).fill("100");
  await page.getByRole("spinbutton", { name: "裁剪Y 坐标" }).fill("80");
  await page.getByRole("spinbutton", { name: "裁剪宽度" }).fill("400");
  await page.getByRole("spinbutton", { name: "裁剪高度" }).fill("300");
  await page.getByRole("button", { name: "完成裁剪" }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].crop).toEqual({ x: 100, y: 80, width: 400, height: 300 });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].crop).toEqual({ x: 0, y: 0, width: 1000, height: 650 });
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].width).toBe(400);
});

test("adds images and switches selection-driven layouts while keeping all layers editable", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "添加图片", exact: true }).click();
  await page.getByRole("button", { name: "图片 2 740 × 900", exact: true }).click();
  await page.getByRole("button", { name: "添加所选图片", exact: true }).click();
  await page.getByRole("button", { name: "全选图片", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "属性面板" });
  await inspector.getByRole("button", { name: "横向", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layout.mode).toBe("horizontal");
  const horizontal = (await snapshot(page)).scene;
  expect(horizontal.layers).toHaveLength(2);
  expect(horizontal.layers[0].height).toBeCloseTo(horizontal.layers[1].height);
  expect(horizontal.layers[1].x).toBeGreaterThan(horizontal.layers[0].x + horizontal.layers[0].width);
  await inspector.getByRole("button", { name: "纵向", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layout.mode).toBe("vertical");
  const vertical = (await snapshot(page)).scene;
  expect(vertical.layers[0].width).toBeCloseTo(vertical.layers[1].width);
  expect(vertical.layers[1].y).toBeGreaterThan(vertical.layers[0].y + vertical.layers[0].height);
  await inspector.getByRole("button", { name: "横向", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.artboard).toEqual(horizontal.artboard);
  for (const [index, layer] of (await snapshot(page)).scene.layers.entries()) {
    expect(layer.width).toBeCloseTo(horizontal.layers[index].width, 8);
    expect(layer.height).toBeCloseTo(horizontal.layers[index].height, 8);
  }
  await inspector.getByRole("button", { name: "宫格", exact: true }).click();
  await page.getByRole("spinbutton", { name: "宫格列数" }).fill("1");
  await expect.poll(async () => (await snapshot(page)).scene.layout.columns).toBe(1);
  expect((await snapshot(page)).scene.layers.map(layer => layer.assetId)).toEqual(["sample-one", "sample-two"]);
});

test("keeps group drag and returns to single image tools after an undragged canvas click", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "添加图片", exact: true }).click();
  await page.getByRole("button", { name: "图片 2 740 × 900", exact: true }).click();
  await page.getByRole("button", { name: "添加所选图片", exact: true }).click();
  await expect(page.getByRole("heading", { name: "多张图片", exact: true })).toBeVisible();
  const inspector = page.getByRole("complementary", { name: "属性面板" });
  await inspector.getByRole("button", { name: "横向", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layout.mode).toBe("horizontal");
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  const state = (await snapshot(page)).scene;
  const caption = (await page.locator(".image-canvas-board-caption").boundingBox())!;
  const scale = Number((await page.locator(".ic-zoom-value").innerText()).replace("%", "")) / 100;
  const x = caption.x + (state.layers[0].x + state.layers[0].width / 3) * scale;
  const y = caption.y - 12 - state.artboard.height * scale + (state.layers[0].y + state.layers[0].height / 2) * scale;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 20, { steps: 7 }); await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).scene.layers[1].x).toBeGreaterThan(state.layers[1].x + 10);
  await expect(page.getByRole("heading", { name: "多张图片", exact: true })).toBeVisible();
  await page.mouse.click(x + 40, y + 20);
  await expect(page.getByRole("heading", { name: "图片", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "裁剪", exact: true })).toBeVisible();
});

test("exports actual 2x pixels and creates a fresh immutable render when applying after copy", async ({ page }) => {
  await open(page);
  await page.getByRole("combobox", { name: "导出倍率" }).selectOption("2");
  await page.getByRole("button", { name: "复制成品", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).completed).toBe(1);
  expect((await snapshot(page)).output).toMatchObject({ width: 2000, height: 1300, mime: "webp" });
  await page.getByRole("button", { name: "应用到文章", exact: true }).click();
  await expect(page.getByText("已返回正文", { exact: true })).toBeVisible();
  expect(await snapshot(page)).toMatchObject({ copied: 1, applied: 1, completed: 2 });
});

for (const orientation of [6, 8]) test(`renders the phone photo orientation ${orientation} in raw crop coordinates`, async ({ page }) => {
  await open(page, `?orientation=${orientation}`);
  await page.getByRole("button", { name: "PNG", exact: true }).click();
  await page.getByRole("button", { name: "复制成品", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).completed).toBe(1);
  const output = (await snapshot(page)).output!;
  expect(output).toMatchObject({ width: 650, height: 1000, mime: "png" });
  expect(orientation === 6 ? output.topPixel : output.bottomPixel).toEqual([28, 32, 36, 255]);
  expect(orientation === 6 ? output.bottomPixel : output.topPixel).not.toEqual([28, 32, 36, 255]);
});

for (const orientation of [6, 8]) test(`orients a shared photo background independently from its layer (${orientation})`, async ({ page }) => {
  await open(page, `?orientation=${orientation}&background=1`);
  await page.getByRole("button", { name: "PNG", exact: true }).click();
  await page.getByRole("button", { name: "复制成品", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).completed).toBe(1);
  const output = (await snapshot(page)).output!;
  expect(output).toMatchObject({ width: 850, height: 1200, mime: "png" });
  expect(orientation === 6 ? output.topPixel : output.bottomPixel).toEqual([28, 32, 36, 255]);
  expect(orientation === 6 ? output.bottomPixel : output.topPixel).not.toEqual([28, 32, 36, 255]);
});

test("keeps a cancelled file output uncommitted and the draft editable", async ({ page }) => {
  await open(page, "?cancel=1");
  await page.getByRole("button", { name: "另存为图片", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).saved).toBe(1);
  expect((await snapshot(page)).completed).toBe(0);
  await expect(page.getByRole("button", { name: "应用到文章", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "向右旋转", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].rotation).toBe(90);
});

test("moves a selected image with the pointer and keeps panning and zooming outside the saved scene", async ({ page }) => {
  await open(page);
  const caption = await page.locator(".image-canvas-board-caption").boundingBox();
  const scale = Number((await page.locator(".ic-zoom-value").innerText()).replace("%", "")) / 100;
  const x = caption!.x + 250 * scale, y = caption!.y - 12 - 650 * scale + 250 * scale;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 72, y + 36, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].x).toBeGreaterThan(20);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.layers[0].x).toBe(0);
  await page.getByRole("button", { name: "平移画布", exact: true }).click();
  const beforePan = (await snapshot(page)).scene;
  const beforeX = (await page.locator(".image-canvas-board-caption").boundingBox())!.x;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 48, y + 24, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await page.locator(".image-canvas-board-caption").boundingBox())!.x).toBeGreaterThan(beforeX + 30);
  await page.mouse.wheel(0, -180);
  await expect.poll(async () => page.locator(".ic-zoom-value").innerText()).not.toBe(`${Math.round(scale * 100)}%`);
  expect((await snapshot(page)).scene).toEqual(beforePan);
});

for (const dark of [false, true]) test(`fits floating controls in 1280x720 ${dark ? "dark" : "light"}`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, dark ? "?dark=1" : "");
  for (const selector of [".ic-document-bar", ".ic-view-bar", ".ic-tool-rail", ".ic-inspector", ".ic-selection-dock"]) {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds, selector).not.toBeNull();
    expect(bounds!.x, selector).toBeGreaterThanOrEqual(0);
    expect(bounds!.y, selector).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width, selector).toBeLessThanOrEqual(1280);
    expect(bounds!.y + bounds!.height, selector).toBeLessThanOrEqual(720);
  }
  await page.getByRole("button", { name: "渐变", exact: true }).click();
  await page.getByRole("slider", { name: "四周留白", exact: true }).press("End");
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.artboard.width).toBe(1600);
  await page.screenshot({ path: `output/image-canvas-implementation/${dark ? "dark" : "light"}-1280.png` });
});
