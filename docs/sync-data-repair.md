# 同步数据检查与修复

先备份服务端数据库与对象存储。下列接口需要当前工作区的有效设备认证，以及正常同步使用的 `X-Sync-Protocol: 2`、`X-Sync-Instance`、`X-Sync-Epoch` 请求头。

## 只读检查

`GET /v1/sync/diagnostics` 每页检查最多 100 个实体，返回 `checked`、`issues` 和 `nextAfter`。按 `nextAfter.entityType`、`nextAfter.entityId` 分别传入下一页的 `afterType`、`afterId`，直到 `nextAfter` 为 null。

问题包含实体类型、ID、远端修订号、稳定错误码及可定位的字段路径；不返回正文或凭据。检查不会更改实体、回执、游标或初始化归属。附件先检查数据库索引，再使用 R2 `head` 或本地文件元数据核对对象存在性和大小，不下载完整图片。`blob_missing` 表示索引缺失，`blob_object_missing` 表示实际对象缺失，`blob_object_size_mismatch` 表示对象大小与索引不符，`blob_storage_unavailable` 表示存储查询暂时失败；后者不应作为对象丢失处理。正文附件仍以流式方式检查长度与 UTF-8，摘要由附件上传流程验证。检查不是数据库快照，并发编辑期间可在写入停止后重新检查。

## 修复实体

使用 `GET /v1/sync/entities/:type/:id` 读取完整记录，在副本中修正问题字段。将修复后的完整 payload 作为正常 `/v1/sync/push` 操作提交：`baseRevision` 使用读取到的远端修订号，`operationId` 使用新的唯一值。保存修复请求与返回的操作回执。版本冲突时重读并比较，不能绕过版本检查或直接修改数据库历史。

修复后重跑只读检查，并让客户端重试保留的增量组或基线暂存。无法应用的原组不会被跳过，首次基线失败也不会替换已存在的本地正文。

## 初始化设备不可用

优先使用恢复密钥恢复原设备身份。自托管 Cloudflare 管理员在 `apps/sync-server` 中运行 `npm run recovery:cloudflare -- --list` 核对设备，再运行 `npm run recovery:cloudflare -- <设备 ID>` 签发一次性恢复密钥；本地/VPS 管理员使用部署文档中的设备恢复流程。恢复后先核对冻结操作回执，再继续初始化。

不能恢复原设备时保留现有数据库、附件和回执，再在隔离的新实例中显式重新初始化。不能因等待超时改变 `seed_device`，也不能直接删除 dirty 或回执以使初始化结束。
