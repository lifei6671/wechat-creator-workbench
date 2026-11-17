# 专题文本卡片所见即所得编辑增量技术方案

> 项目：wechat-creator-workbench
>
> 日期：2026-11-17
>
> 适用范围：已完成的专题画布第一版（React Flow + SQLite）中的 `text` 节点
>
> 目标：文本卡片直接编辑排版后的 Markdown，维持既有专题、文章和素材工作流
>
> 关联：[专题画布与 GitHub README 导入技术方案](./topic-canvas-technical-design.md)、[Milkdown 长文性能方案](./milkdown-long-document-performance-plan.md)、[桌面 UI 规范](./ui-design-guidelines.md)

## 1. 已实现基线与改造目标

当前专题画布已经具备独立专题、文章/截图/文本节点、连线、节点拖动/缩放、粘贴、保存与恢复、文章跳转和文本转原创文章。**这份文档只指导在现有代码上增加文本节点的原地所见即所得编辑，不是第一版专题功能的重新开发计划。**

### 1.1 当前源码确认

| 路径 | 当前能力 | 本次改造点 |
| --- | --- | --- |
| `apps/desktop/src/workspace/CollectionNodes.tsx` | `TextPreview` 使用 `renderMarkdown`；编辑态是 `textarea`，通过 `editingId` 切换 | 编辑态挂载现有 Milkdown，阅读态保留 `TextPreview` |
| `apps/desktop/src/workspace/CollectionCanvas.tsx` | `editingId`、`changeText`、`finishText`、`pendingText`、`flushText`、串行 `enqueue` | 把逐键字符串事件改为修订通知和按需 Markdown 快照；统一退出编辑前的捕获 |
| `packages/editor-react/index.tsx` | `MarkdownEditor` 已有 `onDocumentChanged`、`MarkdownEditorHandle.captureMarkdown()`、`clipboard()`、异步创建与卸载销毁 | 直接复用；仅当卡片布局/交互被现有编辑器插件实际阻断时做局部适配 |
| `apps/desktop/src/editor/clipboard.ts` | `attachClipboard` 在捕获阶段接管 copy/cut/paste，包括快捷键 | 通过现有全局路由将编辑卡片事件交给 Milkdown |
| `apps/desktop/src/workspace/DesktopShell.tsx` | `collectionMode` 下只把粘贴事件交给 `canvas.paste(target)`；文章模式有 `editorClipboard` | 扩展专题画布剪贴板调用，复用 `editorClipboard` |
| `apps/desktop/src/workspace/collection-canvas.css` | 卡片定位、选中态、滚动及尺寸调整 | 为卡片内部 `.editor-host` / `.editor-scroll` / `.ProseMirror` 添加局部样式 |
| `src-tauri/src/content/collections.rs` | `update_collection_node_text(node_id, markdown)`、`convert_collection_text` | 保留 Rust 命令及表结构 |
| `src-tauri/src/assets/cleanup.rs` | 已统计 `collection_nodes.asset_id`，尚未扫描文本节点 `content_md` 中的图片引用 | 若卡片编辑器可插入图片/远程图，则同步纳入 Markdown 资源引用 |

现有依赖 `@xyflow/react@12.12.1`、`@milkdown/kit@7.23.0` 均已安装，不增加新的编辑器依赖。当前主编辑器通过 ProseMirror 修订插件仅通知修订号，在 `captureMarkdown()` 读取时才序列化 Markdown：卡片沿用这一性能约定。

### 1.2 目标体验及边界

1. 双击 **text** 卡片进入 Milkdown 所见即所得编辑态，可直接编辑标题、段落、加粗、列表、引用、代码及链接等现有编辑器支持的 Markdown 内容。
2. 同时只有一个文本节点处于编辑态；其余节点继续使用轻量 `renderMarkdown()`，画布大量卡片无需创建大量 ProseMirror 实例。
3. 编辑时允许选择文字、滚动长卡片、撤销/重做；鼠标操作不会拖动画布或节点。
4. 点击画布空白处、切换卡片、按 Esc、切换专题标签或关闭工作区时，先取得最后一版 Markdown，再交由既有 `update_collection_node_text` 保存。
5. 文章节点继续打开已有正文编辑器；图片节点继续调整大小；文本转原创文章、画布连线、位置保存和视口恢复保持现有行为。
6. 文本节点本身属于专题，仍然保存在 `collection_nodes.content_md`；不增加 `entries`、历史版本或新数据库表。画布操作不修改 `entries.version`。

