import { expect, test, type Page } from "@playwright/test";

// Exercise native scrollbar hit testing instead of Playwright's hidden scrollbars.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

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
          if (command === "empty_trash") {
            Reflect.set(window, "motionConfirmCalls", (Reflect.get(window, "motionConfirmCalls") ?? 0) + 1);
            return [];
          }
          throw new Error(`Unexpected native call: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    });
  }, platform);
}

for (const platform of ["Win32", "MacIntel"]) test(`retains every sidebar icon frame at normal and maximized widths on ${platform}`, async ({ page }) => {
  await mockNativeWindow(page, platform);
  await page.goto("/tests/workspace-resize.html?edit=1");
  async function checkFrames() {
    const icons = page.locator(".sidebar-toggle-icon:visible");
    expect(await icons.count()).toBeGreaterThan(0);
    const frames = await icons.evaluateAll(elements => elements.map(element => {
      const frame = element.querySelector<SVGRectElement>('rect:not(.sidebar-toggle-fill)')!;
      return { opacity: getComputedStyle(frame).opacity, stroke: getComputedStyle(frame).stroke,
        width: frame.getAttribute("width"), height: frame.getAttribute("height"),
        iconWidth: element.getBoundingClientRect().width, iconHeight: element.getBoundingClientRect().height };
    }));
    for (const frame of frames) {
      expect(frame.opacity).toBe("1");
      expect(frame.stroke).not.toBe("none");
      expect(frame.width).toBe("18"); expect(frame.height).toBe("18");
      expect(frame.iconWidth).toBe(18); expect(frame.iconHeight).toBe(18);
    }
    await expect.poll(() => icons.evaluateAll(elements => elements.every(element =>
      getComputedStyle(element.querySelector('.sidebar-toggle-fill')!).opacity === (element.getAttribute("data-expanded") === "true" ? "1" : "0")))).toBe(true);
  }
  for (const [width, height] of [[1360, 840], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await checkFrames();
    await page.locator("#ai-panel-trigger").click(); await checkFrames();
    await page.locator("#ai-panel-trigger").click(); await checkFrames();
    if (await page.locator("#hide-timeline-directory").isVisible()) {
      await page.locator("#hide-timeline-directory").click(); await checkFrames();
      await page.locator("#show-timeline-directory").click(); await checkFrames();
    }
    await page.locator("#hide-sidebar").click(); await checkFrames();
    await page.locator("#show-sidebar").click(); await checkFrames();
  }
});

for (const motion of ["no-preference", "reduce"] as const) test(`dismisses settings through its exit and restores focus with ${motion} motion`, async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.emulateMedia({ reducedMotion: motion });
  await page.goto("/tests/workspace-resize.html?edit=1");
  const trigger = page.getByRole("button", { name: "设置", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  const partial = await dialog.evaluate(async element => {
    element.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click();
    await Promise.resolve();
    const animations = element.getAnimations();
    for (const animation of animations) animation.pause();
    await Promise.all(animations.map(animation => animation.ready));
    for (const animation of animations) animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    const opacity = Number(getComputedStyle(element).opacity);
    const intermediate = element.isConnected && opacity > 0 && opacity < 1;
    for (const animation of animations) animation.finish();
    return intermediate;
  });
  expect(partial).toBe(motion === "no-preference");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

test("keeps a new settings dialog when a nonmodal command palette finishes closing", async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.goto("/tests/workspace-resize.html?edit=1");
  await page.getByRole("button", { name: "命令面板", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "查找命令或笔记" })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeVisible();
  await expect.poll(() => settings.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await expect(page.locator(".command-palette")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "关闭设置" })).toBeEnabled();
});

test("does not activate a cancelled destructive action during its exit", async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.goto("/tests/workspace-resize.html?edit=1");
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page.locator("#empty-trash").click();
  const dialog = page.getByRole("dialog", { name: "清空回收站", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "清空回收站", exact: true }).focus();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => {
    const closing = document.querySelector<HTMLElement>('.rt-DialogContent[data-state="closed"]');
    return !closing || closing.inert;
  })).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator('.rt-DialogContent[data-state="closed"]')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "motionConfirmCalls") ?? 0)).toBe(0);
});

test("ignores a queued confirmation click after cancellation starts", async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.goto("/tests/workspace-resize.html?edit=1");
  await page.addStyleTag({ content: ':is(.rt-BaseDialogOverlay, .rt-DialogContent)[data-state="closed"] { animation-duration: 60s !important; }' });
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page.locator("#empty-trash").click();
  const dialog = page.getByRole("dialog", { name: "清空回收站", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "清空回收站", exact: true }).focus();
  await page.keyboard.press("Escape");
  const closing = page.locator('.rt-DialogContent[data-state="closed"]');
  await expect(closing).toHaveCount(1);
  await closing.locator('.dialog-actions button').last().evaluate(button => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(await page.evaluate(() => Reflect.get(window, "motionConfirmCalls") ?? 0)).toBe(0);
  await page.locator('.rt-BaseDialogOverlay[data-state="closed"]').evaluate(element => {
    for (const animation of element.getAnimations({ subtree: true })) animation.finish();
  });
  await expect(closing).toHaveCount(0);
});

for (const region of ["right", "directory"] as const) test(`takes over a partially opened ${region} at its rendered boundary`, async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.clock.install();
  await page.goto(`/tests/workspace-resize.html?edit=1${region === "right" ? "&priority=1" : ""}`);
  const group = page.locator("#workspace-panels");
  await expect.poll(() => page.locator("#ai-sidebar").evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(region === "right" ? 420 : 350);
  await expect(group).not.toHaveAttribute("data-ai-sidebar-moving", "true");
  if (region === "right") {
    await page.locator("#ai-panel-trigger").click();
    await expect.poll(() => page.locator("#ai-sidebar").evaluate(element => element.getBoundingClientRect().width)).toBe(0);
  } else {
    await page.locator("#hide-timeline-directory").click();
    await expect(group).not.toHaveAttribute("data-timeline-directory-moving", "true");
  }
  // CSS animation time and JS timers are independent: hold cleanup timers too.
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  await group.evaluate(element => { (element as HTMLElement).style.setProperty("--motion-layout", "60s"); });
  await page.locator(region === "right" ? "#ai-panel-trigger" : "#show-timeline-directory").evaluate((element: HTMLElement) => element.click());
  await expect.poll(() => group.locator(":scope > [data-panel]").evaluateAll(panels => panels.some(panel => panel.getAnimations().length > 0))).toBe(true);
  await page.evaluate(async () => {
    // Hold a legal intermediate width while moving the real pointer onto its boundary.
    const animations = [...document.querySelectorAll("#workspace-panels > [data-panel], #timeline-directory")].flatMap(element => element.getAnimations());
    for (const animation of animations) animation.pause();
    await Promise.all(animations.map(animation => animation.ready));
    for (const animation of animations) animation.currentTime = Number(animation.effect!.getTiming().duration) * .8;
  });
  const separator = region === "right" ? page.getByRole("separator", { name: "调整右侧栏宽度", exact: true }) : page.locator("#resize-timeline-directory");
  await separator.evaluate((element: HTMLElement) => { element.dataset.motionSeparator = "true"; });
  await page.evaluate(() => {
    const boundary = () => document.querySelector('[data-motion-separator="true"]')!.getBoundingClientRect().x;
    document.addEventListener("pointerdown", () => Reflect.set(window, "motionBoundaryBefore", boundary()), { capture: true, once: true });
    window.addEventListener("pointerdown", () => Reflect.set(window, "motionBoundaryAfter", boundary()), { once: true });
  });
  const bounds = (await separator.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 150);
  await page.mouse.down();
  try {
    expect(await page.evaluate(() => Math.abs(Reflect.get(window, "motionBoundaryAfter") - Reflect.get(window, "motionBoundaryBefore")))).toBeLessThan(1);
    await expect(group).toHaveAttribute("data-resizing", "true");
    await page.mouse.move(bounds.x + (region === "right" ? -20 : 20), bounds.y + 150);
  } finally { await page.mouse.up(); }
});

for (const platform of ["Win32", "MacIntel"]) test(`keeps every panel directly attached to a live resize gesture on ${platform}`, async ({ page }) => {
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/tests/workspace-resize.html?priority=1&edit=1");
  const group = page.locator("#workspace-panels");
  await expect.poll(() => page.locator("#ai-sidebar").evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(420);
  await expect(group).not.toHaveAttribute("data-ai-sidebar-moving", "true");
  const separator = page.getByRole("separator", { name: "调整右侧栏宽度", exact: true });
  const bounds = (await separator.boundingBox())!;
  const before = (await page.locator("#ai-sidebar").boundingBox())!.width;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 150);
  await page.mouse.down();
  try {
    await expect(group).toHaveAttribute("data-resizing", "true");
    expect(await group.locator(":scope > [data-panel]").evaluateAll(panels => panels.every(panel => getComputedStyle(panel).transitionDuration === "0s"))).toBe(true);
    await page.mouse.move(bounds.x - 60, bounds.y + 150, { steps: 4 });
    // Read the rendered width immediately: a lagging transition cannot satisfy this.
    expect((await page.locator("#ai-sidebar").boundingBox())!.width - before).toBeGreaterThan(58);
  } finally { await page.mouse.up(); }
  await expect(group).not.toHaveAttribute("data-resizing", "true");
});

for (const platform of ["Win32", "MacIntel"]) test(`keeps publication controls while typing stable on ${platform}`, async ({ page }) => {
  await mockNativeWindow(page, platform);
  await page.goto("/tests/workspace-resize.html?edit=1");
  await page.getByRole("button", { name: "公众号设置", exact: true }).click();
  const copy = page.locator(".wechat-publishing-footer button");
  await expect(copy).toBeEnabled();
  await expect(page.getByRole("button", { name: "自动推荐", exact: true })).toBeEnabled();
  const editor = page.locator(".document-editor:not([hidden]) .ProseMirror");
  await editor.locator("p").first().click();
  await editor.press("End");
  const initial = await page.evaluate(() => {
    const copy = document.querySelector<HTMLButtonElement>(".wechat-publishing-footer button")!;
    let disabledChanges = 0;
    const observer = new MutationObserver(records => { disabledChanges += records.filter(record => record.attributeName === "disabled").length; });
    observer.observe(copy, { attributes: true, attributeFilter: ["disabled"] });
    Object.assign(window, { typingFeedback: () => ({ disabledChanges, connected: copy.isConnected }) });
    return { ...Reflect.get(window, "publicationTyping") };
  });
  await editor.pressSequentially("连续输入正文", { delay: 60 });
  const result = await page.evaluate(() => ({ ...Reflect.get(window, "publicationTyping"), ...Reflect.get(window, "typingFeedback")() }));
  expect(result.saves).toBe(initial.saves);
  expect(result.recommendations).toBe(initial.recommendations);
  expect(result.disabledChanges).toBe(0);
  expect(result.connected).toBe(true);
  await expect(page.locator("#tab-resize .unsaved-dot")).toHaveCount(1);
  await expect(copy).toBeEnabled();
  await expect.poll(async () => (await page.evaluate(() => Reflect.get(window, "publicationTyping"))).saves).toBeGreaterThan(initial.saves);
});

for (const platform of ["Win32", "MacIntel"]) test(`keeps the upper right sidebar divider draggable after editor scrolling on ${platform}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/tests/workspace-resize.html?priority=1&edit=1");
  const scroll = page.locator(".document-editor:not([hidden]) .editor-scroll");
  await expect(scroll).toBeVisible();
  expect(await page.locator(".document-editor:not([hidden]) .editor-area").evaluate(element => getComputedStyle(element).marginInlineEnd)).toBe("4px");
  expect(await page.locator(".sidebar-workspace .explorer-scroll").first().evaluate(element => getComputedStyle(element).marginInlineEnd)).toBe("4px");
  const right = page.locator('#ai-sidebar[data-panel]');
  await expect.poll(async () => Math.round((await right.boundingBox())!.width)).toBe(420);
  await expect(page.locator('#workspace-panels')).not.toHaveAttribute('data-ai-sidebar-moving', 'true');
  const widthBeforeScroll = (await right.boundingBox())!.width;
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const metrics = await scroll.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: box.right - 5, y: box.y, height: box.height, top: element.scrollTop,
      thumbHeight: element.clientHeight * element.clientHeight / element.scrollHeight };
  });
  await page.mouse.move(metrics.x, metrics.y + metrics.height - metrics.thumbHeight / 2 - 2);
  await page.mouse.down();
  await page.mouse.move(metrics.x, metrics.y + metrics.thumbHeight / 2 - 8, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0);
  await page.screenshot({ path: test.info().outputPath("scrollbar-insets.png") });
  expect((await right.boundingBox())!.width).toBeCloseTo(widthBeforeScroll, 0);
  const separator = page.getByRole("separator", { name: "调整右侧栏宽度", exact: true });
  for (const y of [20, 65, 110, 180]) {
    const bounds = (await separator.boundingBox())!;
    const before = (await right.boundingBox())!.width;
    await page.mouse.move(bounds.x - 2, y);
    await page.mouse.down();
    try {
      await page.mouse.move(bounds.x - 7, y);
      await expect.poll(async () => (await right.boundingBox())!.width).toBeCloseTo(before + 5, 0);
      await page.mouse.move(bounds.x - 60, y, { steps: 6 });
    } finally { await page.mouse.up(); }
    await expect.poll(async () => (await right.boundingBox())!.width, `drag at y=${y}`).toBeGreaterThan(before + 50);
  }
  expect(errors).toEqual([]);
});

