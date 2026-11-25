# 稳定性与数据可靠性改造验证记录

实施基线：`dev/markdown-editing-and-animated-images`，`5c8598ac26103f1c442292b3e54775554a8a95f7`。计划文档为 `docs/stability-and-data-reliability-plan.md`，以实际分支源码为准。

## 批次 A

### ST-01 同步契约和异常实体诊断

- 调用链：服务端 `createApp → operation → apply → Database.batch`；客户端 `Remote::hydrate → apply_received → apply_entity → content/assets/canvas apply`。
- 已确认缺口：服务端未校验条目状态、部分可空字段与 URL，客户端会在反序列化或业务校验时拒绝；附件上传校验摘要与大小，但正文附件未校验 UTF-8。
- 新增 `tests/fixtures/sync-contract/entities.json` 的 34 组协议 v2 样本，覆盖全部七类实体。TypeScript 通过真实 SQLite apply 和回执/变更计数验证，Rust 通过真实 `apply_entity` 和事务验证；保留历史缺省值与未知条目扩展字段，并交叉验证 chrono 日期语法和范围。
- 已修正状态枚举、标签与可空字段类型、文章来源/发布链接、自定义属性、素材字段及目录颜色的校验。条目 URL 与画布网页 URL 沿用各自客户端规则，没有统一收紧历史语义。
- 正文附件在实体事务前有界流式校验长度及 UTF-8；摘要继续由既有文件/R2 上传校验负责，二进制图片不套用正文校验。客户端 hydrate 拒绝内联与 blob 并存、孤立大小及错误哈希类型。
- 新增认证后的只读分页诊断 `/v1/sync/diagnostics`，返回实体类型、ID、修订、错误码与字段路径，不返回正文；检查元数据、关联及正文附件。历史操作回执不经过新写入校验，仍可查询与核对。
- 管理员检查/修复步骤见 `docs/sync-data-repair.md`。修复使用正常版本化 push，不直接改历史；原有增量保存点和基线事务保留，新增测试确认失败基线不产生部分实体且保留暂存。
- 复现：最初服务端样本有 15 项失败；错误 UTF-8 附件会被接受；客户端 hydrate 会静默接受双正文模式。修复后的测试已通过。
- `npm test --prefix apps/sync-server`：45 通过、1 跳过；包含 Node HTTP/SQLite/文件及 Workers 本地 D1/R2，相同 HTTP 契约覆盖非法 UTF-8、依赖拒绝、回执和恢复。跳过项为真实隔离云部署。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked sync::contents`：41 通过、6 忽略；忽略项需要隔离服务及系统凭据库。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`：通过。
- 数据库迁移：无；没有修改现有迁移、实体编码、操作摘要格式或协议版本。服务端先部署校验/诊断，客户端随后升级。
- `npm run test:native --prefix apps/sync-server`：1 项通过；隔离本地服务、真实 Rust 客户端与 Windows 凭据库，验证同一连接密钥重装后恢复并继续双向同步。
- 首轮独立评审发现四个契约/诊断缺口，已修复并新增共享反例：素材 kind 数组类型、非正文实体扩展字段、chrono 年份边界、缺失正文/素材 blob 的只读诊断。受影响的共享样本、hydrate 三项测试和 Clippy 重测通过；独立复评 `CHILD_AGENT / FULL_SCOPE` 通过，12/12 文件覆盖，无遗留发现。

### ST-02 初始化失败恢复

