// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WorkspaceToast } from "./WorkspaceToast";

it("dismisses feedback after its display time and exit transition", () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const notice = { type: "info" as const, text: "已复制" };
  const dismiss = vi.fn(() => root.render(null));
  try {
    flushSync(() => root.render(<Theme><WorkspaceToast notice={notice} onDismiss={dismiss} /></Theme>));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(notice.text);
    flushSync(() => vi.advanceTimersByTime(3999));
    expect(container.querySelector("[data-leaving]")).toBeNull();
    flushSync(() => vi.advanceTimersByTime(1));
    expect(container.querySelector("[data-leaving]")).not.toBeNull();
    expect(dismiss).not.toHaveBeenCalled();
    flushSync(() => vi.advanceTimersByTime(180));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(notice);
    expect(container.querySelector('[role="status"]')).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});
