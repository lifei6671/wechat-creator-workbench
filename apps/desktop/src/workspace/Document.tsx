import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Button, ContextMenu, DropdownMenu, Spinner } from "@radix-ui/themes";
import {
  ArchiveRestore, BookOpen, ChevronLeft, ChevronRight, CloudUpload, Copy, EllipsisVertical, Eye, FileDown, FilePenLine, Focus, History,
  ListFilter, ListTree, Palette, PencilLine, Save, Search, Share2, SlidersHorizontal, Sparkles, Trash2, Workflow, X,
} from "lucide-react";
import type { Category, CategoryPlacement, Collection } from "../../../../packages/shared-types";
import { MarkdownEditor, type ClipboardIO, type ImageContext, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { recordEditorPerformance } from "../../../../packages/editor-react/performance";
import { footnoteId } from "../../../../packages/markdown-core";
import { renderWechat, wechatThemeId, wechatThemes, type RenderedWechat } from "../../../../packages/wechat-renderer";
import type { ChatSelection } from "../ai/context";
import previewCss from "../styles/preview.css?inline";
import { desktop, errorMessage } from "../desktop";
import { isConflict, SaveQueue } from "../editor/save-queue";
import { commandKey, untitled } from "../labels";
import { Tool, Tooltip } from "../ui";
import { loadLocalImage } from "./Publishing";
import { EditorContextMenu, editorDisplayItems, type EditorDisplay } from "./EditorContextMenu";
import { InlineEntryTitle } from "./InlineEntryTitle";
import { MoveEntryMenu } from "./MoveEntryMenu";
import { AddToCollectionMenu } from "./CollectionMenu";
import { usePointerDrag } from "./pointer-drag";

export type ViewMode = "edit" | "preview";
export type TabAction = "closeOthers" | "reading" | "properties" | "search"
  | "copyPath" | "history" | "export" | "delete" | "restore";

export function DocumentTabs({ sessions, activeId, readingIds, lockedIds, categories, collections = [], activeCollectionId,
  collectionOptions = [], onAddToCollection, onSwitchCollection, onCloseCollection, onMove, onSwitch, onClose, onAction, onReorder, onRename, onError }: {
  sessions: SaveQueue[];
  activeId: string | null;
  collections?: Collection[];
  activeCollectionId?: string;
  collectionOptions?: Collection[];
  onAddToCollection?(id: string, collection: Collection): void;
  onSwitchCollection?(id: string): void;
  onCloseCollection?(id: string): void;
  readingIds: string[];
  lockedIds: string[];
  categories: Category[];
  onMove(id: string, folder: string | null): void;
  onSwitch(id: string): void;
  onClose(id: string): void;
  onAction(id: string, action: TabAction): void;
  onReorder(id: string, anchor: string, placement: CategoryPlacement): void;
  onRename(id: string, title: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const wheelFrame = useRef(0);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  const drag = usePointerDrag<{ id: string; title: string }, { id: string; placement: CategoryPlacement }>(element => {
    const tab = element.closest<HTMLElement>("[data-tab-id]");
    return tab && !element.closest(".tab-close, .entry-inline-name") ? { id: tab.dataset.tabId!, title: tab.dataset.tabTitle! } : null;
  }, (event, item) => {
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < left || x > right || y < top || y > bottom) return null;
    for (const tab of event.currentTarget.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      const rect = tab.getBoundingClientRect();
      if (x < rect.left - 2 || x > rect.right + 2) continue;
      const id = tab.dataset.tabId!;
      return id === item.id ? null : { id, placement: x < rect.left + rect.width / 2 ? "before" : "after" };
    }
    return null;
  }, (item, target) => onReorder(item.id, target.id, target.placement));

  useLayoutEffect(() => {
    const viewport = list.current!;
    const holder = strip.current!;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let target = 0;
    let position = 0;
    let lastTime = 0;
    function measure() {
      const next = {
        overflow: viewport.scrollWidth > holder.clientWidth + 1,
        left: viewport.scrollLeft > 1,
        right: viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1,
      };
      setEdges(current => current.overflow === next.overflow && current.left === next.left && current.right === next.right ? current : next);
    }
    function animate(time: number) {
      const elapsed = lastTime ? time - lastTime : 16;
      lastTime = time;
      position += (target - position) * (1 - Math.exp(-elapsed / 48));
      if (Math.abs(target - position) < 0.5) {
        viewport.scrollLeft = target;
        wheelFrame.current = 0;
        return;
      }
      viewport.scrollLeft = position;
      wheelFrame.current = requestAnimationFrame(animate);
    }
    function wheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey || viewport.scrollWidth <= viewport.clientWidth) return;
      const delta = event.deltaX || event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? viewport.clientWidth : 1;
      if (!wheelFrame.current) position = target = viewport.scrollLeft;
      target = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, target + delta * unit));
      if (reducedMotion.matches) viewport.scrollLeft = target;
      else if (!wheelFrame.current) { lastTime = 0; wheelFrame.current = requestAnimationFrame(animate); }
    }
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    resize.observe(holder);
    viewport.addEventListener("scroll", measure);
    viewport.addEventListener("wheel", wheel, { passive: false });
    measure();
    return () => {
      resize.disconnect();
      viewport.removeEventListener("scroll", measure);
      viewport.removeEventListener("wheel", wheel);
      cancelAnimationFrame(wheelFrame.current);
      wheelFrame.current = 0;
    };
  }, [sessions.length, collections.length]);

  useLayoutEffect(() => {
    const viewport = list.current!;
    const selected = viewport.querySelector<HTMLElement>('.tab[data-active="true"]');
    if (!selected) return;
    const tab = selected.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    const distance = tab.left < area.left ? tab.left - area.left : Math.max(0, tab.right - area.right);
    if (distance) {
      cancelAnimationFrame(wheelFrame.current);
      wheelFrame.current = 0;
      viewport.scrollLeft += distance;
    }
  }, [activeId, activeCollectionId, edges.overflow]);

  function scroll(direction: -1 | 1) {
    const viewport = list.current!;
    cancelAnimationFrame(wheelFrame.current);
    wheelFrame.current = 0;
    viewport.scrollBy({ left: viewport.clientWidth * 0.65 * direction,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = {
      ArrowLeft: (index - 1 + tabs.length) % tabs.length, ArrowRight: (index + 1) % tabs.length,
      Home: 0, End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  }

  return <div className="tab-strip" ref={strip}>
    {edges.overflow && <div className="tab-scroll-slot">
      {edges.left && <Tool label="向左滚动标签页" className="chrome-icon tab-scroll" onClick={() => scroll(-1)}><ChevronLeft size={15} /></Tool>}
    </div>}
    <div className="tabs" ref={list} role="tablist" aria-label="打开的内容" onKeyDown={navigate} {...drag.events}>
      {sessions.map(queue => <DocumentTab key={queue.entry.id} queue={queue} active={activeId === queue.entry.id}
        tabbable={activeId === queue.entry.id || (!activeId && !activeCollectionId && queue === sessions[0])}
        reading={readingIds.includes(queue.entry.id)} locked={lockedIds.includes(queue.entry.id)} hasOtherTabs={sessions.length > 1 || collections.length > 0}
        dragging={drag.ghost?.id === queue.entry.id} placement={drag.hint?.id === queue.entry.id ? drag.hint.placement : undefined}
        collectionOptions={collectionOptions} onAddToCollection={onAddToCollection}
        categories={categories} onMove={onMove} onSwitch={onSwitch} onClose={onClose} onAction={onAction} onRename={onRename} onError={onError} />)}
      {collections.map(collection => <CollectionTab key={`collection:${collection.id}`} item={collection} active={activeCollectionId === collection.id}
        tabbable={activeCollectionId === collection.id || (!activeId && !activeCollectionId && !sessions.length && collection === collections[0])}
        onSwitch={() => onSwitchCollection?.(collection.id)} onClose={() => onCloseCollection?.(collection.id)} />)}
    </div>
    {edges.overflow && <div className="tab-scroll-slot">
      {edges.right && <Tool label="向右滚动标签页" className="chrome-icon tab-scroll" onClick={() => scroll(1)}><ChevronRight size={15} /></Tool>}
    </div>}
    {drag.ghost && <div ref={drag.ghostElement} className="tree-drag-ghost tab-drag-ghost" aria-hidden="true"
      style={{ translate: `${drag.ghost.x}px ${drag.ghost.y}px` }}><FilePenLine size={15} /><span>{drag.ghost.title}</span></div>}
  </div>;
}

function CollectionTab({ item, active, tabbable, onSwitch, onClose }: {
  item: Collection; active: boolean; tabbable: boolean; onSwitch(): void; onClose(): void;
}) {
  return <ContextMenu.Root>
    <ContextMenu.Trigger>
      <div className="tab" role="presentation" data-active={active} onAuxClick={event => {
        if (event.button === 1) { event.preventDefault(); onClose(); }
      }}>
        <Tooltip content={item.title}>
          <button id={`collection-tab-${item.id}`} className="plain-button tab-title" type="button" role="tab" aria-selected={active}
            aria-controls="collection-canvas-panel" tabIndex={tabbable ? 0 : -1} onClick={onSwitch}>
            <Workflow size={14} aria-hidden="true" /><span>{item.title}</span>
          </button>
        </Tooltip>
        <Tool className="chrome-icon tab-close" label={`关闭 ${item.title}`} onClick={onClose}><X size={14} /></Tool>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Content size="1" aria-label="专题标签操作">
      <ContextMenu.Item onSelect={onClose}><X size={15} />关闭标签页</ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>;
}

function DocumentTab({ queue, active, tabbable, reading, locked, hasOtherTabs, dragging, placement, categories, collectionOptions,
  onAddToCollection, onMove, onSwitch, onClose, onAction, onRename, onError }: {
  queue: SaveQueue;
  active: boolean;
  tabbable: boolean;
  collectionOptions: Collection[];
  onAddToCollection?(id: string, collection: Collection): void;
  reading: boolean;
  locked: boolean;
  hasOtherTabs: boolean;
  dragging: boolean;
  placement?: CategoryPlacement;
  categories: Category[];
  onMove(id: string, folder: string | null): void;
  onSwitch(id: string): void;
  onClose(id: string): void;
  onAction(id: string, action: TabAction): void;
  onRename(id: string, title: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameAfterMenu = useRef(false);
  const fields = useSyncExternalStore(queue.subscribe, queue.snapshotFields);
  const dirty = useSyncExternalStore(queue.subscribe, queue.isDirty);
  const { id, deletedAt } = queue.entry;
  const title = fields.title || untitled;
  const frozen = reading || locked;
  const act = (action: TabAction) => onAction(id, action);
  if (renaming) return <div className="tab entry-inline" data-active={active}>
    <InlineEntryTitle title={fields.title} placeholder={untitled} onSave={name => onRename(id, name)} onError={onError}
      onClose={restore => {
        setRenaming(false);
        if (restore) requestAnimationFrame(() => { if (document.activeElement === document.body) document.getElementById(`tab-${id}`)?.focus(); });
      }} />
  </div>;
  return <ContextMenu.Root>
    <ContextMenu.Trigger>
      <div className="tab" role="presentation" data-active={active} data-tab-id={id} data-tab-title={title}
        data-placement={placement} data-dragging={dragging || undefined} onAuxClick={event => {
        if (event.button === 1) { event.preventDefault(); onClose(id); }
      }}>
        <Tooltip content={title}>
          <button id={`tab-${id}`} className="plain-button tab-title" type="button" role="tab" aria-selected={active}
            aria-controls="document-body" tabIndex={tabbable ? 0 : -1} onClick={() => onSwitch(id)}>
            {dirty && <span className="unsaved-dot" role="img" aria-label="有未保存的修改" />}
            <span>{title}</span>
          </button>
        </Tooltip>
        <Tool className="chrome-icon tab-close" label={`关闭 ${title}`} onClick={() => onClose(id)}><X size={14} /></Tool>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Content size="1" aria-label="标签页操作" onCloseAutoFocus={event => {
      if (!renameAfterMenu.current) return;
      renameAfterMenu.current = false;
      event.preventDefault();
      setRenaming(true);
    }}>
      <ContextMenu.Item disabled={locked} onSelect={() => onClose(id)}><X size={15} />关闭标签页</ContextMenu.Item>
      <ContextMenu.Item disabled={!hasOtherTabs || locked} onSelect={() => act("closeOthers")}><X size={15} />关闭其他标签页</ContextMenu.Item>
      <ContextMenu.Separator />
      {deletedAt === null && <ContextMenu.Item disabled={locked} onSelect={() => act("reading")}><BookOpen size={15} />{reading ? "退出阅读模式" : "阅读模式"}</ContextMenu.Item>}
      <ContextMenu.Item onSelect={() => act("search")}><Search size={15} />{frozen || deletedAt !== null ? "查找" : "查找与替换"}</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => act("properties")}><FilePenLine size={15} />内容属性</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => act("history")}><History size={15} />历史版本</ContextMenu.Item>
      {deletedAt === null && onAddToCollection && <AddToCollectionMenu entryId={id} collections={collectionOptions} disabled={locked}
        onAdd={collection => onAddToCollection(id, collection)} onError={onError} />}
      <ContextMenu.Separator />
      {deletedAt === null && <>
        <ContextMenu.Item disabled={frozen} onSelect={() => { renameAfterMenu.current = true; }}><PencilLine size={15} />重命名</ContextMenu.Item>
        <MoveEntryMenu categories={categories} current={fields.categoryId} disabled={frozen} onMove={folder => onMove(id, folder)} />
      </>}
      <ContextMenu.Item onSelect={() => act("copyPath")}><Copy size={15} />复制工作区路径</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => act("export")}><FileDown size={15} />导出 Markdown</ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item color={deletedAt === null ? "red" : undefined} disabled={frozen} onSelect={() => act(deletedAt === null ? "delete" : "restore")}>
        {deletedAt === null ? <><Trash2 size={15} />移入回收站</> : <><ArchiveRestore size={15} />从回收站恢复</>}
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>;
}

export function DocumentEditor({ queue, active, locked, reading, clipboard, display, onDisplayChange, handle, onImages, localizeImageLink, onImageZoom, onError, canHost, hostBusy, uploadingSource, onHostImage, onAddSelectionToChat }: {
  queue: SaveQueue;
  active: boolean;
  locked: boolean;
  reading: boolean;
  clipboard: ClipboardIO;
  display: EditorDisplay;
  onDisplayChange(option: keyof EditorDisplay, checked: boolean): void;
  handle(value: MarkdownEditorHandle | null): void;
  onImages(files: File[]): Promise<string>;
  localizeImageLink?(url: string): Promise<string>;
  onImageZoom(image: { src: string; alt: string }, trigger: HTMLButtonElement): void;
  onError(error: unknown): void;
  canHost?(src: string): boolean;
  hostBusy?: boolean;
  uploadingSource?: string;
  onHostImage?(image: ImageContext): void;
  onAddSelectionToChat?(selection: ChatSelection): void;
}) {
  const fields = useSyncExternalStore(queue.subscribe, queue.snapshotFields);
  useLayoutEffect(() => { recordEditorPerformance("document.commit"); });
  const editor = useRef<MarkdownEditorHandle>(null);
  const readOnly = reading || locked || queue.entry.deletedAt !== null;
  return <div className="document-editor" data-limit-width={display.limitWidth} data-line-numbers={display.lineNumbers}
    data-wechat-theme={wechatThemeId(fields.themeId)} hidden={!active}>
    <EditorContextMenu editor={editor} clipboard={clipboard} readOnly={readOnly} display={display} onDisplayChange={onDisplayChange} onError={onError}
      canHost={canHost} hostBusy={hostBusy} uploadingSource={uploadingSource} onHostImage={onHostImage} onAddSelectionToChat={onAddSelectionToChat}>
      <MarkdownEditor entryId={queue.entry.id} value={fields.contentMd} readOnly={readOnly} active={active} lineNumbers={display.lineNumbers} convertLinks={display.convertLinks}
        githubRepo={fields.source?.url}
        title={display.showTitle && <div className="writing-title">
        {reading ? <h1>{fields.title || untitled}</h1> : <textarea aria-label="标题" rows={1}
          value={fields.title} readOnly={readOnly} placeholder={untitled}
          onChange={event => queue.edit({ title: event.target.value.replace(/[\r\n]+/g, " ") })}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              editor.current?.focus();
            }
          }} onBlur={() => { void queue.flush(); }} />}
        </div>}
        ref={value => {
          editor.current = value;
          if (!value) return;
          const release = queue.bindContentProvider(value.captureMarkdown);
          handle(value);
          return () => { release(); editor.current = null; handle(null); };
        }} onError={onError} resolveImage={loadLocalImage}
        imageErrorMessage={errorMessage} onImageZoom={onImageZoom} onOpenLink={desktop.openLink}
        onDocumentChanged={(_id, revision) => queue.markContentDirty(revision)}
        onBlur={() => { void queue.flush(); }} onImages={onImages} localizeImageLink={localizeImageLink} />
    </EditorContextMenu>
  </div>;
}

