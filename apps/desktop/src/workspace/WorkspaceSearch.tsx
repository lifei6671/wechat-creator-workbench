import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Popover, Switch } from "@radix-ui/themes";
import { CaseSensitive, ListFilter, Search, SlidersHorizontal, X } from "lucide-react";
import type { WorkspaceSearchHit, WorkspaceSearchInfo } from "../../../../packages/shared-types";
import { persist, Tool, useStoredInitial } from "../ui";

const historyKey = "workspace-search-history";

const operators = [
  ["path:", "匹配笔记路径", "path:()"],
  ["file:", "匹配笔记标题", "file:()"],
  ["content:", "匹配正文", "content:()"],
  ["tag:", "匹配标签", "tag:()"],
  ["line:", "在同一行中匹配", "line:()"],
  ["section:", "在同一章节中匹配", "section:()"],
  ["[属性]", "匹配状态、摘要或来源", "[状态:]"],
] as const;

export const searchDisplayDefaults = { collapse: false, context: false, explain: false };
export type SearchDisplay = typeof searchDisplayDefaults;
export const searchDisplayKey = "workspace-search-display";
const settings = [
  ["collapse", "折叠搜索结果"],
  ["context", "显示更多上下文"],
  ["explain", "说明搜索含义"],
] as const;

export function WorkspaceSearch({ query, caseSensitive, inputRef, onQuery, onCaseSensitive,
  display = searchDisplayDefaults, onDisplayChange, searchInfo }: {
  query: string;
  caseSensitive: boolean;
  inputRef: Ref<HTMLInputElement>;
  onQuery(query: string): void;
  onCaseSensitive(value: boolean): void;
  display?: SearchDisplay;
  onDisplayChange?(value: SearchDisplay): void;
  searchInfo?: WorkspaceSearchInfo;
}) {
  const field = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cursor = useRef<number | null>(null);
  const pendingQuery = useRef(false);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  const [history, setHistory] = useState(useStoredInitial<string[]>(historyKey, []));

  useLayoutEffect(() => {
    if (open || cursor.current === null) return;
    const position = cursor.current;
    field.current!.focus();
    field.current!.setSelectionRange(position, position);
    cursor.current = null;
  }, [open, query]);

  function insert(value: string) {
    const { selectionStart, selectionEnd } = field.current!;
    const selected = selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd;
    const prefix = (selected ? query.slice(0, selectionStart) : query).trimEnd();
    const suffix = selected ? query.slice(selectionEnd).trimStart() : "";
    const insertion = value.slice(0, -1) + (selected ? query.slice(selectionStart, selectionEnd) : "") + value.slice(-1);
    const head = prefix ? `${prefix} ${insertion}` : insertion;
    const text = suffix ? `${head} ${suffix}` : head;
    cursor.current = head.length - 1;
    pendingQuery.current = true;
    onQuery(text);
    setOpen(false);
  }

  function saveHistory(next: string[]) {
    setHistory(next);
    persist(historyKey, next);
  }

  function remember() {
    if (!pendingQuery.current) return;
    pendingQuery.current = false;
    const value = query.trim();
    if (value && value !== history[0]) saveHistory([value, ...history.filter(item => item !== value)].slice(0, 12));
  }

  return <div className="workspace-search" ref={row} onBlur={event => {
    const next = event.relatedTarget;
    if (row.current?.contains(next) || list.current?.contains(next)) return;
    remember();
    setOpen(false);
  }}>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor virtualRef={anchor} />
      <div ref={anchor} className="workspace-search-field">
        <Search size={15} aria-hidden="true" />
        <input autoFocus ref={element => {
          field.current = element;
          if (typeof inputRef === "function") inputRef(element);
          else if (inputRef) inputRef.current = element;
        }} aria-label="搜索笔记" placeholder="搜索笔记" value={query}
          onFocus={() => { if (cursor.current === null) setOpen(true); }}
          onClick={() => { if (!query.trim()) setOpen(true); }}
          onChange={event => { pendingQuery.current = true; onQuery(event.target.value); setOpen(!event.target.value.trim()); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              remember();
              setOpen(false);
            } else if (event.key === "ArrowDown" && open) {
              event.preventDefault();
              list.current?.querySelector("button")?.focus();
            }
          }} />
        <div className="workspace-search-tools">
          <Tool label="区分大小写" className="chrome-icon" aria-pressed={caseSensitive}
            onClick={() => { onCaseSensitive(!caseSensitive); field.current?.focus(); setOpen(false); }}><CaseSensitive size={17} /></Tool>
          {query && <Tool label="清除搜索" className="chrome-icon"
            onClick={() => { remember(); onQuery(""); setOpen(true); field.current?.focus(); }}><X size={14} /></Tool>}
        </div>
      </div>
      <Popover.Trigger><Tool label="搜索语法" className="chrome-icon workspace-search-syntax"><ListFilter size={16} /></Tool></Popover.Trigger>
      {onDisplayChange && <Tool label="搜索选项" className="chrome-icon workspace-search-options"
        aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => {
          setOpen(false);
          setSettingsOpen(current => !current);
        }}><SlidersHorizontal size={16} /></Tool>}
      <Popover.Content ref={list} className="search-operators" size="1" align="start" sideOffset={10} collisionPadding={8} aria-label="搜索语法"
        onOpenAutoFocus={event => { if (document.activeElement === field.current) event.preventDefault(); }}
        onInteractOutside={event => { if (row.current?.contains(event.target as Node)) event.preventDefault(); }}
        onEscapeKeyDown={event => { event.preventDefault(); field.current?.focus(); setOpen(false); }}
        onCloseAutoFocus={event => event.preventDefault()}>
        <h2>搜索语法</h2>
        {operators.map(([syntax, label, value]) => <button key={syntax} type="button" className="plain-button search-operator"
          onClick={() => insert(value)}><code>{syntax}</code><span>{label}</span></button>)}
        {history.length > 0 && <div className="search-history">
          <div className="search-history-heading">
            <h2>搜索历史</h2>
            <Tool label="清除搜索历史" className="chrome-icon" onClick={() => {
              field.current!.focus();
              pendingQuery.current = false;
              saveHistory([]);
            }}><X size={13} /></Tool>
          </div>
          {history.map(value => <button className="plain-button search-operator search-history-item" key={value} type="button"
            onClick={() => {
              cursor.current = value.length;
              pendingQuery.current = false;
              onQuery(value);
              saveHistory([value, ...history.filter(item => item !== value)]);
              setOpen(false);
            }}>{value}</button>)}
        </div>}
      </Popover.Content>
    </Popover.Root>
    {display.explain && searchInfo && <SearchExplanation info={searchInfo} />}
    {settingsOpen && onDisplayChange && <div id={settingsId} className="workspace-search-settings" aria-label="搜索显示设置">
      {settings.map(([key, label]) => <label key={key}>{label}
        <Switch size="1" checked={display[key]} onCheckedChange={checked => onDisplayChange({ ...display, [key]: checked })} />
      </label>)}
    </div>}
  </div>;
}

