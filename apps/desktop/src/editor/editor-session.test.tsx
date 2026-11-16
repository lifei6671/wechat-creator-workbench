// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EditorView } from "@milkdown/kit/prose/view";
import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor, type EditorCommand, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { Entry } from "../../../../packages/shared-types";
import { parseWechat } from "../../../../packages/wechat-renderer";
import { desktop, type AiHistoryItem, type AiStreamEvent, type AiThread } from "../desktop";
import { attachClipboard } from "./clipboard";
import { SaveQueue } from "./save-queue";
import { captureAiIntent, matchesAiTarget, type ChatSelection } from "../ai/context";
import { messageTimeLabel } from "../labels";
import { AiPanel } from "../workspace/AiPanel";
import formatFixtures from "../../../../fixtures/wechat-format.json";

const nativeHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // The installed Milkdown block provider uses browser hit testing on pointer movement.
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  // jsdom lacks the Range geometry used by ProseMirror when undo and commands scroll.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [new DOMRect()] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (nativeHitTest) Object.defineProperty(document, "elementFromPoint", nativeHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

async function select(element: HTMLElement, from: number, to: number, handle: MarkdownEditorHandle) {
  const text = [...element.querySelector("p")!.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!;
  handle.focus();
  document.getSelection()!.setBaseAndExtent(text, from, text, to);
  document.dispatchEvent(new Event("selectionchange"));
  await vi.waitFor(() => expect(handle.target().original).toBe(text.textContent!.slice(from, to)));
}

it("keeps unhandled Tab in editable body text while leaving reverse navigation available", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const render = (readOnly: boolean) => flushSync(() => root.render(<MarkdownEditor
    entryId="body-tab" value="普通正文" readOnly={readOnly} onChange={onChange} onBlur={() => {}}
    ref={value => { handle = value; }} />));
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const body = container.querySelector<HTMLElement>(".ProseMirror")!;
    handle!.focus();
    const pressTab = (shiftKey = false) => body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", shiftKey, bubbles: true, cancelable: true,
    }));
    expect(pressTab()).toBe(false);
    expect(document.activeElement).toBe(body);
    expect(onChange).not.toHaveBeenCalled();
    expect(pressTab(true)).toBe(true);
    render(true);
    expect(pressTab()).toBe(true);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("filters and runs editor slash commands without consuming IME confirmation", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let editor: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="slash" value="" active readOnly={false}
      ref={handle => { editor = handle; }} onChange={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(editor).not.toBeNull());
    editor!.focus();
    editor!.insert("/h2");
    const menu = container.querySelector<HTMLElement>(".rich-slash-menu")!;
    const editorDom = container.querySelector(".ProseMirror")!;
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect([...menu.querySelectorAll("button")].map(button => button.textContent)).toEqual([
      expect.stringContaining("标题 2"),
    ]);
    const key = (event: KeyboardEventInit) => editorDom.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...event }));
    key({ key: "Enter", isComposing: true });
    expect(editorDom.textContent).toContain("/h2");
    expect(menu.hidden).toBe(false);
    expect(key({ key: "Enter" })).toBe(false);
    editor!.insert("小标题");
    expect(editorDom.querySelector("h2")?.textContent).toContain("小标题");
    expect(menu.hidden).toBe(true);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("routes an image link inserted from the slash menu through the configured image storage", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const source = "https://example.com/image.png";
  const localizeImageLink = vi.fn().mockResolvedValue("asset://uploaded");
  const onChange = vi.fn();
  let editor: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="slash-image" value="" active readOnly={false}
      ref={handle => { editor = handle; }} localizeImageLink={localizeImageLink} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(editor).not.toBeNull());
    editor!.focus();
    editor!.insert("/图片");
    const menu = container.querySelector<HTMLElement>(".rich-slash-menu")!;
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    const item = menu.querySelector<HTMLButtonElement>(".rich-slash-item")!;
    expect(item.textContent).toContain("图片");
    item.click();
    menu.querySelector<HTMLInputElement>("input[type=url]")!.value = source;
    menu.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onChange.mock.lastCall?.[2]).toContain("asset://uploaded"));
    expect(localizeImageLink).toHaveBeenCalledExactlyOnceWith(source);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("formats chat timestamps by local calendar days", () => {
  const now = new Date(2026, 10, 16, 20);
  expect(messageTimeLabel(new Date(2026, 10, 16, 18, 10), now)).toBe("18:10");
  expect(messageTimeLabel(new Date(2026, 10, 15, 18, 10), now)).toBe("昨天 18:10");
  expect(messageTimeLabel(new Date(2026, 10, 14, 23, 59), now)).toBe("前天");
  expect(messageTimeLabel(new Date(2026, 10, 6, 15, 10), now)).toBe("11.06 15:10");
  expect(messageTimeLabel(new Date(2026, 11, 31, 0, 7), new Date(2027, 0, 1))).toBe("昨天 00:07");
});

it("binds an AI rewrite to the original session and range and gives it a separate undo step", async () => {
  const entry: Entry = { id: "draft", kind: "article", title: "标题",
    contentMd: "初稿 第一段 第二段\n\n![图](https://example.com/image.png)\n\n| 标题 | 链接 |\n| --- | --- |\n| 示例 | [参考](https://example.com) |\n\n~~~js\nconst value = 1;\n~~~\n\n补充[^note]\n\n[^note]: 脚注",
    status: "draft", categoryId: null,
    tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [] };
  const createQueue = (entry: Entry) => new SaveQueue(entry, vi.fn().mockResolvedValue({ version: 2 }), () => {});
  const original = createQueue(entry);
  const other = createQueue({ ...entry, id: "other" });
  const editorContainer = document.createElement("div");
  const root = createRoot(editorContainer);
  const handles = new Map<string, MarkdownEditorHandle>();
  document.body.append(editorContainer);
  flushSync(() => root.render([original, other].map(queue => <MarkdownEditor key={queue.sessionId}
    ref={instance => { if (instance) handles.set(queue.entry.id, instance); }} entryId={queue.entry.id}
    value={queue.entry.contentMd} readOnly={false} onChange={(_id, _revision, contentMd) => queue.edit({ contentMd })}
    onBlur={() => {}} />)));
  try {
    await vi.waitFor(() => expect(handles.size).toBe(2));
    const editor = editorContainer.querySelector<HTMLElement>(".ProseMirror")!;
    const handle = handles.get(entry.id)!;
    handle.insert("!");
    await select(editor, 4, 7, handle);
    const task = captureAiIntent("rewrite", "润色", "auto", original, handle);
    expect(task.request.text).toBe("第一段");
    expect(matchesAiTarget(task.target!, createQueue(entry))).toBe(false);
    expect(matchesAiTarget(task.target!, other)).toBe(false);
    await select(editor, 8, 11, handle);
    const before = original.snapshot().fields.contentMd;
    expect(matchesAiTarget(task.target!, original)).toBe(true);
    expect(handles.get(other.entry.id)!.replaceTarget(task.target!.context!, "新段落")).toBe(false);
    expect(handle.replaceTarget(task.target!.context!, "第一段\n\n## 标题")).toBe(false);
    expect(original.snapshot().fields.contentMd).toBe(before);
    expect(handle.replaceTarget(task.target!.context!, "新段落")).toBe(true);
    expect(original.snapshot().fields.contentMd).toBe(before.replace("第一段", "新段落"));
    expect(matchesAiTarget(task.target!, original)).toBe(false);
    handle.command("undo");
    expect(original.snapshot().fields.contentMd).toBe(before);
  } finally {
    original.dispose();
    other.dispose();
    flushSync(() => root.unmount());
    editorContainer.remove();
  }
});

