import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Popover, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import "../src/styles/desktop-shell.css";
import { TooltipProvider } from "../../../packages/ui-react/Tooltip";
import type { CanvasCardColor, Category, CategoryIcon, EntryRow } from "../../../packages/shared-types";
import { FolderInline } from "../src/workspace/FolderInline";
import { ColorChoices } from "../src/workspace/ColorChoices";
import { Explorer } from "../src/workspace/Explorer";
import { desktop } from "../src/desktop";

const entry: EntryRow = { id: "fixture-entry", kind: "article", title: "目录内笔记", status: "draft", updatedAt: 0, deletedAt: null, categoryId: "folder" };
const child: Category = { id: "child-folder", parentId: "folder", name: "嵌套目录", sortOrder: 0, icon: "book", iconColor: "green" };
desktop.entries = async filter => ({ items: filter.categoryId === "folder" && !filter.pinned ? [entry] : [], nextOffset: null });
const unexpected = () => { throw new Error("Unexpected fixture action"); };

function Fixture() {
  const [folder, setFolder] = useState<Category>({ id: "folder", parentId: null, name: "目录", sortOrder: 0, icon: "folder", iconColor: "blue" });
  const [editing, setEditing] = useState(!new URLSearchParams(location.search).has("section"));
  const [calls, setCalls] = useState(0);
  const [canvasColor, setCanvasColor] = useState<CanvasCardColor | null>(null);
  const [paletteRevision, setPaletteRevision] = useState(0);
  const [explorerRevision, setExplorerRevision] = useState(0);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [finish, setFinish] = useState<(() => void) | null>(null);
  const failure = new URLSearchParams(location.search).has("fail");
  const section = new URLSearchParams(location.search).get("section") === "timeline" ? "timeline" : "folders";
  const appearance = new URLSearchParams(location.search).get("appearance") === "dark" ? "dark" : "light";
  const saveFolder = (name: string, icon: CategoryIcon, iconColor: CanvasCardColor | null) => {
    setCalls(value => value + 1);
    return new Promise<void>((resolve, reject) => setFinish(() => () => {
      if (failure) reject(new Error("保存颜色失败"));
      else { setFolder(current => ({ ...current, name, icon, iconColor })); resolve(); }
    }));
  };
  return <Theme appearance={appearance}><TooltipProvider>
    <Popover.Root>
      <Popover.Trigger><button>画布配色</button></Popover.Trigger>
      <Popover.Content aria-label="画布颜色"><ColorChoices value={canvasColor} onChange={setCanvasColor} closeOnSelect />
        <button onClick={() => setPaletteRevision(value => value + 1)}>刷新调色板 {paletteRevision}</button>
      </Popover.Content>
    </Popover.Root>
    <output data-testid="canvas-color">{canvasColor ?? "null"}</output>
    <button onClick={() => setEditing(true)}>编辑目录</button>
    <button disabled={!finish} onClick={() => { finish!(); setFinish(null); }}>完成保存</button>
    <button onClick={() => setExplorerRevision(value => value + 1)}>重新加载目录</button>
    <output data-testid="calls">{calls}</output>
    <output data-testid="saved">{JSON.stringify(folder)}</output>
    {editing && <FolderInline target={folder} defaultName="未命名" onClose={() => setEditing(false)}
      onError={unexpected} onSave={saveFolder} />}
    <Explorer key={explorerRevision} section={section} active={null} openMode="current" readOnlyIds={[]} treeLocked={false}
      library={{ workspaceId: "fixture", categories: [folder, child], tags: [], tagSuggestions: [] }} page={null}
      expanded={expanded} revision={0} loading="all" pageSize={60} caseSensitive={false} query="" searchInputRef={null}
      listError="" onRetry={unexpected} onQuery={unexpected} onCaseSensitive={unexpected}
      onFolder={id => setExpanded(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])}
      onCreate={unexpected} onImportLink={unexpected} onImportMarkdown={unexpected} onRevealFolder={unexpected}
      onSaveFolder={(_id, _parent, name, icon, color) => saveFolder(name, icon, color)} onFolderError={unexpected}
      onReorderFolder={unexpected} onReorderEntry={unexpected} onRenameEntry={unexpected} onMoveEntry={unexpected}
      onCategoryAction={unexpected} onOpen={unexpected} onRowAction={unexpected} onMore={unexpected} />
  </TooltipProvider></Theme>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
