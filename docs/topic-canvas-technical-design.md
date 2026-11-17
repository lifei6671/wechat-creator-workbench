# 专题画布与 GitHub README 导入技术方案

> 项目：wechat-creator-workbench
>
> 日期：2026-11-17
>
> 适用基线：Tauri 2 + Rust + SQLite + React + Milkdown
>
> 状态：已确定的首版功能设计，供 Codex 按阶段实施
>
> 设计规范：[桌面界面与交互设计规范](./ui-design-guidelines.md)；关联基线：[MVP 技术方案](./mvp-technical-design.md)

## 1. 目标和边界

在现有内容库之外提供「专题」主工作区：围绕一个选题，在无限画布中自由排列文章引用、截图和文本卡片，建立带说明的连线，并将研究过程逐步转化为原创文章。同时新增公开 GitHub 仓库 README 的导入能力，使 GitHub 项目、公众号文章和原创文稿都可加入同一专题。

### 1.1 产品约定

- **文章节点是引用**：指向现有 entries.id。引用不复制正文，可在不同专题出现；删除节点不删除原文章。公众号导入在桌面端当前可能创建 article，MCP 可能创建 reference，本专题一律依据 entry_id 关联，兼容两者。
- **截图节点是专题私有内容**：通过现有 Assets 服务存放文件，节点保存 asset_id，逻辑归属于所在专题；不提供跨专题复用入口。相同字节仍可能在底层按 SHA-256 复用文件或素材记录。
- **文本节点是专题私有内容**：content_md 直接保存在专题节点内，不创建 entries 记录，不进入全局文章目录和全文检索；可手动「创建原创文章」，再将当前节点替换为文章引用。
- **关系是画布局部连线**：仅关联同一专题中的两个 node_id。已有 entry_links 继续表示「从资料创建文章」的来源关系，不承担专题连线。
- **画布是主工作区视图**：专题展示区取代文章编辑区，使用 React Flow；点击文章节点可打开现有 Milkdown 编辑器。首版不改动现有 SaveQueue 的 Entry 会话模型。
- **所有业务写入经 Rust Workspace 服务**：Tauri IPC 与后续 MCP 可复用业务方法；画布不直接访问 SQLite。
- **首版单机单用户**：不引入实时协作、Yjs、向量数据库、图数据库或额外后端。

### 1.2 首版范围

| 能力 | 首版行为 |
| --- | --- |
| 专题 | 新建、重命名、删除、列出 |
| 画布 | 缩放、平移、拖动、调整卡片尺寸、保存与恢复坐标、自动定位新卡片 |
| 文章卡片 | 搜索已有内容并添加，允许同一篇文章在多个专题或同一专题中重复引用。双击在卡片内编辑正文 |
| 截图卡片 | 画布聚焦时粘贴系统截图、拖入图片文件，插入画布并预览 |
| 文本卡片 | 新建、编辑轻量 Markdown、阅读渲染、复制、从文本创建原创文章 |
| 关系 | 手动拉线、删除连线、修改简短说明；只连接同专题节点 |
| GitHub README | 公开仓库链接导入默认 README，原始 Markdown 存现有 entries，可加入专题，重复导入返回已有内容 |
| 数据 | SQLite 持久化、现有 S3 数据库备份包含专题元数据；本地图片文件继续遵循现有备份边界 |

首版不做自动布局、区域分组、自由绘画、便签共享、专题树、批量 README 导入、README 自动更新、跨专题关系图、智能相似推荐。专题的「文章列表视图」可后续补充，画布为首版默认展示。

## 2. 源码基线与复用点（2026-11-17 核对）

