import { useEffect, useState } from "react";
import { Button, Dialog, IconButton, Tabs } from "@radix-ui/themes";
import { RefreshCw, X } from "lucide-react";
import { desktop, errorMessage, type ImageVersionFile, type ImageVersionStatus } from "../desktop";
import { ActionError, useButtonFeedback } from "../button-feedback";
import "./ImageVersions.css";

const reasons: Record<string, string> = {
  original: "与原图共用文件", referenced: "仍被引用", latest: "最近 5 个版本", recent: "30 天内版本",
  retained: "已保留", published: "已发布或已外发", session: "本次编辑仍需使用",
  public: "图床图片，用途受保护", synced: "跨设备副本受保护", uploading: "正在上传",
  backup: "备份仍需使用", missing: "本地文件不可用",
};
const date = (time: number) => new Date(time).toLocaleDateString("zh-CN");
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const category = (file: ImageVersionFile) => ["removed", "expired", "restored"].includes(file.state ?? "") ? "recycle"
  : file.reasons.length ? "protected" : "waiting";
function detail(file: ImageVersionFile) {
  if (file.error) return file.error;
  if (file.state === "expired") return "回收保留期已结束";
  if (file.state === "restored") return "恢复后保留";
  if (file.state === "removed") return file.expiresAt ? `可恢复至 ${date(file.expiresAt)}` : "已回收";
  if (file.reasons.length) return file.reasons.filter(reason => reason !== "missing" || file.reasons.length === 1).map(reason => reasons[reason] ?? reason).join("，");
  if (file.state === "copying") return "正在备份";
  return file.dueAt ? `${date(file.dueAt)} 后自动清理` : "等待后台检查";
}

export function ImageVersions({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<ImageVersionStatus | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("waiting");
  const [busy, setBusy] = useState(false);
  const feedback = useButtonFeedback();
  useEffect(() => {
    let live = true;
    void desktop.imageVersionStatus().then(value => { if (live) setStatus(value); }, failure => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; };
  }, []);
  async function run(key: string, operation?: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    const updated = await feedback.run(key, async () => {
      await operation?.();
      const value = await desktop.imageVersionStatus();
      setError("");
      return value;
    }) as ImageVersionStatus | false | undefined;
    if (updated) {
      if (operation) await new Promise(resolve => window.setTimeout(resolve, 1000));
      setStatus(updated);
    }
    setBusy(false);
  }
  const files = status?.files.filter(file => category(file) === tab) ?? [];
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Content className="image-versions-dialog" aria-describedby={undefined}>
      <header><Dialog.Title>旧版本图片</Dialog.Title>
        <Button size="1" variant="ghost" {...feedback.props("refresh", busy)} onClick={() => void run("refresh")}>
          {feedback.icon("refresh", <RefreshCw size={14} />)}{feedback.label("refresh", "刷新", "已更新")}</Button>
        <IconButton variant="ghost" size="1" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16} /></IconButton>
      </header>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List><Tabs.Trigger value="waiting">待清理</Tabs.Trigger><Tabs.Trigger value="protected">已保留</Tabs.Trigger><Tabs.Trigger value="recycle">回收记录</Tabs.Trigger></Tabs.List>
      <div className="image-versions-summary">{status ? `${files.length} 个文件` : "正在读取"}</div>
      <Tabs.Content value={tab}>
      <div className="image-versions-list" aria-busy={busy}>
        {status && !files.length && <div className="image-versions-empty">没有{tab === "waiting" ? "待清理的旧版本图片" : tab === "protected" ? "保留记录" : "回收记录"}</div>}
        {files.map(file => <div className="image-version-row" key={`${file.sha256}:${file.copyId ?? "local"}`}>
          <div className="image-version-info"><div>{file.name}</div><time>{new Date(file.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
            <div className={file.error ? "inline-error" : "image-version-reason"}>{detail(file)}</div></div>
          <span className="image-version-size"><span>{file.location === "s3" ? "图床" : "本地文件"}</span><span>{size(file.bytes)}</span></span>
          {tab === "waiting" ? <Button size="1" variant="soft" {...feedback.props(file.sha256, busy)} onClick={() => void run(file.sha256, () => desktop.imageVersionKeep(file.assetId))}>
            {feedback.label(file.sha256, "保留", "已保留")}</Button>
            : file.state === "removed" ? <Button size="1" variant="soft" {...feedback.props(file.sha256, busy)} onClick={() => void run(file.sha256, () => desktop.imageVersionRestore(file.assetId))}>
              {feedback.label(file.sha256, "恢复", "已恢复")}</Button> : <span />}
        </div>)}
      </div>
      </Tabs.Content>
      </Tabs.Root>
      <ActionError error={error || feedback.error()} />
      <footer><span>后台自动清理，回收副本保留 30 天</span><Button size="1" variant="soft" disabled={busy} onClick={onClose}>关闭</Button></footer>
    </Dialog.Content>
  </Dialog.Root>;
}
