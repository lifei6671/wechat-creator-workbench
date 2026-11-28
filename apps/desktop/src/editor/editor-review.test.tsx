// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EditorView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { SearchQuery } from "prosemirror-search";
import highlighter from "highlight.js/lib/common";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../../packages/editor-react";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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

async function mount(value: string, convertLinks = false, lineNumbers = false) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  flushSync(() => root.render(<Theme><MarkdownEditor entryId="probe" value={value} readOnly={false} convertLinks={convertLinks} lineNumbers={lineNumbers}
    ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} /></Theme>));
  await vi.waitFor(() => expect(handle).not.toBeNull());
  const focus = vi.spyOn(EditorView.prototype, "focus");
  handle!.focus();
  const view = focus.mock.contexts.at(-1) as EditorView;
  focus.mockRestore();
  return { root, container, handle: handle!, view, dispose() { flushSync(() => root.unmount()); container.remove(); } };
}

function enter(container: HTMLElement, label: string, value: string) {
  flushSync(() => {
    const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function click(container: HTMLElement, label: string) {
  flushSync(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
}

it.each(["**", "__"])("recognizes %s bold when a separator is added after its closing delimiter", async delimiter => {
  const source = `${delimiter}标题：${delimiter}不到两个月斩获 2.3K Star！`;
  const m = await mount(source);
  try {
    expect(m.container.querySelector("strong")).toBeNull();
    const pos = source.indexOf("不到") + 1;
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, pos)));
    m.view.dispatch(m.view.state.tr.insertText(" "));
    expect(m.container.querySelector("strong")?.textContent).toBe("标题：");
    expect(m.view.state.doc.textContent).toBe("标题： 不到两个月斩获 2.3K Star！");
    expect(m.view.state.selection.from).toBe(5);
    const changed = m.handle.captureMarkdown().markdown;
    m.handle.command("undo");
    expect(m.container.querySelector("strong")).toBeNull();
    expect(m.view.state.doc.textContent).toBe(source);
    m.handle.command("redo");
    expect(m.handle.captureMarkdown().markdown).toBe(changed);
    expect(m.container.querySelector("strong")?.textContent).toBe("标题：");
  } finally { m.dispose(); }
});

it.each(["**", "__"])("still recognizes %s bold after removing invalid inner whitespace", async delimiter => {
  const source = `${delimiter}标题： ${delimiter} 后文`;
  const m = await mount(source);
  try {
    const pos = source.indexOf(" ") + 1;
    m.view.dispatch(m.view.state.tr.delete(pos, pos + 1));
    expect(m.container.querySelector("strong")?.textContent).toBe("标题：");
  } finally { m.dispose(); }
});

it.each([
  { source: "\\*\\*literal\\*\\*后文", needle: "后文" },
  { source: "`**标题：**后文`", needle: "后文" },
  { source: "**标题：**后文", needle: "文" },
  { source: "**标题： **后文", needle: "后文" },
])("keeps unrelated or still-invalid literal syntax when inserting a space ($source)", async ({ source, needle }) => {
  const m = await mount(source);
  try {
    const text = m.view.state.doc.textContent;
    m.view.dispatch(m.view.state.tr.insertText(" ", text.indexOf(needle) + 1));
    expect(m.container.querySelector("strong")).toBeNull();
    expect(m.view.state.doc.textContent).toBe(text.replace(needle, " " + needle));
  } finally { m.dispose(); }
});

it.each([
  { closingFirst: false, surrounding: false }, { closingFirst: true, surrounding: false },
  { closingFirst: false, surrounding: true }, { closingFirst: true, surrounding: true },
])("promotes inline code when two backticks are added to each side ($closingFirst, $surrounding)", async ({ closingFirst, surrounding }) => {
  const m = await mount(surrounding ? "前文\n\n**说明** `const value = 1;` 后文\n\n末段" : "`const value = 1;`");
  try {
    for (const opening of closingFirst ? [false, true] : [true, false]) {
      for (let index = 0; index < 2; index++) {
        let from = 0, to = 0;
        m.view.state.doc.descendants((node, pos) => {
          if (node.isText && node.marks.some(mark => mark.type.name === "inlineCode")) {
            from = pos;
            to = pos + node.nodeSize;
          }
        });
        const position = opening ? from : to;
        m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, position)));
        const handled = m.view.someProp("handleTextInput", handler => handler(m.view, position, position, "`",
          () => m.view.state.tr.insertText("`")));
        if (!handled) m.view.dispatch(m.view.state.tr.insertText("`"));
        if (index === 0) expect(m.container.querySelector("pre")).toBeNull();
      }
    }
    expect(m.container.querySelector("pre > code")?.textContent).toBe("const value = 1;");
    expect(m.handle.captureMarkdown().markdown).toBe(surrounding
      ? "前文\n\n**说明** \n\n```\nconst value = 1;\n```\n\n&#x20;后文\n\n末段" : "```\nconst value = 1;\n```");
    expect(m.view.state.selection.$from.parent.type.name).toBe("code_block");
    m.handle.command("undo");
    expect(m.container.querySelector("pre")).toBeNull();
    expect(m.container.querySelector("p code")?.textContent).toBe("const value = 1;");
  } finally { m.dispose(); }
});

