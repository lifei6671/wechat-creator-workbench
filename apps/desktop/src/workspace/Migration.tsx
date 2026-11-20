import { useSettingsButtonFeedback } from "./settings-button-feedback";
import { Button } from "@radix-ui/themes";
import { SettingRow } from "./Settings";

export function MigrationPanel({ busy, working, feedback, prepared, onTransfer, onConfirmRestore, onDiscardRestore }: {
  busy: boolean;
  working: "export" | "import" | null;
  feedback: { error: boolean; text: string } | null;
  prepared: boolean;
  onTransfer(action: "export" | "import"): Promise<boolean | undefined>;
  onConfirmRestore(): void;
  onDiscardRestore(): void;
}) {
  const buttons = useSettingsButtonFeedback();
  async function transfer(action: "export" | "import") {
    buttons.start(action);
    const result = await onTransfer(action);
    if (result !== undefined) buttons.finish(action, result);
  }
  return <div className="settings-card">
    <SettingRow label="工作区迁移包" hint="包含数据库、本地素材和工作区配置。系统凭据需在新设备重新填写。">
      {hintId => <div className="button-strip setting-actions">
        <Button variant="soft" aria-describedby={hintId} disabled={busy} loading={working === "export"} onClick={() => void transfer("export")}>{buttons.label("export", "导出迁移包", "导出成功", "导出失败")}</Button>
        <Button variant="soft" aria-describedby={hintId} disabled={busy} loading={working === "import"} onClick={() => void transfer("import")}>{buttons.label("import", "导入迁移包", "校验完成", "导入失败")}</Button>
      </div>}
    </SettingRow>
    {feedback?.error && <p className={`settings-feedback ${feedback.error ? "inline-error" : "muted-text"}`}
      role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
    {prepared && <SettingRow label="已校验的迁移包" hint="已通过数据库和素材完整性校验。"
      warning="恢复将用迁移包中的数据库和本地素材替换当前工作区的数据。">
      {hintId => <div className="button-strip setting-actions">
        <Button id="migration-restore-trigger" aria-describedby={hintId} size="1" variant="soft" disabled={busy} onClick={onConfirmRestore}>确认恢复</Button>
        <Button size="1" variant="ghost" color="gray" disabled={busy} onClick={onDiscardRestore}>取消</Button>
      </div>}
    </SettingRow>}
  </div>;
}
