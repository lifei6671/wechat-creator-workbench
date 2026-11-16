import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Select, Switch, TextField } from "@radix-ui/themes";
import { Cloud, DatabaseBackup, Eye, EyeOff, FolderInput, Keyboard, Plug, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { desktop, errorMessage, type BackupTarget, type ImageSecret, type McpConfig, type McpStatus } from "../desktop";
import { commandKey } from "../labels";
import type { ViewMode } from "./Document";

export type Appearance = "system" | "light" | "dark";
export type ViewShortcut = "none" | "shift-m" | "alt-v";

const groups = [
  { label: "工作区", items: [
    { id: "appearance", label: "通用", icon: SlidersHorizontal, keywords: "外观 应用主题 深色 浅色 系统 编辑视图 排版预览 显示资源导航 下载粘贴内容中的外链图片 链接 脚注 目录 加载方式 一次性加载 滚动分页 每页笔记数" },
    { id: "shortcuts", label: "快捷键", icon: Keyboard, keywords: "命令面板 切换编辑视图 查找与替换 全文搜索 保存版本 新建笔记" },
    { id: "migration", label: "工作区迁移", icon: FolderInput, keywords: "迁移包 新设备 数据转移 导入 导出 ZIP 素材 设置 恢复" },
  ] },
  { label: "服务", items: [
    { id: "model", label: "AI 代理", icon: Sparkles, keywords: "默认 AI 目标 本地代理 本地模型 自定义模型 Codex Claude Code Ollama LM Studio 供应商 接口地址 模型名 API 密钥 超时 摘要 标题 改写 OpenAI" },
    { id: "mcp", label: "MCP 服务", icon: Plug, keywords: "运行状态 端口 令牌权限 访问令牌 读写 本机地址 Codex Claude" },
  ] },
  { label: "存储", items: [
    { id: "images", label: "S3 图床", icon: Cloud, keywords: "素材 图片 公开访问地址 S3 端点 区域 桶名 对象前缀 访问密钥 ID 秘密访问密钥 R2" },
    { id: "backups", label: "数据库备份", icon: DatabaseBackup, keywords: "SQLite S3 R2 还原 恢复 备份桶 工作区 S3 端点 区域 桶名 对象前缀 访问密钥 ID 秘密访问密钥" },
  ] },
] as const;

export type SettingsPage = typeof groups[number]["items"][number]["id"];
const allPages = groups.flatMap(group => [...group.items]);
const deferredPages = ["images", "backups"] as const;

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
      <header className="settings-window-header">
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
            {(id !== "images" && id !== "backups") || loaded.includes(id) ? renderPage(id)
              : <div className="settings-card"><p className="settings-feedback muted-text">正在读取设置…</p></div>}
          </section>)}
        </div>
      </div>
      {toast}
    </Dialog.Content>
  </Dialog.Root>;
}

