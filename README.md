# 微信创作工作台

面向微信公众号创作者的本地桌面应用。支持公开公众号文章导入、Markdown 写作、Plainly 排版、公众号富文本复制、素材库、S3 图床和带图导出。

开发环境为 Node.js 24.19.0、pnpm 12.5.1 和 Rust 1.98.0。Windows 需要 VS C++ 生成工具和 WebView2。macOS 版面向 macOS 14 及以上，构建需要 Xcode Command Line Tools。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

- `pnpm typecheck` 检查 TypeScript，`pnpm test` 运行前端单元测试。首次进行全仓类型检查前，先运行 `npm ci --prefix apps/sync-server` 安装同步服务的依赖。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` 验证迁移和内容服务。
- `pnpm tauri build --debug --no-bundle` 生成用于本机验证的桌面程序；`pnpm build` 构建桌面安装包。

正文和素材记录保存在系统应用数据目录下的 `workspace/content.db`，图片文件保存在 `workspace/assets/`。从「资料库」可导入公众号链接，写作区可选择主题、复制公众号富文本或导出排版 HTML。没有图床时，复制正文后可按助手中的编号逐张复制或保存图片。

### macOS 通用安装包

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
APPLE_SIGNING_IDENTITY=- pnpm build --target universal-apple-darwin --bundles app,dmg
```

`src-tauri/target/universal-apple-darwin/release/bundle/` 下的 `.app` 和 `.dmg` 同时包含 Apple Silicon 和 Intel 架构。示例使用临时签名，供本机验证。对外分发时使用 Developer ID 签名并完成 Apple 公证。

## S3 数据库备份

在「设置」→「数据库备份」配置私有 S3 桶。点「备份当前工作区」会先保存打开的稿件，再上传一份 SQLite 快照。工作台从 S3 读取工作区和备份清单，每个工作区在成功上传后保留最近 5 份备份。

在备份列表点「准备恢复」下载并校验快照，校验通过后点「确认恢复」。应用会保存待提交稿件，停止服务并重启，然后用所选快照替换本地数据库。恢复结果以快照中的内容为准。备份只包含数据库，图片由本地素材文件或图床提供；换设备后可在设置中重新填写备份、图床及 AI 所需的凭据。

## 本机 MCP

打开「设置」→「MCP 服务」，启用服务并复制令牌。默认地址为 `http://127.0.0.1:17321/mcp`，默认权限为只读。需要新建、修改内容或导入文章时，在设置里选择读写并保存。

Windows PowerShell 中从剪贴板加载刚复制的令牌，然后为 [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs) 添加服务。从包含该环境变量的终端启动客户端。

```powershell
$env:WECHAT_WORKBENCH_MCP_TOKEN = (Get-Clipboard).Trim()
codex mcp add wechat-workbench --url http://127.0.0.1:17321/mcp --bearer-token-env-var WECHAT_WORKBENCH_MCP_TOKEN
```

macOS 终端可用 `pbpaste` 读取刚复制的令牌。

```sh
export WECHAT_WORKBENCH_MCP_TOKEN="$(pbpaste)"
codex mcp add wechat-workbench --url http://127.0.0.1:17321/mcp --bearer-token-env-var WECHAT_WORKBENCH_MCP_TOKEN
```

[Claude Code](https://code.claude.com/docs/en/mcp) 可在项目的 `.mcp.json` 使用同一个环境变量。从设置改过端口时同步替换示例地址。

```json
{
  "mcpServers": {
    "wechat-workbench": {
      "type": "http",
      "url": "http://127.0.0.1:17321/mcp",
      "headers": { "Authorization": "Bearer ${WECHAT_WORKBENCH_MCP_TOKEN}" }
    }
  }
}
```

## AI 助手

在「设置」→「AI 代理」启用 AI，并选择默认目标：

- **本地代理**：在本机安装并登录 Codex CLI 或 Claude Code。工作台会检测可执行文件，并使用 CLI 已有的登录凭据。工作台将本次文字交给代理生成候选，应用候选仍需在编辑器中确认。
- **本地模型**：启动 Ollama 或 LM Studio 的本机服务，填写模型名。设置里可直接选用这两种服务的默认接口地址。
- **API 模型**：可选用 OpenAI、Gemini、OpenRouter 预设，也可填写自定义的 Chat Completions 基础 URL 或完整接口地址。API 密钥留在系统凭据库中。

模型可在添加前测试连接，测试只发送示例文字。底部状态栏的「AI 助手」会调用默认目标生成摘要、建议标题或改写选区。关闭 AI 会停止接受新生成请求，保留已保存的目标配置。旧版单一模型配置会保留为默认目标。

项目采用 GPL-3.0，主要第三方依赖见 [NOTICE](NOTICE.md)。
