import { expect, test } from "@playwright/test";

test("keeps the sidebar close button clear of Windows window controls", async ({ page }) => {
  await page.goto("/tests/wechat-publication.html?windows=1");
  const close = page.getByRole("button", { name: "关闭公众号侧栏", exact: true });
  await expect(close).toBeVisible();
  const button = (await close.boundingBox())!, controls = (await page.getByTestId("window-controls").boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(controls.x);
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
