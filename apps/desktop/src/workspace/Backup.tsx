import { useEffect, useState, type FormEvent } from "react";
import { Button, Select } from "@radix-ui/themes";
import { readS3Settings, S3Fields, SettingRow } from "./Settings";
import { desktop, errorMessage, type BackupSettings, type BackupSnapshot, type BackupStage } from "../desktop";

export const backupProgress: Record<BackupStage, string> = {
  snapshot: "正在生成数据库快照…", upload: "正在上传备份…", download: "正在下载备份…", validate: "正在校验备份…",
};

const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" });
const sizeFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
export const backupDate = (timestamp: number) => dateFormat.format(timestamp);
export type PreparedBackup = { ticket: string; snapshot: BackupSnapshot; workspaceLabel: string; migration?: false };

export function BackupPanel({ busy, progress, feedback, listRevision, prepared, onCreate, onRestore, onConfirmRestore, onDiscardRestore }: {
  busy: boolean;
  progress: string;
  feedback: { error: boolean; text: string } | null;
  listRevision: number;
  prepared: PreparedBackup | null;
  onCreate(): Promise<void>;
  onRestore(workspace: string, snapshot: BackupSnapshot, workspaceLabel: string): Promise<void>;
  onConfirmRestore(): void;
  onDiscardRestore(): void;
}) {
  const [settings, setSettings] = useState<BackupSettings>();
  const [remote, setRemote] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [listing, setListing] = useState<{ workspace: string; items?: BackupSnapshot[]; error?: string }>();
  const [settingsError, setSettingsError] = useState("");
  const [workspacesError, setWorkspacesError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [configuring, setConfiguring] = useState(false);
  const current = settings?.currentWorkspace;
  const configured = Boolean(settings?.target && settings.hasKey);
  const workspace = selected && (selected === current || remote.includes(selected)) ? selected : current;
  const activeList = listing?.workspace === workspace ? listing : undefined;
  const items = activeList?.items;
  const listError = activeList?.error;

  useEffect(() => {
    let live = true;
    void desktop.backupSettings().then(value => { if (live) { setSettings(value); setSettingsError(""); } },
      failure => { if (live) setSettingsError(errorMessage(failure)); });
    return () => { live = false; };
  }, [refresh]);

  useEffect(() => {
    if (!configured) return;
    let live = true;
    void desktop.backupWorkspaces().then(value => { if (live) { setRemote(value); setWorkspacesError(""); } },
      failure => { if (live) setWorkspacesError(errorMessage(failure)); });
    return () => { live = false; };
  }, [configured, listRevision, refresh]);

  useEffect(() => {
    if (!configured || !workspace) return;
    let live = true;
    void desktop.backupList(workspace).then(value => { if (live) setListing({ workspace, items: value }); },
      failure => { if (live) setListing({ workspace, error: errorMessage(failure) }); });
    return () => { live = false; };
  }, [configured, workspace, listRevision, refresh]);

  const error = settingsError || workspacesError || listError;
  function returnToBackups() {
    setConfiguring(false);
    requestAnimationFrame(() => (document.getElementById("configure-backup") ?? document.getElementById("settings-backups"))?.focus());
  }
  if (configuring && settings) return <BackupStorageSettings initial={settings} onCancel={returnToBackups} onSaved={() => {
    setSettings(undefined); setRemote([]); setSelected(undefined); setListing(undefined); setWorkspacesError("");
    setRefresh(value => value + 1);
    returnToBackups();
  }} />;

  return <>
    <div className="settings-card">
      {!settings && !error && <p className="settings-feedback muted-text" role="status">正在读取设置…</p>}
      {settings && <SettingRow label="备份桶" hint={configured ? `数据库快照存放在 ${settings.target?.bucket}。`
        : settings.target ? "重新填写访问密钥后即可读写数据库快照。" : "配置用于保存和读取数据库快照的存储桶。"}>
        {hintId => <Button id="configure-backup" aria-describedby={hintId} size="2" color="gray" variant="soft" disabled={busy} onClick={() => {
          setConfiguring(true);
          requestAnimationFrame(() => document.getElementById("backup-endpoint")?.focus());
        }}>{configured ? "修改配置" : "配置备份桶"}</Button>}
      </SettingRow>}
      {configured && <SettingRow label="备份当前工作区" hint="上传当前数据库快照，每个工作区保留最近 5 份。">
        {hintId => <Button size="2" aria-describedby={hintId} disabled={busy} onClick={() => { void onCreate(); }}>立即备份</Button>}
      </SettingRow>}
      {progress && <p className="settings-feedback muted-text" role="status">{progress}</p>}
      {feedback && !progress && <p className={`settings-feedback ${feedback.error ? "inline-error" : "muted-text"}`}
        role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
      {error && <div className="settings-feedback backup-feedback">
        <p className="inline-error" role="alert">{error}</p>
        <Button size="1" variant="ghost" onClick={() => setRefresh(value => value + 1)}>重试读取</Button>
      </div>}
      {prepared && <SettingRow label="已校验的备份"
        hint={`${prepared.workspaceLabel} ${backupDate(prepared.snapshot.createdAt)}`}
        warning="恢复将用此备份替换当前工作区的数据库。">
        {hintId => <div className="button-strip setting-actions">
          <Button id="backup-restore-trigger" aria-describedby={hintId} size="1" variant="soft" disabled={busy} onClick={onConfirmRestore}>确认恢复</Button>
          <Button size="1" variant="ghost" color="gray" disabled={busy} onClick={onDiscardRestore}>取消</Button>
        </div>}
      </SettingRow>}
    </div>
      {configured && workspace && <>
        <div className="settings-group-title">备份列表</div>
        <div className="settings-card">
        <SettingRow id="backup-workspace" label="工作区" hint="选择要查看备份的工作区。">
          {hintId => <Select.Root value={workspace} onValueChange={setSelected}>
            <Select.Trigger id="backup-workspace" aria-describedby={hintId} />
            <Select.Content>
              <Select.Item value={current!}>当前工作区</Select.Item>
              {remote.filter(id => id !== current).map(id => <Select.Item key={id} value={id} title={id}>{id}</Select.Item>)}
            </Select.Content>
          </Select.Root>}
        </SettingRow>
        {!listError && !items && <p className="settings-feedback muted-text" role="status">正在读取备份…</p>}
        {items?.length === 0 && <p className="settings-feedback muted-text">此工作区暂无备份</p>}
        {!!items?.length && <ul className="backup-list" aria-label="备份列表">{items.map(item => <li key={item.name}>
          <div className="backup-item-detail">
            <time dateTime={new Date(item.createdAt).toISOString()}>{backupDate(item.createdAt)}</time>
            <span className="muted-text">{sizeFormat.format(item.bytes / 1024)} KB</span>
          </div>
          <Button size="1" variant="soft" color="gray" aria-label={`准备恢复 ${backupDate(item.createdAt)} 的备份`} disabled={busy}
            onClick={() => { void onRestore(workspace, item, workspace === current ? "当前工作区" : workspace); }}>准备恢复</Button>
        </li>)}</ul>}
        </div>
      </>}
  </>;
}

function BackupStorageSettings({ initial, onCancel, onSaved }: {
  initial: BackupSettings;
  onCancel(): void;
  onSaved(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function reuse() {
    setBusy(true);
    setError("");
    try { await desktop.backupUseImageStorage(); onSaved(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { target, secret } = readS3Settings(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    try {
      await desktop.configureBackup(target, secret);
      onSaved();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <form className="settings-card" autoComplete="off" onSubmit={event => void submit(event)}>
    <S3Fields scope="backup" initial={initial.target} hasKey={initial.hasKey} />
    {error && <p role="alert" className="settings-feedback inline-error">{error}</p>}
    <div className="settings-footer">
      <Button type="button" variant="soft" disabled={busy} onClick={() => void reuse()}>复用 S3 图床配置</Button>
      <Button type="button" variant="soft" color="gray" disabled={busy} onClick={onCancel}>取消</Button>
      <Button type="submit" loading={busy}>保存</Button>
    </div>
  </form>;
}
