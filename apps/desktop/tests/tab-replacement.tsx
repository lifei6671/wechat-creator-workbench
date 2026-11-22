import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import type { Entry } from "../../../packages/shared-types";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { SaveQueue } from "../src/editor/save-queue";
import { DocumentTabs } from "../src/workspace/Document";

const unexpected = () => { throw new Error("Unexpected fixture action"); };
function queue(id: string, title: string) {
  const entry: Entry = { id, title, kind: "article", status: "draft", categoryId: null, contentMd: "", tags: [], summary: "", source: null,
    publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [] };
  return new SaveQueue(entry, unexpected, unexpected);
}
const first = queue("first", "第一篇"), old = queue("old", "旧文稿"), last = queue("last", "第三篇"), next = queue("next", "新文稿");

function Fixture() {
  const [sessions, setSessions] = useState([first, old, last]);
  const [replacement, setReplacement] = useState<{ from: string; to: string }>();
  return <Theme><TooltipProvider>
    <button onClick={() => { setSessions([first, next, last]); setReplacement({ from: "old", to: "next" }); }}>替换当前文章</button>
    <button onClick={() => setSessions([first, next, last, old])}>打开新标签</button>
    <div style={{ width: 600 }}><DocumentTabs sessions={sessions} replacement={replacement} activeId="next" readingIds={[]} lockedIds={[]}
      categories={[]} onSwitch={unexpected} onClose={id => setSessions(current => current.filter(queue => queue.entry.id !== id))}
      onAction={unexpected} onMove={unexpected} onReorder={unexpected} onRename={async () => unexpected()} onError={unexpected} /></div>
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
