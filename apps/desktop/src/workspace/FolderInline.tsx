import { useRef, useState } from "react";
import { Popover, Tooltip } from "@radix-ui/themes";
import { Check } from "lucide-react";
import type { Category, CategoryIcon } from "../../../../packages/shared-types";
import { errorMessage } from "../desktop";
import { folderIcons } from "./folder-icons";

export function FolderInline({ target, defaultName, onSave, onError, onClose }: {
  target?: Category;
  defaultName: string;
  onSave(name: string, icon: CategoryIcon): Promise<void>;
  onError(error: unknown): void;
  onClose(restoreFocus: boolean): void;
}) {
  const [icon, setIcon] = useState<CategoryIcon>(target?.icon ?? "folder");
  const [name, setName] = useState(target?.name ?? defaultName);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const committing = useRef(false);
  const row = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const [Icon] = folderIcons[icon];

  function save(restoreFocus: boolean) {
    if (committing.current) return;
    const title = name.trim();
    if (!title || (title === target?.name && icon === target.icon)) {
      onClose(restoreFocus);
      return;
    }
    committing.current = true;
    setSaving(true);
    setError("");
    void onSave(title, icon).then(() => onClose(restoreFocus), error => {
      if (row.current) {
        committing.current = false;
        setError(errorMessage(error));
        setSaving(false);
      } else onError(error);
    });
  }

  return <>
    <form ref={row} className="folder-inline" onSubmit={event => { event.preventDefault(); save(true); }}
      onBlur={event => {
        const next = event.relatedTarget;
        if (!row.current?.contains(next) && !picker.current?.contains(next)) save(false);
      }} onKeyDown={event => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
          || picker.current?.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }} onContextMenu={event => {
      event.preventDefault();
      event.stopPropagation();
    }}>
      <Popover.Root>
        <Popover.Trigger><button type="button" className="plain-button folder-inline-icon" aria-label="选择目录图标" disabled={saving}><Icon size={16} /></button></Popover.Trigger>
        <Popover.Content ref={picker} aria-label="目录图标" className="folder-icon-picker" size="1" align="start" sideOffset={6}
          onInteractOutside={event => { if (!row.current?.contains(event.target as Node)) save(false); }}>
          <div className="folder-icon-choices">
            {Object.entries(folderIcons).map(([value, [Option, label]]) => <Tooltip key={value} content={label}>
              <button type="button" className="plain-button folder-icon-choice" aria-label={label} aria-pressed={value === icon}
                onClick={() => setIcon(value as CategoryIcon)}><Option size={16} strokeWidth={1.65} />
                {value === icon && <Check className="folder-icon-check" size={10} />}
              </button>
            </Tooltip>)}
          </div>
        </Popover.Content>
      </Popover.Root>
      <input className="folder-inline-name" aria-label="目录名称" placeholder="目录名称" autoFocus value={name} disabled={saving}
        onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} />
    </form>
    {error && <p role="alert" className="inline-error folder-inline-error">{error}</p>}
  </>;
}
