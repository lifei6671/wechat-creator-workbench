import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { SyncActivity, SyncBinding } from "../src/desktop";
import { StatusBar } from "../src/workspace/StatusBar";

const binding: SyncBinding = { url: "https://sync.example", instanceId: "instance", epoch: "epoch", deviceId: "device", paused: false };
const activity: SyncActivity = { hasLocalContent: true, initialized: true, pending: false, incoming: false, issues: 0,
  phase: "idle", error: null, lastExchangeAt: 1 };
const noop = () => {};
function Fixture() {
  const [mcp, setMcp] = useState("running");
  const [sync, setSync] = useState("healthy");
  const [clicked, setClicked] = useState("");
  const next = { ...activity };
  let nextBinding: SyncBinding | null | undefined = binding;
  let error = "";
  if (["connecting", "downloading", "merging", "syncing", "waiting_seed"].includes(sync)) next.phase = sync as SyncActivity["phase"];
  if (sync === "pending") next.pending = true;
  if (sync === "incoming") next.incoming = true;
  if (sync === "issues") next.issues = 1;
  if (sync === "paused") nextBinding = { ...binding, paused: true };
  if (sync === "unconnected") nextBinding = null;
  if (sync === "reading" || sync === "read-error") nextBinding = undefined;
  if (sync === "first") next.lastExchangeAt = null;
  if (sync === "error") next.error = { code: "NETWORK", message: "网络连接失败" };
  if (sync === "credential") next.error = { code: "SYNC_CREDENTIAL", message: "凭据失效" };
  if (sync === "read-error") error = "状态读取失败";
  return <Theme appearance={new URLSearchParams(location.search).get("appearance") === "dark" ? "dark" : "light"}>
    <TooltipProvider><div style={{ minHeight: "100vh", paddingTop: 120 }}>
      <label>MCP 场景<select aria-label="MCP 场景" value={mcp} onChange={e => setMcp(e.target.value)}>
        {["running", "stopped", "unknown", "error"].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>同步场景<select aria-label="同步场景" value={sync} onChange={e => setSync(e.target.value)}>
        {["healthy", "connecting", "downloading", "merging", "syncing", "pending", "incoming", "issues", "paused", "unconnected", "reading", "first", "waiting_seed", "error", "credential", "read-error"].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <output data-testid="clicked">{clicked}</output>
      <StatusBar actions={{ mode: "edit", setMode: noop, focusMode: false, onFocusMode: noop, reading: false, publishing: false, onCopyWechat: noop }}
        trashActive={false} settingsOpen={false} mcpRunning={mcp === "unknown" ? undefined : mcp === "running"}
        mcpError={mcp === "error" ? "服务读取失败" : undefined} backupProgress={null} migrationProgress={null}
        imageStorageEnabled={false} assetRevision={0} imageUpload={null} syncBinding={nextBinding} syncActivity={next}
        syncError={error} syncWaitingReason="等待结束编辑" onSync={button => setClicked(button.classList.contains("status-sync") ? "sync" : "wrong")}
        onMcp={button => setClicked(button.classList.contains("status-mcp") ? "mcp" : "wrong")}
        onPalette={noop} onTrash={noop} onSettings={noop} onError={noop} />
    </div></TooltipProvider>
  </Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
