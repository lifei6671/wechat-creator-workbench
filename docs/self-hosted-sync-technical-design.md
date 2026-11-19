# 微信创作工作台自托管多端同步技术方案

> 版本 1.1
>
> 适用仓库：`https://github.com/lifei6671/wechat-creator-workbench`（`master`）
>
> 实施目标：用户部署自己的同步服务，Windows/macOS 桌面端基于本地 SQLite 离线写作并执行可靠的增量同步。
>
> 部署模式：Cloudflare 官方一键部署（Workers + D1 + R2）；VPS Docker Compose（Node.js + SQLite + 本地私有文件）。
> 方案基线：本地 `master` 的 `8b6f8a7`，最新数据库迁移为 `0019_collection_node_web.sql`。此版本定义拟实施的协议，真实部署和双设备验收见第 15 节。

## 1. 决策和边界

1. **每个服务端实例只服务一个写作工作区的一个所有者，可绑定多台设备**。首版不实现公网多用户注册、共享空间、多人实时编辑。
2. **Cloudflare 账号用于部署服务**。桌面应用连接用户部署的服务 URL，通过首次认领、接入密钥或恢复密钥取得设备凭据。
3. **SQLite 是每台设备的唯一编辑数据源**。Rust 负责数据库写入、同步队列和合并；React/Milkdown 仅使用现有内容 API，不能让同步逻辑绕过 Rust 服务层直接改编辑器。
4. **同步对象是业务实体，不是 `.db` 文件**。现有 S3 数据库快照仍用于备份/恢复，不能参与日常双向合并。
5. **云端保存权威实体快照、递增变更日志与设备认证信息**。增量日志指向提交时的确切版本。每个实体有独立 `remote_revision`；本地 `entries.version` 继续负责本机编辑并发。
6. **网络同步采用单写入请求、批量上传、按游标分页拉取**。无 WebSocket、CRDT、消息队列、后台常驻进程。
7. **附件同步私有化**。Cloudflare 使用 R2 Worker 绑定，VPS 使用本地数据目录；不复用用户已有的公众号公开图床凭据、对象前缀或删除流程。
8. **客户端账号配置是可选增强**。完全没有配置同步服务时，工作台按现有方式离线工作。

## 2. 现有源码和改动位置

| 位置 | 当前实现 | 同步接入点 |
|---|---|---|
| `src-tauri/src/db.rs` | `Workspace::write/save` 统一 SQLite `IMMEDIATE` 事务，迁移至 0019；`workspace_id` 存于 `app_settings` | 注册 `0020_sync.sql`；在事务内通过触发器捕获本地变更，远端回放用事务级开关抑制回流 |
| `src-tauri/src/content.rs` | `create_entry`、`save_entry`、`set_deleted`；`expected_version`；修改文章时重建标签及图片引用 | `entry` 逻辑快照包含正文、元数据、标签名、来源和链接；独立于本地 version |
| `src-tauri/src/content/taxonomy.rs` | 分类树，`entry_tags`、`tags.normalized`；分类删除会批量移动文章 | 同步分类；标签通过文章快照重建本地关联，无需跨设备共享标签本地 ID |
| `src-tauri/src/content/collections.rs` | `collections`、`collection_nodes`、`collection_edges`；卡片类型 `entry/image/text/web` | 专题、卡片、连线分别同步；`viewport_x/y/zoom` 保持每设备本地状态 |
| `src-tauri/src/assets/mod.rs` | `assets` 哈希去重，`asset://id` 稳定引用，本地哈希路径 | 上传/获取原图 blob；新增按现有 asset ID 物化远端文件的接口 |
| `src-tauri/src/assets/cleanup.rs` | 退出时基于本地引用清理本地文件及已配置 S3 图床对象 | 共享同步附件不由此处删除；本地缓存清理与远端附件删除分开 |
| `src-tauri/src/backup/restore.rs` | 快照校验、标记、替换数据库及重启恢复 | 成功恢复后暂停同步，要求确认服务端基线；避免旧游标和待上传操作意外回放 |
| `src-tauri/src/secrets.rs` | 系统钥匙串，键以本地 `workspace_id` 为前缀 | 保存设备 Token，绝不存入数据库快照或应用日志 |
| `apps/desktop/src/editor/save-queue.ts` | 编辑器 750ms 防抖、4s 最长延迟，本地 `version` 校验 | 保留；同步远端更新不得覆盖仍在编辑的队列缓冲 |
| `apps/desktop/src/workspace/Settings.tsx` | 现有配置面板 | 增加“同步”配置与设备管理 |
| `src-tauri/src/main.rs` | Tauri 初始化及 IPC 命令注册 | 注册同步命令和非独立进程的应用内调度任务 |

注意：`assets::fill()` 是微信公众号导入占位图的填充逻辑，会检查引用且通过原有导入路径写入；远端同步不能直接用它生成新 ID，应新建 `materialize_synced_asset`，保留远端同步的资产 ID。

## 3. 首版交付范围

首个双设备试用版本覆盖目录、内容、标签、来源、条目之间的关联和私有附件。专题画布在文章闭环验证后接入同一协议。

| 实体类型 | 本地来源 | 传输内容 | 策略 |
|---|---|---|---|
| `category` | `categories` | ID、父级、名称、排序、图标 | 根级先于子级应用，删除前先应用文章迁移 |
| `entry` | `entries`、`entry_tags`、`sources`、`entry_links` | 灵感/资料/文章正文、元数据、标签名称、来源信息、文章引用关系、软删除时间 | 整篇正文为一个冲突单元；保留本地版本号语义 |
| `asset` | `assets` | ID、SHA-256、MIME、文件名、尺寸、来源类型、保留标记 | 首个试用版本覆盖正文图片和封面。保留资产 ID，文件按需下载并按哈希去重 |
| `collection` | `collections` | ID、名称、说明、时间 | 专题阶段接入；排除 `viewport_x/y/zoom` |
| `collection_node` | `collection_nodes` | 卡片类型、所属专题、正文或引用、坐标尺寸、颜色、外链 | 专题阶段接入；每张卡片独立版本，拖拽结束后提交几何数据 |
| `collection_edge` | `collection_edges` | 起止节点、标签、所属专题 | 专题阶段接入；先节点后连线 |

