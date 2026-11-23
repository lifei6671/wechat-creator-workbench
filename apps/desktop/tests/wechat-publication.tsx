import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import "../src/styles/wechat-publication.css";
import "../src/styles/right-sidebar.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { Entry, WechatCandidate, WechatPublicationDefaults } from "../../../packages/shared-types";
import { renderWechat } from "../../../packages/wechat-renderer";
import { desktop } from "../src/desktop";
import { SaveQueue } from "../src/editor/save-queue";
import { useButtonFeedback } from "../src/button-feedback";
import { SidebarToggleIcon, Tool } from "../src/ui";
import { WechatPublicationPanel } from "../src/workspace/WechatPublicationPanel";
import { RightSidebarToolbar, type RightSidebarMode } from "../src/workspace/RightSidebar";
import { PropertiesPanel } from "../src/workspace/Dialogs";
import { AiPanel } from "../src/workspace/AiPanel";
import { recommendationFingerprint, WechatPublishing } from "../src/workspace/wechat-publication";

const candidates: WechatCandidate[] = Array.from({ length: 8 }, (_, index) => ({ entryId: `past-${index}`, title: `向量检索实践 ${index + 1}`,
  summary: "向量数据库与检索增强生成的实践经验", url: `https://mp.weixin.qq.com/s/past-${index}`, tags: ["向量检索"], publishedAt: 1 }));
let defaults: WechatPublicationDefaults = { schemaVersion: 1, recommendationCount: 5, version: 0, updatedAt: 0 };
desktop.wechatPublicationDefaults = async () => defaults;
desktop.saveWechatPublicationDefaults = async (version, count) => {
  if (version !== defaults.version) throw new Error("默认配置已更新");
  return defaults = { ...defaults, recommendationCount: count, version: version + 1, updatedAt: Date.now() };
};
desktop.wechatRecommendations = async input => ({ inputFingerprint: await recommendationFingerprint(input),
  items: candidates.slice(0, input.count).map(({ entryId, title, url }) => ({ entryId, title, url })) });
desktop.wechatCandidates = async (_input, query, related) => ({ items: candidates.filter(item => item.title.includes(query)).slice(0, related ? 7 : 8), nextOffset: null });
desktop.resolveWechatRecommendations = async (_input, items) => ({ items, invalid: [] });
const thread = { id: "sidebar-fixture", title: "当前对话", archived: false, updatedAt: 1 };
desktop.aiThreads = async () => [thread];
desktop.aiThread = async () => thread;
desktop.aiMessages = async () => [];
desktop.aiUpdateThread = async () => {};
desktop.aiDeleteThread = async () => { throw new Error("测试删除失败"); };
const entry: Entry = { id: "current", kind: "article", title: "如何构建可靠的知识检索", contentMd: "## 从关键词到语义检索\n\n向量检索把问题与文档映射到同一空间。",
  status: "draft", categoryId: null, tags: ["向量检索"], summary: "", source: null, publishedAt: null, publishedUrl: "", createdAt: 1, updatedAt: 1, deletedAt: null, version: 1, links: [] };
