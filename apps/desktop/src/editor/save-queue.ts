import type { AppError, Entry, EntryFields, SaveMode, SaveResult, RecoveryCommit, RecoveryDraft } from "../../../../packages/shared-types";
import type { MarkdownSnapshot, PreparedImageReplacement } from "../../../../packages/editor-react";

type Commit = (id: string, version: number, fields: EntryFields, mode: SaveMode, recovery?: RecoveryCommit) => Promise<SaveResult>;
type SaveOptions = { manual?: boolean; retry?: boolean; aiReplace?: boolean };
const SAVE_DELAY_MS = 750;
const MAX_SAVE_DELAY_MS = 4000;

export interface SaveSnapshot {
  fields: EntryFields;
  version: number;
  revision: number;
  savedRevision: number;
  saving: boolean;
  processingImages: boolean;
  error: unknown;
  recoveryError: unknown;
}

export function isConflict(error: unknown): error is AppError {
  return typeof error === "object" && error !== null && "code" in error && error.code === "VERSION_CONFLICT";
}

let sessionSequence = 0;

export class SaveQueue {
  readonly sessionId = ++sessionSequence;
  private readonly recoverySessionId = crypto.randomUUID();
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private captured?: { revision: number; fields: EntryFields };
  private listeners = new Set<() => void>();
  private state: SaveSnapshot;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveDeadline?: number;
  private contentProvider?: () => MarkdownSnapshot;
  private pendingContentRevision?: number;
  private inFlight: Promise<boolean> | undefined;
  private manual = false;
  private aiReplace = false;
  private drainToLatest = false;
  private saveRequested = false;
  private externalCommit = false;

  constructor(
    readonly entry: Entry,
    private readonly commit: Commit,
    private readonly onCommit: () => void,
    private readonly persistRecovery?: (draft: RecoveryDraft) => Promise<void>,
  ) {
    const { title, contentMd, status, categoryId, coverAssetId, themeId, tags, summary, source, publishedAt, publishedUrl, publicationPlatforms, customProperties, wechatPublication } = entry;
    this.state = {
      fields: { title, contentMd, status, categoryId, coverAssetId, themeId, tags, summary, source, publishedAt, publishedUrl, publicationPlatforms, customProperties, wechatPublication },
      version: entry.version, revision: 0, savedRevision: 0, saving: false, processingImages: false, error: null, recoveryError: null,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.state;
  snapshotFields = () => this.state.fields;
  isDirty = () => this.state.revision !== this.state.savedRevision;
  isSaving = () => this.state.saving;
  isProcessingImages = () => this.state.processingImages;
  setProcessingImages = (processingImages: boolean) => {
    if (processingImages !== this.state.processingImages) this.update({ processingImages });
  };
  saveError = () => this.state.error ?? this.state.recoveryError;

  bindContentProvider(read: () => MarkdownSnapshot) {
    this.contentProvider = read;
    return () => {
      if (this.contentProvider !== read) return;
      const { fields } = this.capture();
      this.contentProvider = undefined;
      this.pendingContentRevision = undefined;
      if (fields !== this.state.fields) this.update({ fields });
    };
  }

  markContentDirty(localRevision: number) {
    this.pendingContentRevision = localRevision;
    this.change();
  }

  capture(): SaveSnapshot {
    const snapshot = this.state;
    if (this.pendingContentRevision === undefined) return snapshot;
    if (this.captured?.revision === snapshot.revision) return { ...snapshot, fields: this.captured.fields };
    const content = this.contentProvider?.();
    if (content?.localRevision !== this.pendingContentRevision) throw new Error("无法读取当前正文修订");
    const fields = { ...snapshot.fields, contentMd: content.markdown };
    this.captured = { revision: snapshot.revision, fields };
    return { ...snapshot, fields };
  }

  private update(change: Partial<SaveSnapshot>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  edit(change: Partial<EntryFields>) {
    if (this.externalCommit) throw new Error("正在应用图片，请稍后编辑内容属性");
    if (change.contentMd !== undefined) this.pendingContentRevision = undefined;
    this.change({ ...this.state.fields, ...change });
  }

  private change(fields = this.state.fields) {
    this.update({ fields, revision: this.state.revision + 1 });
    if (this.persistRecovery && this.recoveryTimer === undefined) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined;
        void this.writeRecovery();
      }, SAVE_DELAY_MS);
    }
    clearTimeout(this.timer);
    if (!this.state.error) {
      const now = Date.now();
      this.saveDeadline ??= now + MAX_SAVE_DELAY_MS;
      this.timer = setTimeout(() => { void this.requestSave(); }, Math.min(SAVE_DELAY_MS, this.saveDeadline - now));
    }
  }

  private async writeRecovery() {
    if (!this.persistRecovery || !this.isDirty()) return;
    let revision = this.state.revision;
    try {
      const snapshot = this.capture();
      revision = snapshot.revision;
      await this.persistRecovery({ entryId: this.entry.id, kind: this.entry.kind,
        sessionId: this.recoverySessionId, baseVersion: snapshot.version, localRevision: revision, fields: snapshot.fields });
      if (revision === this.state.revision) this.update({ recoveryError: null });
    } catch (recoveryError) {
      if (revision === this.state.revision && revision > this.state.savedRevision) this.update({ recoveryError });
    }
  }

