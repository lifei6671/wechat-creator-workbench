// @vitest-environment jsdom
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, expect, it, vi } from "vitest";
import { imageView } from "../../../../packages/editor-react/image-view";

afterEach(() => vi.useRealTimers());

it("locks image retries through the request and failure feedback, and preserves the failure reason", async () => {
  vi.useFakeTimers();
  const schema = new Schema({ nodes: {
    doc: { content: "image*" }, text: {},
    image: { attrs: { src: {}, alt: { default: "" }, title: { default: "" } }, atom: true },
  } });
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView(host, { state: EditorState.create({ schema }) });
  let fail!: (error: Error) => void;
  const resolveImage = vi.fn().mockRejectedValueOnce(new Error("初次加载失败"))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const image = imageView(schema.nodes.image.create({ src: "https://example.test/image.png" }), view, () => undefined,
    () => schema.topNodeType.create(), () => "", () => ({ resolveImage, imageErrorMessage: error => String(error) }), new Set());
  host.append(image.dom);
  try {
    await Promise.resolve(); await Promise.resolve();
    const button = host.querySelector<HTMLButtonElement>(".rich-image-retry")!;
    expect(button.hidden).toBe(false);
    button.click(); button.click();
    expect(resolveImage).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(5000);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fail(new Error("重试请求失败"));
    await Promise.resolve(); await Promise.resolve();
    expect(button.textContent).toBe("重试失败");
    button.click();
    expect(resolveImage).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.textContent).toBe("重试");
    expect(host.querySelector('.rich-image-status [role="alert"]')?.textContent).toContain("重试请求失败");
  } finally { image.destroy?.(); view.destroy(); host.remove(); }
  expect(vi.getTimerCount()).toBe(0);
});
