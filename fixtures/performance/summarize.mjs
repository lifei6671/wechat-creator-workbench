import { readFileSync } from "node:fs";
import { join } from "node:path";

const [baselineDir, optimizedDir, baselineTabsDir, optimizedTabsDir] = process.argv.slice(2);
if (![baselineDir, optimizedDir, baselineTabsDir, optimizedTabsDir].every(Boolean)) {
  throw new Error("node fixtures/performance/summarize.mjs <基线> <改造后> <基线标签> <改造后标签>");
}
const read = folder => JSON.parse(readFileSync(join(folder, "results.json"), "utf8"));
const before = read(baselineDir);
const after = read(optimizedDir);
const tabsBefore = read(baselineTabsDir).results;
const tabsAfter = read(optimizedTabsDir).results;
const names = [...new Set(before.results.filter(row => row.input).map(row => row.fixture.name))];
const f = number => number.toFixed(1);
const integerRange = numbers => {
  const min = Math.min(...numbers), max = Math.max(...numbers);
  return min === max ? String(min) : `${min}–${max}`;
};
const percentile = (values, quantile) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];
const distribution = values => [0.5, 0.95, 0.99].map(quantile => f(percentile(values, quantile))).join(" / ");
const count = (rows, name) => integerRange(rows.map(row => row.inputMetrics[name]?.count ?? 0));
const table = (head, rows) => {
  const line = cells => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
};
const sample = names.map(name => {
  const old = before.results.filter(row => row.input && row.fixture.name === name);
  const next = after.results.filter(row => row.input && row.fixture.name === name);
  if (old.length !== next.length || old.length < 5) throw new Error(`${name} 的配对轮数不足`);
  return { name, old, next };
});

console.log(table(["样本", "中文字符", "UTF-8 KiB", "ProseMirror 节点", "顶层块", "表格单元格"],
  sample.map(({ name, old: [{ fixture, shape }] }) => [name, fixture.chineseCharacters, f(fixture.utf8Bytes / 1024), shape.nodes, shape.blocks, shape.cells])));
console.log();
console.log(table(["样本", "输入到下一帧 P50/P95/P99（改造前）", "改造后", "P95 变化", "最长 Long Task（前 → 后）"],
  sample.map(({ name, old, next }) => {
    const frames = rows => rows.flatMap(row => row.input.nextFrameMs);
    const maxTask = rows => {
      const values = rows.flatMap(row => row.longTasks);
      return values.length ? f(Math.max(...values)) : "—";
    };
    const change = (percentile(frames(next), 0.95) / percentile(frames(old), 0.95) - 1) * 100;
    return [name, distribution(frames(old)), distribution(frames(next)), `${f(change)}%`, `${maxTask(old)} → ${maxTask(next)}`];
  })));
console.log();
console.log(table(["样本", "输入期间全文序列化（前 → 后）", "全局块装饰（前 → 后）", "全文链接装饰（前 → 后）", "正文整理（前 → 后）", "文档组件提交（前 → 后）", "状态栏提交（前 → 后）"],
  sample.map(({ name, old, next }) => [name, ...["markdown.serialize", "decoration.blocks.full", "decoration.links.full", "layout.normalize", "document.commit", "status.commit"]
    .map(metric => `${count(old, metric)} → ${count(next, metric)}`)])));
console.log();
const averageMetric = (rows, name, afterInput = false) => {
  let calls = 0, milliseconds = 0;
  for (const row of rows) {
    const current = row.save.metrics[name];
    const input = afterInput ? row.inputMetrics[name] : undefined;
    calls += (current?.count ?? 0) - (input?.count ?? 0);
    milliseconds += (current?.ms ?? 0) - (input?.ms ?? 0);
  }
  return calls ? f(milliseconds / calls) : "—";
};
console.log(table(["样本", "首次 / 后续打开 P95（前 → 后）", "最后一次保存前的全文快照均值", "最后一次保存 IPC 均值（前 → 后）", "AI 校验及提交 P95（前 → 后）"],
  sample.map(({ name, old, next }) => {
    const opening = rows => `${f(rows[0].opened["editor.open"].ms)} / ${f(percentile(rows.slice(1).map(row => row.opened["editor.open"].ms), 0.95))}`;
    const ai = rows => f(percentile(rows.flatMap(row => row.targetMetrics.map(metric => metric.replaceMs)), 0.95));
    return [name, `${opening(old)} → ${opening(next)}`, averageMetric(next, "markdown.snapshot", true),
      `${averageMetric(old, "save.ipc", true)} → ${averageMetric(next, "save.ipc", true)}`, `${ai(old)} → ${ai(next)}`];
  })));
console.log();
const mib = bytes => typeof bytes === "number" ? f(bytes / 1024 ** 2) : "—";
console.log(table(["标签数", "切换到下一帧 P95（前 → 后）", "改造后 JS 堆 MiB（关闭前 → 后）", "改造后 WebView 工作集 MiB（关闭前 → 后）", "改造后 DOM 元素（关闭前 → 后）"],
  [1, 5, 10].map(tabs => {
    const old = tabsBefore.find(row => row.tabs === tabs), next = tabsAfter.find(row => row.tabs === tabs);
    const switchTime = tabs > 1 ? `${f(percentile(old.switchFrameMs, 0.95))} → ${f(percentile(next.switchFrameMs, 0.95))}` : "—";
    return [tabs, switchTime, `${mib(next.before.heap.usedSize)} → ${mib(next.after.heap.usedSize)}`,
      `${mib(next.before.workingSet.webview)} → ${mib(next.after.workingSet.webview)}`, `${next.before.elements} → ${next.after.elements}`];
  })));
