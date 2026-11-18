# 专题画布文本编辑与网页预览增量技术方案

> 项目：wechat-creator-workbench
>
> 更新日期：2026-11-18
>
> 适用范围：现有 React Flow + SQLite 专题画布的两项增量需求。第 1 至 6 节为文本卡片，第 7 节为网页卡片。
>
> 目标：文本卡片直接编辑排版后的 Markdown。粘贴外部链接可生成网页卡片，在画布内浏览原网页。
>
> 关联：[专题画布与 GitHub README 导入技术方案](./topic-canvas-technical-design.md)、[Milkdown 长文性能方案](./milkdown-long-document-performance-plan.md)、[桌面 UI 规范](./ui-design-guidelines.md)

## 1. 已实现基线与改造目标

当前专题画布已经具备独立专题、文章/截图/文本节点、连线、节点拖动/缩放、粘贴、保存与恢复、文章跳转和文本转原创文章。文章卡片已支持在画布内使用 Milkdown 编辑正文，也可单独打开文章。文本卡片当前用 `textarea` 编辑 Markdown 源码，阅读态显示排版。

### 1.1 当前源码确认

| 路径 | 当前能力 | 本次改造点 |
| --- | --- | --- |
| `apps/desktop/src/workspace/CollectionNodes.tsx`、`CollectionEditorScope.tsx` | `TextPreview` 使用 `renderMarkdown`，文本编辑态由 `CollectionTextEditor` 渲染 `textarea` | 文本编辑态挂载现有 Milkdown，阅读态保留 `TextPreview` |
| `apps/desktop/src/workspace/CollectionCanvas.tsx` | `editingId`、`changeText`、`finishText`、`pendingText`、`flushText`、串行 `enqueue` | 把逐键字符串事件改为修订通知和按需 Markdown 快照；统一退出编辑前的捕获 |
| `apps/desktop/src/workspace/CollectionArticle.tsx` | 文章卡片已使用 `MarkdownEditor`、剪贴板和文章 `SaveQueue` | 复用卡片内的焦点与交互样式，文本卡片继续走画布队列 |
| `packages/editor-react/index.tsx` | `MarkdownEditor` 已支持修订通知、`captureMarkdown()`、`pendingEdits()`、剪贴板和异步初始化 | 直接复用现有接口 |
| `apps/desktop/src/editor/clipboard.ts` | `attachClipboard` 在捕获阶段接管 copy/cut/paste，包括快捷键 | 通过现有全局路由将编辑卡片事件交给 Milkdown |
| `apps/desktop/src/workspace/DesktopShell.tsx` | 专题模式先调用 `articleClipboard()`，其余粘贴由 `canvas.paste(target)` 处理。文本输入框走普通字段处理 | 将活动卡片路由扩展到文本编辑器，复用 `editorClipboard` |
| `apps/desktop/src/workspace/collection-canvas.css` | 卡片定位、选中态、滚动及尺寸调整 | 为卡片内部 `.editor-host` / `.editor-scroll` / `.ProseMirror` 添加局部样式 |
| `src-tauri/src/content/collections.rs` | `update_collection_node_text(node_id, markdown)`、`convert_collection_text` | 保留 Rust 命令及表结构 |
| `src-tauri/src/assets/cleanup.rs` | 已统计 `collection_nodes.asset_id`，尚未扫描文本节点 `content_md` 中的图片引用 | 将文本卡片的 Markdown 图片纳入素材引用统计 |

现有依赖 `@xyflow/react@12.12.1`、`@milkdown/kit@7.23.0` 均已安装，不增加新的编辑器依赖。当前主编辑器通过 ProseMirror 修订插件仅通知修订号，在 `captureMarkdown()` 读取时才序列化 Markdown：卡片沿用这一性能约定。

### 1.2 目标体验及边界

1. 双击 **text** 卡片进入 Milkdown 所见即所得编辑态，可直接编辑标题、段落、加粗、列表、引用、代码及链接等现有编辑器支持的 Markdown 内容。
2. 当前画布同时最多有一张文本或文章卡片处于编辑态。其余卡片保持轻量阅读预览。
3. 编辑时允许选择文字、滚动长卡片、撤销/重做；鼠标操作不会拖动画布或节点。
4. 点击画布空白处、切换卡片、按 Esc、切换专题标签或关闭工作区时，等待当前编辑器已启动的异步修改完成，保存最后一版 Markdown，再退出编辑。
5. 文章卡片支持画布内编辑和单独打开。图片卡片沿用现有的尺寸调整。文本转原创文章、画布连线、位置保存和视口恢复沿用现有工作流。
6. 文本节点属于专题，保存在 `collection_nodes.content_md`。编辑文本节点无需创建 `entries` 或历史版本，写入范围限于画布文本。

