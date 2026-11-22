import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { Entry, EntryFields } from "../../../packages/shared-types";
import { SaveQueue } from "../src/editor/save-queue";
import { PropertiesDialog } from "../src/workspace/Dialogs";

const entry: Entry = { id: "properties-fixture", kind: "article", title: "示例文章", contentMd: "正文", status: "draft", categoryId: null,
  tags: ["写作"], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, createdAt: 0, updatedAt: 0, deletedAt: null, links: [] };

function Fixture() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<{ version: number; fields: EntryFields }>({ version: 1, fields: entry });
  const fail = useRef(new URLSearchParams(location.search).get("failure") === "once");
  const [queue] = useState(() => new SaveQueue(entry, async (_id, version, fields) => {
    if (fail.current) { fail.current = false; throw new Error("模拟保存失败"); }
    const next = { version: version + 1, fields }; setSaved(next); return { version: next.version };
  }, () => {}));
  return <Theme><TooltipProvider>
    <output data-testid="saved" hidden>{JSON.stringify(saved)}</output>
    <button type="button" onClick={() => setOpen(true)}>内容属性</button>
    {open && <PropertiesDialog id={entry.id} queue={queue} locked={false} categories={[]} tagSuggestions={["写作", "工具"]}
      onClose={() => setOpen(false)} onOpen={() => { throw new Error("Unexpected navigation"); }}
      onSave={async (_, change) => { queue.edit(change); if (!await queue.flush({ retry: true })) throw queue.saveError(); }} />}
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
