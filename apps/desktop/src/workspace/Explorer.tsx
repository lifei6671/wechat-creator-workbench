import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { Button, ContextMenu, DropdownMenu, Spinner, Tooltip } from "@radix-ui/themes";
import {
  ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, FileDown, FilePenLine, FileUp, Files, FileText,
  FolderInput, FolderOpen, FolderPlus, History, Link, PencilLine, Plus, Trash2,
} from "lucide-react";
import type { Category, CategoryIcon, CategoryPlacement, EntryPage, EntryRow, Library } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { dateLabel, statusLabels, untitled } from "../labels";
import { Tool } from "../ui";
import { folderIcons } from "./folder-icons";
import { FolderInline } from "./FolderInline";
import { InlineEntryTitle } from "./InlineEntryTitle";
import { useExplorerDrag } from "./explorer-drag";
import { WorkspaceSearch } from "./WorkspaceSearch";

export type Section = "folders" | "search" | "assets" | "trash" | "imports";
export type CategoryAction = "delete" | "up" | "down";
export type EntryRowAction = "delete" | "restore" | "duplicate" | "move" | "copyTitle" | "copyPath" | "history" | "export";

interface CreateActions {
  onCreate(): void;
  onImportWechat(): void;
  onImportMarkdown(): void;
  disabled?: boolean;
}

function CreateItems({ Item, onCreate, onImportWechat, onImportMarkdown, disabled }: CreateActions & {
  Item: typeof DropdownMenu.Item | typeof ContextMenu.Item;
}) {
  return <>
    <Item disabled={disabled} onSelect={onCreate}><FilePenLine size={15} />新建笔记</Item>
    <Item disabled={disabled} onSelect={onImportWechat}><Link size={15} />导入公众号文章</Item>
    <Item disabled={disabled} onSelect={onImportMarkdown}><FileUp size={15} />导入 Markdown</Item>
  </>;
}

export function CreateMenu(actions: CreateActions) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      <button type="button" className="plain-button chrome-icon add-tab" aria-label="新建内容" title="新建内容">
        <Plus size={17} />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" size="1">
      <CreateItems Item={DropdownMenu.Item} {...actions} />
    </DropdownMenu.Content>
  </DropdownMenu.Root>;
}

interface ExplorerProps {
  section: Exclude<Section, "assets">;
  library: Library | null;
  page: EntryPage | null;
  active: string | null;
  readOnlyIds: string[];
  treeLocked: boolean;
  categoryId: string | undefined;
  expanded: string[];
  revision: number;
  loading: "all" | "paged";
  pageSize: number;
  caseSensitive: boolean;
  query: string;
  searchInputRef: Ref<HTMLInputElement>;
  listError: string;
  onRetry(): void;
  onQuery(query: string): void;
  onCaseSensitive(value: boolean): void;
  onFolder(id: string): void;
  onRoot(): void;
  onCreate(categoryId: string | null): void;
  onImportWechat(categoryId: string | null): void;
  onImportMarkdown(categoryId: string | null): void;
  onRevealFolder(id: string): void;
  onSaveFolder(id: string | null, parent: string | null, name: string, icon: CategoryIcon): Promise<void>;
  onFolderError(error: unknown): void;
  onReorderFolder(id: string, anchor: string, placement: CategoryPlacement): void;
  onReorderEntry(id: string, anchor: string, placement: CategoryPlacement): void;
  onRenameEntry(id: string, title: string): Promise<void>;
  onMoveEntry(id: string, categoryId: string | null): void;
  onCategoryAction(category: Category, action: CategoryAction): void;
  onOpen(id: string): void;
  onRowAction(row: EntryRow, action: EntryRowAction): void;
  onMore(): void;
}

type RowActions = Pick<ExplorerProps, "active" | "readOnlyIds" | "onOpen" | "onRowAction" | "onRenameEntry" | "onFolderError">;

