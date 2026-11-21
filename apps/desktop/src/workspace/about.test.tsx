// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop, type AppUpdateStatus } from "../desktop";
import { AboutPage } from "./About";
import { SettingsDialog } from "./Settings";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let changed: (status: AppUpdateStatus) => void;
const idle: AppUpdateStatus = { phase: "idle", version: null, downloaded: 0, total: null, error: null };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(desktop, "appInfo").mockResolvedValue({ name: "workbench", version: "0.1.0", platform: "windows", arch: "x86_64", updatesEnabled: true });
  vi.spyOn(desktop, "appUpdateStatus").mockResolvedValue(idle);
  vi.spyOn(desktop, "onAppUpdateChanged").mockImplementation(async callback => { changed = callback; return () => {}; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ notices: "已有第三方署名", components: [
    { name: "react", version: "19.2.0", ecosystem: "JavaScript", license: "MIT", url: "https://react.dev", text: "MIT license text" },
    { name: "react", version: "18.3.1", ecosystem: "JavaScript", license: "MIT", url: "https://react.dev", text: "MIT license text" },
    { name: "tauri", version: "2.12.5", ecosystem: "Rust", license: "MIT OR Apache-2.0", url: "https://tauri.app", text: "Rust license" },
    { name: "uuid", version: "1.0.0", ecosystem: "Rust", license: "MIT", url: "https://example.com", text: "Excluded transitive dependency" },
  ] }) }));
  container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!;
function change(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}

it("isolates About from scrolling settings and preserves draft values and scroll position", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.id === "settings-section-model" ? 720 : 0;
  });
  await act(async () => root.render(<Theme><SettingsDialog initialPage="model" onClose={vi.fn()}
    renderPage={page => page === "about" ? <AboutPage onInstall={vi.fn()} /> : page === "model" ? <input aria-label="草稿" /> : null} /></Theme>));
  const viewport = document.querySelector<HTMLDivElement>(".settings-pages:not(.settings-about)")!;
  const draft = document.querySelector<HTMLInputElement>('[aria-label="草稿"]')!;
  change(draft, "未提交的设置"); viewport.scrollTop = 755;
  await act(async () => button("关于").click());
  expect(viewport.hidden).toBe(true);
  expect(document.querySelector(".settings-about")?.hasAttribute("hidden")).toBe(false);
  expect(document.activeElement?.id).toBe("settings-about");
  expect(document.querySelector(".settings-about .settings-card")).toBeNull();
  viewport.dispatchEvent(new Event("scroll"));
  expect(button("关于").getAttribute("aria-current")).toBe("location");
  await act(async () => button("AI 代理").click());
  expect(viewport.hidden).toBe(false); expect(viewport.scrollTop).toBe(755);
  expect(draft.value).toBe("未提交的设置");
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索设置"]')!;
  change(search, "版本 更新 开源");
  expect([...document.querySelectorAll(".settings-nav-item")].map(item => item.textContent)).toEqual(["关于"]);
  await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(button("关于").getAttribute("aria-current")).toBe("location");
});
it("shows only core components with resolved versions and licenses offline", async () => {
  const open = vi.spyOn(desktop, "openLink").mockResolvedValue();
  await act(async () => root.render(<Theme><AboutPage onInstall={vi.fn()} /></Theme>));
  expect(container.textContent).toContain("版本 0.1.0"); expect(container.textContent).toContain("Windows x64");
  expect(container.querySelectorAll(".about-component-list li")).toHaveLength(3);
  expect([...container.querySelectorAll(".about-component-name")].map(item => item.textContent)).toEqual(["Tauri", "React", "React"]);
  expect(container.querySelector('[aria-label="查找开源组件"]')).toBeNull();
  expect(container.textContent).not.toContain("Excluded transitive dependency");
  expect(container.textContent).toContain("MIT license text");
  expect(container.textContent).toContain("18.3.1"); expect(container.textContent).toContain("19.2.0");
  expect(container.textContent).not.toContain("第三方署名");
  await act(async () => button("当前版本发布说明").click());
  expect(open).toHaveBeenCalledWith("https://github.com/lifei6671/wechat-creator-workbench/releases/tag/v0.1.0");
});
it("keeps download failures retryable and only offers installation after verified readiness", async () => {
  const next = { ...idle, phase: "available" as const, version: "0.2.0" };
  vi.spyOn(desktop, "appUpdateCheck").mockResolvedValue(next);
  const download = vi.spyOn(desktop, "appUpdateDownload").mockRejectedValueOnce(new Error("签名校验失败"))
    .mockResolvedValueOnce({ ...next, phase: "ready" });
  const install = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<Theme><AboutPage onInstall={install} /></Theme>));
  await act(async () => button("检查更新").click());
  expect(container.textContent).toContain("发现新版本 0.2.0");
  await act(async () => button("下载更新").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("签名校验失败");
  expect(button("退出并安装")).toBeUndefined();
  expect(button("下载失败").disabled).toBe(true);
  await vi.waitFor(() => expect(button("下载更新")?.disabled).toBe(false), { timeout: 1600 });
  await act(async () => button("下载更新").click());
  expect(download).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("0.2.0 已准备就绪");
  expect(container.textContent).toContain("版本 0.1.0");
  await act(async () => button("退出并安装").click()); expect(install).toHaveBeenCalledOnce();
});
it("restores session download progress on remount and handles unknown totals", async () => {
  const state = { ...idle, phase: "downloading" as const, version: "0.2.0", downloaded: 3 * 1024 * 1024 };
  vi.mocked(desktop.appUpdateStatus).mockResolvedValue(state);
  await act(async () => root.render(<Theme><AboutPage onInstall={vi.fn()} /></Theme>));
  expect(container.textContent).toContain("正在下载 3.0 MB");
  expect(container.querySelector("progress")?.hasAttribute("value")).toBe(false);
  await act(async () => changed({ ...state, total: 6 * 1024 * 1024 }));
  expect(container.querySelector("progress")?.value).toBe(3 * 1024 * 1024);
  await act(async () => changed({ ...state, phase: "ready" }));
  expect(button("退出并安装").disabled).toBe(false);
});
