// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { renderWechat, wechatThemes } from "../../../../packages/wechat-renderer";
import fixture from "../../../../fixtures/theme-consistency.md?raw";
const editorCss = readFileSync(resolve(process.cwd(), "packages/editor-react/editor.css"), "utf8");

vi.mock("../../../../packages/wechat-renderer/graphics", () => ({ graphic: vi.fn().mockRejectedValue(new Error("Invalid diagram")) }));

beforeAll(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterAll(() => { vi.unstubAllGlobals(); });

it.each(["\n", "\r\n"])("preserves the complete theme sample through reading and publishing (%j)", async newline => {
  const source = fixture.replaceAll("\r\n", "\n").replaceAll("\n", newline);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const render = (readOnly: boolean) => flushSync(() => root.render(<MarkdownEditor entryId="theme-integration" value={source}
    readOnly={readOnly} convertLinks ref={value => { handle = value; }} onDocumentChanged={changed} onBlur={() => {}} />));
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const initialRevision = handle!.captureMarkdown().localRevision;
    const editor = container.querySelector(".ProseMirror")!;
    expect(editor.querySelectorAll('li[data-item-type="task"]')).toHaveLength(2);
    expect(editor.querySelectorAll('li[data-checked="true"]')).toHaveLength(1);
    expect(editor.querySelector('[data-callout="success"]')?.getAttribute("data-callout-tone")).toBe("success");
    expect(editor.querySelector('[data-callout="danger"]')?.getAttribute("data-callout-tone")).toBe("danger");
    const code = editor.querySelector(".rich-code-block pre")!;
    expect(code.querySelector(".rich-code-header button")?.getAttribute("aria-label")).toContain("javascript");
    const projected = handle!.linkFootnoteMarkdown(source);
    expect(handle!.linkFootnoteMarkdown(projected)).toBe(projected);
    render(true);
    expect(container.querySelector(".ProseMirror")).toBe(editor);
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.querySelector(".rich-code-language-passive")?.textContent).toBe("javascript");
    for (const theme of wechatThemes) for (const output of ["preview", "clipboard", "html"] as const) {
      const result = await renderWechat({ markdown: projected, themeId: theme.id, revision: 1, output }, {
        sources: vi.fn(), image: vi.fn(), derive: vi.fn(),
      });
      try {
        const template = document.createElement("template");
        template.innerHTML = result.html;
        expect(template.content.querySelectorAll("input, button, label")).toHaveLength(0);
        expect(template.content.textContent).toContain("☑");
        expect(template.content.textContent).toContain("☐");
        expect(template.content.textContent).toContain("加粗标题");
        expect(template.content.textContent).toContain("加粗提示");
        expect(template.content.querySelectorAll("th,td")).toHaveLength(4);
        expect(template.content.querySelector("pre code")?.textContent).toContain("console.log(message)");
        expect(template.content.textContent).toContain("展开说明");
        expect(template.content.textContent).toContain("https://example.test/source");
        if (output === "clipboard") expect(template.content.querySelectorAll("a")).toHaveLength(0);
      } finally { result.dispose(); }
    }
    render(false);
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(handle!.captureMarkdown().markdown).toBe(source);
    expect(handle!.captureMarkdown().localRevision).toBe(initialRevision);
    expect(changed).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("keeps the source and language label visible when a reading-mode Mermaid render fails", async () => {
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = editorCss;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let handle: MarkdownEditorHandle | null = null;
  const source = "```mermaid\ninvalid diagram\n```";
  const changed = vi.fn();
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="failed-diagram" value={source} readOnly
      ref={value => { handle = value; }} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(container.querySelector(".rich-mermaid[data-failed]")).not.toBeNull());
    const pre = container.querySelector("pre")!;
    const header = container.querySelector<HTMLElement>(".rich-code-header")!;
    const passive = header.querySelector<HTMLElement>(".rich-code-language-passive")!;
    expect(getComputedStyle(pre).display).toBe("block");
    expect(getComputedStyle(header).display).not.toBe("none");
    expect(getComputedStyle(passive).display).toBe("block");
    expect(passive.textContent).toBe("mermaid");
    expect(pre.querySelector("code")?.textContent).toBe("invalid diagram");
    expect(handle!.captureMarkdown().markdown).toBe(source);
    expect(changed).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); style.remove(); }
});
