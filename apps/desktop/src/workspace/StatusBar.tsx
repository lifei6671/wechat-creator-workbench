import { useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Spinner } from "@radix-ui/themes";
import { CloudUpload, Copy, DatabaseBackup, Eye, Focus, ListFilter, PencilLine, Plug, Settings, Trash } from "lucide-react";
import { desktop, type SyncActivity, type SyncBinding, type UploadProgress } from "../desktop";
import type { SaveQueue } from "../editor/save-queue";
import { commandKey } from "../labels";
import { Tool, Tooltip } from "../ui";
import type { DocumentActions } from "./Document";
import { getSyncStatus, SyncStatus } from "./SyncStatus";
import { ActionError } from "../button-feedback";

export function StatusBar({ queue, actions, trashActive, settingsOpen, mcpRunning, mcpError, backupProgress, migrationProgress,
  imageStorageEnabled, assetRevision, imageUpload, syncBinding, syncActivity, syncError, syncWaitingReason, onSync, onError, onMcp, onPalette, onTrash, onSettings }: {
  queue?: SaveQueue;
  actions: Pick<DocumentActions, "mode" | "setMode" | "focusMode" | "onFocusMode" | "reading" | "publishing" | "onCopyWechat" | "feedback" | "shortcutLabels">;
  trashActive: boolean;
  settingsOpen: boolean;
  mcpRunning?: boolean;
  mcpError?: string;
  backupProgress: string | null;
  migrationProgress: "export" | "import" | null;
  imageStorageEnabled: boolean;
  assetRevision: number;
  imageUpload: UploadProgress | null;
  syncBinding: SyncBinding | null | undefined;
  syncActivity: SyncActivity | null | undefined;
  syncError: string;
  syncWaitingReason?: string;
  onSync(trigger: HTMLButtonElement): void;
  onError(error: unknown): void;
  onMcp(trigger: HTMLButtonElement): void;
  onPalette: (trigger: HTMLButtonElement) => void;
  onTrash: () => void;
  onSettings: (trigger: HTMLButtonElement) => void;
}) {
  const commandButton = useRef<HTMLButtonElement>(null);
  const previewing = actions.mode === "preview";
  const paletteShortcut = actions.shortcutLabels ? actions.shortcutLabels.palette : `${commandKey}K`;
  const canCopy = queue?.entry.deletedAt === null;
  const backup = backupProgress ?? (migrationProgress === "export" ? "正在导出工作区…" : migrationProgress === "import" ? "正在导入工作区…" : null);
  const mcpLabel = mcpError ? "MCP 状态异常" : mcpRunning === undefined ? "正在读取 MCP 状态" : mcpRunning ? "MCP（运行中）" : "MCP（未运行）";
  const mcpDetail = mcpError ? `${mcpLabel}：${mcpError}` : mcpLabel;
  const mcpState = mcpError ? "error" : mcpRunning === undefined ? "unknown" : mcpRunning ? "success" : "error";
  const syncProps = { binding: syncBinding, activity: syncActivity, error: syncError, waitingReason: syncWaitingReason };
  const sync = getSyncStatus(syncProps);

  return <footer className="status-bar" aria-label="工作区状态栏">
    {!actions.focusMode && <div className="button-strip">
      <Tooltip content={paletteShortcut ? `命令面板（${paletteShortcut}）` : "命令面板"}>
        <button ref={commandButton} className="plain-button status-button status-command" type="button"
          aria-label="命令面板" aria-haspopup="dialog" onClick={event => onPalette(event.currentTarget)}>
          <ListFilter size={15} /><span className="status-command-label">命令面板</span>
        </button>
      </Tooltip>
      <Tool label="回收站" className="chrome-icon" aria-current={trashActive ? "page" : undefined} onClick={onTrash}>
        <Trash size={16} strokeWidth={1.8} />
      </Tool>
      <Tooltip content={mcpDetail}><button type="button" className="plain-button status-button status-icon-button status-mcp"
        aria-label={mcpDetail} aria-haspopup="dialog" onClick={event => onMcp(event.currentTarget)}>
        <span className="status-indicator"><Plug size={15} aria-hidden="true" />
          <span className="status-dot" data-state={mcpState} aria-hidden="true" /></span>
      </button></Tooltip>
    </div>}
    <Tooltip content={sync.detail}><button type="button" className="plain-button status-button status-icon-button status-sync"
      aria-label={`同步设置：${sync.label}`} aria-haspopup="dialog" onClick={event => onSync(event.currentTarget)}>
      <SyncStatus {...syncProps} compact />
    </button></Tooltip>
    {backup && <Tooltip content={backup}><span className="background-status" role="status" aria-label={backup}>
      <span className="background-status-icon" aria-hidden="true"><DatabaseBackup size={15} /></span>
      <span className="background-status-label">{backup}</span>
    </span></Tooltip>}

    <ActionError className="status-action-feedback" error={actions.feedback?.error()} />
    <div className="status-bar-right">
      {queue && <DocumentStatus key={queue.sessionId} queue={queue} reading={actions.reading} imageStorageEnabled={imageStorageEnabled}
        assetRevision={assetRevision} imageUpload={imageUpload} onError={onError} />}
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
          {canCopy && <button className="plain-button status-button" type="button" disabled={actions.publishing}
            {...actions.feedback?.props("copyWechat", actions.publishing)}
            onClick={actions.onCopyWechat}>
            <span className="status-copy-icon" aria-hidden="true">
              {actions.feedback ? actions.feedback.icon("copyWechat", <Copy size={15} />, 15)
                : actions.publishing ? <Spinner size="1" /> : <Copy size={15} />}
            </span>
            {actions.feedback ? actions.feedback.label("copyWechat", "复制公众号格式", "已复制", "复制失败") : "复制公众号格式"}
          </button>}
        </div>}
        <div className="button-strip">
          <Tool label="设置" className="chrome-icon" aria-haspopup="dialog" aria-expanded={settingsOpen}
            onClick={event => onSettings(event.currentTarget)}><Settings size={16} strokeWidth={1.65} /></Tool>
        </div>
      </>}
    </div>
  </footer>;
}