- 调用链：`exchange → queue_existing → stage_outbox → prepare_uploads → push_one → reject_outbox`；既有 `sync_issues` 阻止同代次重新入队，dirty 不会被清除。
- 复用边界：冻结 outbox 和 operationId、回执查询、现有保存点与 reconciliation、现有恢复密钥与管理员设备恢复。不得通过删除 dirty 或自动抢占 seed_device 结束初始化。
- ST-01 已独立提交：`cfa5dd7`。
- 基线回归测试实际复现：文件恢复但 SQLite dirty 代次未变化时，`stage_outbox` 仍跳过该素材。
- “立即同步”在现有同步 gate 内校验原图摘要和长度；只移除已验证修复、代次及原因仍匹配、未处于冻结操作中的素材问题。未恢复或恢复了错误文件的素材继续阻塞，不清除 dirty。网络失败保留原 operationId、出站内容及代次，继续使用原指数退避与回执核对。
- 素材得到服务端成功回执后，只放行确实引用该素材且全部素材依赖已有远端修订的失败文稿/卡片。原正文、引用与 dirty 仍保留，待正常上传成功后确认。
- 首次初始化有待处理记录时返回 `SYNC_INITIALIZATION_BLOCKED`，包含聚合的待上传/拒绝数量及具体实体 ID、原因；正常记录仍可先上传。不会把部分成功当作 ready。
- 同步活动接口增加聚合计数和首个阻塞项；用户已批准现有“最近检查”下一行“待上传 N 项 / 需处理 N 项”的最小原型，已用既有 SettingRow 实现。原有“立即同步”用于修复后的重试，无新按钮。既有错误区域显示实体 ID。
- 最近成功交换时间保存在既有 app_settings 的 `sync-last-success` 中，绑定 instance/epoch；应用重启时可读取，仅用于最近检查展示。
- 同原图素材库重新导入时校验既有文件摘要；缺失或确认为损坏的文件通过既有临时文件原子替换，保留原素材 ID。新增真实导入回归先失败再通过；原生双客户端验收现通过实际素材库导入修复损坏文件。重复导入有一次额外本地读取/摘要计算，不影响普通正文保存路径。
- 原生双客户端场景 `initialization_resumes_after_original_repair_and_keeps_other_devices_waiting`：通过。隔离服务下验证缺图阻塞、正常文稿先上传、另一设备等待、原设备凭据丢失后用恢复密钥取回同一身份、恢复原图后完成初始化、正常文稿不重复写入、另一设备实际读到正文和原图。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked sync::`：54 通过、8 忽略；包括缺图/错误文件、依赖修复与断网冻结操作不变。对应的原生场景单独执行通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked assets::tests`：32 项通过，覆盖去重导入、损坏文件修复、图床及缓存、退出和历史工作区升级。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`、`pnpm typecheck`：通过。`pnpm test .../settings.test.tsx .../sync-scheduler.test.ts`：48 项通过，新增统计行先失败再通过。
- 数据库迁移：无；只有可被旧客户端忽略的本地设置键及新增 IPC 返回字段。没有修改 seed_device、同步代际、已发布迁移或回执格式。
- 修复边界：缺失原图且本地、同步服务、图床均无副本时，无法重建图片。可从素材库重新导入相同原图再手动同步；替换为不同图片需要正常编辑对应业务引用。尚未增加批量重新绑定/放弃素材专用界面，不能通过删除 dirty 代替业务修复。
- 首轮独立评审发现同原图重新导入不能覆盖已存在损坏文件，已修复真实入口并重跑原生场景及 Clippy；独立复评 `CHILD_AGENT / FULL_SCOPE` 通过，11/11 文件覆盖，无遗留发现。

### ST-05 CI 和故障注入

- 调用链：原 `desktop` CI job 先执行 Playwright，再执行 Clippy、Rust 测试与 Tauri 构建；浏览器失败会阻止全部后续原生检查。现拆为互不依赖的 `native`、`browser`，各自保留 Windows/macOS 矩阵及 `fail-fast: false`。
- 保留原必需检查名称 `Desktop (macos-latest)`、`Desktop (windows-latest)` 作为汇总门槛。只有两类矩阵全部成功才通过；失败、取消或跳过均不能变绿。浏览器失败 trace 独立保留 7 天。
- 新增 `scripts/stability-ci.test.mjs`：基线两项失败；修改后两项通过。直接执行 YAML 中的汇总命令，验证 success/failure/cancelled/skipped 的全部 16 种组合，避免用另一份实现代替真实门槛。
- 文件夹动画测试原来按实际 rAF 时间采样中间高度；注入 400ms 帧延迟后，WebKit 普通动画的两个目录场景实际失败。改为在一次浏览器调用中暂停并定位真实 CSS transition 的起点、中点，再恢复播放。保留高度插值、收起期间挂载、最终卸载、inert、快速反向操作和减少动态效果断言；未修改产品动画实现。专项 Chromium/WebKit 20 项通过，包含延迟帧、普通/减少动态效果和两个目录视图。
- 前端全量测试最初因本机高并发资源竞争出现 6 个计时失败（563 项通过）；相同断言采用 `--maxWorkers=2` 后 40 个文件、569 项全部通过。将此并发限制写入现有 `pnpm test`，没有延长超时或弱化断言。
- 扩展现有 `npm run test:native --prefix apps/sync-server`，默认逐项运行 8 个真实 Rust 双客户端场景；每项独立临时 SQLite、文件服务及 Windows 系统凭据库身份，结束即清理。支持指定一个既知场景重跑，并保留任一失败的退出码。文章/私图场景首次失败明确为旧测试的手写撤销请求漏发 `X-Sync-Protocol: 2`（HTTP 426），补齐测试请求头后单独重跑通过；其余 7 项通过。
- 8 个场景覆盖领取/加入/重连、文章及私图、画布、已有数据合并、正文 blob 与组回执响应丢失及设备重新登记、仅存设备恢复、同连接密钥重装、缺图中断初始化/其他设备等待/原身份恢复/继续上传。断网冻结操作、非法正文、事务回滚与重复回执继续由现有 Rust/服务端故障测试覆盖，未新建同步协议或恢复框架。

### 批次 A 汇总验证

| 实际执行项目 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test --maxWorkers=2`（与最终脚本有效参数一致） | 40 文件、569 项通过 |
| `pnpm test:release` | 8 通过、2 跳过；跳过依赖 Docker/发布安装包的可选集成环境 |
| `npm test --prefix apps/sync-server` | 45 通过、1 跳过；真实云端另行执行，见下文 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 235 通过、11 忽略；其中 8 项真实客户端场景另行通过，另 3 项为需要 S3 凭据的备份集成及两个手动搜索基准 |
| `pnpm tauri build --debug --no-bundle`（包含 `pnpm web:build`） | Windows 构建通过 |
| `pnpm test:browser` | Chromium/WebKit 全量 368 项通过，13.0 分钟；含 400ms 延迟帧回归 |
| Windows Tauri/WebView2 烟雾测试 | 通过；独立应用标识及全新工作区，真实 UI 新建/输入/失焦保存、正常退出、重启后通过 UI 与 IPC 核对正文及版本。未替换生产工作区或运行生产实例 |
| 真实隔离 Workers/D1/R2 合约 | 通过；当前服务端源码及全部 8 项既有迁移，在临时数据库和私有桶执行 HTTP 合约，包括大附件、摘要、非法 UTF-8、回执、设备恢复与画布 |

真实云端测试资源使用统一前缀 `wcb-stability-1125-01a211ae`，测试后 Worker、对象、R2 桶及 D1 数据库均已删除并确认成功；没有访问生产工作区或修改正式部署。验证产生的临时配置、资源清单和烟雾测试记录位于被忽略的 `output/stability/`，截图位于 `output/playwright/`，不包含真实凭据。

