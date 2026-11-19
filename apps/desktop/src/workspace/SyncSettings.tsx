import { useEffect, useState } from "react";
import { AlertDialog, Button, Flex, Select, TextArea, TextField } from "@radix-ui/themes";
import { desktop, errorMessage, type SyncBinding, type SyncConflict, type SyncConnectMethod, type SyncDevice, type SyncDevices, type SyncResolution } from "../desktop";
import { SettingRow } from "./Settings";

const conflictLabels: Record<SyncConflict["entityType"], string> = {
  entry: "文稿冲突", category: "目录冲突", asset: "素材冲突",
  collection: "专题冲突", collection_node: "画布卡片冲突", collection_edge: "画布连线冲突",
};

function credentialRejected(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "SYNC_CREDENTIAL" || error.code === "SYNC_REAUTH");
}

export function SyncSettings({ onSync, onResolve, onRebuild, automaticError }: {
  onSync(): Promise<string | undefined>;
  onResolve(type: SyncConflict["entityType"], id: string, choice: SyncResolution, remoteRevision: number, localGeneration: number): Promise<void>;
  onRebuild(): Promise<string>;
  automaticError?: string;
}) {
  const [binding, setBinding] = useState<SyncBinding | null>();
  const [devices, setDevices] = useState<SyncDevices>();
  const [url, setUrl] = useState("");
  const [name, setName] = useState<string>();
  const [method, setMethod] = useState<SyncConnectMethod>("claim");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"connect" | "secret" | "devices" | "access" | "recovery" | "revoke" | "sync" | "resolve" | "rebuild">();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<SyncDevice>();
  const [recoveryArchive, setRecoveryArchive] = useState("");
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const showConnectionForm = binding === null || Boolean(binding && needsReconnect);
  const canClaim = !binding || binding.paused;
  const connectionMethod = !canClaim && method === "claim" ? "join" : method;

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const saved = await desktop.syncStatus();
        if (!current) return;
        setBinding(saved);
        if (saved && !saved.paused) {
          const [list, issues] = await Promise.all([desktop.syncDevices(), desktop.syncConflicts()]);
          if (current) { setDevices(list); setConflicts(issues); }
        }
      } catch (failure) {
        if (!current) return;
        setError(errorMessage(failure));
        setNeedsReconnect(credentialRejected(failure));
        try {
          const status = await desktop.syncStatus();
          if (current) setBinding(status);
        } catch {
          if (current) setBinding(undefined);
        }
      }
    })();
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!showConnectionForm) return;
    let current = true;
    void desktop.syncDefaultDeviceName().then(defaultName => {
      if (current && defaultName) setName(edited => edited ?? defaultName);
    }, () => {});
    return () => { current = false; };
  }, [showConnectionForm]);

  async function perform(kind: NonNullable<typeof busy>, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (failure) {
      if (kind === "connect" && typeof failure === "object" && failure !== null &&
        "code" in failure && failure.code === "SYNC_CLAIMED") {
        setMethod("join");
        setCode("");
        setError("服务已有设备，请用接入密钥加入或用恢复密钥连接。");
      } else {
        setError(errorMessage(failure));
        if (credentialRejected(failure)) { setMethod("join"); setNeedsReconnect(true); }
      }
      setBinding(await desktop.syncStatus().catch(() => binding));
    } finally {
      setBusy(undefined);
    }
  }

  async function connect() {
    const current = await desktop.syncConnect(binding?.url ?? url, name ?? "", connectionMethod, code, binding?.paused);
    setBinding(current);
    setNeedsReconnect(false);
    setCode("");
    if (current.paused) {
      setNotice("设备已连接，可以重建同步基线");
      return;
    }
    await synchronize();
    setDevices(await desktop.syncDevices());
  }

  async function synchronize() {
    let archive: string | undefined;
    try {
      archive = await onSync();
      if (archive) {
        setRecoveryArchive(archive);
        await onSync();
      }
    }
    finally { setConflicts(await desktop.syncConflicts()); }
    setNotice(archive ? "本地工作区已备份并完成首次合并" : "同步检查完成");
  }

  async function resolve(issue: SyncConflict, choice: SyncResolution) {
    if (issue.remoteRevision === null || issue.localGeneration === null) return;
    try { await onResolve(issue.entityType, issue.entityId, choice, issue.remoteRevision, issue.localGeneration); }
    finally { setConflicts(await desktop.syncConflicts()); }
    setNotice(choice === "local" ? "本地版本已排队上传" : "冲突已处理");
  }

  const active = devices?.devices.filter(device => !device.revokedAt) ?? [];
  const failure = error || automaticError;
  const feedbackText = failure || notice;
  return <div className="settings-card sync-settings">
    <SettingRow label="连接状态">
      {() => <span role="status" className="settings-state">
        {binding === undefined ? (error ? "无法读取" : "正在读取…") : binding ? (needsReconnect ? "需要重新连接" : binding.paused ? "已暂停" : "设备已绑定") : "未连接"}
      </span>}
    </SettingRow>
    {binding && <SettingRow id="sync-bound-url" label="服务地址" hint="添加其他设备时使用同一个地址。">
      {hintId => <TextField.Root id="sync-bound-url" aria-describedby={hintId} readOnly value={binding.url} />}
    </SettingRow>}
    {showConnectionForm && <form onSubmit={event => { event.preventDefault(); void perform("connect", connect); }}>
      {!binding && <SettingRow id="sync-url" label="服务地址"
        hint="填部署后的 HTTPS 根地址。Cloudflare 用 Worker 的地址，Docker 用为同步服务配置的 HTTPS 域名。本机测试可用 http://127.0.0.1:8787。">
        {hintId => <TextField.Root id="sync-url" aria-describedby={hintId} type="url" placeholder="https://sync.example.com"
          required value={url} onChange={event => setUrl(event.target.value)} />}
      </SettingRow>}
      <SettingRow id="sync-name" label="设备名称" hint="默认填入当前电脑名称，可修改。这个名称会显示在同步设备列表中。">
        {hintId => <TextField.Root id="sync-name" aria-describedby={hintId} placeholder="例如 办公电脑" required
          maxLength={128} value={name ?? ""} onChange={event => setName(event.target.value)} />}
      </SettingRow>
      <SettingRow id="sync-method" label="连接方式"
        hint={canClaim
          ? "首次部署选「认领服务」。添加电脑选「加入已有服务」。本机已有内容时，先备份再合并。"
          : "选「恢复连接」沿用原设备。使用接入密钥会登记为新设备。"}>
        {hintId => <Select.Root value={connectionMethod} onValueChange={value => { setMethod(value as SyncConnectMethod); setCode(""); setError(""); }}>
          <Select.Trigger id="sync-method" aria-describedby={hintId} />
          <Select.Content>
            {canClaim && <Select.Item value="claim">认领服务</Select.Item>}
            <Select.Item value="join">加入已有服务</Select.Item>
            <Select.Item value="recover">恢复连接</Select.Item>
          </Select.Content>
        </Select.Root>}
      </SettingRow>
      <SettingRow id="sync-code" label={connectionMethod === "claim" ? "认领密钥" : connectionMethod === "recover" ? "恢复密钥" : "接入密钥"}
        hint={connectionMethod === "claim"
          ? binding
            ? "填写管理员重新配置的 SETUP_SECRET。Cloudflare 在部署配置中设置，Docker 在服务目录的 .env 文件中设置。"
            : "填写部署时设置的 SETUP_SECRET。部署前可点「生成并复制密钥」，把同一个值填入 Cloudflare 部署配置或 Docker 的 .env 文件。"
          : connectionMethod === "recover"
            ? "用之前保存的恢复密钥，或请 Cloudflare 管理员为这台设备签发。全新安装请用空工作区恢复云端内容。"
            : "粘贴已保存的工作区接入密钥。可在已连接的电脑上打开「设置 → 同步」生成。"}>
        {hintId => <TextField.Root id="sync-code" aria-describedby={hintId} type="password" autoComplete="off" required
          minLength={64} maxLength={64} value={code} onChange={event => setCode(event.target.value)} />}
      </SettingRow>
      <div className="settings-footer sync-connect-footer">
        <p role={failure ? "alert" : "status"} title={feedbackText || undefined}
          className={`sync-feedback ${failure ? "inline-error" : "muted-text"}`}>{feedbackText}</p>
        {!binding && method === "claim" && <Button type="button" color="gray" variant="soft" loading={busy === "secret"} disabled={Boolean(busy)}
          onClick={() => void perform("secret", async () => {
            const generated = await desktop.syncGenerateSecret();
            await desktop.copyText(generated);
            setCode(generated);
            setNotice("认领密钥已复制。请将同一个值填入服务部署配置的 SETUP_SECRET。");
          })}>生成并复制密钥</Button>}
        <Button type="submit" loading={busy === "connect"} disabled={Boolean(busy)}>
          {connectionMethod === "recover" ? "恢复连接" : binding ? "重新连接" : "连接"}
        </Button>
      </div>
    </form>}
    {binding && !binding.paused && !needsReconnect && <>
      {active.map(device => <SettingRow key={device.deviceId} label={device.name}>
        {() => device.deviceId === devices?.currentDeviceId ? <span className="muted-text">当前设备</span>
          : <Button type="button" size="1" color="red" variant="soft" disabled={Boolean(busy)} onClick={() => setConfirm(device)}>撤销</Button>}
      </SettingRow>)}
      <SettingRow label="工作区接入密钥" hint="保存后可重复添加设备。重新生成会使旧密钥失效。">
        {hintId => <Button type="button" aria-describedby={hintId} variant="soft"
          loading={busy === "access"} disabled={Boolean(busy)} onClick={() => void perform("access", async () => {
            await desktop.copyText(await desktop.syncCreateAccessKey());
            setNotice("接入密钥已复制，请保存在应用之外");
          })}>生成并复制接入密钥</Button>}
      </SettingRow>
      <SettingRow label="恢复密钥"
        hint="请保存在应用之外。重装并丢失设备凭据时可用一次，重新生成会替换旧密钥。">
        {hintId => <Button id="sync-recovery-key" aria-describedby={hintId} type="button" variant="soft"
          loading={busy === "recovery"} disabled={Boolean(busy)} onClick={() => void perform("recovery", async () => {
            const key = await desktop.syncCreateRecoveryKey();
            await desktop.copyText(key);
            setNotice("恢复密钥已复制，请保存在应用之外");
          })}>生成并复制恢复密钥</Button>}
      </SettingRow>
      <div className="settings-footer">
        <Button type="button" variant="soft" loading={busy === "sync"} disabled={Boolean(busy)}
          onClick={() => void perform("sync", synchronize)}>立即同步</Button>
        <Button type="button" color="gray" variant="soft" loading={busy === "devices"} disabled={Boolean(busy)}
          onClick={() => void perform("devices", async () => setDevices(await desktop.syncDevices()))}>刷新设备</Button>
      </div>
    </>}
    {conflicts.map(issue => <SettingRow key={issue.entityType + "/" + issue.entityId}
      label={issue.local?.title || issue.local?.name || issue.local?.label || issue.remote?.title || issue.remote?.name || issue.remote?.label || conflictLabels[issue.entityType]} hint={issue.reason}>
      {() => issue.resolvable ? <details>
        <summary>查看冲突内容</summary>
        <TextArea aria-label="本地稿" readOnly value={issue.local?.contentMd ?? ""} />
        <TextArea aria-label="云端稿" readOnly value={issue.remote?.contentMd ?? ""} />
        <Flex wrap="wrap" gap="2" mt="2">
          {([["copy", "另存本地稿"], ["local", "保留本地稿"], ["cloud", "采用云端稿"]] as const).map(([choice, label]) =>
            <Button key={choice} type="button" size="1" variant="soft" disabled={Boolean(busy) || binding?.paused}
              onClick={() => void perform("resolve", () => resolve(issue, choice))}>{label}</Button>)}
        </Flex>
      </details> : issue.canKeepLocal && <Button type="button" size="1" variant="soft" disabled={Boolean(busy) || binding?.paused}
        onClick={() => void perform("resolve", () => resolve(issue, "local"))}>保留本地版本</Button>}
    </SettingRow>)}
    {binding?.paused && !needsReconnect && <div className="settings-footer">
      <AlertDialog.Root>
        <AlertDialog.Trigger><Button type="button" variant="soft" disabled={Boolean(busy)} loading={busy === "rebuild"}>重建同步基线</Button></AlertDialog.Trigger>
        <AlertDialog.Content maxWidth="440px">
          <AlertDialog.Title>重建同步基线</AlertDialog.Title>
          <AlertDialog.Description>应用会先把当前工作区保存为本地恢复副本，再载入云端内容。本地未同步的修改可以从副本中找回。</AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel><Button color="gray" variant="soft">取消</Button></AlertDialog.Cancel>
            <AlertDialog.Action><Button color="red" onClick={() => void perform("rebuild", async () => {
              setRecoveryArchive(await onRebuild());
              setBinding(await desktop.syncStatus());
              setConflicts([]);
              setNotice("同步基线已重建");
              setDevices(await desktop.syncDevices());
            })}>重建</Button></AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>}
    {recoveryArchive && <div className="settings-footer">
      <Button type="button" variant="soft" disabled={Boolean(busy)} onClick={() => void perform("rebuild", () => desktop.revealFile(recoveryArchive))}>打开恢复副本位置</Button>
    </div>}
    {!showConnectionForm && notice && <p role="status" className="settings-feedback muted-text">{notice}</p>}
    {!showConnectionForm && failure && <p role="alert" className="settings-feedback inline-error">{failure}</p>}
    <AlertDialog.Root open={Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(undefined); }}>
      <AlertDialog.Content maxWidth="400px">
        <AlertDialog.Title>撤销设备</AlertDialog.Title>
        <AlertDialog.Description>{confirm?.name}的设备凭据将失效。如果它持有接入密钥，重新生成密钥可阻止它再次加入。</AlertDialog.Description>
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel><Button color="gray" variant="soft">取消</Button></AlertDialog.Cancel>
          <AlertDialog.Action><Button color="red" onClick={() => {
            if (!confirm) return;
            void perform("revoke", async () => {
              await desktop.syncRevokeDevice(confirm.deviceId);
              setDevices(await desktop.syncDevices());
              setNotice("设备已撤销");
            });
          }}>撤销</Button></AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  </div>;
}