it.each([false, true])("promotes the screenshot's fenced inline code after a DOM edit (composition=%s)", async composition => {
  const command = "npm i -g @el4cteo/fast-anything";
  const m = await mount("`" + command + "`");
  try {
    const code = m.container.querySelector("p > code")!;
    if (composition) m.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const leading = document.createTextNode("``");
    const trailing = document.createTextNode("``");
    code.before(leading);
    code.after(trailing);
    document.getSelection()!.collapse(trailing, 2);
    document.dispatchEvent(new Event("selectionchange"));
    if (composition) {
      await vi.waitFor(() => expect(m.view.state.doc.textContent).toBe("``" + command + "``"));
      expect(m.container.querySelector("pre")).toBeNull();
      m.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    }
    await vi.waitFor(() => expect(m.container.querySelector("pre > code")?.textContent).toBe(command));
    expect(m.handle.captureMarkdown().markdown).toBe("```\n" + command + "\n```");
    m.handle.command("undo");
    expect(m.container.querySelector("pre")).toBeNull();
    expect(m.container.querySelector("p > code")?.textContent).toBe(command);
  } finally { m.dispose(); }
});

it("keeps escaped inline fences unchanged during initial document layout", async () => {
  const source = "\\`\\``npm i -g @el4cteo/fast-anything`\\`\\`\n\n```\nlast block\n```";
  const m = await mount(source);
  try {
    expect(m.container.querySelectorAll("pre")).toHaveLength(1);
    expect(m.container.querySelector("p > code")?.textContent).toBe("npm i -g @el4cteo/fast-anything");
    expect(m.handle.captureMarkdown().markdown).toBe(source);
  } finally { m.dispose(); }
});

it.each([false, true])("preserves escaped fences and the caret when editing elsewhere in their paragraph (composition=%s)", async composition => {
  const source = "\\`\\``literal`\\`\\` 后文";
  const m = await mount(source);
  try {
    const end = m.view.state.doc.firstChild!.nodeSize - 1;
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, end)));
    if (composition) m.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    m.view.dispatch(m.view.state.tr.insertText("新文字"));
    if (composition) {
      m.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(m.container.querySelector("pre")).toBeNull();
    expect(m.handle.captureMarkdown().markdown).toBe(source + "新文字");
    expect(m.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(m.view.state.selection.from).toBe(end + 3);
  } finally { m.dispose(); }
});

it("only promotes the newly completed fence when an escaped fence shares its paragraph", async () => {
  const m = await mount("\\`\\``literal`\\`\\` and `new code`");
  try {
    for (const opening of [true, false]) {
      let position = 0;
      m.view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "new code") position = opening ? pos : pos + node.nodeSize;
      });
      m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, position)));
      m.view.someProp("handleTextInput", handler => handler(m.view, position, position, "``", () => m.view.state.tr.insertText("``")));
    }
    expect(m.container.querySelectorAll("pre")).toHaveLength(1);
    expect(m.container.querySelector("pre > code")?.textContent).toBe("new code");
    expect(m.container.querySelector("p > code")?.textContent).toBe("literal");
    expect(m.container.querySelector("p")?.textContent).toBe("``literal`` and ");
  } finally { m.dispose(); }
});

it("rescans only changed search blocks while preserving full counts and replacements", async () => {
  const m = await mount(Array.from({ length: 300 }, () => "第一处旧词，第二处旧词。").join("\n\n"));
  const find = vi.spyOn(SearchQuery.prototype, "findNext");
  try {
    flushSync(() => m.handle.search());
    enter(m.container, "查找", "旧词");
    find.mockClear();
    flushSync(() => m.view.dispatch(m.view.state.tr.insertText("前缀", 1)));
    expect(find.mock.calls.length).toBeLessThan(10);
    expect(m.container.querySelector("output")?.textContent).toContain("600");
    find.mockClear();
    flushSync(() => m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 2))));
    expect(find).not.toHaveBeenCalled();
    click(m.container, "展开替换");
    enter(m.container, "替换", "新词");
    click(m.container, "全部替换");
    expect(m.handle.captureMarkdown().markdown.match(/新词/g)).toHaveLength(600);
    expect(m.handle.captureMarkdown().markdown).not.toContain("旧词");
  } finally { find.mockRestore(); m.dispose(); }
});

