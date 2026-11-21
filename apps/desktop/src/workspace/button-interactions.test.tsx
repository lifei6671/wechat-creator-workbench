// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { afterEach, expect, it, vi } from "vitest";
import { desktop } from "../desktop";
import { PublishImagesDialog } from "./Publishing";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps image copy locked until the clipboard completes and the one second result ends", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let complete!: () => void;
  const copy = vi.spyOn(desktop, "copyImage").mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Theme><PublishImagesDialog images={[{ url: "asset://image", alt: "示例" }]} onClose={vi.fn()} /></Theme>));
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "复制图片")!;
    const errorSlot = document.querySelector(".action-error-slot");
    await act(async () => { button.click(); button.click(); });
    expect(copy).toHaveBeenCalledExactlyOnceWith("asset://image");
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => vi.advanceTimersByTime(5000));
    expect(button.disabled).toBe(true);
    await act(async () => complete());
    expect(button.textContent).toBe("已复制");
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(copy).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(button.textContent).toBe("复制图片");
    expect(button.disabled).toBe(false);
    expect(document.querySelector(".action-error-slot")).toBe(errorSlot);
    expect((document.querySelector(".muted-text")?.textContent ?? "")).not.toContain("已复制图片");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps a failed image save reason in its reserved slot and does not show a result for canceled file selection", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const save = vi.spyOn(desktop, "saveImage").mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("保存失败，请选择可写目录"));
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Theme><PublishImagesDialog images={[{ url: "asset://image", alt: "示例" }]} onClose={vi.fn()} /></Theme>));
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "保存图片")!;
    const errorSlot = document.querySelector(".action-error-slot");
    await act(async () => button.click());
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("data-feedback-state")).toBeNull();
    await act(async () => button.click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(button.textContent).toBe("保存图片");
    expect(errorSlot?.textContent).toBe("保存失败，请选择可写目录");
    expect(document.querySelector(".action-error-slot")).toBe(errorSlot);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
