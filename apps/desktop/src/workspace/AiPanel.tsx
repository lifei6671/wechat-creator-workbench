import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadListPrimitive, ThreadPrimitive, useAui, useAuiState,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { Button, Checkbox, ContextMenu, DropdownMenu, TextField, VisuallyHidden } from "@radix-ui/themes";
import { ArrowUp, Check, ChevronDown, Copy, FileText, History, PencilLine, Plus, Settings, Sparkles, Square, Trash2, X } from "lucide-react";
import { diffLines } from "diff";
import type { MarkdownEditorHandle } from "../../../../packages/editor-react";
import { renderMarkdown } from "../../../../packages/markdown-core";
import { desktop, errorMessage, windowsTitleBar, type AiPropertyField, type AiPropertyValues, type AiProposalStatus, type AiSelection } from "../desktop";
import type { SaveQueue } from "../editor/save-queue";
import { aiActions, captureAiIntent, matchesAiTarget, messageText, requestedProperties, scopeLabels, type AiAction, type CapturedTarget, type ChatSelection, type ScopeChoice } from "../ai/context";
import { propertyProposalOf, proposalOf, useWritingRuntime, type WritingThreads } from "../ai/runtime";
import type { AiPropertyProposal, AiProposal } from "../ai/proposals";
import { messageTimeLabel, untitled } from "../labels";
import { Tool } from "../ui";
import { ActionError, useButtonFeedback } from "../button-feedback";
import { addTag } from "./TagInput";
import { WindowDragRegion } from "./WindowTitle";

const readNothing = () => null;
const subscribeNothing = () => () => {};
const rewriteActions = [
  ["AI 润色", "润色选区，保留原意和语气。"],
  ["精简", "精简选区，保留主要信息。"],
  ["扩写", "扩写选区，让表达更充分，不编造事实。"],
] as const;

function selectionPreview(text: string) {
  const characters = Array.from(text.trim().replace(/\s+/g, " "));
  return characters.length > 12 ? characters.slice(0, 12).join("") + "…" : characters.join("");
}

interface Props {
  open: boolean;
  queue?: SaveQueue;
  editor?: MarkdownEditorHandle;
  target: { label?: string; hint?: string };
  selection?: AiSelection;
  targetPicker: ReactNode;
  canChat: boolean;
  canEdit: boolean;
  canSend?(): boolean;
  trackWrite?(write: Promise<void>): Promise<void>;
  tagSuggestions?: string[];
  selectionRequest?: ChatSelection;
  canWrite(queue: SaveQueue, editor: MarkdownEditorHandle): boolean;
  onClose(): void;
  onSettings(): void;
}

type ConversationSession = WritingThreads & {
  entryId: string | null; targets: Map<string, CapturedTarget | null>; draft?: string; isBusy?: () => boolean;
};

export function AiPanel(props: Props) {
  const entryId = props.queue?.entry.id ?? null;
  const sessions = useRef(new Map<string | null, ConversationSession>());
  const [mounted, setMounted] = useState<ConversationSession[]>([]);
  const [settled, setSettled] = useState(0);
  const onIdle = useCallback(() => setSettled(value => value + 1), []);
  useEffect(() => {
    let active = sessions.current.get(entryId);
    if (!active && props.open) {
      active = { entryId, items: new Map(), targets: new Map() };
      sessions.current.set(entryId, active);
    }
    setMounted(previous => {
      const ordered = active && (props.open || previous.includes(active)) && previous[0] !== active
        ? [active, ...previous.filter(session => session !== active)] : previous;
      let cached = 0;
      const next = ordered.filter(session => session === active || session.isBusy?.() || cached++ < 3);
      return next.length === ordered.length ? ordered : next;
    });
  }, [entryId, props.open, settled]);
  return mounted.map(session => {
    const active = session.entryId === entryId;
    return <div key={session.entryId ?? "general"} className="ai-session" hidden={!props.open || !active}>
      <AiConversation {...props} session={session} onIdle={onIdle} open={props.open && active}
        queue={active ? props.queue : undefined} editor={active ? props.editor : undefined}
        selectionRequest={active ? props.selectionRequest : undefined} />
    </div>;
  });
}

type Progress = Exclude<AiProposalStatus, "pending"> | "saving" | "saveFailed" | "recordFailed";

