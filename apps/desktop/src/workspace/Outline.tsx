import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { TextField } from "@radix-ui/themes";
import { ChevronRight, GripVertical, ListTree, Search, X } from "lucide-react";
import type { MarkdownEditorHandle, OutlineItem, OutlinePlacement } from "../../../../packages/editor-react";
import { Tool } from "../ui";
import { usePointerDrag } from "./pointer-drag";

const titleOf = (item: OutlineItem) => item.title || "空标题";

function positionOutlineGhost(element: HTMLDivElement, x: number, y: number) {
  const { offsetWidth: width, offsetHeight: height, ownerDocument } = element;
  const edge = 8;
  const gap = 10;
  const left = x - width - gap;
  const top = y - height / 2;
  const { clientWidth, clientHeight } = ownerDocument.documentElement;
  const ghostX = Math.max(edge, Math.min(left >= edge ? left : x + gap, clientWidth - width - edge));
  const ghostY = Math.max(edge, Math.min(top, clientHeight - height - edge));
  element.style.translate = `${ghostX}px ${ghostY}px`;
}

function revealCurrentHeading(viewport: HTMLElement) {
  const row = viewport.querySelector('[aria-current="location"]');
  if (!row) return;
  const bounds = viewport.getBoundingClientRect();
  const { top, bottom } = row.getBoundingClientRect();
  const visibleTop = bounds.top + viewport.clientTop + 4;
  const visibleBottom = bounds.bottom - 4;
  if (top < visibleTop) viewport.scrollTop -= Math.ceil(visibleTop - top);
  else if (bottom > visibleBottom) viewport.scrollTop += Math.ceil(bottom - visibleBottom);
}

