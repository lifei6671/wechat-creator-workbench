# 微信创作工作台自托管同步服务

两个入口提供同一套 HTTP 协议和 SQL 迁移，支持设备认领、配对和撤销，目录、条目和专题画布的增量同步，以及私有素材与长正文的校验读写。

## Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Flifei6671%2Fwechat-creator-workbench%2Ftree%2Fmaster%2Fapps%2Fsync-server)

在 Cloudflare 账号中开通 R2，点击部署按钮。将 32 字节随机值的十六进制形式填入 `SETUP_SECRET`，完成迁移和部署后使用生成的 HTTPS 地址。部署按钮读取公开仓库中已发布的子目录。

通过 Wrangler 部署时，将实际 D1 的 `database_id` 和私有 R2 桶名填入自己的 Wrangler 配置。先运行迁移命令，按顺序应用所有尚未执行的迁移，包括 `0002_article_dependencies.sql` 和 `0003_canvas_dependencies.sql`，再部署 Worker。`SETUP_SECRET` 作为 Worker 密钥提供。

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
2. 在设备上生成并保存独立的 32 字节随机令牌，以十六进制 `deviceToken` 连同 `{ name, setupSecret }` 发送到 `POST /v1/setup/claim`。第二台设备通过 `POST /v1/pairings` 获取的配对令牌调用 `POST /v1/pairings/redeem`，提交自己的 `deviceToken`。两者都返回 `deviceId`。响应丢失时，可以用已保存的设备令牌认证，`GET /v1/devices` 也会返回当前设备 ID。
3. 同步和 blob 请求带上 `Authorization: Bearer <deviceToken>`、`X-Sync-Instance` 和 `X-Sync-Epoch`。首次上传设备依次调用 `POST /v1/sync/seed` 的 `begin`、`push`、`finish`。
4. 使用 `GET /v1/sync/bootstrap` 扫描快照；续页查询传入返回的 `nextAfter.entityType` 和 `nextAfter.entityId`，参数为 `afterType` 和 `afterId`。随后用 `cursor=snapshotStartCursor&throughCursor=snapshotEndCursor` 补拉增量。

目录载荷使用 `name` 和可空的 `parentId`。条目载荷使用 `kind`、`title`、可空的 `categoryId`，以及 `contentMd` 或 `contentBlobHash` / `contentBlobSize`。增量返回 `remoteRevision`、`deletedAt` 和零基 `groupIndex`。首版每个原子操作组最多 256 项。重试保留操作 ID 和同一份序列化变更。推送回执中的游标用于诊断，客户端通过拉取推进本地游标。

```sh
npm ci
npm test
```

`npm test` 用同一份 HTTP 契约测试运行 Node SQLite 和 Wrangler 本地 D1/R2。要对远端 Worker 或 Compose 服务运行同一套测试，将 `SYNC_TEST_URL` 和 `SYNC_TEST_SECRET` 设为独立、空白测试实例的地址与认领密钥，再运行 `npm run test:remote`。测试会认领该实例，写入目录、文章、专题画布和测试附件，并撤销其创建的第二台设备。

桌面端在「设置 → 存储 → 同步」连接服务。空服务由首台设备初始化，后续设备使用空工作区拉取。建立同步基线后，桌面端会在后台同步，也可点击「立即同步」。预览、封面和导出缺图时会按需获取同一个私有文件。同篇稿件产生冲突时可查看两份稿并选择处理方式。

同步世代恢复流程见主仓库的 v1.1 设计。预留的增量保留水位支持过期游标检查，日志保留窗口需按实际写入量确定。