界面变更仅为已批准的统计行及既有错误区：`待上传 N 项` 帮助用户判断剩余上传进度；`需处理 N 项` 指出阻塞数量；错误区增加实体类型/ID 以便定位修复。继续使用既有“立即同步”和素材库重新导入入口，没有新增按钮、Toast 或成功弹窗。

ST-05 独立代码评审 `CHILD_AGENT / FULL_SCOPE` 覆盖 8/8 文件，边界整合覆盖三个分区共 26 个交付文件，未发现代码阻塞项。完整浏览器结果已纳入最终冻结核对；代码评审通过不替代平台和 CI 验收。

## 批次 B

本轮已实施 ST-03、ST-04，具体实现、验证及平台缺口见下方“下一阶段稳定性改造”记录。

## 数据库迁移与兼容性

当前客户端最新迁移为 `0037_asset_lifecycle.sql`，本轮依序追加 0034–0037；服务端仍为 `0008_asset_validation_scan.sql`。不修改历史迁移，不提升同步协议版本。

## 环境与未执行项目

当前执行环境为 Windows。真实 D1/R2 隔离验证与 Windows 原生烟雾测试已完成；macOS 远程连接器返回工具服务器不可用，尚未执行 macOS 原生构建/烟雾测试。Playwright WebKit 与模拟 MacIntel 的测试不能替代实际 WKWebView。

Windows 隔离测试应用已正常退出，临时应用标识仅用于验证，未写入正式配置；构建目录已恢复正常应用配置。工具策略拒绝删除本次创建的 `%LOCALAPPDATA%/io.github.lifei6671.wechat-creator-workbench.stability-01a211ae`，仅返回 `blocked by policy`，因此保留该独立测试目录。

当前修改尚未推送或触发本次 GitHub CI。macOS 原生验收仍有环境缺口，本轮实现和实际验证见下方记录；不以浏览器 WebKit 代替 WKWebView。现有备份 S3 集成及搜索基准的忽略项没有被伪报为通过。

前轮批次 A 的回退与部署：不包含数据库迁移，可以回退相应代码提交；新增设置键及 IPC 字段不要求旧客户端迁移。服务端应先保留数据库和对象存储一致的恢复点，再部署向后兼容的校验/诊断，随后升级客户端。没有实际执行生产备份、升级或回退演练。


## 下一阶段稳定性改造（2026-11-25）

本轮起点：`45d9ea73f56d15d99d24b8f924f066792636381a`，分支 `dev/markdown-editing-and-animated-images`。开始时只有用户提供的未跟踪方案文档，不纳入本轮提交。以下记录补充上述批次 A 结果；本轮明确授权继续批次 B，原 macOS 验收缺口继续保留。

### R-01 异常基线重新获取

- 根因与调用链：`exchange` 遇到非空 `bootstrap_cursor` 直接返回；`apply_received_with_backup → apply_received_transaction → apply_baseline/reconcile/merge` 失败会回滚整个应用事务，旧暂存仍被视为正常待应用数据。
- 方案：追加客户端迁移 `0034_sync_baseline_failure.sql`，在 `sync_progress` 保存失败游标及原始错误原因。应用失败后在独立事务记录；暂停、首次合并缺少备份、历史不一致及退出错误沿用既有恢复规则。自动调度仍等待完整基线应用；手动交换遇到失败标记时复用 `download_baseline` 重新下载。完整下载成功才清除失败标记，中途失败仍能重试。连接身份变化及显式采用基线同步清理标记。
- 涉及文件：上述同步核心、`sync.rs` 重新连接、`db.rs` 迁移注册、`contents/contract_tests.rs`、`contents/initialization_tests.rs`、服务端隔离原生测试夹具。
- 保留边界：下载只替换基线暂存，不清空正文、dirty、outbox 或冲突；仍使用原组级协调和原子应用事务。协议与服务端迁移不变。旧客户端不认识新增字段；回退不手工降低数据库版本，应使用迁移前快照与兼容客户端。
- 回归：真实临时 Node/SQLite 服务注入历史非法条目状态，新客户端应用失败且没有部分写入；管理员正常条件 push 产生 revision 2；客户端重启后重新下载更高游标并成功初始化，正文和修订均核对。测试注入入口只存在于本地测试夹具，不进入服务端产品代码。
- 复现结果：修复前端到端测试在“新游标必须大于失败游标”断言失败；修复后通过。现有失败基线回滚测试增加了失败游标及原因持久化断言。
- 验证：`npm run test:native --prefix apps/sync-server -- failed_legacy_baseline_refetches_after_versioned_admin_repair` 通过（1 项）。`cargo test --manifest-path src-tauri/Cargo.toml --locked sync::contents`：44 通过、8 忽略（其中本项端到端用例已单独执行通过）；`cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` 通过。独立复审 `CHILD_AGENT / FULL_SCOPE / Tier 3` 覆盖 8/8 文件，通过，无阻塞发现；额外检查了 UI 手动入口、自动调度、冻结队列协调及首次合并边界。
- 部署：客户端启动自动追加本地迁移，无需修改服务端部署；修复云端实体后使用现有“立即同步”。没有新增界面元素或文案。
- 平台边界：本项真实客户端测试在 Windows 执行；macOS、真实隔离云端在最终整体验证中另行记录，未由本地测试代替。


### R-02 多级同步依赖恢复

