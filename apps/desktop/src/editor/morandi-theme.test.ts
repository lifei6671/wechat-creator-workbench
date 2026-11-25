// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { renderWechat, wechatThemeId, wechatThemes } from "../../../../packages/wechat-renderer";
import fixture from "../../../../fixtures/morandi-theme.md?raw";

const source = fixture.replaceAll("\r\n", "\n");
vi.mock("../../../../packages/wechat-renderer/graphics", () => ({
  graphic: vi.fn(async () => ({ blob: new Blob(["diagram"], { type: "image/svg+xml" }), width: 320, height: 160 })),
  graphicPng: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));
const services = () => ({
  image: vi.fn(async () => ({ src: "https://images.test/morandi.png", width: 640, height: 320 })),
  sources: vi.fn(async () => []), derive: vi.fn(),
});

it("registers Morandi in the existing theme registry", () => {
  expect(wechatThemes.find(theme => theme.id === "morandi")?.label).toBe("莫兰迪");
  expect(wechatThemeId("morandi")).toBe("morandi");
});

it.each(["preview", "clipboard", "html"] as const)("inlines an adaptive Morandi article for %s", async output => {
  const result = await renderWechat({ markdown: source, themeId: "morandi", revision: 7, output }, services());
  try {
    expect(result.themeId).toBe("morandi");
    const template = document.createElement("template"); template.innerHTML = result.html;
    const root = template.content.firstElementChild as HTMLElement;
    expect(root.style.color).toBe("inherit");
    expect(["", "transparent", "initial"]).toContain(root.style.backgroundColor);
    const captions = new Set([...root.querySelectorAll("img")].map(img => img.nextElementSibling));
    for (const element of template.content.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,strong,em,a,blockquote,mark")) {
      if (element.closest("pre") || captions.has(element)) continue;
      expect(["", "inherit"], element.outerHTML).toContain(element.style.color);
      expect(["", "transparent", "initial"], element.outerHTML).toContain(element.style.backgroundColor);
    }
    for (const element of template.content.querySelectorAll<HTMLElement>("[style]")) {
      if (!element.closest("pre") && !captions.has(element)) expect(["", "inherit"], element.outerHTML).toContain(element.style.color);
    }
    for (const caption of captions) expect((caption as HTMLElement).style.color).toBe("rgb(100, 100, 100)");
    const paragraph = root.querySelector("p")!;
    expect(paragraph.style.fontSize).toBe("16px");
    expect(paragraph.style.lineHeight).toBe("1.85");
    expect(paragraph.style.marginBottom).toBe("16px");
    const h2 = root.querySelector("h2")!;
    expect(h2.style.borderLeftWidth).toBe("4px");
    expect(h2.style.borderLeftColor).toBe("rgb(132, 154, 169)");
    expect(h2.style.paddingLeft).toBe("10px");
    expect(root.querySelector("h1 > span")?.getAttribute("style")).toContain("32px");
    const quote = root.querySelector("blockquote")!;
    expect(quote.style.borderLeftColor).toBe("rgb(135, 157, 139)");
    expect(quote.querySelectorAll(":scope > p")).toHaveLength(2);
    const caption = [...root.querySelectorAll("p")].find(node => node.textContent?.startsWith("图 1："))!;
    expect(caption.style.fontSize).toBe("13px");
    expect(caption.style.textAlign).toBe("center");
    expect(root.querySelectorAll("figure,figcaption")).toHaveLength(0);
    const pre = root.querySelector("pre")!;
    expect(pre.textContent).toContain("    // Preserve indentation");
    expect(pre.style.color).not.toBe("inherit");
    expect(pre.style.backgroundColor).not.toBe("transparent");
    const inline = root.querySelector<HTMLElement>("p code")!;
    expect(inline.style.color).toBe("inherit");
    expect(inline.style.borderWidth).toBe("0.5px");
    expect(root.querySelector("hr")?.style.width).toBe("48px");
    expect(root.querySelector("table")?.getAttribute("width")).toBe("100%");
    expect(root.querySelectorAll("td")).toHaveLength(14);
    expect(root.querySelector("table")?.textContent).toContain("256");
    expect(root.querySelectorAll("img")).toHaveLength(2);
    expect(result.html).not.toMatch(/var\(|prefers-color-scheme|<style|<script|\sclass=|<button|<input/);
    if (output !== "preview") expect(result.html).not.toMatch(/\sdata-/);
    if (output === "clipboard") expect([...root.querySelectorAll("a[href]")].every(node => node.getAttribute("href")!.startsWith("https://mp.weixin.qq.com/"))).toBe(true);
  } finally { result.dispose(); }
});

it("keeps the existing clipboard restriction for unconverted external links", async () => {
  await expect(renderWechat({ markdown: "[外部地址](https://example.test)", themeId: "morandi", revision: 0, output: "clipboard" }, services())).rejects.toThrow("未转为脚注");
});

it("keeps Mermaid publication on the existing derive and image pipeline", async () => {
  const dependencies = services();
  const diagram = "flowchart LR\n  A --> B";
  const sources = vi.fn(async () => [{ kind: "mermaid" as const, source: diagram, line: 0 }]);
  const derive = vi.fn(async () => "derived-diagram");
  const result = await renderWechat({ markdown: `\`\`\`mermaid\n${diagram}\n\`\`\``, themeId: "morandi", revision: 1, output: "clipboard" }, { ...dependencies, sources, derive });
  try {
    expect(derive).toHaveBeenCalledWith("mermaid", diagram, new Uint8Array([1, 2, 3]));
    expect(dependencies.image).toHaveBeenCalledWith("asset://derived-diagram");
    expect(result.images).toEqual([{ url: "asset://derived-diagram", alt: "Mermaid 图表" }]);
    expect(result.html).toContain('alt="Mermaid 图表"');
    expect(result.warnings).toEqual([]);
  } finally { result.dispose(); }
});
