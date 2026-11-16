import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Checkbox, ScrollArea, Select, TextField } from "@radix-ui/themes";
import { readS3Settings, S3Fields, SettingRow } from "./Settings";
import { CloudUpload, ImageOff, Plus, Settings2 } from "lucide-react";
import { desktop, errorMessage, type AssetLibrary, type ImageTarget, type ImageUploadOptions } from "../desktop";
import { Tool, Tooltip } from "../ui";

export function canHostImage(target: ImageTarget | null, src: string) {
  if (!target) return false;
  if (src.startsWith("asset://")) return true;
  if (!/^https?:\/\//i.test(src) || !URL.canParse(src)) return false;
  const image = new URL(src);
  const base = new URL(target.publicBase);
  const prefix = [base.pathname.replace(/\/$/, ""), ...target.prefix.split("/").filter(Boolean).map(encodeURIComponent)].join("/");
  return image.origin !== base.origin || !image.pathname.startsWith(`${prefix}/`) || image.pathname.length === prefix.length + 1;
}

export function imageMarkdown(id: string, label: string) {
  const alt = label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]").replace(/[\r\n]/g, " ");
  return `![${alt || "图片"}](asset://${id})`;
}

const acceptedImages = "image/png,image/jpeg,image/gif,image/webp";

const states = {
  queued: "等待上传", running: "上传中", retrying: "等待重试", failed: "上传失败", completed: "已上传",
} as const;

