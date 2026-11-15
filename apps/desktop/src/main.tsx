import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "./styles/tokens.css";
import "./styles/desktop-shell.css";
import "./styles/settings.css";
import "./styles/menus.css";
import { DesktopShell } from "./workspace/DesktopShell";

document.addEventListener("contextmenu", event => event.preventDefault());
createRoot(document.getElementById("root")!).render(<DesktopShell />);
