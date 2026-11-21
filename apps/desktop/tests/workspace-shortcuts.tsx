import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/settings.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { WorkspaceSettings } from "../src/workspace/Settings";
import { readWorkspaceShortcuts } from "../src/workspace/workspace-shortcuts";
import { defaultViewShortcut, type ViewShortcut } from "../src/workspace/view-shortcut";
import { useStoredInitial } from "../src/ui";

const unexpected = () => { throw new Error("Unexpected fixture action"); };
function Fixture() {
  const [bindings, setBindings] = useState(readWorkspaceShortcuts);
  const [view, setView] = useState(() => useStoredInitial<ViewShortcut>("view-shortcut", defaultViewShortcut()));
  return <Theme><TooltipProvider><div style={{ height: "100vh", overflow: "auto", padding: 24, boxSizing: "border-box" }}>
    <div style={{ maxWidth: 760 }}><WorkspaceSettings page="shortcuts" appearance="light" shortcut={view} workspaceShortcuts={bindings}
      preferredView="edit" explorer downloadPastedImages convertLinks defaultOutline documentOpenMode="current" folderLoading="all" folderPageSize={60}
      onAppearance={unexpected} onShortcut={value => { setView(value); localStorage.setItem("view-shortcut", JSON.stringify(value)); }}
      onView={unexpected} onExplorer={unexpected} onDownloadPastedImages={unexpected}
      onConvertLinks={unexpected} onDefaultOutline={unexpected} onDocumentOpenMode={unexpected} onFolderLoading={unexpected} onFolderPageSize={unexpected}
      onWorkspaceShortcut={(id, value) => { const next = { ...bindings, [id]: value }; setBindings(next); localStorage.setItem("workspace-shortcuts", JSON.stringify(next)); }} />
    </div>
  </div></TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
