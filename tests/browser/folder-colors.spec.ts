import { expect, test, type Page } from "@playwright/test";

async function openColors(page: Page) {
  await page.getByRole("button", { name: "选择目录图标" }).click();
  await expect(page.getByRole("group", { name: "颜色", exact: true })).toBeVisible();
}

async function save(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "颜色", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "目录名称" }).press("Enter");
  await page.getByRole("button", { name: "完成保存" }).click();
  await expect(page.getByRole("textbox", { name: "目录名称" })).toHaveCount(0);
}

for (const section of ["folders", "timeline"]) for (const appearance of ["light", "dark"]) {
  test(`renders the saved icon badge in ${section} ${appearance}`, async ({ page }) => {
    await page.goto(`/tests/folder-colors.html?section=${section}&appearance=${appearance}`);
    const row = page.locator("#folder-row-folder");
    const svg = row.locator(".folder-icon svg");
    const badge = row.locator(".folder-icon-badge");
    await page.locator(".explorer").evaluate(element => { element.style.width = "260px"; });
    async function color(value: string) {
      return page.locator(".radix-themes").first().evaluate((element, value) => {
        const probe = element.appendChild(document.createElement("span"));
        probe.style.color = value;
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      }, value);
    }
    async function edit() {
      const name = await row.locator(":scope > span:not(.folder-icon)").boundingBox();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "编辑名称和图标" }).click();
      const input = page.getByRole("textbox", { name: "目录名称" });
      await expect(input).toBeVisible();
      expect(Math.abs((await input.boundingBox())!.x - name!.x)).toBeLessThan(1);
      await openColors(page);
    }
    async function checkBadge(background: string) {
      await expect(badge).toHaveCSS("background-color", await color(background));
      await expect(badge).toHaveCSS("width", "22px");
      await expect(badge).toHaveCSS("height", "22px");
      await expect(badge).toHaveCSS("border-radius", "6px");
      await expect(svg).toHaveCSS("color", await color("var(--white-a12)"));
      await expect(svg).toHaveCSS("stroke", await color("var(--white-a12)"));
      const bounds = await badge.boundingBox();
      const glyph = await svg.boundingBox();
      expect(Math.abs(bounds!.x + bounds!.width / 2 - glyph!.x - glyph!.width / 2)).toBeLessThan(0.5);
      expect(Math.abs(bounds!.y + bounds!.height / 2 - glyph!.y - glyph!.height / 2)).toBeLessThan(0.5);
    }
    await checkBadge("var(--blue-9)");
    await edit();
    await page.getByRole("button", { name: "红色", exact: true }).click();
    await expect(page.locator(".folder-inline-icon .folder-icon-badge")).toHaveCSS("background-color", await color("var(--red-9)"));
    const choices = page.locator(".folder-icon-choice .folder-icon-badge");
    await expect(choices).toHaveCount(32);
    const red = await color("var(--red-9)");
    for (const choice of await choices.all()) await expect(choice).toHaveCSS("background-color", red);
    await save(page);
    await checkBadge("var(--red-9)");
    if (section === "folders") {
      await row.click();
      await expect(row.locator(".lucide-folder-open")).toBeVisible();
      await checkBadge("var(--red-9)");
      await expect(row.locator(".folder-chevron")).toHaveCSS("color", await color("var(--gray-10)"));
      const childRow = page.locator("#folder-row-child-folder");
      await expect(childRow.locator(".folder-icon-badge")).toHaveCSS("background-color", await color("var(--green-9)"));
      await expect(childRow.locator(".folder-icon svg")).toHaveCSS("stroke", await color("var(--white-a12)"));
      const entryRow = page.getByRole("button", { name: "目录内笔记", exact: true });
      await expect(entryRow.locator(".folder-icon-badge")).toHaveCount(0);
      await expect(entryRow.locator(":scope > svg")).toHaveCSS("color", await color("var(--text-muted)"));
      const childLabel = await childRow.locator(":scope > span:not(.folder-icon)").boundingBox();
      const entryLabel = await entryRow.locator(".entry-title").boundingBox();
      expect(Math.abs(childLabel!.x - entryLabel!.x)).toBeLessThan(4);
      if (appearance === "light") await page.locator(".explorer").screenshot({ path: test.info().outputPath("folder-icon-badges.png") });
    }
    await edit();
    await page.getByLabel("自定义颜色", { exact: true }).evaluate((input: HTMLInputElement) => {
      input.value = "#123abc";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.getByRole("button", { name: "星标", exact: true }).click();
    await save(page);
    await expect(row.locator(".lucide-star")).toBeVisible();
    await checkBadge("#123abc");
    if (section === "folders") {
      const bounds = (await row.boundingBox())!;
      await page.mouse.move(bounds.x + 80, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 110, bounds.y + bounds.height / 2, { steps: 6 });
      const ghost = page.locator(".tree-drag-ghost .folder-icon-badge");
      await expect(ghost).toHaveCSS("background-color", await color("#123abc"));
      await expect(ghost.locator("svg")).toHaveCSS("stroke", await color("var(--white-a12)"));
      await page.mouse.up();
      await expect(ghost).toHaveCount(0);
    }
    await page.getByRole("button", { name: "重新加载目录" }).click();
    await page.locator(".explorer").evaluate(element => { element.style.width = "260px"; });
    await page.locator("html").evaluate(element => { element.style.zoom = "1.25"; });
    await checkBadge("#123abc");
    await edit();
    await page.getByRole("button", { name: "默认", exact: true }).click();
    await save(page);
    await checkBadge("var(--gray-9)");
  });
}

