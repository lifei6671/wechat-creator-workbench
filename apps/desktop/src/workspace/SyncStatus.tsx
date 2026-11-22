import { Spinner } from "@radix-ui/themes";
import { CircleAlert, Cloud, CloudCheck, CloudOff, CloudUpload, Clock3, Pause } from "lucide-react";
import type { SyncActivity, SyncBinding } from "../desktop";

type SyncStatusProps = {
  binding: SyncBinding | null | undefined;
  activity: SyncActivity | null | undefined;
  reconnect?: boolean;
  error?: string;
  waitingReason?: string;
};

export function getSyncStatus({ binding, activity, reconnect = false, error, waitingReason }: SyncStatusProps) {
  let label: string;
  let tone: "muted" | "busy" | "success" | "warning" | "error" = "muted";
  let Icon = Cloud;
  let dot: "waiting" | "busy" | "success" | "error" = "waiting";
  const credentialError = activity?.error?.code === "SYNC_CREDENTIAL" || activity?.error?.code === "SYNC_REAUTH";
  const phases = { connecting: "正在连接", downloading: "正在下载", merging: "正在合并", syncing: "正在同步" };
  const busy = activity && activity.phase in phases && !binding?.paused && !reconnect && !credentialError;
  if (reconnect || credentialError) {
    label = "需要重新连接"; tone = "error"; dot = "error"; Icon = CloudOff;
  } else if (binding?.paused) {
    label = "已暂停"; tone = "warning"; Icon = Pause;
  } else if (busy) {
    label = phases[activity.phase as keyof typeof phases]; tone = "busy"; dot = "busy";
  } else if (binding === undefined) {
    label = error ? "无法读取同步状态" : "正在读取同步状态";
    if (error) { tone = "error"; dot = "error"; Icon = CircleAlert; }
  } else if (!binding) {
    label = "未连接同步"; dot = error || activity?.error ? "error" : "waiting"; Icon = CloudOff;
  } else if (activity?.phase === "waiting_seed") {
    label = "等待云端初始化"; Icon = Clock3;
  } else if (activity?.error || error) {
    label = "同步失败"; tone = "error"; dot = "error"; Icon = CircleAlert;
  } else if (activity?.issues) {
    label = "有内容需要处理"; tone = "warning"; dot = "error"; Icon = CircleAlert;
  } else if (activity?.incoming) {
    label = waitingReason ?? "已下载，准备应用"; Icon = Clock3;
  } else if (activity?.pending) {
    label = "正在处理上传任务"; dot = "busy"; Icon = CloudUpload;
  } else if (activity?.initialized && activity.lastExchangeAt !== null) {
    label = "已同步"; tone = "success"; dot = "success"; Icon = CloudCheck;
  } else {
    label = "等待检查";
  }
  const detail = activity?.incoming && waitingReason && tone === "muted" ? `已下载，${waitingReason}` : label;
  return { label, tone, Icon, busy, dot, detail: activity?.error?.message || error || detail };
}

export function SyncStatus({ compact = false, ...props }: SyncStatusProps & { compact?: boolean }) {
  const { label, tone, Icon, busy, dot, detail } = getSyncStatus(props);
  if (compact) return <span className="status-indicator" role="status" aria-label={label}>
    <Icon size={15} strokeWidth={1.65} aria-hidden="true" />
    <span className="status-dot" data-state={dot} aria-hidden="true" />
  </span>;
  return <span className="sync-state" role="status" data-tone={tone} title={detail}>
    {busy ? <Spinner size="1" /> : <Icon size={15} strokeWidth={1.65} aria-hidden="true" />}
    <span>{label}</span>
  </span>;
}
