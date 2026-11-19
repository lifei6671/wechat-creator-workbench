// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import type { Edge, EdgeChange, NodeChange, NodeProps } from "@xyflow/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { CanvasEdge, CanvasNode, Collection } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { CollectionCanvas, type CollectionCanvasHandle } from "./CollectionCanvas";
import { useCanvasWebPreview } from "./CanvasWebPreview";
import { CanvasPreviewCache } from "./CanvasPreviewCache";
import type { FlowNode } from "./CollectionNodes";

const viewportControl = vi.hoisted(() => ({
  get: vi.fn(() => ({ x: 12, y: 24, zoom: 1 })),
  set: vi.fn(async (_view: { x: number; y: number; zoom: number }, _options: { duration: number }) => true),
}));
const flowEvents = vi.hoisted(() => ({ nodes: (_changes: NodeChange<FlowNode>[]) => {} }));

vi.mock("@xyflow/react", async importOriginal => {
  const flow = await importOriginal<typeof import("@xyflow/react")>();
  const controls = { viewportInitialized: false, screenToFlowPosition: (point: { x: number; y: number }) => point,
    getViewport: viewportControl.get, setViewport: viewportControl.set };
  return { ...flow, useReactFlow: () => controls, useStore: () => 1,
    Background: () => null, Handle: () => null, NodeResizer: () => null, NodeToolbar: () => null,
    ReactFlow: ({ nodes, edges, nodeTypes, onPaneClick, onNodesChange, onEdgesChange, onNodeClick }: {
      nodes: FlowNode[];
      edges: Edge[];
      nodeTypes: { card: React.ComponentType<Pick<NodeProps<FlowNode>, "id" | "data" | "selected" | "width" | "height">> };
      onPaneClick(event: React.MouseEvent<HTMLButtonElement>): void;
      onNodesChange(changes: NodeChange<FlowNode>[]): void;
      onEdgesChange(changes: EdgeChange[]): void;
      onNodeClick(event: React.MouseEvent): void;
    }) => {
      flowEvents.nodes = onNodesChange;
      return <div><button type="button" onClick={onPaneClick}>空白画布</button>{nodes.map(node =>
      <div key={node.id} data-node={node.id} onClick={event => {
        onNodesChange(nodes.flatMap(item => {
          const selected = item.id === node.id ? !(event.ctrlKey && node.selected) : Boolean(event.ctrlKey && item.selected);
          return selected === Boolean(item.selected) ? [] : [{ type: "select", id: item.id, selected }];
        }));
        onNodeClick(event);
      }}>
        <nodeTypes.card id={node.id} data={node.data} selected={node.selected ?? false} width={node.width} height={node.height} />
      </div>)}{edges.map(edge => <button key={edge.id} data-edge={edge.id} onClick={() => {
        onEdgesChange([{ type: "select", id: edge.id, selected: true }]);
      }}>{edge.id}</button>)}</div>;
    },
  };
});

vi.mock("../../../../packages/editor-react", async importOriginal => {
  const { useLayoutEffect, useRef } = await import("react");
  const editor = await importOriginal<typeof import("../../../../packages/editor-react")>();
  return { ...editor, MarkdownEditor: ({ entryId, value, ref, onDocumentChanged, onBlur }: React.ComponentProps<typeof editor.MarkdownEditor>) => {
    const state = useRef({ markdown: value, localRevision: 0 });
    const element = useRef<HTMLDivElement>(null);
    const pending = useRef<Promise<unknown>>(undefined);
    useLayoutEffect(() => {
      const handle = {
        focus: () => element.current?.focus(), captureMarkdown: () => state.current, pendingEdits: () => pending.current,
        clipboard: (action, io) => {
          if (action !== "paste") return false;
          pending.current = io.read().then(text => {
            state.current = { markdown: state.current.markdown + text, localRevision: state.current.localRevision + 1 };
            onDocumentChanged(entryId, state.current.localRevision);
          }).finally(() => { pending.current = undefined; });
          return true;
        },
      } satisfies Partial<MarkdownEditorHandle>;
      if (typeof ref === "function") return ref(handle as MarkdownEditorHandle) || undefined;
    }, []);
    return <div contentEditable suppressContentEditableWarning className="ProseMirror" ref={element} onBlur={onBlur}
      onInput={event => {
        state.current = { markdown: event.currentTarget.textContent ?? "", localRevision: state.current.localRevision + 1 };
        onDocumentChanged(entryId, state.current.localRevision);
      }}>{value}</div>;
  } };
});

