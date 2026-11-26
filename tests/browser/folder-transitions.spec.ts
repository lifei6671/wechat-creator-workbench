import { expect, test } from "@playwright/test";

for (const section of ["folders", "timeline"]) for (const motion of ["no-preference", "reduce"] as const) for (const frameDelay of [0, 400]) {
  test(`${section}: expands and collapses folders with ${motion} motion (late-frame=${frameDelay})`, async ({ page }) => {
    if (frameDelay) await page.addInitScript(delay => {
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => request(time => { setTimeout(() => callback(time), delay); });
    }, frameDelay);
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
        // Commit the old layout before toggling so both engines create the transition.
        branch.getBoundingClientRect();
        (document.querySelector(toggle) as HTMLButtonElement).click();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const running = branch.getAnimations();
        // Seek the actual CSS transitions inside this one browser evaluation.
        // Delayed RAF or protocol delivery cannot consume the intermediate frame.
        for (const animation of running) animation.pause();
        await Promise.all(running.map(animation => animation.ready));
        for (const fraction of [0, .5]) {
          for (const animation of running) animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction;
          heights.push(branch.getBoundingClientRect().height);
          mounted.push(Boolean(document.getElementById("folder-row-child-folder")));
          animations.push(running.length);
        }
        for (const animation of running) animation.play();
        await new Promise<void>(resolve => setTimeout(resolve, 350));
        heights.push(branch.getBoundingClientRect().height);
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

test("reverses a menu exit from its current opacity and honours a live motion preference change", async ({ page }) => {
  await page.goto("/tests/folder-colors.html?section=folders");
  await page.locator("#folder-row-folder").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "文件夹操作" });
  await expect(menu).toBeVisible();
  const result = await menu.evaluate(async element => {
    // Start a fresh entry so protocol latency cannot consume its short duration.
    element.setAttribute("data-state", "closed");
    for (const animation of element.getAnimations()) animation.finish();
    element.setAttribute("data-state", "open");
    const animations = element.getAnimations();
    for (const animation of animations) animation.pause();
    await Promise.all(animations.map(animation => animation.ready));
    for (const animation of animations) animation.currentTime = Number(animation.effect!.getTiming().duration) / 3;
    const before = Number(getComputedStyle(element).opacity);
    element.setAttribute("data-state", "closed");
    const closed = Number(getComputedStyle(element).opacity);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const during = Number(getComputedStyle(element).opacity);
    element.setAttribute("data-state", "open");
    const reopened = Number(getComputedStyle(element).opacity);
    return { before, closed, during, reopened };
  });
  expect(result.before).toBeGreaterThan(0);
  expect(result.before).toBeLessThan(1);
  expect(Math.abs(result.closed - result.before)).toBeLessThan(.01);
  expect(result.during).toBeLessThanOrEqual(result.before + .01);
  expect(Math.abs(result.reopened - result.during)).toBeLessThan(.01);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await menu.evaluate(element => element.getAnimations().length)).toBe(0);
  expect(await menu.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("finishes a collapsing folder when reduced motion is enabled during the transition", async ({ page }) => {
  await page.goto("/tests/folder-colors.html?section=folders");
  const toggle = page.locator("#folder-row-folder");
  await toggle.click();
  await expect(page.locator("#folder-row-child-folder")).toBeVisible();
  await toggle.click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#folder-row-child-folder")).toHaveCount(0);
  expect(await page.locator("#folder-folder").locator("..").evaluate(element => element.getAnimations().length)).toBe(0);
  await toggle.click();
  await expect(page.locator("#folder-row-child-folder")).toBeVisible();
});