文本卡片支持 Markdown 链接和内嵌图片。空白画布粘贴截图时创建图片节点，文本编辑区粘贴图片时插入 Markdown 图片。内嵌图片和第 4 节的素材引用保护一起交付。

## 2. 选型：复用现有 MarkdownEditor

在 `apps/desktop/src/workspace/CanvasTextEditor.tsx` 新增薄适配组件，内部按需挂载现有 `MarkdownEditor`，不另外引入富文本引擎或复制完整 Milkdown schema。

适配器的核心职责：

- 初次挂载使用节点的 `contentMd` 初始化编辑器；同一编辑会话内 ProseMirror 文档为实时内容权威，不用上层 `contentMd` 逐键重置编辑器。
- 以 `canvas:<nodeId>` 作为编辑器会话标识，避免与文章 Entry ID 相混淆。此标识只供编辑器会话使用，不写入 entries。
- 通过 `MarkdownEditorHandle` 的 `ref` 注册/注销活动编辑器，并在异步初始化完成后调用 `handle.focus()`。清理时解除注册，防止对已销毁编辑器取快照。
- `onDocumentChanged` **只报脏修订**，不在每次 ProseMirror 事务后提取整篇 Markdown。
- 向画布注册现有 `MarkdownEditorHandle`。`captureMarkdown()` 同步返回 `{ markdown, localRevision }`，`pendingEdits()` 返回已启动的异步编辑任务，`clipboard()` 处理系统剪贴板。
- `onBlur` 只请求保存，编辑会话继续。编辑器内部的悬浮工具、焦点转移和链接操作保留当前会话。

推荐组件界面（示意类型，最终以项目已有命名为准）：

~~~ts
interface CanvasTextEditorProps {
  nodeId: string;
  initialMarkdown: string;
  register(nodeId: string, handle: MarkdownEditorHandle | null): void;
  onDirty(nodeId: string, localRevision: number): void;
  onBlur(nodeId: string): void;
  onFinish(nodeId: string): void;
  onError(error: unknown): void;
}
~~~

组件为既有 `MarkdownEditor` 传入 `entryId`、`value={initialMarkdown}`、`active`、`onDocumentChanged`、`onBlur`、`onEscape`、`ref`，图片加载与插入沿用现有入口。只有进入编辑态时实例化，其他时候使用 `TextPreview`。

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
  -> 防抖到期或失焦请求保存时，captureMarkdown() 同步读取已生效的修订
  -> 把快照写入 nodesRef / React 节点和待保存草稿
  -> enqueue(updateCollectionNodeText) 依次写入 SQLite
  -> 成功后清除对应草稿
~~~

实现要点：

1. **保留一层约 350ms 防抖。** 日常自动保存和失焦请求读取编辑器中已经生效的修订。快照取得后直接交给现有队列写入。
2. `captureCurrentText(nodeId)` 同步读取活动编辑会话的 `{ markdown, localRevision }`。修订号判断是否需要捕获，Markdown 内容判断是否需要写入。以已保存内容和已排队写入顺序为准去重，确保用户将正文改回原文时也能覆盖正在写入的其他版本。
3. 有新快照时同步更新 `nodesRef`、受控节点和 `pendingText`。`flushText(nodeId)` 使用 `enqueue` 按顺序写入，成功后只清除该请求对应的草稿。
4. **结束编辑先等异步修改，再取最终快照。** `finishText(nodeId)` 复用文章卡片的 `pendingEdits()` 等待剪切、粘贴、图片导入或本地化等已启动任务。保持原会话可用，等待和保存期间若又产生任务或修订，继续处理至最新内容已提交，再退出编辑或切换节点。保存失败时保留原编辑器及草稿，显示错误，允许继续编辑或重试。
5. `flush()` 复用最终提交逻辑，等待当前编辑器的异步任务和最新修订，同时提交待保存草稿。工作台切换或关闭标签、备份、迁移导出、应用退出和确认恢复使用现有 `flush()` 入口。备份和导出调用完成后可继续当前编辑会话。
6. `convert(node)` 先提交活动编辑器的最新内容，再调用 `convertCollectionText`。沿用正在转换的状态限制重复提交，文本写入失败时保留编辑会话。
7. 删除正在编辑的卡片时停止该节点计时器，沿用现有节点删除命令。已入队的保存与删除使用同一 `enqueue` 序列，删除成功后清除该节点草稿。
8. `onNodesChange` 中选中另一节点、React Flow `onPaneClick` 和编辑区 Esc 统一进入 `finishText`。是否切换以及切到哪张卡片以当前操作意图为准，旧请求完成后不得覆盖较新的切换意图。

