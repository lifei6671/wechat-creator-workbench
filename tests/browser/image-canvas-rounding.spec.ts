import { expect, test } from "@playwright/test";

test("rounded workspace preview", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/tests/image-canvas.html");
  await page.getByRole("slider", { name: "圆角", exact: true }).fill("64");
  await page.getByRole("slider", { name: "阴影", exact: true }).fill("80");
  await page.getByRole("slider", { name: "四周留白", exact: true }).fill("60");
  await page.getByRole("button", { name: "画板设置", exact: true }).click();
  await page.getByRole("button", { name: "渐变", exact: true }).click();
  await page.getByRole("slider", { name: "圆角", exact: true }).fill("64");
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.imageCanvasTest.snapshot().scene.artboard)).toMatchObject({ width: 1120, height: 770, cornerRadius: 64 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cornerAlpha = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".image-canvas-workspace canvas")!;
    const bounds = canvas.getBoundingClientRect();
    const caption = document.querySelector(".image-canvas-board-caption")!.getBoundingClientRect();
    const scale = parseFloat(document.querySelector<HTMLElement>(".image-canvas-app")!.style.getPropertyValue("--ic-view-scale"));
    const board = window.imageCanvasTest.snapshot().scene.artboard;
    const left = (caption.left - bounds.left) * canvas.width / bounds.width;
    const top = (caption.top - bounds.top - 12 - board.height * scale) * canvas.height / bounds.height;
    const width = board.width * scale * canvas.width / bounds.width;
    const height = board.height * scale * canvas.height / bounds.height;
    const ctx = canvas.getContext("2d")!;
    return [[left, top], [left + width, top], [left, top + height], [left + width, top + height]].map(([x, y]) => {
      const pixels = ctx.getImageData(Math.round(x) - 2, Math.round(y) - 2, 5, 5).data;
      return Math.max(...Array.from(pixels).filter((_, index) => index % 4 === 3));
    });
  });
  await page.screenshot({ path: `output/image-canvas-rounding/preview-${test.info().project.name}.png` });
  // The rounded board's soft shadow remains; no square content edge may remain.
  expect(cornerAlpha.every(alpha => alpha <= 24), JSON.stringify(cornerAlpha)).toBe(true);
});

test("rounded images follow the native circle with shadows", async ({ page }) => {
  await page.goto("/tests/image-canvas.html");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/image-canvas/renderer.ts";
    const { imageNode } = await import(modulePath);
    const scenePath = "/src/image-canvas/scene.ts";
    const { newImageLayer } = await import(scenePath);
    const source = document.createElement("canvas"); source.width = 320; source.height = 220;
    const sourceContext = source.getContext("2d")!;
    sourceContext.fillStyle = "#faf9fb"; sourceContext.fillRect(0, 0, 320, 220);
    const image = await createImageBitmap(source);
    const layer = { ...newImageLayer({ id: "rounding", url: "asset://rounding", width: 320, height: 220 }),
      x: 80, y: 80, cornerRadius: 64, shadow: { color: "#1c2024", blur: 24, offsetX: 0, offsetY: 12, opacity: .8 } };
    const node = imageNode(layer, { image, width: 320, height: 220, orientation: 1, dispose() {} });
    const actual = node.toCanvas({ x: 0, y: 0, width: 480, height: 380, pixelRatio: 1 });
    const expected = document.createElement("canvas"); expected.width = 480; expected.height = 380;
    const ctx = expected.getContext("2d")!;
    ctx.fillStyle = "#faf9fb"; ctx.shadowColor = "rgba(28,32,36,0.8)";
    ctx.shadowBlur = 24; ctx.shadowOffsetY = 12;
    ctx.beginPath(); ctx.roundRect(80, 80, 320, 220, 64); ctx.fill();
    const a = actual.getContext("2d")!.getImageData(0, 0, 480, 380).data;
    const b = ctx.getImageData(0, 0, 480, 380).data;
    let wrong = 0, max = 0;
    for (let i = 3; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]); if (delta > 8) wrong++; max = Math.max(max, delta);
      if (a[i] > 240 && b[i] > 240) for (let channel = 1; channel <= 3; channel++) if (Math.abs(a[i - channel] - b[i - channel]) > 8) wrong++;
    }
    node.destroy(); image.close();
    return { wrong, max, actual: actual.toDataURL(), expected: expected.toDataURL() };
  });
  await test.info().attach("actual", { body: Buffer.from(result.actual.split(",")[1], "base64"), contentType: "image/png" });
  await test.info().attach("expected", { body: Buffer.from(result.expected.split(",")[1], "base64"), contentType: "image/png" });
  expect(result.wrong, JSON.stringify({ wrong: result.wrong, max: result.max })).toBe(0);
});