it.each([false, true])("defers code recoloring until typing pauses while preserving code and line numbers (numbers=%s)", async numbers => {
  const m = await mount("```javascript\nconst original = 1;\n```", false, numbers);
  const highlight = vi.spyOn(highlighter, "highlight");
  vi.useFakeTimers();
  try {
    for (const source of ["let draft = 2;", "let final = 3;\nreturn final;"]) {
      m.view.dispatch(m.view.state.tr.insertText(source, 1, 1 + m.view.state.doc.firstChild!.content.size));
    }
    expect(m.container.querySelector("code")?.textContent).toBe("let final = 3;\nreturn final;");
    expect(highlight).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(highlight).toHaveBeenCalledOnce();
    expect([...m.container.querySelectorAll(".hljs-keyword")].map(node => node.textContent)).toContain("let");
    if (numbers) expect([...m.container.querySelectorAll(".rich-code-line-number")].map(node => node.getAttribute("data-editor-line"))).toEqual(["1", "2"]);
    m.view.dispatch(m.view.state.tr.insertText(" ", 2));
    m.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(highlight).toHaveBeenCalledOnce();
  } finally { highlight.mockRestore(); vi.useRealTimers(); if (m.container.isConnected) m.dispose(); }
});

it("reuses link footnotes across plain paragraph splits and refreshes numbering for new links", async () => {
  const m = await mount("普通段落\n\n[链接](https://example.com)", true);
  try {
    const notes = m.container.querySelector(".rich-link-notes")!;
    m.view.dispatch(m.view.state.tr.split(3));
    expect(m.container.querySelector(".rich-link-notes")).toBe(notes);
    m.view.dispatch(m.view.state.tr.insertText("https://example.com/new", 1));
    expect(m.container.querySelector(".rich-link-notes")).not.toBe(notes);
    expect([...m.container.querySelectorAll(".rich-link-citation")].map(node => node.textContent)).toEqual(["[^1]", "[^2]"]);
  } finally { m.dispose(); }
});

it("checks replace after asynchronous editor updates and direct same-task reentrancy", async () => {
  for (const sameTask of [false, true]) {
    const m = await mount("old old");
    const coords = vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 });
    const input = (label: string, value: string) => flushSync(() => {
      const field = m.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    try {
      flushSync(() => m.handle.search());
      input("查找", "old");
      flushSync(() => m.container.querySelector<HTMLButtonElement>('button[aria-label="展开替换"]')!.click());
      input("替换", "new");
      await Promise.resolve().then(async () => {
        m.view.dispatch(m.view.state.tr.insertText("prefix ", 1));
        if (!sameTask) await new Promise(done => setTimeout(done, 0));
        m.container.querySelector<HTMLButtonElement>('button[aria-label="全部替换"]')!.click();
      });
      expect(m.handle.captureMarkdown().markdown).toBe("prefix new new");
    } finally { coords.mockRestore(); m.dispose(); }
  }
});

it("checks switching an existing footnote draft without unmounting the editor", async () => {
  const m = await mount("甲[^a]乙[^b]\n\n[^a]: 第一条\n\n[^b]: 第二条");
  const coords = vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 });
  try {
    for (const label of ["a", "b"]) {
      flushSync(() => m.container.querySelector<HTMLElement>(`sup[data-label="${label}"]`)!.click());
      expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="脚注内容"]')!.value).toBe(label === "a" ? "第一条" : "第二条");
    }
  } finally { coords.mockRestore(); m.dispose(); }
});

it("preserves search and replacement settings when reopening the same document", async () => {
  const m = await mount("Word word");
  try {
    flushSync(() => m.handle.search());
    enter(m.container, "查找", "Word");
    click(m.container, "展开替换");
    enter(m.container, "替换", "Changed");
    for (const label of ["区分大小写", "全词匹配", "正则表达式"]) click(m.container, label);
    click(m.container, "关闭查找");
    flushSync(() => m.handle.search());
    expect(m.container.querySelector<HTMLInputElement>('input[aria-label="查找"]')!.value).toBe("Word");
    expect(m.container.querySelector<HTMLInputElement>('input[aria-label="替换"]')!.value).toBe("Changed");
    for (const label of ["区分大小写", "全词匹配", "正则表达式"]) {
      expect(m.container.querySelector(`[aria-label="${label}"]`)!.getAttribute("aria-pressed")).toBe("true");
    }
    click(m.container, "全部替换");
    expect(m.handle.captureMarkdown().markdown).toBe("Changed word");
  } finally { m.dispose(); }
  const another = await mount("另一个文稿");
  try {
    flushSync(() => another.handle.search());
    expect(another.container.querySelector<HTMLInputElement>('input[aria-label="查找"]')!.value).toBe("");
  } finally { another.dispose(); }
});

