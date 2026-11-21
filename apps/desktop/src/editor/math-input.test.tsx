// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EditorView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { undoInputRule } from "@milkdown/kit/prose/inputrules";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { graphic } from "../../../../packages/wechat-renderer/graphics";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:formula");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [new DOMRect()] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

async function mount(value = "") {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  flushSync(() => root.render(<MarkdownEditor entryId="math-input" value={value} readOnly={false}
    ref={editor => { handle = editor; }} onDocumentChanged={() => {}} onBlur={() => {}} />));
  await vi.waitFor(() => expect(handle).not.toBeNull());
  const focus = vi.spyOn(EditorView.prototype, "focus");
  handle!.focus();
  const view = focus.mock.contexts.at(-1) as EditorView;
  focus.mockRestore();
  return { container, view, handle: handle!, dispose() { flushSync(() => root.unmount()); container.remove(); } };
}

function type(view: EditorView, text: string) {
  for (const character of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(character, from, to);
    if (!view.someProp("handleTextInput", handler => handler(view, from, to, character, insert))) view.dispatch(insert());
  }
}

it.each(["θ", String.raw`\theta`, "x^2"])("recognizes and renders typed inline math: %s", async expression => {
  const m = await mount();
  try {
    type(m.view, `$${expression}$`);
    expect(m.view.state.doc.firstChild!.firstChild!.type.name).toBe("math_inline");
    expect(m.handle.captureMarkdown().markdown).toBe(`$${expression}$`);
    await vi.waitFor(() => expect(m.container.querySelector(".rich-formula img")?.getAttribute("alt")).toBe(expression));
    expect(undoInputRule(m.view.state, m.view.dispatch)).toBe(true);
    expect(m.view.state.doc.textContent).toBe(`$${expression}$`);
  } finally { m.dispose(); }
});

it("loads and renders a literal Unicode theta formula", async () => {
  const m = await mount("$θ$");
  try {
    expect(m.view.state.doc.firstChild!.firstChild!.type.name).toBe("math_inline");
    await vi.waitFor(() => expect(m.container.querySelector(".rich-formula img")?.getAttribute("alt")).toBe("θ"));
    const rendered = await graphic("math-inline", "θ");
    expect(rendered.width).toBeGreaterThan(0);
    expect(rendered.height).toBeGreaterThan(0);
    expect(rendered.blob.type).toBe("image/svg+xml");
  } finally { m.dispose(); }
});

it.each(["$ θ $", String.raw`\$θ$`, "$$θ$$", "价格 $5"])("keeps non-inline-math input literal: %s", async text => {
  const m = await mount();
  try {
    type(m.view, text);
    expect(m.view.state.doc.textContent).toBe(text);
    expect(m.container.querySelector(".rich-formula")).toBeNull();
  } finally { m.dispose(); }
});

it.each(["`代码`", "```text\n代码\n```"])("keeps dollars literal inside code: %s", async source => {
  const m = await mount(source);
  try {
    let inside = 0;
    m.view.state.doc.descendants((node, pos) => { if (node.isText && node.text === "代码") inside = pos + 1; });
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, inside)));
    type(m.view, "$θ$");
    expect(m.view.state.doc.textContent).toBe("代$θ$码");
    expect(m.container.querySelector(".rich-formula")).toBeNull();
  } finally { m.dispose(); }
});

it("recognizes adjacent prose and successive formulas without moving the caret", async () => {
  const m = await mount();
  try {
    const source = "角度 $θ$，平方 $x^2$。";
    type(m.view, source);
    expect(m.container.querySelectorAll(".rich-formula")).toHaveLength(2);
    expect(m.handle.captureMarkdown().markdown).toBe(source);
    expect(m.view.state.selection.from).toBe(m.view.state.doc.content.size - 1);
  } finally { m.dispose(); }
});

it("parses a pasted Unicode formula through the same schema", async () => {
  const m = await mount();
  const io = { read: vi.fn().mockResolvedValue("$θ$"), write: vi.fn(), onError: vi.fn() };
  try {
    m.handle.clipboard("paste", io);
    await m.handle.pendingEdits();
    expect(m.view.state.doc.firstChild!.firstChild!.type.name).toBe("math_inline");
    expect(m.handle.captureMarkdown().markdown).toBe("$θ$");
    expect(io.onError).not.toHaveBeenCalled();
  } finally { m.dispose(); }
});

it("waits for IME composition to finish before converting the formula", async () => {
  const m = await mount();
  try {
    const body = m.container.querySelector(".ProseMirror")!;
    body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(m.view.composing).toBe(true);
    type(m.view, "$θ$");
    expect(m.view.state.doc.textContent).toBe("$θ$");
    expect(m.container.querySelector(".rich-formula")).toBeNull();
    body.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(m.container.querySelector(".rich-formula")).not.toBeNull());
    expect(m.handle.captureMarkdown().markdown).toBe("$θ$");
  } finally { m.dispose(); }
});
