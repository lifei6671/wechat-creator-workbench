import { useSettingsButtonFeedback } from "./settings-button-feedback";
import { useEffect, useState } from "react";
import { AlertDialog, Button, Flex, TextArea, TextField } from "@radix-ui/themes";
import { ChevronRight } from "lucide-react";
import { desktop, errorMessage, type SyncActivity, type SyncBinding, type SyncConflict, type SyncDevice, type SyncDevices, type SyncResolution } from "../desktop";
import { SettingRow } from "./Settings";
import { SyncStatus } from "./SyncStatus";

const conflictLabels: Record<SyncConflict["entityType"], string> = {
  entry: "文稿冲突", category: "目录冲突", asset: "素材冲突",
  collection: "专题冲突", collection_node: "画布卡片冲突", collection_edge: "画布连线冲突", wechat_publication_defaults: "公众号默认设置冲突",
};

function canvasVersion(type: SyncConflict["entityType"], version: SyncConflict["local"], deleted: boolean) {
  if (deleted || !version) return "此项已删除";
  if (type === "wechat_publication_defaults") return `默认生成数量：${version.recommendationCount} 篇`;
  if (type === "collection") return `标题：${version.title}\n说明：${version.description}`;
  if (type === "collection_edge") return `连线文字：${version.label}\n起点：${version.sourceNodeId}\n终点：${version.targetNodeId}`;
  const kinds: Record<string, string> = { text: "文字", entry: "文章引用", image: "图片", web: "网页" };
  const colors: Record<string, string> = { red: "红色", orange: "橙色", amber: "琥珀色", green: "绿色", blue: "蓝色", violet: "紫色" };
  return [
    `卡片类型：${kinds[version.kind!]}`,
    version.kind === "text" ? `正文：\n${version.contentMd}` : undefined,
    version.kind === "entry" ? `文章：${version.entryId}` : undefined,
    version.kind === "image" ? `图片：${version.assetId}` : undefined,
    version.kind === "web" ? `网址：${version.externalUrl}` : undefined,
    `位置：${version.x}, ${version.y}`,
    `尺寸：${version.width} × ${version.height}`,
    `颜色：${version.customColor ?? (version.color ? colors[version.color] : "默认")}`,
  ].filter(line => line !== undefined).join("\n");
}

function credentialRejected(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "SYNC_CREDENTIAL" || error.code === "SYNC_REAUTH");
}

const pauseLabels: Record<string, string> = {
  backup_restored: "已恢复历史工作区，需要核对云端内容。",
  identity_changed: "同步服务身份已变化，需要核对目标服务。",
  history_inconsistent: "云端历史与本机记录不一致，已保留本地内容。",
  legacy_review: "原同步连接已暂停，需要核对云端内容。",
};

