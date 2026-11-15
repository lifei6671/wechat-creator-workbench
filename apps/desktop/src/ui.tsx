import { IconButton, Tooltip } from "@radix-ui/themes";
import type { ComponentProps, ReactNode } from "react";

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
