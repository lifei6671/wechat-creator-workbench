import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import "../src/styles/settings.css";
import { desktop } from "../src/desktop";
import { SyncSettings } from "../src/workspace/SyncSettings";

let binding = { url: "https://original.example.test/", instanceId: "instance", epoch: "epoch", deviceId: "device", paused: false };
desktop.syncStatus = async () => binding;
desktop.syncActivity = async () => null;
desktop.syncConflicts = async () => [];
desktop.syncDevices = async () => ({ currentDeviceId: "device", devices: [] });
desktop.onSyncStatusChanged = async () => () => {};
let complete: (success: boolean) => void;
declare global { interface Window { finishAddressChange(success: boolean): void } }
window.finishAddressChange = success => complete(success);
desktop.syncChangeUrl = url => new Promise((resolve, reject) => {
  complete = success => {
    if (!success) reject({ code: "SYNC_ADDRESS_IDENTITY", message: "新地址不属于当前同步服务，未修改服务地址" });
    else { binding = { ...binding, url: new URL(url).href }; resolve(binding); }
  };
});
createRoot(document.getElementById("root")!).render(
  <Theme appearance={new URLSearchParams(location.search).has("dark") ? "dark" : "light"} accentColor="indigo" grayColor="slate" scaling="95%">
    <div className="workspace-shell" style={{ minHeight: "100vh", display: "block", padding: 16 }}>
      <div className="settings-pages" style={{ maxWidth: 760, margin: "auto" }}>
        <SyncSettings onSync={async () => undefined} onResolve={async () => {}} onRebuild={async () => ""} />
      </div>
    </div>
  </Theme>,
);