建议使用现有 `nodesRef`、`pendingText`、`tail` 和单个 `editingId` 完成这些行为。这里的异步先后关系是实际存在的数据一致性问题，使用当前串行队列即可，无需新的状态机或二级数据库。

### 3.3 Clipboard：在已有捕获阶段路由到当前 Milkdown

当前 `apps/desktop/src/editor/clipboard.ts` 的 `attachClipboard()` 会在捕获阶段接管 copy、cut、paste 和对应快捷键。`DesktopShell.tsx` 已优先把事件交给画布内的文章编辑器，剩余粘贴再交给画布。

将现有文章卡片剪贴板入口扩展为活动卡片入口。画布已经获得 `editorClipboard`，接口可沿用现有的参数形状。

~~~ts
interface CollectionCanvasHandle {
  clipboard(
    action: ClipboardAction,
    target: EventTarget | null,
    plainText?: boolean
  ): boolean;
  paste(target: EventTarget | null): boolean;
  flush(): Promise<void>;
  addEntry(entryId: string): Promise<void>;
}
~~~

调用规则：

1. 将事件转发给当前活动卡片的 `handle.clipboard(action, clipboard, target, plainText)`，由现有接口判断事件是否属于编辑器正文。文本和文章卡片共享 Markdown、富文本及图片剪贴板能力。
2. 画布空白处获得焦点时，粘贴由已有 `paste(target)` 处理。文本卡片阶段沿用文本和截图节点，网页卡片阶段按第 7 节增加单个网址的识别。
3. 弹窗和普通输入框继续使用现有字段处理逻辑。画布粘贴路径应排除编辑区、弹窗和普通输入框。
4. 复用编辑器已有会话和选区范围检查，异步剪贴板任务只作用于发起它的会话。离开编辑的提交顺序见第 3.2 节。
5. 卡片菜单「复制 Markdown」在编辑态直接读取活动会话的快照，阅读态读取节点的 `contentMd`。复制动作本身无需写入 SQLite。

`CollectionCanvas` 的 `paste(target)` 已对 `[contenteditable=true]` 做了排除；这个排除继续保留，但必须由新的 clipboard 分派先接管编辑器事件，否则全局捕获监听器会阻断浏览器默认粘贴。

### 3.4 焦点与结束编辑

焦点管理建议使用显式的完成入口，覆盖：

| 触发 | 行为 |
| --- | --- |
| 双击 text 卡片 | 挂载 Milkdown；异步初始化后聚焦 |
| 点击画布空白区域 | 通过 `finishText()` 提交最终快照，保存成功后退出 |
| 选择或双击另一张卡片 | 通过 `finishText()` 提交原卡片，成功后完成选择或进入新卡片编辑 |
| 编辑卡片内按 Esc | 内部弹窗、菜单和输入法组合优先处理，剩余 Esc 通过 `finishText()` 结束编辑 |
| 切换到其他文章或专题标签，关闭当前专题 | 先调用现有 `canvas.flush()`，提交成功后完成切换或关闭 |
| 「创建原创文章」 | 提交最终文本后转换 |
| 点击浮动格式工具、链接工具或普通失焦 | 保留编辑会话，失焦只请求保存，工具交互保持所需选区 |
| 应用退出或确认数据库恢复 | 由现有 `CollectionCanvas.flush()` 及写入等待机制完成提交 |

现有 `CollectionEditorScope` 会在焦点离开容器时触发 `onLeave`。文本卡片应复用其画布交互隔离样式，结束编辑由上述显式入口控制。最终提交完成前保持 `MarkdownEditorHandle` 可用。

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

## 4. 文本卡片的数据、保存和性能约束