for (const platform of ["Win32", "MacIntel"]) test(`keeps title tabs and the right sidebar toggle positioned with the left sidebar collapsed on ${platform}`, async ({ page }) => {
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto("/tests/workspace-resize.html?priority=1&collapsed=1");
  await expect(page.locator("#tab-resize")).toBeVisible();
  await expect(page.getByRole("button", { name: "显示左侧栏", exact: true })).toBeVisible();
  for (const module of ["initial", "properties"]) {
    if (module === "properties") await page.getByRole("button", { name: "内容属性", exact: true }).click();
    for (const width of [1800, 1000, 2400, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => {
        const header = (await page.locator(".workbench-chrome").boundingBox())!;
        const toggle = (await page.locator("#ai-panel-trigger").boundingBox())!;
        const gap = header.x + header.width - toggle.x - toggle.width;
        expect(gap).toBeGreaterThanOrEqual(-1);
        return gap;
      }).toBeLessThan(20);
      const viewport = (await page.locator(".workbench-chrome .tabs").boundingBox())!;
      const tab = (await page.locator("#tab-resize").boundingBox())!;
      expect(viewport.width).toBeGreaterThan(110);
      expect(Math.min(tab.x + tab.width, viewport.x + viewport.width) - Math.max(tab.x, viewport.x)).toBeGreaterThan(80);
      await page.screenshot({ path: test.info().outputPath(`titlebar-${module}-${width}.png`), clip: { x: 0, y: 0, width, height: 100 } });
    }
  }
});

