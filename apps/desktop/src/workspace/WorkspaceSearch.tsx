import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { Popover } from "@radix-ui/themes";
import { CaseSensitive, Search, SlidersHorizontal, X } from "lucide-react";
import { persist, Tool, useStoredInitial } from "../ui";

const historyKey = "workspace-search-history";

const operators = [
  ["path:", "匹配笔记路径", "path:"],
  ["file:", "匹配笔记标题", "file:"],
  ["tag:", "匹配标签", "tag:"],
  ["line:", "在同一行中匹配", "line:()"],
  ["section:", "在同一章节中匹配", "section:()"],
  ["[属性]", "匹配状态、摘要或来源", "[状态:]"],
] as const;

export function WorkspaceSearch({ query, caseSensitive, inputRef, onQuery, onCaseSensitive }: {
  query: string;
  caseSensitive: boolean;
  inputRef: Ref<HTMLInputElement>;
  onQuery(query: string): void;
  onCaseSensitive(value: boolean): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cursor = useRef<number | null>(null);
  const pendingQuery = useRef(false);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(useStoredInitial<string[]>(historyKey, []));

  useLayoutEffect(() => {
    if (open || cursor.current === null) return;
    const position = cursor.current;
    field.current!.focus();
    field.current!.setSelectionRange(position, position);
    cursor.current = null;
  }, [open, query]);

  function insert(value: string) {
    const prefix = query.trimEnd();
    const text = prefix ? `${prefix} ${value}` : value;
    cursor.current = text.length - (/[)\]]$/.test(value) ? 1 : 0);
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
            onClick={() => { onCaseSensitive(!caseSensitive); field.current?.focus(); }}><CaseSensitive size={17} /></Tool>
          {query && <Tool label="清除搜索" className="chrome-icon"
            onClick={() => { remember(); onQuery(""); setOpen(true); field.current?.focus(); }}><X size={14} /></Tool>}
        </div>
      </div>
      <Popover.Trigger><button className="plain-button chrome-icon workspace-search-options" type="button" aria-label="搜索选项">
        <SlidersHorizontal size={16} />
      </button></Popover.Trigger>
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
  </div>;
}
