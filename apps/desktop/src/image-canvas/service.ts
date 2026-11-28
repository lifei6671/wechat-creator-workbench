import type { ImageCanvasAsset, ImageExportOptions, ImageProject, ImageRenderResult, ImageScene, PreparedImageRender } from "../../../../packages/shared-types";

export interface ImageCanvasService {
  saveProject(id: string, expectedVersion: number, scene: ImageScene): Promise<{ version: number }>;
  readAsset(id: string): Promise<ArrayBuffer>;
  infoAsset(id: string): Promise<ImageCanvasAsset>;
  readThumbnail(id: string): Promise<ArrayBuffer>;
  importImage(file: File): Promise<ImageCanvasAsset>;
  listAssets(page: number): Promise<{ items: ImageCanvasAsset[]; hasMore: boolean }>;
  prepareRender(projectId: string, version: number, renderId: string, options: ImageExportOptions, bytes: Uint8Array): Promise<PreparedImageRender>;
  commitRender(renderId: string): Promise<ImageRenderResult>;
  copyImage(src: string): Promise<void>;
  saveImage(src: string): Promise<boolean>;
}

export interface ImageCanvasHandle { flush(): Promise<void> }

/** Serializes each project and retains unsaved state when a write fails. */
export class ProjectSaveQueue {
  private version: number;
  private revision = 0;
  private savedRevision = 0;
  private desired: ImageScene;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private error: unknown;

  constructor(private project: ImageProject, private service: Pick<ImageCanvasService, "saveProject">,
    private onState: (state: "saved" | "pending" | "saving" | "error", error?: unknown) => void) {
    this.version = project.version;
    this.desired = project.scene;
  }

  set(scene: ImageScene) {
    if (this.desired === scene) return;
    this.desired = scene;
    this.revision += 1;
    clearTimeout(this.timer);
    this.onState("pending");
    if (!this.error) this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 450);
  }

  getVersion() { return this.version; }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.error = undefined;
    this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async drain() {
    try {
      while (this.savedRevision < this.revision) {
        this.onState("saving");
        const scene = this.desired;
        const revision = this.revision;
        const saved = await this.service.saveProject(this.project.id, this.version, scene);
        this.version = saved.version;
        this.savedRevision = revision;
      }
      this.onState("saved");
    } catch (error) {
      this.error = error;
      this.onState("error", error);
      throw error;
    }
  }

  dispose() { clearTimeout(this.timer); }
}
