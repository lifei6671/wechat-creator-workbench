import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Button } from "@radix-ui/themes";
import { ChevronDown, FolderOpen, Layers, Tag as TagIcon } from "lucide-react";
import type { Category, EntryFilter, EntryPage, EntryRow, Tag } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { rootFolderLabel, untitled } from "../labels";
import { Tool } from "../ui";
import { CoverThumbnail } from "./Assets";
import { allEntries, BlankAreaMenu, ContentRow, type RowActions } from "./Explorer";
import { folderIcons } from "./folder-icons";
import { WindowDragRegion } from "./WindowTitle";

const pageSize = 60;
const dayLabel = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
const timeLabel = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const calendarDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
type ArticleTags = { ids: ReadonlyMap<string, string>; select(id: string, keyboard: boolean): void };

function groupEntries(items: EntryRow[]) {
  const today = new Date();
  const todayDay = calendarDay(today);
  const groups: { label: string; recent: boolean; items: EntryRow[] }[] = [];
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const daysAgo = (todayDay - calendarDay(date)) / 86_400_000;
    const month = `${date.getMonth() + 1}月`;
    const label = daysAgo === 0 ? "今天" : daysAgo === 1 ? "昨天"
      : today.getFullYear() === date.getFullYear() ? month : `${date.getFullYear()}年${month}`;
    if (groups.at(-1)?.label !== label) groups.push({ label, recent: daysAgo === 0 || daysAgo === 1, items: [] });
    groups.at(-1)!.items.push(item);
  }
  return groups;
}

export function Timeline({ root, folder, tag, untagged, tags, onSelectTag, includeChildren, onIncludeChildren, revision, actions, sidebarToggle, blankMenu }: {
  root: boolean;
  folder: Category | null;
  tag: Tag | null;
  untagged: boolean;
  tags: Tag[];
  onSelectTag: ArticleTags["select"];
  includeChildren: boolean;
  onIncludeChildren(value: boolean): void;
  revision: number;
  actions: RowActions;
  sidebarToggle: ReactNode;
  blankMenu: Omit<ComponentProps<typeof BlankAreaMenu>, "children" | "label"> | null;
}) {
  const label = root ? rootFolderLabel : folder?.name ?? tag?.name ?? (untagged ? "无标签" : null);
  const Icon = folder ? folderIcons[folder.icon][0] : root ? FolderOpen : TagIcon;
  const directoryKey = folder ? `folder:${folder.id}` : "root";
  const tagIds = useMemo(() => new Map(tags.map(tag => [tag.name, tag.id])), [tags]);
  const content = <div className="timeline-content" onContextMenu={event => {
    if (event.target instanceof Element && event.target.closest("button, input")) event.preventDefault();
  }}>
    {label !== null && <TimelineEntries key={folder ? `${directoryKey}:${includeChildren}` : tag ? `tag:${tag.id}` : root ? directoryKey : "untagged"}
      categoryId={folder?.id} tagId={tag?.id} untagged={untagged} exactCategory={root || Boolean(folder && !includeChildren)}
      revision={revision} actions={actions}
      articleTags={{ ids: tagIds, select: onSelectTag }} />}
  </div>;
  return <aside className="timeline-pane" aria-label="文章时间流">
    <div className="chrome-band timeline-chrome"><WindowDragRegion onError={actions.onFolderError} />{sidebarToggle}</div>
    {label !== null &&
      <div className="section-bar explorer-title timeline-heading">
        <div className="timeline-folder-title">
          <Icon size={16} aria-hidden="true" />
          <h1>{label}</h1>
        </div>
        {folder && <Tool label="包含子目录" className="chrome-icon" aria-pressed={includeChildren}
          onClick={() => onIncludeChildren(!includeChildren)}><Layers size={16} /></Tool>}
      </div>}
    {blankMenu ? <BlankAreaMenu key={directoryKey} {...blankMenu} label="文章区操作">{content}</BlankAreaMenu> : content}
  </aside>;
}