`entry` 内的标签按名称及 `normalized` 规则还原为本地 `tags`/`entry_tags`；来源通过 `source_url` 去重并重建 `sources`；`entry_links` 通过文章关联的 `source_entry_id` 集合还原。`entries.folder_sort_order`、`pinned_order` 等已有排序属性也需纳入快照，排序仍由本地表呈现。`entry_assets` 从 Markdown 资源引用重新派生，不同步该派生表。

**首版不跨设备同步**：`app_settings` 中设备偏好、S3 图床及备份配置、系统密钥、AI 会话、`entry_revisions`、任务 `jobs`、FTS5 搜索索引、画布 WebView 缓存、缩略图、编辑器焦点与专题视口。现有这些功能维持本地原有行为。

已发布的图床图片 URL 作为文章内容的一部分同步；本地 `asset://` 图片会在同步服务的私有附件区拥有可下载的副本。引用图片不等于向公众号公开发布图片。

## 4. 服务端代码布局：单目录、双运行时

**关键兼容约束**：Cloudflare 官方 Deploy to Cloudflare 按钮虽接受仓库子目录，但要求该目录包含构建所需的全部源码、依赖和配置，不能依赖上级 monorepo 的工作区包。因此 `apps/sync-server/` 必须独立安装和构建。

```text
apps/sync-server/
  package.json                # 独立依赖及 build/deploy 脚本
  package-lock.json           # 子目录独立锁文件
  tsconfig.json
  wrangler.jsonc              # D1: DB / R2: BLOBS
  .dev.vars.example           # 首次绑定用高强度 SETUP_SECRET 模板
  Dockerfile
  compose.yaml
  .env.example
  migrations/
    0001_sync.sql             # 两种数据库共享的 SQLite 兼容 SQL
  src/
    app.ts                   # createApp(deps)：共用 Hono 路由
    protocol.ts              # 请求/响应类型与版本
    auth.ts                  # 首次认领、接入密钥、恢复密钥和设备撤销
    sync.ts                  # 快照、增量、版本冲突、幂等
    blob.ts                  # 私有附件读写接口
    storage.ts               # 应用层存储操作契约
    cloudflare.ts            # Workers 入口（D1 + R2）
    node.ts                  # Node.js 入口
    adapters/
      d1.ts
      sqlite.ts
      r2.ts
      local-files.ts
  tests/
    sync-contract.test.ts
    auth.test.ts
```

- 核心路由只使用 Hono、Web API、Web Crypto，避免依赖 Node 专属模块。
- Cloudflare 入口只注入 `env.DB` 和 `env.BLOBS`；VPS 入口使用 `@hono/node-server`、`better-sqlite3` 与文件系统。
- 存储适配层提供业务操作，如 `applyOperation`、`listChanges`、`listSnapshot` 和 blob 读写。两端共用实体结构校验、错误码和契约测试。D1 用 `batch()` 事务，Node SQLite 用同步事务。
- 桌面端 Rust 同步数据结构依据 `protocol.ts` 和固定 JSON 样例维护，并做契约测试；不要让部署子目录反向依赖仓库根部的 `packages/*`。

## 5. 云端数据模型

可以从以下表开始，采用 D1 与 SQLite 均能执行的 SQL 子集：

```sql
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE sync_pairings (
  token_hash TEXT PRIMARY KEY NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER
);
CREATE TABLE sync_entities (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(entity_type, entity_id)
);
CREATE TABLE sync_changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  payload_json TEXT NOT NULL,
  group_id TEXT NOT NULL,
  group_index INTEGER NOT NULL,
  group_size INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE sync_operations (
  sync_epoch TEXT NOT NULL,
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(sync_epoch, device_id, operation_id)
);
CREATE TABLE sync_blobs (
  sha256 TEXT PRIMARY KEY NOT NULL,
  size_bytes INTEGER NOT NULL
);
```

**持久化规则**：

1. `sync_meta` 保存永久 `server_instance_id`、`workspace_id`、当前 `sync_epoch`、首次认领状态、初始上传状态及设备 ID、增量保留水位。恢复改变 `sync_epoch`，详见第 12 节。
2. `sync_entities` 保存每个实体的最新快照或墓碑。删除也增加版本。条目软删除的墓碑仍保留可恢复字段；目录、专题、节点和连线等硬删除对象的墓碑保留身份及版本。
3. `sync_changes` 保存提交时的版本及其精确载荷，长正文共享不可变 blob。一个操作中的实体变更使用同一服务端 `group_id`，在事务内追加一段连续的日志。增量查询按游标读取这些记录。全量查询读 `sync_entities`。
4. `applyOperation` 在同一数据库事务中完成实例及世代校验、幂等判断、`baseRevision` 比较、关联约束验证、实体更新、日志追加和回执保存。D1 适配器用条件写入和数据库约束组织为一次 `batch()`。前置条件不满足时，该操作内所有实体保持原样。
5. 新建实体用 `baseRevision=0`，已存在实体和墓碑使用其实际版本。只有条目可通过显式恢复操作将软删除墓碑变回正常状态。客户端按持久化的 `operationId` 和原载荷重试。服务端按 `sync_epoch + device_id + operation_id` 查找回执并核对该组 `mutations` 的摘要，请求外层游标不参与摘要。相同操作返回原回执，修改载荷或解决冲突后使用新 ID。
6. 服务端在事务中验证本机 SQLite 也会要求的关系约束，包括同级目录名的 `NOCASE` 唯一性、目录层级与父子关系，以及文章与目录、素材、来源条目、专题节点与连线之间的有效引用。所需的索引和引用查询随同步范围接入。涉及跨实体变更的删除规则见第 8 节。
7. `sync_blobs` 在对象成功写入并校验后登记哈希和长度。实体提交在数据库事务内检查引用是否已登记。对象写入成功而登记失败时，重复上传可以完成登记，文件以哈希寻址。
8. 协议从首版支持增量保留水位。日志回收按完整操作组截断，只删除已超过保留窗口的日志，同时推进该水位。低于水位的客户端重新全量建立基线，保留本地待同步内容。去重回执与墓碑不随日志截断删除。D1 免费数据库容量为 500 MB，试用前用持续保存的样本测量日志和回执增长，据此定下日志保留窗口。私有 blob 的回收另行设计。

