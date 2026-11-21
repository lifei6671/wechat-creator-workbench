import { expect, test } from "@playwright/test";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`replaces a middle tab without adding an exit visual (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/tests/tab-replacement.html");
    const tabs = page.locator(".tabs > .tab");
    await expect(tabs).toHaveCount(3);
    await page.locator(".tabs").evaluate(element => {
      element.dataset.tabSamples = String(element.children.length);
      const observer = new MutationObserver(() => { element.dataset.tabSamples += `,${element.children.length}`; });
      observer.observe(element, { childList: true });
    });
    await page.getByRole("button", { name: "替换当前文章", exact: true }).click();
    await expect(page.locator("#tab-next")).toBeVisible();
    const samples = await page.locator(".tabs").evaluate(element => element.dataset.tabSamples!.split(",").map(Number));
    expect(Math.max(...samples)).toBe(3);
    expect(await tabs.evaluateAll(elements => elements.map(element => element.getAttribute("data-tab-id")))).toEqual(["first", "next", "last"]);
    await expect(page.locator(".tab-exiting")).toHaveCount(0);
    await page.getByRole("button", { name: "打开新标签", exact: true }).click();
    await expect(tabs).toHaveCount(4);
    await expect(page.locator("#tab-old")).toBeVisible();
  });
}
