import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import type { EntryRow } from "../../../packages/shared-types";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { ContentRow, type RowActions } from "../src/workspace/Explorer";

const row: EntryRow = { id: "article", kind: "article", title: "文章", status: "draft", updatedAt: 0, deletedAt: null, categoryId: null };
const unexpected = () => { throw new Error("Unexpected fixture action"); };

function Fixture() {
  const mode = new URLSearchParams(location.search).get("mode") === "new-tab" ? "new-tab" : "current";
  const [opened, setOpened] = useState({ count: 0, id: "", mode: "" });
  const [action, setAction] = useState("");
  const actions: RowActions = {
    active: null, readOnlyIds: [], treeLocked: false, openMode: mode, categories: [],
    onOpen: (id, override) => setOpened(current => ({ count: current.count + 1, id, mode: override ?? mode })),
    onRowAction: (_row, action) => setAction(action), onRenameEntry: async () => unexpected(),
    onFolderError: unexpected, onMoveEntry: unexpected,
  };
  return <Theme><TooltipProvider>
    <output data-testid="opened">{JSON.stringify(opened)}</output>
    <output data-testid="action">{action}</output>
    <ul style={{ width: 360, display: "grid", gap: 32 }}>
      <ContentRow row={{ ...row, id: "tree", title: "目录文章" }} actions={actions} draggable />
      <ContentRow row={{ ...row, id: "pinned", title: "置顶文章" }} actions={actions} pinned />
      <ContentRow row={{ ...row, id: "detail", title: "导入文章" }} actions={actions} detail />
      <ContentRow row={{ ...row, id: "search", title: "搜索文章" }} actions={actions}
        search={{ toggle: <button type="button" onClick={() => setAction("toggle")}>展开匹配</button>, count: 1, results: null }} />
      <ContentRow row={{ ...row, id: "timeline", title: "时间流文章" }} actions={actions}
        timeline={{ id: "timeline-open", content: () => <p>时间流文章</p> }} />
    </ul>
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