| 文件 / 模块 | 已有实现 | 接入点 |
| --- | --- | --- |
| src-tauri/migrations/0001_initial.sql | entries / sources / entry_links / assets / jobs / FTS | 新增专题表，不改文章主表与 entry_links |
| src-tauri/src/db.rs | MIGRATIONS、SCHEMA_VERSION 与事务迁移 | 新增 0016 迁移 |
| src-tauri/src/content.rs | Entry/EntryRow、create_entry、get_entry、SaveQueue 相关版本语义 | 新建 content/collections.rs，调用现有 Entry 服务 |
| src-tauri/src/wechat_import.rs | 微信链接去重、导入结果、图片导入 | GitHub 单独入口，复用通用业务约定，不混合域名规则 |
| src-tauri/src/commands.rs | import_markdown、内容 IPC | 增加专题、GitHub 导入命令 |
| src-tauri/src/assets/mod.rs | import / import_to_library / read / thumbnail、哈希去重 | 截图复用 attachment 导入与素材读取 |
| src-tauri/src/clipboard.rs | clipboard_read(accept_images, accept_html)，图片结果包含 asset id | 画布粘贴调用 desktop.readClipboard(true, false) |
| src-tauri/src/assets/cleanup.rs | referenced() 从文章正文、历史、封面搜集素材引用，退出时按哈希清理 | **必须纳入专题节点的图片引用** |
| src-tauri/src/assets/mod.rs 的 library() | 目前直接查询 assets 全表 | 专题独占截图在素材库列表的显示策略需同步处理 |
| packages/shared-types/index.ts | Entry、EntryRow、EntryPage、EntryFilter | 增加 Collection/CanvasNode/CanvasEdge 类型 |
| apps/desktop/src/desktop.ts | invoke 包装、readClipboard、assetImport、entries 等 | 新增专题和 GitHub IPC 包装 |
| apps/desktop/src/workspace/Explorer.tsx | Section / CreateMenu / ContentRow | 专题导航、现有文章选择/打开 |
| apps/desktop/src/workspace/DesktopShell.tsx | 导航、主工作区、SaveQueue、标签页 | 专题选中时渲染画布，不改 Entry SaveQueue |
| apps/desktop/src/workspace/Dialogs.tsx | 文章属性、既有来源关联入口 | 可展示文章所属专题；避免把来源关联当成画布连线 |

源码中尚无专题表；当前最新迁移为 0015_entry_pins.sql。实施前如仓库迁移序号已经变化，应按实际最新版本递增。

## 3. 核心模型和 SQLite 迁移

新增 src-tauri/migrations/0016_collection_canvas.sql；节点使用独立 node_id，不将 (collection_id, entry_id) 作为主键：同一篇文章可以以不同视角放置在同一画布的两个位置。

~~~sql
CREATE TABLE collections (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    viewport_x REAL NOT NULL DEFAULT 0,
    viewport_y REAL NOT NULL DEFAULT 0,
    viewport_zoom REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE collection_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL
        REFERENCES collections(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('entry', 'image', 'text')),
    entry_id TEXT REFERENCES entries(id),
    asset_id TEXT REFERENCES assets(id),
    content_md TEXT NOT NULL DEFAULT '',
    color TEXT CHECK (color IN ('red', 'orange', 'amber', 'green', 'blue', 'violet')),
    custom_color TEXT CHECK (
        length(custom_color) = 7
        AND substr(custom_color, 1, 1) = '#'
        AND substr(custom_color, 2) NOT GLOB '*[^0-9A-Fa-f]*'
    ),
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    width REAL NOT NULL DEFAULT 320,
    height REAL NOT NULL DEFAULT 200,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (kind = 'entry' AND entry_id IS NOT NULL
            AND asset_id IS NULL AND content_md = '')
        OR
        (kind = 'image' AND entry_id IS NULL
            AND asset_id IS NOT NULL AND content_md = '')
        OR
        (kind = 'text' AND entry_id IS NULL
            AND asset_id IS NULL)
    )
) STRICT;
CREATE INDEX collection_nodes_by_collection
    ON collection_nodes(collection_id, id);