**本轮集中于文本排版与链接编辑**。截图仍优先作为 `image` 节点；如果现有完整版编辑器允许向文本卡片粘贴富文本图片或插入 `asset://` 图片，必须同时满足第 5 节的资源引用一致性，避免编辑成功后素材被清理。

## 2. 选型：复用现有 MarkdownEditor

在 `apps/desktop/src/workspace/CanvasTextEditor.tsx` 新增薄适配组件，内部按需挂载现有 `MarkdownEditor`，不另外引入富文本引擎或复制完整 Milkdown schema。

适配器的核心职责：

- 初次挂载使用节点的 `contentMd` 初始化编辑器；同一编辑会话内 ProseMirror 文档为实时内容权威，不用上层 `contentMd` 逐键重置编辑器。
- 以 `canvas:<nodeId>` 作为编辑器会话标识，避免与文章 Entry ID 相混淆。此标识只供编辑器会话使用，不写入 entries。
- 通过 `MarkdownEditorHandle` 的 `ref` 注册/注销活动编辑器，并在异步初始化完成后调用 `handle.focus()`。清理时解除注册，防止对已销毁编辑器取快照。
- `onDocumentChanged` **只报脏修订**，不在每次 ProseMirror 事务后提取整篇 Markdown。
- 提供同步 `captureMarkdown()` 和 `clipboard(action, io, target, plainText)` 给画布容器，分别完成保存快照和系统剪贴板路由。
- `onBlur` 仅请求快照/保存，不作为强制卸载信号；编辑器内部的悬浮工具、焦点转移与链接操作不应该立刻结束会话。

推荐组件界面（示意类型，最终以项目已有命名为准）：

~~~ts
interface CanvasTextEditorHandle {
  captureMarkdown(): string;
  clipboard(
    action: ClipboardAction,
    io: ClipboardIO,
    target: EventTarget | null,
    plainText?: boolean
  ): boolean;
}

interface CanvasTextEditorProps {
  nodeId: string;
  initialMarkdown: string;
  register(nodeId: string, handle: CanvasTextEditorHandle | null): void;
  onDirty(nodeId: string, localRevision: number): void;
  onBlur(nodeId: string): void;
  onFinish(nodeId: string): void;
  onError(error: unknown): void;
}
~~~

组件对既有 `MarkdownEditor` 使用 `value=initialMarkdown`、`readOnly={false}`、`active`、`onDocumentChanged`、`onBlur`、`ref`。只有进入编辑态时实例化，其他时候仍使用 `TextPreview`。

画布内部只有一个活动编辑器；持有 `{ nodeId, handle, container }` 的 ref 即可，不建立跨专题编辑器管理器。编辑器创建是异步的，在 `ref(handle)` 到达之前保持原文本数据，首次聚焦由回调触发。

## 3. 改造步骤与接口边界

### 3.1 CollectionNodes.tsx：切换渲染与编辑

保留现有 `CanvasCard`、`TextPreview`、`CollectionImage` 和 `collectionNodeTypes`，只将 `kind === "text" && editing` 的 `textarea` 改为 `CanvasTextEditor`。

- 阅读态仍由 `renderMarkdown(data.contentMd)` 渲染；卡片仍允许双击进入编辑。
- 编辑态用 `CanvasTextEditor`；外层设置 `nodrag nopan nowheel`，且保留当前 `data-editing` 与选中边框。
- 编辑器初始化只使用本次进入时的 `contentMd`；React Flow 的受控节点更新不重新创建当前 Milkdown。
- 内容编辑结束后刷新当前 `FlowNode.data.contentMd`，让 `TextPreview` 直接反映最近快照。
- 卡片尺寸调整仍走现有 `NodeResizer`；编辑期间按当前第一版行为隐藏卡片尺寸控制，避免文本选择和缩放手柄竞争焦点。

### 3.2 CollectionCanvas.tsx：单次防抖、最终快照、串行保存

保留 `pendingText` / `enqueue` / `flushText` 的写入职责。改造关键是从 **文本输入变更** 变成 **文档修订通知 + 延迟快照**：

~~~text
ProseMirror 文档修改
  -> onDocumentChanged(nodeId, localRevision) 标记脏
  -> 重置该卡片已有的 350ms 计时器
  -> 超时或离开编辑前：captureMarkdown() 同步取快照
  -> 把快照写入 nodesRef / React 节点和待保存草稿
  -> enqueue(updateCollectionNodeText) 依次写入 SQLite
  -> 成功后清除对应草稿
~~~

实现要点：

