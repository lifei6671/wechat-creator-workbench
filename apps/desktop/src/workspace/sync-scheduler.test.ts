import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SyncActivity } from "../desktop";
import { startSyncApplication } from "./sync-scheduler";

const incoming: SyncActivity = { hasLocalContent: true, initialized: true, pending: false, incoming: true, issues: 0, phase: "idle", error: null, lastExchangeAt: 1 };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("retries deferred local replay and never schedules a network exchange", async () => {
  const read = vi.fn(async () => incoming);
  const apply = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
  const application = startSyncApplication({ read, apply, report: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(apply).toHaveBeenCalledTimes(2);
  read.mockResolvedValue({ ...incoming, incoming: false });
  application.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledTimes(2);
  application.dispose();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(3);
});

it("coalesces notifications during replay and retries retained incoming work on the next timer", async () => {
  let complete!: () => void;
  const apply = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(new Promise(resolve => { complete = () => resolve(true); })).mockResolvedValue(true);
  const read = vi.fn(async () => incoming);
  const application = startSyncApplication({ read, apply, report: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  application.wake();
  application.wake();
  expect(apply).toHaveBeenCalledOnce();
  complete();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(apply).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledTimes(2);
  application.dispose();
});

it("does not loop when applying a retained conflict emits its own status notifications", async () => {
  let wakeDuringApply: () => void = () => {};
  const apply = vi.fn(async () => {
    wakeDuringApply();
    await Promise.resolve();
    wakeDuringApply();
    return true;
  });
  const read = vi.fn(async () => incoming);
  const application = startSyncApplication({ read, apply, report: vi.fn() });
  wakeDuringApply = application.wake;
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  application.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(apply).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(apply).toHaveBeenCalledTimes(3);
  application.dispose();
});

it("preserves structured native errors while allowing downloaded pages to apply", async () => {
  const error = { code: "SYNC_CREDENTIAL", message: "设备凭据已失效" };
  const apply = vi.fn(async () => true);
  const report = vi.fn();
  const application = startSyncApplication({ read: async () => ({ ...incoming, error }), apply, report });
  await vi.advanceTimersByTimeAsync(0);
  expect(report).toHaveBeenCalledWith(error);
  expect(apply).toHaveBeenCalledOnce();
  application.dispose();
});

it("does not apply or report a read completed after disposal", async () => {
  let complete!: (activity: SyncActivity) => void;
  const read = () => new Promise<SyncActivity>(resolve => { complete = resolve; });
  const apply = vi.fn(async () => true);
  const report = vi.fn();
  const application = startSyncApplication({ read, apply, report });
  application.dispose();
  complete(incoming);
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});


it("rereads notifications arriving during a status read without waiting for a foreground event or timer", async () => {
  let finish!: (activity: SyncActivity) => void;
  const read = vi.fn<() => Promise<SyncActivity>>().mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(incoming);
  const apply = vi.fn(async () => true);
  const application = startSyncApplication({ read, apply, report: vi.fn() });
  application.wake();
  application.wake();
  finish({ ...incoming, incoming: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledOnce();
  application.dispose();
});
