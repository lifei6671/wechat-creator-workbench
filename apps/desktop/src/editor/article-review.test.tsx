// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EditorView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { projectReviewText, reviewRanges } from "../../../../packages/editor-react/review-projection";

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
async function mount(value: string) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  flushSync(() => root.render(<Theme><MarkdownEditor entryId="review-test" value={value} readOnly={false}
    ref={value => { handle = value; }} onDocumentChanged={() => {}} onBlur={() => {}} /></Theme>));
  await vi.waitFor(() => expect(handle).not.toBeNull());
  const focus = vi.spyOn(EditorView.prototype, "focus");
  handle!.focus();
  const view = focus.mock.contexts.at(-1) as EditorView;
  focus.mockRestore();
  return { container, handle: handle!, view, dispose() { flushSync(() => root.unmount()); container.remove(); } };
}

it("projects visible headings, marks, lists, quotes and breaks without excluded resources or URLs", async () => {
  const source = '# 标题\n\n段落 **中文😀** [链接](https://private.example/path) `行内`  \n换行\n\n> 引用\n\n- 第一项\n  - 内层\n\n```js\n代码不检测\n```\n\n| 表格 |\n| --- |\n| 不检测 |\n\n![图片](asset://test)\n\n$x^2$\n\n末尾 e\u0301';
  const m = await mount(source);
  try {
    const snapshot = m.handle.captureReview("document")!;
    expect(snapshot.projection.text).toBe("标题\n\n段落 中文😀 链接 行内\n换行\n\n引用\n\n第一项\n\n内层\n\n末尾 e\u0301");
    for (const run of snapshot.projection.runs) {
      expect(m.view.state.doc.textBetween(run.pmFrom, run.pmTo, "", "\n")).toBe(snapshot.projection.text.slice(run.textFrom, run.textTo));
    }
    const emoji = snapshot.projection.text.indexOf("😀");
    expect(reviewRanges(snapshot.projection, {from:emoji,to:emoji+1})).toEqual([]);
    expect(reviewRanges(snapshot.projection, {from:-1,to:2})).toEqual([]);
    const ranges = reviewRanges(snapshot.projection, {from:0,to:snapshot.projection.text.length});
    expect(ranges.length).toBeGreaterThan(6);
    expect(ranges.every(range => range.to > range.from)).toBe(true);
    expect(m.handle.captureReview("selection")).toBeNull();
    const selected = snapshot.projection.runs.find(run => snapshot.projection.text.slice(run.textFrom,run.textTo).includes("中文"))!;
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, selected.pmFrom+1,selected.pmTo)));
    const selection = m.handle.captureReview("selection")!;
    expect(selection.projection.text).toBe("文😀");
    expect(m.handle.matchesReview(snapshot)).toBe(true);
  } finally { m.dispose(); }
});

it("keeps review decorations out of serialization and history, preserves search, and invalidates on every document edit", async () => {
  const m = await mount("第一段中文😀\n\n第二段中文");
  try {
    const initial = m.handle.captureMarkdown().markdown;
    const snapshot = m.handle.captureReview("document")!;
    expect(m.handle.showReview(snapshot,[{id:"a",category:"ai_generated",range:{from:0,to:5}}])).toBe(true);
    expect(m.container.querySelectorAll(".review-mark").length).toBeGreaterThan(0);
    expect(m.handle.captureMarkdown().markdown).toBe(initial);
    flushSync(() => m.handle.search());
    m.handle.clearReview();
    expect(m.container.querySelector(".review-mark")).toBeNull();
    expect(m.container.querySelector('.rich-search')).not.toBeNull();
    m.handle.showReview(snapshot,[{id:"b",category:"ai_suspected",range:{from:0,to:4}}]);
    m.view.dispatch(m.view.state.tr.insertText("新增",1));
    expect(m.handle.matchesReview(snapshot)).toBe(false);
    expect(m.container.querySelector(".review-mark")).toBeNull();
    expect(m.handle.showReview(snapshot,[])).toBe(false);
    m.handle.command("undo");
    expect(m.handle.captureMarkdown().markdown).toBe(initial);
    expect(m.handle.matchesReview(snapshot)).toBe(false);
    expect(m.handle.revealReview(snapshot,{from:0,to:2})).toBe(false);
    const current = m.handle.captureReview("document")!;
    expect(m.handle.revealReview(current,{from:0,to:2})).toBe(true);
    expect(m.handle.selectionText()).toBe("第一");
  } finally { m.dispose(); }
});

it.each([1000,5000,20000])("projects %i Chinese characters without serializing per keystroke", async length => {
  const m = await mount("文".repeat(length));
  try {
    const timings: number[]=[];
    for(let i=0;i<20;i++) {
      const start=performance.now(); const projection=projectReviewText(m.view.state.doc);
      timings.push(performance.now()-start);
      expect(projection.text.length).toBe(length);
      expect(projection.runs.length).toBe(1);
    }
    timings.sort((a,b)=>a-b);
    console.info(`Review projection ${length} Chinese characters median=${timings[10].toFixed(3)}ms (Windows jsdom)`);
  } finally { m.dispose(); }
});