export function AssetPanel({ onImport, onInsert, onCover, onConfigure, canInsert, canCover }: {
  onImport(files: File[]): Promise<string>;
  onInsert(id: string, name: string): void;
  onCover(id: string): void;
  canInsert: boolean;
  canCover: boolean;
  onConfigure(): void;
}) {
  const [library, setLibrary] = useState<AssetLibrary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    let request = 0;
    function load() {
      const started = ++request;
      void desktop.assetLibrary().then(value => {
        if (live && request === started) { setLibrary(value); setError(""); }
      }, error => { if (live && request === started) setError(errorMessage(error)); });
    }
    load();
    const unlisten = desktop.onAssetsChanged(load);
    void unlisten.then(load, error => { if (live) setError(errorMessage(error)); });
    return () => { live = false; void unlisten.then(remove => remove(), () => {}); };
  }, [refresh]);
  const current = library?.items.find(item => item.id === selected);

  async function importImages(files: File[]) {
    if (!files.length) return;
    setLoading(true);
    try { await onImport(files); }
    finally { setLoading(false); setRefresh(value => value + 1); }
  }

  return <aside className="explorer" aria-label="素材库">
    <div className="section-bar explorer-title">
      <h1>素材库</h1>
      <div className="button-strip">
        <Tool label="导入图片" disabled={loading} onClick={() => input.current?.click()}><Plus size={16} /></Tool>
        <Tool label="S3 图床设置" onClick={onConfigure}><Settings2 size={16} /></Tool>
      </div>
      <input ref={input} type="file" accept={acceptedImages} multiple hidden onChange={event => {
        void importImages(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
    </div>
    <ScrollArea className="explorer-scroll" type="auto" scrollbars="vertical" radius="full">
      <div className="asset-list" onDragOver={event => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }} onDrop={event => {
        event.preventDefault();
        if (!loading) void importImages(Array.from(event.dataTransfer.files));
      }}>
        {loading && <p className="muted-text" role="status">正在导入图片…</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {notice && <p className="muted-text" role="status">{notice}</p>}
        {library?.items.length === 0 && !loading && <div className="explorer-empty">
          <Button size="1" variant="soft" onClick={() => input.current?.click()}>导入图片</Button>
        </div>}
        {library && library.items.length > 0 && <div className="asset-grid" role="group" aria-label="图片">
          {library.items.map(item => <Tooltip key={item.id} content={item.name || "图片"}>
            <button className="plain-button asset-tile" type="button" aria-pressed={selected === item.id}
              onClick={() => { setSelected(item.id); setNotice(""); }}>
              <AssetThumb key={`${item.bytes}:${item.publicUrl}`} id={item.id} name={item.name} tile available={item.bytes !== null} />
              <span className="asset-tile-name">{item.name || "图片"}</span>
            </button>
          </Tooltip>)}
        </div>}
      </div>
    </ScrollArea>
    {current && <section className="asset-details" aria-label="所选图片">
      <AssetThumb id={current.id} name={current.name} />
      <div className="asset-dimensions">
        {current.width && current.height ? `${current.width} × ${current.height}` : "图片详情"}
        {current.bytes != null && <span>{new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(current.bytes / 1024)} KB</span>}
        <span>{current.publicUrl ? "已上传" : current.uploadStatus ? states[current.uploadStatus] : "本地"}</span>
      </div>
      {current.uploadError && <p className="inline-error" role="alert">{current.uploadError}</p>}
      {current.cleanupError && <p className="inline-error" role="status">上次退出清理未完成：{current.cleanupError}</p>}
      <div className="button-strip asset-controls">
        {canInsert && <Button variant="soft" size="1" onClick={() => onInsert(current.id, current.name)}>插入正文</Button>}
        {canCover && <Button variant="soft" color="gray" size="1" onClick={() => onCover(current.id)}>设为封面</Button>}
        {current.publicUrl && <Button variant="soft" size="1" onClick={() => {
          void desktop.copyText(current.publicUrl!).then(() => setNotice("已复制图床链接"), error => setError(errorMessage(error)));
        }}>复制图床链接</Button>}
        {!current.publicUrl && current.bytes && library?.target && <Button variant="soft" size="1" disabled={["queued", "running", "retrying"].includes(current.uploadStatus ?? "")}
          onClick={() => { void desktop.assetUpload(current.id).catch(error => setError(errorMessage(error))); }}>
          <CloudUpload size={14} />{current.uploadStatus === "failed" ? "重试上传" : "上传"}
        </Button>}
      </div>
    </section>}
  </aside>;
}

export function AssetThumb({ id, name, tile = false, available = true }: {
  id: string; name: string; tile?: boolean; available?: boolean;
}) {
  const media = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(!tile);
  const [result, setResult] = useState<{ id: string; src?: string } | null>(null);
  useEffect(() => {
    if (!tile || !available) return;
    const target = media.current!;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { root: target.closest(".rt-ScrollAreaViewport"), rootMargin: "60px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [tile, available]);
  useEffect(() => {
    if (!visible || !available) return;
    let live = true;
    let objectUrl: string | undefined;
    const image = tile ? desktop.assetThumbnail(id) : desktop.assetRead(`asset://${id}`);
    void image.then(bytes => {
      if (live) {
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: tile ? "image/png" : "" }));
        setResult({ id, src: objectUrl });
      }
    }, () => { if (live) setResult({ id }); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, visible, tile, available]);
  const src = result?.id === id ? result.src : undefined;
  if (tile) return <span className="asset-tile-media" ref={media} aria-hidden="true">
    {src ? <img src={src} alt="" onError={() => setResult({ id })} /> : (!available || result?.id === id) && <ImageOff size={16} />}
  </span>;
  return src
    ? <img className="asset-thumbnail" src={src} alt={name} onError={() => setResult({ id })} />
    : <div className="asset-thumbnail asset-placeholder">{result?.id === id ? "图片缺失" : "正在加载图片…"}</div>;
}

const uploadVariables = [["year", "年"], ["month", "月"], ["day", "日"], ["hour", "时"], ["minute", "分"], ["second", "秒"], ["timestamp", "时间戳"]] as const;

export function ImageStorageSettings({ track }: { track<T>(job: Promise<T>): Promise<T> }) {
  const [initial, setInitial] = useState<Awaited<ReturnType<typeof desktop.imageStorageSettings>>>();
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [options, setOptions] = useState<ImageUploadOptions>({ filenameTemplate: "", quality: "original" });
  const filename = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void desktop.imageStorageSettings().then(value => {
      setInitial(value);
      setEnabled(value.enabled || !value.target);
      setOptions(value.options);
    }, failure => setFeedback({ error: true, text: errorMessage(failure) }));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement;
    const test = action?.value === "test";
    const { target: base, publicBase, secret } = readS3Settings(new FormData(event.currentTarget));
    const target = { ...base, publicBase };
    setBusy(test ? "test" : "save");
    setFeedback(null);
    try {
      if (test) {
        await track(desktop.imageStorageTest(target, secret));
        setFeedback({ error: false, text: "上传、读取和删除均通过" });
      } else {
        await track(desktop.imageStorageSave(enabled ? target : null, enabled ? secret : undefined, enabled ? options : undefined));
        setFeedback({ error: false, text: enabled ? "图床设置已保存" : "图床已停用" });
      }
    } catch (error) {
      setFeedback({ error: true, text: errorMessage(error) });
    } finally { setBusy(null); }
  }
  const sample = new Date();
  const parts = sample.toISOString().slice(0, 19).split(/[-T:]/);
  const prefix = uploadVariables.reduce((text, [key], index) => text.replaceAll(`{${key}}`, parts[index] ?? String(sample.getTime())), options.filenameTemplate.trim());
  return <form className="settings-card" autoComplete="off" onSubmit={submit} aria-busy={Boolean(busy)}>
    {initial && <>
      <label className="settings-check image-storage-enabled"><Checkbox checked={enabled} disabled={Boolean(busy)}
        onCheckedChange={value => setEnabled(value === true)} />启用图床</label>
      <S3Fields scope="images" initial={initial.target} hasKey={Boolean(initial.secret)} publicBase={initial.target?.publicBase} credentials={initial.secret} />
      <SettingRow id="image-upload-quality" label="上传清晰度" hint="高清、标清和省流转为 WebP。GIF 和动态 WebP 按原文件上传。">
        <Select.Root value={options.quality} onValueChange={(quality: ImageUploadOptions["quality"]) => setOptions(current => ({ ...current, quality }))}>
          <Select.Trigger id="image-upload-quality" /><Select.Content>
            <Select.Item value="original">原图</Select.Item><Select.Item value="high">高清</Select.Item>
            <Select.Item value="standard">标清</Select.Item><Select.Item value="economy">省流</Select.Item>
          </Select.Content>
        </Select.Root>
      </SettingRow>
      <div className="image-naming">
        <div className="image-naming-header"><label htmlFor="image-filename">文件命名规则</label>
          <Button type="button" size="1" variant="ghost" onClick={() => setOptions(current => ({ ...current, filenameTemplate: "" }))}>恢复默认</Button></div>
        <TextField.Root ref={filename} id="image-filename" placeholder="默认按内容哈希命名" value={options.filenameTemplate}
          onChange={event => setOptions(current => ({ ...current, filenameTemplate: event.target.value }))} />
        <div className="image-naming-variables" aria-label="插入命名变量">{uploadVariables.map(([key, label]) => <Button key={key} type="button" size="1" variant="soft" color="gray" onClick={() => {
          const input = filename.current!;
          const from = input.selectionStart ?? options.filenameTemplate.length;
          const to = input.selectionEnd ?? from;
          const token = `{${key}}`;
          setOptions(current => ({ ...current, filenameTemplate: current.filenameTemplate.slice(0, from) + token + current.filenameTemplate.slice(to) }));
          requestAnimationFrame(() => { input.focus(); input.setSelectionRange(from + token.length, from + token.length); });
        }}>{label}</Button>)}</div>
        <output htmlFor="image-filename" className="image-naming-preview">{prefix ? `${prefix}-` : ""}a8f3…72ce.{options.quality === "original" ? "jpg" : "webp"}</output>
        <span className="setting-hint">日期和时间使用 UTC。文件名自动添加内容哈希和扩展名。</span>
      </div>
    </>}
    <div className="settings-footer image-storage-footer">
      <span className="image-storage-feedback" role={feedback?.error ? "alert" : "status"} data-error={feedback?.error}
        title={feedback?.text}>{feedback?.text ?? (!initial ? "正在读取设置…" : busy === "test" ? "正在测试…" : busy ? "正在保存…" : "")}</span>
      {initial && <>
        <Button type="submit" value="test" variant="soft" disabled={Boolean(busy)}>测试连接</Button>
        <Button type="submit" value="save" disabled={Boolean(busy)} formNoValidate={!enabled}>保存</Button>
      </>}
    </div>
  </form>;
}
