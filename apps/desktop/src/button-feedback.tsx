import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { errorMessage } from "./desktop";

type Result = { status: "pending" | "success" | "error"; expiresAt?: number };

export function useButtonFeedback() {
  const current = useRef<Record<string, Result>>({});
  const [results, setResults] = useState(current.current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);

  function update(next: Record<string, Result>) {
    current.current = next;
    if (mounted.current) setResults(next);
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const deadlines = Object.values(results).flatMap(result => result.expiresAt === undefined ? [] : [result.expiresAt]);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      update(Object.fromEntries(Object.entries(current.current).filter(([, result]) => result.expiresAt === undefined || result.expiresAt > now)));
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [results]);

  function isLocked(key: string) {
    const result = current.current[key];
    return result?.status === "pending" || (result?.expiresAt !== undefined && result.expiresAt > Date.now());
  }

  function start(key: string) {
    if (isLocked(key)) return false;
    update({ ...current.current, [key]: { status: "pending" } });
    setErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
    return true;
  }

  function finish(key: string, success: boolean | undefined) {
    const next = { ...current.current };
    if (success === undefined) delete next[key];
    else next[key] = { status: success ? "success" : "error", expiresAt: Date.now() + 1000 };
    update(next);
  }

  async function run(key: string, operation: () => unknown | Promise<unknown>) {
    if (!start(key)) return;
    try {
      const value = await operation();
      finish(key, value === false ? undefined : true);
      return value;
    } catch (failure) {
      finish(key, false);
      if (mounted.current) setErrors(previous => ({ ...previous, [key]: errorMessage(failure) }));
      return false;
    }
  }

  function props(key: string, disabled = false) {
    return {
      disabled: disabled || isLocked(key),
      "aria-busy": results[key]?.status === "pending" || undefined,
      "data-feedback-state": results[key]?.status,
    };
  }

  function label(key: string, original: string, success: string, failure = "操作失败") {
    const status = results[key]?.status;
    const widthLabel = [original, success, failure].reduce((longest, text) => text.length > longest.length ? text : longest);
    return <span className="settings-button-label" data-label={original} data-success-label={success} data-failure-label={failure} data-width-label={widthLabel}
      data-result={status === "pending" ? undefined : status}>
      <span aria-live="polite" aria-atomic="true">{status === "success" ? success : status === "error" ? failure : original}</span>
    </span>;
  }

  function icon(key: string, original: ReactNode, size = 16) {
    const status = results[key]?.status;
    const Icon = status === "pending" ? LoaderCircle : status === "success" ? Check : X;
    return <span className="button-feedback-icon" data-state={status} aria-hidden="true">
      {status ? <Icon size={size} /> : original}
    </span>;
  }

  return useMemo(() => ({ start, finish, run, props, label, icon, isLocked,
    error: (key?: string) => key === undefined ? Object.values(errors).join("；") : errors[key] ?? "",
    status: (key: string) => results[key]?.status,
  }), [results, errors]);
}

export function ActionError({ error, className = "" }: { error?: string; className?: string }) {
  return <div className={`action-error-slot ${className}`} tabIndex={error ? 0 : -1}>
    <p className="inline-error" role={error ? "alert" : undefined} aria-live="assertive" aria-atomic="true">{error || ""}</p>
  </div>;
}
