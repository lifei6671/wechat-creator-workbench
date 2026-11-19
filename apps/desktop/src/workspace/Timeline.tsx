import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Button } from "@radix-ui/themes";
import { ChevronDown, FolderOpen, Layers, Tag as TagIcon, type LucideIcon } from "lucide-react";
import type { Category, EntryFilter, EntryPage, EntryRow, Tag, TimelineSelection } from "../../../../packages/shared-types";
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
type TimelineHeading = { label: string; icon: LucideIcon; hasFolder: boolean; includeChildren: boolean };
type TimelineFilter = EntryFilter & { timelineScope: TimelineSelection };
type TimelineResults = { filter: TimelineFilter; heading: TimelineHeading; page: EntryPage | null; pinned: EntryRow[] };

function groupEntries(items: EntryRow[]) {
  const today = new Date();
  const todayDay = calendarDay(today);
  const groups: { label: string; period: number | string; recent: boolean; items: EntryRow[] }[] = [];
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const daysAgo = (todayDay - calendarDay(date)) / 86_400_000;
    const month = `${date.getMonth() + 1}月`;
    const label = daysAgo === 0 ? "今天" : daysAgo === 1 ? "昨天"
      : today.getFullYear() === date.getFullYear() ? month : `${date.getFullYear()}年${month}`;
    const recent = daysAgo === 0 || daysAgo === 1;
    const period = recent ? calendarDay(date) : `${date.getFullYear()}-${date.getMonth() + 1}`;
    if (groups.at(-1)?.period !== period) groups.push({ label, period, recent, items: [] });
    groups.at(-1)!.items.push(item);
  }
  return groups;
}

