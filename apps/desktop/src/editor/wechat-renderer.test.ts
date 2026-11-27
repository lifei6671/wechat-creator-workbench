// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { parseWechat, renderWechat, wechatThemeId, wechatThemes, type SourceFragment } from "../../../../packages/wechat-renderer";
import { graphic } from "../../../../packages/wechat-renderer/graphics";
import fixture from "../../../../fixtures/wechat-format.json?raw";

const gzhThemes = wechatThemes.filter(theme => theme.id.startsWith("gzh-"));

it.each(wechatThemes)("renders safe alt captions below ordinary images and respects explicit captions in $label", async theme => {
  const alt = '<script>alert("caption")</script> 软件截图';
  const markdown = `![${alt.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}](asset://caption)\n\n![](asset://empty)\n\n<figure><img src="asset://explicit" alt="无障碍说明"><figcaption>明确图注</figcaption></figure>\n\n<figure><p><a href="https://mp.weixin.qq.com/s/example"><img src="asset://nested" alt="嵌套说明"></a></p><figcaption>嵌套说明</figcaption></figure>`;
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ markdown, themeId: theme.id, revision: 1, output }, {
      image: async () => ({ src: "https://images.test/caption.png", width: 320, height: 160 }), sources: vi.fn(), derive: vi.fn(),
    });
    try {
      const template = document.createElement("template"); template.innerHTML = result.html;
      const images = [...template.content.querySelectorAll("img")];
      expect(images).toHaveLength(4);
      const caption = images[0].nextElementSibling as HTMLElement;
      expect(images[0].alt).toContain("软件截图");
      expect(caption?.textContent).toBe(images[0].alt);
      expect(caption.style.fontSize).toBe("13px");
      expect(caption.style.textAlign).toBe("center");
      expect(caption.style.color).toBe("rgb(100, 100, 100)");
      expect(caption.style.marginTop).toBe("8px");
      expect(images[1].nextElementSibling).toBeNull();
      expect(images[2].nextElementSibling?.textContent).toBe("明确图注");
      expect(template.content.querySelectorAll("script,figure,figcaption")).toHaveLength(0);
      expect(result.text.split(images[0].alt)).toHaveLength(2);
      expect(result.text.split("嵌套说明")).toHaveLength(2);
      expect(result.html).not.toContain("class=");
    } finally { result.dispose(); }
  }
});

it.each(wechatThemes)("uses the available article width with self-contained inline styles in $label", async theme => {
  const markdown = "# 标题\n\n## 章节\n\n正文 **强调** 与 `inline`。\n\n> 引用\n\n- 列表\n\n```js\nconst value = 1;\n```\n\n| 名称 |\n| --- |\n| 单元格 |\n\n[微信链接](https://mp.weixin.qq.com/s/example)\n\n![图片](asset://responsive)";
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ markdown, themeId: theme.id, revision: 1, output }, {
      sources: vi.fn(), derive: vi.fn(), image: async () => ({ src: "https://images.test/responsive.png", width: 320, height: 160 }),
    });
    try {
      const template = document.createElement("template"); template.innerHTML = result.html;
      const article = template.content.firstElementChild as HTMLElement;
      expect(article.style.width, output).toBe("100%");
      expect(["", "none"]).toContain(article.style.maxWidth);
      expect(article.style.boxSizing).toBe("border-box");
      for (const property of ["paddingLeft", "paddingRight", "marginLeft", "marginRight"] as const) expect(article.style[property], `${output} ${property}`).toBe("0px");
      expect(article.style.fontSize).not.toBe("");
      expect(article.querySelector("h1")?.style.fontSize).not.toBe("");
      expect(article.querySelector("blockquote")?.style.paddingLeft).not.toBe("");
      expect(article.querySelector("pre")?.style.overflowX).toBe("auto");
      expect(article.querySelector("th")?.style.padding).not.toBe("");
      expect(article.querySelector("img")?.style.maxWidth).toBe("100%");
      expect(["", "none"]).toContain(article.querySelector("img")?.style.maxHeight);
      expect(article.querySelector("img")?.style.height).toBe("auto");
      expect(article.querySelector("table")?.getAttribute("width")).toBe("100%");
      expect(result.html).not.toMatch(/<style|<link|\sclass=|var\(/);
      if (output !== "preview") expect(result.html).not.toMatch(/\sdata-/);
    } finally { result.dispose(); }
  }
});

