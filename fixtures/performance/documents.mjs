export const cases = {
  "L1-10k": [10_000, 60, "plain"],
  "L1-50k": [50_000, 250, "plain"],
  "L1-100k": [100_000, 500, "plain"],
  "L2-300k": [300_000, 1500, "plain"],
  "L2-300k-long": [300_000, 120, "plain"],
  "L2-1m": [1_000_000, 5000, "plain"],
  "L2-1m-long": [1_000_000, 400, "plain"],
  "L3-5000": [100_000, 5000, "dense"],
  "L3-20000": [100_000, 20_000, "dense"],
  "L4": [90_000, 450, "structured"],
  "L5": [90_000, 450, "heavy"],
  "L6": [100_000, 600, "structured"],
};

const seed = 0x1172026;
const source = "本文记录网页文章编辑过程中的常见问题包括选区定位内容校验链接处理图片引用搜索替换章节调整表格布局版本比较以及保存流程";

export function documentFixture(name) {
  const [characters, count, structure] = cases[name];
  let random = seed;
  const blocks = [];
  const notes = [];
  for (let i = 0; i < count; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const offset = random % source.length;
    const length = Math.floor((i + 1) * characters / count) - Math.floor(i * characters / count);
    const text = (source.slice(offset) + source.repeat(Math.ceil(length / source.length))).slice(0, length);
    const firstAiSection = name === "L6" && i < 225;
    if (i > 0 && i % 25 === 0 && structure !== "dense" && !firstAiSection) blocks.push(`## 章节 ${i / 25}`);
    if (structure === "structured" && i % 5 === 4 && !firstAiSection) {
      const label = `n${i}`;
      blocks.push(`> ${text} [参考链接](https://example.invalid/${i}) [^${label}]`, `- 项目 ${i}\n  - 子项 ${i}`);
      notes.push(`[^${label}]: 参考资料 ${i}`);
    } else if (structure === "heavy" && i % 8 === 7) {
      blocks.push(text, "| 条目 | 数值 |\n| --- | --- |\n| 样例 | $x^2$ |", "```js\nconst count = 42;\n```",
        i % 72 === 7 ? "```mermaid\ngraph TD; A-->B;\n```" : "$$\nx^2 + y^2 = 1\n$$",
        `![测试图 ${i}](asset://performance-image-${i})`);
    } else {
      blocks.push(text);
    }
  }
  const markdown = [...blocks, ...notes].join("\n\n");
  return { name, seed, markdown, chineseCharacters: [...markdown.matchAll(/\p{Script=Han}/gu)].length,
    utf8Bytes: Buffer.byteLength(markdown) };
}
