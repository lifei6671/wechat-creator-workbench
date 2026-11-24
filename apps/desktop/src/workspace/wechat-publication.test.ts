import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Entry, WechatRecommendation } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { SaveQueue } from "../editor/save-queue";
import { emptyPublication, recommendationFingerprint, WechatPublishing } from "./wechat-publication";

const article: Entry = { id: "current", kind: "article", title: "向量检索", contentMd: "当前正文", status: "draft", categoryId: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", createdAt: 1, updatedAt: 1, deletedAt: null, version: 1, links: [] };
const item = (id: string): WechatRecommendation => ({ entryId: id, title: id, url: `https://mp.weixin.qq.com/s/${id}` });
let publishing: WechatPublishing;
let queue: SaveQueue;
let commit: ReturnType<typeof vi.fn<ConstructorParameters<typeof SaveQueue>[1]>>;
beforeEach(() => {
  publishing = new WechatPublishing();
  commit = vi.fn(async () => ({ version: 2, updatedAt: 1 }));
  queue = new SaveQueue(article, commit, () => {});
  vi.spyOn(desktop, "wechatPublicationDefaults").mockResolvedValue({ schemaVersion: 1, recommendationCount: 5, recommendationAuthors: [], version: 0, updatedAt: 0 });
  vi.spyOn(desktop, "wechatRecommendations").mockImplementation(async input => ({ inputFingerprint: await recommendationFingerprint(input), items: [item("auto")] }));
  vi.spyOn(desktop, "resolveWechatRecommendations").mockImplementation(async (_input, items) => ({ items, invalid: [] }));
});
afterEach(() => { publishing.dispose(); queue.dispose(); vi.restoreAllMocks(); });

it("saves multiple exact authors and a focused author draft before the save barrier", async () => {
  await publishing.defaults.load();
  const save = vi.spyOn(desktop, "saveWechatPublicationDefaults").mockImplementation(async (version, count, authors) => ({
    schemaVersion: 1, recommendationCount: count, recommendationAuthors: authors, version: version + 1, updatedAt: 1,
  }));
  publishing.defaults.editAuthors(["Alice", "alice"]);
  publishing.defaults.editAuthorDraft(" 王林 ");
  expect(await publishing.flush()).toBe(true);
  expect(save).toHaveBeenLastCalledWith(0, 5, ["Alice", "alice", "王林"]);
  expect(publishing.session(queue).input().authors).toEqual(["Alice", "alice", "王林"]);
  expect(publishing.defaults.snapshot().authorDraft).toBe("");
  publishing.defaults.editAuthors([]);
  await publishing.flush();
  expect(publishing.session(queue).input().authors).toEqual([]);
});

it("caches author options across focus and reloads only after a source revision changes", async () => {
  const fetch = vi.spyOn(desktop, "wechatRecommendationAuthors").mockResolvedValue(["李飞", "张明"]);
  await publishing.defaults.loadAuthors(0);
  publishing.defaults.editAuthorDraft("李");
  await publishing.defaults.loadAuthors(0);
  expect(fetch).toHaveBeenCalledOnce();
  expect(publishing.defaults.snapshot().authorOptions).toEqual(["李飞", "张明"]);
  fetch.mockResolvedValue(["李飞"]);
  await publishing.defaults.loadAuthors(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(publishing.defaults.snapshot().authorOptions).toEqual(["李飞"]);
});

it.each([false, true])("ignores an older author request after the latest revision loads, failure=%s", async failure => {
  let finish!: (authors: string[]) => void;
  let reject!: (error: Error) => void;
  const fetch = vi.spyOn(desktop, "wechatRecommendationAuthors")
    .mockReturnValueOnce(new Promise((resolve, fail) => { finish = resolve; reject = fail; }))
    .mockResolvedValueOnce(["新作者"]);
  const older = publishing.defaults.loadAuthors(1);
  await publishing.defaults.loadAuthors(2);
  if (failure) reject(new Error("旧请求失败")); else finish(["旧作者"]);
  await older;
  expect(publishing.defaults.snapshot().authorOptions).toEqual(["新作者"]);
  expect(publishing.defaults.snapshot().authorsError).toBe("");
  await publishing.defaults.loadAuthors(2);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not generate on opening, refreshing, saving or copying an unconfigured article", async () => {
  const session = publishing.session(queue);
  await session.refresh();
  expect(session.snapshot().ready).toBe(true);
  expect(queue.capture().fields.wechatPublication).toBeUndefined();
  expect(await session.prepare()).toEqual([]);
  await session.change(current => ({ ...current, recommendations: { ...current.recommendations, enabled: false } }));
  await session.change(current => ({ ...current, recommendations: { ...current.recommendations, enabled: true } }));
  queue.edit({ contentMd: "继续输入" });
  await session.refresh();
  expect(queue.isDirty()).toBe(true);
  expect(desktop.wechatRecommendations).not.toHaveBeenCalled();
});

it("discards a requested generation when its article closes", async () => {
  let finish!: (value: { inputFingerprint: string; items: WechatRecommendation[] }) => void;
  vi.mocked(desktop.wechatRecommendations).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = publishing.session(queue).ensure(true);
  const rejected = expect(pending).rejects.toThrow("文章已关闭");
  await vi.waitFor(() => expect(desktop.wechatRecommendations).toHaveBeenCalledOnce());
  publishing.dispose();
  finish({ inputFingerprint: "a".repeat(64), items: [item("stale")] });
  await rejected;
  expect(desktop.resolveWechatRecommendations).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});

it("preserves generated recommendations when the body or default count changes", async () => {
  const session = publishing.session(queue);
  await session.ensure(true);
  const previous = queue.capture().fields.wechatPublication;
  queue.edit({ contentMd: "刚保存的新正文" });
  await queue.flush();
  commit.mockClear();
  await session.refresh();
  session.editCount("9");
  await session.flush();
  await session.refresh();
  expect(queue.capture().fields.wechatPublication?.recommendations.items).toEqual(previous?.recommendations.items);
  expect(desktop.wechatRecommendations).toHaveBeenCalledOnce();
  queue.edit({ contentMd: "还在输入的正文" });
  commit.mockClear();
  await session.refresh();
  expect(commit).not.toHaveBeenCalled();
  expect(queue.isDirty()).toBe(true);
});

it("waits for a background refresh then checks the latest draft before copying", async () => {
  const session = publishing.session(queue);
  await session.change(current => ({ ...current, recommendations: { ...current.recommendations, items: [item("manual")] } }), true);
  const resolve = vi.mocked(desktop.resolveWechatRecommendations);
  resolve.mockClear();
  let finish!: (value: { items: WechatRecommendation[]; invalid: [] }) => void;
  resolve.mockReturnValueOnce(new Promise(done => { finish = done; })).mockResolvedValueOnce({ items: [], invalid: [{ entryId: "manual", message: "文章已删除" }] });
  const refresh = session.refresh();
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  queue.edit({ contentMd: "复制前刚刚输入的正文" });
  const prepare = session.prepare();
  const rejected = expect(prepare).rejects.toThrow("推荐文章已失效");
  finish({ items: [item("manual")], invalid: [] });
  await refresh;
  await rejected;
  expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ contentMd: "复制前刚刚输入的正文" }), [item("manual")]);
  expect(queue.isDirty()).toBe(false);
});

