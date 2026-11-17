import { ContextMenu } from "@radix-ui/themes";
import { Check, Folder, FolderInput, FolderRoot } from "lucide-react";
import type { Category } from "../../../../packages/shared-types";
import { rootFolderLabel } from "../labels";

export function MoveEntryMenu({ categories, current, disabled, onMove }: {
  categories: Category[];
  current: string | null;
  disabled?: boolean;
  onMove(category: string | null): void;
}) {
  function item(id: string | null, name: string, parentName?: string) {
    const Icon = id === null ? FolderRoot : Folder;
    const selected = id === current;
    const label = parentName === undefined ? name : `${name}，上级目录 ${parentName}`;
    return <ContextMenu.Item key={id ?? "root"} className={parentName === undefined ? undefined : "move-entry-child"}
      aria-label={selected ? `${label}（当前位置）` : label}
      onSelect={() => { if (!selected) onMove(id); }}>
      <Icon size={15} /><span>{name}</span>{selected && <Check size={15} className="move-entry-current" />}
    </ContextMenu.Item>;
  }
  return <ContextMenu.Sub>
    <ContextMenu.SubTrigger disabled={disabled}><FolderInput size={15} />移动到文件夹</ContextMenu.SubTrigger>
    <ContextMenu.SubContent className="move-entry-submenu" aria-label="移动到文件夹" sideOffset={4}>
      {item(null, rootFolderLabel)}
      {categories.filter(category => category.parentId === null).map(root => [
        item(root.id, root.name),
        ...categories.filter(child => child.parentId === root.id).map(child => item(child.id, child.name, root.name)),
      ])}
    </ContextMenu.SubContent>
  </ContextMenu.Sub>;
}