export function MarkdownPreview({ title, markdown, themeId, revision, githubRepo, projectLinks }: {
  title: string; markdown: string; themeId?: string | null; revision: number; githubRepo?: string; projectLinks?: MarkdownEditorHandle["linkFootnoteMarkdown"] | null;
}) {
  const snapshot = useMemo(() => ({ markdown, themeId, revision, githubRepo }), [markdown, themeId, revision, githubRepo]);
  const deferred = useDeferredValue(snapshot);
  const host = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLElement>(null);
  const displayed = useRef<RenderedWechat | null>(null);
  const [assetRevision, setAssetRevision] = useState(0);
  const resources = useRef(new Map<string, { image: ReturnType<typeof loadLocalImage>; failed: boolean }>());

  useLayoutEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = previewCss;
    const article = document.createElement("article");
    const titleElement = document.createElement("h1");
    titleElement.className = "preview-title";
    const content = document.createElement("div");
    article.append(titleElement, content);
    root.replaceChildren(style, article);
    heading.current = titleElement;
    body.current = content;
    const cache = resources.current;
    return () => {
      displayed.current?.dispose();
      for (const item of cache.values()) void item.image.then(image => image.dispose(), () => {});
      cache.clear();
    };
  }, []);

  useLayoutEffect(() => {
    heading.current!.textContent = title || untitled;
  }, [title]);

  useEffect(() => {
    const listener = desktop.onAssetsChanged(() => {
      let refresh = false;
      for (const [url, item] of resources.current) {
        if (item.failed) { resources.current.delete(url); refresh = true; }
      }
      if (refresh) setAssetRevision(value => value + 1);
    });
    return () => { void listener.then(remove => remove(), () => {}); };
  }, []);

  useEffect(() => {
    if (projectLinks === null) return;
    let alive = true;
    const controller = new AbortController();
    void Promise.resolve().then(() => renderWechat({ ...deferred, markdown: projectLinks?.(deferred.markdown) ?? deferred.markdown, output: "preview" }, {
      signal: controller.signal,
      sources: desktop.wechatGraphics,
      derive: desktop.deriveImage,
      image(url) {
        let item = resources.current.get(url);
        if (!item) {
          const entry = { image: loadLocalImage(url), failed: false };
          void entry.image.catch(() => { entry.failed = true; });
          resources.current.set(url, entry);
          item = entry;
        }
        return item.image;
      },
    })).then(result => {
      if (!alive) { result.dispose(); return; }
      displayed.current?.dispose();
      displayed.current = result;
      const content = body.current!;
      content.innerHTML = result.html;
      for (const link of content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const href = link.getAttribute("href")!;
        if (href.startsWith("#") && footnoteId.test(href.slice(1))) {
          link.addEventListener("click", event => {
            event.preventDefault();
            content.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({ block: "nearest" });
          });
        } else {
          link.removeAttribute("href");
        }
      }
      const used = new Set(result.images.map(image => image.url));
      for (const [url, item] of resources.current) {
        if (!used.has(url)) {
          resources.current.delete(url);
          void item.image.then(image => image.dispose(), () => {});
        }
      }
    }, error => {
      if (!alive) return;
      displayed.current?.dispose();
      displayed.current = null;
      body.current!.textContent = errorMessage(error);
    });
    return () => { alive = false; controller.abort(); };
  }, [deferred, assetRevision, projectLinks]);

  return <div className="preview-phone">
    <div className="preview-phone-screen">
      <div className="markdown-preview" ref={host} role="region" aria-label="公众号排版预览" tabIndex={0} />
    </div>
  </div>;
}