- 根因：旧 `retry_asset_dependents` 只检查成功素材直接引用的条目/卡片，成功的来源条目、专题和卡片回执不会唤醒后续引用条目、专题节点与连线；局部恢复还可能提前放行存在其他缺失依赖的实体。
- 调用链：`apply_outcome → dependencies::retry → retry_group → group_ready`；手动修复重试经 `retry_repaired_assets → retry_blocked`，仍复用 `stage_outbox/prepare_uploads`。成功回执清理不晚于冻结代次的旧本地拒绝；较新代次的问题和真实云端版本冲突保留。
- 方案：按既有业务引用关系定位受影响的当前阻塞项，再扩展到原子 batch；核对整组全部依赖，组内一起提交的实体作为 proposed 状态参与校验。只移除当前代次且没有 remote_json 的依赖问题，不变更正文、dirty generation、批次或冻结操作。`stage_outbox` 也会等待组内仍阻塞的其他成员。
- 依赖语义对应服务端现有 SQL 视图：素材与来源条目要求远端实体存在；目录、专题及连线端点要求有效；目录父项为根目录、连线端点属于同一专题。`blob_missing` 显式重试走既有 HEAD/上传流程，每次手动触发最多重新入队一次，仍保留真实上传失败，不设置后台无界重试。
- 迁移：追加 `0035_sync_issue_codes.sql`，为 sync_issues 增加可空稳定错误码和部分索引；历史中文及原始错误码继续兼容。界面继续展示原有 reason，无新增可见元素。没有修改服务端协议、模型或已发布迁移。恢复检查只在成功回执或手动重试时执行，查询当前阻塞项及其实际关联，不扫描全工作区正文。
- 源码：`src-tauri/src/sync/contents.rs`、新增 `contents/dependencies.rs`、`db.rs` 及新迁移；回归在 `contents/initialization_tests.rs` 和原生服务夹具。
- 复现：真实临时双客户端测试修复两个素材后，旧代码仍剩 4 项拒绝（引用条目、两个专题节点和连线），无法 finish。新代码通过；仅修复第一个素材时，来源条目和引用条目保持阻塞；全部修复后逐级上传、第二客户端读取关联、画布连线和实际图片，素材远端 revision 保持 1，无重复写入。
- 其他回归：原子组部分依赖缺失、目录已删除、真实版本冲突、冻结出站操作、历史 blob 错误及 generation 保持；保留原有素材部分依赖测试。
- 验证：专项真实双客户端用例通过；首轮 `cargo test --manifest-path src-tauri/Cargo.toml --locked sync::contents` 46 通过、9 忽略；最终组门槛专项 47 通过、9 忽略；独立复审发现并修复了历史中文 blob 记录无法重试和组内编辑修复仍卡住的两项恢复缺口，增加针对回归后 3 项通过，Clippy 重测通过。`CHILD_AGENT / FULL_SCOPE / Tier 3` 复评覆盖 7/7 文件通过，无遗留阻塞项。部署时客户端自动追加迁移；不降低 schema 版本回退，以迁移前快照和兼容客户端恢复。Windows 已执行，macOS 与真实云端留待最终验收。


### R-03 同步附件实际对象诊断

- 根因与调用链：`GET /v1/sync/diagnostics → diagnoseEntities` 过去只查 sync_blobs 索引；素材二进制不进入正文校验，因此文件/R2 对象删除后仍报告无问题。
- 方案：BlobStore 增加只读 `head`，R2 适配器调用官方元数据 API，本地适配器调用 `stat`；诊断比较 payload 大小、索引大小与实际对象大小。继续使用原分页，每页最多 100 项；图片不调用 get，不下载正文外的图片数据。正文原有有界 UTF-8 流式检查保持原样，没有实施长正文重复读取优化。
- 错误分类：原 `blob_missing` 保留为索引缺失；`blob_object_missing`、`blob_object_size_mismatch`、`blob_storage_unavailable` 分别表示对象缺失、实际大小不符、元数据存储暂时不可用；原 `blob_length_mismatch` 仍表示索引与实体声明不符。存储异常只转换为稳定错误码，不返回内部异常、正文、令牌或凭据。
- 文件：`apps/sync-server/src/diagnostics.ts`、`storage.ts`、`adapters/local-files.ts`、`adapters/r2.ts`，新增 `tests/attachment-diagnostics.test.mjs`，扩展 HTTP 合约和本地 Workers 测试；管理员说明同步更新。无数据库迁移或同步写入协议变化。
- 先红后绿：三个专项回归原均失败（对象缺失被报告为正常，存储失败页无问题），实现后全部通过。真实本地文件覆盖写入、删除和截断；R2 适配器测试确保只 head、从不 get，并检查暂时失败和脱敏。101 个实体覆盖分页和逐项错误，核对数据库实体/身份/回执没有变化。
- `npm test --prefix apps/sync-server`：最终 50 通过、1 跳过。包含真实 Node HTTP/SQLite/文件合约，以及运行中的 Workers 本地 D1/R2：通过 wrangler 实际删除和以短文件替换 R2 对象后，HTTP 诊断分别返回对象缺失与大小不符。跳过项为真实云端，最终隔离环境另行执行。Wrangler 提示现有 observability.issue_detection 未识别，不影响测试结果。
- 独立复审发现正文附件在元数据成功后 get/流读取失败会中断整页并记录原异常，补充两条先失败再通过的回归；`content-blobs.ts` 仅在 get/read/cancel 存储边界转换为脱敏 503 稳定错误，数据库与 UTF-8/长度错误保留。`CHILD_AGENT / FULL_SCOPE / Tier 3` 复评覆盖 10/10 文件通过，无遗留发现。部署无迁移，保留原生产数据库和对象存储恢复点后升级同步服务即可；诊断只读，不自动删除或覆盖对象。真实远端 R2 与 macOS 在最终验证中单列，未由适配器模拟代替。


