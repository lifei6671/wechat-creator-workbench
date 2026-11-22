import { expect, test } from "@playwright/test";

// Native mouse semantics cannot be emulated by overriding navigator.platform: macOS treats Control-click as a context menu.
for (const mode of ["current", "new-tab"]) {
  test(`opens articles with the primary modifier on ${process.platform} with ${mode} preference`, async ({ page }) => {
    await page.goto(`/tests/entry-open.html?mode=${mode}`);
    const opened = page.getByTestId("opened");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    let count = 0;
    for (const [id, title] of [["tree", "目录文章"], ["pinned", "置顶文章"], ["detail", "导入文章"], ["search", "搜索文章"], ["timeline", "时间流文章"]]) {
      const button = page.getByRole("button", { name: title, exact: true });
      await button.click();
      await expect(opened).toHaveText(JSON.stringify({ count: ++count, id, mode }));
      await button.click({ modifiers: [modifier] });
      await expect(opened).toHaveText(JSON.stringify({ count: ++count, id, mode: "new-tab" }));
      await button.click();
      await expect(opened).toHaveText(JSON.stringify({ count: ++count, id, mode }));
      await button.focus();
      await button.press("Enter");
      await expect(opened).toHaveText(JSON.stringify({ count: ++count, id, mode }));
    }
    await page.getByRole("button", { name: "展开匹配", exact: true }).click({ modifiers: [modifier] });
    await expect(page.getByTestId("action")).toHaveText("toggle");
    await page.getByRole("button", { name: "时间流文章", exact: true }).hover();
    await page.getByRole("button", { name: "置顶", exact: true }).click({ modifiers: [modifier] });
    await expect(page.getByTestId("action")).toHaveText("pin");
    await expect(opened).toHaveText(JSON.stringify({ count, id: "timeline", mode }));
    await page.getByRole("button", { name: "目录文章", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "打开", exact: true })).toBeVisible();
    await expect(opened).toHaveText(JSON.stringify({ count, id: "timeline", mode }));
  });
}