1. **只保留一层约 350ms 防抖**。修订事件只安排下一次快照；快照到手后直接进入待保存队列，不能再通过旧 `changeText` 叠加第二层 350ms。
2. `captureCurrentText(nodeId)` 为同步操作：只在活动编辑器属于该节点且存在待保存修订时取 `captureMarkdown().markdown`；同步更新 `nodesRef`、受控节点与 `pendingText`。这是隐藏编辑器前的强制动作。
3. `flushText(nodeId)` 先调用 `captureCurrentText(nodeId)`，再按照现有 `enqueue` 写入。正在保存的快照与后续新修订应按提交顺序写入；旧响应只清除其对应草稿，不能覆盖后来的文本。
4. `finishText(nodeId)` 先完成同步捕获，然后进入保存。成功后退出编辑态；保存失败保留已捕获的文本和待保存状态，向用户显示错误并允许重试。禁止先 `setEditingId(null)` 再试图读取编辑器。
5. `flush()` 同步捕获活动编辑器的最后修订，并等待待保存队列完成，供已存在的标签切换、退出与恢复流程调用；不能只读取已排队的 `pendingText`，忽略尚未到达防抖时限的编辑。
6. `convert(node)` 先捕获和保存最新文本，再调用 `convertCollectionText`；避免最后输入还在 ProseMirror 中就把旧 Markdown 转成文章。
7. 删除正在编辑的卡片时停止该节点计时器，并按用户的删除操作和现有删除命令处理。保存、删除仍走同一 `enqueue` 序列，不让旧的保存请求在删除后重建节点。
8. `onNodesChange` 中「选中另一节点」与 React Flow `onPaneClick`、画布键盘 Esc 的逻辑统一进入 `finishText`，不要再直接 `setEditingId(null)`；编辑器内 Esc 在合成输入期间不触发退出。

建议使用现有 `nodesRef`、`pendingText`、`tail` 和单个 `editingId` 完成这些行为。这里的异步先后关系是实际存在的数据一致性问题，使用当前串行队列即可，无需新的状态机或二级数据库。

### 3.3 Clipboard：在已有捕获阶段路由到当前 Milkdown

当前 `apps/desktop/src/editor/clipboard.ts` 的 `attachClipboard()` 会在 **捕获阶段** 对 copy、cut、paste 和常用快捷键执行 `preventDefault`；在 `DesktopShell.tsx` 的 `collectionMode` 分支只处理空白画布 paste。

因此，`CanvasTextEditor` 成为 contenteditable 后，必须同时接入三种剪贴板动作。推荐扩展 `CollectionCanvasHandle`：

~~~ts
interface CollectionCanvasHandle {
  clipboard(
    action: ClipboardAction,
    io: ClipboardIO,
    target: EventTarget | null,
    plainText?: boolean
  ): boolean;
  flush(): Promise<void>;
  addEntry(entryId: string): Promise<void>;
}
~~~

调用规则：

1. 事件目标位于当前活动卡片的 `.ProseMirror` 及其编辑容器时，由活动编辑器 `handle.clipboard(action, io, target, plainText)` 执行；保持现有 Markdown/富文本复制、剪切和粘贴行为。
2. 其他画布空白位置的 paste 继续走已有 `paste(target)`，创建文本或截图节点。
3. 焦点在弹窗或普通 input/textarea 时继续交给既有处理路径；不让画布读取或覆盖弹窗中的文字。
4. `DesktopShell.tsx` 将已有 `editorClipboard` 传给专题画布调用，不复制一套系统剪贴板适配器。
5. 任何编辑态内的粘贴，只对当前卡片有效；切换卡片期间尚未完成的异步粘贴应利用编辑器既有的会话/选区范围检查。

`CollectionCanvas` 的 `paste(target)` 已对 `[contenteditable=true]` 做了排除；这个排除继续保留，但必须由新的 clipboard 分派先接管编辑器事件，否则全局捕获监听器会阻断浏览器默认粘贴。

### 3.4 焦点与结束编辑

焦点管理建议使用显式的完成入口，覆盖：

| 触发 | 行为 |
| --- | --- |
| 双击 text 卡片 | 挂载 Milkdown；异步初始化后聚焦 |
| 点击画布空白区域 | 捕获当前 Markdown → 保存 → 退出编辑 |
| 双击另一 text 卡片 | 捕获原节点 → 保存 → 进入新节点编辑 |
| 编辑卡片内按 Esc | 退出卡片编辑，画布保留节点 |
| 切换文章/专题标签 | 先调用现有 `canvas.flush()`，捕获编辑器内容后完成切换 |
| 「创建原创文章」 | 捕获并保存最新文本后转换 |
| 点击浮动格式工具或链接工具 | 保持编辑会话和选区；单纯 `blur` 只安排保存 |
| 应用退出或数据库恢复 | 使用现有 `CollectionCanvas.flush()` 及写入等待机制 |

