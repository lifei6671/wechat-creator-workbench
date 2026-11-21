// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ActionError, useButtonFeedback } from "./button-feedback";

afterEach(() => vi.useRealTimers());

function mount() {
  let feedback!: ReturnType<typeof useButtonFeedback>;
  function Harness() {
    feedback = useButtonFeedback();
    return <><button {...feedback.props("copy")}>{feedback.icon("copy", <svg />)}{feedback.label("copy", "复制", "已复制")}</button>
      <ActionError error={feedback.error("copy")} /></>;
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  flushSync(() => root.render(<StrictMode><Harness /></StrictMode>));
  return { get feedback() { return feedback; }, container, rerender() { flushSync(() => root.render(<StrictMode><Harness /></StrictMode>)); }, close() { flushSync(() => root.unmount()); container.remove(); } };
}

it("locks duplicate entry points synchronously through the real request and one second result", async () => {
  vi.useFakeTimers();
  const view = mount();
  let resolve!: () => void;
  const request = new Promise<void>(done => { resolve = done; });
  const operation = vi.fn(() => request);
  let task!: Promise<unknown>;
  try {
    flushSync(() => { task = view.feedback.run("copy", operation); void view.feedback.run("copy", operation); });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("button")?.disabled).toBe(true);
    flushSync(() => vi.advanceTimersByTime(5000));
    expect(view.feedback.status("copy")).toBe("pending");
    await act(async () => { resolve(); await task; });
    flushSync(() => vi.advanceTimersByTime(999));
    expect(view.feedback.isLocked("copy")).toBe(true);
    await view.feedback.run("copy", operation);
    expect(operation).toHaveBeenCalledTimes(1);
    flushSync(() => vi.advanceTimersByTime(1));
    expect(view.feedback.isLocked("copy")).toBe(false);
  } finally { view.close(); }
});

it("reserves the error area and keeps failure details after button feedback expires", async () => {
  vi.useFakeTimers();
  const view = mount();
  try {
    expect(view.container.querySelector(".action-error-slot")).not.toBeNull();
    await act(async () => { await view.feedback.run("copy", () => { throw new Error("剪贴板不可用，请重试"); }); });
    flushSync(() => vi.advanceTimersByTime(1000));
    expect(view.feedback.isLocked("copy")).toBe(false);
    expect(view.feedback.error("copy")).toBe("剪贴板不可用，请重试");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("剪贴板不可用，请重试");
  } finally { view.close(); }
});

it("treats cancellation as idle and leaves unrelated actions available", async () => {
  const view = mount();
  try {
    flushSync(() => { expect(view.feedback.start("export")).toBe(true); expect(view.feedback.start("copy")).toBe(true); });
    flushSync(() => view.feedback.finish("copy", undefined));
    expect(view.feedback.isLocked("copy")).toBe(false);
    expect(view.feedback.status("copy")).toBeUndefined();
    expect(view.feedback.isLocked("export")).toBe(true);
    expect(view.feedback.error("copy")).toBe("");
  } finally { view.close(); }
});


it("keeps the feedback API stable across unrelated parent renders", () => {
  const view = mount();
  try {
    const previous = view.feedback;
    view.rerender();
    expect(view.feedback).toBe(previous);
  } finally { view.close(); }
});
