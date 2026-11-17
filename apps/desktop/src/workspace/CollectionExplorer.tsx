import { useRef, useState } from "react";
import { ContextMenu } from "@radix-ui/themes";
import { ChevronsDownUp, ChevronsUpDown, PencilLine, Plus, Trash2, Workflow } from "lucide-react";
import type { Collection } from "../../../../packages/shared-types";
import { Tool } from "../ui";
import { ListError, TreeSection } from "./Explorer";
import { InlineEntryTitle } from "./InlineEntryTitle";

export function CollectionExplorer({ items, activeId, error, locked, collapsed, draft, onToggle, onSelect, onCreate, onRename,
  onDelete, onSave, onCloseEditor, onError, onRetry }: {
  items: Collection[] | null;
  activeId?: string;
  error: string;
  locked: boolean;
  collapsed: boolean;
  draft?: { id?: string };
  onToggle(): void;
  onSelect(id: string): void;
  onCreate(): void;
  onRename(id: string): void;
  onDelete(item: Collection): void;
  onSave(item: Collection | undefined, title: string): Promise<void>;
  onCloseEditor(): void;
  onError(error: unknown): void;
  onRetry(): void;
}) {
  const [menuTarget, setMenuTarget] = useState<string>();
  const editAfterMenu = useRef<(() => void) | null>(null);
  const canCreate = !locked && items !== null && !error;
  const listId = "collection-list";
  const createId = "add-collection";

  function finishMenu(event: Event) {
    const edit = editAfterMenu.current;
    if (!edit) return;
    editAfterMenu.current = null;
    event.preventDefault();
    edit();
  }

  function editor(item?: Collection) {
    let initialTitle = item?.title ?? "未命名";
    if (!item) {
      const names = new Set(items?.map(collection => collection.title));
      for (let suffix = 2; names.has(initialTitle); suffix++) initialTitle = `未命名 ${suffix}`;
    }
    return <div className="entry-inline tree-entry" onContextMenu={event => event.stopPropagation()}>
      <Workflow size={15} aria-hidden="true" />
      <InlineEntryTitle title={item?.title ?? ""} initialTitle={initialTitle} label="专题名称" placeholder="专题名称" required
        onSave={title => onSave(item, title)} onError={onError} onClose={restoreFocus => {
          onCloseEditor();
          if (restoreFocus) requestAnimationFrame(() => {
            if (document.activeElement === document.body) document.getElementById(item ? `collection-row-${item.id}` : createId)?.focus();
          });
        }} />
    </div>;
  }

  return <ContextMenu.Root>
    <ContextMenu.Trigger disabled={!canCreate}>
      <aside className="explorer" aria-label="专题">
        <div className="directory-tools" role="group" aria-label="专题快捷操作">
          <Tool id={createId} className="chrome-icon" label="新建专题" disabled={!canCreate} onClick={onCreate}><Plus size={16} /></Tool>
          <Tool className="chrome-icon" label={collapsed ? "展开专题列表" : "折叠专题列表"}
            aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
            {collapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}
          </Tool>
        </div>
        <div className="explorer-scroll explorer-list-scroll">
          <ul className="explorer-content folder-tree" aria-label="专题目录">
            <TreeSection id={listId} title="专题" collapsed={collapsed} onToggle={onToggle}>
              {error ? <ListError message={error} onRetry={onRetry} />
                : !items ? <li className="explorer-empty" role="status">正在读取专题…</li>
                  : <>
                    {items.map(item => <li key={item.id} className="tree-item">
                      {draft?.id === item.id ? editor(item) : <ContextMenu.Root onOpenChange={open => {
                        setMenuTarget(current => open ? item.id : current === item.id ? undefined : current);
                      }}>
                        <ContextMenu.Trigger>
                          <button type="button" id={`collection-row-${item.id}`} className="plain-button entry-row tree-entry"
                            aria-current={item.id === activeId ? "true" : undefined} data-menu-target={menuTarget === item.id || undefined}
                            onClick={() => onSelect(item.id)}>
                            <Workflow size={15} aria-hidden="true" /><span className="entry-title">{item.title}</span>
                          </button>
                        </ContextMenu.Trigger>
                        <ContextMenu.Content size="1" aria-label="专题操作" onCloseAutoFocus={finishMenu}>
                          <ContextMenu.Item disabled={locked} onSelect={() => { editAfterMenu.current = () => onRename(item.id); }}>
                            <PencilLine size={14} />重命名
                          </ContextMenu.Item>
                          <ContextMenu.Item color="red" disabled={locked} onSelect={() => onDelete(item)}>
                            <Trash2 size={14} />删除专题
                          </ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Root>}
                    </li>)}
                    {draft && !draft.id && <li>{editor()}</li>}
                    {!items.length && !draft && <li className="explorer-empty">暂无专题</li>}
                  </>}
            </TreeSection>
          </ul>
        </div>
      </aside>
    </ContextMenu.Trigger>
    <ContextMenu.Content size="1" aria-label="专题目录操作" onCloseAutoFocus={finishMenu}>
      <ContextMenu.Item disabled={!canCreate} onSelect={() => { editAfterMenu.current = onCreate; }}>
        <Plus size={15} />新建专题
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>;
}