注意：`MarkdownEditor` 的 `onBlur` 来自 ProseMirror DOM，不代表用户一定离开整张卡片。不要把失焦等同于卸载；特别是有 Tooltip、悬浮工具或菜单的情况下。结束操作必须同步捕获，避免 React 卸载使 handle 失效。

### 3.5 CSS：只覆盖卡片内编辑器

在 `collection-canvas.css` 中添加 `.collection-text-editor` 作用域，避免影响文章编辑区。初始实现可沿用以下规则，再根据当前设计变量调节：

~~~css
.collection-text-editor {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
  cursor: text;
  user-select: text;
}

.collection-text-editor .editor-host,
.collection-text-editor .editor-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.collection-text-editor .editor-scroll {
  --writing-gutter: 12px;
  --writing-width: 100%;
  --block-controls-gutter: 0px;
}

.collection-text-editor .ProseMirror {
  padding: 10px 14px;
  font-size: var(--workspace-font);
  line-height: 1.5;
}
~~~

编辑区容器挂载 `nodrag nopan nowheel`，确保内部滚轮不会缩放画布、拖选文字不会拖动节点、删除键只对编辑器生效。完整文章编辑器中的浮动块工具和宽屏布局在窄卡片上可能遮挡正文，先用卡片作用域样式调整可见性和尺寸；只有实测无法隔离时才增加可选的 `mode="canvas"` 来隐藏完整文章特有的控件。

## 4. 数据、保存和性能约束

- **SQLite 不迁移**：保留 `collection_nodes.content_md` 和 `update_collection_node_text` 命令；每张文本卡片只有一份 Markdown 持久化内容。
- **文章 SaveQueue 不改**：文本卡片走独立的 CollectionCanvas 保存队列，文章正文继续走原本 SaveQueue 和乐观版本规则。
- **原文渲染保持轻量**：未激活的卡片继续 `renderMarkdown`，无需持有 `MarkdownEditor` 或 ProseMirror 状态。
- **只在有实际内容变化时保存**：只修改选区、移动光标、缩放画布不触发正文写入；相同 Markdown 快照无需重复提交。
- **编辑器实例数量**：正常专题视图同时存在的 Milkdown 实例数量应为 0 或 1。不得因为页面存在 100 张文本卡片就创建 100 个编辑器。
- **正在编辑的节点不被旧异步结果覆盖**：既有 `pendingText` 草稿和串行 `enqueue` 保持最后一次修订一致性；保存失败的草稿仍能显示和重试。
- **文本卡片资源引用**：`src-tauri/src/assets/cleanup.rs::referenced()` 已保护 image 节点的 asset_id。对于文本 Markdown 中出现的 `asset://` 图片、已登记图床 URL 或派生资源，读取 `collection_nodes WHERE kind='text'` 的 `content_md` 并调用已有 `references::urls` / `derived_keys` 纳入引用集合；与文章正文相同的哈希组清理规则适用。此改动与卡片富文本粘贴一并验收。现有 TextPreview 对图片可能转为占位；图片展示行为优先延续专题截图节点，避免另写一套卡片图片渲染引擎。
- **图片进入文本节点**：可以沿用现有 MarkdownEditor 粘贴语法，但产品默认建议将截图粘贴到画布空白处生成 image 节点。若编辑器中插入图片，其引用必须受到前述清理保护，不能发生「编辑态能看见、退出应用后被清理」。
- **性能检验**：先对 100 张卡片（其中 30 张文本卡片）的普通画布与单张卡片编辑态进行对比；记录是否仅创建 1 个 Milkdown、首次进入编辑耗时、连续输入以及退出编辑后的渲染开销。具体毫秒数以实测记录，不预设空泛加速倍数。

## 5. 改造文件与任务顺序

