import { useLayoutEffect, useRef, useState } from "react";
import { Button, Switch, TextField } from "@radix-ui/themes";
import { desktop, errorMessage, type ReviewSettings as Configuration, type ReviewUsage } from "../desktop";
import { ActionError, useButtonFeedback } from "../button-feedback";
import { SettingRow } from "./Settings";

export function ReviewSettings({ onSaved }: { onSaved(): void }) {
  const [settings, setSettings] = useState<Configuration>();
  const [enabled, setEnabled] = useState(false);
  const [key, setKey] = useState("");
  const [usage, setUsage] = useState<ReviewUsage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const alive = useRef(false);
  const buttons = useButtonFeedback();
  useLayoutEffect(() => {
    alive.current = true;
    void Promise.all([desktop.reviewSettings(), desktop.reviewUsage()]).then(([config, totals]) => {
      if (alive.current) { setSettings(config); setEnabled(config.enabled); setUsage(totals); }
    }, failure => { if (alive.current) setError(errorMessage(failure)); });
    return () => { alive.current = false; };
  }, []);
  const blocked = busy || ["save", "delete", "test", "clear"].some(action => buttons.isLocked(action));

  async function run(action: string, operation: () => Promise<void>) {
    if (running.current || blocked || !buttons.start(action)) return;
    running.current = true; setBusy(true); setError("");
    try { await operation(); buttons.finish(action, true); }
    catch (failure) { if (alive.current) setError(errorMessage(failure)); buttons.finish(action, false); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function save(apiKey?: string) {
    const config = await desktop.saveReviewSettings(enabled, apiKey);
    if (!alive.current) return;
    setSettings(config); setKey(""); onSaved();
  }

  return <form className="settings-card review-settings" onSubmit={event => { event.preventDefault(); void run("save", () => save(key.trim() || undefined)); }}>
    <SettingRow id="review-enabled" label="朱雀文本检测" hint="仅主动检测时将正文或选区发送给腾讯。结果仅供参考。">
      {hintId => <Switch id="review-enabled" radius="full" aria-describedby={hintId} checked={enabled} disabled={!settings || blocked} onCheckedChange={setEnabled} />}
    </SettingRow>
    <SettingRow id="review-key" label="API Key" hint={settings ? settings.hasKey ? "已配置" : "未配置" : "正在读取设置…"}>
      {hintId => <TextField.Root id="review-key" type="password" autoComplete="off" placeholder="输入新密钥以替换" aria-describedby={hintId}
        disabled={!settings || blocked} value={key} onChange={event => setKey(event.target.value)} />}
    </SettingRow>
    <div className="setting-description" data-error={error ? true : undefined}>
      <span className="setting-hint" aria-hidden={error ? true : undefined}>连接测试发送固定样本，会消耗检测额度。</span>
      <ActionError error={error} />
    </div>
    <div className="settings-footer">
      <Button type="button" color="red" variant="soft" loading={buttons.status("delete") === "pending"}
        {...buttons.props("delete", blocked || !settings?.hasKey)} onClick={() => void run("delete", () => save(""))}>
        {buttons.label("delete", "删除", "已删除", "删除失败")}</Button>
      <Button type="button" color="gray" variant="soft" loading={buttons.status("test") === "pending"}
        {...buttons.props("test", blocked || !settings || (!key.trim() && !settings.hasKey))} onClick={() => void run("test", async () => {
          const result = await desktop.reviewTestConnection(key.trim() || undefined);
          const totals = await desktop.reviewUsage();
          if (alive.current) { setUsage(totals); if (result.persistenceError) setError(result.persistenceError); }
        })}>{buttons.label("test", "测试连接", "连接成功", "连接失败")}</Button>
      <Button type="submit" loading={buttons.status("save") === "pending"} {...buttons.props("save", !settings || blocked)}>
        {buttons.label("save", "保存设置", "已保存", "保存失败")}</Button>
    </div>
    {usage && <div className="setting-row"><div className="setting-copy"><span>本机用量</span>
      <span className="setting-hint review-usage">{usage.month}（UTC 月）已观测扣减 {usage.knownTokens.toLocaleString()} token<br />
      成功调用 {usage.successfulCalls.toLocaleString()} 次，其中 {usage.unknownCalls.toLocaleString()} 次用量未知<br />
      缓存命中 {usage.cacheHits.toLocaleString()} 次</span></div></div>}
    <SettingRow label="结果缓存" hint="保留 30 天，仅此工作区可用。">
      {() => <Button type="button" color="gray" variant="soft" loading={buttons.status("clear") === "pending"}
        {...buttons.props("clear", blocked || !settings)} onClick={() => void run("clear", () => desktop.reviewClearCache())}>
        {buttons.label("clear", "清理缓存", "已清理", "清理失败")}</Button>}
    </SettingRow>
  </form>;
}
