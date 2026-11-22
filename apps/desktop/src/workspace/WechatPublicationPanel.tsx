import { useDeferredValue, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { Button, Checkbox, Dialog, DropdownMenu, Select, Spinner } from "@radix-ui/themes";
import { ArrowDown, ArrowUp, Copy, GripVertical, MoreHorizontal, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { WechatCandidate, WechatRecommendation } from "../../../../packages/shared-types";
import { wechatThemes, wechatThemeId } from "../../../../packages/wechat-renderer";
import { ActionError, useButtonFeedback } from "../button-feedback";
import { desktop, errorMessage } from "../desktop";
import type { PublicationSession } from "./wechat-publication";

function linkKey(value: string) {
  const url = new URL(value);
  return url.pathname === "/s" ? JSON.stringify(["__biz", "mid", "idx"].map(key => url.searchParams.get(key))) : url.pathname;
}

export function WechatPublicationPanel({ session, locked, onClose, onCopy, publishing, copyFeedback, sourceRevision = 0 }: {
  session: PublicationSession; locked: boolean; onClose(): void; onCopy(): void; publishing: boolean; copyFeedback?: ReturnType<typeof useButtonFeedback>; sourceRevision?: number;
}) {
  const { fields, revision } = useSyncExternalStore(session.queue.subscribe, session.queue.snapshot);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const defaults = useSyncExternalStore(session.defaults.subscribe, session.defaults.snapshot);
  const [tab, setTab] = useState("article");
  const [picker, setPicker] = useState(false);
  const [dragTarget, setDragTarget] = useState<string>();
  const drag = useRef<{ id: string; y: number; moved: boolean }>(null);
  const feedback = useButtonFeedback();
  const config = fields.wechatPublication ?? session.config();
  const recommendations = config.recommendations;
  const resolved = new Map(state.resolved.items.map(item => [item.entryId, item]));
  const invalid = new Map(state.resolved.invalid.map(item => [item.entryId, item.message]));
  useEffect(() => { void session.ensure().catch(() => {}); }, [session, revision, defaults.value?.version, sourceRevision]);

  async function changeItems(items: WechatRecommendation[]) {
    await session.change(current => ({ ...current, recommendations: { ...current.recommendations, items } }), true);
  }
  function move(index: number, direction: number) {
    const target = index + direction;
    if (target < 0 || target >= recommendations.items.length) return;
    const items = [...recommendations.items];
    [items[index], items[target]] = [items[target], items[index]];
    void changeItems(items);
  }
  function pointerUp(event: PointerEvent<HTMLOListElement>) {
    const moving = drag.current; drag.current = null; setDragTarget(undefined);
    if (!moving?.moved) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-recommendation]")?.dataset.recommendation;
    if (!target || target === moving.id) return;
    const items = [...recommendations.items];
    const from = items.findIndex(item => item.entryId === moving.id), to = items.findIndex(item => item.entryId === target);
    if (from < 0 || to < 0) return;
    const [item] = items.splice(from, 1); items.splice(to, 0, item); void changeItems(items);
  }
  const failure = state.error || defaults.error || feedback.error() || copyFeedback?.error("copyWechat")
    || state.resolved.invalid.map(item => `${recommendations.items.find(row => row.entryId === item.entryId)?.title ?? "推荐文章"}：${item.message}`).join("；");
  return <aside className="wechat-publishing-panel" aria-label="公众号配置">
    <header className="wechat-publishing-header"><h2>公众号</h2><button type="button" className="plain-button chrome-icon" aria-label="关闭公众号侧栏"
      {...feedback.props("close")} onClick={() => void feedback.run("close", async () => {
        if (!await session.flush()) throw new Error(session.snapshot().error); onClose();
      })}>{feedback.icon("close", <X size={16} />)}</button></header>
    <div className="wechat-publishing-tabs" role="tablist" aria-label="配置范围">
      {[["article", "当前文章"], ["defaults", "默认设置"]].map(([id, label]) => <button key={id} id={`wechat-${id}-tab`} type="button" role="tab"
        aria-selected={tab === id} aria-controls={`wechat-${id}-panel`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const next = id === "article" ? "defaults" : "article"; setTab(next); document.getElementById(`wechat-${next}-tab`)?.focus(); } }}>{label}</button>)}
    </div>
    <div className="wechat-publishing-body" role="tabpanel" id={`wechat-${tab}-panel`} aria-labelledby={`wechat-${tab}-tab`}>
      {tab === "article" ? <>
        <div className="wechat-setting-row"><label htmlFor="wechat-theme">排版主题</label><Select.Root size="1" value={wechatThemeId(fields.themeId)} disabled={locked}
          onValueChange={themeId => { session.queue.edit({ themeId }); void session.flush(); }}>
          <Select.Trigger id="wechat-theme" aria-label="排版主题" /><Select.Content>{wechatThemes.map(theme => <Select.Item key={theme.id} value={theme.id}>{theme.label}</Select.Item>)}</Select.Content>
        </Select.Root></div>
        <section className="wechat-recommendation-settings">
          <div className="wechat-recommendation-header"><h3>推荐阅读</h3>{state.loading && <Spinner size="1" />}<button type="button" className="wechat-recommendation-switch" role="switch"
            aria-label="启用推荐阅读" aria-checked={recommendations.enabled} disabled={locked}
            onClick={() => void session.change(current => ({ ...current, recommendations: { ...current.recommendations, enabled: !current.recommendations.enabled } }))}><span /></button></div>
          <div className="wechat-setting-row wechat-count-row"><label htmlFor="wechat-article-count">生成数量</label><div className="wechat-count-control">
            <input id="wechat-article-count" type="number" min="1" step="1" max="4294967295" disabled={locked} value={state.countDraft ?? session.input().count}
              onChange={event => session.editCount(event.target.value)} onBlur={() => void session.flush()} /><span>篇</span>
          </div>{recommendations.countOverride === null ? <span className="muted-text">默认</span> : <button type="button" className="plain-button wechat-small-action" disabled={locked}
            onClick={() => void session.change(current => ({ ...current, recommendations: { ...current.recommendations, countOverride: null } }))}>使用默认</button>}</div>
          <div className="wechat-list-heading"><span>{recommendations.mode === "auto" ? "自动推荐" : "手动调整"}</span><div>
            {state.undo && <button type="button" className="plain-button wechat-small-action" disabled={locked} onClick={() => void session.undo()}>撤销</button>}
            <button type="button" className="plain-button wechat-small-action" {...feedback.props("regenerate", locked || state.loading)}
              onClick={() => void feedback.run("regenerate", async () => { if (!await session.regenerate()) throw new Error(session.snapshot().error); })}>
              {feedback.icon("regenerate", <RotateCcw size={13} />, 13)}{feedback.label("regenerate", "重新推荐", "已推荐")}</button>
          </div></div>
          <ol className="wechat-recommendation-list" aria-label="当前推荐文章"
            onPointerMove={event => { if (!drag.current || Math.abs(event.clientY - drag.current.y) < 5 && !drag.current.moved) return;
              drag.current.moved = true; setDragTarget(document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-recommendation]")?.dataset.recommendation); }}
            onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setDragTarget(undefined); }}>
            {recommendations.items.map((item, index) => <li key={item.entryId} data-recommendation={item.entryId} data-drag-target={dragTarget === item.entryId || undefined}
              className="wechat-recommendation-row">
              <button type="button" className="plain-button wechat-drag-handle" aria-label={`拖动排序：${item.title}`} disabled={locked} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { id: item.entryId, y: event.clientY, moved: false }; event.currentTarget.closest("ol")!.setPointerCapture(event.pointerId); }}
                onKeyDown={event => { if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); move(index, event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical size={14} /></button>
              <span className={invalid.has(item.entryId) ? "inline-error" : ""} title={invalid.get(item.entryId)}>{resolved.get(item.entryId)?.title ?? item.title}</span>
              <DropdownMenu.Root><DropdownMenu.Trigger><button type="button" className="plain-button chrome-icon wechat-row-more" aria-label={`推荐文章 ${index + 1} 操作`} disabled={locked}><MoreHorizontal size={15} /></button></DropdownMenu.Trigger>
                <DropdownMenu.Content size="1" align="end"><DropdownMenu.Item disabled={index === 0} onSelect={() => move(index, -1)}><ArrowUp size={14} />上移</DropdownMenu.Item>
                  <DropdownMenu.Item disabled={index === recommendations.items.length - 1} onSelect={() => move(index, 1)}><ArrowDown size={14} />下移</DropdownMenu.Item>
                  <DropdownMenu.Separator /><DropdownMenu.Item color="red" onSelect={() => void changeItems(recommendations.items.filter(row => row.entryId !== item.entryId))}><Trash2 size={14} />移除推荐</DropdownMenu.Item>
                </DropdownMenu.Content></DropdownMenu.Root>
            </li>)}
          </ol>
          {!state.loading && recommendations.items.length === 0 && <p className="wechat-empty">尚未添加推荐文章</p>}
          <button type="button" className="plain-button wechat-add-articles" disabled={locked || state.loading} onClick={() => setPicker(true)}><Plus size={15} />添加文章</button>
        </section>
      </> : <section><h3>推荐阅读</h3><div className="wechat-setting-row wechat-default-count"><label htmlFor="wechat-default-count">默认生成数量</label>
        <div className="wechat-count-control"><input id="wechat-default-count" type="number" min="1" step="1" max="4294967295" disabled={locked || !defaults.value}
          value={defaults.draft} onChange={event => session.defaults.edit(event.target.value)} onBlur={() => void session.defaults.flush()} /><span>篇</span></div></div>
        <p className="wechat-scope-note">用于未单独设置数量的文章。</p>
        {defaults.error && <Button size="1" variant="soft" {...feedback.props("reload", locked)} onClick={() => void feedback.run("reload", () => session.defaults.reload())}>重新加载</Button>}
      </section>}
    </div>
    <footer className="wechat-publishing-footer"><ActionError error={failure} /><Button size="1" variant="solid" disabled={locked || publishing || state.loading || !state.ready || state.resolved.invalid.length > 0}
      {...copyFeedback?.props("copyWechat", locked || publishing || state.loading || !state.ready || state.resolved.invalid.length > 0)} onClick={onCopy}>
      {copyFeedback?.icon("copyWechat", <Copy size={15} />) ?? <Copy size={15} />}{copyFeedback?.label("copyWechat", "复制公众号格式", "已复制") ?? "复制公众号格式"}</Button></footer>
    {picker && <WechatArticlePicker session={session} selected={recommendations.items} onClose={() => setPicker(false)} onAdd={async items => {
      if (!await session.change(current => {
        const ids = new Set(current.recommendations.items.map(item => item.entryId));
        const urls = new Set(current.recommendations.items.map(item => linkKey(item.url)));
        const additions = items.filter(item => {
          const url = linkKey(item.url);
          if (ids.has(item.entryId) || urls.has(url)) return false;
          ids.add(item.entryId); urls.add(url); return true;
        });
        return { ...current, recommendations: { ...current.recommendations, items: [...current.recommendations.items, ...additions] } };
      }, true)) throw new Error(session.snapshot().error || "无法保存推荐列表");
      setPicker(false);
    }} />}
  </aside>;
}

