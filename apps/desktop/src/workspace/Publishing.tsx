import { useState, type FormEvent } from "react";
import { Button, Dialog, TextField } from "@radix-ui/themes";
import { X } from "lucide-react";
import { desktop, errorMessage, type ExportImage, type LinkImportResult, type WechatImportJob } from "../desktop";
import { Tooltip } from "../ui";
import { ActionError, useButtonFeedback } from "../button-feedback";
import { renderWechat, type ImageResult, type RenderInput, type RenderedWechat } from "../../../../packages/wechat-renderer";

export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const [dialogOpen, setDialogOpen] = useState(true);
  return <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
    <Dialog.Content className="image-viewer" aria-describedby={undefined} inert={!dialogOpen} onCloseAutoFocus={() => { if (!dialogOpen) onClose(); }}>
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
  const [dialogOpen, setDialogOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const buttons = useButtonFeedback();

  async function perform(load: () => Promise<LinkImportResult>) {
    if (busy || !buttons.start("import")) return;
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
        else {
          setJob(job);
          if (job.error) throw new Error(job.error);
        }
      }
      buttons.finish("import", true);
    } catch (error) { setError(errorMessage(error)); buttons.finish("import", false); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void perform(() => desktop.importLink(url.trim(), categoryId, downloadImages));
  }
  async function openImported(id: string) {
    if (busy || !buttons.start("open")) return;
    setBusy(true);
    setError("");
    try { await onOpen(id); buttons.finish("open", true); }
    catch (failure) { setError(errorMessage(failure)); buttons.finish("open", false); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open={dialogOpen} onOpenChange={open => { if (!open && !busy) setDialogOpen(false); }}>
    <Dialog.Content maxWidth="520px" aria-describedby={undefined} inert={!dialogOpen} onCloseAutoFocus={() => { if (!dialogOpen) onClose(); }}>
      <Dialog.Title>导入链接</Dialog.Title>
      <form className="dialog-form" onSubmit={submit}>
        <label>网页链接<TextField.Root type="url" required value={url} onChange={event => setUrl(event.target.value)}
          placeholder="https://" autoFocus /></label>
        {<div className="action-error-slot" tabIndex={(error) ? 0 : -1}>{error ? <p role="alert" className="inline-error">{error}</p> : null}</div>}
        <div className="dialog-actions">
          <Dialog.Close><Button type="button" color="gray" variant="soft" disabled={busy}>关闭</Button></Dialog.Close>
          <Button type="submit" loading={buttons.status("import") === "pending"} {...buttons.props("import", busy)}>
            {buttons.label("import", adding ? "导入并添加" : "导入", "已导入", "导入失败")}</Button>
        </div>
      </form>
      {job && <section className="wechat-job" aria-label="本次导入结果">
          <div className="wechat-job-status"><strong>{importStatus[job.status]}</strong>
            <span title={job.url}>{job.url}</span></div>
          {<div className="action-error-slot" tabIndex={(job.error) ? 0 : -1}>{job.error ? <p className="inline-error">{job.error}</p> : null}</div>}
          <div className="button-strip">
            {job.entryId && <Button size="1" variant="soft" {...buttons.props("open", busy)} onClick={() => void openImported(job.entryId!)}>{adding ? "添加到画布" : "打开笔记"}</Button>}
            {job.entryId && job.pendingImages > 0 && <Button size="1" variant="soft" {...buttons.props("import", busy)}
              onClick={() => { void perform(async () => ({ kind: "wechat", job: await desktop.retryWechatImages(job.entryId!) })); }}>补图（{job.pendingImages}）</Button>}
            {!job.entryId && (job.status === "failed" || job.status === "needs_attention") && <Button size="1" variant="soft"
              {...buttons.props("import", busy)} onClick={() => { void perform(() => desktop.importLink(job.url, categoryId, downloadImages)); }}>重试导入</Button>}
          </div>
      </section>}
    </Dialog.Content>
  </Dialog.Root>;
}

export function PublishImagesDialog({ images, onClose }: { images: RenderedWechat["images"]; onClose(): void }) {
  const buttons = useButtonFeedback();
  const [dialogOpen, setDialogOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  async function useImage(index: number, action: "copy" | "save") {
    const key = `${index}:${action}`;
    if (busy) return;
    setBusy(true);
    try {
      await buttons.run(key, () => action === "copy" ? desktop.copyImage(images[index].url) : desktop.saveImage(images[index].url));
    }
    finally { setBusy(false); }
  }
  return <Dialog.Root open={dialogOpen} onOpenChange={open => { if (!open && !busy) setDialogOpen(false); }}>
    <Dialog.Content maxWidth="520px" inert={!dialogOpen} onCloseAutoFocus={() => { if (!dialogOpen) onClose(); }}>
      <Dialog.Title>逐张处理图片</Dialog.Title>
      <Dialog.Description>正文样式已复制。粘贴到公众号后台后，按标记顺序插入图片。</Dialog.Description>
      <div className="wechat-job-list">
        {images.map((image, index) => <div key={index} className="wechat-job">
          <div className="wechat-job-status"><strong>图片 {index + 1}</strong><span>{image.alt}</span></div>
          <div className="button-strip">
            <Button size="1" variant="soft" {...buttons.props(`${index}:copy`, busy)} loading={buttons.status(`${index}:copy`) === "pending"}
              onClick={() => void useImage(index, "copy")}>{buttons.label(`${index}:copy`, "复制图片", "已复制")}</Button>
            <Button size="1" variant="soft" color="gray" {...buttons.props(`${index}:save`, busy)} loading={buttons.status(`${index}:save`) === "pending"}
              onClick={() => void useImage(index, "save")}>{buttons.label(`${index}:save`, "保存图片", "已保存")}</Button>
          </div>
          <ActionError error={buttons.error(`${index}:copy`) || buttons.error(`${index}:save`)} />
        </div>)}
      </div>
      <div className="dialog-actions"><Dialog.Close><Button variant="soft" color="gray" disabled={busy}>关闭</Button></Dialog.Close></div>
    </Dialog.Content>
  </Dialog.Root>;
}
