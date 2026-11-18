import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme, Button, TextField } from "@radix-ui/themes";
import { Background, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, type Node, type NodeProps, type Viewport } from "@xyflow/react";
import type { WebviewTag } from "electron";
import "@radix-ui/themes/styles.css";
import "@xyflow/react/dist/style.css";
import "./prototype.css";

type Card = Node<{ url?: string; text?: string; interactive?: boolean; onTitle?: (title: string) => void; onError?: (error: string) => void }, "card">;
declare const __FIXTURE_URL__: string;

function CanvasCard({ data }: NodeProps<Card>) {
  const surface = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(data.url ? "网页预览" : "文本卡片");
  useEffect(() => {
    if (!data.url) return;
    const view = document.createElement("webview") as WebviewTag;
    view.setAttribute("partition", "canvas-prototype");
    view.src = data.url;
    const ready = () => { view.dataset.ready = "true"; };
    const updateTitle = (event: Electron.PageTitleUpdatedEvent) => { setTitle(event.title); data.onTitle?.(event.title); };
    const fail = (event: Electron.DidFailLoadEvent) => {
      if (event.errorCode !== -3) data.onError?.(`${event.errorDescription} (${event.errorCode})`);
    };
    view.addEventListener("page-title-updated", updateTitle);
    view.addEventListener("dom-ready", ready);
    view.addEventListener("did-fail-load", fail);
    surface.current!.appendChild(view);
    return () => {
      view.removeEventListener("page-title-updated", updateTitle);
      view.removeEventListener("dom-ready", ready);
      view.removeEventListener("did-fail-load", fail);
      view.remove();
    };
  }, [data.url, data.onTitle, data.onError]);
  return <div className={`prototype-card ${data.url ? "web-card" : "text-card"}`}>
    <div className="card-caption">{title}</div>
    {data.url ? <div ref={surface} className="web-surface" data-interactive={data.interactive} />
      : <article><h2>稳定缩放</h2><p>{data.text}</p><ul><li>固定排版宽度</li><li>容器统一缩放</li><li>边缘裁切</li></ul></article>}
  </div>;
}
const nodeTypes = { card: CanvasCard };
const zoomTransition = { duration: 250, ease: (progress: number) => 1 - (1 - progress) ** 3, interpolate: "linear" as const };

declare global {
  interface Window {
    canvasPrototype: { getViewport(): Viewport; setViewport(view: Viewport, options?: { duration: number }): Promise<boolean>; setInteractive(value: boolean): void };
  }
}

function Canvas() {
  const flow = useReactFlow<Card>();
  const canvas = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(__FIXTURE_URL__);
  const [error, setError] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [zoom, setZoom] = useState(0.8);
  const [nodes, setNodes, onNodesChange] = useNodesState<Card>([
    { id: "web", type: "card", position: { x: 60, y: 80 }, style: { width: 520, height: 520 },
      data: { url, onError: setError } },
    { id: "text", type: "card", position: { x: 640, y: 80 }, style: { width: 320, height: 300 },
      data: { text: "网页和文本使用同一画布变换。拖动空白区域平移，滚轮缩放。" } },
  ]);
  useEffect(() => {
    setNodes(current => current.map(node => node.id === "web" ? { ...node, data: { ...node.data, interactive } } : node));
  }, [interactive, setNodes]);
  useEffect(() => {
    window.canvasPrototype = { getViewport: flow.getViewport, setViewport: flow.setViewport, setInteractive };
    const area = canvas.current!;
    let lastWheel = 0, targetZoom = 0.8;
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || !event.deltaY || !(event.target instanceof Element) || event.target.closest("input,button")) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now(), view = flow.getViewport();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.clientHeight : 1);
      targetZoom = Math.max(0.1, Math.min(3, (now - lastWheel < 250 ? targetZoom : view.zoom) * 2 ** (-delta * 0.002)));
      lastWheel = now;
      const rect = area.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const scale = targetZoom / view.zoom;
      void flow.setViewport({ x: x - (x - view.x) * scale, y: y - (y - view.y) * scale, zoom: targetZoom }, zoomTransition);
    };
    area.addEventListener("wheel", wheel, { capture: true, passive: false });
    return () => area.removeEventListener("wheel", wheel, true);
  }, [flow]);
  function open() {
    try {
      const address = new URL(url.trim());
      if (!/^https?:$/.test(address.protocol)) throw Error("请输入 HTTP 或 HTTPS 地址");
      setError("");
      setNodes(current => current.map(node => node.id === "web" ? { ...node, data: { ...node.data, url: address.href } } : node));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <Theme accentColor="indigo" grayColor="slate" radius="small" className="prototype-shell">
    <header><strong>网页画布验证</strong><form onSubmit={event => { event.preventDefault(); open(); }}>
      <TextField.Root aria-label="网页地址" value={url} onChange={event => setUrl(event.target.value)} /><Button type="submit" variant="soft">打开</Button>
    </form><Button variant="soft" onClick={() => setInteractive(!interactive)}>{interactive ? "操作画布" : "浏览网页"}</Button>
      <Button variant="ghost" aria-label="缩小画布" onClick={() => void flow.zoomOut(zoomTransition)}>−</Button>
      <span className="zoom-value">{Math.round(zoom * 100)}%</span>
      <Button variant="ghost" aria-label="放大画布" onClick={() => void flow.zoomIn(zoomTransition)}>＋</Button>
      <Button variant="soft" onClick={() => void flow.fitView({ padding: 0.15, ...zoomTransition })}>适应</Button>
    </header>
    <div ref={canvas} className="prototype-canvas"><ReactFlow<Card> nodes={nodes} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
      defaultViewport={{ x: 80, y: 50, zoom: 0.8 }} minZoom={0.1} maxZoom={3}
      zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnDrag={[0, 1, 2]}
      onNodeDoubleClick={() => setInteractive(true)} onMove={(_event, view) => setZoom(view.zoom)}><Background gap={24} /></ReactFlow></div>
    <footer role="status">{error || (interactive ? "网页浏览" : "画布操作")}</footer>
  </Theme>;
}
createRoot(document.getElementById("root")!).render(<ReactFlowProvider><Canvas /></ReactFlowProvider>);