- **文本卡片持久化**。沿用 `collection_nodes.content_md` 和 `update_collection_node_text` 命令。每张文本卡片只有一份持久化 Markdown。网页卡片的独立迁移见第 7 节。
- **文章 SaveQueue 不改**：文本卡片走独立的 CollectionCanvas 保存队列，文章正文继续走原本 SaveQueue 和乐观版本规则。
- **原文渲染保持轻量**：未激活的卡片继续 `renderMarkdown`，无需持有 `MarkdownEditor` 或 ProseMirror 状态。
- **只在有实际内容变化时保存**：只修改选区、移动光标、缩放画布不触发正文写入；相同 Markdown 快照无需重复提交。
- **编辑器实例数量**。只统计当前专题画布内的卡片编辑器。阅读态为 0 个，任意一张文本或文章卡片编辑时为 1 个。工作台独立文章标签中保留的编辑器实例不计入。
- **正在编辑的节点不被旧异步结果覆盖**：既有 `pendingText` 草稿和串行 `enqueue` 保持最后一次修订一致性；保存失败的草稿仍能显示和重试。
- **文本卡片资源引用**。在 `src-tauri/src/assets/cleanup.rs::referenced()` 中，把 `collection_nodes WHERE kind='text'` 的 `content_md` 纳入素材引用统计。复用 `references::urls`、`derived_keys` 和哈希组规则，覆盖 `asset://`、已登记图床 URL 及派生资源。素材库用 `entry_references()` 判断专题截图是否也被文章使用，该函数保留文章引用范围。
- **图片显示与交付**。编辑态通过现有编辑器渲染 Markdown 图片。阅读态沿用 `TextPreview` 图片占位，重新进入编辑可以查看原图。截图粘贴到空白画布时仍生成图片节点。图片剪贴板与退出清理保护一并验收。
- **性能检验**：先对 100 张卡片（其中 30 张文本卡片）的普通画布与单张卡片编辑态进行对比；记录是否仅创建 1 个 Milkdown、首次进入编辑耗时、连续输入以及退出编辑后的渲染开销。具体毫秒数以实测记录，不预设空泛加速倍数。

## 5. 文本卡片改造文件与任务顺序

| 顺序 | 文件 | 最小改动 | 完成判定 |
| --- | --- | --- | --- |
| 1 | 新增 `apps/desktop/src/workspace/CanvasTextEditor.tsx` | 用 `MarkdownEditor` 包装卡片编辑，注册活动 handle、修订通知、异步就绪聚焦、同步快照 | 一张 text 卡片能原地编辑标题、加粗、列表 |
| 2 | `CollectionNodes.tsx` | text 编辑态挂载 CanvasTextEditor，阅读态保留 TextPreview | 双击进入和退出后 Markdown 一致，卡片位置/尺寸不改变 |
| 3 | `CollectionCanvas.tsx` | 单层防抖、等待异步编辑、同步捕获、串行保存、统一完成入口、转换前提交 | 快速离开、切换或转换时保留最新修改，保存失败可重试 |
| 4 | `CollectionCanvas.tsx` + `DesktopShell.tsx` | 活动编辑器的 copy/cut/paste 路由及外部空白画布粘贴 | 卡片编辑与画布粘贴互不干扰 |
| 5 | `collection-canvas.css` | 局部字体、留白、滚动、浮动控件适配 | 文本编辑不误拖节点，不出现宽屏样式溢出 |
| 6 | `src-tauri/src/assets/cleanup.rs` | 扩展文本节点内的素材引用统计及局部测试 | 卡片里的资产引用在退出清理后仍有效 |
| 7 | 相关组件/集成测试 | 补充本期交互和保存场景；按现有脚本执行类型检查、测试和构建 | 验收清单逐项通过 |

文本卡片工作包复用当前依赖、SQLite 表结构、React Flow、Milkdown Schema 和文章 `SaveQueue`。文件名和具体函数签名以执行时的源码为准。

## 6. 文本卡片验收标准

### 6.1 Markdown 编辑

- [ ] 双击文本卡片进入原地所见即所得编辑，支持标题、段落、列表、加粗、引用、代码和链接等现有 Milkdown 格式。
- [ ] 编辑器内输入时内容直接排版。退出后 `TextPreview` 反映最新 Markdown，图片按占位显示。关闭和重开专题后持久化内容一致。
- [ ] 当前画布内只有正在编辑的文本或文章卡片创建 Milkdown 实例。连续进入和退出 20 张卡片后，已结束会话的实例均释放。

### 6.2 一致性与保存

