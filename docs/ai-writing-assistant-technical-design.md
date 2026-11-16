# AI 写作助手技术方案

> 项目：wechat-creator-workbench
>
> 日期：2026-11-16
>
> 状态：首期代码已实现；真实模型、原生窗口与 S3 恢复沿用 P7 验收
>
> 目标：在现有 Tauri 2、React 19、Milkdown 7 和 SQLite 工作台中集成可折叠 AI 聊天侧栏，使助手能读取文章上下文、生成可审阅的 Markdown 修改提案，并经编辑器事务应用修改。
>
> 关联文档：[MVP 技术方案](./mvp-technical-design.md) · [实施计划](./implementation-plan.md) · [界面设计规范](./ui-design-guidelines.md)

## 1. 目标、约束及交付边界

### 1.1 用户工作流

1. 在 Milkdown 中选中文字，点击「AI 润色」「精简」「扩写」或在右侧栏输入自定义指令。
2. 侧栏展示当前引用范围（选区／当前章节／全文），明确本轮发送给模型的内容。
3. 模型逐步输出回答；需要改写时形成一份结构化修改提案。
4. 用户查看原文和建议内容的差异，选择「接受」「重新生成」「复制」或「放弃」。
5. 接受后通过原有 Milkdown 编辑事务修改对应区域，进入既有自动保存队列；可立即撤销。
6. 对话、回复和提案元数据持久化至 SQLite；关闭、重开应用后可以继续查阅历史。

本功能面向微信公众号长文写作，不要求模型直接管理文件或操作 SQLite。文章摘要、标题建议、选区改写、普通聊天均继续支持。

### 1.2 不变的架构约束

- `entries.content_md` 仍是正文的持久化来源；`.md` 文件仅作为导出文件。Milkdown/ProseMirror 文档树仅负责编辑期间的结构、选区和事务。
- SQLite 由 Rust 应用服务统一写入；AI 不直接更新 `entries.content_md`，也不建立第二条保存管线。
- 每篇文章通过现有 `SaveQueue` 执行约 750 毫秒防抖、串行保存和 `expectedVersion` 乐观锁。
- 自动保存不创建历史快照；手动关键版本、未来整篇替换前的历史遵循原有规则，每篇最多保留 **3 条**。普通选区改写使用 ProseMirror 撤销历史。
- 兼容现有用户自配 OpenAI 风格模型接口及本机 Codex、Claude Code 命令行目标；继续使用操作系统凭据存储模型密钥。
- 保留已有 S3 数据库单文件备份、S3 图床和本地 Streamable HTTP MCP 体系。新增 AI 聊天表自然进入 SQLite 数据库备份，不新增独立云服务。
- 前端 UI 延续 Radix UI Themes 的现有令牌和工作区侧栏，不为聊天引入完整第二套设计系统。
- 只处理真实出现的并发编辑、关闭标签、切换文章、模型取消、保存失败和版本冲突；不建立通用三方合并、独立快照数据库或复杂任务编排框架。

### 1.3 首期交付与后续范围

| 能力 | 首期交付 | 后续按需增加 |
| --- | --- | --- |
| 聊天 | 流式输出、取消、重试、会话列表和本地持久化 | 消息分支、附件、多模型并行 |
| 文档读取 | 选区、当前章节、整篇文章（显式选择） | 多文档资料检索 |
| 文档修改 | 选区改写、差异预览、整段接受或放弃、撤销 | 多处提案、逐句接受、批量改写 |
| 目标校验 | 同一文档、同一编辑会话、同一修订号、原文一致性 | 编辑期间位置映射后的局部继续应用 |
| 智能体 | 复用现有模型及本机代理目标作为对话生成器 | 经过审批的跨文档工具调用 |

## 2. 当前仓库基线与改造边界

以下表格记录改造前的基线和改造范围。