const topic: Collection = { id: "topic", title: "专题", description: "", createdAt: 0, updatedAt: 0, nodeCount: 1,
  viewport: { x: 0, y: 0, zoom: 1 } };
const card: CanvasNode = { id: "note", collectionId: topic.id, kind: "text", entryId: null, assetId: null, color: null,
  contentMd: "开始", externalUrl: null, x: 0, y: 0, width: 320, height: 200, createdAt: 0, updatedAt: 0, entry: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function mountCanvas(read = vi.fn().mockResolvedValue(""), edit = true, nodes = [card], edges: CanvasEdge[] = []) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onError = vi.fn();
  const update = vi.spyOn(desktop, "updateCollectionNodeText").mockResolvedValue();
  vi.spyOn(desktop, "canvasPreviewCacheRead").mockResolvedValue(new ArrayBuffer(0));
  vi.spyOn(desktop, "collectionCanvas").mockResolvedValue({ collection: topic, nodes, edges });
  let api!: CollectionCanvasHandle;
  flushSync(() => root.render(<Theme><CollectionCanvas collection={topic} dark={false} revision={0} articleLocked={false}
    clipboard={{ read, write: vi.fn(), onError }} canvasRef={value => { if (value) api = value; }} track={job => job}
    waitForWrites={async () => {}} onOpenEntry={vi.fn()} onLoadArticle={vi.fn()} onSaveArticle={vi.fn()} onArticleImages={vi.fn()}
    onDelete={vi.fn()} downloadLinkImages={false} onEntryCreated={vi.fn()} onError={onError} /></Theme>));
  await vi.waitFor(() => expect(container.querySelector(".collection-card")).not.toBeNull());
  const editor = () => container.querySelector<HTMLElement>(".ProseMirror");
  if (edit) {
    container.querySelector(".collection-card")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => expect(editor()).not.toBeNull());
  }
  return { container, editor, api, update, onError, leave: () => container.querySelector<HTMLButtonElement>(".collection-flow button")!.click(),
    type(markdown: string) { editor()!.textContent = markdown; editor()!.dispatchEvent(new Event("input", { bubbles: true })); },
    unmount() { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); } };
}

it("holds sync replay during a canvas gesture and saves final card geometry once", async () => {
  const canvas = await mountCanvas(undefined, false);
  const save = vi.spyOn(desktop, "updateCollectionNodeGeometry").mockResolvedValue();
  const panel = canvas.container.querySelector(".collection-flow")!;
  try {
    panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 12 }));
    expect(canvas.api.canApplySync()).toBe(false);
    flushSync(() => flowEvents.nodes([{ type: "position", id: card.id, dragging: true, position: { x: 5, y: 6 } }]));
    expect(save).not.toHaveBeenCalled();
    flushSync(() => flowEvents.nodes([{ type: "position", id: card.id, dragging: false, position: { x: 50, y: 60 } }]));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 12 }));
    expect(canvas.api.canApplySync()).toBe(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith([
      { nodeId: card.id, x: 50, y: 60, width: 320, height: 200 },
    ]));
  } finally { canvas.unmount(); }
});

