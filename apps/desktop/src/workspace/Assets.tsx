import { ActionError } from "../button-feedback";
import { useSettingsButtonFeedback } from "./settings-button-feedback";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import { Button, Checkbox, Select, TextField } from "@radix-ui/themes";
import { readS3Settings, S3Fields, SettingRow } from "./Settings";
import { ChevronLeft, ChevronRight, CloudUpload, Grid2X2, Grid3X3, ImageOff, Plus, Settings2 } from "lucide-react";
import { desktop, errorMessage, type AssetLibrary, type AssetRow, type ImageTarget, type ImageUploadOptions } from "../desktop";
import { persist, Tool, Tooltip, useStoredInitial } from "../ui";

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
  queued: "等待上传", running: "上传中", retrying: "等待重试", failed: "上传失败", completed: "图床",
} as const;

function assetImageKey(item: AssetRow) {
  return `${item.id}:${item.bytes ?? item.publicUrl}`;
}

const tileGap = 4;
const tilePadding = 4;
const tileCaption = 16;

function arrangeAssets(items: AssetRow[], width: number, minimum: number) {
  const columns = Math.max(1, Math.floor((width + tileGap) / (minimum + tileGap)));
  const tileWidth = (width - (columns - 1) * tileGap) / columns;
  const heights = Array<number>(columns).fill(0);
  const priorities = Array<number>(columns).fill(0);
  const chrome = 2 * tilePadding + tileGap + tileCaption;
  const mediaHeight = (width: number, ratio: number) => Math.min(320, Math.max(0, width - 2 * tilePadding) * ratio);
  const tiles = items.map(item => {
    const column = priorities.indexOf(Math.min(...priorities));
    const ratio = item.width && item.height ? item.height / item.width : 3 / 4;
    const imageHeight = mediaHeight(tileWidth, ratio);
    const position = { insetBlockStart: heights[column], insetInlineStart: column * (tileWidth + tileGap), width: tileWidth };
    heights[column] += imageHeight + chrome + tileGap;
    // Keep column assignments stable when the sidebar width changes within the same column count.
    priorities[column] += mediaHeight(minimum, ratio) + chrome + tileGap;
    return { item, position, imageHeight };
  });
  return { tiles, height: Math.max(...heights) };
}