for (const platform of ["Win32", "MacIntel"]) for (const entry of ["titlebar", "context", "folder"])
  for (const delay of [0, 300]) test(`keeps new article focus and titlebar geometry from ${entry} with ${delay}ms creation on ${platform}`, async ({ page }) => {
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1360, height: 840 });
  await page.goto(`/tests/workspace-resize.html?priority=1&createDelay=${delay}${entry === "folder" ? "&folder=1" : ""}`);
  await expect(page.locator("#tab-resize")).toBeVisible();
  await page.getByRole("button", { name: "内容属性", exact: true }).click();
  if (entry === "folder") await page.getByRole("button", { name: "内容目录", exact: true }).click();
  await page.locator("#tab-second").focus();
  if (entry === "titlebar") await page.getByRole("button", { name: "新建内容", exact: true }).click();
  else if (entry === "folder") await page.getByRole("button", { name: "回归目录", exact: true }).click({ button: "right" });
  else {
    const area = page.locator(".timeline-content"), bounds = (await area.boundingBox())!;
    await area.click({ button: "right", position: { x: 20, y: bounds.height - 20 } });
  }
  await page.getByRole("menuitem", { name: "新建笔记", exact: true }).click();
  await expect(page.locator("#tab-created-1")).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  // Wait through the focus-scope cleanup, without focusing the editor from the test.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const editor = page.locator(".document-editor:not([hidden]) .ProseMirror");
  await expect(editor).toBeFocused();
  await editor.pressSequentially("新建后直接输入正文，焦点应留在当前文章。");
  await expect(editor).toContainText("新建后直接输入正文");
  const title = page.locator('.document-editor:not([hidden]) textarea[aria-label="标题"]');
  await title.fill("新增文章的长标题：编辑后标签页与右侧栏按钮应保持正确位置");
  await title.press("Enter");
  await expect(editor).toBeFocused();
  await page.keyboard.type("继续编辑正文。");
  for (const width of [1360, 2560, 1000, 1360]) {
    await page.setViewportSize({ width, height: 840 });
    await expect.poll(() => page.evaluate(() => {
      const writing = document.querySelector<HTMLElement>("#writing")!;
      const header = writing.querySelector<HTMLElement>(".workbench-chrome")!;
      const tabs = header.querySelector<HTMLElement>(".tabs")!;
      const active = tabs.querySelector<HTMLElement>('[aria-selected="true"]')!;
      const toggle = header.querySelector<HTMLElement>("#ai-panel-trigger")!;
      const w = writing.getBoundingClientRect(), h = header.getBoundingClientRect(), t = tabs.getBoundingClientRect(), a = active.getBoundingClientRect(), b = toggle.getBoundingClientRect();
      return [writing.scrollLeft, writing.firstElementChild!.scrollLeft, header.scrollLeft].every(left => left === 0)
        && Math.abs(h.right - w.right) < 1 && Math.abs(h.left - w.left) < 1 && t.width >= Math.min(100, w.width - 155)
        && Math.min(a.right, t.right, h.right, w.right) - Math.max(a.left, t.left, h.left, w.left) >= Math.min(80, t.width - 35)
        && h.right - b.right >= 0 && h.right - b.right < 20;
    })).toBe(true);
  }
});

