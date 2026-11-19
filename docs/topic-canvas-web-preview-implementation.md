# 专题画布网页卡片交互与缩放实施方案

> 适用项目：wechat-creator-workbench  
> 目标环境：Tauri 2、React Flow 12.12.1、Windows WebView2  
> 制定日期：2026-11-18  
> 性质：交付 Codex 实施的技术设计；以现有源码为基线，按最小正确实现原则开发。

## 1. 产品目标与已确认约束

专题画布容纳任意数量的网页链接卡片，每张卡片持续显示属于自己的网页预览。画布中同时只有一张被单独选中的网页卡片可以使用原生 WebView2 交互。其他网页卡片显示此前截取的静态预览；平移和缩放均由 React Flow 统一驱动。

**选中状态是激活状态的唯一依据。** 不维护与 React Flow selected 独立的持久激活 ID。单击网页卡片使它成为唯一选中节点后即激活，无须二次单击或双击。只有单选一个网页节点且没有选中连线时，才允许原生网页交互。

| 用户动作 | 节点选中状态 | 实时网页 | 其余网页 |
| --- | --- | --- | --- |
| 在画布粘贴合法 URL | 新卡片自动被单独选中 | 新卡片加载并激活 | 原有卡片继续显示截图 |
| 单击未选中的网页卡片 | 该卡片单选 | 切换至该卡片，待首次绘制完成可交互 | 原激活卡片变静态截图 |
| 单击画布空白区域 / Escape 清除选中 | 无选中网页 | 关闭或遮挡当前实时视图并释放交互 | 所有链接保留静态截图 |
| 选择文章、文本或图片节点 | 无选中网页 | 无交互网页 | 所有链接保留静态截图 |
| 多选节点或选择连线 | 不满足网页单选条件 | 无交互网页 | 所有链接保留静态截图 |
| 删除、切换专题或关闭标签 | 取消当前会话 | 停止并释放实时视图 | 缓存随专题下次打开恢复 |
| 打开已有专题 | 默认不选中任何节点 | 默认不激活网页 | 从磁盘缓存显示已有截图 |

若网页仍在加载就切换，原节点显示当前已生成的最后一张截图；首次截图尚未生成时显示带域名的加载占位，不能把异步结果写到后来激活的卡片。

图形缩放允许将网页暂时冻结为图片。首版继续使用 PNG；PNG 嵌套 SVG 不会成为矢量网页截图。高倍率清晰度通过真实输出分辨率测试与分级截图改善，不能承诺所有站点在 300% 下达到无限放大的矢量质量。

## 2. 源码现状及必须修改的具体位置

1. apps/desktop/src/workspace/CollectionCanvas.tsx：初始化 previewId 为最后一个网页节点；关闭专题再进入时即使没有选中也会自动加载网页。修改为由 selectedNodes / selectedEdges 派生 activeWebNodeId，初始值为 null。
2. 同文件 onNodesChange：存在阻止取消最后一个选中节点的分支。必须删除或收窄该拦截，使点击空白、取消选中和普通多选按 React Flow 行为生效；保留与编辑保存相关的业务约束。
3. 同文件 onNodeClick：现有网页分支会调用 edit(node.id)，并由 edit() 另行 setPreviewId。改为由节点单选变化触发激活；单击已经选中的网页内容交给真实网页处理。菜单“预览网页”改为“选中并打开网页”，其行为是选中目标节点；“关闭网页预览”改为取消选中并保留静态画面。
4. 同文件 pasteContent：已有创建并自动选择新网页的意图；保持该行为，但需要在节点创建完成后以原子节点状态更新单选新卡片，并利用现有意图代号阻止过期的粘贴任务抢回选中状态。paste 的选中与激活不再依赖 previewId。
5. apps/desktop/src/workspace/CollectionNodes.tsx：目前仅 previewId 对应节点生成 collection-web-viewport，其他网页仅展示 URL。改为每个网页卡片都渲染静态预览层，只有 activeWebNodeId 节点额外挂载实时视图的定位槽位。静态层保留在实时网页下方，交接期间可覆盖。
6. apps/desktop/src/workspace/CanvasWebPreview.ts：当前截图由 hook 局部 picture / backing 管理，切换节点时清理 Blob；effect cleanup 会关闭旧 WebView。改为画布会话级共享管理器：先保留旧节点截图，再释放旧实时视图，最后激活新节点；异步操作通过会话代号校验。
7. src-tauri/src/canvas_webview.rs：已有单子 WebView open / bounds / cover / reveal / close、CapturePreview 和滚动记忆能力。优先复用；新增磁盘预览缓存读取、写入与删除接口，缓存数据与 SQLite 分离。
8. apps/desktop/src/desktop.ts、src-tauri/src/main.rs、src-tauri/capabilities/desktop.json、相关权限声明：注册最少的新增缓存命令及 TypeScript 调用。

