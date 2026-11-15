import { useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, Select, TextArea, TextField } from "@radix-ui/themes";
import { X } from "lucide-react";
import type { Category, Entry, EntryFields, Revision } from "../../../../packages/shared-types";
import { statuses } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { dateLabel, statusLabels, untitled } from "../labels";
import type { SaveQueue } from "../editor/save-queue";
import { AssetThumb } from "./Assets";
import { FolderSelect } from "./FolderSelect";
import { addTag, TagInput } from "./TagInput";

export function EntryLocationDialog({ entry, categories, onClose, onSave }: {
  entry: Entry;
  categories: Category[];
  onClose(): void;
  onSave(categoryId: string | null): Promise<void>;
}) {
  const [value, setValue] = useState(entry.categoryId ?? "none");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await onSave(value === "none" ? null : value);
      onClose();
    } catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <Dialog.Content maxWidth="380px" aria-describedby={undefined}>
      <Dialog.Title>移动到文件夹</Dialog.Title>
      <form className="dialog-form" onSubmit={save}>
        <label>所在目录<FolderSelect categories={categories} value={value} onChange={setValue} label="所在目录" defaultLabel="根目录" /></label>
        {error && <p role="alert" className="inline-error">{error}</p>}
        <div className="dialog-actions">
          <Dialog.Close><Button type="button" variant="soft" color="gray" disabled={saving}>取消</Button></Dialog.Close>
          <Button type="submit" loading={saving}>移动</Button>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Root>;
}

