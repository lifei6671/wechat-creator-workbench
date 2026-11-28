import { expect, test } from "@playwright/test";

for (const width of [500, 1000]) for (const dark of [false, true]) {
  test(`edits sync address without overflow and reports real completion (${width}, dark=${dark})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/tests/sync-address.html' + (dark ? '?dark' : ''));
    const input = page.getByRole("textbox", { name: "服务地址" });
    const button = page.getByRole("button", { name: "保存", exact: true });
    await expect(input).toHaveValue("https://original.example.test/");
    await expect(button).toBeDisabled();
    await input.fill("https://new.example.test");
    const row = input.locator("xpath=ancestor::div[contains(@class,'setting-row')]");
    const height = await row.evaluate(element => element.getBoundingClientRect().height);
    const bounds = await button.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await button.click();
    await expect(input).toBeDisabled();
    await expect(button).toBeDisabled();
    await expect(button.locator(".rt-Spinner")).toHaveCount(1);
    await page.evaluate(() => window.finishAddressChange(false));
    await expect(row.getByRole("alert")).toContainText("新地址不属于当前同步服务");
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(height);
    await expect(input).toHaveValue("https://new.example.test");
    await expect(button).toBeEnabled();
    await button.click();
    await page.evaluate(() => window.finishAddressChange(true));
    await expect(input).toHaveValue("https://new.example.test/");
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
    await expect(row.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
