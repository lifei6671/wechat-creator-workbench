import { expect, test } from "@playwright/test";

test("keeps the theme list anchored to its trigger when reopening later themes", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/tests/wechat-publication.html?empty=1");
  const trigger = page.getByRole("combobox", { name: "排版主题", exact: true });
  for (const theme of ["留白禅意", "摸鱼票据", "橄榄手记"]) {
    await trigger.click();
    await page.getByRole("option", { name: theme, exact: true }).click();
    const scrollBefore = await page.evaluate(() => ({ page: window.scrollY, sidebar: document.querySelector(".right-sidebar-content")!.scrollTop }));
    await trigger.click();
    const list = page.getByRole("listbox");
    await expect(list).toHaveAttribute("data-side", "bottom");
    await expect(list).toHaveCSS("animation-name", "none");
    await expect(list).toHaveCSS("transition-duration", "0s");
    await expect(list).toHaveCSS("transform", "none");
    const triggerBounds = await page.locator("#wechat-theme").boundingBox();
    const listBounds = await list.boundingBox();
    expect(Math.abs(listBounds!.y - (triggerBounds!.y + triggerBounds!.height + 4))).toBeLessThanOrEqual(1);
    const positions = await list.evaluate(async element => {
      const positions: number[] = [];
      for (let index = 0; index < 8; index++) { await new Promise(requestAnimationFrame); positions.push(element.getBoundingClientRect().top); }
      return positions;
    });
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => ({ page: window.scrollY, sidebar: document.querySelector(".right-sidebar-content")!.scrollTop }))).toEqual(scrollBefore);
    if (theme === "橄榄手记") await page.screenshot({ path: `output/playwright/anchored-theme-menu-${test.info().project.name}.png` });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
});