D1 单字段或单行上限为 2,000,000 字节。按序列化后的 UTF-8 字节数限制实体、事件和 HTTP 批次大小，附件和长正文规则见第 9 节。

## 6. 统一 HTTP 协议（版本 v1）

| 接口 | 身份 | 说明 |
|---|---|---|
| `GET /v1/meta` | 公开 | 返回协议版本、服务实例 ID、当前同步世代及认领状态 |
| `POST /v1/setup/claim` | 部署者设置的认领密钥 | 每次开放认领只登记一台设备，接收设备预生成的令牌并返回设备 ID |
| `POST /v1/access-key` | 已认证设备 | 生成或轮换可重复使用的工作区接入密钥 |
| `POST /v1/devices/join` | 工作区接入密钥 | 接收预生成的独立设备令牌并登记新设备 |
| `POST /v1/recovery-key` | 已认证设备 | 生成本设备的一次性恢复密钥，替换先前生成的密钥 |
| `POST /v1/recover` | 一次性恢复密钥 | 接收新设备令牌，替换原设备凭据并返回原设备 ID |
| `GET /v1/devices` | 已认证设备 | 读取设备列表 |
| `DELETE /v1/devices/:id` | 已认证设备 | 撤销指定设备 |
| `POST /v1/sync/seed` | 已认证设备 | `begin` 锁定首次上传设备，`finish` 将初始化完成的工作区开放给其他设备，均可重试 |
| `GET /v1/sync/bootstrap` | 已认证设备 | 按固定 `(entityType, entityId)` 键分页，第一页返回起始增量游标 |
| `POST /v1/sync/push` | 已认证设备 | 批量提交单实体操作或需要原子生效的多实体操作 |
| `GET /v1/sync/pull?cursor=N&limit=100` | 已认证设备 | 按递增游标返回变更当时的快照或墓碑，可用 `throughCursor` 指定本轮上界 |
| `GET /v1/sync/entities/:type/:id` | 已认证设备 | 查看当前实体或墓碑，供冲突详情及处理前更新版本使用 |
| `HEAD/PUT/GET /v1/blobs/:sha256` | 已认证设备 | 根据哈希校验、上传、按需下载私有附件和长正文 |

认领或加入完成后，同步及 blob 请求携带 `X-Sync-Instance`、`X-Sync-Epoch`。服务端核对当前实例和世代，工作区就绪后的推送与增量拉取还需检查客户端已持久化的游标。请求级的身份、协议、实例或世代错误使请求停止处理。世代不匹配或游标超出可用范围时返回 `409 reset_required`，客户端暂停推送。同步查询通过同一个权威数据库读游标和快照，首版使用 D1 主库读写。

`push` 请求示意。每个 `operations[]` 元素是独立的事务和幂等单元：

```json
{
  "protocolVersion": 1,
  "cursor": 42,
  "operations": [
    {
      "operationId": "a3c1b91a-5d5e-4f16-83a6-8f4d3c94ce41",
      "mutations": [
        {
          "entityType": "entry",
          "entityId": "ebd0eb5b-1f13-4190-819f-d11237b77c4b",
          "baseRevision": 3,
          "operation": "upsert",
          "payload": { "kind": "article", "title": "我的文章", "contentMd": "示例正文" }
        }
      ]
    }
  ]
}
```

`mutations[]` 支持 `upsert`、`delete` 和 `restore`。`restore` 用于恢复已软删除的条目。成功后写入 `upsert` 类型的日志，载荷是恢复后的快照。

`push` 按提交顺序处理操作组，HTTP 200 逐组返回结果。`applied` 和 `already_applied` 返回组内各实体的 `remoteRevision` 及提交水位。`conflict` 返回版本或关系冲突及涉及实体的当前版本，正文按需查询。`rejected` 返回当前操作的载荷、依赖缺失或大小错误。前一组的领域冲突不回滚已经提交的组。依赖失败的相关组保留在客户端，其余组可继续。推送回执仅更新相应实体的版本基线，拉取游标由拉取流程推进。

`bootstrap` 第一页在同一次主库读取中返回 `snapshotStartCursor` 和本页数据，后续用固定键扫描最新快照和墓碑。客户端分页写入暂存区。最后一页返回当时的已提交水位 `snapshotEndCursor`。随后从起始游标补拉至该水位，暂存区仅接收同实体更高版本。扫描期间插入到已扫描区间、被更新或被删除的实体会通过补拉补齐。补拉完成后再按依赖写入业务表并启用增量游标。中途发生世代切换或起始游标过期时，从新水位重新开始暂存。

