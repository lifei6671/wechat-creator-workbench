// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Entry } from "../../../../packages/shared-types";
import { CollectionArticlePreview } from "./CollectionArticle";

it("loads and renders the full Markdown body once the article card enters the viewport", async () => {
  let entered!: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { entered = callback; }
    observe() {}
    disconnect() {}
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const article: Entry = { id: "article", kind: "article", title: "文章名", status: "draft", deletedAt: null, categoryId: null,
    updatedAt: 0, tags: [], summary: "仅作摘要", source: null, publishedAt: null, publishedUrl: "", version: 1, links: [],
    contentMd: "## 正文标题\n\n**加粗正文**[^1]\n\n- 列表项\n\n| 列 |\n| --- |\n| 单元格 |\n\n[^1]: 脚注正文" };
  const load = vi.fn().mockResolvedValue(article);
  try {
    flushSync(() => root.render(<CollectionArticlePreview id={article.id} title={article.title} source={null} load={load} onError={vi.fn()} />));
    expect(load).not.toHaveBeenCalled();
    flushSync(() => entered([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await vi.waitFor(() => expect(container.querySelector(".collection-markdown strong")?.textContent).toBe("加粗正文"));
    expect(load).toHaveBeenCalledExactlyOnceWith(article.id);
    expect(container.querySelector(".collection-markdown h2")?.textContent).toBe("正文标题");
    expect(container.querySelector(".collection-markdown ul li")?.textContent).toBe("列表项");
    expect(container.querySelector(".collection-markdown td")?.textContent).toBe("单元格");
    expect(container.querySelector(".collection-markdown .footnotes")?.textContent).toContain("脚注正文");
    expect(container.textContent).not.toContain("仅作摘要");
  } finally {
    flushSync(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