- [ ] 最后输入一个字符后立即点击空白画布、切换另一个节点、打开文章或关闭专题，内容完整保存。
- [ ] 在正在进行的自动保存期间继续输入，最终数据库中的 content_md 是最新一版，不被旧的异步结果覆盖。
- [ ] 编辑器内异步粘贴尚未完成时切换卡片或创建原创文章，结果包含已完成的粘贴。转换只创建一篇文章。
- [ ] 保存请求失败时有明确错误提示，最新文本保留在前端待保存状态，用户可继续编辑或重试；不会把失败显示为已保存。
- [ ] 没有正文变化时不产生文本更新，撤销回原文时数据库最终状态和画布一致，包括先前版本已经入队的情况。
- [ ] 切换专题、退出应用、备份、导出和确认数据库恢复仍沿用现有 `flush()` 入口。

### 6.3 画布与剪贴板

- [ ] 编辑器内的 Ctrl/Cmd+C、X、V、Z（以及重做）作用于文本内容；画布空白区域粘贴仍创建节点。
- [ ] 防抖尚未到期时，卡片菜单「复制 Markdown」也能复制最新内容。
- [ ] 编辑器内 Delete/Backspace 删除文字；非编辑状态下删除选中节点。
- [ ] 编辑器内拖选文字、滚动、输入中文、操作格式工具不会拖动节点、平移/缩放画布或提前卸载编辑器。
- [ ] 点击画布空白区域、按 Esc 或切换卡片时，编辑器在保存后退出。打开内部浮动控件时，Esc 优先关闭控件。中文输入法组合过程中按 Esc 不退出卡片。
- [ ] 画布中图片节点、文章节点、连线、缩放、对齐辅助线、截图粘贴和导入 README 流程仍正常工作。

### 6.4 素材与性能

- [ ] 含 `asset://`、已登记图床 URL 或派生资源引用的文本卡片，在正常退出清理和重开专题后仍可访问对应图片。删除最后一处引用后沿用现有清理顺序回收。
- [ ] 100 节点专题下，画布内阅读态有 0 个 Milkdown 实例，单卡编辑时有 1 个。记录首次进入、连续输入和退出编辑的耗时及渲染开销。
- [ ] `pnpm typecheck`、受影响的 Vitest 测试及 Rust 对应测试通过；按照当前仓库的构建脚本核对前端和 Tauri 集成结果。

## 7. 网页卡片

### 7.1 产品行为

| 操作 | 行为 |
| --- | --- |
| 在空白画布粘贴单个 `http://` 或 `https://` URL | 生成网页卡片并打开卡片内预览。剪贴板文本去除首尾空白后须为一个无空白字符且具有有效主机名的 HTTP(S) URL。带说明的文字、多个链接和 Markdown 链接文本沿用普通文本卡片行为 |
| 在文本卡片、文章编辑器或弹窗输入框中粘贴 URL | 由获得焦点的编辑器或字段处理 |
| 在空白画布粘贴图片 | 沿用图片卡片路径 |
| 使用「导入 GitHub README」 | 沿用显式导入入口。直接粘贴 GitHub 链接生成网页卡片 |
| 激活已有网页卡片 | 单击卡片加载原网页，可滚动和点击网页链接。网页占满卡片内部，网页标题与其他卡片一样显示在卡片上沿。加载标题前显示域名，「在系统浏览器打开」位于卡片工具条与右键菜单 |
| 切换到另一张网页卡片、切换标签或手动关闭预览 | 释放当前浏览视图。未打开的网页卡片显示原始 URL，右键菜单支持复制链接及在系统浏览器打开 |
| 网页无法加载或站点登录与内嵌浏览器不兼容 | 保留网页卡片和系统浏览器入口，用户可用原链接继续访问 |

画布同时打开一个网页预览。粘贴创建节点后直接打开，点击空白画布时继续显示。重新打开专题时，优先预览最近创建的网页卡片，并沿用保存的视口。处于文本、文章编辑或图片尺寸调整时临时隐藏网页，结束后恢复。网页标题随当前页面加载到画布会话中。

### 7.2 技术选型和桌面端验证

由 Tauri 子 WebView 以独立浏览视图直接导航到原网页。当前工作台 CSP 禁用了 iframe，站点也能通过 `X-Frame-Options` 或 CSP `frame-ancestors` 限制 iframe 嵌入。采用原生子 WebView 可以保留当前工作台 CSP。远程页面仅获得浏览权限，工作台 Tauri 命令和本地资源权限限定到主界面。网页导航限定为 HTTP(S)。

Tauri 子 WebView API 需要启用 `unstable` Cargo 特性，当前项目尚未启用。先在真实桌面窗口内验证原生浏览区域与 React Flow 卡片的配合，再接入节点和迁移。

