import { Spinner } from "@radix-ui/themes";
import { CircleAlert, Cloud, CloudCheck, CloudOff, CloudUpload, Clock3, Pause } from "lucide-react";
import type { SyncActivity, SyncBinding } from "../desktop";

export function SyncStatus({ binding, activity, reconnect = false, error }: {
  binding: SyncBinding | null | undefined;
  activity: SyncActivity | null | undefined;
  reconnect?: boolean;
  error?: string;
}) {
  let label: string;
  let tone: "muted" | "busy" | "success" | "warning" | "error" = "muted";
  let Icon = Cloud;
  const credentialError = activity?.error?.code === "SYNC_CREDENTIAL" || activity?.error?.code === "SYNC_REAUTH";
  const phases = { connecting: "正在连接", downloading: "正在下载", merging: "正在合并", syncing: "正在同步" };
  const busy = activity && activity.phase in phases && !binding?.paused && !reconnect && !credentialError;
  if (reconnect || credentialError) {
    label = "需要重新连接"; tone = "error"; Icon = CloudOff;
  } else if (binding?.paused) {
    label = "已暂停"; tone = "warning"; Icon = Pause;
  } else if (busy) {
    label = phases[activity.phase as keyof typeof phases]; tone = "busy";
  } else if (binding === undefined) {
    label = error ? "无法读取同步状态" : "正在读取同步状态";
    if (error) { tone = "error"; Icon = CircleAlert; }
  } else if (!binding) {
    label = "未连接同步"; Icon = CloudOff;
  } else if (activity?.phase === "waiting_seed") {
    label = "等待云端初始化"; Icon = Clock3;
  } else if (activity?.error || error) {
    label = "同步失败"; tone = "error"; Icon = CircleAlert;
  } else if (activity?.issues) {
    label = "有内容需要处理"; tone = "warning"; Icon = CircleAlert;
  } else if (activity?.incoming) {
    label = "已下载，等待应用"; Icon = Clock3;
  } else if (activity?.pending) {
    label = "有内容待上传"; Icon = CloudUpload;
  } else if (activity?.initialized && activity.lastExchangeAt !== null) {
    label = "已同步"; tone = "success"; Icon = CloudCheck;
  } else {
    label = "等待检查";
  }
  return <span className="sync-state" role="status" data-tone={tone} title={activity?.error?.message || error || label}>
    {busy ? <Spinner size="1" /> : <Icon size={15} strokeWidth={1.65} aria-hidden="true" />}
    <span>{label}</span>
  </span>;
}
