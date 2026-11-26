import { useEffect, useState } from "react";
import { Button, Dialog, IconButton } from "@radix-ui/themes";
import { X } from "lucide-react";
import type { Entry, EntryFields, RecoverySummary } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { ActionError, useButtonFeedback } from "../button-feedback";

export function EditorRecovery({ drafts: initial, onClose, onRecovered }: {
  drafts: RecoverySummary[]; onClose(): void; onRecovered(entry: Entry): void;
}) {
  const [drafts, setDrafts] = useState(initial);
  const [index, setIndex] = useState(0);
  const [comparison, setComparison] = useState<{ fields: EntryFields; current: Entry | null }>();
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const feedback = useButtonFeedback();
  const draft = drafts[index];
  useEffect(() => {
    if (!draft) return;
    let current = true;
    setComparison(undefined); setLoadError("");
    void Promise.all([desktop.recoveryGet(draft.entryId, draft.sessionId), desktop.entry(draft.entryId).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND") return null;
      throw error;
    })]).then(([fields, entry]) => {
      if (current) setComparison({ fields, current: entry });
    }, error => { if (current) setLoadError(errorMessage(error)); });
    return () => { current = false; };
  }, [draft]);

  async function act(action: "discard" | "copy" | "restore") {
    if (busy || !draft || !comparison) return;
    setBusy(true);
    let recovered: Entry | undefined;
    const result = await feedback.run(action, async () => {
      if (action === "discard") {
        await desktop.recoveryDiscard(draft.entryId, draft.sessionId, draft.localRevision);
        return true;
      }
      recovered = await desktop.recoveryRestore(draft.entryId, draft.sessionId, draft.localRevision, action === "copy");
      return true;
    });
    if (result === false) { setBusy(false); return; }
    // Keep the button's result visible for the same interval as other workspace actions.
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (recovered) onRecovered(recovered);
    const remaining = drafts.filter(item => item !== draft);
    if (!remaining.length) onClose();
    else { setDrafts(remaining); setIndex(0); setBusy(false); }
  }

  const canRestore = comparison?.current?.version === draft?.baseVersion && comparison?.current?.deletedAt === null;
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Content className="editor-recovery-dialog" aria-describedby={undefined} onPointerDownOutside={event => event.preventDefault()}>
      <div className="dialog-heading"><Dialog.Title>恢复未保存内容</Dialog.Title>
        <IconButton size="1" variant="ghost" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16} /></IconButton></div>
      <select aria-label="恢复草稿" value={index} disabled={busy} onChange={event => setIndex(Number(event.target.value))}>
        {drafts.map((item, i) => <option key={item.sessionId} value={i}>{item.title || "未命名"}　{new Date(item.updatedAt).toLocaleString()}</option>)}
      </select>
      <div className="editor-recovery-comparison" aria-busy={!comparison && !loadError}>
        <section><h3>当前文档</h3><pre>{comparison?.current?.contentMd ?? ""}</pre></section>
        <section><h3>恢复内容</h3><pre>{comparison?.fields.contentMd ?? ""}</pre></section>
      </div>
      <ActionError error={loadError || feedback.error()} />
      <div className="editor-recovery-actions">
        <Button size="1" variant="soft" color="red" loading={feedback.status("discard") === "pending"} {...feedback.props("discard", busy || !comparison)} onClick={() => void act("discard")}>
          {feedback.label("discard", "放弃", "已放弃")}</Button>
        <span />
        <Button size="1" variant="soft" loading={feedback.status("copy") === "pending"} {...feedback.props("copy", busy || !comparison)} onClick={() => void act("copy")}>
          {feedback.label("copy", "另存草稿", "已另存")}</Button>
        <Button size="1" loading={feedback.status("restore") === "pending"} {...feedback.props("restore", busy || !comparison || !canRestore)} onClick={() => void act("restore")}>
          {feedback.label("restore", "恢复到原文档", "已恢复")}</Button>
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}
