import { expect, test } from "@playwright/test";

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
  await page.getByRole("button", { name: "重新推荐", exact: true }).click();
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
