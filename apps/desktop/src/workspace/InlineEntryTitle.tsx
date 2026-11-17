import { useRef, useState } from "react";

export function InlineEntryTitle({ title, initialTitle = title, label = "重命名文档", placeholder, required = false, onSave, onClose, onError }: {
  title: string;
  initialTitle?: string;
  label?: string;
  placeholder: string;
  required?: boolean;
  onSave(title: string): Promise<void>;
  onClose(restoreFocus: boolean): void;
  onError(error: unknown): void;
}) {
  const [draft, setDraft] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  function save(restoreFocus: boolean) {
    if (pending.current) return;
    const name = draft.trim();
    if (name === title || (required && !name)) { onClose(restoreFocus); return; }
    pending.current = true;
    setSaving(true);
    void onSave(name).then(() => onClose(restoreFocus), error => {
      pending.current = false;
      setSaving(false);
      onError(error);
    });
  }

  return <input className="entry-inline-name" aria-label={label} placeholder={placeholder} autoFocus
    value={draft} readOnly={saving} onChange={event => setDraft(event.target.value)}
    onFocus={event => event.currentTarget.select()} onBlur={() => save(false)} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || saving) return;
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") save(true);
        else onClose(true);
      }
    }} />;
}
