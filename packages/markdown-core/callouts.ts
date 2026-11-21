import type MarkdownIt from "markdown-it";

export const calloutLabels = {
  note: "备注", abstract: "摘要", info: "信息", todo: "待办事项", tip: "提示", success: "成功",
  question: "问题", warning: "警告", failure: "失败", danger: "危险", bug: "错误", example: "示例", quote: "引用",
} as const;

export function calloutTone(kind: keyof typeof calloutLabels) {
  if (["warning", "question"].includes(kind)) return "warning";
  if (["failure", "danger", "bug"].includes(kind)) return "danger";
  if (["tip", "success"].includes(kind)) return "success";
  return "info";
}

export function readCalloutMarker(line: string) {
  const marker = /^\[!([a-z]+)\](?=\s|$)/i.exec(line);
  if (!marker) return;
  const kind = marker[1].toLowerCase() as keyof typeof calloutLabels;
  if (!Object.hasOwn(calloutLabels, kind)) return;
  return { marker: marker[0], kind, label: calloutLabels[kind] };
}

export function renderCallouts(parser: MarkdownIt) {
  parser.core.ruler.after("inline", "workbench_callouts", state => {
    state.tokens.forEach((quote, index, tokens) => {
      if (quote.type !== "blockquote_open" || tokens[index + 1]?.type !== "paragraph_open") return;
      const { content, children } = tokens[index + 2];
      const callout = readCalloutMarker(content);
      const first = children?.[0];
      if (!callout || !children || first?.type !== "text" || !first.content.startsWith(callout.marker)) return;

      quote.attrJoin("class", `workbench-callout workbench-callout-${callout.kind} workbench-callout-tone-${calloutTone(callout.kind)}`);
      first.content = first.content.slice(callout.marker.length).trimStart();
      const breakAt = children.findIndex(token => token.type === "softbreak" || token.type === "hardbreak");
      const title = children.slice(0, breakAt < 0 ? children.length : breakAt);
      if (title.length === 1 && !first.content) first.content = callout.label;
      const open = new state.Token("strong_open", "strong", 1);
      open.attrSet("class", "workbench-callout-title");
      const close = new state.Token("strong_close", "strong", -1);
      const body = breakAt < 0 ? [] : [new state.Token("hardbreak", "br", 0), ...children.slice(breakAt + 1)];
      tokens[index + 2].children = [open, ...title, close, ...body];
    });
  });
}
