# Cloudflare 同步服务端

这是已编译 Worker 包，版本与来源提交见 `version.json`，协议版本为 1。无需克隆仓库或编译 TypeScript。

1. 安装 Node.js 24，执行 `npm ci --ignore-scripts`，安装锁定的 Wrangler 部署工具。
2. 新安装先用 `npx wrangler login` 登录，再创建 D1 数据库和 R2 桶。在 `wrangler.jsonc` 填写自己的 Worker 名称、`database_name`、`database_id` 和 `bucket_name`，保留 DB、BLOBS 绑定及迁移目录。
3. 用 `npx wrangler secret put SETUP_SECRET` 设置随机 32 字节十六进制连接密钥，将同一个密钥交给需要连接的设备。
4. 执行 `npm run deploy`，先应用迁移，再部署已打包的 `worker/cloudflare.js`。可用 `npx wrangler deploy --dry-run` 检查部署产物。

## 从源码部署或旧发行包升级

解压新版后，以新版包内的 `wrangler.jsonc` 为基础，只从原配置迁移 Worker 名称、D1 的 `database_name` / `database_id`、R2 的 `bucket_name`，以及实际使用的账号和路由等环境配置。保留新版的 DB、BLOBS 绑定名和迁移目录。

不要用旧配置文件整体覆盖新版配置。下面两个字段必须保留新版值，旧源码入口 `src/cloudflare.ts` 不存在于发行包中：

```json
{
  "main": "worker/cloudflare.js",
  "no_bundle": true
}
```

继续复用原 D1、R2 和已有的连接密钥。执行 `npm ci --ignore-scripts` 后，先运行 `npx wrangler deploy --dry-run` 确认编译入口可用，再运行 `npm run deploy` 应用迁移并部署。不要创建新数据库、清空原素材或无意轮换连接密钥。

桌面和服务端目前使用相同的协议版本 1，发行说明若声明兼容变化，按该版本说明升级。

设备恢复工具：`npm run recovery:cloudflare -- --help`。执行恢复时使用实际配置的 `--config` 参数；此包不含任何账号、真实密钥或用户数据。运行组件及许可正文见 `third-party.json`，部署工具的锁定版本和许可证随 npm 包提供。