it.each(["preview", "clipboard", "html"] as const)("retains explicit caption text and image descriptions in %s publication output", async output => {
  const markdown = '<figure><img src="asset://caption" alt="独立的无障碍描述"><figcaption>明确保存的图片说明</figcaption></figure>';
  const result = await renderWechat({ markdown, themeId: "plainly-tech", revision: 1, output }, {
    image: async () => ({ src: "https://images.test/caption.png", width: 320, height: 160 }), sources: vi.fn(), derive: vi.fn(),
  });
  try {
    const template = document.createElement("template"); template.innerHTML = result.html;
    expect(template.content.textContent).toContain("明确保存的图片说明");
    expect(template.content.querySelector("img")?.alt).toBe("独立的无障碍描述");
    expect(template.content.querySelector("figure, figcaption, .rich-table-scroll, .rich-image")).toBeNull();
    expect(result.html).not.toContain("--article-");
  } finally { result.dispose(); }
});

it.each(wechatThemes)("wraps URL text without changing prose, code or link targets in $label", async theme => {
  const url = "https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md";
  const markdown = `官方遥测文档：${url}[^1]\n\n英文 Adversarial Distillation Research。\n\n\`${url}\`\n\n\`\`\`text\n${url}\n\`\`\`\n\n[^1]: ${url}`;
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ markdown, themeId: theme.id, revision: 1, output }, { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
    try {
      const template = document.createElement("template"); template.innerHTML = result.html;
      const urls = [...template.content.querySelectorAll<HTMLElement>('span[style*="word-break"]')];
      expect(urls).toHaveLength(2);
      expect(urls.map(span => span.textContent)).toEqual([url, url]);
      expect(urls.every(span => span.style.wordBreak === "break-all" && span.style.overflowWrap === "anywhere")).toBe(true);
      expect(template.content.querySelector('code span[style*="word-break"]')).toBeNull();
      expect(template.content.textContent).toContain("英文 Adversarial Distillation Research。");
      expect(template.content.querySelector("code")?.textContent).toBe(url);
      expect(template.content.querySelector("pre code")?.textContent?.trim()).toBe(url);
      expect(result.text).toContain(`官方遥测文档：${url}`);
    } finally { result.dispose(); }
  }
});

it.each(wechatThemes)("keeps list labels and descriptions inline for WeChat in $label", async theme => {
  const markdown = [
    "- **影视播放：** TVBox、影视仓、Kodi、FongMi 影视、OK 影视等。",
    "- **家庭K歌：** 麦动、家庭 KTV 等。",
    "- 普通文字 **加粗** 后续文字",
    "- [微信文章](https://mp.weixin.qq.com/s/example) 与 **说明** 结尾",
    "  1. **嵌套：** 保持同行",
    "  2. 纯文本条目",
  ].join("\n");
  const outputs: string[] = [];
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ markdown, output, themeId: theme.id, revision: 1 },
      { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
    try {
      const template = document.createElement("template");
      template.innerHTML = result.html;
      const items = template.content.querySelectorAll("li");
      expect(items).toHaveLength(6);
      expect(items[0].textContent).toBe("影视播放： TVBox、影视仓、Kodi、FongMi 影视、OK 影视等。");
      expect(items[1].textContent).toBe("家庭K歌： 麦动、家庭 KTV 等。");
      expect(items[2].textContent).toBe("普通文字 加粗 后续文字");
      expect(items[0].querySelector("p, br, section")).toBeNull();
      expect(items[4].textContent).toBe("嵌套： 保持同行");
      expect(items[5].textContent).toBe("纯文本条目");
      expect(items[3].querySelector("ol > li")).toBe(items[4]);
      expect(items[3].querySelector("a")?.getAttribute("href")).toBe("https://mp.weixin.qq.com/s/example");
      for (const [item, description] of [[items[0], " TVBox、影视仓、Kodi、FongMi 影视、OK 影视等。"],
        [items[1], " 麦动、家庭 KTV 等。"], [items[4], " 保持同行"]] as const) {
        const span = item.lastChild as HTMLElement;
        expect(span.tagName).toBe("SPAN");
        expect(span.style.display).toBe("inline");
        expect(span.textContent).toBe(description);
      }
      expect(result.html).not.toContain("nowrap");
      outputs.push(result.html);
    } finally { result.dispose(); }
  }
  expect(new Set(outputs).size).toBe(1);
});