| 现有位置 | 已有能力 | 本次扩展 |
| --- | --- | --- |
| `apps/desktop/src/workspace/AiPanel.tsx` | 自研侧栏、`useAiAssistant`、摘要／标题／选区改写／聊天、候选应用、取消与重试 | 保留侧栏外壳、目标选择和设置入口；逐步改用 assistant-ui 的消息／输入组件与运行时 |
| `apps/desktop/src/workspace/AiSettings.tsx`、`AiTargetPicker.tsx` | 模型与本机代理目标选择 | 原样复用，适配聊天运行时 |
| `apps/desktop/src/workspace/Document.tsx` | 当前文章、编辑器实例、保存队列及 AI 操作入口 | 传递固定的文档上下文与修改提案动作 |
| `packages/editor-react/index.tsx` | `MarkdownEditorHandle.target()`、`replaceTarget()`；依据 entryId、session、localRevision 验证目标并执行 ProseMirror 事务 | 扩展上下文读取和结构指纹；差异在侧栏显示，保留统一事务入口 |
| `apps/desktop/src/editor/save-queue.ts` | 单文章串行保存、750 毫秒防抖、`ai_replace`／`manual`／`auto` 模式 | 选区替换继续走 `auto`；仅整篇覆盖需要 `ai_replace` 关键历史 |
| `apps/desktop/src/desktop.ts` | `aiGenerate`、`aiCancel`、`saveEntry` 等 IPC 封装 | 补流式调用、会话管理和提案持久化 IPC |
| `src-tauri/src/ai.rs` | AIService、OpenAI 风格完整响应、本机代理、取消、任务记录与用量 | 增加流式文本响应，保留已有摘要／标题／改写结构化接口 |
| `src-tauri/src/ai/agent.rs`、`settings.rs` | 本机代理隔离执行、模型设置与密钥 | 沿用既有实现；命令行目标首期仍显示等待与最终结果 |
| `src-tauri/src/db.rs`、`src-tauri/migrations/` | SQLite 迁移、事务、`jobs`／`ai_job_details` | 新增聊天会话／消息／修改提案表及迁移 |
| `src-tauri/src/commands.rs` | `save_entry`、`revisions` 等统一保存入口 | 继续使用，不为 AI 建立独立正文写接口 |

**已发现的行为差异：**

- 目前聊天消息由 `useAiAssistant` 按编辑会话保存在内存，重启不保留；现有 `0012_ai_chat.sql` 是扩展 `ai_job_details.operation`，并未建立聊天会话表。
- 当前 OpenAI 模型请求主要等待完整 JSON 响应，侧栏未获得逐字增量。
- 普通聊天要求模型在 `replacement` 中返回整篇 Markdown；这是现阶段改写全文的接口路径。此次升级要将「回答」与「局部改写提案」拆开，使文档局部修改以选区为目标。
- 当前 `replaceTarget()` 在任一正文修订发生后拒绝旧目标；这是首期保留的正确性基线。更宽松的位置映射在通过测试后单独升级，不能在同次改造中绕过修订校验。
- 现有 UI 已有对话历史入口、候选应用和拷贝操作；迁移应保留用户习惯，不重新制作整个右侧面板。

## 3. 组件选型

### 3.1 主方案

- **assistant-ui / `@assistant-ui/react`**：负责对话消息、生成状态、编辑器输入框、消息重试和聊天运行时。
- **`LocalRuntime` + `ChatModelAdapter`**：通过 Tauri IPC 接入已有 Rust AIService。增量消息由适配器累积后交给 assistant-ui。
- **`RemoteThreadListAdapter` + `ThreadHistoryAdapter`**：对接 Rust/SQLite 自有会话表；不接入 assistant-ui Cloud。
- **Milkdown 7 / ProseMirror**：复用 `MarkdownEditorHandle`，负责上下文、编辑位置、事务、撤销与差异装饰。
- **Radix UI Themes**：继续维护已有侧栏宽度、标题栏、模型选择器、颜色与按钮规格。选择 assistant-ui 原语组件，按现有 CSS 样式组合；不复制需要完整 Tailwind/shadcn 运行体系的演示页面。
- **Rust AIService**：统一发送模型请求、限制输入大小、取消任务、记录用量及处理模型凭据。

assistant-ui 是聊天交互层，并非编辑器或业务工具执行框架。当前不引入 CopilotKit 或 Agent Elements 整套运行时。开源许可证与依赖版本以实际锁定的 npm 发行包为准，集成前确认与现有 GPL-3.0 仓库的分发要求兼容。

### 3.2 分层结构

~~~text
apps/desktop/src/workspace
  ├── DesktopShell / Document（现有工作区与文章会话）
  ├── AiPanel（现有侧栏布局、设置和目标选择）
  └── AI 聊天视图（assistant-ui 消息、输入框、工具卡片）
               │
apps/desktop/src/ai
  ├── runtime.tsx       ChatModelAdapter、运行时与会话适配器
  ├── context.ts        文档上下文快照和请求组装
  └── proposals.ts      差异预览、接受与放弃
               │
packages/editor-react
  └── MarkdownEditorHandle（上下文、原文切片、目标校验、事务）
               │
