import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import "../src/styles/settings.css";
import "../src/styles/menus.css";
import type { Entry } from "../../../packages/shared-types";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { desktop } from "../src/desktop";
import { DesktopShell } from "../src/workspace/DesktopShell";
import { saveDocumentTabs, saveWorkspaceLayout } from "../src/workspace/preferences";
import { recommendationFingerprint } from "../src/workspace/wechat-publication";

const article: Entry = { id: "resize", title: "窗口缩放中的文章", kind: "article", contentMd: ["## 正文", "保留正文和侧栏内容。", "### 子节",
  ...Array.from({ length: new URLSearchParams(location.search).has("long") ? 1000 : 24 }, (_, index) => `段落 ${index + 1}：用于滚动定位并检查当前章节跟随。`), "## 第二节", "第二节正文。"].join("\n\n"), status: "draft", categoryId: null,
  createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null, tags: [], summary: "文章摘要", source: null, publishedAt: null, publishedUrl: "", version: 1, links: [] };
const second = { ...article, id: "second", title: "另一篇用于检查标签布局的文章" };
const thread = { id: "resize-thread", title: "当前对话", archived: false, updatedAt: 1 };
const publicationTyping = { saves: 0, recommendations: 0 };
Object.assign(window, { publicationTyping });
desktop.library = async () => ({ workspaceId: "resize-fixture", categories: [], tags: [], tagSuggestions: [] });
desktop.entries = async filter => ({ items: filter.pinned ? [] : [article, second], nextOffset: null });
desktop.entry = async id => id === second.id ? second : article;
desktop.save = async (_id, version) => { publicationTyping.saves++; return { version: version + 1 }; };
desktop.collections = async () => [];
desktop.entryCollections = async () => [];
desktop.imageStorageTarget = async () => null;
desktop.mcpStatus = async () => ({ running: false, config: { enabled: false, port: 8787, permission: "read" }, error: null });
desktop.restoreNotice = async () => null;
desktop.syncActivity = async () => null;
desktop.syncStatus = async () => null;
desktop.syncWake = async () => {};
desktop.setWindowBackground = async () => {};
desktop.aiSettings = async () => ({ preferences: { enabled: true, defaultTarget: { kind: "model", id: "test" } }, agents: [],
  models: [{ id: "test", kind: "custom", name: "测试模型", endpoint: "http://localhost", model: "test", timeoutSeconds: 30 }] });
desktop.aiThreads = async () => [thread];
desktop.aiThread = async () => thread;
desktop.aiMessages = async () => [];
desktop.aiUpdateThread = async () => {};
desktop.wechatGraphics = async () => [];
desktop.wechatPublicationDefaults = async () => ({ schemaVersion: 1, recommendationCount: 5, recommendationAuthors: [], version: 0, updatedAt: 0 });
desktop.wechatRecommendations = async input => { publicationTyping.recommendations++; return { inputFingerprint: await recommendationFingerprint(input), items: [] }; };
desktop.resolveWechatRecommendations = async (_input, items) => ({ items, invalid: [] });
for (const event of ["onExit", "onHistory", "onHideRequested", "onSyncStatusChanged", "onWorkspaceChanged", "onTrashEmptied", "onAssetsChanged", "onBackupProgress", "onMcpStatusChanged"] as const) {
  desktop[event] = async () => () => {};
}
const priority = new URLSearchParams(location.search).has("priority");
const collapsed = new URLSearchParams(location.search).has("collapsed");
if (collapsed) {
  article.title = "发现 5 个宝藏开源 AI 视频工具！写文案、自动剪辑、生成宣传片，连剪映都能交给 AI！";
  second.title = "手写笔记、PDF批注和无限画布直接搬进笔记软件，学习效率翻倍";
}
if (priority) {
  localStorage.setItem("timeline-article-width", "480");
  localStorage.setItem("ai-sidebar-width", "420");
}
localStorage.setItem("view", JSON.stringify(new URLSearchParams(location.search).has("edit") ? "edit" : "preview"));
saveWorkspaceLayout({ section: "timeline", explorerOverride: !collapsed, timelineDirectory: priority ? "manual" : "shown", focusMode: false, aiOpen: true });
saveDocumentTabs("resize-fixture", { ids: [second.id, article.id], activeId: article.id });
createRoot(document.getElementById("root")!, { onUncaughtError(error, info) { console.error(error, info.componentStack); } }).render(<TooltipProvider><DesktopShell /></TooltipProvider>);
