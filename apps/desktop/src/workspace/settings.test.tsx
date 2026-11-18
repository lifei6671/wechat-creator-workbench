// @vitest-environment jsdom
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop, type AiSettings } from "../desktop";
import { ModelSettings } from "./AiSettings";
import { MigrationPanel } from "./Migration";
import { McpSettings, S3Fields, SettingsDialog } from "./Settings";
import { SyncSettings } from "./SyncSettings";

let enterSection: (section: HTMLElement) => void;
beforeEach(() => {
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

it("shows the bound sync device and copies a pairing code without displaying it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const pairingToken = "f".repeat(64);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test/", deviceId: "previous", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({
    currentDeviceId: "local",
    devices: [{ deviceId: "local", name: "工作电脑", createdAt: 0, revokedAt: null }],
  });
  vi.spyOn(desktop, "syncCreatePairing").mockResolvedValue({ pairingToken, expiresAt: Date.now() + 600_000 });
  vi.spyOn(desktop, "syncConflicts").mockResolvedValue([]);
  const copy = vi.spyOn(desktop, "copyText").mockResolvedValue(undefined);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={vi.fn()} onRebuild={vi.fn()} /></Theme>));
    await vi.waitFor(() => expect(container.textContent).toContain("工作电脑"));
    expect(container.textContent).toContain("设备已绑定");
    expect(container.textContent).toContain("当前设备");
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === "复制配对码")!;
    flushSync(() => button.click());
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(pairingToken));
    expect(container.textContent).not.toContain(pairingToken);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("offers re-pairing against the saved instance when its device credential was revoked", async () => {
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
    await vi.waitFor(() => expect(container.textContent).toContain("需重新配对"));
    expect(container.querySelector<HTMLInputElement>("#sync-bound-url")?.readOnly).toBe(true);
    expect(container.querySelector('label[for="sync-code"]')?.textContent).toBe("配对码");
    expect(container.textContent).not.toContain("复制配对码");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("keeps a local canvas edit by sending the displayed conflict version", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const resolve = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(desktop, "syncStatus").mockResolvedValue({
    url: "https://sync.example.test/", deviceId: "local", instanceId: "instance", epoch: "epoch", paused: false,
  });
  vi.spyOn(desktop, "syncDevices").mockResolvedValue({ currentDeviceId: "local", devices: [] });
  vi.spyOn(desktop, "syncConflicts").mockResolvedValueOnce([{
    entityType: "collection_node", entityId: "note", reason: "两端修改了同一张卡片",
    local: { contentMd: "本地" }, remote: { contentMd: "云端" },
    resolvable: false, canKeepLocal: true, remoteRevision: 3, localGeneration: 8,
  }]).mockResolvedValue([]);
  try {
    flushSync(() => root.render(<Theme><SyncSettings onSync={vi.fn()} onResolve={resolve} onRebuild={vi.fn()} /></Theme>));
    const keep = await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find(item => item.textContent === "保留本地版本");
      expect(button).toBeDefined();
      return button!;
    });
    flushSync(() => keep.click());
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith("collection_node", "note", "local", 3, 8));
    await vi.waitFor(() => expect(container.textContent).toContain("本地版本已排队上传"));
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
