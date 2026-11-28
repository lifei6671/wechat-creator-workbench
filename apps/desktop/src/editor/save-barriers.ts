const barriers = new Set<() => Promise<void>>();
export const hasActiveSaveBarriers = () => barriers.size > 0;

export function registerSaveBarrier(flush: () => Promise<void>) {
  barriers.add(flush);
  return () => { barriers.delete(flush); };
}

export async function flushSaveBarriers() {
  await Promise.all([...barriers].map(flush => flush()));
}
