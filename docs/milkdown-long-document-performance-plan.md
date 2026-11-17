# Milkdown 超长文档与 AI 局部编辑性能改造方案

> 项目：wechat-creator-workbench  
> 版本：1.0 / 2026-11-17  
> 状态：已完成本地源码静态审查；性能基线与改造验收按本文执行  
> 目标：在现有 Tauri 2 + React 19 + Milkdown 7.23.0 + ProseMirror + SQLite 架构下，优化 10 万至 100 万中文字符的 Markdown 长文写作，以及 AI 修改单段、章节时的输入响应、保存成本、渲染开销与内容一致性。
>
> 关联：[AI 写作助手方案](./ai-writing-assistant-technical-design.md) · [Obsidian 功能方案](./obsidian-feature-integration-plan.md) · [实施计划](./implementation-plan.md)

## 1. 设计依据与边界

### 1.1 已确定的使用场景

- 用户长期编辑单篇较长的中文 Markdown 文稿，含标题、引用、脚注、链接、代码块、图片、表格、公式、Mermaid。
- 编辑体验为 Milkdown 所见即所得，Markdown 字符串仍是唯一的持久化正文形式，保存在 SQLite `entries.content_md`。
- AI 默认处理选区或当前章节；用户主动选择才读取全文。AI 候选经过现有侧栏确认后以 ProseMirror 事务提交。
- 文章有多标签页、公众号预览/复制、状态栏字数、图片引用、关键版本与自动保存；优化不能只考虑编辑器组件。
- 首先保障常见长文编辑，100 万字作为极限场景评估，不为单个极端样本预先重构编辑器。

### 1.2 代码审查范围

本方案依据当前已登记的本地 `wechat-creator-workbench` 工作区源码，包括工作目录中的当前实现，而不是依据此前的设计文档推断。重点核对：

- `packages/editor-react/index.tsx`、`presentation.ts`、`code-view.ts`、`table-view.ts`、`slash-menu.ts`、`link-footnotes.ts`。
- `apps/desktop/src/workspace/Document.tsx`、`DesktopShell.tsx`、`AiPanel.tsx`、`StatusBar.tsx`。
- `apps/desktop/src/editor/save-queue.ts`、`apps/desktop/src/ai/context.ts`、`runtime.ts`、`proposals.ts`。
- `src-tauri/src/content.rs`、`src-tauri/src/assets/references.rs`。
- `apps/desktop/src/editor/editor-session.test.tsx`、`save-queue.test.ts` 和现有 AI 技术方案。

**证据级别**：以下“已存在”“每次”“当前”的表述来自上述源码；“耗时占比”“可提升多少”仍需真实应用压测确定。本轮是技术设计和静态审查，不把源码推断写成已实测的性能数据。

### 1.3 默认假设与可能改变优先级的变量

1. 默认性能重点是**单篇长文和 AI 局部修改**，而不是数万篇文章的文件索引。
2. 暂以 Windows 11 / WebView2 的正式 Tauri 构建作为主验收环境，之后再做 macOS / Linux 差异验证。
3. 长文可能有完全不同的 DOM 复杂度：10 万字纯段落与 10 万字密集表格不应共用唯一性能结论。
4. 未取得真实用户慢操作的性能追踪。若真实记录显示浏览器布局/表格节点比全文序列化更重，则先后顺序按证据调整。
5. 常见错误是仅将自动保存防抖设为 750 毫秒，却忽略**保存之前每次输入已完成的全文转换与 React 通知**。

## 2. 源码发现与实际瓶颈