export function Timeline({ workspaceId, root, folder, tag, untagged, tags, onSelectTag, includeChildren, onIncludeChildren, onPin, revision, actions, sidebarToggle, navigation, directoryToggle, blankMenu }: {
  workspaceId: string | undefined;
  root: boolean;
  folder: Category | null;
  tag: Tag | null;
  untagged: boolean;
  tags: Tag[];
  onSelectTag: ArticleTags["select"];
  includeChildren: boolean;
  onIncludeChildren(value: boolean): void;
  onPin(id: string, pinned: boolean, scope: TimelineSelection): void;
  revision: number;
  actions: RowActions;
  sidebarToggle: ReactNode;
  navigation?: ReactNode;
  directoryToggle?: ReactNode;
  blankMenu: ComponentProps<typeof BlankAreaMenu>["actions"];
}) {
  const label = !workspaceId ? null : root ? rootFolderLabel : folder?.name ?? tag?.name ?? (untagged ? "无标签" : null);
  const heading: TimelineHeading | null = label === null ? null : {
    label, icon: folder ? folderIcons[folder.icon][0] : root ? FolderOpen : TagIcon, hasFolder: !!folder, includeChildren,
  };
  const hasSelection = heading !== null;
  const requestHeading = useEffectEvent(() => heading);
  const tagIds = useMemo(() => new Map(tags.map(tag => [tag.name, tag.id])), [tags]);
  const [results, setResults] = useState<TimelineResults | null>(null);
  const [pending, setPending] = useState(true);
  const [requestError, setError] = useState<{ message: string; loadingMore?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const loaded = useRef(pageSize);
  const generation = useRef(0);
  const focusRow = useRef<string | null>(null);
  const movedRow = useRef<{ id: string; previous: HTMLElement } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const categoryId = folder?.id;
  const tagId = tag?.id;
  const exactCategory = root || Boolean(folder && !includeChildren);
  const filter = useMemo<TimelineFilter>(() => ({
    categoryId, exactCategory, tagIds: tagId ? [tagId] : undefined,
    untagged, deleted: false, pinned: false,
    timelineScope: categoryId ? { kind: "folder", id: categoryId } : tagId ? { kind: "tag", id: tagId } : { kind: untagged ? "untagged" : "root" },
    sort: "updated", kind: "article", includePreview: true, offset: 0,
  }), [categoryId, exactCategory, tagId, untagged]);

  const switching = results !== null && results.filter !== filter;
  const shownHeading = hasSelection ? (switching ? results.heading : heading) : null;
  const { page = null, pinned = [] } = results ?? {};
  const articleTags = { ids: tagIds, select: onSelectTag };
  const error = switching ? null : requestError;

  useLayoutEffect(() => {
    loaded.current = pageSize;
    focusRow.current = null;
    movedRow.current = null;
    return () => { generation.current++; };
  }, [filter, hasSelection]);

  useEffect(() => {
    const heading = requestHeading();
    if (!heading) { setResults(null); setError(null); setPending(false); return; }
    const current = ++generation.current;
    setPending(true);
    setError(null);
    void Promise.all([
      desktop.entries({ ...filter, limit: loaded.current }),
      desktop.entries({ ...filter, pinned: true, limit: allEntries }),
    ]).then(([dated, pins]) => {
      if (generation.current !== current) return;
      setResults({ filter, heading, page: dated, pinned: pins.items });
    }, failure => {
      if (generation.current !== current) return;
      setResults(previous => previous?.filter === filter ? previous : { filter, heading, page: null, pinned: [] });
      setError({ message: errorMessage(failure) });
    }).finally(() => {
      if (generation.current === current) setPending(false);
    });
    return () => { generation.current++; };
  }, [filter, hasSelection, revision, retry]);

  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [results?.filter]);

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
  }, [results]);

  const rowActions: RowActions = {
    ...actions,
    onRowAction(row, action, trigger) {
      if (action === "pin" || action === "unpin") {
        if (!results || switching) return;
        if (trigger && document.activeElement !== document.body) movedRow.current = { id: row.id, previous: trigger };
        onPin(row.id, action === "pin", results.filter.timelineScope);
        return;
      }
      actions.onRowAction(row, action, trigger);
    },
  };

  function more(event: MouseEvent<HTMLButtonElement>) {
    if (!results || !page || switching) return;
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
      setResults({ ...results, page: { items: [...page.items, ...added], nextOffset: result.nextOffset } });
      setError(null);
    }, failure => {
      if (generation.current === current) setError({ message: errorMessage(failure), loadingMore: true });
    }).finally(() => {
      if (generation.current === current) setPending(false);
    });
  }

  const fixedIds = new Set(pinned.map(item => item.id));
  const datedItems = page?.items.filter(item => !fixedIds.has(item.id)) ?? [];
  const committedFilter = results?.filter;
  const groupScope = JSON.stringify([workspaceId, committedFilter?.categoryId, committedFilter?.exactCategory,
    committedFilter?.tagIds?.[0], committedFilter?.untagged]);
  const Icon = shownHeading?.icon;
  return <aside className="timeline-pane" aria-label="文章时间流">
    <div className={navigation ? "chrome-band timeline-chrome sidebar-chrome timeline-only-chrome" : "chrome-band timeline-chrome"}
      role={navigation ? "navigation" : undefined} aria-label={navigation ? "工作区导航" : undefined}>
      {navigation}<WindowDragRegion onError={actions.onFolderError} />{sidebarToggle}
    </div>
    {(shownHeading || directoryToggle) &&
      <div className="section-bar explorer-title timeline-heading">
        <div className="timeline-folder-title">
          {directoryToggle}
          {shownHeading && Icon && <><Icon size={16} aria-hidden="true" /><h1>{shownHeading.label}</h1></>}
        </div>
        {shownHeading?.hasFolder && <Tool label="包含子目录" className="chrome-icon" aria-pressed={shownHeading.includeChildren} disabled={switching}
          onClick={() => onIncludeChildren(!includeChildren)}><Layers size={16} /></Tool>}
      </div>}
    <BlankAreaMenu label="文章区操作" actions={switching ? null : blankMenu}>
      <div className="timeline-content" inert={switching} onContextMenu={event => {
        if (event.target instanceof Element && event.target.closest("button, input")) event.preventDefault();
      }}>
        {hasSelection && <div ref={list} className="timeline-entries explorer-list-scroll" aria-busy={switching || pending} onPointerDown={event => {
          if (event.pointerType !== "mouse" && event.target instanceof Element && event.target.closest("button, input, .timeline-entry")) event.stopPropagation();
        }}>
          {results && <>
            {pinned.length > 0 && <TimelineGroup label="已固定" items={pinned} actions={rowActions} articleTags={articleTags} scope={groupScope} period="pinned" pinned />}
            {groupEntries(datedItems).map(group => <TimelineGroup key={group.period} {...group} actions={rowActions} articleTags={articleTags} scope={groupScope} />)}
          </>}
          {error && <p className="timeline-feedback inline-error" role="alert">{error.message}</p>}
          {error && !error.loadingMore && <Button size="1" variant="soft" className="timeline-more"
            onClick={() => setRetry(value => value + 1)}>重试</Button>}
          {!error && (!page ? <p className="timeline-feedback muted-text" role="status">正在加载…</p>
            : !page.items.length && !pinned.length && <p className="timeline-feedback muted-text">暂无文章</p>)}
          {page?.nextOffset != null && (!error || error.loadingMore) && <Button size="1" variant="ghost" className="timeline-more"
            aria-disabled={switching || pending} onClick={more}>{error?.loadingMore ? "重试" : "加载更多"}</Button>}
        </div>}
      </div>
    </BlankAreaMenu>
  </aside>;
}

function TimelineGroup({ label, items, actions, articleTags, recent, pinned, scope, period }: {
  label: string; items: EntryRow[]; actions: RowActions; articleTags: ArticleTags; recent?: boolean; pinned?: boolean;
  scope: string; period: string | number;
}) {
  const preference = `timeline-group-collapsed:${scope}:${period}`;
  const saved = useMemo(() => localStorage.getItem(preference) === "true", [preference]);
  const [override, setOverride] = useState<{ preference: string; collapsed: boolean }>();
  const collapsed = override?.preference === preference ? override.collapsed : saved;
  const listId = useId();
  return <section className="timeline-group">
    <h2><button type="button" className="plain-button timeline-group-toggle"
      aria-expanded={!collapsed} aria-controls={listId} onClick={() => {
        if (collapsed) localStorage.removeItem(preference);
        else localStorage.setItem(preference, "true");
        setOverride({ preference, collapsed: !collapsed });
      }}>
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
