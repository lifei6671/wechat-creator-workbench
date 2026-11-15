// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

it("opens without blocking the workspace and supports keyboard selection", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const outside = vi.fn();
  const second = vi.fn();
  const actions = [{ name: "新建笔记", run: vi.fn() }, { name: "设置", run: second }];
  function Workspace() {
    const [show, setShow] = useState(false);
    return <Theme>
      <button type="button" onClick={() => setShow(true)}>打开</button>
      <button type="button" onClick={outside}>工作区</button>
      {show && <CommandPalette actions={actions} onOpen={vi.fn()} onClose={() => setShow(false)} />}
    </Theme>;
  }
  try {
    flushSync(() => root.render(<Workspace />));
    const [open, workspace] = container.querySelectorAll("button");
    const panel = () => document.querySelector('[aria-label="命令面板"]');
    const key = (element: Element, name: string) => {
      flushSync(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
    };
    flushSync(() => open.click());
    const field = panel()?.querySelector("input")!;
    expect(document.activeElement).toBe(field);
    expect(panel()?.querySelector("h2")).toBeNull();
    expect(panel()?.hasAttribute("aria-modal")).toBe(false);
    expect(workspace.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
    panel()!.querySelectorAll('[role="option"]').forEach(option => { option.scrollIntoView = vi.fn(); });
    key(field, "ArrowDown");
    expect(panel()?.querySelector('[aria-selected="true"]')?.textContent).toBe("设置");
    key(field, "Enter");
    expect(second).toHaveBeenCalledOnce();
    expect(panel()).toBeNull();

    flushSync(() => open.click());
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync(() => workspace.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })));
    flushSync(() => workspace.click());
    expect(panel()).toBeNull();
    expect(outside).toHaveBeenCalledOnce();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
