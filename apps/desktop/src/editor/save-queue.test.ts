import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entry, SaveResult } from "../../../../packages/shared-types";
import { SaveQueue } from "./save-queue";

const entry: Entry = {
  id: "article", kind: "article", title: "", contentMd: "", status: "draft", categoryId: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 4,
  updatedAt: 0, deletedAt: null, links: [],
};

function pending() {
  let resolve!: (value: SaveResult) => void;
  const promise = new Promise<SaveResult>(resolveWith => { resolve = resolveWith; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

describe("SaveQueue", () => {
  it("debounces typing and only commits the latest draft", async () => {
    vi.useFakeTimers();
    const commit = vi.fn().mockResolvedValue({ version: 5 });
    const queue = new SaveQueue(entry, commit, () => {});
    queue.edit({ contentMd: "开" });
    await vi.advanceTimersByTimeAsync(500);
    queue.edit({ contentMd: "开头" });
    await vi.advanceTimersByTimeAsync(500);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("article", 4, expect.objectContaining({ contentMd: "开头" }), "auto");
    expect(queue.snapshot()).toMatchObject({ revision: 2, savedRevision: 2, saving: false });
  });

  it("waits for the in-flight save and uses its version without overwriting newer text", async () => {
    const first = pending();
    const second = pending();
    const commit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const queue = new SaveQueue(entry, commit, () => {});
    queue.edit({ contentMd: "第一稿" });
    const blur = queue.flush();
    queue.edit({ contentMd: "第二稿" });
    queue.edit({ contentMd: "最后一稿" });
    const close = queue.flush({ manual: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(close).toBe(blur);
    first.resolve({ version: 5 });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit).toHaveBeenNthCalledWith(2, "article", 5, expect.objectContaining({ contentMd: "最后一稿" }), "manual");
    expect(queue.snapshot()).toMatchObject({ fields: { contentMd: "最后一稿" }, revision: 3, savedRevision: 1, saving: true });
    second.resolve({ version: 6 });
    expect(await close).toBe(true);
    expect(queue.snapshot()).toMatchObject({ version: 6, savedRevision: 3, saving: false });
  });

  it("keeps the buffer on conflict and does not retry a stale version", async () => {
    const conflict = { code: "VERSION_CONFLICT", currentVersion: 7, message: "内容已有新版本" };
    const commit = vi.fn().mockRejectedValue(conflict);
    const queue = new SaveQueue(entry, commit, () => {});
    queue.edit({ contentMd: "尚未提交" });
    expect(await queue.flush()).toBe(false);
    queue.edit({ contentMd: "继续编辑后的稿" });
    expect(await queue.flush({ retry: true })).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(queue.snapshot()).toMatchObject({ fields: { contentMd: "继续编辑后的稿" }, savedRevision: 0, error: conflict });
  });

  it("leaves a failed manual save available for an explicit retry", async () => {
    const commit = vi.fn().mockRejectedValueOnce({ code: "DATABASE" }).mockResolvedValueOnce({ version: 5 });
    const queue = new SaveQueue(entry, commit, () => {});
    expect(await queue.flush({ manual: true })).toBe(false);
    expect(await queue.flush()).toBe(false);
    expect(await queue.flush({ retry: true })).toBe(true);
    expect(commit.mock.calls.map(call => call[3])).toEqual(["manual", "manual"]);
  });
});