export function Explorer(props: ExplorerProps) {
  const { section, library, page, categoryId, expanded, revision, loading, pageSize, query } = props;
  const [editing, setEditing] = useState<{ target?: Category; parent: string | null } | null>(null);
  const [contextFolder, setContextFolder] = useState<string | null>(null);
  const [loadingFolders, setLoadingFolders] = useState<string[]>([]);
  const markLoading = useCallback((id: string, pending: boolean) => {
    setLoadingFolders(current => pending ? [...current, id] : current.filter(folder => folder !== id));
  }, []);
  const limit = loading === "all" ? 2_147_483_647 : pageSize;
  const editAfterMenu = useRef<(() => void) | null>(null);
  const categories = library?.categories ?? [];
  const isTree = section === "folders";
  const isSearch = section === "search";
  const listLabel = isSearch ? "全文搜索" : section === "imports" ? "公众号导入" : "回收站";
  const drag = useExplorerDrag(categories, props.onReorderFolder, props.onReorderEntry, props.onMoveEntry);
  const DragIcon = drag.ghost?.kind === "folder" ? FolderOpen : FileText;

  function addFolder(parent: string | null) {
    if (parent) props.onRevealFolder(parent);
    setEditing(current => current && !current.target && current.parent === parent ? current : { parent });
  }

  function finishMenu(event: Event) {
    const edit = editAfterMenu.current;
    if (!edit) return;
    editAfterMenu.current = null;
    event.preventDefault();
    edit();
  }

  function folderEditor(draft: NonNullable<typeof editing>) {
    const siblingNames = new Set(categories.filter(folder => folder.parentId === draft.parent).map(folder => folder.name));
    let name = "未命名";
    for (let suffix = 2; siblingNames.has(name); suffix++) name = `未命名 ${suffix}`;
    return <FolderInline key={draft.target?.id ?? `new-${draft.parent ?? "root"}`} target={draft.target}
      defaultName={name} onError={props.onFolderError}
      onSave={(name, icon) => props.onSaveFolder(draft.target?.id ?? null, draft.parent, name, icon)}
      onClose={restoreFocus => {
        setEditing(current => current === draft ? null : current);
        const origin = draft.target?.id ?? draft.parent;
        if (restoreFocus) requestAnimationFrame(() => {
          if (document.activeElement === document.body) document.getElementById(origin ? `folder-row-${origin}` : "add-root-folder")?.focus();
        });
      }} />;
  }

  function branch(parentId: string | null) {
    const siblings = categories.filter(category => category.parentId === parentId);
    return siblings.map((category, index) => {
      const open = expanded.includes(category.id);
      const [Icon] = folderIcons[category.icon];
      const Chevron = open ? ChevronDown : ChevronRight;
      const drop = drag.hint?.id === category.id ? drag.hint.placement : undefined;
      return <li key={category.id} className="tree-folder" data-placement={drop}>
        {editing?.target?.id === category.id ? folderEditor(editing) : <div className="folder-row"
          data-tree-kind="folder" data-tree-id={category.id} data-tree-title={category.name}
          data-menu-target={contextFolder === category.id || undefined}
          data-dragging={drag.ghost?.id === category.id || undefined} data-tree-draggable={!props.treeLocked || undefined}>
          <ContextMenu.Root onOpenChange={open => setContextFolder(current => open ? category.id : current === category.id ? null : current)}>
            <Tooltip content={category.name}><ContextMenu.Trigger>
              <button type="button" id={`folder-row-${category.id}`} className="plain-button folder-select" aria-expanded={open}
                aria-controls={open ? `folder-${category.id}` : undefined} onClick={() => props.onFolder(category.id)}>
                <Chevron size={12} className="folder-chevron" />
                <span className="folder-icon" aria-hidden="true">{loadingFolders.includes(category.id)
                  ? <Spinner size="1" />
                  : open && category.icon === "folder" ? <FolderOpen size={15} /> : <Icon size={15} />}</span>
                <span>{category.name}</span>
              </button>
            </ContextMenu.Trigger></Tooltip>
            <ContextMenu.Content size="1" aria-label="文件夹操作" onCloseAutoFocus={finishMenu}>
              <CreateItems Item={ContextMenu.Item} disabled={props.treeLocked} onCreate={() => props.onCreate(category.id)}
                onImportWechat={() => props.onImportWechat(category.id)} onImportMarkdown={() => props.onImportMarkdown(category.id)} />
              {!category.parentId && <ContextMenu.Item disabled={props.treeLocked} onSelect={() => { editAfterMenu.current = () => addFolder(category.id); }}><FolderPlus size={14} />新建子目录</ContextMenu.Item>}
              <ContextMenu.Item disabled={props.treeLocked} onSelect={() => {
                editAfterMenu.current = () => setEditing({ target: category, parent: category.parentId });
              }}><PencilLine size={14} />编辑名称和图标</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item disabled={props.treeLocked || index === 0} onSelect={() => props.onCategoryAction(category, "up")}><ArrowUp size={14} />上移</ContextMenu.Item>
              <ContextMenu.Item disabled={props.treeLocked || index === siblings.length - 1} onSelect={() => props.onCategoryAction(category, "down")}><ArrowDown size={14} />下移</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item color="red" disabled={props.treeLocked} onSelect={() => props.onCategoryAction(category, "delete")}><Trash2 size={14} />删除目录</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        </div>}
        {open && <ul className="folder-children" id={`folder-${category.id}`} data-tree-container={category.id} aria-label={category.name}>
          {branch(category.id)}
          <FolderEntries categoryId={category.id} revision={revision} limit={limit} markLoading={markLoading} actions={props} drag={drag} />
          {editing && !editing.target && editing.parent === category.id && <li>{folderEditor(editing)}</li>}
        </ul>}
      </li>;
    });
  }

  const content = <aside className="explorer" aria-label={isTree ? "内容目录" : listLabel} {...(isTree ? drag.events : {})}>
    {isTree && <div className="section-bar tree-tools" data-placement={drag.hint?.id === null ? "inside" : undefined}>
      <button type="button" className="plain-button root-target" onClick={props.onRoot} aria-current={categoryId === undefined ? "location" : undefined}
        data-selected={categoryId === undefined} title="将新内容放在根目录">
        目录
      </button>
      <Tool id="add-root-folder" label="新建目录" className="chrome-icon" disabled={props.treeLocked || !library}
        onClick={() => addFolder(null)}><FolderPlus size={16} /></Tool>
    </div>}
    {isSearch && <WorkspaceSearch inputRef={props.searchInputRef} query={query} caseSensitive={props.caseSensitive}
      onQuery={props.onQuery} onCaseSensitive={props.onCaseSensitive} />}
    {!isTree && !isSearch && <div className="section-bar explorer-title"><h1>{listLabel}</h1></div>}

    <div className="explorer-scroll explorer-list-scroll">
      {isTree ? <ul className="explorer-content folder-tree" data-tree-container="" aria-label="目录和内容">
        {branch(null)}
        <FolderEntries revision={revision} limit={limit} markLoading={markLoading} actions={props} drag={drag}
          empty={library?.categories.length === 0 && !editing ? "暂无内容" : undefined} />
        {editing && !editing.target && editing.parent === null && <li>{folderEditor(editing)}</li>}
      </ul> : <ul className={`explorer-content entry-list${isSearch ? " search-results" : ""}`} aria-label={isSearch ? "搜索结果" : listLabel}>
        {isSearch && !query.trim() ? null : props.listError ? <ListError message={props.listError} onRetry={props.onRetry} />
          : !page ? <li className="explorer-empty">正在载入…</li>
            : !page.items.length ? <li className="explorer-empty">{isSearch ? "没有匹配的内容" : section === "imports" ? "暂无导入文章" : "回收站为空"}</li>
              : page.items.map(row => <ContentRow key={row.id} row={row} actions={props} detail={!isSearch} />)}
        {page?.nextOffset != null && !props.listError && <li><Button size="1" variant="ghost" className="load-more" onClick={props.onMore}>加载更多</Button></li>}
      </ul>}
    </div>
    {isTree && drag.ghost && <div className="tree-drag-ghost" aria-hidden="true" ref={drag.ghostElement}
      style={{ translate: `${drag.ghost.x}px ${drag.ghost.y}px` }}><DragIcon size={16} /><span>{drag.ghost.title}</span></div>}
  </aside>;
  return <ContextMenu.Root>
    <ContextMenu.Trigger disabled={!isTree}>{content}</ContextMenu.Trigger>
    {isTree && <ContextMenu.Content size="1" aria-label="目录操作" onCloseAutoFocus={finishMenu}>
      <CreateItems Item={ContextMenu.Item} disabled={props.treeLocked || !library} onCreate={() => props.onCreate(null)}
        onImportWechat={() => props.onImportWechat(null)} onImportMarkdown={() => props.onImportMarkdown(null)} />
      <ContextMenu.Separator />
      <ContextMenu.Item disabled={props.treeLocked || !library} onSelect={() => { editAfterMenu.current = () => addFolder(null); }}><FolderPlus size={15} />新建目录</ContextMenu.Item>
    </ContextMenu.Content>}
  </ContextMenu.Root>;
}

