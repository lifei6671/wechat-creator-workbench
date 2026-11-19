import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Select, Switch, TextField } from "@radix-ui/themes";
import { Cloud, DatabaseBackup, Eye, EyeOff, FolderInput, Keyboard, Plug, RefreshCw, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { desktop, errorMessage, macTitleBar, windowsTitleBar, type BackupTarget, type ImageSecret, type McpConfig, type McpStatus } from "../desktop";
import { commandKey } from "../labels";
import type { ViewMode } from "./Document";
import type { DocumentOpenMode } from "./preferences";

export type Appearance = "system" | "light" | "dark";
export type ViewShortcut = "none" | "shift-m" | "alt-v";

const groups = [
  { label: "工作区", items: [
    { id: "appearance", label: "通用", icon: SlidersHorizontal, keywords: `外观 应用主题 深色 浅色 系统 编辑视图 排版预览 显示资源导航 默认展开文档大纲 下载粘贴和链接导入的外链图片 链接 脚注 目录 点击文档 当前标签 新标签 加载方式 一次性加载 滚动分页 每页笔记数 关闭窗口 退出应用 托盘 菜单栏${windowsTitleBar ? " GPU 硬件加速 渲染" : ""}` },
    { id: "shortcuts", label: "快捷键", icon: Keyboard, keywords: "命令面板 切换编辑视图 查找与替换 全文搜索 保存版本 新建笔记" },
    { id: "migration", label: "工作区迁移", icon: FolderInput, keywords: "迁移包 新设备 数据转移 导入 导出 ZIP 素材 设置 恢复" },
  ] },
  { label: "服务", items: [
    { id: "model", label: "AI 代理", icon: Sparkles, keywords: "默认 AI 目标 本地代理 本地模型 自定义模型 Codex Claude Code Ollama LM Studio 供应商 接口地址 模型名 API 密钥 超时 摘要 标题 改写 OpenAI" },
    { id: "mcp", label: "MCP 服务", icon: Plug, keywords: "运行状态 端口 令牌权限 访问令牌 读写 本机地址 Codex Claude" },
  ] },
  { label: "存储", items: [
    { id: "sync", label: "同步", icon: RefreshCw, keywords: "多设备 自托管 服务地址 Cloudflare Docker VPS 设备名称 连接方式 认领密钥 接入密钥 恢复密钥 重装 合并 SETUP_SECRET" },
    { id: "images", label: "S3 图床", icon: Cloud, keywords: "素材 图片 公开访问地址 S3 端点 区域 桶名 对象前缀 访问密钥 ID 秘密访问密钥 R2" },
    { id: "backups", label: "数据库备份", icon: DatabaseBackup, keywords: "SQLite S3 R2 还原 恢复 备份桶 工作区 S3 端点 区域 桶名 对象前缀 访问密钥 ID 秘密访问密钥" },
  ] },
] as const;

export type SettingsPage = typeof groups[number]["items"][number]["id"];
const allPages = groups.flatMap(group => [...group.items]);
const deferredPages: readonly SettingsPage[] = ["images", "backups", "sync"];

function settingsSection(viewport: HTMLElement, page: SettingsPage) {
  return viewport.querySelector<HTMLElement>(`#settings-section-${page}`)!;
}

export function SettingsDialog({ initialPage, renderPage, status, toast, onClose }: {
  initialPage: SettingsPage;
  renderPage(page: SettingsPage): ReactNode;
  status?: string;
  toast?: ReactNode;
  onClose(): void;
}) {
  const [page, setPage] = useState(initialPage);
  const [loaded, setLoaded] = useState<SettingsPage[]>([initialPage]);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const choices = groups.map(group => ({ ...group, items: [...group.items].filter(item =>
    terms.every(term => `${group.label} ${item.label} ${item.keywords}`.toLowerCase().includes(term))) }));
  const first = choices.find(group => group.items.length)?.items[0];

  const attachScrollArea = useCallback((viewport: HTMLDivElement | null) => {
    if (!viewport) return;
    scrollArea.current = viewport;
    viewport.scrollTop = settingsSection(viewport, initialPage).offsetTop;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = deferredPages.find(id => entry.target.id === `settings-section-${id}`)!;
        observer.unobserve(entry.target);
        setLoaded(current => current.includes(id) ? current : [...current, id]);
      }
    }, { root: viewport });
    for (const id of deferredPages) {
      if (id !== initialPage) observer.observe(settingsSection(viewport, id));
    }
    return () => { observer.disconnect(); scrollArea.current = null; };
  }, [initialPage]);

  function select(next: SettingsPage) {
    const viewport = scrollArea.current!;
    const section = settingsSection(viewport, next);
    viewport.scrollTop = section.offsetTop;
    section.querySelector("h2")!.focus({ preventScroll: true });
    setPage(next);
  }

  function trackScroll(viewport: HTMLDivElement) {
    let current: SettingsPage = allPages[0].id;
    for (const { id } of allPages) {
      if (settingsSection(viewport, id).offsetTop > viewport.scrollTop + 1) break;
      current = id;
    }
    setPage(current);
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Content className="settings-dialog" maxWidth="912px" aria-describedby={undefined}
      onPointerDownOutside={event => event.preventDefault()}
      onEscapeKeyDown={event => { if (query) { event.preventDefault(); setQuery(""); search.current?.focus(); } }}
      onOpenAutoFocus={event => {
        event.preventDefault();
        if (initialPage === "appearance") search.current?.focus();
        else select(initialPage);
      }}>
      <header className="settings-window-header" data-mac-titlebar={macTitleBar || undefined}>
        <Dialog.Title className="settings-title">设置</Dialog.Title>
        {status && page !== "backups" && <span className="settings-header-status" role="status">{status}</span>}
        <Dialog.Close><button className="plain-button settings-close" type="button" aria-label="关闭设置"><X size={17} /></button></Dialog.Close>
      </header>
      <div className="settings-window-body">
        <div className="settings-sidebar">
          <div className="settings-search">
            <TextField.Root ref={search} value={query} onChange={event => setQuery(event.target.value)}
              aria-label="搜索设置" placeholder="搜索设置" onKeyDown={event => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229 && terms.length && first) {
                  event.preventDefault(); select(first.id);
                }
              }}>
              <TextField.Slot><Search size={15} /></TextField.Slot>
              {query && <TextField.Slot><button type="button" className="plain-button settings-search-clear" aria-label="清除搜索"
                onClick={() => { setQuery(""); search.current?.focus(); }}><X size={13} /></button></TextField.Slot>}
            </TextField.Root>
          </div>
          <nav aria-label="设置分类" className="settings-nav">
            {choices.map(group => group.items.length > 0 && <div className="settings-nav-group" key={group.label}>
              <div className="settings-nav-label">{group.label}</div>
              {group.items.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={id === page ? "location" : undefined}
                aria-controls={`settings-section-${id}`}
                className="plain-button settings-nav-item" onClick={() => select(id)}><Icon size={17} strokeWidth={1.75} /><span>{label}</span></button>)}
            </div>)}
            {!first && <p className="settings-no-results" role="status">没有匹配的设置</p>}
          </nav>
        </div>
        <div className="settings-pages" ref={attachScrollArea} onScroll={event => trackScroll(event.currentTarget)}>
          {allPages.map(({ id, label }) => <section className="settings-page" key={id} id={`settings-section-${id}`} aria-labelledby={`settings-${id}`}>
            <h2 id={`settings-${id}`} className="settings-page-title" tabIndex={-1}>{label}</h2>
            {!deferredPages.includes(id) || loaded.includes(id) ? renderPage(id)
              : <div className="settings-card"><p className="settings-feedback muted-text">正在读取设置…</p></div>}
          </section>)}
        </div>
      </div>
      {toast}
    </Dialog.Content>
  </Dialog.Root>;
}

