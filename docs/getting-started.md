# 安装、开发与配置

开发环境为 Node.js 24.19.0、pnpm 12.5.1 和 Rust 1.98.0。Windows 需要 VS C++ 生成工具和 WebView2。macOS 版面向 macOS 14 及以上，构建需要 Xcode Command Line Tools。

```sh
pnpm install --frozen-lockfile
cargo install cargo-about --version 0.9.3 --locked --features cli
cargo fetch --manifest-path src-tauri/Cargo.toml --locked
pnpm web:build
pnpm dev
```

- `pnpm typecheck` 检查 TypeScript，`pnpm test` 运行前端单元测试。首次进行全仓类型检查前，先运行 `npm ci --prefix apps/sync-server` 安装同步服务的依赖。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` 验证迁移和内容服务。
- `pnpm tauri build --debug --no-bundle` 生成用于本机验证的桌面程序；`pnpm build` 构建桌面安装包。
- 「设置 → 关于」显示本机版本、更新状态和离线开源组件清单。开发构建未配置更新签名时禁用检查；正式发行、签名配置及部署包说明见 [发行指南](release-guide.md)。

面向 `master` 的 Pull Request 和推送到 `master` 后，GitHub Actions 会运行前端类型检查和测试、同步服务的 Node/Workers 本地契约测试，以及 macOS、Windows 的 Clippy、Rust 测试和桌面编译。浏览器与原生检查分别运行，浏览器失败不会阻止原生检查；原有 `Desktop` 检查汇总两类结果，任一失败、取消或跳过均不能通过。Clippy 将警告视为失败。`master` 要求通过 Pull Request 合并，且 `Frontend and sync server`、`Desktop (macos-latest)`、`Desktop (windows-latest)` 三项检查全部通过，分支与最新 `master` 保持同步；管理员同样受约束，无需额外审批。CI 不部署服务，也不发布安装包。

正文和素材记录保存在系统应用数据目录下的 `workspace/content.db`，图片文件保存在 `workspace/assets/`。通过「导入链接」可导入公众号文章，写作区可选择主题、复制公众号富文本或导出排版 HTML。没有图床时，复制正文后可按助手中的编号逐张复制或保存图片。

右下角字数后显示当前文章的状态，无状态时隐藏。公众号侧栏中的推荐阅读需要点击「自动推荐」生成，打开侧栏、编辑正文和复制都不会自动推荐。默认设置支持作者多选，精确匹配任一选中作者；留空时不过滤作者。输入框聚焦后显示候选，也可输入作者后按回车添加。

启用图床自动上传时，因退出而中断的图片上传会在下次启动后自动继续，完成后文章中的本地图片链接会更新为公开链接。网络或图床配置错误仍需处理后手动重试。

Obsidian Web Clipper 中选择「复制到剪贴板」后，在工作区空白处或文章正文按 `Ctrl+V`（macOS 为 `Command+V`），会将带有 `title` 和 `source` 属性的剪藏收录到当前文件夹，并在新标签页打开。作者、原文发布日期、剪藏日期、摘要和标签会保存为文章属性，重复来源打开已有文章。远程图片遵循粘贴图片下载设置；Obsidian 本地附件只有文件名时保留引用并提示缺少文件。使用纯文本粘贴可保留完整原文，不触发导入。

在「设置 → 同步」展开「查看冲突内容」，可对照文章或白板冲突项的本地与云端版本，并选择保留本地、采用云端或另存副本。白板按白板信息、卡片、连线分别处理冲突；另存副本会完整复制本地白板的卡片、布局和连线，保留已有文章及图片引用，再为原冲突项选择云端版本。同组冲突需全部处理后才能应用。云端已删除的白板项不能在原 ID 上恢复，可另存副本以保留本地内容；本地已删除的项没有可另存的副本。

回收站右上角的垃圾桶按钮可清空全部已删除内容，操作前会确认。可在「设置 → 通用 → 回收站保留时间」选择 1、7、14、30、90 天或不自动清理，默认 7 天；应用启动时及运行期间每小时清理过期内容。清理会移除正文、历史版本及关联 AI 记录，其他文档共用的素材仍会保留。

### macOS 固定自签名

macOS 打包默认使用钥匙串中的 `Wechat Creator Workbench Self-Signed` 代码签名身份。首次配置可在「钥匙串访问 → 证书助理 → 创建证书」中使用这个名称，身份类型选择「自签名根」，证书类型选择「代码签名」，并设置较长的有效期。后续构建复用同一张证书及其私钥。

```sh
security find-identity -p codesigning
make build-desktop
```

当前平台的 `.app` 输出到 `src-tauri/target/release/bundle/macos/`。首次签名时，macOS 可能要求授权 `codesign` 使用私钥；从临时签名切换到固定证书后，访问已有凭据也可能需要重新授权一次。

更换构建电脑时，应导入同一份含私钥的 `.p12`，不要重新创建同名证书。证书和私钥不进入 Git 仓库。当前发行流水线显式使用临时签名；如需在 CI 中复用固定证书，需通过受保护的 Secrets 导入同一份 `.p12`，再调整签名身份。自签名版本未经 Apple 公证，下载者可能仍需手动允许打开。可通过 `APPLE_SIGNING_IDENTITY` 环境变量覆盖签名身份。

### macOS 安装包

与发行流水线一致，Apple Silicon 和 Intel 分别构建。在对应架构的 Mac 上运行以下命令，生成本机架构的安装包：

```sh
APPLE_SIGNING_IDENTITY=- pnpm build --bundles app,dmg
```

产物位于 `src-tauri/target/release/bundle/`，其中 `.app` 和 `.dmg` 仅包含本机架构。示例使用临时签名，供本机验证。发布签名和首次打开方式见[发行指南](release-guide.md)。

## S3 数据库备份

在「设置」→「数据库备份」配置私有 S3 桶。点「备份当前工作区」会先保存打开的稿件，再上传一份 SQLite 快照。工作台从 S3 读取工作区和备份清单，每个工作区在成功上传后保留最近 5 份备份。

在备份列表点「准备恢复」下载并校验快照，校验通过后点「确认恢复」。应用会保存待提交稿件，停止服务并重启，然后用所选快照替换本地数据库。恢复结果以快照中的内容为准。备份只包含数据库，图片由本地素材文件或图床提供；换设备后可在设置中重新填写备份、图床及 AI 所需的凭据。

## 本机 MCP

1. 打开工作台的「设置」→「MCP 服务」，点「启用 MCP」。初次启用为只读。使用期间保持工作台运行。
2. 选 Codex，点「复制 Codex 配置」。打开个人 `~/.codex/config.toml`（Windows 为 `%USERPROFILE%\.codex\config.toml`，自定义 `CODEX_HOME` 时在该目录下），将复制的服务段保存到文件中。已有 `[mcp_servers.wechat-workbench]` 时，更新其中的 `url` 和 `http_headers.Authorization`，删除旧的 `bearer_token_env_var`，保留其他服务和设置。配置含有效令牌，只保存在本机个人配置文件中。
3. 完全退出 Codex，按平时的方式重新打开。请 Agent「用 wechat-workbench 的 list_entries 读取最近三条，告诉我标题和类型」。空列表也表示连接成功，工作台会显示最近成功访问的客户端和时间。以后正常重启即可复用这条连接。

Claude Code 用户选择「Claude Code」并点「复制客户端配置」，将 JSON 中的 `wechat-workbench` 服务合并进个人 `~/.claude.json` 顶层的 `mcpServers`。如果此前在项目的 `.mcp.json` 或项目本地配置注册过同名服务，请移除旧的同名项，以便个人配置生效。重启 Claude Code 后可用 `/mcp` 查看状态。其他客户端将 JSON 中的地址和 `Authorization` 请求头填入个人 Streamable HTTP 连接设置。[Codex MCP 配置](https://developers.openai.com/codex/mcp/) / [Claude Code MCP 配置](https://code.claude.com/docs/en/mcp#choose-the-right-scope)

需要写入时，在工作台「高级设置」选择读写并保存，再让客户端重连。更换端口或重置令牌后，重新复制并更新已接入客户端的配置。服务仅监听本机，默认地址为 `http://127.0.0.1:17321/mcp`。

## AI 助手

在「设置」→「AI 代理」启用 AI，并选择默认目标：

- **本地代理**：在本机安装并登录 Codex CLI 或 Claude Code。工作台会检测可执行文件，并使用 CLI 已有的登录凭据。工作台将本次文字交给代理生成候选，应用候选仍需在编辑器中确认。
- **本地模型**：启动 Ollama 或 LM Studio 的本机服务，填写模型名。设置里可直接选用这两种服务的默认接口地址。
- **API 模型**：可选用 OpenAI、Gemini、OpenRouter 预设，也可填写自定义的 Chat Completions 基础 URL 或完整接口地址。API 密钥留在系统凭据库中。

模型可在添加前测试连接，测试只发送示例文字。底部状态栏的「AI 助手」会调用默认目标生成摘要、建议标题或改写选区。关闭 AI 会停止接受新生成请求，保留已保存的目标配置。旧版单一模型配置会保留为默认目标。

项目采用 GPL-3.0，主要第三方依赖见 [NOTICE](../NOTICE.md)。