export function SyncSettings({ onSync, onResolve, onRebuild, automaticError, waitingReason, applicationBusy = false, onBusyChange }: {
  onSync(): Promise<string | undefined>;
  onResolve(type: SyncConflict["entityType"], id: string, choice: SyncResolution, remoteRevision: number, localGeneration: number): Promise<void>;
  onRebuild(): Promise<string>;
  automaticError?: string;
  waitingReason?: string;
  applicationBusy?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const [binding, setBinding] = useState<SyncBinding | null>();
  const [activity, setActivity] = useState<SyncActivity | null>();
  const [devices, setDevices] = useState<SyncDevices>();
  const [url, setUrl] = useState("");
  const [name, setName] = useState<string>();
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState<"connect" | "reauthorize" | "secret" | "info" | "access" | "recovery" | "recover" | "revoke" | "sync" | "resolve" | "rebuild" | "reveal">();
  const { start, finish, label: buttonLabel, props: buttonProps } = useSettingsButtonFeedback();
  const blocked = Boolean(busy) || applicationBusy;
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<SyncDevice>();
  const [recoveryArchive, setRecoveryArchive] = useState("");
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const showConnectionForm = binding === null || Boolean(binding && !binding.paused && needsReconnect);
  const showMergeNotice = showConnectionForm && activity?.hasLocalContent && !activity.initialized;

  useEffect(() => {
    let live = true;
    let request = 0;
    let deviceExchangeAt: number | null | undefined;
    async function refresh(loadDevices = false) {
      const current = ++request;
      try {
        const [saved, state, issues] = await Promise.all([desktop.syncStatus(), desktop.syncActivity(), desktop.syncConflicts()]);
        if (!live || current !== request) return;
        setBinding(saved);
        setActivity(state);
        setConflicts(issues);
        if (credentialRejected(state?.error)) setNeedsReconnect(true);
        const exchanged = state?.lastExchangeAt != null && state.lastExchangeAt !== deviceExchangeAt;
        if ((loadDevices || exchanged) && saved && !saved.paused && !credentialRejected(state?.error)) {
          const list = await desktop.syncDevices();
          if (live && current === request) { setDevices(list); deviceExchangeAt = state?.lastExchangeAt; }
        }
      } catch (failure) {
        if (!live || current !== request) return;
        setError(errorMessage(failure));
        if (credentialRejected(failure)) setNeedsReconnect(true);
      }
    }
    const refreshLocal = () => { void refresh(); };
    const refreshDevices = () => { if (document.visibilityState === "visible") void refresh(true); };
    const subscription = desktop.onSyncStatusChanged(refreshLocal);
    void subscription.then(() => refresh(true), failure => { if (live) setError(errorMessage(failure)); });
    window.addEventListener("focus", refreshDevices);
    document.addEventListener("visibilitychange", refreshDevices);
    return () => {
      live = false;
      void subscription.then(unlisten => unlisten(), () => {});
      window.removeEventListener("focus", refreshDevices);
      document.removeEventListener("visibilitychange", refreshDevices);
    };
  }, []);

  useEffect(() => {
    if (!showConnectionForm && !binding?.paused) return;
    let current = true;
    void desktop.syncDefaultDeviceName().then(defaultName => {
      if (current && defaultName) setName(edited => edited ?? defaultName);
    }, failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [showConnectionForm, binding?.paused]);

  async function perform(kind: NonNullable<typeof busy>, operation: () => Promise<void>, key: string = kind) {
    if (blocked) return;
    if (!start(key)) return;
    setBusy(kind);
    onBusyChange?.(true);
    setError("");
    try {
      await operation();
      finish(key, true);
    } catch (failure) {
      finish(key, false);
      setError(errorMessage(failure));
      if (credentialRejected(failure)) setNeedsReconnect(true);
    } finally {
      setBusy(undefined);
      onBusyChange?.(false);
    }
  }

  async function synchronize() {
    try {
      const archive = await onSync();
      if (archive) setRecoveryArchive(archive);
      setActivity(await desktop.syncActivity());
      setDevices(await desktop.syncDevices());
    } finally { setConflicts(await desktop.syncConflicts()); }
  }

  async function connected(current: SyncBinding) {
    setBinding(current);
    setNeedsReconnect(false);
    setCode("");
    setRecoveryCode("");
    if (current.paused) return;
    await synchronize();
  }

  async function resolve(issue: SyncConflict, choice: SyncResolution) {
    if (issue.remoteRevision === null || issue.localGeneration === null) return;
    try { await onResolve(issue.entityType, issue.entityId, choice, issue.remoteRevision, issue.localGeneration); }
    finally { setConflicts(await desktop.syncConflicts()); }
  }

  const active = devices?.devices.filter(device => !device.revokedAt) ?? [];
  const failure = error || activity?.error?.message || automaticError;
  const feedback = <div className="sync-action-feedback">
    {<div className="action-error-slot">{failure ? <p role="alert" className="sync-feedback" data-error="true" title={failure}>{failure}</p> : null}</div>}
  </div>;
  const deviceName = name ?? active.find(device => device.deviceId === devices?.currentDeviceId)?.name ?? "";
  const lastExchangeAt = activity?.lastExchangeAt;
  return <div className="settings-card sync-settings">
    <SettingRow label="连接状态" hint={binding?.pauseReason ? pauseLabels[binding.pauseReason] : undefined}>
      {() => <SyncStatus binding={binding} activity={activity} reconnect={needsReconnect} error={error || automaticError} waitingReason={waitingReason} />}
    </SettingRow>
    {lastExchangeAt != null && <SettingRow label="最近检查">
      {() => <span className="muted-text">{new Date(lastExchangeAt).toLocaleString()}</span>}
    </SettingRow>}
    {binding && activity?.pendingCount !== undefined && <SettingRow label={`待上传 ${activity.pendingCount} 项`}>
      {() => <span className="muted-text">需处理 {activity.issues} 项</span>}
    </SettingRow>}
    {binding && <SettingRow id="sync-bound-url" label="服务地址">
      {() => <TextField.Root id="sync-bound-url" readOnly value={binding.url} />}
    </SettingRow>}
    {showConnectionForm && <form onSubmit={event => {
      event.preventDefault();
      void perform("connect", async () => connected(await desktop.syncConnect(binding?.url ?? url, name ?? "", code || undefined)));
    }}>
      {!binding && <SettingRow id="sync-url" label="服务地址" hint="填写已部署同步服务的 HTTPS 根地址（如 Worker 域名），不是 R2/S3 存储端点。">
        {hintId => <TextField.Root id="sync-url" aria-describedby={hintId} type="url" placeholder="https://sync.example.com"
          required value={url} onChange={event => setUrl(event.target.value)} />}
      </SettingRow>}
      <SettingRow id="sync-name" label="设备名称" hint="显示在同步设备列表中。">
        {hintId => <TextField.Root id="sync-name" aria-describedby={hintId} placeholder="例如 办公电脑" required
          maxLength={128} value={name ?? ""} onChange={event => setName(event.target.value)} />}
      </SettingRow>
      <SettingRow id="sync-code" label="连接密钥" hint="首次连接使用部署时的 SETUP_SECRET，添加电脑或重装使用已保存的连接密钥。">
        {hintId => <TextField.Root id="sync-code" aria-describedby={hintId} type="text" autoComplete="off" required
          minLength={64} maxLength={64} value={code} onChange={event => setCode(event.target.value)} />}
      </SettingRow>
      {showMergeNotice && <p id="sync-merge-hint" className="setting-hint">连接后将合并本地与云端内容；同一内容存在不同修改时，会保留双方版本供你处理。</p>}
      <div className="settings-footer sync-connect-footer">
        {feedback}
        {!binding && <Button type="button" color="gray" variant="soft" loading={busy === "secret"}
          onClick={() => void perform("secret", async () => {
            const generated = await desktop.syncGenerateSecret();
            await desktop.copyText(generated);
            setCode(generated);
          })} {...buttonProps("secret", blocked)}>{buttonLabel("secret", "生成部署密钥", "复制成功", "生成失败")}</Button>}
        <Button type="submit" aria-describedby={showMergeNotice ? "sync-merge-hint" : undefined}
          loading={busy === "connect"}  {...buttonProps("connect", blocked)}>{buttonLabel("connect", "连接", "连接成功", "连接失败")}</Button>
      </div>
    </form>}
    {binding && !binding.paused && !needsReconnect && <>
      {deviceName && <SettingRow label="当前设备">{() => <span className="muted-text">{deviceName}</span>}</SettingRow>}
      <div className="settings-footer sync-actions-footer">
        {feedback}
        <Button type="button" color="gray" variant="soft" loading={busy === "info"}  onClick={() => void perform("info", async () => {
          const info = await desktop.syncConnectionInfo();
          await desktop.copyText(`服务地址：${info.url}\n连接密钥：${info.accessKey}`);
        })} {...buttonProps("info", blocked)}>{buttonLabel("info", "复制连接信息", "复制成功", "复制失败")}</Button>
        <Button type="button" variant="soft" loading={busy === "sync"}  onClick={() => void perform("sync", synchronize)} {...buttonProps("sync", blocked)}>
          {buttonLabel("sync", "立即同步", "检查完成", "检查失败")}
        </Button>
      </div>
    </>}
    {!showConnectionForm && (!binding || binding.paused) && failure &&
      <div className="settings-footer sync-actions-footer">{feedback}</div>}
    {conflicts.map(issue => <SettingRow key={issue.entityType + "/" + issue.entityId}
      label={issue.local?.title || issue.local?.name || issue.local?.label || issue.remote?.title || issue.remote?.name || issue.remote?.label || conflictLabels[issue.entityType]} hint={issue.reason}>
      {() => issue.resolvable ? <details className="sync-conflict">
        <summary>{issue.directoryDifference?.onlyDifference ? "选择目录归属" : "查看冲突内容"}</summary>
        {issue.directoryDifference && <dl className="sync-conflict-directories">
          <div><dt>本地目录</dt><dd>{issue.directoryDifference.localPath}</dd></div>
          <div><dt>云端目录</dt><dd>{issue.directoryDifference.remotePath}</dd></div>
        </dl>}
        {!issue.directoryDifference?.onlyDifference && <div className="sync-conflict-versions">
          <label><span>{issue.entityType === "entry" ? "本地稿" : "本地版本"}</span>
            <TextArea aria-label={issue.entityType === "entry" ? "本地稿" : "本地版本"} readOnly rows={7}
              value={issue.entityType === "entry" ? issue.local?.contentMd ?? "" : canvasVersion(issue.entityType, issue.local, !issue.local)} />
          </label>
          <label><span>{issue.entityType === "entry" ? "云端稿" : "云端版本"}</span>
            <TextArea aria-label={issue.entityType === "entry" ? "云端稿" : "云端版本"} readOnly rows={7}
              value={issue.entityType === "entry" ? issue.remote?.contentMd ?? "" : canvasVersion(issue.entityType, issue.remote, issue.remoteDeleted)} />
          </label>
        </div>}
        {issue.entityType !== "entry" && issue.entityType !== "wechat_publication_defaults" && <p className="setting-hint">
          仅处理当前冲突项。另存副本会完整复制本地白板的卡片、布局和连线，保留文章及图片引用，再让原冲突项采用云端版本。
          {issue.remoteDeleted && "云端已删除此项，需另存副本以保留本地内容。"}
          {!issue.local && "本地已删除此项，无法另存副本。"}
        </p>}
        <Flex wrap="wrap" gap="2" mt="2">
          {([["copy", issue.entityType === "entry" ? "另存本地稿" : "另存副本"],
            ["local", issue.directoryDifference?.onlyDifference ? "保留本地目录" : issue.entityType === "entry" ? "保留本地稿" : "保留本地版本"],
            ["cloud", issue.directoryDifference?.onlyDifference ? "采用云端目录" : issue.entityType === "entry" ? "采用云端稿" : "采用云端版本"]] as const).map(([choice, label]) =>
            (issue.entityType === "wechat_publication_defaults" && choice === "copy") ? null : <Button key={choice} type="button" size="1" variant="soft"
              onClick={() => void perform("resolve", () => resolve(issue, choice), `resolve:${issue.entityType}:${issue.entityId}:${choice}`)} {...buttonProps(`resolve:${issue.entityType}:${issue.entityId}:${choice}`, blocked || binding?.paused ||
              (issue.entityType !== "entry" && (choice === "local" && !issue.canKeepLocal || choice === "copy" && !issue.local)))}>
              {buttonLabel(`resolve:${issue.entityType}:${issue.entityId}:${choice}`, label, "处理完成")}
            </Button>)}
        </Flex>
      </details> : null}
    </SettingRow>)}
    <details className="sync-advanced">
      <summary><ChevronRight size={16} strokeWidth={1.65} aria-hidden="true" />高级操作</summary>
      {binding && !binding.paused && !needsReconnect && <>
        {active.map(device => <SettingRow key={device.deviceId} label={device.name}>
          {() => device.deviceId === devices?.currentDeviceId ? <span className="muted-text">当前设备</span>
            : <Button type="button" size="1" color="red" variant="soft"  onClick={() => setConfirm(device)} {...buttonProps(`revoke:${device.deviceId}`, blocked)}>
              {buttonLabel(`revoke:${device.deviceId}`, "撤销", "已撤销")}
            </Button>}
        </SettingRow>)}
        <SettingRow label="更换连接密钥" hint="旧连接密钥将失效，已连接的设备继续同步。">
          {() => <Button type="button" variant="soft" loading={busy === "access"}  onClick={() => void perform("access", async () => {
            await desktop.copyText(await desktop.syncCreateAccessKey());
          })} {...buttonProps("access", blocked)}>{buttonLabel("access", "更换并复制密钥", "复制成功", "复制失败")}</Button>}
        </SettingRow>
      </>}
      {binding?.paused && <form onSubmit={event => {
        event.preventDefault();
        void perform("reauthorize", async () => {
          setBinding(await desktop.syncReauthorize(binding.url, deviceName, code));
          setNeedsReconnect(false);
          setCode("");
        });
      }}>
        <SettingRow id="sync-review-name" label="设备名称">
          {() => <TextField.Root id="sync-review-name" required maxLength={128} value={deviceName} onChange={event => setName(event.target.value)} />}
        </SettingRow>
        <SettingRow id="sync-review-key" label="当前服务连接密钥" hint="仅重新授权，随后仍需明确选择是否采用云端内容。">
          {hintId => <TextField.Root id="sync-review-key" aria-describedby={hintId} type="text" autoComplete="off"
            required minLength={64} maxLength={64} value={code} onChange={event => setCode(event.target.value)} />}
        </SettingRow>
        <div className="settings-footer"><Button type="submit" variant="soft" loading={busy === "reauthorize"}  {...buttonProps("reauthorize", blocked)}>
          {buttonLabel("reauthorize", "授权当前服务", "授权成功", "授权失败")}
        </Button></div>
      </form>}
      {binding && !binding.paused && !needsReconnect && <SettingRow label="设备恢复密钥" hint="用于恢复指定设备身份，使用一次后失效。">
        {hintId => <Button id="sync-recovery-key" aria-describedby={hintId} type="button" variant="soft"
          loading={busy === "recovery"}  onClick={() => void perform("recovery", async () => {
            await desktop.copyText(await desktop.syncCreateRecoveryKey());
          })} {...buttonProps("recovery", blocked)}>{buttonLabel("recovery", "生成并复制恢复密钥", "复制成功", "复制失败")}</Button>}
      </SettingRow>}
      {(showConnectionForm || binding?.paused) && <form onSubmit={event => {
        event.preventDefault();
        void perform("recover", async () => connected(await desktop.syncRecover(binding?.url ?? url, deviceName, recoveryCode)));
      }}>
        <SettingRow id="sync-recover-code" label="设备恢复密钥" hint="恢复原设备身份，保留本地内容及同步记录。">
          {hintId => <TextField.Root id="sync-recover-code" aria-describedby={hintId} type="password" autoComplete="off"
            required minLength={64} maxLength={64} value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} />}
        </SettingRow>
        <div className="settings-footer"><Button type="submit" variant="soft" loading={busy === "recover"}
           {...buttonProps("recover", blocked || !deviceName || !(binding?.url ?? url))}>{buttonLabel("recover", "恢复指定设备", "恢复成功", "恢复失败")}</Button></div>
      </form>}
      {binding?.paused && !needsReconnect && <div className="settings-footer">
        <AlertDialog.Root>
          <AlertDialog.Trigger><Button type="button" variant="soft"  loading={busy === "rebuild"} {...buttonProps("rebuild", blocked)}>
            {buttonLabel("rebuild", "采用云端内容恢复本机", "恢复完成", "恢复失败")}
          </Button></AlertDialog.Trigger>
          <AlertDialog.Content className="sync-confirm-dialog" maxWidth="440px">
            <AlertDialog.Title>采用云端内容恢复本机</AlertDialog.Title>
            <AlertDialog.Description>先保存本地恢复副本，再采用云端内容。本地独有文稿将移入废纸篓，未同步修改可从恢复副本找回。</AlertDialog.Description>
            <Flex gap="3" mt="4" justify="end">
              <AlertDialog.Cancel><Button color="gray" variant="soft">取消</Button></AlertDialog.Cancel>
              <AlertDialog.Action><Button color="red" onClick={() => void perform("rebuild", async () => {
                setRecoveryArchive(await onRebuild());
                setBinding(await desktop.syncStatus());
                setActivity(await desktop.syncActivity());
                setConflicts([]);
                setDevices(await desktop.syncDevices());
              })} {...buttonProps("rebuild")}>{buttonLabel("rebuild", "恢复", "恢复完成", "恢复失败")}</Button></AlertDialog.Action>
            </Flex>
          </AlertDialog.Content>
        </AlertDialog.Root>
      </div>}
    </details>
    {recoveryArchive && <div className="settings-footer">
      <Button type="button" variant="soft" loading={busy === "reveal"}  onClick={() => void perform("reveal", () => desktop.revealFile(recoveryArchive))} {...buttonProps("reveal", blocked)}>
        {buttonLabel("reveal", "打开恢复副本位置", "已打开", "打开失败")}
      </Button>
    </div>}
    <AlertDialog.Root open={Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(undefined); }}>
      <AlertDialog.Content className="sync-confirm-dialog" maxWidth="400px">
        <AlertDialog.Title>撤销设备</AlertDialog.Title>
        <AlertDialog.Description>{confirm?.name}的设备凭据将失效。更换连接密钥可阻止持有旧密钥的设备再次加入。</AlertDialog.Description>
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel><Button color="gray" variant="soft">取消</Button></AlertDialog.Cancel>
          <AlertDialog.Action><Button color="red" onClick={() => {
            if (!confirm) return;
            void perform("revoke", async () => {
              await desktop.syncRevokeDevice(confirm.deviceId);
              setDevices(await desktop.syncDevices());
            }, `revoke:${confirm.deviceId}`);
          }} {...buttonProps(`revoke:${confirm?.deviceId}`)}>{buttonLabel(`revoke:${confirm?.deviceId}`, "撤销", "已撤销")}</Button></AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  </div>;
}
