import { useState } from "react";
import { FilePenLine, ListTree, LoaderCircle, Sparkles } from "lucide-react";
import { Tool, WechatIcon } from "../ui";
import { WindowDragRegion } from "./WindowTitle";

export type RightSidebarMode = "wechat" | "ai" | "properties" | "outline";
const tools = [
  { id: "wechat", label: "公众号设置", icon: <WechatIcon /> },
  { id: "ai", label: "AI 助手", icon: <Sparkles size={17} strokeWidth={1.8} /> },
  { id: "properties", label: "内容属性", icon: <FilePenLine size={17} strokeWidth={1.8} /> },
  { id: "outline", label: "文档大纲", icon: <ListTree size={17} strokeWidth={1.8} /> },
] as const;

export function RightSidebarToolbar({ value, disabled, working, onChange, onError }: {
  value: RightSidebarMode; disabled: Partial<Record<RightSidebarMode, boolean>>;
  working?: RightSidebarMode | "close" | null;
  onChange(mode: RightSidebarMode): void;
  onError(error: unknown): void;
}) {
  const [focused, setFocused] = useState<RightSidebarMode>("wechat");
  const tabStop = disabled[focused] ? tools.find(tool => !disabled[tool.id])?.id : focused;
  return <header className="right-sidebar-header chrome-band">
    <div className="right-sidebar-tools" role="toolbar" aria-label="右侧栏工具" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const available = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = available.indexOf(event.target as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1
        : (index + (event.key === "ArrowLeft" ? -1 : 1) + available.length) % available.length;
      available[next]?.focus();
    }}>
      {tools.map(tool => <Tool key={tool.id} id={`right-sidebar-${tool.id}-button`} label={tool.label} className="chrome-icon right-sidebar-button"
        aria-pressed={value === tool.id} aria-controls={`right-sidebar-${tool.id}-panel`}
        tabIndex={tabStop === tool.id ? 0 : -1} onFocus={() => setFocused(tool.id)}
        disabled={Boolean(working) || disabled[tool.id]} aria-busy={working === tool.id || undefined}
        onClick={() => onChange(tool.id)}>{working === tool.id
          ? <span className="button-feedback-icon" data-state="pending" aria-hidden="true"><LoaderCircle size={17} /></span> : tool.icon}</Tool>)}
    </div>
    <WindowDragRegion onError={onError} />
  </header>;
}
