// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { renderWechat } from "../../../../packages/wechat-renderer";

beforeAll(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterAll(() => { vi.unstubAllGlobals(); });

it.each(["\n", "\r\n"])("projects every external source through one toggle and plan (%j)", async newline => {
  const source = [
    "正文 [来源](https://example.test/body) 和 [公众号](https://mp.weixin.qq.com/s/example)。",
    "[相对链接](./guide.md)",
    "手写脚注[^manual]。",
    '[![链接图片](asset://linked)](https://example.test/image-source)',
    '<div>HTML <a href="https://example.test/block"><strong>块来源</strong></a><a href="./page.md">HTML 相对链接</a><img src="asset://picture" alt="原图"></div>',
    '段内 <a href="https://example.test/inline">行内来源</a>。',
    "[^manual]: [手工来源](https://example.test/manual)",
  ].join(newline + newline);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const render = (enabled: boolean) => flushSync(() => root.render(<MarkdownEditor entryId="link-projection" value={source}
    githubRepo="https://github.com/acme/docs" convertLinks={enabled} readOnly={false} ref={editor => { handle = editor; }} onDocumentChanged={changed} onBlur={() => {}} />));
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    expect(container.querySelector('.rich-embedded-html a[href="https://example.test/block"]')).not.toBeNull();
    render(true);
    await vi.waitFor(() => expect(container.querySelector(".rich-link-notes")).not.toBeNull());
    expect(container.querySelector('.rich-embedded-html a[href="https://example.test/block"]')).toBeNull();
    expect(container.querySelector(".rich-embedded-html sup")?.textContent).toMatch(/\[\^\d+\]/);
    const wechat = container.querySelector('a[href="https://mp.weixin.qq.com/s/example"]')!;
    expect(wechat).not.toBeNull();
    expect(wechat.closest(".rich-link-footnoted")).toBeNull();
    expect(wechat.querySelector(".rich-link-footnoted")).toBeNull();
    expect(container.textContent).toContain("手工来源： https://example.test/manual");
    const projected = handle!.linkFootnoteMarkdown(source);
    for (const destination of ["body", "block", "inline", "manual"]) expect(projected).toContain(`example.test/${destination}`);
    expect(handle!.linkFootnoteMarkdown(projected)).toBe(projected);
    for (const output of ["preview", "clipboard", "html"] as const) {
      const result = await renderWechat({ markdown: projected, output, revision: 1 }, {
        sources: vi.fn(), derive: vi.fn(), image: vi.fn(async () => ({ src: "https://images.test/picture.png", width: 100, height: 80 })),
      });
      try {
        const template = document.createElement("template");
        template.innerHTML = result.html;
        expect(template.content.querySelectorAll(".footnote-item, li[id^=fn]")).toHaveLength(7);
        expect(template.content.querySelector('a[href="https://mp.weixin.qq.com/s/example"]')).not.toBeNull();
        expect(template.content.querySelectorAll('a[href^="https://example.test/"]')).toHaveLength(0);
        for (const destination of ["body", "block", "inline", "manual"]) expect(template.content.textContent).toContain(`https://example.test/${destination}`);
        expect(template.content.textContent).toContain("https://example.test/image-source");
        expect(template.content.textContent).toContain("https://github.com/acme/docs/blob/HEAD/guide.md");
        expect(template.content.textContent).toContain("https://github.com/acme/docs/blob/HEAD/page.md");
        expect(template.content.querySelectorAll("img")).toHaveLength(2);
        expect(template.content.querySelector("img")?.getAttribute("src")).toBe("https://images.test/picture.png");
        if (output === "clipboard") expect(template.content.querySelectorAll("a")).toHaveLength(1);
      } finally { result.dispose(); }
    }
    render(false);
    expect(container.querySelector(".rich-link-notes")).toBeNull();
    expect(container.querySelector('.rich-embedded-html a[href="https://example.test/block"]')).not.toBeNull();
    expect(handle!.captureMarkdown().markdown).toBe(source);
    expect(changed).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("rejects an unconverted external link at the publication boundary", async () => {
  const image = vi.fn();
  await expect(renderWechat({ markdown: "[来源](https://example.test/missed)", output: "clipboard", revision: 1 }, {
    sources: vi.fn(), derive: vi.fn(), image,
  })).rejects.toThrow("未转为脚注");
  expect(image).not.toHaveBeenCalled();
});

it.each(["：", "： "].flatMap(separator => ["\n", "\r\n"].map(newline => ({ separator, newline }))))(
  "keeps legacy URL-named footnotes stable ($separator, $newline)", async ({ separator, newline }) => {
    const name = "https://mirror.example/form";
    const address = "https://redirect.example/form";
    const source = [`<${name}>[^1]`, `[^1]: ${name}${separator}<${address}>`].join(newline + newline);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const changed = vi.fn();
    let handle: MarkdownEditorHandle | null = null;
    const mount = async (id: string, value: string) => {
      flushSync(() => root.render(<MarkdownEditor key={id} entryId={id} value={value} convertLinks readOnly={false}
        ref={editor => { handle = editor; }} onDocumentChanged={changed} onBlur={() => {}} />));
      await vi.waitFor(() => expect(handle?.target().entryId).toBe(id));
    };
    try {
      await mount("legacy-open", source);
      expect(container.querySelector(".ProseMirror > p")?.textContent).toBe(`${name}[^1]`);
      const projected = handle!.linkFootnoteMarkdown(source);
      expect(projected.match(/^\[\^\d+\]:/gm)).toHaveLength(1);
      expect(handle!.linkFootnoteMarkdown(projected)).toBe(projected);
      expect(handle!.captureMarkdown().markdown).toBe(source);
      for (const output of ["preview", "clipboard", "html"] as const) {
        const result = await renderWechat({ markdown: projected, output, revision: 1 }, { sources: vi.fn(), derive: vi.fn(), image: vi.fn() });
        try {
          const template = document.createElement("template");
          template.innerHTML = result.html;
          expect(template.content.querySelector("p")?.textContent).toBe(`${name}[1]`);
          expect(template.content.querySelectorAll(".footnote-item, li[id^=fn]")).toHaveLength(1);
          expect(template.content.textContent).toContain(`${name}${separator}${address}`);
          expect(template.content.querySelectorAll('a[href^="https://"]')).toHaveLength(0);
        } finally { result.dispose(); }
      }
      await mount("legacy-reopened", projected);
      expect(container.querySelector(".ProseMirror > p")?.textContent).toBe(`${name}[^1]`);
      expect(handle!.linkFootnoteMarkdown(projected)).toBe(projected);
      expect(handle!.captureMarkdown().localRevision).toBe(0);
      expect(changed).not.toHaveBeenCalled();
    } finally { flushSync(() => root.unmount()); container.remove(); }
  },
);

it.each(["\n", "\r\n"])("shares disclosure title and body footnotes across toggles and publishing (%j)", async newline => {
  const source = [
    "[之前](https://example.test/before)",
    '<details open><summary><a href="https://example.test/source"><strong>来源</strong></a> <a href="./guide.md">相对链接</a> <a href="mailto:writer@example.test">联系</a> <a href="https://mp.weixin.qq.com/s/allowed">公众号</a></summary>',
    "折叠正文 [内文](https://example.test/inside)。",
    "</details>",
    "[之后](https://example.test/after)",
  ].join(newline + newline);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  const render = (enabled: boolean) => flushSync(() => root.render(<MarkdownEditor entryId="disclosure-projection" value={source}
    githubRepo="https://github.com/acme/docs" convertLinks={enabled} readOnly={false}
    ref={editor => { handle = editor; }} onDocumentChanged={changed} onBlur={() => {}} />));
  try {
    render(false);
    await vi.waitFor(() => expect(handle).not.toBeNull());
    const details = container.querySelector("details")!;
    expect(details.querySelector('summary a[href="https://example.test/source"]')).not.toBeNull();
    details.open = false;
    render(true);
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(false);
    expect(details.querySelectorAll("summary sup")).toHaveLength(3);
    expect(details.querySelector("summary")?.textContent).toBe("来源[^2] 相对链接[^3] 联系[^4] 公众号");
    expect(details.querySelectorAll("summary a")).toHaveLength(1);
    expect(details.querySelector("summary a")?.getAttribute("href")).toBe("https://mp.weixin.qq.com/s/allowed");
    expect(details.querySelector("summary strong")?.textContent).toBe("来源");
    expect(details.querySelector("p")?.textContent).toBe("折叠正文 内文[^5]。");
    const projected = handle!.linkFootnoteMarkdown(source);
    expect(handle!.linkFootnoteMarkdown(projected)).toBe(projected);
    for (const output of ["preview", "clipboard", "html"] as const) {
      const result = await renderWechat({ markdown: projected, output, revision: 1 }, { sources: vi.fn(), derive: vi.fn(), image: vi.fn() });
      try {
        const template = document.createElement("template");
        template.innerHTML = result.html;
        expect(template.content.querySelectorAll(".footnote-item, li[id^=fn]")).toHaveLength(6);
        expect(template.content.textContent).toContain("来源[2] 相对链接[3] 联系[4] 公众号");
        expect(template.content.textContent).toContain("折叠正文 内文[5]。");
        expect(template.content.querySelectorAll('a[href^="https://example.test/"], a[href^="mailto:"]')).toHaveLength(0);
        expect(template.content.querySelector('a[href="https://mp.weixin.qq.com/s/allowed"]')).not.toBeNull();
        expect(template.content.textContent).toContain("https://github.com/acme/docs/blob/HEAD/guide.md");
        expect(template.content.textContent).toContain("mailto:writer@example.test");
      } finally { result.dispose(); }
    }
    render(false);
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(false);
    expect(details.querySelectorAll("summary sup")).toHaveLength(0);
    expect(details.querySelectorAll("summary a")).toHaveLength(4);
    expect(container.querySelector(".rich-link-notes")).toBeNull();
    expect(handle!.captureMarkdown().markdown).toBe(source);
    expect(handle!.captureMarkdown().localRevision).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("converts a disclosure when its title contains the document's only link", async () => {
  const source = '<details>\n\n<summary><a href="https://example.test/source">来源</a></summary>\n\n正文\n\n</details>';
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const changed = vi.fn();
  let handle: MarkdownEditorHandle | null = null;
  try {
    flushSync(() => root.render(<MarkdownEditor entryId="title-only-link" value={source} convertLinks readOnly={false}
      ref={editor => { handle = editor; }} onDocumentChanged={changed} onBlur={() => {}} />));
    await vi.waitFor(() => expect(handle).not.toBeNull());
    expect(container.querySelector("summary")?.textContent).toBe("来源[^1]");
    expect(container.querySelector("summary a")).toBeNull();
    const projected = handle!.linkFootnoteMarkdown(source);
    expect(handle!.linkFootnoteMarkdown(projected)).toBe(projected);
    const result = await renderWechat({ markdown: projected, output: "clipboard", revision: 1 }, { sources: vi.fn(), derive: vi.fn(), image: vi.fn() });
    try {
      const template = document.createElement("template");
      template.innerHTML = result.html;
      expect(template.content.querySelectorAll("a")).toHaveLength(0);
      expect(template.content.querySelectorAll(".footnote-item, li[id^=fn]")).toHaveLength(1);
      expect(template.content.textContent).toContain("来源： https://example.test/source");
      expect(template.content.textContent).toContain("正文");
    } finally { result.dispose(); }
    expect(handle!.captureMarkdown().markdown).toBe(source);
    expect(changed).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); container.remove(); }
});