## 3. 状态与组件设计

### 3.1 选中态推导激活态

从受控 nodes / edges 派生：
- selectedNodes = nodes.filter(node => node.selected)
- selectedEdges = edges.filter(edge => edge.selected)
- activeWebNodeId = selectedNodes.length === 1 且 selectedEdges.length === 0 且 selectedNodes[0].data.kind === "web" ? selectedNodes[0].id : null

不再将 previewId 存入 useState；不保留“选中了其他节点但原网页仍在交互”的状态。编辑器、弹窗和图片查看器打开时可以暂时遮挡实时视图，但不会修改选中事实；恢复后重新计算是否满足激活条件。

区分 selection 与 editing：双击文本、文章继续使用原编辑逻辑；网页单击只选择，选中后实时网页直接接收内部滚轮/点击。右键菜单和多选不应意外重置目标节点选中。首次打开旧专题时不恢复上一次选中网页。

### 3.2 一个实时网页 + 多个静态网页节点

每张网页卡片包含：
- 预览图片区：有缓存时显示 PNG；无缓存时显示域名与加载状态。
- 静态图片的本地节点 ID 与 URL 校验信息，用于防止异步串图。
- 交互定位槽：仅 activeWebNodeId 对应节点提供给现有 WebView2 控制器。
- 标题显示继续沿用现有 pageTitle / 域名；标题可以在会话内更新。

页面中保持一个原生交互 WebView2；通过已有全局 nativeWrites 串行化所有真实网页的命令，避免旧请求覆盖新会话。无需创建第二个后台 WebView，也无需为每个网页卡片长期保留 WebView2。

推荐新增局部的 CanvasPreviewCache.ts（或等效单个 hook），将静态图片的缓存、对象 URL 释放和节点订阅逻辑从 CanvasWebPreview.ts 中分离。不要重写完整画布和 Rust 资源服务。

## 4. 捕获、切换与缓存契约

### 4.1 首次粘贴 / 激活

1. 创建 URL 节点并自动置为唯一选中节点。
2. 卡片立即可见，先显示已有缓存或加载占位；原生 WebView2 通过现有 open 加载真实 URL。
3. 在 WebView2 的网页加载信号到达后等待主内容进入可绘制状态，再调用 CapturePreview 获取首次 PNG 并保存至节点缓存。NavigationCompleted 只能代表导航完成，CapturePreview 返回成功也不等于画面一定非空；测试页应检查实际像素，避免将加载白屏保存为正式预览。
4. 截图准备与用户在当前激活网页中滚动、点击并行，不阻塞用户交互。若导航或内容变化，退出激活前按当前最终画面更新该节点预览。

### 4.2 从 A 选中 B / 点击空白取消选中

1. React Flow 先提交正确的节点 selected 状态；可交互目标同步变为 B 或 null。
2. 画布上的 A 静态预览始终存在。将当前 WebView2 从可交互表层撤离（沿用 cover 层级策略）；必要时先使用已有有效截图确保视觉连续。
3. 在关闭/复用旧 WebView2 之前完成最后一次截图刷新（可复用现有 CapturePreview；验证 cover 后仍可抓图）。结果只保存给 A，且以操作代号校验，旧结果不能覆盖新版本。
4. 释放旧视图，再按最新 activeWebNodeId 打开目标节点。B 在网页首帧有效前持续显示已有静态预览，不允许原生透明/白帧覆盖图片。
5. 若最新目标是 null，则保持所有节点静态展示，不再存在接收网页输入的原生视图。
6. 快速 A→B→C、A→空白、删除 A、切换专题等动作采用最新意图代号，最终状态必须与最新选择一致；清理旧任务和对象 URL。

截图和 cover 的确切先后由 Windows 真实桌面截图验证。若在遮挡后 CapturePreview 无法得到网页内容，就先捕获并在捕获期间隔离原生网页输入，再交接图层；不能让已经取消选中的网页继续接受点击。

### 4.3 静态图片缓存

磁盘目录沿用 app_cache_dir()/canvas-previews/v1/；缓存键包含 collectionId、nodeId、URL 摘要和预览版本。由 Rust 对真实缓存路径与图片写入负责，避免将预览 PNG 放入 SQLite、文章素材库或备份包。