### ST-03 编辑器异常退出恢复

- 根因与调用链：原 SaveQueue 只有内存快照及正式保存防抖，连续编辑、保存失败和版本冲突后的内容无法跨进程恢复。现为 `Milkdown/source/AI → SaveQueue.capture → recoveryPut → Workspace.put_editor_recovery`，正式提交经 `save_entry_with_recovery → save_in_transaction → recovery::acknowledge`，启动经 `recoveryList → EditorRecovery → restore_editor_recovery`。
- 迁移：追加 `0036_editor_recovery.sql`，本地表按 entry_id/session_id 隔离会话，保存完整可编辑字段、基础版本、本地修订及已确认水位；没有外键级联删除，不加入同步触发器或协议。与方案的单 entry 主键相比，独立会话行能同时保留属性、画布文章和新进程会话，旧会话请求无法覆盖新会话草稿。
- 顺序保证：跨进程 UUID 与既有 AI 内存 numeric sessionId 各司其职。put 只接受更高本地修订；正式保存同事务确认对应 session/revision，新草稿仍保留，自己提交后提高基础版本；空字段行保留确认水位，阻止保存成功后晚到 put 复活已保存草稿。应用启动在 IPC/后台写入启动前清理已完成行和与正式字段完全相同的草稿；未处理稿保留，不自动覆盖。
- 调度：独立 750ms 恢复定时器不因连续输入重置，也不因正式保存冲突停用；恢复和正式保存复用按本地修订缓存的 Markdown 序列化结果。保存失败立即再持久化快照；恢复失败进入原保存错误区域，不阻止后续正常正式提交。源码切换、AI 替换、属性和画布中的文章编辑接入同一队列。原正式保存 750ms 防抖/4秒最大调度维持原语义。
- 恢复：启动显示已批准的最小比较窗口；仅基础版本相同且原文档未删除时允许恢复，最终事务仍检查版本。版本变化或原文档不存在时可另存草稿，原正式内容保持不变；另存和相应草稿确认也在同一事务。关闭保留记录，下次启动再发现。
- 文件：`content/recovery.rs`、`content.rs`、`commands.rs`、`main.rs`、`db.rs`、`build.rs`、desktop capability、共享 IPC 类型；前端 `save-queue.ts`、`desktop.ts`、`DesktopShell.tsx`、`CollectionCanvas.tsx`、`Document.tsx`、`EditorRecovery.tsx` 及局部 CSS、相关测试/浏览器夹具。
- 先红后绿：3个前端复现原均不调用恢复持久化；新增恢复后通过。Rust 5项覆盖乱序、晚到草稿、跨会话、旧保存/新草稿、正式保存冲突、恢复确认写入失败回滚和删除后重启另存。前端4项与原保存队列8项通过；UI2项通过，覆盖版本保护、真正请求结束和1秒反馈。Chromium/WebKit 新恢复窗口回归4项通过，包含标题/关闭按钮对齐、两栏比较和 pending spinner。
- 原工作区122项回归中，初次11项仅因保存 IPC 新增第5参数失败，保留原断言并补会话/修订契约后121项通过、1项在并行构建负载下超时；同一超时用例单独重跑通过，没有增加超时或修改行为断言。最终全量在本轮总体验证记录中补充。专项 TypeScript 检查与 Clippy 已通过，最终增量仍须纳入整体验证。
- 独立复审 `CHILD_AGENT / FULL_SCOPE / Tier 3`：发现并修复未编辑文档手动保存携带 revision0 导致事务回滚、恢复按钮缺少可见 pending 状态；新增针对回归先失败再通过。真实原生验收发现命令权限注册缺口并补全，复评及增量复核累计覆盖24/24文件通过；新增启动清理/旧丢弃回归同样通过。
- 实际 Windows WebView2：使用独立应用标识 `io.github.lifei6671.wechat-creator-workbench.stability-01a212aa` 和全新工作区。连续输入时恢复稿在772ms落库，正式正文仍为空；强制结束测试进程后重启，真实窗口发现草稿并通过按钮恢复，正文及版本核对通过。1,060,000字节正文实测874ms落库，再注入独立正式更新后强退重启，覆盖按钮禁用，另存草稿完整保留长正文，正式正文保持更新结果。数据是本机两次观测，不是跨平台时延保证。
- 原生构建：早期默认输出路径因用户运行中的exe占用而复制失败，未终止该进程。最终使用任务专属CARGO_TARGET_DIR完成隔离配置及正常配置两次完整构建，命令均退出0；正常配置产物没有启动。原生恢复截图为头部对齐修复前版本，最终对齐由两引擎浏览器断言验证；截图/时延记录在忽略目录 `output/playwright/recovery-native-dialog.png`、`output/stability/recovery-smoke-result.json`。隔离测试应用正常退出，内容验收已在退出前完成。
- 可见元素清单：标题“恢复未保存内容”定位当前任务；草稿标题及恢复时间用于识别记录；“当前文档/恢复内容”两栏支持比较；“关闭”保留选择到下次启动；“放弃”移除所选稿；“另存草稿”在版本变化/删除后保留内容；“恢复到原文档”只在基础版本匹配时执行。按钮处理/结果状态及固定错误区域帮助判断操作结果。用户已于本轮明确批准此原型，无新增 Toast 或解释性文案。
- 部署与恢复：客户端自动追加本地迁移，无服务端部署要求；数据库快照内的恢复稿只供人工选择。不得手工降低 schema；回退使用迁移前快照与兼容客户端。macOS 原生强退和 WKWebView 尚未验证，真实同步冲突仍由后端版本冲突回归覆盖，未伪称原生双设备强退验收。


