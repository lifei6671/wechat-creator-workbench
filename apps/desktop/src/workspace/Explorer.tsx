import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { Button, ContextMenu, DropdownMenu, HoverCard, Select, Spinner } from "@radix-ui/themes";
import {
  ArchiveRestore, ArrowDown, ArrowDownNarrowWide, ArrowUp, CalendarDays, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Crosshair, FileDown, FilePenLine, FileUp, Files, FileText,
  FolderOpen, FolderPlus, History, Link, PencilLine, Pin, PinOff, Plus, SquareArrowOutUpRight, Tag, Tags, Trash2,
} from "lucide-react";
import type { CanvasCardColor, Category, CategoryIcon, CategoryPlacement, Collection, EntryFilter, EntryPage, EntryRow, EntrySortOrder, Library, TimelineSelection, WorkspaceSearchHit, WorkspaceSearchMatches } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { commandKey, dateLabel, rootFolderLabel, statusLabels, untitled } from "../labels";
import { persist, Tool, Tooltip, useStoredInitial } from "../ui";
import { folderIcons } from "./folder-icons";
import { colorValue } from "./ColorChoices";
import { MoveEntryMenu } from "./MoveEntryMenu";
import { AddToCollectionMenu } from "./CollectionMenu";
import { FolderInline } from "./FolderInline";
import { InlineEntryTitle } from "./InlineEntryTitle";
import { useExplorerDrag } from "./explorer-drag";
import type { DocumentOpenMode } from "./preferences";
import type { useButtonFeedback } from "../button-feedback";
import { SearchHitRow, WorkspaceSearch, searchDisplayDefaults, searchDisplayKey } from "./WorkspaceSearch";

export type Section = "folders" | "timeline" | "search" | "assets" | "trash" | "imports" | "collections";
export type CategoryAction = "delete" | "up" | "down";
export type EntryRowAction = "delete" | "restore" | "duplicate" | "pin" | "unpin" | "copyTitle" | "copyPath" | "history" | "export" | "properties";

interface CreateActions {
  onCreate(): void;
  onImportLink(): void;
  onImportMarkdown(): void;
  onCreateCollection?(): void;
  disabled?: boolean;
}

function CreateItems({ Item, onCreate, onImportLink, onImportMarkdown, onCreateCollection, disabled }: CreateActions & {
  Item: typeof DropdownMenu.Item | typeof ContextMenu.Item;
}) {
  return <>
    <Item disabled={disabled} onSelect={onCreate}><FilePenLine size={15} />新建笔记</Item>
    {onCreateCollection && <Item disabled={disabled} onSelect={onCreateCollection}><Plus size={15} />新建专题</Item>}
    <Item disabled={disabled} onSelect={onImportLink}><Link size={15} />导入链接</Item>
    <Item disabled={disabled} onSelect={onImportMarkdown}><FileUp size={15} />导入 Markdown</Item>
  </>;
}

export function CreateMenu(actions: CreateActions) {
  const { onCreateCollection } = actions;
  const createAfterMenu = useRef<(() => void) | null>(null);
  return <DropdownMenu.Root>
    <Tooltip content="新建内容"><DropdownMenu.Trigger>
      <button type="button" className="plain-button chrome-icon add-tab" aria-label="新建内容">
        <Plus size={17} />
      </button>
    </DropdownMenu.Trigger></Tooltip>
    <DropdownMenu.Content align="start" size="1" onCloseAutoFocus={event => {
      const create = createAfterMenu.current;
      if (!create) return;
      createAfterMenu.current = null;
      event.preventDefault();
      create();
    }}>
      <CreateItems Item={DropdownMenu.Item} {...actions} onCreateCollection={onCreateCollection && (() => {
        createAfterMenu.current = onCreateCollection;
      })} />
    </DropdownMenu.Content>
  </DropdownMenu.Root>;
}

export function BlankAreaMenu({ children, label, actions }: {
  children: ReactNode;
  label: string;
  actions: (CreateActions & { onAddFolder?(): void }) | null;
}) {
  const addFolderAfterMenu = useRef<(() => void) | undefined>(undefined);
  return <ContextMenu.Root>
    <ContextMenu.Trigger disabled={!actions}>{children}</ContextMenu.Trigger>
    {actions && <ContextMenu.Content size="1" aria-label={label} onCloseAutoFocus={event => {
      const addFolder = addFolderAfterMenu.current;
      if (!addFolder) return;
      addFolderAfterMenu.current = undefined;
      event.preventDefault();
      addFolder();
    }}>
      <CreateItems Item={ContextMenu.Item} {...actions} />
      {actions.onAddFolder && <>
        <ContextMenu.Separator />
        <ContextMenu.Item disabled={actions.disabled} onSelect={() => { addFolderAfterMenu.current = actions.onAddFolder; }}><FolderPlus size={15} />新建目录</ContextMenu.Item>
      </>}
    </ContextMenu.Content>}
  </ContextMenu.Root>;
}

export interface ExplorerHandle {
  addFolder(parent: string | null): void;
  revealDirectory(): void;
  revealTimelineTag(id: string, focus: boolean): void;
}

