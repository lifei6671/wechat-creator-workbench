import { useEffect, useState } from "react";

export function useSettingsButtonFeedback() {
  const [results, setResults] = useState<Record<string, { status: "success" | "error"; expiresAt: number }>>({});

  useEffect(() => {
    const pending = Object.values(results);
    if (!pending.length) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setResults(current => Object.fromEntries(Object.entries(current).filter(([, result]) => result.expiresAt > now)));
    }, Math.min(...pending.map(result => result.expiresAt)) - Date.now());
    return () => window.clearTimeout(timer);
  }, [results]);

  function start(key: string) {
    setResults(current => { const next = { ...current }; delete next[key]; return next; });
  }

  function finish(key: string, success: boolean) {
    const expiresAt = Date.now() + 1000;
    setResults(current => ({ ...current, [key]: { status: success ? "success" : "error", expiresAt } }));
  }

  function label(key: string, original: string, success: string, failure = "操作失败") {
    const status = results[key]?.status;
    return <span className="settings-button-label" data-label={original} data-success-label={success} data-result={status}>
      <span>{status === "success" ? success : status === "error" ? failure : original}</span>
    </span>;
  }

  return { start, finish, label };
}
