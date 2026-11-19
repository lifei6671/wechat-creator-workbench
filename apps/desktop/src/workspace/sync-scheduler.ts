import type { SyncActivity } from "../desktop";

// Network timing belongs to the native task. This loop only retries safe local replay.
export function startSyncApplication({ read, apply, report }: {
  read(): Promise<SyncActivity | null>;
  apply(): Promise<boolean>;
  report(error?: unknown): void;
}) {
  let stopped = false;
  let running = false;

  async function check() {
    if (stopped) return;
    if (running) return;
    running = true;
    try {
      const activity = await read();
      if (stopped) return;
      report(activity?.error ?? undefined);
      if (activity?.incoming) await apply();
    } catch (error) {
      if (!stopped) report(error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void check(), 5_000);
  void check();
  return {
    wake() { void check(); },
    dispose() { stopped = true; clearInterval(timer); },
  };
}