interface ExplorerProps {
  feedback?: ReturnType<typeof useButtonFeedback>;
  ref?: Ref<ExplorerHandle>;
  section: Exclude<Section, "assets" | "collections">;
  library: Library | null;
  page: EntryPage | null;
  active: string | null;
  activeFolder?: string | null;
  preserveActiveFolder?: boolean;
  timelineSelection?: TimelineSelection | null;
  onTimelineSelect?(selection: TimelineSelection): void;
  includeTimelineChildren?: boolean;
  directoryTrailingAction?: ReactNode;
  onEmptyTrash?(): void;
  onCreateCurrent?(): void;
  onToggleAll?(expand: boolean): void;
  onLocateCurrent?(): void;
  readOnlyIds: string[];
  treeLocked: boolean;
  expanded: string[];
  revision: number;
  loading: "all" | "paged";
  pageSize: number;
  caseSensitive: boolean;
  query: string;
  searchInputRef: Ref<HTMLInputElement>;
  searchSort?: EntryFilter["sort"];
  selectedSearchHit?: { entryId: string; start: number };
  onSearchSort?(sort: NonNullable<EntryFilter["sort"]>): void;
  onSearchHit?(entryId: string, hit: WorkspaceSearchHit, version: number, showContext: boolean): void;
  listError: string;
  onRetry(): void;
  onQuery(query: string): void;
  onCaseSensitive(value: boolean): void;
  onFolder(id: string): void;
  onCreate(categoryId: string | null): void;
  onImportLink(categoryId: string | null): void;
  onImportMarkdown(categoryId: string | null): void;
  onRevealFolder(id: string): void;
  onSaveFolder(id: string | null, parent: string | null, name: string, icon: CategoryIcon, color: CanvasCardColor | null): Promise<void>;
  onFolderError(error: unknown): void;
  onReorderFolder(id: string, anchor: string, placement: CategoryPlacement): void;
  onReorderEntry(id: string, anchor: string, placement: CategoryPlacement): void;
  onRenameEntry(id: string, title: string): Promise<void>;
  onMoveEntry(id: string, categoryId: string | null): void;
  collectionOptions?: Collection[];
  onAddToCollection?(id: string, collection: Collection): void;
  onCategoryAction(category: Category, action: CategoryAction): void;
  openMode: DocumentOpenMode;
  onOpen(id: string, mode?: DocumentOpenMode): void;
  onRowAction(row: EntryRow, action: EntryRowAction, trigger?: HTMLElement | null): void;
  onMore(): void;
}

export type RowActions = Pick<ExplorerProps, "active" | "readOnlyIds" | "treeLocked" | "openMode" | "onOpen" | "onRowAction" | "onRenameEntry" | "onFolderError" | "onMoveEntry" | "collectionOptions" | "onAddToCollection" | "feedback"> & {
  categories: Category[];
};

export const allEntries = 2_147_483_647;
const entryDate = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function TreeSection({ id, title, collapsed, onToggle, onExpanded, pinned, icon, children }: {
  id: string; title: string; collapsed: boolean; onToggle(): void; onExpanded?(): void;
  pinned?: boolean; icon?: ReactNode; children: ReactNode;
}) {
  const chevron = <ChevronDown size={14} className="tree-section-chevron" aria-hidden="true" />;
  return <li className={pinned ? "tree-section tree-pinned" : "tree-section"} data-tree-pinned-area={pinned ? "" : undefined}>
    <button type="button" className="plain-button tree-section-title" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}>
      {icon ? <>{chevron}{icon}{title}</> : <>{title}{chevron}</>}
    </button>
    <div className="tree-section-content" data-collapsed={collapsed} onTransitionEnd={event => {
      if (!collapsed && event.target === event.currentTarget && event.propertyName === "grid-template-rows") onExpanded?.();
    }}>
      <ul id={id} aria-label={pinned ? "置顶文档" : title === "目录" ? "目录文档" : title} inert={collapsed}>{children}</ul>
    </div>
  </li>;
}

