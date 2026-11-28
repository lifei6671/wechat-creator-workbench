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
  it("publishes an atomic image replacement only after the native commit and acknowledges its revision", async () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const changed = vi.fn();
    const queue = new SaveQueue(entry, commit, changed);
    let localRevision = 0, markdown = "";
    queue.bindContentProvider(() => ({ localRevision, markdown }));
    const native = pending();
    const installed = vi.fn(() => { markdown = "![结果](asset://result)"; queue.markContentDirty(++localRevision); });
    const cancelled = vi.fn();
    const save = vi.fn().mockReturnValue(native.promise);
    const applying = queue.applyExternalContent(() => ({ markdown: "![结果](asset://result)", commit: installed, cancel: cancelled }), save);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(4, expect.objectContaining({ contentMd: "![结果](asset://result)" }), expect.objectContaining({ localRevision: 1 }));
    expect(installed).not.toHaveBeenCalled();
    expect(queue.isSaving()).toBe(true);
    const barrier = queue.flush();
    native.resolve({ version: 5 });
    await applying;
    expect(await barrier).toBe(true);
    expect(installed).toHaveBeenCalledOnce();
    expect(queue.snapshot()).toMatchObject({ version: 5, revision: 1, savedRevision: 1, fields: { contentMd: "![结果](asset://result)" } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(commit).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    queue.dispose();
  });

  it("keeps the original document when an atomic native image commit fails", async () => {
    const queue = new SaveQueue(entry, vi.fn(), () => {});
    const install = vi.fn(), cancel = vi.fn();
    const failure = { code: "VERSION_CONFLICT", message: "内容已有新版本" };
    await expect(queue.applyExternalContent(() => ({ markdown: "结果", commit: install, cancel }), () => Promise.reject(failure))).rejects.toBe(failure);
    expect(install).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(queue.snapshot()).toMatchObject({ version: 4, fields: { contentMd: "" }, error: failure, saving: false });
    queue.dispose();
  });

  it("blocks stale autosave if the native receipt commits but the editor cannot acknowledge it", async () => {
    const commit = vi.fn();
    const queue = new SaveQueue(entry, commit, () => {});
    await expect(queue.applyExternalContent(() => ({ markdown: "结果", commit() { throw new Error("编辑器已卸载"); }, cancel() {} }),
      async () => ({ version: 5 }))).rejects.toThrow("编辑器已卸载");
    expect(queue.snapshot()).toMatchObject({ version: 5, error: { code: "VERSION_CONFLICT" } });
    expect(await queue.flush({ retry: true })).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("captures the newest editor revision once per commit and includes concurrent metadata", async () => {
    const first = pending();
    const commit = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ version: 6 });
    const queue = new SaveQueue(entry, commit, () => {});
    let localRevision = 0;
    const read = vi.fn(() => ({ localRevision, markdown: `正文 ${localRevision}` }));
    const unbind = queue.bindContentProvider(read);
    for (let i = 0; i < 200; i++) queue.markContentDirty(++localRevision);
    expect(read).not.toHaveBeenCalled();
    expect(queue.snapshot().fields.contentMd).toBe("");
    const saved = queue.flush();
    queue.edit({ title: "新标题", categoryId: "folder" });
    queue.markContentDirty(++localRevision);
    expect(commit).toHaveBeenCalledExactlyOnceWith("article", 4, expect.objectContaining({ contentMd: "正文 200", title: "" }), "auto");
    first.resolve({ version: 5 });
    expect(await saved).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith("article", 5, expect.objectContaining({ contentMd: "正文 201", title: "新标题", categoryId: "folder" }), "auto");
    expect(queue.snapshot()).toMatchObject({ revision: 202, savedRevision: 202, version: 6 });
    unbind();
    queue.dispose();
  });

  it("bounds the delay while typing and can save the final snapshot after the editor detaches", async () => {
    vi.useFakeTimers();
    const commit = vi.fn().mockResolvedValueOnce({ version: 5 }).mockResolvedValueOnce({ version: 6 });
    const queue = new SaveQueue(entry, commit, () => {});
    let localRevision = 0;
    const read = vi.fn(() => ({ localRevision, markdown: `正文 ${localRevision}` }));
    const unbind = queue.bindContentProvider(read);
    for (let i = 0; i < 8; i++) {
      queue.markContentDirty(++localRevision);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(commit).toHaveBeenCalledExactlyOnceWith("article", 4, expect.objectContaining({ contentMd: "正文 8" }), "auto");
    queue.markContentDirty(++localRevision);
    expect(queue.capture().fields.contentMd).toBe("正文 9");
    expect(queue.snapshot().fields.contentMd).toBe("正文 8");
    unbind();
    expect(await queue.flush()).toBe(true);
    expect(commit).toHaveBeenLastCalledWith("article", 5, expect.objectContaining({ contentMd: "正文 9" }), "auto");
    queue.dispose();
  });

  it("coalesces new input during an automatic save until the next debounce interval", async () => {
    vi.useFakeTimers();
    const first = pending();
    const commit = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ version: 6 });
    const queue = new SaveQueue(entry, commit, () => {});
    queue.edit({ contentMd: "一" });
    await vi.advanceTimersByTimeAsync(750);
    queue.edit({ contentMd: "二" });
    await vi.advanceTimersByTimeAsync(100);
    first.resolve({ version: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(queue.snapshot()).toMatchObject({ revision: 2, savedRevision: 1 });
    queue.edit({ contentMd: "三" });
    await vi.advanceTimersByTimeAsync(749);
    expect(commit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(commit).toHaveBeenLastCalledWith("article", 5, expect.objectContaining({ contentMd: "三" }), "auto");
    expect(queue.snapshot()).toMatchObject({ revision: 3, savedRevision: 3 });
    queue.dispose();
  });

  it("flushes the latest edits when closing at the end of an automatic save", async () => {
    vi.useFakeTimers();
    const first = pending();
    const commit = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ version: 6 });
    const queue = new SaveQueue(entry, commit, () => {});
    queue.edit({ contentMd: "已开始写入" });
    await vi.advanceTimersByTimeAsync(750);
    queue.edit({ contentMd: "关闭前的最后一稿" });
    let closing: Promise<boolean> | undefined;
    const unsubscribe = queue.subscribe(() => {
      if (queue.isSaving() || !queue.isDirty()) return;
      unsubscribe();
      closing = queue.flush();
    });
    first.resolve({ version: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await closing).toBe(true);
    expect(commit).toHaveBeenLastCalledWith("article", 5, expect.objectContaining({ contentMd: "关闭前的最后一稿" }), "auto");
    expect(queue.snapshot()).toMatchObject({ revision: 2, savedRevision: 2, version: 6 });
    queue.dispose();
  });

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
