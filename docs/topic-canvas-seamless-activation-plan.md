# 专题画布网页卡片平滑激活技术方案

> 项目：wechat-creator-workbench  
> 技术基线：Tauri 2、React Flow 12.12.1、Windows WebView2  
> 状态：针对当前已完成的多网页截图实现进行局部改造  
> 日期：2026-11-18

## 1. 产品行为

专题内每张网页卡片始终显示自己的预览图。用户单击某张网页卡片后，该卡片成为唯一选中节点并进入实时交互态；点击空白、选择其他类型卡片或多选时，所有网页退出交互态。粘贴新 URL 后自动选中新卡片并加载网页。

**体验目标：选中动作只改变卡片交互能力，不让静态图与原生页面之间出现突然换版、白帧、位移或内容比例突变。** 页面重新加载确实发生时，允许在新旧画面之间进行短暂柔和的过渡；动态网页内容发生真实变化时不承诺像素完全一致。

保持一个原生 WebView2、其余静态图片、React Flow 统一缩放的现有架构。优先修复画面交接与页面位置一致性；不迁移 Electron，不新增多个常驻 WebView2，不引入第二套节点状态。

## 2. 当前代码证据

- `apps/desktop/src/workspace/CollectionCanvas.tsx`：`activeWebNodeId` 已由 selectedNodes/selectedEdges 正确派生，选中语义保留；`useCanvasWebPreview(...)` 对选中卡片挂载原生定位槽位。
- `apps/desktop/src/workspace/CollectionNodes.tsx`：`WebCardPreview` 持续显示 `img.collection-web-image`，选中时增加 `collection-web-viewport` 定位槽位；该槽位由独立原生 WebView2 覆盖。
- `apps/desktop/src/workspace/CanvasWebPreview.ts`：激活时 `open` 新建网页，`loaded` 后捕获 PNG、`cache.capture`，随后 `revealView`；取消选中时 hook cleanup 重新截图并关闭实例。
- `apps/desktop/src/workspace/CanvasPreviewCache.ts`：`capture/load` 解码新图后直接替换 `entry.image`，立刻通知视图，并调用 revokeObjectURL 释放旧图。
- `apps/desktop/src/workspace/collection-canvas.css`：预览图片 `object-fit: cover; object-position: top left`，若捕获区域宽高比与卡片不一致，可能出现裁剪位置变化。
- `src-tauri/src/canvas_webview.rs`：`Preview::Open` 关闭当前子视图并 `WebviewBuilder::new` 加载 URL，属于新浏览会话。现有 `remember_position` 将滚动坐标仅写入当前网页的 Symbol 中，关闭子视图后不提供跨次激活的恢复。首帧检测 `contains_page_pixels` 只用于过滤明显空白，不保证新旧画面内容等价。

## 3. 先做最小诊断，确认是哪一种跳变

在现有代码临时记录（使用性能标记或调试日志，不引入业务数据表）：

1. 用户选中时间、`open` 开始/完成、`loaded` 时间、`CapturePreview` 返回时间、`cache.capture` 生效时间、`reveal` 时间。
2. 静态 PNG 的自然宽高、当前卡片 `getBoundingClientRect()`、画布缩放比例、WebView2 当前视口宽高以及设备像素比。
3. 退出激活前和重新激活后的网页 `location.href`、`scrollX/Y`、`innerWidth/innerHeight`；只记录调试指标，不将网页正文写入日志。
4. 保存三个阶段的窗口实际画面：旧截图、刚提交新截图、原生 WebView2 reveal 完成。

用两个固定测试页分别覆盖：无动画的固定 DOM 网页，和滚动至中部后重新选中的长网页。

分类标准：
- **同一位置但内容突然变化**：新旧截图替换、重新加载及动态页面状态变化。
- **文本位置/比例不同**：WebView2 的排版宽度、网页缩放、截图裁剪或 `object-fit: cover` 导致的几何差异。
- **短时白闪/边框露底**：视图覆盖顺序及原生 WebView2 层级交接问题。
- **整个画布平移**：检查 `revealPreview` / `focus` 是否因选中触发 `fitView`，此行为只保留在粘贴后的必要自动聚焦流程，不在普通点击时发生。