export function Explorer(props: ExplorerProps) {
  const { section, library, page, expanded, revision, loading, pageSize, query, preserveActiveFolder } = props;
  const [editing, setEditing] = useState<{ target?: Category; parent: string | null } | null>(null);
  const [contextFolder, setContextFolder] = useState<string | null>(null);
  const [loadingFolders, setLoadingFolders] = useState<string[]>([]);
  const [pins, setPins] = useState<{ items: EntryRow[]; error?: string } | null>(null);
  const [pinsCollapsed, setPinsCollapsed] = useState(() => useStoredInitial("directory-pins-collapsed", false));
  const [directoryCollapsed, setDirectoryCollapsed] = useState(() => useStoredInitial("directory-collapsed", false));
  const [tagsCollapsed, setTagsCollapsed] = useState(() => useStoredInitial("directory-tags-collapsed", false));
  const [sort, setSort] = useState(() => useStoredInitial<"manual" | EntrySortOrder>("directory-sort", "manual"));
  const [autoLocate, setAutoLocate] = useState(() => useStoredInitial("directory-auto-locate", false));
  const markLoading = useCallback((id: string, pending: boolean) => {
    setLoadingFolders(current => pending ? [...current, id] : current.filter(folder => folder !== id));
  }, []);
  const limit = loading === "all" ? allEntries : pageSize;
  const editAfterMenu = useRef<(() => void) | null>(null);
  const categories = library?.categories ?? [];
  const rowActions = { ...props, categories };
  const foldersExpanded = categories.some(category => category.parentId === null && expanded.includes(category.id));
  const isTimeline = section === "timeline";
  const counts = isTimeline ? library?.articleCounts : undefined;
  const folderCounts = { ...counts?.folders };
  if (counts && props.includeTimelineChildren) {
    for (const { id, parentId } of categories) {
      if (parentId) folderCounts[parentId] = (folderCounts[parentId] ?? 0) + (counts.folders[id] ?? 0);
    }
  }
  const selection = props.timelineSelection;
  const timelineFolder = isTimeline && selection?.kind === "folder" ? categories.find(folder => folder.id === selection.id) : undefined;
  const isTree = section === "folders" || isTimeline;
  const workspaceId = library?.workspaceId;
  useEffect(() => {
    if (section !== "folders" || !workspaceId) return;
    let current = true;
    void desktop.entries({ pinned: true, deleted: false, offset: 0, limit: allEntries }).then(({ items }) => {
      if (current) setPins({ items: items.filter(row => row.pinned) });
    }, error => {
      if (current) setPins(previous => ({ items: previous?.items ?? [], error: errorMessage(error) }));
    });
    return () => { current = false; };
  }, [section, workspaceId, revision]);
  const pinnedIds = new Set(pins?.items.map(row => row.id));
  const hasPinSection = pinnedIds.size > 0 || Boolean(pins?.error);
  const locate = !isTimeline && autoLocate && pins && !preserveActiveFolder ? props.active : null;
  const locatePinned = locate !== null && pinnedIds.has(locate);
  const locateInFolders = locatePinned || directoryCollapsed ? null : locate;
  const locatedEntry = useRef<{ id: string; pinned: boolean } | null>(null);
  useEffect(() => {
    if (!isTree || !locate) { locatedEntry.current = null; return; }
    if (locatedEntry.current?.id === locate && locatedEntry.current.pinned === locatePinned) return;
    locatedEntry.current = { id: locate, pinned: locatePinned };
    if (locatePinned) {
      setPinsCollapsed(false);
      persist("directory-pins-collapsed", false);
      requestAnimationFrame(() => {
        if (locatedEntry.current?.id === locate && locatedEntry.current.pinned) props.onLocateCurrent?.();
      });
    } else props.onLocateCurrent?.();
  }, [isTree, locate, locatePinned, props.onLocateCurrent]);
  const isSearch = section === "search";
  const [searchDisplay, setSearchDisplay] = useState(() => useStoredInitial(searchDisplayKey, searchDisplayDefaults));
  const listLabel = isSearch ? "全文搜索" : section === "imports" ? "导入的外部文章" : "回收站";
  const drag = useExplorerDrag(categories, sort === "manual", props.onReorderFolder, props.onReorderEntry, props.onMoveEntry);
  const DragIcon = drag.ghost?.kind === "folder" ? FolderOpen : FileText;
  const draggedFolder = drag.ghost?.kind === "folder" ? categories.find(folder => folder.id === drag.ghost!.id) : undefined;

  function collapseDirectory(collapsed: boolean) {
    setDirectoryCollapsed(collapsed);
    persist("directory-collapsed", collapsed);
  }

  function collapseTags(collapsed: boolean) {
    setTagsCollapsed(collapsed);
    persist("directory-tags-collapsed", collapsed);
  }

  function scrollAfterSectionExpands(pinned: boolean) {
    if (!locate || locatePinned !== pinned) return;
    document.getElementById(`entry-row-${locate}`)?.scrollIntoView({ block: "nearest" });
  }

  function addFolder(parent: string | null) {
    collapseDirectory(false);
    if (parent) props.onRevealFolder(parent);
    setEditing(current => current && !current.target && current.parent === parent ? current : { parent });
  }

  useImperativeHandle(props.ref, () => ({
    addFolder,
    revealDirectory: () => collapseDirectory(false),
    revealTimelineTag(id, focus) {
      collapseTags(false);
      requestAnimationFrame(() => {
        const row = document.getElementById(`timeline-tag-${id}`);
        if (focus) row?.focus({ preventScroll: true });
        row?.scrollIntoView?.({ block: "nearest" });
      });
    },
  }));

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
      onSave={(name, icon, color) => props.onSaveFolder(draft.target?.id ?? null, draft.parent, name, icon, color)}
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
      const hasChildren = isTimeline && categories.some(child => child.parentId === category.id);
      const childrenId = `folder-${category.id}`;
      const drop = drag.hint?.id === category.id ? drag.hint.placement : undefined;
      const children = (isTimeline ? hasChildren || editing?.parent === category.id : open)
        ? <ul className="folder-children" id={childrenId} data-tree-container={category.id} aria-label={category.name}
          inert={isTimeline && !open}>
          {branch(category.id)}
          {!isTimeline && <FolderEntries key={sort} categoryId={category.id} revision={revision} limit={limit} markLoading={markLoading} actions={rowActions} drag={drag}
            pinnedIds={pinnedIds} sort={sort === "manual" ? undefined : sort}
            locate={props.activeFolder === category.id ? locateInFolders : null} />}
          {editing && !editing.target && editing.parent === category.id && <li>{folderEditor(editing)}</li>}
        </ul> : null;
      return <li key={category.id} className="tree-folder" data-placement={drop}>
        {editing?.target?.id === category.id ? folderEditor(editing) : <div className="folder-row"
          data-tree-kind="folder" data-tree-id={category.id} data-tree-title={category.name}
          data-menu-target={contextFolder === category.id || undefined}
          data-dragging={drag.ghost?.id === category.id || undefined} data-tree-draggable={!props.treeLocked || undefined}>
          {isTimeline && (hasChildren
            ? <button type="button" className="plain-button timeline-folder-toggle" aria-label={`${open ? "折叠" : "展开"} ${category.name}`}
              aria-expanded={open} aria-controls={childrenId} onClick={() => props.onFolder(category.id)}>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            : <span className="timeline-folder-toggle" aria-hidden="true" />)}
          <ContextMenu.Root onOpenChange={open => setContextFolder(current => open ? category.id : current === category.id ? null : current)}>
            <ContextMenu.Trigger>
              <button type="button" id={`folder-row-${category.id}`} className="plain-button folder-select"
                aria-expanded={isTimeline ? undefined : open}
                aria-current={isTimeline && selection?.kind === "folder" && selection.id === category.id ? "true" : undefined}
                aria-controls={!isTimeline && open ? childrenId : undefined}
                onClick={() => {
                  if (isTimeline) props.onTimelineSelect?.({ kind: "folder", id: category.id });
                  else props.onFolder(category.id);
                }}>
                {!isTimeline && <Chevron size={12} className="folder-chevron" />}
                <span className="folder-icon folder-icon-badge" aria-hidden="true" style={{ backgroundColor: colorValue(category.iconColor) }}>{loadingFolders.includes(category.id)
                  ? <Spinner size="1" />
                  : open && category.icon === "folder" ? <FolderOpen size={14} /> : <Icon size={14} />}</span>
                <span>{category.name}</span>
                {counts && <span className="timeline-count" aria-label={`${folderCounts[category.id] ?? 0} 篇文章`}>{folderCounts[category.id] ?? 0}</span>}
              </button>
            </ContextMenu.Trigger>
            <ContextMenu.Content size="1" aria-label="文件夹操作" onCloseAutoFocus={finishMenu}>
              <CreateItems Item={ContextMenu.Item} disabled={props.treeLocked} onCreate={() => props.onCreate(category.id)}
                onImportLink={() => props.onImportLink(category.id)} onImportMarkdown={() => props.onImportMarkdown(category.id)} />
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
        {isTimeline && children ? <div className="tree-section-content" data-collapsed={!open}>{children}</div> : children}
      </li>;
    });
  }

  const content = <aside className="explorer" aria-label={isTree ? "内容目录" : listLabel} {...(isTree ? drag.events : {})}>
    {isTree && <div className="directory-tools" role="group" aria-label="目录快捷操作">
      <Tool label="新建笔记" className="chrome-icon" disabled={props.treeLocked || !library} onClick={() => props.onCreateCurrent ? props.onCreateCurrent() : props.onCreate(null)}><FilePenLine size={16} /></Tool>
      <Tool id="add-root-folder" label={timelineFolder ? "新建子目录" : "新建目录"} className="chrome-icon"
        disabled={props.treeLocked || !library || Boolean(timelineFolder?.parentId)}
        onClick={() => addFolder(timelineFolder?.id ?? null)}><FolderPlus size={16} /></Tool>
      {!isTimeline && <DropdownMenu.Root><Tooltip content="排序"><DropdownMenu.Trigger>
        <button type="button" aria-label="排序" className="plain-button chrome-icon"><ArrowDownNarrowWide size={16} /></button>
      </DropdownMenu.Trigger></Tooltip><DropdownMenu.Content size="1">
        <DropdownMenu.RadioGroup value={sort} onValueChange={value => { setSort(value as typeof sort); persist("directory-sort", value); }}>
          <DropdownMenu.RadioItem value="name">文件名（A-Z）</DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="nameDesc">文件名（Z-A）</DropdownMenu.RadioItem>
          <DropdownMenu.Separator />
          <DropdownMenu.RadioItem value="updated">编辑时间（从新到旧）</DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="updatedAsc">编辑时间（从旧到新）</DropdownMenu.RadioItem>
          <DropdownMenu.Separator />
          <DropdownMenu.RadioItem value="created">创建时间（从新到旧）</DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="createdAsc">创建时间（从旧到新）</DropdownMenu.RadioItem>
          <DropdownMenu.Separator />
          <DropdownMenu.RadioItem value="manual">手动排序</DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content></DropdownMenu.Root>}
      {!isTimeline && <Tool label="自动定位当前文件" className="chrome-icon" aria-pressed={autoLocate} onClick={() => {
        setAutoLocate(!autoLocate); persist("directory-auto-locate", !autoLocate);
        if (!autoLocate && preserveActiveFolder) props.onLocateCurrent?.();
      }}><Crosshair size={16} /></Tool>}
      <Tool label={foldersExpanded && !directoryCollapsed ? "全部折叠" : "全部展开"} className="chrome-icon" disabled={!categories.length}
        onClick={() => {
          if (directoryCollapsed) collapseDirectory(false);
          props.onToggleAll?.(directoryCollapsed || !foldersExpanded);
        }}>{foldersExpanded && !directoryCollapsed ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}</Tool>
      {props.directoryTrailingAction}
    </div>}
    {isSearch && <>
      <WorkspaceSearch inputRef={props.searchInputRef} query={query} caseSensitive={props.caseSensitive} searchInfo={page?.search}
        onQuery={props.onQuery} onCaseSensitive={props.onCaseSensitive} display={searchDisplay} onDisplayChange={value => {
          setSearchDisplay(value);
          persist(searchDisplayKey, value);
        }} />
      {query.trim() && <div className="workspace-search-summary">
        <span aria-live="polite">{page ? `${page.search?.total ?? page.items.length} 篇笔记` : ""}</span>
        <Select.Root size="1" value={props.searchSort ?? "name"}
          onValueChange={value => props.onSearchSort?.(value as NonNullable<EntryFilter["sort"]>)}>
          <Select.Trigger aria-label="搜索结果排序" variant="ghost" />
          <Select.Content>
            <Select.Item value="relevance">相关性</Select.Item>
            <Select.Item value="name">标题 A–Z</Select.Item>
            <Select.Item value="nameDesc">标题 Z–A</Select.Item>
            <Select.Item value="updated">最近修改</Select.Item>
            <Select.Item value="updatedAsc">最早修改</Select.Item>
            <Select.Item value="created">最近创建</Select.Item>
            <Select.Item value="createdAsc">最早创建</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>}
    </>}
    {!isTree && !isSearch && <div className="section-bar explorer-title"><h1>{listLabel}</h1>
      {section === "trash" && <Tool id="empty-trash" label="清空回收站" className="chrome-icon"
        disabled={props.treeLocked || !page?.items.length} onClick={props.onEmptyTrash}><Trash2 size={16} /></Tool>}
    </div>}

    <div className="explorer-scroll explorer-list-scroll" data-root-drop={drag.hint?.id === null || undefined}>
      {isTree ? <ul className={`explorer-content folder-tree${isTimeline ? " timeline-folders" : ""}`} data-tree-container=""
        aria-label={isTimeline ? "目录" : "目录和内容"}>
        {!isTimeline && hasPinSection && <TreeSection id="tree-pinned-list" title="置顶" collapsed={pinsCollapsed} pinned
          onExpanded={() => scrollAfterSectionExpands(true)} onToggle={() => {
          setPinsCollapsed(!pinsCollapsed);
          persist("directory-pins-collapsed", !pinsCollapsed);
        }}>
            {pins?.items.map(row => <ContentRow key={row.id} row={row} actions={rowActions} pinned
              draggable={!props.treeLocked} dragging={drag.ghost?.id === row.id}
              placement={drag.hint?.id === row.id && drag.hint.placement !== "inside" ? drag.hint.placement : undefined} />)}
            {pins?.error && <ListError message={pins.error} onRetry={props.onRetry} />}
        </TreeSection>}
        <TreeSection id="tree-directory-list" title="目录" collapsed={directoryCollapsed}
          onExpanded={() => scrollAfterSectionExpands(false)} onToggle={() => collapseDirectory(!directoryCollapsed)}>
          {isTimeline && <li><div className="folder-row">
            <span className="timeline-folder-toggle" aria-hidden="true" />
            <button type="button" id="timeline-root-folder" className="plain-button folder-select"
              aria-current={selection?.kind === "root" ? "true" : undefined}
              onClick={() => props.onTimelineSelect?.({ kind: "root" })}>
              <span className="folder-icon folder-icon-badge" aria-hidden="true"><FolderOpen size={14} /></span>
              <span>{rootFolderLabel}</span>
              {counts && <span className="timeline-count" aria-label={`${counts.root} 篇文章`}>{counts.root}</span>}
            </button>
          </div></li>}
          {branch(null)}
          {!isTimeline && <FolderEntries key={sort} revision={revision} limit={limit} markLoading={markLoading} actions={rowActions} drag={drag}
            pinnedIds={pinnedIds} sort={sort === "manual" ? undefined : sort} locate={props.activeFolder === null ? locateInFolders : null}
            empty={library?.categories.length === 0 && pins && !pinnedIds.size && !editing ? "暂无内容" : undefined} />}
          {editing && !editing.target && editing.parent === null && <li>{folderEditor(editing)}</li>}
        </TreeSection>
        {isTimeline && library && <TreeSection id="timeline-tags" title="标签" collapsed={tagsCollapsed}
          onExpanded={() => {
            if (selection?.kind === "tag") {
              document.getElementById(`timeline-tag-${selection.id}`)?.scrollIntoView?.({ block: "nearest" });
            }
          }}
          onToggle={() => collapseTags(!tagsCollapsed)} icon={<Tags size={15} aria-hidden="true" />}>
          {library.tags.map(tag => <li key={tag.id}>
            <button type="button" id={`timeline-tag-${tag.id}`} className="plain-button timeline-tag-row"
              aria-current={selection?.kind === "tag" && selection.id === tag.id ? "true" : undefined}
              onClick={() => props.onTimelineSelect?.({ kind: "tag", id: tag.id })}>
              <Tag size={15} aria-hidden="true" /><span>{tag.name}</span>
              {counts && <span className="timeline-count" aria-label={`${counts.tags[tag.id] ?? 0} 篇文章`}>{counts.tags[tag.id] ?? 0}</span>}
            </button>
          </li>)}
          <li><button type="button" className="plain-button timeline-tag-row"
            aria-current={selection?.kind === "untagged" ? "true" : undefined}
            onClick={() => props.onTimelineSelect?.({ kind: "untagged" })}>
            <Tag size={15} aria-hidden="true" /><span>无标签</span>
            {counts && <span className="timeline-count" aria-label={`${counts.untagged} 篇文章`}>{counts.untagged}</span>}
          </button></li>
        </TreeSection>}
      </ul> : <ul className={`explorer-content entry-list${isSearch ? " search-results" : ""}`} aria-label={isSearch ? "搜索结果" : listLabel}>
        {isSearch && !query.trim() ? null : props.listError ? <ListError message={props.listError} onRetry={props.onRetry} />
          : !page ? <li className="explorer-empty">正在载入…</li>
            : !page.items.length ? <li className="explorer-empty">{isSearch ? "没有匹配的内容" : section === "imports" ? "暂无导入文章" : "回收站为空"}</li>
              : page.items.map(row => isSearch && row.searchMatches && props.onSearchHit
                ? <SearchNote key={JSON.stringify([row.id, row.searchMatches.version, query, props.caseSensitive, searchDisplay.collapse])}
                  row={row} matches={row.searchMatches} actions={rowActions}
                  search={{ text: query, caseSensitive: props.caseSensitive }} selected={props.selectedSearchHit}
                  collapsed={searchDisplay.collapse} showContext={searchDisplay.context} onOpenHit={props.onSearchHit} onRefresh={props.onRetry} />
                : <ContentRow key={row.id} row={row} actions={rowActions} detail={!isSearch} />)}
        {page?.nextOffset != null && !props.listError && <li><Button size="1" variant="ghost" className="load-more" onClick={props.onMore}>加载更多</Button></li>}
      </ul>}
    </div>
    {isTree && drag.ghost && <div className="tree-drag-ghost" aria-hidden="true" ref={drag.ghostElement}
      style={{ translate: `${drag.ghost.x}px ${drag.ghost.y}px` }}>{drag.ghost.kind === "folder"
        ? <span className="folder-icon-badge" style={{ backgroundColor: colorValue(draggedFolder?.iconColor) }}><DragIcon size={14} /></span>
        : <DragIcon size={16} />}<span>{drag.ghost.title}</span></div>}
  </aside>;
  return section === "folders" ? <BlankAreaMenu label="目录操作" actions={{
    disabled: props.treeLocked || !library,
    onCreate: () => props.onCreate(null), onImportLink: () => props.onImportLink(null),
    onImportMarkdown: () => props.onImportMarkdown(null), onAddFolder: () => addFolder(null),
  }}>
    {content}
  </BlankAreaMenu> : content;
}