| 优先级 | 证据位置 | 当前实现 | 成本及风险 | 改造方向 |
| --- | --- | --- | --- | --- |
| P0 | `editor-react/index.tsx` → `revision` 插件的 `view.update()` | 有正文修订时立即执行 `markdown = publish(view.state.doc)`，再调用 `onChange(entryId, localRevision, markdown)` | **每次正文修改都执行整篇 Markdown 序列化**，与 `SaveQueue` 的写入防抖无关 | 正文脏标记与取快照分离 |
| P0 | `Document.tsx` → `DocumentEditor` | `onChange` 直接调用 `queue.edit({ contentMd })` | 每次按键传播完整字符串，通知所有该队列订阅者 | 改为修订通知；需要 Markdown 的功能按边界取快照 |
| P0 | `presentation.ts` → `editorPresentation` | `cached?.doc !== doc` 时调用 `blockDecorations(doc, ...)`；`blockDecorations` 使用 `doc.descendants` | 每次文档节点变化重建全文块级装饰，代码块着色/行号/折叠标题均参与 | 先按变更范围增量维护，必要时局部重算 |
| P0 | `presentation.ts` → `linkFootnoteDecorations` | 开启 `convertLinks` 时以文档对象为缓存键，文档变化后重新执行 `linksToFootnotes(...)` | 编辑普通文字也可能重新分析全文链接、脚注 | 区分“链接相关变更”与普通文本编辑；保留全局失效情形 |
| P1 | `index.tsx` → `normalizeDocument` 和 `documentLayout.appendTransaction` | 每次正文事务都会检查尾部块并遍历顶层节点以收集脚注定义 | 顶层块多时为线性成本；有时还附加整理事务 | 快速判定布局是否受影响，再维护既有脚注顺序规则 |
| P1 | `StatusBar.tsx` | 对 `fields.contentMd` 执行 `replace(/\s/g, "")`、`Array.from(...)` 统计字数；图片上传进度也依赖正文字符串 | 与逐字全文同步叠加，增加主线程与派生计算成本 | 按节流窗口/取快照边界更新统计；图片引用保持最终一致 |
| P1 | `index.tsx` → `SearchBar` | 查找打开时循环 `searchQuery.findNext` 收集全部匹配；编辑器更新会通知搜索订阅者 | 大文档、大量匹配时全局搜索与 React 更新昂贵 | 搜索活动态优化、匹配数/展示数限量及按需计算 |
| P1 | `index.tsx` → `captureContext` | 选区/章节读取时遍历顶层标题；全文范围使用 `markdown` 缓存 | 切换延迟快照后，全文上下文不能继续依赖上一次按键的缓存 | 全文按请求实时取快照；标题索引后续可缓存 |
| P1 | `index.tsx` → `replaceTarget`；`AiPanel.tsx` | 已用 `replaceRange` 提交局部事务，且校验 `entryId/session/localRevision/originalSlice`；接受提案后复用 `SaveQueue` | 现有局部机制**已经正确**；任意正文修订都会使旧目标失效。前后文 `doc.slice` 校验也可能随篇幅增大 | 保留安全基线，先优化片段解析和提交耗时；位置映射单独评估 |
| P1 | `DesktopShell.tsx` | `sessions.map` 为每个打开标签都挂载 `DocumentEditor`，非活动文档通过 `hidden` 隐藏 | 多篇巨型文稿同时开启时存在多个完整编辑器/DOM | 后续按需保留活动编辑器，先验证标签切换与保存约束 |
| P2 | `code-view.ts` | `highlight.js` 高亮结果以 `WeakMap<ProseNode,...>` 缓存；Mermaid 由节点视图延迟 180ms 触发绘图 | 已有缓存与延迟，仍可能在代码块众多时影响初始化 | 仅在剖析证明必要时优化可见区域资源 |
| P2 | `content.rs::save_entry` / `references.rs::sync_entry` | 保存事务重写正文与相关元数据，调用 `sync_entry` 删除并重建正文图片引用关系 | 即使修改标题等元数据，也可能进行整篇正文引用扫描 | 测量后按正文/封面变化设计安全失效条件，保留图片清理语义 |

### 2.1 当前完整保存链路

`ProseMirror tr.docChanged` → 修订插件 `view.update` → `publish(整篇 doc)` → `MarkdownEditor.onChange` → `DocumentEditor.queue.edit({ contentMd })` → `SaveQueue` 更新订阅者 → **750ms 防抖** → `desktop.save` → Rust `content::save_entry` → 更新 SQLite 并同步图片引用。

