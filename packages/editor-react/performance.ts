import type { EditorView } from "@milkdown/kit/prose/view";
import type { MarkdownEditorHandle } from "./index";

const enabled = import.meta.env.VITE_EDITOR_PERF === "1";
const metrics: Record<string, { count: number; ms: number }> = {};
export const editorPerformance = enabled ? {
  metrics,
  editors: new Map<string, { view: EditorView; handle: MarkdownEditorHandle }>(),
  reset() { for (const name of Object.keys(metrics)) delete metrics[name]; },
} : undefined;

if (editorPerformance) Object.assign(window, { __workbenchEditorPerformance: editorPerformance });

export function recordEditorPerformance(name: string, ms = 0) {
  if (!enabled) return;
  const metric = metrics[name] ??= { count: 0, ms: 0 };
  metric.count++;
  metric.ms += ms;
}

export function measureEditorPerformance<T>(name: string, work: () => T): T {
  if (!enabled) return work();
  const start = performance.now();
  try { return work(); }
  finally { recordEditorPerformance(name, performance.now() - start); }
}
