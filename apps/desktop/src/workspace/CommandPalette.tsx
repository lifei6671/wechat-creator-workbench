import { useEffect, useRef, useState } from "react";
import { Popover } from "@radix-ui/themes";
import { FileText, X } from "lucide-react";
import { desktop, errorMessage } from "../desktop";
import { untitled } from "../labels";
import type { EntryRow } from "../../../../packages/shared-types";

export interface PaletteCommand { name: string; keys?: string; run(): void }

export function CommandPalette({ actions, onOpen, onClose }: {
  actions: PaletteCommand[];
  onOpen(id: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [matches, setMatches] = useState<EntryRow[]>([]);
  const [error, setError] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const options = [
    ...actions.filter(action => action.name.includes(query.trim())),
    ...matches.map(entry => ({
      name: entry.title || untitled, keys: undefined,
      run: () => onOpen(entry.id), entryId: entry.id,
    })),
  ];
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      void desktop.entries({ query, deleted: false, offset: 0 }).then(
        page => { if (current) setMatches(page.items.slice(0, 8)); },
        error => { if (current) setError(errorMessage(error)); },
      );
    }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [query]);

  function select(index: number) {
    const command = options[index];
    if (command) { onClose(); command.run(); }
  }
  return <Popover.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Popover.Anchor className="command-palette-anchor" aria-hidden="true" />
    <Popover.Content className="command-palette" aria-label="命令面板" align="center" maxWidth="calc(100vw - 32px)"
      collisionPadding={16} onCloseAutoFocus={event => event.preventDefault()}>
      <div className="command-palette-field">
        <input role="combobox" aria-label="查找命令或笔记" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results"
          aria-activedescendant={options[index] ? `command-${index}` : undefined} value={query} placeholder="查找命令或笔记"
          onChange={event => { setQuery(event.target.value); setIndex(0); setMatches([]); setError(""); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") { event.preventDefault(); select(index); }
            if (options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              const next = (index + step + options.length) % options.length;
              setIndex(next);
              list.current?.children[next]?.scrollIntoView({ block: "nearest" });
            }
          }} />
        <button className="plain-button chrome-icon" type="button" aria-label="关闭命令面板" onClick={onClose}><X size={16} /></button>
      </div>
      <div id="command-results" role="listbox" aria-label="命令和内容" className="command-results" ref={list}>
        {options.map((option, i) => <button type="button" key={"entryId" in option ? String(option.entryId) : option.name}
          className="plain-button command-row" role="option" id={`command-${i}`} aria-selected={i === index}
          onMouseMove={() => setIndex(i)} onClick={() => select(i)} tabIndex={-1}>
          {"entryId" in option && <FileText size={15} />}<span>{option.name}</span>{option.keys && <kbd>{option.keys}</kbd>}
        </button>)}
      </div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      {!options.length && !error && <p className="muted-text command-empty">暂无匹配结果</p>}
    </Popover.Content>
  </Popover.Root>;
}