因此**750ms 只限制数据库保存，不限制每个按键的全文序列化**。这是本次最明确、最值得首先量化的热点。

### 2.2 源码已有的能力，应直接复用

- `ProseMirror` 内建事务、结构共享、局部 DOM 更新、`StepMap/Mapping`、`DecorationSet`、撤销/重做。
- `SaveQueue` 已实现单篇串行提交、版本乐观锁、失败保留状态和手动/AI 保存类型，不再建立第二套保存器。
- AI 已有 `replaceTarget` 局部替换、片段一致性校验与撤销边界。保留“原会话 + 原修订 + 原内容”的接受条件。
- 异步图片粘贴的 `pending/mapRange` 已能处理操作期间的部分位置变化；不必重写通用异步操作框架。
- 代码语法着色已有基于节点对象身份的缓存；避免重复引入另一个高亮引擎。
- `content.rs` 的关键版本最多 3 条，自动保存不新增版本；保持此产品规则。

## 3. 方案一：正文脏标记与快照按需生成（P0）

### 3.1 目标

**常规逐字输入只执行 ProseMirror 事务与轻量状态通知，不在每次正文事务后生成完整 Markdown 字符串。** 在自动保存、预览、导出、复制、AI 全文读取等明确边界生成一致的正文快照。

### 3.2 接口与职责调整

建议保持当前 `MarkdownEditorHandle`，新增最小能力：

~~~ts
interface MarkdownSnapshot {
  markdown: string;
  localRevision: number;
}

// 由活动中的编辑器状态同步取得；只在明确读取点调用
captureMarkdown(): MarkdownSnapshot;

// 当前编辑器文档变化时，仅发送修订号，不传全文
onDocumentChanged(entryId: string, localRevision: number): void;
~~~

- `packages/editor-react/index.tsx`：修订插件只发修订通知；保留现有 `publish(doc)` 的 Markdown 格式化语义，并封装到 `captureMarkdown()`。不要直接改为从 `doc.textContent` 保存，那会丢失 Markdown 结构。
- `Document.tsx`：用修订回调标记正文脏，不再每键调用 `queue.edit({ contentMd })`；继续通过现有 ref 拿到编辑器实例。
- `SaveQueue`：新增正文脏版本及同步快照提供者（例如 `setContentProvider`、`markContentDirty`），在 `drain` 的每次提交前按当前修订读取一次最新 Markdown。**不要把回调函数和 ProseMirror 节点放进可持久化字段**。
- `SaveQueue.fields.contentMd` 视为“已物化的 Markdown 快照”，可能落后于编辑器实时内容。所有读取该字段的调用点必须明确快照是否已更新。
- `flush` 继续保证 `expectedVersion`、修订号和正文对应同一提交快照：读取内容后固定本次 `fields/revision/version`；保存中若又发生修改，现有 `drain` 循环读取下一版并再次提交，旧写入不能覆盖新版本。
- 标题、标签、分类等元数据更新沿用 `queue.edit`；若正文同时是脏状态，本次保存必须包含最新正文，不能用旧 `fields.contentMd` 提交。
- 自动保存从最后一次更改后 750ms 开始，建议再加入 3–5s 的连续输入最长提交间隔作为可测配置；具体值需权衡大量长文同步序列化造成的暂停。保留失焦、标签切换与退出时的 `flush` 语义。

### 3.3 所有正文消费者的迁移清单

