# 浏览器主题回归

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm test:browser
```

使用 [Playwright Test](https://github.com/microsoft/playwright) 的 Chromium、WebKit 项目，固定工具版本并复用两个引擎的同一份断言。测试自动启动 1421 端口的 Vite，退出时关闭服务；测试结果及失败 trace 写入忽略目录 `output/playwright/test-results`。现有 Windows、macOS CI 桌面矩阵运行相同命令。

`theme-quotes.spec.ts` 覆盖 9 套主题、LF/CRLF 原文、单段及三段引用、13 类三段提示块，比较实际 `DocumentEditor` 的编辑／阅读模式和预览、公众号复制、HTML 导出结果。断言普通段落、末尾段落的计算边距、实际段间距离，以及切换模式后原文不变。夹具位于 `apps/desktop/tests`，不参与生产入口。

引用样式必须在真实引擎中验证：当前 jsdom 对 `margin: 0 0 20px; margin-bottom: 0;` 的长短属性覆盖解析与浏览器不同，单元测试不能替代这组回归。跨平台测试不比较字体像素、整页高度或不同系统的字形。