test("rounded workspace clips corner hits while keeping images outside the board editable", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/tests/image-canvas.html");
  await page.getByText("位置与层级", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "图片 Y 坐标", exact: true }).fill("-80");
  await page.getByRole("button", { name: "画板设置", exact: true }).click();
  await page.getByRole("slider", { name: "圆角", exact: true }).fill("64");
  await expect.poll(() => page.evaluate(() => window.imageCanvasTest.snapshot().scene.artboard.cornerRadius)).toBe(64);
  await page.getByRole("button", { name: "适应画板", exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const board = await page.evaluate(() => {
    const caption = document.querySelector(".image-canvas-board-caption")!.getBoundingClientRect();
    const scale = parseFloat(document.querySelector<HTMLElement>(".image-canvas-app")!.style.getPropertyValue("--ic-view-scale"));
    return { x: caption.left, y: caption.top - 12 - window.imageCanvasTest.snapshot().scene.artboard.height * scale, scale };
  });
  await page.mouse.click(board.x + 2 * board.scale, board.y + 2 * board.scale);
  await expect(page.getByRole("heading", { name: "画板", exact: true })).toBeVisible();
  await page.mouse.click(board.x + 500 * board.scale, board.y - 40 * board.scale);
  await expect(page.getByRole("heading", { name: "图片", exact: true })).toBeVisible();
});

for (const format of ["png", "webp"] as const) test(`rounded background exports match a native circular silhouette (${format})`, async ({ page }) => {
  await page.goto("/tests/image-canvas.html");
  const results = await page.evaluate(async format => {
    const modulePath = "/src/image-canvas/renderer.ts";
    const { renderScene } = await import(modulePath);
    const source = document.createElement("canvas"); source.width = 320; source.height = 220;
    source.getContext("2d")!.fillRect(0, 0, 320, 220);
    const sourceBlob = await new Promise<Blob>(resolve => source.toBlob(blob => resolve(blob!)));
    const bytes = await sourceBlob.arrayBuffer();
    const backgrounds = [{ type: "solid", color: "#141726" },
      { type: "linear-gradient", angle: 135, stops: [{ offset: 0, color: "#141726" }, { offset: 1, color: "#56468b" }] },
      { type: "image", assetId: "rounding", fit: "cover" }];
    const checks = [];
    for (const background of backgrounds) for (const scale of [1, 2]) {
      const scene = { schemaVersion: 1, artboard: { width: 320, height: 220, cornerRadius: 64, background },
        layers: [], layout: { mode: "free", gap: 0, padding: 0, columns: 2, align: "center", size: 0 } };
      const encoded = await renderScene(scene, { format, scale, quality: .9, jpegBackground: "#ffffff" },
        async () => bytes, async () => ({ id: "rounding", width: 320, height: 220, orientation: 1 }));
      const image = await createImageBitmap(new Blob([new Uint8Array(encoded)]));
      const actual = document.createElement("canvas"); actual.width = image.width; actual.height = image.height;
      const aCtx = actual.getContext("2d")!; aCtx.drawImage(image, 0, 0); image.close();
      const expected = document.createElement("canvas"); expected.width = actual.width; expected.height = actual.height;
      const ctx = expected.getContext("2d")!; ctx.scale(scale, scale); ctx.beginPath(); ctx.roundRect(0, 0, 320, 220, 64);
      if (background.type === "image") { ctx.clip(); ctx.fillRect(0, 0, 320, 220); }
      else ctx.fill();
      const a = aCtx.getImageData(0, 0, actual.width, actual.height).data;
      const b = ctx.getImageData(0, 0, actual.width, actual.height).data;
      let wrong = 0;
      for (let y = 1; y < actual.height - 1; y++) for (let x = 1; x < actual.width - 1; x++) {
        const i = (y * actual.width + x) * 4 + 3;
        if (Math.abs(a[i] - b[i]) <= 8) continue;
        // Clip and vector-fill rasterization differ within the one-pixel antialiasing band.
        const neighbors = [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => b[((y + dy) * actual.width + x + dx) * 4 + 3]));
        if (neighbors.every(alpha => alpha === b[i])) wrong++;
      }
      checks.push({ background: background.type, scale, wrong });
    }
    return checks;
  }, format);
  expect(results.filter(result => result.wrong > 0)).toEqual([]);
});
