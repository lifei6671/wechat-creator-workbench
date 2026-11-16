import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@radix-ui/themes";
import { X } from "lucide-react";
import type { EditorTarget, MarkdownEditorHandle } from "../../../../packages/editor-react";
import { desktop, errorMessage, type AiJob, type AiOperation, type AiRequest } from "../desktop";
import type { SaveQueue } from "../editor/save-queue";
import { untitled } from "../labels";
import { Tool } from "../ui";

const labels: Record<AiOperation, string> = { summary: "生成摘要", titles: "建议标题", rewrite: "改写选区" };
const statuses: Record<AiJob["status"], string> = { running: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消" };

export interface AiTarget {
  sessionId: number;
  revision: number;
  editor: EditorTarget | null;
  title: string;
  original: string;
}

interface Task {
  request: AiRequest;
  target: AiTarget;
  result?: { candidates: string[] };
  error?: string;
  applied?: boolean;
}

export function captureAiTask(queue: SaveQueue, editor: MarkdownEditorHandle, operation: AiOperation): Task {
  const { fields, revision } = queue.snapshot();
  const target = operation === "rewrite" ? editor.target() : null;
  const text = target?.original ?? fields.contentMd;
  if (!text.trim()) throw new Error(target ? "请在编辑器中选中要改写的文字" : "请先填写正文");
  return {
    request: { id: crypto.randomUUID(), entryId: queue.entry.id, operation, title: fields.title, text },
    target: { sessionId: queue.sessionId, revision, editor: target, title: fields.title || untitled,
      original: target?.original ?? (operation === "summary" ? fields.summary : fields.title) },
  };
}

export function matchesAiTarget(target: AiTarget, queue: SaveQueue) {
  return queue.sessionId === target.sessionId && queue.entry.deletedAt === null && queue.snapshot().revision === target.revision;
}

export function useAiAssistant() {
  const [task, setTask] = useState<Task>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [startedId, setStartedId] = useState("");

  useEffect(() => {
    const subscription = desktop.onAiStarted(setStartedId);
    void subscription.catch(failure => setError(errorMessage(failure)));
    return () => { void subscription.then(unlisten => unlisten(), () => {}); };
  }, []);

  async function generate(task: Task) {
    setTask(task);
    setBusy(true);
    setStartedId("");
    setStatus("");
    setError("");
    try { setTask({ ...task, result: await desktop.aiGenerate(task.request) }); }
    catch (failure) { setTask({ ...task, error: errorMessage(failure) }); }
    finally { setBusy(false); setCancelling(false); }
  }

  async function cancel() {
    setCancelling(true);
    try { await desktop.aiCancel(task!.request.id); }
    catch (failure) { setError(errorMessage(failure)); setCancelling(false); }
  }

  return {
    task, status, error, busy, canCancel: busy && !cancelling && startedId === task?.request.id, cancel,
    start(queue: SaveQueue, editor: MarkdownEditorHandle, operation: AiOperation) {
      try { void generate(captureAiTask(queue, editor, operation)); }
      catch (failure) { setError(errorMessage(failure)); }
    },
    retry() {
      const { request, target } = task!;
      void generate({ request: { ...request, id: crypto.randomUUID() }, target });
    },
    async copy(candidate: string) {
      try { await desktop.copyText(candidate); setStatus("已复制候选"); setError(""); }
      catch (failure) { setError(errorMessage(failure)); }
    },
    apply(candidate: string, queue: SaveQueue, editor: MarkdownEditorHandle) {
      if (!task || !matchesAiTarget(task.target, queue)) return;
      const { operation } = task.request;
      if (operation === "rewrite") {
        if (!editor.replaceTarget(task.target.editor!, candidate)) {
          setError("原选区已变化，可复制候选或重新生成");
          return;
        }
      } else {
        queue.edit(operation === "summary" ? { summary: candidate } : { title: candidate });
      }
      setTask({ ...task, applied: true });
      setStatus("已应用到原稿");
      setError("");
    },
  };
}

type Assistant = ReturnType<typeof useAiAssistant>;

export function AiPanel({ assistant, origin, target, canGenerate, onGenerate, onApply, onClose, onSettings }: {
  assistant: Assistant;
  origin?: SaveQueue;
  target: { label?: string; hint?: string };
  canGenerate: boolean;
  onGenerate(operation: AiOperation): void;
  onApply(candidate: string): void;
  onClose(): void;
  onSettings(): void;
}) {
  const [history, setHistory] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  const { task, busy, cancel, canCancel, retry, error, status } = assistant;
  return <aside className="ai-panel" ref={panel} tabIndex={-1} aria-label="AI 助手"
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="section-bar ai-panel-title"><h2>AI 助手</h2><Tool label="关闭 AI 助手" onClick={onClose}><X size={15} /></Tool></div>
    <div className="ai-panel-body">
      <p className="muted-text ai-active-target">{target.label ? `默认目标：${target.label}` : target.hint}</p>
      <div className="button-strip ai-actions">
        {(Object.keys(labels) as AiOperation[]).map(operation => <Button key={operation} size="1" variant="soft" color="gray"
          disabled={!canGenerate || busy} onClick={() => onGenerate(operation)}>{labels[operation]}</Button>)}
      </div>
      {task && <div className="ai-target"><strong>{labels[task.request.operation]}</strong><span title={task.target.title}>{task.target.title}</span></div>}
      {busy && <div className="button-strip"><span role="status">生成中…</span><Button size="1" variant="ghost" disabled={!canCancel}
        onClick={() => { void cancel(); }}>取消生成</Button></div>}
      {task?.error && <div className="ai-candidate"><p className="inline-error" role="alert">{task.error}</p>
        <Button size="1" variant="soft" color="gray" disabled={busy || !target.label} onClick={retry}>重试</Button></div>}
      {task?.result && (origin ? <BoundCandidates task={task} queue={origin} onApply={onApply} onCopy={assistant.copy} />
        : <Candidates task={task} applicable={false} onApply={onApply} onCopy={assistant.copy} />)}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {status && <p className="muted-text" role="status">{status}</p>}
      <div className="button-strip ai-actions">
        <Button size="1" variant="ghost" color="gray" onClick={onSettings}>AI 设置</Button>
        <Button size="1" variant="ghost" color="gray" aria-expanded={history} onClick={() => setHistory(value => !value)}>任务记录</Button>
      </div>
      {history && <AiHistory busy={busy} />}
    </div>
  </aside>;
}

interface CandidateProps {
  task: Task;
  onApply(candidate: string): void;
  onCopy(candidate: string): Promise<void>;
}

function BoundCandidates({ queue, ...props }: CandidateProps & { queue: SaveQueue }) {
  useSyncExternalStore(queue.subscribe, queue.snapshot);
  return <Candidates {...props} applicable={matchesAiTarget(props.task.target, queue)} />;
}

function Candidates({ task, applicable, onApply, onCopy }: CandidateProps & { applicable: boolean }) {
  return <div className="ai-candidates">
    {!applicable && !task.applied && <p className="muted-text" role="status">原稿已修改或关闭。可复制候选，或重新生成。</p>}
    {task.target.original && <div className="ai-comparison"><strong>原文</strong><del>{task.target.original}</del></div>}
    {task.result!.candidates.map((candidate, index) => <div key={index} className="ai-candidate">
      <div className="ai-comparison"><strong>{task.request.operation === "titles" ? `候选标题 ${index + 1}` : "候选内容"}</strong><ins>{candidate}</ins></div>
      <div className="button-strip">
        <Button size="1" variant="soft" disabled={!applicable || task.applied} onClick={() => onApply(candidate)}>应用到原稿</Button>
        <Button size="1" variant="ghost" color="gray" onClick={() => { void onCopy(candidate); }}>复制</Button>
      </div>
    </div>)}
  </div>;
}

function AiHistory({ busy }: { busy: boolean }) {
  const [jobs, setJobs] = useState<AiJob[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void desktop.aiJobs().then(value => { if (current) setJobs(value); }, failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [busy]);
  if (error) return <p className="inline-error" role="alert">{error}</p>;
  if (!jobs?.length) return <p className="muted-text">{jobs ? "暂无任务" : "正在读取任务…"}</p>;
  return <ul className="ai-jobs">{jobs.map(job => <li key={job.id}>
    <div className="ai-job-line"><strong>{labels[job.operation]}</strong><span>{statuses[job.status]}</span></div>
    <div className="ai-job-line"><span title={job.model}>{job.model}</span><time dateTime={new Date(job.createdAt).toISOString()}>{new Date(job.createdAt).toLocaleString("zh-CN")}</time></div>
    {job.usage?.totalTokens != null && <span className="muted-text">{job.usage.totalTokens} tokens</span>}
    {job.error && job.status === "failed" && <p className="inline-error">{job.error}</p>}
  </li>)}</ul>;
}
