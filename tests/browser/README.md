# 浏览器主题回归

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm test:browser
```

使用 [Playwright Test](https://github.com/microsoft/playwright) 的 Chromium、WebKit 项目，固定工具版本并复用两个引擎的同一份断言。测试自动启动 1421 端口的 Vite，退出时关闭服务；测试结果及失败 trace 写入忽略目录 `output/playwright/test-results`。现有 Windows、macOS CI 桌面矩阵运行相同命令。

`theme-quotes.spec.ts` 覆盖 9 套主题、LF/CRLF 原文、单段及三段引用、13 类三段提示块，比较实际 `DocumentEditor` 的编辑／阅读模式和预览、公众号复制、HTML 导出结果。断言普通段落、末尾段落的计算边距、实际段间距离，以及切换模式后原文不变。夹具位于 `apps/desktop/tests`，不参与生产入口。

引用样式必须在真实引擎中验证：当前 jsdom 对 `margin: 0 0 20px; margin-bottom: 0;` 的长短属性覆盖解析与浏览器不同，单元测试不能替代这组回归。跨平台测试不比较字体像素、整页高度或不同系统的字形。

`footnote-layout.spec.ts` 使用同一 Markdown 样稿和实际 `DocumentEditor`，覆盖 9 套主题、编辑／阅读模式、340px／840px 栏宽、100%／125% 缩放，以及技术主题的 CRLF。通过文本 Range 的实际行框检查常规编号完整、首行对齐、英文单词不被拆开、长网址可以折行、极长自定义标识不挤垮正文且不溢出；同时验证作者硬换行保留、没有新增硬换行和原文不变。

`folder-colors.spec.ts` 覆盖目录纯颜色修改、重新编辑、恢复默认、自定义颜色的鼠标／键盘原生焦点移交、Esc 取消、重复保存锁和固定错误占位，并检查画布调色板的关闭行为及无关重渲染不覆盖颜色草稿。原生对话框的焦点丢失通过 DOM 事件模拟；测试不操作系统选色器本身。浏览器单例用例预算为 60 秒，断言仍使用默认等待时间，兼顾 Windows WebKit 的冷启动耗时。

目录颜色显示回归挂载真实 `Explorer`，通过右键菜单编辑并保存后，断言底板的计算背景色及最终 SVG 的白色 `color`／`stroke`，同时检查底板尺寸、圆角、图形居中和编辑前后的文字对齐。覆盖目录树、时间流、明暗外观、嵌套目录、展开图标、切换图标、自定义颜色、125% 缩放、重新加载及默认灰色恢复，并确认文章图标不受影响，避免只检查外层属性而漏掉 SVG 的 CSS 覆盖。
