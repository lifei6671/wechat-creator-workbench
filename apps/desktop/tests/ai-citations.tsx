import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { desktop, type AiHistoryItem } from "../src/desktop";
import { AiPanel } from "../src/workspace/AiPanel";

const labels = ["全文", "当前章节", "不引用正文", undefined, "选区"];
const rows: AiHistoryItem[] = labels.map((citation, index) => ({
  parentId: index ? `message-${index - 1}` : null,
  message: { id: `message-${index}`, role: "user", createdAt: new Date("2026-11-21T14:34:00Z"),
    content: [{ type: "text", text: `测试消息 ${index + 1}\n生成标签、摘要和标题` }], attachments: [],
    metadata: { custom: { citation, ...(citation === "选区" && { chatSelection: { original: "需要保留的选区原文", headingPath: [] } }) } } },
}));
const thread = { id: "citation-history", title: "标签布局测试", archived: false, updatedAt: 1 };
desktop.aiThreads = async () => [thread];
desktop.aiThread = async () => thread;
desktop.aiMessages = async () => rows;
desktop.aiUpdateThread = async () => {};
desktop.copyText = async () => { throw new Error("测试复制失败"); };
const appearance = new URLSearchParams(location.search).get("appearance") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(<Theme appearance={appearance}><TooltipProvider>
  <div style={{ width: "100%", height: "100vh" }}>
    <AiPanel open target={{ label: "测试模型" }} targetPicker={null} canChat canEdit={false}
      canWrite={() => false} onClose={() => {}} onSettings={() => {}} />
  </div>
</TooltipProvider></Theme>);