export function SettingRow({ id, label, hint, warning, children }: {
  id?: string; label: string; hint?: string; warning?: string; children(hintId: string): ReactNode;
}) {
  const generatedId = useId();
  const hintId = id ? `${id}-hint` : generatedId;
  return <div className="setting-row"><div className="setting-copy">
    {id ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}
    {(hint || warning) && <span id={hintId} className="setting-hint">
      {hint}{warning && <> <span className="setting-warning">{warning}</span></>}
    </span>}
  </div><div className="setting-control">{children(hintId)}</div></div>;
}

export function readS3Settings(data: FormData) {
  const value = (name: string) => String(data.get(name) ?? "").trim();
  const accessKey = value("accessKey"), secretKey = value("secretKey");
  return {
    target: { endpoint: value("endpoint"), region: value("region"), bucket: value("bucket"), prefix: value("prefix") },
    publicBase: value("publicBase"),
    secret: accessKey || secretKey ? { accessKey, secretKey } : undefined,
  };
}

export function S3Fields({ scope, initial, hasKey, publicBase, credentials }: {
  scope: "images" | "backup";
  initial: BackupTarget | null;
  hasKey: boolean;
  publicBase?: string;
  credentials?: ImageSecret | null;
}) {
  const [showSecret, setShowSecret] = useState(false);
  return <>
    <SettingRow id={`${scope}-endpoint`} label="S3 端点" hint="用于连接存储服务的 API 地址。">
      {hintId => <TextField.Root id={`${scope}-endpoint`} aria-describedby={hintId} name="endpoint" type="url" required defaultValue={initial?.endpoint} />}
    </SettingRow>
    <SettingRow id={`${scope}-region`} label="区域" hint="使用服务商指定的区域代码。">
      {hintId => <TextField.Root id={`${scope}-region`} aria-describedby={hintId} name="region" required defaultValue={initial?.region} />}
    </SettingRow>
    <SettingRow id={`${scope}-bucket`} label="桶名" hint={scope === "images" ? "存放图床图片的存储桶。" : "存放数据库快照的存储桶。"}>
      {hintId => <TextField.Root id={`${scope}-bucket`} aria-describedby={hintId} name="bucket" required defaultValue={initial?.bucket} />}
    </SettingRow>
    <SettingRow id={`${scope}-prefix`} label="对象前缀" hint="给桶内的对象添加路径前缀，可留空。">
      {hintId => <TextField.Root id={`${scope}-prefix`} aria-describedby={hintId} name="prefix" defaultValue={initial?.prefix} />}
    </SettingRow>
    {scope === "images" && <SettingRow id="images-public" label="公开访问地址" hint="生成可在公众号等外部页面访问的图片链接。">
      {hintId => <TextField.Root id="images-public" aria-describedby={hintId} name="publicBase" type="url" required defaultValue={publicBase} />}
    </SettingRow>}
    <SettingRow id={`${scope}-access`} label="访问密钥 ID" hint="指定用于连接存储桶的访问凭据。">
      {hintId => <TextField.Root id={`${scope}-access`} aria-describedby={hintId} name="accessKey" type={scope === "images" ? "text" : "password"}
        autoComplete="off" required={!hasKey} defaultValue={credentials?.accessKey} placeholder={hasKey ? "已保存" : undefined} />}
    </SettingRow>
    <SettingRow id={`${scope}-secret`} label="秘密访问密钥" hint="与访问密钥 ID 配对，用于签名存储请求。">
      {hintId => <TextField.Root id={`${scope}-secret`} aria-describedby={hintId} name="secretKey" type={showSecret ? "text" : "password"}
        autoComplete="off" required={!hasKey} defaultValue={credentials?.secretKey} placeholder={hasKey ? "已保存" : undefined}>
        {scope === "images" && <TextField.Slot><button type="button" className="plain-button" aria-label={showSecret ? "隐藏秘密访问密钥" : "显示秘密访问密钥"}
          onClick={() => setShowSecret(value => !value)}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button></TextField.Slot>}
      </TextField.Root>}
    </SettingRow>
  </>;
}

