import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "./styles/tokens.css";
import "./styles/desktop-shell.css";
import "./styles/settings.css";
import "./styles/menus.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { DesktopShell } from "./workspace/DesktopShell";
import { desktop } from "./desktop";
import { restoreWorkspacePreferences } from "./workspace/preferences";

document.addEventListener("contextmenu", event => event.preventDefault());
void desktop.takeMigratedPreferences().then(restoreWorkspacePreferences, () => {}).finally(() => {
  createRoot(document.getElementById("root")!, {
    onUncaughtError(error, info) { console.error("Workspace render failed", error, info.componentStack); },
  }).render(<TooltipProvider><DesktopShell /></TooltipProvider>);
});
