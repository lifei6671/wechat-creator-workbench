import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@radix-ui/themes";
import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowLeft, ArrowUpToLine, Check, Copy, Crop, Download, FlipHorizontal2, FlipVertical2,
  Grid2X2, Hand, Image as ImageIcon, Layers, LockKeyhole, Maximize, Minus, MousePointer2, Plus, Redo2, RotateCw, Rows2, Columns2,
  Trash2, Undo2, UnlockKeyhole, X } from "lucide-react";
import type { ImageBackground, ImageCanvasAsset, ImageExportOptions, ImageLayer, ImageProject, ImageScene, PreparedImageRender } from "../../../../packages/shared-types";
import { useButtonFeedback } from "../button-feedback";
import { errorMessage } from "../desktop";
import { AssetDialog } from "./AssetDialog";
import { CropDialog } from "./CropDialog";
import { CanvasWorkspace, type Viewport, type WorkspaceHandle } from "./CanvasWorkspace";
import { appendImages, cropLayer, layoutScene, MAX_LAYERS, moveLayers, reorderLayers, rotateSceneImage, selectionBounds, validateOutput, withPadding } from "./scene";
import { renderScene } from "./renderer";
import { ProjectSaveQueue, type ImageCanvasHandle, type ImageCanvasService } from "./service";
import "./image-canvas.css";

export type { ImageCanvasHandle, ImageCanvasService } from "./service";

export interface ImageCanvasEditorProps {
  project: ImageProject;
  service: ImageCanvasService;
  onApply(render: PreparedImageRender): Promise<void>;
  onClose(): void;
  onReady?(handle: ImageCanvasHandle | null): void;
  applyLabel?: string;
}

const gradientPresets = [
  { angle: 135, colors: ["#faf9fb", "#e6f4fe", "#c2e5ff", "#acd8fc"] },
  { angle: 135, colors: ["#fff7c2", "#ddf9f2", "#b8eae0", "#a1ded2"] },
  { angle: 45, colors: ["#ffefd6", "#ffd19a", "#ffc182", "#f5ae73"] },
  { angle: 135, colors: ["#f4f0fe", "#e1d9ff", "#c2b5f5", "#aa99ec"] },
  { angle: 45, colors: ["#ffdcd3", "#f5a898", "#ff977d", "#e54d2e"] },
  { angle: 135, colors: ["#c2e5ff", "#8ec8f6", "#5eb1ef", "#0d74ce"] },
  { angle: 135, colors: ["#a1ded2", "#53b9ab", "#0d9b8a", "#008573"] },
  { angle: 225, colors: ["#f3d673", "#e2a336", "#ab6400", "#7e451d"] },
  { angle: 135, colors: ["#c2b5f5", "#aa99ec", "#8e4ec6", "#664282"] },
  { angle: 135, colors: ["#53b9ab", "#008573", "#145750", "#0d3d38"] },
  { angle: 135, colors: ["#8da4ef", "#3e63dd", "#304384", "#182449"] },
  { angle: 90, colors: ["#60646c", "#43484e", "#272a2d", "#18191b"] },
].map(({ angle, colors }) => ({ type: "linear-gradient" as const, angle,
  stops: colors.map((color, index) => ({ offset: index / (colors.length - 1), color })) }));
const solidColors = ["#faf9fb", "#ffee9c", "#a1ded2", "#c2b5f5", "#5eb1ef", "#ec8e7b", "#008573", "#ab6400", "#8347b9", "#145750", "#304384", "#272a2d"];
const defaultSolidColor = solidColors[10];
const defaultGradient = gradientPresets[10];

function IconButton({ label, children, active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; active?: boolean }) {
  return <button type="button" className={`ic-icon${active ? " is-active" : ""}`} title={label} aria-label={label} aria-pressed={active} {...props}>{children}</button>;
}

function NumberField({ label, accessibleLabel, value, onChange, onFinish, min = 1, max = 16000 }: {
  label: string; accessibleLabel: string; value: number; onChange(value: number): void; onFinish(): void; min?: number; max?: number;
}) {
  return <label className="ic-number"><span>{label}</span><input aria-label={accessibleLabel} type="number" min={min} max={max} value={Math.round(value * 100) / 100}
    onBlur={onFinish} onChange={event => { const next = event.target.valueAsNumber; if (Number.isFinite(next) && next >= min && next <= max) onChange(next); }} /></label>;
}

function Slider({ label, value, text, max, step = 1, disabled, onChange, onFinish }: { label: string; value: number; text: string; max: number; step?: number; disabled?: boolean;
  onChange(value: number): void; onFinish(): void }) {
  return <label className="ic-slider"><span><span>{label}</span><output>{text}</output></span><input aria-label={label} type="range" min="0" max={max} step={step} value={value} disabled={disabled}
    style={{ "--ic-slider-progress": `${value / max * 100}%` } as React.CSSProperties}
    onChange={event => onChange(event.target.valueAsNumber)} onPointerUp={onFinish} onBlur={onFinish} /></label>;
}

