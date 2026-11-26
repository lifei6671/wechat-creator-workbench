# 文章质量审查首期实施记录

日期：2026-11-26
基线：`382cc49e3af7a8506dd04d0847efecfefbb094fc`

## 范围与阶段

首期接入 Makers 朱雀文本检测，实现配置、全文/选区检测、占比与片段展示、定位高亮、修改失效和主动复检。后端与 mock 先完成，界面原型经确认后实现前端；真实 Key 随后用于核实厂商契约。原有技术方案保留不改，实际契约差异记录于本文。

## 接口核实

2026-11-26 阅读[腾讯官方朱雀文档](https://cloud.tencent.com/document/product/1552/137539)（标注更新于 2026-11-12）及 [Makers 模型概览](https://cloud.tencent.com/document/product/1552/132760)。确认固定 HTTPS 分类端点、Bearer 鉴权、`text` 和 `is_merge` 参数、0/1/2 标签、三类比例、整体指标及两套用量字段。只有 `makers_models_usage.total_tokens` 用于本机观测的额度统计。

公开文档没有明确文本长度上下限、段落切分算法、Unicode 偏移单位及位置数组含义。2026-11-26 使用个人 Key 对固定合成文本执行 7 次基础探针和 3 次定向探针，均 HTTP 200、业务成功。记录分别保存于 [基础探针](article-quality-review-api-probe.json)和[Unicode 与长度探针](article-quality-review-api-offsets.json)。不保存 Key、请求头或私人文章。

| 合成样本 | 观测结果 |
| --- | --- |
| 中文、ASCII、非 BMP emoji、组合字符、换行，80 Unicode 标量 / 82 UTF-16 单元 | 返回位置 `[0,80]`，不是 UTF-16 计数。 |
| 2530 标量 / 2770 UTF-16 单元，多段及 CRLF | `is_merge:false` 返回 9 段；第二段 `[263,273]` 仅符合 Unicode 标量“起点 + 长度”，其余非首段亦完全吻合。 |
| 同一长 Unicode 样本 `is_merge:true` | 返回 1 段 `[0,2530]`。 |
| 单个汉字、1000、5000、20000 汉字 | 全部成功。1000 字返回 `[0,384]`、`[384,384]`、`[768,232]`，证实第二个数字是长度。 |
| 131072 UTF-8 字节，43692 标量 | 成功，114 段；验证客户端 128 KiB 保护上限的可执行样本。 |

确认 `position` 为 **Unicode 标量起点 + 标量长度**。适配器用标量边界表转换为 UTF-16 左闭右开区间，必须与厂商分段原文精确相同，重复文字也可按有效位置定位；位置缺失、不一致或越界时，只接受唯一精确子串匹配，否则保留分类而不高亮。最初按端点范围校验的草案会拒绝部分长文本，已依据真实响应修正，并以真实合成响应 fixture 回归；适配器缓存版本升为 2。

`is_merge:false` 仍会在段内切分，段数不能当作 Markdown 段落数。观测中的纯中文窗口常为 384 标量，尾段可能更长；含 Unicode 混合内容的段长不同，不能据此假定固定分段算法。空白未归一化的样本可逐片精确匹配。

厂商未公布真实上限，本次未穷举到远端拒绝边界；可以确认单字和客户端 128 KiB 样本均可接受。128 KiB 是本机保护策略，不宣称为腾讯上限。超限选择部分正文，不自动拆分请求或合并比例。7 次基础探针观测扣减 43660 token，3 次定向探针 81254 token，共 124914 token；这是探针本身的观测值，不表示账户余额。常规样本约 2–8 秒，128 KiB 样本约 29 秒，属于本机单次联调记录。

Makers 概览将内置模型定位为技术验证体验，明确不建议生产使用。首期保持默认关闭的可选体验，不将其作为发布审核或作者身份判定。正式发布适用性仍须核实。

## 源码边界

复用 `Workspace` 普通设置、`secrets::entry` 系统凭据、reqwest/serde、Tauri 命令与权限注册。审查不加入 MCP、内容实体和同步协议。派生缓存放在应用缓存目录下按 workspace 隔离，独立 SQLite 文件，不改变主库 schema。现有备份选择主库快照及 assets，缓存与 Keyring 不进入备份。

## 验证记录

- `cargo test --manifest-path src-tauri/Cargo.toml --locked review:: -- --nocapture`：真实偏移契约修正后 10 通过，原生凭据测试默认忽略。普通测试不依赖云端或系统凭据。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked native_keyring_settings_roundtrip -- --ignored --nocapture`：Windows 原生 Keyring 1 通过；仅使用临时工作区和合成凭据，测试结束删除凭据。覆盖保存、不传 Key 时保持、显式空字符串删除、工作区隔离、返回与主库无明文。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`：最终 267 通过，16 忽略；其中 13 项为既有外部服务测试，3 项为需手动运行的原生凭据及真实接口测试。含 Tauri 注册校验、备份迁移、同步回归和审查 mock 测试。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`：通过。
- 前端 `pnpm test`：45 文件、633 项通过。随后设置、编辑器上下文和审查定向回归 49 项通过，类型检查通过。
- Chromium 与 Windows WebKit 的审查浏览器回归 12 项通过：覆盖实时快照、选区、结果定位、装饰撤下、过期汇总隐藏、请求期间修改/切文档、设置变化、关闭面板和缓存用量显示。
- 公众号与侧栏回归原 30 项中，26 项首次通过；4 项由新增图标数量和 Windows 间距变化触发，修正为 5 个入口且仅窄栏收紧间距后，4 项定向复测通过，新增 300px 最小侧栏的原生窗口按钮避让断言。
- `node --test scripts/probe-zhuque.test.mjs`：1 通过；真实探针另外执行，不纳入普通 CI 网络依赖。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked live_makers_review_uses_production_service -- --ignored --nocapture`：真实生产服务链路 1 通过。临时工作区将个人 Key 存入系统 Keyring，再经实际服务发出请求，获得 9 个可定位片段和 4217 token 扣减，结果成功缓存，随后缓存读取为 0 额外扣减；临时凭据已删除。与 10 次探针合计观测扣减 129131 token。
- 用量文案修正后，Chromium/Windows WebKit 设置回归另行 2 项通过，明确断言“成功调用 3 次，其中 1 次用量未知”。
- Windows `pnpm tauri build --debug --no-bundle` 最终构建通过。初版原生窗口已确认审查入口和设置页、默认关闭、Key 不回填及未配置时禁用检测；最终版本包含真实偏移契约修复与更新后的前端。
- 设置样式修复前的独立只读评审按后端、前端与契约修复分区，再做集成核对，覆盖当时 37 个本次交付文件。发现并修复用量文案“另有”为“其中”，与未知用量属于成功调用子集的契约一致；真实偏移修正后已重新审核边界转换、fixture、缓存版本及 probe。未发现剩余 P0/P1/P2。该检查点的 36 个冻结代码和支持文件（不含本实施记录）的聚合 SHA256 为 `87e767a7b02f1011fa6fcc962889638018e1b2a39bde73cf961a1994f8cefa7f`，聚合算法为按路径排序的 `path + NUL + SHA256(file) + LF` 再计算 SHA256。

本地 HTTP mock 覆盖成功、401/403/429/500/400/302、非法 JSON、业务失败、超时、禁止重试与重定向。覆盖三类分类、额外字段、未知额度、Unicode 精确唯一匹配、重叠重复匹配拒绝定位、缓存/强制请求/过期/工作区隔离、缓存失败不重发、连接测试计费但不污染文章缓存。备份迁移测试验证仅导出主库与资产，审查派生文件不进入迁移包。

Windows 真机 WebView2 的入口和设置已观察；真实 Keyring 单独测试通过。Chromium 与 Windows 版 WebKit 检查了定位、键盘操作、暗色模式及长文；这些浏览器引擎检查不等同于 macOS 原生 WKWebView 验收。macOS 远程工作区工具返回服务不存在，原生构建、Keychain 和实际中文输入法均未实测。跨平台共用 reqwest、rusqlite、Keyring 和 Tauri 路径接口，Windows 标题栏避让只在既有 Windows 适配边界收紧间距。

### 长文观测

Windows 浏览器单次取样，合成引用块每 100 汉字一段；未通过打字触发网络。投影和装饰构建分别计时，不包含模型请求。WebKit 显示 0ms 表示低于计时精度，不是零耗时。

| 汉字数量 | Chromium 投影 / 装饰 | Windows WebKit 投影 / 装饰 |
| --- | --- | --- |
| 1000 | 0.3ms / 1.0ms | <1ms / 2ms |
| 5000 | <0.1ms / 1.2ms | <1ms / 3ms |
| 20000 | 0.2ms / 2.7ms | <1ms / 6ms |

这是局部同步操作观测，未测全帧延迟、原生输入法和相对旧版的端到端打字基线，不作跨设备性能保证。

## 设置样式一致性验证

文章审查设置复用现有 `SettingRow`、`settings-card`、`setting-description` 和 `settings-footer`。开关采用通用设置的全圆角，密钥字段直接使用通用输入框尺寸、字体及边框；操作按钮采用统一尺寸并右对齐。本机用量与结果缓存作为同一卡片内的设置项，与服务配置保持同一视觉归属，移除独立分隔线和额外留白。固定错误位替换额度说明，不改变控件位置。用户可见元素及用途仍以[逐项元素说明](prototypes/article-quality-review.md)为准。

浏览器夹具使用真实 `SettingsDialog`，与桌面相同的 Radix `radius="small"`、`scaling="95%"` 及明暗主题。样式检查将审查控件与实际通用设置开关及 S3 表单对比，覆盖字段宽高、字号、圆角、边框、按钮尺寸、同一卡片内包含用量与缓存、错误位置稳定和 1000/1360px 窗口下的溢出。`pnpm typecheck` 通过；设置与审查单元测试 48 项通过；同卡片排布调整后，类型检查及 Chromium 与 Windows WebKit 的审查和样式回归 18 项再次通过。Windows WebKit 检查不代替 macOS 原生验收。

本轮 Windows `pnpm tauri build --debug --no-bundle` 通过，新版已启动，并在原生 WebView2 中逐项查看通用与文章审查设置，确认关闭状态的圆角开关、密钥框、右对齐按钮、同卡片内的用量与缓存及间距。未在用户工作区启用服务或写入 Key。独立只读复审覆盖本轮组件、样式、夹具、回归及记录，并重新核对与既有设置和审查状态逻辑的集成；无剩余 P0/P1/P2。设置样式修复后的 37 个代码及支持文件（不含本实施记录）聚合 SHA256 为 `f10f14b09ef32ddb632baea95c14d818c5d9e6199dad66001045377147c484db`，沿用上述聚合算法，路径按区分大小写的字典序排序；含本记录共 38 个交付文件。

### 未保存密钥的连接测试

`review_test_connection` 接收可选 `api_key`，前端 `reviewTestConnection(apiKey?)` 传入去除首尾空白的输入。优先使用本次输入，留空则读取已保存凭据；无需先保存或启用服务。测试只发送固定合成样本，不保存输入、不改变开关和配置代次，继续记录实际用量且不生成文章缓存。普通正文检测仍要求服务已启用并使用已保存凭据。删除按钮使用 Radix `color="red"` 的危险操作样式。

本次类型检查通过；Chromium 与 Windows WebKit 回归共 22 项通过，包含未配置、未启用、未保存密钥、覆盖已存密钥、清空后回退及不调用保存的断言。Rust 审查模块 11 项通过、3 项默认忽略；新增 Windows 原生 Keyring 与本地 HTTP mock 测试另行 1 项通过，临时工作区的凭据、开关和代次保持不变，结束删除合成凭据。全量 Rust 267 项通过、16 项默认忽略；Clippy 通过。全量并发曾使既有模拟响应校验的 50ms 时限误触发，现仅专门验证超时的用例保留 50ms，其余 HTTP 响应用例使用 2 秒时限，错误码及禁止重试断言保持。Windows 构建与启动通过。本轮未调用真实朱雀服务，未消耗额度。

## 实现差异与待确认项

- 后端实际路径为 `src-tauri/src/review.rs` 与 `review/{settings,zhuque,cache,tests}.rs`。在 `main.rs`、`build.rs` 和 `capabilities/desktop.json` 同步注册 6 条命令（含方案表未列出的缓存清理命令）。
- 单一服务拒绝重叠推理，不建立任务队列。固定端点复用 reqwest 能力，但不复用会补全 `/chat/completions` 的生成模型配置。保持系统 DNS 与本机 TUN 可用。
- 输入保护为客户端 128 KiB UTF-8 字节上限，已验证该大小的合成样本；真实厂商最大值仍未知，不自动拆分或拼接比例。适配器版本与投影版本纳入缓存键。
- 精确位置按实测标量起点及长度解析，并校验切片；无法定位的发现不保存原始片段。结果 DTO 保留分类、置信度与可空区间，UI 文案从类别生成，摘要由当前快照切片生成。
- 用量按 UTC 日历月统计，明确为本机观测值。远端失败与超时不伪装成零消耗。Makers 缺失字段仅记成功调用的未知用量，不用 `usage.total_tokens` 冒充扣减。
- [界面原型](prototypes/article-quality-review.html)及[逐项元素说明](prototypes/article-quality-review.md)已确认，前端接入 `MarkdownEditorHandle` 的投影、校验和装饰接口；审查面板通过现有选区订阅获知代次变化，不在每次按键时序列化全文。关闭面板、切文档或设置变化释放旧会话，选择变化不会单独使结果过期。

## 手动联调复现

本机文件可为 `{ "key": "个人 Makers Key" }` 的 JSON，文件名使用 `.local.json`，由现有 Git 忽略规则排除。不要将真实值放进命令或文档。

```powershell
$env:MAKERS_MODELS_KEY_FILE = (Resolve-Path 'matrix.tencent.local.json').Path
node scripts/probe-zhuque.mjs
node scripts/probe-zhuque.mjs --offsets
Remove-Item Env:MAKERS_MODELS_KEY_FILE
```

第一条最多 7 次请求；第二条另外 3 次，包含 128 KiB 样本，会消耗较多额度，不属于日常连接测试。均只发送脚本中固定的合成文字，遇到鉴权、限流、服务或网络失败停止，不自动重试。应用的“测试连接”只执行 1 次固定短样本请求。所有记录和 fixture 均排除密钥与请求头。