function ListError({ message, onRetry }: { message: string; onRetry(): void }) {
  return <li className="explorer-empty" role="alert">
    <span>{message}</span><Button size="1" variant="soft" onClick={onRetry}>重试</Button>
  </li>;
}

function FolderEntries({ categoryId, revision, limit, markLoading, actions, drag, empty }: {
  categoryId?: string; revision: number; limit: number; markLoading(id: string, pending: boolean): void;
  actions: RowActions & Pick<ExplorerProps, "treeLocked">;
  drag: ReturnType<typeof useExplorerDrag>; empty?: string;
}) {
  const [page, setPage] = useState<EntryPage | null>(null);
  const [failure, setFailure] = useState<{ message: string; offset: number; count: number } | null>(null);
  const [pending, setPending] = useState(false);
  const currentPage = useRef<EntryPage | null>(null);
  const currentLimit = useRef(limit);
  const request = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLButtonElement>(null);

  const load = useCallback((offset: number, count: number) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setFailure(null);
    if (categoryId) markLoading(categoryId, true);
    void desktop.entries({ categoryId, exactCategory: true, deleted: false, offset, limit: count }).then(result => {
      if (controller.signal.aborted) return;
      const next = offset ? { ...result, items: [...currentPage.current!.items, ...result.items] } : result;
      currentPage.current = next;
      setPage(next);
    }, error => {
      if (!controller.signal.aborted) setFailure({ message: errorMessage(error), offset, count });
    }).finally(() => {
      if (controller.signal.aborted) return;
      request.current = null;
      setPending(false);
      if (categoryId) markLoading(categoryId, false);
    });
  }, [categoryId, markLoading]);

  useEffect(() => {
    const count = limit === currentLimit.current ? Math.max(limit, currentPage.current?.items.length ?? 0) : limit;
    currentLimit.current = limit;
    load(0, count);
    return () => {
      if (!request.current) return;
      request.current.abort();
      request.current = null;
      if (categoryId) markLoading(categoryId, false);
    };
  }, [categoryId, revision, limit, load, markLoading]);

  const nextOffset = page?.nextOffset;
  useEffect(() => {
    const target = sentinel.current;
    if (!target || nextOffset == null || pending || failure) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load(nextOffset, limit);
    }, { root: target.closest(".explorer-scroll") });
    observer.observe(target);
    return () => observer.disconnect();
  }, [failure, limit, load, nextOffset, pending]);

  const errorRow = failure && <ListError message={failure.message} onRetry={() => load(failure.offset, failure.count)} />;
  if (!page) return errorRow;
  return <>
    {!page.items.length && empty && <li className="explorer-empty">{empty}</li>}
    {page.items.map(row => <ContentRow key={row.id} row={row} actions={actions}
      draggable={!actions.treeLocked && !actions.readOnlyIds.includes(row.id)} dragging={drag.ghost?.id === row.id}
      placement={drag.hint?.id === row.id && drag.hint.placement !== "inside" ? drag.hint.placement : undefined} />)}
    {errorRow ?? (page.nextOffset !== null && <li>
      <Button ref={sentinel} size="1" variant="ghost" className="load-more" disabled={pending}
        onClick={() => load(page.nextOffset!, limit)}>{pending ? "正在加载…" : "加载更多"}</Button>
    </li>)}
  </>;
}