最小新增命令：
- canvas_preview_cache_read：输入 collectionId / nodeId / URL，返回缓存图片字节或不存在。
- canvas_preview_cache_write：存入当前节点有效 PNG；尽可能复用现有 CapturePreview 结果，不做额外网页截图。
- canvas_preview_cache_delete：删除节点截图，删除网页卡片时调用。专题删除时可以清理对应目录。

优先采用已有的 Tauri 二进制 Response 通道读图，前端以对象 URL 显示，卸载时 revoke；缓存写入采用临时文件 + 原子重命名，不引入新数据库表和缓存索引服务。

重开专题时，所有链接卡片按需加载已有缓存；没有可用截图则显示稳定的域名占位。首次加载一个从未缓存的旧链接时，需要用户选择该卡片，复用真实 WebView2 生成新预览。

缓存文件由本机拥有，可能含网页中的账号信息，不上传至 R2。按照现有缓存目录生命周期管理，删除节点与专题时清理对应缓存。

## 5. 丝滑缩放：单手势单截图

### 5.1 视口更新

CollectionCanvas.tsx 中滚轮目前每个事件都以 250ms 过渡调用 setViewport，且等待 prepareWebZoom。调整为：
- 滚轮事件累计目标倍率和最后指针锚点，每帧最多一次 setViewport，滚轮路径 duration=0；正确保留鼠标锚点坐标变换。
- 按钮放大/缩小/适应/聚焦继续使用现有 250ms 缓动。
- 非网页卡片不启动截图链路。
- 当前选中的是网页时：在动画开始前，让已有最新静态预览接管显示，完成 cover 后统一缩放；新滚轮输入复用同一次冻结任务。
- 连续输入延长当前手势；停止约 350ms 后计算最终位置，恢复唯一实时 WebView2，等待真实绘制完成再撤去覆盖图。
- 若激活状态中途变化，终止旧网页恢复意图，优先按当前选中状态交接。禁用运行期间的逐帧 Rust bounds 更新，仅在进入/退出交互或确有必要时更新。
- 窗口缩放、拖动卡片和页面滚轮继续遵守当前事件边界，编辑器内部 nowheel 不触发画布缩放。

### 5.2 图像清晰度

首版使用 WebView2 CapturePreview 原生 PNG，严格保持截图的宽高比与卡片内容坐标，不把 PNG 嵌进 SVG 假称矢量。实际清晰度以显示尺寸、设备像素比和截图像素尺寸判定：

目标像素宽度约为：卡片 CSS 宽度 × 目标画布倍率 × 设备像素比（高度同理）。例如 420×280 CSS、150% 显示、300% 放大，目标约 1890×1260 像素。

现有截图方法能否在不改变网页排版宽度的前提下得到该分辨率，必须先写独立验证：测量 CapturePreview 的真实 PNG 宽高、网页 innerWidth、正文段落尺寸和滚动位置。只有验证通过才实施高清采样或分级缓存。PNG 不能保证无限倍无损放大；如果高倍率仍模糊，作为单独可衡量的清晰度改进项处理，不改变选中/激活主架构。

### 5.3 平台范围

Windows 11 / WebView2 为本轮完整实现与验收平台。当前 canvas_webview_snapshot 在非 Windows 平台返回 None，macOS / Linux 的本地网页截图与缓存生成需要后续独立实现；其现有可交互子视图不得因本次 Windows 实现退化。不能将 Windows 的截图结果宣称为全平台能力。

## 6. 实施步骤（Codex 执行）

**阶段一：选中语义**
1. 将 previewId 替换为 derived activeWebNodeId；首次打开专题 null。
2. 取消 onNodesChange 对最后取消选中的拦截；修改现有 onKeyDownCapture 的 Escape 分支，在退出编辑和清除边选择之外同步取消节点 selected，确保 Escape 与点击空白均退出网页交互；确认选择其他节点、边和框选行为。
3. 粘贴成功后单选创建节点并自动打开；移除 web onNodeClick 里额外的 edit 激活逻辑。
4. 更新右键菜单交互文字和操作，建立节点选择相关测试。

**阶段二：多卡片静态预览**
1. 网页节点永远有预览图片/占位层，只有激活节点有 WebView 定位槽。
2. 提取最小缓存管理逻辑，新增 Tauri 磁盘缓存接口。
3. 重构 CanvasWebPreview 的切换清理顺序：先确保静态图，后关闭真实视图；切换过程中保留所有卡片预览。
4. 加入异步意图校验、图片对象 URL 释放和删除缓存测试。

