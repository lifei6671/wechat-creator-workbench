# 莫兰迪科技长文

低饱和度的装饰帮助组织内容，正文继续继承阅读环境的颜色。Technology articles need clear hierarchy, readable examples and reliable references. **重要结论保持本色**，*斜体*、~~删除线~~与 ==重点标记== 保留语义。

## 接口与数据流

这是最主要的章节层级，左侧竖线使用灰蓝色。长地址保持完整：https://github.com/example/technology-project/blob/main/documentation/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz?revision=0123456789012345678901234567890123456789

### 设计约束

正文中的 `request.operationId` 与 `abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz` 应自然换行。

#### 实现细节

本节解释实现。

##### 校验过程

保留清晰的小标题。

###### 补充信息

辅助层级不添加过多装饰。

> 引用第一段，强调事实与上下文。
>
> 引用第二段，保留完整的阅读节奏。
>
> > 嵌套引用继续继承正文颜色。

> [!NOTE] 实现提示
> 提示块也保持透明背景，不用低对比度颜色承载正文。

1. 准备输入。
2. 检查结果。
   - 比较版本。
   - 保留回执。
     - 验证嵌套缩进。

- [x] 完成自动化验证。
- [ ] 完成公众号真机验收。

```typescript
interface Operation { id: string; revision: number }
const endpoint = "https://example.test/api/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
function send(operation: Operation) {
    // Preserve indentation and line breaks.
    console.log(operation.id, operation.revision);
}
```

| 能力 | 数量 | 说明 |
| :--- | ---: | :--- |
| 事务 | 128 | `atomic` 写入 |
| 校验 | 256 | 保留文字与链接 |

| 第一列 | 第二列 | 第三列 | 第四列 | 第五列 | 第六列 | 第七列 | 第八列 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 项目 | API | 技术文档 | 长内容自动折行 | 版本 | 回执 | 状态 | 结论 |

![软件截图](asset://morandi-screen)

<figure><img src="asset://morandi-diagram" alt="数据流架构的无障碍说明"><figcaption>图 1：独立保存的架构图说明。</figcaption></figure>

---

阅读 [公众号参考文章](https://mp.weixin.qq.com/s/morandi-reference)，其链接处理沿用现有发布策略。开源资料见脚注[^1]。

```mermaid
flowchart LR
  A[Markdown] --> B[内联样式]
  B --> C[公众号]
```

[^1]: https://github.com/example/technology-project
