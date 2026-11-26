import { afterEach, expect, it, vi } from "vitest";
import type { Entry } from "../../../../packages/shared-types";
import { SaveQueue } from "./save-queue";

const entry: Entry = { id: "article", kind: "article", title: "Title", contentMd: "", status: "draft", categoryId: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 4, updatedAt: 0, deletedAt: null, links: [] };
afterEach(() => vi.useRealTimers());

it("persists continuous rich-text snapshots within one second and reuses serialization for the formal save", async () => {
  vi.useFakeTimers();
  const put = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn(() => new Promise<never>(() => {}));
  const queue = new SaveQueue(entry, commit, () => {}, put);
  let revision = 0;
  const read = vi.fn(() => ({ localRevision: revision, markdown: "x".repeat(100_000) + revision }));
  queue.bindContentProvider(read);
  for (let i = 0; i < 25; i++) {
    queue.markContentDirty(++revision);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(put).toHaveBeenCalledTimes(3);
  expect(put.mock.calls[0][0]).toMatchObject({ entryId: "article", baseVersion: 4, localRevision: 8, fields: { contentMd: "x".repeat(100_000) + 8 } });
  expect(read.mock.calls.length).toBeLessThanOrEqual(4);
  expect(put.mock.calls.every(([draft]) => /^[a-f0-9-]{36}$/.test(draft.sessionId))).toBe(true);
  queue.dispose();
});

it("continues recovery persistence after a formal save conflict and captures source/AI replacement", async () => {
  vi.useFakeTimers();
  const put = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockRejectedValue({ code: "VERSION_CONFLICT", currentVersion: 5 });
  const queue = new SaveQueue(entry, commit, () => {}, put);
  queue.edit({ contentMd: "source replacement" });
  expect(await queue.flush({ aiReplace: true })).toBe(false);
  queue.edit({ contentMd: "new AI content" });
  await vi.advanceTimersByTimeAsync(800);
  expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ baseVersion: 4, localRevision: 2, fields: expect.objectContaining({ contentMd: "new AI content" }) }));
  expect(commit).toHaveBeenCalledWith("article", 4, expect.anything(), "ai_replace", expect.objectContaining({ localRevision: 1 }));
  queue.dispose();
});

it("shares one serialized Markdown result between recovery and an ordinary quiet-period save", async () => {
  vi.useFakeTimers();
  const put = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockResolvedValue({ version: 5 });
  const queue = new SaveQueue(entry, commit, () => {}, put);
  const read = vi.fn(() => ({ localRevision: 1, markdown: "serialized once" }));
  queue.bindContentProvider(read);
  queue.markContentDirty(1);
  await vi.advanceTimersByTimeAsync(800);
  expect(read).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledWith("article", 4, expect.objectContaining({ contentMd: "serialized once" }), "auto", expect.objectContaining({ localRevision: 1 }));
  queue.dispose();
});


it("keeps manual saves of an unedited document valid without a revision-zero recovery acknowledgement", async () => {
  const put = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockResolvedValue({ version: 5 });
  const queue = new SaveQueue(entry, commit, () => {}, put);
  expect(await queue.flush({ manual: true })).toBe(true);
  expect(commit).toHaveBeenCalledExactlyOnceWith("article", 4, expect.anything(), "manual");
  expect(put).not.toHaveBeenCalled();
  queue.dispose();
});