export function AssetPanel({ onImport, onInsert, onCover, onConfigure, canInsert, canCover }: {
  onImport(files: File[]): Promise<string>;
  onInsert(id: string, name: string): void;
  onCover(id: string): void;
  canInsert: boolean;
  canCover: boolean;
  onConfigure(): void;
}) {
  const [library, setLibrary] = useState<AssetLibrary | null>(null);
  const [selected, setSelected] = useState<{ item: AssetRow; key: string; thumbnail?: string } | null>(null);
  const selectedId = selected?.item.id;
  const [selectedError, setSelectedError] = useState("");
  const [error, setError] = useState("");
  const assetButtons = useSettingsButtonFeedback();
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const [paging, setPaging] = useState(false);
  const [largeTiles, setLargeTiles] = useState(() => useStoredInitial("asset-large-tiles", false));
  const [gridWidth, setGridWidth] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = grid.current!;
    setGridWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setGridWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    let request = 0;
    function load() {
      const started = ++request;
      void desktop.assetLibrary(page).then(value => {
        if (live && request === started) {
          setLibrary(value);
          setError("");
        }
      }, error => { if (live && request === started) setError(errorMessage(error)); }).finally(() => {
        if (live && request === started) setPaging(false);
      });
    }
    load();
    const unlisten = desktop.onAssetsChanged(load);
    void unlisten.then(load, error => { if (live) setError(errorMessage(error)); });
    return () => { live = false; void unlisten.then(remove => remove(), () => {}); };
  }, [page, refresh]);
  useEffect(() => {
    setSelectedError("");
    if (!selectedId) return;
    const id = selectedId;
    let live = true;
    let request = 0;
    function load() {
      const started = ++request;
      void desktop.assetDetail(id).then(item => {
        if (!live || request !== started) return;
        setSelected(selected => {
          if (selected?.item.id !== id) return selected;
          return item ? { ...selected, item } : null;
        });
        setSelectedError("");
      }, error => { if (live && request === started) setSelectedError(errorMessage(error)); });
    }
    load();
    const unlisten = desktop.onAssetsChanged(load);
    void unlisten.then(() => { if (live) load(); }, error => { if (live) setSelectedError(errorMessage(error)); });
    return () => { live = false; void unlisten.then(remove => remove(), () => {}); };
  }, [selectedId, refresh]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [library?.page]);
  const current = selected?.item;
  const currentKey = current && assetImageKey(current);
  const minimum = largeTiles ? 108 : 68;
  const layout = arrangeAssets(library?.items ?? [], gridWidth || minimum, minimum);

  function turnPage(next: number) {
    setPaging(true);
    if (next === page) setRefresh(value => value + 1);
    else setPage(next);
  }

  async function importImages(files: File[]) {
    if (!files.length) return;
    await assetButtons.run("import", async () => {
      setLoading(true);
      try { await onImport(files); }
      finally { setLoading(false); setRefresh(value => value + 1); }
    });
  }

  return <aside className="explorer" aria-label="素材库">
    <div className="section-bar explorer-title">
      <div className="asset-heading">
        <h1>素材库</h1>
        <Tool label={largeTiles ? "切换为小缩略图" : "切换为大缩略图"} className="chrome-icon"
          onClick={() => { setLargeTiles(!largeTiles); persist("asset-large-tiles", !largeTiles); }}>
          {largeTiles ? <Grid3X3 size={15} /> : <Grid2X2 size={15} />}
        </Tool>
      </div>
      <div className="button-strip">
        <Tool label="导入图片" {...assetButtons.props("import", loading)} onClick={() => input.current?.click()}>{assetButtons.icon("import", <Plus size={16} />)}</Tool>
        <Tool label="S3 图床设置" onClick={onConfigure}><Settings2 size={16} /></Tool>
      </div>
      <input ref={input} type="file" accept={acceptedImages} multiple hidden onChange={event => {
        void importImages(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
    </div>
    <div ref={scroll} className="explorer-scroll explorer-list-scroll asset-scroll">
      <div className="asset-list" onDragOver={event => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }} onDrop={event => {
        event.preventDefault();
        if (!loading) void importImages(Array.from(event.dataTransfer.files));
      }}>
        <div className="action-error-slot">
          {loading && <p className="muted-text" role="status">正在导入图片…</p>}
        </div>
        <ActionError error={error || assetButtons.error("import")} />

        {library?.items.length === 0 && !loading && <div className="explorer-empty">
          <Button size="1" variant="soft" {...assetButtons.props("import", loading)} onClick={() => input.current?.click()}>
            {assetButtons.label("import", "导入图片", "已导入", "导入失败")}</Button>
        </div>}
        <div ref={grid} className="asset-masonry" data-large={largeTiles || undefined} role="group" aria-label="图片"
          aria-hidden={!layout.tiles.length} style={{
            height: layout.height, "--asset-tile-gap": `${tileGap}px`, "--asset-tile-padding": `${tilePadding}px`,
            "--asset-tile-caption": `${tileCaption}px`,
          } as CSSProperties}>
          {layout.tiles.map(({ item, position, imageHeight }) => {
            const key = assetImageKey(item);
            return <AssetTile key={key} item={item} position={position} imageHeight={imageHeight}
              selected={selected?.item.id === item.id} onSelect={thumbnail => {
              setSelected(selected => selected?.item.id === item.id ? selected : { item, key, thumbnail });
                      }} />;
          })}
        </div>
      </div>
    </div>
    {library && (library.page > 0 || library.hasNext) && <div className="asset-pagination" role="group" aria-label="素材分页">
      <Tool label="上一页" className="chrome-icon" disabled={paging || library.page === 0}
        onClick={() => turnPage(library.page - 1)}><ChevronLeft size={16} /></Tool>
      <Tool label="下一页" className="chrome-icon" disabled={paging || !library.hasNext}
        onClick={() => turnPage(library.page + 1)}><ChevronRight size={16} /></Tool>
    </div>}
    {current && <section className="asset-details asset-library-details" aria-label="所选图片">

      <AssetThumb key={currentKey} id={current.id} name={current.name}
        thumbnail={selected?.key === currentKey ? selected?.thumbnail : undefined} />
      <div className="asset-dimensions">
        {current.width && current.height ? `${current.width} × ${current.height}` : "图片详情"}
        {current.bytes != null && <span>{new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(current.bytes / 1024)} KB</span>}
        <span>{current.publicUrl ? "图床" : current.uploadStatus ? states[current.uploadStatus] : "本地"}</span>
      </div>

      <ActionError error={selectedError || current.uploadError || current.cleanupError || ["copy:", "upload:", "cover:", "insert:"].map(action => assetButtons.error(action + current.id)).find(Boolean)} />
      <div className="button-strip asset-controls">
        {canInsert && <Button variant="soft" size="1" {...assetButtons.props(`insert:${current.id}`)}
          onClick={() => void assetButtons.run(`insert:${current.id}`, () => onInsert(current.id, current.name))}>
          {assetButtons.label(`insert:${current.id}`, "插入正文", "已插入")}</Button>}
        {canCover && <Button variant="soft" color="gray" size="1" {...assetButtons.props(`cover:${current.id}`)}
          onClick={() => void assetButtons.run(`cover:${current.id}`, () => onCover(current.id))}>
          {assetButtons.label(`cover:${current.id}`, "设为封面", "已设置")}</Button>}
        {current.publicUrl && <Button variant="soft" size="1" {...assetButtons.props("copy:" + current.id)} loading={assetButtons.status("copy:" + current.id) === "pending"}
          onClick={() => void assetButtons.run("copy:" + current.id, () => desktop.copyText(current.publicUrl!))}>
          {assetButtons.label("copy:" + current.id, "复制图床链接", "已复制")}</Button>}
        {!current.publicUrl && current.bytes && library?.target && <Button variant="soft" size="1"
          {...assetButtons.props("upload:" + current.id, ["queued", "running", "retrying"].includes(current.uploadStatus ?? ""))}
          onClick={() => void assetButtons.run("upload:" + current.id, () => desktop.assetUpload(current.id))}>
          {assetButtons.icon("upload:" + current.id, <CloudUpload size={14} />, 14)}{assetButtons.label("upload:" + current.id, current.uploadStatus === "failed" ? "重试上传" : "上传", "已加入上传")}
        </Button>}
      </div>
    </section>}
  </aside>;
}

function AssetTile({ item, position, imageHeight, selected, onSelect }: {
  item: AssetRow; position: CSSProperties; imageHeight: number; selected: boolean; onSelect(thumbnail?: string): void;
}) {
  const media = useRef<HTMLSpanElement>(null);
  const [broken, setBroken] = useState(false);
  const available = item.bytes !== null;
  const visible = useNearViewport(media, available);
  const result = useAssetImage(visible && available ? `asset://${item.id}` : null, true);
  const src = broken ? undefined : result?.src;
  return <Tooltip content={item.name || "图片"}>
    <button className="plain-button asset-tile" style={position} type="button" aria-pressed={selected}
      onClick={() => onSelect(src)}>
      <span className="asset-tile-media" ref={media} aria-hidden="true" style={{ height: imageHeight }}>
        {src ? <img src={src} alt="" onError={() => setBroken(true)} />
          : (!available || result) && <ImageOff size={16} />}
      </span>
      <span className="asset-tile-name">{item.name || "图片"}</span>
    </button>
  </Tooltip>;
}

export function CoverThumbnail({ source }: { source: string }) {
  const media = useRef<HTMLSpanElement>(null);
  const visible = useNearViewport(media, true);
  const result = useAssetImage(visible ? source : null, true);
  return <span ref={media} className="timeline-cover" aria-hidden="true">
    {result?.src && <img src={result.src} alt="" draggable={false} />}
  </span>;
}

function useNearViewport(media: RefObject<HTMLSpanElement | null>, available: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!available) return;
    const target = media.current!;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { root: target.closest(".explorer-list-scroll"), rootMargin: "60px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [media, available]);
  return visible;
}

export function AssetThumb({ id, name, thumbnail }: { id: string; name: string; thumbnail?: string }) {
  const result = useAssetImage(`asset://${id}`);
  const src = result ? result.src : thumbnail;
  return src
    ? <img className="asset-thumbnail" src={src} alt={name} />
    : <div className="asset-thumbnail asset-placeholder">{result ? "图片缺失" : "正在加载图片…"}</div>;
}

export function useAssetImage(url: string | null, small = false) {
  const [result, setResult] = useState<{ url: string; src?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    let objectUrl: string | undefined;
    const localThumbnail = small && url.startsWith("asset://");
    const request = localThumbnail ? desktop.assetThumbnail(url.slice("asset://".length)) : desktop.assetRead(url);
    void request.then(async bytes => {
      if (!live) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: localThumbnail ? "image/png" : "" }));
      if (!localThumbnail) {
        const image = new Image();
        image.src = objectUrl;
        await image.decode();
      }
      if (live) setResult({ url, src: objectUrl });
    }).catch(() => { if (live) setResult({ url }); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, small]);
  return result?.url === url ? result : null;
}

