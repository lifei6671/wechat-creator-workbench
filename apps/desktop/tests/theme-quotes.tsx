import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { MarkdownEditorHandle } from "../../../packages/editor-react";
import type { Entry } from "../../../packages/shared-types";
import { calloutLabels } from "../../../packages/markdown-core/callouts";
import { renderWechat, wechatThemes } from "../../../packages/wechat-renderer";
import { SaveQueue } from "../src/editor/save-queue";
import { DocumentEditor } from "../src/workspace/Document";
import previewCss from "../src/styles/preview.css?inline";

const parameters = new URLSearchParams(location.search);
const themeId = parameters.get("theme") ?? wechatThemes[0].id;
const newline = parameters.get("newline") === "crlf" ? "\r\n" : "\n";
const source = (parameters.has("urls") ? [
  "官方遥测文档：https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md[^1]",
  "English words stay complete: Adversarial Distillation Research Natural wrapping.",
  "`https://example.test/inline-code`",
  "```text\nhttps://example.test/code-block\n```",
  "[^1]: https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md",
] : [
  "> 单段引用",
  "> 引用第一段\n>\n> 引用中间段\n>\n> 引用末尾段",
  ...Object.keys(calloutLabels).map(kind => `> [!${kind.toUpperCase()}] 自定义标题\n> 提示第一段\n>\n> 提示中间段\n>\n> 提示末尾段`),
]).join(parameters.has("urls") ? "\n\n" : "\n\n分隔段落\n\n").replaceAll("\n", newline);
const entry: Entry = { id: "quote-spacing", kind: "article", title: "引用段距", contentMd: source, status: "draft",
  categoryId: null, coverAssetId: null, themeId, tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "",
  customProperties: [], version: 1, createdAt: 0, updatedAt: 0, deletedAt: null, links: [] };
const unexpected = () => { throw new Error("The quote fixture must not save or use native services"); };
const queue = new SaveQueue(entry, unexpected, unexpected);
let editor: MarkdownEditorHandle | null = null;

function Fixture() {
  const [reading, setReading] = useState(false);
  return <Theme><TooltipProvider>
    <label><input type="checkbox" checked={reading} onChange={event => setReading(event.target.checked)} />阅读模式</label>
    <button onClick={() => {
      document.body.dataset.sourceUnchanged = String(editor!.captureMarkdown().markdown === source);
    }}>核对原文</button>
    <DocumentEditor queue={queue} active locked={false} reading={reading}
      clipboard={{ read: unexpected, write: unexpected, onError: unexpected }}
      display={{ limitWidth: true, lineNumbers: false, showTitle: false, convertLinks: false }} onDisplayChange={unexpected}
      handle={value => { editor = value; }} onImages={unexpected} onImageZoom={unexpected} onError={unexpected} />
  </TooltipProvider></Theme>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
for (const output of ["preview", "clipboard", "html"] as const) {
  const result = await renderWechat({ markdown: source, themeId, revision: 1, output }, {
    sources: unexpected, image: unexpected, derive: unexpected,
  });
  const host = document.body.appendChild(document.createElement("div"));
  host.dataset.output = output;
  host.attachShadow({ mode: "open" }).innerHTML = `<style>${previewCss}</style>${result.html}`;
  result.dispose();
}
document.body.dataset.ready = "true";
