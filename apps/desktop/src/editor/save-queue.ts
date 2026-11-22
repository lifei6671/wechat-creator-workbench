import type { AppError, Entry, EntryFields, SaveMode, SaveResult } from "../../../../packages/shared-types";
import type { MarkdownSnapshot } from "../../../../packages/editor-react";

type Commit = (id: string, version: number, fields: EntryFields, mode: SaveMode) => Promise<SaveResult>;
type SaveOptions = { manual?: boolean; retry?: boolean; aiReplace?: boolean };
const SAVE_DELAY_MS = 750;
const MAX_SAVE_DELAY_MS = 4000;

export interface SaveSnapshot {
  fields: EntryFields;
  version: number;
  revision: number;
  savedRevision: number;
  saving: boolean;
  error: unknown;
}

export function isConflict(error: unknown): error is AppError {
  return typeof error === "object" && error !== null && "code" in error && error.code === "VERSION_CONFLICT";
}

let sessionSequence = 0;

export class SaveQueue {
  readonly sessionId = ++sessionSequence;
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

  constructor(
    readonly entry: Entry,
    private readonly commit: Commit,
    private readonly onCommit: () => void,
  ) {
    const { title, contentMd, status, categoryId, coverAssetId, themeId, tags, summary, source, publishedAt, publishedUrl, publicationPlatforms, customProperties, wechatPublication } = entry;
    this.state = {
      fields: { title, contentMd, status, categoryId, coverAssetId, themeId, tags, summary, source, publishedAt, publishedUrl, publicationPlatforms, customProperties, wechatPublication },
      version: entry.version, revision: 0, savedRevision: 0, saving: false, error: null,
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
  saveError = () => this.state.error;

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
    const content = this.contentProvider?.();
    if (content?.localRevision !== this.pendingContentRevision) throw new Error("无法读取当前正文修订");
    return { ...snapshot, fields: { ...snapshot.fields, contentMd: content.markdown } };
  }

  private update(change: Partial<SaveSnapshot>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  edit(change: Partial<EntryFields>) {
    if (change.contentMd !== undefined) this.pendingContentRevision = undefined;
    this.change({ ...this.state.fields, ...change });
  }

  private change(fields = this.state.fields) {
    this.update({ fields, revision: this.state.revision + 1 });
    clearTimeout(this.timer);
    if (!this.state.error) {
      const now = Date.now();
      this.saveDeadline ??= now + MAX_SAVE_DELAY_MS;
      this.timer = setTimeout(() => { void this.requestSave(); }, Math.min(SAVE_DELAY_MS, this.saveDeadline - now));
    }
  }

  flush(options: SaveOptions = {}): Promise<boolean> {
    return this.requestSave(options);
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
        const { version: committedVersion } = await this.commit(this.entry.id, version, fields, mode).catch(error => {
          this.manual ||= mode === "manual";
          this.aiReplace ||= mode === "ai_replace";
          throw error;
        });
        committed = true;
        this.update({ version: committedVersion, savedRevision: revision });
      }
      return true;
    } catch (error) {
      this.update({ error });
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
    this.contentProvider = undefined;
    this.pendingContentRevision = undefined;
    this.listeners.clear();
  }
}
