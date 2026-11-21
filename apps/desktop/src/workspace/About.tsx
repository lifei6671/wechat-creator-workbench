import { useEffect, useState } from "react";
import { Button } from "@radix-ui/themes";
import { ExternalLink } from "lucide-react";
import { desktop, errorMessage, type AppInfo, type AppUpdateStatus } from "../desktop";
import { useSettingsButtonFeedback } from "./settings-button-feedback";
import appIcon from "../../../../src-tauri/icons/128x128.png";

const repository = "https://github.com/lifei6671/wechat-creator-workbench";
const coreComponents = [
  ["tauri", "Tauri"],
  ["react", "React"],
  ["@milkdown/core", "Milkdown"],
  ["@radix-ui/themes", "Radix UI"],
  ["@xyflow/react", "React Flow"],
  ["@assistant-ui/react", "assistant-ui"],
  ["rusqlite", "rusqlite"],
];
export interface OpenSourceComponent {
  name: string; version: string; ecosystem: string; license: string; url: string; text: string;
}
export interface LicenseManifest { components: OpenSourceComponent[]; notices: string }
const initialUpdate: AppUpdateStatus = { phase: "idle", version: null, downloaded: 0, total: null, error: null };
const platforms: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
const architectures: Record<string, string> = { x86_64: "x64", aarch64: "ARM64" };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function AboutPage({ onInstall }: { onInstall(): Promise<void> }) {
  const [info, setInfo] = useState<AppInfo>();
  const [update, setUpdate] = useState(initialUpdate);
  const [licenses, setLicenses] = useState<LicenseManifest>();
  const [error, setError] = useState("");
  const [licenseError, setLicenseError] = useState("");
  const [working, setWorking] = useState("");
  const buttons = useSettingsButtonFeedback();
  useEffect(() => {
    let live = true;
    let received = false;
    const listening = desktop.onAppUpdateChanged(state => {
      received = true;
      if (live) { setUpdate(state); setError(""); }
    });
    void listening.then(async () => {
      const [metadata, status] = await Promise.all([desktop.appInfo(), desktop.appUpdateStatus()]);
      if (live) { setInfo(metadata); if (!received) setUpdate(status); }
    }).catch(failure => { if (live) setError(errorMessage(failure)); });
    void fetch("/licenses.json").then(async response => {
      if (!response.ok) throw new Error("无法读取开源组件清单");
      return response.json() as Promise<LicenseManifest>;
    }).then(value => { if (live) setLicenses(value); }, failure => { if (live) setLicenseError(errorMessage(failure)); });
    return () => { live = false; void listening.then(unlisten => unlisten(), () => {}); };
  }, []);

  async function perform(action: string, operation: () => Promise<unknown>) {
    if (!buttons.start(action)) return;
    setWorking(action); setError("");
    try { await operation(); buttons.finish(action, true); }
    catch (failure) { setError(errorMessage(failure)); buttons.finish(action, false); }
    finally { setWorking(""); }
  }
  const busy = Boolean(working) || ["checking", "downloading", "installing"].includes(update.phase);
  const stateText = update.phase === "checking" ? "正在检查更新…"
    : update.phase === "current" ? "已是最新版本"
      : update.phase === "available" ? `发现新版本 ${update.version}`
        : update.phase === "downloading" ? `正在下载 ${size(update.downloaded)}${update.total ? ` / ${size(update.total)}` : ""}`
          : update.phase === "ready" ? `${update.version} 已准备就绪`
            : update.phase === "installing" ? "正在保存并准备更新…" : "";
  const entries = coreComponents.flatMap(([name, label]) =>
    licenses?.components.filter(item => item.name === name).map(item => ({ ...item, label })) ?? []);
  const link = (label: string, url: string) => <button type="button" className="plain-button about-link"
    {...buttons.props(`open:${url}`)} onClick={() => void perform(`open:${url}`, () => desktop.openLink(url))}>
    {label}{buttons.icon(`open:${url}`, <ExternalLink size={14} />, 14)}</button>;

  return <div className="about-page">
    <header className="about-identity">
      <img src={appIcon} width="56" height="56" alt="" />
      <div><h3>微信创作工作台</h3>
        <p className="about-version">{info ? `版本 ${info.version}` : "正在读取版本…"}</p>
        {info && <p className="muted-text">{platforms[info.platform] ?? info.platform} {architectures[info.arch] ?? info.arch}</p>}
      </div>
    </header>
    <section className="about-update" aria-label="应用更新">
      <div className="about-update-row">
        <span role="status" aria-live="polite">{stateText || (info?.updatesEnabled === false ? "当前构建未配置更新签名" : "应用更新")}</span>
        {update.phase === "available" || update.phase === "downloading" ? <Button size="2" variant="soft" color="gray" loading={busy}
           onClick={() => void perform("download", async () => setUpdate(await desktop.appUpdateDownload()))} {...buttons.props("download", busy)}>
          {buttons.label("download", "下载更新", "下载完成", "下载失败")}</Button>
          : update.phase === "ready" || update.phase === "installing" ? <Button size="2" loading={busy} {...buttons.props("install", busy)}
            onClick={() => void perform("install", onInstall)}>{buttons.label("install", info?.platform === "macos" ? "安装并重启" : "退出并安装", "安装已启动")}</Button>
            : <Button size="2" variant="soft" color="gray" loading={busy}
              onClick={() => void perform("check", async () => setUpdate(await desktop.appUpdateCheck()))} {...buttons.props("check", busy || !info?.updatesEnabled)}>
              {buttons.label("check", "检查更新", "检查完成", "检查失败")}</Button>}
      </div>
      {update.phase === "downloading" && <progress aria-label="更新下载进度" max={update.total ?? undefined}
        value={update.total ? update.downloaded : undefined} />}
      {<div className="action-error-slot" tabIndex={((error || update.error)) ? 0 : -1}>{(error || update.error) ? <p className="inline-error" role="alert">{error || update.error}</p> : null}</div>}
      {update.version && link("新版本发布说明", `${repository}/releases/tag/v${update.version}`)}
    </section>
    <div className="about-links">
      {link("项目仓库", repository)}
      {info && link("当前版本发布说明", `${repository}/releases/tag/v${info.version}`)}
    </div>
    <section className="about-components" aria-labelledby="about-components-title">
      <div className="about-components-heading"><h3 id="about-components-title">核心开源组件</h3></div>
      {licenseError ? <p className="inline-error" role="alert">{licenseError}</p> : !licenses ? <p role="status">正在读取组件…</p> : <>
        <ul className="about-component-list">
          {entries.map(item => <li key={`${item.ecosystem}:${item.name}:${item.version}`}>
            <details><summary><span className="about-component-name">{item.label}</span><span className="about-component-version">{item.version}</span>
              <span className="muted-text">{item.ecosystem}</span></summary>
              <div className="about-license"><span>{item.license}</span>{item.url && link("项目地址", item.url)}<pre>{item.text}</pre></div>
            </details>
          </li>)}
        </ul>
      </>}
    </section>
  </div>;
}