`pull` 响应包含 `serverInstanceId`、`syncEpoch`、`changes[]`、`nextCursor` 和 `hasMore`。每条变更有日志游标、组信息、版本和对应载荷。`nextCursor` 指向该页最后一条已返回的日志。轮询可分页接收一个组，客户端等到组齐全才把它写入业务表。回放成功的结果、需要保留的完整冲突组和未收齐的日志都应先在本地事务内持久化，随后在同一事务内推进游标。

首版初始限额为单实体序列化 JSON 512 KiB、单次推送请求 1 MiB 且最多 20 个操作组、全量或增量单页 2 MiB 且最多 100 条记录。分页按 UTF-8 字节和条数先到的上限截断。服务端查询分批取数，避免为截断一页而一次读出全部大载荷。超出限额的操作返回明确错误，后续独立操作可以继续。

## 7. 本地 SQLite 迁移与变更捕获

新增 `src-tauri/migrations/0020_sync.sql` 并注册到 `db.rs::MIGRATIONS`，结构建议如下：

| 表 | 核心字段 | 用途 |
|---|---|---|
| `sync_control` | id=1、capture_enabled、applying_remote | 初始化/回放时控制 SQLite 触发器 |
| `sync_dirty` | entity_type、entity_id、generation、operation、updated_at | 合并同实体高频变更；写入与本地业务事务原子提交 |
| `sync_revisions` | entity_type、entity_id、remote_revision | 已应用远端数据或已获推送确认的版本。仅观察到的冲突版本保存在冲突记录中 |
| `sync_outbox` | operation_id、sync_epoch、payload_json、各实体的 local_generation、status、attempts | 固定在途操作及基础版本，便于超时原样重试 |
| `sync_state` | server_instance_id、sync_epoch、cursor、sync_status、初始上传进度 | 保存绑定身份、已持久化增量游标及暂停和初始化状态 |
| `sync_inbox` | sync_epoch、cursor、group_id、payload_json | 暂存未收齐或尚未回放的操作组，重启后继续 |
| `sync_conflicts` | 涉及实体或组、local_payload、remote_payload、remote_revision | 持久化冲突和待处理依赖，两侧内容可恢复 |

同步触发器覆盖：

- `entries` 的新增、修改、删除；`entry_tags` 的增删、`entry_links` 的增删均将所属 `entry` 标记为脏。
- `sources` 更新时，将引用此来源的 `entry` 标记为脏；不需要额外同步纯本地 sources 关系表。
- `categories` 的新增、修改、删除；分类重排会标记变动的分类，删除时批量迁移文章也会标记对应 `entry`。
- `collections` 标题/描述的新增、修改、删除；仅修改 `viewport` 不产生同步变更。
- `collection_nodes` / `collection_edges` 的新增、修改、删除；级联删除应保留实体墓碑。
- `assets` 的元数据新增与需要共享的修改；**退出清理产生的本地文件/索引回收不等同于云端全局删除**，不能作为远端删除操作直接广播。

服务端数据回放时，在同一个 `Workspace::write` 事务内暂时设置 `sync_control.applying_remote=1`，完成关系表写入、资源引用重建和搜索索引自动更新，然后将其恢复为 0，最后提交事务。若事务失败，标志位与全部写入一起回滚。这样远端回放不会形成重复上传回路。

**变更快照生成**。Rust 同步任务从 `sync_dirty` 读取实体和代次，构造业务快照。单实体的反复编辑合并为一个待发送状态，同时保留在途快照。涉及关联约束的本地批量操作，在原写事务内记录影响清单及分组关系，按组构造 `sync_outbox`。每个实体同一时间最多有一个在途操作。生成快照及记录代次在本地事务内完成，网络请求在事务外执行。

**并发保存规则**。发出的操作记录 `local_generation=18`。如果网络请求期间又保存到 `generation=19`，服务端确认版本 4 时更新对应版本基线，并保留代次 19 的脏标记。下一轮以新版本为基线继续提交。响应丢失后，原 `operation_id` 连同原载荷重试。收到有效回执时同时处理基线、outbox 和脏标记，避免应用重启后重复提交新代次。

## 8. 同步执行顺序和冲突处理

### 8.1 初次绑定

- 服务端从 `empty` 进入 `seeding` 时，原子记录负责首次上传的设备 ID。`begin` 重试会返回同一状态。初始化期间仅该设备可向云端提交内容，其他设备看到初始化尚未完成。
- 该设备先在本地事务中把同步范围内的已有业务实体标记待上传，同时记录本轮初始扫描已完成，再按依赖分批上传。重启后沿用云端初始化状态、本地脏标记及 outbox。首轮数据和依赖全部获服务端确认后调用 `finish`，进入 `ready`。即使是空工作区，第一台设备也通过同一流程建立基线。
- 云端就绪后，全新本地库按第 6 节全量初始化。加入的设备已有内容时，客户端先把本地数据库与素材备份成迁移包，再在一次事务内应用已校验的云端快照并登记本地独有项。相同文稿 ID 的不同版本交给现有冲突界面处理；同名不同 ID 的文稿分别保留。独立同名目录保留结构并在本地名称后加「本机」，素材和专题引用保留稳定 ID。双方给同一图片占位填充不同文件时，本地文件分配新的素材 ID，并同步更新引用。

### 8.2 增量与本地回放