function AiConversation(props: Props & { session: ConversationSession; onIdle: () => void }) {
  const { session, onIdle } = props;
  const { targets } = session;
  const [error, setError] = useState("");
  // A cached session can remount only after its outstanding proposal writes settle.
  const [stored, setStored] = useState<ReadonlySet<string>>(() => new Set(targets.keys()));
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const pending = useRef(new Set<string>());
  const report = useCallback((failure: unknown) => setError(errorMessage(failure)), []);
  const markStored = useCallback((id: string) => setStored(previous => new Set(previous).add(id)), []);
  const markUnavailable = useCallback((id: string, failed: boolean) => setUnavailable(previous => {
    const next = new Set(previous);
    if (failed) next.add(id); else next.delete(id);
    return next;
  }), []);
  const { runtime, loadHistory, trackWork, hasPendingWork } = useWritingRuntime(
    session.entryId, session, report, markStored, markUnavailable, targets, onIdle,
  );
  useLayoutEffect(() => {
    session.isBusy = () => hasPendingWork() || pending.current.size > 0 || runtime.thread.getState().isRunning
      || Object.values(progress).includes("recordFailed");
    return () => { delete session.isBusy; };
  }, [session, hasPendingWork, runtime, progress]);

  const mark = (id: string, status: Progress) => setProgress(previous => ({ ...previous, [id]: status }));
  const finishProposal = (id: string) => {
    pending.current.delete(id);
    onIdle();
  };
  async function changeStatus(id: string, status: Exclude<AiProposalStatus, "pending">) {
    const write = desktop.aiProposalStatus(id, status);
    await (props.trackWrite ? props.trackWrite(write) : write);
    mark(id, status);
    if (status !== "rejected") targets.delete(id);
  }
  async function reject(proposal: AiProposal) {
    if (pending.current.has(proposal.id)) return;
    pending.current.add(proposal.id);
    try { await changeStatus(proposal.id, "rejected"); }
    catch (failure) { report(failure); }
    finally { finishProposal(proposal.id); }
  }
  function apply(id: string, candidate: string, action: AiAction, proposal?: AiProposal) {
    if (pending.current.has(id)) return;
    const target = targets.get(id);
    const { queue, editor } = props;
    if (!target || !queue || !editor || !props.canWrite(queue, editor) || !matchesAiTarget(target, queue)) return;
    const { context } = target;
    try {
      if (proposal) {
        if (!stored.has(id)) return;
        const restored = editor.captureDocumentMatch();
        if (!context || !editor.replaceTarget(context, candidate)) {
          pending.current.add(id);
          void changeStatus(id, "conflicted").catch(report).finally(() => finishProposal(id));
          return;
        }
        pending.current.add(id);
        const revision = queue.snapshot().revision;
        const checkSave = () => {
          const state = queue.snapshot();
          const reverted = state.revision > revision && state.savedRevision < revision && restored();
          if (reverted || state.savedRevision >= revision) {
            unsubscribe();
            void changeStatus(id, reverted ? "conflicted" : "applied").catch(failure => {
              mark(id, reverted ? "conflicted" : "recordFailed");
              report(failure);
            })
              .finally(() => finishProposal(id));
          } else {
            mark(id, state.error ? "saveFailed" : "saving");
          }
        };
        // A proposal follows the existing autosave and remains pending while a failed save is retried.
        const unsubscribe = queue.subscribe(checkSave);
        checkSave();
      } else {
        queue.edit(action === "summary" ? { summary: candidate } : { title: candidate });
        mark(id, "applied");
        targets.delete(id);
      }
    } catch (failure) { report(failure); }
  }
  function applyProperties(proposal: AiPropertyProposal, change: AiPropertyValues) {
    const { id, entryId } = proposal;
    const { queue, editor } = props;
    const target = targets.get(id);
    if (pending.current.has(id) || !stored.has(id) || !queue || !editor || entryId !== queue.entry.id
      || target?.sessionId !== queue.sessionId || !props.canWrite(queue, editor)) return;
    const current = queue.snapshot().fields;
    const tags = change.tags?.reduce((merged, tag) => addTag(merged, tag, props.tagSuggestions ?? []), current.tags);
    const changed = (tags && tags !== current.tags) || (change.title !== undefined && change.title !== current.title)
      || (change.summary !== undefined && change.summary !== current.summary);
    setError("");
    if (progress[id] === "saveFailed" && changed) {
      mark(id, "conflicted");
      targets.delete(id);
      return;
    }
    pending.current.add(id);
    mark(id, "saving");
    const save = async () => {
      if (changed) queue.edit({ ...change, ...(tags && { tags }) });
      if (!await queue.flush({ retry: true })) throw queue.snapshot().error;
    };
    const write = save();
    void trackWork(props.trackWrite ? props.trackWrite(write) : write).then(() => {
      mark(id, "applied");
      targets.delete(id);
    }, failure => {
      mark(id, "saveFailed");
      report(failure);
    }).finally(() => finishProposal(id));
  }
  return <AssistantRuntimeProvider runtime={runtime}>
    <ConversationView {...props} runtime={runtime} loadHistory={loadHistory} trackWork={trackWork} error={error} report={report}
      clear={() => setError("")} targets={targets} stored={stored} progress={progress}
      unavailable={unavailable} apply={apply} applyProperties={applyProperties} reject={reject} />
  </AssistantRuntimeProvider>;
}