apps/desktop/src/desktop.ts → Tauri IPC / Channel
               │
src-tauri/src/ai.rs（模型调用与任务）
src-tauri/src/content.rs（沿用正文保存服务）
src-tauri/src/db.rs（SQLite）
~~~

目录 `apps/desktop/src/ai` 为建议新增目录；使用现有模块抽离代码，不复制现有会话状态或保存逻辑。

## 4. 文档上下文设计

### 4.1 上下文模式

| 模式 | 读取内容 | 操作规则 |
| --- | --- | --- |
| `selection` | 当前选区 Markdown、选区所在标题、必要相邻文字 | 润色／精简／扩写默认选用；无选区则提示选择内容 |
| `section` | 光标所在标题及其以下内容，直到同级或更高级标题之前 | 标题前读取导言；无标题时只引用当前正文块 |
| `document` | 当前文章标题和完整 Markdown | 摘要、标题、全文审稿；明确标示范围，受现有 256 KiB 输入限制 |

聊天发送前固定上下文，允许用户看到「引用：选区／章节／全文」。默认选区优先，无选区时引用当前章节；可切换为不引用正文。全文任务按用户主动选择读取；长度超限时告知缩小范围，不静默截断关键内容。

### 4.2 编辑器快照

由 `packages/editor-react/index.tsx` 的 `MarkdownEditorHandle.captureContext(scope)` 从编辑器状态读取，不使用 DOM 或 Markdown 字符偏移。

~~~typescript
type AiContextScope = "selection" | "section" | "document";

interface AiEditorContext {
  entryId: string;
  session: symbol;      // 仅驻留前端，不持久化
  localRevision: number;
  scope: AiContextScope;
  from: number;         // ProseMirror 位置，不是 Markdown 字符索引
  to: number;
  original: string;     // 当前范围的 Markdown
  originalSlice: string;  // ProseMirror Slice 序列化后的 JSON
  headingPath: string[];
}
~~~

实现原则：

1. 失焦不会改变 ProseMirror 保存的选区；提交时从编辑器状态采集，之后固定本轮范围。把光标移回正文并清空选区时，不保留旧的选区作为默认目标。
2. 使用已有 `target()` 和编辑器内部的 `publish`/解析逻辑提取内容；章节按 ProseMirror 标题节点定位，不另写一套 Markdown 正则分段器。
3. 发起请求时保存 `entryId`、编辑会话 `session`、`localRevision`、范围、Markdown 和原始结构化切片指纹。
4. 模型收到的是正文数据，不是可信应用指令。保留 `ai.rs` 已有数据与系统指令分离约束。
5. 快照只用于本轮请求及提案定位；SQLite 长期会话只保存可重放的文本内容和提案信息，不持久化前端 `symbol`。

## 5. AI 输出与修改提案

### 5.1 分离回答和修改

普通聊天模式输出自由文本，采用增量显示。修改模式返回结构化结果：

~~~typescript
interface AiEditProposal {
  id: string;
  threadId: string;
  messageId: string;
  entryId: string;
  baseVersion: number;       // 发起时 SaveQueue 对应数据库版本
  localRevision: number;     // 发起时 ProseMirror 本地修订
  from: number;
  to: number;
  originalMarkdown: string;
  originalSliceHash: string;
  replacementMarkdown: string;
  description: string;
  status: "pending" | "applied" | "rejected" | "conflicted";
}
~~~

`from/to`、`entryId`、`localRevision` 以及原文哈希由前端创建快照时确定，模型只生成 `replacementMarkdown` 与描述。不要让模型给出 ProseMirror 位置、SQL 或直接执行的 JS。

现有摘要、标题建议、选区改写的 `ai_generate` 结构化结果继续可用；聊天中「改写选区」按钮可将自定义提示词与选区快照交给同一提案生成入口。升级后普通聊天不再以整篇 `replacement` 作为局部编辑载体。若继续支持整篇重写，必须作为独立用户确认的操作，遵循 `ai_replace` 关键历史规则。

### 5.2 差异与应用

