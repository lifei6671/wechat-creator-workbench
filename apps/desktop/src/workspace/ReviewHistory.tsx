import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@radix-ui/themes";
import { Trash2 } from "lucide-react";
import { desktop, errorMessage, type ReviewCacheEntry } from "../desktop";
import { ActionError, useButtonFeedback } from "../button-feedback";
import { messageTimeLabel } from "../labels";
import { Tool } from "../ui";

export function ReviewHistory({ articleId, revision, disabled, onBusyChange }: {
  articleId: string;
  revision: number;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
}) {
  const [records, setRecords] = useState<ReviewCacheEntry[]>([]);
  const [expanded, setExpanded] = useState("");
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const buttons = useButtonFeedback();
  const current = useRef(0);
  const mounted = useRef(false);
  const headingId = useId();
  const detailsId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; current.current++; };
  }, []);
  useEffect(() => {
    const id = ++current.current;
    setLoading(true); setError("");
    void desktop.reviewCacheList(articleId).then(value => {
      if (id === current.current) { setRecords(value); setDeleted(new Set()); }
    }, failure => {
      if (id === current.current) setError(errorMessage(failure));
    }).finally(() => { if (id === current.current) setLoading(false); });
    return () => { current.current++; };
  }, [articleId, revision]);

  const feedback = records.some(record => buttons.isLocked(`delete:${record.id}`)) || buttons.isLocked("clear");
  const blocked = disabled || busy || loading || feedback;
  const visible = records.filter(record => !deleted.has(record.id) || buttons.isLocked(`delete:${record.id}`));
  async function remove(id?: string) {
    if (blocked) return;
    const action = id ? `delete:${id}` : "clear";
    await buttons.run(action, async () => {
      const generation = ++current.current;
      setBusy(true); onBusyChange(true); setError("");
      try {
        if (id) await desktop.reviewCacheDelete(articleId, id);
        else await desktop.reviewClearCache(articleId);
        if (!mounted.current || generation !== current.current) return false;
        if (id) {
          setDeleted(previous => new Set(previous).add(id));
          setExpanded(previous => previous === id ? "" : previous);
        } else { setRecords([]); setExpanded(""); setDeleted(new Set()); }
      } finally {
        if (mounted.current) { setBusy(false); onBusyChange(false); }
      }
    });
  }
  return <section className="review-history" aria-labelledby={headingId}>
    <div className="review-history-heading"><h3 id={headingId}>审查记录</h3>
      <Button size="1" color="red" variant="ghost" loading={buttons.status("clear") === "pending"}
        {...buttons.props("clear", blocked || !visible.length)} onClick={() => void remove()}>
        {buttons.label("clear", "清空", "已清空")}</Button>
    </div>
    {loading && <p className="muted-text" role="status">正在读取记录…</p>}
    {!loading && !visible.length && !error && <p className="muted-text">暂无审查记录</p>}
    <ul className="ai-thread-list" aria-label="审查记录">{visible.map(record => {
      const name = record.title || "朱雀文本检测";
      const action = `delete:${record.id}`;
      const open = expanded === record.id;
      const date = new Date(record.checkedAt);
      const details = `${detailsId}-${record.id}`;
      return <li key={record.id}>
        <div className="ai-thread-row ai-thread-item">
          <button type="button" className="ai-thread-name" aria-expanded={open} aria-controls={details}
            disabled={busy || deleted.has(record.id)} onClick={() => setExpanded(open ? "" : record.id)}>
            <span className="ai-thread-title" title={name}>{name}</span>
            <time className="ai-thread-time" dateTime={date.toISOString()} title={date.toLocaleString("zh-CN")}>{messageTimeLabel(date)}</time>
          </button>
          <Tool label={`删除记录：${name}`} className="ai-thread-delete" color="red"
            {...buttons.props(action, blocked)} onClick={() => void remove(record.id)}>
            {buttons.icon(action, <Trash2 size={14} />, 14)}</Tool>
        </div>
        <div className="review-history-conclusion" id={details} hidden={!open}>
          <p>{record.scope === "document" ? "全文检测　" : "选区检测　"}朱雀文本检测</p>
          <dl><dt>人类撰写</dt><dd>{percentage(record.summary.humanRatio)}</dd>
            <dt>AI 生成</dt><dd>{percentage(record.summary.aiRatio)}</dd>
            <dt>疑似 AI</dt><dd>{percentage(record.summary.suspectedRatio)}</dd></dl>
        </div>
      </li>;
    })}</ul>
    <ActionError error={error || buttons.error()} />
  </section>;
}

function percentage(value: number) {
  return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}
