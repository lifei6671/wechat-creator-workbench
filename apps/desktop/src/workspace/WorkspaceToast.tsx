import { useEffect, useEffectEvent, useState } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { Tool } from "../ui";

export type Notice = { type: "error" | "info"; text: string };

export function WorkspaceToast({ notice, onDismiss }: { notice: Notice; onDismiss(notice: Notice): void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState<Notice | null>(null);
  const exiting = notice === leaving;
  const dismiss = useEffectEvent(() => onDismiss(notice));

  useEffect(() => {
    if (exiting || hovered || focused) return;
    const timer = window.setTimeout(() => setLeaving(notice), notice.type === "error" ? 6500 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice, exiting, hovered, focused]);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => dismiss(), 180);
    return () => window.clearTimeout(timer);
  }, [notice, exiting]);

  const Icon = notice.type === "error" ? CircleAlert : CircleCheck;
  return <div className="workspace-toast" data-tone={notice.type} data-leaving={exiting || undefined}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}>
    <Icon className="toast-icon" size={16} aria-hidden="true" />
    <span role={notice.type === "error" ? "alert" : "status"}>{notice.text}</span>
    <Tool className="chrome-icon toast-close" label="关闭通知" onClick={() => setLeaving(notice)}><X size={14} /></Tool>
  </div>;
}
