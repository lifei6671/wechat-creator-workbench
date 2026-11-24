import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, Dialog, TextField } from "@radix-ui/themes";
import { FileText, Plus, Search } from "lucide-react";
import type { EntryPage } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { untitled } from "../labels";
import { useButtonFeedback } from "../button-feedback";

export function EdgeLabelDialog({ label, onSave, onClose }: {
  label: string;
  onSave(label: string): Promise<void>;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(label);
  return <CollectionForm title="编辑连线说明" submitLabel="保存" onClose={onClose} onSubmit={() => onSave(draft)}>
    <label>连线说明<TextField.Root value={draft} maxLength={120} onChange={event => setDraft(event.target.value)} autoFocus /></label>
  </CollectionForm>;
}

function CollectionForm({ title, submitLabel, ready = true, onClose, onSubmit, children }: {
  title: string;
  submitLabel: string;
  ready?: boolean;
  onClose(): void;
  onSubmit(): Promise<void>;
  children: ReactNode;
}) {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const buttons = useButtonFeedback();
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready || !buttons.start("submit")) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit();
      onClose();
    } catch (failure) {
      buttons.finish("submit", false);
      setError(errorMessage(failure));
      setBusy(false);
    }
  }
  return <Dialog.Root open={dialogOpen} onOpenChange={open => { if (!open && !busy) setDialogOpen(false); }}>
    <Dialog.Content maxWidth="440px" aria-describedby={undefined} inert={!dialogOpen} onCloseAutoFocus={event => {
      if (!dialogOpen) onClose();
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) event.preventDefault();
    }}>
      <Dialog.Title>{title}</Dialog.Title>
      <form className="dialog-form" onSubmit={submit}>
        {children}
        {<div className="action-error-slot" tabIndex={(error) ? 0 : -1}>{error ? <p role="alert" className="inline-error">{error}</p> : null}</div>}
        <div className="dialog-actions">
          <Dialog.Close><Button type="button" color="gray" variant="soft" disabled={busy}>取消</Button></Dialog.Close>
          <Button type="submit" loading={busy} {...buttons.props("submit", !ready)}>{buttons.label("submit", submitLabel, "已保存")}</Button>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Root>;
}

export function CollectionPicker({ onChoose, onClose }: { onChoose(id: string): Promise<void>; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<EntryPage | null>(null);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const buttons = useButtonFeedback();
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void desktop.entries({
        deleted: false, offset, limit: 30, query: query.trim() || undefined,
      }).then(result => {
        if (live) setPage(previous => offset && previous ? { ...result, items: [...previous.items, ...result.items] } : result);
      }, failure => { if (live) setError(errorMessage(failure)); });
    }, query ? 160 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [offset, query]);
  async function choose(id: string) {
    if (busy || !buttons.start("choose")) return;
    setBusy(true);
    setError("");
    try { await onChoose(id); onClose(); }
    catch (failure) { buttons.finish("choose", false); setError(errorMessage(failure)); setBusy(false); }
  }
  return <Dialog.Root open={dialogOpen} onOpenChange={open => { if (!open && !busy) setDialogOpen(false); }}>
    <Dialog.Content maxWidth="480px" aria-describedby={undefined} inert={!dialogOpen} onCloseAutoFocus={() => { if (!dialogOpen) onClose(); }}>
      <Dialog.Title>添加文章</Dialog.Title>
      <TextField.Root aria-label="搜索内容" placeholder="搜索内容" autoFocus value={query} onChange={event => {
        setQuery(event.target.value);
        setOffset(0);
        setPage(null);
        setError("");
      }}><TextField.Slot><Search size={15} /></TextField.Slot></TextField.Root>
      {<div className="action-error-slot" tabIndex={(error) ? 0 : -1}>{error ? <p className="inline-error" role="alert">{error}</p> : null}</div>}
      <ul className="collection-picker-list">
        {page?.items.map(item => <li key={item.id}>
          <button className="plain-button collection-list-row" type="button" {...buttons.props("choose", busy)} onClick={() => void choose(item.id)}>
            <FileText size={16} /><span>{item.title || untitled}</span><Plus size={14} />
          </button>
        </li>)}
        {page?.nextOffset != null && <li><Button size="1" variant="soft" onClick={() => setOffset(page.nextOffset!)}>加载更多</Button></li>}
        {!page && !error && <li role="status">正在搜索…</li>}
        {page?.items.length === 0 && <li className="muted-text">没有匹配的内容</li>}
      </ul>
      <div className="dialog-actions"><Dialog.Close><Button type="button" variant="soft" color="gray" disabled={busy}>取消</Button></Dialog.Close></div>
    </Dialog.Content>
  </Dialog.Root>;
}