1. Windows 缩放开始前，使用 WebView2 CapturePreview 获取当前网页视图，在卡片内部通过 Blob 图片呈现缩放动画。图片与 Markdown 卡片由同一 React Flow 合成层变换。先等待主界面完成图片绘制，再将网页子窗口移至主界面窗口下方，保持 WebView2 可见和绘制状态。连续缩放复用同一画面，停止后更新网页尺寸、缩放与滚动位置，等待网页 CapturePreview 完成后只调整层级提升网页窗口，不再设置尺寸。最近画面保留在网页下方，下一次交接替换并释放旧 Blob，关闭预览时一并释放，避免两个合成器交接之间短暂暴露空白。切换层级时不触发 Windows 背景重绘。不能用主界面的 requestAnimationFrame 代替网页渲染完成信号。预览画面仅在内存保留。原生平台缺少捕获适配时沿用实时视图。验收须采样实际桌面画面覆盖截图和实时网页的交接，不能仅检查 DOM 对齐。
2. Windows 保留完整网页视图尺寸，用原生窗口区域裁切卡片与画布的交集。裁切时保持网页排版宽度和滚动位置。卡片完全移出画布，或菜单、弹窗覆盖网页时，临时隐藏视图。macOS/Linux 沿用可见区域尺寸的现有实现，边缘无重排仍需对应平台适配。
3. 验证网页内滚动和点击可用，卡片外仍可操作画布。快速切换卡片或标签只允许最新激活的网页预览显示。
4. 在项目支持的桌面平台记录实测结果。原生显示、焦点和遮挡验证通过后再提交网页卡片的持久化改动。

技术参考：[Tauri 子 WebView](https://v2.tauri.app/reference/javascript/api/namespacewebview/)、[Tauri Capability](https://v2.tauri.app/reference/acl/capability/)、[W3C CSP frame-ancestors](https://www.w3.org/TR/CSP3/#directive-frame-ancestors)。

### 7.3 画布节点和持久化

- 在 `CanvasNodeContent` 和 Rust 节点模型加入 `web` 类型。采用独立的 SQLite 迁移扩展 `collection_nodes.kind` 约束，并增加 `external_url`。网页卡片保存原始 URL，沿用既有节点 ID、位置、尺寸、颜色和连线。其他节点类型的 URL 为空。
- 现有 `collection_nodes` 对类型施加 `CHECK` 约束。迁移保留原有节点和连线的 ID、引用完整性及级联删除行为，并用含文章、文本、图片和连线的既有数据库验证升级。Rust 创建节点入口校验 URL 协议与主机名。
- 在 `CollectionCanvas.tsx` 的空白画布粘贴路径识别单个 URL，复用节点创建队列。在卡片渲染层补充域名、预览入口和系统浏览器入口。
- 工作区仅持久化网页 URL 和画布节点信息。网页正文由 WebView 在线加载，进入页面后的导航状态属于当前预览会话。网页卡片在内容库中无对应条目，备份与恢复随现有专题数据库处理。

### 7.4 验收标准

- [ ] 空白画布粘贴单个 HTTP(S) URL 生成一个网页卡片并自动打开原网页。普通文本、多个链接、带说明的链接和图片沿用各自原有路径。
- [ ] 文本和文章编辑器内粘贴地址保持编辑器行为。弹窗输入框正常粘贴。GitHub 地址可作为网页卡片，显式导入 README 仍生成资料条目。
- [ ] 卡片内能够浏览网页，打开另一张网页卡片后仅显示新的预览。单独在系统浏览器打开原地址可用。
- [ ] 平移、缩放、移动和调整卡片大小过程中，预览保持可见并跟随卡片。越过画布边缘时保留可见区域，返回画布后原网页内容继续可用。打开菜单、弹窗或切换标签时，原生视图正确隐藏。
- [ ] 重开专题后恢复链接、卡片位置、尺寸和连线，并默认预览最近创建的网页卡片。网页标题显示在卡片上沿，点击空白画布时保留预览。网页加载失败时可继续复制 URL 或在系统浏览器打开。
- [ ] 既有数据库升级后，文章、图片、文本节点和已有连线仍可读取。新网页节点可以创建、重开和删除，且没有对应的文章条目或正文副本。

## 8. 执行交接

1. 按第 2 至 5 节接入文本卡片 Milkdown 和最终保存流程，再打通剪贴板与素材引用保护。优先验证最后一笔输入后立即切换、粘贴未完成时转换，以及保存失败后编辑并重试。
2. 按第 7 节先完成原生 WebView 验证，再接入网页节点的粘贴、持久化和预览交互。两个工作包分别记录测试和桌面验收结果。
