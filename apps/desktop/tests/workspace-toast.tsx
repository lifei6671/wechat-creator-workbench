import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import "../src/styles/settings.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { WorkspaceToast, type Notice } from "../src/workspace/WorkspaceToast";

const query = new URLSearchParams(location.search);
const type = (query.get("tone") ?? "error") as Notice["type"];
const messages = { error: "图片上传失败，请检查网络后重试", success: "工作区已恢复", warning: "部分图片未能下载，已保留原链接", info: "正在使用本地工作区" };
const notice: Notice = { type, text: query.has("long") ? messages[type].repeat(8) : messages[type] };
function Fixture() {
  const [visible, setVisible] = useState(true);
  const toast = visible && <WorkspaceToast notice={notice} onDismiss={() => setVisible(false)} />;
  return <Theme className="theme-root" appearance={query.get("appearance") === "dark" ? "dark" : "light"}><TooltipProvider>
    <header style={{ height: 40, background: "var(--sand-3)", padding: "10px 16px" }}>微信创作工作台</header>
    {query.has("dialog") ? <Dialog.Root open><Dialog.Content className="settings-dialog" aria-describedby={undefined}>
      <Dialog.Title>设置</Dialog.Title>{toast}
    </Dialog.Content></Dialog.Root> : <main style={{ position: "relative", margin: 80, width: "60%", height: 300, overflow: "hidden" }}>{toast}</main>}
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