**阶段三：连续缩放**
1. 改造滚轮调度，一动画帧合并一次视口更新。
2. 复用当前静态快照作为缩放冻结层，仅一次冻结/一次恢复。
3. 测量首次准备、缩放帧间隔和恢复的实际耗时；针对瓶颈做局部调整。

**阶段四：高清与实机验收**
1. 验证 PNG 输出像素、设备缩放与 CSS 排版稳定性。
2. 如 WebView2 可以稳定输出目标尺寸，再加入高清缓存生成；否则记录测试边界，维持真实网页交互时的原生清晰度。
3. 完成 Windows 100%/150% 的实际窗口录像与像素采样回归。

## 7. 测试与验收

自动化优先扩展 apps/desktop/src/workspace/collection-canvas.test.tsx 和对应 Rust 单测，测试不能只断言 API 已调用，必须验证最终选中态、缓存内容归属和原生操作时序。

| 验收场景 | 期望结果 |
| --- | --- |
| 粘贴 A、B、C | 三张卡片均显示预览；只有 C 被单独选中、实时可交互 |
| 单击 A | A 选中并最终可交互；B、C 静态画面持续可见 |
| 单击空白 / Escape | 取消网页选中；全部显示截图；没有仍可交互的原生网页 |
| 单击文本/文章/图片 | 网页均退出交互；其他节点行为保持正常 |
| Ctrl/⌘ 多选、框选、选择连线 | 仅在恰好单选一张网页且未选连线时允许网页交互 |
| 打开包含多个网页的旧专题 | 所有缓存截图可见；初始无选中和实时网页 |
| 旧网页尚未加载完就选择新网页 | 结果只属于对应节点；最终仅最新选中节点可交互 |
| 快速 A→B→C、A→空白、删除激活节点 | 最终无旧网页覆盖、无串图、无异步复活 |
| 画布 10%～300% 连续缩放 | 普通图片与网页截图同步变化；缩放过程无白帧 |
| 缩放后恢复 | 当前激活网页滚动位置和页面排版稳定、能继续点击 |
| 节点删除与专题关闭 | 原生视图和对象 URL 及时释放，磁盘缓存按所属节点清理 |

性能验收：固定 Windows 11 Release 构建和相同测试数据，分别测试 20 个普通节点、100 节点含 30 张图/100 条边、10 张网页静态卡片和 1 张激活网页。连续缩放的帧间隔 P95 目标不高于 20ms（60Hz 环境），桌面采样要求白帧/网页错位 0 次，锚点漂移 ≤2 CSS px；记录首次截图准备时间和恢复耗时 P50/P95/P99，优先确认是否为当前最主要延迟。每种场景重复至少 5 轮。

推荐命令：pnpm typecheck；pnpm test；cargo test（在 src-tauri 目录）；Windows 正式应用中实际滚轮/触控板缩放并采样屏幕图像。[Electron 原型历史验证记录](./electron-canvas-prototype-results.md)只能作为对照，不代表 Tauri 的验收结果。

## 8. 实施纪律与交付

- 本次优先最小改动现有文件；不要替换 React Flow、桌面宿主和 Milkdown。
- 选中态派生、截图缓存和原生视图协调各自单一职责；不增加第二套持久化选中状态。
- 任何同步截图或跨进程等待均不得阻塞 React Flow 普通卡片的拖动与选择。
- 对截图生成失败保留网页卡片与正常选择体验，缓存缺失按占位处理，重新选择时可重新加载。
- 每个阶段完成对应测试后再进入下一阶段，最后提交改动文件清单、关键时序解释、实测数据、跨平台限制及余留性能问题。
- 当高清 PNG 测试不能达到预定像素分辨率时，报告测量结果，不通过 SVG 包装、插值或提高 CSS image-rendering 等方式冒充清晰度提升。

## 9. 参考资料

- 本地源码：apps/desktop/src/workspace/CollectionCanvas.tsx
- 本地源码：apps/desktop/src/workspace/CollectionNodes.tsx
- 本地源码：apps/desktop/src/workspace/CanvasWebPreview.ts
- 本地源码：src-tauri/src/canvas_webview.rs
- 本地文档：docs/topic-canvas-inline-editing-plan.md
- React Flow 选中语义：https://reactflow.dev/api-reference/react-flow
- React Flow 受控节点变更：https://reactflow.dev/api-reference/types/on-nodes-change
- 微软 WebView2 API 概述：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis
