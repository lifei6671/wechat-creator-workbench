import { useCallback, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { Background, ReactFlow, ReactFlowProvider, ViewportPortal, applyEdgeChanges, applyNodeChanges, useReactFlow,
  type Edge, type NodeChange, type Viewport } from "@xyflow/react";
import { BookOpen, Clipboard, Copy, ExternalLink, FilePlus2, FileText, Focus, Globe2, Image, Link2, Maximize, Minus, Plus, Scaling, SquarePen, StickyNote, Trash2, Workflow, X } from "lucide-react";
import { Button, ContextMenu, Spinner } from "@radix-ui/themes";
import type { CanvasCardColor, CanvasEdge, CanvasGeometry, CanvasNode, CanvasNodeContent, CanvasPosition, Collection, CollectionCanvas as Canvas, Entry, EntryFields, SaveMode, SaveResult } from "../../../../packages/shared-types";
import type { ClipboardAction, ClipboardIO, MarkdownEditorHandle } from "../../../../packages/editor-react";
import { desktop, errorMessage } from "../desktop";
import { commandKey, untitled } from "../labels";
import { Tool } from "../ui";
import { SaveQueue } from "../editor/save-queue";
import { pastedWebUrl, useCanvasWebPreview } from "./CanvasWebPreview";
import { CanvasPreviewCache } from "./CanvasPreviewCache";
import { CollectionNodeContext, collectionNodeTypes, type FlowNode } from "./CollectionNodes";
import { CollectionPicker, EdgeLabelDialog, GitHubImportDialog } from "./CollectionDialogs";
import { alignCollectionNodes } from "./collection-alignment";
import { ImageViewer, loadLocalImage } from "./Publishing";
import "@xyflow/react/dist/style.css";

export interface CollectionCanvasHandle {
  paste(target: EventTarget | null): boolean;
  clipboard(action: ClipboardAction, target: EventTarget | null, plainText?: boolean): boolean;
  flush(): Promise<void>;
  canApplySync(): boolean;
  addEntry(entryId: string): Promise<void>;
}

interface Props {
  collection: Collection;
  dark: boolean;
  revision: number;
  articleLocked: boolean;
  previewBlocked?: boolean;
  clipboard: ClipboardIO;
  canvasRef: Ref<CollectionCanvasHandle>;
  track<T>(job: Promise<T>): Promise<T>;
  waitForWrites(): Promise<unknown>;
  onOpenEntry(id: string): void;
  onLoadArticle(id: string): Promise<Entry>;
  onSaveArticle(id: string, version: number, fields: EntryFields, mode: SaveMode): Promise<SaveResult>;
  onArticleImages(files: File[]): Promise<string>;
  onDelete(): void;
  onEntryCreated(): void;
  onError(error: unknown): void;
}

export function CollectionCanvas(props: Props) {
  const [canvas, setCanvas] = useState<Canvas>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const { collection: { id }, waitForWrites } = props;
  useEffect(() => {
    let live = true;
    void waitForWrites().then(() => desktop.collectionCanvas(id)).then(result => { if (live) setCanvas(result); },
      failure => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; };
  }, [id, retry, waitForWrites]);
  if (!canvas) return <div id="collection-canvas-panel" role="tabpanel" aria-labelledby={`collection-tab-${id}`} className="document-body collection-state">
    {error ? <><p className="inline-error" role="alert">{error}</p><Button size="1" onClick={() => { setError(""); setRetry(value => value + 1); }}>重试</Button></>
      : <span role="status"><Spinner /> 正在读取专题…</span>}
  </div>;
  return <ReactFlowProvider><CanvasWorkspace {...props} initial={canvas} /></ReactFlowProvider>;
}

function toFlowNode(node: CanvasNode): FlowNode {
  const label = node.externalUrl ? new URL(node.externalUrl).hostname
    : node.entry?.title || (node.kind === "image" ? node.assetName || "图片" : node.kind === "text" ? "文本卡片" : untitled);
  return { id: node.id, type: "card", data: node, position: { x: node.x, y: node.y },
    width: node.width, height: node.height, ariaLabel: label };
}

function toFlowEdge(edge: CanvasEdge): Edge {
  return { id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId,
    label: edge.label, ariaLabel: edge.label || "连线", type: "default" };
}

const edgeDefaults = { labelBgPadding: [5, 3] as [number, number], labelBgBorderRadius: 4 };
const rightMousePan = [2];
const proOptions = { hideAttribution: true };

function zoomTransition() {
  return { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250,
    ease: (progress: number) => 1 - (1 - progress) ** 3, interpolate: "linear" as const };
}

type TextDraft = { value: string; saving?: Promise<void> };
type TextEdit = { nodeId: string; handle: MarkdownEditorHandle; revision: number; captured: number; timer?: number };
type ArticleEdit = { nodeId: string; queue: SaveQueue };

function CanvasWorkspace({ collection, initial, dark, revision, articleLocked, previewBlocked, clipboard, canvasRef, track, onOpenEntry,
  onLoadArticle, onSaveArticle, onArticleImages, onEntryCreated, onError, onDelete }: Props & { initial: Canvas }) {
  const collectionId = collection.id;
  const flow = useReactFlow<FlowNode, Edge>();
  const area = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState(() => initial.nodes.map(toFlowNode));
  const nodesRef = useRef(nodes);
  const [edges, setEdges] = useState(() => initial.edges.map(toFlowEdge));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [articleEdit, setArticleEdit] = useState<ArticleEdit>();
  const activeArticleEdit = useRef<ArticleEdit | undefined>(undefined);
  const articleEditor = useRef<MarkdownEditorHandle | null>(null);
  const textEditor = useRef<TextEdit | null>(null);
  const deleting = useRef<{ ids: Set<string>; job: Promise<void> } | null>(null);
  const editIntent = useRef(0);
  const selectionIntent = useRef(0);
  const revealPreview = useRef<string | null>(null);
  const articleRequests = useMemo(() => new Map<string, Promise<Entry>>(), [revision]);
  const loadArticle = useCallback((id: string) => {
    const pending = articleRequests.get(id);
    if (pending) return pending;
    const request = desktop.entry(id).catch(error => { articleRequests.delete(id); throw error; });
    articleRequests.set(id, request);
    return request;
  }, [articleRequests]);
  const [guides, setGuides] = useState<ReturnType<typeof alignCollectionNodes>>();
  const draggedIds = useRef(new Set<string>());
  const activePointers = useRef(new Set<number>());
  const selectingCards = useRef(false);
  const explicitEdgeSelection = useRef(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const converting = useRef<string | null>(null);
  const [dialog, setDialog] = useState<{ type: "picker" | "github"; point?: CanvasPosition } | { type: "edge"; edge: Edge } | null>(null);
  const [menu, setMenu] = useState<{ type: "canvas"; point?: CanvasPosition } | { type: "node" | "edge"; id: string }>({ type: "canvas" });
  const actionAfterMenu = useRef<(() => void) | null>(null);
  const [image, setImage] = useState<Awaited<ReturnType<typeof loadLocalImage>>>();
  const [webSlot, setWebSlot] = useState<HTMLDivElement | null>(null);
  const [webPreviews] = useState(() => new CanvasPreviewCache(collectionId));
  const pendingText = useRef(new Map<string, TextDraft>());
  const tail = useRef(Promise.resolve());
  const savedViewport = useRef(initial.collection.viewport);
  const viewportTimer = useRef<number | undefined>(undefined);
  const prepareWebZoom = useRef<(() => Promise<void> | undefined) | undefined>(undefined);
  const cancelWheelZoom = useRef<() => void>(undefined);
  const zoomIntent = useRef(0);
  const viewportWrite = useRef<{ view: Viewport; saving: Promise<void> } | undefined>(undefined);
  const loadedRevision = useRef(revision);
  const selectedNodes = nodes.filter(node => node.selected);
  const selectedEdges = edges.filter(edge => edge.selected);
  const activePreview = selectedNodes.length === 1 && selectedEdges.length === 0
    && selectedNodes[0].data.kind === "web" ? selectedNodes[0].data : undefined;
  const activeWebNodeId = activePreview?.id ?? null;

  const animateZoom = useCallback((action: () => void) => {
    cancelWheelZoom.current?.();
    const intent = ++zoomIntent.current;
    void (async () => {
      await prepareWebZoom.current?.();
      if (area.current && intent === zoomIntent.current) action();
    })().catch(onError);
  }, [onError]);

  useEffect(() => {
    const canvas = area.current!;
    let pending: { zoom: number; x: number; y: number } | undefined;
    let frame: number | undefined;
    let waiting = false, disposed = false;

    function applyWheelZoom() {
      frame = undefined;
      const target = pending;
      pending = undefined;
      if (!target) return;
      const view = flow.getViewport();
      if (target.zoom === view.zoom) return;
      const scale = target.zoom / view.zoom;
      void flow.setViewport({
        x: target.x - (target.x - view.x) * scale,
        y: target.y - (target.y - view.y) * scale,
        zoom: target.zoom,
      }, { duration: 0 }).catch(onError);
    }

    function scheduleFrame() {
      if (!disposed && pending && frame === undefined) frame = requestAnimationFrame(applyWheelZoom);
    }

    function cancelWheel() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pending = undefined;
    }

    function wheel(event: WheelEvent) {
      if (event.defaultPrevented || selectingCards.current || !event.deltaY || !(event.target instanceof Element)
        || event.target.closest(".nowheel, input, textarea, [contenteditable=true], [role=dialog]")) return;
      event.preventDefault();
      event.stopPropagation();
      ++zoomIntent.current;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      const pinchGain = event.ctrlKey && commandKey === "⌘" ? 10 : 1;
      const base = pending?.zoom ?? flow.getViewport().zoom;
      const zoom = Math.max(0.1, Math.min(3, base * 2 ** (-delta * 0.002 * pinchGain)));
      const rect = canvas.getBoundingClientRect();
      pending = { zoom, x: event.clientX - rect.left, y: event.clientY - rect.top };
      const prepared = prepareWebZoom.current?.();
      if (!prepared) scheduleFrame();
      else if (!waiting) {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        waiting = true;
        void prepared.finally(() => {
          waiting = false;
          scheduleFrame();
        }).catch(onError);
      } else void prepared.catch(onError);
    }
    function pinch(event: TouchEvent) {
      if (event.touches.length === 2 && event.target instanceof Element && !event.target.closest(".nowheel, [contenteditable=true]")) {
        void prepareWebZoom.current?.()?.catch(onError);
      }
    }
    canvas.addEventListener("wheel", wheel, { passive: false, capture: true });
    canvas.addEventListener("touchstart", pinch, { passive: true, capture: true });
    canvas.addEventListener("touchmove", pinch, { passive: true, capture: true });
    cancelWheelZoom.current = cancelWheel;
    return () => {
      disposed = true;
      cancelWheelZoom.current = undefined;
      cancelWheel();
      canvas.removeEventListener("wheel", wheel, true);
      canvas.removeEventListener("touchstart", pinch, true);
      canvas.removeEventListener("touchmove", pinch, true);
    };
  }, [flow, onError]);

  const changeNodes = useCallback((apply: (current: FlowNode[]) => FlowNode[]) => {
    const next = apply(nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, []);

  const enqueue = useCallback(<T,>(operation: () => Promise<T>) => {
    const job = tail.current.then(operation);
    tail.current = job.then(() => {}, () => {});
    return track(job);
  }, [track]);

  const registerTextEditor = useCallback((nodeId: string, handle: MarkdownEditorHandle | null) => {
    if (handle) textEditor.current = { nodeId, handle, revision: 0, captured: 0 };
    else if (textEditor.current?.nodeId === nodeId) {
      window.clearTimeout(textEditor.current.timer);
      textEditor.current = null;
    }
  }, []);

  const flushText = useCallback((id: string) => {
    if (deleting.current?.ids.has(id)) return Promise.resolve();
    const edit = textEditor.current;
    if (edit?.nodeId === id) {
      window.clearTimeout(edit.timer);
      if (edit.captured !== edit.revision) {
        const { markdown, localRevision } = edit.handle.captureMarkdown();
        edit.captured = localRevision;
        const node = nodesRef.current.find(item => item.id === id);
        // The node holds the last queued value, including writes still in flight.
        if (node && node.data.contentMd !== markdown) {
          changeNodes(current => current.map(item => item === node ? { ...item, data: { ...item.data, contentMd: markdown } } : item));
          pendingText.current.set(id, { value: markdown });
        }
      }
    }
    const draft = pendingText.current.get(id);
    if (!draft) return Promise.resolve();
    if (draft.saving) return draft.saving;
    draft.saving = enqueue(() => desktop.updateCollectionNodeText(id, draft.value)).then(() => {
      if (pendingText.current.get(id) === draft) pendingText.current.delete(id);
    }, error => {
      draft.saving = undefined;
      throw error;
    });
    return draft.saving;
  }, [changeNodes, enqueue]);

  const flushLatestText = useCallback(async (id: string) => {
    while (true) {
      const edit = textEditor.current;
      const removal = deleting.current;
      if (removal?.ids.has(id)) { await removal.job; return; }
      if (edit?.nodeId !== id) {
        await flushText(id);
        return;
      }
      const pending = edit.handle.pendingEdits();
      if (pending) { await pending; continue; }
      await flushText(id);
      if (textEditor.current !== edit || (edit.captured === edit.revision && !edit.handle.pendingEdits() && !pendingText.current.has(id))) return;
    }
  }, [flushText]);

  const saveText = useCallback((id: string) => { void flushText(id).catch(onError); }, [flushText, onError]);
  const markTextDirty = useCallback((id: string, revision: number) => {
    const edit = textEditor.current;
    if (edit?.nodeId !== id) return;
    edit.revision = revision;
    window.clearTimeout(edit.timer);
    edit.timer = window.setTimeout(() => saveText(id), 350);
  }, [saveText]);

  const rememberViewport = useCallback((view: Viewport) => {
    const pending = viewportWrite.current;
    const previous = pending?.view ?? savedViewport.current;
    if (previous.x === view.x && previous.y === view.y && previous.zoom === view.zoom) {
      return pending?.saving ?? Promise.resolve();
    }
    const saving = enqueue(() => desktop.saveCollectionViewport(collectionId, view)).then(() => {
      savedViewport.current = view;
    }).finally(() => {
      if (viewportWrite.current?.view === view) viewportWrite.current = undefined;
    });
    viewportWrite.current = { view, saving };
    return saving;
  }, [collectionId, enqueue]);

  const flushArticle = useCallback(async (edit: ArticleEdit, retry = false) => {
    do {
      let pending = articleEditor.current?.pendingEdits();
      while (pending) {
        await pending;
        pending = articleEditor.current?.pendingEdits();
      }
      if (!await edit.queue.flush({ retry })) throw edit.queue.saveError();
    } while (articleEditor.current?.pendingEdits());
  }, []);

  const clearArticleEdit = useCallback((edit: ArticleEdit) => {
    if (activeArticleEdit.current === edit) {
      activeArticleEdit.current = undefined;
      setArticleEdit(undefined);
      setEditingId(current => current === edit.nodeId ? null : current);
      edit.queue.dispose();
    }
  }, []);

  const finishArticleEdit = useCallback(async (retry = false) => {
    const edit = activeArticleEdit.current;
    if (!edit) return;
    await flushArticle(edit, retry);
    clearArticleEdit(edit);
  }, [clearArticleEdit, flushArticle]);

  const discardArticle = useCallback(() => {
    const edit = activeArticleEdit.current;
    if (!edit || edit.queue.isSaving()) return;
    clearArticleEdit(edit);
    onEntryCreated();
  }, [clearArticleEdit, onEntryCreated]);

  const finishArticle = useCallback(() => {
    void finishArticleEdit(true).catch(onError);
  }, [finishArticleEdit, onError]);

  const leaveEdit = useCallback((after?: () => void) => {
    const intent = ++editIntent.current;
    const text = textEditor.current;
    const finish = () => {
      if (intent !== editIntent.current) return;
      setEditingId(null);
      after?.();
    };
    if (text) return flushLatestText(text.nodeId).then(finish, onError);
    if (activeArticleEdit.current) return finishArticleEdit(true).then(finish, onError);
    finish();
  }, [finishArticleEdit, flushLatestText, onError]);

  const finishText = useCallback((id: string) => {
    if (textEditor.current?.nodeId === id) leaveEdit(() => area.current?.focus());
  }, [leaveEdit]);

  const flush = useCallback(async () => {
    window.clearTimeout(viewportTimer.current);
    const textId = textEditor.current?.nodeId;
    const writes = [...pendingText.current.keys()].filter(id => id !== textId).map(flushText);
    if (textId) writes.push(flushLatestText(textId));
    const edit = activeArticleEdit.current;
    if (edit) writes.push(flushArticle(edit));
    if (flow.viewportInitialized) writes.push(rememberViewport(flow.getViewport()));
    await Promise.all(writes);
    if (textId) await flushLatestText(textId);
  }, [flow, flushArticle, flushLatestText, flushText, rememberViewport]);

  const flushOnUnmount = useEffectEvent(() => {
    const edit = activeArticleEdit.current;
    void flush().catch(onError).finally(() => edit?.queue.dispose());
  });
  useLayoutEffect(() => () => flushOnUnmount(), []);
  useEffect(() => () => image?.dispose(), [image]);

  useEffect(() => {
    const finishPointer = (event: PointerEvent) => { activePointers.current.delete(event.pointerId); };
    const loseFocus = () => activePointers.current.clear();
    window.addEventListener("pointerup", finishPointer, true);
    window.addEventListener("pointercancel", finishPointer, true);
    window.addEventListener("blur", loseFocus);
    return () => {
      window.removeEventListener("pointerup", finishPointer, true);
      window.removeEventListener("pointercancel", finishPointer, true);
      window.removeEventListener("blur", loseFocus);
    };
  }, []);

  useEffect(() => {
    if (loadedRevision.current === revision) return;
    let live = true;
    void desktop.collectionCanvas(collectionId).then(result => {
      if (!live) return;
      loadedRevision.current = revision;
      const summaries = new Map(result.nodes.map(node => [node.id, node.entry]));
      changeNodes(current => current.map(node => node.data.kind === "entry" && summaries.has(node.id)
        ? { ...node, data: { ...node.data, entry: summaries.get(node.id)! } } : node));
    }, error => { if (live) onError(error); });
    return () => { live = false; };
  }, [changeNodes, collectionId, onError, revision]);

  function addNode(content: CanvasNodeContent, point?: CanvasPosition, selectIntent?: number) {
    const rect = area.current!.getBoundingClientRect();
    const center = flow.screenToFlowPosition(point ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const topLeft = flow.screenToFlowPosition({ x: rect.left, y: rect.top });
    const bottomRight = flow.screenToFlowPosition({ x: rect.right, y: rect.bottom });
    const width = content.kind === "web" ? 420 : 320;
    const height = content.kind === "web" ? 280 : content.kind === "entry" ? 144 : content.kind === "image" ? 224 : 200;
    const origin = { x: Math.round((center.x - (point ? 16 : width / 2)) / 16) * 16,
      y: Math.round((center.y - (point ? 16 : height / 2)) / 16) * 16 };
    return enqueue(async () => {
      const overlaps = ({ x, y }: CanvasPosition) => nodesRef.current.some(node =>
        x < node.position.x + node.width + 12 && x + width + 12 > node.position.x
        && y < node.position.y + node.height + 12 && y + height + 12 > node.position.y);
      let position = origin;
      if (overlaps(position)) {
        const candidates = [
          { x: origin.x + width + 16, y: origin.y }, { x: origin.x - width - 16, y: origin.y },
          { x: origin.x, y: origin.y + height + 16 }, { x: origin.x, y: origin.y - height - 16 },
        ];
        position = candidates.find(({ x, y }) => x >= topLeft.x && x + width <= bottomRight.x
          && y >= topLeft.y && y + height <= bottomRight.y && !overlaps({ x, y }))
          ?? { x: origin.x + 48, y: origin.y + 48 };
        while (nodesRef.current.some(node => Math.abs(node.position.x - position.x) < 42 && Math.abs(node.position.y - position.y) < 42)) {
          position.x += 48;
          position.y += 48;
        }
      }
      const node = await desktop.createCollectionNode(collectionId, content, position);
      const added = toFlowNode(node);
      if (area.current && selectIntent !== undefined && selectIntent === selectionIntent.current) {
        revealPreview.current = node.id;
        clearEdgeSelection();
        changeNodes(current => [...current.map(item => item.selected ? { ...item, selected: false } : item),
          { ...added, selected: true }]);
      } else {
        changeNodes(current => [...current, added]);
      }
      return node;
    });
  }

  function pasteContent(point?: CanvasPosition) {
    ++editIntent.current;
    const intent = ++selectionIntent.current;
    void track((async () => {
      const content = await desktop.readClipboard(true, false);
      if (!content || !area.current) return;
      if (content.kind === "text" && content.text.trim()) {
        const url = pastedWebUrl(content.text);
        if (url) {
          let selectIntent: number | undefined;
          if (intent === selectionIntent.current) {
            await leaveEdit(() => { selectIntent = intent; });
          }
          if (area.current) await addNode({ kind: "web", url }, point, selectIntent);
        } else await addNode({ kind: "text", contentMd: content.text }, point);
      }
      if (content.kind === "images") {
        for (const asset of content.images) {
          if (!area.current) break;
          await addNode({ kind: "image", assetId: asset.id }, point);
        }
        if (content.errors.length) onError(content.errors.join("；"));
      }
    })()).catch(onError);
  }

  function paste(target: EventTarget | null) {
    if (!(target instanceof HTMLElement) || !area.current?.contains(target)
      || !area.current.contains(document.activeElement)
      || target.closest("textarea, input, [contenteditable=true], [role=dialog], button, a")) return false;
    pasteContent();
    return true;
  }
  useImperativeHandle(canvasRef, () => ({
    paste, flush, addEntry: async entryId => { await addNode({ kind: "entry", entryId }); },
    canApplySync: () => !activePointers.current.size && !dialog && !image &&
      !activeArticleEdit.current?.queue.isDirty() && !activeArticleEdit.current?.queue.isSaving(),
    clipboard: (action, target, plainText) => (textEditor.current?.handle ?? articleEditor.current)?.clipboard(action, clipboard, target, plainText) ?? false,
  }));

  const resize = useCallback((nodeId: string, geometry: CanvasGeometry) => {
    const { x, y, width, height } = geometry;
    changeNodes(current => current.map(node => node.id === nodeId ? { ...node, position: { x, y }, width, height } : node));
    void enqueue(() => desktop.updateCollectionNodeGeometry([{ nodeId, x, y, width, height }])).catch(onError);
  }, [changeNodes, enqueue, onError]);

  const fitImage = useCallback((id: string, naturalWidth: number, naturalHeight: number) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (!node) return;
    const scale = Math.min(node.width / naturalWidth, node.height / naturalHeight);
    const width = Math.max(1, Math.min(node.width, naturalWidth * scale));
    const height = Math.max(1, Math.min(node.height, naturalHeight * scale));
    if (width === node.width && height === node.height) return;
    changeNodes(current => current.map(item => item.id === id ? { ...item, width, height } : item));
  }, [changeNodes]);

  const color = useCallback((id: string, next: CanvasCardColor | null) => {
    void enqueue(async () => {
      await desktop.updateCollectionNodeColor(id, next);
      changeNodes(current => current.map(node => node.id === id ? { ...node, data: { ...node.data, color: next } } : node));
    }).catch(onError);
  }, [changeNodes, enqueue, onError]);

  const focus = useCallback((id: string) => {
    animateZoom(() => { void flow.fitView({ nodes: [{ id }], padding: 0.22, maxZoom: 1.25, ...zoomTransition() }); });
  }, [animateZoom, flow]);
  useCanvasWebPreview(area, webSlot?.dataset.previewNode === activeWebNodeId ? webSlot : null,
    activePreview?.externalUrl ? { id: activePreview.id, url: activePreview.externalUrl } : undefined,
    Boolean(previewBlocked || dialog || image || editingId),
    () => flow.getViewport().zoom,
    () => {
      if (activeWebNodeId && revealPreview.current === activeWebNodeId) {
        revealPreview.current = null;
        focus(activeWebNodeId);
      }
    },
    (id, title) => {
      const card = nodesRef.current.find(node => node.id === id);
      if (card && card.data.pageTitle !== title) {
        changeNodes(current => current.map(node => node === card ? { ...node, ariaLabel: title, data: { ...node.data, pageTitle: title } } : node));
      }
    }, onError, prepareWebZoom, webPreviews, clearSelection);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const selection = changes.filter(change => change.type === "select");
    if (selection.length) ++selectionIntent.current;
    if (editingId && selection.some(change => change.selected && change.id !== editingId)) {
      const intent = selectionIntent.current;
      leaveEdit(() => {
        if (intent === selectionIntent.current) changeNodes(current => applyNodeChanges(selection, current));
      });
      changes = changes.filter(change => change.type !== "select");
    }
    if (selection.some(change => change.selected)) explicitEdgeSelection.current = false;
    if (!changes.length) return;
    const moving = new Map<string, CanvasPosition>();
    let dragging = false;
    for (const change of changes) {
      if (change.type !== "position" || !change.position) continue;
      if (change.dragging === true) {
        draggedIds.current.add(change.id);
        dragging = true;
        moving.set(change.id, change.position);
      } else if (change.dragging === false && draggedIds.current.delete(change.id)) {
        moving.set(change.id, change.position);
      }
    }
    let aligned = changes;
    if (moving.size) {
      const dragged: CanvasGeometry[] = [], stationary: CanvasGeometry[] = [];
      for (const node of nodesRef.current) {
        const position = moving.get(node.id);
        (position ? dragged : stationary).push({ ...(position ?? node.position), width: node.width, height: node.height });
      }
      const [first, ...rest] = dragged;
      if (first) {
        const alignment = alignCollectionNodes([first, ...rest], stationary, 6 / flow.getViewport().zoom);
        setGuides(dragging && (alignment.vertical || alignment.horizontal) ? alignment : undefined);
        if (alignment.x || alignment.y) aligned = changes.map(change => change.type === "position" && moving.has(change.id) && change.position
          ? { ...change, position: { x: change.position.x + alignment.x, y: change.position.y + alignment.y } } : change);
      }
    }
    changeNodes(current => applyNodeChanges(aligned, current));
    const updates = aligned.flatMap(change => {
      if (change.type !== "position" || change.dragging !== false || !change.position) return [];
      const node = nodesRef.current.find(node => node.id === change.id);
      return node ? [{ nodeId: node.id, ...node.position, width: node.width, height: node.height }] : [];
    });
    if (updates.length) void enqueue(() => desktop.updateCollectionNodeGeometry(updates)).catch(onError);
  }, [changeNodes, editingId, enqueue, flow, leaveEdit, onError]);

  const edit = useCallback((id: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (!node || node.data.kind === "web" || editingId === id || converting.current || deleting.current?.ids.has(id)) return;
    if (node.data.kind === "entry" && (articleLocked || !node.data.entryId || node.data.entry?.deletedAt !== null)) return;
    const intent = ++editIntent.current;
    ++selectionIntent.current;
    void (async () => {
      const text = textEditor.current;
      if (text) await flushLatestText(text.nodeId);
      await finishArticleEdit();
      if (!area.current || intent !== editIntent.current || !nodesRef.current.some(item => item.id === id)) return;
      changeNodes(current => current.map(item => item.selected === (item.id === id)
        ? item : { ...item, selected: item.id === id }));
      if (node.data.kind !== "entry") {
        setEditingId(id);
        return;
      }
      setEditingId(null);
      const entry = await onLoadArticle(node.data.entryId!);
      if (!area.current || intent !== editIntent.current || !nodesRef.current.some(item => item.id === id)) return;
      const next = { nodeId: id, queue: new SaveQueue(entry, (...args) => track(onSaveArticle(...args)), onEntryCreated) };
      activeArticleEdit.current = next;
      setArticleEdit(next);
      setEditingId(id);
    })().catch(onError);
  }, [articleLocked, changeNodes, editingId, finishArticleEdit, flushLatestText, onEntryCreated, onError, onLoadArticle, onSaveArticle, track]);

  const previewImage = useCallback((id: string) => {
    void loadLocalImage(`asset://${id}`).then(result => {
      if (!area.current) { result.dispose(); return; }
      (document.activeElement as HTMLElement | null)?.blur();
      setImage(result);
    }).catch(onError);
  }, [onError]);
  const registerArticleEditor = useCallback((handle: MarkdownEditorHandle | null) => { articleEditor.current = handle; }, []);
  function connect(source: string, target: string) {
    void enqueue(async () => {
      const edge = await desktop.createCollectionEdge(collectionId, source, target, "");
      setEdges(current => [...current, toFlowEdge(edge)]);
    }).catch(onError);
  }

  function clearEdgeSelection() {
    explicitEdgeSelection.current = false;
    setEdges(current => current.some(edge => edge.selected)
      ? current.map(edge => edge.selected ? { ...edge, selected: false } : edge) : current);
  }
  function clearSelection() {
    ++selectionIntent.current;
    revealPreview.current = null;
    changeNodes(current => current.some(node => node.selected)
      ? current.map(node => node.selected ? { ...node, selected: false } : node) : current);
    clearEdgeSelection();
  }
  const menuNode = menu.type === "node" ? nodes.find(node => node.id === menu.id) : undefined;
  const menuEdge = menu.type === "edge" ? edges.find(edge => edge.id === menu.id) : undefined;
  const menuNodes = menuNode?.selected ? selectedNodes : menuNode ? [menuNode] : [];
  const removeItems = useCallback((nodesToDelete: FlowNode[], edgesToDelete: Edge[]) => {
    if ((!nodesToDelete.length && !edgesToDelete.length) || deleting.current || nodesToDelete.some(node => node.id === converting.current)) return;
    ++selectionIntent.current;
    const removed = new Set(nodesToDelete.map(node => node.id));
    const text = textEditor.current;
    if (text && removed.has(text.nodeId)) window.clearTimeout(text.timer);
    const job = enqueue(async () => {
      const edit = activeArticleEdit.current;
      if (edit && removed.has(edit.nodeId)) await finishArticleEdit();
      for (const edge of edgesToDelete) {
        if (removed.has(edge.source) || removed.has(edge.target)) continue;
        await desktop.deleteCollectionEdge(edge.id);
        setEdges(current => current.filter(item => item.id !== edge.id));
      }
      for (const id of removed) {
        await desktop.deleteCollectionNode(id);
        pendingText.current.delete(id);
        setEditingId(current => current === id ? null : current);
        changeNodes(current => current.filter(node => node.id !== id));
        setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id));
      }
    });
    deleting.current = { ids: removed, job };
    void job.catch(onError).finally(() => { deleting.current = null; });
  }, [changeNodes, enqueue, finishArticleEdit, onError]);

  const remove = useCallback((id: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (node) removeItems([node], []);
  }, [removeItems]);

  const copyText = useCallback((id: string) => {
    const text = textEditor.current;
    const markdown = text?.nodeId === id && text.revision ? text.handle.captureMarkdown().markdown
      : nodesRef.current.find(node => node.id === id)!.data.contentMd;
    void desktop.copyText(markdown).catch(onError);
  }, [onError]);

  const convertText = useCallback((id: string) => {
    if (converting.current || deleting.current) return;
    converting.current = id;
    setConvertingId(id);
    void track((async () => {
      await flushLatestText(id);
      setEditingId(current => current === id ? null : current);
      const result = await enqueue(() => desktop.convertCollectionText(id));
      changeNodes(current => current.map(item => item.id === id ? { ...item, data: result } : item));
      onEntryCreated();
      if (area.current) onOpenEntry(result.entryId!);
    })()).catch(onError).finally(() => {
      converting.current = null;
      setConvertingId(null);
    });
  }, [changeNodes, enqueue, flushLatestText, onEntryCreated, onError, onOpenEntry, track]);

  const nodeActions = useMemo(() => ({
    editingId, convertingId, edit, remove, focus, color, fitImage, registerTextEditor, markTextDirty, saveText, finishText, resize, loadArticle,
    activeWebNodeId, webPreviews, setWebSlot, copyText, convertText,
    articleQueue: articleEdit?.queue, articleLocked, clipboard,
    registerArticleEditor, finishArticle, discardArticle, onArticleImages, onError,
  }), [editingId, convertingId, edit, remove, focus, color, fitImage, registerTextEditor, markTextDirty, saveText, finishText, resize, loadArticle, activeWebNodeId,
    webPreviews, copyText, convertText, articleEdit, articleLocked, clipboard, registerArticleEditor, finishArticle, discardArticle, onArticleImages, onError]);

  function closeDialog() {
    setDialog(null);
    requestAnimationFrame(() => area.current?.focus());
  }

  function editEdge(edge: Edge) {
    (document.activeElement as HTMLElement | null)?.blur();
    setDialog({ type: "edge", edge });
  }

  return <div id="collection-canvas-panel" role="tabpanel" aria-labelledby={`collection-tab-${collectionId}`} className="document-body collection-workspace" inert={articleLocked}>
    <ContextMenu.Root>
    <ContextMenu.Trigger>
    <div className="collection-flow" tabIndex={0} ref={area} aria-label="专题画布"
      onPointerDownCapture={event => { activePointers.current.add(event.pointerId); }}
      onContextMenuCapture={event => {
        const element = event.target as Element;
        if (!event.currentTarget.contains(element) || element.closest(".collection-inline-editor")) return;
        if (element.closest("textarea, input, [contenteditable=true]")) { event.stopPropagation(); return; }
        const node = element.closest<HTMLElement>(".react-flow__node[data-id]");
        const edge = element.closest<SVGElement>(".react-flow__edge[data-id]");
        if (node) setMenu({ type: "node", id: node.dataset.id! });
        else if (edge) setMenu({ type: "edge", id: edge.dataset.id! });
        else setMenu({ type: "canvas", point: event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined });
      }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={event => {
         if (!event.dataTransfer.files.length || (event.target as Element).closest(".collection-inline-editor")) return;
        event.preventDefault();
        const files = [...event.dataTransfer.files];
        const point = { x: event.clientX, y: event.clientY };
        void track((async () => {
          const failures: string[] = [];
          for (const file of files) {
            if (!area.current) break;
            try {
              const assetId = await desktop.assetImport(file, "attachment");
              if (area.current) await addNode({ kind: "image", assetId }, point);
            } catch (error) { failures.push(`${file.name}：${errorMessage(error)}`); }
          }
          if (failures.length) onError(failures.join("；"));
        })()).catch(onError);
      }}
      onKeyDownCapture={event => {
        const element = event.target as Element;
        if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229
          || !event.currentTarget.contains(element) || element.closest(".collection-inline-editor")) return;
        event.stopPropagation();
        leaveEdit();
        clearSelection();
        area.current?.focus();
      }}
      onPointerCancelCapture={() => { selectingCards.current = false; }}
      onKeyDown={event => {
        const element = event.target as Element;
        if (event.nativeEvent.isComposing || event.defaultPrevented ||
          !event.currentTarget.contains(element) || element.closest("input, textarea, [contenteditable=true], [role=dialog]")) return;
        if (event.shiftKey && event.code === "Digit2" && !event.ctrlKey && !event.metaKey && !event.altKey && selectedNodes.length === 1) {
          event.preventDefault();
          focus(selectedNodes[0].id);
        }
        const deletingKey = event.key === "Delete" || (commandKey === "⌘" && event.key === "Backspace");
        if (deletingKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          if (event.repeat) return;
          if (element.closest(".react-flow__edge") || (explicitEdgeSelection.current && selectedEdges.length)) removeItems([], selectedEdges);
          else removeItems(selectedNodes, selectedEdges);
        }
      }}>
      <CollectionNodeContext.Provider value={nodeActions}>
        <ReactFlow<FlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={collectionNodeTypes}
          defaultEdgeOptions={edgeDefaults} onNodesChange={onNodesChange}
          onEdgesChange={changes => {
            if (!selectingCards.current && changes.some(change => change.type === "select" && change.selected)) {
              ++selectionIntent.current;
              explicitEdgeSelection.current = true;
            }
            setEdges(current => applyEdgeChanges(changes, current));
          }}
          panOnDrag={rightMousePan} panActivationKeyCode={null} proOptions={proOptions}
          defaultViewport={initial.collection.viewport} minZoom={0.1} maxZoom={3} colorMode={dark ? "dark" : "light"}
          onMoveEnd={() => {
            window.clearTimeout(viewportTimer.current);
            viewportTimer.current = window.setTimeout(() => {
              void rememberViewport(flow.getViewport()).catch(onError);
            }, 250);
          }}
          onConnect={({ source, target }) => connect(source, target)} isValidConnection={({ source, target }) => source !== target}
          onNodeClick={(event) => {
            revealPreview.current = null;
            if (!editingId) {
              ++selectionIntent.current;
              ++editIntent.current;
            }
            explicitEdgeSelection.current = false;
            if (!(commandKey === "⌘" ? event.metaKey : event.ctrlKey)) {
              clearEdgeSelection();
            }
          }}
          onEdgeClick={() => { explicitEdgeSelection.current = true; leaveEdit(); }}
          onEdgeDoubleClick={(_event, edge) => editEdge(edge)} edgesReconnectable={false}
          onSelectionStart={() => { ++selectionIntent.current; selectingCards.current = true; explicitEdgeSelection.current = false; }}
          onSelectionEnd={() => { selectingCards.current = false; }}
          onPaneClick={event => {
            if (event.button !== 0) return;
            const intent = ++selectionIntent.current;
            leaveEdit(() => {
              if (intent !== selectionIntent.current) return;
              clearSelection();
              area.current?.focus();
            });
          }}
          onPaneContextMenu={event => {
            // React Flow reports a stationary right press as mouseup when the same button also pans.
            if (event.type !== "mouseup") return;
            const { clientX, clientY } = event;
            const edge = document.elementFromPoint(clientX, clientY)?.closest(".react-flow__edge");
            (edge ?? area.current)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX, clientY }));
          }} zoomOnDoubleClick={false} zoomOnScroll={false} deleteKeyCode={null}>
          <Background gap={16} size={1} />
          {guides && <ViewportPortal><svg className="collection-guides" width="1" height="1" aria-hidden="true">
            {guides.vertical && <line x1={guides.vertical.x} x2={guides.vertical.x} y1={guides.vertical.start} y2={guides.vertical.end} vectorEffect="non-scaling-stroke" />}
            {guides.horizontal && <line x1={guides.horizontal.start} x2={guides.horizontal.end} y1={guides.horizontal.y} y2={guides.horizontal.y} vectorEffect="non-scaling-stroke" />}
          </svg></ViewportPortal>}
        </ReactFlow>
      </CollectionNodeContext.Provider>
      {nodes.length === 0 && <div className="collection-empty">
        <Workflow size={24} strokeWidth={1.5} /><h2>右键添加内容</h2>
      </div>}
      <div className="collection-zoom button-strip" aria-label="画布缩放">
        <Tool className="chrome-icon" label="缩小画布" onClick={() => animateZoom(() => { void flow.zoomOut(zoomTransition()); })}><Minus size={15} /></Tool>
        <Tool className="chrome-icon" label="放大画布" onClick={() => animateZoom(() => { void flow.zoomIn(zoomTransition()); })}><Plus size={15} /></Tool>
        <Tool className="chrome-icon" label="适应画布" onClick={() => animateZoom(() => { void flow.fitView({ padding: 0.16, maxZoom: 1.25, ...zoomTransition() }); })}><Maximize size={15} /></Tool>
      </div>
    </div>
    </ContextMenu.Trigger>
    <ContextMenu.Content size="1" aria-label={menu.type === "canvas" ? "画布操作" : menu.type === "node" ? "卡片操作" : "连线操作"}
      onCloseAutoFocus={event => {
        const action = actionAfterMenu.current;
        if (!action) return;
        actionAfterMenu.current = null;
        event.preventDefault();
        action();
      }}>
      {menu.type === "canvas" && <>
        <ContextMenu.Item onSelect={() => { actionAfterMenu.current = () => setDialog({ type: "picker", point: menu.point }); }}>
          <FileText size={15} />添加文章
        </ContextMenu.Item>
        <ContextMenu.Item onSelect={() => void addNode({ kind: "text", contentMd: "" }, menu.point).catch(onError)}><StickyNote size={15} />新建文本</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => { actionAfterMenu.current = () => setDialog({ type: "github", point: menu.point }); }}><FilePlus2 size={15} />导入 GitHub README</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => pasteContent(menu.point)}><Clipboard size={15} />粘贴</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item color="red" onSelect={() => { actionAfterMenu.current = onDelete; }}><Trash2 size={15} />删除专题</ContextMenu.Item>
      </>}
      {menuNode && <>
        {menuNode.data.entryId && menuNode.data.entry?.deletedAt === null && <>
          <ContextMenu.Item disabled={articleLocked} onSelect={() => { actionAfterMenu.current = () => edit(menuNode.id); }}><SquarePen size={15} />编辑正文</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => onOpenEntry(menuNode.data.entryId!)}><BookOpen size={15} />打开文章</ContextMenu.Item>
        </>}
        {menuNode.data.assetId && <>
          <ContextMenu.Item onSelect={() => { actionAfterMenu.current = () => edit(menuNode.id); }}><Scaling size={15} />调整图片大小</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => previewImage(menuNode.data.assetId!)}><Image size={15} />查看图片</ContextMenu.Item>
        </>}
        {menuNode.data.kind === "text" && <>
          <ContextMenu.Item disabled={convertingId === menuNode.id} onSelect={() => { actionAfterMenu.current = () => edit(menuNode.id); }}><SquarePen size={15} />编辑文本</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => copyText(menuNode.id)}><Copy size={15} />复制 Markdown</ContextMenu.Item>
          <ContextMenu.Item disabled={convertingId !== null} onSelect={() => convertText(menuNode.id)}><FilePlus2 size={15} />创建原创文章</ContextMenu.Item>
        </>}
        {menuNode.data.externalUrl && <>
          {activeWebNodeId === menuNode.id
            ? <ContextMenu.Item onSelect={clearSelection}><X size={15} />取消选中网页</ContextMenu.Item>
            : <ContextMenu.Item onSelect={() => {
              const id = menuNode.id;
              actionAfterMenu.current = () => {
                const intent = ++selectionIntent.current;
                leaveEdit(() => {
                  if (intent !== selectionIntent.current) return;
                  clearEdgeSelection();
                  changeNodes(current => current.map(node => node.selected === (node.id === id)
                    ? node : { ...node, selected: node.id === id }));
                });
              };
            }}><Globe2 size={15} />选中并打开网页</ContextMenu.Item>}
          <ContextMenu.Item onSelect={() => void desktop.openLink(menuNode.data.externalUrl!).catch(onError)}><ExternalLink size={15} />在系统浏览器打开</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => void desktop.copyText(menuNode.data.externalUrl!).catch(onError)}><Copy size={15} />复制链接</ContextMenu.Item>
        </>}
        {menuNodes.length === 1 && <ContextMenu.Item onSelect={() => focus(menuNode.id)}><Focus size={15} />聚焦当前卡片</ContextMenu.Item>}
        {menuNodes.length === 2 && <ContextMenu.Item onSelect={() => connect(menuNodes[0].id, menuNodes[1].id)}><Link2 size={15} />连接卡片</ContextMenu.Item>}
        <ContextMenu.Item color="red" disabled={menuNodes.some(node => node.id === convertingId)} onSelect={() => removeItems(menuNodes, [])}>
          <Trash2 size={15} />{menuNodes.length > 1 ? "删除选中卡片" : "删除卡片"}
        </ContextMenu.Item>
      </>}
      {menuEdge && <>
        <ContextMenu.Item onSelect={() => { actionAfterMenu.current = () => editEdge(menuEdge); }}><SquarePen size={15} />编辑连线说明</ContextMenu.Item>
        <ContextMenu.Item color="red" onSelect={() => removeItems([], [menuEdge])}><Trash2 size={15} />删除连线</ContextMenu.Item>
      </>}
    </ContextMenu.Content>
    </ContextMenu.Root>
    {dialog?.type === "picker" && <CollectionPicker onClose={closeDialog} onChoose={async entryId => { await addNode({ kind: "entry", entryId }, dialog.point); }} />}
    {dialog?.type === "github" && <GitHubImportDialog adding onClose={closeDialog} onImport={url => track((async () => {
      const result = await desktop.importGitHub(url, null);
      if (result.deleted) throw new Error("该仓库已收录，请先从回收站恢复");
      if (!result.existing) onEntryCreated();
      if (area.current) await addNode({ kind: "entry", entryId: result.entryId }, dialog.point);
    })())} />}
    {dialog?.type === "edge" && <EdgeLabelDialog label={String(dialog.edge.label ?? "")} onClose={closeDialog}
      onSave={label => enqueue(async () => {
        const id = dialog.edge.id;
        await desktop.updateCollectionEdge(id, label);
        setEdges(current => current.map(edge => edge.id === id ? { ...edge, label: label.trim(), ariaLabel: label.trim() || "连线" } : edge));
      })} />}
    {image && <ImageViewer src={image.src} alt="专题截图" onClose={() => {
      setImage(undefined);
      requestAnimationFrame(() => area.current?.focus());
    }} />}
  </div>;
}