| 顺序 | 文件 | 最小改动 | 完成判定 |
| --- | --- | --- | --- |
| 1 | 新增 `apps/desktop/src/workspace/CanvasTextEditor.tsx` | 用 `MarkdownEditor` 包装卡片编辑，注册活动 handle、修订通知、异步就绪聚焦、同步快照 | 一张 text 卡片能原地编辑标题、加粗、列表 |
| 2 | `CollectionNodes.tsx` | text 编辑态挂载 CanvasTextEditor，阅读态保留 TextPreview | 双击进入和退出后 Markdown 一致，卡片位置/尺寸不改变 |
| 3 | `CollectionCanvas.tsx` | 单层防抖、同步捕获、串行保存、统一完成入口、convert 前提交 | 快速离开/切换/转换文章不丢最后输入 |
| 4 | `CollectionCanvas.tsx` + `DesktopShell.tsx` | 活动编辑器的 copy/cut/paste 路由及外部空白画布粘贴 | 卡片编辑与画布粘贴互不干扰 |
| 5 | `collection-canvas.css` | 局部字体、留白、滚动、浮动控件适配 | 文本编辑不误拖节点，不出现宽屏样式溢出 |
| 6 | `src-tauri/src/assets/cleanup.rs` | 扩展文本节点内的素材引用统计及局部测试 | 卡片里的资产引用在退出清理后仍有效 |
| 7 | 相关组件/集成测试 | 补充本期交互和保存场景；按现有脚本执行类型检查、测试和构建 | 验收清单逐项通过 |

新增依赖、数据库迁移、替换 React Flow、重建 Milkdown Schema 和文章 SaveQueue 均不属于本期工作项。文件名、具体函数签名以执行时最新仓库代码为准。

## 6. 验收标准

### 6.1 Markdown 编辑

- [ ] 双击文本卡片进入原地所见即所得编辑，支持标题、段落、列表、加粗、引用、代码和链接等现有 Milkdown 格式。
- [ ] 编辑器内继续输入时内容直接排版；退出后 TextPreview 视觉内容和 Markdown 语义一致；关闭重开专题后持久化内容一致。
- [ ] 仅当前活动卡片创建 Milkdown 实例；其他卡片正常保持轻量渲染，连续编辑 20 张卡片后无遗留编辑器实例。

### 6.2 一致性与保存

- [ ] 最后输入一个字符后立即点击空白画布、切换另一个节点、打开文章或关闭专题，内容完整保存。
- [ ] 在正在进行的自动保存期间继续输入，最终数据库中的 content_md 是最新一版，不被旧的异步结果覆盖。
- [ ] 从编辑中的文本卡片选择「创建原创文章」，转换结果包含最后一笔修改且只创建一篇文章。
- [ ] 保存请求失败时有明确错误提示，最新文本保留在前端待保存状态，用户可继续编辑或重试；不会把失败显示为已保存。
- [ ] 切换专题、退出应用、准备数据库恢复仍沿用当前画布与工作台的 flush/等待规则。

### 6.3 画布与剪贴板

- [ ] 编辑器内的 Ctrl/Cmd+C、X、V、Z（以及重做）作用于文本内容；画布空白区域粘贴仍创建节点。
- [ ] 编辑器内 Delete/Backspace 删除文字；非编辑状态下删除选中节点。
- [ ] 编辑器内拖选文字、滚动、输入中文、操作格式工具不会拖动节点、平移/缩放画布或提前卸载编辑器。
- [ ] 点击画布空白区域、按 Esc 或切换卡片时编辑器正常退出；在编辑器内部浮动控件交互不会误关闭。
- [ ] 画布中图片节点、文章节点、连线、缩放、对齐辅助线、截图粘贴和导入 README 流程仍正常工作。

### 6.4 素材与性能

- [ ] 含 `asset://` 图片引用的文本卡片，关闭重开及执行正常退出素材清理后引用仍有效；删除最后一处引用后沿用原有清理顺序回收。
- [ ] 100 节点专题下，非编辑态无 Milkdown 实例；单卡编辑态只挂载一个，输入没有因全节点重渲染出现持续明显卡顿。
- [ ] `pnpm typecheck`、受影响的 Vitest 测试及 Rust 对应测试通过；按照当前仓库的构建脚本核对前端和 Tauri 集成结果。

## 7. 执行交接

交给 Codex 的任务为：

> 请按 `docs/topic-canvas-inline-editing-plan.md` 对已完成的专题画布增量改造：文本节点在编辑态使用现有 Milkdown 所见即所得编辑器；保留 React Flow、现有节点/连线、SQLite 与文章 SaveQueue。实现编辑器按需挂载、脏修订延迟快照、退出前同步捕获、串行保存、活动编辑器剪贴板路由及卡片样式；使图片引用继续遵守现有素材生命周期。完成后运行受影响测试与类型检查，记录可复现的验证结果。
