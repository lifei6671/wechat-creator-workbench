import { createContext, memo, useContext, useLayoutEffect, useRef, type CSSProperties } from "react";
import { Handle, NodeResizer, NodeToolbar, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import { Popover } from "@radix-ui/themes";
import { Copy, ExternalLink, FilePlus2, Focus, Palette, SquarePen, Trash2 } from "lucide-react";
import type { CanvasCardColor, CanvasGeometry, CanvasNode, Entry } from "../../../../packages/shared-types";
import type { ClipboardIO, MarkdownEditorHandle } from "../../../../packages/editor-react";
import { renderMarkdown } from "../../../../packages/markdown-core";
import { desktop } from "../desktop";
import { untitled } from "../labels";
import { Tool } from "../ui";
import { ColorChoices, colorValue } from "./ColorChoices";
import type { useButtonFeedback } from "../button-feedback";
import { useAssetImage } from "./Assets";
import type { SaveQueue } from "../editor/save-queue";
import { CollectionArticleEditor, CollectionArticlePreview } from "./CollectionArticle";
import { CanvasTextEditor } from "./CanvasTextEditor";
import { useCanvasPreviewImages, type CanvasPreviewCache } from "./CanvasPreviewCache";

export type FlowNode = Node<CanvasNode & { pageTitle?: string }, "card"> & { width: number; height: number };
export const CollectionNodeContext = createContext<{
  feedback?: ReturnType<typeof useButtonFeedback>;
  editingId: string | null;
  activeWebNodeId: string | null;
  webPreviews: CanvasPreviewCache;
  convertingId: string | null;
  edit(id: string): void;
  remove(id: string): void;
  focus(id: string): void;
  color(id: string, color: CanvasCardColor | null): void;
  fitImage(id: string, width: number, height: number): void;
  registerTextEditor(id: string, handle: MarkdownEditorHandle | null): void;
  markTextDirty(id: string, revision: number): void;
  saveText(id: string): void;
  finishText(id: string): void;
  copyText(id: string): void;
  convertText(id: string): void;
  resize(id: string, geometry: CanvasGeometry): void;
  setWebSlot(slot: HTMLDivElement | null): void;
  loadArticle(id: string): Promise<Entry>;
  articleQueue?: SaveQueue;
  articleLocked: boolean;
  clipboard: ClipboardIO;
  registerArticleEditor(handle: MarkdownEditorHandle | null): void;
  finishArticle(): void;
  discardArticle(): void;
  onArticleImages(files: File[]): Promise<string>;
  onError(error: unknown): void;
} | null>(null);

const CanvasCard = memo(function CanvasCard({ id, data, selected, width, height }: Pick<NodeProps<FlowNode>, "id" | "data" | "selected"> & {
  width?: number;
  height?: number;
}) {
  const actions = useContext(CollectionNodeContext)!;
  const entry = data.entry;
  const title = entry?.title || untitled;
  const caption = data.externalUrl ? data.pageTitle || new URL(data.externalUrl).hostname
    : data.kind === "entry" ? title : data.kind === "image" ? data.assetName || "图片" : undefined;
  const editing = actions.editingId === id;
  const imageEditing = data.kind === "image" && editing;
  const canEdit = data.kind === "text" ? id !== actions.convertingId : data.kind === "entry" && !actions.articleLocked && entry?.deletedAt === null;
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (imageEditing) card.current?.focus({ preventScroll: true }); }, [imageEditing]);
  return <article ref={card} className={`collection-card${editing ? " nodrag" : ""}`} data-kind={data.kind} data-editing={editing}
    style={cardColorStyle(data.color)}
    data-color={data.color ?? undefined} data-selected={selected} tabIndex={imageEditing ? -1 : undefined} aria-label={imageEditing ? "调整图片大小" : undefined} onDoubleClick={event => {
    if (editing || data.kind === "web" || (event.target as Element).closest("a")) return;
    event.stopPropagation();
    actions.edit(id);
  }}>
    {selected && <CardTools id={id} data={data} hasCaption={Boolean(caption)} canEdit={canEdit && !editing} editing={editing} />}
    <NodeResizer isVisible={imageEditing || (selected && !editing)} keepAspectRatio={data.kind === "image"}
      minWidth={data.kind === "image" ? Math.min(96, width ?? 96) : 160}
      minHeight={data.kind === "image" ? Math.min(64, height ?? 64) : 96} maxWidth={1200} maxHeight={1000}
      onResizeEnd={(_event, geometry) => actions.resize(id, geometry)} />
    <Handle type="target" position={Position.Left} title="连线终点" />
    <Handle type="source" position={Position.Right} title="连线起点" />
    {caption && <div className="collection-card-caption" aria-hidden="true">{caption}</div>}
    {data.entryId && (editing && actions.articleQueue
      ? <CollectionArticleEditor queue={actions.articleQueue} locked={actions.articleLocked || entry?.deletedAt !== null} clipboard={actions.clipboard}
        onEditor={actions.registerArticleEditor} onFinish={actions.finishArticle} onDiscard={actions.discardArticle}
        onImages={actions.onArticleImages} onError={actions.onError} />
      : entry?.deletedAt === null ? <CollectionArticlePreview id={data.entryId} title={title} source={entry.sourcePlatform} load={actions.loadArticle} onError={actions.onError} />
      : <div className="collection-card-body muted-text">{entry ? "已移入回收站" : "找不到文章"}</div>)}
    {data.assetId && <CollectionImage id={data.assetId} name={caption ?? "图片"} onSize={(w, h) => actions.fitImage(id, w, h)} />}
    {data.externalUrl && <WebCardPreview id={id} url={data.externalUrl} cache={actions.webPreviews}
      slot={actions.activeWebNodeId === id ? actions.setWebSlot : undefined} />}
    {data.kind === "text" && (editing
      ? <CanvasTextEditor id={id} markdown={data.contentMd} clipboard={actions.clipboard} locked={actions.articleLocked}
        register={actions.registerTextEditor} dirty={actions.markTextDirty} save={actions.saveText} finish={actions.finishText}
        onImages={actions.onArticleImages} onError={actions.onError} />
      : <TextPreview markdown={data.contentMd} onError={actions.onError} />)}
  </article>;
});

