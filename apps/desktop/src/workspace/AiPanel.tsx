import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Button, DropdownMenu } from "@radix-ui/themes";
import { ArrowUp, FileText, History, Plus, Settings, Sparkles, Square } from "lucide-react";
import type { EditorTarget, MarkdownEditorHandle } from "../../../../packages/editor-react";
import { renderMarkdown } from "../../../../packages/markdown-core";
import { desktop, errorMessage, type AiJob, type AiOperation, type AiRequest, type AiResult, type AiSelection, type AiTurn } from "../desktop";
import type { SaveQueue } from "../editor/save-queue";
import { untitled } from "../labels";
import { SidebarToggleIcon, Tool } from "../ui";

const actions: Record<AiOperation, string> = { summary: "生成摘要", titles: "建议标题", rewrite: "改写选区" };
const labels = { ...actions, chat: "对话" };
const statuses: Record<AiJob["status"], string> = { running: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消" };

interface AiTarget {
  sessionId: number;
  revision: number;
  editor: EditorTarget | null;
}

interface Task {
  request: AiRequest;
  target: AiTarget | null;
  message: string;
  result?: AiResult;
  error?: string;
  applied?: boolean;
  saving?: boolean;
  feedback?: string;
}

const noTasks: Task[] = [];
const noSnapshot = () => null;
const noSubscription = () => () => {};

export function captureAiTask(queue: SaveQueue, editor: MarkdownEditorHandle, operation: AiOperation, selection?: AiSelection) {
  const { fields, revision } = queue.snapshot();
  const target = operation === "rewrite" ? editor.target() : null;
  const text = target?.original ?? fields.contentMd;
  if (!text.trim()) throw new Error(target ? "请在编辑器中选中要改写的文字" : "请先填写正文");
  return {
    request: { id: crypto.randomUUID(), entryId: queue.entry.id, operation, title: fields.title, text, ...selection },
    target: { sessionId: queue.sessionId, revision, editor: target },
    message: actions[operation],
  };
}

export function matchesAiTarget(target: AiTarget, queue: SaveQueue) {
  return queue.sessionId === target.sessionId && queue.entry.deletedAt === null && queue.snapshot().revision === target.revision;
}

function chatHistory(tasks: Task[], remainingBytes: number): AiTurn[] {
  const history: AiTurn[] = [];
  const encoder = new TextEncoder();
  let budget = Math.min(48 * 1024, remainingBytes);
  for (const task of tasks.slice().reverse()) {
    if (!task.result) continue;
    let assistant = "reply" in task.result ? task.result.reply : task.result.candidates.join("\n\n");
    const turnBytes = encoder.encode(task.message).length + encoder.encode(assistant).length;
    if (turnBytes > budget) break;
    budget -= turnBytes;
    if ("replacement" in task.result && task.result.replacement !== null) {
      const proposal = `\n\n该轮建议的 Markdown 正文：\n${task.result.replacement}`;
      const proposalBytes = encoder.encode(proposal).length;
      if (proposalBytes <= budget) { assistant += proposal; budget -= proposalBytes; }
    }
    history.unshift({ user: task.message, assistant });
    if (history.length === 8) break;
  }
  return history;
}

export function useAiAssistant() {
  const [conversations, setConversations] = useState<Record<number, Task[]>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<string>();
  const [startedId, setStartedId] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const pending = useRef<string | null>(null);
  const applying = useRef(false);

  useEffect(() => {
    const subscription = desktop.onAiStarted(setStartedId);
    return () => { void subscription.then(unlisten => unlisten(), () => {}); };
  }, []);

  function update(scope: number, id: string, change: Partial<Task>) {
    setConversations(current => {
      if (!current[scope]) return current;
      return { ...current, [scope]: current[scope].map(task => task.request.id === id ? { ...task, ...change } : task) };
    });
  }

  async function generate(scope: number, task: Task, retryId?: string) {
    if (pending.current) return;
    const { id } = task.request;
    pending.current = id;
    setBusyId(id);
    setStartedId("");
    setErrors(current => ({ ...current, [scope]: "" }));
    setConversations(current => {
      const tasks = current[scope] ?? noTasks;
      return { ...current, [scope]: retryId ? tasks.map(item => item.request.id === retryId ? task : item) : [...tasks, task] };
    });
    try { update(scope, id, { result: await desktop.aiGenerate(task.request) }); }
    catch (failure) { update(scope, id, { error: errorMessage(failure) }); }
    finally { pending.current = null; setBusyId(undefined); setCancelling(false); }
  }

  return {
    conversations, errors, busyId, canCancel: Boolean(busyId && !cancelling && startedId === busyId),
    reset(scope: number) {
      setConversations(current => ({ ...current, [scope]: [] }));
      setErrors(current => ({ ...current, [scope]: "" }));
    },
    forget(scope: number) {
      setConversations(({ [scope]: _, ...current }) => current);
      setErrors(({ [scope]: _, ...current }) => current);
    },
    start(queue: SaveQueue, editor: MarkdownEditorHandle, operation: AiOperation, selection?: AiSelection) {
      try { void generate(queue.sessionId, captureAiTask(queue, editor, operation, selection)); }
      catch (failure) { setErrors(current => ({ ...current, [queue.sessionId]: errorMessage(failure) })); }
    },
    send(prompt: string, queue?: SaveQueue, editor?: MarkdownEditorHandle, selection?: AiSelection) {
      const snapshot = queue?.snapshot();
      const title = snapshot?.fields.title ?? "";
      const text = snapshot?.fields.contentMd ?? "";
      const scope = queue?.sessionId ?? 0;
      const remainingBytes = 256 * 1024 - new TextEncoder().encode(title + text + prompt).length;
      const history = chatHistory(conversations[scope] ?? noTasks, remainingBytes);
      void generate(scope, {
        request: { id: crypto.randomUUID(), operation: "chat", prompt, history, entryId: queue?.entry.id ?? null, title, text, ...selection },
        target: queue && editor && snapshot ? { sessionId: queue.sessionId, revision: snapshot.revision, editor: editor.target("document") } : null,
        message: prompt,
      });
    },
    retry(scope: number, task: Task, selection?: AiSelection) {
      const request = { ...task.request, id: crypto.randomUUID(), target: selection?.target, agentModel: selection?.agentModel };
      void generate(scope, { ...task, request, error: undefined }, task.request.id);
    },
    async cancel(id: string) {
      setCancelling(true);
      try { await desktop.aiCancel(id); }
      catch (failure) {
        const thread = Object.entries(conversations).find(([, tasks]) => tasks.some(task => task.request.id === id));
        if (thread) update(Number(thread[0]), id, { feedback: errorMessage(failure) });
        setCancelling(false);
      }
    },
    async copy(scope: number, id: string, content: string) {
      try { await desktop.copyText(content); update(scope, id, { feedback: "已复制" }); }
      catch (failure) { update(scope, id, { feedback: errorMessage(failure) }); }
    },
    reportError(scope: number, id: string, failure: unknown) {
      update(scope, id, { feedback: errorMessage(failure) });
    },
    async apply(task: Task, candidate: string, queue: SaveQueue, editor: MarkdownEditorHandle, isCurrent: () => boolean) {
      const { target, request } = task;
      if (!target || !matchesAiTarget(target, queue) || !isCurrent() || applying.current) return;
      const mark = (change: Partial<Task>) => update(queue.sessionId, request.id, change);
      if (request.operation === "chat") {
        applying.current = true;
        mark({ saving: true, feedback: "" });
        try {
          if (!await queue.flush()) {
            mark({ feedback: "原文保存失败，请处理保存错误后再应用" });
            return;
          }
          if (!isCurrent() || !matchesAiTarget(target, queue) || !editor.replaceTarget(target.editor!, candidate)) {
            mark({ feedback: "当前文档已切换或修改，请重新生成" });
            return;
          }
          const changed = queue.snapshot().revision !== target.revision;
          const saved = !changed || await queue.flush({ aiReplace: true });
          mark({ applied: true, feedback: saved ? "已应用到正文" : "正文已更新，保存失败" });
        } catch (failure) { mark({ feedback: errorMessage(failure) }); }
        finally { applying.current = false; mark({ saving: false }); }
        return;
      }
      if (request.operation === "rewrite") {
        if (!editor.replaceTarget(target.editor!, candidate)) {
          mark({ feedback: "原选区已变化，请重新生成" });
          return;
        }
      } else {
        queue.edit(request.operation === "summary" ? { summary: candidate } : { title: candidate });
      }
      mark({ applied: true, feedback: "已应用到原稿" });
    },
  };
}

type Assistant = ReturnType<typeof useAiAssistant>;

export function AiPanel({ open, assistant, queue, target, selection, targetPicker, windowControls, canChat, canEdit, onSend, onGenerate, onApply, onClose, onSettings }: {
  open: boolean;
  assistant: Assistant;
  queue?: SaveQueue;
  target: { label?: string; hint?: string };
  selection?: AiSelection;
  targetPicker: ReactNode;
  windowControls?: ReactNode;
  canChat: boolean;
  canEdit: boolean;
  onSend(message: string): void;
  onGenerate(operation: AiOperation): void;
  onApply(task: Task, candidate: string): void;
  onClose(): void;
  onSettings(): void;
}) {
  const [history, setHistory] = useState(false);
  const [composerKey, resetComposer] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scope = queue?.sessionId ?? 0;
  const tasks = assistant.conversations[scope] ?? noTasks;
  const snapshot = useSyncExternalStore(queue?.subscribe ?? noSubscription, queue?.snapshot ?? noSnapshot);
  const title = snapshot ? snapshot.fields.title || untitled : undefined;
  const { busyId, canCancel } = assistant;
  const currentBusy = tasks.some(task => task.request.id === busyId) ? busyId : undefined;

  useEffect(() => { if (open) input.current?.focus({ preventScroll: true }); }, [open]);
  useLayoutEffect(() => {
    if (!history && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [open, tasks, history]);

  return <aside className="ai-panel" aria-label="AI 聊天"
    onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
        event.stopPropagation(); onClose();
      }
    }}>
    <header className="ai-chat-header">
      <h2>AI 聊天</h2>
      <Tool label="新对话" color="gray" disabled={Boolean(currentBusy) || tasks.some(task => task.saving)} onClick={() => {
        assistant.reset(scope); setHistory(false); resetComposer(key => key + 1);
        requestAnimationFrame(() => input.current?.focus());
      }}><Plus size={16} /></Tool>
      <div className="ai-chat-header-tools">
        <Tool label="任务记录" color="gray" aria-pressed={history} onClick={() => setHistory(value => !value)}><History size={15} /></Tool>
        <Tool label="隐藏右侧栏" className="chrome-icon" onClick={onClose}><SidebarToggleIcon expanded side="right" /></Tool>
      </div>
      {windowControls}
    </header>
    <div className="ai-transcript" ref={transcript}>
      {history ? <AiHistory busy={Boolean(busyId)} />
        : tasks.length ? <ol className="ai-turns" aria-label="对话消息">
          {tasks.map((task, index) => <li key={task.request.id} className="ai-turn">
            <p className="ai-user-message">{task.message}</p>
            {task.request.id === currentBusy && !task.result && !task.error && <p className="muted-text" role="status">正在回复…</p>}
            {task.error && <div className="ai-reply">
              <p className="inline-error" role="alert">{task.error}</p>
              {index === tasks.length - 1 && <Button size="1" variant="soft" color="gray" disabled={Boolean(busyId) || !canChat}
                onClick={() => assistant.retry(scope, task, selection)}>重试</Button>}
            </div>}
            {task.result && <div className="ai-reply">
              {"reply" in task.result && <AiReply text={task.result.reply} onError={error => assistant.reportError(scope, task.request.id, error)} />}
              <AiSuggestions task={task} applicable={Boolean(canEdit && queue && task.target && matchesAiTarget(task.target, queue))}
                onApply={candidate => onApply(task, candidate)}
                onCopy={candidate => { void assistant.copy(scope, task.request.id, candidate); }} />
            </div>}
            {task.feedback && <p className="muted-text" role="status">{task.feedback}</p>}
          </li>)}
        </ol> : <div className="ai-chat-empty">
          <Sparkles size={25} strokeWidth={1.45} aria-hidden="true" />
          <p>{target.label ? `向 ${target.label} 提问` : "开始 AI 对话"}</p>
          {queue && <div className="ai-quick-actions">{(Object.keys(actions) as AiOperation[]).map(operation =>
            <Button key={operation} size="1" variant="soft" color="gray" disabled={!canEdit || !canChat || Boolean(busyId)}
              onClick={() => onGenerate(operation)}>{actions[operation]}</Button>)}</div>}
        </div>}
      {!history && assistant.errors[scope] && <p className="inline-error" role="alert">{assistant.errors[scope]}</p>}
    </div>
    <Composer key={`${scope}:${composerKey}`} input={input} target={target} targetPicker={targetPicker} title={title}
      enabled={canChat && !busyId} busy={busyId} canCancel={canCancel} onCancel={id => { void assistant.cancel(id); }}
      onSend={message => { setHistory(false); onSend(message); }} onSettings={onSettings}
      onGenerate={tasks.length && canEdit ? operation => { setHistory(false); onGenerate(operation); } : undefined} />
  </aside>;
}