## 4. 平滑激活的最小实现

### 4.1 两张静态图交接，再显示原生页面

不要在 `cache.capture()` 后直接把新图顶替旧图并立即 `reveal`。推荐按以下顺序执行：

1. 单击选择节点后，保持旧缓存图片显示；新 WebView2 在当前主视图后方加载。
2. 等待目标网页有效绘制，捕获新 PNG 并解码。原生视图继续保持在主界面后方。
3. 在同一卡片 DOM 内临时保留 **旧图和新图两个图片层**。固定两层相同的几何尺寸和裁剪；用约 120–180ms 的 opacity 过渡让旧图淡出、新图淡入。
4. 过渡完成后，将新图作为该节点的正式缓存，旧图的对象 URL 再释放。
5. 当前原生视图仍位于后方，此时显示的新图与其已捕获的内容应尽量一致。再调用现有 `reveal` 切到实时视图。
6. 若缩放/选中状态变化，使用现有会话代号取消已过期的交接；旧节点保持其静态缓存，最新单选目标最终获得交互。

注意：DOM 图片不能在独立原生子视图显示到前台后继续作为普通 CSS 层覆盖它。**必须先完成图片之间的淡入淡出，再进行原生层级交接**。不用强行为原生窗口加透明度，也不额外引入动画库。

### 4.2 缓存 API 最小调整

`CanvasPreviewCache.ts` 提供“解码得到待提交图片”和“完成过渡后提交图片”的操作，或由 `WebCardPreview` 持有临时的 `incomingImage`。不要求大规模重构，满足下面的所有权即可：

- 旧 `image` 在过渡完成前保持引用。
- 新对象 URL 在 decode 后才参与显示。
- 过期请求的临时 URL 必须 revoke；完成替换后旧 URL 才 revoke。
- 新图尺寸及 URL 的节点身份匹配，不能将 A 的截图赋予 B。
- 缓存磁盘写入可沿用 Rust 现有实现，不必引入双份长期存储。

`CollectionNodes.tsx` 的 `WebCardPreview` 对对应选中节点接收一次短暂交接信号，内部使用双 `img` 层及 CSS opacity 过渡；非激活节点维持普通单图，不增加全画布渲染成本。

### 4.3 网页状态一致性

图片渐变只能掩盖视觉跳变，不能让重建的网页自动恢复原来位置。对重新选中已浏览过的卡片，优先为每个节点保留当前会话内的页面地址和滚动位置：

- 离开激活态、关闭旧 WebView2 前，读取该网页真实 `location.href` 和 `scrollX/Y`；由 Rust/WebView2 执行脚本并返回结果（需明确会话 ID），防止旧请求串台。
- 再次激活时，使用该会话最后一次实际地址；页面已完成有效布局后恢复滚动位置，**再**生成用于交接的新截图。
- 对只是加载中的新链接，等待首次有效内容；对用户主动改变当前网页内容，截图以最后实际显示内容为准。
- 会话级节点状态不写入 SQLite；本轮先保证在一次打开专题期间切换卡片的位置一致性，重开专题仍以静态缓存为初始展示。

若网站依赖复杂的前端内存状态、登录会话或实时数据，即使地址和滚动一致，新页面也可能与旧图不同。这是单实时 WebView2 方案的客观边界，不通过额外 HTML 抓取重建解决。

### 4.4 统一画面几何

核对 `CapturePreview` 输出实际像素宽高、卡片内容布局尺寸和 WebView2 CSS 视口尺寸。要求截图与实时网页共享相同逻辑排版宽度和左上角原点。

当截图尺寸已与卡片内容宽高比一致时，建议使用直接占满内容区的绘制方式，避免 `object-fit: cover` 造成无意裁剪；若截图包含不同尺寸区域，则必须按捕获时的原始宽高比显式计算缩放/裁切，不能只依赖 CSS cover。