const fieldLabels: Record<Exclude<WorkspaceSearchInfo["clauses"][number]["field"], "text" | "unknownProperty">, string> = {
  content: "匹配正文", file: "匹配标题", path: "匹配路径", tag: "匹配标签", line: "匹配行",
  section: "匹配章节", status: "匹配状态", summary: "匹配摘要", source: "匹配来源",
};

function explainAll(nodes: ReactNode[]) {
  return nodes.length > 1 ? <li>匹配所有:<ul role="list">{nodes}</ul></li> : nodes;
}

function SearchExplanation({ info }: { info: WorkspaceSearchInfo }) {
  if (!info.clauses.length) return null;
  const nodes = info.clauses.flatMap(({ field, terms }, index) => {
    const leaves = terms.map((term, termIndex) => <li key={`${index}-${termIndex}`}>{`匹配文本: ${JSON.stringify(term)}`}</li>);
    if (field === "text") return leaves;
    if (field === "unknownProperty") return [<li key={index}>未知属性，无法匹配</li>];
    return [<li key={index}>{`${fieldLabels[field]}:`}<ul role="list">
      {leaves.length ? explainAll(leaves) : <li>属性有值</li>}
    </ul></li>];
  });
  return <ul role="list" className="search-explanation" aria-label="搜索含义">{explainAll(nodes)}</ul>;
}

export function SearchHitRow({ hit, selected, showContext, onOpen }: {
  hit: WorkspaceSearchHit;
  selected: boolean;
  showContext: boolean;
  onOpen(): void;
}) {
  const snippet = showContext ? (hit.expanded ?? hit) : hit;
  let start = 0;
  const chunks = snippet.ranges.map(range => {
    const before = snippet.text.slice(start, range.start);
    start = range.end;
    return <Fragment key={range.start}>{before}<mark>{snippet.text.slice(range.start, range.end)}</mark></Fragment>;
  });
  return <li>
    <button className="plain-button search-hit" type="button" aria-current={selected ? "true" : undefined}
      onClick={onOpen}>
      <span className="search-hit-line" aria-label={`第 ${hit.line} 行`}>{hit.line}</span>
      <span className="search-hit-content">
        {showContext && hit.before && <code className="search-hit-context">{hit.before}</code>}
        <code className="search-hit-text">{snippet.leading && "…"}{chunks}{snippet.text.slice(start)}{snippet.trailing && "…"}</code>
        {showContext && hit.after && <code className="search-hit-context">{hit.after}</code>}
      </span>
    </button>
  </li>;
}