  flush(options: SaveOptions = {}): Promise<boolean> {
    return this.requestSave(options);
  }

  async applyExternalContent(
    prepare: () => PreparedImageReplacement,
    commit: (version: number, fields: EntryFields, recovery: RecoveryCommit) => Promise<SaveResult>,
  ): Promise<void> {
    if (!await this.flush({ retry: true })) throw this.saveError();
    if (this.inFlight) throw new Error("正文正在保存，请稍后重试");
    const prepared = prepare();
    const { fields, version, revision } = this.capture();
    const nextFields = { ...fields, contentMd: prepared.markdown };
    this.externalCommit = true;
    this.update({ saving: true });
    let committed = false;
    const operation = Promise.resolve().then(async () => {
      const result = await commit(version, nextFields, { sessionId: this.recoverySessionId, localRevision: revision + 1 });
      committed = true;
      // Advance the confirmed version before publishing the prepared editor transaction.
      this.update({ version: result.version });
      prepared.commit();
      const installed = this.capture();
      if (installed.fields.contentMd !== prepared.markdown) throw new Error("正文应用确认失败，请重新打开文章");
      clearTimeout(this.timer);
      this.pendingContentRevision = undefined;
      this.captured = undefined;
      this.update({ fields: nextFields, savedRevision: this.state.revision, error: null, recoveryError: null });
      this.onCommit();
    }).catch(error => {
      if (committed) {
        // A committed native receipt is authoritative. Never save the stale editor over it.
        this.pendingContentRevision = undefined;
        this.captured = undefined;
        this.update({ fields: nextFields, savedRevision: this.state.revision,
          error: { code: "VERSION_CONFLICT", message: "图片已保存，请重新打开文章以读取最新正文" } });
      } else this.update({ error });
      throw error;
    }).finally(() => {
      prepared.cancel();
      this.externalCommit = false;
      this.inFlight = undefined;
      this.update({ saving: false });
    });
    this.inFlight = operation.then(() => true, () => false);
    await operation;
  }

  private requestSave(options?: SaveOptions): Promise<boolean> {
    clearTimeout(this.timer);
    this.saveDeadline = undefined;
    if (this.state.error) {
      if (!options?.retry || isConflict(this.state.error)) return Promise.resolve(false);
      this.update({ error: null });
    }
    this.manual ||= options?.manual === true;
    this.aiReplace ||= options?.aiReplace === true;
    if (!this.inFlight && !this.aiReplace && !this.manual && !this.isDirty()) return Promise.resolve(true);
    this.saveRequested = true;
    this.drainToLatest ||= options !== undefined;
    if (this.inFlight) return this.inFlight;
    let complete!: (saved: boolean) => void;
    let fail!: (error: unknown) => void;
    const saving = new Promise<boolean>((resolve, reject) => { complete = resolve; fail = reject; });
    this.inFlight = saving;
    void this.drain().then(complete, fail);
    return saving;
  }

  private async drain() {
    let committed = false;
    try {
      this.update({ saving: true });
      while ((this.saveRequested || this.drainToLatest) && (this.aiReplace || this.manual || this.isDirty())) {
        this.saveRequested = false;
        const { fields, version, revision } = this.capture();
        this.pendingContentRevision = undefined;
        if (fields !== this.state.fields) this.update({ fields });
        const mode = this.aiReplace ? "ai_replace" : this.manual ? "manual" : "auto";
        if (mode === "ai_replace") this.aiReplace = false;
        if (mode === "manual") this.manual = false;
        const saving = this.persistRecovery && revision > 0
          ? this.commit(this.entry.id, version, fields, mode, { sessionId: this.recoverySessionId, localRevision: revision })
          : this.commit(this.entry.id, version, fields, mode);
        const { version: committedVersion } = await saving.catch(error => {
          this.manual ||= mode === "manual";
          this.aiReplace ||= mode === "ai_replace";
          throw error;
        });
        committed = true;
        this.update({ version: committedVersion, savedRevision: revision, recoveryError: null });
      }
      return true;
    } catch (error) {
      this.update({ error });
      await this.writeRecovery();
      return false;
    } finally {
      this.drainToLatest = false;
      this.saveRequested = false;
      // An idle notification can immediately trigger an explicit save of the remaining edits.
      this.inFlight = undefined;
      this.update({ saving: false });
      if (committed) this.onCommit();
    }
  }

  categoryMoved(categoryId: string | null, version: number) {
    if (this.state.version + 1 === version) {
      this.update({ fields: { ...this.state.fields, categoryId }, version });
    }
  }

  dispose() {
    clearTimeout(this.timer);
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    // Capture while the editor provider is still bound; failed queues retain their last draft.
    void this.writeRecovery();
    this.contentProvider = undefined;
    this.pendingContentRevision = undefined;
    this.listeners.clear();
  }
}
