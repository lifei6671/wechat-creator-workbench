import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import "../src/styles/wechat-publication.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { Entry, WechatCandidate, WechatPublicationDefaults } from "../../../packages/shared-types";
import { renderWechat } from "../../../packages/wechat-renderer";
import { desktop } from "../src/desktop";
import { SaveQueue } from "../src/editor/save-queue";
import { useButtonFeedback } from "../src/button-feedback";
import { WechatPublicationPanel } from "../src/workspace/WechatPublicationPanel";
import { recommendationFingerprint, WechatPublishing } from "../src/workspace/wechat-publication";

const candidates: WechatCandidate[] = Array.from({ length: 8 }, (_, index) => ({ entryId: `past-${index}`, title: `向量检索实践 ${index + 1}`,
  summary: "向量数据库与检索增强生成的实践经验", url: `https://mp.weixin.qq.com/s/past-${index}`, tags: ["向量检索"], publishedAt: 1 }));
let defaults: WechatPublicationDefaults = { schemaVersion: 1, recommendationCount: 5, version: 0, updatedAt: 0 };
desktop.wechatPublicationDefaults = async () => defaults;
desktop.saveWechatPublicationDefaults = async (version, count) => {
  if (version !== defaults.version) throw new Error("默认配置已更新");
  return defaults = { ...defaults, recommendationCount: count, version: version + 1, updatedAt: Date.now() };
};
desktop.wechatRecommendations = async input => ({ inputFingerprint: await recommendationFingerprint(input), items: candidates.slice(0, input.count) });
desktop.wechatCandidates = async (_input, query, related) => ({ items: candidates.filter(item => item.title.includes(query)).slice(0, related ? 7 : 8), nextOffset: null });
desktop.resolveWechatRecommendations = async (_input, items) => ({ items, invalid: [] });
const entry: Entry = { id: "current", kind: "article", title: "如何构建可靠的知识检索", contentMd: "## 从关键词到语义检索\n\n向量检索把问题与文档映射到同一空间。",
  status: "draft", categoryId: null, tags: ["向量检索"], summary: "", source: null, publishedAt: null, publishedUrl: "", createdAt: 1, updatedAt: 1, deletedAt: null, version: 1, links: [] };
function Fixture() {
  const [failure] = useState(() => ({ once: new URLSearchParams(location.search).has("failure") }));
  const [publishing] = useState(() => new WechatPublishing());
  const [saved, setSaved] = useState(entry);
  const [queue] = useState(() => new SaveQueue(entry, async (_id, version, fields) => {
    if (failure.once && fields.wechatPublication?.recommendations.mode === "manual") { failure.once = false; throw new Error("模拟保存失败"); }
    setSaved({ ...entry, ...fields, version: version + 1 }); return { version: version + 1 };
  }, () => {}));
  const [session] = useState(() => publishing.session(queue));
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const { fields } = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState("");
  const [barrier, setBarrier] = useState(false);
  const feedback = useButtonFeedback();
  useEffect(() => { let current = true;
    if (state.ready) void renderWechat({ markdown: fields.contentMd, revision: 1, output: "preview", themeId: fields.themeId, recommendations: state.resolved.items },
      { image: async () => { throw new Error("unexpected image"); }, sources: async () => [], derive: async () => { throw new Error("unexpected graphic"); } }).then(result => { if (current) setHtml(result.html); result.dispose(); });
    return () => { current = false; };
  }, [fields, state.ready, state.resolved]);
  return <Theme appearance={new URLSearchParams(location.search).get("dark") ? "dark" : "light"}><TooltipProvider>
    <div data-windows-titlebar={new URLSearchParams(location.search).has("windows") || undefined}
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px", height: "100vh" }}>
      {new URLSearchParams(location.search).has("windows") && <div className="window-controls" data-testid="window-controls" style={{ width: 132, height: 40 }} />}
      <main style={{ padding: 40, overflow: "auto" }}><h1>{fields.title}</h1><div data-testid="preview" dangerouslySetInnerHTML={{ __html: html }} />
        <button data-testid="backup-barrier" onClick={() => { void publishing.flush().then(setBarrier); }}>保存检查</button>
      </main><WechatPublicationPanel session={session} locked={false} publishing={false} onClose={() => {}} copyFeedback={feedback}
        onCopy={() => void feedback.run("copyWechat", async () => { const items = await session.prepare(); setCopied(JSON.stringify(items)); })} />
    </div><output hidden data-testid="saved">{JSON.stringify(saved)}</output><output hidden data-testid="copied">{copied}</output>
    <output hidden data-testid="defaults">{JSON.stringify(defaults)}</output><output hidden data-testid="barrier">{String(barrier)}</output>
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
