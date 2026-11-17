import type { AiContextScope, AiEditorContext, MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { AiPropertyField, AiRequest, AiSelection, AiTurn } from "../desktop";
import type { SaveQueue } from "../editor/save-queue";
import type { ThreadMessage } from "@assistant-ui/react";

export const aiActions = { summary: "生成摘要", titles: "建议标题", rewrite: "改写选区" } as const;
export const scopeLabels = { selection: "选区", section: "当前章节", document: "全文" } as const;
export type AiAction = keyof typeof aiActions | "chat" | "properties";
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

export function requestedProperties(prompt: string): AiPropertyField[] {
  const write = /补(?:上|充|齐|全|写|一下|个|标签|摘要|标题)|填(?:上|进|入|写|充)|写入|写到|添加|加(?:上|个|些|几个|标签)|改(?:个|一下|为)|修改|更新|更换|换个|设置|设为|替换/;
  const generate = /(?:给|为|替|帮).{0,36}(?:生成|写(?:个|一段|一个)|(?:起|拟)(?:个|一个))/;
  const asksHow = /^(?:(?:请问|你觉得|你知道|(?:请|能)告诉我|我想知道)\s*)?(?:我该|我应该)?(?:怎么|如何|怎样)/;
  const negates = /不要|不用|无需|不必|^(?:请)?别/;
  const clauses = prompt.split(/[，,。；;\n]|但是?|不过/).map(part => part.trim())
    .filter(part => !asksHow.test(part) && !negates.test(part));
  if (!clauses.some(part => write.test(part) || generate.test(part))) return [];
  const request = clauses.join(" ");
  const fields: AiPropertyField[] = [];
  if (/标签|\btags?\b/i.test(request)) fields.push("tags");
  if (/摘要|简介|\bsummary\b/i.test(request)) fields.push("summary");
  if (/标题|\btitle\b/i.test(request)) fields.push("title");
  return fields;
}

export function captureAiIntent(operation: AiAction, prompt: string, scope: ScopeChoice,
  queue?: SaveQueue, editor?: MarkdownEditorHandle, selection?: AiSelection,
  { original, chatSelection, propertyFields, tagSuggestions = [] }: {
    original?: AiEditorContext; chatSelection?: ChatSelection; propertyFields?: AiPropertyField[]; tagSuggestions?: string[];
  } = {}): AiIntent {
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
  const searchText = propertyFields?.includes("tags") ? `${title}\n${text}\n${prompt}`.toLowerCase() : "";
  const properties = operation === "properties" && propertyFields?.length ? {
    fields: propertyFields,
    tagSuggestions: propertyFields.includes("tags")
      ? [...new Set([...(snapshot?.fields.tags ?? []), ...tagSuggestions.filter(tag => tag && searchText.includes(tag.toLowerCase()))])]
        .filter(tag => bytes(tag) <= 160).slice(0, 64) : [],
  } : undefined;
  if (operation === "properties" && !properties) throw new Error("请指定要填写的内容属性");
  if (bytes(title + text + prompt) + (meta?.headingPath.reduce((sum, heading) => sum + bytes(heading), 0) ?? 0)
    + (properties?.tagSuggestions.reduce((sum, tag) => sum + bytes(tag), 0) ?? 0) > limit) {
    throw new Error("引用内容过长，请缩小范围");
  }
  const request: AiRequest = operation === "chat" || operation === "properties"
    ? { ...base, entryId, operation: "chat", history: [], ...(meta && { context: meta }), ...(properties && { properties }) }
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
