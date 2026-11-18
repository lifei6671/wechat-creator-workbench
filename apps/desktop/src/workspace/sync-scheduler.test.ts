import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startSyncScheduler } from "./sync-scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("syncs on startup and wake, after local changes accumulate, and every five minutes", async () => {
  let active = true;
  let pending = false;
  const apply = vi.fn(async () => true);
  const run = vi.fn(async () => { pending = false; });
  const scheduler = startSyncScheduler({ isActive: () => active, read: async () => ({ pending }), run, apply, report: vi.fn() });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    pending = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);

    active = false;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run).toHaveBeenCalledTimes(3);
    active = true;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(4);
    expect(apply).toHaveBeenCalledTimes(4);
  } finally {
    scheduler.dispose();
  }
});

it("serializes attempts, backs off after failure, and retries deferred replay without another exchange", async () => {
  let fail!: (error: Error) => void;
  const request = new Promise<void>((_resolve, reject) => { fail = reject; });
  const run = vi.fn<() => Promise<void>>().mockReturnValueOnce(request).mockResolvedValue(undefined);
  const apply = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
  const report = vi.fn();
  const scheduler = startSyncScheduler({ isActive: () => true, read: async () => ({ pending: false }), run, apply, report });
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.wake();
    expect(run).toHaveBeenCalledTimes(1);
    const error = new Error("offline");
    fail(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledWith(error);
    expect(apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(3);
  } finally {
    scheduler.dispose();
  }
});