it("keeps a deliberately empty manual list through body edits and prepares without changing the body", async () => {
  const session = publishing.session(queue);
  await session.ensure(true);
  await session.change(current => ({ ...current, recommendations: { ...current.recommendations, items: [] } }), true);
  queue.edit({ contentMd: "改后的正文" });
  expect(await session.prepare()).toEqual([]);
  expect(desktop.wechatRecommendations).toHaveBeenCalledOnce();
  expect(queue.capture().fields.contentMd).toBe("改后的正文");
  expect(queue.capture().fields.wechatPublication?.recommendations.mode).toBe("manual");
});

it("discards stale generation when a manual edit arrives and preserves more than five items", async () => {
  const session = publishing.session(queue);
  let finish!: (value: { inputFingerprint: string; items: WechatRecommendation[] }) => void;
  vi.mocked(desktop.wechatRecommendations).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = session.ensure(true);
  await vi.waitFor(() => expect(desktop.wechatRecommendations).toHaveBeenCalledOnce());
  const manual = Array.from({ length: 7 }, (_, index) => item(`manual-${index}`));
  const changed = session.change(() => ({ ...emptyPublication(), recommendations: { ...emptyPublication().recommendations, items: manual } }), true);
  finish({ inputFingerprint: await recommendationFingerprint(session.input()), items: [item("stale")] });
  await Promise.all([pending, changed]);
  expect(await session.prepare()).toEqual(manual);
  expect(queue.capture().fields.wechatPublication?.recommendations.items).toEqual(manual);
});