### ST-04 素材生命周期与备份恢复

- 复现：新增“无引用原图先等待七天、只有冻结写入才删除”的测试，在旧实现实际因立即删文件而失败。现清理将无引用与删除分离，不以关闭应用作为立即删除的理由。
- 方案与事务：追加 `0037_asset_lifecycle.sql` 保存按哈希的候选时间、公共图片保护及备份清单/引用。候选重新被引用时取消；物理删除只在 Cleaning 阶段执行，`Workspace.cleanup_assets` 持有同一工作区互斥锁完成最终引用/宽限期检查、文件删除和数据库提交，阻止恢复写入或取消退出并发穿过删除窗口。失败保留候选及失败任务，后续可安全重试。
- 保护范围：当前正文、历史修订和回收站原文、专题图片/文本、恢复草稿、冻结 outbox、待应用/冲突快照、dirty/已同步素材、保留标记及备份哈希。Markdown/HTML/派生素材继续使用现有引用解析器；有清理候选时才在重新引用写入路径追加取消检查。不存在于素材索引中的原始文件保守保留，只回收可再生成的孤立缩略图缓存。
- 远端边界：没有全部设备、历史备份及外部发布引用的全局证据，因此不再自动删除远端图床对象或其本地原图。新公共保护表对历史位置记录保守回填，之后新增位置记录也建立长期保护；用户删除文章不会解除已发布图片保护。不再发出远端删除请求，因此网络删除超时或另一个设备仍引用不会造成这次清理丢图。
- 备份：快照创建前先登记本地保护，实际 SQLite 快照完成后读取其中的素材哈希并固化精确清单，然后才上传快照。上传未确认的清单保留；只有真实远端列表确认的备份过期才移除其清单。旧备份没有清单或目标历史无法确认时保守保护本地素材，不能凭本机缓存推断远端安全。清单用于本地文件保护；本轮没有跨设备远端物理回收协议。
- 完整性：新增只读 `asset_integrity`，本地文件按实际大小和现有流式 SHA-256 校验；报告本地可用、待从同步/图床恢复、文件缺失、校验失败及引用条目/专题。缺少索引的 asset:// 引用也能定位。恢复入口复用同步下载、图床读取和原子缓存，验证原图摘要/大小后才替换；不因图片缺失回滚已恢复的数据库。
- 能力区别：数据库快照只保存数据库和恢复稿，不包含图片文件；从未上传且本地已经丢失的原图无法恢复。经过压缩、摘要不同的图床副本不能冒充原图。完整工作区导入导出对实际打包的原图校验哈希，沿用现有格式及恢复流程。现有导出会跳过已有图床位置但本地原图不存在的文件；仅有压缩图床副本时，不能承诺完整恢复原图。
- 文件：assets 的 cleanup/references/sync/mod、新增 integrity；backup/store/migration、新增 retention；db、恢复稿和专题引用写入边界、新迁移、Tauri注册/权限；现有备份页、素材完整性窗口及IPC类型。没有修改同步协议或已发布迁移。
- 测试：宽限期、冻结写入、重新引用恢复草稿取消旧计划、实际本地删除失败后重试、历史/共享哈希和公共多设备对象保护；历史数据库快照缺图/损坏定位；备份未知历史及在途上传保护。原先验证“立即远端删除”的三个私有单测按本轮明确退役的自动远端删除策略替换为保留本地/远端位置证据检查；原有正文、共享文件和引用断言保留，立即本地删除断言移到七天及冻结后执行，没有跳过失败用例。
- 已批准界面元素：备份页“素材完整性/检查素材”提供检查入口；窗口标题定位任务；“图片名/状态/引用文档/操作”帮助定位具体对象及关联内容；“恢复”仅在存在已知来源时可用，结果以真实下载和校验为准；“重新检查”刷新磁盘状态；“关闭”退出窗口。沿用固定错误区、按钮spinner及1秒结果反馈，无额外成功Toast。
- 专项验证：素材模块47项、备份模块14项通过（原S3真实服务1项忽略）；素材完整性UI2项通过。备份恢复回归使用实际SQLite快照并核对完整哈希集合，覆盖未知历史、在途上传、切换备份目标和同名历史清单。完整工作区导入导出既有回归继续通过。真实双客户端测试实际损坏第二端图片缓存，恢复后字节核对一致，dirty数量保持不变；relative_path是现有同步触发器排除的本地缓存字段。
- 完整Rust回归初次发现两个旧迁移夹具把最新数据库伪装成旧user_version，新增表导致重复建表失败。改为通过测试专用legacy_database实际迁移到v30/v32再填历史数据，保留原迁移和所有业务断言，没有修改已发布迁移。
- 独立复审 `CHILD_AGENT / FULL_SCOPE / Tier 3` 覆盖29/29路径。发现并修复：备份目标切换后的清单作用域错配、远端列表与新上传竞争、恢复快照中的继承清单不完整；分别固定Store捕获的目标、复用现有prepared锁串行化列表/上传、从实际恢复库重新构建自身快照清单并将其他继承记录标记未验证。修复后复评通过，无P0/P1遗留。最终五分区集成复审及属性焦点、取消竞态增量共覆盖64/64交付路径通过。
- Windows WebView2：以相同任务独立应用标识运行最新完整构建，通过真实“数据库备份 → 检查素材”入口核对本地可用及引用文章；仅删除隔离工作区测试图片，重新检查定位文件缺失且无来源恢复按钮禁用，重新导入相同原图修复后核对状态。UI、IPC权限及正常退出通过，截图为 `output/playwright/integrity-native-dialog.png`。
- Windows/真实云端及macOS差异在最终验证中单列。部署只需客户端追加本地迁移，无服务端迁移；升级前保留数据库和原图恢复点，禁止手动降低schema，使用迁移前完整工作区恢复。


