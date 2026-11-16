# 第三方组件

本项目采用 [GPL-3.0](LICENSE)。P0/P1 使用以下上游组件，具体依赖版本及校验信息见 `pnpm-lock.yaml` 和 `src-tauri/Cargo.lock`：

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| [Tauri 与官方插件](https://github.com/tauri-apps/tauri) | MIT 或 Apache-2.0 | 桌面窗口、单实例、原生文件对话框和 IPC 能力范围 |
| [Arboard](https://github.com/1Password/arboard) | MIT 或 Apache-2.0 | Rust 读写系统剪贴板 |
| [clipboard-win](https://github.com/DoumanAsh/clipboard-win) | BSL-1.0 | 识别 Windows 剪贴板中的 HTML 格式 |
| [React](https://github.com/facebook/react) | MIT | 工作区组件 |
| [Radix UI Themes](https://github.com/radix-ui/themes) | MIT | 主题和可访问的界面控件 |
| [Lucide](https://github.com/lucide-icons/lucide) | ISC（包含采用 MIT 的 Feather 图标） | 工作区图标 |
| [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) | MIT | 可拖动及键盘可调整的分栏 |
| [Milkdown](https://github.com/Milkdown/milkdown) / [ProseMirror](https://github.com/ProseMirror/prosemirror) | MIT | 富文本编辑、撤销、选区及 Markdown 转换 |
| [prosemirror-search](https://github.com/ProseMirror/prosemirror-search) | MIT | 编辑区查找与替换 |
| [remark-math](https://github.com/remarkjs/remark-math) | MIT | 编辑器解析 Markdown 数学公式 |
| [markdown-it](https://github.com/markdown-it/markdown-it) | MIT | 基础 Markdown 渲染 |
| [DOMPurify](https://github.com/cure53/DOMPurify) | MPL-2.0 或 Apache-2.0 | 预览 HTML 允许列表净化 |
| [rusqlite](https://github.com/rusqlite/rusqlite) / [SQLite](https://sqlite.org/copyright.html) | MIT / 公有领域 | 本地事务、外键和 FTS5 全文索引 |

P2 复用 [AWS SDK for Rust](https://github.com/awslabs/aws-sdk-rust) 执行 S3 对象请求，使用 [keyring](https://github.com/hwchen/keyring-rs) 访问系统凭据库，使用 [image](https://github.com/image-rs/image) 校验图片头和尺寸，使用 [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark) 和 [lol-html](https://github.com/cloudflare/lol-html) 解析正文图像引用，使用 [zip](https://github.com/zip-rs/zip2) 生成带图归档。

P3 复用 Plainly 的三套 Rico 微信主题和公众号表格处理规则。固定来源、版权、许可和修改范围见 [排版来源](packages/wechat-renderer/SOURCES.md)。

Rust 导入使用 [scraper](https://github.com/rust-scraper/scraper) 提取公众号正文，使用 [Ammonia](https://github.com/rust-ammonia/ammonia) 净化，使用 [htmd](https://github.com/letmutex/htmd) 生成 Markdown。浏览器端用 [Juice](https://github.com/Automattic/juice) 内联主题样式，使用 [MathJax](https://github.com/mathjax/MathJax) 及 [Mermaid](https://github.com/mermaid-js/mermaid) 生成公式和图表。

P4 使用官方 [rmcp](https://github.com/modelcontextprotocol/rust-sdk) 实现 MCP 协议和 Streamable HTTP 传输（Apache-2.0），使用 [Axum](https://github.com/tokio-rs/axum) 路由本机端点（MIT），使用 [Hyper](https://github.com/hyperium/hyper) 管理可在退出时关闭的 HTTP 连接（MIT）。AI 复用 Rust 的 reqwest 与系统凭据库。

AI 写作侧栏使用 [assistant-ui 和 assistant-stream](https://github.com/assistant-ui/assistant-ui)（MIT）承载消息交互和本地会话适配；使用 [jsdiff](https://github.com/kpdecker/jsdiff)（BSD-3-Clause）显示原文和候选差异；Rust 复用 [sse-stream](https://github.com/4t145/sse-stream) 与 [futures-util](https://github.com/rust-lang/futures-rs)（均为 MIT 或 Apache-2.0）读取模型事件流。对应许可文本见 [AI 依赖许可](third-party-ai.txt)。

AI 设置支持从本地源码目录 `apps/desktop/src/assets/ai/` 加载可选图标。可在有相应许可时放入来自 [OpenAI Codex 扩展](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt)（26.51111.21308）的 `codex.png`，以及 [Anthropic Claude Code 扩展](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)（2.1.325）的 `claude-code.png`。图标归各自的发布方所有。未提供图标时，界面用代理名称标识。