| 调用位置 | 当前数据来源 | 调整要求 |
| --- | --- | --- |
| `index.tsx::target('document')` / `captureContext('document')` | 闭包变量 `markdown` | 在用户明确请求全文时调用 `captureMarkdown`，不读取旧缓存 |
| `index.tsx::clipboard` 全选复制 | 闭包变量 `markdown` | 复制时实时捕获一次 Markdown |
| `index.tsx::linkFootnoteMarkdown` | 以 `source === markdown` 判断是否复用活动文档树 | 将源是否为活动文档改为显式调用/新鲜快照判定；避免误用过期文本 |
| `DesktopShell.tsx` 正文复制、公众号渲染、导出链路 | `queue.snapshot().fields.contentMd` | 显式请求当前正文快照；渲染操作开始时冻结快照 |
| `DesktopShell.tsx::ActivePreview` / `Document.tsx::MarkdownPreview` | 实时订阅队列中的 Markdown | 进入预览时捕获一次；预览进行中按需要刷新，不必跟随每个输入事务 |
| `StatusBar.tsx` | `fields.contentMd` | 将字数与图片上传进度改为节流采样/按需更新，状态栏不能驱动每键全量序列化 |
| `AiPanel.tsx::apply` | `queue.snapshot().fields.contentMd` 作为应用前正文 | 修订号与应用提交回调作为判断依据；需要内容比对时从编辑器取新鲜快照 |
| `SaveQueue` 提交与关闭标签 | 快照字段 | 保存前物化，**确认提交完成后**才能销毁提供者与编辑器实例 |
| `editor-session.test.tsx` 现有 `onChange` 断言 | 同步 Markdown 回调 | 区分“文档修订通知”与“请求 Markdown 快照”的断言，保留原本内容语义用例 |

**关键正确性约束**：当前 `DesktopShell.closeTabs` 和“当前标签替换”路径已经先 `flush` 再销毁队列，可以沿用；但仍须逐一核对退出、删除、恢复、备份和应用窗口关闭路径，防止先解除编辑器 ref 后才请求快照。

### 3.4 实施细节

1. **先添加观测再改协议**：在 `publish`、`blockDecorations`、`linkFootnoteDecorations`、`normalizeDocument` 及 `SaveQueue.drain` 周围记录耗时，统计一次输入触发的序列化次数。
2. **变更事件保持轻量**：`onDocumentChanged` 同步更新计数，避免携带 Markdown 字符串；减少状态订阅者对正文更新的联动。
3. **序列化与 SQLite 写入串行分离**：每次提交只序列化当前最新修订一次；序列化期间如发生新编辑，下次循环提交更新后的版本。
4. **保存失败保留最新正文**：不能清空脏标记；重试仍以当前编辑器获取正文；乐观锁冲突仍走当前错误流程。
5. **保存快照一致性**：绑定 `localRevision` / `SaveQueue.revision` / `contentMd`；严格禁止“以新修订号标记旧 Markdown 已保存”。
6. **同步序列化的后续处理**：该方案只降低调用次数，单次超长文本序列化仍可能阻塞主线程。先测量，若一次耗时仍过大，再单独评估工作线程序列化及跨线程数据传输成本，不直接将 ProseMirror 状态迁入线程。

## 4. 方案二：装饰节点与布局检查增量化（P0–P1）

### 4.1 `editorPresentation` 的改造

当前 `blockDecorations` 会进行全树遍历，含折叠、代码高亮、代码行号、引用标记与标题装饰。建议改成插件状态管理：

1. 保存上一版 `DecorationSet`；普通 `tr.docChanged` 先通过 `set.map(tr.mapping, tr.doc)` 映射已有装饰。
2. 从 `tr.mapping.maps` 取变更范围，扩展至涉及的完整块/列表/代码块，在新文档上只重建这一区域的装饰，并替换相应旧装饰。
3. 选区与光标相关的 `syntaxAtCaret` 保持临时装饰，不参与全文缓存重建。
4. 打开/关闭行号、折叠章节、标题层级更改、整篇替换、代码语言改变等情形，允许**有依据的**更大范围失效与重建。
5. 代码行号目前跨块累计，修改前部代码块可能影响后续全局编号；先验证行号是否应保持全局连续，必要时使用块级前缀统计，再实现增量更新。不能仅按变更块重算导致后续编号错误。

优先使用现有 `@milkdown/kit/prose/view` 的 `DecorationSet`，不新引入虚拟化库或另一套装饰管理框架。

