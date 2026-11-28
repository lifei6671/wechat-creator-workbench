import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import ImageCanvasEditor from "../src/image-canvas/ImageCanvasEditor";
import { newImageLayer } from "../src/image-canvas/scene";
import type { ImageCanvasService } from "../src/image-canvas/service";
import type { ImageCanvasAsset, ImageProject, ImageRenderResult, ImageScene, PreparedImageRender } from "../../../packages/shared-types";

const assets = new Map<string, ArrayBuffer>();
const staged = new Map<string, PreparedImageRender>();
const completed: string[] = [];
let copied = 0, saved = 0, applied = 0, output: { width: number; height: number; mime: string; topPixel?: number[]; bottomPixel?: number[]; cornerPixel?: number[]; topEdgePixel?: number[] } | undefined;
async function sample(id: string, width: number, height: number, second = false): Promise<ImageCanvasAsset> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = second ? "#e9f6e9" : "#faf9f6"; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#1c2024"; ctx.fillRect(0, 0, width * .23, height);
  ctx.fillStyle = "#ffffff"; ctx.font = "bold 24px sans-serif"; ctx.fillText("创作工作台", 24, 48);
  ctx.font = "18px sans-serif"; ["文章", "灵感", "资料", "专题"].forEach((text, i) => ctx.fillText(text, 26, 116 + i * 64));
  const x = width * .29; ctx.fillStyle = "#1c2024"; ctx.font = "bold 36px sans-serif"; ctx.fillText(second ? "整理好的想法" : "让灵感，慢慢成形", x, 100);
  ctx.fillStyle = "#60646c"; ctx.font = "20px sans-serif"; ctx.fillText("记录、整理，再写成一篇好文章。", x, 154);
  ctx.fillStyle = "#e6e7ea";
  for (let i = 0; i < 6; i++) ctx.fillRect(x, 230 + i * 40, (width - x - 50) * (i % 3 === 2 ? .65 : 1), 8);
  if (new URLSearchParams(location.search).has("visual")) {
    const source = second ? new URL("../../../docs/prototypes/image-canvas/assets/page.png", import.meta.url)
      : new URL("../../../docs/prototypes/image-canvas/assets/reference-desktop.png", import.meta.url);
    const image = await createImageBitmap(await (await fetch(source)).blob());
    const crop = second ? { x: 54, y: 41, width: 972, height: 733 } : { x: 578, y: 207, width: 2323, height: 1438 };
    const scale = Math.max(width / crop.width, height / crop.height);
    ctx.drawImage(image, crop.x + (crop.width - width / scale) / 2, crop.y + (crop.height - height / scale) / 2, width / scale, height / scale, 0, 0, width, height);
    image.close();
    const visual = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/png"));
    assets.set(id, await visual.arrayBuffer());
    return { id, url: `asset://${id}`, width, height };
  }
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/png"));
  assets.set(id, await blob.arrayBuffer());
  return { id, url: `asset://${id}`, width, height };
}
const initial = await sample("sample-one", 1000, 650);
const second = await sample("sample-two", 740, 900, true);
const orientation = Number(new URLSearchParams(location.search).get("orientation") ?? 1);
if (orientation === 6 || orientation === 8) initial.orientation = orientation;
const oriented = orientation === 6 || orientation === 8;
const wallpaper = new URLSearchParams(location.search).has("background");
const padding = wallpaper ? 100 : 0;
const initialLayer = newImageLayer(initial); initialLayer.x += padding; initialLayer.y += padding;
let project: ImageProject = { id: "canvas-test", originEntryId: "article", baseAssetId: initial.id, version: 1,
  scene: { schemaVersion: 1, artboard: { width: (oriented ? initial.height : initial.width) + 2 * padding,
    height: (oriented ? initial.width : initial.height) + 2 * padding,
    background: wallpaper ? { type: "image", assetId: initial.id, fit: "contain" } : { type: "transparent" } },
    layers: [initialLayer], layout: { mode: "free", gap: 24, padding, columns: 2, align: "center", size: 0 } },
  createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null };