function Fixture() {
  const [failure] = useState(() => ({ once: new URLSearchParams(location.search).has("failure") }));
  const [publishing] = useState(() => new WechatPublishing());
  const [saved, setSaved] = useState(entry);
  const [queue] = useState(() => new SaveQueue(entry, async (_id, version, fields) => {
    for (const item of fields.wechatPublication?.recommendations.items ?? []) {
      const unknown = Object.keys(item).find(key => !["entryId", "title", "url"].includes(key));
      if (unknown) throw new Error(`unknown field '${unknown}', expected one of 'entryId', 'title', 'url'`);
    }
    if (failure.once && fields.wechatPublication?.recommendations.mode === "manual") { failure.once = false; throw new Error("模拟保存失败"); }
    setSaved({ ...entry, ...fields, version: version + 1 }); return { version: version + 1 };
  }, () => {}));
  const [session] = useState(() => publishing.session(queue));
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const { fields } = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState("");
  const [barrier, setBarrier] = useState(false);
  const [mode, setMode] = useState<RightSidebarMode>("wechat");
  const [visible, setVisible] = useState(true);
  const propertiesFlush = useRef<((closing?: boolean) => Promise<boolean>) | null>(null);
  async function switchPanel(next: RightSidebarMode | null) {
    if (propertiesFlush.current && !await propertiesFlush.current()) return;
    if (!await publishing.flush()) return;
    if (next) { setMode(next); setVisible(true); } else setVisible(false);
  }
  const feedback = useButtonFeedback();
  useEffect(() => { let current = true;
    if (state.ready) void renderWechat({ markdown: fields.contentMd, revision: 1, output: "preview", themeId: fields.themeId, recommendations: state.resolved.items },
      { image: async () => { throw new Error("unexpected image"); }, sources: async () => [], derive: async () => { throw new Error("unexpected graphic"); } }).then(result => { if (current) setHtml(result.html); result.dispose(); });
    return () => { current = false; };
  }, [fields, state.ready, state.resolved]);
  return <Theme appearance={new URLSearchParams(location.search).get("dark") ? "dark" : "light"}><TooltipProvider>
    <div data-windows-titlebar={new URLSearchParams(location.search).has("windows") || undefined}
      style={{ display: "grid", gridTemplateColumns: visible ? "minmax(0, 1fr) 380px" : "1fr", height: "100vh" }}>
      {new URLSearchParams(location.search).has("windows") && <div className="window-controls" data-testid="window-controls" style={{ width: 132, height: 40 }} />}
      <main style={{ padding: 40, overflow: "auto" }}>
        <header className="workbench-chrome chrome-band" style={{ margin: "-40px -40px 24px", height: 40, "--chrome-trailing-space": "380px" } as CSSProperties}>
          <div className="window-drag" /><Tool className="chrome-icon sidebar-toggle ai-panel-trigger" label={visible ? "隐藏右侧栏" : "显示右侧栏"} aria-expanded={visible} onClick={() => void switchPanel(visible ? null : mode)}><SidebarToggleIcon side="right" expanded={visible} /></Tool>
        </header><h1>{fields.title}</h1><div data-testid="preview" dangerouslySetInnerHTML={{ __html: html }} />
        <button data-testid="backup-barrier" onClick={() => { void publishing.flush().then(setBarrier); }}>保存检查</button>
      </main>{visible && <aside className="right-sidebar" aria-label="右侧栏">
        <RightSidebarToolbar value={mode} disabled={{ outline: true }} onError={console.error} onChange={value => void switchPanel(value)} />
        <div className="right-sidebar-content">
          <div role="region" id="right-sidebar-wechat-panel" aria-labelledby="right-sidebar-wechat-button" hidden={mode !== "wechat"}>
            {mode === "wechat" && <WechatPublicationPanel embedded session={session} locked={false} publishing={false} onClose={() => void switchPanel(null)} copyFeedback={feedback}
              onCopy={() => void feedback.run("copyWechat", async () => { const items = await session.prepare(); setCopied(JSON.stringify(items)); })} />}
          </div>
          <div role="region" id="right-sidebar-ai-panel" aria-labelledby="right-sidebar-ai-button" hidden={mode !== "ai"}>
            <div className="ai-sidebar"><AiPanel open={mode === "ai"} queue={queue} target={{ hint: "请选择 AI 目标" }} targetPicker={null} canChat={false} canEdit={false}
              canWrite={() => false} onClose={() => void switchPanel(null)} onSettings={() => {}} /></div>
          </div>
          <div role="region" id="right-sidebar-properties-panel" aria-labelledby="right-sidebar-properties-button" hidden={mode !== "properties"}>
            {mode === "properties" && <PropertiesPanel queue={queue} categories={[]} tagSuggestions={[]} locked={false} flushRef={propertiesFlush}
              onSave={async (_entry, change) => { queue.edit(change); if (!await queue.flush({ retry: true })) throw queue.saveError(); }}
              onClose={() => void switchPanel(null)} onOpen={() => {}} />}
          </div>
        </div>
      </aside>}
    </div><output hidden data-testid="saved">{JSON.stringify(saved)}</output><output hidden data-testid="copied">{copied}</output>
    <output hidden data-testid="defaults">{JSON.stringify(defaults)}</output><output hidden data-testid="barrier">{String(barrier)}</output>
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
