import { expect, test } from "@playwright/test";

test("adds independent platform properties, rejects duplicates and persists links on blur", async ({ page }) => {
  await page.goto("/tests/content-properties.html");
  const saved = page.getByTestId("saved");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "添加属性", exact: true }).click();
  await page.getByRole("menuitem", { name: "发布平台", exact: true }).press("Enter");
  const name = page.getByRole("combobox", { name: "发布平台 1", exact: true });
  await expect(name).toBeFocused();
  await expect(page.getByRole("textbox", { name: "发布链接 1", exact: true })).toBeDisabled();
  await page.getByRole("option", { name: "微信公众号", exact: true }).click();
  await page.getByRole("textbox", { name: "发布链接 1", exact: true }).fill("https://mp.weixin.qq.com/s/published");
  await page.getByLabel("标题", { exact: true }).click();
  const ordinaryHeight = (await page.locator(".property-row").filter({ has: page.getByLabel("标题", { exact: true }) }).boundingBox())!.height;
  await expect.poll(async () => (await page.locator(".publication-property").first().boundingBox())!.height).toBe(ordinaryHeight);
  await expect.poll(async () => JSON.parse(await saved.textContent() || "{}").fields.publicationPlatforms).toEqual([
    { platform: "微信公众号", url: "https://mp.weixin.qq.com/s/published" },
  ]);
  await page.getByRole("button", { name: "添加属性", exact: true }).click();
  await page.getByRole("menuitem", { name: "发布平台", exact: true }).press("Enter");
  const second = page.getByRole("combobox", { name: "发布平台 2", exact: true });
  await second.fill(" 微信公众号 ");
  await second.press("Tab");
  await expect(page.getByRole("alert")).toContainText("已添加");
  await second.fill("我的站点");
  await second.press("Enter");
  await page.getByRole("textbox", { name: "发布链接 2", exact: true }).fill("https://example.com/article");
  await page.getByLabel("标题", { exact: true }).click();
  await expect.poll(async () => JSON.parse(await saved.textContent() || "{}").fields.publicationPlatforms).toHaveLength(2);
  await page.getByRole("button", { name: "关闭内容属性", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "内容属性", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "发布链接 2", exact: true })).toHaveValue("https://example.com/article");
  await page.getByRole("button", { name: "发布平台属性菜单 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "移除属性", exact: true }).click();
  await expect.poll(async () => JSON.parse(await saved.textContent() || "{}").fields.publicationPlatforms).toEqual([{ platform: "我的站点", url: "https://example.com/article" }]);
});

test("autosaves ordinary properties and retains failed input until a successful blur retry", async ({ page }) => {
  await page.goto("/tests/content-properties.html?failure=once");
  const title = page.getByLabel("标题", { exact: true });
  await title.fill("保留的标题");
  await title.press("Tab");
  await expect(page.getByRole("alert")).toContainText("模拟保存失败");
  await expect(title).toHaveValue("保留的标题");
  await title.focus();
  await title.press("Tab");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "添加属性", exact: true }).click();
  await page.getByRole("menuitem", { name: "摘要", exact: true }).click();
  await page.getByLabel("摘要", { exact: true }).fill("自动保存的摘要");
  await page.getByRole("button", { name: "关闭内容属性", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => JSON.parse(await page.getByTestId("saved").textContent() || "{}").fields).toMatchObject({ title: "保留的标题", summary: "自动保存的摘要" });
});