it("preserves explicit list breaks, paragraphs and task markers", async () => {
  const markdown = "- **标签：** 首行  \n  手动换行\n\n  第二段\n\n- [x] **完成：** 任务说明";
  const result = await renderWechat({ markdown, output: "clipboard", themeId: "plainly-tech", revision: 1 },
    { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
  try {
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const items = template.content.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelectorAll("p")).toHaveLength(2);
    expect(items[0].querySelector("p")?.innerHTML).toContain("<br>");
    expect(items[0].querySelectorAll("p")[1].textContent).toBe("第二段");
    expect(items[1].textContent).toContain("☑ 完成： 任务说明");
    expect(items[1].querySelector("strong")?.textContent).toBe("完成：");
  } finally { result.dispose(); }
});

it.each(wechatThemes)("appends safe recommendations only to WeChat outputs in $label", async theme => {
  const markdown = "正文保持原样";
  const recommendations = [{ entryId: "past", title: '<img src=x onerror=alert(1)> 往期文章', url: "https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=full#wechat_redirect" }];
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ markdown, output, themeId: theme.id, revision: 1, recommendations }, { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
    try {
      const template = document.createElement("template"); template.innerHTML = result.html;
      expect(template.content.textContent?.split("推荐阅读：").length).toBe(output === "html" ? 1 : 2);
      expect(template.content.querySelector("img")).toBeNull();
      if (output !== "html") {
        expect(template.content.querySelector("a")?.getAttribute("href")).toBe(recommendations[0].url);
        expect(template.content.textContent).toContain(recommendations[0].title);
        expect(result.text).toContain(recommendations[0].url);
      }
      expect(template.content.textContent).toContain(markdown);
    } finally { result.dispose(); }
  }
});

it.each(["preview", "clipboard", "html"] as const)("limits copied article links without changing visible content in %s", async output => {
  const rendering = renderWechat({ output, revision: 1, themeId: "plainly-tech", markdown: [
    "正文 [验证页面](https://math.mit.edu/~drew/grh/)。",
    "**相关资料：**\n\n原始声明：<https://alpo.ge/remark.pdf>\n\n验证进度：<https://math.mit.edu/~drew/grh/>\n\n报道：<https://www.theverge.com/ai-artificial-intelligence/example>",
    '[站内文章](https://mp.weixin.qq.com/s/example) [普通网站](https://example.test/page) [邮件](mailto:writer@example.test)',
    '[![链接中的图片](asset://linked)](https://example.test/image-page)',
    '脚注[^n]\n\n[^n]: [脚注来源](https://example.test/reference)',
  ].join("\n\n") }, { image: vi.fn(async () => ({ src: "https://images.test/picture.png", width: 80, height: 60 })), sources: vi.fn(), derive: vi.fn() });
  if (output === "clipboard") { await expect(rendering).rejects.toThrow("未转为脚注"); return; }
  const result = await rendering;
  try {
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const links = [...template.content.querySelectorAll("a[href]")].map(node => node.getAttribute("href"));
    expect(links).toContain("https://math.mit.edu/~drew/grh/");
    expect(links).toContain("mailto:writer@example.test");
    expect(links).toContain("#fn1");
    expect(template.content.textContent).toContain("验证页面");
    expect(template.content.textContent).toContain("https://alpo.ge/remark.pdf");
    expect(template.content.textContent).toContain("脚注来源");
    expect(template.content.querySelector('img[alt="链接中的图片"]')?.getAttribute("src")).toBe("https://images.test/picture.png");
    expect(template.content.querySelector("strong")?.textContent).toBe("相关资料：");
    expect(template.content.querySelector("section")?.getAttribute("style")).toBeTruthy();
  } finally { result.dispose(); }
});

