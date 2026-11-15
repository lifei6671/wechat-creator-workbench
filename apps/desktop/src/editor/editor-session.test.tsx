// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EditorView } from "@milkdown/kit/prose/view";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor, type EditorCommand, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import type { Entry } from "../../../../packages/shared-types";
import { attachClipboard } from "./clipboard";
import { SaveQueue } from "./save-queue";
import { captureAiTask, matchesAiTarget } from "../workspace/AiPanel";
import formatFixtures from "../../../../fixtures/wechat-format.json";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // jsdom lacks the Range geometry used by ProseMirror when undo and commands scroll.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [new DOMRect()] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

async function select(element: HTMLElement, from: number, to: number, handle: MarkdownEditorHandle) {
  const text = element.querySelector("p")!.firstChild!;
  handle.focus();
  document.getSelection()!.setBaseAndExtent(text, from, text, to);
  document.dispatchEvent(new Event("selectionchange"));
  await vi.waitFor(() => expect(handle.target().original).toBe(text.textContent!.slice(from, to)));
}

it("binds an AI rewrite to the original session and range and gives it a separate undo step", async () => {
  const entry: Entry = { id: "draft", kind: "article", title: "标题", contentMd: "初稿 第一段 第二段", status: "draft", categoryId: null,
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
    const task = captureAiTask(original, handle, "rewrite");
    expect(task.request.text).toBe("第一段");
    expect(matchesAiTarget(task.target, createQueue(entry))).toBe(false);
    expect(matchesAiTarget(task.target, other)).toBe(false);
    await select(editor, 8, 11, handle);
    expect(matchesAiTarget(task.target, original)).toBe(true);
    expect(handles.get(other.entry.id)!.replaceTarget(task.target.editor!, "新段落")).toBe(false);
    expect(handle.replaceTarget(task.target.editor!, "新段落")).toBe(true);
    expect(original.snapshot().fields.contentMd).toBe("!初稿 新段落 第二段");
    expect(matchesAiTarget(task.target, original)).toBe(false);
    handle.command("undo");
    expect(original.snapshot().fields.contentMd).toBe("!初稿 第一段 第二段");
  } finally {
    original.dispose();
    other.dispose();
    flushSync(() => root.unmount());
    editorContainer.remove();
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
    handle!.insert("新文字");
    finish("![图](asset://asset)");
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("first", 2, "新文字![图](asset://asset)原稿"));

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
    expect(editor.querySelector("sup")?.textContent).toBe("n");
    expect(editor.querySelector('[data-type="html-block"]')?.textContent).toBe("嵌入的 HTML");
    expect(editor.querySelector("[onclick], script")).toBeNull();
    expect(editor.textContent).not.toMatch(/\*\*粗体|\[\^n\]|<em>|# 标题/);
    expect(onChange).not.toHaveBeenCalled();
    handle!.insert("甲");
    const saved: string = onChange.mock.lastCall![2];
    expect(saved).toMatch(/^甲引言\n\n# 标题/m);
    expect(saved).toContain("**粗体** ~~删除~~");
    expect(saved).toContain("[x] 已完成");
    expect(saved).toMatch(/\|\s+一\s+\|\s+二\s+\|/);
    expect(saved).toContain("正文[^n] 和 <em>内嵌</em>。");
    expect(saved).toContain("[^n]: 脚注");
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
    flushSync(() => input("查找").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(container.querySelector('[role="search"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".ProseMirror"));
  } finally {
    coordinates.mockRestore();
    flushSync(() => root.unmount());
    container.remove();
  }
});

it("round-trips formula, task and footnote metadata through native rich clipboard HTML", async () => {
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
    await mount("source", "- [x] 已完成\n\n公式 $x^2$，详见[^1]。\n\n[^1]: 说明");
    handle!.command("selectAll");
    handle!.clipboard("copy", clipboard);
    const html = clipboard.write.mock.calls[0][1];
    await mount("target", "");
    clipboard.read.mockResolvedValue({ html: html +
      '<div data-type="html-block" data-value="&lt;script&gt;alert(1)&lt;/script&gt;">嵌入的 HTML</div>' +
      '<p><span data-math="math_inline" data-display="true" data-value="a$$&#10;&#10;&lt;img src=x onerror=1&gt;&#10;&#10;$$b">行内公式</span></p>' +
      '<div data-math="math_block" data-value="a&#10;$$&#10;http://example.com">块公式</div>' });
    handle!.clipboard("paste", clipboard);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const markdown = onChange.mock.lastCall![2] as string;
    expect(markdown).toContain("[x] 已完成");
    expect(markdown).toContain("$x^2$，详见[^1]");
    expect(markdown).toContain("[^1]: 说明");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("onerror");
    expect(markdown).not.toContain("http://example.com");
    expect(clipboard.onError).not.toHaveBeenCalled();
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
      ["footnote", 'sup[data-type="footnote_reference"]', /\[\^1\]/],
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
    container.querySelector<HTMLButtonElement>(".rich-table-add-column")!.click();
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
  async function mount(entryId: string, markdown: string) {
    flushSync(() => root.render(<MarkdownEditor key={entryId} ref={value => { handle = value; }} entryId={entryId}
      value={markdown} readOnly={false} onChange={onChange} onBlur={() => {}} />));
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
      html: `<h2>资料</h2><p><img src="${external}" alt="示意图" title="原注释"><img src="${owned}" alt="封面"><img src="data:image/png;base64,AAEC" alt="内嵌图"></p>`,
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
  const markdown = "开头 **粗体** [**链接** 文本](https://example.com)\n\n## 第一节\n\n第一节正文\n\n#### 子标题\n\n子节正文\n\n## 第二节\n\n第二节正文\n\n> ~~~text\n> 首行代码\n> 次行代码\n> ~~~";
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
    setCaret(firstHeading.lastChild!, 1);
    expect(markers()).toEqual([]);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    outside.remove();
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
    if (typeof image !== "object" || !image || !("kind" in image)) throw new Error("expected image context");
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
