import { useEffect, useRef, useState } from "react";
import { Dialog } from "@radix-ui/themes";
import { Check, RotateCcw, X } from "lucide-react";
import type { ImageLayer } from "../../../../packages/shared-types";
import { decodeResource } from "./renderer";
import type { ImageCanvasService } from "./service";

export function CropDialog({ layer, service, onApply, onClose }: {
  layer: ImageLayer; service: ImageCanvasService; onApply(crop: ImageLayer["crop"]): void; onClose(): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [crop, setCrop] = useState(layer.crop);
  const [error, setError] = useState("");
  const drag = useRef<{ x: number; y: number; crop: ImageLayer["crop"]; resize: boolean }>(undefined);
  useEffect(() => {
    let current = true;
    void service.readAsset(layer.assetId).then(bytes => decodeResource(bytes, 2048)).then(resource => {
      try {
        if (!current) return;
        setDimensions({ width: resource.width, height: resource.height });
        const element = canvas.current!;
        element.width = resource.image.width;
        element.height = resource.image.height;
        element.getContext("2d")!.drawImage(resource.image, 0, 0);
      } finally { resource.dispose(); }
    }, failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, [layer.assetId, service]);

  function update(next: ImageLayer["crop"]) {
    if (!dimensions) return;
    const x = Math.min(dimensions.width - 1, Math.max(0, Math.round(next.x)));
    const y = Math.min(dimensions.height - 1, Math.max(0, Math.round(next.y)));
    setCrop({ x, y, width: Math.max(1, Math.min(dimensions.width - x, Math.round(next.width))), height: Math.max(1, Math.min(dimensions.height - y, Math.round(next.height))) });
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Content className="image-canvas-small-dialog" aria-describedby={undefined} onEscapeKeyDown={event => { event.preventDefault(); onClose(); }}>
      <header className="ic-dialog-heading"><Dialog.Title>裁剪图片</Dialog.Title><button className="ic-icon" aria-label="关闭裁剪" onClick={onClose}><X /></button></header>
      <div className="ic-crop-area" ref={area} style={{ width: dimensions ? Math.min(494, 330 * dimensions.width / dimensions.height) : 440,
        aspectRatio: dimensions ? `${dimensions.width} / ${dimensions.height}` : "4 / 3" }}
        onPointerMove={event => {
          if (!drag.current || !dimensions) return;
          const bounds = area.current!.getBoundingClientRect();
          const dx = (event.clientX - drag.current.x) / bounds.width * dimensions.width;
          const dy = (event.clientY - drag.current.y) / bounds.height * dimensions.height;
          const original = drag.current.crop;
          update(drag.current.resize ? { ...original, width: original.width + dx, height: original.height + dy }
            : { ...original, x: Math.max(0, Math.min(dimensions.width - original.width, original.x + dx)), y: Math.max(0, Math.min(dimensions.height - original.height, original.y + dy)) });
        }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        <canvas ref={canvas} />
        {dimensions && <div className="ic-crop-selection" style={{ left: `${crop.x / dimensions.width * 100}%`, top: `${crop.y / dimensions.height * 100}%`, width: `${crop.width / dimensions.width * 100}%`, height: `${crop.height / dimensions.height * 100}%` }}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, crop, resize: false }; }}>
          <button className="ic-crop-handle" aria-label="调整裁剪范围" onPointerDown={event => {
            event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, crop, resize: true };
          }} />
        </div>}
      </div>
      <div className="ic-crop-fields">{(["x", "y", "width", "height"] as const).map((key, index) => <label className="ic-number" key={key}>
        <span>{["X", "Y", "宽", "高"][index]}</span><input type="number" min={index < 2 ? 0 : 1} value={crop[key]} aria-label={`裁剪${["X 坐标", "Y 坐标", "宽度", "高度"][index]}`}
          onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) update({ ...crop, [key]: value }); }} /></label>)}</div>
      <div className="ic-presets">{[["1:1", 1], ["4:3", 4 / 3], ["16:9", 16 / 9]] .map(([label, ratio]) => <button key={label} onClick={() => {
        if (!dimensions) return;
        const width = Math.min(crop.width, crop.height * Number(ratio)), height = width / Number(ratio);
        update({ ...crop, width, height });
      }}>{label}</button>)}</div>
      <div className="ic-local-error" role={error ? "alert" : undefined}>{error}</div>
      <footer className="ic-dialog-actions"><button className="ic-button" disabled={!dimensions} onClick={() => setCrop({ x: 0, y: 0, ...dimensions! })}><RotateCcw />恢复原图</button>
        <button className="ic-primary" disabled={!dimensions || Boolean(error)} onClick={() => onApply(crop)}><Check />完成裁剪</button></footer>
    </Dialog.Content>
  </Dialog.Root>;
}