function ConversationView({
  open, queue, editor, target, selection, targetPicker, canChat, canEdit, canSend, tagSuggestions, selectionRequest, onClose, onSettings,
  runtime, session, onIdle, loadHistory, trackWork, error, report, clear, targets, stored, progress, unavailable, apply, applyProperties, reject,
}: Props & {
  runtime: AssistantRuntime; loadHistory(): Promise<void>; error: string; report(failure: unknown): void;
  session: ConversationSession; onIdle(): void; trackWork<T>(operation: Promise<T>): Promise<T>;
  clear(): void; targets: Map<string, CapturedTarget | null>; stored: ReadonlySet<string>; progress: Record<string, Progress>;
  unavailable: ReadonlySet<string>;
  apply(id: string, candidate: string, action: AiAction, proposal?: AiProposal): void; reject(proposal: AiProposal): Promise<void>;
  applyProperties(proposal: AiPropertyProposal, change: AiPropertyValues): void;
}) {
  const aui = useAui();
  const [view, setView] = useState<"chat" | "threads">("chat");
  const [scope, setScope] = useState<ScopeChoice>("auto");
  const [rewrite, setRewrite] = useState(false);
  const [attachedSelection, setAttachedSelection] = useState<ChatSelection | null>(null);
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastSelectionRequest = useRef<ChatSelection | undefined>(undefined);
  const snapshot = useSyncExternalStore(queue?.subscribe ?? subscribeNothing, queue?.snapshot ?? readNothing);
  const getSelection = useCallback(() => editor?.hasSelection(false) ?? false, [editor]);
  const hasSelection = useSyncExternalStore(editor?.subscribeSelection ?? subscribeNothing, getSelection);
  const getRewritePreview = useCallback(() => {
    if (!open || !rewrite || !editor) return "";
    return selectionPreview(editor.selectionText());
  }, [editor, open, rewrite]);
  const rewritePreview = useSyncExternalStore(editor?.subscribeSelection ?? subscribeNothing, getRewritePreview);
  const running = useAuiState(state => state.thread.isRunning);
  const loading = useAuiState(state => state.thread.isLoading);
  const listLoading = useAuiState(state => state.threads.isLoading);
  const threadId = useAuiState(state => state.threadListItem.remoteId);
  const archived = useAuiState(state => state.threadListItem.status === "archived");
  const draft = useAuiState(state => state.composer.text);
  const propertyFields = !rewrite && queue ? requestedProperties(draft) : [];
  const enabled = ready && canChat && open && view === "chat" && !running && !switching && !loading && !archived && !(threadId && unavailable.has(threadId));
  const chosen = rewrite || attachedSelection ? "selection" : scope === "auto" ? hasSelection ? "selection" : "section" : scope;
  const title = snapshot ? snapshot.fields.title || untitled : "";

  useEffect(() => {
    if (ready || listLoading) return;
    const current = runtime.threads.getState().threadIds[0];
    const restoreDraft = () => {
      if (session.draft) aui.composer.setText(session.draft);
      setReady(true);
    };
    if (!current) {
      restoreDraft();
      return;
    }
    let active = true;
    void trackWork(runtime.threads.switchToThread(current)).catch(report).finally(() => { if (active) restoreDraft(); });
    return () => { active = false; };
  }, [ready, listLoading, runtime, report, aui, session, trackWork]);
  useLayoutEffect(() => { if (ready) session.draft = draft; }, [ready, session, draft]);
  useEffect(() => { if (!running) onIdle(); }, [running, onIdle]);
  useEffect(() => { if (open && view === "chat" && ready && !switching) input.current?.focus({ preventScroll: true }); }, [open, ready, view, switching]);
  useEffect(() => {
    if (open && selectionRequest && selectionRequest !== lastSelectionRequest.current) {
      lastSelectionRequest.current = selectionRequest;
      setAttachedSelection(selectionRequest);
      setRewrite(false);
      setView("chat");
      input.current?.focus({ preventScroll: true });
    }
  }, [selectionRequest, open]);

  function send(action: AiAction, text: string, prompt = text, fromComposer = false,
    citation = scope, context?: Parameters<typeof captureAiIntent>[6]) {
    if (!enabled || canSend?.() === false || (action !== "chat" && !canEdit)) return;
    clear();
    try {
      const intent = captureAiIntent(action, prompt, citation, queue, editor, selection, { ...context, tagSuggestions });
      runtime.thread.append({ role: "user", content: [{ type: "text", text }],
        metadata: { custom: { action, citation: intent.label, scope: intent.scope, chatSelection: intent.chatSelection,
          instruction: action === "rewrite" || action === "properties" ? prompt : undefined,
          propertyFields: context?.propertyFields } },
        runConfig: { custom: { intent } },
      });
      if (fromComposer) {
        aui.composer.setText("");
        setAttachedSelection(null);
      }
      if (action === "rewrite") setRewrite(false);
      setView("chat");
    } catch (failure) { report(failure); }
  }
  function retry(id: string) {
    const messages = runtime.thread.getState().messages;
    const index = messages.findIndex(message => message.id === id);
    const user = messages[index]?.role === "user" ? messages[index] : messages[index - 1];
    if (user?.role !== "user") return;
    const action = user.metadata.custom.action as AiAction;
    const text = messageText(user);
    const proposal = proposalOf(messages[index]);
    const original = proposal && targets.get(proposal.id);
    send(action, text, action === "rewrite" || action === "properties" ? String(user.metadata.custom.instruction ?? text) : action === "chat" ? text : "", false,
      user.metadata.custom.scope as ScopeChoice, {
        original: original?.context && matchesAiTarget(original, queue) && editor?.matchesTarget(original.context)
          ? original.context : undefined,
        chatSelection: action === "chat" ? user.metadata.custom.chatSelection as ChatSelection | undefined : undefined,
        propertyFields: action === "properties" ? user.metadata.custom.propertyFields as AiPropertyField[] : undefined,
      });
  }
  function toggleHistory() {
    if (view === "threads") { setView("chat"); return; }
    clear();
    setView("threads");
    setHistoryLoading(true);
    void trackWork(loadHistory()).catch(report).finally(() => setHistoryLoading(false));
  }
  async function switchThread(id?: string) {
    if (!ready || running || switchingRef.current) return;
    switchingRef.current = true;
    clear();
    setSwitching(true);
    try {
      if (id) {
        await trackWork(runtime.threads.switchToThread(id));
        await trackWork(runtime.threads.reload());
      }
      else {
        if (threadId) await trackWork(runtime.threads.getItemById(threadId).archive());
        else await trackWork(runtime.threads.switchToNewThread());
        aui.composer.setText("");
      }
      targets.clear();
      setView("chat");
      setRewrite(false);
      setAttachedSelection(current => current === attachedSelection ? null : current);
    } catch (failure) {
      if (!id && threadId) await runtime.threads.switchToThread(threadId).catch(report);
      report(failure);
    }
    finally { switchingRef.current = false; setSwitching(false); }
  }
  const chooseRewrite = () => { setAttachedSelection(null); setRewrite(true); input.current?.focus({ preventScroll: true }); };

  return <ThreadPrimitive.Root className="ai-panel" aria-label="AI 聊天" onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
      event.stopPropagation(); onClose();
    }
  }}>
    <header className="ai-chat-header">
      <h2>AI 聊天</h2>
      <Tool label="新对话" className="chrome-icon" color="gray" disabled={!ready || running || switching}
        onClick={() => void switchThread()}><Plus size={18} strokeWidth={1.8} /></Tool>
      {open && windowsTitleBar && <WindowDragRegion onError={report} />}
      <div className="ai-chat-header-tools">
        <Tool label="对话记录" className="chrome-icon" color="gray" aria-pressed={view === "threads"} disabled={!ready || switching || historyLoading}
          onClick={toggleHistory}><History size={18} strokeWidth={1.8} /></Tool>
      </div>
    </header>
    <ThreadPrimitive.Viewport className="ai-transcript">
      {view === "threads"
        ? historyLoading || listLoading ? <p role="status" className="muted-text">正在读取对话…</p>
          : <ConversationList runtime={runtime} disabled={!ready || running || switching} select={id => void switchThread(id)} report={report} />
        : !ready || loading || switching ? <p role="status" className="muted-text">正在读取对话…</p>
        : <>
          <ThreadPrimitive.Empty><div className="ai-chat-empty">
            <Sparkles size={25} strokeWidth={1.45} aria-hidden="true" />
            <p>{target.label ? "开始新对话" : target.hint ?? "请选择 AI 目标"}</p>
            {queue && <div className="ai-quick-actions">
              <Button size="1" variant="soft" color="gray" disabled={!enabled || !canEdit} onClick={() => send("summary", aiActions.summary, "")}>生成摘要</Button>
              <Button size="1" variant="soft" color="gray" disabled={!enabled || !canEdit} onClick={() => send("titles", aiActions.titles, "")}>建议标题</Button>
              <Button size="1" variant="soft" color="gray" disabled={!enabled || !canEdit || !hasSelection} onClick={chooseRewrite}>改写选区</Button>
            </div>}
          </div></ThreadPrimitive.Empty>
          <div className="ai-turns" aria-label="对话消息">
            <ThreadPrimitive.Messages>
              {({ message }) => {
                const status = message.status;
                const text = messageText(message);
                return <MessagePrimitive.Root className="ai-turn">
                {message.role === "user" ? <AiUserMessage text={text}>
                    {!running && enabled && runtime.thread.getState().messages.at(-1)?.id === message.id &&
                      <Button size="1" color="gray" variant="soft" onClick={() => retry(message.id)}>重新生成</Button>}
                    <AiMessageTime date={message.createdAt} />
                    {text && <AiCopyButton text={text} onError={report} />}
                </AiUserMessage> : <>
                  {text && <AiReply text={text} streaming={status?.type === "running"} onError={report} />}
                  {status?.type === "running" && !message.content.length && <p className="muted-text" role="status">正在回复…</p>}
                  {status?.type === "incomplete" && <p className={status.reason === "cancelled" ? "muted-text" : "inline-error"} role="status">
                    {status.reason === "cancelled" ? "已停止生成" : status.reason === "error" && typeof status.error === "string"
                      ? status.error : "回复未完成"}
                  </p>}
                  <AiMessageActions message={message} {...{ queue, targets, stored, progress, apply, applyProperties, reject, report }}
                    canEdit={canEdit} canRetry={enabled}
                    retry={() => retry(message.id)} />
                </>}
              </MessagePrimitive.Root>; }}
            </ThreadPrimitive.Messages>
          </div>
        </>}
      <ActionError error={error} />
    </ThreadPrimitive.Viewport>
    <ComposerPrimitive.Root className="ai-composer" autoComplete="off" onSubmit={event => {
      event.preventDefault();
      const text = aui.composer.getState().text.trim();
      if (text) {
        const fields = !rewrite && queue ? requestedProperties(text) : [];
        if (fields.length) send("properties", text, text, true, "document", { propertyFields: fields });
        else send(rewrite ? "rewrite" : "chat", text, text, true, scope, { chatSelection: attachedSelection ?? undefined });
      }
    }}>
      {queue && <div className="ai-citations">
        <div className="ai-context" title={title}><FileText size={13} aria-hidden="true" /><span>{title}</span></div>
        {rewrite ? <Button type="button" variant="soft" size="1" color="gray" className="ai-rewrite-context"
          onClick={() => setRewrite(false)} aria-label={rewritePreview ? "退出改写选区：" + rewritePreview : "退出改写选区"}>
          <span>{rewritePreview || (hasSelection ? "改写选区" : "未选中文字")}</span><span aria-hidden="true">×</span>
        </Button> : propertyFields.length > 0 ? <span className="ai-context-control muted-text">{scopeLabels.document}</span>
        : attachedSelection ? <Button type="button" variant="soft" size="1" color="gray" className="ai-selection-context"
          aria-label={`移除选区引用：${selectionPreview(attachedSelection.original)}`} onClick={() => {
            setAttachedSelection(null);
            if (scope === "auto" || scope === "selection") setScope("none");
            input.current?.focus({ preventScroll: true });
          }}>
          <span>{selectionPreview(attachedSelection.original)}</span><span aria-hidden="true">×</span>
        </Button> : <DropdownMenu.Root>
          <DropdownMenu.Trigger><Button type="button" size="1" color="gray" variant="ghost" className="ai-context-control">
            {chosen === "none" ? "不引用正文" : scopeLabels[chosen]}<ChevronDown size={12} />
          </Button></DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="end" size="1">
            <DropdownMenu.RadioGroup value={scope} onValueChange={value => setScope(value as ScopeChoice)}>
              <DropdownMenu.RadioItem value="auto">自动引用</DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="selection" disabled={!hasSelection}>选区</DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="section">当前章节</DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="document">全文</DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="none">不引用正文</DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>}
      </div>}
      <ComposerPrimitive.Input ref={input} rows={2} aria-label="消息" cancelOnEscape={false}
        disabled={!ready || switching || loading}
        placeholder={rewrite ? "输入选区改写要求" : target.label ? "输入消息" : target.hint ?? "输入消息"}
        unstable_focusOnRunStart={false} unstable_focusOnThreadSwitched={false} />
      <div className="ai-composer-tools">
        {targetPicker}
        <Tool label="AI 设置" color="gray" onClick={onSettings}><Settings size={15} /></Tool>
        {queue && <DropdownMenu.Root>
          <DropdownMenu.Trigger><Tool label="写作工具" className="ai-writing-tools" color="gray" disabled={!enabled || !canEdit}><Sparkles size={15} /></Tool></DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="start" size="1">
            <DropdownMenu.Item onSelect={() => send("summary", aiActions.summary, "")}>生成摘要</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => send("titles", aiActions.titles, "")}>建议标题</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => send("properties", "生成标签、摘要和标题", "给这篇文章生成标签、摘要和标题", false,
              "document", { propertyFields: ["tags", "summary", "title"] })}>生成内容属性</DropdownMenu.Item>
            <DropdownMenu.Separator />
            {rewriteActions.map(([label, prompt]) => <DropdownMenu.Item key={label} disabled={!hasSelection}
              onSelect={() => send("rewrite", label, prompt)}>{label}</DropdownMenu.Item>)}
            <DropdownMenu.Item disabled={!hasSelection} onSelect={chooseRewrite}>自定义改写</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>}
        {running ? <ComposerPrimitive.Cancel asChild><Tool className="ai-send" label="停止生成"><Square size={14} /></Tool></ComposerPrimitive.Cancel>
          : <Button className="ai-send" type="submit" size="1" aria-label="发送消息"
            disabled={!enabled || !draft.trim() || (propertyFields.length > 0
              ? !canEdit : chosen === "selection" && !hasSelection && !attachedSelection)}><ArrowUp size={17} /></Button>}
      </div>
    </ComposerPrimitive.Root>
  </ThreadPrimitive.Root>;
}