it("keeps only exact, standard WeChat article destinations in clipboard anchors", async () => {
  const allowed = ["https://mp.weixin.qq.com/s/ok", "http://mp.weixin.qq.com/s/legacy", "https://MP.WEIXIN.QQ.COM/s/case"];
  const rejected = ["https://mp.weixin.qq.com.evil.test/s/x", "https://sub.mp.weixin.qq.com/s/x", "https://mp.weixin.qq.com@evil.test/s/x",
    "https://user@mp.weixin.qq.com/s/x", "https://mp.weixin.qq.com:8443/s/x", "mailto:writer@example.test"];
  const markdown = [...allowed, "#heading"].map((url, index) => `[目标 ${index}](${url})`).join(" ");
  const result = await renderWechat({ markdown, output: "clipboard", revision: 1 }, { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
  try {
    const template = document.createElement("template");
    template.innerHTML = result.html;
    expect([...template.content.querySelectorAll("a")].map(node => node.getAttribute("href"))).toEqual(allowed);
    for (let index = 0; index <= allowed.length; index++) expect(template.content.textContent).toContain(`目标 ${index}`);
  } finally { result.dispose(); }
  for (const href of rejected) await expect(renderWechat({ markdown: `[来源](${href})`, output: "clipboard", revision: 1 },
    { image: vi.fn(), sources: vi.fn(), derive: vi.fn() })).rejects.toThrow("未转为脚注");
});

it.each(wechatThemes)("omits the article background for $label in every output while preserving content highlights", async theme => {
  for (const output of ["preview", "clipboard", "html"] as const) {
    const result = await renderWechat({ themeId: theme.id, output, revision: 0, markdown: "## 章节\n\n==高亮== 与 `代码`\n\n> 引用" },
      { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const article = template.content.firstElementChild as HTMLElement;
    expect(article.style.backgroundColor).toBe("");
    expect(article.style.backgroundImage).toBe("");
    expect(article.querySelector("mark")?.style.backgroundColor).not.toBe("");
    expect(article.querySelector("code")?.style.backgroundColor).not.toBe("");
    result.dispose();
  }
});

it.each(gzhThemes)("renders $label consistently for preview, clipboard and HTML", async theme => {
  const markdown = "# 主标题\n\n引言含有 **关键观点** 与 ==高亮==。\n\n## 开始使用\n\n> 原始引用\n\n### 小节\n\n- 列表项\n\n## 2. 已编号\n\n## 写在最后\n\n![动图](asset://gif)\n\n| 名称 | 值 |\n| --- | --- |\n| 原文 | 保留 |\n\n脚注[^n]\n\n[^n]: 来源 https://example.test/source";
  const rendered = [];
  for (const output of ["preview", "clipboard", "html"] as const) {
    const image = vi.fn(async () => ({ src: "https://images.test/picture.gif", width: 80, height: 60 }));
    const result = await renderWechat({ markdown, themeId: theme.id, output, revision: 3 }, { image, sources: vi.fn(), derive: vi.fn() });
    expect(wechatThemeId(theme.id)).toBe(theme.id);
    expect(result.themeId).toBe(theme.id);
    expect(result.images).toEqual([{ url: "asset://gif", alt: "动图" }]);
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const headings = template.content.querySelectorAll("h2");
    expect(Array.from(headings, heading => heading.textContent)).toEqual(["01开始使用", "2. 已编号", "∞写在最后", "参考资料"]);
    expect(headings[0].hasAttribute("data-line")).toBe(output === "preview");
    expect(template.content.querySelector("strong")?.parentElement?.style.borderBottomWidth).toBe("0.5px");
    expect(template.content.querySelector("table")?.getAttribute("width")).toBe("100%");
    expect(template.content.querySelector("img")?.getAttribute("src")).toBe("https://images.test/picture.gif");
    expect(template.content.querySelector('a[href="#fn1"]') === null).toBe(output === "clipboard");
    expect(template.content.querySelector('[id="fn1"]')).not.toBeNull();
    expect(result.html).not.toMatch(/<style|<script|\bclass=|var\(--|undefined/);
    expect(template.content.querySelectorAll("[leaf]").length).toBeGreaterThan(10);
    for (const node of template.content.querySelectorAll("*")) {
      for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) expect(node.hasAttribute("leaf")).toBe(true);
    }
    if (output !== "preview") expect(result.html).not.toContain("data-");
    for (const heading of template.content.querySelectorAll("[data-line]")) heading.removeAttribute("data-line");
    rendered.push({ html: template.innerHTML, text: template.content.textContent });
    result.dispose();
  }
  expect(rendered[0].html).toBe(rendered[2].html);
  expect(new Set(rendered.map(result => result.text)).size).toBe(1);
});

it("preserves highlighted code whitespace and safe disclosure content in GZH themes", async () => {
  const source = 'const n = 1;\n\n\tconsole.log("a  b");\n  // 中文， punctuation: exact';
  const result = await renderWechat({ themeId: "gzh-moyu-ticket", output: "clipboard", revision: 1,
    markdown: '## 01 已有编号\n\n```js\n' + source + '\n```\n\n<details><summary>展开内容</summary>\n\n**安全正文** [链接](https://mp.weixin.qq.com/s/example)\n\n</details>\n\n<script>alert(1)</script><a href="javascript:alert(2)" onclick="alert(3)">外部内容</a>' },
    { image: vi.fn(async () => ({ src: null, width: 0, height: 0 })), sources: vi.fn(), derive: vi.fn() });
  const template = document.createElement("template");
  template.innerHTML = result.html;
  const code = template.content.querySelector("pre > code")!;
  expect(code.textContent).toBe(source + "\n");
  expect(code.querySelectorAll("span[style]").length).toBeGreaterThan(0);
  expect(code.parentElement?.style.whiteSpace).toBe("pre");
  expect(code.closest("section")?.querySelector("p")?.textContent).toBe("js");
  expect(template.content.querySelector("h2")?.textContent).toBe("01 已有编号");
  expect(template.content.querySelector("details, summary, div, script, [onerror]")).toBeNull();
  expect(result.html).not.toContain("javascript:");
  expect(template.content.textContent).toContain("展开内容");
  expect(template.content.querySelectorAll("a")).toHaveLength(1);
  expect(template.content.querySelector("a")?.getAttribute("href")).toBe("https://mp.weixin.qq.com/s/example");
  expect(template.content.textContent).toContain("链接");
});

it("keeps legacy themes free of GZH chapter numbers and leaf wrappers", async () => {
  expect(gzhThemes).toHaveLength(6);
  const result = await renderWechat({ themeId: "plainly-default", output: "clipboard", revision: 1, markdown: "## 章节\n\n**原文**" },
    { image: vi.fn(), sources: vi.fn(), derive: vi.fn() });
  expect(result.html).not.toContain("leaf=");
  expect(result.text).toBe("章节\n\n原文");
});

it("uses the same formula and diagram source fragments as Rust retention", () => {
  const samples: { markdown: string; fragments: SourceFragment[] }[] = JSON.parse(fixture);
  for (const sample of samples) {
    expect(parseWechat(sample.markdown, sample.fragments).fragments, sample.markdown)
      .toEqual(sample.fragments.map(({ kind, source }) => ({ kind, source })));
  }
});

it("keeps adjacent GitHub disclosures and renders Markdown inside them in preview", async () => {
  const markdown = [
    "<details open=\"open\">\n<summary>下载</summary>\n<br/>",
    "下载说明",
    "</details>",
    "<details>\n<summary><strong>开源范围</strong></summary>\n<br/>",
    "**许可协议**，请从 [Releases](https://github.com/CM-idea/SnowAir/releases) 下载 `SnowAir.exe`。",
    "</details>",
  ].join("\n\n");
  const result = await renderWechat({ output: "preview", revision: 1, markdown },
    { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
  const template = document.createElement("template");
  template.innerHTML = result.html;
  const [download, license] = template.content.querySelectorAll("details");
  expect(download.open).toBe(true);
  expect(license.open).toBe(false);
  expect(license.querySelector("summary strong")?.textContent).toBe("开源范围");
  expect(license.querySelector("p strong")?.textContent).toBe("许可协议");
  expect(license.querySelector("p a")?.getAttribute("href")).toBe("https://github.com/CM-idea/SnowAir/releases");
  expect(license.querySelector("p code")?.textContent).toBe("SnowAir.exe");
});

it("inlines the theme, retains table width and replaces asset links in document order", async () => {
  const image = vi.fn(async (url: string) => ({ src: `https://images.test/${url.split("://")[1]}.png`, width: 120, height: 60 }));
  const result = await renderWechat({
    output: "clipboard", revision: 17, themeId: "retired-theme",
    markdown: "# 排版标题\n\n==高亮==\n\n|表|\n|-|\n|值|\n\n![首图](asset://one)\n\n<img src='asset://two' onerror='alert(1)'><script>alert(2)</script><span class='preview-image' data-wechat-fragment='0'>普通文字</span>",
  }, { image, derive: vi.fn(), sources: vi.fn() });
  expect(result.revision).toBe(17);
  expect(result.themeId).toBe("plainly-default");
  expect(result.images.map(image => image.url)).toEqual(["asset://one", "asset://two"]);
  const template = document.createElement("template");
  template.innerHTML = result.html;
  expect(template.content.querySelector("h1")?.style.fontSize).toBe("22px");
  expect(template.content.querySelector("mark")?.textContent).toBe("高亮");
  expect(template.content.querySelector("table")?.getAttribute("width")).toBe("100%");
  expect(template.content.querySelector("img")?.getAttribute("src")).toBe("https://images.test/one.png");
  expect(result.html).not.toMatch(/asset:\/\/|onerror|<script|data-line|<style/);
  expect(result.text).toContain("排版标题");
  expect(result.text).toContain("普通文字");
});

it.each(["preview", "clipboard", "html"] as const)("preserves footnote text with output-appropriate links in %s", async mode => {
  const result = await renderWechat({ output: mode, revision: 1,
    markdown: `正文[^n]。\n\n[^n]: 来源说明：${mode === "clipboard" ? String.raw`https\://example.test/source` : "<https://example.test/source>"}\n\n后续正文[^other]\n\n[^other]: 第二条` },
    { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
  expect(result.html).toContain('id="fn1"');
  if (mode === "clipboard") expect(result.html).not.toContain("href=");
  else {
    expect(result.html).toContain('href="#fn1"');
    expect(result.html).toContain('href="#fnref1"');
  }
  expect(result.html.indexOf("后续正文")).toBeLessThan(result.html.indexOf('id="fn1"'));
  expect(result.text).toContain("来源说明：https://example.test/source");
  const output = document.createElement("template");
  output.innerHTML = result.html;
  const references = output.content.querySelector(".plainly-article, section")?.lastElementChild;
  expect(references?.querySelector("h2")?.textContent).toBe("参考资料");
  expect(Array.from(references?.querySelectorAll("li > span") ?? [], item => item.textContent)).toEqual(["[1]", "[2]"]);
  if (mode === "clipboard") expect(references?.querySelector("a")).toBeNull();
  else expect(references?.querySelector('a[href="https://example.test/source"]')?.textContent).toBe("https://example.test/source");
  result.dispose();
});

it("renders info and warning callout titles and body with inline styles in the clipboard", async () => {
  const markdown = "> [!info]\n> 正文说明\n\n> [!WARNING] **注意**\n> 风险说明\n\n> 普通引用 [!INFO]\n\n> \\[!INFO]";
  const { body } = parseWechat(markdown, []);
  expect(body.querySelector(".workbench-callout-info strong")?.textContent).toBe("信息");
  expect(body.querySelector(".workbench-callout-warning strong strong")?.textContent).toBe("注意");
  expect(body.querySelector(".workbench-callout-warning br")?.nextSibling?.textContent).toContain("风险说明");
  expect(body.querySelectorAll("blockquote:not([class])")).toHaveLength(2);
  const result = await renderWechat({ output: "clipboard", revision: 1, markdown },
    { image: vi.fn(), derive: vi.fn(), sources: vi.fn() });
  const article = document.createElement("template");
  article.innerHTML = result.html;
  const [info, warning, quote] = article.content.querySelectorAll("blockquote");
  expect(info.style.backgroundColor).toBe("rgb(230, 244, 254)");
  expect(warning.style.backgroundColor).toBe("rgb(255, 247, 194)");
  expect(quote.textContent).toContain("普通引用 [!INFO]");
});

it("preserves prose between display formulas on the same line", () => {
  const { body } = parseWechat("$$a$$ 以及 $$b$$", [
    { kind: "math-block", source: "a", line: 0 }, { kind: "math-block", source: "b", line: 0 },
  ]);
  expect(body.textContent).toContain("以及");
});

it("prepares standalone SVG math with dimensions from the offline renderer", async () => {
  const result = await graphic("math-block", "\\frac{a}{b}");
  expect(result.blob.type).toBe("image/svg+xml");
  expect(result.width).toBeGreaterThan(5);
  expect(result.height).toBeGreaterThan(5);
  const source = await new Promise<string>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(result.blob);
  });
  const svg = new DOMParser().parseFromString(source, "image/svg+xml");
  expect([...svg.querySelectorAll("path")].some(path => !path.closest("defs"))).toBe(true);
});
