// @vitest-environment jsdom
import { expect, it } from "vitest";
import { applyPreviewAppearance } from "./preview-appearance";

it("adapts prose and surfaces for dark preview, preserves images, and restores exact light styles", () => {
  const content = document.body.appendChild(document.createElement("div"));
  content.innerHTML = '<p style="color:#333 !important">正文</p><blockquote style="background-color:#f0f0f0;border:1px solid #ccc"><span style="color:inherit">引用</span></blockquote><span style="background-color:#218358;color:white">01</span><img src="https://example.test/picture.png" style="width:80px;height:auto">';
  const original = content.innerHTML;
  const lightStyles = new WeakMap<HTMLElement, string>();
  const image = content.querySelector("img")!;
  const originalImage = image.outerHTML;
  try {
    applyPreviewAppearance(content, "dark", lightStyles);
    const prose = content.querySelector("p")!;
    const quote = content.querySelector("blockquote")!;
    expect(prose.style.color).toBe("rgb(214, 214, 214)");
    expect(prose.style.getPropertyPriority("color")).toBe("important");
    expect(quote.style.backgroundColor).toBe("rgb(32, 32, 32)");
    expect(quote.style.borderTopColor).not.toBe("rgb(204, 204, 204)");
    expect(quote.querySelector("span")?.style.color).toBe("inherit");
    expect(image.outerHTML).toBe(originalImage);
    expect(content.querySelector("p")).toBe(prose);
    const dark = content.innerHTML;
    applyPreviewAppearance(content, "dark", lightStyles);
    expect(content.innerHTML).toBe(dark);
    applyPreviewAppearance(content, "light", lightStyles);
    expect(content.innerHTML).toBe(original);
  } finally { content.remove(); }
});