it("waits for a pending paste and keeps the editor available when the final save fails", async () => {
  const clipboard = deferred<string>();
  const canvas = await mountCanvas(vi.fn(() => clipboard.promise));
  const error = new Error("write failed");
  canvas.update.mockRejectedValueOnce(error);
  try {
    canvas.type("最后一字");
    expect(canvas.api.clipboard("paste", canvas.editor())).toBe(true);
    canvas.leave();
    expect(canvas.update).not.toHaveBeenCalled();
    clipboard.resolve(" + 粘贴");
    await vi.waitFor(() => expect(canvas.onError).toHaveBeenCalledWith(error));
    expect(canvas.update).toHaveBeenLastCalledWith(card.id, "最后一字 + 粘贴");
    expect(canvas.editor()).not.toBeNull();
    canvas.type("再次修改");
    canvas.leave();
    await vi.waitFor(() => expect(canvas.editor()).toBeNull());
    expect(canvas.update).toHaveBeenLastCalledWith(card.id, "再次修改");
  } finally { canvas.unmount(); }
});

const webCard = (id: string): CanvasNode => ({ ...card, id, kind: "web", contentMd: "", externalUrl: `https://${id}.test/` });

it("activates only a single selected webpage without a selected edge", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const a = webCard("a"), b = webCard("b");
  const edge = { id: "edge", collectionId: topic.id, sourceNodeId: a.id, targetNodeId: b.id, label: "", createdAt: 0, updatedAt: 0 };
  const canvas = await mountCanvas(undefined, false, [card, a, b], [edge]);
  const slot = () => canvas.container.querySelector<HTMLElement>(".collection-web-viewport")?.dataset.previewNode;
  const select = (id: string, ctrlKey = false) => flushSync(() =>
    canvas.container.querySelector(`[data-node="${id}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey })));
  try {
    expect(slot()).toBeUndefined();
    select(a.id);
    expect(slot()).toBe(a.id);
    select(b.id, true);
    expect(slot()).toBeUndefined();
    select(a.id, true);
    expect(slot()).toBe(b.id);
    flushSync(() => canvas.container.querySelector<HTMLButtonElement>("[data-edge]")!.click());
    expect(slot()).toBeUndefined();
    select(a.id);
    expect(slot()).toBe(a.id);
    select(card.id);
    expect(slot()).toBeUndefined();
    select(b.id);
    expect(slot()).toBe(b.id);
    flushSync(() => canvas.container.querySelector(".collection-flow")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(slot()).toBeUndefined();
    expect(canvas.container.querySelector('[data-selected="true"]')).toBeNull();
    select(a.id);
    flushSync(canvas.leave);
    expect(slot()).toBeUndefined();
  } finally { canvas.unmount(); vi.unstubAllGlobals(); }
});

it("creates a webpage only for a single bare URL pasted into the canvas", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const canvas = await mountCanvas(undefined, false);
  const focus = canvas.container.querySelector<HTMLDivElement>(".collection-flow")!;
  const url = "https://example.test/docs?q=1#top";
  const creation = deferred<void>();
  const read = vi.spyOn(desktop, "readClipboard").mockResolvedValueOnce({ kind: "text", text: ` ${url}\n` })
    .mockResolvedValueOnce({ kind: "text", text: "https://another.test/" })
    .mockResolvedValueOnce({ kind: "text", text: `说明 ${url}` });
  const create = vi.spyOn(desktop, "createCollectionNode").mockImplementation(async (_topic, content) => {
    if (content.kind === "web") await creation.promise;
    return { ...card, id: content.kind === "web" ? new URL(content.url).hostname : "pasted-text", kind: content.kind,
      externalUrl: content.kind === "web" ? content.url : null,
      contentMd: content.kind === "text" ? content.contentMd : "" };
  });
  try {
    focus.focus();
    expect(canvas.api.paste(focus)).toBe(true);
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith(topic.id, { kind: "web", url }, expect.anything()));
    canvas.leave();
    creation.resolve();
    await vi.waitFor(() => expect(canvas.container.querySelector(".collection-card[data-kind=web]")).not.toBeNull());
    expect(canvas.container.querySelector(".collection-web-viewport")).toBeNull();
    expect(canvas.container.querySelector(".collection-card[data-kind=web] .collection-card-caption")?.textContent).toBe("example.test");
    expect(canvas.container.querySelector(".collection-web-header")).toBeNull();
    expect(canvas.api.paste(focus)).toBe(true);
    await vi.waitFor(() => expect(canvas.container.querySelector(".collection-web-viewport")?.getAttribute("data-preview-node")).toBe("another.test"));
    expect(canvas.container.querySelectorAll('.collection-card[data-selected="true"]')).toHaveLength(1);
    flushSync(canvas.leave);
    expect(canvas.container.querySelector(".collection-web-viewport")).toBeNull();
    expect(canvas.api.paste(focus)).toBe(true);
    await vi.waitFor(() => expect(create).toHaveBeenLastCalledWith(topic.id, { kind: "text", contentMd: `说明 ${url}` }, expect.anything()));
    expect(read).toHaveBeenCalledTimes(3);
  } finally { canvas.unmount(); vi.unstubAllGlobals(); }
});

it("flushes the inline editor before a pasted webpage becomes the only selected card", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const canvas = await mountCanvas();
  const page = webCard("pasted");
  const save = deferred<void>();
  canvas.update.mockReturnValueOnce(save.promise);
  vi.spyOn(desktop, "readClipboard").mockResolvedValue({ kind: "text", text: page.externalUrl! });
  const create = vi.spyOn(desktop, "createCollectionNode").mockResolvedValue(page);
  try {
    canvas.type("待保存");
    const area = canvas.container.querySelector<HTMLDivElement>(".collection-flow")!;
    area.focus();
    expect(canvas.api.paste(area)).toBe(true);
    await vi.waitFor(() => expect(canvas.update).toHaveBeenCalledWith(card.id, "待保存"));
    expect(canvas.editor()).not.toBeNull();
    expect(canvas.container.querySelector(".collection-web-viewport")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    save.resolve();
    await vi.waitFor(() => expect(canvas.container.querySelector(".collection-web-viewport")?.getAttribute("data-preview-node")).toBe(page.id));
    expect(canvas.editor()).toBeNull();
    expect(canvas.container.querySelectorAll('.collection-card[data-selected="true"]')).toHaveLength(1);
  } finally { canvas.unmount(); vi.unstubAllGlobals(); }
});

it("shows the cached previews for multiple cards on reopening without activating a live page", async () => {
  const opened = vi.spyOn(desktop, "canvasWebview");
  const png = new Uint8Array([1, 2, 3]).buffer;
  const a = webCard("a"), b = webCard("b"), c = webCard("c");
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    image.decode = async () => {};
    return image;
  });
  const release = vi.fn();
  let index = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return `blob:disk-${++index}`; }
    static revokeObjectURL = release;
  });
  const read = vi.spyOn(desktop, "canvasPreviewCacheRead");
  const pending = deferred<ArrayBuffer>();
  read.mockResolvedValueOnce(png).mockResolvedValueOnce(png).mockReturnValueOnce(pending.promise);
  const canvas = await mountCanvas(undefined, false, [a, b, c]);
  try {
    const image = (id: string) => canvas.container.querySelector<HTMLImageElement>(`[data-node="${id}"] .collection-web-image`);
    await vi.waitFor(() => expect(image("b")?.getAttribute("src")).toBe("blob:disk-2"));
    expect(image("a")?.getAttribute("src")).toBe("blob:disk-1");
    expect(image("c")).toBeNull();
    expect(canvas.container.querySelector('[data-node="c"] .collection-web-placeholder')?.textContent).toBe("c.test");
    expect(canvas.container.querySelector(".collection-web-viewport")).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    expect(read.mock.calls.map(([key]) => key.nodeId)).toEqual(["a", "b", "c"]);
  } finally {
    canvas.unmount();
    pending.resolve(png);
    await Promise.resolve();
    expect(release.mock.calls).toEqual([["blob:disk-1"], ["blob:disk-2"]]);
    vi.unstubAllGlobals();
  }
});

it("keeps the old image until the animated image completes and cancels a stale handoff", async () => {
  const resizeHandlers = new Set<() => void>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private resize: () => void) { resizeHandlers.add(this.resize); }
    observe() {}
    disconnect() { resizeHandlers.delete(this.resize); }
  });
  let width = 200;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("collection-web-viewport") ? new DOMRect(60, 80, width, 120) : new DOMRect(0, 0, 480, 380);
  });
  const png = new Uint8Array([1, 2, 3]).buffer;
  vi.spyOn(desktop, "canvasPreviewCacheRead").mockResolvedValueOnce(png).mockResolvedValueOnce(png);
  const native = vi.spyOn(desktop, "canvasWebview").mockImplementation(async action => action.action === "open");
  const loadEvents: ((event: "loading" | "loaded") => void)[] = [];
  vi.spyOn(desktop, "onCanvasWebTitle").mockResolvedValue(vi.fn());
  vi.spyOn(desktop, "onCanvasWebState").mockImplementation(async callback => {
    loadEvents.push(callback);
    return vi.fn<() => void>();
  });
  vi.spyOn(desktop, "canvasWebviewSnapshot").mockResolvedValue(png);
  vi.spyOn(desktop, "canvasWebviewPage").mockResolvedValue(null);
  const decoded = deferred<void>();
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    image.decode = () => image.src === "blob:fade-3" ? decoded.promise : Promise.resolve();
    return image;
  });
  const release = vi.fn();
  let index = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return `blob:fade-${++index}`; }
    static revokeObjectURL = release;
  });
  const a = webCard("a"), b = webCard("b");
  const canvas = await mountCanvas(undefined, false, [a, b]);
  const tile = (id: string) => canvas.container.querySelector<HTMLElement>(`[data-node="${id}"]`)!;
  const sources = (id: string) => [...tile(id).querySelectorAll("img")].map(image => image.src);
  const reveals = () => native.mock.calls.filter(([action]) => action.action === "reveal");
  try {
    await vi.waitFor(() => expect(sources(a.id)).toEqual(["blob:fade-1"]));
    tile(a.id).click();
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith(expect.objectContaining({ action: "open" })));
    expect(sources(a.id)).toEqual(["blob:fade-1"]);
    loadEvents[0]("loaded");
    await vi.waitFor(() => expect(index).toBe(3));
    expect(sources(a.id)).toEqual(["blob:fade-1"]);
    expect(reveals()).toHaveLength(0);
    decoded.resolve();
    await vi.waitFor(() => expect(sources(a.id)).toEqual(["blob:fade-1", "blob:fade-3"]));
    expect(release).not.toHaveBeenCalled();
    expect(reveals()).toHaveLength(0);
    loadEvents[0]("loading");
    await vi.waitFor(() => expect(sources(a.id)).toEqual(["blob:fade-1"]));
    expect(release).toHaveBeenCalledWith("blob:fade-3");
    expect(reveals()).toHaveLength(0);
    loadEvents[0]("loaded");
    await vi.waitFor(() => expect(sources(a.id)).toEqual(["blob:fade-1", "blob:fade-4"]));
    width = 222;
    resizeHandlers.forEach(resize => resize());
    await vi.waitFor(() => expect(sources(a.id)).toEqual(["blob:fade-1", "blob:fade-5"]));
    expect(release).toHaveBeenCalledWith("blob:fade-4");
    expect(reveals()).toHaveLength(0);
    expect(native).toHaveBeenLastCalledWith(expect.objectContaining({ action: "bounds", bounds: expect.objectContaining({ width }) }));
    // JSDOM has prefixed animation styles but does not expose AnimationEvent.
    tile(a.id).querySelector("[data-fading]")!.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
    await vi.waitFor(() => expect(reveals()).toHaveLength(1));
    expect(sources(a.id)).toEqual(["blob:fade-5"]);
    expect(release).toHaveBeenCalledWith("blob:fade-1");

    tile(b.id).click();
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith(expect.objectContaining({ action: "open", url: b.externalUrl })));
    loadEvents[1]("loaded");
    await vi.waitFor(() => expect(sources(b.id)).toEqual(["blob:fade-2", "blob:fade-7"]));
    canvas.leave();
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({ action: "close" }));
    expect(sources(b.id)).toEqual(["blob:fade-2"]);
    expect(reveals()).toHaveLength(1);
    expect(release).toHaveBeenCalledWith("blob:fade-7");
    expect(release).not.toHaveBeenCalledWith("blob:fade-2");
  } finally { canvas.unmount(); vi.unstubAllGlobals(); }
});

it("retains per-card cache on rapid switches and covers the old view before capture and close", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const container = document.body.appendChild(document.createElement("div"));
  container.getBoundingClientRect = () => new DOMRect(100, 50, 600, 500);
  const viewport = container.appendChild(document.createElement("div"));
  viewport.className = "react-flow__viewport";
  const node = viewport.appendChild(document.createElement("div"));
  node.className = "react-flow__node";
  const slot = node.appendChild(document.createElement("div"));
  const root = createRoot(container.appendChild(document.createElement("div")));
  const native = vi.spyOn(desktop, "canvasWebview").mockImplementation(async action => action.action === "open");
  const pageState = vi.spyOn(desktop, "canvasWebviewPage").mockResolvedValue(null);
  const listeners = new Map<number, (event: "loading" | "loaded" | "escape") => void>();
  vi.spyOn(desktop, "onCanvasWebTitle").mockResolvedValue(vi.fn());
  vi.spyOn(desktop, "onCanvasWebState").mockImplementation(async (listen, session) => {
    listeners.set(session, listen);
    return () => listeners.delete(session);
  });
  const read = vi.spyOn(desktop, "canvasPreviewCacheRead").mockResolvedValue(new ArrayBuffer(0));
  const firstDiskRead = deferred<ArrayBuffer>();
  read.mockReturnValueOnce(firstDiskRead.promise);
  const png = new Uint8Array([1, 2, 3]).buffer;
  const exitCapture = deferred<ArrayBuffer>();
  const blankFrames = 6;
  const snapshot = vi.spyOn(desktop, "canvasWebviewSnapshot").mockResolvedValue(png);
  for (let attempt = 0; attempt < blankFrames; attempt++) snapshot.mockResolvedValueOnce(new ArrayBuffer(0));
  snapshot.mockResolvedValueOnce(png).mockReturnValueOnce(exitCapture.promise);
  const release = vi.fn();
  let imageIndex = 0;
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    image.decode = async () => {};
    return image;
  });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return `blob:preview-${++imageIndex}`; }
    static revokeObjectURL = release;
  });
  const cache = new CanvasPreviewCache(topic.id);
  const a = webCard("a"), b = webCard("b"), c = webCard("c");
  const notifyA = vi.fn(), notifyC = vi.fn();
  const removeA = cache.subscribe(a.id, a.externalUrl!, notifyA);
  const removeC = cache.subscribe(c.id, c.externalUrl!, notifyC);
  const prep: { current: (() => Promise<void> | undefined) | undefined } = { current: undefined };
  const area = { current: container };
  const onReveal = vi.fn();
  const escape = vi.fn();
  let left = 60, zoom = 1;
  Object.defineProperty(slot, "clientWidth", { get: () => 200 });
  slot.getBoundingClientRect = () => new DOMRect(left, 100, 200 * zoom, 160 * zoom);
  function View({ card }: { card?: CanvasNode }) {
    useCanvasWebPreview(area, slot, card ? { id: card.id, url: card.externalUrl! } : undefined, false,
      () => zoom, onReveal, vi.fn(), vi.fn(), prep, cache, escape);
    return null;
  }
  const render = (card?: CanvasNode) => flushSync(() => root.render(<View card={card} />));
  const open = () => native.mock.calls.flatMap(([action]) => action.action === "open" ? [action] : []);
  const key = (card: CanvasNode) => ({ nodeId: card.id, collectionId: topic.id, url: card.externalUrl });
  try {
    render(a);
    await vi.waitFor(() => expect(open()).toHaveLength(1));
    expect(open()[0].bounds.clip.width).toBe(160);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(native.mock.calls.some(([action]) => action.action === "reveal")).toBe(false);
    const oldEvent = listeners.get(open()[0].session)!;
    oldEvent("loaded");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    expect(cache.get(a.id, a.externalUrl!).image).toBeUndefined();
    expect(native.mock.calls.some(([action]) => action.action === "reveal")).toBe(false);
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({ action: "reveal" }), { timeout: 2500 });
    expect(cache.get(a.id, a.externalUrl!).image).toBe("blob:preview-1");
    firstDiskRead.resolve(png);
    await Promise.resolve();
    expect(cache.get(a.id, a.externalUrl!).image).toBe("blob:preview-1");
    expect(notifyA).toHaveBeenCalledTimes(1);
    zoom = 0.5;
    left = 150;
    viewport.style.transform = "scale(0.5)";
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({
      action: "bounds", bounds: { x: 150, y: 100, width: 100, height: 80, layoutWidth: 200, clip: { x: 0, y: 0, width: 100, height: 80 } },
      resume: false, zoom: 0.5,
    }));
    left = -100;
    viewport.style.transform = "translateX(-100px)";
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({ action: "cover" }));
    left = 150;
    node.style.transform = "translateX(150px)";
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({ action: "reveal" }));
    expect(open()).toHaveLength(1);
    const followed = { url: "https://a.test/followed", x: 0, y: 672 };
    pageState.mockResolvedValueOnce(followed);
    render(b);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(blankFrames + 2));
    expect(native).toHaveBeenLastCalledWith({ action: "cover" });
    expect(pageState).toHaveBeenCalledWith(open()[0].session);
    expect(snapshot).toHaveBeenLastCalledWith(false, key(a));
    render(c);
    oldEvent("escape");
    expect(escape).not.toHaveBeenCalled();
    expect(open()).toHaveLength(1);
    exitCapture.resolve(png);
    await vi.waitFor(() => expect(open().map(action => action.url)).toEqual([a.externalUrl, c.externalUrl]));
    expect(native.mock.calls.slice(-2).map(([action]) => action.action)).toEqual(["close", "open"]);
    expect(cache.get(a.id, a.externalUrl!).image).toBe("blob:preview-2");
    expect(cache.get(c.id, c.externalUrl!).image).toBeUndefined();
    const currentEvent = listeners.get(open()[1].session)!;
    const revealRpc = deferred<boolean>();
    native.mockImplementationOnce(action => {
      expect(action).toEqual({ action: "reveal" });
      return revealRpc.promise;
    });
    currentEvent("loaded");
    await vi.waitFor(() => expect(cache.get(c.id, c.externalUrl!).image).toBe("blob:preview-3"));
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({ action: "reveal" }));
    expect(snapshot).toHaveBeenLastCalledWith(false, key(c));
    currentEvent("escape");
    expect(escape).toHaveBeenCalledTimes(1);
    const paint = deferred<ArrayBuffer>();
    const previousCaptureCount = snapshot.mock.calls.length;
    const previousActionCount = native.mock.calls.length;
    snapshot.mockReturnValueOnce(paint.promise);
    const freezing = prep.current!();
    expect(freezing).toBeDefined();
    expect(native.mock.calls).toHaveLength(previousActionCount);
    revealRpc.resolve(false);
    await freezing;
    await prep.current!();
    zoom = 1.2;
    viewport.style.transform = "scale(1.2)";
    await prep.current!();
    expect(cache.get(c.id, c.externalUrl!).image).toBe("blob:preview-3");
    expect(native.mock.calls.slice(previousActionCount).map(([action]) => action)).toEqual([
      { action: "cover", rememberScroll: true },
    ]);
    expect(snapshot.mock.calls).toHaveLength(previousCaptureCount);
    await vi.waitFor(() => expect(snapshot.mock.calls).toHaveLength(previousCaptureCount + 1));
    expect(native).toHaveBeenLastCalledWith(expect.objectContaining({ action: "bounds", zoom: 1.2, restoreScroll: true }));
    expect(snapshot).toHaveBeenLastCalledWith(false);
    paint.resolve(png);
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({ action: "reveal" }));
    expect(native.mock.calls.slice(previousActionCount).map(([action]) => action.action)).toEqual(["cover", "bounds", "reveal"]);
    render(a);
    await vi.waitFor(() => expect(open().map(action => action.url)).toEqual([a.externalUrl, c.externalUrl, followed.url]));
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    pageState.mockResolvedValueOnce({ ...followed, y: 0 }).mockResolvedValueOnce(followed);
    snapshot.mockResolvedValueOnce(new ArrayBuffer(0));
    const reopenedSession = open()[2].session;
    listeners.get(reopenedSession)!("loaded");
    await vi.waitFor(() => expect(cache.get(a.id, a.externalUrl!).incoming).toBeDefined());
    expect(pageState).toHaveBeenLastCalledWith(reopenedSession, followed);
    expect(pageState.mock.calls.filter(([session]) => session === reopenedSession)).toHaveLength(2);
    expect(snapshot).toHaveBeenLastCalledWith(false, key(a));
    expect(pageState.mock.invocationCallOrder.at(-1)!).toBeLessThan(snapshot.mock.invocationCallOrder.at(-1)!);
    render();
    await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith({ action: "close" }));
    expect(cache.get(a.id, a.externalUrl!)).toEqual({ image: "blob:preview-2" });
    removeA();
    expect(release).toHaveBeenCalledWith("blob:preview-2");
    const notificationCount = notifyA.mock.calls.length;
    await cache.capture(a.id, a.externalUrl!, png);
    expect(notifyA).toHaveBeenCalledTimes(notificationCount);
  } finally {
    removeC();
    flushSync(() => root.unmount());
    await Promise.resolve();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
it("coalesces wheel input into one viewport update per frame and preserves the last pointer anchor", async () => {
  const canvas = await mountCanvas(undefined, false);
  viewportControl.set.mockClear();
  const area = canvas.container.querySelector(".collection-flow")!;
  area.getBoundingClientRect = () => new DOMRect(100, 80, 480, 420);
  const wheel = (target: Element, x: number, y: number, deltaY: number) => {
    const event = new WheelEvent("wheel", { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const editor = area.appendChild(document.createElement("div"));
    editor.className = "nowheel";
    expect(wheel(editor, 300, 240, -120)).toBe(false);
    expect(wheel(area, 250, 210, -120)).toBe(true);
    expect(wheel(area, 300, 240, -120)).toBe(true);
    expect(viewportControl.set).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(viewportControl.set).toHaveBeenCalledTimes(1));
    const [view, motion] = viewportControl.set.mock.calls[0];
    expect(motion).toEqual({ duration: 0 });
    expect(view.zoom).toBeCloseTo(2 ** 0.48);
    expect((200 - view.x) / view.zoom).toBeCloseTo(200 - 12);
    expect((160 - view.y) / view.zoom).toBeCloseTo(160 - 24);
  } finally {
    canvas.unmount();
  }
});

it("waits for the latest queued write, including a return to the original Markdown", async () => {
  const canvas = await mountCanvas();
  const first = deferred<void>(), latest = deferred<void>();
  canvas.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  try {
    canvas.type("编辑中的文本");
    canvas.leave();
    await vi.waitFor(() => expect(canvas.update).toHaveBeenCalledWith(card.id, "编辑中的文本"));
    canvas.type(card.contentMd);
    first.resolve();
    await vi.waitFor(() => expect(canvas.update).toHaveBeenCalledWith(card.id, card.contentMd));
    expect(canvas.editor()).not.toBeNull();
    latest.resolve();
    await vi.waitFor(() => expect(canvas.editor()).toBeNull());
  } finally { canvas.unmount(); }
});