export default function ImageCanvasEditor({ project, service, onApply, onClose, onReady, applyLabel = "应用到文章" }: ImageCanvasEditorProps) {
  const [scene, setScene] = useState(project.scene);
  const sceneRef = useRef(scene);
  const [selected, setSelected] = useState(project.scene.layers.length === 1 ? [project.scene.layers[0].id] : []);
  const [viewport, setViewport] = useState<Viewport>({ x: 100, y: 100, scale: 0.5 });
  const [tool, setTool] = useState<"select" | "pan">("select");
  const [space, setSpace] = useState(false);
  const [ratioLocked, setRatioLocked] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState("");
  const [inputError, setInputError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [busy, setBusy] = useState<string>();
  const [animated, setAnimated] = useState(Boolean(project.animatedInput));
  const [options, setOptions] = useState<ImageExportOptions>({ format: "webp", scale: 1, quality: 0.9, jpegBackground: "#ffffff" });
  const workspace = useRef<WorkspaceHandle>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const history = useRef<{ past: ImageScene[]; future: ImageScene[]; merge?: string }>({ past: [], future: [] });
  const saveQueue = useRef<ProjectSaveQueue>(undefined);
  const operation = useRef<Promise<unknown>>(undefined);
  const busyRef = useRef(false);
  const prepared = useRef<{ key: string; renderId: string; render?: PreparedImageRender }>(undefined);
  const fitAfterAdd = useRef(false);
  const feedback = useButtonFeedback();
  if (!saveQueue.current) saveQueue.current = new ProjectSaveQueue(project, service, (state, error) => {
    setSaveState(state);
    if (state === "error") setSaveError(errorMessage(error));
    else if (state === "saved") setSaveError("");
  });

  function endMerge() { history.current.merge = undefined; }

  function change(next: ImageScene, merge?: string) {
    try { validateOutput(next); } catch (error) { setInputError(errorMessage(error)); return; }
    if (next === sceneRef.current) return;
    setInputError("");
    if (!merge || history.current.merge !== merge) {
      history.current.past.push(sceneRef.current);
      if (history.current.past.length > 80) history.current.past.shift();
    }
    history.current.future = [];
    history.current.merge = merge;
    sceneRef.current = next;
    setScene(next);
    saveQueue.current!.set(next);
  }

  function undo(redo = false) {
    if (busyRef.current) return;
    workspace.current?.finishGesture();
    endMerge();
    const source = redo ? history.current.future : history.current.past;
    const target = redo ? history.current.past : history.current.future;
    const next = source.pop();
    if (!next) return;
    target.push(sceneRef.current);
    sceneRef.current = next; setScene(next); saveQueue.current!.set(next);
    setSelected(previous => previous.filter(id => next.layers.some(layer => layer.id === id)));
  }

  async function flushDraft() {
    workspace.current?.finishGesture();
    saveQueue.current!.set(sceneRef.current);
    await saveQueue.current!.flush();
  }

  useEffect(() => {
    onReady?.({ async flush() {
      workspace.current?.finishGesture();
      if (operation.current) await operation.current;
      await saveQueue.current!.flush();
    } });
    return () => { onReady?.(null); };
  }, [onReady]);
  useEffect(() => () => saveQueue.current?.dispose(), []);
  useLayoutEffect(() => { if (fitAfterAdd.current) { fitAfterAdd.current = false; workspace.current?.showAll(); } }, [scene]);

  async function run(key: string, task: () => Promise<unknown>) {
    if (busyRef.current || feedback.isLocked(key)) return;
    busyRef.current = true; setBusy(key); endMerge();
    const pending = feedback.run(key, task);
    operation.current = pending;
    try { return await pending; }
    finally { operation.current = undefined; busyRef.current = false; setBusy(undefined); }
  }

  function close() { void run("close", async () => { await flushDraft(); onClose(); }); }

  function patchLayers(patch: (layer: ImageLayer) => ImageLayer, merge?: string) {
    const ids = new Set(selected);
    change({ ...sceneRef.current, layers: sceneRef.current.layers.map(layer => ids.has(layer.id) ? patch(layer) : layer) }, merge);
  }

  function remove() {
    change({ ...sceneRef.current, layers: sceneRef.current.layers.filter(layer => !selected.includes(layer.id)) });
    setSelected([]);
  }

  function duplicate() {
    const additions = sceneRef.current.layers.filter(layer => selected.includes(layer.id)).map(layer => ({ ...layer, id: crypto.randomUUID(), x: layer.x + 24, y: layer.y + 24 }));
    if (sceneRef.current.layers.length + additions.length > MAX_LAYERS) { setInputError("每个画布最多添加 100 张图片"); return; }
    change({ ...sceneRef.current, layers: [...sceneRef.current.layers, ...additions] });
    setSelected(additions.map(layer => layer.id));
  }

  function addAssets(assets: ImageCanvasAsset[]) {
    const appended = appendImages(sceneRef.current, assets, selected);
    if (assets.some(asset => asset.animated)) setAnimated(true);
    fitAfterAdd.current = true;
    change(appended.scene);
    setSelected(appended.selected); setAddOpen(false);
  }

  function importFiles(files: File[]) {
    if (!files.length) return;
    void run("import", async () => {
      if (sceneRef.current.layers.length + files.length > MAX_LAYERS) throw new Error("每个画布最多添加 100 张图片");
      const assets: ImageCanvasAsset[] = [];
      for (const file of files) assets.push(await service.importImage(file));
      addAssets(assets);
      await flushDraft();
    });
  }

  const chosen = scene.layers.filter(layer => selected.includes(layer.id));
  const single = chosen.length === 1 ? chosen[0] : undefined;
  const multi = chosen.length > 1;
  const styleLayers = chosen.length ? chosen : scene.layers;
  const sample = styleLayers[0];
  const background = scene.artboard.background;
  const colorA = background.type === "solid" ? background.color : background.type === "linear-gradient" ? background.stops[0].color : defaultSolidColor;
  const colorB = background.type === "linear-gradient" ? background.stops[background.stops.length - 1].color : defaultGradient.stops[defaultGradient.stops.length - 1].color;

  function setBackground(value: ImageBackground, merge?: string) { change({ ...sceneRef.current, artboard: { ...sceneRef.current.artboard, background: value } }, merge); }

  function layout(mode: "horizontal" | "vertical" | "grid", patch: Partial<ImageScene["layout"]> = {}, merge?: string) {
    try {
      const current = sceneRef.current;
      change(layoutScene(current, selected, mode, patch), merge);
    } catch (error) { setInputError(errorMessage(error)); }
  }

  function layoutOption(patch: Partial<ImageScene["layout"]>, merge?: string) {
    if (sceneRef.current.layout.mode === "free") change({ ...sceneRef.current, layout: { ...sceneRef.current.layout, ...patch } }, merge);
    else layout(sceneRef.current.layout.mode, patch, merge);
  }

  function applyStyle(patch: (layer: ImageLayer) => ImageLayer, merge?: string) {
    const ids = new Set(styleLayers.map(layer => layer.id));
    change({ ...sceneRef.current, layers: sceneRef.current.layers.map(layer => ids.has(layer.id) ? patch(layer) : layer) }, merge);
  }

  async function output(action: "apply" | "copy" | "save") {
    await run(action, async () => {
      await flushDraft();
      const frozen = sceneRef.current;
      const key = JSON.stringify([frozen, options]);
      if (prepared.current?.key !== key) prepared.current = { key, renderId: crypto.randomUUID() };
      if (!prepared.current.render) {
        const bytes = await renderScene(frozen, options, service.readAsset, service.infoAsset);
        prepared.current.render = await service.prepareRender(project.id, saveQueue.current!.getVersion(), prepared.current.renderId, options, bytes);
      }
      const render = prepared.current.render;
      if (action === "apply") { await onApply(render); prepared.current = undefined; onClose(); }
      else {
        if (action === "copy") await service.copyImage(render.src);
        else if (!await service.saveImage(render.src)) return false;
        await service.commitRender(render.renderId);
        prepared.current = undefined;
      }
    });
  }

  const error = inputError || saveError || feedback.error() || resourceError;
  const stageStyle = { "--ic-view-scale": viewport.scale } as React.CSSProperties;

  return <Dialog.Root open onOpenChange={open => { if (!open && !busyRef.current) close(); }}>
    <Dialog.Content className="image-canvas-dialog" aria-describedby={undefined} style={{ maxWidth: "none", width: "100vw", height: "100dvh", padding: 0 }}
      onEscapeKeyDown={event => { event.preventDefault(); if (cropOpen || addOpen || busyRef.current) return; if (!workspace.current?.cancelGesture()) close(); }}
      onPointerDownOutside={event => event.preventDefault()} onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey) return;
        if ((event.target as HTMLElement).closest("input,select,textarea,[contenteditable=true]")) return;
        const command = event.ctrlKey || event.metaKey;
        if (event.key === " " && !event.repeat) { event.preventDefault(); setSpace(true); }
        if (busyRef.current || cropOpen || addOpen) return;
        if (command && event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey); }
        else if (command && event.key.toLowerCase() === "y") { event.preventDefault(); undo(true); }
        else if (command && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(scene.layers.map(layer => layer.id)); }
        else if (command && event.key.toLowerCase() === "d") { event.preventDefault(); duplicate(); }
        else if (command && event.key.toLowerCase() === "c") { event.preventDefault(); void output("copy"); }
        else if (command && event.key.toLowerCase() === "s") { event.preventDefault(); void run("draft", flushDraft); }
        else if ((event.key === "Delete" || event.key === "Backspace") && selected.length) { event.preventDefault(); remove(); }
        else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selected.length) {
          event.preventDefault(); const delta = event.shiftKey ? 10 : 1;
          change(moveLayers(sceneRef.current, selected, event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0,
            event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0), "nudge");
        }
      }} onKeyUp={event => { event.stopPropagation(); if (event.key === " ") setSpace(false); if (event.key.startsWith("Arrow")) endMerge(); }}
      onPaste={event => {
        if ((event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
        event.stopPropagation(); const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
        if (files.length) { event.preventDefault(); importFiles(files); }
      }} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={event => {
        event.preventDefault(); event.stopPropagation(); if (!busyRef.current) importFiles(Array.from(event.dataTransfer.files).filter(file => file.type.startsWith("image/")));
      }}>
      <main className="image-canvas-app" style={stageStyle}>
        <CanvasWorkspace ref={workspace} scene={scene} selected={selected} onSelect={setSelected} onChange={change} service={service}
          pan={tool === "pan" || space} locked={Boolean(busy)} viewport={viewport} onViewport={setViewport} onResourceError={setResourceError} />
        <header className="ic-document-bar ic-floating">
          <button type="button" className="ic-document-back" aria-label="返回正文" disabled={Boolean(busy)} onClick={close}
            onKeyDown={event => { if (event.key === " ") event.stopPropagation(); }} />
          <span className="ic-document-back-icon" aria-hidden="true">{feedback.icon("close", <ArrowLeft />)}</span>
          <Dialog.Title trim="normal" mb="0">编辑图片</Dialog.Title>
        </header>
        <div className="ic-view-bar ic-floating" role="toolbar" aria-label="画布视图">
          <IconButton label="撤销" disabled={Boolean(busy) || !history.current.past.length} onClick={() => undo()}><Undo2 /></IconButton>
          <IconButton label="重做" disabled={Boolean(busy) || !history.current.future.length} onClick={() => undo(true)}><Redo2 /></IconButton><span className="ic-divider" />
          <IconButton label="缩小" disabled={Boolean(busy)} onClick={() => workspace.current!.zoom(viewport.scale / 1.2)}><Minus /></IconButton>
          <button className="ic-zoom-value" title="恢复 100%" disabled={Boolean(busy)} onClick={() => workspace.current!.zoom(1)}>{Math.round(viewport.scale * 100)}%</button>
          <IconButton label="放大" disabled={Boolean(busy)} onClick={() => workspace.current!.zoom(viewport.scale * 1.2)}><Plus /></IconButton>
          <IconButton label="适应画板" disabled={Boolean(busy)} onClick={() => workspace.current!.fit()}><Maximize /></IconButton><span className="ic-divider" />
          <IconButton label="全选图片" disabled={Boolean(busy)} onClick={() => setSelected(scene.layers.map(layer => layer.id))}><Grid2X2 /></IconButton>
        </div>
        <nav className="ic-tool-rail ic-floating" aria-label="画布工具">
          <IconButton label="选择工具" active={tool === "select" && !space} onClick={() => setTool("select")}><MousePointer2 /></IconButton>
          <IconButton label="平移画布" active={tool === "pan" || space} onClick={() => setTool("pan")}><Hand /></IconButton><span className="ic-rail-divider" />
          <IconButton label="添加图片" disabled={Boolean(busy)} onClick={() => setAddOpen(true)}><Plus /></IconButton>
          <IconButton label="画板与背景" active={!selected.length} disabled={Boolean(busy)} onClick={() => setSelected([])}><ImageIcon /></IconButton>
          <IconButton label="图层列表" active={layersOpen} aria-expanded={layersOpen} onClick={() => setLayersOpen(value => !value)}><Layers /></IconButton>
        </nav>
        <aside className="ic-inspector ic-floating" aria-label="属性面板">
          <div className="ic-inspector-heading"><span className="ic-context-icon">{multi ? <Layers /> : single ? <ImageIcon /> : <Maximize />}</span>
            <div className="ic-context-title"><h2>{multi ? "多张图片" : single ? "图片" : "画板"}</h2><span>{multi ? `已选择 ${chosen.length} 张` : single ? `图片 ${scene.layers.indexOf(single) + 1}` : `${scene.artboard.width} × ${scene.artboard.height} px`}</span></div>
            <IconButton label="画板设置" disabled={Boolean(busy)} onClick={() => setSelected([])}><Maximize /></IconButton>
          </div>
          <div className="ic-panel-scroll"><fieldset className="ic-panel-fields" disabled={Boolean(busy)}>
            {single && <section className="ic-section"><div className="ic-section-title"><h3>图片尺寸</h3><span className="ic-muted">{Math.round(single.crop.width)} × {Math.round(single.crop.height)}</span></div>
              <div className="ic-dimensions"><NumberField label="宽" accessibleLabel="图片宽度" value={single.width} onFinish={endMerge} onChange={value => patchLayers(layer => ({ ...layer, width: value, height: ratioLocked ? value * layer.height / layer.width : layer.height }), "width")} />
                <IconButton label={ratioLocked ? "解除比例锁定" : "锁定比例"} active={ratioLocked} onClick={() => setRatioLocked(value => !value)}>{ratioLocked ? <LockKeyhole /> : <UnlockKeyhole />}</IconButton>
                <NumberField label="高" accessibleLabel="图片高度" value={single.height} onFinish={endMerge} onChange={value => patchLayers(layer => ({ ...layer, height: value, width: ratioLocked ? value * layer.width / layer.height : layer.width }), "height")} /></div>
              <div className="ic-presets">{[25, 50, 75, 100].map(value => <button key={value} onClick={() => patchLayers(layer => ({ ...layer, width: layer.crop.width * value / 100, height: layer.crop.height * value / 100 }))}>{value}%</button>)}</div>
              <Slider label="不透明度" value={single.opacity * 100} text={`${Math.round(single.opacity * 100)}%`} max={100} onFinish={endMerge} onChange={value => patchLayers(layer => ({ ...layer, opacity: value / 100 }), "opacity")} />
            </section>}
            {multi && <section className="ic-section"><div className="ic-section-title"><h3>拼接布局</h3></div><div className="ic-layout-grid">
              {(["horizontal", "vertical", "grid"] as const).map((mode, index) => <button key={mode} aria-pressed={scene.layout.mode === mode} onClick={() => layout(mode)}>{[<Columns2 key="h" />, <Rows2 key="v" />, <Grid2X2 key="g" />][index]}{["横向", "纵向", "宫格"][index]}</button>)}</div>
              <label className="ic-field-line"><span>统一尺寸</span><input aria-label="拼接统一尺寸" type="number" min="1" max="16000" value={Math.round(scene.layout.size) || ""} placeholder="以较小图片为准" onBlur={endMerge}
                onChange={event => { const size = event.target.valueAsNumber; if (size > 0 && size <= 16000) layoutOption({ size }, "layout-size"); }} /></label>
              {scene.layout.mode === "grid" && <><label className="ic-field-line"><span>列数</span><input aria-label="宫格列数" type="number" min="1" max={chosen.length} value={scene.layout.columns} onChange={event => { const columns = event.target.valueAsNumber; if (Number.isInteger(columns) && columns > 0 && columns <= 100) layoutOption({ columns }); }} /></label>
                <label className="ic-field-line"><span>对齐</span><select aria-label="宫格对齐" value={scene.layout.align} onChange={event => layoutOption({ align: event.target.value as ImageScene["layout"]["align"] })}><option value="start">顶部</option><option value="center">居中</option><option value="end">底部</option></select></label></>}
              <Slider label="图片间距" value={scene.layout.gap} text={`${scene.layout.gap} px`} max={200} onFinish={endMerge} onChange={gap => layoutOption({ gap }, "gap")} />
            </section>}
            {!chosen.length && <section className="ic-section"><div className="ic-section-title"><h3>画板尺寸</h3></div><div className="ic-dimensions">
              <NumberField label="宽" accessibleLabel="画板宽度" value={scene.artboard.width} onFinish={endMerge} onChange={width => change({ ...sceneRef.current, artboard: { ...sceneRef.current.artboard, width: Math.round(width) } }, "board-width")} /><span className="ic-muted">×</span>
              <NumberField label="高" accessibleLabel="画板高度" value={scene.artboard.height} onFinish={endMerge} onChange={height => change({ ...sceneRef.current, artboard: { ...sceneRef.current.artboard, height: Math.round(height) } }, "board-height")} /></div>
              <div className="ic-presets">{[["1:1", 1], ["4:3", 4 / 3], ["16:9", 16 / 9], ["3:4", 3 / 4]].map(([label, ratio]) => <button key={label} onClick={() => change({ ...sceneRef.current, artboard: { ...sceneRef.current.artboard, height: Math.max(1, Math.round(sceneRef.current.artboard.width / Number(ratio))) } })}>{label}</button>)}</div>
            </section>}
            <section className="ic-section"><div className="ic-section-title"><h3>背景</h3><button className="ic-text-button" {...feedback.props("background", Boolean(busy))} onClick={() => backgroundInput.current!.click()}>{feedback.label("background", "自选图片", "已添加")}{feedback.icon("background", <Plus />)}</button></div>
              <div className="ic-segmented" aria-label="背景类型"><button aria-pressed={background.type === "solid"} onClick={() => setBackground({ type: "solid", color: colorA })}>纯色</button>
                <button aria-pressed={background.type === "linear-gradient"} onClick={() => { if (background.type !== "linear-gradient") setBackground(defaultGradient); }}>渐变</button>
                <button aria-pressed={background.type === "image"} onClick={() => backgroundInput.current!.click()}>壁纸</button><button aria-pressed={background.type === "transparent"} onClick={() => setBackground({ type: "transparent" })}>透明</button></div>
              {background.type === "solid" && <div className="ic-background-presets">{solidColors.map(color => <button key={color} className="ic-background-preset" style={{ background: color }} title={color} aria-label={`背景颜色 ${color}`} aria-pressed={background.color === color} onClick={() => setBackground({ type: "solid", color })} />)}</div>}
              {background.type === "linear-gradient" && <div className="ic-background-presets">{gradientPresets.map((preset, index) => <button key={index} className="ic-background-preset"
                style={{ background: `linear-gradient(${preset.angle}deg,${preset.stops.map(stop => `${stop.color} ${stop.offset * 100}%`).join(",")})` }}
                aria-label={`渐变背景 ${preset.stops.map(stop => stop.color).join(" ")} ${preset.angle}°`}
                aria-pressed={background.angle === preset.angle && background.stops.length === preset.stops.length && background.stops.every((stop, i) => stop.color === preset.stops[i].color && stop.offset === preset.stops[i].offset)}
                onClick={() => setBackground(preset)} />)}</div>}
              {(background.type === "solid" || background.type === "linear-gradient") && <div className="ic-color-fields"><label className="ic-color-field"><input type="color" aria-label="背景起始颜色" style={{ backgroundColor: colorA }} value={colorA.slice(0, 7)} onBlur={endMerge} onChange={event => setBackground(background.type === "solid" ? { type: "solid", color: event.target.value } : { ...background, stops: background.stops.map((stop, index) => index === 0 ? { ...stop, color: event.target.value } : stop) }, "color-a")} /><span>{colorA.slice(0, 7)}</span></label>
                {background.type === "linear-gradient" && <label className="ic-color-field"><input type="color" aria-label="背景结束颜色" style={{ backgroundColor: colorB }} value={colorB.slice(0, 7)} onBlur={endMerge} onChange={event => setBackground({ ...background, stops: background.stops.map((stop, index) => index === background.stops.length - 1 ? { ...stop, color: event.target.value } : stop) }, "color-b")} /><span>{colorB.slice(0, 7)}</span></label>}</div>}
              {background.type === "linear-gradient" && <Slider label="渐变方向" value={background.angle} text={`${background.angle}°`} max={360} onFinish={endMerge} onChange={angle => setBackground({ ...background, angle }, "gradient-angle")} />}
              {background.type === "image" && <label className="ic-field-line ic-background-fit"><span>铺放</span><select aria-label="背景图片铺放" value={background.fit} onChange={event => setBackground({ ...background, fit: event.target.value as "cover" | "contain" })}><option value="cover">填满画板</option><option value="contain">完整显示</option></select></label>}
            </section>
            <section className="ic-section ic-style-section"><Slider label="四周留白" value={scene.layout.padding} text={`${scene.layout.padding} px`} max={300} onFinish={endMerge} onChange={padding => { try { change(withPadding(sceneRef.current, padding), "padding"); } catch (failure) { setInputError(errorMessage(failure)); } }} />
              <Slider label="圆角" value={chosen.length ? sample!.cornerRadius : scene.artboard.cornerRadius ?? 0}
                text={`${Math.round(chosen.length ? sample!.cornerRadius : scene.artboard.cornerRadius ?? 0)} px`} max={100} onFinish={endMerge}
                onChange={cornerRadius => chosen.length ? applyStyle(layer => ({ ...layer, cornerRadius }), "radius")
                  : change({ ...sceneRef.current, artboard: { ...sceneRef.current.artboard, cornerRadius } }, "board-radius")} />
              <Slider label="阴影" value={(sample?.shadow.opacity ?? 0) * 100} text={`${Math.round((sample?.shadow.opacity ?? 0) * 100)}%`} max={80} onFinish={endMerge} onChange={value => applyStyle(layer => ({ ...layer, shadow: { ...layer.shadow, opacity: value / 100, blur: Math.max(24, layer.shadow.blur) } }), "shadow")} /></section>
            {chosen.length > 0 && <details className="ic-section ic-advanced"><summary>位置与层级<Plus /></summary><div className="ic-advanced-body">
              <div className="ic-dimensions"><NumberField label="X" accessibleLabel="图片 X 坐标" value={single?.x ?? selectionBounds(chosen).x} min={-16000} max={32000} onFinish={endMerge} onChange={value => change(moveLayers(sceneRef.current, selected, value - (single?.x ?? selectionBounds(chosen).x), 0), "position-x")} />
                <NumberField label="Y" accessibleLabel="图片 Y 坐标" value={single?.y ?? selectionBounds(chosen).y} min={-16000} max={32000} onFinish={endMerge} onChange={value => change(moveLayers(sceneRef.current, selected, 0, value - (single?.y ?? selectionBounds(chosen).y)), "position-y")} /></div>
              {single && <div className="ic-field-line ic-rotation"><span>旋转</span><input type="number" aria-label="图片旋转角度" min="-360" max="360" value={Math.round(single.rotation * 100) / 100} onBlur={endMerge}
                onChange={event => { const rotation = event.target.valueAsNumber; if (Number.isFinite(rotation) && rotation >= -360 && rotation <= 360) change(rotateSceneImage(sceneRef.current, single.id, rotation), "rotation"); }} />
                <IconButton label="垂直翻转" active={single.flipY} onClick={() => patchLayers(layer => ({ ...layer, flipY: !layer.flipY }))}><FlipVertical2 /></IconButton></div>}
              <div className="ic-alignment">{["left", "center", "right"].map((align, index) => <IconButton key={align} label={["左对齐", "水平居中", "右对齐"][index]} onClick={() => {
                const bounds = selectionBounds(chosen); const x = align === "left" ? scene.layout.padding : align === "center" ? (scene.artboard.width - bounds.width) / 2 : scene.artboard.width - scene.layout.padding - bounds.width;
                change(moveLayers(sceneRef.current, selected, x - bounds.x, 0));
              }}>{[<AlignLeft key="l" />, <AlignCenter key="c" />, <AlignRight key="r" />][index]}</IconButton>)}<span className="ic-divider" />
                <IconButton label="下移一层" onClick={() => change(reorderLayers(sceneRef.current, selected, "down"))}><ArrowDownToLine /></IconButton><IconButton label="上移一层" onClick={() => change(reorderLayers(sceneRef.current, selected, "up"))}><ArrowUpToLine /></IconButton></div>
            </div></details>}
          </fieldset></div>
          <footer className="ic-export-panel"><div className="ic-export-options"><div className="ic-segmented" aria-label="导出格式">{(["png", "jpeg", "webp"] as const).map((format, index) => <button key={format} disabled={Boolean(busy)} aria-pressed={options.format === format} onClick={() => setOptions(current => ({ ...current, format }))}>{["PNG", "JPG", "WebP"][index]}</button>)}</div>
              <select aria-label="导出倍率" value={options.scale} disabled={Boolean(busy)} onChange={event => setOptions(current => ({ ...current, scale: Number(event.target.value) as 1 | 2 }))}><option value="1">1×</option><option value="2">2×</option></select></div>
            {options.format !== "png" && <Slider label="画质" value={options.quality * 100} text={`${Math.round(options.quality * 100)}%`} max={100} step={1} disabled={Boolean(busy)} onFinish={() => {}} onChange={value => setOptions(current => ({ ...current, quality: Math.max(0.01, value / 100) }))} />}
            {options.format === "jpeg" && <label className="ic-jpeg-fill"><span>透明区域底色</span><input type="color" aria-label="JPEG 透明区域底色" style={{ backgroundColor: options.jpegBackground }} value={options.jpegBackground} disabled={Boolean(busy)} onChange={event => setOptions(current => ({ ...current, jpegBackground: event.target.value }))} /></label>}
            <div className="ic-export-bottom"><span>{scene.artboard.width * options.scale} × {scene.artboard.height * options.scale} px</span><div>
              <IconButton label={feedback.status("copy") === "success" ? "已复制" : "复制成品"} {...feedback.props("copy", Boolean(busy))} onClick={() => void output("copy")}>{feedback.icon("copy", <Copy />)}</IconButton>
              <IconButton label={feedback.status("save") === "success" ? "已保存" : "另存为图片"} {...feedback.props("save", Boolean(busy))} onClick={() => void output("save")}>{feedback.icon("save", <Download />)}</IconButton></div></div>
          </footer>
        </aside>
        <div className="ic-selection-dock ic-floating" role="toolbar" aria-label="选中内容操作">
          {single && <div className="ic-dock-group"><button className="ic-dock-action" disabled={Boolean(busy)} onClick={() => setCropOpen(true)}><Crop />裁剪</button>
            <IconButton label="向右旋转" disabled={Boolean(busy)} onClick={() => change(rotateSceneImage(sceneRef.current, single.id, (single.rotation + 90) % 360))}><RotateCw /></IconButton>
            <IconButton label="水平翻转" disabled={Boolean(busy)} active={single.flipX} onClick={() => patchLayers(layer => ({ ...layer, flipX: !layer.flipX }))}><FlipHorizontal2 /></IconButton></div>}
          {multi && <div className="ic-dock-group">{(["horizontal", "vertical", "grid"] as const).map((mode, index) => <button className="ic-dock-action" key={mode} aria-pressed={scene.layout.mode === mode} disabled={Boolean(busy)} onClick={() => layout(mode)}>{[<Columns2 key="h" />, <Rows2 key="v" />, <Grid2X2 key="g" />][index]}{["横向", "纵向", "宫格"][index]}</button>)}
            <IconButton label="自由摆放" active={scene.layout.mode === "free"} disabled={Boolean(busy)} onClick={() => change({ ...sceneRef.current, layout: { ...sceneRef.current.layout, mode: "free" } })}><MousePointer2 /></IconButton></div>}
          {!chosen.length && <button className="ic-dock-action" disabled={Boolean(busy)} onClick={() => setAddOpen(true)}><Plus />添加图片</button>}
          {chosen.length > 0 && <><span className="ic-divider ic-selection-divider" /><IconButton label="复制一份" disabled={Boolean(busy)} onClick={duplicate}><Copy /></IconButton><IconButton label="删除选中图片" disabled={Boolean(busy)} onClick={remove}><Trash2 /></IconButton></>}
          <span className="ic-divider" /><button className="ic-primary ic-apply" {...feedback.props("apply", Boolean(busy) || Boolean(resourceError))} onClick={() => void output("apply")}>{feedback.icon("apply", <Check />)}{feedback.label("apply", applyLabel, "已应用")}</button>
        </div>
        <button className="ic-save-status" data-state={saveState} {...feedback.props("draft", Boolean(busy))} onClick={() => void run("draft", flushDraft)}>
          <span className="ic-status-dot" /><span role="status">{saveState === "saving" ? "正在保存草稿" : saveState === "pending" ? "草稿待保存" : saveState === "error" ? "保存失败，点击重试" : "草稿已保存"}</span>
        </button>
        {animated && <span className="ic-animation-note">动图使用第一帧</span>}
        <div className="ic-error" tabIndex={error ? 0 : -1} role={error ? "alert" : undefined}><span>{error}</span>{resourceError && <button className="ic-retry-resources" {...feedback.props("resources", Boolean(busy))}
          onClick={() => void run("resources", () => workspace.current!.retryResources())}>{feedback.icon("resources", <Redo2 />)}{feedback.label("resources", "重试素材", "已载入")}</button>}</div>
        {layersOpen && <aside className="ic-layers-popover ic-floating" aria-label="图层列表"><header><h3>图层</h3><IconButton label="关闭图层列表" onClick={() => setLayersOpen(false)}><X /></IconButton></header>
          <div className="ic-layers-list">{[...scene.layers].reverse().map(layer => <button key={layer.id} className="ic-layer-row" aria-pressed={selected.includes(layer.id)} disabled={Boolean(busy)} onClick={event => setSelected(event.shiftKey ? selected.includes(layer.id) ? selected.filter(id => id !== layer.id) : [...selected, layer.id] : [layer.id])}>
            <ImageIcon /><span>图片 {scene.layers.indexOf(layer) + 1}</span><small>{Math.round(layer.width)} × {Math.round(layer.height)}</small></button>)}</div>
          <div className="ic-layer-order"><button disabled={Boolean(busy) || !chosen.length} onClick={() => change(reorderLayers(sceneRef.current, selected, "front"))}>移到顶层</button><button disabled={Boolean(busy) || !chosen.length} onClick={() => change(reorderLayers(sceneRef.current, selected, "back"))}>移到底层</button></div>
        </aside>}
        <input ref={backgroundInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file) void run("background", async () => { const asset = await service.importImage(file); if (asset.animated) setAnimated(true); setBackground({ type: "image", assetId: asset.id, fit: "cover" }); await flushDraft(); });
        }} />
      </main>
      {addOpen && <AssetDialog service={service} busy={Boolean(busy)} error={feedback.error("import")} onClose={() => setAddOpen(false)} onFiles={importFiles} onAdd={assets => { void run("import", async () => {
        const details: ImageCanvasAsset[] = [];
        for (const asset of assets) details.push(await service.infoAsset(asset.id));
        addAssets(details); await flushDraft();
      }); }} />}
      {cropOpen && single && <CropDialog layer={single} service={service} onClose={() => setCropOpen(false)} onApply={crop => { patchLayers(layer => cropLayer(layer, crop)); setCropOpen(false); }} />}
    </Dialog.Content>
  </Dialog.Root>;
}