function AiMessageTime({ date }: { date: Date }) {
  if (Number.isNaN(date.getTime())) return null;
  return <time className="ai-message-time" dateTime={date.toISOString()} title={date.toLocaleString("zh-CN")}>
    {messageTimeLabel(date)}
  </time>;
}

function AiCopyButton({ text }: { text: string; onError(failure: unknown): void }) {
  const buttons = useButtonFeedback();
  const status = buttons.status("copy");
  return <>
    <Tool label={status === "success" ? "已复制" : status === "error" ? "复制失败" : status === "pending" ? "正在复制" : "复制"}
      color="gray" className="ai-message-copy" {...buttons.props("copy")}
      onClick={() => void buttons.run("copy", () => desktop.copyText(text))}>
      {buttons.icon("copy", <Copy size={14} />, 14)}
    </Tool>
    <VisuallyHidden role="status">{status === "success" ? "已复制" : status === "pending" ? "正在复制" : ""}</VisuallyHidden>
    <ActionError className="ai-copy-feedback" error={buttons.error("copy")} />
  </>;
}

function AiUserMessage({ text, children }: { text: string; children: ReactNode }) {
  const citation = useAuiState(state => state.message.metadata.custom.citation);
  const selectedText = useAuiState(state => {
    const custom = state.message.metadata.custom;
    return (custom.chatSelection as ChatSelection | undefined)?.original
      ?? (custom.action === "rewrite" ? proposalOf(state.thread.messages[state.message.index + 1])?.originalMarkdown : undefined);
  });
  return <>
    {!selectedText && typeof citation === "string" && <span className="ai-user-citation">{citation}</span>}
    {selectedText && <blockquote className="ai-user-quote" aria-label="所选内容" tabIndex={0}>{selectedText}</blockquote>}
    <p className="ai-user-message">{text}</p>
    <div className="button-strip ai-user-actions">
      {children}
    </div>
  </>;
}

