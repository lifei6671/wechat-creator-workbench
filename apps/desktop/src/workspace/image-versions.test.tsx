// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { desktop, type ImageVersionFile } from "../desktop";
import { ImageVersions } from "./ImageVersions";

let root: Root, container: HTMLDivElement;
const item: ImageVersionFile = { sha256: "hash", assetId: "old-output", renderId: "r", projectId: "p", name: "旧成品", createdAt: 0,
  bytes: 1024, versions: 1, reasons: [], state: "waiting", dueAt: Date.now() + 604800000, expiresAt: null, error: null };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("opens read-only automatic status without a cleanup confirmation or scheduling request", async () => {
  const status = vi.spyOn(desktop, "imageVersionStatus").mockResolvedValue({ revision: "1", files: [item], reclaimableBytes: 1024 });
  const keep = vi.spyOn(desktop, "imageVersionKeep").mockResolvedValue();
  flushSync(() => root.render(<ImageVersions onClose={() => {}} />));
  await vi.waitFor(() => expect(document.body.textContent).toContain("旧成品"));
  expect(document.body.textContent).toContain("后自动清理");
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  expect(document.body.textContent).not.toContain("确认清理");
  expect(status).toHaveBeenCalledTimes(1);
  expect(keep).not.toHaveBeenCalled();
});
it("waits for real restoration, prevents duplicate work and retains result feedback", async () => {
  let complete!: () => void;
  const restore = vi.spyOn(desktop, "imageVersionRestore").mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  const status = vi.spyOn(desktop, "imageVersionStatus").mockResolvedValue({ revision: "1", files: [{ ...item, reasons: ["missing"], state: "removed", expiresAt: Date.now() + 86400000 }], reclaimableBytes: 0 });
  flushSync(() => root.render(<ImageVersions onClose={() => {}} />));
  await vi.waitFor(() => expect(document.body.textContent).toContain("后台自动清理"));
  await act(async () => { await Promise.resolve(); });
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(element => element.textContent?.includes("回收记录"))!;
  flushSync(() => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  await act(async () => tab.click());
  await vi.waitFor(() => expect(button("恢复")).toBeDefined());
  vi.useFakeTimers();
  flushSync(() => button("恢复").click());
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(restore).toHaveBeenCalledExactlyOnceWith("old-output");
  expect(button("刷新").disabled).toBe(true);
  status.mockResolvedValue({ revision: "2", files: [{ ...item, state: "restored", reasons: ["retained"] }], reclaimableBytes: 0 });
  await act(async () => { complete(); await vi.advanceTimersByTimeAsync(0); });
  expect(button("已恢复")).toBeDefined();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(document.body.textContent).toContain("恢复后保留");
});
