import { ContextMenu } from "@radix-ui/themes";
import { Check, Folder, FolderInput, FolderRoot } from "lucide-react";
import type { Category } from "../../../../packages/shared-types";

export function MoveEntryMenu({ categories, current, disabled, onMove }: {
  categories: Category[];
  current: string | null;
  disabled?: boolean;
  onMove(category: string | null): void;
}) {
  function item(id: string | null, name: string, nested = false) {
    const Icon = id === null ? FolderRoot : Folder;
    return <ContextMenu.Item key={id ?? "root"} className={nested ? "move-entry-child" : undefined}
      aria-label={id === current ? `${name}（当前位置）` : undefined}
      onSelect={() => { if (id !== current) onMove(id); }}>
      <Icon size={15} /><span>{name}</span>{id === current && <Check size={15} className="move-entry-current" />}
    </ContextMenu.Item>;
  }
  return <ContextMenu.Sub>
    <ContextMenu.SubTrigger disabled={disabled}><FolderInput size={15} />移动到文件夹</ContextMenu.SubTrigger>
    <ContextMenu.SubContent className="move-entry-submenu" aria-label="移动到文件夹" sideOffset={4}>
      {item(null, "根目录")}
      {categories.filter(category => category.parentId === null).map(root => [
        item(root.id, root.name),
        ...categories.filter(child => child.parentId === root.id).map(child => item(child.id, `${root.name} / ${child.name}`, true)),
      ])}
    </ContextMenu.SubContent>
  </ContextMenu.Sub>;
}
