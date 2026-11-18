# Electron 网页画布验证原型

验证网页作为 React Flow 节点内的 Electron `<webview>`，能否由同一父容器统一缩放和裁切。原型不接入 Tauri 命令、正式数据库和用户登录会话。

## 启动

先安装仓库根目录现有依赖，再在仓库根目录运行：

```powershell
npm --prefix experiments/electron-canvas ci --workspaces=false
npm --prefix experiments/electron-canvas start
```

原型单独锁定 Electron 45.3.4，复用根目录已安装的 React、React Flow、Radix UI 和 Vite。不会改动根目录依赖或正式应用入口。Electron 首次安装或启动时需要下载对应平台的二进制。

在空白区域拖动平移，滚轮或工具栏缩放。网页一直实时运行；点击「浏览网页」或双击网页卡片后，可以操作网页。点击「操作画布」恢复画布手势。地址栏可输入 HTTP(S) 网页。网页标题显示在卡片上沿。

开发服务器和测试网页均仅监听本机回环地址。网页使用独立、非持久化的 Electron session；主界面和网页均无 Node 集成，网页不具有工作台文件和命令权限。此开发原型没有正式打包、自动更新或业务 IPC。

## 自动验证

Windows 交互式桌面环境需要 PowerShell 7（`pwsh.exe`）：

```powershell
npm --prefix experiments/electron-canvas run typecheck
npm --prefix experiments/electron-canvas run verify -- --scale=1
npm --prefix experiments/electron-canvas run verify -- --scale=1.5
```

测试窗口会短暂置顶，并通过 Windows 原生输入验证滚动和点击。窗口关闭后置顶状态随之消失。每次启动使用新的临时浏览器配置目录，位置前缀为系统临时目录下的 `workbench-electron-canvas-`；原型不读取正式应用数据。

每个显示比例的测量结果和截图输出到 `artifacts/scale-<比例>/`，不纳入 Git。`results.json` 包含运行版本、排版指标、合成帧和实际桌面采样数量。

验证覆盖：

- 30 段连续缩放中的中间比例，网页 CSS 视口、正文段落高度、滚动位置、实例身份和 resize 历史。
- 网页 `requestAnimationFrame` 持续推进，动态颜色确实出现在浏览器合成输出中。
- 浏览器合成帧及 Windows 实际桌面上的固定颜色标记。置顶窗口保证桌面采样目标可见，前台状态另行记录。
- 10% 至 300% 的缩放边界；四个边缘分别检查区域内网页仍在、区域外没有网页泄漏；完全移出后返回。
- 从 Windows `SendInput` 向缩放后卡片的实际屏幕位置发送滚轮和点击，经过正常命中测试，不直接向 guest 注入点击。
- 来自不同端口的跨域测试页，保留 `X-Frame-Options: DENY` 和 CSP `frame-ancestors 'none'`，以及真实 HTTPS 页面 example.com。

`capturePage` 和桌面像素采样仅用于测量与生成验收资料；渲染路径没有截图、图片替身、原生窗口位置同步或网页 zoomFactor 调整。

## 结果和边界

本次结果见 [验证记录](../../docs/electron-canvas-prototype-results.md)。原型通过意味着此渲染路线可行，不意味着已经完成桌面容器迁移，也不意味着所有网站和操作系统均已验证。

采用此路线正式实现时，需要替换 Tauri 桌面宿主和原生能力适配。React 界面、画布数据和 SQLite 数据模型可以复用；Rust 领域逻辑可拆分复用，Tauri 命令、事件、窗口和插件调用需要重新接入。

Electron 官方目前不推荐将 `<webview>` 作为无需维护的长期承诺，说明其上游架构变化可能影响渲染、导航和事件路由。迁移评估必须包含 Electron 升级回归、目标网站、内存与包体积、原生功能和 Rust 通信适配。`WebContentsView` 不属于 DOM，不能视作继承 React Flow CSS 变换的直接替代品。

参考与选型来源：[Electron](https://github.com/electron/electron)（MIT）、[React Flow](https://github.com/xyflow/xyflow)（MIT）、[Electron WebView 文档](https://www.electronjs.org/docs/latest/api/webview-tag)、[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[Obsidian Web viewer](https://obsidian.md/help/plugins/web-viewer)。