const uploadVariables = [["year", "年"], ["month", "月"], ["day", "日"], ["hour", "时"], ["minute", "分"], ["second", "秒"], ["timestamp", "时间戳"]] as const;

export function ImageStorageSettings({ track }: { track<T>(job: Promise<T>): Promise<T> }) {
  const [initial, setInitial] = useState<Awaited<ReturnType<typeof desktop.imageStorageSettings>>>();
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const buttons = useSettingsButtonFeedback();
  const [options, setOptions] = useState<ImageUploadOptions>({ filenameTemplate: "", quality: "original", autoUpload: false });
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
    const key = test ? "test" : "save";
    if (!buttons.start(key)) return;
    setBusy(key);
    setFeedback(null);
    try {
      if (test) {
        await track(desktop.imageStorageTest(target, secret));
      } else {
        await track(desktop.imageStorageSave(enabled ? target : null, enabled ? secret : undefined, enabled ? options : undefined));
      }
      buttons.finish(key, true);
    } catch (error) {
      buttons.finish(key, false);
      setFeedback({ error: true, text: errorMessage(error) });
    } finally { setBusy(null); }
  }
  const sample = new Date();
  const parts = sample.toISOString().slice(0, 19).split(/[-T:]/);
  const prefix = uploadVariables.reduce((text, [key], index) => text.replaceAll(`{${key}}`, parts[index] ?? String(sample.getTime())), options.filenameTemplate.trim());
  return <form className="settings-card" autoComplete="off" onSubmit={submit} aria-busy={Boolean(busy)}>
    {initial && <>
      <SettingRow id="image-storage-enabled" label="启用图床" hint="使用在线存储为图片生成可用于发布的链接。">
        {hintId => <Checkbox id="image-storage-enabled" aria-describedby={hintId} checked={enabled} disabled={Boolean(busy)}
          onCheckedChange={value => setEnabled(value === true)} />}
      </SettingRow>
      <S3Fields scope="images" initial={initial.target} hasKey={Boolean(initial.secret)} publicBase={initial.target?.publicBase} credentials={initial.secret} />
      <SettingRow id="image-auto-upload" label="默认存储到图床" hint="自动上传新导入、粘贴或拖入的图片。"
        warning="开启后，新加入的本地图片会发送到所配置的存储桶。">
        {hintId => <Checkbox id="image-auto-upload" aria-describedby={hintId} checked={options.autoUpload} disabled={!enabled || Boolean(busy)}
          onCheckedChange={value => setOptions(current => ({ ...current, autoUpload: value === true }))} />}
      </SettingRow>
      <SettingRow id="image-upload-quality" label="上传清晰度" hint="高清、标清和省流转为 WebP。GIF 和动态 WebP 按原文件上传。">
        {hintId => <Select.Root value={options.quality} onValueChange={(quality: ImageUploadOptions["quality"]) => setOptions(current => ({ ...current, quality }))}>
          <Select.Trigger id="image-upload-quality" aria-describedby={hintId} /><Select.Content>
            <Select.Item value="original">原图</Select.Item><Select.Item value="high">高清</Select.Item>
            <Select.Item value="standard">标清</Select.Item><Select.Item value="economy">省流</Select.Item>
          </Select.Content>
        </Select.Root>}
      </SettingRow>
      <div className="image-naming">
        <div className="image-naming-header"><label htmlFor="image-filename">文件命名规则</label>
          <Button type="button" size="1" variant="ghost" onClick={() => setOptions(current => ({ ...current, filenameTemplate: "" }))}>恢复默认</Button></div>
        <TextField.Root ref={filename} id="image-filename" aria-describedby="image-filename-hint" placeholder="默认按内容哈希命名" value={options.filenameTemplate}
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
        <span id="image-filename-hint" className="setting-hint">设置图床文件名的前缀。日期和时间使用 UTC，系统会自动添加内容哈希和扩展名。</span>
      </div>
    </>}
    <div className="settings-footer image-storage-footer">
      <span className="image-storage-feedback" role={feedback?.error ? "alert" : "status"} data-error={feedback?.error}
        tabIndex={feedback?.error ? 0 : -1}>{feedback?.text ?? (!initial ? "正在读取设置…" : "")}</span>
      {initial && <>
        <Button type="submit" value="test" variant="soft" loading={busy === "test"}  {...buttons.props("test", Boolean(busy))}>{buttons.label("test", "测试连接", "测试通过", "测试失败")}</Button>
        <Button type="submit" value="save" loading={busy === "save"}  formNoValidate={!enabled} {...buttons.props("save", Boolean(busy))}>{buttons.label("save", "保存", "已保存", "保存失败")}</Button>
      </>}
    </div>
  </form>;
}