it("streams chat across article switches and restores chat and selected-range proposals", { timeout: 10_000 }, async () => {
  const entry: Entry = { id: "chat-draft", kind: "article", title: "标题", contentMd: "开头\n\n## 一\n\n这段正文\n\n## 二\n\n其他段落",
    status: "draft", categoryId: null, tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "",
    version: 1, updatedAt: 0, deletedAt: null, links: [] };
  const commit = vi.fn(async (_id: string, version: number) => ({ version: version + 1 }));
  const queue = new SaveQueue(entry, commit, () => {});
  const other = new SaveQueue({ ...entry, id: "another" }, commit, () => {});
  const threads = new Map<string, AiThread>();
  const messages = new Map<string, AiHistoryItem[]>();
  const entryThreads = new Map<string | null, string[]>();
  const scope = vi.spyOn(desktop, "aiThreads").mockImplementation(async id => (entryThreads.get(id) ?? [])
    .map(thread => threads.get(thread)!).filter(thread => !thread.archived || messages.get(thread.id)?.length));
  vi.spyOn(desktop, "aiCreateThread").mockImplementation(async entryId => {
    const existing = entryThreads.get(entryId) ?? [];
    const id = "thread-" + entryId + (existing.length ? "-" + existing.length : "");
    for (const otherId of existing) threads.get(otherId)!.archived = true;
    entryThreads.set(entryId, [id, ...existing]);
    threads.set(id, { id, title: "", archived: false, updatedAt: Date.now() });
    messages.set(id, []);
    return id;
  });
  vi.spyOn(desktop, "aiThread").mockImplementation(async (_entryId, id) => threads.get(id)!);
  const removeThread = vi.spyOn(desktop, "aiDeleteThread").mockImplementation(async id => {
    threads.delete(id);
    messages.delete(id);
    for (const [entry, ids] of entryThreads) entryThreads.set(entry, ids.filter(thread => thread !== id));
  });
  const updateThread = vi.spyOn(desktop, "aiUpdateThread").mockImplementation(async (id, change) => {
    if (change.archived === false) {
      const siblings = [...entryThreads.values()].find(ids => ids.includes(id))!;
      for (const otherId of siblings) threads.get(otherId)!.archived = otherId !== id;
    }
    Object.assign(threads.get(id)!, change);
  });
  vi.spyOn(desktop, "aiMessages").mockImplementation(async id => structuredClone(messages.get(id) ?? []));
  let interruptedWrite = false;
  let blockedThreadWrites: string | undefined;
  const saveMessage = vi.spyOn(desktop, "aiSaveMessage").mockImplementation(async (thread, item) => {
    if (!interruptedWrite || thread === blockedThreadWrites) {
      interruptedWrite = true;
      throw new Error("对话写入暂时失败");
    }
    const saved = messages.get(thread)!;
    if (item.parentId) expect(saved.some(row => row.message.id === item.parentId)).toBe(true);
    saved.push(structuredClone({ parentId: item.parentId, message: item.message }));
  });
  const updateProposal = vi.spyOn(desktop, "aiProposalStatus").mockImplementation(async (id, status) => {
    for (const rows of messages.values()) for (const row of rows) {
      const proposal = row.message.metadata.custom.proposal as { id: string; status: string } | undefined;
      if (proposal?.id === id) proposal.status = status;
    }
  });
  let emit!: (event: AiStreamEvent) => void;
  let finish!: (reply: { reply: string }) => void;
  let fail!: (error: unknown) => void;
  const cancel = vi.spyOn(desktop, "aiCancel").mockImplementation(async () => fail({ code: "AI_CANCELLED", message: "生成已取消" }));
  const generate = vi.spyOn(desktop, "aiChatStream").mockImplementation((_id, request, onEvent) => {
    if (request.operation === "rewrite") {
      onEvent({ type: "started" });
      return Promise.resolve({ candidates: ["改写稿"], description: "精简措辞" });
    }
    emit = onEvent;
    return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const digest = Object.getOwnPropertyDescriptor(crypto, "subtle");
  Object.defineProperty(crypto, "subtle", { configurable: true, value: webcrypto.subtle });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const editors = new Map<string, MarkdownEditorHandle>();
  const click = (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>(".ai-session:not([hidden]) button")]
      .find(node => node.getAttribute("aria-label") === label || node.textContent === label
        || node.querySelector(".ai-thread-title")?.textContent === label);
    expect(button, label).toBeDefined();
    expect(button!.disabled, label).toBe(false);
    flushSync(() => button!.click());
  };
  const send = async (text: string) => {
    const field = await vi.waitFor(() => {
      const input = container.querySelector<HTMLTextAreaElement>(".ai-session:not([hidden]) textarea[aria-label='消息']");
      expect(input?.disabled, "输入 " + text).toBe(false);
      return input!;
    });
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    flushSync(() => field.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>(".ai-session:not([hidden]) button[aria-label='发送消息']")?.disabled,
      "发送 " + text + " 时：" + field.value + " / " + activePanel().textContent).toBe(false));
    click("发送消息");
  };
  const render = (current: SaveQueue, key: number, selectionRequest?: ChatSelection) => flushSync(() => root.render(<Theme>
    {[queue, other].map(origin => <MarkdownEditor key={origin.sessionId}
      ref={value => { if (value) editors.set(origin.entry.id, value); }} entryId={origin.entry.id} value={origin.entry.contentMd}
      active={current === origin} readOnly={false} onChange={(_id, _revision, contentMd) => origin.edit({ contentMd })} onBlur={() => {}} />)}
    <AiPanel key={key} open queue={current} editor={editors.get(current.entry.id)} target={{ label: "测试模型" }} targetPicker={null}
      canChat canEdit selectionRequest={selectionRequest} canWrite={target => target === current} onClose={() => {}} onSettings={() => {}} />
  </Theme>));
  const activePanel = () => container.querySelector(".ai-session:not([hidden])")!;
  const chooseRewrite = () => {
    const tools = activePanel().querySelector('[aria-label="写作工具"]')!;
    flushSync(() => tools.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "自定义改写");
    expect(item).toBeDefined();
    flushSync(() => item!.click());
  };
  try {
    render(queue, 1);
    await vi.waitFor(() => expect(editors.size).toBe(2));
    render(queue, 1);
    const editor = editors.get(entry.id)!;
    const selectRange = async (from: number, to: number) => {
      const line = container.querySelectorAll(".ProseMirror p")[1].firstChild!;
      editor.focus();
      document.getSelection()!.setBaseAndExtent(line, from, line, to);
      document.dispatchEvent(new Event("selectionchange"));
      await vi.waitFor(() => expect(editor.target().original).toBe(line.textContent!.slice(from, to)));
    };
    await selectRange(1, 1);
    expect(editor.captureContext("section")).toMatchObject({ headingPath: ["一"], original: "## 一\n\n这段正文" });
    await send("怎么改？");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0][1]).toMatchObject({ operation: "chat", text: "## 一\n\n这段正文",
      context: { scope: "section", headingPath: ["一"] } });
    emit({ type: "started" });
    emit({ type: "delta", text: "可以加" });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("可以加"));
    render(other, 1);
    expect(activePanel().textContent).not.toContain("可以加");
    finish({ reply: "可以加一条例子。" });
    await vi.waitFor(() => expect(messages.get("thread-" + entry.id)).toHaveLength(2));
    render(queue, 1);
    await vi.waitFor(() => expect(activePanel().textContent).toContain("可以加一条例子。"));

    await send("举什么例子？");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][1]).toMatchObject({ history: [{ user: "怎么改？", assistant: "可以加一条例子。" }] });
    click("停止生成");
    emit({ type: "started" });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(generate.mock.calls[1][1].id));
    await vi.waitFor(() => expect(activePanel().textContent).toContain("已停止生成"));

    await selectRange(0, 4);
    chooseRewrite();
    const rewriteChip = () => activePanel().querySelector('button[aria-label^="退出改写选区"]');
    await vi.waitFor(() => expect(rewriteChip()?.textContent).toBe("这段正文×"));
    await selectRange(0, 2);
    await vi.waitFor(() => expect(rewriteChip()?.textContent).toBe("这段×"));
    await selectRange(0, 4);
    await send("只改选区");
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "rewrite", text: "这段正文" }));
    await vi.waitFor(() => expect(activePanel().textContent).toContain("精简措辞"));
    const rewriteQuote = activePanel().querySelector('blockquote[aria-label="所选内容"]');
    expect(rewriteQuote?.textContent).toBe("这段正文");
    expect(rewriteQuote?.nextElementSibling?.textContent).toBe("只改选区");
    expect(rewriteQuote?.parentElement?.querySelector(".ai-user-actions")?.textContent).not.toContain("选区");
    expect(queue.snapshot().fields.contentMd).toBe(entry.contentMd);
    commit.mockRejectedValueOnce(new Error("磁盘写入失败"));
    await vi.waitFor(() => expect([...activePanel().querySelectorAll("button")].find(node => node.textContent === "接受修改")?.disabled).toBe(false));
    click("接受修改");
    expect(queue.snapshot().fields.contentMd).toBe(entry.contentMd.replace("这段正文", "改写稿"));
    expect(updateProposal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(activePanel().textContent).toContain("正文已修改，保存失败"), { timeout: 2500 });
    expect(queue.snapshot().fields.contentMd).toContain("改写稿");
    expect(updateProposal).not.toHaveBeenCalled();
    await queue.flush({ retry: true });
    await vi.waitFor(() => expect(updateProposal).toHaveBeenCalledWith(generate.mock.calls.at(-1)![1].id, "applied"));
    expect(commit).toHaveBeenLastCalledWith(entry.id, 1, expect.objectContaining({ contentMd: expect.stringContaining("改写稿") }), "auto");
    editor.command("undo");
    expect(queue.snapshot().fields.contentMd).toBe(entry.contentMd);

    await selectRange(0, 4);
    chooseRewrite();
    await send("再拟一稿");
    await vi.waitFor(() => expect(messages.get("thread-" + entry.id)).toHaveLength(8));
    const undoneProposal = generate.mock.calls.at(-1)![1].id;
    const pendingAccept = () => [...activePanel().querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "接受修改");
    await vi.waitFor(() => expect(pendingAccept()?.disabled).toBe(false));
    flushSync(() => {
      pendingAccept()!.click();
      editor.command("undo");
    });
    await queue.flush();
    await vi.waitFor(() => expect(updateProposal).toHaveBeenCalledWith(undoneProposal, "conflicted"));
    expect(updateProposal).not.toHaveBeenCalledWith(undoneProposal, "applied");
    expect(queue.snapshot().fields.contentMd).toBe(entry.contentMd);
    click("对话记录");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("暂无对话"));
    click("对话记录");
    click("新对话");
    const firstThread = "thread-" + entry.id;
    await vi.waitFor(() => expect(threads.get(firstThread)?.archived).toBe(true));
    await vi.waitFor(() => expect(activePanel().textContent).not.toContain("精简措辞"));
    const savedThread = firstThread + "-1";
    blockedThreadWrites = savedThread;
    await send("另一轮对话");
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "chat", prompt: "另一轮对话", history: [] }));
    const reply = "新对话回复\n\n| 功能 | 状态 |\n| --- | --- |\n| 对话恢复 | 正常 |";
    finish({ reply });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("新对话回复"));
    const scroll = activePanel().querySelector('[role="region"][aria-label="表格"]');
    expect(scroll?.getAttribute("tabindex")).toBe("0");
    expect(scroll?.querySelector("table thead th")?.textContent).toBe("功能");
    expect(scroll?.querySelector("table tbody td")?.textContent).toBe("对话恢复");
    const copyText = vi.spyOn(desktop, "copyText").mockResolvedValue();
    const [copyUser, copyAssistant] = activePanel().querySelectorAll<HTMLButtonElement>('.ai-turn button[aria-label="复制"]');
    const timestamps = [copyUser.previousElementSibling, copyAssistant.previousElementSibling];
    expect(copyUser?.querySelector("svg.lucide-copy")).not.toBeNull();
    expect(copyAssistant?.querySelector("svg.lucide-copy")).not.toBeNull();
    flushSync(() => copyUser.click());
    await vi.waitFor(() => expect(copyUser.querySelector("svg.lucide-check")).not.toBeNull());
    expect(copyUser.parentElement?.querySelector('[role="status"]')?.textContent).toBe("已复制");
    expect(copyAssistant.getAttribute("aria-label")).toBe("复制");
    flushSync(() => copyAssistant.click());
    await vi.waitFor(() => expect(copyAssistant.querySelector("svg.lucide-check")).not.toBeNull());
    expect(copyText.mock.calls).toEqual([["另一轮对话"], [reply]]);
    await vi.waitFor(() => {
      expect(copyUser.getAttribute("aria-label")).toBe("复制");
      expect(copyAssistant.getAttribute("aria-label")).toBe("复制");
    }, { timeout: 1800 });
    click("对话记录");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("怎么改？"));
    expect(activePanel().textContent).not.toContain("另一轮对话");
    await vi.waitFor(() => expect(saveMessage.mock.calls.filter(([id]) => id === savedThread).length).toBeGreaterThanOrEqual(2));
    expect(messages.get(savedThread)).toHaveLength(0);
    blockedThreadWrites = undefined;
    click("怎么改？");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("可以加一条例子。"));
    expect(activePanel().querySelector('.ai-proposal-title [aria-label="已接受"] svg.lucide-check')).not.toBeNull();
    expect(updateThread).toHaveBeenCalledWith(firstThread, { archived: false });
    expect(threads.get(savedThread)?.archived).toBe(true);
    expect(messages.get(savedThread)).toHaveLength(2);
    for (const [index, time] of timestamps.entries()) {
      const date = messages.get(savedThread)![index].message.createdAt;
      expect(time?.getAttribute("datetime")).toBe(date.toISOString());
      expect(time?.textContent).toBe(messageTimeLabel(date));
    }
    await send("继续刚才的话题");
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)).toEqual([
      firstThread,
      expect.objectContaining({ prompt: "继续刚才的话题", history: [{ user: "怎么改？", assistant: "可以加一条例子。" }] }),
      expect.any(Function),
    ]));
    finish({ reply: "这是旧会话的续聊回复。" });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("这是旧会话的续聊回复。"));
    await vi.waitFor(() => expect(messages.get(firstThread)?.at(-1)?.message.content).toEqual([
      { type: "text", text: "这是旧会话的续聊回复。" },
    ]));

    const restoredCount = generate.mock.calls.length;
    render(queue, 2);
    await vi.waitFor(() => expect(activePanel().textContent).toContain("这是旧会话的续聊回复。"));
    expect(activePanel().textContent).toContain("精简措辞");
    expect(activePanel().textContent).toContain("原选区已失效");
    expect(generate).toHaveBeenCalledTimes(restoredCount);
    expect(scope).toHaveBeenCalledWith(other.entry.id);

    const accepted = activePanel().querySelector('[aria-label="已接受"]')!.closest(".ai-suggestion")!;
    const regenerate = [...accepted.querySelectorAll("button")].find(button => button.textContent === "重新生成")!;
    await selectRange(2, 4);
    expect(regenerate.disabled).toBe(false);
    flushSync(() => regenerate.click());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(restoredCount + 1));
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "rewrite", prompt: "只改选区", text: "这段正文" });
    const regenerated = () => [...activePanel().querySelectorAll(".ai-suggestion")].at(-1)!;
    const discard = await vi.waitFor(() => {
      const button = [...regenerated().querySelectorAll("button")].find(item => item.textContent === "放弃");
      expect(button?.disabled).toBe(false);
      return button!;
    });
    expect([...regenerated().querySelectorAll("button")].find(button => button.textContent === "接受修改")?.disabled).toBe(true);
    expect(queue.snapshot().fields.contentMd).toBe(entry.contentMd);
    flushSync(() => discard.click());
    await vi.waitFor(() => expect(regenerated().querySelector('.ai-proposal-title [aria-label="已放弃"] svg.lucide-x')).not.toBeNull());
    expect(regenerated().textContent).not.toContain("已放弃");
    expect([...regenerated().querySelectorAll("button")].find(button => button.textContent === "重新生成")?.disabled).toBe(false);
    const count = generate.mock.calls.length;

    click("新对话");
    await vi.waitFor(() => expect(threads.get(firstThread)?.archived).toBe(true));
    render(queue, 3);
    await vi.waitFor(() => expect(activePanel().querySelectorAll(".ai-thread-list time")).toHaveLength(2));
    click("删除对话：另一轮对话");
    await vi.waitFor(() => expect(removeThread).toHaveBeenCalledWith("thread-" + entry.id + "-1"));
    await vi.waitFor(() => expect(activePanel().querySelectorAll(".ai-thread-list li")).toHaveLength(1));
    expect(activePanel().textContent).toContain("怎么改？");
    click("删除对话：怎么改？");
    await vi.waitFor(() => expect(activePanel().textContent).toContain("暂无对话"));
    expect(removeThread).toHaveBeenLastCalledWith("thread-" + entry.id);

    await selectRange(0, 2);
    const { original, headingPath } = editor.captureContext("selection")!;
    render(queue, 3, { original, headingPath });
    const removeSelection = "移除选区引用：这段";
    await vi.waitFor(() => expect(activePanel().querySelector(`[aria-label="${removeSelection}"]`)?.textContent).toBe("这段×"));
    expect(generate).toHaveBeenCalledTimes(count);
    expect(activePanel().querySelector('[aria-label="对话记录"]')?.getAttribute("aria-pressed")).toBe("false");
    click(removeSelection);
    expect(activePanel().textContent).toContain("不引用正文");

    render(queue, 3, { original, headingPath });
    await selectRange(3, 3);
    await send("解释这段");
    const attachedRequest = { operation: "chat", text: "这段", prompt: "解释这段", context: { scope: "selection", headingPath: ["一"] } };
    await vi.waitFor(() => expect(generate.mock.calls.at(-1)?.[1]).toMatchObject(attachedRequest));
    expect(activePanel().querySelector('blockquote[aria-label="所选内容"]')?.textContent).toBe("这段");
    expect(activePanel().querySelector(`[aria-label="${removeSelection}"]`)).toBeNull();
    fail(new Error("模型暂时不可用"));
    await vi.waitFor(() => expect(activePanel().textContent).toContain("模型暂时不可用"));
    click("重试");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(count + 2));
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject(attachedRequest);
    finish({ reply: "解释完成" });
    await vi.waitFor(() => expect(activePanel().textContent).toContain("解释完成"));

    const update = updateThread.getMockImplementation()!;
    let completeArchive: () => void;
    updateThread.mockImplementationOnce(async (id, change) => {
      await new Promise<void>(resolve => { completeArchive = resolve; });
      await update(id, change);
    });
    click("新对话");
    await vi.waitFor(() => expect(completeArchive).toBeTypeOf("function"));
    await selectRange(0, 2);
    render(queue, 3, { original, headingPath });
    completeArchive!();
    await vi.waitFor(() => {
      expect(activePanel().querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')?.disabled).toBe(false);
      expect(activePanel().textContent).not.toContain("解释完成");
      expect(activePanel().querySelector(`[aria-label="${removeSelection}"]`)).not.toBeNull();
    });

    chooseRewrite();
    await send("精简这一处");
    const latestProposalAction = (label: string) => [...regenerated().querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === label);
    await vi.waitFor(() => expect(latestProposalAction("放弃")?.disabled).toBe(false));
    flushSync(() => latestProposalAction("放弃")!.click());
    await vi.waitFor(() => expect(regenerated().querySelector('[aria-label="已放弃"]')).not.toBeNull());
    await selectRange(2, 4);
    flushSync(() => latestProposalAction("重新生成")!.click());
    await vi.waitFor(() => expect(latestProposalAction("接受修改")?.disabled).toBe(false));
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "rewrite", prompt: "精简这一处", text: "这段" });
  } finally {
    if (digest) Object.defineProperty(crypto, "subtle", digest); else Reflect.deleteProperty(crypto, "subtle");
    vi.restoreAllMocks();
    queue.dispose();
    other.dispose();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("rejects async targets after a document changes or its editor session closes", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  async function mount(session: number) {
    flushSync(() => root.render(<MarkdownEditor
      key={session} ref={value => { handle = value; }} entryId="same-entry"
      value="原稿" readOnly={false} onChange={onChange} onBlur={() => {}}
    />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    return handle!;
  }
  try {
    const first = await mount(1);
    const original = first.target();
    expect(first.replaceTarget(original, "修改")).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("same-entry", 1, "修改原稿");
    expect(first.replaceTarget(original, "过时结果")).toBe(false);
    const closed = first.target();
    const reopened = await mount(2);
    expect(first.replaceTarget(closed, "已关闭")).toBe(false);
    expect(reopened.target().localRevision).toBe(original.localRevision);
    expect(reopened.replaceTarget(original, "旧会话结果")).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("routes clipboard shortcuts to native callbacks and keeps async paste bound to the originating editor", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  let finish!: (text: string) => void;
  const clipboard = {
    read: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })),
    write: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  const detach = attachClipboard((action, target) => handle!.clipboard(action, clipboard, target), clipboard.onError);
  const onChange = vi.fn();
  async function mount(entryId: string) {
    flushSync(() => root.render(<MarkdownEditor key={entryId} ref={value => { handle = value; }} entryId={entryId}
      value="原稿" readOnly={false} onChange={onChange} onBlur={() => {}}
    />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(entryId));
  }
  function shortcut(key: string) {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
    container.querySelector(".ProseMirror")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  try {
    await mount("first");
    shortcut("v");
    expect(clipboard.read).toHaveBeenCalledOnce();
    expect(container.querySelector('.rich-paste-progress[role="status"]')?.textContent).toBe("正在粘贴…");
    expect(onChange).not.toHaveBeenCalled();
    handle!.insert("新文字");
    finish("![图](asset://asset)");
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("first", 2, "新文字![图](asset://asset)原稿"));
    await vi.waitFor(() => expect(container.querySelector(".rich-paste-progress")).toBeNull());

    shortcut("c");
    expect(clipboard.write).toHaveBeenCalledWith("新文字图原稿", expect.stringContaining("data-workbench-src"));

    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    await select(editor, 0, 2, handle!);
    shortcut("v");
    await select(editor, 1, 1, handle!);
    handle!.insert("保留");
    finish("不要覆盖");
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith("first", 3, "新保留文字![图](asset://asset)原稿");

    shortcut("v");
    await mount("second");
    onChange.mockClear();
    finish("![迟到的图](asset://late)");
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".rich-paste-progress")).toBeNull();
    const unavailable = new Error("剪贴板暂不可用");
    clipboard.read.mockRejectedValueOnce(unavailable);
    shortcut("v");
    await vi.waitFor(() => expect(clipboard.onError).toHaveBeenCalledWith(unavailable));
    await vi.waitFor(() => expect(container.querySelector(".rich-paste-progress")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    detach();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("shows rich structure and round-trips Markdown after editing an unrelated block", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onError = vi.fn();
  const markdown = [
    "引言", "# 标题", "**粗体** ~~删除~~", "- [ ] 待处理\n- [x] 已完成", "| 左 | 右 |\n| --- | ---: |\n| 一 | 二 |",
    "正文[^n] 和 <em>内嵌</em>。", "[^n]: 脚注", '<div onclick="alert(1)">保留 HTML</div>',
    ...formatFixtures.slice(0, 5).map(fixture => fixture.markdown),
    "另见[^q]。", "> [^q]: 引用内脚注", "脚注后正文",
  ].join("\n\n");
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="rich"
      value={markdown} readOnly={false} onChange={onChange} onError={onError} onBlur={() => {}} />));
    await vi.waitFor(() => {
      if (onError.mock.calls.length) throw onError.mock.calls[0][0];
      expect(handle).not.toBeNull();
    });
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    expect(editor.querySelector("h1")?.textContent).toBe("标题");
    expect(editor.querySelector("strong")?.textContent).toBe("粗体");
    expect(editor.querySelectorAll('li[data-item-type="task"]').length).toBe(2);
    expect(editor.querySelector("table tr:nth-child(2)")?.textContent).toBe("一二");
    expect(editor.querySelector("sup")?.textContent).toBe("[^n]");
    expect(editor.querySelector("blockquote dl")).toBeNull();
    expect(editor.lastElementChild?.textContent).toBe("[^q]:引用内脚注");
    expect(editor.querySelector('[data-type="html-block"]')?.textContent).toBe("嵌入的 HTML");
    expect(editor.querySelector("[onclick], script")).toBeNull();
    expect(editor.textContent).not.toMatch(/\*\*粗体|<em>|# 标题/);
    expect(onChange).not.toHaveBeenCalled();
    handle!.insert("甲");
    const saved: string = onChange.mock.lastCall![2];
    expect(saved).toMatch(/^甲引言\n\n# 标题/m);
    expect(saved).toContain("**粗体** ~~删除~~");
    expect(saved).toContain("[x] 已完成");
    expect(saved).toMatch(/\|\s+一\s+\|\s+二\s+\|/);
    expect(saved).toContain("正文[^n] 和 <em>内嵌</em>。");
    expect(saved).toContain("[^n]: 脚注");
    expect(saved).toMatch(/脚注后正文[\s\S]+\[\^q\]: 引用内脚注$/);
    expect(saved).toContain('<div onclick="alert(1)">保留 HTML</div>');
    expect(saved).toContain("$x^2$");
    expect(saved).toContain("$$\n\\frac{a}{b}\n$$");
    expect(saved).toContain("$$a$$ 以及 $$b$$");
    expect(saved).toContain("保留 $ a $；公式 $b$。");
    expect(saved).toContain("> $$\n> x^2\n> $$");
    const fence = String.fromCharCode(96).repeat(3);
    expect(saved).toContain(fence + "mermaid\ngraph TD\nA --> B\n" + fence);
    expect(saved).toContain(fence + "text\n$$not_math$$\n" + fence);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("pastes sanitized rich HTML, honors plain paste, and gates editing in read-only mode", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const clipboard = {
    read: vi.fn().mockResolvedValueOnce({
      html: '<p><strong>粗体</strong><a href="javascript:alert(1)">链接</a><img src="data:image/png,x" onerror="alert(1)" alt="坏图"><script>alert(1)</script></p>',
    }).mockResolvedValueOnce("**纯文本**"),
    write: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  let handle: MarkdownEditorHandle | null = null;
  function mount(readOnly: boolean) {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="clipboard"
      value="" readOnly={readOnly} onChange={onChange} onBlur={() => {}} />));
  }
  try {
    mount(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("clipboard", 1, "**粗体**链接坏图"));
    expect(editor.querySelector("strong")?.textContent).toBe("粗体");
    expect(editor.querySelector("a, img, script")).toBeNull();
    handle!.clipboard("paste", clipboard, undefined, true);
    await vi.waitFor(() => expect(editor.textContent).toBe("粗体链接坏图**纯文本**"));
    expect(clipboard.read).toHaveBeenLastCalledWith(true);
    expect(editor.querySelectorAll("strong")).toHaveLength(1);
    mount(true);
    const revision = handle!.target().localRevision;
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    handle!.command("selectAll");
    expect(handle!.hasSelection()).toBe(true);
    handle!.command("heading1");
    handle!.insert("隐藏输入");
    expect(handle!.replaceTarget(handle!.target(), "不应写入")).toBe(false);
    handle!.clipboard("cut", clipboard);
    handle!.clipboard("paste", clipboard);
    handle!.clipboard("copy", clipboard);
    expect(clipboard.read).toHaveBeenCalledTimes(2);
    expect(clipboard.write).toHaveBeenCalledExactlyOnceWith("粗体链接坏图**纯文本**", expect.stringContaining("<strong>粗体</strong>"));
    expect(handle!.target().localRevision).toBe(revision);
    expect(editor.querySelector("h1")).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("renders Markdown copied with a plain HTML representation and keeps explicitly plain paste literal", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const source = "# 标题\n\n**目标：** 正文\n\n- 第一项";
  const read = vi.fn().mockResolvedValueOnce({
    html: "<div># 标题</div><div><br></div><div>**目标：** 正文</div><div>- 第一项</div>", text: source,
  }).mockResolvedValueOnce({ html: "<blockquote>已排版</blockquote>", text: "# 普通副本" })
    .mockResolvedValueOnce({ html: "<pre><code class='language-markdown'># 单块标题</code></pre>", text: "# 单块标题" })
    .mockResolvedValueOnce({ html: "<pre><code class='language-bash'># 字面注释</code></pre>", text: "# 字面注释" })
    .mockResolvedValueOnce({ html: "<p><span style='font-weight: 700'># 字面标记</span></p>", text: "# 字面标记" })
    .mockResolvedValueOnce({ html: "<p><strong># 标题</strong></p><p>**<strong>目标：</strong>** 正文</p><p><span style='font-style: italic'>- 第一项</span></p>", text: source })
    .mockResolvedValueOnce({ html: "<p><strong>1. 事项</strong></p><p><a href='https://example.com/'>详情</a></p>", text: "1. 事项\n\n详情" })
    .mockResolvedValueOnce({ html: "<p><strong># 专题</strong></p><p>- 项目</p><p><a href='https://example.com/'>详情</a></p>", text: "# 专题\n\n- 项目\n\n详情" })
    .mockResolvedValueOnce(source);
  const clipboard = { read, write: vi.fn(), onError: vi.fn() };
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="markdown-paste"
      value="" readOnly={false} onChange={() => {}} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector(".ProseMirror")!;
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("h1")?.textContent).toBe("标题"));
    expect(editor.querySelector("strong")?.textContent).toBe("目标：");
    expect(editor.querySelector("li")?.textContent).toBe("第一项");

    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("blockquote")?.textContent).toBe("已排版"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("h1")?.textContent).toBe("单块标题"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector('pre[data-language="bash"] > code')?.textContent).toBe("# 字面注释"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("strong")?.textContent).toBe("# 字面标记"));
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector("h1")?.textContent).toBe("标题"));
    expect(editor.querySelector("strong")?.textContent).toBe("目标：");
    expect(editor.querySelector("li")?.textContent).toBe("第一项");
    for (const label of ["1. 事项", "# 专题"]) {
      handle!.command("selectAll");
      handle!.clipboard("paste", clipboard);
      await vi.waitFor(() => expect(editor.querySelector("strong")?.textContent).toBe(label));
      expect(editor.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
      expect(editor.querySelector("h1, ol, ul")).toBeNull();
    }
    handle!.command("selectAll");
    handle!.clipboard("paste", clipboard, undefined, true);
    await vi.waitFor(() => expect(editor.querySelector("p")?.textContent).toBe("# 标题"));
    expect(editor.querySelector("h1, strong, li")).toBeNull();
    expect(clipboard.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("expands replace from the find overlay and returns focus to the editor on Escape", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const count = () => container.querySelector("output")?.textContent;
  const coordinates = vi.spyOn(EditorView.prototype, "coordsAtPos").mockImplementation(pos => ({
    top: pos > 10 ? 420 : 100, bottom: pos > 10 ? 440 : 120, left: 10, right: 40,
  }));
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  function enter(field: HTMLInputElement, value: string) {
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  try {
    flushSync(() => root.render(<Theme><MarkdownEditor ref={value => { handle = value; }} entryId="find"
      value={"段落 旧词\n\n再次出现 旧词"} readOnly={false} onChange={onChange} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const scroll = container.querySelector<HTMLElement>(".editor-scroll")!;
    scroll.getBoundingClientRect = () => new DOMRect(0, 0, 500, 350);
    flushSync(() => handle!.search());
    expect(document.activeElement).toBe(input("查找"));
    expect(input("替换")).toBeNull();
    expect(scroll.style.getPropertyValue("--find-clearance")).toBe("");
    enter(input("查找"), "旧词");
    expect(count()).toBe("1 / 2");
    flushSync(() => button("下一处").click());
    expect(count()).toBe("2 / 2");
    expect(scroll.scrollTop).toBeGreaterThan(0);
    flushSync(() => button("展开替换").click());
    flushSync(() => button("全部替换").focus());
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("全部替换"));
    enter(input("替换"), "新词");
    flushSync(() => button("全部替换").click());
    expect(onChange).toHaveBeenLastCalledWith("find", 1, "段落 新词\n\n再次出现 新词");
    expect(count()).toBe("无匹配");
    flushSync(() => button("关闭查找").focus());
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("关闭查找"));
    flushSync(() => button("关闭查找").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(container.querySelector('[role="search"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".ProseMirror"));
  } finally {
    coordinates.mockRestore();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("round-trips formula, task, callout and footnote metadata through native rich clipboard HTML", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const clipboard = {
    read: vi.fn(),
    write: vi.fn<(text: string, html?: string) => Promise<void>>().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  async function mount(entryId: string, markdown: string) {
    flushSync(() => root.render(<MarkdownEditor key={entryId} ref={value => { handle = value; }} entryId={entryId}
      value={markdown} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
  }
  try {
    const source = "- [x] 已完成\n\n==高亮== 与公式 $x^2$，详见[^1]。\n\n[^1]: 说明\n\n> \\[!INFO]\n\n末段正文";
    await mount("source", source);
    expect(container.querySelector(".ProseMirror")?.lastElementChild?.getAttribute("data-type")).toBe("footnote_definition");
    handle!.command("selectAll");
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write).toHaveBeenLastCalledWith(source);
    const editor = container.querySelector(".ProseMirror")!;
    const first = editor.querySelector("li p")!.firstChild!;
    const last = editor.querySelector("dl dd p")!.lastChild!;
    document.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.target().from).toBeGreaterThan(0));
    handle!.clipboard("copy", clipboard);
    const html = clipboard.write.mock.lastCall![1];
    expect(html).toContain('data-math="math_inline"');
    await mount("target", "目标原稿");
    clipboard.read.mockResolvedValue({ html: html +
      '<div data-type="html-block" data-value="&lt;script&gt;alert(1)&lt;/script&gt;">嵌入的 HTML</div>' +
      '<p><span data-math="math_inline" data-display="true" data-value="a$$&#10;&#10;&lt;img src=x onerror=1&gt;&#10;&#10;$$b">行内公式</span></p>' +
      '<div data-math="math_block" data-value="a&#10;$$&#10;http://example.com">块公式</div>' });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const markdown = onChange.mock.lastCall![2] as string;
    expect(markdown).toContain("[x] 已完成");
    expect(markdown).toContain("==高亮==");
    expect(markdown).toContain("$x^2$，详见[^1]");
    expect(markdown).toContain("> \\[!INFO]");
    expect(markdown.trimEnd().endsWith("[^1]: 说明")).toBe(true);
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("onerror");
    expect(markdown).not.toContain("http://example.com");
    expect(clipboard.onError).not.toHaveBeenCalled();
    handle!.command("undo");
    expect(onChange.mock.lastCall![2]).toBe("目标原稿");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("replaces only the original document images after all hosting URLs have resolved", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const original = "正文\n\n![一](asset://same)\n\n![二](asset://same)\n\n![三](asset://other)\n\n![已托管](https://cdn.example.test/photos/existing.png)";
  const choose = (src: string) => src.startsWith("asset://");
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="hosting" value={original} ref={value => { handle = value; }}
      readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const uploading = () => container.querySelectorAll(".rich-image-upload:not([hidden])").length;
    const fail = vi.fn().mockResolvedValueOnce("https://cdn.example.test/photos/same.png").mockRejectedValueOnce(new Error("上传失败"));
    const failedTask = handle!.hostImages!(fail, choose);
    expect(uploading()).toBe(2);
    await expect(failedTask).rejects.toThrow("上传失败");
    expect(uploading()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    const upload = vi.fn(async (src: string) => `https://cdn.example.test/photos/${src.slice(8)}.png`);
    const task = handle!.hostImages!(upload, choose);
    handle!.insert("新写的");
    expect(await task).toBe(3);
    expect(uploading()).toBe(0);
    expect(upload.mock.calls).toEqual([["asset://same"], ["asset://other"]]);
    expect(onChange.mock.lastCall![2]).toBe(`新写的${original.replaceAll("asset://same", "https://cdn.example.test/photos/same.png").replace("asset://other", "https://cdn.example.test/photos/other.png")}`);
    handle!.command("undo");
    expect(onChange.mock.lastCall![2]).toBe(`新写的${original}`);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("runs body format and insert commands while retaining the selected text on right click", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  async function mount(key: string) {
    flushSync(() => root.render(<MarkdownEditor key={key} ref={value => { handle = value; }} entryId={key}
      value="正文" readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(key));
    return container.querySelector<HTMLElement>(".ProseMirror")!;
  }
  try {
    const editor = await mount("marks");
    await select(editor, 0, 2, handle!);
    handle!.prepareContext(new MouseEvent("contextmenu", { button: 2 }));
    expect(handle!.target().original).toBe("正文");
    handle!.command("bold");
    expect(editor.querySelector("strong")?.textContent).toBe("正文");
    handle!.command("italic");
    expect(editor.querySelector("em")?.textContent).toBe("正文");
    handle!.command("strike");
    expect(editor.querySelector("del")?.textContent).toBe("正文");
    handle!.command("link", "https://example.com");
    expect(editor.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    handle!.command("link", "https://example.com/updated");
    expect(editor.querySelector("a")?.getAttribute("href")).toBe("https://example.com/updated");
    const blocks: [EditorCommand, string, RegExp][] = [
      ["heading2", "h2", /^## 正文$/],
      ["taskList", 'li[data-checked="false"]', /\[ \] 正文/],
      ["bulletList", "ul > li", /^[-*+] 正文$/],
      ["orderedList", "ol > li", /^1\. 正文$/],
      ["quote", "blockquote", /^> 正文$/],
      ["table", "table", /\|\s+\|/],
      ["horizontalRule", "hr", /(?:^|\n)(?:---|\*\*\*)(?:\n|$)/],
      ["codeBlock", "pre > code", /\x60\x60\x60\n正文\n\x60\x60\x60/],
      ["mathBlock", "div.rich-formula", /\$\$\nx\n\$\$/],
    ];
    for (const [command, selector, pattern] of blocks) {
      const body = await mount(command);
      handle!.command(command);
      expect(body.querySelector(selector), command).not.toBeNull();
      expect(onChange.mock.lastCall![2], command).toMatch(pattern);
    }
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("edits footnotes at their reference and writes the definition at the bottom on submit", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const input = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="脚注内容"]')!;
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".rich-footnote-actions button"))
    .find(node => node.textContent === label)!;
  function fill(text: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
    flushSync(() => input().dispatchEvent(new Event("input", { bubbles: true })));
  }
  try {
    flushSync(() => root.render(<Theme><MarkdownEditor ref={value => { handle = value; }} entryId="footnotes"
      value={"正文[^N]\n\n末段\n\n[^n]: 旧来源"} readOnly={false} onChange={onChange} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    await select(editor, 2, 2, handle!);
    flushSync(() => handle!.command("footnote"));
    expect(document.querySelector(".rich-footnote-popover code")?.textContent).toBe("[^1]:");
    expect(container.querySelector(".rich-footnote-anchor")).not.toBeNull();
    expect(editor.querySelectorAll("sup")).toHaveLength(1);
    fill("取消的内容");
    flushSync(() => button("取消").click());
    expect(onChange).not.toHaveBeenCalled();

    flushSync(() => handle!.command("footnote"));
    fill("**新来源**");
    expect(onChange).not.toHaveBeenCalled();
    flushSync(() => button("插入").click());
    expect(editor.querySelector("p sup")?.textContent).toBe("[^1]");
    expect(editor.lastElementChild?.textContent).toBe("[^1]:新来源");
    expect(onChange.mock.lastCall![2]).toBe("正文[^1][^N]\n\n末段\n\n[^n]: 旧来源\n\n[^1]: **新来源**");
    expect(editor.querySelector("p")?.contains(document.getSelection()?.anchorNode ?? null)).toBe(true);

    flushSync(() => editor.querySelector<HTMLElement>('sup[data-label="N"]')!.click());
    expect(input().value).toBe("旧来源");
    expect(document.querySelector(".rich-footnote-popover code")?.textContent).toBe("[^n]:");
    fill("补充来源");
    flushSync(() => button("保存").click());
    expect(editor.querySelectorAll("sup")).toHaveLength(2);
    expect(onChange.mock.lastCall![2]).toContain("[^n]: 补充来源");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("opens the footnote editor after pasting syntax-highlighted Markdown without a heading", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  const url = "https://example.com/source";
  const source = `出处[^资料]。\n\n[^资料]: ${url}`;
  const clipboard = {
    read: vi.fn().mockResolvedValue({
      text: source,
      html: `<p>出处<strong>[^资料]</strong>。</p><p><strong>[^资料]:</strong> <a href="${url}">${url}</a></p>`,
    }),
    write: vi.fn(),
    onError: vi.fn(),
  };
  try {
    flushSync(() => root.render(<Theme><MarkdownEditor ref={value => { handle = value; }} entryId="pasted-footnote"
      value="" readOnly={false} onChange={onChange} onBlur={() => {}} /></Theme>));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.clipboard("paste", clipboard);
    const reference = () => container.querySelector<HTMLElement>('sup[data-type="footnote_reference"][data-label="资料"]');
    await vi.waitFor(() => expect(reference()).not.toBeNull());
    expect(container.querySelector('dl[data-label="资料"] a')?.getAttribute("href")).toBe(url);
    expect(onChange.mock.lastCall![2]).toContain("[^资料]:");
    flushSync(() => reference()!.click());
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="脚注内容"]')?.value).toContain(url);
    expect(clipboard.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("preserves callout markers and displays the complete Markdown source on formula focus", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "开头 $E = mc^2$\n\n> [!INFO]\n> 说明内容\n\n> [!warning] **注意**\n> 警告内容\n\n> \\[!INFO]\n\n$$\nx^2\n$$";
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="callouts-and-math"
      value={markdown} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    expect(editor.querySelector('[data-callout="info"] [data-callout-label]')?.getAttribute("data-callout-label")).toBe("信息");
    expect(editor.querySelector('[data-callout="warning"] strong')?.textContent).toBe("注意");
    expect(editor.querySelector("blockquote[data-literal-callout]:not([data-callout])")?.textContent).toBe("[!INFO]");
    const [inline, block] = editor.querySelectorAll<HTMLButtonElement>(".rich-formula-trigger");
    inline.focus();
    const field = editor.querySelector<HTMLInputElement>("input.rich-formula-source")!;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("$E = mc^2$");
    field.value = "$$不完整$";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(field.hidden).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    field.value = "$E = mc^3$";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onChange.mock.lastCall![2]).toBe(markdown.replace("mc^2", "mc^3"));
    block.focus();
    const area = editor.querySelector<HTMLTextAreaElement>("textarea.rich-formula-source")!;
    expect(document.activeElement).toBe(area);
    expect(block.tabIndex).toBe(-1);
    expect(area.value).toBe("$$\nx^2\n$$");
    expect(area.nextElementSibling?.className).toBe("rich-graphic-preview");
    area.value = "$$\nx^3\n$$";
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(area.hidden).toBe(true);
    expect(block.tabIndex).toBe(0);
    expect(onChange.mock.calls).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("converts a clicked link permanently and presents current and pasted links reversibly", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const clipboard = { read: vi.fn(), write: vi.fn(), onError: vi.fn() };
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "[另一篇](https://example.com/other) [**重点**内容](https://example.com/source) [文内](#heading)\n\n正文[^1]\n\n[^1]: 原脚注";
  const original = markdown.replace("[**重点**内容](https://example.com/source)", "**[重点](https://example.com/source)**[内容](https://example.com/source)");
  const render = (convertLinks: boolean) => flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }}
    entryId="link-footnotes" value={markdown} readOnly={false} convertLinks={convertLinks} onChange={onChange} onBlur={() => {}} />));
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    const target = editor.querySelector('a[href$="/source"]')!;
    const click = new MouseEvent("contextmenu", { button: 2, bubbles: true });
    target.dispatchEvent(click);
    const action = handle!.prepareContext(click);
    if (!action || typeof action !== "object" || !("kind" in action) || action.kind !== "link") throw new Error("expected link context");
    action.convert();
    const saved = () => onChange.mock.lastCall![2] as string;
    expect(saved()).toContain("[另一篇](https://example.com/other) **重点**内容[^2] [文内](#heading)");
    expect(saved()).toMatch(/\[\^2\]: .*https:\/\/example\.com\/source/);
    expect(editor.lastElementChild?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/source");
    handle!.command("undo");
    expect(saved()).toBe(original);

    const preview = handle!.linkFootnoteMarkdown(original);
    expect(preview).toContain("另一篇[^2] **重点**内容[^3] [文内](#heading)");
    expect(preview).toContain("[^1]: 原脚注");
    expect(preview).toContain("[^2]: 另一篇：<https://example.com/other>");
    expect(preview).toContain("[^3]: 重点内容：<https://example.com/source>");
    expect(handle!.linkFootnoteMarkdown(preview)).toBe(preview);
    expect(saved()).toBe(original);

    const changes = onChange.mock.calls.length;
    render(true);
    expect(editor.querySelectorAll(".rich-link-citation")).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(changes);
    await select(editor, 0, 0, handle!);
    clipboard.read.mockResolvedValueOnce("[来源](https://example.com/md) [另一份](https://example.com/second)\n\n已有[^2]\n\n[^2]: [旧地址](https://example.com/existing)");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(saved()).toContain("[来源](https://example.com/md)"));
    const projected = () => handle!.linkFootnoteMarkdown(saved());
    expect(projected()).toMatch(/来源\[\^\d+\] 另一份\[\^\d+\]/);
    expect(saved()).toContain("[^2]: [旧地址](https://example.com/existing)");
    handle!.command("undo");
    expect(saved()).toBe(original);

    handle!.command("link", "https://example.com/inserted");
    expect(saved()).toContain("<https://example.com/inserted>");
    expect(projected()).toMatch(/\[\^\d+\]: <https:\/\/example\.com\/inserted>/);
    clipboard.read.mockResolvedValueOnce({ html: '<a href="https://example.com/rich">富文本链接</a>' });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(projected()).toMatch(/富文本链接\[\^\d+\]/));
    clipboard.read.mockResolvedValueOnce("https://example.com/bare");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector('.rich-link-notes a[href$="/bare"]')).not.toBeNull());
    expect(editor.querySelector(':scope > p a[href$="/bare"]')?.textContent).toContain("https://example.com/bare");
    clipboard.read.mockResolvedValueOnce("https://example.com/plain");
    handle!.clipboard("paste", clipboard, undefined, true);
    await vi.waitFor(() => expect(editor.querySelector('.rich-link-notes a[href$="/plain"]')).not.toBeNull());
    clipboard.read.mockResolvedValueOnce({ html: "<p><strong>来源 https://example.com/中文，下一句富文本。</strong> <code>https://example.com/code</code></p>" });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector('.rich-link-notes a[href$="/中文"]')).not.toBeNull());
    expect(Array.from(editor.querySelectorAll(":scope > p")).some(node => /\[\^\d+\]，下一句富文本。/.test(node.textContent))).toBe(true);
    expect(editor.querySelector('code')?.textContent).toBe("https://example.com/code");
    clipboard.read.mockResolvedValueOnce("参考 https://example.com/plain-paragraph，下一句普通文本。");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector('.rich-link-notes a[href$="/plain-paragraph"]')).not.toBeNull());
    expect(projected()).toMatch(/\[\^\d+\]，下一句普通文本。/);
    const standalone = "https://example.com/资料，甲。";
    clipboard.read.mockResolvedValueOnce(standalone);
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(editor.querySelector(`.rich-link-notes a[href="${standalone}"]`)).not.toBeNull());
    const listUrl = "https://example.com/列表，甲。";
    const quoteUrl = "https://example.com/引文，甲。";
    clipboard.read.mockResolvedValueOnce(`- ${listUrl}\n\n> ${quoteUrl}`);
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => {
      expect(editor.querySelector(`.rich-link-notes a[href="${listUrl}"]`)).not.toBeNull();
      expect(editor.querySelector(`.rich-link-notes a[href="${quoteUrl}"]`)).not.toBeNull();
    });
    render(false);
    expect(editor.querySelector(".rich-link-notes")).toBeNull();
    expect(editor.querySelector(".rich-link-footnoted")).toBeNull();
    expect(clipboard.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("keeps exact destinations and URL-shaped link names across article conversion and reopening", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "显式链接 <https://example.com/a，b>。\n\n网址名称 [https://mirror.example/form](https://redirect.example/form)。\n\n行内代码 `https://example.com/ignored`。\n\n[^7]\n\n[^7]: <https://example.com/legacy>";
  async function mount(id: string, value: string, convertLinks = true) {
    flushSync(() => root.render(<MarkdownEditor key={id} ref={instance => { handle = instance; }} entryId={id}
      value={value} readOnly={false} convertLinks={convertLinks} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(id));
    return container.querySelector<HTMLElement>(".ProseMirror")!;
  }
  try {
    const editor = await mount("exact-link-target", markdown);
    await select(editor, 0, 4, handle!);
    const converted = handle!.linkFootnoteMarkdown(markdown);
    expect(handle!.target().original).toBe("显式链接");
    expect(editor.querySelector(":scope > p a")?.textContent).toContain("https://example.com/a，b");
    expect(converted).toContain("行内代码 `https://example.com/ignored`。");
    expect(converted).toContain("[^1]: <https://example.com/a，b>");
    expect(editor.querySelector(":scope > p:nth-child(2)")?.textContent).toContain("https://mirror.example/form[^2]");
    expect(editor.querySelector(":scope > p:nth-child(4)")?.textContent).toContain("https://example.com/legacy[^7]");
    const addressText = document.createTreeWalker(editor.querySelector(":scope > p a")!, NodeFilter.SHOW_TEXT).nextNode()!;
    document.getSelection()!.setBaseAndExtent(addressText, 10, addressText, 10);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(Array.from(editor.querySelectorAll(":scope > p .rich-markdown-syntax"),
      marker => marker.getAttribute("data-markdown"))).toEqual(["<", ">"]));
    expect(onChange).not.toHaveBeenCalled();
    const reopened = await mount("reopened-link-target", converted, false);
    expect(reopened.querySelector(":scope > p")?.textContent).toBe("显式链接 https://example.com/a，b[^1]。");
    expect(reopened.querySelector(":scope > p:nth-child(2)")?.textContent).toContain("https://mirror.example/form[^2]");
    expect(reopened.querySelector(":scope > p:nth-child(2) a")).toBeNull();
    expect(reopened.querySelector('dl a[href="https://redirect.example/form"]')).not.toBeNull();
    expect(handle!.linkFootnoteMarkdown(converted)).toBe(converted);
    const titled = await mount("titled-link-target", '[https://example.com](https://example.com "原有标题")[^cite]\n\n[^cite]: https://example.com：<https://example.com/source>');
    expect(titled.querySelector(":scope > p a")?.getAttribute("title")).toBe("原有标题");
    const rawDestination = "https://example.test/资料，甲";
    const original = await mount("implicit-link-target", rawDestination, false);
    expect(original.querySelector("a")?.getAttribute("href")).toBe(rawDestination);
    const repeated = "<https://example.test/a>[^1]\n\n[^1]: <https://example.test/a>";
    const projected = handle!.linkFootnoteMarkdown(repeated);
    const { body } = parseWechat(projected, []);
    expect(body.querySelector("p")?.querySelector('a[href^="http"]')).toBeNull();
    expect(body.querySelector("p")?.textContent).toBe("https://example.test/a[1]");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("adds rows and columns to the clicked table and persists column formatting and sorts", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "| 名称 | 数量 |\n| --- | --- |\n| 项目 10 | 10 |\n| 项目 2 | 2 |";
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="table-tools" value={markdown}
      readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const table = () => container.querySelector("table")!;
    const rowTexts = () => [...table().rows].map(row => [...row.cells].map(cell => cell.textContent));
    const hoverCell = (row: number, column: number, x = 50, y = 15) => {
      const width = table().rows[0].cells.length * 100;
      table().getBoundingClientRect = () => new DOMRect(20, 40, width, table().rows.length * 30);
      [...table().rows].forEach((line, r) => {
        line.getBoundingClientRect = () => new DOMRect(20, 40 + r * 30, width, 30);
        [...line.cells].forEach((cell, c) => { cell.getBoundingClientRect = () => new DOMRect(20 + c * 100, 40 + r * 30, 100, 30); });
      });
      table().rows[row].cells[column].dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true, clientX: 20 + column * 100 + x, clientY: 40 + row * 30 + y,
      }));
    };
    hoverCell(2, 1, 99);
    container.querySelector<HTMLButtonElement>(".rich-table-add-column")!.click();
    hoverCell(2, 0, 50, 29);
    container.querySelector<HTMLButtonElement>(".rich-table-add-row")!.click();
    expect(rowTexts()).toEqual([["名称", "数量", ""], ["项目 10", "10", ""], ["项目 2", "2", ""], ["", "", ""]]);

    function context(row: number, column: number) {
      const cell = table().rows[row].cells[column];
      const capture = vi.fn((event: MouseEvent) => handle!.prepareContext(event));
      cell.addEventListener("contextmenu", capture, { once: true });
      cell.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true }));
      return capture.mock.results[0].value;
    }
    expect(context(1, 0)).toEqual({ row: 1, column: 0, rows: 4, columns: 3 });
    handle!.tableAction("alignCenter");
    expect([...table().rows].map(row => row.cells[0].style.textAlign)).toEqual(["center", "center", "center", "center"]);
    handle!.tableAction("sortAscending");
    expect(rowTexts().map(row => row[0])).toEqual(["名称", "", "项目 2", "项目 10"]);
    expect(onChange.mock.lastCall![2]).toMatch(/\| :[-]+: /);
    context(2, 1);
    handle!.tableAction("columnLeft");
    expect(rowTexts()[0]).toEqual(["数量", "名称", ""]);
    expect(rowTexts()[2]).toEqual(["2", "项目 2", ""]);

    function dragGrip(axis: "row" | "column", row: number, column: number, x = 20, y = 5) {
      const grip = container.querySelector(`.rich-table-grip-${axis}`)!;
      expect(grip.querySelector("svg")).not.toBeNull();
      expect(grip.hasAttribute("hidden")).toBe(false);
      const transfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "" };
      for (const [type, target] of [["dragstart", grip], ["dragover", table().rows[row].cells[column]], ["drop", table().rows[row].cells[column]]] as const) {
        const event = new MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: 20 + column * 100 + x, clientY: 40 + row * 30 + y,
        });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(type !== "dragstart");
        if (type === "dragover") {
          const preview = container.querySelector<HTMLDivElement>(".rich-table-preview")!;
          const line = container.querySelector<HTMLDivElement>(`.rich-table-line-${axis}`)!;
          const offset = preview.style.cssText;
          expect(preview.hidden || line.hidden).toBe(false);
          table().parentElement!.dispatchEvent(new MouseEvent("dragleave", { bubbles: true, relatedTarget: container }));
          container.dispatchEvent(new MouseEvent("dragover", { bubbles: true, clientX: 1000, clientY: 1000 }));
          expect(line.hidden).toBe(true);
          expect(preview.hidden).toBe(false);
          expect(preview.style.cssText).not.toBe(offset);
        }
      }
      expect(container.querySelector(".rich-table-preview")?.hasAttribute("hidden")).toBe(true);
    }
    handle!.command("selectAll");
    hoverCell(2, 1);
    dragGrip("row", 1, 1);
    expect(rowTexts().slice(0, 3)).toEqual([["数量", "名称", ""], ["2", "项目 2", ""], ["", "", ""]]);
    hoverCell(1, 1);
    dragGrip("column", 1, 0);
    expect(rowTexts().slice(0, 2)).toEqual([["名称", "数量", ""], ["项目 2", "2", ""]]);
    hoverCell(0, 0, 99);
    expect(container.querySelector(".rich-table-grip-column")?.hasAttribute("hidden")).toBe(true);
    container.querySelector<HTMLButtonElement>(".rich-table-add-column")!.click();
    expect(rowTexts()[0]).toEqual(["名称", "", "数量", ""]);
    hoverCell(1, 0, 50, 1);
    container.querySelector<HTMLButtonElement>(".rich-table-add-row")!.click();
    expect(rowTexts().slice(0, 3)).toEqual([["名称", "", "数量", ""], ["", "", "", ""], ["项目 2", "", "2", ""]]);
    hoverCell(0, 0);
    dragGrip("row", 2, 0, 50, 25);
    expect(rowTexts().slice(0, 3)).toEqual([["", "", "", ""], ["项目 2", "", "2", ""], ["名称", "", "数量", ""]]);
    expect(table().rows[0].cells[0].tagName).toBe("TH");
    expect(table().rows[2].cells[0].tagName).toBe("TD");

    const pasteTable = (html: string) => {
      handle!.command("selectAll");
      handle!.clipboard("paste", { read: async () => ({ html }), write: vi.fn(), onError: vi.fn() });
    };
    pasteTable("<table><tr><th rowspan='2'>类别</th><th>数量</th></tr><tr><td colspan='2'>5</td></tr><tr><td>普通</td><td>2</td></tr></table>");
    await vi.waitFor(() => expect(rowTexts()).toEqual([["类别", "数量"], ["5", ""], ["普通", "2"]]));
    expect(context(2, 1)).toEqual({ row: 2, column: 1, rows: 3, columns: 2 });
    handle!.tableAction("sortDescending");
    expect(rowTexts().slice(1)).toEqual([["普通", "2"], ["5", ""]]);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("preserves dragged table selections and keeps newlines in table cells after reopening", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  async function mount(entryId: string, markdown: string, convertLinks = false) {
    flushSync(() => root.render(<MarkdownEditor key={entryId} ref={value => { handle = value; }} entryId={entryId}
      value={markdown} readOnly={false} convertLinks={convertLinks} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle?.target().entryId).toBe(entryId));
    return container.querySelector("table")!;
  }
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  try {
    const table = await mount("table-selection", "| 项目 | 数量 |\n| --- | --- |\n| 笔记 | 12 |\n| 文档 | 24 |");
    const left = table.rows[1].cells[0];
    const right = table.rows[1].cells[1];
    const markup = (cell: HTMLTableCellElement) => cell.querySelector("p")!.innerHTML.replace(/<img class="ProseMirror-separator" alt="">/g, "");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number) => x < 50 ? left : right });
    const fire = (type: string, target: Node, x: number, button = 0) =>
      target.dispatchEvent(new MouseEvent(type, { button, clientX: x, bubbles: true, cancelable: true }));
    const context = (cell: HTMLTableCellElement) => {
      const prepare = vi.fn((event: MouseEvent) => handle!.prepareContext(event));
      cell.addEventListener("contextmenu", prepare, { once: true });
      fire("contextmenu", cell, 60, 2);
      return prepare.mock.results[0].value;
    };
    handle!.focus();
    fire("mousedown", left, 10);
    fire("mousemove", right, 60);
    fire("mouseup", right, 60);
    expect(left.dataset.selectionEdge).toBe("left top bottom");
    expect(right.dataset.selectionEdge).toBe("right top bottom");
    fire("mousedown", right, 60, 2);
    expect(context(right)).toMatchObject({ row: 1, column: 0, selectedCells: true });
    const clipboard = { read: vi.fn(), write: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write.mock.lastCall![1]).toMatch(/<td[^>]*><p>笔记<\/p><\/td><td[^>]*><p>12/);
    handle!.tableAction("clearCells");
    expect([left.textContent, right.textContent]).toEqual(["", ""]);
    handle!.command("undo");
    for (const plainText of [false, true]) {
      fire("mousedown", left, 10);
      fire("mousemove", right, 60);
      fire("mouseup", right, 60);
      clipboard.read.mockResolvedValueOnce("甲\n乙\n\n丙");
      handle!.clipboard("paste", clipboard, undefined, plainText);
      const expected = plainText ? "甲<br>乙<br><br>丙" : "甲<br>乙<br>丙";
      await vi.waitFor(() => expect(markup(right)).toBe(expected));
      expect(markup(left)).toBe(expected);
      expect(table.rows).toHaveLength(3);
    }
    clipboard.read.mockResolvedValueOnce({ html: "<strong>格式</strong>", text: "格式" });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(right.querySelector("strong")?.textContent).toBe("格式"));
    expect(left.querySelector("strong")?.textContent).toBe("格式");
    handle!.command("undo");
    clipboard.read.mockResolvedValueOnce({ html: "<hr>" });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(clipboard.read).toHaveBeenCalledTimes(4));
    expect(markup(right)).toBe("甲<br>乙<br><br>丙");

    const p = table.rows[2].cells[0].querySelector("p")!;
    handle!.focus();
    document.getSelection()!.setBaseAndExtent(p.firstChild!, 0, p.firstChild!, 2);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.hasSelection()).toBe(true));
    expect(context(table.rows[2].cells[0])).toBe("cellText");
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write.mock.lastCall![0]).toBe("文档");
    document.getSelection()!.collapse(p.firstChild!, 2);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.hasSelection()).toBe(false));
    const enter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    p.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const saved = onChange.mock.lastCall![2] as string;
    expect(saved).toMatch(/文档<br>/);
    const reopened = await mount("reopened", saved);
    expect(reopened.rows).toHaveLength(3);
    expect(markup(reopened.rows[1].cells[0])).toBe("甲<br>乙<br><br>丙");
    expect(reopened.rows[2].cells[0].querySelector("br")).not.toBeNull();
    const trailing = container.querySelector<HTMLElement>(".ProseMirror > p:last-child")!;
    expect(trailing).not.toBeNull();
    handle!.focus();
    const start = handle!.target().from;
    document.getSelection()!.collapse(trailing, 0);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.target().from).toBeGreaterThan(start));
    handle!.insert("表格之后的文字");
    expect(trailing.textContent).toBe("表格之后的文字");
    expect(onChange.mock.lastCall![2]).toMatch(/\|\n\n表格之后的文字$/);

    const sources = await mount("table-links", "| 项目 | 数量 |\n| --- | --- |\n| 前 [甲](https://example.com/original) | 乙 |", true);
    const [first, second] = Array.from(sources.rows[1].cells);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number) => x < 50 ? first : second });
    handle!.focus();
    const tableAnchor = () => first.querySelector('a[href$="/original"]')!;
    function linkContext() {
      const event = new MouseEvent("contextmenu", { button: 2, bubbles: true });
      tableAnchor().dispatchEvent(event);
      return handle!.prepareContext(event);
    }
    expect(linkContext()).toMatchObject({ kind: "link", scope: { row: 1, column: 0 } });
    const precedingText = first.querySelector("p")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(precedingText, 0, precedingText, 1);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(handle!.hasSelection()).toBe(true));
    expect(linkContext()).toMatchObject({ kind: "link", scope: "cellText" });
    fire("mousedown", first, 10);
    fire("mousemove", second, 60);
    fire("mouseup", second, 60);
    clipboard.read.mockResolvedValueOnce("[出处](https://example.com/table)");
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(sources.querySelectorAll('sup.rich-link-citation')).toHaveLength(2));
    expect(container.querySelector('.rich-link-notes dl a')?.getAttribute("href")).toBe("https://example.com/table");
    expect(onChange.mock.lastCall![2]).not.toContain("[^1]:");
    handle!.command("undo");
    expect(sources.querySelectorAll("sup.rich-link-citation")).toHaveLength(1);
    expect(container.querySelector(".rich-link-notes dl a")?.getAttribute("href")).toBe("https://example.com/original");
  } finally {
    if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("opens HTTP links only with the platform modifier and measures the context caret", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const openLink = vi.fn().mockResolvedValue(undefined);
  const platform = vi.spyOn(Navigator.prototype, "platform", "get");
  const measure = vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({ top: 20, bottom: 45, left: 10, right: 10 });
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="links" ref={value => { handle = value; }}
      value={"正文 [外链](https://example.com/) [锚点](#heading)"} readOnly={false} onOpenLink={openLink}
      onChange={vi.fn()} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const [link, anchor] = container.querySelectorAll("a");
    const click = (target: Element, options: MouseEventInit = {}) =>
      target.dispatchEvent(new MouseEvent("click", { ...options, bubbles: true, cancelable: true }));
    platform.mockReturnValue("Win32");
    expect(click(link)).toBe(false);
    click(link, { metaKey: true });
    expect(openLink).not.toHaveBeenCalled();
    expect(click(link, { ctrlKey: true })).toBe(false);
    click(anchor, { ctrlKey: true });
    platform.mockReturnValue("MacIntel");
    click(link, { ctrlKey: true });
    click(link, { metaKey: true });
    expect(openLink.mock.calls).toEqual([["https://example.com/"], ["https://example.com/"]]);
    handle!.contextCaret!(true);
    expect(container.querySelector<HTMLElement>(".rich-context-caret")?.style.getPropertyValue("--context-caret-height")).toBe("25px");
    handle!.contextCaret!(false);
    expect(container.querySelector(".rich-context-caret")).toBeNull();
  } finally {
    platform.mockRestore();
    measure.mockRestore();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("selects only the formula or divider when opening its context menu", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const clipboard = { read: vi.fn(), write: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="objects" ref={value => { handle = value; }}
      value={"前文\n\n---\n\n$$\nx^2\n$$\n\n后文"} readOnly={false} onChange={vi.fn()} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    for (const [selector, text, html] of [["hr", "", "<hr>"], [".rich-formula", "x^2", 'data-math="math_block"']]) {
      const element = container.querySelector(selector)!;
      const event = new MouseEvent("contextmenu", { button: 2 });
      let scope: ReturnType<MarkdownEditorHandle["prepareContext"]> | undefined;
      element.addEventListener("contextmenu", () => { scope = handle!.prepareContext(event); }, { once: true });
      element.dispatchEvent(event);
      expect(scope).toBe("object");
      handle!.clipboard("copy", clipboard);
      expect(clipboard.write.mock.lastCall![0]).toBe(text);
      expect(clipboard.write.mock.lastCall![1]).toContain(html);
    }
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("shows fences while editing a code block and uses the chosen language after blur", async () => {
  const container = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(container, outside);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="language"
      value={"\x60\x60\x60javascript\nconst value = 1;\n\x60\x60\x60\n\n代码之后的正文"} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const block = container.querySelector(".rich-code-block")!;
    expect(block.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(block.querySelector(".rich-code-language")?.textContent).toBe("javascript");
    handle!.focus();
    expect(block.classList).toContain("rich-code-active");
    const selectAll = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    block.querySelector("code")!.dispatchEvent(selectAll);
    expect(selectAll.defaultPrevented).toBe(true);
    const clipboard = { read: vi.fn(), write: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
    handle!.clipboard("copy", clipboard);
    expect(clipboard.write.mock.lastCall![0]).toBe("const value = 1;");
    handle!.contextCaret!(true);
    outside.focus();
    expect(block.classList).toContain("rich-code-active");
    expect(block.querySelector(".rich-context-caret")).toBeNull();
    handle!.contextCaret!(false);
    expect(block.classList).not.toContain("rich-code-active");
    handle!.focus();
    expect([...block.querySelectorAll<HTMLElement>(".rich-code-fence")].map(fence => fence.dataset.markdown)).toEqual(["\x60\x60\x60", "\x60\x60\x60"]);
    const input = block.querySelector<HTMLInputElement>("input")!;
    expect(input.closest(".rich-code-fence-open")).not.toBeNull();
    expect(input.value).toBe("javascript");
    input.focus();
    expect(document.activeElement).toBe(input);
    input.value = "typescript";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onChange.mock.lastCall![2]).toMatch(/^\x60\x60\x60typescript/);
    outside.focus();
    expect(block.classList).not.toContain("rich-code-active");
    expect(block.querySelector(".rich-code-language")?.textContent).toBe("typescript");
    expect(block.querySelector(".hljs-keyword")?.textContent).toBe("const");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    outside.remove();
  }
});

it("inserts pasted images with their document, then localizes external URLs in place", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const onChange = vi.fn();
  let finishDownload: (url: string) => void;
  const pending = new Promise<string>(resolve => { finishDownload = resolve; });
  const external = "https://cdn.example.com/diagram.png";
  const owned = "https://images.example.com/workspace/cover.png";
  const localizeImage = vi.fn((url: string) => url === external ? pending : Promise.resolve(url));
  const importImage = vi.fn(async (_file: File) => "asset://embedded-graph");
  const io = {
    read: async () => ({
      html: `<h2>资料</h2><p>出处<sup data-type="footnote_reference" data-label="media">media</sup></p>`
        + '<dl data-type="footnote_definition" data-label="media"><dt>media</dt><dd><p>脚注来源</p></dd></dl>'
        + `<p><img src="${external}" alt="示意图" title="原注释"><img src="${owned}" alt="封面"><img src="data:image/png;base64,AAEC" alt="内嵌图"></p>`,
    }),
    write: vi.fn(), onError: vi.fn(), localizeImage, importImage,
  };
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="pasted-images"
      value="" readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    handle!.clipboard("paste", io);
    await vi.waitFor(() => expect(localizeImage).toHaveBeenCalledTimes(2));
    expect(importImage.mock.lastCall?.[0]).toMatchObject({ type: "image/png", size: 3 });
    expect(container.querySelector("h2")?.textContent).toBe("资料");
    expect(onChange.mock.lastCall![2]).toContain(external);
    expect(onChange.mock.lastCall![2]).toContain("![内嵌图](asset://embedded-graph)");
    expect(onChange.mock.lastCall![2]).toMatch(/\[\^media\]: 脚注来源$/);
    const editor = container.querySelector(".ProseMirror")!;
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    finishDownload!("asset://local-graph");
    await vi.waitFor(() => expect(onChange.mock.lastCall![2]).toContain('![示意图](asset://local-graph "原注释")'));
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(onChange.mock.lastCall![2]).toContain(`![封面](${owned})`);
    handle!.command("undo");
    expect(container.querySelector("h2")).toBeNull();
    handle!.command("redo");
    expect(onChange.mock.lastCall![2]).toContain("asset://local-graph");
    expect(io.onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("shows Markdown at the caret and folds only the selected heading section without changing the document", async () => {
  const container = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(container, outside);
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "开头 **粗体** [**链接** 文本](https://example.com)\n\n## 第一节\n\n第一节正文\n\n#### 子标题\n\n子节正文\n\n## 第二节\n\n第二节正文\n\n> ~~~text\n> 首行代码\n> 次行代码\n> ~~~"
    + "\n\n> **第一段引用**\n>\n> 第二段引用  \n> 手动换行\n>\n> > ### 嵌套引用";
  const render = (lineNumbers: boolean, readOnly = false) => {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="presentation" value={markdown}
      lineNumbers={lineNumbers} readOnly={readOnly} onChange={onChange} onBlur={() => {}} />));
  };
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    const firstHeading = editor.querySelector("h2")!;
    const markers = () => [...editor.querySelectorAll<HTMLElement>(".rich-markdown-syntax")].map(node => node.dataset.markdown);
    function setCaret(text: Node, offset: number) {
      handle!.focus();
      document.getSelection()!.collapse(text, offset);
      document.dispatchEvent(new Event("selectionchange"));
    }

    expect(markers()).toEqual([]);
    setCaret(editor.querySelector("strong")!.firstChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["**", "**"]));
    setCaret(document.createTreeWalker(editor.querySelector("a")!, NodeFilter.SHOW_TEXT).nextNode()!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["[", "**", "**", "](https://example.com)"]));
    setCaret(firstHeading.lastChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["## "]));
    const quote = editor.querySelectorAll(":scope > blockquote")[1];
    const [firstQuote, secondQuote] = quote.querySelectorAll(":scope > p");
    const nestedHeading = quote.querySelector("blockquote h3")!;
    setCaret(firstQuote.querySelector("strong")!.firstChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> ", "**", "**"]));
    setCaret(secondQuote.lastChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> ", "> "]));
    setCaret(nestedHeading.lastChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> > ", "### "]));
    setCaret(editor.querySelector("p")!.firstChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual([]));
    setCaret(nestedHeading.lastChild!, 1);
    await vi.waitFor(() => expect(markers()).toEqual(["> > ", "### "]));
    outside.focus();
    expect(markers()).toEqual([]);

    render(true);
    expect(firstHeading.dataset.editorLine).toBe("2");
    expect([...editor.querySelectorAll<HTMLElement>("blockquote pre .rich-code-line-number")].map(node => node.dataset.editorLine)).toEqual(["9", "10"]);
    firstHeading.querySelector<HTMLButtonElement>(".rich-heading-fold")!.click();
    expect([...editor.querySelectorAll(":scope > [hidden]")].map(node => node.textContent)).toEqual([
      "第一节正文", "子标题", "子节正文",
    ]);
    expect(firstHeading.querySelector(".rich-heading-fold")!.getAttribute("aria-expanded")).toBe("false");
    expect(editor.querySelectorAll("h2")[1].dataset.editorLine).toBe("6");
    expect(onChange).not.toHaveBeenCalled();

    setCaret(editor.querySelector("p")!.firstChild!, 1);
    await vi.waitFor(() => expect(handle!.target().from).toBe(2));
    handle!.insert("新增");
    expect(editor.querySelectorAll(":scope > [hidden]")).toHaveLength(3);
    firstHeading.querySelector<HTMLButtonElement>(".rich-heading-fold-end")!.click();
    expect(editor.querySelector(":scope > [hidden]")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);

    render(false, true);
    expect(editor.querySelector("[data-editor-line]")).toBeNull();
    setCaret(nestedHeading.lastChild!, 1);
    expect(markers()).toEqual([]);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    outside.remove();
  }
});

it("shows the active list item's Markdown marker and keeps its task state clickable", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onChange = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const markdown = "普通正文\n\n- 父项\n  - 子项\n\n4. 第一项\n5. 第二项\n\n- [ ] 待办";
  try {
    flushSync(() => root.render(<MarkdownEditor ref={value => { handle = value; }} entryId="list-source"
      value={markdown} readOnly={false} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const editor = container.querySelector(".ProseMirror")!;
    const marker = () => editor.querySelector<HTMLElement>(".rich-markdown-syntax");
    for (const [selector, prefix] of [["ul ul li > p", "- "], ["ol li + li > p", "5. "], ['li[data-checked="false"] > p', "- [ ] "]]) {
      const paragraph = editor.querySelector(selector)!;
      handle!.focus();
      document.getSelection()!.collapse(paragraph.lastChild!, 1);
      document.dispatchEvent(new Event("selectionchange"));
      await vi.waitFor(() => expect(marker()?.dataset.markdown).toBe(prefix));
      expect(editor.querySelectorAll("li.rich-list-source")).toHaveLength(1);
      expect(marker()?.parentElement).toBe(paragraph);
    }
    expect(onChange).not.toHaveBeenCalled();
    marker()!.click();
    expect(onChange.mock.lastCall![2]).toMatch(/[-*+] \[x\] 待办/);
    expect(marker()?.dataset.markdown).toBe("- [x] ");

    document.getSelection()!.collapse(editor.querySelector(":scope > p")!.firstChild!, 1);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(marker()).toBeNull());
    expect(editor.querySelector("li.rich-list-source")).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("uses the asset resolver without connecting the persisted URLs to image elements", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const disposeFirst = vi.fn();
  const disposeLate = vi.fn();
  const onError = vi.fn();
  const onChange = vi.fn();
  let finishLate!: (image: { src: string; dispose(): void }) => void;
  const resolveImage = vi.fn().mockResolvedValueOnce({ src: "blob:local", dispose: disposeFirst })
    .mockImplementationOnce(() => new Promise(resolve => { finishLate = resolve; }));
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="images"
      value={"![素材](asset://local)\n\n![图片](https://example.com/image.png)"}
      readOnly={false} resolveImage={resolveImage} onError={onError} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(resolveImage).toHaveBeenCalledTimes(2));
    expect(resolveImage.mock.calls).toEqual([["asset://local"], ["https://example.com/image.png"]]);
    expect([...container.querySelectorAll("img[src]")].map(node => node.getAttribute("src"))).toEqual(["blob:local"]);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
  finishLate({ src: "blob:late", dispose: disposeLate });
  await vi.waitFor(() => {
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeLate).toHaveBeenCalledOnce();
  });
  expect(onError).not.toHaveBeenCalled();
});

it("refreshes an unavailable image on asset change without editing Markdown or reloading its session", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onError = vi.fn();
  const missing = new Error("图片尚未保存");
  const dispose = vi.fn();
  const resolveImage = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({ src: "blob:recovered", dispose });
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="asset" ref={value => { handle = value; }} value="![插图](asset://pending)"
      readOnly={false} resolveImage={resolveImage} imageErrorMessage={error => (error as Error).message}
      onError={onError} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => {
      expect(handle).not.toBeNull();
      expect(container.querySelector(".rich-image-status")?.textContent).toContain(missing.message);
    });
    const target = handle!.target();
    handle!.retryMissingImages();
    await vi.waitFor(() => expect(container.querySelector(".rich-image img")?.getAttribute("src")).toBe("blob:recovered"));
    expect(handle!.target()).toEqual(target);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});

it("retries a failed external image from its own placeholder", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const url = "https://images.example.com/picture.png";
  const resolveImage = vi.fn().mockRejectedValueOnce(new Error("无法加载图片"))
    .mockResolvedValueOnce({ src: "blob:retried", dispose: vi.fn() });
  const onChange = vi.fn();
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="external-image" value={`![配图](${url})`}
      readOnly={false} resolveImage={resolveImage} onImageZoom={vi.fn()} onChange={onChange} onBlur={() => {}} />));
    await vi.waitFor(() => expect(container.querySelector(".rich-image-retry")).not.toBeNull());
    const retry = container.querySelector<HTMLButtonElement>(".rich-image-retry")!;
    retry.focus();
    retry.click();
    expect(resolveImage.mock.calls).toEqual([[url], [url, true]]);
    await vi.waitFor(() => expect(container.querySelector(".rich-image img")?.getAttribute("src")).toBe("blob:retried"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("放大图片");
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("zooms the selected image and commits valid Markdown when its line loses focus", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onImageZoom = vi.fn();
  const resolveImage = vi.fn(async (url: string) => ({ src: "blob:" + url, dispose() {} }));
  let handle: MarkdownEditorHandle | null = null;
  function render(readOnly: boolean) {
    flushSync(() => root.render(<MarkdownEditor entryId="image-tools"
      value={'图文示例\n\n![旧图](asset://old "说明")\n\n![另一张](asset://other)'}
      ref={value => { handle = value; }} readOnly={readOnly} resolveImage={resolveImage}
      onImageZoom={onImageZoom} onChange={onChange} onBlur={() => {}} />));
  }
  const sourceButton = () => container.querySelector<HTMLButtonElement>(".rich-image-source-toggle")!;
  const sourceField = () => container.querySelector<HTMLTextAreaElement>(".rich-image-source-editor textarea")!;
  try {
    render(false);
    const zoomButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!;
      expect(button?.disabled).toBe(false);
      return button;
    });
    zoomButton.click();
    expect(onImageZoom).toHaveBeenCalledWith({ src: "blob:asset://old", alt: "旧图" }, zoomButton);
    sourceButton().click();
    expect(sourceField().value).toBe('![旧图](asset://old "说明")');
    expect(handle!.clipboard("paste", { read: vi.fn(), write: vi.fn(), onError: vi.fn() }, sourceField())).toBe(false);
    sourceField().value = "这不是图片";
    const enter = () => sourceField().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    enter();
    expect(container.querySelector(".rich-image-source-editor [role=alert]")?.textContent).toContain("Markdown 图片");
    sourceField().blur();
    expect(sourceField().parentElement?.hidden).toBe(true);
    expect(onChange).not.toHaveBeenCalled();

    sourceButton().click();
    sourceField().value = "![新图](asset://replacement)";
    sourceField().blur();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("image-tools", 1, "图文示例\n\n![新图](asset://replacement)\n\n![另一张](asset://other)");
    expect(sourceField().parentElement?.hidden).toBe(true);

    sourceButton().click();
    sourceField().value = "![取消](asset://replacement)";
    sourceField().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sourceField().parentElement?.hidden).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    render(true);
    sourceButton().click();
    expect(sourceField().parentElement?.hidden).toBe(true);

    const second = await vi.waitFor(() => {
      const element = container.querySelector<HTMLImageElement>('img[alt="另一张"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const contextEvent = new MouseEvent("contextmenu", { bubbles: true, button: 2 });
    second.dispatchEvent(contextEvent);
    const image = handle!.prepareContext(contextEvent);
    expect(image).toMatchObject({ kind: "image", src: "asset://other", available: true });
    if (typeof image !== "object" || !image || !("kind" in image) || image.kind !== "image") throw new Error("expected image context");
    image.remove();
    expect(onChange).toHaveBeenCalledTimes(1);
    render(false);
    image.remove();
    expect(onChange).toHaveBeenLastCalledWith("image-tools", 2, "图文示例\n\n![新图](asset://replacement)");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