CREATE INDEX collection_nodes_by_entry
    ON collection_nodes(entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX collection_nodes_by_asset
    ON collection_nodes(asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE collection_edges (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL
        REFERENCES collections(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL
        REFERENCES collection_nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL
        REFERENCES collection_nodes(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    CHECK(source_node_id <> target_node_id)
) STRICT;
CREATE INDEX collection_edges_by_collection
    ON collection_edges(collection_id);
~~~

设计说明：

1. 主键沿用项目既有 UUID/ULID 生成工具；时间使用 Unix 毫秒。foreign_keys 由当前 Workspace 初始化开启。
2. kind 的三类内容互斥：文章只存 entry_id，图片只存 asset_id，文本只存 content_md。普通文本节点可为空。
3. 来源文章可以软删除：专题仍保留 entry_id，列表/画布显示「已移入回收站」占位，恢复后重新可打开；不得因软删除破坏外键。
4. 删除节点自动删除其连接边；删除专题级联清除全部节点和边，文章主数据与素材物理文件不作同步硬删除。
5. 创建或更新连线时，Rust 在同一数据库事务内验证两个端点属于请求的 collection_id。外键确保存在性，业务判断确保跨专题不能连线。
6. 节点位置、尺寸单独更新，仅修改几何字段，不修改文章版本。文本更新只修改 content_md 和节点 updated_at。避免全节点快照覆盖导致的异步写入相互覆盖。
7. viewport_x/y/zoom 保存 React Flow 的视图坐标；首次进入空画布居中，新节点通过画布空间坐标生成。缩放和位移合法范围按当前 React Flow 配置约束。
8. 首版暂不持久化任意节点样式、嵌套分组、z-index、卡片背景或拖动过程历史，均无本期必要业务需求。

### 3.1 图片资产生命周期（必须和节点落地一起实现）

**当前真实风险**：src-tauri/src/assets/cleanup.rs 的 referenced() 只从 entries、entry_revisions、封面等来源采集图片引用。新的 collection_nodes.asset_id 若不参与引用判断，用户退出时专题截图可能被清理。

必须修改：

- referenced() 额外查询所有 image 节点的 asset_id，加入现有 ids 集合；后续沿用当前按 SHA-256 聚合、S3 远端先删再删本地的生命周期逻辑。
- 对未来允许文本卡片插入图片的需求再扩展 content_md 资源扫描；**首版文本卡片仅支持文本 Markdown，不支持图片嵌入**，图片使用专用节点。
- 截图走现有 Assets::import（对应 attachment/retain_on_exit=false），不要调用 import_to_library（其 retain_on_exit=true 会造成删掉专题后仍长期保留）。
- 删除截图节点只解除引用；实际文件在正常退出清理阶段按所有引用判断处理。若同哈希图片已在文章或素材库中使用，沿用哈希组保留规则。
- 现有 Assets::library() 查询 assets 全表。专题截图逻辑上只属于专题，因此全局素材库应过滤「仅由专题节点引用、没有文章/封面/主动保留等其他用途」的图片；同时保持列表数量与分页 COUNT 条件一致。不能简单排除所有出现过 collection_nodes.asset_id 的素材，否则会错误隐藏同时被文章使用的图片。
- 图片物理字节仍在统一 assets 目录，**专题私有指业务归属，并非加密/独立物理目录**；复用已有 S3 图床自动上传设置时可能产生远端副本，沿用现有上传行为，不在本期新增一套同步或隐私策略。
- 当前 S3 数据备份只有 SQLite，不包含本地图片。恢复后专题节点和文本仍在；若截图仅在本地且目标设备无文件则显示缺图占位，规则与已有文章图片一致。

### 3.2 文本节点与正式文章

- 文本 Markdown 直接保存在 collection_nodes.content_md；默认是简短文案、引用摘录、分析要点。
- 轻量渲染复用 markdown-core / 工作台已有 HTML 净化边界，禁止直接把不可信 Markdown 中的 HTML 插入 DOM。
- 双击进入纯文本 Markdown 编辑状态，离开编辑时保存；同时做短防抖，避免每次按键进入数据库。聚焦编辑器内 Ctrl+V 应粘贴到文本框，而非创建画布节点。
- 「创建原创文章」调用现有 EntryService 创建 kind=article/status=draft，正文复制自当前文本节点；创建成功后可以把原文本节点改成该文章引用，失败则保留文本节点。此转换不需要新版本体系或多端冲突框架。
- 不把文本卡片写入 entries_fts 或全局文章库；专题内部可按文本过滤节点，首版可只在画布内定位，无需独立搜索索引。

## 4. Rust 业务层和 IPC 契约

新增 src-tauri/src/content/collections.rs，以 Workspace 读写事务实现；不要为了这一功能另建泛化图数据库层。

| 命令（建议名称） | 请求 | 返回 | 数据范围 |
| --- | --- | --- | --- |
| list_collections | 无 | Collection[]（含节点数） | 全部专题 |
| save_collection | id?、title、description | Collection | 新建/修改 |
| delete_collection | id | void | 单个专题，级联节点 |
| get_collection_canvas | collectionId | {collection,nodes,edges} | 当前专题 |
| create_collection_node | collectionId、kind、payload、x、y | CanvasNode | 验证引用并创建 |
| update_collection_node_text | nodeId、contentMd | void | text 节点 |
| update_collection_node_color | nodeId、color（预设名、六位十六进制颜色或空值） | void | 单节点边框与背景颜色 |
| update_collection_node_geometry | nodeId、x、y、width、height | void | 单个节点几何 |
| delete_collection_node | nodeId | void | 单节点及边 |
| create_collection_edge | collectionId、sourceNodeId、targetNodeId、label | CanvasEdge | 同专题节点 |
| update_collection_edge | edgeId、label | void | 连线说明 |
| delete_collection_edge | edgeId | void | 连线 |
| save_collection_viewport | collectionId、x、y、zoom | void | 视图持久化 |
| list_entry_collections | entryId | Collection[] | 文章属性展示 |

类型新增 packages/shared-types/index.ts 中的 Collection、CanvasNode、CanvasEdge、CollectionCanvas。节点返回的 entry 摘要信息只用于显示，可通过已有 EntryRow 和预览计算投影；权威关联字段仍为 entry_id，不保存文章正文副本。

实现约束：

- 多个节点的位置更新采用同一请求批量写入（可增加 update_collection_node_positions），仅在批量拖动真正需要时实现；常规拖动结束后单个 IPC 更新即可。
- create/delete/update 方法使用现有 Workspace::write/read 与 AppError；React Flow 的内部 UI 事件不得直接执行 SQL。
- 不修改 entries.version、不调用普通文章 SaveQueue 保存画布。
- 同一工作区单进程；文本节点更新和几何更新分别只写其所属字段。连线和节点删除使用数据库外键级联。
- 若之后向 MCP 暴露专题操作，直接复用这些 Workspace 业务方法；本期不扩展 MCP 命令清单。

## 5. 前端交互与组件方案

### 5.1 组件选型与布局

首选 @xyflow/react（React Flow），复用成熟的节点、边、缩放、平移、NodeResizer、连接交互和可见性管理。沿用 Radix UI Themes、Lucide 图标及现有工作台 CSS 变量；遵守 docs/ui-design-guidelines.md。

推荐文件（按需建，不强制一次性建立所有目录）：

~~~text
apps/desktop/src/workspace/
  CollectionCanvas.tsx          # 专题主视图 + React Flow
  CollectionNodes.tsx           # EntryNode / ImageNode / TextNode
  CollectionToolbar.tsx         # 新建节点、适应画布、缩放
  CollectionPicker.tsx          # 搜索已有文章加入专题
~~~

首版主工作区切换方案：

1. Explorer.tsx 的 Section 增加 collections，导航显示「专题」列表。
2. DesktopShell.tsx 保存 activeCollectionId；选中专题时在主内容区域渲染 CollectionCanvas，取代当前 Milkdown 编辑区域。
3. 文章卡片双击进入原位编辑，使用保存队列写回原文章，并同步已打开的文章标签。右键选择「打开文章」可切换到文档主视图。
4. 专题与文章共用顶部标签栏，可重复选中已有标签或单独关闭。保存已打开的专题和最近选择的专题，画布视口按专题恢复。文章的 SaveQueue 会话仍由文章页管理。
5. 使用当前主题的灰阶和靛蓝强调色，卡片边框、选中态与工具栏按现有设计规范实现，避免新增一套视觉系统。

### 5.2 节点交互

| 行为 | 交互 |
| --- | --- |
| 新增文章 | 右键画布空白处选择「添加文章」，搜索并添加已有条目。也可右键文章，选择「加入专题」和目标专题 |
| 新增文本 | 右键画布空白处选择「新建文本」。双击或右键卡片进入编辑，失焦保存 |
| 新增截图 | 画布空白处获得焦点后 Ctrl/Cmd+V；desktop.readClipboard(true,false) 返回图片 asset id，逐张生成 image 节点 |
| 拖入图片 | 画布接受受支持的本地图片文件，调用已有 desktop.assetImport(file, "attachment")，完成后新建节点 |
| 普通文本粘贴 | 画布非文本编辑状态时，新建 text 节点；文本卡片编辑状态时正常插入选区 |
| 点击/双击 | 单击选中卡片，右键打开操作。双击文本或文章在卡片内编辑，双击图片进入尺寸调整 |
| 卡片工具条 | 单选后在卡片上方显示删除、设置颜色和聚焦。文本及文章还提供编辑。聚焦通过移动和缩放视口完成 |
| 编辑焦点 | 文本及文章失焦时保存，右键编辑菜单、链接和脚注等局部操作保留编辑状态。菜单项带图标，文章编辑菜单仅包含当前正文的操作 |
| 连线 | 从节点连接柄拖至另一个节点；创建 edge，可在属性操作中编辑标签；删除节点时自动删除关联 edge |
| 位置与尺寸 | 交互期间只更新本地状态，拖动/缩放结束写入 SQLite |
| 图片与边框 | 图片使用原图，按原始宽高比调整边框。卡片颜色同时用于边框和淡背景，预设色与自定义色独立于正文和几何信息保存。默认色以空值保存 |
| 快捷键 | 不劫持输入框快捷键；Delete 删除选中节点/边，Esc 退出操作状态；平台修饰键遵循既有约定 |

粘贴事件作用域应限定到获得焦点的画布，不覆盖 Milkdown、弹窗和文本输入。剪贴板接口当前已有图片导入的副作用：readClipboard(true,false) 会把读取的位图/文件导入 Assets，因此成功后直接消费返回的 asset id，不再对同一结果二次上传或入库。若插入节点失败，孤立素材继续由现有退出清理处理。

首版让文字内容和截图能单独调整卡片大小。文本卡片采用轻量输入组件，不在每张卡片内挂载 Milkdown。

### 5.3 画布渲染与保存

- 使用受控节点与边状态，按 node_id 做 React Flow id；entry_id 是业务引用，不可直接当节点 id。
- 节点组件定义在 CollectionCanvas 外部。文章卡片首次进入视口时读取 Markdown 正文，排版预览与原地编辑共用原文，保存走文章的版本校验。
- 初次打开有节点的画布时根据保存的 viewport 恢复。新专题的空白画布提示通过右键添加内容。
- 新节点放在当前视口中心附近，并沿网格轻量错位排列，避免完全重叠；不实现全局自动排版算法。
- 鼠标/触控板优先遵循 React Flow 默认交互并按实际 Windows/macOS 设备测试；输入区域加 no-drag/no-wheel 所需标记，避免正文选择/滚动导致移动画布。
- 正文内容更新与画布坐标保存走不同 IPC，操作成功后更新对应 React 状态，不重新加载整篇文章。
- React Flow 的 onlyRenderVisibleElements、简化远景节点等优化按实测开启；首版先控制复杂节点内容，避免为极端数据量引入自研虚拟列表/渲染器。

参考：
- https://reactflow.dev/learn/advanced-use/performance
- https://reactflow.dev/examples/interaction/save-and-restore
- https://reactflow.dev/api-reference/react-flow

## 6. GitHub README 导入

该功能与专题画布保持独立：导入后仍是一个普通 reference，可通过已有全文搜索、编辑、目录管理和专题选择器访问。

### 6.1 输入及导入流程

首版接受 https://github.com/{owner}/{repo} 仓库地址；若用户粘贴仓库的 README 网页地址，可先提取 owner/repo 后按仓库**默认 README** 导入。本期不支持指定分支或任意 README 子目录路径。

1. 在 Rust 校验 HTTPS、github.com 域名及 owner/repo 路径；去除跟踪参数并按仓库规范地址去重。
2. 先通过 sources + entries.source_id 检查已有对应来源，已有则返回 entryId，不覆盖用户本地编辑。
3. 请求 GitHub 官方 GET /repos/{owner}/{repo}/readme，采用 JSON 表示取得 path、sha、html_url、download_url、content（Base64）。对公开仓库允许无令牌；按 GitHub API 返回的限制、错误和文件大小约束提示用户。
4. 以 GitHub 返回的 README 路径和下载地址作为解析相对链接的基准。仅针对 Markdown AST 的链接/图片节点做转换，避免对代码块内容做正则替换。
5. 图片以合法的绝对远程 URL 留在 Markdown 中，复用现有外链图片读取；此期不强制下载所有 README 截图和徽章。普通相对超链接转为仓库对应文件 URL。
6. 用现有 Workspace 业务写入 kind=reference/status=unread 的 entries 和通用 sources；标题优先 README 一级标题，否则仓库名，来源 URL 为仓库规范地址；保留 Markdown 原文语义。
7. 成功返回 Entry ID，打开新内容或立即添加到当前专题画布。

建议新增 src-tauri/src/github_import.rs 及 github_import IPC，不依赖桌面当前打开的标签页；不把 GitHub 域名塞进 wechat_import.rs 的微信公众号下载白名单。请求规模、超时、错误映射复用项目现有网络边界约定，外部返回不直接执行脚本或动态 HTML。

来源字段当前 Source.account_name 在 Dialogs.tsx 被展示为「公众号」，新增 GitHub 资料时改用通用显示文案「来源平台」。GitHub 索引一开始不必新建 github_sources 元数据表；若下一阶段需要 SHA 更新检测、仓库改名跟随，再基于真实需求增加来源扩展。

官方资料：https://docs.github.com/en/rest/repos/contents#get-a-repository-readme

## 7. 任务拆分与建议执行顺序

| 阶段 | 文件和工作 | 完成条件 |
| --- | --- | --- |
| A. 数据层 | 0016_collection_canvas.sql，db.rs 迁移注册，content/collections.rs，基本测试 | 现有数据库升级，新建/删除专题和三类节点/连线均正确 |
| B. 素材生命周期 | assets/cleanup.rs 的 referenced 扩展；素材库仅专题引用图片的可见性处理 | 截图在专题存活期间正常保留，删除后遵循既有退出清理流程 |
| C. IPC 与类型 | commands.rs、main.rs、build.rs、capabilities/desktop.json、shared-types、desktop.ts | 前端可通过单一 typed API 调用专题操作，权限一致性测试通过 |
| D. React Flow 画布 | CollectionCanvas/Nodes/Toolbar/Picker/Dialog，Explorer、DesktopShell | 专题占据主视图，文章/图片/文本可添加、拖动、连接与重开恢复 |
| E. GitHub 导入 | github_import.rs、导入弹窗与创建菜单、来源属性显示 | 公开 README 可导入、去重、搜索和加入画布 |
| F. 回归与验收 | Rust、TypeScript、Tauri 命令权限、交互回归 | 验收清单通过并记录实测结论 |

落实数据库、业务和界面改造时，按本方案同步更新 docs/implementation-plan.md 的相关验收条目，不重排原有已完成阶段。涉及第三方依赖按现有 GPL-3.0 仓库的许可证与 NOTICE 规则登记；@xyflow/react 选择与项目当前 React 版本匹配的稳定版本，并固定锁文件。

## 8. 验收样例

### 8.1 数据关系与主功能

- [ ] 新建「浏览器自动化」专题，加入两篇 README、一篇公众号文章、一篇原创文章、三张截图与三段文本。
- [ ] 文章在 A、B 两个专题同时出现，编辑原文章后再次打开专题可看到最新标题/摘要；两个专题坐标独立。
- [ ] 一篇文章可在同一专题出现两个不同节点，node_id 不冲突。
- [ ] 截图、文本卡片不会自动创建 entries，不出现在全局目录；全局素材库不会展示仅用于专题的截图。
- [ ] 粘贴截图和普通文案后自动创建对应节点；在文本编辑框内粘贴不会额外创建节点。
- [ ] 截图拖动、改变尺寸、文本修改、节点连线及说明在关闭重开后恢复。
- [ ] 将文本卡片创建为正式原创文章，成功后原内容可在 Milkdown 编辑。
- [ ] 移除文章节点不删除文章；删除专题不影响其中的原文章。
- [ ] 将被引用文章移入回收站，专题呈现占位；恢复后引用重新可用。
- [ ] 专题连线无法连接另一专题的节点，删除任一端点后关联边自动删除。

### 8.2 素材与一致性

- [ ] 粘贴的截图只用于画布，关闭应用并重新打开仍可显示。
- [ ] 同一哈希图片同时用于文章和专题时，删除专题后该文件仍被文章保留。
- [ ] 删除最后一个截图节点后执行现有正常退出清理，最终无引用哈希组按原有规则回收。
- [ ] 创建/删除/移动画布节点不修改 entries.version，不触发普通文档的自动保存。
- [ ] 正在编辑文章时切换到专题，再返回文章，保留 SaveQueue 正文和选区/会话行为；关闭、退出继续沿用当前保存流程。
- [ ] S3 数据库恢复后的专题及文本、连线信息可读；本地缺失截图给出与现有素材一致的占位/错误提示。

### 8.3 GitHub 导入

- [ ] 导入一个含表格、代码块、相对图片和超链接的公开 README，内容在 Milkdown 中可正常阅读。
- [ ] 同一仓库二次导入返回已存在条目，不覆盖本地正文。
- [ ] 公开仓库未配置 GitHub Token 时可导入；不存在仓库、限流、超时得到明确诊断。
- [ ] 导入后的 reference 能与公众号 article、原创 article 一起加入专题。

### 8.4 性能与操作

- [ ] 在 Windows 11 和 macOS 上完成鼠标、触控板的画布拖动、滚轮、缩放、文本框内部滚动测试。
- [ ] 使用 100 个节点（含 30 张图片）、100 条边的测试专题，记录打开耗时、拖动帧耗时 P95 和内存占用；先用轻量自定义节点以及 React Flow 官方性能建议优化实际瓶颈。
- [ ] 在节点/连线增加与删除、截图粘贴、保存重开过程中，复核无异常全画布重新挂载、输入丢失或布局跳变。
- [ ] Rust 相关单元/集成测试、前端类型检查、Tauri 命令权限一致性测试通过。

## 9. 源码参考

- [Roseboard 架构](https://github.com/rankirito/obsidian-roseboard/blob/main/docs/ARCHITECTURE.md)：React Flow 画布、文章预览、节点状态与性能；学习局部实现，不复制整套 Obsidian 持久化。
- [Visual Notes Canvas 数据转换](https://github.com/dandersondev/visual-notes/blob/main/src/canvas-format.ts)：节点/边模型、JSON Canvas 转换；仅作为未来导出格式参考。
- [BlockSuite 无边界编辑数据结构](https://github.com/toeverything/blocksuite/blob/main/docs/components/editors/edgeless-data-structure.md)：内容数据与空间布局分离；本项目继续使用 Milkdown，不集成 BlockSuite 文档引擎。
- [JSON Canvas 格式](https://jsoncanvas.org/)：未来可考虑导入导出；当前 SQLite 表是本地权威数据源。
