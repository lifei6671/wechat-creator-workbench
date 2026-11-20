# 关于页与发行指南

关于页位于设置导航底部，与原有设置表单独立滚动。当前版本读取 Tauri 运行时元数据；平台和架构使用当前应用编译目标。更新检查、下载和已校验的包由原生进程持有，离开页面或关闭设置不会丢失状态，退出整个应用后不恢复下载。

页面仅列出 Tauri、React、Milkdown、Radix UI、React Flow、assistant-ui 和 rusqlite 七个核心组件，版本与许可信息仍来自构建生成的完整清单。完整依赖资料继续随应用分发。

更新使用官方 Tauri updater，来源固定为本仓库最新正式 Release 的 `latest.json`。仅接受更高的稳定语义版本，按应用构建架构匹配更新；检查请求 30 秒超时，包下载 5 分钟超时。下载及安装均验证签名。检查、下载失败可以重试，不显示为“最新版本”。

点击 Windows「退出并安装」或 Mac「安装并重启」后，先保存文稿和画布、等待写入，再复用停止任务和素材清理流程，最后交接官方安装器。保存失败、用户取消或安装器启动失败会恢复工作区；安装器接管后由系统安装器反馈。更新路径绕过关闭到托盘设置。

## 本地开发与开源清单

首次安装开发工具：

```sh
pnpm install --frozen-lockfile
npm ci --prefix apps/sync-server
cargo install cargo-about --version 0.9.3 --locked --features cli
cargo fetch --manifest-path src-tauri/Cargo.toml --locked
pnpm web:build
```

`web:build` 通过 cargo-about 收集目标平台的 Rust 许可，以 Cargo 已解析的普通依赖图过滤构建依赖与 proc-macro，再由 rollup-plugin-license 收集实际进入前端产物的组件，保留同库多版本。组件清单及依赖随附的许可正文放入桌面前端产物 `licenses.json`，未附正文的组件明确显示缺失，并保留许可证标识和项目链接；同时包含原有 NOTICE、AI 署名和抽离主题的来源及许可证。开发服务器读取最近一次实际打包的前端清单，新增或变更前端依赖后重新运行 `web:build`。

开发构建默认公钥为空，关于页仍能离线查看版本和组件，检查更新按钮禁用。不会拿测试公钥或示例密钥冒充正式更新配置。

## 正式发行准备

1. 由维护者确定首发版本。以 `pnpm tauri signer generate -w <仓库外的私钥路径>` 生成并妥善备份长期使用的更新密钥；私钥与密码不提交到仓库。密钥丢失会影响已有安装的后续更新。
2. 配置 Actions Secrets：`TAURI_SIGNING_PRIVATE_KEY`（私钥内容）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（没有密码时留空）及 `TAURI_UPDATER_PUBLIC_KEY`（生成的公钥文件完整内容）。公钥内容本身可以公开，构建时写入应用；流水线使用同一公钥验证三个签名，私钥与公钥不匹配时不能发布。
3. 在 `docs/releases/vX.Y.Z.md` 提交本次详细中文更新记录，基于实际发行差异写清新增行为、修复、同步服务端变化、兼容性及迁移。首发介绍已经交付的能力。文件缺失、过短或含 TODO / 待填写等占位内容时停止发行。
4. 通过项目 CI 和评审后推送 `vX.Y.Z` 标签。只有这一动作才会触发 `.github/workflows/release.yml`；本次开发没有推送标签或发布。

Mac 使用 ad-hoc 签名，不需要 Apple 开发者账户或公证凭据，首次打开可能需要在系统“隐私与安全性”中允许。Windows 目前不做系统代码签名，Tauri 更新签名仍为必需项；两者不能混淆。

## 流水线与版本

发行脚本在 CI 临时工作区将标签版本统一注入根 package、Tauri 配置、Rust package、同步服务端 package，以及 Cargo / npm 锁文件中的本项目记录。pnpm 锁文件没有本项目版本字段，不改第三方版本。注入结果不自动提交回 master。

质量检查保留前端类型检查、测试和构建、服务端 Node / Worker 契约、Clippy 和 Rust 测试。Mac ARM64 使用 `macos-15`，Intel 使用 `macos-15-intel`，Windows 使用 `windows-latest`；三个平台分别原生编译。NSIS 安装与卸载启用简体中文，使用本项目安装器和卸载器图标。

各任务只上传工作流产物。统一发布任务在全部检查和构建成功后校验约定的附件、签名和清单，再写入同一个草稿 Release，确认上传齐全后公开。失败的草稿可重跑；已经公开的版本不会覆盖，需要新标签。更新清单与 Release 使用同一份正文及自动补充的下载说明。

## 服务端包

`node scripts/package-sync.mjs vX.Y.Z` 消费已经注入版本并编译好的同步服务源码工作区，分别生成：

- `CreatorWorkbench-X.Y.Z-sync-cloudflare.tar.gz`：已打包 Worker、指向编译入口的 Wrangler 配置、完整迁移、管理员恢复脚本、锁定部署工具与运行组件许可。
- `CreatorWorkbench-X.Y.Z-sync-vps.tar.gz`：`dist`、生产依赖及锁文件、迁移、直接消费编译结果的 Dockerfile / Compose、环境变量模板及运行组件许可。

两包包含版本、来源提交、协议版本和各自部署说明，不读取或包含本机生产配置、账号、数据库、素材或真实密钥。VPS 原生 SQLite 依赖在目标系统或容器内安装。

本地检查：

```sh
npm run build --prefix apps/sync-server
node scripts/package-sync.mjs v0.1.0
# 在当前 package 版本与标签一致时使用；0.1.0 只是仓库开发版本，不代表决定首发版本。
```

设置 `RELEASE_PACKAGE_TEST=1` 后运行 `node --test scripts/package-sync.test.mjs`，从解压后的 Worker 入口和 VPS Node.js 入口运行同一套 HTTP 契约，测试数据使用独立临时目录。设置 `RELEASE_DOCKER_TEST=1` 后运行 `node --test scripts/docker-sync.test.mjs`，会使用解压后的发行包构建并启动 Docker 镜像，再运行同一套契约；测试只移除自身创建的容器、镜像和临时目录。这两项均进入发行流水线。本机没有可用 Docker 引擎时不能宣称容器验收通过。真实部署升级、三平台安装与两个连续版本的升级验收需要单独记录，不能以编译通过代替。