it("waits for pending generation and focused count edits before the backup barrier resolves", async () => {
  const session = publishing.session(queue);
  let finish!: (value: { inputFingerprint: string; items: WechatRecommendation[] }) => void;
  vi.mocked(desktop.wechatRecommendations).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = session.ensure(true);
  await vi.waitFor(() => expect(desktop.wechatRecommendations).toHaveBeenCalledOnce());
  let flushed = false;
  const barrier = publishing.flush().then(result => { flushed = true; return result; });
  await Promise.resolve(); expect(flushed).toBe(false);
  finish({ inputFingerprint: await recommendationFingerprint(session.input()), items: [item("saved")] });
  expect(await barrier).toBe(true); await pending;
  expect(commit).toHaveBeenLastCalledWith("current", 1, expect.objectContaining({ wechatPublication: expect.objectContaining({ recommendations: expect.objectContaining({ items: [item("saved")] }) }) }), "auto");
  session.editCount("8");
  expect(await publishing.flush()).toBe(true);
  expect(queue.capture().fields.wechatPublication?.recommendations.countOverride).toBe(8);
});

it("cancels a queued regenerate when a later manual change arrives", async () => {
  const session = publishing.session(queue);
  let finish!: (value: { inputFingerprint: string; items: WechatRecommendation[] }) => void;
  vi.mocked(desktop.wechatRecommendations).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = session.ensure(true);
  await vi.waitFor(() => expect(desktop.wechatRecommendations).toHaveBeenCalledOnce());
  const regeneration = session.regenerate();
  await Promise.resolve(); await Promise.resolve();
  const changed = session.change(() => ({ ...emptyPublication(), recommendations: { ...emptyPublication().recommendations, items: [item("later-manual")] } }), true);
  finish({ inputFingerprint: await recommendationFingerprint(session.input()), items: [item("stale")] });
  await Promise.all([pending, changed]);
  expect(await regeneration).toBe(false);
  expect(await session.prepare()).toEqual([item("later-manual")]);
});

it("retains invalid input or persistence failures and blocks the save barrier", async () => {
  const session = publishing.session(queue);
  session.editCount("0");
  expect(await publishing.flush()).toBe(false);
  expect(session.snapshot().countDraft).toBe("0");
  session.editCount("6"); commit.mockRejectedValue(new Error("磁盘写入失败"));
  expect(await publishing.flush()).toBe(false);
  expect(queue.capture().fields.wechatPublication?.recommendations.countOverride).toBe(6);
  expect(session.snapshot().error).toContain("磁盘写入失败");
});

it("regenerates with undo and refuses to publish a removed reference", async () => {
  const session = publishing.session(queue);
  await session.change(() => ({ ...emptyPublication(), recommendations: { ...emptyPublication().recommendations, items: [item("manual")] } }), true);
  expect(await session.regenerate()).toBe(true);
  expect(await session.prepare()).toEqual([item("auto")]);
  expect(await session.undo()).toBe(true);
  expect(await session.prepare()).toEqual([item("manual")]);
  vi.mocked(desktop.resolveWechatRecommendations).mockResolvedValue({ items: [], invalid: [{ entryId: "manual", message: "文章已移入回收站" }] });
  await expect(session.prepare()).rejects.toThrow("推荐文章已失效");
});

it("does not let an older refresh replace a freshly saved global default", async () => {
  await publishing.defaults.load();
  let finish!: (value: { schemaVersion: 1; recommendationCount: number; recommendationAuthors: string[]; version: number; updatedAt: number }) => void;
  vi.mocked(desktop.wechatPublicationDefaults).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const refresh = publishing.defaults.load(true);
  vi.spyOn(desktop, "saveWechatPublicationDefaults").mockResolvedValue({ schemaVersion: 1, recommendationCount: 9, recommendationAuthors: [], version: 1, updatedAt: 2 });
  publishing.defaults.edit("9");
  // Complete the older request while the focused edit is still pending.
  finish({ schemaVersion: 1, recommendationCount: 5, recommendationAuthors: [], version: 0, updatedAt: 0 }); await refresh;
  expect(await publishing.flush()).toBe(true);
  expect(publishing.defaults.snapshot().value?.recommendationCount).toBe(9);
  expect(publishing.defaults.snapshot().draft).toBe("9");
});
