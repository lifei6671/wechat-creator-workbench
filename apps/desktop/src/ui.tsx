import { IconButton } from "@radix-ui/themes";
import type { ComponentProps, ReactNode } from "react";
import { Tooltip } from "../../../packages/ui-react/Tooltip";

export { Tooltip } from "../../../packages/ui-react/Tooltip";

export function SidebarToggleIcon({ expanded = false, side = "left" }: { expanded?: boolean; side?: "left" | "right" }) {
  return <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden="true">
    <rect x="1.5" y="2.25" width="15" height="13.5" rx="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <g transform={side === "right" ? "translate(18 0) scale(-1 1)" : undefined}>
      {expanded ? <rect x="3.25" y="4" width="3.5" height="10" rx="0.9" fill="currentColor" />
        : <path d="M5 4.5v9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />}
    </g>
  </svg>;
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