function NativeToggleSetting({ id, label, hint, warning, preference }: {
  id: string; label: string; hint: string; warning?: string; preference(enabled?: boolean): Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void preference().then(value => {
      if (current) setEnabled(value);
    }, failure => {
      if (current) setError(errorMessage(failure));
    });
    return () => { current = false; };
  }, [preference]);

  async function save(value: boolean) {
    setSaving(true);
    setError("");
    try {
      setEnabled(await preference(value));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <SettingRow id={id} label={label} hint={hint} warning={warning}>
      {hintId => <Switch id={id} aria-describedby={hintId} radius="full"
        checked={enabled === true} disabled={enabled === null || saving} onCheckedChange={save} />}
    </SettingRow>
    {error && <p className="settings-feedback inline-error" role="alert">{error}</p>}
  </>;
}

export function WorkspaceSettings({ page, appearance, shortcut, preferredView, explorer, downloadPastedImages, convertLinks, defaultOutline, documentOpenMode, folderLoading, folderPageSize,
  onAppearance, onShortcut, onView, onExplorer, onDownloadPastedImages, onConvertLinks, onDefaultOutline, onDocumentOpenMode, onFolderLoading, onFolderPageSize }: {
  page: "appearance" | "shortcuts";
  appearance: Appearance;
  shortcut: ViewShortcut;
  preferredView: ViewMode;
  downloadPastedImages: boolean;
  convertLinks: boolean;
  defaultOutline: boolean;
  documentOpenMode: DocumentOpenMode;
  folderLoading: "all" | "paged";
  folderPageSize: number;
  explorer: boolean;
  onAppearance(value: Appearance): void;
  onShortcut(value: ViewShortcut): void;
  onView(value: ViewMode): void;
  onDownloadPastedImages(value: boolean): void;
  onConvertLinks(value: boolean): void;
  onDefaultOutline(value: boolean): void;
  onDocumentOpenMode(value: DocumentOpenMode): void;
  onFolderLoading(value: "all" | "paged"): void;
  onFolderPageSize(value: number): void;
  onExplorer(value: boolean): void;
}) {
  if (page === "appearance") return <>
    <div className="settings-card">
      <SettingRow id="appearance-mode" label="应用主题" hint="设置工作台的浅色或深色外观，也可跟随系统。">
        {hintId => <Select.Root size="2" value={appearance} onValueChange={value => onAppearance(value as Appearance)}>
          <Select.Trigger id="appearance-mode" aria-describedby={hintId} />
          <Select.Content><Select.Item value="system">跟随系统</Select.Item><Select.Item value="light">浅色</Select.Item><Select.Item value="dark">深色</Select.Item></Select.Content>
        </Select.Root>}
      </SettingRow>
      <SettingRow id="explorer-visibility" label="显示资源导航" hint="设置启动时是否显示左侧栏。">
        {hintId => <Switch id="explorer-visibility" aria-describedby={hintId} radius="full" checked={explorer} onCheckedChange={onExplorer} />}
      </SettingRow>
      {(windowsTitleBar || macTitleBar) && <NativeToggleSetting id="close-to-tray"
        label={macTitleBar ? "关闭时收起到菜单栏" : "关闭时收起到托盘"}
        hint={macTitleBar
          ? "从菜单栏图标恢复窗口。停用此设置后，点击关闭按钮会保存并退出应用。"
          : "从任务栏通知区域的图标恢复窗口。停用此设置后，点击关闭按钮会保存并退出应用。"}
        preference={desktop.closeToTray} />}
      {windowsTitleBar && <NativeToggleSetting id="gpu-acceleration" label="硬件加速"
        hint="启用后由 GPU 加速界面渲染，让滚动与界面切换更流畅。重启工作台后生效。"
        warning="关闭后将使用软件渲染，界面可能明显变慢。"
        preference={desktop.gpuAcceleration} />}
    </div>
    <div className="settings-group-title">编辑与预览</div>
    <div className="settings-card">
      <SettingRow id="preferred-view" label="编辑视图" hint="选择工作台默认使用编辑或公众号排版预览。">
        {hintId => <Select.Root size="2" value={preferredView} onValueChange={value => onView(value as ViewMode)}>
          <Select.Trigger id="preferred-view" aria-describedby={hintId} /><Select.Content>
            <Select.Item value="edit">编辑</Select.Item><Select.Item value="preview">排版预览</Select.Item>
          </Select.Content>
        </Select.Root>}
      </SettingRow>
      <SettingRow id="default-document-outline" label="默认展开文档大纲" hint="可在「更多编辑操作」中单独设置当前文档的大纲。">
        {hintId => <Switch id="default-document-outline" aria-describedby={hintId} radius="full" checked={defaultOutline} onCheckedChange={onDefaultOutline} />}
      </SettingRow>
      <SettingRow id="download-pasted-images" label="下载粘贴和链接导入的外链图片" hint="将外链图片保存到本地素材库，已配置图床的图片保留原链接。">
        {hintId => <Switch id="download-pasted-images" aria-describedby={hintId} radius="full" checked={downloadPastedImages} onCheckedChange={onDownloadPastedImages} />}
      </SettingRow>
      <SettingRow id="links-to-footnotes" label="链接转脚注" hint="默认将正文中的外部链接显示为文末参考脚注。">
        {hintId => <Switch id="links-to-footnotes" aria-describedby={hintId} radius="full" checked={convertLinks} onCheckedChange={onConvertLinks} />}
      </SettingRow>
    </div>
    <div className="settings-group-title">目录</div>
    <div className="settings-card">
      <SettingRow id="document-open-mode" label="点击文档" hint="决定点击列表中的文档时，复用当前标签还是另开一个标签。">
        {hintId => <Select.Root size="2" value={documentOpenMode}
          onValueChange={value => onDocumentOpenMode(value === "new-tab" ? "new-tab" : "current")}>
          <Select.Trigger id="document-open-mode" aria-describedby={hintId} />
          <Select.Content>
            <Select.Item value="current">在当前标签打开</Select.Item>
            <Select.Item value="new-tab">在新标签打开</Select.Item>
          </Select.Content>
        </Select.Root>}
      </SettingRow>
      <SettingRow id="folder-loading" label="加载方式" hint="展开目录时一次加载全部笔记，或随滚动分批加载。">
        {hintId => <Select.Root size="2" value={folderLoading} onValueChange={value => onFolderLoading(value as typeof folderLoading)}>
          <Select.Trigger id="folder-loading" aria-describedby={hintId} />
          <Select.Content><Select.Item value="all">一次性加载</Select.Item><Select.Item value="paged">滚动分页</Select.Item></Select.Content>
        </Select.Root>}
      </SettingRow>
      <SettingRow id="folder-page-size" label="每页笔记数" hint="仅在滚动分页时生效，控制每批加载的数量。">
        {hintId => <Select.Root size="2" value={String(folderPageSize)} disabled={folderLoading === "all"} onValueChange={value => onFolderPageSize(Number(value))}>
          <Select.Trigger id="folder-page-size" aria-describedby={hintId} />
          <Select.Content>{[20, 40, 60, 100, 200].map(size => <Select.Item key={size} value={String(size)}>{size}</Select.Item>)}</Select.Content>
        </Select.Root>}
      </SettingRow>
    </div>
  </>;
  return <>
    <div className="settings-card">
      <SettingRow id="view-shortcuts" label="切换编辑视图" hint="设置在编辑与排版预览之间切换的快捷键。">
        {hintId => <Select.Root size="2" value={shortcut} onValueChange={value => onShortcut(value as ViewShortcut)}>
          <Select.Trigger id="view-shortcuts" aria-describedby={hintId} />
          <Select.Content><Select.Item value="none">未设置</Select.Item><Select.Item value="shift-m">{commandKey}Shift+M</Select.Item><Select.Item value="alt-v">{commandKey}Alt+V</Select.Item></Select.Content>
        </Select.Root>}
      </SettingRow>
    </div>
    <div className="settings-group-title">工作区操作</div>
    <dl className="settings-card shortcut-list">
        <div><dt>命令面板</dt><dd><kbd>{commandKey}K</kbd></dd></div>
        <div><dt>新建笔记</dt><dd><kbd>{commandKey}N</kbd></dd></div>
        <div><dt>保存版本</dt><dd><kbd>{commandKey}S</kbd></dd></div>
        <div><dt>全文搜索</dt><dd><kbd>{commandKey}Shift+F</kbd></dd></div>
        <div><dt>查找与替换</dt><dd><kbd>{commandKey}F</kbd></dd></div>
    </dl>
  </>;
}

export function McpSettings({ status, loadError, onStatus }: { status?: McpStatus; loadError: string; onStatus(status: McpStatus): void }) {
  const [port, setPort] = useState<string>();
  const [permission, setPermission] = useState<McpConfig["permission"]>();
  const [busy, setBusy] = useState<"save" | "stop" | "address" | "token" | "reset" | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  async function perform(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError("");
    setFeedback("");
    try { await action(); }
    catch (failure) {
      setError(errorMessage(failure));
      if (kind === "save" || kind === "stop") {
        try { onStatus(await desktop.mcpStatus()); }
        catch (refreshError) { setError(`${errorMessage(failure)}。无法读取服务状态：${errorMessage(refreshError)}`); }
      }
    }
    finally { setBusy(null); }
  }

  const address = status?.running ? `http://127.0.0.1:${status.config.port}/mcp` : "";
  const portValue = port ?? String(status?.config.port ?? "");
  const permissionValue = permission ?? status?.config.permission ?? "read";
  const apply = () => perform("save", async () => {
    const current = await desktop.saveMcp({ port: Number(portValue), permission: permissionValue, enabled: true });
    onStatus(current);
    setFeedback("设置已保存");
  });
  const failure = error || loadError || status?.error;
  return <form className="settings-card mcp-settings" onSubmit={event => { event.preventDefault(); void apply(); }}>
    <SettingRow label="运行状态" hint="显示本机 MCP 服务是否可供客户端连接。">
      {hintId => <span className="settings-state" data-running={status?.running} role="status" aria-describedby={hintId}>
        {!status ? "正在读取设置…" : status.running ? `运行中，${status.config.permission === "read" ? "只读" : "读写"}` : "已停止"}
      </span>}
    </SettingRow>
    <SettingRow id="mcp-port" label="端口" hint="客户端通过此端口连接 MCP 服务。">
      {hintId => <TextField.Root id="mcp-port" aria-describedby={hintId} type="number" min="1" max="65535" required
        disabled={!status} value={portValue} onChange={event => setPort(event.target.value)} />}
    </SettingRow>
    <SettingRow id="mcp-permission" label="令牌权限" hint="只读权限允许客户端查阅工作区内容。"
      warning="选择读写后，客户端可以通过 MCP 修改工作区内容。">
      {hintId => <Select.Root value={permissionValue} disabled={!status} onValueChange={value => setPermission(value as McpConfig["permission"])}>
        <Select.Trigger id="mcp-permission" aria-describedby={hintId} />
        <Select.Content><Select.Item value="read">只读</Select.Item><Select.Item value="write">读写</Select.Item></Select.Content>
      </Select.Root>}
    </SettingRow>
    <SettingRow id="mcp-address" label="本机地址" hint="将此地址填入 MCP 客户端的连接配置。">
      {hintId => <div className="mcp-address">
        <TextField.Root id="mcp-address" aria-describedby={hintId} readOnly value={address} disabled={!status?.running} />
        <Button type="button" aria-describedby={hintId} variant="soft" color="gray" loading={busy === "address"} disabled={!status?.running || busy !== null}
          onClick={() => void perform("address", async () => { await desktop.copyText(address); setFeedback("已复制本机地址"); })}>复制地址</Button>
      </div>}
    </SettingRow>
    <SettingRow label="访问令牌" hint="用于验证连接到 MCP 的客户端。"
      warning="重置后，使用旧令牌的客户端需要更新配置。">
      {hintId => <div className="button-strip setting-actions">
        <Button type="button" aria-describedby={hintId} variant="soft" color="gray" loading={busy === "token"} disabled={!status || busy !== null}
          onClick={() => void perform("token", async () => { await desktop.mcpToken(false); setFeedback("已复制令牌"); })}>复制令牌</Button>
        <Button type="button" aria-describedby={hintId} variant="ghost" color="gray" loading={busy === "reset"} disabled={!status || status.running || busy !== null}
          onClick={() => void perform("reset", async () => { await desktop.mcpToken(true); setFeedback("令牌已重置并复制"); })}>重置令牌</Button>
      </div>}
    </SettingRow>
    <div className="settings-footer mcp-footer">
      <div className="mcp-feedback">
        <span role="status" className="muted-text">{failure ? "" : feedback}</span>
        {failure && <span role="alert" className="inline-error">{failure}</span>}
      </div>
      <Button type="button" variant="soft" color="gray" data-available={Boolean(status?.config.enabled)}
        loading={busy === "stop"} disabled={!status?.config.enabled || busy !== null}
        onClick={() => void perform("stop", async () => {
          if (status) onStatus(await desktop.saveMcp({ ...status.config, enabled: false }));
        })}>停止 MCP</Button>
      <Button type="submit" className="mcp-submit" loading={busy === "save"} disabled={!status || busy !== null}>
        {status?.running ? "保存设置" : "启用 MCP"}
      </Button>
    </div>
  </form>;
}