function AiMessageActions({ message, queue, targets, stored, progress, canEdit, canRetry, apply, applyProperties, reject, report, retry }: {
  message: Parameters<typeof messageText>[0]; queue?: SaveQueue;
  targets: Map<string, CapturedTarget | null>; stored: ReadonlySet<string>; progress: Record<string, Progress>;
  canEdit: boolean; canRetry: boolean;
  apply(id: string, candidate: string, action: AiAction, proposal?: AiProposal): void;
  applyProperties(proposal: AiPropertyProposal, change: AiPropertyValues): void;
  reject(proposal: AiProposal): Promise<void>; report(failure: unknown): void; retry(): void;
}) {
  const proposal = proposalOf(message);
  const id = String(message.metadata.custom.targetId ?? "");
  const target = targets.get(id);
  const applicable = Boolean(canEdit && target && matchesAiTarget(target, queue));
  const action = useAuiState(state => state.thread.messages[state.message.index - 1]?.metadata.custom.action) as AiAction;
  const propertyProposal = propertyProposalOf(message);
  if (propertyProposal) return <PropertyProposalCard proposal={propertyProposal} current={queue?.snapshot().fields}
    progress={progress[id]} bound={target?.sessionId === queue?.sessionId && queue?.entry.id === propertyProposal.entryId}
    applicable={canEdit && stored.has(id)} canRetry={canRetry && canEdit} retry={retry}
    accept={change => applyProperties(propertyProposal, change)} />;
  if (proposal) return <ProposalCard {...{ proposal, retry }} date={message.createdAt} progress={progress[id]} applicable={applicable && stored.has(id)}
    durable={!targets.has(id) || stored.has(id)} canRetry={canRetry && canEdit}
    accept={() => apply(id, proposal.replacementMarkdown, "rewrite", proposal)}
    reject={() => void reject(proposal)} onError={report} />;
  const candidates = message.metadata.custom.candidates as string[] | undefined;
  if (candidates) return <div className="ai-suggestions">
    {candidates.map((candidate, i) => <div key={i} className="ai-suggestion">
      <p className="ai-candidate-text">{candidate}</p>
      <div className="button-strip">
        <Button size="1" variant="soft" disabled={!applicable || Boolean(progress[id])} onClick={() => apply(id, candidate, action)}>
          {progress[id] === "applied" ? "已应用" : "应用到原稿"}
        </Button>
        {i === candidates.length - 1 && <AiMessageTime date={message.createdAt} />}
        <AiCopyButton text={candidate} onError={report} />
      </div>
    </div>)}
  </div>;
  if (message.role !== "assistant" || message.status.type === "running") return null;
  const text = messageText(message);
  return <div className="button-strip">
    <AiMessageTime date={message.createdAt} />
    {text && <AiCopyButton text={text} onError={report} />}
    {message.status.type === "incomplete" && <Button size="1" variant="soft" color="gray"
      disabled={!canRetry || (action === "rewrite" && !canEdit)} onClick={retry}>重试</Button>}
  </div>;
}