test("bounds Windows control space when the workspace temporarily has no width", async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.goto("/tests/workspace-resize.html?edit=1&collapsed=1");
  await expect(page.locator("#tab-resize")).toBeVisible();
  await page.locator("#ai-panel-trigger").click();
  await expect(page.locator("#workspace-panels")).not.toHaveAttribute("data-ai-sidebar-moving", "true");
  const padding = await page.locator("#workspace-panels").evaluate(async element => {
    const group = element as HTMLElement;
    const chrome = group.querySelector<HTMLElement>(".workbench-chrome")!;
    const originalWidth = group.style.width;
    group.style.width = "0px";
    try {
      const samples: number[] = [];
      for (let frame = 0; frame < 12; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push(parseFloat(getComputedStyle(chrome).paddingInlineEnd));
      }
      return samples;
    } finally { group.style.width = originalWidth; }
  });
  expect(Math.max(...padding)).toBeLessThanOrEqual(132);
  await expect.poll(() => page.evaluate(() => {
    const writing = document.querySelector("#writing")!.getBoundingClientRect();
    const header = document.querySelector(".workbench-chrome")!.getBoundingClientRect();
    const toggle = document.querySelector("#ai-panel-trigger")!.getBoundingClientRect();
    const controls = document.querySelector(".window-controls")!.getBoundingClientRect();
    return Math.abs(header.right - writing.right) < 1 && Math.abs(toggle.right - controls.left) < 5;
  })).toBe(true);
});