test("waits for an explicit recommendation request and copies an empty list without generating", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html?empty=1");
  await expect(page.getByRole("button", { name: "自动推荐", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制公众号格式", exact: true })).toBeEnabled();
  await expect(page.getByTestId("generation-calls")).toHaveText("0");
  await expect(page.locator(".wechat-recommendation-row")).toHaveCount(0);
  await page.getByRole("button", { name: "复制公众号格式", exact: true }).click();
  await expect(page.getByTestId("copied")).toHaveText("[]");
  await expect(page.getByTestId("generation-calls")).toHaveText("0");
  await page.getByRole("button", { name: "自动推荐", exact: true }).click();
  await expect(page.locator(".wechat-recommendation-row")).toHaveCount(5);
  await expect(page.getByTestId("generation-calls")).toHaveText("1");
});

test("suggests multiple exact authors on focus and saves the focused draft before backup", async ({ page }, testInfo) => {
  await page.goto("/tests/wechat-publication.html?empty=1");
  await page.getByRole("tab", { name: "默认设置", exact: true }).click();
  const authors = page.getByRole("combobox", { name: "推荐作者", exact: true });
  await authors.focus();
  await expect(page.getByRole("option", { name: "李飞", exact: true })).toBeVisible();
  await expect(page.getByTestId("author-calls")).toHaveText("1");
  await page.getByRole("option", { name: "李飞", exact: true }).click();
  await page.getByRole("option", { name: "张明", exact: true }).click();
  await authors.fill("王");
  await expect(page.getByRole("option", { name: "王林", exact: true })).toBeVisible();
  await expect(page.getByTestId("author-calls")).toHaveText("1");
  await authors.press("ArrowDown");
  await authors.press("Enter");
  await expect.poll(async () => JSON.parse(await page.getByTestId("defaults").textContent() || "{}").recommendationAuthors).toEqual(["李飞", "张明", "王林"]);
  await authors.fill("Alice");
  await authors.press("Enter");
  await authors.fill("alice");
  await authors.press("Enter");
  if (testInfo.project.name === "chromium") await page.screenshot({ path: "output/publication-authors-implemented.png" });
  await authors.fill("新作者");
  await page.getByTestId("backup-barrier").dispatchEvent("click");
  await expect(page.getByTestId("barrier")).toHaveText("true");
  await expect.poll(async () => JSON.parse(await page.getByTestId("defaults").textContent() || "{}").recommendationAuthors).toEqual(["李飞", "张明", "王林", "Alice", "alice", "新作者"]);
  await page.getByRole("tab", { name: "当前文章", exact: true }).click();
  await expect(page.getByTestId("generation-calls")).toHaveText("0");
  await page.getByRole("button", { name: "自动推荐", exact: true }).click();
  await expect(page.getByTestId("generated-authors")).toHaveText(JSON.stringify(["李飞", "张明", "王林", "Alice", "alice", "新作者"]));
});

test("keeps the pending author when a selected author is removed", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html?empty=1");
  await page.getByRole("tab", { name: "默认设置", exact: true }).click();
  const authors = page.getByRole("combobox", { name: "推荐作者", exact: true });
  await expect(authors).toBeEnabled();
  await authors.fill("Alice");
  await authors.press("Enter");
  await expect.poll(async () => JSON.parse(await page.getByTestId("defaults").textContent() || "{}").recommendationAuthors).toEqual(["Alice"]);
  await authors.fill("Bob");
  await page.getByRole("button", { name: "移除作者 Alice", exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.getByTestId("defaults").textContent() || "{}").recommendationAuthors).toEqual(["Bob"]);
  await expect(page.getByRole("button", { name: "移除作者 Bob", exact: true })).toBeVisible();
  await expect(authors).toHaveValue("");
});

test("lifts the original recommendation row and previews its insertion before saving", async ({ page }, testInfo) => {
  await page.goto("/tests/wechat-publication.html");
  await expect(page.locator(".wechat-publishing-footer button")).toBeEnabled();
  const rows = page.locator(".wechat-recommendation-row");
  await expect(rows).toHaveCount(5);
  const first = (await rows.first().getByRole("button", { name: /拖动排序/ }).boundingBox())!;
  const source = (await rows.first().elementHandle())!;
  const original = (await rows.first().boundingBox())!;
  const third = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + 40, third.y + third.height - 4);
  const ghost = page.locator(".wechat-recommendation-row[data-dragging]");
  await expect(ghost).toHaveText("向量检索实践 1");
  expect(await source.evaluate(element => element.hasAttribute("data-dragging"))).toBe(true);
  expect(JSON.parse(await page.getByTestId("saved").textContent() || "{}").wechatPublication.recommendations.mode).toBe("auto");
  const before = (await ghost.boundingBox())!;
  const offsetX = first.x + first.width / 2 - original.x;
  const offsetY = first.y + first.height / 2 - original.y;
  expect(Math.abs(before.x - (third.x + 40 - offsetX))).toBeLessThanOrEqual(1);
  expect(Math.abs(before.y - (third.y + third.height - 4 - offsetY))).toBeLessThanOrEqual(1);
  expect(before.width).toBeCloseTo(original.width, 0);
  expect(before.height).toBeCloseTo(original.height, 0);
  await expect(rows.first()).toContainText("向量检索实践 2");
  await expect(rows.nth(2)).toContainText("向量检索实践 1");
  expect(await page.locator('.wechat-recommendation-slot[data-dragging]').evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(original.height, 0);
  await page.mouse.move(third.x + 60, third.y + third.height - 2);
  const after = (await ghost.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(20, 0);
  expect(after.y - before.y).toBeCloseTo(2, 0);
  await expect(rows.first()).toContainText("向量检索实践 2");
  if (testInfo.project.name === "chromium") await page.screenshot({ path: "output/wechat-recommendation-drag.png" });
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await expect(rows.nth(2)).toContainText("向量检索实践 1");
  await expect.poll(async () => JSON.parse(await page.getByTestId("saved").textContent() || "{}").wechatPublication.recommendations.items.map((item: { entryId: string }) => item.entryId))
    .toEqual(["past-1", "past-2", "past-0", "past-3", "past-4"]);

  const moved = (await rows.nth(2).getByRole("button", { name: /拖动排序/ }).boundingBox())!;
  const top = (await rows.first().boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + 40, top.y + 3);
  await expect(rows.first()).toContainText("向量检索实践 1");
  await page.mouse.up();
  await expect(rows.first()).toContainText("向量检索实践 1");
});

test("cancels a recommendation drag without persisting and clears capture feedback", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html");
  const rows = page.locator(".wechat-recommendation-row");
  await expect(rows).toHaveCount(5);
  const handle = (await rows.first().getByRole("button", { name: /拖动排序/ }).boundingBox())!;
  const target = (await rows.nth(2).boundingBox())!;
  for (const cancel of ["escape", "pointercancel", "lostpointercapture", "outside"]) {
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + 3);
    await expect(page.locator(".wechat-recommendation-row[data-dragging]")).toBeVisible();
    if (cancel === "escape") await page.keyboard.press("Escape");
    else if (cancel === "outside") await page.mouse.move(40, 150);
    else await page.getByRole("list", { name: "当前推荐文章" }).dispatchEvent(cancel);
    await page.mouse.up();
    await expect(page.locator(".wechat-recommendation-row[data-dragging]")).toHaveCount(0);
    await expect(page.locator("[data-drag-target], [data-dragging]")).toHaveCount(0);
    await expect(rows.first()).toContainText("向量检索实践 1");
  }
});