export function ListError({ message, onRetry }: { message: string; onRetry(): void }) {
  return <li className="explorer-empty" role="alert">
    <span>{message}</span><Button size="1" variant="soft" onClick={onRetry}>重试</Button>
  </li>;
}

function FolderEntries({ categoryId, pinnedIds, revision, limit, markLoading, actions, drag, empty, sort, locate }: {
  pinnedIds: ReadonlySet<string>;
  categoryId?: string; revision: number; limit: number; markLoading(id: string, pending: boolean): void;
  actions: RowActions;
  drag: ReturnType<typeof useExplorerDrag>; empty?: string;
  sort?: EntryFilter["sort"]; locate: string | null;
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
    void desktop.entries({ categoryId, pinned: false, exactCategory: true, deleted: false, offset, limit: count, ...(sort ? { sort } : {}) }).then(result => {
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
  }, [categoryId, markLoading, sort]);

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
  const located = Boolean(locate && page?.items.some(row => row.id === locate));
  useEffect(() => {
    if (located) document.getElementById(`entry-row-${locate}`)?.scrollIntoView({ block: "nearest" });
    else if (locate && nextOffset != null && !pending && !failure) load(nextOffset, limit);
  }, [locate, located, nextOffset, pending, failure, load, limit]);
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
    {page.items.filter(row => !pinnedIds.has(row.id)).map(row => <ContentRow key={row.id} row={row} actions={actions}
      draggable={!actions.treeLocked && !actions.readOnlyIds.includes(row.id)} dragging={drag.ghost?.id === row.id}
      placement={drag.hint?.id === row.id && drag.hint.placement !== "inside" ? drag.hint.placement : undefined} />)}
    {errorRow ?? (page.nextOffset !== null && <li>
      <Button ref={sentinel} size="1" variant="ghost" className="load-more" disabled={pending}
        onClick={() => load(page.nextOffset!, limit)}>{pending ? "正在加载…" : "加载更多"}</Button>
    </li>)}
  </>;
}

function SearchNote({ row, matches, actions, search, selected, collapsed, showContext, onOpenHit, onRefresh }: {
  row: EntryRow;
  matches: WorkspaceSearchMatches;
  actions: RowActions;
  search: NonNullable<EntryFilter["workspaceSearch"]>;
  selected?: { entryId: string; start: number };
  collapsed: boolean;
  showContext: boolean;
  onOpenHit(entryId: string, hit: WorkspaceSearchHit, version: number, showContext: boolean): void;
  onRefresh(): void;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [extra, setExtra] = useState<WorkspaceSearchMatches>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const listId = useId();
  const next = extra ? extra.nextOffset : matches.nextOffset;
  async function more() {
    if (next === null || loading) return;
    setLoading(true);
    setError("");
    try {
      const request = await desktop.entries({ deleted: false, offset: 0,
        workspaceSearch: { ...search, matchPage: { entryId: row.id, offset: next } } });
      const page = request.items[0]?.searchMatches;
      if (!page || page.version !== matches.version) {
        setError("笔记已更新，正在刷新结果");
        onRefresh();
        return;
      }
      setExtra(current => ({ ...page, items: [...(current?.items ?? []), ...page.items] }));
    } catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }
  return <ContentRow row={row} actions={actions} search={matches.total ? {
    toggle: <button className="plain-button search-note-toggle" type="button" aria-expanded={open}
      aria-controls={listId} aria-label={`${open ? "折叠" : "展开"} ${row.title || untitled} 的 ${matches.total} 行匹配`}
      onClick={() => setOpen(current => !current)}><ChevronDown size={14} aria-hidden="true" /></button>,
    count: matches.total,
    results: <ul id={listId} hidden={!open} className="search-hit-list">
      {open && <>
        {[...matches.items, ...(extra?.items ?? [])].map(hit => <SearchHitRow key={hit.start} hit={hit} showContext={showContext}
          selected={selected?.entryId === row.id && selected.start === hit.start} onOpen={() => onOpenHit(row.id, hit, matches.version, showContext)} />)}
        {error && <li className="inline-error" role="alert">{error}</li>}
        {next !== null && <li><Button className="load-more-hits" size="1" variant="ghost" loading={loading} onClick={() => void more()}>更多匹配行</Button></li>}
      </>}
    </ul>,
  } : undefined} />;
}

export function ContentRow({ row, actions, detail = false, pinned, draggable, dragging, placement, timeline, search }: {
  row: EntryRow; actions: RowActions; detail?: boolean; pinned?: boolean; draggable?: boolean; dragging?: boolean; placement?: CategoryPlacement;
  timeline?: { id: string; content(feedback: ReactNode): ReactNode };
  search?: { toggle: ReactNode; count: number; results: ReactNode };
}) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const renameAfterMenu = useRef(false);
  const restoringRowFocus = useRef(false);
  const title = row.title || untitled;
  const deleted = row.deletedAt !== null;
  const reading = actions.readOnlyIds.includes(row.id);
  const rowId = timeline?.id ?? `entry-row-${row.id}`;
  const isPinned = pinned || row.pinned;
  const pinLabel = isPinned ? "取消置顶" : "置顶";
  const PinIcon = isPinned ? PinOff : Pin;
  const feedback = actions.feedback;
  const copyKeys = [`copyTitle:${row.id}`, `copyPath:${row.id}`];
  const copyKey = copyKeys.find(key => feedback?.status(key));
  const copyLocked = copyKeys.some(key => feedback?.isLocked(key));
  const copyState = copyKey ? feedback?.status(copyKey) : undefined;
  const copyLabel = copyKey && feedback ? feedback.label(copyKey, "正在复制…",
    copyKey === copyKeys[0] ? "标题已复制" : "路径已复制", "复制失败") : null;
  const rowIcon = pinned ? <Pin size={15} /> : <FileText size={15} />;
  const act = (action: EntryRowAction) => {
    if (timeline) actions.onRowAction(row, action, document.getElementById(rowId));
    else actions.onRowAction(row, action);
  };
  function open(event: MouseEvent<HTMLButtonElement>) {
    if (commandKey === "⌘" ? event.metaKey : event.ctrlKey) actions.onOpen(row.id, "new-tab");
    else actions.onOpen(row.id);
  }
  const trigger = <ContextMenu.Trigger>
    {timeline ? <div className="plain-button timeline-entry" data-menu-target={menuOpen || undefined} data-feedback-state={copyState}>
      <button type="button" id={rowId} className="timeline-entry-open" aria-label={title}
        aria-current={row.id === actions.active ? "true" : undefined} aria-busy={copyState === "pending" || undefined} onClick={open} />
      {timeline.content(copyKey && feedback ? <span className="entry-copy-result">{feedback.icon(copyKey, <Copy size={15} />, 15)}{copyLabel}</span> : null)}
    </div> : <button type="button" id={rowId}
      className={`plain-button entry-row ${detail ? "entry-detail" : "tree-entry"}`}
      data-tree-kind={detail ? undefined : "entry"} data-tree-id={row.id}
      data-tree-title={detail ? undefined : title}
      data-tree-draggable={draggable || undefined} data-tree-pinned={pinned || undefined} data-dragging={dragging || undefined}
      data-menu-target={menuOpen || undefined}
      data-feedback-state={copyState} aria-busy={copyState === "pending" || undefined}
      aria-label={title} aria-current={row.id === actions.active ? "true" : undefined} onClick={open}>
      {!search && (copyKey && feedback ? feedback.icon(copyKey, rowIcon, 15) : rowIcon)}<span className="entry-title">{copyLabel ?? title}</span>
      {detail && <span className="entry-meta"><span>{statusLabels[row.status]}</span><time dateTime={new Date(row.updatedAt).toISOString()}>{dateLabel(row.updatedAt)}</time></span>}
    </button>}
  </ContextMenu.Trigger>;
  const rowContent = renaming ? <div className={timeline ? "entry-inline timeline-entry" : detail ? "entry-inline entry-detail" : "entry-inline tree-entry"}>
      <FileText size={15} /><InlineEntryTitle title={row.title} placeholder={untitled} onError={actions.onFolderError}
        onSave={name => actions.onRenameEntry(row.id, name)} onClose={restore => {
          setRenaming(false);
          if (restore) requestAnimationFrame(() => {
            if (document.activeElement !== document.body) return;
            restoringRowFocus.current = true;
            document.getElementById(rowId)?.focus();
            restoringRowFocus.current = false;
          });
        }} />
    </div> : <ContextMenu.Root onOpenChange={open => { setMenuOpen(open); if (open) setHoverOpen(false); }}>
      {timeline ? trigger : <HoverCard.Root open={!menuOpen && !dragging && hoverOpen} onOpenChange={setHoverOpen} openDelay={420} closeDelay={100}>
      <HoverCard.Trigger onFocus={event => {
        if (restoringRowFocus.current) event.preventDefault();
      }}>{trigger}</HoverCard.Trigger>
      <HoverCard.Content side="right" align="start" sideOffset={10} className="entry-hover-card">
        <strong>{title}</strong>
        {row.createdAt !== undefined && <span><CalendarDays size={15} aria-hidden="true" />
          <time dateTime={new Date(row.createdAt).toISOString()}>创建于 {entryDate.format(row.createdAt)}</time>
        </span>}
        <span><History size={15} aria-hidden="true" /><time dateTime={new Date(row.updatedAt).toISOString()}>更新于 {entryDate.format(row.updatedAt)}</time></span>
      </HoverCard.Content>
      </HoverCard.Root>}
      {timeline && !deleted && <Tool label={pinLabel} className="timeline-pin" disabled={actions.treeLocked}
        onClick={() => act(isPinned ? "unpin" : "pin")}><PinIcon size={14} /></Tool>}
      <ContextMenu.Content size="1" onCloseAutoFocus={event => {
        if (!renameAfterMenu.current) return;
        renameAfterMenu.current = false;
        event.preventDefault();
        setHoverOpen(false);
        setRenaming(true);
      }}>
        {!deleted && <>
          <ContextMenu.Item disabled={actions.treeLocked} onSelect={() => act(isPinned ? "unpin" : "pin")}>
            <PinIcon size={14} />{pinLabel}
          </ContextMenu.Item>
          <ContextMenu.Separator />
        </>}
        <ContextMenu.Item onSelect={() => actions.onOpen(row.id)}><FileText size={14} />打开</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => actions.onOpen(row.id, actions.openMode === "new-tab" ? "current" : "new-tab")}>
          <SquareArrowOutUpRight size={14} />{actions.openMode === "new-tab" ? "在当前标签打开" : "在新标签打开"}
        </ContextMenu.Item>
        {!deleted && <>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={reading} onSelect={() => { renameAfterMenu.current = true; }}><PencilLine size={14} />重命名</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => act("duplicate")}><Files size={14} />创建副本</ContextMenu.Item>
          <MoveEntryMenu categories={actions.categories} current={row.categoryId ?? null} disabled={reading || actions.treeLocked}
            onMove={folder => actions.onMoveEntry(row.id, folder)} />
          {actions.onAddToCollection && <AddToCollectionMenu entryId={row.id} collections={actions.collectionOptions ?? []} disabled={actions.treeLocked}
            onAdd={collection => actions.onAddToCollection?.(row.id, collection)} onError={actions.onFolderError} />}
        </>}
        <ContextMenu.Separator />
        <ContextMenu.Item disabled={copyLocked} onSelect={() => act("copyTitle")}><Copy size={14} />复制标题</ContextMenu.Item>
        <ContextMenu.Item disabled={copyLocked} onSelect={() => act("copyPath")}><Link size={14} />复制工作区路径</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => act("history")}><History size={14} />历史版本</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => act("export")}><FileDown size={14} />导出 Markdown</ContextMenu.Item>
        <ContextMenu.Separator />
        {deleted
          ? <ContextMenu.Item onSelect={() => act("restore")}><ArchiveRestore size={14} />恢复</ContextMenu.Item>
          : <ContextMenu.Item color="red" disabled={reading} onSelect={() => act("delete")}><Trash2 size={14} />移入回收站</ContextMenu.Item>}
        {!deleted && !detail && <>
          <ContextMenu.Separator />
          <ContextMenu.Item onSelect={() => act("properties")}><FilePenLine size={14} />内容属性</ContextMenu.Item>
        </>}
      </ContextMenu.Content>
    </ContextMenu.Root>;
  return <li className={timeline ? "timeline-item" : search ? "tree-item search-note" : !detail ? "tree-item" : undefined} data-placement={placement}>
    {search ? <div className="search-note-header">
      {search.toggle}
      {rowContent}
      <span className="search-note-count" aria-hidden="true">{search.count}</span>
    </div> : rowContent}
    {search?.results}
  </li>;
}