export function SettingRow({ id, label, hint, children }: { id?: string; label: string; hint?: string; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-copy">
    {id ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}
    {hint && <span className="setting-hint">{hint}</span>}
  </div><div className="setting-control">{children}</div></div>;
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
    <SettingRow id={`${scope}-endpoint`} label="S3 端点" hint="用于连接存储服务的 API 地址。"><TextField.Root id={`${scope}-endpoint`} name="endpoint" type="url" required defaultValue={initial?.endpoint} /></SettingRow>
    <SettingRow id={`${scope}-region`} label="区域" hint="使用服务商指定的区域代码。"><TextField.Root id={`${scope}-region`} name="region" required defaultValue={initial?.region} /></SettingRow>
    <SettingRow id={`${scope}-bucket`} label="桶名" hint={scope === "images" ? "存放图床图片的存储桶。" : "存放数据库快照的存储桶。"}><TextField.Root id={`${scope}-bucket`} name="bucket" required defaultValue={initial?.bucket} /></SettingRow>
    <SettingRow id={`${scope}-prefix`} label="对象前缀" hint="给桶内的对象添加路径前缀，可留空。"><TextField.Root id={`${scope}-prefix`} name="prefix" defaultValue={initial?.prefix} /></SettingRow>
    {scope === "images" && <SettingRow id="images-public" label="公开访问地址" hint="生成可在公众号等外部页面访问的图片链接。"><TextField.Root id="images-public" name="publicBase" type="url" required defaultValue={publicBase} /></SettingRow>}
    <SettingRow id={`${scope}-access`} label="访问密钥 ID" hint="指定用于连接存储桶的访问凭据。"><TextField.Root id={`${scope}-access`} name="accessKey" type={scope === "images" ? "text" : "password"} autoComplete="off"
      required={!hasKey} defaultValue={credentials?.accessKey} placeholder={hasKey ? "已保存" : undefined} /></SettingRow>
    <SettingRow id={`${scope}-secret`} label="秘密访问密钥" hint="与访问密钥 ID 配对，用于签名存储请求。"><TextField.Root id={`${scope}-secret`} name="secretKey" type={showSecret ? "text" : "password"} autoComplete="off"
      required={!hasKey} defaultValue={credentials?.secretKey} placeholder={hasKey ? "已保存" : undefined}>
      {scope === "images" && <TextField.Slot><button type="button" className="plain-button" aria-label={showSecret ? "隐藏秘密访问密钥" : "显示秘密访问密钥"}
        onClick={() => setShowSecret(value => !value)}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button></TextField.Slot>}
    </TextField.Root></SettingRow>
  </>;
}

export function WorkspaceSettings({ page, appearance, shortcut, preferredView, explorer, downloadPastedImages, convertLinks, folderLoading, folderPageSize,
  onAppearance, onShortcut, onView, onExplorer, onDownloadPastedImages, onConvertLinks, onFolderLoading, onFolderPageSize }: {
  page: "appearance" | "shortcuts";
  appearance: Appearance;
  shortcut: ViewShortcut;
  preferredView: ViewMode;
  downloadPastedImages: boolean;
  convertLinks: boolean;
  folderLoading: "all" | "paged";
  folderPageSize: number;
  explorer: boolean;
  onAppearance(value: Appearance): void;
  onShortcut(value: ViewShortcut): void;
  onView(value: ViewMode): void;
  onDownloadPastedImages(value: boolean): void;
  onConvertLinks(value: boolean): void;
  onFolderLoading(value: "all" | "paged"): void;
  onFolderPageSize(value: number): void;
  onExplorer(value: boolean): void;
}) {
  if (page === "appearance") return <>
    <div className="settings-card">
      <SettingRow id="appearance-mode" label="应用主题" hint="设置工作台的浅色或深色外观，也可跟随系统。"><Select.Root size="2" value={appearance} onValueChange={value => onAppearance(value as Appearance)}>
        <Select.Trigger id="appearance-mode" />
        <Select.Content><Select.Item value="system">跟随系统</Select.Item><Select.Item value="light">浅色</Select.Item><Select.Item value="dark">深色</Select.Item></Select.Content>
      </Select.Root></SettingRow>
      <SettingRow id="explorer-visibility" label="显示资源导航" hint="控制目录、搜索和素材库所在的左侧栏。"><Switch id="explorer-visibility" radius="full" checked={explorer} onCheckedChange={onExplorer} /></SettingRow>
    </div>
    <div className="settings-group-title">编辑与预览</div>
    <div className="settings-card">
      <SettingRow id="preferred-view" label="编辑视图" hint="选择工作台默认使用编辑或公众号排版预览。"><Select.Root size="2" value={preferredView}
        onValueChange={value => onView(value as ViewMode)}>
        <Select.Trigger id="preferred-view" /><Select.Content>
          <Select.Item value="edit">编辑</Select.Item><Select.Item value="preview">排版预览</Select.Item>
        </Select.Content>
      </Select.Root></SettingRow>
      <SettingRow id="download-pasted-images" label="下载粘贴内容中的外链图片" hint="将外链图片保存到本地素材库，已配置图床的图片保留原链接。">
        <Switch id="download-pasted-images" radius="full" checked={downloadPastedImages} onCheckedChange={onDownloadPastedImages} />
      </SettingRow>
      <SettingRow id="links-to-footnotes" label="链接转脚注" hint="在编辑、预览和公众号排版中显示链接脚注，可随时关闭。">
        <Switch id="links-to-footnotes" radius="full" checked={convertLinks} onCheckedChange={onConvertLinks} />
      </SettingRow>
    </div>
    <div className="settings-group-title">目录</div>
    <div className="settings-card">
      <SettingRow id="folder-loading" label="加载方式" hint="展开目录时一次加载全部笔记，或随滚动分批加载。">
        <Select.Root size="2" value={folderLoading} onValueChange={value => onFolderLoading(value as typeof folderLoading)}>
          <Select.Trigger id="folder-loading" />
          <Select.Content><Select.Item value="all">一次性加载</Select.Item><Select.Item value="paged">滚动分页</Select.Item></Select.Content>
        </Select.Root>
      </SettingRow>
      <SettingRow id="folder-page-size" label="每页笔记数" hint="仅在滚动分页时生效，控制每批加载的数量。">
        <Select.Root size="2" value={String(folderPageSize)} disabled={folderLoading === "all"} onValueChange={value => onFolderPageSize(Number(value))}>
          <Select.Trigger id="folder-page-size" />
          <Select.Content>{[20, 40, 60, 100, 200].map(size => <Select.Item key={size} value={String(size)}>{size}</Select.Item>)}</Select.Content>
        </Select.Root>
      </SettingRow>
    </div>
  </>;
  return <>
    <div className="settings-card">
      <SettingRow id="view-shortcuts" label="切换编辑视图" hint="设置在编辑与排版预览之间切换的快捷键。"><Select.Root size="2" value={shortcut} onValueChange={value => onShortcut(value as ViewShortcut)}>
        <Select.Trigger id="view-shortcuts" />
        <Select.Content><Select.Item value="none">未设置</Select.Item><Select.Item value="shift-m">{commandKey}Shift+M</Select.Item><Select.Item value="alt-v">{commandKey}Alt+V</Select.Item></Select.Content>
      </Select.Root></SettingRow>
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

export function McpSettings() {
  const [status, setStatus] = useState<McpStatus>();
  const [port, setPort] = useState("");
  const [permission, setPermission] = useState<McpConfig["permission"]>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    void desktop.mcpStatus().then(value => {
      setStatus(value);
      setPort(String(value.config.port));
      setPermission(value.config.permission);
    }, failure => setError(errorMessage(failure)));
  }, []);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setFeedback("");
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  const apply = () => perform(async () => {
    const current = await desktop.saveMcp({ port: Number(port), permission, enabled: true });
    setStatus(current);
    setFeedback("设置已保存");
  });
  const address = status && `http://127.0.0.1:${status.config.port}/mcp`;
  return <form className="settings-card" onSubmit={event => { event.preventDefault(); void apply(); }}>
        {status && <>
          <SettingRow label="运行状态" hint="查看本机 MCP 服务是否在运行及其当前权限。"><span className="settings-state" data-running={status.running} role="status">
            {status.running ? `运行中，${status.config.permission === "read" ? "只读" : "读写"}` : "已停止"}
          </span></SettingRow>
          <SettingRow id="mcp-port" label="端口" hint="MCP 客户端连接本机服务时使用的端口。"><TextField.Root id="mcp-port" type="number" min="1" max="65535" required value={port} onChange={event => setPort(event.target.value)} /></SettingRow>
          <SettingRow id="mcp-permission" label="令牌权限" hint="控制客户端能否修改工作区内容。"><Select.Root value={permission} onValueChange={value => setPermission(value as McpConfig["permission"])}>
            <Select.Trigger id="mcp-permission" /><Select.Content><Select.Item value="read">只读</Select.Item><Select.Item value="write">读写</Select.Item></Select.Content>
          </Select.Root></SettingRow>
          {status.running && <SettingRow id="mcp-address" label="本机地址" hint="将此地址填入 MCP 客户端的服务配置。"><TextField.Root id="mcp-address" readOnly value={address} /></SettingRow>}
          <SettingRow label="访问令牌" hint="供 MCP 客户端验证身份。"><div className="button-strip setting-actions">
            {status.running && <Button type="button" variant="soft" color="gray" disabled={busy} onClick={() => void perform(async () => {
              await desktop.copyText(address!); setFeedback("已复制本机地址");
            })}>复制地址</Button>}
            <Button type="button" variant="soft" color="gray" disabled={busy} onClick={() => void perform(async () => {
              await desktop.mcpToken(false); setFeedback("已复制令牌");
            })}>复制令牌</Button>
            {!status.running && <Button type="button" variant="ghost" color="gray" disabled={busy} onClick={() => void perform(async () => {
              await desktop.mcpToken(true); setFeedback("令牌已重置并复制");
            })}>重置令牌</Button>}
          </div></SettingRow>
        </>}
        {!status && !error && <p className="settings-feedback muted-text" role="status">正在读取设置…</p>}
        {(error || status?.error) && <p role="alert" className="settings-feedback inline-error">{error || status?.error}</p>}
        {feedback && <p role="status" className="settings-feedback muted-text">{feedback}</p>}
        {status && <div className="settings-footer">
          {status?.config.enabled && <Button type="button" variant="soft" color="gray" disabled={busy} onClick={() => void perform(async () => {
            const current = await desktop.saveMcp({ ...status.config, enabled: false });
            setStatus(current);
          })}>停止 MCP</Button>}
          <Button type="submit" loading={busy}>{status.running ? "保存设置" : "启用 MCP"}</Button>
        </div>}
  </form>;
}
