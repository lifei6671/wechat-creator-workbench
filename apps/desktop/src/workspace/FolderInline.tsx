import { useRef, useState, type MouseEvent } from "react";
import { Popover, Spinner } from "@radix-ui/themes";
import { Check } from "lucide-react";
import type { CanvasCardColor, Category, CategoryIcon } from "../../../../packages/shared-types";
import { errorMessage } from "../desktop";
import { Tooltip } from "../ui";
import { folderIcons } from "./folder-icons";
import { ColorChoices, colorValue } from "./ColorChoices";

function focusIconButton(event: MouseEvent<HTMLButtonElement | HTMLInputElement>) {
  if (event.button !== 0) return;
  // WKWebView blurs the editor without focusing a clicked button.
  event.preventDefault();
  event.currentTarget.focus();
}

export function FolderInline({ target, defaultName, onSave, onError, onClose }: {
  target?: Category;
  defaultName: string;
  onSave(name: string, icon: CategoryIcon, color: CanvasCardColor | null): Promise<void>;
  onError(error: unknown): void;
  onClose(restoreFocus: boolean): void;
}) {
  const [icon, setIcon] = useState<CategoryIcon>(target?.icon ?? "folder");
  const [color, setColor] = useState<CanvasCardColor | null>(target?.iconColor ?? null);
  const [name, setName] = useState(target?.name ?? defaultName);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const committing = useRef(false);
  const row = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const nativeColor = useRef(false);
  const [Icon] = folderIcons[icon];

  function save(restoreFocus: boolean) {
    if (committing.current) return;
    const title = name.trim();
    if (!title || (title === target?.name && icon === target.icon && color === (target.iconColor ?? null))) {
      onClose(restoreFocus);
      return;
    }
    committing.current = true;
    setSaving(true);
    setError("");
    void onSave(title, icon, color).then(() => onClose(restoreFocus), error => {
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
        // The native color dialog can temporarily take focus outside the webview.
        if (!next && nativeColor.current) return;
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
      <Popover.Root onOpenChange={open => { if (!open) nativeColor.current = false; }}>
        <Popover.Trigger><button type="button" className="plain-button folder-inline-icon" aria-label="选择目录图标"
          disabled={saving} onMouseDown={focusIconButton}>
          <span className="folder-icon-badge" style={{ backgroundColor: colorValue(color) }}>
            {saving ? <Spinner size="1" /> : <Icon size={14} />}</span></button></Popover.Trigger>
        <Popover.Content ref={picker} aria-label="目录图标" className="folder-icon-picker" size="1" align="start" sideOffset={6}
          onInteractOutside={event => { if (!row.current?.contains(event.target as Node)) save(false); }}>
          <div className="folder-icon-choices">
            {Object.entries(folderIcons).map(([value, [Option, label]]) => <Tooltip key={value} content={label}>
              <button type="button" className="plain-button folder-icon-choice" aria-label={label} aria-pressed={value === icon}
                disabled={saving} onMouseDown={focusIconButton} onClick={() => setIcon(value as CategoryIcon)}>
                <span className="folder-icon-badge" style={{ backgroundColor: colorValue(color) }}><Option size={14} /></span>
                {value === icon && <Check className="folder-icon-check" size={10} />}
              </button>
            </Tooltip>)}
          </div>
          <div className="folder-icon-colors"><ColorChoices value={color} onChange={setColor} disabled={saving}
            onCustomColorOpen={() => { nativeColor.current = true; }} onMouseDown={event => {
            nativeColor.current = event.currentTarget instanceof HTMLInputElement;
            focusIconButton(event);
          }} /></div>
        </Popover.Content>
      </Popover.Root>
      <input className="folder-inline-name" aria-label="目录名称" placeholder="目录名称" autoFocus value={name} disabled={saving}
        onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} />
    </form>
    <p role="alert" className="inline-error folder-inline-error">{error}</p>
  </>;
}
