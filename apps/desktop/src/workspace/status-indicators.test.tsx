// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { SyncActivity, SyncBinding } from "../desktop";
import { getSyncStatus, SyncStatus } from "./SyncStatus";

const binding: SyncBinding = { url: "https://sync.example", instanceId: "instance", epoch: "epoch", deviceId: "device", paused: false };
const activity: SyncActivity = { hasLocalContent: true, initialized: true, pending: false, incoming: false, issues: 0,
  phase: "idle", error: null, lastExchangeAt: 1 };

it("keeps sync precedence when displaying status dots", () => {
  const props = { binding, activity: { ...activity, phase: "syncing" as const, issues: 2, error: { code: "NETWORK", message: "重试中" } } };
  expect(getSyncStatus(props)).toMatchObject({ label: "正在同步", dot: "busy", busy: true });
  expect(getSyncStatus({ ...props, binding: { ...binding, paused: true } })).toMatchObject({ label: "已暂停", dot: "waiting", busy: false });
  expect(getSyncStatus({ ...props, reconnect: true })).toMatchObject({ label: "需要重新连接", dot: "error", busy: false });
  expect(getSyncStatus({ ...props, activity: { ...props.activity, error: { code: "SYNC_REAUTH", message: "凭据失效" } } }))
    .toMatchObject({ label: "需要重新连接", dot: "error", busy: false });
  expect(getSyncStatus({ binding, activity: { ...activity, incoming: true, issues: 1 } }))
    .toMatchObject({ label: "有内容需要处理", dot: "error" });
});

it("keeps settings status text and spinner while compact status is icon only", () => {
  const props = { binding, activity: { ...activity, phase: "downloading" as const } };
  const full = renderToStaticMarkup(<SyncStatus {...props} />);
  const compact = renderToStaticMarkup(<SyncStatus {...props} compact />);
  expect(full).toContain("<span>正在下载</span>");
  expect(full).toContain("rt-Spinner");
  const host = document.createElement("div");
  host.innerHTML = compact;
  expect(host.textContent).toBe("");
  expect(host.querySelector("[role=status]")?.getAttribute("aria-label")).toBe("正在下载");
  expect(host.querySelector(".status-dot")?.getAttribute("data-state")).toBe("busy");
});