function TimelineEntries({ categoryId, tagId, untagged, exactCategory, revision, actions, articleTags }: {
  categoryId?: string;
  tagId?: string;
  untagged: boolean;
  exactCategory: boolean;
  revision: number;
  actions: RowActions;
  articleTags: ArticleTags;
}) {
  const [page, setPage] = useState<EntryPage | null>(null);
  const [pinned, setPinned] = useState<EntryRow[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<{ message: string; loadingMore?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const loaded = useRef(pageSize);
  const generation = useRef(0);
  const focusRow = useRef<string | null>(null);
  const movedRow = useRef<{ id: string; previous: HTMLElement } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const filter = useMemo<EntryFilter>(() => ({
    categoryId, exactCategory, tagIds: tagId ? [tagId] : undefined,
    untagged, deleted: false, pinned: false,
    sort: "updated", kind: "article", includePreview: true, offset: 0,
  }), [categoryId, exactCategory, tagId, untagged]);

  useEffect(() => {
    const current = ++generation.current;
    setPending(true);
    setError(null);
    void Promise.all([
      desktop.entries({ ...filter, limit: loaded.current }),
      desktop.entries({ ...filter, pinned: true, limit: allEntries }),
    ]).then(([dated, pins]) => {
      if (generation.current !== current) return;
      setPage(dated);
      setPinned(pins.items);
    }, failure => {
      if (generation.current === current) setError({ message: errorMessage(failure) });
    }).finally(() => {
      if (generation.current === current) setPending(false);
    });
    return () => { generation.current++; };
  }, [filter, revision, retry]);

  useLayoutEffect(() => {
    if (focusRow.current) {
      document.getElementById(`timeline-row-${focusRow.current}`)?.focus();
      focusRow.current = null;
    }
    const moved = movedRow.current;
    if (!moved || moved.previous.isConnected) return;
    movedRow.current = null;
    if (document.activeElement !== document.body || list.current?.closest("[inert]")) return;
    const row = document.getElementById(`timeline-row-${moved.id}`);
    const target = row && !row.closest("[inert]") ? row
      : (row?.closest(".timeline-group") ?? list.current)?.querySelector<HTMLButtonElement>(".timeline-group-toggle");
    target?.focus();
  }, [page, pinned]);

  const rowActions: RowActions = {
    ...actions,
    onRowAction(row, action, trigger) {
      if ((action === "pin" || action === "unpin") && trigger && document.activeElement !== document.body) {
        movedRow.current = { id: row.id, previous: trigger };
      }
      actions.onRowAction(row, action, trigger);
    },
  };

  function more(event: MouseEvent<HTMLButtonElement>) {
    if (!page) return;
    const offset = page.nextOffset;
    if (offset == null || pending) return;
    const current = ++generation.current;
    const keyboardTrigger = event.detail === 0 ? event.currentTarget : null;
    setPending(true);
    void desktop.entries({ ...filter, offset, limit: pageSize }).then(result => {
      if (generation.current !== current) return;
      const seen = new Set(page.items.map(item => item.id));
      const added = result.items.filter(item => !seen.has(item.id));
      if (keyboardTrigger === document.activeElement && added.length) focusRow.current = added[0].id;
      loaded.current = offset + pageSize;
      setPage({ items: [...page.items, ...added], nextOffset: result.nextOffset });
      setError(null);
    }, failure => {
      if (generation.current === current) setError({ message: errorMessage(failure), loadingMore: true });
    }).finally(() => {
      if (generation.current === current) setPending(false);
    });
  }

  const fixedIds = new Set(pinned.map(item => item.id));
  const datedItems = page?.items.filter(item => !fixedIds.has(item.id)) ?? [];
  return <div ref={list} className="timeline-entries explorer-list-scroll" aria-busy={pending} onPointerDown={event => {
    if (event.pointerType !== "mouse" && event.target instanceof Element && event.target.closest("button, input, .timeline-entry")) event.stopPropagation();
  }}>
    {pinned.length > 0 && <TimelineGroup label="已固定" items={pinned} actions={rowActions} articleTags={articleTags} pinned />}
    {groupEntries(datedItems).map(group => <TimelineGroup key={group.label} {...group} actions={rowActions} articleTags={articleTags} />)}
    {error && <p className="timeline-feedback inline-error" role="alert">{error.message}</p>}
    {error && !error.loadingMore && <Button size="1" variant="soft" className="timeline-more"
      onClick={() => setRetry(value => value + 1)}>重试</Button>}
    {!error && (!page ? <p className="timeline-feedback muted-text" role="status">正在加载…</p>
      : !page.items.length && !pinned.length && <p className="timeline-feedback muted-text">暂无文章</p>)}
    {page?.nextOffset != null && (!error || error.loadingMore) && <Button size="1" variant="ghost" className="timeline-more"
      aria-disabled={pending} onClick={more}>{error?.loadingMore ? "重试" : "加载更多"}</Button>}
  </div>;
}

function TimelineGroup({ label, items, actions, articleTags, recent, pinned }: {
  label: string; items: EntryRow[]; actions: RowActions; articleTags: ArticleTags; recent?: boolean; pinned?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();
  return <section className="timeline-group">
    <h2><button type="button" className="plain-button timeline-group-toggle"
      aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {label}<ChevronDown size={14} aria-hidden="true" />
    </button></h2>
    <div className="tree-section-content" data-collapsed={collapsed}>
      <ul id={listId} aria-label={label} inert={collapsed}>
        {items.map(item => {
          const time = new Date(item.updatedAt);
          return <ContentRow key={item.id} row={item} actions={actions} pinned={pinned}
            timeline={{ id: `timeline-row-${item.id}`, content: <>
              <span className="timeline-entry-copy">
                <strong>{item.title || untitled}</strong>
                {item.preview?.summary && <span className="timeline-summary">{item.preview.summary}</span>}
                {!!item.preview?.tags?.length && <span className="timeline-entry-tags">
                  {item.preview.tags.map(tag => {
                    const id = articleTags.ids.get(tag);
                    return id ? <button key={tag} type="button" onClick={event => articleTags.select(id, event.detail === 0)}>{tag}</button>
                      : <span key={tag}>{tag}</span>;
                  })}
                </span>}
                {!pinned && <time dateTime={time.toISOString()} title={time.toLocaleString("zh-CN")}>
                  {recent ? timeLabel.format(time) : dayLabel.format(time)}
                </time>}
              </span>
              {item.preview?.image && <CoverThumbnail key={item.preview.image} source={item.preview.image} />}
            </> }} />;
        })}
      </ul>
    </div>
  </section>;
}
