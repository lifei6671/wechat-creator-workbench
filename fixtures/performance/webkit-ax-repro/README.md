# macOS 富文本编辑器卡死复现

两份样本从 AOCI-CODE README 缩减而来，保留段落、标题和 Markdown 标记结构，正文及图表标签使用合成文字。 [原始 README](https://github.com/aoci-spec/aoci-code)

| 样本 | 构成 | 修复前，macOS 27.0.1（26A434）实测 |
| --- | --- | --- |
| `mermaid.md` | 2 个标题、2 个斜体段落、1 张图 | 编辑区为 660 × 290 px、滚动到 420 px、Mermaid 块处于编辑状态时，查询超时 |
| `without-mermaid.md` | 3 个标题、5 个段落、1 个列表 | 编辑区为 660 × 726 px、滚动到 207 px、光标在普通段落内时，查询超时 |

## 运行

1. 用 `VITE_EDITOR_PERF=1` 启动工作台 macOS 调试版，使用独立测试工作区。用默认排版，关闭大纲和文内查找，窗口大小保持至少 1360 × 840。以富文本模式打开选中的样本，只保留这个文稿的标签页。Mermaid 样本需等图表预览显示。
2. 从获得 macOS 辅助功能授权的终端运行 `swift probe.swift <工作台进程 PID>`。
3. 在 20 秒内把 `scroll.js` 粘贴到工作台的 Web Inspector 控制台执行。脚本设置编辑区大小，在对应滚动位置定位光标。探针查询辅助功能属性 `AXVisibleCharacterRange`。

## 对照结果

- 无图样本约 1.5 秒超时。仅隐藏第一个标题的折叠按钮，正文和滚动范围相同，查询完成。仅隐藏后续任一标题按钮，原始节选仍超时。可在步骤 3 前通过控制台重做第一个对照。

  ```js
  document.querySelector(".ProseMirror > h3:first-child > .rich-heading-fold").style.display = "none";
  ```
- 将 Mermaid 示例的围栏语言从 `mermaid` 改为 `text`，其余内容及操作相同，查询完成。
- 两份短样本都通过了“将标题折叠按钮移出标题文字 DOM”的实验。完整 README 仍能复现，光标进入文中 Mermaid 块时，`AXVisibleCharacterRange` 查询在滚动位置 12400 px 超时。此实验未进入应用。
- WebContent 主线程采样在 WebKit 的可见文本范围计算里命中 `visibleCharacterRangeInternal` 和 `previousLineStartPositionInternal`。 [WebKit 实现](https://github.com/WebKit/WebKit/blob/safari-7625.1.29.11-branch/Source/WebCore/accessibility/AccessibilityObject.cpp)

## 独立 WKWebView 复现

`standalone.html` 保留无图样本的富文本 DOM、首个标题的折叠按钮和光标所在斜体段落两侧的装饰标记。页面没有工作台代码及编辑器框架，加载后会滚动到 207 px 并设置光标。从本目录运行：

```sh
swiftc webview.swift -o /tmp/workbench-fresh-webview
swiftc probe.swift -o /tmp/workbench-ax-probe
/tmp/workbench-fresh-webview "$PWD/standalone.html" &
webview_pid=$!
/tmp/workbench-ax-probe "$webview_pid"
kill "$webview_pid"
```

原始 DOM 通过 `::before { content: attr(data-markdown) }` 显示标记。将两个斜体标记改为普通的 DOM 文本，同时移除相应的 `::before`，保留 `contenteditable="false"`、按钮及布局，独立探针完成查询。应用使用同样做法显示光标周围的 Markdown 标记和代码围栏。

修改后，两份工作台样本、完整 README 原来的 12400 px 卡点，以及 660 px 和 786 px 宽度下从文首到文末的滚动采样均通过。
