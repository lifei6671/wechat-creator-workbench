// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { expect, it, vi } from "vitest";
import { SettingsDialog } from "./Settings";

it("filters settings by field names and retains entered values while switching categories", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav-item")];
  const change = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  };
  flushSync(() => root.render(<SettingsDialog initialPage="model" onClose={() => {}}
    renderPage={page => page === "model" ? <input aria-label="模型输入" /> : null} />));
  try {
    const draft = document.querySelector<HTMLInputElement>('input[aria-label="模型输入"]')!;
    change(draft, "未保存的接口配置");
    const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!;
    change(search, "每页笔记数");
    expect(buttons().map(button => button.textContent)).toEqual(["通用"]);
    change(search, "访问密钥 ID");
    expect(buttons().map(button => button.textContent)).toEqual(["S3 图床", "数据库备份"]);
    change(search, "令牌权限");
    expect(buttons().map(button => button.textContent)).toEqual(["MCP 服务"]);
    flushSync(() => buttons()[0].click());
    expect(draft.closest("section")?.hidden).toBe(true);
    change(search, "");
    flushSync(() => buttons().find(button => button.textContent === "AI 模型")!.click());
    expect(draft.closest("section")?.hidden).toBe(false);
    expect(draft.value).toBe("未保存的接口配置");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("keeps settings open on backdrop clicks and allows explicit dismissal", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  flushSync(() => root.render(<SettingsDialog initialPage="appearance" onClose={close} renderPage={() => null} />));
  try {
    // Radix installs its document pointer listener on the next tick.
    await new Promise(resolve => setTimeout(resolve, 0));
    const backdrop = document.querySelector(".rt-DialogOverlay")!;
    backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
