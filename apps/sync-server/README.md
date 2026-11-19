# 微信创作工作台自托管同步服务

两个入口提供同一套 HTTP 协议和 SQL 迁移，支持首次认领、使用接入密钥添加设备和撤销设备，目录、条目和专题画布的增量同步，以及私有素材与长正文的校验读写。

## Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Flifei6671%2Fwechat-creator-workbench%2Ftree%2Fmaster%2Fapps%2Fsync-server)

在 Cloudflare 账号中开通 R2，点击部署按钮。将 32 字节随机值的十六进制形式填入 `SETUP_SECRET`，完成迁移和部署后使用生成的 HTTPS 地址。部署按钮读取公开仓库中已发布的子目录。

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
2. 首台设备使用 `POST /v1/setup/claim` 提交 `SETUP_SECRET` 和独立设备令牌。已连接的设备使用 `POST /v1/access-key` 生成可重复使用的工作区接入密钥，后续设备通过 `POST /v1/devices/join` 提交接入密钥和各自的设备令牌。响应丢失后，可用预先保存的设备令牌查询 `GET /v1/devices` 取得设备 ID。
3. 同步和 blob 请求带上 `Authorization: Bearer <deviceToken>`、`X-Sync-Instance` 和 `X-Sync-Epoch`。首次上传设备依次调用 `POST /v1/sync/seed` 的 `begin`、`push`、`finish`。
4. 使用 `GET /v1/sync/bootstrap` 扫描快照；续页查询传入返回的 `nextAfter.entityType` 和 `nextAfter.entityId`，参数为 `afterType` 和 `afterId`。随后用 `cursor=snapshotStartCursor&throughCursor=snapshotEndCursor` 补拉增量。

目录载荷使用 `name` 和可空的 `parentId`。条目载荷使用 `kind`、`title`、可空的 `categoryId`，以及 `contentMd` 或 `contentBlobHash` / `contentBlobSize`。增量返回 `remoteRevision`、`deletedAt` 和零基 `groupIndex`。首版每个原子操作组最多 256 项。重试保留操作 ID 和同一份序列化变更。推送回执中的游标用于诊断，客户端通过拉取推进本地游标。

```sh
npm ci
npm test
```

`npm test` 用同一份 HTTP 契约测试运行 Node SQLite 和 Wrangler 本地 D1/R2。要对远端 Worker 或 Compose 服务运行同一套测试，将 `SYNC_TEST_URL` 和 `SYNC_TEST_SECRET` 设为独立、空白测试实例的地址与认领密钥，再运行 `npm run test:remote`。测试会认领该实例，写入目录、文章、专题画布和测试附件，并撤销其创建的第二台设备。

桌面端在「设置 → 同步」连接服务。空服务由首台设备初始化。在这台设备上点「生成并复制接入密钥」，把密钥和服务地址保存在应用之外。另一台电脑选「加入已有服务」，填写同一个服务地址并使用已保存的接入密钥。

加入设备已有文稿时，客户端先备份本地工作区和附件，再合并云端内容。两边独有的稿件和专题都保留。同一篇稿的不同版本可在设置中选择保留本地、采用云端或另存副本。不同的同名目录会保留各自的内容和引用，本地目录增加「本机」后缀。建立同步基线后会自动同步，也可点击「立即同步」。

升级现有服务时保留原来的 D1、R2 或 Docker 持久化卷，并应用待执行的迁移。要使用首次合并，两端客户端均应升级。重新生成接入密钥会替换旧密钥，已连接设备继续使用各自的设备凭据。

## 重装后恢复连接

现有服务先升级并应用 `0004_device_recovery.sql`。继续使用原来的 D1 和 R2，或 VPS 上原来的持久化卷。

在已连接的设备上打开「设置 → 同步」，点击「生成并复制恢复密钥」，把密钥保存在应用之外。重装后若原设备凭据已丢失，在空工作区填写原服务地址，选择「恢复连接」，粘贴密钥。恢复沿用原设备标识，替换它的凭据并消耗密钥，保留云端工作区和其他设备。恢复完成后可以生成新的恢复密钥。

已保存接入密钥时，也可以将重装后的电脑登记为独立设备。设备凭据、恢复密钥和接入密钥均已丢失，且没有其他可连接设备时，需要管理员恢复接入。

同步世代恢复流程见主仓库的 v1.1 设计。预留的增量保留水位支持过期游标检查，日志保留窗口需按实际写入量确定。