const service: ImageCanvasService = {
  async saveProject(_id, version, scene) {
    if (version !== project.version) throw new Error("工程版本冲突");
    project = { ...project, scene: structuredClone(scene), version: version + 1 }; return { version: project.version };
  },
  async readAsset(id) { const bytes = assets.get(id); if (!bytes) throw new Error("素材不可用"); return bytes; },
  async readThumbnail(id) { return assets.get(id)!; },
  async infoAsset(id) { return [initial, second].find(asset => asset.id === id)!; },
  async importImage(file) { const bytes = await file.arrayBuffer(); const image = await createImageBitmap(file);
    const asset = { id: crypto.randomUUID(), url: "", width: image.width, height: image.height }; asset.url = `asset://${asset.id}`;
    assets.set(asset.id, bytes); image.close(); return asset; },
  async listAssets() { return { items: [initial, second], hasMore: false }; },
  async prepareRender(_id, version, renderId, _options, bytes) {
    if (version !== project.version) throw new Error("工程版本冲突");
    const blob = new Blob([new Uint8Array(bytes)]); const image = await createImageBitmap(blob);
    const header = String.fromCharCode(...bytes.slice(0, 12));
    const mime = header.startsWith("\x89PNG") ? "png" : header.startsWith("RIFF") ? "webp" : bytes[0] === 255 && bytes[1] === 216 ? "jpeg" : "unknown";
    const probe = document.createElement("canvas"); probe.width = 1; probe.height = 1;
    const context = probe.getContext("2d")!;
    context.drawImage(image, Math.floor(image.width / 2), 50, 1, 1, 0, 0, 1, 1);
    const topPixel = [...context.getImageData(0, 0, 1, 1).data];
    context.drawImage(image, Math.floor(image.width / 2), image.height - 50, 1, 1, 0, 0, 1, 1);
    const bottomPixel = [...context.getImageData(0, 0, 1, 1).data];
    context.clearRect(0, 0, 1, 1); context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
    const cornerPixel = [...context.getImageData(0, 0, 1, 1).data];
    context.clearRect(0, 0, 1, 1); context.drawImage(image, Math.floor(image.width / 2), 0, 1, 1, 0, 0, 1, 1);
    const topEdgePixel = [...context.getImageData(0, 0, 1, 1).data];
    output = { width: image.width, height: image.height, mime, topPixel, bottomPixel, cornerPixel, topEdgePixel }; image.close();
    const prepared = { renderId, outputAssetId: renderId, src: `asset://${renderId}` };
    assets.set(renderId, new Uint8Array(bytes).buffer); staged.set(renderId, prepared); return prepared;
  },
  async commitRender(id): Promise<ImageRenderResult> { completed.push(id); return staged.get(id)!; },
  async copyImage() { copied += 1; },
  async saveImage() { saved += 1; return !new URLSearchParams(location.search).has("cancel"); },
};
declare global { interface Window { imageCanvasTest: { releaseOpen?(): void; snapshot(): { scene: ImageScene; version: number; copied: number; saved: number; applied: number; completed: number; output: typeof output } } } }
window.imageCanvasTest = { snapshot: () => ({ scene: project.scene, version: project.version, copied, saved, applied, completed: completed.length, output }) };
function App() {
  const [open, setOpen] = useState(true);
  return <Theme appearance={new URLSearchParams(location.search).has("dark") ? "dark" : "light"} accentColor="indigo">
    {open ? <ImageCanvasEditor project={project} service={service} onClose={() => setOpen(false)}
      onApply={async render => { await service.commitRender(render.renderId); applied += 1; }} /> : <p role="status">已返回正文</p>}
  </Theme>;
}
if (new URLSearchParams(location.search).has("host")) {
  const { desktop } = await import("../src/desktop");
  let releaseOpen: () => void;
  const opening = new Promise<void>(resolve => { releaseOpen = resolve; });
  Object.assign(window.imageCanvasTest, { releaseOpen: () => releaseOpen() });
  desktop.imageProjectOpen = async () => { await opening; return project; };
  desktop.imageProjectSave = service.saveProject;
  desktop.imageCanvasRead = url => service.readAsset(url.replace("asset://", ""));
  desktop.imageCanvasInfo = url => service.infoAsset(url.replace("asset://", ""));
  const { useImageCanvasEditor } = await import("../src/workspace/ImageCanvasHost");
  const { MarkdownEditor } = await import("../../../packages/editor-react");
  const { EditorContextMenu } = await import("../src/workspace/EditorContextMenu");
  const { SaveQueue } = await import("../src/editor/save-queue");
  const imageUrl = URL.createObjectURL(new Blob([assets.get(initial.id)!], { type: "image/png" }));
  const entry: import("../../../packages/shared-types").Entry = { id: "article", kind: "article", title: "图片编辑验证", contentMd: `![配图](${imageUrl})`, status: "draft",
    categoryId: null, tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [] };
  function HostApp() {
    const editor = useRef<import("../../../packages/editor-react").MarkdownEditorHandle>(null);
    const [error, setError] = useState("");
    const [queue] = useState(() => new SaveQueue(entry, async () => ({ version: 2 }), () => {}));
    useEffect(() => () => queue.dispose(), [queue]);
    const onError = (failure: unknown) => setError(String(failure));
    const canvas = useImageCanvasEditor(queue, editor, onError);
    return <Theme accentColor="indigo"><EditorContextMenu editor={editor} readOnly={false} onError={onError} onEditImage={canvas.open}
      clipboard={{ async read() { return { html: "", text: "" }; }, async write() {}, onError }}>
      <MarkdownEditor entryId={entry.id} value={entry.contentMd} readOnly={false}
        ref={value => { editor.current = value; if (value) return queue.bindContentProvider(value.captureMarkdown); }}
        onDocumentChanged={(_id, revision) => queue.markContentDirty(revision)} onBlur={() => {}} />
    </EditorContextMenu><div role="alert">{error}</div>{canvas.element}</Theme>;
  }
  createRoot(document.getElementById("root")!).render(<HostApp />);
} else createRoot(document.getElementById("root")!).render(<App />);
