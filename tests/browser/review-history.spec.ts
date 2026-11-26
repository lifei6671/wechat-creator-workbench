import { expect, test } from "@playwright/test";

test("cached conclusions expand without original text, native calls or editor decorations", async ({ page }) => {
  await page.goto("/tests/article-review.html?history=1");
  const history = page.getByRole("list", { name: "审查记录" });
  await expect(history.locator("li")).toHaveCount(2);
  await expect(history).not.toContainText("另一篇文章的记录");
  await expect(history).not.toContainText("未知归属记录");
  const old = history.getByRole("button", { name: /^旧文章的检测/ });
  await expect(old).toHaveAttribute("aria-expanded", "false");
  await old.click();
  await expect(old).toHaveAttribute("aria-expanded", "true");
  await expect(history.locator(".review-history-conclusion:visible")).toContainText("80%");
  await expect(history.locator(".review-history-conclusion:visible")).toContainText("全文检测");
  await expect(history).not.toContainText("第一段中文");
  await expect(page.locator(".review-mark")).toHaveCount(0);
  expect(await page.evaluate(() => window.reviewHarness.calls)).toEqual([]);
  await history.getByRole("button", { name: /^朱雀文本检测/ }).click();
  await expect(history.locator(".review-history-conclusion:visible")).not.toContainText("全文检测");
  await expect(history.locator(".review-history-conclusion:visible")).toContainText("选区检测");
  await expect(old).toHaveAttribute("aria-expanded", "false");
});

test("delete waits for persistence, shows feedback, then removes only its own record", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tests/article-review.html?history=1&hold-delete=1");
  const history = page.getByRole("list", { name: "审查记录" });
  await expect(history.locator("li")).toHaveCount(2);
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  const remove = history.getByRole("button", { name: "删除记录：旧文章的检测" });
  await history.locator("li").first().hover();
  await remove.click();
  await expect(remove).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "检测全文", exact: true })).toBeDisabled();
  await page.clock.runFor(3000);
  await expect(history.locator("li")).toHaveCount(2);
  await expect(remove).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => window.reviewHistoryHarness.completeDeletion());
  await expect(remove).toHaveAttribute("data-feedback-state", "success");
  await page.clock.runFor(999);
  await expect(history.locator("li")).toHaveCount(2);
  await page.clock.runFor(1);
  await expect(history.locator("li")).toHaveCount(1);
  expect(await page.evaluate(() => window.reviewHistoryHarness.deletedRecords)).toEqual(["old"]);
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect(page.getByRole("button", { name: "已清空", exact: true })).toBeDisabled();
  await expect(page.getByText("暂无审查记录", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.reviewHistoryHarness.records().map(record => record.id))).toEqual(["other", "unbound"]);
  await page.evaluate(() => window.reviewHarness.swap());
  await expect(history.locator("li")).toHaveCount(1);
  await expect(history).toContainText("另一篇文章的记录");
});

test("switching articles rejects a late history response from the previous article", async ({ page }) => {
  await page.goto("/tests/article-review.html?history=1&hold-list=1");
  await expect(page.getByText("正在读取记录…")).toBeVisible();
  await page.evaluate(() => window.reviewHarness.swap());
  const history = page.getByRole("list", { name: "审查记录" });
  await expect(history.locator("li")).toHaveCount(1);
  await expect(history).toContainText("另一篇文章的记录");
  await page.evaluate(() => window.reviewHistoryHarness.completeList());
  await expect(history.locator("li")).toHaveCount(1);
  await expect(history).not.toContainText("旧文章的检测");
  await expect(history).not.toContainText("未知归属记录");
  expect(await page.evaluate(() => window.reviewHistoryHarness.historyCalls)).toEqual(["list:article-0", "list:article-1"]);
});