function WechatArticlePicker({ session, selected, onClose, onAdd }: { session: PublicationSession; selected: WechatRecommendation[]; onClose(): void; onAdd(items: WechatRecommendation[]): Promise<void> }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [related, setRelated] = useState(true);
  const [items, setItems] = useState<WechatCandidate[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [staged, setStaged] = useState(new Map<string, WechatRecommendation>());
  const generation = useRef(0);
  const morePending = useRef(false);
  const feedback = useButtonFeedback();
  useEffect(() => {
    const ticket = ++generation.current; setBusy(true); setError("");
    void desktop.wechatCandidates(session.input(), deferredQuery, related).then(result => {
      if (ticket === generation.current) { setItems(result.items); setNextOffset(result.nextOffset); }
    }, failure => { if (ticket === generation.current) setError(errorMessage(failure)); }).finally(() => { if (ticket === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [session, deferredQuery, related]);
  async function loadMore() {
    if (nextOffset === null || morePending.current || busy) return;
    morePending.current = true; const ticket = generation.current;
    try { const result = await desktop.wechatCandidates(session.input(), deferredQuery, related, nextOffset);
      if (ticket === generation.current) { setItems(current => [...current, ...result.items]); setNextOffset(result.nextOffset); }
    } catch (failure) { if (ticket === generation.current) setError(errorMessage(failure)); }
    finally { morePending.current = false; }
  }
  const chosen = new Set(selected.map(item => item.entryId));
  const chosenLinks = new Set(selected.map(item => linkKey(item.url)));
  const alreadyAdded = (item: WechatRecommendation) => chosen.has(item.entryId) || chosenLinks.has(linkKey(item.url));
  return <Dialog.Root open onOpenChange={open => { if (!open && !feedback.isLocked("add")) onClose(); }}><Dialog.Content className="wechat-article-picker" maxWidth="660px" aria-describedby={undefined}>
    <header className="wechat-picker-header"><Dialog.Title>添加文章</Dialog.Title><Dialog.Close><button type="button" className="plain-button chrome-icon" aria-label="关闭文章选择器" disabled={feedback.isLocked("add")}><X size={16} /></button></Dialog.Close></header>
    <div className="wechat-picker-search"><Search size={15} /><input type="search" aria-label="搜索往期文章" placeholder="搜索标题、标签或摘要" value={query} onChange={event => setQuery(event.target.value)} autoFocus /></div>
    <div className="wechat-publishing-tabs" role="tablist" aria-label="文章范围">{[[true, "相关推荐"], [false, "全部文章"]].map(([value, label]) =>
      <button type="button" role="tab" key={String(value)} aria-selected={related === value} onClick={() => setRelated(value as boolean)}>{label}</button>)}</div>
    <div className="wechat-picker-results" aria-busy={busy} onScroll={event => { const element = event.currentTarget; if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) void loadMore(); }}>
      {busy ? <div className="wechat-picker-loading"><Spinner /></div> : items.map(item => <label className="wechat-picker-item" key={item.entryId}>
        <Checkbox disabled={alreadyAdded(item) || feedback.isLocked("add")} checked={alreadyAdded(item) || staged.has(item.entryId)} aria-label={item.title}
          onCheckedChange={checked => setStaged(current => { const next = new Map(current); if (checked) next.set(item.entryId, item); else next.delete(item.entryId); return next; })} />
        <span className="wechat-picker-description"><span className="wechat-picker-title"><strong>{item.title}</strong>{alreadyAdded(item) && <span>已添加</span>}</span>
          {item.summary && <span className="wechat-picker-summary">{item.summary}</span>}<span className="wechat-picker-meta"><span>{item.tags.map(tag => <span className="wechat-picker-tag" key={tag}>{tag}</span>)}</span>
            {item.publishedAt !== null && <time>{new Date(item.publishedAt).toLocaleDateString("zh-CN")}</time>}</span></span>
      </label>)}
      {!busy && !error && items.length === 0 && <p className="wechat-empty">没有找到相关文章</p>}
    </div>
    <ActionError error={error || feedback.error("add")} /><footer className="wechat-picker-footer"><Dialog.Close><Button size="1" variant="soft" color="gray" disabled={feedback.isLocked("add")}>取消</Button></Dialog.Close>
      <Button size="1" {...feedback.props("add", staged.size === 0 || busy)} onClick={() => void feedback.run("add", () => onAdd([...staged.values()]))}>{feedback.icon("add", <Plus size={14} />)}{staged.size ? `添加 ${staged.size} 篇` : "添加文章"}</Button></footer>
  </Dialog.Content></Dialog.Root>;
}
