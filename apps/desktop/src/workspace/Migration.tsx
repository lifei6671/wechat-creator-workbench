import { Button } from "@radix-ui/themes";
import { SettingRow } from "./Settings";

export function MigrationPanel({ busy, working, feedback, prepared, onTransfer, onConfirmRestore, onDiscardRestore }: {
  busy: boolean;
  working: "export" | "import" | null;
  feedback: { error: boolean; text: string } | null;
  prepared: boolean;
  onTransfer(action: "export" | "import"): void;
  onConfirmRestore(): void;
  onDiscardRestore(): void;
}) {
  return <div className="settings-card">
    <SettingRow label="工作区迁移包" hint="包含数据库、本地素材和工作区配置。系统凭据需在新设备重新填写。">
      <div className="button-strip setting-actions">
        <Button variant="soft" disabled={busy} loading={working === "export"} onClick={() => onTransfer("export")}>导出迁移包</Button>
        <Button variant="soft" disabled={busy} loading={working === "import"} onClick={() => onTransfer("import")}>导入迁移包</Button>
      </div>
    </SettingRow>
    {feedback && <p className={`settings-feedback ${feedback.error ? "inline-error" : "muted-text"}`}
      role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
    {prepared && <SettingRow label="已校验的迁移包" hint="已通过数据库和素材完整性校验。">
      <div className="button-strip setting-actions">
        <Button id="migration-restore-trigger" size="1" variant="soft" disabled={busy} onClick={onConfirmRestore}>确认恢复</Button>
        <Button size="1" variant="ghost" color="gray" disabled={busy} onClick={onDiscardRestore}>取消</Button>
      </div>
    </SettingRow>}
  </div>;
}