### 4.2 链接、脚注与正文整理

- `linkFootnoteDecorations`：将全局链接/脚注索引缓存到插件状态。普通纯文本更改可映射位置；涉及链接、新旧脚注定义、文档块重排时按影响范围失效。由于脚注编号可能有全局连锁变化，首版可在**链接相关变更**时全量重建，保证语义正确。
- `normalizeDocument`：先检测事务变化是否可能影响顶层脚注位置、尾部可编辑段落及容器结构；普通文字修改直接返回 `null`。现有尾段与脚注整理的事务元数据 `documentLayout` 及历史行为保留。
- `SearchBar`：只有查找面板活跃时才进行匹配；按文档版本与查询缓存结果，限制可视装饰开销。匹配计数可全量计算，但不能无界渲染所有匹配项；键盘定位与“全部替换”继续正确。
- `code-view.ts`：保留现有高亮 WeakMap 与 Mermaid 资源销毁。只对确定导致初始化超时的重型节点增加视口内资源加载策略；不要将 `content-visibility` 当作编辑器虚拟化。

## 5. 方案三：AI 局部编辑与长文快照（P1）

### 5.1 保留现有事务，不建立新 AI 保存管线

已实现的调用链为 `captureAiIntent` → `runtime` 持久化候选 → `AiPanel.apply` → `editor.replaceTarget` → `SaveQueue` 自动保存 → Rust `content::save_entry`。

保留：

- `entryId`、会话 `symbol`、本地修订号、原始 `Slice` 一致性校验。
- `replaceRange(from, to, markdownSlice(...))` 局部事务。
- 对目标范围外结构不变的校验和明确撤销边界。
- 提案记录的 `pending / applied / conflicted` 状态以及保存失败重试。
- 选区改写走自动保存；仅真正整篇覆盖才使用 `ai_replace` 关键历史。

### 5.2 长文 AI 的改进点

1. **上下文按需**：`captureContext('selection'|'section')` 仅序列化选区/章节；`document` 明确选择才整体序列化，保留现有 256 KiB 请求限制。
2. **目标片段校验**：当前 `matchesTarget` 每次会重建当前 `Slice` 的 JSON；先测量其耗时。可将目标片段比较改为结构相等或已有指纹机制，但不能削弱内容一致性。
3. **原目标外内容比较**：`replaceTarget` 用前后 `doc.slice` 检查拟合替换是否触及范围外结构。此检查应保留语义；仅在性能追踪表明其确实昂贵时，改成等效的局部边界/结构检查。
4. **保存完成判定**：`AiPanel.apply` 当前使用旧全文 `before` 与队列中更新后的 `contentMd` 判断撤销/持久化。实施脏标记协议时必须迁移到修订对应的保存状态，不能用可能滞后的 Markdown 字符串判断是否撤销。
5. **长时间生成期间的文稿编辑**：第一期继续采用现有严格修订校验，任意正文修改导致旧提案进入冲突路径。基于 `Mapping` 的目标位置迁移是**独立增强项**，不应与性能改造同时上线，因为会改变用户已确认的冲突语义。
6. **流式结果**：现有方案将模型流式输出放在侧栏，最终候选才写入正文；继续保持，不需要把每个模型增量写入 ProseMirror。
7. **AI 修改成本口径**：分别测量模型输出生成、Markdown 片段解析、目标校验、事务执行、DOM 绘制、保存序列化。不要把模型网络时延计入编辑器事务性能。

## 6. 方案四：多标签内存与极限长文模式（P2，条件触发）

### 6.1 标签页编辑器驻留

目前 `DesktopShell.tsx` 对所有 `sessions` 都挂载 `DocumentEditor`，`hidden` 仅隐藏非活动编辑器，并不会自动释放 ProseMirror DOM 与插件状态。

先测试：分别打开 1、5、10 篇 10 万字文稿，记录 JS 堆、WebView 工作集、标签切换 P95 与保存状态。