1. 每轮只运行一个同步任务。检查绑定后，优先补齐尚未收到结果的在途操作，再拉取远端变化，随后提交新的本地操作。一次无法处理的冲突只挂起受影响的实体、操作组及其依赖。
2. 先上传依赖的 blob，再按 `category`、`asset`、`entry`、`collection`、`collection_node`、`collection_edge` 的依赖顺序提交新对象。同类实体先提交被依赖对象。全量回放先落实体，再还原条目关联。增量按服务端提交顺序回放完整组。
3. 普通远端变更只应用高于本地基线的版本。长正文先在数据库事务外下载，缺失时将完整组留待回放。同一事务更新业务表、实体版本基线和待回放记录。回放文章时递增本机 `entries.version`，重建标签、来源、条目关联、附件引用及搜索索引。改目录时先写 `category_id`，再写 `folder_sort_order`，避免现有触发器清除远端排序。
4. Rust 在提交回放前检查本地 dirty 和 outbox。打开的文稿还须与 `SaveQueue` 协作。先落盘已有缓冲，再在编辑器确认的安全窗口内提交回放。窗口失效或已有在途本地保存时，保留远端组待处理。已落盘且待同步的本地修改遇到较新远端版本时，持久化冲突。
5. 回放提交后发出应用事件，刷新列表、专题和无待保存修改的文稿。编辑中的稿件及其缓冲持续保留。

### 8.3 跨实体操作和冲突处理

- **同名目录**。两台设备可能离线创建不同 ID 的同名目录。服务端按同级目录名约束拒绝第二个操作，返回相关目录 ID。客户端保留本地目录和其中的稿件，提供重命名后重试。远端同名目录暂存至本地命名冲突解除，再按顺序回放。
- **目录删除**。把受影响文章迁移、子目录删除和目标目录删除作为一个操作组，带上受影响实体的基础版本。服务端校验当前版本和剩余引用。远端多出一篇目录下的文章，或组内有更新冲突时，整组拒绝。客户端保留操作及关联内容供处理。
- **专题和节点删除**。专题、节点及受影响的连线按同一规则组提交。应用远端组前检查本地新增引用及未同步子项，避免 SQLite 级联删除抹掉本地待同步修改。卡片移动和其他独立卡片编辑按单实体版本提交。
- **画布并发修改**。同一画布实体出现冲突时保留本机修改。云端实体仍存在时，可在同步设置中选择保留本地版本，按当前冲突记录的云端版本重新上传。若云端再次变化，冲突会重新提示。
- **组暂停与继续**。远端组因本地独有目录名、引用或待同步内容无法应用时，回滚该组的业务写入，在同一页面事务中保存完整组和冲突详情。受其阻塞的后续组一并暂存，独立组可以继续。解决后按服务端顺序重放暂存组，完整持久化的增量页无需重拉。
- **正文冲突**。保留本地稿和远端版本，提供「采用云端版本」「使用本地版本覆盖」「将本地修改另存为新内容」。覆盖以用户确认时展示的云端版本作为新的 `baseRevision`，云端再次变化时保留冲突。另存和采用云端版本时，只清除用户已处理的本地代次。整篇正文为一个冲突单元。
- **超限操作组**。已启用同步的目录、专题删除在本地提交前检查其必要操作组是否超出推送限制。超限时保留本地内容，引导用户分批移动文章或移除关联项后再删除。组内成员依据同一次业务写入确定，后续编辑走新的代次。

## 9. 附件与超长正文

- 正文按 UTF-8 编码大小决定存放位置。首版从 64 KiB 起将正文作为私有 blob 上传，实体和日志记录 `contentBlobHash`、字节数及业务元数据。序列化后仍受第 6 节实体大小限制。长正文下载并校验后再写入本地 `entries.content_md`，供离线编辑和 FTS5 使用。
- 图片、截图和长正文通过 `PUT /v1/blobs/:sha256` 上传，原始字节不可变。客户端提供已知 `Content-Length`；服务端限制长度并校验实际接收内容，成功后登记。
- Cloudflare 使用 Worker 的 R2 绑定流式读写，上传时将期望的 SHA-256 交给 R2 校验。VPS 端流式写入临时文件，校验长度及摘要后原子重命名。桌面端使用设备 Token。
- `GET` 使用独立设备 Token 验证，远端同步资源不默认公开。用户已有公开 S3 图床仍由现有 `storage_profiles/asset_locations` 管理。
- 新设备先获取资产元数据。预览、封面、导出和发布共用缺失资产获取路径，按哈希下载并验证后原子落盘，`Assets::materialize_synced_asset` 保留原 asset ID。未填充的公众号导入占位素材同步其占位状态，补图后沿用该 ID 发布带哈希的更新。
- 本机清理可回收可重取的文件副本，保留同步资产元数据、尚未上传的附件及 outbox 或冲突稿需要的本地文件。同步私有对象由服务端管理，首版无自动删除。公众号公开图床保留现有独立逻辑。
- 图片和正文 blob 单对象不超过 25 MiB。超限项保留本地原件，状态显示具体限制，同步继续处理无依赖的其他实体。

## 10. 设备认证与所有者初始化

**首次 Cloudflare 用户流程**：

1. 在工作台“设置 → 同步”选择 Cloudflare，点击“部署我的同步服务”。打开 `Deploy to Cloudflare` 官方部署页，目标是仓库下独立的 `apps/sync-server` 子目录。
2. 桌面端生成 32 字节随机初始化密钥，以安全字符串展示/复制；用户在部署模板的 `SETUP_SECRET` 字段粘贴。
3. Cloudflare 账号按平台要求开通 R2 订阅后，部署流程按 `wrangler.jsonc` 创建并绑定 D1/R2，运行数据库迁移并部署 Worker。用户复制自己的 `https://...workers.dev` 地址（或自定义域名）。
4. 桌面端调用 `/v1/meta` 检查实例和协议，生成独立的 32 字节随机设备令牌，再携带初始化密钥和设备令牌调用 `/v1/setup/claim`。服务端以哈希存储校验值，返回设备 ID。响应丢失后，设备可用预先保存的令牌查询自己的设备 ID。
5. 发送认领、加入或恢复请求前，设备令牌使用现有 `secrets.rs` 钥匙串存储。SQLite 记录 URL、设备 ID、实例 ID、同步世代与进度。日常同步使用设备凭据。
6. 已连接的设备生成工作区接入密钥，用户把它保存在应用之外。新设备输入原服务 URL 和接入密钥加入。重新生成会替换旧密钥，已连接的设备继续使用自己的设备令牌。撤销设备时保留正在首次上传的设备和至少一台有效设备。