### 组合回归：素材重导入后的旧问题清理

完整真实客户端套件复现原有 `initialization_resumes_after_original_repair_and_keeps_other_devices_waiting`：原图修复成功后，问题数仍为1，预期为0。R-02的回执清理只匹配冻结generation，而重新导入原图已提高dirty generation，旧本地拒绝未被删除。修正 `apply_outcome` 为清理不晚于本次冻结代次且没有remote_json的本地拒绝，并显式保留稳定错误码及历史中文版本冲突；较新代次仍保留。

新增回归覆盖旧本地拒绝、更新的本地拒绝和真实版本冲突三种情况；原失败端到端断言及全部10项真实客户端套件随后通过。此次组合修复独立提交，不修改任何既有有效断言。最终Rust全量252通过、13项需特定环境或手动执行的忽略；Clippy通过。独立集成复审及两次界面修复增量共覆盖64/64交付路径，无遗留P0/P1。

### 组合回归：属性菜单关闭后的焦点回抢

完整浏览器首轮431通过、WebKit斜体标记初始点击稳定性等待超时1项；未修改该用例，同组4项单独重跑通过。第二轮仍为431通过，但失败变为Chromium属性链接保存；首轮WebKit用例已在完整运行中通过。检查第二轮保留的trace，实际保存的平台名称为“我的站点https://example.com/article”，链接为空，证实输入进入了错误的控件，不能以增加等待或修改预期掩盖。

`PropertiesForm`新增属性菜单的`onCloseAutoFocus`在菜单退出后再通过requestAnimationFrame聚焦平台名，延迟回调会抢走用户已移动到链接框的焦点。新增可控动画帧回归先在旧代码稳定失败；修复移除多余延迟，只有当前焦点仍在body或“添加属性”触发器时才聚焦新字段。既有键盘新增聚焦、属性保存、错误保留和版本冲突断言维持不变，没有新增可见元素或改变产品交互。

`properties-autosave.test.tsx`与`properties.test.tsx`共14项通过；原浏览器属性用例在Chromium/WebKit各重复3次，共12项通过。独立增量复审2/2路径通过，总交付覆盖扩为63路径，无遗留发现；最终完整浏览器和构建结果见下表。

### 组合回归：取消确认后的破坏性动作

第三轮完整浏览器431项通过，WebKit原有“退出期间不能激活已取消的破坏操作”失败：Escape后已有inert属性，但随后的Enter仍触发一次empty_trash。Confirm在退出动画中保留DOM，确认回调只检查按钮反馈状态，没有检查已关闭的dialogOpen。

先新增确定性浏览器回归：仅在测试中延长退出动画，取消后派发队列中残留的点击，旧代码实际触发1次、预期0次。修复复用dialogOpen，在关闭阶段禁用确认按钮并在动作边界拒绝执行，不增加独立状态。原键盘取消断言保持不变，新旧用例在Chromium/WebKit各重复3次，共12项通过。独立增量复审通过，总覆盖64个交付路径。最新Windows WebView2隔离应用实际创建并回收测试文章，执行“清空回收站 → Escape → Enter”后核对文章仍在回收站且正文完整，再恢复测试文章，验证通过；原生结果记录为output/stability/confirm-native-result.json。最终完整浏览器结果见下表。

### 本轮最终验证与环境边界

| 命令或环境 | 实际结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 最终44个文件、627项通过（含新增焦点回归） |
| `pnpm test:release` | 8项通过、2项既有可选环境检查跳过 |
| `pnpm test:browser` | 最终Chromium/WebKit共434项通过、0失败，14.5分钟；包含新增取消队列事件回归 |
| `pnpm web:build` | 通过，由最终Tauri构建的beforeBuildCommand实际执行 |
| `npm test --prefix apps/sync-server` | 50通过、1项真实远端环境测试跳过；本轮真实隔离远端另行执行通过 |
| `npm run test:native --prefix apps/sync-server` | 修复组合缺陷后10/10通过，包含新R-01、R-02及缓存损坏恢复 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 252通过、13项需特定环境或手动执行的忽略；其中10项原生同步用例已由真实客户端专项执行通过 |
| `pnpm tauri build --debug --no-bundle` | 通过；仅指定任务专属CARGO_TARGET_DIR以避开用户正在运行的默认exe，无产品配置修改 |
| Windows WebView2 | 隔离应用真实强退/重启恢复、长正文版本保护另存、素材完整性窗口、文件丢失/重导入修复及取消破坏操作通过 |
| 隔离 Workers/D1/R2 | 当前源码及服务端8项迁移的真实HTTP合约通过；实际删除R2对象及替换错误大小对象后诊断正确 |
| macOS WKWebView | 未执行；连接器尚未建立可执行的Mac连接。用户明确要求本轮停止Mac尝试，由用户后续在Mac实机验收；没有以WebKit或Windows替代WKWebView |

