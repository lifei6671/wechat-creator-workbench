import { ContextMenu } from "@radix-ui/themes";
import { Check, Workflow } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import type { Collection } from "../../../../packages/shared-types";
import { desktop } from "../desktop";

interface CollectionMenuProps {
  entryId: string;
  collections: Collection[];
  disabled?: boolean;
  onAdd(collection: Collection): void;
  onError(error: unknown): void;
}

export function AddToCollectionMenu({ entryId, collections, disabled, onAdd, onError }: CollectionMenuProps) {
  return <ContextMenu.Sub>
    <ContextMenu.SubTrigger disabled={disabled}><Workflow size={15} />加入专题</ContextMenu.SubTrigger>
    <ContextMenu.SubContent className="add-to-collection-submenu" aria-label="加入专题" sideOffset={4}>
      {collections.length ? <CollectionMenuItems key={entryId} entryId={entryId} collections={collections} onAdd={onAdd} onError={onError} />
        : <ContextMenu.Item disabled><Workflow size={15} />暂无专题</ContextMenu.Item>}
    </ContextMenu.SubContent>
  </ContextMenu.Sub>;
}

function CollectionMenuItems({ entryId, collections, onAdd, onError }: Omit<CollectionMenuProps, "disabled">) {
  const [joinedIds, setJoinedIds] = useState<Set<string>>();
  const report = useEffectEvent(onError);

  useEffect(() => {
    let live = true;
    void desktop.entryCollections(entryId).then(result => {
      if (live) setJoinedIds(new Set(result.map(collection => collection.id)));
    }, error => { if (live) report(error); });
    return () => { live = false; };
  }, [entryId]);

  return collections.map(collection => {
    const joined = joinedIds?.has(collection.id);
    return <ContextMenu.Item key={collection.id} aria-label={joined ? `${collection.title}（已加入）` : undefined}
      onSelect={() => onAdd(collection)}>
      <Workflow size={15} /><span>{collection.title}</span>
      {joined && <Check size={15} className="collection-entry-current" aria-hidden="true" />}
    </ContextMenu.Item>;
  });
}