**VPS 用户流程**：提供 `compose.yaml` 和 `.env.example`，用户生成随机 `SETUP_SECRET`，以持久化卷保存 `/data/sync.db`、`/data/blobs`，通过已有 Caddy/Nginx 配置 HTTPS，再在桌面端认领服务和添加设备。

设备令牌和接入密钥使用高熵随机数，服务端保存 SHA-256 摘要。认领状态与首台设备的登记原子提交。已完成认领后，部署者可通过第 12 节的恢复操作再次开放认领。同步与附件 API 均须验证设备。MCP 作为本机服务运行。

## 11. 部署脚本与构建约束

### Cloudflare

- `apps/sync-server/wrangler.jsonc` 声明 Worker 入口 `src/cloudflare.ts`、`DB` D1 绑定和 `BLOBS` R2 绑定。`.dev.vars.example` 声明供部署页面收集的 `SETUP_SECRET` 字段。
- 子目录独立 `package.json/package-lock.json`。`deploy` 脚本先按绑定名执行 `wrangler d1 migrations apply DB --remote`，再执行 `wrangler deploy`。
- README 的部署按钮指向公开仓库中的独立子目录。用全新 Cloudflare 账号验证 R2 开通、资源自动创建、密钥录入、迁移、部署和首次认领。
- 任何 Cloudflare API Token 均留在 Cloudflare 平台的部署授权环节，桌面程序不接触管理 API。

### Docker Compose

- `apps/sync-server/Dockerfile` 以 Node.js 24 构建，运行 `src/node.ts` 对应的生产产物，使用非 root 用户。
- `compose.yaml` 为服务挂载 `./data:/data`，包含 SQLite 数据库文件及私有附件目录；启动时执行与 D1 语义一致的迁移。
- 默认只监听本机反向代理可访问的端口，公网通过 HTTPS 域名访问。数据目录持久化，SQLite 使用 WAL 模式。服务端备份用 SQLite 在线备份或停写后生成一致副本，并一起保留私有 blob。
- 升级需保持数据库迁移向前兼容；统一 `GET /v1/meta` 协议版本供旧版客户端检查。

注意：Cloudflare 官方一键部署对子目录有严格的独立构建限制，不能在 `apps/sync-server` 里 import `../../packages/shared-types` 或使用根目录工作区别名。两种部署方式共同复用子目录内部的 Hono 核心即可。

## 12. 备份/恢复和服务身份

- 本地 `workspace_id` 继续用于 S3 快照和系统钥匙串，连接另存服务端 `workspace_id`、`server_instance_id`、当前 `sync_epoch` 和设备 ID。SQLite 整库备份与同步独立使用。
- 重装前可把恢复密钥保存在应用之外。服务端仅存密钥的 SHA-256 摘要，撤销设备时清除摘要。使用密钥时在同一次数据库更新中消耗密钥并替换该设备的令牌，保留设备 ID、同步世代、云端内容及其他设备。重装后的空工作区通过原有流程拉取云端基线。
- 本地恢复在 `backup/restore.rs::prepare_file` 中写入暂停状态，完成数据库替换后才初始化服务。备份携带的游标、远端版本基线和 outbox 均停止使用。恢复稿保留供用户查看及迁移，从另一设备的备份恢复时需要重新登记。
- 服务端从较早的备份恢复时，先进入维护状态，其间暂停同步请求。恢复已完成初始化的数据库后，检查当前实体仍引用的 blob 是否可读，撤销恢复库中的旧设备令牌、工作区接入密钥和恢复密钥，生成新的 `sync_epoch`，把可用增量水位设为当前日志末尾。部署者轮换 `SETUP_SECRET` 并重置认领状态，保留已恢复数据，开放服务后通过原认领接口授权首台设备，再添加其他设备。D1 Time Travel 恢复数据库，R2 对象需单独保留或恢复。
- 即使 `server_instance_id` 相同且新游标已追过恢复前的数字，旧世代请求仍会被拒绝。客户端观察到新实例、新世代或不可用游标时暂停推送，重新全量建立基线。应用单独暂存云端基线，用户确认后才切换。保留下来的修改可在新基线上明确另存或重新提交。

已暂停的工作区可在“设置 → 同步”中选择“重建同步基线”。原设备凭据失效或服务世代变化时，先在原服务地址重新认领、加入或恢复连接。应用下载并校验基线后，把本地数据库与现有素材保存为 `sync-recovery/` 下的工作区迁移包，再替换同步基线。可从设置中打开副本的位置，通过“工作区迁移”导入副本取回本地稿。尚未下载到本机的云端图片只保留素材记录。仅在设备上存在的文稿会进入废纸篓，旧同步队列在基线切换时清除。

## 13. 同步触发时机

初版采用简单事件调度：用户主动点击“立即同步”、首次连接成功、网络恢复、应用获得焦点；本地有待同步操作后约 30 秒触发上传；窗口保持活动时每 5 分钟做一次远端增量检查。同步任务单飞，失败退避后重试，不阻塞 750ms 的本地编辑自动保存。

