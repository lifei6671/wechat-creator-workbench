import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Dialog } from "@radix-ui/themes";
import { ArrowLeft } from "lucide-react";
import type { ImageContext, MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { ImageProject, PreparedImageRender } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { registerSaveBarrier } from "../editor/save-barriers";
import type { SaveQueue } from "../editor/save-queue";
import type { ImageCanvasHandle, ImageCanvasService } from "../image-canvas/service";
import "../image-canvas/image-canvas.css";

const ImageCanvasEditor = lazy(() => import("../image-canvas/ImageCanvasEditor"));

const service: ImageCanvasService = {
  saveProject: desktop.imageProjectSave,
  readAsset: id => desktop.imageCanvasRead(`asset://${id}`),
  readThumbnail: desktop.assetThumbnail,
  infoAsset: id => desktop.imageCanvasInfo(`asset://${id}`),
  importImage: desktop.imageCanvasImport,
  async listAssets(page) {
    const result = await desktop.assetLibrary(page);
    return {
      items: result.items.filter(item => item.width && item.height).map(item => ({
        id: item.id, url: `asset://${item.id}`, width: item.width!, height: item.height!, name: item.name,
      })),
      hasMore: result.hasNext,
    };
  },
  prepareRender: desktop.imageRenderPrepare,
  commitRender: desktop.imageRenderCommit,
  copyImage: desktop.copyImage,
  saveImage: desktop.saveImage,
};

export function useImageCanvasEditor(queue: SaveQueue, editor: RefObject<MarkdownEditorHandle | null>, onError: (error: unknown) => void) {
  const [session, setSession] = useState<{ project: ImageProject; image: ImageContext; editor: MarkdownEditorHandle }>();
  const opening = useRef(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const releaseBarrier = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; releaseBarrier.current?.(); };
  }, []);
  const ready = useCallback((handle: ImageCanvasHandle | null) => {
    releaseBarrier.current?.();
    releaseBarrier.current = handle ? registerSaveBarrier(() => handle.flush()) : undefined;
  }, []);
  const open = (image: ImageContext) => {
    if (opening.current || session) return;
    const handle = editor.current;
    if (!handle || !image.isCurrent()) return;
    opening.current = true;
    setLoading(true);
    void (async () => {
      await handle.pendingEdits();
      if (!await queue.flush({ retry: true })) throw queue.saveError();
      const project = await desktop.imageProjectOpen(queue.entry.id, image.src);
      if (!mounted.current || editor.current !== handle || !image.isCurrent()) return;
      setSession({ project, image, editor: handle });
    })().catch(onError).finally(() => { opening.current = false; if (mounted.current) setLoading(false); });
  };
  const apply = async (prepared: PreparedImageRender) => {
    if (!session || editor.current !== session.editor || !session.image.isCurrent()) {
      throw new Error("原图片已更改或文章已关闭，请重新打开图片编辑");
    }
    await queue.applyExternalContent(
      () => session.editor.prepareImageReplacement(session.image, prepared.src),
      async (expectedVersion, fields, recovery) => {
        const result = await desktop.imageRenderCommit(prepared.renderId, { id: queue.entry.id, expectedVersion, fields, recovery });
        return { version: result.entryVersion! };
      },
    );
  };
  return {
    open,
    element: session ? <Suspense fallback={<ImageCanvasLoading />}>
      <ImageCanvasEditor project={session.project} service={service} onApply={apply} onReady={ready}
        applyLabel={queue.entry.kind === "article" ? "应用到文章" : "应用到内容"}
        onClose={() => { ready(null); setSession(undefined); editor.current?.focus(); }} />
    </Suspense> : loading ? <ImageCanvasLoading /> : null,
  };
}

function ImageCanvasLoading() {
  return <Dialog.Root open><Dialog.Content className="image-canvas-dialog" aria-describedby={undefined}
    style={{ maxWidth: "none", width: "100vw", height: "100dvh", padding: 0 }}
    onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}
    onCloseAutoFocus={event => event.preventDefault()}>
    <main className="image-canvas-app" aria-busy="true"><div className="image-canvas-workspace" />
      <header className="ic-document-bar ic-floating"><button type="button" className="ic-document-back" aria-label="返回正文" disabled /><span className="ic-document-back-icon" aria-hidden="true"><ArrowLeft /></span><Dialog.Title trim="normal" mb="0">编辑图片</Dialog.Title></header>
      <div className="ic-opening-status" role="status">正在打开图片编辑…</div>
    </main>
  </Dialog.Content></Dialog.Root>;
}
