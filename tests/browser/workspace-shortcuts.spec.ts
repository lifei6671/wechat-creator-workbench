import { expect, test } from "@playwright/test";

for (const platform of ["Win32", "MacIntel"]) for (const zoom of [1, 1.5]) {
  test(`records compact workspace shortcuts on ${platform} at ${zoom}x`, async ({ page }) => {
    await page.addInitScript(platform => Object.defineProperty(navigator, "platform", { value: platform }), platform);
    await page.goto("/tests/workspace-shortcuts.html");
    await page.locator("html").evaluate((element, zoom) => { element.style.zoom = String(zoom); }, zoom);
    const modifier = platform === "MacIntel" ? "Meta" : "Control";
    const prefix = platform === "MacIntel" ? "⌘" : "Ctrl";
    const markdown = page.getByRole("button", { name: "设置复制 Markdown 原文快捷键", exact: true });
    const wechat = page.getByRole("button", { name: "设置复制公众号格式快捷键", exact: true });
    await expect(page.locator(".shortcut-trigger")).toHaveCount(9);
    await expect(page.getByRole("button", { name: "设置阅读模式快捷键", exact: true })).toHaveText(`${prefix}+R`);
    await expect(page.getByRole("button", { name: "设置切换编辑视图快捷键", exact: true })).toHaveText(`${prefix}+W`);
    for (const row of await page.locator(".workspace-shortcuts .setting-row").all()) {
      expect((await row.boundingBox())!.height / zoom).toBeLessThanOrEqual(60);
      const label = (await row.locator("label").boundingBox())!, trigger = (await row.locator(".shortcut-trigger").boundingBox())!;
      expect(Math.abs(label.y + label.height / 2 - trigger.y - trigger.height / 2)).toBeLessThan(1);
    }
    await expect(markdown).toHaveText(`${prefix}+Shift+C`);
    await expect(wechat).toHaveText(`${prefix}+${platform === "MacIntel" ? "Option" : "Alt"}+C`);
    await markdown.click();
    const input = page.getByRole("textbox", { name: "录入复制 Markdown 原文快捷键", exact: true });
    const row = input.locator("xpath=ancestor::div[contains(@class,'setting-row')]");
    const height = (await row.boundingBox())!.height;
    await input.press(`${modifier}+s`);
    await expect(row.getByRole("alert")).toHaveText("该快捷键已被其他操作占用");
    expect((await row.boundingBox())!.height).toBe(height);
    const errorFits = await row.locator(".action-error-slot").evaluate(slot => slot.scrollHeight <= slot.clientHeight);
    expect(errorFits).toBe(true);
    await input.press(`${modifier}+Alt+j`);
    await expect(markdown).toHaveText(`${prefix}+${platform === "MacIntel" ? "Option" : "Alt"}+J`);
    await wechat.click();
    const other = page.getByRole("textbox", { name: "录入复制公众号格式快捷键", exact: true });
    await other.press(`${modifier}+Alt+j`);
    await expect(page.getByRole("alert")).toHaveText("该快捷键已被其他操作占用");
    await other.press("Escape");
    await expect(wechat).toHaveText(`${prefix}+${platform === "MacIntel" ? "Option" : "Alt"}+C`);
    await page.getByRole("button", { name: "设置切换编辑视图快捷键", exact: true }).click();
    const view = page.getByRole("textbox", { name: "录入切换编辑视图快捷键", exact: true });
    await view.press(`${modifier}+Alt+j`);
    await expect(page.getByRole("alert")).toHaveText("该快捷键已被其他操作占用");
    await view.press("Escape");
    await page.getByRole("button", { name: "删除复制 Markdown 原文快捷键", exact: true }).click();
    await expect(markdown).toHaveText("点击设置");
    await page.reload();
    await expect(markdown).toHaveText("点击设置");
    await expect(page.getByRole("button", { name: "删除复制 Markdown 原文快捷键", exact: true })).toBeDisabled();
    await markdown.click();
    await page.getByRole("textbox", { name: "录入复制 Markdown 原文快捷键", exact: true }).press(`${modifier}+Shift+c`);
    await expect(markdown).toHaveText(`${prefix}+Shift+C`);
    const reading = page.getByRole("button", { name: "设置阅读模式快捷键", exact: true });
    await reading.click();
    await page.getByRole("textbox", { name: "录入阅读模式快捷键", exact: true }).press("F9");
    await expect(reading).toHaveText("F9");
    await page.getByRole("button", { name: "删除切换编辑视图快捷键", exact: true }).click();
    await page.reload();
    await page.locator("html").evaluate((element, zoom) => { element.style.zoom = String(zoom); }, zoom);
    await expect(reading).toHaveText("F9");
    const preview = page.getByRole("button", { name: "设置切换编辑视图快捷键", exact: true });
    await expect(preview).toHaveText("点击设置");
    await preview.click();
    await page.getByRole("textbox", { name: "录入切换编辑视图快捷键", exact: true }).press(`${modifier}+w`);
    await expect(preview).toHaveText(`${prefix}+W`);
    await page.screenshot({ path: test.info().outputPath("workspace-shortcuts.png") });
  });
}
