import type { SyncActivity } from "../desktop";

// Network timing belongs to the native task. This loop only retries safe local replay.
export function startSyncApplication({ read, apply, report }: {
  read(): Promise<SyncActivity | null>;
  apply(): Promise<boolean>;
  report(error?: unknown): void;
}) {
  let stopped = false;
  let running = false;
  let reading = false;
  let reread = false;

  async function check() {
    if (stopped) return;
    if (running) {
      if (reading) reread = true;
      return;
    }
    running = true;
    try {
      let activity: SyncActivity | null;
      do {
        reread = false;
        reading = true;
        activity = await read();
      } while (reread && !stopped);
      reading = false;
      if (stopped) return;
      report(activity?.error ?? undefined);
      if (activity?.incoming) await apply();
    } catch (error) {
      if (!stopped) report(error);
    } finally {
      reading = false;
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