for (const platform of ["Win32", "MacIntel"]) test(`keeps panel widths stable through diagonal window resize on ${platform}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && message.text().includes("flushSync")) errors.push(message.text()); });
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/tests/workspace-resize.html?priority=1");
  const right = page.locator('#ai-sidebar[data-panel]');
  const group = page.locator("#workspace-panels");
  await expect(group).not.toHaveAttribute("data-sidebar-restoring", "true");
  await expect(group).not.toHaveAttribute("data-ai-sidebar-moving", "true");
  await expect.poll(async () => Math.round((await right.boundingBox())!.width)).toBe(420);
  await expect.poll(() => page.locator('#navigation[data-panel]').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(480);
  await page.evaluate(() => {
    const group = document.querySelector<HTMLElement>('#workspace-panels')!;
    const navigation = document.querySelector<HTMLElement>('#navigation[data-panel]')!;
    const right = document.querySelector<HTMLElement>('#ai-sidebar[data-panel]')!;
    const samples: { group: number; navigation: number; right: number }[] = [];
    Object.assign(window, { resizeSamples: samples });
    new ResizeObserver(() => samples.push({ group: group.clientWidth, navigation: navigation.getBoundingClientRect().width,
      right: right.getBoundingClientRect().width })).observe(right);
  });
  for (const width of [1540, 1480, 1420, 1360, 1600]) {
    await page.setViewportSize({ width, height: width / 2 + 100 });
    await expect.poll(() => page.evaluate(width => (window as unknown as {
      resizeSamples: { group: number }[];
    }).resizeSamples.some(sample => sample.group === width), width)).toBe(true);
    await expect.poll(async () => Math.round((await right.boundingBox())!.width)).toBe(420);
  }
  const samples = await page.evaluate(() => (window as unknown as {
    resizeSamples: { group: number; navigation: number; right: number }[];
  }).resizeSamples);
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(sample.navigation, JSON.stringify(samples)).toBeCloseTo(480, 0);
    expect(sample.right, JSON.stringify(samples)).toBeCloseTo(420, 0);
  }
  await test.info().attach("diagonal-resize-samples", { body: JSON.stringify(samples), contentType: "application/json" });
  expect(errors).toEqual([]);
});

for (const platform of ["Win32", "MacIntel"]) test(`collapses the right sidebar at its threshold and stays draggable after reopening on ${platform}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/tests/workspace-resize.html?priority=1");
  const group = page.locator('#workspace-panels');
  const right = page.locator('#ai-sidebar[data-panel]');
  const toggle = page.locator('#ai-panel-trigger');
  const separator = page.getByRole("separator", { name: "调整右侧栏宽度", exact: true });
  await expect.poll(async () => Math.round((await right.boundingBox())!.width)).toBe(420);
  await expect(group).not.toHaveAttribute('data-ai-sidebar-moving', 'true');
  for (const module of ["AI 助手", "内容属性"]) {
    await page.getByRole("button", { name: module, exact: true }).click();
    const bounds = (await separator.boundingBox())!;
    const expandedWidth = (await right.boundingBox())!.width;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(bounds.x + expandedWidth - 200, bounds.y + bounds.height / 2, { steps: 4 });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(separator).toBeVisible();
      await expect.poll(async () => Math.round((await right.boundingBox())!.width)).toBe(300);
      await page.mouse.move(bounds.x + expandedWidth - 100, bounds.y + bounds.height / 2, { steps: 4 });
      await expect.poll(async () => (await right.boundingBox())!.width).toBe(0);
      await expect(separator).toHaveCount(1);
      await page.mouse.move(bounds.x + expandedWidth - 50, bounds.y + bounds.height / 2);
      await page.mouse.move(bounds.x - 20, bounds.y + bounds.height / 2, { steps: 4 });
      await expect.poll(async () => (await right.boundingBox())!.width).toBeGreaterThan(expandedWidth);
      await page.mouse.move(bounds.x + expandedWidth - 100, bounds.y + bounds.height / 2, { steps: 4 });
      await expect.poll(async () => (await right.boundingBox())!.width).toBe(0);
    } finally { await page.mouse.up(); }
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(group).not.toHaveAttribute('data-ai-sidebar-moving', 'true');
    await expect.poll(async () => (await right.boundingBox())!.width).toBeCloseTo(expandedWidth, 0);
    await separator.hover();
    const reopened = (await separator.boundingBox())!;
    const before = (await right.boundingBox())!.width;
    expect(before).toBeCloseTo(expandedWidth, 0);
    await page.mouse.down();
    await expect(separator).toHaveAttribute("data-separator", "active");
    await page.mouse.move(reopened.x - 80, reopened.y + reopened.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await right.boundingBox())!.width).toBeGreaterThan(before + 60);
  }
  expect(errors).toEqual([]);
});

