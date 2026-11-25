import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../../packages/editor-react";
import { workspaceShortcutForEvent } from "../src/workspace/workspace-shortcuts";

const parameters = new URLSearchParams(location.search);
const source = parameters.get("source") ?? '# **[老实写作业，很枯燥吧？ | Panache 开源全平台手写生成工具](https://linux.do/t/topic/3223667)**\n\n后文';
let editor: MarkdownEditorHandle | null = null;
declare global { interface Window {
  markdown: () => string; pasteSource: (text: string) => Promise<void>;
  setReading: (value: boolean) => void; completeUpload: () => void;
  startHostUpload: () => void; finishHostUpload: () => Promise<number>;
  selectionFrom: () => number;
  pasteWithImages: () => void; finishLocalization: () => Promise<void>;
} }
window.markdown = () => editor!.captureMarkdown().markdown;
window.selectionFrom = () => editor!.target().from;
window.pasteSource = async text => {
  editor!.clipboard("paste", { read: async () => text, write: async () => {}, onError: error => { throw error; } });
  await editor!.pendingEdits();
};
let finishLocalization: (url: string) => void;
window.pasteWithImages = () => {
  editor!.clipboard("paste", {
    read: async () => ({ html: '<p><strong>正文</strong> <img alt="图片" src="https://example.com/original.png"></p>' }),
    write: async () => {},
    localizeImage: () => new Promise<string>(resolve => { finishLocalization = resolve; }),
    onError: error => { throw error; },
  });
};
window.finishLocalization = async () => { finishLocalization("asset://localized"); await editor!.pendingEdits(); };
let uploaded = false;
const readImageUploadState = async () => ({ pending: !uploaded, publicUrl: uploaded ? "https://example.com/uploaded.png" : undefined });
const resolveHostedImage = async () => "https://example.com/uploaded.png";
let hostTask: Promise<number>;
let finishHostUpload: (url: string) => void;
window.startHostUpload = () => {
  hostTask = editor!.hostImages!(() => new Promise<string>(resolve => { finishHostUpload = resolve; }), src => src.startsWith("https://"));
};
window.finishHostUpload = async () => { finishHostUpload("https://example.com/hosted.png"); return hostTask; };
function Fixture() {
  const [reading, setReading] = useState(false);
  const [uploadRevision, setUploadRevision] = useState(0);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || workspaceShortcutForEvent({}, event) !== "reading") return;
      event.preventDefault();
      event.stopPropagation();
      flushSync(() => setReading(value => !value));
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);
  window.setReading = value => flushSync(() => setReading(value));
  window.completeUpload = () => { uploaded = true; flushSync(() => setUploadRevision(value => value + 1)); };
  return <Theme><TooltipProvider>
  <MarkdownEditor entryId="source" value={source} readOnly={reading} convertLinks={parameters.has("footnotes")}
    uploadRevision={uploadRevision} readImageUploadState={parameters.has("upload") ? readImageUploadState : undefined}
    resolveHostedImage={parameters.has("upload") ? resolveHostedImage : undefined}
    ref={value => { editor = value; document.body.dataset.ready = String(Boolean(value)); }}
    onDocumentChanged={() => {}} onBlur={() => {}} />
  <button>外部控件</button>
</TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
