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
  vi.spyOn(desktop, "wechatPublicationDefaults").mockResolvedValue({ schemaVersion: 1, recommendationCount: 5, version: 0, updatedAt: 0 });
  vi.spyOn(desktop, "wechatRecommendations").mockImplementation(async input => ({ inputFingerprint: await recommendationFingerprint(input), items: [item("auto")] }));
  vi.spyOn(desktop, "resolveWechatRecommendations").mockImplementation(async (_input, items) => ({ items, invalid: [] }));
});
afterEach(() => { publishing.dispose(); queue.dispose(); vi.restoreAllMocks(); });

it("keeps a deliberately empty manual list through body edits and prepares without changing the body", async () => {
  const session = publishing.session(queue);
  await session.ensure();
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
  const pending = session.ensure();
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
  const pending = session.ensure();
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
  const pending = session.ensure();
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
  let finish!: (value: { schemaVersion: 1; recommendationCount: number; version: number; updatedAt: number }) => void;
  vi.mocked(desktop.wechatPublicationDefaults).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const refresh = publishing.defaults.load(true);
  vi.spyOn(desktop, "saveWechatPublicationDefaults").mockResolvedValue({ schemaVersion: 1, recommendationCount: 9, version: 1, updatedAt: 2 });
  publishing.defaults.edit("9");
  // Complete the older request while the focused edit is still pending.
  finish({ schemaVersion: 1, recommendationCount: 5, version: 0, updatedAt: 0 }); await refresh;
  expect(await publishing.flush()).toBe(true);
  expect(publishing.defaults.snapshot().value?.recommendationCount).toBe(9);
  expect(publishing.defaults.snapshot().draft).toBe("9");
});
