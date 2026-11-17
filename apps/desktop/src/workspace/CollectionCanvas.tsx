import { useCallback, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { Background, ReactFlow, ReactFlowProvider, ViewportPortal, applyEdgeChanges, applyNodeChanges, useReactFlow,
  type Edge, type NodeChange, type Viewport } from "@xyflow/react";
import { BookOpen, Clipboard, Copy, FilePlus2, FileText, Focus, Image, Link2, Maximize, Minus, Plus, Scaling, SquarePen, StickyNote, Trash2, Workflow } from "lucide-react";
import { Button, ContextMenu, Spinner } from "@radix-ui/themes";
import type { CanvasCardColor, CanvasEdge, CanvasGeometry, CanvasNode, CanvasNodeContent, CanvasPosition, Collection, CollectionCanvas as Canvas, Entry, EntryFields, SaveMode, SaveResult } from "../../../../packages/shared-types";
import type { ClipboardAction, ClipboardIO, MarkdownEditorHandle } from "../../../../packages/editor-react";
import { desktop, errorMessage } from "../desktop";
import { commandKey, untitled } from "../labels";
import { Tool } from "../ui";
import { SaveQueue } from "../editor/save-queue";
import { CollectionNodeContext, collectionNodeTypes, type FlowNode } from "./CollectionNodes";
import { CollectionPicker, EdgeLabelDialog, GitHubImportDialog } from "./CollectionDialogs";
import { alignCollectionNodes } from "./collection-alignment";
import { ImageViewer, loadLocalImage } from "./Publishing";
import "@xyflow/react/dist/style.css";

export interface CollectionCanvasHandle {
  paste(target: EventTarget | null): boolean;
  articleClipboard(action: ClipboardAction, target: EventTarget | null, plainText?: boolean): boolean;
  flush(): Promise<void>;
  addEntry(entryId: string): Promise<void>;
}

interface Props {
  collection: Collection;
  dark: boolean;
  revision: number;
  articleLocked: boolean;
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
  const label = node.entry?.title || (node.kind === "image" ? node.assetName || "图片" : node.kind === "text" ? "文本卡片" : untitled);
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

type TextDraft = { value: string; timer: number; saving?: Promise<void> };
type ArticleEdit = { nodeId: string; queue: SaveQueue };

function CanvasWorkspace({ collection, initial, dark, revision, articleLocked, clipboard, canvasRef, track, onOpenEntry,
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
  const editIntent = useRef(0);
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
  const selectingCards = useRef(false);
  const explicitEdgeSelection = useRef(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const converting = useRef<string | null>(null);
  const [dialog, setDialog] = useState<{ type: "picker" | "github"; point?: CanvasPosition } | { type: "edge"; edge: Edge } | null>(null);
  const [menu, setMenu] = useState<{ type: "canvas"; point?: CanvasPosition } | { type: "node" | "edge"; id: string }>({ type: "canvas" });
  const actionAfterMenu = useRef<(() => void) | null>(null);
  const [image, setImage] = useState<Awaited<ReturnType<typeof loadLocalImage>>>();
  const pendingText = useRef(new Map<string, TextDraft>());
  const tail = useRef(Promise.resolve());
  const savedViewport = useRef(initial.collection.viewport);
  const viewportWrite = useRef<{ view: Viewport; saving: Promise<void> } | undefined>(undefined);
  const loadedRevision = useRef(revision);

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

  const flushText = useCallback((id: string) => {
    const draft = pendingText.current.get(id);
    if (!draft) return Promise.resolve();
    if (draft.saving) return draft.saving;
    window.clearTimeout(draft.timer);
    draft.saving = enqueue(() => desktop.updateCollectionNodeText(id, draft.value)).then(() => {
      if (pendingText.current.get(id) === draft) pendingText.current.delete(id);
    }, error => {
      draft.saving = undefined;
      throw error;
    });
    return draft.saving;
  }, [enqueue]);

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

  const leaveEdit = useCallback(() => {
    ++editIntent.current;
    if (activeArticleEdit.current) finishArticle();
    else setEditingId(null);
  }, [finishArticle]);

  const flush = useCallback(async () => {
    const writes = [...pendingText.current.keys()].map(flushText);
    const edit = activeArticleEdit.current;
    if (edit) writes.push(flushArticle(edit));
    if (flow.viewportInitialized) writes.push(rememberViewport(flow.getViewport()));
    await Promise.all(writes);
  }, [flow, flushArticle, flushText, rememberViewport]);

  const flushOnUnmount = useEffectEvent(() => {
    const edit = activeArticleEdit.current;
    void flush().catch(onError).finally(() => edit?.queue.dispose());
  });
  useLayoutEffect(() => () => flushOnUnmount(), []);
  useEffect(() => () => image?.dispose(), [image]);

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

  function addNode(content: CanvasNodeContent, point?: CanvasPosition) {
    const rect = area.current!.getBoundingClientRect();
    const center = flow.screenToFlowPosition(point ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const topLeft = flow.screenToFlowPosition({ x: rect.left, y: rect.top });
    const bottomRight = flow.screenToFlowPosition({ x: rect.right, y: rect.bottom });
    const width = 320;
    const height = content.kind === "entry" ? 144 : content.kind === "image" ? 224 : 200;
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
      changeNodes(current => [...current, toFlowNode(node)]);
    });
  }

  function pasteContent(point?: CanvasPosition) {
    void track((async () => {
      const content = await desktop.readClipboard(true, false);
      if (!content || !area.current) return;
      if (content.kind === "text" && content.text.trim()) await addNode({ kind: "text", contentMd: content.text }, point);
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
      || target.closest("textarea, input, [contenteditable=true], button, a")) return false;
    pasteContent();
    return true;
  }
  useImperativeHandle(canvasRef, () => ({
    paste, flush, addEntry: entryId => addNode({ kind: "entry", entryId }),
    articleClipboard: (action, target, plainText) => articleEditor.current?.clipboard(action, clipboard, target, plainText) ?? false,
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
    void flow.fitView({ nodes: [{ id }], padding: 0.22, maxZoom: 1.25 });
  }, [flow]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const selection = changes.filter(change => change.type === "select");
    if (selection.some(change => change.selected && change.id !== editingId)) leaveEdit();
    if (selection.some(change => change.selected)) explicitEdgeSelection.current = false;
    if (!selectingCards.current && selection.length && !selection.some(change => change.selected)) {
      const deselecting = new Set(selection.map(change => change.id));
      // Edge selection and modifier clicks can request that React Flow clears the last selected card.
      if (nodesRef.current.every(node => !node.selected || deselecting.has(node.id))) {
        changes = changes.filter(change => change.type !== "select");
      }
    }
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
    if (!node || converting.current === id || activeArticleEdit.current?.nodeId === id) return;
    if (node.data.kind === "entry" && (articleLocked || !node.data.entryId || node.data.entry?.deletedAt !== null)) return;
    if (!node.selected) {
      changeNodes(current => current.map(item => item.selected === (item.id === id)
        ? item : { ...item, selected: item.id === id }));
    }
    const intent = ++editIntent.current;
    if (!activeArticleEdit.current && node.data.kind !== "entry") { setEditingId(id); return; }
    void (async () => {
      await finishArticleEdit();
      if (node.data.kind !== "entry") {
        if (area.current && intent === editIntent.current) setEditingId(id);
        return;
      }
      const entry = await onLoadArticle(node.data.entryId!);
      if (!area.current || intent !== editIntent.current || !nodesRef.current.some(item => item.id === id)) return;
      const next = { nodeId: id, queue: new SaveQueue(entry, (...args) => track(onSaveArticle(...args)), onEntryCreated) };
      activeArticleEdit.current = next;
      setArticleEdit(next);
      setEditingId(id);
    })().catch(onError);
  }, [articleLocked, changeNodes, finishArticleEdit, onEntryCreated, onError, onLoadArticle, onSaveArticle, track]);
  const changeText = useCallback((id: string, value: string) => {
    if (converting.current === id || !nodesRef.current.some(node => node.id === id && node.data.kind === "text")) return;
    window.clearTimeout(pendingText.current.get(id)?.timer);
    changeNodes(current => current.map(node => node.id === id ? { ...node, data: { ...node.data, contentMd: value } } : node));
    pendingText.current.set(id, { value, timer: window.setTimeout(() => { void flushText(id).catch(onError); }, 350) });
  }, [changeNodes, flushText, onError]);
  const finishText = useCallback((id: string) => {
    setEditingId(current => current === id ? null : current);
    void flushText(id).catch(onError);
  }, [flushText, onError]);

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

  const selectedNodes = nodes.filter(node => node.selected);
  const selectedEdges = edges.filter(edge => edge.selected);
  function clearEdgeSelection() {
    explicitEdgeSelection.current = false;
    setEdges(current => current.some(edge => edge.selected)
      ? current.map(edge => edge.selected ? { ...edge, selected: false } : edge) : current);
  }
  const menuNode = menu.type === "node" ? nodes.find(node => node.id === menu.id) : undefined;
  const menuEdge = menu.type === "edge" ? edges.find(edge => edge.id === menu.id) : undefined;
  const menuNodes = menuNode?.selected ? selectedNodes : menuNode ? [menuNode] : [];
  const deleting = useRef(false);
  const removeItems = useCallback((nodesToDelete: FlowNode[], edgesToDelete: Edge[]) => {
    if ((!nodesToDelete.length && !edgesToDelete.length) || deleting.current || nodesToDelete.some(node => node.id === converting.current)) return;
    deleting.current = true;
    const removed = new Set(nodesToDelete.map(node => node.id));
    void enqueue(async () => {
      const edit = activeArticleEdit.current;
      if (edit && removed.has(edit.nodeId)) await finishArticleEdit();
      for (const edge of edgesToDelete) {
        if (removed.has(edge.source) || removed.has(edge.target)) continue;
        await desktop.deleteCollectionEdge(edge.id);
        setEdges(current => current.filter(item => item.id !== edge.id));
      }
      for (const id of removed) {
        await desktop.deleteCollectionNode(id);
        window.clearTimeout(pendingText.current.get(id)?.timer);
        pendingText.current.delete(id);
        changeNodes(current => current.filter(node => node.id !== id));
        setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id));
      }
    }).catch(onError).finally(() => { deleting.current = false; });
  }, [changeNodes, enqueue, finishArticleEdit, onError]);

  const remove = useCallback((id: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (node) removeItems([node], []);
  }, [removeItems]);
  const nodeActions = useMemo(() => ({
    editingId, convertingId, edit, remove, focus, color, fitImage, changeText, finishText, resize, loadArticle,
    articleQueue: articleEdit?.queue, articleLocked, clipboard,
    registerArticleEditor, finishArticle, discardArticle, onArticleImages, onError,
  }), [editingId, convertingId, edit, remove, focus, color, fitImage, changeText, finishText, resize, loadArticle,
    articleEdit, articleLocked, clipboard, registerArticleEditor, finishArticle, discardArticle, onArticleImages, onError]);

  function convert(node: FlowNode) {
    if (converting.current || deleting.current) return;
    converting.current = node.id;
    setConvertingId(node.id);
    setEditingId(current => current === node.id ? null : current);
    void track((async () => {
      await flushText(node.id);
      const result = await enqueue(() => desktop.convertCollectionText(node.id));
      changeNodes(current => current.map(item => item.id === node.id ? { ...item, data: result } : item));
      onEntryCreated();
      if (area.current) onOpenEntry(result.entryId!);
    })()).catch(onError).finally(() => {
      converting.current = null;
      setConvertingId(null);
    });
  }

  function closeDialog() {
    setDialog(null);
    requestAnimationFrame(() => area.current?.focus());
  }

  function editEdge(edge: Edge) {
    (document.activeElement as HTMLElement | null)?.blur();
    setDialog({ type: "edge", edge });
  }

  return <div id="collection-canvas-panel" role="tabpanel" aria-labelledby={`collection-tab-${collectionId}`} className="document-body collection-workspace">
    <ContextMenu.Root>
    <ContextMenu.Trigger>
    <div className="collection-flow" tabIndex={0} ref={area} aria-label="专题画布"
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
        if (!event.dataTransfer.files.length || (event.target as Element).closest(".collection-article-editor")) return;
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
        clearEdgeSelection();
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
              explicitEdgeSelection.current = true;
            }
            setEdges(current => applyEdgeChanges(changes, current));
          }}
          panOnDrag={rightMousePan} panActivationKeyCode={null} proOptions={proOptions}
          defaultViewport={initial.collection.viewport} minZoom={0.1} maxZoom={3} colorMode={dark ? "dark" : "light"}
          onMoveEnd={(_event, viewport) => { void rememberViewport(viewport).catch(onError); }}
          onConnect={({ source, target }) => connect(source, target)} isValidConnection={({ source, target }) => source !== target}
          onNodeClick={event => {
            explicitEdgeSelection.current = false;
            if (!(commandKey === "⌘" ? event.metaKey : event.ctrlKey)) clearEdgeSelection();
          }}
          onEdgeClick={() => { explicitEdgeSelection.current = true; }}
          onEdgeDoubleClick={(_event, edge) => editEdge(edge)} edgesReconnectable={false}
          onSelectionStart={() => { selectingCards.current = true; explicitEdgeSelection.current = false; }}
          onSelectionEnd={() => { selectingCards.current = false; }}
          onPaneClick={event => {
            if (event.button !== 0) return;
            leaveEdit();
            changeNodes(current => current.map(node => node.selected ? { ...node, selected: false } : node));
            clearEdgeSelection();
            area.current?.focus();
          }}
          onPaneContextMenu={event => {
            // React Flow reports a stationary right press as mouseup when the same button also pans.
            if (event.type !== "mouseup") return;
            const { clientX, clientY } = event;
            const edge = document.elementFromPoint(clientX, clientY)?.closest(".react-flow__edge");
            (edge ?? area.current)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX, clientY }));
          }} zoomOnDoubleClick={false} deleteKeyCode={null}>
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
        <Tool className="chrome-icon" label="缩小画布" onClick={() => void flow.zoomOut()}><Minus size={15} /></Tool>
        <Tool className="chrome-icon" label="放大画布" onClick={() => void flow.zoomIn()}><Plus size={15} /></Tool>
        <Tool className="chrome-icon" label="适应画布" onClick={() => void flow.fitView({ padding: 0.16, maxZoom: 1.25 })}><Maximize size={15} /></Tool>
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
          <ContextMenu.Item onSelect={() => void desktop.copyText(menuNode.data.contentMd).catch(onError)}><Copy size={15} />复制 Markdown</ContextMenu.Item>
          <ContextMenu.Item disabled={convertingId !== null} onSelect={() => convert(menuNode)}><FilePlus2 size={15} />创建原创文章</ContextMenu.Item>
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
    {dialog?.type === "picker" && <CollectionPicker onClose={closeDialog} onChoose={entryId => addNode({ kind: "entry", entryId }, dialog.point)} />}
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
