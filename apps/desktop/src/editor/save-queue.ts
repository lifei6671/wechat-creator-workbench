import type { AppError, Entry, EntryFields, SaveMode, SaveResult } from "../../../../packages/shared-types";

type Commit = (id: string, version: number, fields: EntryFields, mode: SaveMode) => Promise<SaveResult>;

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
  private inFlight: Promise<boolean> | undefined;
  private manual = false;

  constructor(
    readonly entry: Entry,
    private readonly commit: Commit,
    private readonly onCommit: () => void,
  ) {
    const { title, contentMd, status, categoryId, coverAssetId, themeId, tags, summary, source, publishedAt, publishedUrl } = entry;
    this.state = {
      fields: { title, contentMd, status, categoryId, coverAssetId, themeId, tags, summary, source, publishedAt, publishedUrl },
      version: entry.version, revision: 0, savedRevision: 0, saving: false, error: null,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.state;

  private update(change: Partial<SaveSnapshot>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  edit(change: Partial<EntryFields>) {
    this.update({ fields: { ...this.state.fields, ...change }, revision: this.state.revision + 1 });
    clearTimeout(this.timer);
    if (!this.state.error) this.timer = setTimeout(() => { void this.flush(); }, 750);
  }

  flush(options: { manual?: boolean; retry?: boolean } = {}): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.state.error) {
      if (!options.retry || isConflict(this.state.error)) return Promise.resolve(false);
      this.update({ error: null });
    }
    this.manual ||= options.manual === true;
    if (!this.inFlight && (this.manual || this.state.revision !== this.state.savedRevision)) {
      this.inFlight = this.drain().finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight ?? Promise.resolve(true);
  }

  private async drain() {
    this.update({ saving: true });
    let committed = false;
    try {
      while (this.manual || this.state.revision !== this.state.savedRevision) {
        const { fields, version, revision } = this.state;
        const mode = this.manual ? "manual" : "auto";
        this.manual = false;
        const { version: committedVersion } = await this.commit(this.entry.id, version, fields, mode).catch(error => {
          this.manual ||= mode === "manual";
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
      this.update({ saving: false });
      if (committed) this.onCommit();
    }
  }

  categoryMoved(categoryId: string | null, version: number) {
    if (this.state.version + 1 === version) {
      this.update({ fields: { ...this.state.fields, categoryId }, version });
    }
  }

  dispose() { clearTimeout(this.timer); }
}
