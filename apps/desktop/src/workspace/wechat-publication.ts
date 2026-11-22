import type { WechatPublication, WechatPublicationDefaults, WechatRecommendationInput, WechatResolvedRecommendations } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { SaveQueue } from "../editor/save-queue";

export function recommendationInput(queue: SaveQueue, defaultCount: number): WechatRecommendationInput {
  const fields = queue.capture().fields;
  return { entryId: queue.entry.id, title: fields.title, summary: fields.summary, tags: fields.tags,
    contentMd: fields.contentMd, categoryId: fields.categoryId, status: fields.status, publishedAt: fields.publishedAt,
    count: fields.wechatPublication?.recommendations.countOverride ?? defaultCount };
}

export async function recommendationFingerprint(input: WechatRecommendationInput) {
  const source = JSON.stringify([1, input.title, input.summary, input.tags, input.contentMd, input.categoryId, input.status, input.publishedAt, input.count]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function emptyPublication(): WechatPublication {
  return { schemaVersion: 1, recommendations: { enabled: true, mode: "auto", countOverride: null, inputFingerprint: null, items: [] } };
}

function countValue(value: string) {
  const count = Number(value);
  if (!value.trim() || !Number.isInteger(count) || count < 1 || count > 0xffffffff) throw new Error("请输入大于 0 的有效整数");
  return count;
}

export class PublicationDefaults {
  private listeners = new Set<() => void>();
  private state: { value: WechatPublicationDefaults | null; draft: string; error: string; saving: boolean } = {
    value: null, draft: "5", error: "", saving: false,
  };
  private revision = 0;
  private dirty = false;
  private loading?: Promise<void>;
  private pending?: Promise<boolean>;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  hasPendingEdits = () => this.dirty || this.state.saving;
  private update(change: Partial<typeof this.state>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener(); }
  edit(value: string) { this.dirty = true; this.revision++; this.update({ draft: value }); }

  async load(force = false) {
    if (this.loading) return this.loading;
    if (this.state.value && !force) return;
    const revision = this.revision;
    const previous = this.state.value;
    this.loading = desktop.wechatPublicationDefaults().then(value => {
      if (previous && (this.dirty || revision !== this.revision || this.state.value !== previous)) return;
      this.update({ value, ...(this.dirty || revision !== this.revision ? {} : { draft: String(value.recommendationCount), error: "" }) });
    }).catch(error => { this.update({ error: errorMessage(error) }); throw error; }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  async reload() {
    if (this.pending) await this.pending;
    this.dirty = false;
    this.revision++;
    await this.load(true);
  }

  flush(): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!this.dirty) return Promise.resolve(true);
    this.pending = this.save().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async save() {
    this.update({ saving: true });
    try {
      await this.load();
      while (this.dirty) {
        const revision = this.revision;
        const count = countValue(this.state.draft);
        if (count !== this.state.value!.recommendationCount) {
          const value = await desktop.saveWechatPublicationDefaults(this.state.value!.version, count);
          this.update({ value });
        }
        if (this.revision === revision) this.dirty = false;
      }
      this.update({ error: "" });
      return true;
    } catch (error) { this.update({ error: errorMessage(error) }); return false; }
    finally { this.update({ saving: false }); }
  }
}

interface PublicationSnapshot {
  resolved: WechatResolvedRecommendations;
  loading: boolean;
  ready: boolean;
  error: string;
  countDraft: string | null;
  undo: WechatPublication | null;
}

export class PublicationSession {
  private listeners = new Set<() => void>();
  private state: PublicationSnapshot = { resolved: { items: [], invalid: [] }, loading: false, ready: false, error: "", countDraft: null, undo: null };
  private pending?: Promise<WechatResolvedRecommendations>;
  private refreshRequested = false;
  private manualRevision = 0;
  private disposed = false;
  constructor(readonly queue: SaveQueue, readonly defaults: PublicationDefaults) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(change: Partial<PublicationSnapshot>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener(); }
  config = () => this.queue.snapshot().fields.wechatPublication ?? emptyPublication();
  input = () => recommendationInput(this.queue, this.defaults.snapshot().value?.recommendationCount ?? 5);
  editCount(value: string) { this.update({ countDraft: value }); }

  commitCount() {
    if (this.state.countDraft === null) return;
    const count = countValue(this.state.countDraft);
    const current = this.config();
    if (count !== this.input().count) this.queue.edit({ wechatPublication: { ...current, recommendations: { ...current.recommendations, countOverride: count } } });
    this.update({ countDraft: null, error: "" });
  }

  async flush() {
    try {
      this.commitCount();
      const [saved, defaults] = await Promise.all([this.queue.flush({ retry: true }), this.defaults.flush()]);
      if (!saved) throw this.queue.saveError();
      if (!defaults) throw new Error(this.defaults.snapshot().error);
      this.update({ error: "" });
      return true;
    } catch (error) { this.update({ error: errorMessage(error) }); return false; }
  }

  async change(update: (current: WechatPublication) => WechatPublication, manual = false) {
    const value = update(this.config());
    if (manual) { this.manualRevision++; value.recommendations = { ...value.recommendations, mode: "manual" }; }
    this.queue.edit({ wechatPublication: value });
    this.update({ undo: null, error: "", ready: false });
    if (!await this.flush()) return false;
    try { await this.ensure(); return true; } catch { return false; }
  }

  async regenerate() {
    const revision = this.manualRevision;
    if (!await this.flush()) return false;
    if (this.manualRevision !== revision) return false;
    const previous = this.config();
    try {
      await this.ensure(true);
      if (this.manualRevision !== revision || this.config().recommendations.mode !== "auto") { this.update({ error: "推荐已取消，当前修改已保留" }); return false; }
      this.update({ undo: previous }); return true;
    }
    catch { return false; }
  }

  async undo() {
    const previous = this.state.undo;
    if (!previous) return false;
    return this.change(() => previous);
  }

  ensure(force = false): Promise<WechatResolvedRecommendations> {
    if (this.pending) {
      this.refreshRequested = true;
      const revision = this.manualRevision;
      return force ? this.pending.then(() => this.ensure(this.manualRevision === revision)) : this.pending;
    }
    this.pending = this.resolve(force).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async resolve(force: boolean): Promise<WechatResolvedRecommendations> {
    this.update({ loading: true });
    try {
      await this.defaults.load();
      if (!await this.flush()) throw new Error(this.state.error);
      do {
        this.refreshRequested = false;
        if (this.disposed) throw new Error("文章已关闭");
        const input = this.input();
        const inputKey = JSON.stringify(input);
        const original = this.queue.snapshot().fields.wechatPublication;
        let config = original ?? emptyPublication();
        const fingerprint = await recommendationFingerprint(input);
        if (force || config.recommendations.mode === "auto" && config.recommendations.inputFingerprint !== fingerprint) {
          const generated = await desktop.wechatRecommendations(input);
          if (this.disposed) throw new Error("文章已关闭");
          if (JSON.stringify(this.input()) !== inputKey || this.queue.snapshot().fields.wechatPublication !== original) { force = false; this.refreshRequested = true; continue; }
          config = { ...config, recommendations: { ...config.recommendations, mode: "auto", inputFingerprint: generated.inputFingerprint, items: generated.items } };
          this.queue.edit({ wechatPublication: config });
          if (!await this.queue.flush({ retry: true })) throw this.queue.saveError();
          force = false;
        }
        const resolved = config.recommendations.enabled
          ? await desktop.resolveWechatRecommendations(input, config.recommendations.items) : { items: [], invalid: [] };
        if (this.disposed) throw new Error("文章已关闭");
        if (JSON.stringify(this.input()) !== inputKey || this.queue.snapshot().fields.wechatPublication !== config) { this.refreshRequested = true; continue; }
        this.update({ resolved, ready: true, error: "" });
      } while (this.refreshRequested);
      return this.state.resolved;
    } catch (error) { if (!this.disposed) this.update({ ready: false, error: errorMessage(error) }); throw error; }
    finally { if (!this.disposed) this.update({ loading: false }); }
  }

  async prepare() {
    const resolved = await this.ensure();
    if (resolved.invalid.length) throw new Error("推荐文章已失效，请在公众号侧栏修正或移除后重试");
    return resolved.items;
  }

  async settle() {
    if (this.pending) {
      try { await this.pending; } catch { return false; }
    }
    return this.flush();
  }

  dispose() { this.disposed = true; this.listeners.clear(); }
}

export class WechatPublishing {
  readonly defaults = new PublicationDefaults();
  private sessions = new Map<SaveQueue, PublicationSession>();
  session(queue: SaveQueue) {
    let session = this.sessions.get(queue);
    if (!session) { session = new PublicationSession(queue, this.defaults); this.sessions.set(queue, session); }
    return session;
  }
  release(queue: SaveQueue) { this.sessions.get(queue)?.dispose(); this.sessions.delete(queue); }
  async flushQueue(queue: SaveQueue) {
    const session = this.sessions.get(queue);
    return (!session || await session.settle()) && await this.defaults.flush();
  }
  needsFlush(queue?: SaveQueue) {
    const session = queue && this.sessions.get(queue);
    return this.defaults.hasPendingEdits() || Boolean(session && (session.snapshot().countDraft !== null || queue!.isDirty() || queue!.isSaving()));
  }
  async flush() {
    const results = await Promise.all([...this.sessions.values()].map(session => session.settle()));
    return results.every(Boolean) && await this.defaults.flush();
  }
  dispose() { for (const session of this.sessions.values()) session.dispose(); this.sessions.clear(); }
}