test("switches sidebar tools directly and autosaves properties without a modal", async ({ page }, testInfo) => {
  await page.goto("/tests/wechat-publication.html?windows=1");
  await expect(page.locator(".wechat-recommendation-row")).toHaveCount(5);
  const toolbar = page.getByRole("toolbar", { name: "右侧栏工具", exact: true });
  const buttons = toolbar.getByRole("button");
  await expect(buttons).toHaveCount(4);
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator(".right-sidebar-header").getByRole("tablist")).toHaveCount(0);
  for (const button of await buttons.all()) expect((await button.boundingBox())!.width).toBeLessThanOrEqual(32);
  const background = await page.locator(".workbench-chrome").evaluate(element => getComputedStyle(element).backgroundColor);
  expect(await page.locator(".right-sidebar-header").evaluate(element => getComputedStyle(element).backgroundColor)).toBe(background);
  expect(await page.locator(".right-sidebar-header").evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe("0px");
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  await expect(page.locator(".ai-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI 聊天", exact: true })).toHaveCount(0);
  const actions = page.getByRole("group", { name: "对话操作", exact: true });
  await expect(actions.getByRole("button", { name: "对话记录", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  expect(await actions.evaluate(element => getComputedStyle(element).position)).toBe("absolute");
  const toolsBounds = (await actions.boundingBox())!, titleBounds = (await toolbar.boundingBox())!;
  expect(toolsBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
  await actions.getByRole("button", { name: "对话记录", exact: true }).click();
  await expect(actions.getByRole("button", { name: "对话记录", exact: true })).toHaveAttribute("aria-pressed", "true");
  const historyBounds = (await page.locator(".ai-thread-list").boundingBox())!;
  expect(historyBounds.y).toBeGreaterThanOrEqual(toolsBounds.y + toolsBounds.height);
  expect(historyBounds.y - toolsBounds.y - toolsBounds.height).toBeLessThanOrEqual(12);
  await actions.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(actions.getByRole("button", { name: "对话记录", exact: true })).toHaveAttribute("aria-pressed", "false");
  const sidebar = page.locator(".right-sidebar");
  await sidebar.evaluate(element => { element.style.width = "276px"; });
  const narrowBounds = (await sidebar.boundingBox())!;
  for (const button of await actions.getByRole("button").all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(narrowBounds.x + narrowBounds.width);
  }
  await sidebar.evaluate(element => { element.style.width = ""; });
  await expect(page.locator(".wechat-publishing-panel")).toHaveCount(0);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: "output/right-sidebar-ai.png" });
  await page.getByRole("button", { name: "内容属性", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("如何构建可靠的知识检索");
  await page.getByRole("button", { name: "添加属性", exact: true }).click();
  await page.getByRole("menuitem", { name: "摘要", exact: true }).click();
  await page.getByLabel("摘要", { exact: true }).fill("侧栏中的摘要");
  await page.getByRole("button", { name: "公众号设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "公众号设置", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "内容属性", exact: true }).click();
  await expect(page.getByLabel("摘要", { exact: true })).toHaveValue("侧栏中的摘要");
  await page.getByRole("button", { name: "添加属性", exact: true }).click();
  await page.getByRole("menuitem", { name: "发布平台", exact: true }).click();
  await page.getByRole("option", { name: "微信公众号", exact: true }).click();
  await page.getByRole("textbox", { name: "发布链接 1", exact: true }).fill("invalid-url");
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  await expect(page.getByRole("button", { name: "内容属性", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".properties-sidebar")).toContainText("HTTP");
  await page.getByRole("textbox", { name: "发布链接 1", exact: true }).fill("https://mp.weixin.qq.com/s/published");
  if (testInfo.project.name === "chromium") await page.screenshot({ path: "output/right-sidebar-properties.png" });
  await page.getByRole("button", { name: "内容属性", exact: true }).press("ArrowLeft");
  await expect(page.getByRole("button", { name: "AI 助手", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "内容属性", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "AI 助手", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "AI 助手", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "AI 助手", exact: true }).press("Home");
  await expect(page.getByRole("button", { name: "公众号设置", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "公众号设置", exact: true }).press("Space");
  await expect(page.getByRole("button", { name: "公众号设置", exact: true })).toHaveAttribute("aria-pressed", "true");
  const saved = JSON.parse(await page.getByTestId("saved").textContent() || "{}");
  expect(saved.summary).toBe("侧栏中的摘要");
  expect(saved.publicationPlatforms).toEqual([{ platform: "微信公众号", url: "https://mp.weixin.qq.com/s/published" }]);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: "output/sidebar-toolbar-preview.png" });
});

for (const dark of [false, true]) test(`keeps all three sidebar backgrounds consistent in ${dark ? "dark" : "light"}`, async ({ page }) => {
  await page.goto(`/tests/wechat-publication.html?windows=1${dark ? "&dark=1" : ""}`);
  const background = await page.locator(".right-sidebar").evaluate(element => getComputedStyle(element).backgroundColor);
  for (const [name, selector] of [["公众号设置", ".wechat-publishing-panel"], ["AI 助手", ".ai-panel"], ["内容属性", ".properties-sidebar"]]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(selector)).toBeVisible();
    expect(await page.locator(selector).evaluate(element => getComputedStyle(element).backgroundColor)).toBe(background);
  }
});

test("keeps the history list close to its actions and stable when deleting fails", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html?windows=1");
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  await page.getByRole("button", { name: "对话记录", exact: true }).click();
  const list = page.locator(".ai-thread-list");
  await expect(list).toBeVisible();
  const before = (await list.boundingBox())!;
  await list.locator("li").first().hover();
  await page.getByRole("button", { name: "删除对话：当前对话", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("测试删除失败");
  expect((await list.boundingBox())!.y).toBe(before.y);
  await expect(list.locator(".ai-thread-title")).toHaveText("当前对话");
});

test("spaces sidebar icons and keeps the shared toggle clear of Windows window controls", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html?windows=1");
  await expect(page.getByRole("button", { name: "关闭右侧栏", exact: true })).toHaveCount(0);
  const tools = page.getByRole("toolbar", { name: "右侧栏工具", exact: true }).getByRole("button");
  const buttons = await Promise.all((await tools.all()).map(button => button.boundingBox()));
  for (let i = 1; i < buttons.length; i++) expect(buttons[i]!.x - buttons[i - 1]!.x - buttons[i - 1]!.width).toBeGreaterThanOrEqual(12);
  const controls = (await page.getByTestId("window-controls").boundingBox())!;
  expect(buttons.at(-1)!.x + buttons.at(-1)!.width).toBeLessThanOrEqual(controls.x);
  const toggle = page.getByRole("button", { name: "隐藏右侧栏", exact: true });
  const header = (await page.locator(".workbench-chrome").boundingBox())!, bounds = (await toggle.boundingBox())!;
  expect(header.x + header.width - bounds.x - bounds.width).toBeGreaterThanOrEqual(8);
  await toggle.hover();
  await expect(page.getByRole("tooltip")).toHaveText("隐藏右侧栏");
});

test("adds selected candidates using only the persisted recommendation fields", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html");
  await expect(page.locator(".wechat-publishing-footer button")).toBeEnabled();
  await page.getByRole("button", { name: "添加文章", exact: true }).click();
  await page.getByRole("tab", { name: "全部文章", exact: true }).click();
  await page.getByRole("checkbox", { name: "向量检索实践 6", exact: true }).check();
  await page.getByRole("checkbox", { name: "向量检索实践 8", exact: true }).check();
  await page.getByRole("button", { name: "添加 2 篇", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const saved = JSON.parse(await page.getByTestId("saved").textContent() || "{}");
  expect(saved.wechatPublication.recommendations.items.slice(-2)).toEqual([
    { entryId: "past-5", title: "向量检索实践 6", url: "https://mp.weixin.qq.com/s/past-5" },
    { entryId: "past-7", title: "向量检索实践 8", url: "https://mp.weixin.qq.com/s/past-7" },
  ]);
  expect(saved.wechatPublication.recommendations.mode).toBe("manual");
  expect(saved.contentMd).not.toContain("推荐阅读");
  await page.getByTestId("backup-barrier").click();
  await expect(page.getByTestId("barrier")).toHaveText("true");
});

test("retries a failed addition without appending the same article twice", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html?failure=add-once");
  await expect(page.locator(".wechat-recommendation-row")).toHaveCount(5);
  await page.getByRole("button", { name: "添加文章", exact: true }).click();
  await page.getByRole("checkbox", { name: "向量检索实践 6", exact: true }).check();
  await page.getByRole("button", { name: "添加 1 篇", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("模拟保存失败");
  await page.getByRole("button", { name: "添加 1 篇", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".wechat-recommendation-row")).toHaveCount(6);
  const saved = JSON.parse(await page.getByTestId("saved").textContent() || "{}");
  expect(saved.wechatPublication.recommendations.items.filter((item: {entryId:string}) => item.entryId === "past-5")).toHaveLength(1);
});

test("edits, reorders, adds beyond five, keeps manual empty, and restores generation", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html");
  const rows = page.locator(".wechat-recommendation-row");
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId("preview").getByRole("link")).toHaveCount(5);
  await page.getByRole("button", { name: "拖动排序：向量检索实践 1", exact: true }).press("Alt+ArrowDown");
  await expect(rows.first()).toContainText("向量检索实践 2");
  await page.getByRole("button", { name: "添加文章", exact: true }).click();
  await page.getByRole("tab", { name: "全部文章", exact: true }).click();
  await page.getByRole("checkbox", { name: "向量检索实践 6", exact: true }).check();
  await page.getByRole("checkbox", { name: "向量检索实践 8", exact: true }).check();
  await page.getByRole("button", { name: "添加 2 篇", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(rows).toHaveCount(7);
  await page.getByRole("button", { name: "复制公众号格式", exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.getByTestId("copied").textContent() || "[]").length).toBe(7);
  for (let count = 7; count > 0; count--) {
    await rows.first().getByRole("button", { name: /推荐文章 \d+ 操作/ }).click();
    await page.getByRole("menuitem", { name: "移除推荐", exact: true }).click();
    await expect(rows).toHaveCount(count - 1);
  }
  await expect(page.getByTestId("preview").getByRole("link")).toHaveCount(0);
  await page.getByLabel("生成数量", { exact: true }).fill("2");
  await page.getByLabel("生成数量", { exact: true }).press("Tab");
  await expect(rows).toHaveCount(0);
  await page.getByRole("button", { name: "自动推荐", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(rows).toHaveCount(0);
  const saved = JSON.parse(await page.getByTestId("saved").textContent() || "{}");
  expect(saved.contentMd).not.toContain("推荐阅读");
  expect(saved.wechatPublication.recommendations.mode).toBe("manual");
});

test("flushes the focused shared count before backup and renders dark layout without overflow", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html?dark=1");
  await expect(page.locator(".wechat-recommendation-row")).toHaveCount(5);
  await page.getByRole("tab", { name: "默认设置", exact: true }).click();
  await page.getByLabel("默认生成数量", { exact: true }).fill("7");
  await page.getByTestId("backup-barrier").dispatchEvent("click");
  await expect(page.getByTestId("barrier")).toHaveText("true");
  await expect.poll(async () => JSON.parse(await page.getByTestId("defaults").textContent() || "{}").recommendationCount).toBe(7);
  const overflow = await page.locator(".wechat-publishing-panel").evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
});
