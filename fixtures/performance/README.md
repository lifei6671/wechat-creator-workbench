# 工作台长文基准

在 Windows 上从仓库根目录运行。先关闭其他基准实例，保持工作台测试窗口可见。基准包使用单独的 Tauri 应用标识，WebView2 也使用临时配置目录。输入均来自 `documents.mjs` 的固定种子。

```powershell
$env:VITE_EDITOR_PERF = '1'
$perfConfig = (Resolve-Path 'fixtures/performance/tauri.perf.json').Path
pnpm tauri build --no-bundle --config $perfConfig
Remove-Item Env:VITE_EDITOR_PERF
node fixtures/performance/run.mjs src-tauri/target/release/wechat-creator-workbench-performance.exe perf-results 5 L1-100k,L3-5000,L4,L5,L2-300k,L2-1m,L6,outputs,tabs
```

结果目录包含每一轮的 JSON 分布数据以及第一轮的合成文稿窗口截图。`input.nextFrameMs` 从合成 ProseMirror 事务测到下一次 `requestAnimationFrame`。`operationMs` 只测操作，`save.ipc` 包含 Tauri IPC 和数据库提交。`outputs` 验证未保存正文的读取，`tabs` 记录 1、5、10 篇十万字文稿的 DOM 数量、JS 堆、WebView2 工作集和切换时延，还检查 50 次保存、关闭和重开。

在改动前后使用同一构建类型、样本、轮数、窗口尺寸和缩放。常规构建使用默认环境即可。

```powershell
node fixtures/performance/summarize.mjs perf-before perf-after perf-before-tabs perf-after-tabs
```
