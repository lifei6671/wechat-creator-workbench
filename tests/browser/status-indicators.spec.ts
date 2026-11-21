import { expect, test, type Locator } from "@playwright/test";

for (const appearance of ["light", "dark"]) for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`status dots in ${appearance}, motion ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto(`/tests/status-indicators.html?appearance=${appearance}`);
    const mcp = page.locator(".status-mcp"), sync = page.locator(".status-sync");
    async function check(button: Locator, state: string, label: string) {
      await expect(button).toHaveAccessibleName(label);
      await expect(button).toHaveText("");
      const dot = button.locator(".status-dot");
      await expect(dot).toHaveAttribute("data-state", state);
      const style = await dot.evaluate((el, state) => {
        const css = getComputedStyle(el);
        const probe = document.createElement("span");
        probe.style.color = `var(--${({ success: "green", error: "red", busy: "orange", waiting: "yellow", unknown: "gray" } as Record<string, string>)[state]}-9)`;
        el.parentElement!.append(probe);
        const expectedColor = getComputedStyle(probe).color;
        probe.remove();
        const rect = el.getBoundingClientRect(), button = el.closest("button")!.getBoundingClientRect();
        const icon = el.parentElement!.getBoundingClientRect();
        return { color: css.backgroundColor, expectedColor, width: rect.width, height: rect.height,
          animation: css.animationName, duration: css.animationDuration, buttonWidth: button.width,
          contained: rect.left >= button.left && rect.right <= button.right && rect.top >= button.top && rect.bottom <= button.bottom,
          upperRight: rect.top < icon.top && rect.right > icon.right };
      }, state);
      expect(style.color).toBe(style.expectedColor);
      expect(style.width).toBe(6); expect(style.height).toBe(6); expect(style.buttonWidth).toBe(28);
      expect(style.contained).toBe(true); expect(style.upperRight).toBe(true);
      expect(style.animation).toBe(reducedMotion === "reduce" || state === "unknown" ? "none" : "status-dot-breathe");
      if (style.animation !== "none") expect(style.duration).toBe("2s");
    }
    for (const [scenario, state, label] of [
      ["running", "success", "MCP（运行中）"], ["stopped", "error", "MCP（未运行）"],
      ["unknown", "unknown", "正在读取 MCP 状态"], ["error", "error", "MCP 状态异常：服务读取失败"],
    ]) {
      await page.getByLabel("MCP 场景").selectOption(scenario);
      await check(mcp, state, label);
    }
    for (const [scenario, state, label] of [
      ["healthy", "success", "已同步"], ["connecting", "busy", "正在连接"], ["downloading", "busy", "正在下载"],
      ["merging", "busy", "正在合并"], ["syncing", "busy", "正在同步"], ["pending", "busy", "正在处理上传任务"],
      ["incoming", "waiting", "等待结束编辑"], ["issues", "error", "有内容需要处理"], ["paused", "waiting", "已暂停"],
      ["unconnected", "waiting", "未连接同步"], ["reading", "waiting", "正在读取同步状态"], ["first", "waiting", "等待检查"],
      ["waiting_seed", "waiting", "等待云端初始化"], ["error", "error", "同步失败"],
      ["credential", "error", "需要重新连接"], ["read-error", "error", "无法读取同步状态"],
    ]) {
      await page.getByLabel("同步场景").selectOption(scenario);
      await check(sync, state, `同步设置：${label}`);
    }
    await mcp.hover();
    await expect(page.getByRole("tooltip")).toHaveText("MCP 状态异常：服务读取失败");
    await page.mouse.move(900, 50);
    await mcp.focus();
    await expect(page.getByRole("tooltip")).toHaveText("MCP 状态异常：服务读取失败");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("clicked")).toHaveText("mcp");
    await page.getByLabel("同步场景").selectOption("incoming");
    await sync.focus();
    await expect(page.getByRole("tooltip")).toHaveText("已下载，等待结束编辑");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("clicked")).toHaveText("sync");
    const opacity = await sync.locator(".status-dot").evaluate(el => {
      const animation = el.getAnimations()[0];
      if (!animation) return null;
      animation.pause();
      animation.currentTime = 0;
      const start = getComputedStyle(el).opacity;
      animation.currentTime = 1000;
      return [start, getComputedStyle(el).opacity];
    });
    expect(opacity).toEqual(reducedMotion === "reduce" ? null : ["1", "0.5"]);
    await page.locator("html").evaluate(el => { el.style.zoom = "1.5"; });
    const scaled = await sync.locator(".status-dot").boundingBox();
    expect(scaled!.width).toBe(9); expect(scaled!.height).toBe(9);
    await page.screenshot({ path: test.info().outputPath("status-indicators.png") });
  });
}

test("spaces left status buttons evenly at desktop and narrow scaled widths", async ({ page }) => {
  await page.goto("/tests/status-indicators.html");
  for (const width of [1360, 1000]) for (const zoom of [1, 1.5]) {
    await page.setViewportSize({ width, height: 840 });
    await page.locator("html").evaluate((el, zoom) => { el.style.zoom = String(zoom); }, zoom);
    const buttons = [page.getByRole("button", { name: "命令面板", exact: true }),
      page.getByRole("button", { name: "回收站", exact: true }), page.locator(".status-mcp"), page.locator(".status-sync")];
    const rects = await Promise.all(buttons.map(button => button.boundingBox()));
    for (let i = 1; i < rects.length; i++) {
      const previous = rects[i - 1]!, current = rects[i]!;
      expect((current.x - previous.x - previous.width) / zoom).toBeCloseTo(12, 1);
      expect(current.y + current.height / 2).toBeCloseTo(previous.y + previous.height / 2, 1);
    }
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeInViewport();
    expect(await page.locator(".status-bar").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});
