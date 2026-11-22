import { expect, test } from "@playwright/test";

for (const appearance of ["light", "dark"]) {
  test(`keeps context badges above user messages in ${appearance}`, async ({ page }) => {
    await page.goto(`/tests/ai-citations.html?appearance=${appearance}`);
    await page.getByRole("button", { name: "对话记录", exact: true }).click();
    const actions = (await page.locator(".ai-chat-actions").boundingBox())!;
    const history = (await page.locator(".ai-thread-list").boundingBox())!;
    expect(history.y - actions.y - actions.height).toBeGreaterThanOrEqual(0);
    expect(history.y - actions.y - actions.height).toBeLessThanOrEqual(12);
    await page.getByRole("button", { name: /^标签布局测试/ }).click();
    await expect(page.locator(".ai-user-message")).toHaveCount(5);
    for (const width of [520, 320]) for (const zoom of [1, 1.5]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator("html").evaluate((el, zoom) => { el.style.zoom = String(zoom); }, zoom);
      for (const [index, label] of ["全文", "当前章节", "不引用正文"].entries()) {
        const turn = page.locator(".ai-turn").nth(index);
        const badge = turn.locator(":scope > .ai-user-citation");
        const message = turn.locator(".ai-user-message");
        await expect(badge).toHaveText(label);
        expect(await badge.evaluate(el => el.nextElementSibling?.classList.contains("ai-user-message"))).toBe(true);
        const style = await badge.evaluate(el => {
          const css = getComputedStyle(el);
          const probe = document.createElement("span"); probe.style.color = "var(--sand-6)"; el.append(probe);
          const borderColor = getComputedStyle(probe).color; probe.remove();
          return { fontSize: css.fontSize, borderStyle: css.borderTopStyle, borderColor: css.borderTopColor, expectedColor: borderColor };
        });
        expect(style.fontSize).toBe("12px"); expect(style.borderStyle).toBe("solid");
        expect(style.borderColor).toBe(style.expectedColor);
        const a = (await badge.boundingBox())!, b = (await message.boundingBox())!;
        expect((b.y - a.y - a.height) / zoom).toBeCloseTo(4, 1);
        expect(a.x + a.width).toBeCloseTo(b.x + b.width, 1);
        expect(await turn.locator(".ai-user-actions .ai-user-citation").count()).toBe(0);
      }
      await expect(page.locator(".ai-turn").nth(3).locator(".ai-user-citation")).toHaveCount(0);
      await expect(page.getByRole("blockquote", { name: "所选内容" })).toHaveText("需要保留的选区原文");
      const overflow = await page.locator(".ai-transcript").evaluate(el => el.scrollWidth - el.clientWidth);
      // WebKit rounds these integer dimensions differently at fractional CSS widths under zoom.
      expect(overflow).toBeLessThanOrEqual(1);
    }
    const first = page.locator(".ai-turn").first();
    await first.scrollIntoViewIfNeeded();
    const badgeBefore = await first.locator(".ai-user-citation").boundingBox();
    const heightBefore = (await first.boundingBox())!.height;
    await first.getByRole("button", { name: "复制", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(first.getByRole("alert")).toContainText("测试复制失败");
    expect((await first.boundingBox())!.height).toBe(heightBefore);
    expect(await first.locator(".ai-user-citation").boundingBox()).toEqual(badgeBefore);
    await page.screenshot({ path: test.info().outputPath("ai-citations.png") });
  });
}
