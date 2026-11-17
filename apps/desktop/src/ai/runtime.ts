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

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
type TrackWork = <T>(operation: Promise<T>) => Promise<T>;

export async function* streamAiRun(
  threadId: string, request: AiIntent["request"], abortSignal: AbortSignal, report: (failure: unknown) => void,
  trackWork: TrackWork,
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
    void trackWork(desktop.aiChatStream(threadId, request, event => {
      if (event.type === "started") {
        started = true;
        if (abortSignal.aborted) cancel();
      } else {
        partial += event.text;
        notify();
      }
    })).then(value => { result = { value }; notify(); }, error => { result = { error }; notify(); });
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
    if ("error" in result) {
      const { error } = result;
      // A large Tauri channel event can arrive after the command has settled.
      const finalText = error && typeof error === "object" && "partial" in error && typeof error.partial === "string"
        ? error.partial : partial;
      if (finalText !== shown) yield finalText;
      throw error;
    }
    return result.value;
  } finally {
    abortSignal.removeEventListener("abort", cancel);
  }
}

export type WritingThreads = {
  current?: string;
  items: Map<string, AiThread>;
  history?: Promise<void>;
};

const threadMetadata = (thread: AiThread, current?: string) => ({
  remoteId: thread.id, title: thread.title || undefined, status: thread.id === current ? "regular" as const : "archived" as const,
  lastMessageAt: new Date(thread.updatedAt),
});

function useHistoryAdapters(
  entryId: string | null, write: (threadId: string, item?: AiHistoryItem) => Promise<void>,
  report: (failure: unknown) => void, setUnavailable: (id: string, failed: boolean) => void, trackWork: TrackWork,
) {
  const aui = useAui();
  return useMemo(() => {
    async function load() {
      const { remoteId } = aui.threadListItem.getState();
      if (!remoteId) return { messages: [] };
      try {
        await write(remoteId);
        await desktop.aiThread(entryId, remoteId);
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
    }
    const history: ThreadHistoryAdapter = {
      load: () => trackWork(load()),
      append: item => trackWork(aui.threadListItem.initialize().then(({ remoteId }) => write(remoteId, item))),
    };
    history.update = history.append;
    return { history };
  }, [aui, entryId, report, setUnavailable, trackWork, write]);
}

export function useWritingRuntime(
  entryId: string | null, threads: WritingThreads, report: (failure: unknown) => void, markStored: (id: string) => void,
  setUnavailable: (id: string, failed: boolean) => void, targets: Map<string, CapturedTarget | null>,
  onIdle: () => void,
) {
  const { adapter, trackWork, hasPendingWork } = useMemo(() => {
    const unsaved = new Map<string, Map<string, AiHistoryItem>>();
    let writes = Promise.resolve();
    let working = 0;
    function hasPendingWork() { return working > 0 || unsaved.size > 0; }
    function trackWork<T>(operation: Promise<T>): Promise<T> {
      working++;
      return operation.finally(() => {
        working--;
        if (!hasPendingWork()) onIdle();
      });
    }
    function updateMetadata(id: string, change: Partial<AiThread>) {
      const thread = threads.items.get(id);
      if (thread) threads.items.set(id, { ...thread, ...change });
    }
    function write(id: string, item?: AiHistoryItem) {
      const pending = trackWork(writes.then(async () => {
        let items = unsaved.get(id);
        if (item) {
          if (!items) { items = new Map(); unsaved.set(id, items); }
          items.set(item.message.id, item);
        }
        if (!items) return;
        // Persist missing parents before their replies and later turns.
        for (const [messageId, queued] of items) {
          await desktop.aiSaveMessage(id, queued);
          updateMetadata(id, { updatedAt: Date.now() });
          items.delete(messageId);
          const proposal = proposalOf(queued.message);
          if (proposal) markStored(proposal.id);
        }
        unsaved.delete(id);
      }));
      writes = pending.catch(report);
      return pending;
    }
    async function tracked<T>(operation: Promise<T>): Promise<T> {
      try { return await trackWork(operation); }
      catch (failure) { report(failure); throw failure; }
    }
    const adapter: RemoteThreadListAdapter = {
      async list() {
        const items = [...threads.items.values()].sort((left, right) => right.updatedAt - left.updatedAt);
        return { threads: items.map(thread => threadMetadata(thread, threads.current)) };
      },
      async fetch(id) {
        if (!threads.items.has(id)) throw new Error("找不到该对话");
        return threadMetadata(await tracked(desktop.aiThread(entryId, id)), threads.current);
      },
      async initialize() {
        const remoteId = await tracked(desktop.aiCreateThread(entryId));
        threads.current = remoteId;
        threads.items.set(remoteId, { id: remoteId, title: "", updatedAt: Date.now(), archived: false });
        return { remoteId };
      },
      async rename(id, title) {
        await tracked(desktop.aiUpdateThread(id, { title }));
        updateMetadata(id, { title });
      },
      async archive(id) {
        await write(id);
        await tracked(desktop.aiUpdateThread(id, { archived: true }));
        if (threads.current === id) threads.current = undefined;
      },
      async unarchive(id) {
        await writes;
        for (const pendingId of unsaved.keys()) await write(pendingId);
        await tracked(desktop.aiUpdateThread(id, { archived: false }));
        threads.current = id;
      },
      async delete(id) {
        await tracked(desktop.aiDeleteThread(id));
        threads.items.delete(id);
        if (threads.current === id) threads.current = undefined;
        unsaved.delete(id);
      },
      async generateTitle(id, messages) {
        const first = messages.find(message => message.role === "user");
        const title = Array.from(first ? messageText(first).trim().split(/\r?\n/, 1)[0] : "新对话").slice(0, 36).join("") || "新对话";
        await tracked(desktop.aiUpdateThread(id, { title }));
        updateMetadata(id, { title });
        return createAssistantStream(controller => controller.appendText(title));
      },
      unstable_useAdapters: () => useHistoryAdapters(entryId, write, report, setUnavailable, trackWork),
    };
    return { adapter, trackWork, hasPendingWork };
  }, [entryId, threads, markStored, report, setUnavailable, onIdle]);

  const runtime = useRemoteThreadListRuntime({
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
            const stream = streamAiRun(remoteId, input, abortSignal, report, trackWork);
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
              if (!context) throw new Error("请在正文中选中文字");
              const { localRevision, from, to, originalSlice } = context;
              const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(originalSlice));
              const originalSliceHash = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
              const proposal: AiProposal = {
                id: request.id, entryId: request.entryId, baseVersion: intent.baseVersion, localRevision, from, to,
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
      }), [aui, report, targets, trackWork]);
      return useLocalRuntime(model);
    },
  });
  const loadHistory = async () => {
    threads.history ??= desktop.aiThreads(entryId).then(items => {
      for (const thread of items) {
        if (!threads.items.has(thread.id)) threads.items.set(thread.id, thread);
      }
    }).catch(failure => {
      threads.history = undefined;
      throw failure;
    });
    await threads.history;
    await runtime.threads.reload();
  };
  return { runtime, loadHistory, trackWork, hasPendingWork };
}
