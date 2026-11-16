import { useDeferredValue, useMemo, useRef, useSyncExternalStore } from "react";
import { Spinner } from "@radix-ui/themes";
import { Copy, Eye, Focus, ListFilter, PencilLine, Settings, Sparkles, Trash2 } from "lucide-react";
import type { SaveQueue } from "../editor/save-queue";
import { commandKey } from "../labels";
import { Tool, Tooltip } from "../ui";
import type { DocumentActions } from "./Document";

export function StatusBar({ queue, actions, trashActive, settingsOpen, onPalette, onTrash, onSettings }: {
  queue?: SaveQueue;
  actions: Pick<DocumentActions, "mode" | "setMode" | "focusMode" | "onFocusMode" | "reading" | "aiOpen" | "onAi" | "publishing" | "onCopyWechat">;
  trashActive: boolean;
  settingsOpen: boolean;
  onPalette: (trigger: HTMLButtonElement) => void;
  onTrash: () => void;
  onSettings: (trigger: HTMLButtonElement) => void;
}) {
  const commandButton = useRef<HTMLButtonElement>(null);
  const previewing = actions.mode === "preview";
  const canCopy = queue?.entry.deletedAt === null;

  return <footer className="status-bar" aria-label="工作区状态栏">
    {!actions.focusMode && <div className="button-strip">
      <Tooltip content={`命令面板（${commandKey}K）`}>
        <button ref={commandButton} className="plain-button status-button status-command" type="button"
          aria-label="命令面板" aria-haspopup="dialog" onClick={event => onPalette(event.currentTarget)}>
          <ListFilter size={15} /><span className="status-command-label">命令面板</span>
        </button>
      </Tooltip>
      <Tool label="回收站" className="chrome-icon" aria-current={trashActive ? "page" : undefined} onClick={onTrash}>
        <Trash2 size={15} strokeWidth={1.65} />
      </Tool>
    </div>}

    <div className="status-bar-right">
      {queue && <DocumentStatus key={queue.sessionId} queue={queue} reading={actions.reading} />}
      {actions.focusMode ? <div className="button-strip">
        <button className="plain-button status-button" type="button" onClick={() => {
          actions.onFocusMode();
          requestAnimationFrame(() => commandButton.current?.focus());
        }}><Focus size={15} />退出专注写作</button>
      </div> : <>
        {queue && (!actions.reading || canCopy) && <div className="button-strip">
          {!actions.reading && <button className="plain-button status-button" type="button"
            onClick={() => actions.setMode(previewing ? "edit" : "preview")}>
            {previewing ? <><PencilLine size={15} />继续编辑</> : <><Eye size={15} />预览排版</>}
          </button>}
          {canCopy && <button className="plain-button status-button" type="button" aria-disabled={actions.publishing}
            onClick={actions.onCopyWechat}>
            {actions.publishing ? <Spinner size="1" /> : <Copy size={15} />}
            复制公众号格式
          </button>}
        </div>}
        <div className="button-strip">
          {!actions.reading && <Tool label="AI 助手" id="ai-panel-trigger" className="chrome-icon"
            aria-expanded={actions.aiOpen} onClick={actions.onAi}><Sparkles size={15} strokeWidth={1.65} /></Tool>}
          <Tool label="设置" className="chrome-icon" aria-haspopup="dialog" aria-expanded={settingsOpen}
            onClick={event => onSettings(event.currentTarget)}><Settings size={16} strokeWidth={1.65} /></Tool>
        </div>
      </>}
    </div>
  </footer>;
}

function DocumentStatus({ queue, reading }: { queue: SaveQueue; reading: boolean }) {
  const { fields, error, revision, savedRevision, saving } = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const wordSource = useDeferredValue(fields.contentMd);
  const count = useMemo(() => Array.from(wordSource.replace(/\s/g, "")).length.toLocaleString("zh-CN"), [wordSource]);
  return <div className="document-status" role="group" aria-label="文章状态">
    {reading && <span>只读</span>}
    <span role="status" className={error ? "status-error" : undefined}>
      {error ? "保存失败" : queue.entry.deletedAt !== null ? "已移入回收站" : saving ? "保存中…" : revision === savedRevision ? "已保存" : "未保存"}
    </span>
    <span>{count} 字</span>
  </div>;
}
