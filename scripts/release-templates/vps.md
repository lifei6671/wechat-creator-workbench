# VPS / NAS 同步服务端

这是已编译 Node.js 包，版本与来源提交见 `version.json`，协议版本为 1。无需 TypeScript 源码或编译工具。

推荐使用 Docker Compose：复制 `.env.example` 为 `.env`，设置随机 32 字节十六进制的 `SETUP_SECRET`，执行 `docker compose up -d --build`。该命令直接消费 `dist`，只在目标容器内安装生产依赖及原生 SQLite 模块。默认监听 `127.0.0.1:8787`，通过自己的反向代理提供 HTTPS。文稿与素材持久化在 `sync-data` 卷中。

也可在 Node.js 24 环境中执行 `npm ci --omit=dev`，设置 `SETUP_SECRET`、`DATA_DIR`，然后 `npm start`。`better-sqlite3` 是原生模块，需要目标系统可用的预编译包或 C++、make、Python 编译环境；不要复制其他系统上的 node_modules。

升级时备份原持久化目录，停止旧服务，换用新版包并沿用原 Compose 项目名（或指定相同 `-p` 参数）、卷名、环境变量及 DATA_DIR，再执行 `docker compose up -d --build`。不要使用 `docker compose down -v`。启动时自动按顺序应用尚未执行的迁移，原设备身份与素材保留。桌面更新不会自动更新此服务。

运行组件版本与许可正文见 `third-party.json`。此包不包含用户数据库、素材或真实凭据。