export function PropertiesDialog({ queue, categories, tagSuggestions, locked, onClose, onOpen }: {
  queue: SaveQueue;
  categories: Category[];
  tagSuggestions: string[];
  locked: boolean;
  onClose(): void;
  onOpen(id: string): void;
}) {
  const { entry } = queue;
  const { fields } = queue.snapshot();
  const [status, setStatus] = useState(fields.status);
  const [category, setCategory] = useState(fields.categoryId ?? "none");
  const [cover, setCover] = useState(fields.coverAssetId ?? null);
  const [tags, setTags] = useState(fields.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [error, setError] = useState("");
  const readOnly = locked || entry.deletedAt !== null;
  const hasSourceFields = entry.kind === "reference" || fields.source !== null;
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const sourceUrl = text("sourceUrl");
    const publishedUrl = text("publishedUrl");
    const author = text("author");
    const accountName = text("accountName");
    const originalDate = text("originalDate");
    if (!sourceUrl && (author || accountName || originalDate)) {
      setError("请先填写原文链接，再保存来源信息");
      return;
    }
    for (const value of [sourceUrl, publishedUrl]) {
      if (value && !URL.canParse(value)) {
        setError("请输入完整链接");
        return;
      }
    }
    const change: Partial<EntryFields> = {
      status, categoryId: category === "none" ? null : category, tags: addTag(tags, tagDraft, tagSuggestions),
      summary: text("summary"),
      publishedUrl,
      coverAssetId: cover,
      publishedAt: status === "published" ? fields.publishedAt ?? Date.now() : fields.publishedAt,
    };
    if (hasSourceFields) {
      change.source = sourceUrl ? {
        url: sourceUrl, author, accountName,
        originalPublishedAt: originalDate ? new Date(originalDate + "T00:00:00").getTime() : null,
        importedAt: fields.source?.importedAt ?? null,
      } : null;
    }
    queue.edit(change);
    void queue.flush({ retry: true });
    onClose();
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Content maxWidth="360px" className="properties-panel" aria-describedby={undefined} onEscapeKeyDown={event => {
      if (event.target instanceof HTMLInputElement && event.target.getAttribute("aria-expanded") === "true") event.preventDefault();
    }}>
      <header className="properties-header">
        <Dialog.Title>内容属性</Dialog.Title>
        <Dialog.Close><button className="plain-button chrome-icon" type="button" aria-label="关闭内容属性"><X size={16} /></button></Dialog.Close>
      </header>
      <form className="properties-form" onSubmit={save}>
        <div className="properties-fields">
          <div className="form-pair">
            <label>状态
              <Select.Root size="2" value={status} onValueChange={value => setStatus(value as Entry["status"])} disabled={readOnly}>
                <Select.Trigger aria-label="状态" />
                <Select.Content>{statuses[entry.kind].map(value => <Select.Item value={value} key={value}>{statusLabels[value]}</Select.Item>)}</Select.Content>
              </Select.Root>
            </label>
            <label>所在目录
              <FolderSelect size="2" categories={categories} value={category} onChange={setCategory} label="所在目录" defaultLabel="根目录" disabled={readOnly} />
            </label>
          </div>
          <TagInput tags={tags} onTags={setTags} draft={tagDraft} onDraft={setTagDraft} history={tagSuggestions} readOnly={readOnly} />
          <label>摘要<TextArea size="2" name="summary" readOnly={readOnly} defaultValue={fields.summary} rows={3} /></label>
          {hasSourceFields && <>
            <label>原文链接<TextField.Root type="url" readOnly={readOnly} name="sourceUrl" defaultValue={fields.source?.url} /></label>
            <div className="form-pair">
              <label>作者<TextField.Root name="author" readOnly={readOnly} defaultValue={fields.source?.author} /></label>
              <label>公众号<TextField.Root name="accountName" readOnly={readOnly} defaultValue={fields.source?.accountName} /></label>
            </div>
            <label>原文发布日期<TextField.Root name="originalDate" type="date" readOnly={readOnly}
              defaultValue={fields.source?.originalPublishedAt == null ? "" : new Intl.DateTimeFormat("sv-SE").format(fields.source.originalPublishedAt)} /></label>
            {fields.source?.importedAt && <span className="muted-text">收录于 {dateLabel(fields.source.importedAt)}</span>}
          </>}
          <label>发布链接<TextField.Root type="url" name="publishedUrl" readOnly={readOnly} defaultValue={fields.publishedUrl} /></label>
          {cover && <div className="asset-details">
            <span>封面</span><AssetThumb id={cover} name="文章封面" />
            {!readOnly && <Button type="button" size="1" variant="soft" onClick={() => setCover(null)}>移除封面</Button>}
          </div>}
          {entry.links.length > 0 && <div className="linked-entries">
            <span>关联内容</span>
            {entry.links.map(link => <Button key={link.id} variant="soft" size="1" type="button" onClick={() => { onClose(); onOpen(link.id); }}>
              {link.title || untitled}
            </Button>)}
          </div>}
          {error && <p role="alert" className="inline-error">{error}</p>}
        </div>
        {!readOnly && <footer className="properties-footer">
          <Dialog.Close><Button type="button" variant="soft" color="gray">取消</Button></Dialog.Close>
          <Button type="submit">保存</Button>
        </footer>}
      </form>
    </Dialog.Content>
  </Dialog.Root>;
}

export function RevisionsDialog({ id, onClose, onCopy }: {
  id: string;
  onClose(): void;
  onCopy(text: string): Promise<void>;
}) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void desktop.revisions(id).then(setRevisions, error => setError(errorMessage(error)));
  }, [id]);
  const revision = revisions?.[current];
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Content maxWidth="580px" aria-describedby={undefined}>
    <Dialog.Title>历史版本</Dialog.Title>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {revisions === null && !error && <p>正在载入…</p>}
    {revisions?.length === 0 && <p>尚无手动保存的版本</p>}
    {revision && <>
      <div className="button-strip revision-list">
        {revisions!.map((item, index) => <Button size="1" key={item.version} variant={current === index ? "solid" : "soft"} onClick={() => { setCurrent(index); setCopied(false); }}>
          版本 {item.version}
        </Button>)}
      </div>
      <p className="muted-text">{dateLabel(revision.createdAt)} {revision.reason === "manual" ? "手动保存" : "AI 改写前"}</p>
      <TextArea aria-label="该版本正文" readOnly rows={12} value={revision.contentMd} />
    </>}
    <div className="dialog-actions">
      {revision && <Button size="2" variant="soft" onClick={() => {
        void onCopy(revision.contentMd).then(() => setCopied(true), error => setError(errorMessage(error)));
      }}>{copied ? "已复制" : "复制正文"}</Button>}
      <Dialog.Close><Button variant="soft" color="gray">关闭</Button></Dialog.Close>
    </div>
  </Dialog.Content></Dialog.Root>;
}

export function Confirm({ title, text, action, onClose, onConfirm }: {
  title: string;
  text: string;
  action: string;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <Dialog.Content maxWidth="410px">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{text}</Dialog.Description>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <div className="dialog-actions">
        <Dialog.Close><Button variant="soft" color="gray" disabled={saving}>取消</Button></Dialog.Close>
        <Button color="red" loading={saving} onClick={() => {
          setSaving(true);
          void onConfirm().then(onClose, error => setError(errorMessage(error))).finally(() => setSaving(false));
        }}>{action}</Button>
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}