for (const platform of ["Win32", "MacIntel"]) test(`restores a dragged closed sidebar when properties cannot be saved on ${platform}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockNativeWindow(page, platform);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/tests/workspace-resize.html?priority=1");
  await page.getByRole("button", { name: "内容属性", exact: true }).click();
  await page.getByRole("button", { name: "添加属性", exact: true }).click();
  await page.getByRole("menuitem", { name: "原文链接", exact: true }).click();
  const url = page.getByLabel("原文链接", { exact: true });
  await url.fill("invalid-url");
  const right = page.locator('#ai-sidebar[data-panel]');
  const separator = page.getByRole("separator", { name: "调整右侧栏宽度", exact: true });
  const toggle = page.locator('#ai-panel-trigger');
  await expect(page.locator('#workspace-panels')).not.toHaveAttribute('data-ai-sidebar-moving', 'true');
  for (const valid of [false, true]) {
    if (valid) await url.fill("https://example.com/source");
    const width = (await right.boundingBox())!.width;
    const bounds = (await separator.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(bounds.x + width - 100, bounds.y + bounds.height / 2, { steps: 6 });
      await expect.poll(async () => (await right.boundingBox())!.width).toBe(0);
    } finally { await page.mouse.up(); }
    if (!valid) {
      await expect.poll(async () => Math.round((await right.boundingBox())!.width)).toBe(Math.round(width));
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(url).toHaveValue("invalid-url");
      await expect(page.locator('.properties-sidebar').getByRole('alert')).toContainText("HTTP");
    } else {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(url).toHaveValue("https://example.com/source");
    }
  }
  expect(errors).toEqual([]);
});

for (const appearance of ["light", "dark"]) test(`highlights Windows minimize and maximize controls on hover in ${appearance}`, async ({ page }) => {
  await mockNativeWindow(page, "Win32");
  await page.addInitScript(appearance => localStorage.setItem("appearance", JSON.stringify(appearance)), appearance);
  await page.goto("/tests/workspace-resize.html?priority=1");
  const controls = page.getByRole("group", { name: "窗口控制", exact: true });
  const base = await controls.evaluate(element => getComputedStyle(element).backgroundColor);
  for (const name of ["最小化", "最大化"]) {
    const button = controls.getByRole("button", { name, exact: true });
    await button.hover();
    await expect.poll(() => button.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
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
