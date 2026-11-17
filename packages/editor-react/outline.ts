import { closeHistory } from "@milkdown/kit/prose/history";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { foldedSections } from "./presentation";

export interface OutlineItem {
  readonly id: string;
  readonly level: number;
  readonly title: string;
  readonly from: number;
  readonly to: number;
  readonly children: readonly OutlineItem[];
}

export type OutlinePlacement = "before" | "after";
type Branch = Omit<OutlineItem, "to" | "children"> & { to: number; children: Branch[] };
type Heading = { item: OutlineItem; parent: OutlineItem | undefined; containerStart: number };

export function lastBodyBlock(doc: ProseNode) {
  let end = doc.content.size;
  for (let index = doc.childCount - 1; index >= 0; index--) {
    const node = doc.child(index);
    if (node.type.name !== "footnote_definition") return { node, end };
    end -= node.nodeSize;
  }
  return { node: null, end };
}

function readOutline(doc: ProseNode, identify: (node: ProseNode, from: number) => string) {
  const items: Branch[] = [];
  const headings = new Map<string, Heading>();
  const { node: tail, end } = lastBodyBlock(doc);
  const bodyEnd = tail?.type.name === "paragraph" && !tail.content.size ? end - tail.nodeSize : end;

  function readChildren(container: ProseNode, start: number, limit: number, enclosing?: Branch) {
    const open: Branch[] = [];
    container.forEach((node, offset) => {
      const from = start + offset;
      if (from >= limit) return;
      if (node.type.name === "heading") {
        const level: number = node.attrs.level;
        while (open.length && open.at(-1)!.level >= level) open.pop()!.to = from;
        const parent = open.at(-1) ?? enclosing;
        const item: Branch = {
          id: identify(node, from), level, from, to: limit, children: [],
          title: node.textBetween(0, node.content.size, " ", leaf => leaf.attrs.alt ?? leaf.attrs.value ?? " ").trim(),
        };
        (parent?.children ?? items).push(item);
        headings.set(item.id, { item, parent, containerStart: start });
        open.push(item);
      } else if (!node.isTextblock && !node.isLeaf && node.type.name !== "table" && node.type.name !== "footnote_definition") {
        readChildren(node, from + 1, from + node.nodeSize - 1, open.at(-1) ?? enclosing);
      }
    });
  }

  readChildren(doc, 0, bodyEnd);
  return { doc, items: items as readonly OutlineItem[], headings };
}

export function editorOutline(view: EditorView, scroll: HTMLElement, subscribe: (listener: () => void) => () => void,
  isActive: () => boolean) {
  let snapshot: ReturnType<typeof readOutline> | undefined;
  let tracked: { doc: ProseNode; positions: Map<number, string> } | undefined;
  let sequence = 0;
  const ids = new WeakMap<ProseNode, string>();

  function current() {
    const { doc } = view.state;
    if (snapshot?.doc !== doc) {
      const mapped = tracked?.doc === doc ? tracked.positions : undefined;
      const reserved = new Set(mapped?.values());
      const positions = new Map<number, string>();
      snapshot = readOutline(doc, (node, from) => {
        const previous = ids.get(node);
        const id = mapped?.get(from) ?? (previous && !reserved.has(previous) ? previous : String(++sequence));
        ids.set(node, id);
        reserved.add(id);
        positions.set(from, id);
        return id;
      });
      tracked = { doc, positions };
    }
    return snapshot;
  }

  function destination(source: OutlineItem, target: OutlineItem, placement: OutlinePlacement) {
    if (!isActive() || !view.editable || source === target || source.level !== target.level) return;
    const { headings } = current();
    const origin = headings.get(source.id), anchor = headings.get(target.id);
    if (origin?.item !== source || anchor?.item !== target ||
      origin.parent !== anchor.parent || origin.containerStart !== anchor.containerStart) return;
    const at = placement === "before" ? target.from : target.to;
    if (at < source.from || at > source.to) return at;
  }

  function viewportTop() {
    const top = scroll.getBoundingClientRect().top;
    const search = scroll.parentElement!.querySelector(":scope > .rich-search");
    return Math.max(top, search?.getBoundingClientRect().bottom ?? top) + 8;
  }

  const actions = {
    getOutline: () => current().items,
    subscribeOutline: subscribe,
    scrollToHeading(item: OutlineItem) {
      if (!isActive() || current().headings.get(item.id)?.item !== item) return false;
      const { state } = view;
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, item.from + 1)));
      if (view.editable) view.focus();
      const heading = view.nodeDOM(item.from) as HTMLElement;
      scroll.scrollTop += heading.getBoundingClientRect().top - viewportTop();
      return true;
    },
    canMoveOutlineSection: (source: OutlineItem, target: OutlineItem, placement: OutlinePlacement) =>
      destination(source, target, placement) !== undefined,
    moveOutlineSection(source: OutlineItem, target: OutlineItem, placement: OutlinePlacement) {
      const at = destination(source, target, placement);
      if (at === undefined) return false;
      const { state } = view;
      const section = state.doc.slice(source.from, source.to).content;
      const tr = closeHistory(state.tr).delete(source.from, source.to);
      const insert = tr.mapping.map(at);
      tr.insert(insert, section);
      tr.setSelection(TextSelection.create(tr.doc, insert + 1));
      view.dispatch(tr);
      view.dispatch(closeHistory(view.state.tr));
      view.focus();
      return true;
    },
    observeOutlinePosition(listener: (id: string | null) => void) {
      let frame = 0;
      let doc: ProseNode | undefined;
      let folds: ReturnType<typeof foldedSections>;
      let visible: { id: string; element: HTMLElement }[] = [];
      let active: string | null = null;
      function measure() {
        frame = 0;
        const nextFolds = foldedSections(view.state);
        if (view.state.doc !== doc || nextFolds !== folds) {
          doc = view.state.doc;
          folds = nextFolds;
          visible = [];
          for (const { item } of current().headings.values()) {
            const element = view.nodeDOM(item.from);
            if (element instanceof HTMLElement && !element.closest("[hidden]")) visible.push({ id: item.id, element });
          }
        }
        const threshold = viewportTop() + 20;
        let low = 0, high = visible.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (visible[middle].element.getBoundingClientRect().top <= threshold) low = middle + 1;
          else high = middle;
        }
        const atBottom = scroll.scrollTop > 0 && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 1;
        const next = (atBottom ? visible.at(-1) : visible[low - 1])?.id ?? null;
        if (active !== next) listener(active = next);
      }
      const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
      const unsubscribe = subscribe(schedule);
      scroll.addEventListener("scroll", schedule, { passive: true });
      const observer = new ResizeObserver(schedule);
      observer.observe(scroll);
      observer.observe(view.dom);
      schedule();
      return () => {
        unsubscribe();
        scroll.removeEventListener("scroll", schedule);
        observer.disconnect();
        cancelAnimationFrame(frame);
      };
    },
  };

  return { actions, mapTransaction(tr: Transaction) {
    if (tracked?.doc !== tr.before) return;
    const positions = new Map<number, string>();
    for (const [from, id] of tracked.positions) {
      // Track just inside the heading so setNodeMarkup can replace its outer tokens.
      const mapped = tr.mapping.mapResult(from + 1, -1);
      if (!mapped.deletedAcross) positions.set(mapped.pos - 1, id);
    }
    tracked = { doc: tr.doc, positions };
  } };
}