function DocumentStatus({ queue, reading, imageStorageEnabled, assetRevision, imageUpload, onError }: {
  queue: SaveQueue; reading: boolean; imageStorageEnabled: boolean; assetRevision: number; imageUpload: UploadProgress | null;
  onError(error: unknown): void;
}) {
  const fields = useSyncExternalStore(queue.subscribe, queue.snapshotFields);
  const dirty = useSyncExternalStore(queue.subscribe, queue.isDirty);
  const saving = useSyncExternalStore(queue.subscribe, queue.isSaving);
  const error = useSyncExternalStore(queue.subscribe, queue.saveError);
  const wordSource = useDeferredValue(fields.contentMd);
  const count = useMemo(() => Array.from(wordSource.replace(/\s/g, "")).length.toLocaleString("zh-CN"), [wordSource]);
  const [backgroundUpload, setBackgroundUpload] = useState<UploadProgress | null>(null);
  const report = useEffectEvent(onError);
  const canTrack = imageStorageEnabled && queue.entry.deletedAt === null;
  useEffect(() => {
    if (!canTrack) return;
    let current = true;
    const timer = setTimeout(() => {
      void desktop.imageUploadProgress(wordSource).then(progress => {
        if (current) setBackgroundUpload(progress);
      }, error => {
        if (!current) return;
        setBackgroundUpload(null);
        report(error);
      });
    }, 120);
    return () => { current = false; clearTimeout(timer); };
  }, [canTrack, wordSource, assetRevision]);
  const upload = imageUpload ?? (canTrack ? backgroundUpload : null);
  return <div className="document-status" role="group" aria-label="文章状态">
    {upload && upload.total > 0 && <Tooltip content={`图片上传 ${upload.completed}/${upload.total}`}>
      <span className="background-status" role="status" aria-label={`图片上传 ${upload.completed}/${upload.total}`}>
        <span className="background-status-icon" aria-hidden="true"><CloudUpload size={15} /></span>
        {upload.completed}/{upload.total}
      </span>
    </Tooltip>}
    {reading && <span>只读</span>}
    <span role="status" className={error ? "status-error" : undefined}>
      {error ? "保存失败" : queue.entry.deletedAt !== null ? "已移入回收站" : saving ? "保存中…" : dirty ? "未保存" : "已保存"}
    </span>
    <span>{count} 字</span>
  </div>;
}