初期不把 PNG 转成 SVG；位图清晰度问题与激活瞬间的刷新感分别验收。WebView2 ZoomFactor 与 RasterizationScale 不要在交接的最后一刻二次改变目标布局。

## 5. 应修改的文件与优先级

| 优先级 | 文件 | 改动 |
| --- | --- | --- |
| P0 | apps/desktop/src/workspace/CanvasWebPreview.ts | 识别新图已捕获后启动过渡，过渡完才 reveal；异步会话取消与层级同步 |
| P0 | apps/desktop/src/workspace/CanvasPreviewCache.ts | 为交接提供解码后的待显示图片，延迟旧对象 URL 回收 |
| P0 | apps/desktop/src/workspace/CollectionNodes.tsx | 选中网页的双图短时过渡；其他卡片保持单静态图片 |
| P0 | apps/desktop/src/workspace/collection-canvas.css | 两张图相同定位、裁剪、短 opacity 过渡及减少动态效果适配 |
| P0 | apps/desktop/src/workspace/collection-canvas.test.tsx | 旧图持续显示、渐变完成再 reveal、快速切换取消、对象 URL 回收 |
| P1 | src-tauri/src/canvas_webview.rs + apps/desktop/src/desktop.ts | 增加会话级当前 URL、滚动位置读写与激活恢复，只在证实状态重置影响显著时实现 |
| P1 | apps/desktop/src/workspace/CollectionCanvas.tsx | 确保普通点击选择不会自动调用 fitView；调试日志与交接会话状态接线 |

执行时先隔离 **刷新感来自截图瞬间替换** 与 **网页真的重载导致的内容变化**。若两者同时存在，先实施 P0，再实现 P1 的会话状态恢复，不要用延长过渡时间代替内容一致性。

## 6. 自动化与桌面验收

### 单元及集成测试

- A 节点原有截图存在时，选中 A：新网页尚未 ready 前旧截图保持不变；新图 decode 完成后开始交接，过渡完成后才调用 reveal。
- 页面加载失败、截图超时或空图时继续显示旧截图，并能再次选中尝试；不可把空白 PNG 替代有效缓存。
- A→B→C 快速切换、B 还未加载就点空白：过期过渡不执行 reveal，旧图不会写到其他节点，临时对象 URL 释放。
- 多选、点击空白、选中非网页节点时均不保留原生交互视图。
- 滚动至正文中部后 A→B→A：确认当前会话内真实 URL 与滚动位置恢复，再核对前后几何与截取图。
- 连续缩放过程中旧图/新图都跟随同一 React Flow 变换；不出现独立动画导致的边框错位。

### Windows 11 实机对照

对固定 DOM 页与动态网页各做至少 5 轮，使用 Release 构建，在 100%、150% 系统显示比例及 50%、100%、200%、300% 画布缩放下测试：

1. 记录点击选中至页面可交互的耗时 P50/P95；建议初始过渡时间 150ms，过渡只在新网页稳定后启动。
2. 逐帧检查截图切换期间卡片外框相对网页内容是否发生像素级位移，目标 ≤2 CSS px。
3. 采样窗口实际屏幕，白帧及网页画面越界次数必须为 0。
4. 对固定内容页，截图交接前后页面位置、文字换行与滚动位置应保持一致；动态页面变化按实际内容记录。
5. 确认过渡后的真实网页可点击、滚动、导航，且切换到其他卡片后无原生视图遮挡残留。
6. 用主进程绘制采样而不只用 DOM/React 断言；原生子窗口的 z-order 不受普通 CSS z-index 控制。

不将上一轮 Electron 原型测试作为本轮 Tauri 合成效果的验收结果。

## 7. Codex 执行指令

先阅读本方案及对应最新源码、测试，做最小诊断验证。按“缓存图片过渡 → 原生层级交接 → 会话状态恢复（如必要）”顺序修改，只提交相关文件。完成后运行 `pnpm typecheck`、`pnpm test`、相关 Rust 测试，并提供 Windows Release 实机的画面采样和关键耗时。展示固定页重激活前后截图、真实网页位置变化及验收结果；对无法恢复的动态网页状态记录明确边界。
