import { expect, test } from "@playwright/test";

for (const appearance of ["light", "dark"]) for (const dialog of [false, true]) {
  test(`anchors semantic toast colors to the window in ${appearance}, dialog=${dialog}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const [tone, color] of [["error", "red"], ["success", "green"], ["warning", "amber"], ["info", "blue"]]) {
      await page.goto(`/tests/workspace-toast.html?tone=${tone}&appearance=${appearance}${dialog ? "&dialog" : ""}`);
      const toast = page.locator(".workspace-toast");
      await toast.hover();
      await expect.poll(() => toast.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
      const bounds = (await toast.boundingBox())!;
      expect(bounds.y).toBeCloseTo(52, 0);
      expect(bounds.x + bounds.width).toBeCloseTo(1268, 0);
      const icon = (await toast.locator(".toast-icon").boundingBox())!;
      const closeIcon = (await toast.locator(".toast-close svg").boundingBox())!;
      expect(Math.abs(icon.y + icon.height / 2 - closeIcon.y - closeIcon.height / 2)).toBeLessThanOrEqual(1);
      const colors = await toast.evaluate((element, color) => {
        const style = getComputedStyle(element);
        const probe = element.appendChild(document.createElement("span"));
        const token = (step: number) => {
          probe.style.color = `var(--${color}-${step})`;
          return getComputedStyle(probe).color;
        };
        const result = { text: style.color, border: style.borderTopColor, background: style.backgroundColor,
          icon: getComputedStyle(element.querySelector(".toast-icon")!).color,
          close: getComputedStyle(element.querySelector(".toast-close")!).color,
          expectedText: token(11), expectedBorder: token(7), expectedBackground: token(2) };
        probe.remove();
        return result;
      }, color);
      expect(colors.text).toBe(colors.expectedText);
      expect(colors.border).toBe(colors.expectedBorder);
      expect(colors.background).toBe(colors.expectedBackground);
      expect(colors.icon).toBe(colors.text);
      expect(colors.close).toBe(colors.text);
      await expect(toast.getByRole(tone === "error" ? "alert" : "status")).toBeVisible();
      if (appearance === "light" && !dialog && tone === "error") await toast.screenshot({ path: test.info().outputPath("toast-error.png") });
      await toast.getByRole("button", { name: "关闭通知" }).click();
      await expect(toast).toHaveCount(0);
    }
  });
}

test("wraps long notices within a narrow window and respects reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/workspace-toast.html?tone=error&long");
  const toast = page.locator(".workspace-toast");
  await toast.hover();
  const bounds = (await toast.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(308);
  expect(await toast.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await toast.evaluate(element => element.getAnimations().length)).toBe(0);
  await toast.getByRole("button", { name: "关闭通知" }).focus();
  await page.keyboard.press("Enter");
  await expect(toast).toHaveCount(0);
});
