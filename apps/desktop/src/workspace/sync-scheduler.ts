const checkInterval = 5_000;
const uploadDelay = 30_000;
const pullInterval = 300_000;

export function startSyncScheduler({ isActive, read, run, apply, report }: {
  isActive(): boolean;
  read(): Promise<{ pending: boolean } | null>;
  run(): Promise<void>;
  apply(): Promise<boolean>;
  report(error?: unknown): void;
}) {
  let stopped = false;
  let running = false;
  let awakened = true;
  let needsApply = false;
  let pendingSince: number | undefined;
  let nextPull = 0;
  let retryAt = 0;
  let failures = 0;

  async function check() {
    if (stopped || running || !isActive() || Date.now() < retryAt) return;
    running = true;
    try {
      const activity = await read();
      if (stopped || !isActive()) return;
      if (!activity) {
        pendingSince = undefined;
        nextPull = retryAt = failures = 0;
        needsApply = false;
        return;
      }
      const now = Date.now();
      pendingSince = activity.pending ? pendingSince ?? now : undefined;
      if (awakened || now >= nextPull || (pendingSince !== undefined && now >= pendingSince + uploadDelay)) {
        awakened = false;
        needsApply = true;
        nextPull = 0;
        try {
          await run();
        } catch (error) {
          if (!stopped && isActive()) needsApply = !await apply().catch(() => false);
          throw error;
        }
        nextPull = Date.now() + pullInterval;
        pendingSince = undefined;
        retryAt = failures = 0;
        if (!stopped) report();
      }
      if (needsApply && !stopped && isActive() && await apply()) {
        needsApply = false;
        retryAt = failures = 0;
        if (!stopped) report();
      }
    } catch (error) {
      retryAt = Date.now() + Math.min(pullInterval, 15_000 * 2 ** failures++);
      if (!stopped) report(error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void check(), checkInterval);
  void check();
  return {
    wake() { awakened = true; void check(); },
    dispose() { stopped = true; clearInterval(timer); },
  };
}
