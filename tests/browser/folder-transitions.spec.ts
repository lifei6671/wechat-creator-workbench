import { expect, test } from "@playwright/test";

for (const section of ["folders", "timeline"]) for (const motion of ["no-preference", "reduce"] as const) {
  test(`${section}: expands and collapses folders with ${motion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await page.goto(`/tests/folder-colors.html?section=${section}`);
    const toggle = section === "folders" ? "#folder-row-folder" : '.timeline-folder-toggle[aria-controls="folder-folder"]';
    const branch = page.locator("#folder-folder").locator("..");
    await expect(branch).toHaveAttribute("data-collapsed", "true");
    for (const open of [true, false]) {
      const frames = await page.evaluate(async toggle => {
        const branch = document.getElementById("folder-folder")!.parentElement!;
        const heights: number[] = [];
        const mounted: boolean[] = [];
        const animations: number[] = [];
        (document.querySelector(toggle) as HTMLButtonElement).click();
        const started = performance.now();
        await new Promise<void>(resolve => {
          const frame = () => {
            heights.push(branch.getBoundingClientRect().height);
            mounted.push(Boolean(document.getElementById("folder-row-child-folder")));
            animations.push(branch.getAnimations().length);
            if (performance.now() - started < 350) requestAnimationFrame(frame);
            else resolve();
          };
          requestAnimationFrame(frame);
        });
        return { heights, mounted, animations, transition: getComputedStyle(branch).transitionDuration };
      }, toggle);
      await expect(branch).toHaveAttribute("data-collapsed", String(!open));
      expect(await page.locator("#folder-folder").evaluate(element => element.hasAttribute("inert"))).toBe(!open);
      const max = Math.max(...frames.heights);
      if (open) expect(frames.heights.at(-1)).toBeGreaterThan(10);
      else expect(frames.heights.at(-1)).toBeLessThan(0.1);
      if (motion === "no-preference") {
        expect(frames.heights.some(height => height > 1 && height < max - 1)).toBe(true);
        if (!open) expect(frames.mounted[0]).toBe(true);
      } else {
        expect(frames.transition).toBe("0s");
        expect(frames.animations.every(count => count === 0)).toBe(true);
        if (open) expect(frames.heights[0]).toBeGreaterThan(10);
        else expect(frames.heights[0]).toBeLessThan(0.1);
      }
    }
    await expect(page.locator("#folder-row-child-folder")).toHaveCount(section === "timeline" ? 1 : 0);
    // Reversing a collapse must cancel its pending unmount.
    await page.evaluate(async toggle => {
      const button = document.querySelector(toggle) as HTMLButtonElement;
      button.click();
      await new Promise(resolve => setTimeout(resolve, 60));
      button.click();
      await new Promise(resolve => setTimeout(resolve, 60));
      button.click();
    }, toggle);
    await expect(page.locator("#folder-row-child-folder")).toBeVisible();
    await expect(branch).toHaveAttribute("data-collapsed", "false");
    await expect.poll(() => branch.evaluate(element => element.getAnimations().length)).toBe(0);
    await expect(page.locator("#folder-row-child-folder")).toBeVisible();
  });
}