1. 侧栏显示提案卡片：修改说明、原文与替换后 Markdown 的行内或并排差异、复制、重新生成、接受和放弃。
2. 在侧栏显示 Markdown 行级差异。编辑器暂态高亮可按需补充；预览阶段不修改正文。
3. 首期只支持整个提案一次接受，不开发逐字选择性合并。差异组件优先复用成熟 `diff` 库，核对现有依赖后引入。
4. 用户点击「接受」时检查：文章未删除、原编辑会话仍存活、当前 `localRevision` 与发起时一致、目标范围结构切片与指纹一致，且编辑器可写。
5. 将替换 Markdown 通过当前 Milkdown Schema 解析为切片，再调用现有 `replaceTarget()` 所封装的 ProseMirror 事务。应用后的 `onChange` 自然写入 `SaveQueue.edit()`。
6. 维持 `replaceTarget()` 已有 `closeHistory` 撤销边界；接受后可一次撤销该次修改。
7. 自动保存成功后更新提案状态。保存失败保留编辑器当前未保存正文和错误提示，由原有保存队列重试，不显示已持久化成功。
8. 原文已改变或目标会话关闭时，提案仍可复制或重新生成，但不能写到后来选中的其他文章、其他段落。

**位置映射的取舍**：首期采用现有「任何正文修订改变即拒绝应用」规则，以最少改动获得正确的选区定位。若测试确认长文场景频繁因无关段落编辑而拒绝，第二阶段再为提案注册 ProseMirror 事务映射，按每次 `tr.mapping` 跟踪 `from/to`；映射后仍须比较目标原文切片，一旦目标本身被修改就标记冲突。不要直接拿旧的 `from/to` 去替换新文档。

### 5.3 Markdown 格式边界

- 持久化仍为 Markdown；运行时的 ProseMirror 位置只用于编辑会话。不能以 `from/to` 当作 Markdown 字符串下标。
- 使用现有 Milkdown Schema、parser 与 serializer 处理替换片段；不要在 AI 模块引入另一个 Markdown 编辑引擎。
- 针对标题、引用、列表、表格、图片、代码块、脚注、公式和自定义节点验证解析—序列化往返；对不能完整表达的自定义属性，不执行会导致信息丢失的替换。
- 图片保留既有 `asset://` 引用以及资产生命周期逻辑；AI 无法通过 Markdown 输出直接创建未经 AssetService 注册的本地素材。

## 6. Tauri 模型服务与流式协议

### 6.1 聊天适配器

在 `apps/desktop/src/ai/runtime.tsx` 用 `ChatModelAdapter` 对接 Rust。若适配器采用 `async *run`，每次向 assistant-ui 交付**累积后的完整消息**，而不是仅当前增量，否则消息内容会闪动或丢失。

~~~text
用户发送 → captureContext → ChatModelAdapter
                         ↓
               desktop.aiChatStream(...)
                         ↓
                 Tauri Channel
                         ↓
        累积文本 → assistant-ui 消息渲染
                         ↓
            SQLite 会话／消息保存
~~~

`LocalRuntime` 管理消息状态；已访问的文章范围保留自己的运行时，以便切换文章后继续接收原请求结果。同一文章范围内，生成期间先停止或等待结果再切换会话。原有 AI 目标选择器继续使用。

### 6.2 Rust 命令建议

| 命令 | 输入要点 | 输出／职责 |
| --- | --- | --- |
| `ai_chat_stream` | requestId、threadId、模型目标、消息、上下文、Channel | 发送增量与结束事件，支持取消 |
| `ai_generate` | 结构化请求，选区改写接受可选指令 | 生成摘要、标题和修改候选 |
| `ai_cancel` | requestId | 复用现有 CancellationToken |
| `ai_threads_list`、`ai_thread_get/create/update/delete` | threadId、entryId 等 | SQLite 会话操作 |
| `ai_messages_list`、`ai_message_save` | threadId、消息与父消息 ID | 持久化聊天历史；同时写入回复附带的修改提案 |
| `ai_proposal_status` | proposalId、审批状态 | 更新已有提案状态 |

接口名是实现建议，优先沿用项目现有命名和错误码体系，避免同义命令重复。正文保存仍通过已有 `save_entry` 与 `SaveQueue`。

OpenAI 风格模型的响应由 Rust 解析 SSE。每个请求使用一个 Tauri Channel 交付 `started` 和 `delta`，命令本身返回最终结果或结构化错误。兼容接口若忽略流式选项并返回 JSON，侧栏显示完整结果。流式与结构化请求共用任务取消、超时、HTTP 错误分类与用量记录。

本机 Codex 通过 `codex app-server` 的标准输入输出传输启动临时只读会话。使用本机 Codex 的登录和模型配置，禁用工具、插件、钩子与 Codex 记忆。聊天将 `item/agentMessage/delta` 转发给现有 Tauri Channel，并在 `turn/completed` 后返回最终文本。摘要、标题和改写继续解析完整结果。Claude Code 目标继续使用隔离的 CLI 完整响应。两种本机目标均使用现有任务取消与超时机制，聊天记录由工作台保存。

