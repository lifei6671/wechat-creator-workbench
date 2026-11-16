# 微信创作工作台：成熟 Obsidian 功能内置化技术方案

> 状态：待实施 · 2026-11-16  
> 项目：wechat-creator-workbench  
> 适用范围：Windows 11 / macOS；Tauri 2 + React + TypeScript + Milkdown / ProseMirror + Rust + SQLite  
> 配套文档：[MVP 技术方案](./mvp-technical-design.md)、[实施计划与验收](./implementation-plan.md)、[AI 写作助手](./ai-writing-assistant-technical-design.md)、[UI 规范](./ui-design-guidelines.md)  
> 执行者：Codex / 工程开发者

## 1. 目标、边界与决策

本方案的目标是将成熟开源插件中与**微信公众号创作者**直接相关的功能内置到工作台，优先完善「收集灵感 → 管理素材 → 写作与 AI 修改 → 长文整理 → 公众号排版 → 提交草稿」的实际流程。

**确定的架构决策：**

1. 采用**功能提取与原生集成**，不兼容 Obsidian 插件运行时、不实现第三方插件市场、不引入 vault 文件模型。Markdown 正文唯一持久化来源仍是 SQLite 的 `entries.content_md`。
2. 独立、成熟、许可证兼容的 TypeScript 逻辑优先选择性复用；与 Obsidian 的 `App`、`Vault`、`Editor`、`Plugin` 等 API 强耦合的代码仅借鉴行为和交互，接入现有 Milkdown/ProseMirror。
3. 保留现有内容服务、`SaveQueue`、关键历史、`asset://` 素材标识与清理生命周期。所有持久化写操作由 Rust 业务服务处理，MCP 与桌面端保持同一规则。
4. 现有公众号排版采用 Plainly 抽离的 `packages/wechat-renderer`；本次只增量扩展主题、发布流程及后续可选草稿接口。
5. 功能优先级服从用户写作流程，不以插件下载量、功能数量或可复制代码量决定实施顺序。保持 `docs/ui-design-guidelines.md` 的紧凑桌面工作区与 Radix 交互规范。

**交付边界**：当前执行的是技术设计；本文列出的功能、数据库变更和外部服务验收均为后续任务，不将规划视作已完成的开发结果。

## 2. 现有代码基线与差距

以下基于 2026-11-16 对本仓库实际路径及现有文档的检查。Codex 开始每个工作包时须重新检查最新源码；工作区已有大量未提交变更，不得覆盖它们。

| 能力 | 已有实现 / 源码入口 | 本次增量 |
| --- | --- | --- |
| 编辑与长文 | `packages/editor-react/index.tsx`：Milkdown、`MarkdownEditorHandle`、`captureContext`、`replaceTarget`、事务与撤销；`apps/desktop/src/workspace/Document.tsx` | 可折叠、可搜索、可拖动章节的独立大纲 |
| 保存与关键历史 | `apps/desktop/src/editor/save-queue.ts`；`src-tauri/src/content.rs`；`entry_revisions` | 大纲移动、格式化与 AI 修改复用保存队列，不增加第二套历史 |
| AI 辅助写作 | `apps/desktop/src/workspace/AiPanel.tsx`、`apps/desktop/src/ai/{context,proposals,runtime}.ts`；`docs/ai-writing-assistant-technical-design.md` | 优化快捷提示、上下文引用与提案交互，不重复实现聊天运行时 |
| 图片与素材 | `apps/desktop/src/workspace/Assets.tsx`；`src-tauri/src/assets/{mod,commands,references,cleanup,publishing}.rs`；`asset://`、SHA-256 去重、S3 图床 | 图片批处理、命名/筛选体验、文章图片诊断，复用原素材生命周期 |
| 公众号排版 | `packages/wechat-renderer/index.ts`、`apps/desktop/src/workspace/Publishing.tsx`、`Document.tsx` | 进一步增强发布预检；官方草稿箱提交单独实施 |
| 导入与采集 | `wechat_import.rs`、`Publishing.tsx`、`DesktopShell.tsx`，支持微信公众号文章 URL 与本地 Markdown 导入 | 快速创建灵感/资料、模板填充、剪贴板文本采集 |
| 内容状态 | `src-tauri/migrations/0001_initial.sql`，`entries.kind/status`；`entry_links` | 使用现有状态构建轻量选题看板 |
| 检索与智能体 | `src-tauri/src/content/search.rs`，FTS5 trigram；`src-tauri/src/mcp/{mod,tools}.rs`，本机 Streamable HTTP | 搜索结果体验和能力补充，优先沿用已有 MCP |
| 界面 | `CommandPalette.tsx`、`DesktopShell.tsx`、`StatusBar.tsx`、Radix Themes | 在原命令面板、侧栏和状态栏加入入口 |