Rust其余3项忽略为既有S3真实服务集成及两项手动搜索基准，未伪称通过。构建保留既有Vite拆包/动态导入提示及Windows链接器输出提示，没有降低编译或测试标准。

真实云端临时资源统一命名 `wcb-stability-1125-01a212aa`，仅使用新建测试D1和私有R2桶。测试后Worker、全部测试对象、R2桶及D1均已删除，资源清单确认cleanupComplete=true。没有对生产服务或生产工作区进行故障注入，没有发布生产版本，没有推送或触发GitHub CI。运行中的原有Windows应用没有停止或覆盖；隔离烟雾应用已正常退出。

最终构建使用 `output/stability/native-target-01a212aa`，缓存目录复用既有编译缓存，顶层exe单独输出；先构建隔离应用进行验收，再以正常配置重新构建，正常配置产物没有启动。验证日志、资源清单及截图保留于忽略的output目录，产品配置没有临时应用标识或测试入口。

五项实现均已独立分区审查，并完成覆盖事务、幂等、错误恢复、历史兼容、同步代次/操作组和性能边界的组合复审。独立审查采用CHILD_AGENT / PARTITIONED_PLUS_INTEGRATION，覆盖64/64交付路径，无遗留P0/P1；Review gate=PASSED，Coverage=COMPLETE，代码状态与最终验证保持一致；用户已明确将macOS原生验收留待后续自行执行，本轮不宣称完整跨平台验收通过。ST-06、ST-07、ST-08未扩展到本轮。

### 后续回归：编辑态主题与网页 GIF 粘贴

- 编辑态主题根因：`26a4b3e` 统一正文样式时移除了 `DocumentEditor` 的主题绑定和投影样式，主题选择只影响导出。恢复 `fields.themeId → wechatEditorStyles → document-editor CSS variables` 调用链，复用既有渲染器投影及 Radix 色板；只改变外观，不重建编辑器或修改 Markdown。编辑、阅读和锁定状态共用此路径。
- 代码涉及 `Document.tsx`、`styles/article.css`、`packages/wechat-renderer/index.ts`；回归涉及 `editor-spacing.test.tsx`、`document.test.tsx` 和 `tests/browser/article-typography.spec.ts`。无迁移、同步协议、依赖或产品配置变更。旧测试中“编辑态与排版主题独立”的断言按恢复主题行为更新，原正文不变、编辑器不重建、撤销、表格编辑及选择保持断言继续保留。
- 先红后绿：新增编辑态装饰回归在旧实现的单测及 Chromium/WebKit 中均失败；恢复投影后通过。独立复审发现深色表头对比度不足，新增实际颜色对比测试先失败（3.68），随后将编辑投影表头改为继承文字颜色及 Radix 浅背景，链接使用对应色板 step 12；微信导出 HTML 样式不变。
- 可见区域：标题/段落体现已有主题的字体和间距；引用/列表体现已有层次；代码块/表格体现已有背景及装饰；链接保留可辨识的颜色。上述元素用于在编辑时识别所选主题，没有新增控件、标签、提示或交互。
- GIF 来源为 `https://github.com/webadderallorg/Recordly/blob/main/docs/media/feature2.gif`。Windows Edge 实际右键“复制图像”得到 HTML 剪贴板，其中图片地址带 `?raw=true`。隔离原生 WebView2 应用使用真实粘贴链路及本地 HTTP S3 测试存储，自动产生一次 PUT，并将正文图片地址替换为上传后的地址；7015332 字节、`image/gif`，SHA-256 为 `33f4a2e9dc1c5ad4e3f2f2d70e293bdfc5e7e2f75cb5279d2a9ddc73b6f4075b`，与原始 GIF 完全一致，未丢失动画数据。结果见 `output/stability/gif-native-result.json`。
- 此次没有复现 GIF 未自动上传，因此没有修改粘贴或上传实现。另一次独立请求 GitHub 的 `?raw=true` 地址遇到 HTTP 503，直接 raw.githubusercontent.com 地址成功；这仅证明源站请求可能失败，不能确定为用户当次失败原因。没有增加未经验证的重试或地址改写。生产工作区仅只读核对素材/上传状态，故障与粘贴测试均使用隔离工作区和测试存储；临时原生应用及 HTTP 服务已退出，原浏览器标签和剪贴板状态已恢复。
- 实际验证：`pnpm typecheck` 通过；`pnpm test` 最终 44 文件、627 项通过；主题专项单测 101 项通过；`pnpm exec playwright test tests/browser/article-typography.spec.ts --workers=2` 在 Chromium/WebKit 共 16 项通过；`pnpm tauri build --debug --no-bundle` 正常配置构建通过，其中实际执行 `pnpm web:build`。构建沿用任务专属 `CARGO_TARGET_DIR`，没有停止或覆盖用户正在运行的原应用。服务端及 Rust 业务代码未修改，相关既有全量结果见前表，本次没有重复执行。
- 部署：使用正常配置新客户端构建即可，无数据库或服务端部署步骤。Windows 原生 GIF 链路已实测；macOS WKWebView 按用户要求留待其自行验收，WebKit 浏览器通过不代表 Mac 原生验收完成。
- 独立复审：`CHILD_AGENT / FULL_SCOPE / Tier 2` 覆盖本次 7/7 路径，表头对比度 P2 已修复，未遗留发现或 P0/P1；Review gate=PASSED、Coverage=COMPLETE、Freshness=FRESH。复审确认主题切换不影响正文/编辑器状态，浅深色对比回归、原有效测试保护和 GIF 未复现的事实表述一致。