it("keeps cached regex replacement groups aligned when an earlier block changes length", async () => {
  const m = await mount("first\n\nsecond 12-34");
  try {
    flushSync(() => m.handle.search());
    enter(m.container, "查找", "(\\d+)-(\\d+)");
    click(m.container, "正则表达式");
    click(m.container, "展开替换");
    enter(m.container, "替换", "$2/$1");
    flushSync(() => m.view.dispatch(m.view.state.tr.insertText("long prefix ", 1)));
    click(m.container, "全部替换");
    expect(m.handle.captureMarkdown().markdown).toBe("long prefix first\n\nsecond 34/12");
  } finally { m.dispose(); }
});

it.each([["heading4", 4], ["heading5", 5], ["heading6", 6]] as const)("applies %s through commands with undo and redo", async (command, level) => {
  const m = await mount("标题");
  try {
    m.handle.command(command);
    expect(m.container.querySelector(`h${level}`)).not.toBeNull();
    expect(m.view.state.doc.firstChild!.textContent).toBe("标题");
    expect(m.handle.captureMarkdown().markdown).toBe("#".repeat(level) + " 标题");
    m.handle.command("undo");
    expect(m.handle.captureMarkdown().markdown).toBe("标题");
    m.handle.command("redo");
    expect(m.container.querySelector(`h${level}`)).not.toBeNull();
    expect(m.view.state.doc.firstChild!.textContent).toBe("标题");
  } finally { m.dispose(); }
});

it.each([5, 6])("inserts heading %s through the filtered slash menu", async level => {
  const m = await mount("");
  try {
    m.handle.insert(`/h${level}`);
    const menu = m.container.querySelector<HTMLElement>(".rich-slash-menu")!;
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect(menu.querySelector("button")?.textContent).toContain(`标题 ${level}`);
    m.container.querySelector(".ProseMirror")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    m.handle.insert("深层标题");
    expect(m.handle.captureMarkdown().markdown).toBe("#".repeat(level) + " 深层标题");
  } finally { m.dispose(); }
});

it.each([false, true])("retains invalid formula drafts on blur and saves corrected source (block=%s)", async block => {
  const original = block ? "$$\nx^2\n$$" : "$x^2$";
  const m = await mount(original);
  try {
    m.container.querySelector<HTMLButtonElement>(".rich-formula-trigger")!.focus();
    const field = m.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(".rich-formula-source")!;
    field.value = "未完成的公式";
    field.blur();
    expect(field.hidden).toBe(false);
    expect(field.value).toBe("未完成的公式");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(m.container.querySelector<HTMLElement>(".rich-formula-error")!.hidden).toBe(false);
    expect(m.handle.captureMarkdown().markdown).toBe(original);
    field.focus();
    field.value = block ? "$$\nx^3\n$$" : "$x^3$";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.blur();
    expect(m.handle.captureMarkdown().markdown).toBe(original.replace("x^2", "x^3"));
  } finally { m.dispose(); }
});

it.each(["", "![", "未完成的图片"])("allows replacing image Markdown with %j, undoing, and cancelling", async replacement => {
  const original = "![图片](asset://original)";
  const m = await mount(original);
  try {
    const button = () => m.container.querySelector<HTMLButtonElement>(".rich-image-source-toggle")!;
    const field = () => m.container.querySelector<HTMLTextAreaElement>(".rich-image-source-editor textarea")!;
    button().click();
    field().value = replacement;
    field().blur();
    expect(m.container.querySelector(".rich-image")).toBeNull();
    expect(m.container.querySelector('[role="alert"]')).toBeNull();
    expect(m.view.state.doc.textContent).toBe(replacement);
    expect(m.handle.captureMarkdown().markdown).not.toContain("asset://original");
    m.handle.command("undo");
    expect(m.handle.captureMarkdown().markdown).toBe(original);
    button().click();
    field().value = "取消的修改";
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(field().parentElement!.hidden).toBe(true);
    expect(m.handle.captureMarkdown().markdown).toBe(original);
    button().click();
    field().value = "![新图](asset://corrected)";
    field().dispatchEvent(new Event("input", { bubbles: true }));
    field().blur();
    expect(m.handle.captureMarkdown().markdown).toBe("![新图](asset://corrected)");
  } finally { m.dispose(); }
});