function ContentRow({ row, actions, detail = false, draggable, dragging, placement }: {
  row: EntryRow; actions: RowActions; detail?: boolean; draggable?: boolean; dragging?: boolean; placement?: CategoryPlacement;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameAfterMenu = useRef(false);
  const title = row.title || untitled;
  const deleted = row.deletedAt !== null;
  const reading = actions.readOnlyIds.includes(row.id);
  const act = (action: EntryRowAction) => actions.onRowAction(row, action);
  return <li className={!detail ? "tree-item" : undefined} data-placement={placement}>
    {renaming ? <div className={detail ? "entry-inline entry-detail" : "entry-inline tree-entry"}>
      <FileText size={15} /><InlineEntryTitle title={row.title} placeholder={untitled} onError={actions.onFolderError}
        onSave={name => actions.onRenameEntry(row.id, name)} onClose={restore => {
          setRenaming(false);
          if (restore) requestAnimationFrame(() => { if (document.activeElement === document.body) document.getElementById(`entry-row-${row.id}`)?.focus(); });
        }} />
    </div> : <ContextMenu.Root>
      <ContextMenu.Trigger>
        <button type="button" id={`entry-row-${row.id}`} className={`plain-button entry-row ${detail ? "entry-detail" : "tree-entry"}`}
          data-tree-kind={detail ? undefined : "entry"} data-tree-id={row.id} data-tree-title={detail ? undefined : title}
          data-tree-draggable={draggable || undefined} data-dragging={dragging || undefined}
          aria-current={row.id === actions.active ? "true" : undefined} title={title} onClick={() => actions.onOpen(row.id)}>
          <FileText size={15} /><span className="entry-title">{title}</span>
          {detail && <span className="entry-meta"><span>{statusLabels[row.status]}</span><time dateTime={new Date(row.updatedAt).toISOString()}>{dateLabel(row.updatedAt)}</time></span>}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Content size="1" onCloseAutoFocus={event => {
        if (!renameAfterMenu.current) return;
        renameAfterMenu.current = false;
        event.preventDefault();
        setRenaming(true);
      }}>
        <ContextMenu.Item onSelect={() => actions.onOpen(row.id)}><FileText size={14} />打开</ContextMenu.Item>
        {!deleted && <>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={reading} onSelect={() => { renameAfterMenu.current = true; }}><PencilLine size={14} />重命名</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => act("duplicate")}><Files size={14} />创建副本</ContextMenu.Item>
          <ContextMenu.Item disabled={reading} onSelect={() => act("move")}><FolderInput size={14} />移动到文件夹</ContextMenu.Item>
        </>}
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={() => act("copyTitle")}><Copy size={14} />复制标题</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => act("copyPath")}><Link size={14} />复制工作区路径</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => act("history")}><History size={14} />历史版本</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => act("export")}><FileDown size={14} />导出 Markdown</ContextMenu.Item>
        <ContextMenu.Separator />
        {deleted
          ? <ContextMenu.Item onSelect={() => act("restore")}><ArchiveRestore size={14} />恢复</ContextMenu.Item>
          : <ContextMenu.Item color="red" disabled={reading} onSelect={() => act("delete")}><Trash2 size={14} />移入回收站</ContextMenu.Item>}
      </ContextMenu.Content>
    </ContextMenu.Root>}
  </li>;
}
