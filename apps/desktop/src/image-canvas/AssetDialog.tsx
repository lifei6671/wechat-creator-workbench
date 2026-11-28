import { useEffect, useRef, useState } from "react";
import { Dialog } from "@radix-ui/themes";
import { Check, FolderOpen, LoaderCircle, Plus, X } from "lucide-react";
import type { ImageCanvasAsset } from "../../../../packages/shared-types";
import { decodeResource } from "./renderer";
import type { ImageCanvasService } from "./service";

function Thumbnail({ asset, service }: { asset: ImageCanvasAsset; service: ImageCanvasService }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    void service.readThumbnail(asset.id).then(bytes => decodeResource(bytes, 240)).then(resource => {
      try {
        if (!current) return;
        const element = canvas.current!;
        element.width = resource.image.width; element.height = resource.image.height;
        element.getContext("2d")!.drawImage(resource.image, 0, 0);
      } finally { resource.dispose(); }
    }, () => { if (current) setError(true); });
    return () => { current = false; };
  }, [asset.id, service]);
  return error ? <span className="ic-thumbnail-error">图片加载失败</span> : <canvas ref={canvas} />;
}

export function AssetDialog({ service, onAdd, onFiles, onClose, busy, error }: {
  service: ImageCanvasService; onAdd(assets: ImageCanvasAsset[]): void; onFiles(files: File[]): void; onClose(): void; busy: boolean; error: string;
}) {
  const [items, setItems] = useState<ImageCanvasAsset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let current = true;
    setLoading(true); setLoadError("");
    void service.listAssets(page).then(result => {
      if (!current) return;
      setItems(previous => page === 0 ? result.items : [...previous, ...result.items.filter(item => !previous.some(existing => existing.id === item.id))]);
      setHasMore(result.hasMore); setLoading(false);
    }, failure => { if (current) { setLoading(false); setLoadError(failure instanceof Error ? failure.message : String(failure)); } });
    return () => { current = false; };
  }, [service, page, attempt]);

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Content className="image-canvas-small-dialog ic-library-dialog" aria-describedby={undefined}
    onEscapeKeyDown={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="ic-dialog-heading"><Dialog.Title>添加图片</Dialog.Title><button className="ic-icon" disabled={busy} aria-label="关闭添加窗口" onClick={onClose}><X /></button></header>
    <button className="ic-file-drop" disabled={busy} aria-busy={busy || undefined} onClick={() => input.current!.click()}>{busy ? <LoaderCircle className="ic-spin" /> : <FolderOpen />}<span>{busy ? "正在添加图片" : "选择本地图片"}</span></button>
    <input ref={input} hidden type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={event => {
      const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) onFiles(files);
    }} />
    <p className="ic-import-note">动图使用第一帧，原文件保留</p>
    <div className="ic-library-heading"><h3>素材库</h3>{loading && <LoaderCircle className="ic-spin" aria-label="正在加载素材" />}</div>
    {!loading && !items.length && !loadError && <div className="ic-library-empty">暂无图片素材</div>}
    <div className="ic-library-grid">{items.map((asset, index) => <button className="ic-library-item" key={asset.id} aria-pressed={selected.includes(asset.id)} disabled={busy}
      onClick={() => setSelected(previous => previous.includes(asset.id) ? previous.filter(id => id !== asset.id) : [...previous, asset.id])}>
      <Thumbnail asset={asset} service={service} />{selected.includes(asset.id) && <span className="ic-library-check"><Check /></span>}
      <span>{"name" in asset && typeof asset.name === "string" ? asset.name : `图片 ${index + 1}`}</span><small>{asset.width} × {asset.height}</small>
    </button>)}</div>
    {loadError && <button className="ic-button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>重试加载</button>}
    {hasMore && !loadError && <button className="ic-button ic-more" disabled={loading || busy} onClick={() => setPage(value => value + 1)}><Plus />加载更多</button>}
    <div className="ic-local-error" role={error || loadError ? "alert" : undefined}>{error || loadError}</div>
    <footer className="ic-dialog-actions"><button className="ic-button" disabled={busy} onClick={onClose}>取消</button><button className="ic-primary" disabled={busy || !selected.length}
      onClick={() => onAdd(items.filter(asset => selected.includes(asset.id)))}>{busy ? <LoaderCircle className="ic-spin" /> : <Plus />}{busy ? "添加中" : "添加所选图片"}</button></footer>
  </Dialog.Content></Dialog.Root>;
}