**当前核心判断**：真正需优先新增的是长文结构整理、格式规则、快捷模板和创作看板；图片、AI、公众号与 MCP 已有基础，应该沿现有代码做功能增强。Word Count、Dataview、Omnisearch 等能力不作为独立移植项目。

## 3. 外部开源仓库复用评估

以下仓库链接、公开许可证和功能方向截至 2026-11-16 已核对。具体要复制的文件、函数和提交哈希**尚未锁定**：执行工作包时先查看源码依赖闭包，再确定可提取范围，并将真实来源写入 `NOTICE.md`。

| 候选仓库 / 源码入口 | 许可证 | 可借鉴能力 | 本项目复用方式与限制 |
| --- | --- | --- | --- |
| [Quiet Outline](https://github.com/guopenghui/obsidian-quiet-outline/tree/master/src) | MIT | 大纲搜索、展开/折叠、拖动章节、键盘导航 | **交互设计为主**；树结构由 ProseMirror 文档生成，Obsidian 编辑器适配代码不能直接运行 |
| [Obsidian Linter](https://github.com/platers/obsidian-linter/tree/master/src) | MIT | 独立格式化规则、规则配置、文本检查 | **选择性提取纯规则逻辑**；先只引入与现有 Markdown 语法兼容的安全规则 |
| [Image Manager](https://github.com/davidvkimball/obsidian-image-manager/tree/main/src) | MIT | 图片导入、命名、远程图片本地化、管理界面 | **复用纯处理逻辑/交互**；文件存储、URL 与删除一律交现有 AssetService |
| [Claudian](https://github.com/YishenTu/claudian/tree/main/src) | MIT | 选区改写、上下文引用、差异预览、快捷指令 | **重点研究交互实现**；保留现有 assistant-ui、Rust AI 服务与提案状态 |
| [QuickAdd](https://github.com/chhoumann/quickadd) | MIT | 快速捕获、模板、常用工作流命令 | **抽取轻量模板与命令思想**；不引入其宏脚本执行器或 Obsidian 命令总线 |
| [TaskNotes](https://github.com/callumalpass/tasknotes) | MIT | 任务视图、筛选、日历与看板交互 | **借鉴任务视图**；本项目的 Entry 是 SQLite 行而不是一任务一 Markdown 文件 |
| [WeChatPB](https://github.com/Kianzzz/wechatPB/tree/main/src) | MIT | 公众号多账号、主题、图片处理、草稿提交 | **研究可移植协议与发布逻辑**；项目社区规模小，须核实接口可用性 |
| [WeChat Publisher](https://github.com/RanceLee233/wechat-publisher) | MIT | 微信排版预览、草稿提交、异常提示及流程 | **产品体验参考**；仓库主要提供构建产物，不能假设拥有可复用的完整源模块 |
| [Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api) | MIT | 标题级局部编辑、搜索、版本条件写入、MCP | **协议对照**；已有 Rust MCP，不再新建本机 HTTP 服务 |
| [Novel Word Count](https://github.com/isaaclyman/novel-word-count-obsidian) | MIT | 长文统计与写作目标 | 低优先级；优先检查现有状态栏字数统计 |

**筛选规则**：复制源码的收益必须覆盖 Obsidian 依赖剥离、类型/API 适配、测试和后续维护成本。复制前固定上游提交 SHA、文件清单、原许可证和修改说明；确认实际代码与仓库声明的许可证一致。MIT 代码随 GPL-3.0 项目分发时保留版权与许可证文本，新增第三方依赖信息写入 `NOTICE.md`。第三方源代码还可能包含不同许可证的内嵌资产、依赖或主题，逐项核对。

## 4. 统一集成架构

`React / Radix UI` 提供大纲、模板、任务看板和发布入口；`packages/editor-react` 只负责编辑器文档结构、事务操作和快照；`packages/markdown-core` 处理与界面无关的格式规则；`packages/wechat-renderer` 负责排版转换；Rust 服务持久化内容、元数据、素材、账号与任务。通用入口通过现有 `apps/desktop/src/desktop.ts` 调用 IPC；MCP 使用相同 Rust 业务服务。

### 4.1 文档修改的统一路径

~~~text
用户拖动章节 / 运行格式化 / 接受 AI 改写
                  │
        编辑器生成修改预览或意图
                  │
        Milkdown / ProseMirror 事务
                  │
            onChange → SaveQueue
                  │
       save_entry(expectedVersion)
                  │
        Rust EntryService → SQLite
~~~

- **结构操作**：使用当前 ProseMirror 文档节点与 `tr`/`mapping`，禁止把 ProseMirror `from/to` 当作 Markdown 字符串偏移。
- **完整内容变更**：只有当前编辑会话有效且用户明确确认才应用；既有 `SaveQueue` 负责持久化与版本冲突。
- **撤销**：章节拖动、局部格式调整、AI 选区接受都尽量形成单次撤销边界；不将每次操作写为 `entry_revisions`。
- **异步一致性**：保存操作绑定原文档 `entryId`、编辑会话和本地修订号；用户切换/关闭标签或继续编辑时，旧操作不能写到新文档。

### 4.2 图片与公众号边界

图片 URL 以现有 `asset://<id>` 为准；新功能不自行维护另一套磁盘资源索引，不直接物理删除文件或 S3 远端对象。重命名优先修改展示名，不改变哈希文件存储路径；公众号输出由既有 `renderWechat` 和发布素材解析机制生成。

## 5. 工作包 X1：长文大纲（首期优先）

**用户场景**：撰写长篇公众号文章时，在侧栏看到标题树，快速跳转、搜索标题、收折章节、拖动整个章节，并撤销误操作。

**借鉴**：Quiet Outline 的大纲层级、搜索、展开/折叠、拖放反馈；数据与修改使用 Milkdown 原有模型。

**实施范围**：

1. 从当前 `editorView.state.doc` 遍历标题节点，生成只读的 `OutlineItem { id, level, title, from, to, children }`。`id` 是当前会话派生键，不入库；定位点随编辑事务重算或映射。
2. 在现有工作区适合的位置加入可折叠大纲面板，沿用 Radix 主题令牌；打开新文章时同步对应标题树；只读/阅读模式支持跳转。
3. 点击标题时由 editor handle 提供 `scrollToHeading(...)`（实际名称执行时确定），滚动并设置编辑器选择；搜索只过滤侧栏展示，不修改正文。
4. 拖动章节时识别从目标标题到下一个**同级或更高级标题**之前的整个章节范围，包含正文、子标题、表格与图片。相同章节内拖动、拖入自身后代为无效目标；跨级移动第一版只允许同级排序。
5. 使用 ProseMirror 事务移动完整块片段；撤销恢复原顺序。正文更改触发既有保存队列。
6. 不将目录树保存到 SQLite，不增加标题版本表；重新打开文章由 Markdown 内容重建。

**建议代码边界**：`packages/editor-react/index.tsx` 暴露必要的只读大纲接口及章节移动动作；可在同包新增 `outline.ts` 存放纯遍历/范围计算；UI 在 `apps/desktop/src/workspace/` 新增 `Outline.tsx` 并接入 `Document.tsx` / `DesktopShell.tsx`。

**验收**：三级标题、重名标题、空标题、表格、图片、代码块、引用和脚注不破坏结构；移动完整章节后 Markdown 往返结果与预期一致；单次撤销可恢复；切换文档后不发生串文档移动；5 万字文章中展开/跳转交互保持可用。

## 6. 工作包 X2：Markdown 规范化与素材增强

### 6.1 Markdown 规范化

**用户场景**：将 AI 生成、复制粘贴或外部导入的正文整理成公众号排版需要的稳定 Markdown，同时保留内容原意。

第一版提供「检查格式 → 预览变化 → 应用到本文」；不在每次自动保存时自动重写全文。规则从 Obsidian Linter 中逐条选择，优先实现标题前后空行、列表标记一致、行末多余空格、连续空行与常规标点空格等**独立且可测试**的规则。中文与英文/数字之间的空格可作为显式可选项，不能改动代码片段、链接 URL、行内公式、HTML 标签内容或合法的 Markdown 换行语义。

- 算法独立放在 `packages/markdown-core`，输入输出均为 Markdown 字符串；规则按固定顺序执行并保证幂等。
- 格式化前后显示文本差异；点击应用时通过当前 Milkdown Schema 解析，确认支持的节点和属性完整保留后再提交替换事务。无法无损还原的结构保持原文并提示用户。
- 不使用随处替换的全局正则直接覆盖原文；不要通过前端调用 Rust 的 `save_entry` 绕开正在编辑的文档。
- 可复用现有 `diff` 依赖和 AI 提案差异交互，不新建同类差异组件。
- 首期不移植全部 Linter 规则、YAML frontmatter 操作、自动保存钩子和用户脚本引擎。

**验收**：连续格式化两次得到相同输出；代码块、公式、Mermaid、脚注、表格、图片 `asset://` 和自定义警示块保持原义；应用可撤销；修改后保存与版本冲突按原有队列执行。

### 6.2 图片与素材增强

已具备导入、粘贴、拖放、SHA-256 去重、图床、缩略图和独立素材库，因此本次聚焦：

1. 文章维度的图片清单：展示当前稿件全部引用、封面、尺寸、文件名以及本地图床状态，复用 `entry_assets`、`AssetService` 与现有素材面板。
2. 素材展示名修改、复制引用或插入到当前文章；改名只改元数据，保留稳定 `asset://` ID。
3. 多图批量重命名/导出或转换压缩按实际需求分批落地；转换产生新图片时必须通过 `AssetService` 登记新资源及引用，不能直接覆盖共享哈希文件。
4. 优先利用现有 `assets` 表和 `AssetRow` / 业务方法；只有确实需要持久化新的字段时才编写迁移。
5. 用户删除或替换引用后，仅更新正文/封面引用，遵循仓库既有退出时哈希组清理与远程目标删除规则。

**验收**：同图被多篇文章或封面引用时不被意外删除；图片展示名改变后所有 `asset://` 引用仍有效；带图导出与公众号复制继续使用原有解析器；素材异步操作不会插入到后来打开的其他文章。

## 7. 工作包 X3：快捷采集、模板与选题看板

### 7.1 快捷采集（QuickAdd 思路）

首期复用现有 `create_entry`、`entry_links`、剪贴板和 `CommandPalette`：

- 命令「记录灵感」：输入标题、正文或粘贴文本，创建 `kind=idea, status=inbox` 的 Entry。
- 命令「保存参考资料」：接收标题、原文链接与摘录，创建 `kind=reference, status=unread` 的 Entry。链接由现有数据模型或正文承载，先核对 `Source` 外键契约，不为任意网页新增微信专用来源对象。
- 命令「从灵感/资料创建文章」：继续使用现有转换入口，保留 `entry_links` 来源关系。
- 剪贴板图片仍交素材服务；任意网站自动抓取、浏览器扩展和脚本宏不在首期范围。

### 7.2 文章模板

提供 3 个内置内容模板：项目实操教程、热点技术解读、工具评测。模板填充发生在新建文章时，正文作为正常 Markdown 保存并可完全编辑。

建议先使用 TypeScript 静态模板数据，支持少量确定变量：标题、日期、来源链接（由用户选择的关联资料产生）；不建立任意 JavaScript 模板脚本执行环境。只有用户确实需要持久保存自定义模板时，才增加 `writing_templates` 独立表（`id / name / content_md / created_at / updated_at`）及最小增删改查 IPC；迁移号以实施时数据库最新序号为准，当前 `0015_entry_pins.sql` 仍在工作区中，不能抢占编号。

**验收**：创建后可编辑、自动保存、撤销；模板生成的标题层级合法；来源关联记录符合现有结构；同一模板生成不同文章互不共享编辑状态。

### 7.3 轻量选题看板（TaskNotes 思路）

首版**不新增任务表或任务状态枚举**。以已有 `entries.kind` 和 `entries.status` 组织列：

- 灵感：`inbox`（收集）→ `planned`（计划）→ `used`（已采用）→ `archived`；
- 文章：`draft`（写作中）→ `ready`（待发布）→ `published`（已发布）→ `archived`；
- 资料：继续使用 `unread` / `reviewed` / `used` / `archived`，不与文章混为同一状态机。

看板操作通过现有 `save_entry(expectedVersion)` 更改所属条目状态，移动卡片不复制正文。默认只提供文章与灵感两个视图，点击卡片进入原文章编辑器；优先复用已有 `EntryFilter`、分页、标签与分类筛选。截止日期、负责人、重复任务、日历同步、通用多维表格属于后续独立需求。

**验收**：拖动后状态符合 `kind` 对应的约束；过滤与普通文章列表一致；并发修改触发已有版本冲突处理；已发布文章保留原发布链接及来源关系。

## 8. 工作包 X4：AI 写作增强与公众号发布

### 8.1 AI 写作助手（Claudian 借鉴）

仓库已使用 `@assistant-ui/react`、本地/远端模型、会话持久化和 `ai_edit_proposals`，已有选区快照及 `replaceTarget`。因此不再引入 Claudian 的代理调度、文件系统或对话持久化。

补强重点为：

1. 在 AI 面板提供可编辑快捷提示：润色、扩写、缩写、改写标题、提取摘要；调用现有选区/章节/全文上下文机制。
2. 显示当前引用的文章、标题路径和选区来源，允许用户移除引用；发起请求后冻结快照，避免焦点丢失与切换文档造成目标漂移。
3. 复用 `diff` 和已有提案卡片，保持「预览 → 接受/放弃」机制；接受后沿当前 ProseMirror 事务与 `SaveQueue` 保存。
4. 优先完善纯提示词和 UI，而不是引入能对任意本机文件执行命令的智能体能力；已有独立 MCP 服务继续为外部 Codex/Claude Code 提供授权写入。

**验收**：AI 回复不能未经确认覆盖正文；同一段被用户改写后旧提案不能强制应用；旧会话提案可查看但不误用已失效位置；全文重写遵循现有 `ai_replace` 关键历史规则。

### 8.2 公众号排版与发布（WeChatPB / WeChat Publisher 借鉴）

目前已具备主题、即时预览、富文本复制、HTML/Markdown 导出、图床/无图床图片处理；第一步加强发布前检查，不替换 `renderWechat`：

- 检查标题、封面、正文图片是否存在可用的本地资源或当前发布方式可访问的公网地址；
- 渲染公式、Mermaid、代码块和主题样式继续复用现有输出链；
- 在发布入口清楚区分「复制公众号格式」「导出 HTML」「提交到公众号草稿箱（后续）」。

**官方草稿箱提交为 X4 的独立后续子任务**，需先核实微信公众平台草稿接口当前权限、可调用账号类型、图片上传与封面素材要求、出口 IP 白名单和桌面应用网络场景。方案优先考虑纯本地直连、用户主动操作；固定出口 IP 条件不满足时，以现有复制到后台流程为稳定入口，不预设统一云端中转服务。

若验证可行，再最小增加：

- `wechat_accounts`：账号 ID、显示名、AppID、`credential_ref`；AppSecret 留在系统凭据库；
- `wechat_draft_mappings`：`entry_id`、`account_id`、微信草稿标识、最近成功同步版本及时间；
- Rust 内独立的微信账号/草稿 API 适配器，与 `packages/wechat-renderer` 的 HTML 输出对接；
- 明确由用户确认才提交，不自动群发、不把「草稿已创建」等同于「已发布」或自动修改文章 `published` 状态。

数据库表只是实现时的建议草图，接口验证后再决定具体迁移字段与错误码。重复提交应基于实际微信 API 支持的更新方式处理，不能假设现有草稿永远可修改。

**验收**：第一步复制/HTML 导出没有退化；若后续接入真实草稿 API，实际提交草稿并在公众号后台重开，验证标题、封面、图片、代码、公式、样式和草稿关联；失败时文章保持当前保存状态，提示可继续复制到后台完成操作。

## 9. 数据模型、协议与一致性约束

1. **默认无数据库迁移**：X1 大纲、X2 格式规则、X3 快捷采集与初版看板、X4 AI 提示动作均复用已有 SQLite 数据与接口。图片展示名若存在更新入口，优先复用 `assets.name`。
2. **按需迁移**：只有自定义模板持久化或微信账号/草稿关联确实进入开发范围时新增表；迁移必须配套 Rust 数据访问、`desktop.ts` DTO、数据库备份恢复用例。
3. **既有 Entry 枚举不变**：不能把任意业务阶段直接写入 `entries.status`；新增阶段必须修改 CHECK 约束、共享类型、筛选与迁移，需单独决策。
4. **MCP 不重复建设**：现有本地 `/mcp` 服务有鉴权、权限、读写和冲突处理。后续需要模板/选题接口时在 `src-tauri/src/mcp/tools.rs` 增加工具，并复用 Rust 服务；不得另起 Obsidian 风格 REST 服务。
5. **素材唯一写入入口**：`asset://`、引用抽取、派生素材、S3 上传/删除和退出时清理均由现有服务负责，编辑器与插件改造逻辑只表达业务意图。
6. **备份恢复兼容**：新增表随 SQLite 快照恢复；图片依旧不包含在数据库备份里，恢复成功后的进程重启和清理跳过机制保持现状。
7. **界面契约**：新增面板遵循 `docs/ui-design-guidelines.md` 的侧栏、焦点、键盘与专注模式规范，不增加永久占据正文宽度的后台仪表盘。

## 10. Codex 执行顺序与任务清单

使用独立工作包编号，避免与 `docs/implementation-plan.md` 的既有 P0–P7 阶段编号冲突。先增强编辑器，再补强创作流程，最后处理外部平台接口。

| 工作包 | 内容 | 主要文件 | 依赖 | 完成标准 |
| --- | --- | --- | --- | --- |
| X1-A | 大纲派生树、跳转、搜索/折叠 | `packages/editor-react/`、`workspace/Outline.tsx`、`Document.tsx` | 现有编辑器 | 大纲随当前文稿更新，定位正确 |
| X1-B | 同级章节移动与撤销 | `packages/editor-react/`、相关测试 | X1-A | 完整章节移动、一次撤销、保存无冲突 |
| X2-A | Markdown 检查、差异预览、显式应用 | `packages/markdown-core/`、`Document.tsx`、测试 | 编辑器接口 | 多次运行幂等、复杂节点安全、可撤销 |
| X2-B | 文章图片清单、展示名与批处理基础 | `Assets.tsx`、`src-tauri/src/assets/`、`desktop.ts` | 已有素材服务 | 引用、去重、S3/清理规则不变 |
| X3-A | 命令面板快速采集、内置写作模板 | `CommandPalette.tsx`、`DesktopShell.tsx`、必要服务 | X1 非必需 | 采集与模板可形成正常 Entry |
| X3-B | 灵感/文章状态看板 | `workspace/`、`content.rs`、`shared-types` | X3-A 非必需 | 拖动状态、筛选与版本冲突正确 |
| X4-A | AI 快捷指令、来源引用与提案交互细化 | `AiPanel.tsx`、`ai/context.ts`、相关测试 | 现有 AI 方案 | AI 修改只作用于确认的原目标 |
| X4-B | 公众号发布预检与复制/导出体验增强 | `Publishing.tsx`、`wechat-renderer/`、测试 | 现有主题与素材 | 渲染与复制路径无回归 |
| X4-C | 微信账号及草稿接口（条件任务） | Rust 公众号 API 服务、迁移、发布 UI | API 权限与出口条件经验证 | 真实公众号后台重开草稿验证 |

**每个工作包执行要求**：

1. 先读 `AGENTS.md`、本方案及直接涉及的源文件、测试，执行 `git status` 并保留既有未提交变更；只在目标模块实施。
2. 上游源码复用前核对具体文件许可、提交 SHA、依赖树，评估与 Obsidian API 的耦合；提取后在 `NOTICE.md` 记录来源，不直接复制整个插件包。
3. 先复用项目已有 API 与依赖（Milkdown、`diff`、`markdown-it`、`juice`、Radix Themes、Rust 业务服务）；未证实需要时不新建框架、存储层、宏运行时。
4. 同步更新受影响的 DTO/迁移/文档及局部测试。每阶段执行 `pnpm typecheck`、受影响前端测试；涉及 Rust 时执行相关 `cargo test`。
5. 按既有研发安排在集中回归和最终端到端阶段统一执行完整性能、跨平台和真实公众号接口验收，不将接口可用性推断写成已测试结果。
6. 提交应以单个工作包为单位，只包含本次实际修改的文件；不要顺带提交工作区其他未提交变更。

## 11. 关键验收矩阵

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| OBS-01 | 三级标题与相同名称标题 | 大纲生成、跳转、折叠与搜索准确 |
| OBS-02 | 拖动带图片/表格/子标题的章节 | 内容顺序完整，一次撤销恢复，持久化后重开一致 |
| OBS-03 | AI 或用户在大纲拖动期间修改正文 | 目标按实际会话与当前事务校验，不误移动其他文档 |
| OBS-04 | 对复杂 Markdown 执行格式化两次 | 第二次输出不再变化；代码块/公式/链接/图片及自定义节点不损坏 |
| OBS-05 | 格式化差异确认后撤销 | 正文恢复，原 SaveQueue 与版本冲突行为正常 |
| OBS-06 | 图片重命名与同哈希多文章引用 | 素材 ID 不变，共享图片不被重命名操作破坏或删除 |
| OBS-07 | 采集灵感、创建文章、关联资料 | Entry 状态及来源关系正确，正文仍只在 SQLite |
| OBS-08 | 模板创建两篇不同文章 | 各自保存和编辑互不影响，不共享可变状态 |
| OBS-09 | 看板跨列移动与过滤 | 遵守 kind/status CHECK，符合过滤条件，版本冲突可见 |
| OBS-10 | AI 选区改写后继续人工编辑 | 旧提案不能误应用到新位置，未确认内容不写正文 |
| OBS-11 | 公众号复制/导出含图与复杂内容 | 与现有 `wechat-renderer` 黄金样本一致 |
| OBS-12 | 真实草稿箱提交（实施 X4-C 时） | 微信后台可重开草稿，标题、封面、正文与图片准确 |
| OBS-13 | 关闭/重开应用、备份与恢复 | 新增持久数据正常恢复，已有素材清理与 AI 会话规则保持一致 |

## 12. 参考资料与后续维护

- [Milkdown 官方文档](https://milkdown.dev/) · [ProseMirror API](https://prosemirror.net/docs/ref/)
- [Tauri 2](https://v2.tauri.app/) · [Radix UI Themes](https://www.radix-ui.com/themes/docs/overview/getting-started)
- [Quiet Outline](https://github.com/guopenghui/obsidian-quiet-outline)、[Linter](https://github.com/platers/obsidian-linter)、[Image Manager](https://github.com/davidvkimball/obsidian-image-manager)
- [Claudian](https://github.com/YishenTu/claudian)、[QuickAdd](https://github.com/chhoumann/quickadd)、[TaskNotes](https://github.com/callumalpass/tasknotes)
- [WeChatPB](https://github.com/Kianzzz/wechatPB)、[WeChat Publisher](https://github.com/RanceLee233/wechat-publisher)、[Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api)

执行过程中若现有功能、数据库迁移或微信平台接口已有新变化，以仓库实际源码和可验证的接口结果更新本方案。