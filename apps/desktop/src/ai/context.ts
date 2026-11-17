import type { AiContextScope, AiEditorContext, MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { AiRequest, AiSelection, AiTurn } from "../desktop";
import type { SaveQueue } from "../editor/save-queue";
import type { ThreadMessage } from "@assistant-ui/react";

export const aiActions = { summary: "生成摘要", titles: "建议标题", rewrite: "改写选区" } as const;
export const scopeLabels = { selection: "选区", section: "当前章节", document: "全文" } as const;
export type AiAction = keyof typeof aiActions | "chat";
export type ScopeChoice = AiContextScope | "auto" | "none";
export type ChatSelection = Pick<AiEditorContext, "original" | "headingPath">;
export type CapturedTarget = { sessionId: number; revision: number; context: AiEditorContext | null };
export type AiIntent = {
  request: AiRequest; target: CapturedTarget | null; baseVersion: number; label?: string; scope: ScopeChoice;
  chatSelection?: ChatSelection;
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const limit = 256 * 1024;

export function captureAiIntent(operation: AiAction, prompt: string, scope: ScopeChoice,
  queue?: SaveQueue, editor?: MarkdownEditorHandle, selection?: AiSelection,
  { original, chatSelection }: { original?: AiEditorContext; chatSelection?: ChatSelection } = {}): AiIntent {
  const snapshot = queue?.snapshot();
  const entryId = queue?.entry.id ?? null;
  const requested = operation === "rewrite" ? "selection" : operation === "chat" ? scope : "document";
  const editorContext = original ?? (chatSelection || !snapshot || !editor || requested === "none" ? null : requested === "auto"
    ? editor.captureContext("selection") ?? editor.captureContext("section")
    : editor.captureContext(requested));
  const quotedSelection = chatSelection ?? (editorContext?.scope === "selection"
    ? { original: editorContext.original, headingPath: editorContext.headingPath }
    : undefined);
  const context = quotedSelection ? { ...quotedSelection, scope: "selection" as const } : editorContext;
  if (requested === "selection" && !context) throw new Error("请在正文中选中文字");
  const title = context ? snapshot?.fields.title ?? "" : "";
  const text = context?.original ?? "";
  if (operation !== "chat" && (!entryId || !text.trim())) throw new Error("请先填写正文");
  const meta = context && { scope: context.scope, headingPath: context.headingPath };
  const base = { id: crypto.randomUUID(), title, text, prompt, ...selection };
  if (bytes(title + text + prompt) + (meta?.headingPath.reduce((sum, heading) => sum + bytes(heading), 0) ?? 0) > limit) {
    throw new Error("引用内容过长，请缩小范围");
  }
  const request: AiRequest = operation === "chat"
    ? { ...base, entryId, operation, history: [], ...(meta && { context: meta }) }
    : { ...base, entryId: entryId!, operation };
  return {
    request, baseVersion: snapshot?.version ?? 0,
    target: operation !== "chat" && queue && editor && snapshot && (operation !== "rewrite" || editorContext)
      ? { sessionId: queue.sessionId, revision: snapshot.revision, context: operation === "rewrite" ? editorContext : null } : null,
    label: context ? scopeLabels[context.scope] : queue ? "不引用正文" : undefined,
    scope: context?.scope ?? "none",
    chatSelection: quotedSelection,
  };
}

export function messageText(message: ThreadMessage) {
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

export function chatHistory(messages: readonly ThreadMessage[], request: Extract<AiRequest, { operation: "chat" }>): AiTurn[] {
  const history: AiTurn[] = [];
  const headings = request.context?.headingPath.reduce((sum, heading) => sum + bytes(heading), 0) ?? 0;
  let budget = Math.min(48 * 1024, limit - bytes(request.title + request.text + request.prompt) - headings);
  for (let i = messages.length - 2; i > 0 && history.length < 8; i--) {
    const message = messages[i], parent = messages[i - 1];
    if (message.role !== "assistant" || message.status.type !== "complete" || parent.role !== "user") continue;
    if (parent.metadata.custom.action !== "chat") continue;
    const user = messageText(parent), assistant = messageText(message);
    if (!user || !assistant) continue;
    budget -= bytes(user) + bytes(assistant);
    if (budget < 0) break;
    history.unshift({ user, assistant });
  }
  return history;
}

export function matchesAiTarget(target: CapturedTarget, queue?: SaveQueue) {
  return queue?.sessionId === target.sessionId && queue.entry.deletedAt === null
    && queue.snapshot().revision === target.revision;
}