### 6.3 会话与任务区别

`jobs` 和 `ai_job_details` 保存一次模型任务的状态、模型与用量；`ai_threads`、`ai_messages` 保存用户可回看的对话。两者职责不同，历史消息不应靠扫描任务表重建。

应用退出时不自动重发之前的模型请求。已保存的取消或错误显示终态；若进程中断时只来得及保存用户消息，恢复后提供手动重新生成。现有 `begin_exit` 对 AIService 的停止机制继续适用。

## 7. SQLite 数据模型

迁移 [0013_ai_conversations.sql](../src-tauri/migrations/0013_ai_conversations.sql) 建立会话表，[0014_ai_current_thread.sql](../src-tauri/migrations/0014_ai_current_thread.sql) 将旧会话中除每个范围最新一条以外的会话放入历史。

- `ai_threads` 按文章或通用聊天分别列出，支持新建、改名和删除。移入回收站保留对话；永久删除文章时清理关联对话与提案。
- `ai_messages` 记录消息顺序和父消息关系。插入回复与附带的 `ai_edit_proposals` 使用同一个 SQLite 事务；提案状态单独更新。
- `content_json` 保存 assistant-ui 消息的可序列化结构，包含文本／必要的工具部件；禁止保存前端 `symbol`、Tauri Channel 实例或 API 密钥。
- 提案的 `target_from/to`、`local_revision` 只对发起时编辑会话有效。重新打开文档后，历史提案只可查看／复制，不能直接用旧位置应用。
- 数据库新增表自然被现有 S3 SQLite 快照覆盖；依循备份恢复后的进程重启和编辑状态重建流程。
- 保留现有 `ai_job_details` 和 `jobs`，不为了会话持久化迁移旧任务内容。
- `ai_edit_proposals` 是审阅记录，不计入 `entry_revisions` 的 3 条关键历史数量。

## 8. 页面交互规范

1. 沿用现有可折叠右侧栏、模型选择和顶部工具入口；聊天消息组件与底部输入框使用 assistant-ui 原语，样式与现有 Radix UI Themes 一致。
2. 选区出现时可从 Milkdown 右键菜单或快捷工具进入「AI 改写」；侧栏展示文档标题、引用范围和当前模型。
   侧栏选择的 AI 目标及具体代理模型 ID 一起保存为工作区默认值，重新打开工作台时自动使用。
3. 回答消息展示 Markdown、代码块、加载状态、停止、重试和复制。
4. 改写结果展示差异卡片；明确「接受修改」才触发事务。正在保存、应用成功、保存失败采用现有状态和通知机制。
5. 点击「新对话」将当前会话移入对话记录，时钟按钮打开可续聊的会话列表。打开历史会话时恢复原消息并设为当前会话。切换文章后侧栏切换对应范围，通用聊天使用 `entry_id = NULL`。重新打开工作台时恢复当前会话，历史提案不沿用旧编辑位置。
6. 生成中用户继续输入、改变选区或切换文章时，当前生成仍绑定发起时的 `entryId` 与快照，不能操作当前活动文档。

## 9. 逐阶段实施任务

### A. 编辑器接口与上下文（先完成）

- [x] 扩展 `MarkdownEditorHandle`：新增选区／章节／全文的快照读取和原始结构指纹，保留现有 `target()`、`replaceTarget()`。
- [x] 侧栏失焦后仍引用发送前的固定选区；选区清空时不假装有改写目标。
- [x] 抽离 `AiContext` 组装逻辑；避免每轮普通聊天都自动发送整篇文章。
- [x] 验证按标题截取章节、失焦和切换文稿后的引用范围，并回归已有 Markdown 结构保留与撤销测试。

### B. 聊天运行时与流式输出

- [x] 锁定与 React 19 兼容的 `@assistant-ui/react` 版本并检查许可证。
- [x] 复用 `AiPanel.tsx` 外壳，替换聊天消息／输入框；用 `LocalRuntime` 统一接管消息状态。
- [x] Rust `AIService` 增加流式响应与 Tauri Channel 事件，保留现有结构化生成命令和 CLI 目标。
- [x] 接入取消／重试、增量拼接、错误反馈；已有 AI 设置和任务记录可继续使用。

### C. 会话持久化与提案

