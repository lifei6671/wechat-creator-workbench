import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import Konva from "konva";
import { Group, Layer, Rect, Stage, Transformer } from "react-konva";
import type { ImageLayer, ImageScene } from "../../../../packages/shared-types";
import { artboardRadius, backgroundNode, decodeResource, imageNode, type ImageResource } from "./renderer";
import { layerBounds, moveLayers, orientationTransform, sceneAssetIds, selectionBounds } from "./scene";
import type { ImageCanvasService } from "./service";

export interface Viewport { x: number; y: number; scale: number }
export interface WorkspaceHandle { fit(): void; showAll(): void; cancelGesture(): boolean; finishGesture(): void; zoom(scale: number): void; retryResources(): Promise<void> }
interface Props {
  scene: ImageScene;
  selected: string[];
  onSelect(ids: string[]): void;
  onChange(scene: ImageScene): void;
  service: ImageCanvasService;
  pan: boolean;
  locked: boolean;
  viewport: Viewport;
  onViewport(viewport: Viewport): void;
  onResourceError(error: string): void;
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : String(error);

export const CanvasWorkspace = forwardRef<WorkspaceHandle, Props>(function CanvasWorkspace(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<Konva.Stage>(null);
  const content = useRef<Konva.Group>(null);
  const background = useRef<Konva.Group>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const latest = useRef(props);
  latest.current = props;
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [resources, setResources] = useState(new Map<string, ImageResource>());
  const [failures, setFailures] = useState(new Map<string, string>());
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number }>();
  const pointerGesture = useRef<{ type: "pan" | "marquee"; start: { x: number; y: number }; viewport: Viewport; add: boolean }>(undefined);
  const nodeGesture = useRef<{ scene: ImageScene; selected: string[]; original: ImageLayer; nodes: Konva.Node[]; primary?: Konva.Node }>(undefined);
  const pressed = useRef(false);
  const clickChoice = useRef<string>(undefined);
  const deferredRebuild = useRef(false);
  const [sceneEpoch, setSceneEpoch] = useState(0);
  const cache = useRef(new Map<string, ImageResource>());
  const retired = useRef<Array<{ id: string; resource: ImageResource }>>([]);
  const pending = useRef(new Map<string, Promise<void>>());
  const mounted = useRef(true);
  const fitted = useRef(false);
  const [checker] = useState(() => {
    const pattern = document.createElement("canvas"); pattern.width = 16; pattern.height = 16;
    const context = pattern.getContext("2d")!;
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, 16, 16);
    context.fillStyle = "#e8e8ec"; context.fillRect(0, 0, 8, 8); context.fillRect(8, 8, 8, 8);
    const image = new Image(); image.src = pattern.toDataURL(); return image;
  });

  function fit() {
    const { scene, onViewport } = latest.current;
    const width = Math.max(100, size.width - (size.width < 850 ? 330 : 410));
    const height = Math.max(100, size.height - 210);
    const scale = Math.min(width / scene.artboard.width, height / scene.artboard.height, 1);
    onViewport({ scale, x: 90 + (width - scene.artboard.width * scale) / 2,
      y: 105 + (height - scene.artboard.height * scale) / 2 });
  }

  function showAll() {
    const { scene, onViewport } = latest.current;
    if (!scene.layers.length) { fit(); return; }
    const images = selectionBounds(scene.layers);
    const left = Math.min(0, images.x), top = Math.min(0, images.y);
    const width = Math.max(scene.artboard.width, images.x + images.width) - left;
    const height = Math.max(scene.artboard.height, images.y + images.height) - top;
    const availableWidth = Math.max(100, size.width - (size.width < 850 ? 330 : 410));
    const availableHeight = Math.max(100, size.height - 210);
    const scale = Math.min(availableWidth / width, availableHeight / height, 1);
    onViewport({ scale, x: 90 + (availableWidth - width * scale) / 2 - left * scale,
      y: 105 + (availableHeight - height * scale) / 2 - top * scale });
  }

  function refreshDeferred() {
    if (!pressed.current && !nodeGesture.current && deferredRebuild.current) {
      deferredRebuild.current = false;
      setSceneEpoch(value => value + 1);
    }
  }

