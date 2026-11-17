import { ContextMenu } from "@radix-ui/themes";
import { Workflow } from "lucide-react";
import type { Collection } from "../../../../packages/shared-types";

export function AddToCollectionMenu({ collections, disabled, onAdd }: {
  collections: Collection[];
  disabled?: boolean;
  onAdd(collection: Collection): void;
}) {
  return <ContextMenu.Sub>
    <ContextMenu.SubTrigger disabled={disabled}><Workflow size={15} />加入专题</ContextMenu.SubTrigger>
    <ContextMenu.SubContent aria-label="加入专题" sideOffset={4}>
      {collections.length ? collections.map(collection => <ContextMenu.Item key={collection.id} onSelect={() => onAdd(collection)}>
        <Workflow size={15} />{collection.title}
      </ContextMenu.Item>) : <ContextMenu.Item disabled><Workflow size={15} />暂无专题</ContextMenu.Item>}
    </ContextMenu.SubContent>
  </ContextMenu.Sub>;
}