export function Outline({ editor, readOnly, onClose }: {
  editor: MarkdownEditorHandle; readOnly: boolean; onClose(): void;
}) {
  const items = useSyncExternalStore(editor.subscribeOutline, editor.getOutline);
  const list = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const [active, setActive] = useState<string | null>(null);
  const query = input.trim().toLowerCase();

  const { headings, matches, parents } = useMemo(() => {
    const headings = new Map<string, OutlineItem>();
    const matches = new Set<string>();
    const parents = new Map<string, string>();
    function index(branches: readonly OutlineItem[], parent?: string) {
      let branchMatches = false;
      for (const item of branches) {
        headings.set(item.id, item);
        if (parent) parents.set(item.id, parent);
        const childMatches = index(item.children, item.id);
        if (query && (childMatches || titleOf(item).toLowerCase().includes(query))) {
          matches.add(item.id);
          branchMatches = true;
        }
      }
      return branchMatches;
    }
    index(items);
    return { headings, matches, parents };
  }, [items, query]);

  useLayoutEffect(() => editor.observeOutlinePosition(setActive), [editor]);

  let visibleActive = active;
  for (let parent = active ? parents.get(active) : undefined; parent; parent = parents.get(parent)) {
    if (!query && collapsed.has(parent)) visibleActive = parent;
  }
  useLayoutEffect(() => revealCurrentHeading(list.current!), [visibleActive, query]);

  const drag = usePointerDrag<OutlineItem, { id: string; placement: OutlinePlacement }>(
    element => {
      if (readOnly || !element.closest("[data-outline-grip]")) return null;
      const id = element.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId;
      return id ? headings.get(id) ?? null : null;
    },
    (event, item) => {
      if (readOnly) return null;
      const { currentTarget: viewport, clientX, clientY } = event;
      const bounds = viewport.getBoundingClientRect();
      const panel = viewport.parentElement!.getBoundingClientRect();
      if (clientY < bounds.top || clientY >= bounds.bottom || clientX < panel.left - 12 || clientX > panel.right + 12) return null;
      // Hit-test inside the row so rounded corners and the scrollbar don't block edge drops.
      const hitX = bounds.left + viewport.clientWidth / 2;
      const rowAt = (y: number) => {
        const row = document.elementFromPoint(hitX, y)?.closest<HTMLElement>("[data-outline-id]");
        return row && viewport.contains(row) ? row : null;
      };
      const destination = (row: HTMLElement | null) => {
        if (!row) return null;
        const target = headings.get(row.dataset.outlineId!);
        const { top, height } = row.getBoundingClientRect();
        const placement: OutlinePlacement = clientY < top + height / 2 ? "before" : "after";
        return target && editor.canMoveOutlineSection(item, target, placement) ? { id: target.id, placement } : null;
      };
      const row = rowAt(clientY);
      return row ? destination(row) : destination(rowAt(clientY - 4)) ?? destination(rowAt(clientY + 4));
    },
    (item, { id, placement }) => editor.moveOutlineSection(item, headings.get(id)!, placement),
    positionOutlineGhost,
  );

  function toggle(id: string) {
    setCollapsed(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function renderBranches(items: readonly OutlineItem[], depth: number) {
    return <ul role="list">{items.map((item, index) => {
      if (query && !matches.has(item.id)) return null;
      const title = titleOf(item);
      const canExpand = item.children.length > 0 && !query;
      const expanded = Boolean(query) || !collapsed.has(item.id);
      return <li key={item.id} style={{ "--outline-depth": Math.min(depth, 5) } as CSSProperties}
        data-placement={drag.hint?.id === item.id ? drag.hint.placement : undefined}>
        <div className="outline-row" data-outline-id={item.id} data-dragging={drag.ghost?.id === item.id || undefined}>
          {canExpand ? <button type="button" className="plain-button outline-expand" aria-expanded={expanded}
            aria-label={`${expanded ? "折叠" : "展开"} ${title}`} onClick={() => toggle(item.id)}><ChevronRight size={14} strokeWidth={1.6} /></button>
            : <span className="outline-expand" />}
          <button type="button" className="plain-button outline-heading" title={title}
            aria-current={visibleActive === item.id ? "location" : undefined} onClick={() => editor.scrollToHeading(item)}
            aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
            onKeyDown={event => {
              if (readOnly || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              const direction = event.key === "ArrowUp" ? -1 : 1;
              const placement = direction < 0 ? "before" : "after";
              for (let offset = index + direction; items[offset]; offset += direction) {
                const target = items[offset];
                if ((!query || matches.has(target.id)) && editor.moveOutlineSection(item, target, placement)) {
                  event.preventDefault();
                  break;
                }
              }
            }}>{title}</button>
          {!readOnly && <span className="outline-grip" data-outline-grip aria-hidden="true"><GripVertical size={14} /></span>}
        </div>
        {item.children.some(child => !query || matches.has(child.id)) &&
          <div className="outline-children" inert={!expanded} onTransitionEnd={event => {
            if (expanded && event.target === event.currentTarget && event.propertyName === "grid-template-rows" &&
              event.currentTarget.querySelector('[aria-current="location"]')) revealCurrentHeading(list.current!);
          }}>{renderBranches(item.children, depth + 1)}</div>}
      </li>;
    })}</ul>;
  }

  return <nav className="document-outline" aria-label="文档大纲">
    <div className="outline-toolbar">
      <h2>文档大纲</h2>
      <Tool className="chrome-icon" label="隐藏文档大纲" onClick={onClose}><X size={16} strokeWidth={1.6} /></Tool>
    </div>
    <TextField.Root className="outline-search" size="2" color="gray" variant="soft" placeholder="搜索标题" aria-label="搜索标题"
      value={input} onChange={event => setInput(event.target.value)}
      onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing && event.keyCode !== 229) setInput(""); }}>
      <TextField.Slot><Search size={15} strokeWidth={1.6} /></TextField.Slot>
    </TextField.Root>
    <div className="outline-list" ref={list} {...drag.events}>
      {!items.length || (query && !matches.size) ? <p className="outline-empty">
        {items.length ? "没有匹配的标题" : "暂无标题"}
      </p> : renderBranches(items, 0)}
    </div>
    {drag.ghost && <div className="tree-drag-ghost outline-drag-ghost" ref={drag.ghostElement} aria-hidden="true"
      data-snapped={Boolean(drag.hint) || undefined}><ListTree size={15} /><span>{titleOf(drag.ghost)}</span></div>}
  </nav>;
}
