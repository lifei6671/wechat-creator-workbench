import { useState, type FormEvent } from "react";
import { Button, Dialog, TextField } from "@radix-ui/themes";
import { X } from "lucide-react";
import { desktop, errorMessage, type ExportImage, type LinkImportResult, type WechatImportJob } from "../desktop";
import { Tooltip } from "../ui";
import { renderWechat, type ImageResult, type RenderInput, type RenderedWechat } from "../../../../packages/wechat-renderer";

export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Content className="image-viewer" aria-describedby={undefined}>
      <Dialog.Title className="image-viewer-title">{alt || "图片预览"}</Dialog.Title>
      <Tooltip content="关闭图片预览"><Dialog.Close><button type="button" className="plain-button chrome-icon image-viewer-close" aria-label="关闭图片预览">
        <X size={18} strokeWidth={1.65} />
      </button></Dialog.Close></Tooltip>
      <img src={src} alt={alt} />
    </Dialog.Content>
  </Dialog.Root>;
}

export async function loadLocalImage(url: string, retry = false) {
  const bytes = await desktop.assetRead(url, retry);
  const src = URL.createObjectURL(new Blob([bytes]));
  try {
    const image = new Image();
    image.src = src;
    await image.decode();
    return { src, width: image.naturalWidth, height: image.naturalHeight, dispose: () => URL.revokeObjectURL(src) };
  } catch (error) {
    URL.revokeObjectURL(src);
    throw error;
  }
}

export async function renderForPublication(input: RenderInput) {
  const hosting = input.output === "clipboard" && Boolean(await desktop.imageStorageTarget());
  const resolved = new Map<string, Promise<ImageResult>>();
  const exportImages: ExportImage[] = [];
  const result = await renderWechat(input, {
    sources: desktop.wechatGraphics,
    derive: desktop.deriveImage,
    image(url) {
      let value = resolved.get(url);
      if (!value) {
        value = (async () => {
          const image = await loadLocalImage(url);
          image.dispose();
          const file = input.output === "html" ? await desktop.assetInfo(url) : null;
          if (file) exportImages.push({ url, name: file.name });
          const src = input.output === "html" ? (file ? `assets/${file.name}` : url)
            : hosting ? await desktop.publicImage(url) : null;
          return { src, width: image.width, height: image.height };
        })();
        resolved.set(url, value);
      }
      return value;
    },
  });
  return { result, hosting, exportImages };
}

type Track = <T>(job: Promise<T>) => Promise<T>;
const importStatus: Record<WechatImportJob["status"], string> = {
  queued: "等待导入", running: "导入中", completed: "已导入", partial: "部分图片待补",
  needs_attention: "访问受限", failed: "导入失败",
};

export function LinkImportDialog({ categoryId, downloadImages, onClose, track, onOpen, onImported, adding }: {
  categoryId: string | null;
  downloadImages: boolean;
  onClose(): void;
  track: Track;
  onOpen(id: string): void | Promise<void>;
  onImported?(unavailableImages: number): void;
  adding?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<WechatImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function perform(load: () => Promise<LinkImportResult>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setJob(null);
    try {
      const result = await track(load());
      if (result.kind === "article") {
        if (result.article.deleted) throw new Error("该链接已收录，请先从回收站恢复");
        onImported?.(result.article.unavailableImages);
        await onOpen(result.article.entryId);
      } else {
        const job = result.job;
        if (job.entryId) onImported?.(0);
        if (job.status === "completed" && job.entryId) await onOpen(job.entryId);
        else setJob(job);
      }
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void perform(() => desktop.importLink(url.trim(), categoryId, downloadImages));
  }
  async function openImported(id: string) {
    setBusy(true);
    setError("");
    try { await onOpen(id); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Content maxWidth="520px" aria-describedby={undefined}>
      <Dialog.Title>导入链接</Dialog.Title>
      <form className="dialog-form" onSubmit={submit}>
        <label>网页链接<TextField.Root type="url" required value={url} onChange={event => setUrl(event.target.value)}
          placeholder="https://" autoFocus /></label>
        {error && <p role="alert" className="inline-error">{error}</p>}
        <div className="dialog-actions">
          <Dialog.Close><Button type="button" color="gray" variant="soft" disabled={busy}>关闭</Button></Dialog.Close>
          <Button type="submit" loading={busy}>{adding ? "导入并添加" : "导入"}</Button>
        </div>
      </form>
      {job && <section className="wechat-job" aria-label="本次导入结果">
          <div className="wechat-job-status"><strong>{importStatus[job.status]}</strong>
            <span title={job.url}>{job.url}</span></div>
          {job.error && <p className="inline-error">{job.error}</p>}
          <div className="button-strip">
            {job.entryId && <Button size="1" variant="soft" disabled={busy} onClick={() => void openImported(job.entryId!)}>{adding ? "添加到画布" : "打开笔记"}</Button>}
            {job.entryId && job.pendingImages > 0 && <Button size="1" variant="soft" disabled={busy}
              onClick={() => { void perform(async () => ({ kind: "wechat", job: await desktop.retryWechatImages(job.entryId!) })); }}>补图（{job.pendingImages}）</Button>}
            {!job.entryId && (job.status === "failed" || job.status === "needs_attention") && <Button size="1" variant="soft"
              disabled={busy} onClick={() => { void perform(() => desktop.importLink(job.url, categoryId, downloadImages)); }}>重试导入</Button>}
          </div>
      </section>}
    </Dialog.Content>
  </Dialog.Root>;
}

export function PublishImagesDialog({ images, onClose }: { images: RenderedWechat["images"]; onClose(): void }) {
  const [feedback, setFeedback] = useState<{ index: number; text: string; error?: boolean }>();
  const [busy, setBusy] = useState(false);
  async function useImage(index: number, action: "copy" | "save") {
    setBusy(true);
    try {
      if (action === "copy") {
        await desktop.copyImage(images[index].url);
        setFeedback({ index, text: "已复制图片" });
      } else if (await desktop.saveImage(images[index].url)) {
        setFeedback({ index, text: "已保存图片" });
      }
    } catch (error) { setFeedback({ index, text: errorMessage(error), error: true }); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Content maxWidth="520px">
      <Dialog.Title>逐张处理图片</Dialog.Title>
      <Dialog.Description>正文样式已复制。粘贴到公众号后台后，按标记顺序插入图片。</Dialog.Description>
      <div className="wechat-job-list">
        {images.map((image, index) => <div key={index} className="wechat-job">
          <div className="wechat-job-status"><strong>图片 {index + 1}</strong><span>{image.alt}</span></div>
          <div className="button-strip">
            <Button size="1" variant="soft" disabled={busy} onClick={() => void useImage(index, "copy")}>复制图片</Button>
            <Button size="1" variant="soft" color="gray" disabled={busy} onClick={() => void useImage(index, "save")}>保存图片</Button>
            {feedback?.index === index && <span role={feedback.error ? "alert" : "status"} className={feedback.error ? "inline-error" : "muted-text"}>{feedback.text}</span>}
          </div>
        </div>)}
      </div>
      <div className="dialog-actions"><Dialog.Close><Button variant="soft" color="gray" disabled={busy}>关闭</Button></Dialog.Close></div>
    </Dialog.Content>
  </Dialog.Root>;
}
