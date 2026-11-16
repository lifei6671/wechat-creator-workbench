import { useMemo } from "react";
import {
  useAui, useLocalRuntime, useRemoteThreadListRuntime,
  type ChatModelAdapter, type RemoteThreadListAdapter, type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import { desktop, errorMessage, type AiHistoryItem, type AiResult, type AiThread } from "../desktop";
import { chatHistory, messageText, type AiIntent, type CapturedTarget } from "./context";
import type { AiProposal } from "./proposals";

export function proposalOf(message: AiHistoryItem["message"] | undefined): AiProposal | undefined {
  return message?.metadata.custom.proposal as AiProposal | undefined;
}

// The sidebar remounts when the document changes. Keep visibility for the lifetime of this app window.
const currentRunThreads = new Set<string>();
const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

export async function* streamAiRun(
  threadId: string, request: AiIntent["request"], abortSignal: AbortSignal, report: (failure: unknown) => void,
) {
  let started = false;
  let partial = "";
  let result: { value: AiResult } | { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const cancel = () => {
    if (started) void desktop.aiCancel(request.id).catch(report);
  };
  if (abortSignal.aborted) return;
  abortSignal.addEventListener("abort", cancel, { once: true });
  try {
    void desktop.aiChatStream(threadId, request, event => {
      if (event.type === "started") {
        started = true;
        if (abortSignal.aborted) cancel();
      } else {
        partial += event.text;
        notify();
      }
    }).then(value => { result = { value }; notify(); }, error => { result = { error }; notify(); });
    let shown = "";
    while (!result) {
      if (!abortSignal.aborted && partial !== shown) {
        shown = partial;
        yield shown;
      } else {
        await new Promise<void>(resolve => { wake = resolve; });
      }
    }
    if (abortSignal.aborted) return;
    if ("error" in result) throw result.error;
    return result.value;
  } finally {
    abortSignal.removeEventListener("abort", cancel);
  }
}

const threadMetadata = (thread: AiThread) => ({
  remoteId: thread.id, title: thread.title || undefined, status: thread.archived ? "archived" as const : "regular" as const,
  lastMessageAt: new Date(thread.updatedAt),
});

function useHistoryAdapters(
  write: (threadId: string, item?: AiHistoryItem) => Promise<void>,
  report: (failure: unknown) => void, setUnavailable: (id: string, failed: boolean) => void,
) {
  const aui = useAui();
  return useMemo(() => {
    const history: ThreadHistoryAdapter = {
      async load() {
        const { remoteId } = aui.threadListItem.getState();
        if (!remoteId) return { messages: [] };
        try {
          await write(remoteId);
          const rows = await desktop.aiMessages(remoteId);
          setUnavailable(remoteId, false);
          return {
            headId: rows.at(-1)?.message.id ?? null,
            messages: rows.map(({ message, parentId }) => ({
              parentId,
              message: { ...message, createdAt: new Date(message.createdAt) },
            })),
          };
        } catch (failure) {
          setUnavailable(remoteId, true);
          report(failure);
          throw failure;
        }
      },
      async append(item) {
        const { remoteId } = await aui.threadListItem.initialize();
        await write(remoteId, item);
      },
    };
    history.update = history.append;
    return { history };
  }, [aui, report, setUnavailable, write]);
}

export function useWritingRuntime(
  entryId: string | null, report: (failure: unknown) => void, markStored: (id: string) => void,
  setUnavailable: (id: string, failed: boolean) => void, targets: Map<string, CapturedTarget | null>,
) {
  const adapter = useMemo<RemoteThreadListAdapter>(() => {
    const unsaved = new Map<string, Map<string, AiHistoryItem>>();
    let writes = Promise.resolve();
    function write(id: string, item?: AiHistoryItem) {
      const pending = writes.then(async () => {
        let items = unsaved.get(id);
        if (item) {
          if (!items) { items = new Map(); unsaved.set(id, items); }
          items.set(item.message.id, item);
        }
        if (!items) return;
        // Persist missing parents before their replies and later turns.
        for (const [messageId, queued] of items) {
          await desktop.aiSaveMessage(id, queued);
          items.delete(messageId);
          const proposal = proposalOf(queued.message);
          if (proposal) markStored(proposal.id);
        }
        unsaved.delete(id);
      });
      writes = pending.catch(report);
      return pending;
    }
    async function tracked<T>(operation: Promise<T>): Promise<T> {
      try { return await operation; }
      catch (failure) { report(failure); throw failure; }
    }
    return {
      async list() {
        const threads = await tracked(desktop.aiThreads(entryId));
        return { threads: threads.filter(thread => currentRunThreads.has(thread.id)).map(threadMetadata) };
      },
      async fetch(id) {
        if (!currentRunThreads.has(id)) throw new Error("找不到该对话");
        return threadMetadata(await tracked(desktop.aiThread(entryId, id)));
      },
      async initialize() {
        const remoteId = await tracked(desktop.aiCreateThread(entryId));
        currentRunThreads.add(remoteId);
        return { remoteId };
      },
      rename: (id, title) => tracked(desktop.aiUpdateThread(id, { title })),
      async archive(id) {
        await write(id);
        await tracked(desktop.aiUpdateThread(id, { archived: true }));
      },
      async unarchive(id) {
        await writes;
        for (const pendingId of unsaved.keys()) await write(pendingId);
        await tracked(desktop.aiUpdateThread(id, { archived: false }));
      },
      async delete(id) {
        await tracked(desktop.aiDeleteThread(id));
        currentRunThreads.delete(id);
        unsaved.delete(id);
      },
      async generateTitle(id, messages) {
        const first = messages.find(message => message.role === "user");
        const title = Array.from(first ? messageText(first).trim().split(/\r?\n/, 1)[0] : "新对话").slice(0, 36).join("") || "新对话";
        await tracked(desktop.aiUpdateThread(id, { title }));
        return createAssistantStream(controller => controller.appendText(title));
      },
      unstable_useAdapters: () => useHistoryAdapters(write, report, setUnavailable),
    };
  }, [entryId, markStored, report, setUnavailable]);

  return useRemoteThreadListRuntime({
    adapter,
    runtimeHook: () => {
      const aui = useAui();
      const model = useMemo<ChatModelAdapter>(() => ({
        async *run({ messages, abortSignal, runConfig }) {
          const intent = runConfig.custom?.intent as AiIntent | undefined;
          if (!intent) throw new Error("请重新发送消息");
          const { request, target } = intent;
          const input = request.operation === "chat" ? { ...request, history: chatHistory(messages, request) } : request;
          try {
            const { remoteId } = await aui.threadListItem.initialize();
            const stream = streamAiRun(remoteId, input, abortSignal, report);
            let next = await stream.next();
            try {
              while (!next.done) {
                yield reply(next.value);
                next = await stream.next();
              }
            } finally {
              await stream.return(undefined);
            }
            const result = next.value;
            if (!result || abortSignal.aborted) return;
            if ("reply" in result) {
              yield reply(result.reply);
            } else if (request.operation === "rewrite") {
              const context = target?.context;
              const source = context ? {
                baseVersion: intent.baseVersion, localRevision: context.localRevision, from: context.from, to: context.to,
                originalSliceHash: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(context.originalSlice)))].
                  map(byte => byte.toString(16).padStart(2, "0")).join(""),
              } : intent.previousProposal;
              if (!source) throw new Error("请在正文中选中文字");
              const { baseVersion, localRevision, from, to, originalSliceHash } = source;
              const proposal: AiProposal = {
                id: request.id, entryId: request.entryId, baseVersion, localRevision, from, to,
                originalMarkdown: request.text, originalSliceHash,
                replacementMarkdown: result.candidates[0], description: result.description || "选区改写", status: "pending",
              };
              targets.set(request.id, target);
              yield { content: [], metadata: { custom: { proposal, targetId: request.id } } };
            } else {
              if (target) targets.set(request.id, target);
              yield { content: [], metadata: { custom: { candidates: result.candidates, targetId: request.id } } };
            }
          } catch (failure) {
            yield { status: { type: "incomplete", reason: "error", error: errorMessage(failure) } };
          }
        },
      }), [aui]);
      return useLocalRuntime(model);
    },
  });
}
