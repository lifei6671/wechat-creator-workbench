import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import { renderWechat, wechatThemes, type RenderInput, type SourceFragment } from "../../../packages/wechat-renderer";
import { MarkdownPreview } from "../src/workspace/Document";
import { desktop } from "../src/desktop";
import fixture from "../../../fixtures/morandi-theme.md?raw";

const parameters = new URLSearchParams(location.search);
const original = fixture.replaceAll("\r\n", "\n");
const source = original + (parameters.has("long") ? Array.from({ length: 400 }, (_, index) => `\n\n段落 ${index}：长文章保持内容和颜色继承。Technology writing stays readable.`).join("") : "");
const line = source.split("\n").findIndex(line => line === "```mermaid");
const graphicSources: SourceFragment[] = [{ kind: "mermaid", line, source: "flowchart LR\n  A[Markdown] --> B[内联样式]\n  B --> C[公众号]" }];
let graphicRequests = 0;
desktop.wechatGraphics = async () => { graphicRequests++; return graphicSources; };
desktop.onAssetsChanged = async () => () => {};
desktop.assetRead = async () => {
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 240;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f4f3f0"; context.fillRect(0, 0, 640, 240);
  context.strokeStyle = "#849aa9"; context.strokeRect(16, 16, 608, 208);
  context.fillStyle = "#25272a"; context.font = "20px sans-serif"; context.fillText("Markdown → HTML → WeChat", 28, 120);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
  return blob.arrayBuffer();
};
declare global { interface Window {
  morandiTest: {
    setAppearance(value: "light" | "dark"): void;
    setTheme(value: string): void;
    export(output: RenderInput["output"]): Promise<string>;
    source: string;
    graphicRequests(): number;
  };
} }
function Fixture() {
  const [appearance, setAppearance] = useState<"light" | "dark">(parameters.get("appearance") === "dark" ? "dark" : "light");
  const [themeId, setTheme] = useState("morandi");
  window.morandiTest = {
    source,
    graphicRequests: () => graphicRequests,
    setAppearance: value => flushSync(() => setAppearance(value)),
    setTheme: value => flushSync(() => setTheme(value)),
    async export(output) {
      const result = await renderWechat({ markdown: source, themeId, revision: 1, output }, {
        sources: async () => graphicSources,
        image: async () => ({ src: "https://images.test/morandi.png", width: 640, height: 240 }),
        derive: async () => "morandi-derived",
      });
      try { return result.html; } finally { result.dispose(); }
    },
  };
  return <Theme appearance={appearance} accentColor="indigo" grayColor="slate"><TooltipProvider>
    <select aria-label="选择测试主题" value={themeId} onChange={event => setTheme(event.target.value)}>
      {wechatThemes.map(theme => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
    </select>
    <div className="preview-stack" style={{ height: "calc(100vh - 32px)" }}>
      <MarkdownPreview title="莫兰迪技术文章" markdown={source} themeId={themeId} revision={1}
        onThemeChange={parameters.has("locked") ? undefined : setTheme} />
    </div>
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