只有驻留成本超出预算后，再考虑“活动编辑器 + 少量热标签”的生命周期控制。必须通过关闭标签前保存、重开选区/滚动恢复、AI 任务绑定、异步图片回调、焦点、只读状态及撤销历史测试。若需要丢弃实例，明确撤销历史只保证活动编辑会话的行为，不暗示跨实例自动保留。

### 6.2 分段编辑的进入条件

默认**不实施** ProseMirror 内部虚拟化，也不引入社区实验型子树窗口库作为生产依赖。普通文档优先继续使用一个完整编辑器。

只有在 P0/P1 全部完成且正式 Tauri 压测仍无法满足 30 万字实际写作指标时，单独立项：

- 以 Markdown AST 标题结构生成章节边界；用户仍看到一篇完整文稿。
- 活动章节使用 Milkdown，其他章节使用轻量只读展示/占位；可用 TanStack Virtual 虚拟化章节容器。
- 明确处理章节边界增删、跨章节选区、搜索、拖动、表格/脚注跨章节引用、撤销边界、选区映射、AI 全文修改。
- 在真正实现前先出独立验证报告，确保改造成本小于长文模式带来的收益。

## 7. 基准数据、测量工具与验收门槛

### 7.1 固定数据集（在 `fixtures/performance/` 中新增生成器及固定种子）

| 编号 | 文稿规模 | 结构 | 目的 |
| --- | --- | --- | --- |
| L1 | 1 万、5 万、10 万中文字符 | 常规标题/段落 | 真实写作输入、保存 |
| L2 | 30 万、100 万中文字符 | 纯段落与长段落两组 | 编辑器容量与滚动极限 |
| L3 | 5,000 / 20,000 个短段落 | 相同总字数但节点密度不同 | DOM 与装饰树开销 |
| L4 | 100–500 KiB Markdown | 多层标题、列表、链接、脚注、引用 | 结构操作与格式保真 |
| L5 | 100–500 KiB Markdown | 表格、代码、Mermaid、公式、图片 | 重型节点初始化与资源 |
| L6 | 10 万字符以上 | AI 替换 1/20/200 段，带脚注/链接 | 局部解析、映射、撤销和保存 |

记录**中文字符数、UTF-8 字节数、ProseMirror 节点数、顶层块数、表格单元格数**，防止只按文件大小比较。

### 7.2 采集指标

| 指标 | 采集点 | 说明 |
| --- | --- | --- |
| 输入到下一帧 P50/P95/P99 | 浏览器性能事件 + 绘制追踪 | 用户感知延迟；单测 `dispatch` 时间不等于输入延迟 |
| `publish` 次数与耗时 | `index.tsx` | 核心验收：普通连续输入期间序列化次数明显下降 |
| `blockDecorations` / `linkFootnoteDecorations` 耗时 | `presentation.ts` | 看是否仍每个事务整篇重算 |
| `normalizeDocument` 执行/附加事务次数 | `index.tsx` | 结构化正确性与处理成本 |
| React 组件提交次数 | `DocumentEditor`、`StatusBar`、`SearchBar` | 验证订阅联动是否减少 |
| Markdown 解析/序列化 | 编辑器初始化与快照入口 | 分开记录首开与保存 |
| AI 目标验证/事务/撤销耗时 | `replaceTarget`、`AiPanel.apply` | 不包含模型网络时延 |
| `SaveQueue` 等待/提交/重试 | `save-queue.ts` | 关联修订号和数据库版本，不能记录正文原文 |
| Rust 保存/引用同步耗时 | `content.rs` / `references.rs` | 识别大文存储侧成本 |
| JS 堆、WebView 工作集、DOM 元素数 | Tauri 正式构建 | 包括多标签驻留成本 |

仅在开发/基准模式启用性能埋点；聚合耗时和计数，不记录用户文章原文、模型输入或图片地址。

### 7.3 运行方式

