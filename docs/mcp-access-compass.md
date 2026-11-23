# MCP 技术访问罗盘

**设计目标**是让作者能一次接入自己的 Agent，然后在对话里完成从找资料、整理专题到交付排版稿的工作。第一次接入的完成标志是 Agent 通过作者选择的客户端，成功读到当前工作区的内容。内容接管的完成标志是 Agent 写入的成果能在桌面继续编辑、核对和恢复。

建议先改善接入，同时开放已有的内容检索能力。下一步补齐写稿、归档、专题画布和素材引用，最后打通带图导出与公众号排版。沿用桌面应用内置的 Rust MCP 服务、本机回环地址和 SQLite 领域服务。本文是基于提交 `9018de2` 的设计提案，下面的现状表列出该版本已提供的能力。

**首版实施进展。** 设置页已提供含凭据的客户端配置，并在成功读取后显示客户端和时间。只读连接仅列出读工具。`list_entries` 支持 `limit`，`search_entries` 可传 `{"mode":"workspace","query":"section:写作","filter":{"limit":3}}` 获取桌面搜索的命中行、片段和版本。省略 `mode` 的调用保持原有关键词语义。[当前使用方法](./getting-started.md#本机-mcp)

## 1. 从设置页到第一次成功读取

工作台在本机提供 Streamable HTTP 服务，默认关闭。启用后默认只读并监听 `http://127.0.0.1:17321/mcp`。参照 Anytype 的接入方式，工作台将实际端口与当前凭据填入个人客户端配置。用户复制一次并保存，之后从桌面图标或新终端启动客户端，都能复用这条连接。[Anytype MCP 接入方式](https://github.com/anyproto/anytype-mcp#2-configure-your-mcp-client) / [本机 MCP 使用指南](./getting-started.md#本机-mcp)

| 操作或可见元素 | 用途 |
| --- | --- |
| 启用 MCP、运行状态 | 启动服务并确认监听成功，查看当前权限。 |
| 客户端 | 选择 Codex 的 TOML 或 Claude Code 等客户端使用的 JSON。 |
| 客户端配置、复制 Codex 配置、复制客户端配置 | 把服务名、运行地址和 Bearer 请求头复制到剪贴板。只粘贴到本机的个人客户端配置。 |
| 最近成功访问 | 显示实际完成业务读取的客户端名称和时间。名称来自握手，只作显示。 |
| 高级设置 | 调整权限和端口，停止服务，或停止后重置令牌。端口或令牌变更后，更新客户端保存的配置。 |

Codex 使用个人 `config.toml` 中的 `http_headers.Authorization`。Claude Code 使用个人 `~/.claude.json` 中的 `headers.Authorization`。工作台在原生进程内读取系统凭据库，生成配置后直接写入剪贴板。客户端保存的配置含有可用令牌，应作为个人凭据文件保管。[Codex MCP 配置](https://developers.openai.com/codex/mcp/) / [Claude Code MCP 配置](https://code.claude.com/docs/en/mcp)

### 验证连接

保存配置并重启目标客户端后，可将下面这句话发给 Agent。

> 用 wechat-workbench 的 list_entries 读取最近三条，告诉我标题和类型。

客户端完成初始化后调用 `tools/call(list_entries, {"limit":3})`。成功返回条目或空列表都算读通。认证失败时检查个人配置中的请求头是否需要更新，端口不通时检查已生效地址和工作台运行状态。[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) / [MCP 工具调用](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## 2. 现有能力和缺口

当前注册了 **9 个工具，6 个读取、3 个写入**。读写连接使用相同的工具路由，只读连接也能发现写工具，在实际调用时收到 `MCP_READ_ONLY`。服务端目前只声明 tools，未提供工作区使用说明。默认的只读权限已覆盖正文。[工具注册、鉴权和返回值](../src-tauri/src/mcp/tools.rs)

| 工作内容 | MCP 当前能做什么 | 桌面已有能力或具体缺口 |
| --- | --- | --- |
| 浏览与检索 | `list_entries`、`search_entries`、`get_entry` 能按类型、状态、分类、标签和偏移量检索，再取 Markdown 正文和版本 | MCP 将关键词传给 `Filter.query`。桌面的 `workspace_search` 还能按路径、标签、章节查询，返回命中片段和定位版本。Agent 暂时只能读全文来确定匹配位置。[搜索实现](../src-tauri/src/content/search.rs) / [条目查询](../src-tauri/src/content.rs) |
| 写稿与组织 | `create_entry`、`update_entry` 能创建灵感、资料、文章，用 `expectedVersion` 修改正文、状态、标签、所属分类、摘要及部分发布属性。`list_categories`、`list_tags` 可查分类和标签 | 已经可以把文章移入已有分类。尚缺建文件夹、组织目录、设置封面和自定义属性、从来源派生草稿、局部改文、查看保存版本、移入和恢复回收站。[条目字段与版本](../src-tauri/src/content.rs) / [分类操作](../src-tauri/src/content/taxonomy.rs) |
| 采集 | `import_wechat_article` 提交公开公众号链接，`get_job_status` 查询任务和缺图情况 | 桌面另有网页、GitHub README、剪藏和 Markdown 导入。公众号链接首次导入时，现有 MCP 建未读资料，桌面入口建文章草稿。复用实现时需要保留各入口的目标及已有来源去重规则。[公众号导入](../src-tauri/src/wechat_import.rs) / [链接与剪藏导入](../src-tauri/src/link_import.rs) |
| 专题画布 | 现有工具无法读取专题结构和操作卡片 | 桌面可组织条目引用、文本、图片、网页四类节点和连线。节点文本、位置、连线标签等写入尚无面向外部客户端的预期版本参数。[画布业务方法](../src-tauri/src/content/collections.rs) |
| 素材与排版 | 条目正文可包含已有 `asset://` 引用，发布属性可随条目读取和部分更新 | Agent 缺少素材浏览、缩略图、导入图片、推荐文章解析和带图导出入口。公众号排版使用 TypeScript 渲染器和桌面图片处理能力，部分输出路径可能上传图床。[素材入口](../src-tauri/src/assets/commands.rs) / [排版与图片处理](../apps/desktop/src/workspace/Publishing.tsx) |
| 写作对话 | 外部 MCP 没有写作会话工具 | 应用内 AI 会保存会话、消息和改写提议。需要引用作者以前的讨论时，可单独授权会话读取。工作区内容读写和启用内置 AI 是两个独立选择。[会话存储](../src-tauri/src/ai/conversations.rs) / [内置 AI 接入](./getting-started.md#ai-助手) |

## 3. 同类产品给出的取舍

| 参考 | 产品做法 | 工作台采用的部分 |
| --- | --- | --- |
| Notion | 团队早期把 API 逐项映射为工具，随后为 Agent 重设搜索、创建和更新接口，以 Markdown 表达文档，减少获取和修改正文的调用次数。[Notion 工程复盘](https://www.notion.com/en-gb/blog/notions-hosted-mcp-server-an-inside-look) | 搜索先返回证据片段和稳定 ID，编辑围绕章节或原文。用户说“整理资料”时，Agent 可以按任务组织调用。 |
| Outline | 官方指南按客户端提供配置方式，给出服务开关、鉴权和工作区指引。支持 OAuth，也给出 Bearer API key 接入。[Outline MCP 指南](https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL) | 设置页生成客户端专用说明。服务端在工具发现时提供工作区对象关系和写入约定，用户第一次对话就能验证读取。 |
| Anytype | 本地优先知识库在应用内签发密钥、提供可复制的接入配置，工具覆盖搜索、对象、列表、属性和标签。[Anytype 官方 MCP](https://github.com/anyproto/anytype-mcp) | 工作台生成含令牌的个人客户端配置。工具按稿件、分类、专题、卡片和素材组织。 |

## 4. 按创作任务设计工具

下列新增工具名为建议契约。把现有 9 个名称、参数和返回字段作为兼容基线。能力发现使用标准 `tools/list` 和服务端 `instructions`，按当前连接的授权列举工具，调用时仍执行服务端鉴权。可增加一个小型只读 `get_workspace_info`，返回工作区 ID、有效权限、条目类型及各自合法状态，供 Agent 确认连接目标。实际工具清单始终取自协议。只实现 tools 的客户端也应能跑通全部核心任务。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

| 作者交给 Agent 的任务 | 建议契约与结果 |
| --- | --- |
| “找出正文里提到离线写作的资料，告诉我依据。” | 保留 `search_entries` 原有关键词语义。增加可选的桌面搜索模式、结果上限与片段选项，接入 `WorkspaceSearch`。返回条目 ID、标题、匹配行、片段、版本、`nextOffset`。长文按需取章节或行范围。专题和卡片可以按专题浏览，再按类型和文字检索。 |
| “给我正在写的这篇文章补个结尾。” | 增加只读 `get_active_context`，由主窗口提供当前文章或专题 ID、已保存版本和是否有待保存编辑。没有打开内容时返回空。对当前稿件操作先等保存完成再按 ID 读取。用户明确分享选区时才传递选中文字。 |
| “从这篇资料建草稿，把结论改成两段。” | 扩展 `create_entry` 支持已有的来源条目关系，返回新稿 ID。扩展 `update_entry` 支持封面、主题、自定义属性等当前可编辑字段。新增 `edit_entry_text(id, expectedVersion, oldText, newText)`，在指定版本的 Markdown 中仅替换唯一匹配。零处或多处匹配返回可定位错误，Agent 重读目标段落后再改。 |
| “把选中的稿件归档，找回昨天放进回收站的稿子。” | 归档复用状态字段。分类创建、重命名、移动复用 taxonomy。条目标签按名称写入、按标签 ID 筛选。整库改标签名时先列出受影响条目，再事务更新关联并处理重名目标。另提供 `trash_entry`、`restore_entry`、回收站列表及历史版本读取。恢复某一稿正文时以当前版本保存所选内容，保留版本递增。置顶、排序要明确目录或时间流作用域。 |
| “把这些链接和截图整理成选题画布。” | 增加 `import_link`、专题列表、创建专题、`get_collection_canvas` 和 `apply_canvas_changes`。一次提交新建条目引用、图片、网页、文本卡及它们的连线，用请求内临时标识引用刚创建的卡片，返回持久 ID 映射。Agent 可用默认布局，只有用户指定排布时才需要传坐标。移除引用卡保留原条目。 |
| “用素材库里这张截图作封面，在正文第二节再引用一次。” | 提供分页素材列表、按 ID 取详情和缩略图，结果带可用于 Markdown 的 `asset://<id>`。导入返回素材 ID，由保存正文或封面的领域逻辑登记引用。用户提供的图片字节或公开图片地址走现有素材导入。本机大文件通过用户选定的文件句柄导入，避免把原图塞进工具描述或突破当前 1 MiB HTTP 请求体上限。 |
| “按公众号主题排好，导出一份能检查的稿件。” | 先提供主题与推荐候选读取、推荐有效性校验，再提供 `export_entry(id, expectedVersion, format)`。Markdown、普通 HTML、公众号格式分别遵循现有输出规则，返回实际格式、缺图情况、产物引用。带图文件写入约定的工作台导出目录，返回可取回的产物。上传图床须显式请求，公众号后台最终群发仍由作者操作。[公众号输出规则](./wechat-publication-technical-design.md) |
| “参考我上次讨论的提纲继续写。” | 需要此能力时，为指定会话单独授权读取。工具按文章列出会话摘要，按会话 ID 分页取消息。正文修改沿用同一套文章版本检查。 |

**一次跨工具调用的预期结果。** 作者说“把这篇 README 和我已有的两篇离线写作资料整理成专题，再起一份草稿”。Agent 先搜索并返回两篇资料的标题和命中片段，再导入 README 并取得实际条目 ID。随后创建专题，一次提交三张引用卡、一张提纲卡和连线，创建草稿并把草稿 ID 作为引用卡加入专题。回执列出专题、草稿和三条来源，作者打开画布即可继续写。如果导入已完成而画布写入失败，回执保留已导入条目 ID。重试从画布开始。如果提交后只丢了响应，先重读专题核对已落库的引用，再补缺少的操作。

## 5. 实现时需要守住的契约

**共享业务入口。** 调用关系为 `MCP 工具 / Tauri 命令 → Rust 领域方法 → Workspace 事务`。已有的 `update_external`、`set_deleted`、`revisions`、素材服务和任务查询可直接复用。对于携带副作用的 Tauri 命令，先提取桌面和 MCP 都能调用的操作，例如删除网页卡片还要清预览缓存。网络获取在数据库事务外执行，事务提交后发出相应的 `workspace-changed`、`assets-changed` 事件。离线变更继续走现有同步记录和冲突机制。MCP 成功表示本机提交完成，远端同步状态按既有同步流程报告。[桌面命令](../src-tauri/src/commands.rs) / [同步提交](../src-tauri/src/sync/contents.rs) / [现用官方 Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)

建议用一篇已有的 GitHub 资料做读路径对照。桌面 `get_entry` 还会调用 `with_github_images` 转换符合条件的历史正文，MCP 的同名工具直接返回数据库条目。应把这一步归到共享读取路径，并用同一条历史记录核对正文和图片。对于需要按原文定位的编辑，匹配基线也应采用 Agent 刚读到的同一表示。[桌面读取入口](../src-tauri/src/commands.rs) / [GitHub 历史内容转换](../src-tauri/src/content.rs) / [MCP 读取入口](../src-tauri/src/mcp/tools.rs)

**编辑并发与恢复。** 条目读取返回 `version`，所有覆盖性写入都带 `expectedVersion`。已有 `VERSION_CONFLICT` 返回 `currentVersion`。Agent 应重读、比较、重算改动。普通外部保存目前走 `SaveMode::External`，不会自动创建整篇覆盖前快照。新增整篇覆盖或历史恢复入口时，应在同一事务先留存旧正文，沿用历史条数策略。桌面有未保存稿时保留本地编辑和冲突处理入口，空闲编辑器才重载。验收需同时检查主编辑区和专题内编辑器。[条目保存](../src-tauri/src/content.rs) / [编辑保存队列](../apps/desktop/src/editor/save-queue.ts)

**画布批改。** `apply_canvas_changes(collectionId, expectedRevision, operations)` 需要真正的画布内容修订号。建议在本地数据库记录单调递增值，由专题描述、节点和连线的增删改共同推进，覆盖桌面写入、MCP 写入和远端回放。视口平移缩放独立保存。已有库升级时初始化基线。检查修订号、校验引用属于该专题、应用操作和记录同步变更必须在一个事务完成，失败时整批回滚。现有方法各自打开事务，批改应抽出接受事务的内部操作。桌面尚未落库的卡片文本或拖动也要纳入协调。有未提交改动的画布先完成保存或明确返回忙，桌面延迟回写同样检查基线。单靠 MCP 入口比较时间戳挡不住旧的桌面保存。[画布存储](../src-tauri/src/content/collections.rs) / [同步回放](../src-tauri/src/content/collections/sync.rs)

**权限和外部影响。** 初次连接默认只读，普通内容读写由作者一次授权，涵盖稿件、分类、画布和可恢复的内容操作。现有单令牌的权限对所有持有方共同生效。开放多客户端独立授权时，将旧令牌映射为原有权限的旧连接，新连接使用独立凭据及权限，可单独撤销。撤销和降权同时终止对应活动会话。对于会话历史、图床上传和不可逆的整专题删除，分别按连接显式授权，升级不替旧连接开启这些能力。整专题删除目前会直接删除专题及从属内容，开放前返回将影响的卡片和连线数量，并在执行时核对同一修订号。备份恢复、同步管理密钥、模型凭据和永久清空回收站留在桌面管理入口。认证沿用本机 Bearer、系统凭据库、回环监听及 Host / Origin 校验。诊断只记录工具名、结果码和必要的连接信息。[本机服务](../src-tauri/src/mcp/mod.rs) / [专题删除语义](../src-tauri/src/content/collections.rs)

**导入、排版和大结果。** 公众号继续使用后台任务 ID，沿用状态查询和未完成图片数。网页与 GitHub 接入保留来源、重复匹配和已在回收站的结果，返回已有条目时让 Agent 知道是否需要恢复。列表先给摘要，原图、长正文和导出物按需读取。排版复用 `packages/wechat-renderer`。现有 `renderForPublication` 依赖桌面图片解码和 Tauri 能力，Rust 不能直接调用它。建议先交付 Rust 能直接提供的 Markdown 输出，再通过带请求 ID 的桌面渲染请求传入已保存的文章快照，返回独立产物。以目标条目 ID 和版本绑定结果，渲染端退出或超时返回明确错误。只读预览使用已保存配置，推荐重算写回与图床上传分别走授权的写操作。[渲染包](../packages/wechat-renderer/index.ts) / [桌面渲染适配](../apps/desktop/src/workspace/Publishing.tsx)

## 6. 实施顺序与验收

| 阶段 | 实现范围 | 可观察的完成条件 |
| --- | --- | --- |
| 1　接通第一个 Agent | 在设置页原型中确认客户端选择、复制个人配置与最近成功访问，再接入动态配置、服务指引和按权限发现。更新使用指南。 | 在 Windows、macOS 分别使用 Codex CLI、Claude Code 按生成配置接入并在重启后复用。默认及自定义端口可用，空库也验证成功。错误令牌无法读取，只读连接无法写入。用户全程无需把令牌贴进聊天。 |
| 2　完成一篇稿件 | 开放桌面全文检索、局部编辑、稿件属性、来源派生、目录整理、历史与回收站，以及已有素材的查找和引用。 | 仅靠客户端从命中片段找到资料，派生草稿、修改指定段落、设封面、归档、恢复。桌面同时修改时旧版本写入返回冲突，作者未保存的文字仍可找回。旧客户端的原有调用继续有效。 |
| 3　完成一个专题 | 开放网页、GitHub、剪藏与素材导入。补齐专题读取、卡片和连线批改、画布并发控制。 | 用第 4 节的 README 场景验收。在另一个桌面窗口或设备改动后重试旧画布批次，验证无半成品、无重复来源和无静默覆盖。重开专题可见完整结构，图片仍可读取。 |
| 4　交付可用的排版稿 | 完成带图文件、公众号格式、推荐校验和显式图床上传。多客户端授权先于敏感能力上线。有写作历史需求时再开放指定会话。 | 同一版本、主题和素材输入的 MCP 产物与桌面导出对照。检查普通 HTML 和公众号格式的推荐区差异、图片可用性、失败回执，以及撤销一个客户端后另一个仍按原权限工作。公众号格式用真实草稿保存后重开检查。 |

首个开发批次建议只选阶段 1 和阶段 2 的全文检索。用一个全新客户端，让作者只靠设置页说明完成“找出一条资料并给出原文依据”。如果这条路径需要开发者口头解释，先修接入说明或搜索结果，再扩展写工具。
