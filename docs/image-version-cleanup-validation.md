# 图片旧版本自动清理验收记录

日期：2026-11-28。测试环境为 Windows；所有删除使用独立临时工作区、本进程测试存储或 Wrangler 本地绑定。未部署生产服务，未删除生产图床对象，也未替换当前运行的桌面程序。

## 已执行检查

| 检查 | 结果 |
| --- | --- |
| Rust 完整测试 | 308 通过，0 失败，21 项需要外部环境的测试默认忽略 |
| Clippy | `--all-targets -- -D warnings` 通过 |
| 服务端完整测试 | 77 通过，0 失败，1 项真实远程部署验收未执行 |
| GC 服务端专项 | 21 项通过，含原生 SQLite、代际恢复、引用 fence、到期互斥、S3 编码字节及权限变更 |
| Workers D1/R2 | Wrangler 本地绑定通过私有删除/恢复/到期和公开编码备份/恢复/到期；包含迁移和事务 SQL |
| 界面 | 9 项相关测试及 TypeScript 类型检查通过；Web 构建完成 |
| Windows 构建 | 使用 `tauri/custom-protocol` 构建独立调试程序，嵌入本次 Web 产物 |
| 布局 | Chromium 1100×760、600×640，检查标签页、位置文字、恢复反馈和无确认清理流程 |

完整 Rust 默认忽略的测试不等于已经逐项执行。另用隔离 HTTP 服务、临时 SQLite/文件存储、系统凭据及真实 AWS S3 SDK 执行了以下原生流程：

1. `automatic_private_cleanup_between_devices_restores_an_offline_pending_reference`：两设备检查、持久屏障、离线新增旧图引用、另一设备回收、恢复新代际后提交并读取。
2. `managed_s3_remote_retirement_converges_before_another_device_exports`：B 先知道 live 副本，A 回收，B 导入退休状态后恢复相同编码字节到新 key，再保护和输出新地址；A 获取替代关系；保留首项不阻塞后续到期；暂停重建先获取生命周期，闲置到期缓存不再强制下载。
3. `managed_s3_cleanup_restores_an_inflight_generation_before_external_delivery`：503 后重试保持托管身份；编码内容改变使用新 key；删除请求在途时恢复及输出；合法保留不阻塞后续副本到期；已经领取的本地到期任务不被后续保留标记永久卡住。
4. `image_canvas_projects_renders_and_private_inputs_between_workspaces`：既有工程、原图、成品及暂停重建回归。

迁移回归还覆盖：云端退休但本机草稿仍引用时，导出/导入保留真实 raw；旧素材大小为空仍可恢复；首次未知备份不要求重新生成已到期闲置历史；回收实际字节随迁移包保留。

## 验收边界

- S3 原生流程使用本进程对象服务模拟条件、归属 metadata、故障及在途删除；不是对所有 S3 提供者的实测。
- D1/R2 是本地绑定，不是生产 Worker 或真实生产桶。
- 未在 macOS 原生运行本轮变更；共享 Rust、协议和界面已完成静态与自动检查。
- 未在真实公众号编辑器粘贴或发布文章，未写入用户剪贴板。本轮验证了交付函数前的保护、字节恢复与最终地址，OS 写入顺序由代码检查覆盖。
- Windows 新构建未自动启动，当前程序及其编辑状态保持原样。云端启用需要升级服务端和所有有效设备，不以单机测试代替生产升级。

规则及升级边界见[实施说明](./image-version-cleanup-implementation.md)。
