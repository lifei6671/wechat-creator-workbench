# 微信创作工作台自托管同步服务

两个入口提供同一套 HTTP 协议和 SQL 迁移，使用同一份连接信息完成首次连接、添加设备和重装接入，支持设备撤销、目录、条目和专题画布的增量同步，以及私有素材与长正文的校验读写。

## Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Flifei6671%2Fwechat-creator-workbench%2Ftree%2Fmaster%2Fapps%2Fsync-server)

在 Cloudflare 账号中开通 R2，点击部署按钮。将 32 字节随机值的十六进制形式填入 `SETUP_SECRET`，作为初始连接密钥保存。完成迁移和部署后使用生成的 HTTPS 地址。部署按钮读取公开仓库中已发布的子目录。

通过 Wrangler 部署时，将实际 D1 的 `database_id` 和私有 R2 桶名填入自己的 Wrangler 配置。先运行迁移命令，按顺序应用所有尚未执行的迁移，再部署 Worker。`SETUP_SECRET` 作为 Worker 密钥提供。

```sh
npm ci
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy --secrets-file .dev.vars
```

## VPS

在服务目录中将 `.env.example` 复制为 `.env`，填入随机 `SETUP_SECRET`。可用 `openssl rand -hex 32` 生成。Compose 绑定本机端口，反向代理将 HTTPS 请求转发到该端口。

```sh
docker compose up -d --build
curl http://127.0.0.1:8787/v1/meta
```

服务以非 root 用户运行，启动时按顺序应用所有尚未执行的 SQLite 迁移。数据库、WAL 和私有文件写入 `sync-data` 卷。反向代理须允许 25 MiB 的上传及流式下载。整库备份用 SQLite 在线备份或停写后生成一致副本，并保留其引用的私有文件。

## 协议和测试

1. 请求 `GET /v1/meta` 取得 `serverInstanceId` 和 `syncEpoch`。
2. 确认元数据的 `unifiedConnect` 和 `operationReceiptLookup` 为 `true`，使用 `POST /v1/connect` 提交 `accessKey`、预先持久化的 `deviceToken` 和 `name`，同时携带元数据对应的 `X-Sync-Instance` 与 `X-Sync-Epoch`。首台设备、第二台设备和重装后的电脑使用同一把连接密钥，每次安装使用独立设备令牌。成功返回 HTTP 200 和设备、实例、世代及初始化状态。响应丢失时重试原设备令牌，只产生一次登记；也可用该令牌查询 `GET /v1/devices` 确认结果。
3. 同步和 blob 请求带上 `Authorization: Bearer <deviceToken>`、`X-Sync-Instance` 和 `X-Sync-Epoch`。首次上传设备依次调用 `POST /v1/sync/seed` 的 `begin`、`push`、`finish`。
4. 使用 `GET /v1/sync/bootstrap` 扫描快照；续页查询传入返回的 `nextAfter.entityType` 和 `nextAfter.entityId`，参数为 `afterType` 和 `afterId`。随后用 `cursor=snapshotStartCursor&throughCursor=snapshotEndCursor` 补拉增量。
5. 对未收到结果的操作，用当前授权设备调用 `POST /v1/sync/receipts/lookup`，提交 `{originDeviceId, operation}`。`operation` 必须与原推送使用同一份规范化线上载荷，包括正文 blob 字段。返回单条 `applied`、`conflict`、`rejected` 或 `not_found` 结果，已提交结果保留原 `versions` 和 `cursor`。载荷不匹配返回 HTTP 409 `operation_id_reused`，不可当成未提交。查询允许读取本世代已撤销设备的回执，不要求增量游标有效，不产生写入，正文上限与推送一样为 1 MiB。

HTTP 409 `reset_required` 保留原错误字段并提供 `reason`：`cursor_expired` 表示游标低于保留水位，可重新取完整快照；`cursor_ahead` 表示历史不一致；`instance_changed` 和 `epoch_changed` 表示服务身份变化。客户端仅在第一种情况下自动对账，其他情况保留本地数据并暂停处理。

目录载荷使用 `name` 和可空的 `parentId`。条目载荷使用 `kind`、`title`、可空的 `categoryId`，以及 `contentMd` 或 `contentBlobHash` / `contentBlobSize`。增量返回 `remoteRevision`、`deletedAt` 和零基 `groupIndex`。首版每个原子操作组最多 256 项。重试保留操作 ID 和同一份序列化变更。推送回执中的游标用于诊断，客户端通过拉取推进本地游标。

