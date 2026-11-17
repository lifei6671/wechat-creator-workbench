import { IconButton } from "@radix-ui/themes";
import { PanelLeft, PanelRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Tooltip } from "../../../packages/ui-react/Tooltip";

export { Tooltip } from "../../../packages/ui-react/Tooltip";

export function SidebarToggleIcon({ expanded = false, side = "left" }: { expanded?: boolean; side?: "left" | "right" }) {
  const Panel = side === "left" ? PanelLeft : PanelRight;
  return <Panel size={18} strokeWidth={1.8} aria-hidden="true">
    {expanded && <rect x={side === "left" ? 5 : 16} y={5} width={3} height={14} rx={0.5} fill="currentColor" stroke="none" />}
  </Panel>;
}

export function Tool({ label, children, ...props }: ComponentProps<typeof IconButton> & { label: string; children: ReactNode }) {
  return <Tooltip content={label}>
    <IconButton type="button" size="1" variant="ghost" aria-label={label} {...props}>{children}</IconButton>
  </Tooltip>;
}

export function useStoredInitial<T>(key: string, initial: T): T {
  const stored = localStorage.getItem(key);
  return stored === null ? initial : JSON.parse(stored) as T;
}

export function persist<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}