export const collectionNodeTypes = { card: CanvasCard };

function WebCardPreview({ id, url, cache, slot }: {
  id: string; url: string; cache: CanvasPreviewCache; slot?: (element: HTMLDivElement | null) => void;
}) {
  const { image, incoming } = useCanvasPreviewImages(cache, id, url);
  const hostname = new URL(url).hostname;
  return <div className="collection-web-preview">
    {[image, slot ? incoming : undefined].map(source => source && <img key={source} className="collection-web-image"
      src={source} alt={source === incoming ? "" : hostname} draggable={false}
      data-fading={source === incoming || undefined}
      onAnimationEnd={() => { if (source === incoming) cache.finish(id, url, source); }} />)}
    {!image && <span className="collection-web-placeholder">{hostname}</span>}
    {slot && <div className="collection-web-viewport" aria-label="网页预览" data-preview-node={id} ref={slot} />}
  </div>;
}

function cardColorStyle(color: CanvasCardColor | null): CSSProperties | undefined {
  if (!color) return;
  return { "--card-color": colorValue(color) } as CSSProperties;
}

function CardTools({ id, data, hasCaption, canEdit, editing }: { id: string; data: CanvasNode; hasCaption: boolean; canEdit: boolean; editing: boolean }) {
  const actions = useContext(CollectionNodeContext)!;
  const zoom = useStore(state => state.transform[2]);
  return <NodeToolbar className="collection-card-tools nodrag nopan" offset={8 + (hasCaption ? 23 * zoom : 0)}
    role="group" aria-label="卡片工具" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <Tool label="删除卡片" color="gray" disabled={id === actions.convertingId} onClick={() => actions.remove(id)}><Trash2 size={18} strokeWidth={1.75} /></Tool>
    <Popover.Root>
      <Popover.Trigger><Tool label="设置颜色" color="gray"><Palette size={18} strokeWidth={1.75} /></Tool></Popover.Trigger>
      <Popover.Content size="1" className="collection-color-palette" aria-label="卡片颜色" side="bottom" sideOffset={8}>
        <ColorChoices value={data.color} onChange={color => actions.color(id, color)} closeOnSelect />
      </Popover.Content>
    </Popover.Root>
    <Tool label="聚焦当前卡片（Shift + 2）" color="gray" onClick={() => actions.focus(id)}><Focus size={18} strokeWidth={1.75} /></Tool>
    {data.externalUrl && <Tool label="在系统浏览器打开" color="gray" {...actions.feedback?.props(`open:${id}`)}
      onClick={() => { if (actions.feedback) void actions.feedback.run(`open:${id}`, () => desktop.openLink(data.externalUrl!));
        else void desktop.openLink(data.externalUrl!).catch(actions.onError); }}>
      {actions.feedback ? actions.feedback.icon(`open:${id}`, <ExternalLink size={18} strokeWidth={1.75} />, 18) : <ExternalLink size={18} strokeWidth={1.75} />}</Tool>}
    {(data.kind === "text" || data.kind === "entry") && <Tool label="编辑" color="gray" disabled={!canEdit} onClick={() => actions.edit(id)}><SquarePen size={18} strokeWidth={1.75} /></Tool>}
    {data.kind === "text" && editing && <>
      <Tool label={actions.feedback?.status(`copy:${id}`) === "success" ? "已复制" : "复制 Markdown"} color="gray"
        {...actions.feedback?.props(`copy:${id}`)} onClick={() => actions.copyText(id)}>
        {actions.feedback ? actions.feedback.icon(`copy:${id}`, <Copy size={18} strokeWidth={1.75} />, 18) : <Copy size={18} strokeWidth={1.75} />}</Tool>
      <Tool label="创建原创文章" color="gray" disabled={actions.convertingId !== null} onClick={() => actions.convertText(id)}><FilePlus2 size={18} strokeWidth={1.75} /></Tool>
    </>}
  </NodeToolbar>;
}

function CollectionImage({ id, name, onSize }: { id: string; name: string; onSize(w: number, h: number): void }) {
  const image = useAssetImage(`asset://${id}`);
  return <div className="collection-card-image">
    {image?.src ? <img src={image.src} alt={name} draggable={false} onLoad={event => {
      const { naturalWidth, naturalHeight } = event.currentTarget;
      if (naturalWidth && naturalHeight) onSize(naturalWidth, naturalHeight);
    }} /> : <span className="muted-text">{image ? "图片缺失" : "正在加载图片…"}</span>}
  </div>;
}

function TextPreview({ markdown, onError }: { markdown: string; onError(error: unknown): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!markdown.trim()) return;
    const fragment = renderMarkdown(markdown);
    fragment.querySelectorAll(".preview-image").forEach(image => image.replaceWith(image.textContent ?? ""));
    ref.current?.replaceChildren(fragment);
  }, [markdown]);
  return markdown.trim()
    ? <div className="collection-card-body collection-markdown nowheel" ref={ref} onClick={event => {
      const link = (event.target as Element).closest("a");
      if (!link) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(link.href)) void desktop.openLink(link.href).catch(onError);
    }} />
    : <div className="collection-card-body muted-text">双击编辑</div>;
}
