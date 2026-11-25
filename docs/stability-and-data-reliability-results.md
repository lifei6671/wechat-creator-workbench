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

- 当前 CI 将浏览器与 Rust 检查串联在同一桌面 job，浏览器失败会阻止 Rust 检查。
- 文件夹动画测试通过实际 rAF 时刻采样中间高度，在繁忙的 WebKit 上可能错过短动画。
- 实施和验证：待前置任务完成。

## 批次 B

尚未开始。只有批次 A 的适用验证门槛通过后才实施 ST-03、ST-04 和相应故障注入。

## 数据库迁移与兼容性

当前客户端最新迁移为 `0033_wechat_author_options.sql`，服务端为 `0008_asset_validation_scan.sql`。不修改历史迁移，不提升同步协议版本。

## 环境与未执行项目

当前执行环境为 Windows。macOS 原生应用烟雾测试、真实 D1/R2 云资源验证及部署尚未执行；任何后续本地模拟不得替代这些验收。未操作生产工作区或部署。