```sh
npm ci
npm test
```

`npm test` 用同一份 HTTP 契约测试运行 Node SQLite 和 Wrangler 本地 D1/R2，覆盖并发统一连接、登记重试、轮换后旧密钥失效、回执查询与原子操作组。要对远端 Worker 或 Compose 服务运行同一套测试，将 `SYNC_TEST_URL` 和 `SYNC_TEST_SECRET` 设为独立、空白测试实例的地址与连接密钥，再运行 `npm run test:remote`。测试会初始化该实例，写入目录、文章、专题画布和测试附件，并撤销其创建的第二台设备。

桌面端在「设置 → 同步」填写服务地址、连接密钥和设备名称。空服务由首台设备初始化。另一台电脑或重装后的电脑填写同一份连接信息，自动登记新设备并合并或下载云端内容。「复制连接信息」复制保存的值，不轮换密钥；设备管理中的「更换连接密钥」才会调用 `POST /v1/access-key`。

加入设备已有文稿时，客户端先备份本地工作区和附件，再合并云端内容。两边独有的稿件和专题都保留。同一篇稿的不同版本可在设置中选择保留本地、采用云端或另存副本。不同的同名目录会保留各自的内容和引用，本地目录增加「本机」后缀。建立同步基线后会自动同步，也可点击「立即同步」。

升级现有服务时保留原来的 D1、R2 或 Docker 持久化卷，并应用待执行的迁移。要使用自动连接与对账，两端客户端和服务端均应升级。旧 `claim`、`join`、`recover` 路由以及已有设备令牌继续有效。本轮统一接入和回执查询没有新增服务端数据库迁移。

**对于已认领且从未设置接入密钥的服务，首次统一连接会把当前部署的 `SETUP_SECRET` 转为可重复使用的连接密钥。已有接入密钥的服务继续沿用原接入密钥。** 数据库只保存摘要；初始化或迁移不覆盖已有摘要，也不修改原认领设备、数据和设备令牌。

更换连接密钥后，旧部署密钥即使仍保留在环境变量中也不能新增设备。已授权设备继续使用各自的设备凭据。服务启动不把环境变量覆盖回数据库。若旧服务没有接入摘要且已移除 `SETUP_SECRET`，可由已有授权设备执行「更换连接密钥」，或使用下面的管理员恢复入口；仅凭服务地址无法连接。

## 重装后恢复连接

现有服务先升级并应用 `0004_device_recovery.sql`。继续使用原来的 D1 和 R2，或 VPS 上原来的持久化卷。

重装后在普通连接表单输入原服务地址和连接密钥，即可登记当前安装并自动下载或合并云端内容，无需指定原设备。

确需沿用原设备标识时，在已连接设备的高级操作中生成恢复密钥，保存到应用之外，再通过「恢复指定设备身份」兑换。该操作替换原设备凭据并消耗恢复密钥，保留工作区内容和其他设备。恢复后继续相同的内容协商，本地工作区无需为空。

### 两种密钥都丢失时通过 Cloudflare 恢复原设备

在已应用 `0007_admin_device_recovery.sql` 并部署新版的 Worker 上，拥有原 D1 编辑权限的 Cloudflare 管理员可以为指定设备签发临时恢复密钥。进入该 Worker 的部署项目目录，确保 Wrangler 配置中的 `DB` 绑定指向原 D1。登录 Wrangler 后列出设备，并用列表中原设备的 `id` 签发密钥。

```sh
npm ci
npx wrangler login
npm run recovery:cloudflare -- --list
npm run recovery:cloudflare -- DEVICE_ID
```

在重装后的工作台打开同步高级操作，填写原服务地址，通过「恢复指定设备身份」粘贴命令输出的恢复密钥。首次安装从空工作区拉取云端内容。该密钥有效期为 15 分钟，只能使用一次。为同一台设备再次签发会替换上一个临时密钥。

兑换成功后，应用沿用原设备 ID，并换发该设备的凭据。原认领状态、同步进度、云端数据及其他设备不受影响。命令在本地终端显示明文密钥，D1 仅保存密钥摘要和到期时间。

同步世代恢复流程见主仓库的 v1.1 设计。预留的增量保留水位支持过期游标检查，日志保留窗口需按实际写入量确定。