  function endNodeGesture() {
    nodeGesture.current = undefined;
    pressed.current = false;
    clickChoice.current = undefined;
    refreshDeferred();
  }

  function zoom(scale: number) {
    const { viewport, onViewport } = latest.current;
    const next = Math.min(8, Math.max(0.02, scale));
    const center = { x: (size.width - 300) / 2, y: size.height / 2 };
    onViewport({ scale: next, x: center.x - (center.x - viewport.x) / viewport.scale * next,
      y: center.y - (center.y - viewport.y) / viewport.scale * next });
  }

  useImperativeHandle(ref, () => ({ fit, showAll, zoom, async retryResources() {
    const referenced = new Set(sceneAssetIds(latest.current.scene));
    for (const id of failures.keys()) if (referenced.has(id)) {
      const [bytes, asset] = await Promise.all([latest.current.service.readAsset(id), latest.current.service.infoAsset(id)]);
      const resource = await decodeResource(bytes, 2048, asset.orientation ?? 1, asset);
      const old = cache.current.get(id);
      if (old) retired.current.push({ id, resource: old });
      cache.current.set(id, resource);
      setResources(new Map(cache.current));
      setFailures(previous => { const next = new Map(previous); next.delete(id); return next; });
    }
  }, finishGesture() {
    const gesture = nodeGesture.current;
    if (!gesture) { finishPointer(); return; }
    endNodeGesture();
    const nodes = new Map(gesture.nodes.map(node => [node.id(), node]));
    const next = { ...gesture.scene, layout: { ...gesture.scene.layout, mode: "free" as const }, layers: gesture.scene.layers.map(layer => {
      const node = nodes.get(layer.id);
      return node ? { ...layer, x: node.x(), y: node.y(), width: layer.width * node.scaleX(), height: layer.height * node.scaleY(), rotation: node.rotation() } : layer;
    }) };
    for (const node of gesture.nodes) { node.stopDrag(); node.scale({ x: 1, y: 1 }); }
    transformer.current?.stopTransform();
    latest.current.onChange(next);
  }, cancelGesture() {
    const gesture = nodeGesture.current;
    if (gesture) {
      endNodeGesture();
      for (const node of gesture.nodes) {
        node.stopDrag();
        const original = gesture.scene.layers.find(layer => layer.id === node.id())!;
        node.setAttrs({ x: original.x, y: original.y, width: original.width, height: original.height, rotation: original.rotation, scaleX: 1, scaleY: 1 });
      }
      transformer.current?.stopTransform();
      transformer.current?.forceUpdate();
      return true;
    }
    if (pressed.current) { pressed.current = false; clickChoice.current = undefined; refreshDeferred(); return true; }
    if (!pointerGesture.current) return false;
    if (pointerGesture.current.type === "pan") props.onViewport(pointerGesture.current.viewport);
    pointerGesture.current = undefined;
    setMarquee(undefined);
    return true;
  } }));

  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (size.width > 1 && !fitted.current) { fitted.current = true; fit(); } }, [size]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      transformer.current?.nodes([]);
      content.current?.destroyChildren();
      background.current?.destroyChildren();
      for (const resource of cache.current.values()) resource.dispose();
      for (const value of retired.current) value.resource.dispose();
      retired.current = []; cache.current.clear();
    };
  }, []);

  const visible = { x: -props.viewport.x / props.viewport.scale - 200, y: -props.viewport.y / props.viewport.scale - 200,
    width: size.width / props.viewport.scale + 400, height: size.height / props.viewport.scale + 400 };
  const visibleIds = [...new Set([...props.scene.layers.filter(layer => props.selected.includes(layer.id) || intersects(layerBounds(layer), visible)).map(layer => layer.assetId),
    ...(props.scene.artboard.background.type === "image" ? [props.scene.artboard.background.assetId] : [])])];
  const qualityScale = 2 ** Math.ceil(Math.log2(props.viewport.scale * window.devicePixelRatio));
  function targetSize(id: string, width: number, height: number, orientation: ImageResource["orientation"] = 1) {
    const current = latest.current;
    const layers = current.scene.layers.filter(layer => layer.assetId === id);
    let ratio = Math.max(0, ...layers.map(layer => Math.max(layer.width / layer.crop.width, layer.height / layer.crop.height) * qualityScale));
    const { artboard } = current.scene;
    if (artboard.background.type === "image" && artboard.background.assetId === id) {
      const { displayWidth, displayHeight } = orientationTransform(width, height, orientation);
      const factor = artboard.background.fit === "cover" ? Math.max(artboard.width / displayWidth, artboard.height / displayHeight) : Math.min(artboard.width / displayWidth, artboard.height / displayHeight);
      ratio = Math.max(ratio, factor * qualityScale);
    }
    return Math.min(2048, Math.max(64, Math.ceil(Math.max(width, height) * ratio)));
  }
  const resourceKey = JSON.stringify([visibleIds, qualityScale, props.scene.layers.map(layer => [layer.assetId, layer.width, layer.height, layer.crop.width, layer.crop.height]),
    props.scene.artboard.width, props.scene.artboard.height, props.scene.artboard.background]);
  useEffect(() => {
    const needed = new Set(visibleIds);
    for (const [id, resource] of cache.current) if (!needed.has(id)) { retired.current.push({ id, resource }); cache.current.delete(id); }
    setResources(new Map(cache.current));
    for (const id of needed) {
      const cached = cache.current.get(id);
      if (pending.current.has(id) || cached && Math.max(cached.image.width, cached.image.height) >= Math.min(Math.max(cached.width, cached.height), targetSize(id, cached.width, cached.height, cached.orientation)) - 1) continue;
      const loading = Promise.all([props.service.readAsset(id), props.service.infoAsset(id)])
        .then(([bytes, asset]) => decodeResource(bytes, (width, height) => targetSize(id, width, height, asset.orientation), asset.orientation ?? 1, asset)).then(resource => {
        if (!mounted.current || !latest.current.scene.layers.some(layer => layer.assetId === id) && !(latest.current.scene.artboard.background.type === "image" && latest.current.scene.artboard.background.assetId === id)) {
          resource.dispose(); return;
        }
        const previous = cache.current.get(id);
        if (previous) retired.current.push({ id, resource: previous });
        cache.current.set(id, resource);
        setResources(new Map(cache.current));
        setFailures(previous => { const next = new Map(previous); next.delete(id); return next; });
      }, error => { if (mounted.current) setFailures(previous => new Map(previous).set(id, errorText(error))); })
        .finally(() => pending.current.delete(id));
      pending.current.set(id, loading);
    }
  }, [resourceKey, props.service]);
  useEffect(() => {
    const referenced = new Set(sceneAssetIds(props.scene));
    const active = [...failures].filter(([id]) => referenced.has(id));
    props.onResourceError(active.length ? `素材加载失败：${active.map(([, error]) => error).join("；")}` : "");
  }, [failures, props.onResourceError, props.scene]);

  useLayoutEffect(() => {
    const group = content.current;
    if (!group) return;
    if (nodeGesture.current || pressed.current) { deferredRebuild.current = true; return; }
    group.destroyChildren();
    background.current!.destroyChildren();
    const { scene, selected, pan, locked } = props;
    if (scene.artboard.background.type !== "image" || resources.has(scene.artboard.background.assetId)) background.current!.add(backgroundNode(scene, resources));
    for (const layer of scene.layers) {
      if (!intersects(layerBounds(layer), visible) && !selected.includes(layer.id)) continue;
      const loaded = resources.get(layer.assetId);
      const resource = loaded?.image.width ? loaded : undefined;
      const node = resource ? imageNode(layer, resource) : new Konva.Group({ ...layer, name: "image-layer" });
      if (!resource) {
        node.add(new Konva.Rect({ width: layer.width, height: layer.height, fill: "#f0f0f3", stroke: "#cdced6", strokeWidth: 0.5 / props.viewport.scale }));
        node.add(new Konva.Text({ text: failures.has(layer.assetId) ? "图片加载失败" : "正在载入图片…", fill: failures.has(layer.assetId) ? "#ce2c31" : "#60646c",
          fontSize: 14 / props.viewport.scale, width: layer.width, align: "center", y: layer.height / 2, listening: false }));
      }
      node.draggable(!pan && !locked && Boolean(resource));
      node.on("mousedown touchstart", event => {
        const current = latest.current;
        if (current.pan || current.locked || (event.evt instanceof MouseEvent && event.evt.button !== 0)) return;
        event.cancelBubble = true;
        pressed.current = true;
        clickChoice.current = layer.id;
        const shift = "shiftKey" in event.evt && event.evt.shiftKey;
        const ids = current.selected.includes(layer.id)
          ? shift ? current.selected.filter(id => id !== layer.id) : current.selected
          : shift ? [...current.selected, layer.id] : [layer.id];
        current.onSelect(ids);
        transformer.current?.nodes(group.getChildren().filter(child => ids.includes(child.id()) && resources.has(scene.layers.find(item => item.id === child.id())!.assetId)));
      });
      node.on("mouseup touchend", () => { pressed.current = false; refreshDeferred(); });
      node.on("click tap", event => {
        event.cancelBubble = true;
        const current = latest.current;
        const shift = "shiftKey" in event.evt && event.evt.shiftKey;
        if (clickChoice.current === layer.id && !shift && !current.pan && !current.locked) current.onSelect([layer.id]);
        clickChoice.current = undefined;
        pressed.current = false;
        refreshDeferred();
      });
      node.on("dragstart", () => {
        if (nodeGesture.current) return;
        const current = latest.current;
        const ids = current.selected.includes(layer.id) ? current.selected : [layer.id];
        current.onSelect(ids);
        clickChoice.current = undefined;
        nodeGesture.current = { scene: current.scene, selected: ids, original: layer, primary: node,
          nodes: group.getChildren().filter(child => ids.includes(child.id())) };
      });
      node.on("dragend", () => {
        const gesture = nodeGesture.current;
        if (!gesture || gesture.primary !== node) return;
        endNodeGesture();
        latest.current.onChange(moveLayers(gesture.scene, gesture.selected, node.x() - gesture.original.x, node.y() - gesture.original.y));
      });
      group.add(node);
    }
    const current = latest.current;
    const nodes = group.getChildren().filter(node => current.selected.includes(node.id()) && resources.has(scene.layers.find(layer => layer.id === node.id())!.assetId));
    transformer.current?.nodes(current.locked || current.pan ? [] : nodes);
    group.getLayer()?.batchDraw();
    retired.current = retired.current.filter(value => {
      if (resources.get(value.id) === value.resource) return true;
      value.resource.dispose(); return false;
    });
  }, [props.scene, resources, failures, props.viewport.x, props.viewport.y, props.viewport.scale, size, sceneEpoch]);

  useLayoutEffect(() => {
    if (nodeGesture.current || pressed.current) return;
    const nodes = content.current?.getChildren() ?? [];
    for (const node of nodes) if (node.hasName("image-layer")) node.draggable(!props.pan && !props.locked && resources.has(props.scene.layers.find(layer => layer.id === node.id())!.assetId));
    transformer.current?.nodes(props.locked || props.pan ? [] : nodes.filter(node => props.selected.includes(node.id()) && resources.has(props.scene.layers.find(layer => layer.id === node.id())!.assetId)));
  }, [props.selected, props.pan, props.locked, props.scene, resources]);

  function worldPoint(screen: { x: number; y: number }) {
    return { x: (screen.x - props.viewport.x) / props.viewport.scale, y: (screen.y - props.viewport.y) / props.viewport.scale };
  }

  function finishPointer() {
    pressed.current = false;
    refreshDeferred();
    const gesture = pointerGesture.current;
    if (!gesture) return;
    pointerGesture.current = undefined;
    if (gesture.type === "marquee" && marquee) {
      const ids = props.scene.layers.filter(layer => intersects(layerBounds(layer), marquee)).map(layer => layer.id);
      props.onSelect(gesture.add ? [...new Set([...props.selected, ...ids])] : ids);
    }
    setMarquee(undefined);
  }

  return <div className={`image-canvas-workspace${props.pan ? " is-panning" : ""}`} ref={container} onContextMenu={event => event.preventDefault()}>
    <Stage ref={stage} width={size.width} height={size.height} onWheel={event => {
      event.evt.preventDefault();
      if (props.locked || nodeGesture.current) return;
      const pointer = stage.current!.getPointerPosition()!;
      const point = worldPoint(pointer);
      const scale = Math.min(8, Math.max(0.02, props.viewport.scale * Math.exp(-event.evt.deltaY * (event.evt.ctrlKey ? -0.005 : 0.0015))));
      props.onViewport({ scale, x: pointer.x - point.x * scale, y: pointer.y - point.y * scale });
    }} onMouseDown={event => {
      if (props.locked || event.evt.button !== 0 && event.evt.button !== 1) return;
      if (event.target.findAncestor(".image-layer") && !props.pan && event.evt.button !== 1) return;
      const pointer = stage.current!.getPointerPosition()!;
      const pan = props.pan || event.evt.button === 1;
      pointerGesture.current = { type: pan ? "pan" : "marquee", start: pointer, viewport: props.viewport, add: event.evt.shiftKey };
      if (!pan && !event.evt.shiftKey) props.onSelect([]);
    }} onMouseMove={() => {
      const gesture = pointerGesture.current;
      if (!gesture) return;
      const pointer = stage.current!.getPointerPosition()!;
      if (gesture.type === "pan") props.onViewport({ ...gesture.viewport,
        x: gesture.viewport.x + pointer.x - gesture.start.x, y: gesture.viewport.y + pointer.y - gesture.start.y });
      else {
        const start = worldPoint(gesture.start), end = worldPoint(pointer);
        setMarquee({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) });
      }
    }} onMouseUp={finishPointer} onMouseLeave={finishPointer}>
      <Layer>
        <Group x={props.viewport.x} y={props.viewport.y} scaleX={props.viewport.scale} scaleY={props.viewport.scale}>
          <Rect width={props.scene.artboard.width} height={props.scene.artboard.height} cornerRadius={artboardRadius(props.scene)} fillPatternImage={checker} stroke="#cdced6" strokeWidth={0.5 / props.viewport.scale}
            shadowColor="#1c2024" shadowOpacity={0.08} shadowBlur={20} listening={false} />
          <Group ref={background} listening={false} />
          <Group ref={content} clipFunc={artboardRadius(props.scene) > 0 ? context => {
              const { x, y, scale } = props.viewport;
              context.beginPath();
              context.rect(-x / scale - 1, -y / scale - 1, size.width / scale + 2, size.height / scale + 2);
              context.rect(0, 0, props.scene.artboard.width, props.scene.artboard.height);
              context.roundRect(0, 0, props.scene.artboard.width, props.scene.artboard.height, artboardRadius(props.scene));
              return ["evenodd"];
            } : undefined} />
          {marquee && <Rect {...marquee} fill="#3e63dd19" stroke="#3e63dd" strokeWidth={0.5 / props.viewport.scale} listening={false} />}
          <Transformer ref={transformer} flipEnabled={false} rotateEnabled={true} keepRatio={true} borderStroke="#3e63dd" borderStrokeWidth={0.5}
            anchorFill="#ffffff" anchorStroke="#3e63dd" anchorStrokeWidth={0.5} anchorSize={8} anchorCornerRadius={4}
            boundBoxFunc={(oldBox, next) => Math.abs(next.width) < 4 || Math.abs(next.height) < 4 ? oldBox : next}
            onTransformStart={() => {
              const nodes = transformer.current!.nodes();
              nodeGesture.current = { scene: props.scene, selected: props.selected, original: props.scene.layers.find(layer => layer.id === nodes[0].id())!, nodes };
            }} onTransformEnd={() => {
              const gesture = nodeGesture.current;
              if (!gesture) return;
              endNodeGesture();
              const nodes = new Map(gesture.nodes.map(node => [node.id(), node]));
              props.onChange({ ...gesture.scene, layout: { ...gesture.scene.layout, mode: "free" }, layers: gesture.scene.layers.map(layer => {
                const node = nodes.get(layer.id);
                if (!node) return layer;
                const value = { ...layer, x: node.x(), y: node.y(), width: Math.max(1, layer.width * node.scaleX()), height: Math.max(1, layer.height * node.scaleY()), rotation: node.rotation() };
                node.scale({ x: 1, y: 1 });
                return value;
              }) });
            }} />
        </Group>
      </Layer>
    </Stage>
    <span className="image-canvas-board-caption" style={{ left: props.viewport.x, top: props.viewport.y + props.scene.artboard.height * props.viewport.scale + 12 }}>
      {props.scene.artboard.width} × {props.scene.artboard.height}
    </span>
  </div>;
});