自动回放等待编辑输入失去焦点和本地文稿保存完成。已经下载的变更会留在本地，用户也可以手动点击“立即同步”回放。

同步设置遵循[桌面界面与交互设计规范](./ui-design-guidelines.md)。状态包括未配置、已同步、待同步、同步中、已暂停、冲突和错误。冲突可查看保留下来的本地内容。应用分别反馈本地保存与云端同步的进度。

## 14. Codex 实施任务

### 阶段 A：可部署的同步协议

- [ ] 建立 `apps/sync-server/` 独立项目，接通 Hono 双入口、D1/SQLite 共享迁移以及 R2/本地文件接口。
- [ ] 用最小的目录和条目实体实现认领、配对、初始上传、全量水位、版本比较、精确增量和幂等回执。
- [ ] 用同一组用例验证两种存储实现的并发提交、整组回滚、重复请求与分段拉取。用真实 D1 验证 `batch()`，以接近上限的 UTF-8 载荷测量每页字节、查询次数和日志增长。
- [ ] 配齐独立锁文件、`wrangler.jsonc`、部署按钮、Dockerfile 和 Compose。实测新 Cloudflare 账号首次认领、带校验的 R2 流式上传和 VPS 持久卷启动。

### 阶段 B：带私有图片的文章同步

- [ ] 注册本地同步迁移并更新备份 schema 检查，接入 Rust 同步任务、系统钥匙串和恢复暂停。实现初次上传断点续传、全量暂存和补拉、本地 dirty/outbox/inbox、代次确认与冲突查看。
- [ ] 覆盖目录、内容、标签、来源和条目关联，验证 FTS5、目录排序、SaveQueue 与冲突恢复。
- [ ] 接入私有图片、封面、长正文的上传及恢复。预览、导出和发布共用素材读取路径，退出清理保留同步元数据和未完成操作所需文件。
- [ ] 在两台设备验证首次上云、跨页回放、断线重试、同文并发保留两份稿，以及恢复后暂停推送，再开放文章同步试用。

### 阶段 C：专题画布与发布验收

- [x] 接入专题、节点和连线，验证本地视口、拖拽结束同步、截图及级联删除的操作组。
- [ ] 执行第 15 节全量验收，覆盖 Windows/macOS 双设备，以及实际 Cloudflare 一键部署和 VPS Docker Compose 部署。记录试用期间确认的保留窗口与容量数据。

专题同步要求同一工作区的设备使用支持画布同步的版本。先执行服务端 `0003_canvas_dependencies.sql` 迁移并升级服务，再更新各设备。已有绑定、文章及同步游标会沿用，已有专题会加入上传队列。恢复重建沿用同 ID 专题的本机视口，未同步的专题内容可从恢复包找回。

Windows 上的两个独立工作区已通过 Node SQLite 和本地 Workers D1/R2 联调，覆盖画布首次同步、截图原件读取、重建后视口保留和删除冲突回放。Windows ↔ macOS 专题画布同步实测结果见下方记录。

发布验收记录（2026-11-18）

- DigitalVirt VPS 已通过 Docker Compose 部署和专题画布验收。amd64 镜像由仓库 Dockerfile 在本地构建，在 VPS 上以 UID 1000 运行，SQLite 与私有附件保存在独立持久卷。Windows 的两个独立工作区经 SSH 转发访问 VPS 上的 Caddy HTTPS 反代，正常校验 Let's Encrypt 证书。画布用例覆盖首次同步、截图原件读取、视口保留、冲突与级联删除。强制重建容器后，HTTPS 仍可访问，实例 ID、同步代次、同步游标 23、12 项实体版本及两份私有文件的 SHA-256 一致。公网入口、DNS 和自动签发待验证。
- 追加的 25 MiB 附件契约测试在约 1 GiB 内存、无交换空间的 VPS 上触发系统级 OOM，内核终止了 WARP 和一个 Node 进程。临时 Compose 项目、持久卷、Caddy 实例及 SSH 规则、公钥已清理，原有 SSH、Caddy 和 WARP 已确认恢复。
- Debian NAS 已通过 25 MiB 附件和容器重建后的授权读取复测。Compose 通过无根 Podman 运行，Windows 客户端经 SSH 转发访问 Caddy HTTPS，并在测试进程内校验证书。完整 HTTP 契约通过，两台测试设备上传和下载的 26,214,400 字节附件 SHA-256 一致。强制重建更换了同步容器并沿用原卷。原设备凭据通过 HTTPS 完整读取 25 MiB 和 90,000 字节附件并验证 SHA-256，专题连线的第 2 版删除记录仍可读，服务实例 ID 和同步代次一致。无设备凭据的附件请求返回 401。
- 隔离的真实 Cloudflare Worker 已应用全部 D1 迁移。Linux 客户端通过 HTTP 契约测试，验证专题、卡片、连线、删除组和私有对象读写，生产 D1 写入 35 条变更。Windows 直连首次遇到网络错误，使用独立资源复测通过双工作区画布用例，记录 18 条画布变更和两份私有对象。
- Cloudflare 官方部署按钮已通过验收。接受权限更新并重装 GitHub App 后，部署向导从公开验收分支克隆独立服务到私有仓库，创建 Worker、D1 与 R2，配置 `SETUP_SECRET`，并通过 Workers Builds 自动执行 `0001` 至 `0003` 三条迁移。验收 Worker 的 Windows 双工作区画布用例通过，生产 D1 记录 18 条画布变更和两份私有对象。验收前已轮换该实例的临时认领密钥。

Windows ↔ macOS 实机验收记录（2026-11-19，`c5dc772`）