1. 用 `pnpm test` 跑单元/组件回归；此类 `jsdom` 测试用于正确性，**不得当作真实渲染性能基准**。
2. 用固定自动化脚本重放 200 次文本插入、100 次光标移动、30 次段落删除、10 次粘贴、10 次 AI 本地模拟替换；中文输入法另做真实桌面手工验证。
3. 以 **Windows 11 正式 Tauri/WebView2** 为主环境，窗口尺寸、缩放、文档样本和硬件固定；每个场景至少 5 轮，每轮保留事件分布，报告 P50/P95/P99、最长任务和内存增长。
4. 额外使用 Chromium 性能追踪与 React Profiler 辅助定位，但最终以 Tauri 内嵌 WebView 的响应结果为准。
5. 所有阶段与同一“改造前”基线比较，展示绝对耗时、百分比变化、额外内存及回归项。

### 7.4 建议验收目标（工程目标，不是当前实测）

| 场景 | 第一版目标 |
| --- | --- |
| 10 万字常规文稿连续输入 | 输入至绘制 P95 ≤ 50ms，无持续 >100ms 卡顿 |
| 30 万字纯文本常规输入 | 输入至绘制 P95 ≤ 100ms |
| 10 万字打开至可编辑 | P95 ≤ 2s |
| 10 万字 AI 替换 1–20 段 | 本地提交/可见反馈 P95 ≤ 100ms，不计生成时延 |
| 10 万字单次保存 | 单独报告序列化与 Rust 保存耗时；先基线后定门槛 |
| 连续输入 200 次 | 不得出现 200 次完整 Markdown 序列化；目标 ≤ 实际保存快照次数加显式读取次数 |
| 多次保存和关闭重开 | 已提交版本无丢字、乱序、重复；`expectedVersion` 正常工作 |
| 5 篇长文标签切换 | 报告峰值内存与关闭后回收；实际超预算再优化挂载 |
| 100 万字 | 作为实验性上限评估，决定是否独立实施分段模式 |

指标应分别报告冷启动、热启动和含大量复杂节点的结果，不能把纯文本成绩宣称为所有文稿的性能。

## 8. 实施工作包（Codex 可直接执行）

### P0-A：建立基线与诊断（先执行）

**改动范围**：新增 `fixtures/performance/` 测试样本生成器、基准脚本；在指定热点增加仅开发环境可开关的计时器。

**验收**：
- 采集 L1、L3、L4、L5 的首开、200 次输入、保存与 AI 局部替换数据。
- 有截图/报告说明主线程耗时归属；确认 `publish`、装饰重建、React 提交各自开销。
- 代码改动不影响正式构建，不输出文稿正文。

### P0-B：正文修订通知与按需快照（核心）

**改动范围**：`editor-react/index.tsx`、`Document.tsx`、`save-queue.ts`、`DesktopShell.tsx`、`StatusBar.tsx`、`AiPanel.tsx` 及有关测试。

**验收**：
- 输入事务不执行 `publish`；保存、复制、预览、AI 全文读取显式生成当前 Markdown。
- 当前自动保存 750ms、版本乐观锁、失败重试、标签关闭/替换逻辑继续成立。
- 文稿保存时正好发生新的键入，最终磁盘版本与编辑器版本一致。
- 图片引用、微信预览、导出、查找、全选复制、字数统计、AI 提案状态无回归。
- 修改现有依赖“每键同步 Markdown”的测试，新增快照协议测试；不要通过删掉断言完成迁移。

### P1-A：装饰与文档整理热路径

**改动范围**：`presentation.ts`、`index.tsx::normalizeDocument`、`link-footnotes.ts`（按需）、`SearchBar`。

**验收**：
- 普通段落输入不再导致全局 `blockDecorations` 重建。
- 保持代码语法高亮、代码行号、标题折叠、callout、链接转脚注、选区、表格格式和查找结果准确。
- 测试“文首插入导致后续行号/脚注编号变化”一类全局失效场景。
- 普通长文的输入延迟与基线相比明显改善，且没有明显的 DOM/装饰内存泄漏。