test("a late detection remains associated with its captured article", async ({ page }) => {
  await page.goto("/tests/article-review.html?history=1");
  await page.getByRole("button", { name: "检测全文", exact: true }).click();
  await page.evaluate(() => window.reviewHarness.swap());
  const history = page.getByRole("list", { name: "审查记录" });
  await expect(history).toContainText("另一篇文章的记录");
  await page.evaluate(() => window.reviewHarness.complete());
  await expect(history.locator("li")).toHaveCount(1);
  await expect(history).not.toContainText("测试文章 0");
  const stored = await page.evaluate(() => window.reviewHistoryHarness.records().find(record => record.id === "new"));
  expect(stored?.entryId).toBe("article-0");
  await expect(page.locator(".review-mark")).toHaveCount(0);
});

test("a deletion completed after switching cannot change the next article's history", async ({ page }) => {
  await page.goto("/tests/article-review.html?history=1&hold-delete=1");
  const history = page.getByRole("list", { name: "审查记录" });
  await history.locator("li").first().hover();
  await history.getByRole("button", { name: "删除记录：旧文章的检测" }).click();
  await page.evaluate(() => window.reviewHarness.swap());
  await expect(history).toContainText("另一篇文章的记录");
  await page.evaluate(() => window.reviewHistoryHarness.completeDeletion());
  await expect(history.locator("li")).toHaveCount(1);
  await expect(history).toContainText("另一篇文章的记录");
  expect(await page.evaluate(() => window.reviewHistoryHarness.records().map(record => record.id))).toEqual(["legacy", "other", "unbound"]);
});

for (const operation of ["delete", "clear"] as const) test(`${operation} failures preserve cached conclusions`, async ({ page }) => {
  await page.goto(`/tests/article-review.html?history=1&${operation}-failure=1`);
  const history = page.getByRole("list", { name: "审查记录" });
  const row = history.locator("li").first();
  if (operation === "delete") {
    await row.hover();
    await row.getByRole("button", { name: "删除记录：旧文章的检测" }).click();
  } else await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect(history.locator("li")).toHaveCount(2);
  await expect(page.getByRole("alert")).toHaveText(operation === "delete" ? "合成删除失败" : "合成清空失败");
});

test("a completed review refreshes cache history and retains scope and title", async ({ page }) => {
  await page.goto("/tests/article-review.html");
  await page.getByRole("button", { name: "检测全文", exact: true }).click();
  await page.evaluate(() => window.reviewHarness.complete());
  const history = page.getByRole("list", { name: "审查记录" });
  await history.getByRole("button", { name: /^测试文章 0/ }).click();
  await expect(history.locator(".review-history-conclusion:visible")).toContainText("全文检测");
  expect(await page.evaluate(() => window.reviewHistoryHarness.context())).toEqual({ entryId: "article-0", title: "测试文章 0", scope: "document" });
});

for (const platform of ["Win32", "MacIntel"]) test(`timeline statuses precede timestamps and use distinct outline colors on ${platform}`, async ({ page }) => {
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
          throw new Error(`Unexpected native call: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    });
  }, platform);
  await page.goto("/tests/workspace-resize.html?statuses=1");
  const badges = page.locator(".timeline-status");
  await expect(badges).toHaveCount(3);
  const metadata = await badges.evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    const timeStyle = getComputedStyle(node.nextElementSibling!);
    return { text: node.textContent, next: node.nextElementSibling?.tagName, size: style.fontSize,
      sameTypography: style.font === timeStyle.font,
      height: node.getBoundingClientRect().height,
      color: style.color, border: style.borderTopStyle, fits: node.getBoundingClientRect().right <= node.parentElement!.getBoundingClientRect().right };
  }));
  expect(metadata.map(item => item.text)).toEqual(["草稿", "待发布", "已发布"]);
  expect(new Set(metadata.map(item => item.color)).size).toBe(3);
  expect(metadata.every(item => item.next === "TIME" && item.size === "12px" && item.sameTypography && item.height <= 17 && item.border === "solid" && item.fits)).toBe(true);
});
