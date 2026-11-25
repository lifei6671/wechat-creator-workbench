import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { MarkdownEditorHandle } from "../../../packages/editor-react";
import type { Entry } from "../../../packages/shared-types";
import { desktop } from "../src/desktop";
import { SaveQueue } from "../src/editor/save-queue";
import { DocumentEditor } from "../src/workspace/Document";
import fixture from "../../../fixtures/technology-article.md?raw";

const parameters = new URLSearchParams(location.search);
const source = fixture.replaceAll("\r\n", "\n") + (parameters.has("long")
  ? Array.from({ length: 500 }, (_, index) => `\n\n段落 ${index}：A reliable system preserves content. 长篇正文用于核对输入和主题切换。`).join("") : "");
const entry: Entry = { id: "technology", kind: "article", title: "现代科技文章", contentMd: source, status: "draft",
  categoryId: null, coverAssetId: null, themeId: parameters.get("theme") ?? "plainly-tech", tags: [], summary: "", source: null,
  publishedAt: null, publishedUrl: "", customProperties: [], version: 1, createdAt: 0, updatedAt: 0, deletedAt: null, links: [] };
const queue = new SaveQueue(entry, async (_id, version) => ({ version: version + 1 }), () => {});
let editor: MarkdownEditorHandle | null = null;
declare global { interface Window {
  articleTest: {
    markdown(): ReturnType<MarkdownEditorHandle["captureMarkdown"]>;
    source: string;
    selection(): { from: number; to: number };
    command(command: Parameters<MarkdownEditorHandle["command"]>[0]): void;
    theme(themeId: string): void;
    table(action: Parameters<MarkdownEditorHandle["tableAction"]>[0]): void;
    rememberDocument(): void;
    matchesDocument(): boolean;
  };
  setArticleAppearance(value: "light" | "dark"): void;
  setArticleReading(value: boolean): void;
} }
let matchesDocument = () => false;
Object.assign(window, { articleTest: {
  markdown: () => editor!.captureMarkdown(), source,
  selection: () => ({ from: editor!.target().from, to: editor!.target().to }),
  command: (command: Parameters<MarkdownEditorHandle["command"]>[0]) => editor!.command(command),
  theme: (themeId: string) => flushSync(() => queue.edit({ themeId })),
  table: (action: Parameters<MarkdownEditorHandle["tableAction"]>[0]) => editor!.tableAction(action),
  rememberDocument: () => { matchesDocument = editor!.captureDocumentMatch(); },
  matchesDocument: () => matchesDocument(),
} });
desktop.assetRead = async url => {
  const dimensions: Record<string, [number, number]> = { "asset://screen": [720, 360], "asset://diagram": [600, 180], "asset://small": [32, 32], "asset://wide": [2400, 400] };
  const [width, height] = dimensions[url];
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  if (!url.includes("diagram")) { context.fillStyle = "#f0f0f3"; context.fillRect(0, 0, width, height); }
  context.strokeStyle = "#8b8d98"; context.strokeRect(1, 1, width - 2, height - 2);
  context.fillStyle = "#1c2024"; context.font = "16px sans-serif";
  context.fillText(url.includes("diagram") ? "Markdown → SQLite → Preview" : "Technology workspace", 16, height / 2);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
  return blob.arrayBuffer();
};
desktop.openLink = async url => { document.body.dataset.openedLink = url; };

function Fixture() {
  const [appearance, setAppearance] = useState<"light" | "dark">(parameters.get("appearance") === "dark" ? "dark" : "light");
  const [reading, setReading] = useState(false);
  Object.assign(window, { setArticleAppearance: (value: "light" | "dark") => flushSync(() => setAppearance(value)),
    setArticleReading: (value: boolean) => flushSync(() => setReading(value)) });
  return <Theme appearance={appearance} accentColor="indigo" grayColor="slate"><TooltipProvider>
    <div style={{ height: "100vh" }}><DocumentEditor queue={queue} active locked={false} reading={reading}
      clipboard={{ read: async () => "", write: async () => {}, onError: error => { throw error; } }}
      display={{ limitWidth: true, lineNumbers: false, showTitle: false, convertLinks: false }} onDisplayChange={() => {}}
      handle={value => { editor = value; }} onImages={async () => ""}
      onImageZoom={image => { document.body.dataset.zoomedImage = image.alt; }} onError={error => { throw error; }} /></div>
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
