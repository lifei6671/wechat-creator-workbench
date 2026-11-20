// @vitest-environment jsdom
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop, type AiSettings } from "../desktop";
import { ModelSettings } from "./AiSettings";
import { MigrationPanel } from "./Migration";
import { McpSettings, S3Fields, SettingsDialog, TrashRetentionSetting, ViewShortcutSetting } from "./Settings";
import { SyncSettings } from "./SyncSettings";

let enterSection: (section: HTMLElement) => void;
it("shows seven-day trash retention and persists changes including disabling automatic cleanup", async () => {
  const preference = vi.spyOn(desktop, "trashRetention").mockImplementation(async days => days ?? 7);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><form><TrashRetentionSetting /></form></Theme>));
    await vi.waitFor(() => expect(container.querySelector("#trash-retention")?.textContent).toContain("7 天"));
    expect(container.querySelector("#trash-retention")?.getAttribute("aria-describedby")).toBe("trash-retention-hint");
    for (const days of [30, 0]) {
      const select = container.querySelector("select")!;
      flushSync(() => { select.value = String(days); select.dispatchEvent(new Event("change", { bubbles: true })); });
      await vi.waitFor(() => expect(preference).toHaveBeenLastCalledWith(days));
      await vi.waitFor(() => expect(container.querySelector("#trash-retention")?.textContent).toContain(days ? "30 天" : "不自动清理"));
    }
  } finally { flushSync(() => root.unmount()); container.remove(); }
});
beforeEach(() => {
  vi.spyOn(desktop, "onSyncStatusChanged").mockResolvedValue(() => {});
  vi.spyOn(desktop, "syncActivity").mockResolvedValue(null);
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {
      enterSection = section => callback([{ isIntersecting: true, target: section }]);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("explains what to enter in every first-time sync setting", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue(null);
  vi.spyOn(desktop, "syncDefaultDeviceName").mockResolvedValue("办公电脑");
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#sync-name")?.value).toBe("办公电脑"));
    for (const [id, context] of [
      ["sync-url", "HTTPS 根地址"], ["sync-name", "设备列表"],
      ["sync-code", "SETUP_SECRET"],
    ]) {
      const description = container.querySelector(`#${id}`)?.getAttribute("aria-describedby");
      expect(description).toBe(`${id}-hint`);
      expect(document.getElementById(description!)?.textContent).toContain(context);
    }
    expect(container.querySelector("#sync-method")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("#sync-code")?.type).toBe("text");
    expect(container.querySelector("#sync-url-hint")?.textContent).toContain("不是 R2/S3 存储端点");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("does not replace a device name edited before the computer name arrives", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let resolveName!: (name: string) => void;
  const suggested = new Promise<string>(resolve => { resolveName = resolve; });
  vi.spyOn(desktop, "syncStatus").mockResolvedValue(null);
  vi.spyOn(desktop, "syncDefaultDeviceName").mockReturnValue(suggested);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    const input = await vi.waitFor(() => {
      const field = container.querySelector<HTMLInputElement>("#sync-name");
      expect(field).not.toBeNull();
      return field!;
    });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "写作用电脑");
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    resolveName("系统电脑名");
    await new Promise(requestAnimationFrame);
    expect(input.value).toBe("写作用电脑");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("copies saved connection information without rotating its key and keeps secrets out of the settings view", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const accessKey = "f".repeat(64);
  const recoveryKey = "e".repeat(64);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test/", deviceId: "previous", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({
    currentDeviceId: "local",
    devices: [{ deviceId: "local", name: "工作电脑", createdAt: 0, revokedAt: null }],
  });
  vi.spyOn(desktop, "syncCreateAccessKey").mockResolvedValue(accessKey);
  vi.spyOn(desktop, "syncConnectionInfo").mockResolvedValue({ url: "https://sync.example.test/", accessKey });
  vi.spyOn(desktop, "syncCreateRecoveryKey").mockResolvedValue(recoveryKey);
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  const copy = vi.spyOn(desktop, "copyText").mockResolvedValue(undefined);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()}
      automaticError="后台同步超时" /></Theme>));
    await vi.waitFor(() => expect(container.textContent).toContain("工作电脑"));
    expect(container.textContent).toContain("同步失败");
    expect(container.textContent).toContain("当前设备");
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === "复制连接信息")!;
    flushSync(() => button.click());
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(`服务地址：https://sync.example.test/\n连接密钥：${accessKey}`));
    await vi.waitFor(() => expect(container.textContent).toContain("连接信息已复制"));
    expect(desktop.syncCreateAccessKey).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("后台同步超时");
    expect(container.textContent).not.toContain(accessKey);
    flushSync(() => container.querySelector<HTMLDetailsElement>(".sync-advanced")!.open = true);
    const recovery = container.querySelector<HTMLButtonElement>("#sync-recovery-key")!;
    flushSync(() => recovery.click());
    await vi.waitFor(() => expect(copy).toHaveBeenLastCalledWith(recoveryKey));
    await vi.waitFor(() => expect(container.textContent).toContain("恢复密钥已复制"));
    expect(container.textContent).not.toContain(recoveryKey);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("retries unified connection and applies a first merge once without using its archive as a scheduling signal", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const url = "https://sync.example.test";
  const setupSecret = "a".repeat(64);
  const accessCode = "b".repeat(64);
  const synchronize = vi.fn().mockResolvedValueOnce("sync-recovery/workspace-merge.zip").mockResolvedValueOnce(undefined);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue(null);
  vi.spyOn(desktop, "syncDefaultDeviceName").mockResolvedValue("新电脑");
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "new", devices: [] });
  const connect = vi.spyOn(desktop, "syncConnect")
    .mockRejectedValueOnce({ code: "SYNC_CODE", message: "连接密钥无效" })
    .mockResolvedValueOnce({ url, deviceId: "new", instanceId: "instance", epoch: "epoch", paused: false });
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={synchronize} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#sync-name")?.value).toBe("新电脑"));
    const form = container.querySelector("form")!;
    const feedback = form.querySelector(".sync-feedback")!;
    const fill = (id: string, value: string) => {
      const input = form.querySelector(`#${id}`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    };
    const submit = () => flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    fill("sync-url", url);
    fill("sync-code", setupSecret);
    submit();
    await vi.waitFor(() => expect(feedback.textContent).toContain("连接密钥无效"));
    expect(form.querySelector(".sync-connect-footer > [role=alert]")).toBe(feedback);
    expect(form.querySelector("#sync-method")).toBeNull();
    expect(form.querySelector("#sync-code-hint")?.textContent).toContain("连接密钥");
    expect(form.querySelector<HTMLInputElement>("#sync-code")?.value).toBe(setupSecret);
    expect(form.querySelector<HTMLInputElement>("#sync-url")?.value).toBe(url);

    fill("sync-code", accessCode);
    submit();
    await vi.waitFor(() => expect(container.textContent).toContain("已合并本地与云端内容"));
    await vi.waitFor(() => expect(container.textContent).toContain("打开恢复副本位置"));
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenNthCalledWith(1, url, "新电脑", setupSecret);
    expect(connect).toHaveBeenNthCalledWith(2, url, "新电脑", accessCode);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("offers reconnecting against the saved instance when its device credential was revoked", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test/", deviceId: "revoked", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockRejectedValue({ code: "SYNC_CREDENTIAL", message: "同步设备凭据已失效" });
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.textContent).toContain("需要重新连接"));
    expect(container.querySelector<HTMLInputElement>("#sync-bound-url")?.readOnly).toBe(true);
    expect(container.querySelector('label[for="sync-code"]')?.textContent).toBe("连接密钥");
    expect(container.querySelector("#sync-code")?.getAttribute("aria-describedby")).toBe("sync-code-hint");
    expect(container.querySelector("#sync-code-hint")?.textContent).toContain("连接密钥");
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "生成并复制接入密钥")).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each(["local", "cloud", "copy"] as const)("resolves a canvas edit with %s using the displayed versions", async choice => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const resolve = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test/", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [] });
  vi.spyOn(desktop, "syncConflicts").mockResolvedValueOnce([{
    entityType: "collection_node", entityId: "note", reason: "两端修改了同一张卡片",
    local: { kind: "text", contentMd: "本地", x: 10, y: 20, width: 300, height: 200 },
    remote: { kind: "text", contentMd: "云端", x: 30, y: 40, width: 400, height: 200 },
    remoteDeleted: false, resolvable: true, canKeepLocal: true, remoteRevision: 3, localGeneration: 8,
  }]).mockResolvedValue([]);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={resolve} onRebuild={vi.fn()} /></Theme>));
    const keep = await vi.waitFor(() => {
      const label = { local: "保留本地版本", cloud: "采用云端版本", copy: "另存副本" }[choice];
      const button = [...container.querySelectorAll("button")].find(item => item.textContent === label);
      expect(button).toBeDefined();
      return button!;
    });
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="本地版本"]')?.value).toContain("本地");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="云端版本"]')?.value).toContain("位置：30, 40");
    expect(container.textContent).toContain("完整复制本地白板");
    flushSync(() => keep.click());
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith("collection_node", "note", choice, 3, 8));
    await vi.waitFor(() => expect(container.textContent).toContain(choice === "local" ? "本地版本已排队上传" : choice === "copy" ? "已另存本地白板副本" : "冲突已处理"));
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each(["collection", "collection_edge"] as const)("shows both %s versions and offers all choices", async entityType => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({ url: "https://sync.example.test/", deviceId: "device", instanceId: "i", epoch: "e", paused: false });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "device", devices: [] });
  vi.mocked(desktop.syncConflicts).mockResolvedValue([{
    entityType, entityId: "item", reason: "版本不同", local: { title: "本地白板", description: "本地说明", label: "本地连线", sourceNodeId: "a", targetNodeId: "b" },
    remote: { title: "云端白板", description: "云端说明", label: "云端连线", sourceNodeId: "b", targetNodeId: "c" },
    remoteDeleted: false, resolvable: true, canKeepLocal: true, remoteRevision: 2, localGeneration: 1,
  }]);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="云端版本"]')).not.toBeNull());
    const local = container.querySelector<HTMLTextAreaElement>('[aria-label="本地版本"]')!;
    const remote = container.querySelector<HTMLTextAreaElement>('[aria-label="云端版本"]')!;
    expect(local.value).toContain(entityType === "collection" ? "本地说明" : "本地连线");
    expect(remote.value).toContain(entityType === "collection" ? "云端说明" : "终点：c");
    expect(local.readOnly && remote.readOnly).toBe(true);
    for (const text of ["保留本地版本", "采用云端版本", "另存副本"]) {
      expect([...container.querySelectorAll("button")].find(button => button.textContent === text)?.disabled).toBe(false);
    }
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it.each([true, false])("explains deleted canvas versions (cloud deleted: %s)", async remoteDeleted => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({ url: "https://sync.example.test/", deviceId: "device", instanceId: "i", epoch: "e", paused: false });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "device", devices: [] });
  vi.mocked(desktop.syncConflicts).mockResolvedValue([{
    entityType: "collection", entityId: "topic", reason: "修改与删除冲突", local: remoteDeleted ? { title: "本地白板", description: "说明" } : null,
    remote: remoteDeleted ? {} : { title: "云端白板", description: "说明" }, remoteDeleted,
    resolvable: true, canKeepLocal: !remoteDeleted, remoteRevision: 2, localGeneration: 1,
  }]);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="云端版本"]')).not.toBeNull());
    expect(container.querySelector<HTMLTextAreaElement>(`[aria-label="${remoteDeleted ? "云端" : "本地"}版本"]`)?.value).toBe("此项已删除");
    const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text)!;
    expect(button("采用云端版本").disabled).toBe(false);
    expect(button("保留本地版本").disabled).toBe(remoteDeleted);
    expect(button("另存副本").disabled).toBe(!remoteDeleted);
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("refreshes a visible settings page after native authentication failure and keeps blocked work out of the synced state", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let changed!: () => void;
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { changed = callback; return () => {}; });
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test/", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [] });
  vi.spyOn(desktop, "syncDefaultDeviceName").mockResolvedValue("本机");
  const state = { hasLocalContent: true, initialized: true, pending: false, incoming: false, issues: 1, phase: "idle" as const, error: null, lastExchangeAt: 1 };
  vi.mocked(desktop.syncActivity).mockResolvedValue(state);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.textContent).toContain("有内容需要处理"));
    expect(container.textContent).not.toContain("已同步");
    vi.mocked(desktop.syncActivity).mockResolvedValue({ ...state, error: { code: "SYNC_CREDENTIAL", message: "同步设备已撤销" } });
    flushSync(changed);
    await vi.waitFor(() => expect(container.textContent).toContain("需要重新连接"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("同步设备已撤销");
    expect(container.querySelector("#sync-code")).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("refreshes local status when a hidden settings page becomes visible again", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test/", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [] });
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.textContent).toContain("等待检查"));
    vi.mocked(desktop.syncActivity).mockResolvedValue({ hasLocalContent: true, initialized: true, pending: false, incoming: true, issues: 0, phase: "idle", error: null, lastExchangeAt: 1 });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(container.textContent).toContain("已下载，准备应用"));
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("shows live sync progress and keeps the merge completion notice on one line", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let changed!: () => void;
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { changed = callback; return () => {}; });
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [] });
  const state = { hasLocalContent: true, initialized: true, pending: false, incoming: false, issues: 0,
    phase: "idle" as const, error: null, lastExchangeAt: 1 };
  vi.mocked(desktop.syncActivity).mockResolvedValue(state);
  let finish!: (archive: string) => void;
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={() => new Promise(resolve => { finish = resolve; })}
      onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.textContent).toContain("已同步"));
    const sync = [...container.querySelectorAll("button")].find(button => button.textContent === "立即同步")!;
    flushSync(() => sync.click());
    for (const phase of ["connecting", "downloading", "merging"] as const) {
      vi.mocked(desktop.syncActivity).mockResolvedValue({ ...state, phase });
      flushSync(changed);
      await vi.waitFor(() => expect(container.querySelector('.sync-state[data-tone="busy"]')).not.toBeNull());
    }
    vi.mocked(desktop.syncActivity).mockResolvedValue(state);
    finish("C:/recovery.zip");
    await vi.waitFor(() => expect(container.querySelector(".sync-feedback")?.textContent).toBe("已合并本地与云端内容"));
    expect(container.querySelector(".sync-feedback")?.getAttribute("title")).toBe("已合并本地与云端内容");
    expect(container.querySelector(".sync-advanced > summary svg")).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it.each([
  { hasLocalContent: true, initialized: false, bound: false, visible: true },
  { hasLocalContent: false, initialized: false, bound: false, visible: false },
  { hasLocalContent: true, initialized: false, bound: true, visible: true },
  { hasLocalContent: true, initialized: true, bound: true, visible: false },
])("shows the accessible merge notice only for first nonempty connection: %j", async state => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue(state.bound ? {
    url: "https://sync.example.test/", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false,
  } : null);
  vi.spyOn(desktop, "syncDefaultDeviceName").mockResolvedValue("本机");
  vi.mocked(desktop.syncActivity).mockResolvedValue({ hasLocalContent: state.hasLocalContent, initialized: state.initialized,
    pending: false, incoming: false, issues: 0, phase: "idle", lastExchangeAt: null,
    error: state.bound ? { code: "SYNC_CREDENTIAL", message: "设备凭据已失效" } : null });
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.querySelector("#sync-name")).not.toBeNull());
    const notice = container.querySelector("#sync-merge-hint");
    const form = container.querySelector("form")!;
    const connect = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(Boolean(notice)).toBe(state.visible);
    if (state.visible) {
      expect(notice!.textContent).toBe("连接后将合并本地与云端内容；同一内容存在不同修改时，会保留双方版本供你处理。");
      expect(connect.getAttribute("aria-describedby")).toBe(notice!.id);
      expect(notice!.classList.contains("setting-hint")).toBe(true);
      expect(notice!.closest(".sync-feedback")).toBeNull();
      expect(notice!.getAttribute("role")).toBeNull();
    } else expect(connect.hasAttribute("aria-describedby")).toBe(false);
    expect(connect.textContent).toBe("连接");
    expect(form.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    if (state.bound) expect(form.querySelector('[role="alert"]')?.textContent).toContain("设备凭据已失效");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("associates visible help and warnings with the settings controls they describe", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<Theme>
    <McpSettings status={{ config: { enabled: false, port: 8787, permission: "read" }, running: false, error: null }}
      loadError="" onStatus={() => {}} />
    <S3Fields scope="backup" initial={null} hasKey={false} />
    <MigrationPanel busy={false} working={null} feedback={null} prepared
      onTransfer={() => {}} onConfirmRestore={() => {}} onDiscardRestore={() => {}} />
  </Theme>));
  try {
    const help = (control: Element) => {
      const id = control.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      return document.getElementById(id!)!;
    };
    expect(help(container.querySelector("#backup-endpoint")!).textContent).toBe("用于连接存储服务的 API 地址。");
    const permission = help(container.querySelector("#mcp-permission")!);
    expect(permission.textContent).toContain("只读权限允许客户端查阅工作区内容");
    expect(permission.querySelector(".setting-warning")?.textContent).toContain("客户端可以通过 MCP 修改工作区内容");
    const reset = [...container.querySelectorAll("button")].find(button => button.textContent === "重置令牌")!;
    const restore = container.querySelector("#migration-restore-trigger")!;
    expect(help(reset).querySelector(".setting-warning")?.textContent).toContain("旧令牌的客户端");
    expect(help(restore).querySelector(".setting-warning")?.textContent).toContain("替换当前工作区的数据");
    expect(help(reset).id).not.toBe(help(restore).id);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

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
    flushSync(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(buttons()[0].getAttribute("aria-current")).toBe("location");
    expect(document.activeElement?.id).toBe("settings-mcp");
    expect(draft.closest("section")?.hidden).toBe(false);
    change(search, "");
    flushSync(() => buttons().find(button => button.textContent === "AI 代理")!.click());
    expect(draft.closest("section")?.hidden).toBe(false);
    expect(draft.value).toBe("未保存的接口配置");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("opens at the requested section, tracks the scroll position and loads storage sections when reached", async () => {
  const offsets: Record<string, number> = {
    appearance: 0, shortcuts: 460, migration: 600, model: 720, mcp: 980, sync: 1180, images: 1250, backups: 1620,
  };
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return offsets[this.id.replace("settings-section-", "")] ?? 0;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const active = () => document.querySelector('.settings-nav-item[aria-current="location"]')?.textContent;
  const renderPage = vi.fn((page: string) => <span>{page}</span>);
  flushSync(() => root.render(<SettingsDialog initialPage="model" renderPage={renderPage} onClose={() => {}} />));
  try {
    const viewport = document.querySelector<HTMLElement>(".settings-pages")!;
    expect(viewport.scrollTop).toBe(720);
    expect(active()).toBe("AI 代理");
    expect(document.activeElement?.id).toBe("settings-model");
    expect(renderPage).not.toHaveBeenCalledWith("backups");
    expect(renderPage).not.toHaveBeenCalledWith("sync");

    const backupAnchor = document.querySelector<HTMLButtonElement>('[aria-controls="settings-section-backups"]')!;
    flushSync(() => backupAnchor.click());
    expect(viewport.scrollTop).toBe(1620);
    expect(active()).toBe("数据库备份");
    expect(document.activeElement?.id).toBe("settings-backups");
    flushSync(() => enterSection(document.getElementById("settings-section-backups")!));
    expect(renderPage).toHaveBeenCalledWith("backups");

    viewport.scrollTop = 1120;
    viewport.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(active()).toBe("MCP 服务"));
    viewport.scrollTop = 1200;
    viewport.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(active()).toBe("同步"));
    flushSync(() => enterSection(document.getElementById("settings-section-sync")!));
    expect(renderPage).toHaveBeenCalledWith("sync");
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(active()).toBe("通用"));
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

it.each(["local", "custom"] as const)("removes a saved %s model with one click", async kind => {
  const initial: AiSettings = {
    preferences: { enabled: true, defaultTarget: { kind: "model", id: "saved-model" } },
    agents: [],
    models: [{ id: "saved-model", kind, name: "试用模型", endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2", timeoutSeconds: 60 }],
  };
  vi.spyOn(desktop, "aiAgentVersions").mockResolvedValue([]);
  const deleteModel = vi.spyOn(desktop, "deleteAiModel").mockResolvedValue({
    ...initial, preferences: { ...initial.preferences, defaultTarget: null }, models: [],
  });
  function Harness() {
    const [settings, setSettings] = useState(initial);
    return <Theme><ModelSettings settings={settings} loadError="" onSave={async save => setSettings(await save())} /></Theme>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<Harness />));
  try {
    const tab = container.querySelector(`[role="tab"][aria-controls$="-content-${kind}"]`)!;
    flushSync(() => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    const remove = container.querySelector<HTMLButtonElement>('[data-state="active"] button[aria-label="移除 试用模型"]')!;
    flushSync(() => remove.click());
    expect(deleteModel).toHaveBeenCalledOnce();
    expect(deleteModel).toHaveBeenCalledWith("saved-model");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="移除 试用模型"]')).toBeNull();
      expect(container.querySelector("#ai-default")?.textContent).toBe("未选择");
    });
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});


it("records shortcuts through the inline input and preserves bindings on cancellation", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  function Setting() {
    const [value, setValue] = useState<import("./view-shortcut").ViewShortcut>("none");
    return <ViewShortcutSetting value={value} hintId="shortcut-hint" onChange={value => { setValue(value); changed(value); }} />;
  }
  try {
    flushSync(() => root.render(<Theme><Setting /></Theme>));
    const trigger = () => container.querySelector<HTMLButtonElement>("button#view-shortcuts")!;
    const clear = () => container.querySelector<HTMLButtonElement>('button[aria-label="删除快捷键"]')!;
    const press = (init: KeyboardEventInit) => flushSync(() => container.querySelector<HTMLInputElement>("input#view-shortcuts")!
      .dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })));
    expect(trigger().textContent).toBe("点击设置");
    expect(trigger().querySelector(".shortcut-empty-icon svg")).not.toBeNull();
    expect(clear().disabled).toBe(true);
    flushSync(() => trigger().click());
    const input = container.querySelector<HTMLInputElement>('input[placeholder="按下快捷键"]')!;
    expect(input).not.toBeNull();
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[aria-label="取消快捷键设置"]')?.textContent).toBe("ESC 取消");
    press({ key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(changed).not.toHaveBeenCalled();
    for (const binding of [
      { key: "s", code: "KeyS" }, { key: "e", code: "KeyE" }, { key: "[", code: "BracketLeft" },
      { key: "1", code: "Digit1", altKey: true }, { key: "c", code: "KeyC", altKey: true }, { key: "x", code: "KeyX", altKey: true },
    ]) {
      press({ ...binding, ctrlKey: true });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("已被其他操作占用");
      expect(changed).not.toHaveBeenCalled();
    }
    press({ key: "j", ctrlKey: true, altKey: true });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ code: "KeyJ", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false });
    expect(trigger().querySelector("kbd")?.textContent).toBe("Ctrl+Alt+J");
    expect(trigger().dataset.configured).toBe("true");
    expect(clear().disabled).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));

    flushSync(() => trigger().click());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="取消快捷键设置"]')!.click());
    expect(trigger().textContent).toBe("Ctrl+Alt+J");
    expect(changed).toHaveBeenCalledOnce();
    flushSync(() => trigger().click());
    press({ key: "e", code: "KeyE", ctrlKey: true });
    press({ key: "Escape", code: "Escape" });
    expect(trigger().textContent).toBe("Ctrl+Alt+J");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));

    flushSync(() => trigger().click());
    flushSync(() => clear().click());
    expect(changed).toHaveBeenLastCalledWith("none");
    expect(trigger().textContent).toBe("点击设置");
    expect(container.querySelector("input#view-shortcuts")).toBeNull();
    expect(clear().disabled).toBe(true);
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it.each(["input", "cancel"])("cancels shortcut recording with Escape from %s without closing settings", async focus => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const closed = vi.fn();
  const changed = vi.fn();
  try {
    flushSync(() => root.render(<Theme><SettingsDialog initialPage="shortcuts" onClose={closed}
      renderPage={page => page === "shortcuts" ? <ViewShortcutSetting value="shift-m" hintId="shortcut-hint" onChange={changed} /> : null} /></Theme>));
    const dialog = document.querySelector('[role="dialog"]')!;
    flushSync(() => dialog.querySelector<HTMLButtonElement>("button#view-shortcuts")!.click());
    const target = focus === "input" ? dialog.querySelector<HTMLInputElement>("input#view-shortcuts")!
      : dialog.querySelector<HTMLButtonElement>('[aria-label="取消快捷键设置"]')!;
    target.focus();
    flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })));
    expect(closed).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(dialog.querySelector("button#view-shortcuts")?.textContent).toBe("Ctrl+Shift+M");
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.querySelector("button#view-shortcuts")));
  } finally { flushSync(() => root.unmount()); container.remove(); }
});


