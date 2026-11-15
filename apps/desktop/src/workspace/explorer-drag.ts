import type { PointerEvent } from "react";
import type { Category, CategoryPlacement } from "../../../../packages/shared-types";
import { usePointerDrag } from "./pointer-drag";

type Source = { kind: "folder" | "entry"; id: string; title: string; parent: string | null };
type Destination = { id: string; placement: CategoryPlacement } | { id: string | null; placement: "inside" };

function rowFolder(element: Element) {
  return element.closest<HTMLElement>("[data-tree-container]")?.dataset.treeContainer || null;
}

export function useExplorerDrag(categories: Category[],
  onSortFolder: (id: string, anchor: string, placement: CategoryPlacement) => void,
  onSortEntry: (id: string, anchor: string, placement: CategoryPlacement) => void,
  onMove: (id: string, folder: string | null) => void,
) {
  function itemAt(element: Element): Source | null {
    const row = element.closest<HTMLElement>("[data-tree-draggable]");
    if (!row) return null;
    const id = row.dataset.treeId!;
    const kind = row.dataset.treeKind === "folder" ? "folder" : "entry";
    const parent = kind === "folder" ? categories.find(folder => folder.id === id)!.parentId : rowFolder(row);
    return { kind, id, parent, title: row.dataset.treeTitle! };
  }

  function targetAt(event: PointerEvent<HTMLElement>, item: Source): Destination | null {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || !event.currentTarget.contains(element) || element.closest(".folder-inline, .entry-inline")) return null;
    const header = element.closest<HTMLElement>("[data-tree-kind=folder]");
    const row = item.kind === "folder" ? header : element.closest<HTMLElement>("[data-tree-kind=entry]");
    if (item.kind === "entry") {
      const folder = header?.dataset.treeId ?? rowFolder(element);
      if (folder !== item.parent) return { id: folder, placement: "inside" };
    }
    if (!row) return null;
    const id = row.dataset.treeId!;
    if (id === item.id || (item.kind === "folder" && categories.find(folder => folder.id === id)!.parentId !== item.parent)) return null;
    const rect = row.getBoundingClientRect();
    return { id, placement: event.clientY < rect.top + rect.height / 2 ? "before" : "after" };
  }

  return usePointerDrag(itemAt, targetAt, (item, target) => {
    if (target.placement === "inside") onMove(item.id, target.id);
    else (item.kind === "folder" ? onSortFolder : onSortEntry)(item.id, target.id, target.placement);
  });
}