test("retains the canvas palette's close-on-preset and custom-color behavior", async ({ page }) => {
  await page.goto("/tests/folder-colors.html");
  const trigger = page.getByRole("button", { name: "画布配色" });
  await trigger.click();
  const palette = page.getByRole("dialog", { name: "画布颜色" });
  const custom = palette.getByLabel("自定义颜色", { exact: true });
  await custom.evaluate((input: HTMLInputElement) => { input.value = "#fedcba"; });
  await palette.getByRole("button", { name: "刷新调色板 0" }).click();
  await expect(custom).toHaveValue("#fedcba");
  await palette.getByRole("button", { name: "黄色", exact: true }).click();
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("canvas-color")).toHaveText("amber");
  await trigger.click();
  await palette.getByLabel("自定义颜色", { exact: true }).evaluate((input: HTMLInputElement) => {
    input.value = "#abcdef";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(palette).toBeVisible();
  await expect(page.getByTestId("canvas-color")).toHaveText("#abcdef");
});

test("saves a color-only edit, retains it on reopen, and restores the default", async ({ page }) => {
  await page.goto("/tests/folder-colors.html");
  await openColors(page);
  await expect(page.getByRole("button", { name: "蓝色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "红色", exact: true }).click();
  await expect(page.getByRole("button", { name: "红色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("calls")).toHaveText("0");
  await save(page);
  await expect(page.getByTestId("saved")).toContainText('"iconColor":"red"');
  await page.getByRole("button", { name: "编辑目录" }).click();
  await openColors(page);
  await expect(page.getByRole("button", { name: "红色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "默认", exact: true }).click();
  await save(page);
  await expect(page.getByTestId("saved")).toContainText('"iconColor":null');
  await expect(page.getByTestId("calls")).toHaveText("2");
});

for (const activation of ["mouse", "keyboard"]) test(`keeps ${activation} native color-dialog focus loss from saving early and supports cancellation`, async ({ page }) => {
  await page.goto("/tests/folder-colors.html");
  await openColors(page);
  const custom = page.getByLabel("自定义颜色", { exact: true });
  await custom.evaluate((input: HTMLInputElement, activation) => {
    if (activation === "mouse") input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    else input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    input.focus();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    input.value = "#123abc";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, activation);
  await expect(page.getByTestId("calls")).toHaveText("0");
  await expect(custom).toHaveValue("#123abc");
  await save(page);
  await expect(page.getByTestId("saved")).toContainText('"iconColor":"#123abc"');
  await page.getByRole("button", { name: "编辑目录" }).click();
  await openColors(page);
  await expect(custom).toHaveValue("#123abc");
  await page.getByRole("button", { name: "绿色", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "颜色", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "目录名称" }).press("Escape");
  await expect(page.getByRole("textbox", { name: "目录名称" })).toHaveCount(0);
  await expect(page.getByTestId("saved")).toContainText('"iconColor":"#123abc"');
  await expect(page.getByTestId("calls")).toHaveText("1");
});

test("locks duplicate saves and displays failures in the reserved error region", async ({ page }) => {
  await page.goto("/tests/folder-colors.html?fail=1");
  const error = page.getByRole("alert");
  const before = await error.boundingBox();
  await openColors(page);
  await page.getByRole("button", { name: "紫色", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "颜色", exact: true })).toHaveCount(0);
  const name = page.getByRole("textbox", { name: "目录名称" });
  await name.press("Enter");
  await expect(name).toBeDisabled();
  await expect(page.getByRole("button", { name: "选择目录图标" })).toBeDisabled();
  await page.getByRole("button", { name: "完成保存" }).click();
  await expect(error).toHaveText("保存颜色失败");
  expect((await error.boundingBox())!.height).toBe(before!.height);
  await expect(name).toBeEnabled();
  await expect(page.getByTestId("calls")).toHaveText("1");
});
