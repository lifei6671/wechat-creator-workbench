import { expect, it } from "vitest";
import { parseWebClipping } from "./web-clipping";

const clipping = `---
title: "GPT-6.2 Astra 发布了，但口碑崩了。。。"
source: "https://juejin.cn/post/7709318936996298790?utm_source=gold_browser_extension"
author:
  - "[[cxuanAI]]"
published: 2026-11-18
created: 2026-11-20
description: "今天凌晨的时候，GPT 发布了 GPT-6.2 Astra。"
tags:
  - "clippings"
---
今天凌晨的时候，GPT 发布了 GPT-6.2 Astra。

**不推荐使用 GPT-6.2 Astra 模型**

![image.png|535](https://example.com/image.png)

- Computer use

![[层状火山-360度环绕.mp4]]

![[yumuwenshi.mov]]
`;

it("imports Web Clipper metadata separately from the original Markdown body", () => {
  const result = parseWebClipping(clipping)!;
  expect(result.title).toBe("GPT-6.2 Astra 发布了，但口碑崩了。。。");
  expect(result.source).toEqual({
    url: "https://juejin.cn/post/7709318936996298790?utm_source=gold_browser_extension",
    author: "cxuanAI", accountName: "juejin.cn",
    originalPublishedAt: Date.parse("2026-11-18"), importedAt: Date.parse("2026-11-20"),
  });
  expect(result.tags).toEqual(["clippings"]);
  expect(result.summary).toBe("今天凌晨的时候，GPT 发布了 GPT-6.2 Astra。");
  expect(result.contentMd).toBe(clipping.split("---\n")[2]);
  expect(result.unavailableAttachments).toEqual(["层状火山-360度环绕.mp4", "yumuwenshi.mov"]);
});

it("accepts the escaped rich-text representation supplied in the clipping example", () => {
  const escaped = clipping.replace(/^---$/gm, "\0").replace(/([!()*\-.:\[\]~])/g, "\\$1").replace(/\0/g, "\\---").replace(/^  /gm, "&#x20; ")
    .split("\n").map(line => line + "\\").join("\r\n");
  expect(parseWebClipping("\uFEFF" + escaped)).toEqual(parseWebClipping(clipping));
});

it("leaves ordinary Markdown, frontmatter without a source, and code examples alone", () => {
  for (const text of ["普通文本", "---\n\n正文", "---\ntitle: 笔记\n---\n正文", "```yaml\n" + clipping + "\n```"])
    expect(parseWebClipping(text)).toBeNull();
});

it("supports author aliases, scalar tags, folded descriptions, and ISO dates", () => {
  const text = clipping.replace('  - "[[cxuanAI]]"', '  - "[[cxuanAI|作者]]"\n  - 另一作者')
    .replace('  - "clippings"', '  "#clippings"').replace('published: 2026-11-18', 'published: "2026-11-18T12:30:00+08:00"')
    .replace('description: "今天凌晨的时候，GPT 发布了 GPT-6.2 Astra。"', 'description: >-\n  第一行\n  第二行');
  const result = parseWebClipping(text)!;
  expect(result.source.author).toBe("作者、另一作者");
  expect(result.source.originalPublishedAt).toBe(Date.parse("2026-11-18T12:30:00+08:00"));
  expect(result.tags).toEqual(["clippings"]);
  expect(result.summary).toBe("第一行 第二行");
});

it("reports malformed clipping properties instead of silently discarding metadata", () => {
  expect(() => parseWebClipping(clipping.replace('title: "', 'title: ["'))).toThrow("剪藏属性格式有误");
  expect(() => parseWebClipping(clipping.replace("https://juejin.cn", "file://juejin.cn"))).toThrow("只支持 HTTP 或 HTTPS");
  expect(() => parseWebClipping(clipping.replace("2026-11-18", "2026-02-30"))).toThrow("日期无效");
  expect(() => parseWebClipping(clipping.replace('  - "clippings"', "  - {name: clippings}"))).toThrow("文本列表");
});

it("does not report local attachment syntax inside code as missing files", () => {
  expect(parseWebClipping(clipping.replace(/!\[\[[^\]]+\]\]/g, "`![[example.mp4]]`"))!.unavailableAttachments).toEqual([]);
});
