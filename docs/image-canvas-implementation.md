# 图片画布实施记录

本次授权：按已批准的第二版原型与技术方案实现图片编辑、拼接及云同步，不提交、不推送、不部署。

起始代码：`eea0f091d0450986f96b96b7aa47e12fc6455d4b`。已有改动为 `docs/README.md`、技术方案及 `docs/prototypes/image-canvas/`，均保留。

## 共享契约

模型以 `packages/shared-types/image-canvas.ts` 为准。坐标为图层左上角，旋转围绕左上角；翻转在图层矩形内部进行，裁剪使用原图固有像素坐标；数组从底到顶。阴影及不透明度为 0 到 1。

IPC：

- `image_project_open({entryId, src}) -> ImageProject`，读取并私有入库输入；精确成品恢复快照。稳定工程 ID 由宿主和输入素材派生。
- `image_project_save({id, expectedVersion, scene}) -> {version}`，每工程串行版本检查。
- `image_canvas_import`：原始字节请求，`x-asset-name` 头，返回 `ImageCanvasAsset`，不触发自动公开上传。
- `image_canvas_read({url}) -> ArrayBuffer`：校验原始哈希，优先私有同步附件，不把图床压缩版本作为原图；清除返回数据的 EXIF 方向以按原始像素坐标解码，原文件及同步哈希不改变。
- `image_canvas_info({url}) -> ImageCanvasAsset`：读取原图尺寸和 EXIF 方向，初始图层把方向编码为旋转与翻转，场景裁剪始终使用原始像素坐标。
- `image_render_prepare`：原始图片字节请求，头 `x-project-id`、`x-project-version`、`x-render-id`、`x-export-options`（encodeURIComponent(JSON.stringify(options))），从已保存版本冻结快照；返回 `PreparedImageRender`。准备阶段不发布输出同步实体。
- `image_render_commit({renderId, entry?}) -> ImageRenderResult`。entry 为 `{id, expectedVersion, fields, recovery?}`；同一事务登记输出资产、不可变快照、正文及同步原子组。无 entry 为独立输出。重复 renderId 对比回执并返回同一结果。
- 准备输出的源为精确 `asset://` 输出身份。复制和保存复用现有素材命令；文件保存取消不提交 render。

同步协议升级为 3，`image_project` 载荷为 `{originEntryId,baseAssetId,scene,assetIds,createdAt,updatedAt}`，删除沿实体墓碑；`image_render` 载荷为 `{projectId,scene,sceneHash,outputAssetId,assetIds,exportOptions,rendererVersion,createdAt}`，不可变。assetIds 从 scene 派生并核对，render 额外依赖输出素材与已有工程身份。originEntryId 是来源记录，不是必须存活的外键。

场景限制：100 图层、JSON 384 KiB；图片/输出边长 16000、面积 4000 万像素、图片字节 20 MiB；同步沿用实体 512 KiB、推送 1 MiB、256 项原子组。颜色支持十六进制 CSS 色值，避免各渲染端不同的 CSS 解析。

## 进度与验证

- 已确认第二版原型；统一选择驱动的工作区，不设置单图与拼接模式切换。
- 共享模型、真实 Konva 画布、原生持久化、正文事务和协议 3 已实现。
- 前端 40、原生 26、同步服务 14 个文件已通过独立分区及最终整合评审；最终交付身份和构建产物见验收记录。
- 验证详情见 [验收记录](image-canvas-validation.md)。不对生产工作区或服务执行测试写入。