### P1-B：AI 长文局部修改

**改动范围**：`index.tsx::captureContext/matchesTarget/replaceTarget`、`AiPanel.tsx` 及 AI 相关测试。

**验收**：
- 选区和章节只提取所需 Markdown；显式全文读到最新快照。
- AI 修改目标外正文不变，单次可撤销；原会话/修订冲突正确拒绝。
- AI 结果提交后保存失败、撤销、重试、切换标签与关闭文档都能得到正确状态。
- 仅在测得瓶颈后优化 `Slice` JSON/前后文比较，保持结果等价。

### P2：真实瓶颈驱动的专项优化

**候选**：多标签驻留控制、重型代码/图片/表格节点的可见区初始化、Rust 正文引用增量更新。

**启动条件**：P0/P1 真实压测指出对应瓶颈；优先使用现有依赖及浏览器能力。

**验收**：带对照基线；专项正确性与主功能回归通过。分段编辑不包含在本阶段默认改造中。

## 9. 必须补充/保留的正确性测试

1. **连续输入 + 自动保存**：在 `flush` 已开始而用户继续输入时，先保存旧版本，再保存新版本，最终 SQLite 与编辑器一致。
2. **元数据与正文同时更新**：修改标题/分类/封面并继续输入，数据库保存不能携带旧正文；保留乐观锁冲突行为。
3. **关闭与切换标签**：先快照/保存，再销毁编辑器；异步粘贴、图片替换任务仍绑定原始会话。
4. **预览/导出/复制**：最后一个尚未自动保存的字符必须出现在输出中。
5. **AI 全文/章节引用**：生成期间发生编辑后，严格版本检查与提案冲突语义一致。
6. **AI 修改后撤销**：段落级/章节级替换均可一次撤销，状态栏、保存记录、提案状态正确。
7. **链接、脚注和折叠**：修改文首链接后，后文脚注编号/渲染准确；删除或重排标题后折叠位置有效。
8. **复杂结构**：表格中编辑/多单元选区、代码块、Mermaid、公式、图片、中文输入法组合输入正确。
9. **Markdown 往返保真**：加载→编辑无关段落→保存→重开后结构与既有序列化约定保持一致。
10. **多标签回收**：保存/关闭/恢复 50 次后检查对象 URL、事件订阅、编辑器实例及内存增长趋势。

重点复用已有测试文件 `editor-session.test.tsx`、`save-queue.test.ts`、`document.test.tsx`、`workspace-session.test.tsx`，针对新协议追加断言，不为了压测移除现有功能保护。

## 10. 交付顺序与关联规则

- 本文是本次长文性能改造的执行基线；实现时同步更新与之矛盾的 `ai-writing-assistant-technical-design.md` 接口说明。
- **先量化、再优化**：一次提交只解决一组明确瓶颈，附前后相同样本测量结果。
- 第一优先级是全文序列化热路径，其次全文装饰、保存消费者与 AI 快照一致性；多编辑器生命周期和分段编辑按数据立项。
- 不更换 Milkdown、SQLite、Tauri，不增加独立后端、不引入新的文档数据库格式，也不额外实现通用冲突合并框架。
- 阶段交付包含：相关源码改动、通过的回归测试、真实 Tauri 性能数据、变更范围与剩余性能热点说明。

## 11. 参考文档

- [ProseMirror 官方开发指南：高效更新、事务映射、装饰集合](https://prosemirror.net/docs/guide/)
- [Milkdown 官方：架构与 Markdown 解析、序列化](https://milkdown.dev/docs/guide/architecture-overview)
- [Milkdown 官方：监听器与文档变更](https://milkdown.dev/docs/api/plugin-listener)
- [Milkdown 官方：编辑器实例和按需获取 Markdown](https://milkdown.dev/docs/guide/using-crepe)
- [ProseMirror 搜索模块](https://github.com/ProseMirror/prosemirror-search)

以上外部资料用于确认通用 API 与技术机制；对具体瓶颈的定位以本仓库当前代码为准。
