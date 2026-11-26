import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Checkbox } from "@radix-ui/themes";
import { ClipboardCheck, Settings2, TriangleAlert, Diamond } from "lucide-react";
import type { MarkdownEditorHandle, ReviewRange, ReviewSnapshot } from "../../../../packages/editor-react";
import { desktop, errorMessage, type ReviewResult, type ReviewSettings } from "../desktop";
import { ActionError, useButtonFeedback } from "../button-feedback";
import { Tool } from "../ui";
import { ReviewHistory } from "./ReviewHistory";
import "../styles/review.css";

type Scope = "document" | "selection";
type Result = { snapshot: ReviewSnapshot; result: ReviewResult; scope: Scope };

export function ReviewPanel({ editor, articleId, articleTitle, configurationRevision, selectionEnabled, locked, onSettings, onNavigate }: {
  editor?: MarkdownEditorHandle;
  articleTitle: string;
  articleId: string;
  configurationRevision: number;
  selectionEnabled: boolean;
  locked: boolean;
  onSettings(): void;
  onNavigate(snapshot: ReviewSnapshot, range: ReviewRange): void;
}) {
  const [settings, setSettings] = useState<ReviewSettings>();
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result>();
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [marks, setMarks] = useState(true);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [cacheBusy, setCacheBusy] = useState(false);
  const buttons = useButtonFeedback();
  const request = useRef(0);
  const snapshot = useRef<ReviewSnapshot | undefined>(undefined);
  const alive = useRef(false);
  const running = useRef(false);
  const lastScope = useRef<Scope>("document");

  useLayoutEffect(() => {
    alive.current = true;
    let current = true;
    request.current++;
    snapshot.current = undefined;
    setResult(undefined); setStale(false); setSettings(undefined); setError("");
    void desktop.reviewSettings().then(value => { if (current) setSettings(value); }, failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; alive.current = false; request.current++; editor?.clearReview(); };
  }, [editor, configurationRevision]);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      setHasSelection(editor.hasSelection(false));
      if (snapshot.current && !editor.matchesReview(snapshot.current)) {
        snapshot.current = undefined;
        setStale(true);
        editor.clearReview();
      }
    };
    update();
    return editor.subscribeSelection(update);
  }, [editor]);

  const enabled = settings?.enabled && settings.hasKey;
  const feedbackLocked = ["document", "selection", "force"].some(key => buttons.isLocked(key));
  const blocked = locked || busy || cacheBusy || feedbackLocked || !editor || !enabled;

  async function check(scope: Scope, force = false) {
    if (running.current || blocked) return;
    const action = force ? "force" : scope;
    if (!buttons.start(action)) return;
    running.current = true;
    setBusy(true); setError(""); setResult(undefined); setStale(false);
    editor!.clearReview();
    const id = ++request.current;
    let outcome: boolean | undefined;
    try {
      const captured = editor!.captureReview(scope);
      if (!captured || !captured.projection.text.trim()) throw new Error("没有可检测的正文或选区");
      if (new TextEncoder().encode(captured.projection.text).byteLength > settings!.maxTextBytes) {
        throw new Error("超过本机单次检测文本上限，请选择部分正文");
      }
      snapshot.current = captured;
      lastScope.current = scope;
      const value = await desktop.reviewCheck(captured.projection.text, captured.projection.version, force, { entryId: articleId, title: articleTitle, scope });
      if (!alive.current || id !== request.current) return;
      setHistoryRevision(previous => previous + 1);
      if (!editor!.matchesReview(captured)) { setStale(true); return; }
      if (value.settingsRevision !== settings!.revision) return;
      setResult({ snapshot: captured, result: value, scope });
      if (marks) editor!.showReview(captured, value.findings);
      if (value.persistenceError) setError(value.persistenceError);
      outcome = true;
    } catch (failure) {
      if (alive.current && id === request.current) { setError(errorMessage(failure)); outcome = false; }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
      // Discarded responses still complete their original button's pending state.
      buttons.finish(action, outcome);
    }
  }

  const valid = result && !stale;
  const percentages = valid ? [["人工", result.result.summary.humanRatio], ["AI", result.result.summary.aiRatio], ["疑似 AI", result.result.summary.suspectedRatio]] as const : [];
  return <section className="review-panel">
    <h2>文章审查</h2>
    <div className="review-heading"><h3>AI 文本检测</h3><Tool label="审查设置" onClick={onSettings}><Settings2 size={16} /></Tool></div>
    <div className="review-actions">
      <Button size="1" loading={buttons.status("document") === "pending"} {...buttons.props("document", blocked)} onClick={() => void check("document")}>
        {buttons.label("document", "检测全文", "检测完成", "检测失败")}</Button>
      <Button size="1" variant="soft" color="gray" loading={buttons.status("selection") === "pending"}
        {...buttons.props("selection", blocked || !selectionEnabled || !hasSelection)} onClick={() => void check("selection")}>
        {buttons.label("selection", "检测选区", "检测完成", "检测失败")}</Button>
    </div>
    <p className="review-hint">不含代码、公式、表格与图片。</p>
    <ActionError error={error} />
    {!settings && !error && <p className="review-hint" role="status">正在读取设置…</p>}
    {settings && !enabled && <div className="review-empty"><p>请先配置朱雀文本检测。</p><Button size="1" variant="soft" onClick={onSettings}>前往设置</Button></div>}
    {enabled && !result && !busy && !stale && !error && <p className="review-hint">主动检测当前正文或选区。</p>}
    {busy && <p className="review-hint" role="status">正在检测当前快照…</p>}
    {stale && !busy && <p className="review-stale" role="status">正文已修改，请重新检测。</p>}
    {valid && <>
      <p className="review-hint">检测范围：{result.scope === "document" ? "全文正文" : "选区"}</p>
      <div className="review-ratios">{percentages.map(([label, ratio]) => <div key={label}><span>{label}</span><strong>{(ratio * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%</strong></div>)}</div>
      <label className="review-marks"><Checkbox checked={marks} onCheckedChange={value => {
        setMarks(value === true);
        if (value) editor?.showReview(result.snapshot, result.result.findings); else editor?.clearReview();
      }} />正文标记</label>
      <h3>待复核内容（{result.result.findings.length}）</h3>
      <div className="review-findings">{result.result.findings.map(finding => {
        const excerpt = finding.range ? result.snapshot.projection.text.slice(finding.range.from, finding.range.to) : "无法定位";
        const Icon = finding.category === "ai_generated" ? TriangleAlert : Diamond;
        return <button type="button" className="review-finding" key={finding.id} disabled={locked || !finding.range}
          title={`厂商置信度 ${(finding.confidence * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}
          onClick={() => { if (finding.range) onNavigate(result.snapshot, finding.range); }}>
          <span className={`review-category ${finding.category}`}><Icon size={12} />{finding.category === "ai_generated" ? "AI 生成" : "疑似 AI"}</span>
          <span className="review-excerpt">{excerpt.length > 100 ? `${excerpt.slice(0, 100)}…` : excerpt}</span>
        </button>;
      })}</div>
      <p className="review-metadata">{result.result.cacheHit ? "缓存命中，本次未发起请求" : result.result.chargedTokens === null ? "本次用量未知" : `本次扣减 ${result.result.chargedTokens.toLocaleString()} token`}<br />检测于 {new Date(result.result.checkedAt).toLocaleString()}</p>
    </>}
    {(result || stale) && <Button size="1" color="gray" variant="soft" title="跳过缓存，会额外消耗检测额度"
      loading={buttons.status("force") === "pending"} {...buttons.props("force", blocked || lastScope.current === "selection" && (!selectionEnabled || !hasSelection))}
      onClick={() => void check(lastScope.current, true)}>{buttons.label("force", "重新检测", "检测完成", "检测失败")}</Button>}
    {valid && <p className="review-hint review-disclaimer"><ClipboardCheck size={13} />检测结果仅供参考。</p>}
    <ReviewHistory key={articleId} articleId={articleId} revision={historyRevision + configurationRevision} disabled={locked || busy || feedbackLocked} onBusyChange={setCacheBusy} />
  </section>;
}