function PropertyProposalCard({ proposal, current, progress, bound, applicable, canRetry, retry, accept }: {
  proposal: AiPropertyProposal; current?: AiPropertyValues; progress?: Progress;
  bound: boolean; applicable: boolean; canRetry: boolean; retry(): void; accept(change: AiPropertyValues): void;
}) {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const { values } = proposal;
  const tags = values.tags?.reduce<string[]>((unique, tag) => addTag(unique, tag, []), []) ?? [];
  const chosenTags = tags.filter(tag => !excluded.has(`tag:${tag}`));
  const selection: AiPropertyValues = {
    ...(chosenTags.length > 0 && { tags: chosenTags }),
    ...(values.title && !excluded.has("title") && { title: values.title }),
    ...(values.summary && !excluded.has("summary") && { summary: values.summary }),
  };
  const disabled = !bound || !applicable || Boolean(progress);
  function choose(key: string, selected: boolean) {
    setExcluded(previous => {
      const next = new Set(previous);
      if (selected) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  return <section className="ai-suggestion ai-property-proposal" aria-label="内容属性提案">
    <strong>内容属性提案</strong>
    {!values.title && <p className="muted-text">{current?.title || untitled}</p>}
    {tags.length > 0 && <fieldset className="ai-property-group">
      <legend>添加标签</legend>
      {tags.map(tag => <label className="ai-property-choice" key={tag}>
        <Checkbox size="1" checked={!excluded.has(`tag:${tag}`)} disabled={disabled}
          onCheckedChange={checked => choose(`tag:${tag}`, checked === true)} />{tag}
      </label>)}
    </fieldset>}
    {(["title", "summary"] as const).map(field => values[field] && <div className="ai-property-group" key={field}>
      <label className="ai-property-choice">
        <Checkbox size="1" checked={!excluded.has(field)} disabled={disabled}
          onCheckedChange={checked => choose(field, checked === true)} />{field === "title" ? "标题" : "摘要"}
      </label>
      {current?.[field] && current[field] !== values[field] && <p className="muted-text">现有{field === "title" ? "标题" : "摘要"}：{current[field]}</p>}
      <p className="ai-property-value">{values[field]}</p>
    </div>)}
    {progress === "conflicted" && <p className="muted-text" role="status">属性已被修改，请重新生成</p>}
    <div className="button-strip ai-proposal-actions">
      {progress === "applied" ? <span className="ai-proposal-status" data-status="applied" role="status"><Check size={14} />已写入内容属性</span>
        : bound ? <Button size="1" variant="soft"
          disabled={!applicable || progress === "saving" || !Object.keys(selection).length} onClick={() => accept(selection)}>
          {progress === "saving" ? "正在保存…" : progress === "saveFailed" ? "重试保存" : "写入内容属性"}
        </Button>
        : <Button size="1" variant="soft" color="gray" disabled={!canRetry} onClick={retry}>重新生成</Button>}
    </div>
  </section>;
}

function ProposalCard({ proposal, date, applicable, durable, progress, canRetry, accept, reject, onError, retry }: {
  proposal: AiProposal; date: Date; applicable: boolean; durable: boolean; progress?: Progress; canRetry: boolean;
  accept(): void; reject(): void; onError(failure: unknown): void; retry(): void;
}) {
  const changes = useMemo(() => diffLines(proposal.originalMarkdown, proposal.replacementMarkdown, { timeout: 100 }),
    [proposal.originalMarkdown, proposal.replacementMarkdown]);
  const status = progress ?? proposal.status;
  const statusText = {
    pending: !durable ? "正在保存提案…" : applicable ? "" : "原选区已失效。可以复制建议，或重新选择文字发起改写。",
    applied: "", rejected: "", conflicted: "原选区已失效",
    saving: "正在保存正文…", saveFailed: "正文已修改，保存失败", recordFailed: "正文已保存，提案状态更新失败",
  }[status];
  const resolvedLabel = status === "applied" ? "已接受" : status === "rejected" ? "已放弃" : undefined;
  return <section className="ai-suggestion" aria-label="修改提案">
    <strong className="ai-proposal-title">
      {resolvedLabel && <span className="ai-proposal-status" data-status={status} role="img" aria-label={resolvedLabel} title={resolvedLabel}>
        {status === "applied" ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
      </span>}
      修改提案
    </strong>
    <p className="muted-text">{proposal.description}</p>
    <details>
      <summary>查看差异</summary>
      {changes ? <pre className="ai-diff" aria-label="原文与建议内容">{changes.map((part, i) => part.added
        ? <ins key={i}>{part.value}</ins> : part.removed ? <del key={i}>{part.value}</del> : <span key={i}>{part.value}</span>)}</pre>
        : <><pre aria-label="原文">{proposal.originalMarkdown}</pre><pre aria-label="建议内容">{proposal.replacementMarkdown}</pre></>}
    </details>
    {statusText && <p className="muted-text" role="status">{statusText}</p>}
    <div className="button-strip ai-proposal-actions">
      {status === "pending" && <Button size="1" variant="soft" disabled={!applicable} onClick={accept}>接受修改</Button>}
      <AiMessageTime date={date} />
      <AiCopyButton text={proposal.replacementMarkdown} onError={onError} />
      <Button size="1" variant="ghost" color="gray" disabled={!canRetry} onClick={retry}>重新生成</Button>
      {status === "pending" && <Button size="1" variant="ghost" color="gray" disabled={!durable} onClick={reject}>放弃</Button>}
    </div>
  </section>;
}

const relativeTime = new Intl.RelativeTimeFormat("zh-CN");

function formatThreadTime(date: Date) {
  const minutes = Math.floor(Math.max(0, Date.now() - date.getTime()) / 60_000);
  if (minutes === 0) return "刚刚";
  if (minutes < 60) return relativeTime.format(-minutes, "minute");
  if (minutes < 1440) return relativeTime.format(-Math.floor(minutes / 60), "hour");
  return relativeTime.format(-Math.floor(minutes / 1440), "day");
}

function ConversationList({ runtime, disabled, select }: {
  runtime: AssistantRuntime; disabled: boolean; select(id: string): void; report(failure: unknown): void;
}) {
  const ids = useAuiState(state => state.threads.archivedThreadIds);
  const [editing, setEditing] = useState("");
  const [deleting, setDeleting] = useState("");
  const buttons = useButtonFeedback();
  if (!ids.length) return <p className="muted-text">暂无对话</p>;
  return <><ActionError error={buttons.error()} /><ul className="ai-thread-list" aria-label="对话记录"><ThreadListPrimitive.Items archived>{({ threadListItem }) => {
    const { id, title, lastMessageAt } = threadListItem;
    const name = title || "新对话";
    const inactive = disabled || Boolean(deleting);
    return <li>
      {editing === id ? <form className="ai-thread-row" onSubmit={event => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("title")).trim();
        if (name) void buttons.run(`rename:${id}`, async () => { await runtime.threads.getItemById(id).rename(name); setEditing(""); });
      }}>
        <TextField.Root size="1" name="title" aria-label="对话名称" defaultValue={title} maxLength={100} autoFocus required />
        <Button size="1" type="submit" {...buttons.props(`rename:${id}`)} loading={buttons.status(`rename:${id}`) === "pending"}>{buttons.label(`rename:${id}`, "保存", "已保存")}</Button>
        <Button size="1" color="gray" variant="ghost" type="button" disabled={buttons.status(`rename:${id}`) === "pending"} onClick={() => setEditing("")}>取消</Button>
      </form> : <ContextMenu.Root>
        <ContextMenu.Trigger disabled={inactive}>
          <div className="ai-thread-row ai-thread-item">
            <button type="button" className="ai-thread-name" disabled={inactive}
              onClick={() => select(id)}>
              <span className="ai-thread-title" title={name}>{name}</span>
              {lastMessageAt && <time className="ai-thread-time" dateTime={lastMessageAt.toISOString()}
                title={lastMessageAt.toLocaleString("zh-CN")}>{formatThreadTime(lastMessageAt)}</time>}
            </button>
            <Tool label={"删除对话：" + name} className="ai-thread-delete" color="gray"
              {...buttons.props(`delete:${id}`, inactive)} onClick={() => {
                void buttons.run(`delete:${id}`, async () => {
                  setDeleting(id);
                  try { await runtime.threads.getItemById(id).delete(); }
                  finally { setDeleting(""); }
                });
              }}>{buttons.icon(`delete:${id}`, <Trash2 size={14} />, 14)}</Tool>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Content size="1">
          <ContextMenu.Item onSelect={() => setEditing(id)}><PencilLine size={15} />重命名</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>}
    </li>;
  }}</ThreadListPrimitive.Items></ul></>;
}

function AiReply({ text, streaming, onError }: { text: string; streaming: boolean; onError(error: unknown): void }) {
  const element = useRef<HTMLDivElement>(null);
  const latest = useRef(text);
  const rendered = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const render = useCallback((text: string) => {
    if (rendered.current === text) return;
    const content = renderMarkdown(text);
    for (const table of content.querySelectorAll("table")) {
      const scroll = document.createElement("div");
      scroll.className = "ai-table-scroll";
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", "表格");
      scroll.tabIndex = 0;
      table.replaceWith(scroll);
      scroll.append(table);
    }
    element.current?.replaceChildren(content);
    rendered.current = text;
  }, []);
  useLayoutEffect(() => {
    latest.current = text;
    if (!streaming || rendered.current === undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      render(text);
    } else if (timer.current === undefined) {
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        render(latest.current);
      }, 80);
    }
  }, [text, streaming, render]);
  useLayoutEffect(() => () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  return <div className="ai-message-markdown" ref={element} onClick={event => {
    const anchor = (event.target as HTMLElement).closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    const url = anchor.getAttribute("href")!;
    if (!url.startsWith("#")) void desktop.openLink(url).catch(onError);
  }} />;
}