- [x] 编写下一序号 SQLite 迁移，增加 `ai_threads`、`ai_messages`、`ai_edit_proposals`。
- [x] 编写 Rust repository 与 IPC，接入 assistant-ui 会话列表与历史适配器。
- [x] 将普通聊天「整篇 replacement」能力调整为明确的局部修改提案入口。
- [x] 加入差异组件与审批按钮；原文和替换内容复用当前 Milkdown Schema 解析。
- [x] 接受提案时执行 `replaceTarget()`，触发既有 `SaveQueue`；保存失败按已有状态保留未保存缓冲。
- [x] 仅选区改写使用撤销，不为每次提案创建全文历史。

### D. 回归与验收

- [x] 完成局部单元／组件测试，沿用原有 `pnpm typecheck`、`pnpm test` 和 Rust 测试流程；集中回归纳入既有 P6。
- [ ] 将真实模型、跨平台窗口、长文和完整恢复流程纳入既有 P7，不改变原定发布验收顺序。

## 10. 验收矩阵

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| AI-01 | 选中段落后点击右侧栏输入框 | 提交使用固定的原选区及原文章，不因焦点变化而丢失 |
| AI-02 | 改写选区，接受提案 | 只替换目标，Markdown 序列化后落入 `entries.content_md`，图片与无关内容不变 |
| AI-03 | 接受后立即撤销 | 一次撤销恢复被替换内容，继续输入和自动保存正常 |
| AI-04 | AI 生成期间继续修改正文 | 首期拒绝应用过期目标，候选仍可复制或重新生成 |
| AI-05 | AI 生成期间仅改变选区／切换活动标签 | 不修改后来选中的范围或另一篇文章；原会话有效时仍可按发起时目标校验 |
| AI-06 | 关闭原编辑标签再打开文章 | 旧提案可查看／复制，但原位置不被当成新会话可应用目标 |
| AI-07 | Markdown 含表格、图片、链接、代码块、脚注等 | 改写允许的目标区域后，非目标结构和属性保持一致 |
| AI-08 | 模型返回流式回答，用户停止 | UI 增量显示，停止对应请求，任务状态准确，其他会话不串线 |
| AI-09 | 新建对话、重启应用、切换会话 | 从 SQLite 恢复消息顺序、模型答复和提案文本 |
| AI-10 | 保存失败或数据库版本冲突 | 编辑器保留未保存正文；显示保存错误；旧版本不覆盖新版本 |
| AI-11 | 数据库 S3 快照恢复 | 聊天会话随数据库恢复；旧在途模型任务不自动重启 |
| AI-12 | 不配置 AI 时离线写作 | Milkdown 编辑、保存、排版、图片、MCP 和 S3 配置入口行为保持正常 |

验收样本沿用原实施计划的 5 万字长文、中文输入法连续输入、表格／公式／Mermaid／图片和多标签页切换样本，不另建一套独立性能框架。

## 11. Codex 执行约定

1. 先阅读本文、`docs/mvp-technical-design.md`、`docs/implementation-plan.md`、`AGENTS.md`，再检查目标模块的实际导出接口与测试。
2. 按 A → B → C → D 执行，每阶段以本项目现有模式实现、运行相关测试后再进入下一阶段。
3. 只在确定的模块内修改，优先复用已有 `SaveQueue`、`replaceTarget()`、`AiService` 和 SQLite 事务；不要为 AI 建第二套数据库正文写入流程。
4. 引入开源组件优先使用成熟组件和官方接口，锁定依赖版本；若组件与现有 Radix 样式冲突，优先使用无样式原语而不是重构整个页面。
5. 若开发过程中发现当前实现与本方案存在差异，优先依据仓库实际代码收敛实现，并同步更新本文件的相关接口和验收项。

## 12. 技术参考

- assistant-ui 自定义运行时：https://www.assistant-ui.com/docs/runtimes/custom/local-runtime
- assistant-ui 自有数据库持久化：https://www.assistant-ui.com/docs/integrations/persistence/custom-adapter
- assistant-ui 持久化接口：https://www.assistant-ui.com/docs/api-reference/adapters/persistence
- Milkdown 实用接口：https://milkdown.dev/docs/api/utils
- ProseMirror 事务参考：https://prosemirror.net/docs/ref/#transform.Mapping
- Tauri 2 Channel：https://v2.tauri.app/develop/calling-frontend/#channels
- assistant-ui 仓库：https://github.com/assistant-ui/assistant-ui
