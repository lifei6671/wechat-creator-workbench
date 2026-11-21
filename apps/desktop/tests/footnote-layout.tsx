import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { MarkdownEditorHandle } from "../../../packages/editor-react";
import type { Entry } from "../../../packages/shared-types";
import { DocumentEditor } from "../src/workspace/Document";
import { SaveQueue } from "../src/editor/save-queue";
import fixture from "../../../fixtures/footnote-layout.md?raw";

const parameters = new URLSearchParams(location.search);
const normalized = fixture.replaceAll("\r\n", "\n");
const source = parameters.get("newline") === "crlf" ? normalized.replaceAll("\n", "\r\n") : normalized;
const entry: Entry = { id: "footnote-layout", kind: "article", title: "脚注换行", contentMd: source, status: "draft",
  categoryId: null, coverAssetId: null, themeId: parameters.get("theme"), tags: [], summary: "", source: null,
  publishedAt: null, publishedUrl: "", customProperties: [], version: 1, createdAt: 0, updatedAt: 0, deletedAt: null, links: [] };
const unexpected = () => { throw new Error("The footnote fixture must not save or use native services"); };
const queue = new SaveQueue(entry, unexpected, unexpected);
let editor: MarkdownEditorHandle | null = null;

function Fixture() {
  const [reading, setReading] = useState(false);
  return <Theme><TooltipProvider>
    <label><input type="checkbox" checked={reading} onChange={event => setReading(event.target.checked)} />阅读模式</label>
    <button onClick={() => { document.body.dataset.sourceUnchanged = String(editor!.captureMarkdown().markdown === source); }}>核对原文</button>
    <DocumentEditor queue={queue} active locked={false} reading={reading}
      clipboard={{ read: unexpected, write: unexpected, onError: unexpected }}
      display={{ limitWidth: true, lineNumbers: false, showTitle: false, convertLinks: true }} onDisplayChange={unexpected}
      handle={value => { editor = value; }} onImages={unexpected} onImageZoom={unexpected} onError={unexpected} />
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