export interface DocumentActions {
  mode: ViewMode;
  setMode(mode: ViewMode): void;
  focusMode: boolean;
  reading: boolean;
  onReading(): void;
  outlineOpen: boolean;
  onOutline(open: boolean): void;
  onFocusMode(): void;
  onPalette(): void;
  onAi(): void;
  aiOpen: boolean;
  onSave(): void;
  onSearch(): void;
  onProperties(): void;
  onSavedVersions(): void;
  onExport(): void;
  onExportAssets(): void;
  onExportWechat(): void;
  onCopyWechat(): void;
  onCopyMarkdown?(): void;
  onHostImages?(): void;
  hostingImages?: boolean;
  publishing: boolean;
  onDelete(): void;
  onDraft(): void;
  onCopy(): void;
  onReload(): void;
  onRetry(): void;
}
function BreadcrumbTitle({ queue, title, readOnly }: { queue: SaveQueue; title: string; readOnly: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = useRef(false);
  const placeholder = untitled;
  if (readOnly) return <span className="path-title" aria-current="page" title={title}>{title || placeholder}</span>;
  return <input className="path-title path-title-input" aria-label="内容标题" aria-current="page" value={draft ?? title}
    placeholder={placeholder} title={draft === null ? title : undefined} spellCheck={false}
    onFocus={event => { setDraft(title); event.currentTarget.select(); }}
    onChange={event => setDraft(event.currentTarget.value)}
    onBlur={event => {
      if (!cancel.current) {
        const next = event.currentTarget.value.trim();
        if (next !== queue.snapshot().fields.title) queue.edit({ title: next });
      }
      cancel.current = false;
      setDraft(null);
    }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        cancel.current = event.key === "Escape";
        event.currentTarget.blur();
        if (event.key === "Enter") void queue.flush();
      }
    }} />;
}