- Windows 11 与 macOS 27.0.1（Apple Silicon）各运行由同一提交编译的原生 Rust 测试进程，调用工作台同步实现及系统凭据存储。测试工作区与 Node SQLite 服务均独立创建，Windows 经校验证书的临时局域网转发访问 Mac 上的服务。
- Windows 首次上云，Mac 配对拉取后核对目录、文稿、专题、四类卡片、连线及原有 ID。专题文本卡片中的 126,063 字节 Markdown 完整读取，截图字节与原始 PNG 一致。
- Mac 修改卡片坐标及正文，两次本地改稿归并为同一卡片变更，Windows 拉取后得到最终内容。两端独立编辑同一卡片时，Mac 保留本地及远端版本，选择本地版本后 Windows 拉取到该版本。Windows 删除卡片时，关联连线在同一组内删除并在 Mac 回放。两端视口独立，Mac 重建基线时保留视口并生成恢复包。
- macOS 上的 8 项 Rust 同步相关测试及认领配对、文章与私有图片、专题画布三项独立服务集成测试通过。设置和同步调度的 11 项前端测试在 Windows 和 Mac 均通过。安装包中的同步界面人工操作仍待验证。

## 15. 验收矩阵

| 场景 | 通过标准 |
|---|---|
| 完全未配置同步 | 启动、编辑、粘图、搜索、导出、MCP、备份流程均维持现有行为 |
| 首次 Cloudflare 部署 | 新账号按平台流程开通 R2，官方按钮创建 Worker、D1、R2，数据库迁移和首次认领成功 |
| VPS Docker | Compose 启动，HTTPS 反向代理后可认领和跨设备访问。重启容器后数据及私有文件仍可访问 |
| 初次上云 | A 端已有文章、目录和私有图片。上传中断后可续传，第二设备在初始化完成后才下载，业务 ID 保持一致 |
| 第二设备拉取 | B 端仅有默认内置目录时可初始化。内置目录按固定 ID 更新，正文、关联和素材引用有效 |
| 全量扫描期间并发写入 | 第一页后在已扫描区间新增、修改及删除实体，B 端通过补拉获得最终状态 |
| 增量跨页引用和分组 | 旧文章日志携带当时的目录引用。一个组跨页并在中途重启时，重启后收齐再生效，游标和暂存记录一致 |
| 离线创建与编辑 | A 断网反复保存、本地正常使用；恢复网络后 B 获得最终版本，且不上传每一次按键历史 |
| 并发不同文章 | A/B 分别修改不同文章，双方最终都能看到两份修改 |
| 并发同一文章 | 批量推送返回 HTTP 200，冲突组结果为 `conflict`，本地稿和远端稿均可查看与恢复 |
| 并发创建同名目录 | 同级目录唯一性在服务端生效，冲突目录及关联稿件保留，重命名后可继续同步，其他条目继续拉取 |
| 同步时继续输入 | 推送代次 18 在途时保存代次 19，回执保留 19。拉取时新增未落盘输入也可继续保存，出现竞争时保留两份内容 |
| 发送成功丢失响应 | 同一操作 ID 和载荷重试返回原回执，远端版本和日志只增加一次 |
| 删除及恢复 | 条目软删除、显式恢复均传播。目录删除与文章迁移原子生效且保留排序。目录中存在并发新增稿件时整组拒绝 |
| 专题画布 | 卡片和连线可在第二设备恢复，视口由各设备保存。删除专题、节点及受影响连线作为一组；本地未同步子项遇到远端删除时保留冲突 |
| 长正文与分页大小 | 包含多字节字符的长文走私有 blob 并完整写回本地。满页按字节截断，翻页无遗漏；超限项有明确错误 |
| 图片、封面和截图 | 新设备可用相同 `asset://id` 预览及直接导出、发布，下载文件的 SHA-256 一致。专题阶段验证截图 |
| 素材清理 | A 退出时不会删除 B 仍需访问的同步私有对象；已有公众号图床和备份清理互不干扰 |
| 设备撤销 | 撤销设备令牌后其同步与附件读写均返回 401/403，其他设备继续正常工作 |
| 本地备份恢复 | 恢复后保留旧稿且同步暂停，旧游标和旧 outbox 保持停用 |
| 服务端回滚 | 实例 ID 相同且游标追过旧值时，旧世代请求仍被拒绝。设备重新配对，以全量快照建立基线，未同步稿可显式迁移 |
| 增量过期 | 从低于保留水位的游标拉取会收到 `reset_required`，客户端保留本地待同步内容并重建基线 |
| 运行时一致性 | 真实 D1 与 VPS SQLite 通过同一契约用例，包含并发 CAS、组原子性、幂等、精确事件版本和游标。部署目录独立构建通过 |

## 16. 参考资料

- 仓库源码：`https://github.com/lifei6671/wechat-creator-workbench`
- Cloudflare 官方一键部署：`https://developers.cloudflare.com/workers/platform/deploy-buttons/`
- D1 `batch()` 和事务语义：`https://developers.cloudflare.com/d1/worker-api/d1-database/`
- D1 容量与单条数据限制：`https://developers.cloudflare.com/d1/platform/limits/`
- R2 订阅开通：`https://developers.cloudflare.com/r2/get-started/`
- Workers R2 流式读写与校验：`https://developers.cloudflare.com/r2/api/workers/workers-api-reference/`
- D1 Time Travel 恢复：`https://developers.cloudflare.com/d1/reference/time-travel/`
- Hono Node.js 运行：`https://hono.dev/docs/getting-started/nodejs`
- EdgeEver 服务端同步接口：`https://github.com/tianma-if/edgeever/blob/main/apps/api/src/sync-routes.ts`
- EdgeEver 桌面端同步：`https://github.com/tianma-if/edgeever/blob/main/apps/web/src/lib/desktop-sync.ts`