it("keeps only core connected actions visible and refreshes devices without a refresh button", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let notify!: () => void;
  let exchangeAt = 1;
  let names = ["当前电脑"];
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(desktop.onSyncStatusChanged).mockImplementation(async callback => { notify = callback; return () => {}; });
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({ url: "https://sync.example.test/", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false });
  vi.mocked(desktop.syncActivity).mockImplementation(async () => ({ hasLocalContent: true, initialized: true, pending: false, incoming: false,
    issues: 0, phase: "idle", error: null, lastExchangeAt: exchangeAt }));
  const devices = vi.spyOn(desktop, "syncDevices").mockImplementation(async () => ({ currentDeviceId: "local",
    devices: names.map((name, index) => ({ name, deviceId: index ? `peer-${index}` : "local", createdAt: 0, revokedAt: null })),
  }));
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  const sync = vi.fn(async () => { exchangeAt += 1; names.push("同步后加入的电脑"); return undefined; });
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={sync} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.textContent).toContain("当前电脑"));
    const advanced = container.querySelector<HTMLDetailsElement>(".sync-advanced")!;
    expect(advanced.open).toBe(false);
    const primary = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(button => !advanced.contains(button));
    expect(primary.map(button => button.textContent)).toEqual(["复制连接信息", "立即同步"]);
    expect(container.textContent).not.toContain("刷新设备");
    expect(container.textContent).not.toContain("输入连接密钥");
    expect([...advanced.querySelectorAll("button")].map(button => button.textContent)).toContain("更换并复制密钥");
    expect(advanced.querySelector("#sync-recovery-key")).not.toBeNull();

    flushSync(() => primary.find(button => button.textContent === "立即同步")!.click());
    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(advanced.textContent).toContain("同步后加入的电脑"));
    names.push("后台同步加入的电脑");
    exchangeAt += 1;
    flushSync(notify);
    await vi.waitFor(() => expect(advanced.textContent).toContain("后台同步加入的电脑"));
    const afterExchange = devices.mock.calls.length;
    flushSync(notify);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(devices).toHaveBeenCalledTimes(afterExchange);
    names.push("切回窗口后加入的电脑");
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(advanced.textContent).toContain("切回窗口后加入的电脑"));
  } finally { flushSync(() => root.unmount()); container.remove(); }
});