function Composer({ input, target, targetPicker, title, enabled, busy, canCancel, onCancel, onSend, onSettings, onGenerate }: {
  input: React.RefObject<HTMLTextAreaElement | null>;
  target: { label?: string; hint?: string };
  targetPicker: ReactNode;
  title?: string;
  enabled: boolean;
  busy?: string;
  canCancel: boolean;
  onCancel(id: string): void;
  onSend(message: string): void;
  onSettings(): void;
  onGenerate?(operation: AiOperation): void;
}) {
  const [draft, setDraft] = useState("");
  const sendable = enabled && Boolean(draft.trim());
  function send(event: FormEvent) {
    event.preventDefault();
    if (!sendable) return;
    onSend(draft.trim());
    setDraft("");
  }

  return <form className="ai-composer" onSubmit={send} autoComplete="off">
    {title && <div className="ai-context" title={title} aria-label={`当前文档：${title}`}>
      <FileText size={13} aria-hidden="true" /><span>{title}</span>
    </div>}
    <textarea ref={input} rows={2} aria-label="消息" autoComplete="off" value={draft}
      placeholder={target.label ? `询问 ${target.label}` : "输入消息"}
      onChange={event => setDraft(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
    <div className="ai-composer-tools">
      {targetPicker}
      <Tool label="AI 设置" color="gray" onClick={onSettings}><Settings size={15} /></Tool>
      {onGenerate && <DropdownMenu.Root>
        <DropdownMenu.Trigger><Tool label="写作工具" color="gray" disabled={!enabled}><Sparkles size={15} /></Tool></DropdownMenu.Trigger>
        <DropdownMenu.Content size="1" align="start" side="top">
          {(Object.keys(actions) as AiOperation[]).map(operation => <DropdownMenu.Item key={operation}
            onSelect={() => onGenerate(operation)}>{actions[operation]}</DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu.Root>}
      {busy ? <Tool className="ai-send" label="停止生成" disabled={!canCancel} onClick={() => onCancel(busy)}><Square size={14} /></Tool>
        : <Button className="ai-send" type="submit" size="1" aria-label="发送消息" disabled={!sendable}><ArrowUp size={17} /></Button>}
    </div>
  </form>;
}

function AiReply({ text, onError }: { text: string; onError(error: unknown): void }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { element.current?.replaceChildren(renderMarkdown(text)); }, [text]);
  return <div className="ai-message-markdown" ref={element} onClick={event => {
    const anchor = (event.target as HTMLElement).closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    const url = anchor.getAttribute("href")!;
    if (!url.startsWith("#")) void desktop.openLink(url).catch(onError);
  }} />;
}

function AiSuggestions({ task, applicable, onApply, onCopy }: {
  task: Task;
  applicable: boolean;
  onApply(candidate: string): void;
  onCopy(candidate: string): void;
}) {
  const result = task.result!;
  const change = "reply" in result;
  const proposals = change ? result.replacement !== null && task.target ? [result.replacement] : [] : result.candidates;
  if (!proposals.length) return null;
  return <div className="ai-suggestions">
    {proposals.map((candidate, index) => <div key={index} className="ai-suggestion">
      {change ? <details>
        <summary>查看拟修改正文</summary>
        <pre>{candidate || "清空正文"}</pre>
      </details> : <p className="ai-candidate-text">{candidate}</p>}
      <div className="button-strip">
        <Button size="1" variant="soft" disabled={!applicable || task.applied || task.saving} onClick={() => onApply(candidate)}>
          {task.saving ? "正在应用…" : task.applied ? "已应用" : change ? "应用到正文" : "应用到原稿"}
        </Button>
        <Button size="1" variant="ghost" color="gray" onClick={() => onCopy(candidate)}>复制</Button>
      </div>
    </div>)}
    {!applicable && !task.applied && !task.saving && <p className="muted-text">原文已有变动，可复制内容或重新生成。</p>}
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