export function DocumentToolbar({ queue, categories, actions, onReveal, display, onDisplayChange, locked }: {
  queue: SaveQueue; categories: Category[]; actions: DocumentActions;
  onReveal(categoryId: string | null): void;
  display: EditorDisplay;
  locked: boolean;
  onDisplayChange(option: keyof EditorDisplay, checked: boolean): void;
}) {
  const { fields } = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const deleted = queue.entry.deletedAt !== null;
  const folder = categories.find(category => category.id === fields.categoryId);
  const parent = categories.find(category => category.id === folder?.parentId);
  return <div className="section-bar document-tools">
    <nav className="document-path" aria-label="内容路径">
      {deleted ? <span>回收站</span> : <>
        <button className="plain-button path-part" type="button" onClick={() => onReveal(null)}>目录</button>
        {[parent, folder].map(category => category && <span className="path-folder" key={category.id}>
          <ChevronRight size={12} />
          <Tooltip content={category.name}>
            <button className="plain-button path-part" type="button" onClick={() => onReveal(category.id)}>{category.name}</button>
          </Tooltip>
        </span>)}
      </>}
      <ChevronRight size={12} /><BreadcrumbTitle key={queue.sessionId} queue={queue} title={fields.title} readOnly={deleted || actions.reading || locked} />
    </nav>
    <div className="button-strip document-actions">
      {deleted && <Button size="1" variant="ghost" color="gray" onClick={actions.onDelete}><ArchiveRestore size={15} />恢复</Button>}
      <DropdownMenu.Root>
        <Tooltip content="分享"><DropdownMenu.Trigger><button className="plain-button chrome-icon" type="button" aria-label="分享">
          {actions.publishing ? <Spinner size="1" /> : <Share2 size={16} strokeWidth={1.65} />}
        </button></DropdownMenu.Trigger></Tooltip>
        <DropdownMenu.Content align="end" size="1">
          {!deleted && <>
            <DropdownMenu.Item disabled={actions.publishing} onSelect={actions.onCopyWechat}><Copy size={14} />复制公众号格式</DropdownMenu.Item>
            <DropdownMenu.Item disabled={actions.publishing} onSelect={actions.onExportWechat}><FileDown size={14} />导出排版 HTML</DropdownMenu.Item>
            <DropdownMenu.Separator />
          </>}
          <DropdownMenu.Item onSelect={actions.onExport}><FileDown size={14} />导出 Markdown</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={actions.onExportAssets}><FileDown size={14} />导出 Markdown 和图片</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {!deleted && <Tool className="chrome-icon reading-toggle" label={actions.reading ? "退出阅读模式" : "阅读模式"}
        aria-pressed={actions.reading} onClick={actions.onReading}><BookOpen size={16} strokeWidth={1.65} /></Tool>}
      <DropdownMenu.Root>
        <Tooltip content="更多编辑操作"><DropdownMenu.Trigger><button type="button" id="document-action-trigger" className="plain-button chrome-icon" aria-label="更多编辑操作"><EllipsisVertical size={17} /></button></DropdownMenu.Trigger></Tooltip>
        <DropdownMenu.Content align="end" size="1">
          <DropdownMenu.Item onSelect={actions.onProperties}><FilePenLine size={14} />内容属性</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={actions.onSearch}><Search size={14} />{deleted || actions.reading ? "查找" : "查找与替换"}</DropdownMenu.Item>
          {actions.mode === "edit" && <DropdownMenu.CheckboxItem checked={actions.outlineOpen}
            onCheckedChange={actions.onOutline}><ListTree size={14} />显示文档大纲</DropdownMenu.CheckboxItem>}
          {!deleted && !actions.reading && <DropdownMenu.Item onSelect={actions.onCopyMarkdown}><Copy size={14} />复制 Markdown</DropdownMenu.Item>}
          {!deleted && !actions.reading && <DropdownMenu.Item onSelect={actions.onSave}><Save size={14} />保存版本 <kbd className="menu-shortcut">{commandKey}S</kbd></DropdownMenu.Item>}
          {!deleted && !actions.reading && actions.onHostImages && <DropdownMenu.Item disabled={locked || actions.hostingImages}
            onSelect={actions.onHostImages}>
            {actions.hostingImages ? <span className="image-upload-menu-spinner rich-progress" aria-hidden="true" /> : <CloudUpload size={14} />}
            {actions.hostingImages ? "正在上传图片…" : "批量上传到图床"}
          </DropdownMenu.Item>}
          <DropdownMenu.Item onSelect={actions.onSavedVersions}><History size={14} />历史版本</DropdownMenu.Item>
          <DropdownMenu.Separator />
          {!actions.reading && <DropdownMenu.Item onSelect={() => actions.setMode(actions.mode === "edit" ? "preview" : "edit")}>
            {actions.mode === "edit" ? <><Eye size={14} />预览排版</> : <><PencilLine size={14} />继续编辑</>}
          </DropdownMenu.Item>}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger><SlidersHorizontal size={14} />显示选项</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              {editorDisplayItems.map(([option, label, Icon]) => <DropdownMenu.CheckboxItem key={option} checked={display[option]}
                onCheckedChange={checked => onDisplayChange(option, checked)}><Icon size={15} />{label}</DropdownMenu.CheckboxItem>)}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
          {!deleted && !actions.reading && <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger><Palette size={14} />公众号主题</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              <DropdownMenu.RadioGroup value={wechatThemeId(fields.themeId)} onValueChange={themeId => queue.edit({ themeId })}>
                {wechatThemes.map(theme => <DropdownMenu.RadioItem key={theme.id} value={theme.id}>{theme.label}</DropdownMenu.RadioItem>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>}
          {!actions.reading && <DropdownMenu.CheckboxItem checked={actions.aiOpen} onCheckedChange={actions.onAi} disabled={actions.focusMode}><Sparkles size={15} />AI 助手</DropdownMenu.CheckboxItem>}
          <DropdownMenu.Item onSelect={actions.onFocusMode}><Focus size={15} />{actions.focusMode ? "退出专注写作" : "专注写作"}</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={actions.onPalette}><ListFilter size={15} />命令面板 <kbd className="menu-shortcut">{commandKey}K</kbd></DropdownMenu.Item>
          {!actions.reading && <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item color={deleted ? undefined : "red"} onSelect={actions.onDelete}>
              {deleted ? <ArchiveRestore size={14} /> : <Trash2 size={14} />}{deleted ? "从回收站恢复" : "移入回收站"}
            </DropdownMenu.Item>
          </>}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </div>;
}

export function DocumentSaveError({ queue, actions }: {
  queue: SaveQueue;
  actions: Pick<DocumentActions, "onCopy" | "onDraft" | "onReload" | "onRetry">;
}) {
  const error = useSyncExternalStore(queue.subscribe, () => queue.snapshot().error);
  const [expanded, setExpanded] = useState(false);
  if (!error) return null;
  const conflict = isConflict(error);
  const reason = conflict ? `内容已更新至版本 ${error.currentVersion}，当前稿仍在编辑器中` : errorMessage(error);
  return <div className="save-error" role="alert">
    <span title={reason} className={expanded ? "" : "error-ellipsis"}>{reason}</span>
    <div className="button-strip">
      {conflict ? <>
        <Button size="1" variant="soft" onClick={actions.onCopy}>复制当前稿</Button>
        <Button size="1" variant="soft" onClick={actions.onDraft}>另存为副本</Button>
        <Button size="1" variant="soft" onClick={actions.onReload}>重新加载</Button>
      </> : <>
        <Button size="1" variant="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? "收起详情" : "详情"}</Button>
        <Button size="1" variant="soft" onClick={actions.onRetry}>重试保存</Button>
      </>}
    </div>
  </div>;
}
