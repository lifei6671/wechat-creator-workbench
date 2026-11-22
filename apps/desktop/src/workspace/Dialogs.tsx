import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Checkbox, Dialog, DropdownMenu, Select, TextArea, Text as RadixText } from "@radix-ui/themes";
import { CalendarDays, Folder, Link, Plus, Send, Tags, Text, Trash2, X } from "lucide-react";
import type { Category, Collection, CustomProperty, Entry, EntryFields, PublicationPlatform, Revision } from "../../../../packages/shared-types";
import { statuses } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import { dateLabel, statusLabels, untitled } from "../labels";
import { isConflict, type SaveQueue } from "../editor/save-queue";
import { AssetThumb } from "./Assets";
import { FolderSelect } from "./FolderSelect";
import { addTag, TagInput } from "./TagInput";
import { ActionError, useButtonFeedback } from "../button-feedback";
import { PublicationProperty } from "./PublicationProperty";

interface PropertiesDialogProps {
  id: string;
  queue?: SaveQueue;
  categories: Category[];
  tagSuggestions: string[];
  locked: boolean;
  onSave(entry: Entry, change: Partial<EntryFields>): Promise<void>;
  onClose(): void;
  onOpen(id: string): void;
  onOpenCollection?(id: string): void;
  flushRef?: { current: ((closing?: boolean) => Promise<boolean>) | null };
  onConflict?(entry: Entry): void;
}

const propertyTypes = {
  text: { label: "文本", icon: Text },
  date: { label: "日期", icon: CalendarDays },
  tags: { label: "标签", icon: Tags },
} as const;
const builtinFields = {
  title: { label: "标题", kind: "text" },
  sourceUrl: { label: "原文链接", kind: "text", icon: Link },
  author: { label: "作者", kind: "text" },
  accountName: { label: "来源平台", kind: "text" },
  originalDate: { label: "原文发布日期", kind: "date" },
  createdDate: { label: "创建日期", kind: "date" },
  summary: { label: "摘要", kind: "text" },
  tags: { label: "标签", kind: "tags" },
  publishedDate: { label: "发布日期", kind: "date" },
  publishedUrl: { label: "发布链接", kind: "text", icon: Link },
  status: { label: "状态", kind: "text" },
  category: { label: "所在目录", kind: "text", icon: Folder },
} satisfies Record<string, { label: string; kind: CustomProperty["kind"]; icon?: typeof Text }>;
type Builtin = keyof typeof builtinFields;
const builtinNames = Object.keys(builtinFields) as Builtin[];
const sourceFields: Builtin[] = ["author", "accountName", "originalDate"];
const propertyDate = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" });
const formatPropertyDate = (value?: number | null) => value == null ? "" : propertyDate.format(value);
const readPropertyDate = (value: string, previous?: number | null) =>
  value ? (value === formatPropertyDate(previous) ? previous! : new Date(value + "T00:00:00").getTime()) : null;
type PropertyDraft = CustomProperty & { id: number; tagDraft: string };

function changePropertyType(property: PropertyDraft, kind: CustomProperty["kind"]): PropertyDraft | null {
  if (kind === property.kind) return property;
  const value = property.kind === "tags" ? addTag(property.value, property.tagDraft, []).join("、") : property.value;
  if (kind === "tags") return { ...property, kind, value: addTag([], value, []), tagDraft: "" };
  if (kind === "date" && value) {
    const date = new Date(value + "T00:00:00Z");
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
      && date.toISOString().slice(0, 10) === value;
    if (!valid) return null;
  }
  return { ...property, kind, value, tagDraft: "" };
}

export function PropertiesDialog({ id, queue, onClose, flushRef, ...form }: PropertiesDialogProps) {
  const [open, setOpen] = useState(true);
  const localFlush = useRef<((closing?: boolean) => Promise<boolean>) | null>(null);
  const flushForm = flushRef ?? localFlush;
  const closeFeedback = useButtonFeedback();
  async function requestClose() {
    if (!closeFeedback.start("close")) return;
    if (!flushForm.current || await flushForm.current(true)) setOpen(false);
    else closeFeedback.finish("close", false);
  }
  const [loaded, setLoaded] = useState<Entry>();
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (queue) return;
    let current = true;
    void desktop.entry(id).then(entry => {
      if (current) setLoaded(entry);
    }, error => {
      if (current) setLoadError(errorMessage(error));
    });
    return () => { current = false; };
  }, [id, queue]);
  const entry = queue?.entry ?? loaded;

  return <Dialog.Root open={open} onOpenChange={next => { if (!next) void requestClose(); }}>
    <Dialog.Content maxWidth="440px" className="properties-panel" aria-describedby={undefined}
      onCloseAutoFocus={event => {
        if (open) return;
        event.preventDefault();
        onClose();
      }} onEscapeKeyDown={event => {
        if (event.target instanceof HTMLInputElement && event.target.getAttribute("aria-expanded") === "true") event.preventDefault();
      }}>
      <header className="properties-header">
        <Dialog.Title>内容属性</Dialog.Title>
        <button className="plain-button chrome-icon" type="button" aria-label="关闭内容属性" {...closeFeedback.props("close")}
          onClick={() => void requestClose()}>{closeFeedback.icon("close", <X size={16} />, 16)}</button>
      </header>
      {entry ? <PropertiesForm {...form} entry={entry} fields={queue?.snapshot().fields ?? entry} flushRef={flushForm} onClose={() => setOpen(false)} />
        : <div className="properties-fields">
          {loadError ? <p role="alert" className="inline-error">{loadError}</p> : <p role="status">正在读取内容属性…</p>}
        </div>}
    </Dialog.Content>
  </Dialog.Root>;
}

function propertyValues(entry: Entry, fields: EntryFields): Record<Builtin, string> {
  return {
    title: fields.title, sourceUrl: fields.source?.url ?? "", author: fields.source?.author ?? "",
    accountName: fields.source?.accountName ?? "", originalDate: formatPropertyDate(fields.source?.originalPublishedAt),
    createdDate: formatPropertyDate(entry.createdAt), summary: fields.summary, tags: "",
    publishedDate: formatPropertyDate(fields.publishedAt), publishedUrl: fields.publishedUrl,
    status: fields.status, category: fields.categoryId ?? "",
  } as Record<Builtin, string>;
}

export function PropertiesPanel({ queue, flushRef, ...form }: Omit<PropertiesDialogProps, "id" | "queue"> & { queue: SaveQueue }) {
  const fields = useSyncExternalStore(queue.subscribe, queue.snapshotFields);
  const localFlush = useRef<((closing?: boolean) => Promise<boolean>) | null>(null);
  return <section className="properties-sidebar" aria-label="内容属性">
    <PropertiesForm {...form} entry={queue.entry} fields={fields} flushRef={flushRef ?? localFlush} live />
  </section>;
}

function PropertiesForm({ entry, fields, categories, tagSuggestions, locked, onSave, onClose, onOpen, onOpenCollection, flushRef, onConflict, live = false }: Omit<PropertiesDialogProps, "id" | "queue"> & {
  entry: Entry;
  fields: EntryFields;
  flushRef: { current: ((closing?: boolean) => Promise<boolean>) | null };
  live?: boolean;
}) {
  const [draft, setDraft] = useState(() => ({ values: propertyValues(entry, fields),
    cover: fields.coverAssetId ?? null, tags: fields.tags, tagDraft: "",
    properties: (fields.customProperties ?? []).map((property, id) => ({ ...property, id, tagDraft: "" })) as PropertyDraft[],
    publications: (fields.publicationPlatforms ?? []).map((value, id) => ({ id, ...value })),
  }));
  const draftRef = useRef(draft);
  const { values, cover, tags, tagDraft, properties, publications } = draft;
  function updateDraft(change: Partial<typeof draft>) {
    draftRef.current = { ...draftRef.current, ...change };
    setDraft(draftRef.current);
  }
  const [shown, setShown] = useState(() => new Set(builtinNames.filter(name =>
    name === "tags" ? fields.tags.length > 0 : values[name].trim() !== "")));
  const [hidden, setHidden] = useState(() => new Set(properties.filter(property => property.kind === "tags"
    ? property.value.length === 0 : !property.value.trim()).map(property => property.id)));
  const nextPropertyId = useRef(properties.length);
  const nextPublicationId = useRef(publications.length);
  const focusAfterAdd = useRef<string>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saved = useRef(fields);
  const acceptedPublications = useRef(new Map(publications.map(({ id, platform, url }) => [id, { platform, url }])));
  const dirty = useRef(new Map<string, number>());
  const conflicts = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const serial = useRef<Promise<boolean>>(Promise.resolve(true));
  const pending = useRef(new Map<string, { revision: number; promise: Promise<boolean> }>());
  useEffect(() => {
    if (!live || fields === saved.current || dirty.current.size || pending.current.size) return;
    const current = draftRef.current;
    const nextValues = propertyValues(entry, fields);
    const publicationsChanged = JSON.stringify(fields.publicationPlatforms ?? []) !== JSON.stringify(saved.current.publicationPlatforms ?? []);
    const customChanged = JSON.stringify(fields.customProperties ?? []) !== JSON.stringify(saved.current.customProperties ?? []);
    const nextPublications = publicationsChanged
      ? (fields.publicationPlatforms ?? []).map(value => ({ id: nextPublicationId.current++, ...value })) : current.publications;
    const nextProperties = customChanged
      ? (fields.customProperties ?? []).map(value => ({ ...value, id: nextPropertyId.current++, tagDraft: "" })) : current.properties;
    saved.current = fields;
    if (publicationsChanged) acceptedPublications.current = new Map(nextPublications.map(({ id, platform, url }) => [id, { platform, url }]));
    if (customChanged) setHidden(new Set(nextProperties.filter(property => property.value.length === 0).map(property => property.id)));
    setShown(current => new Set([...current, ...builtinNames.filter(name => name === "tags" ? fields.tags.length > 0 : nextValues[name].trim() !== "")]));
    updateDraft({ values: nextValues, cover: fields.coverAssetId ?? null, tags: fields.tags, properties: nextProperties, publications: nextPublications });
  });
  const fieldScope = (name: Builtin) => name === "sourceUrl" || sourceFields.includes(name) ? "source" : name;
  const mark = (scope: string) => dirty.current.set(scope, ++sequence.current);
  function setError(scope: string, message: string) {
    setErrors(current => { const next = { ...current }; if (message) next[scope] = message; else delete next[scope]; return next; });
  }
  function setCover(value: string | null) { updateDraft({ cover: value }); mark("cover"); void saveScope("cover"); }
  function setTags(value: string[]) { updateDraft({ tags: value }); mark("tags"); queueMicrotask(() => void saveScope("tags")); }
  function setTagDraft(value: string) { updateDraft({ tagDraft: value }); mark("tags"); }
  function setProperties(update: (current: PropertyDraft[]) => PropertyDraft[]) {
    updateDraft({ properties: update(draftRef.current.properties) }); mark("custom");
  }
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionError, setCollectionError] = useState("");
  const showCollections = Boolean(onOpenCollection);
  useEffect(() => {
    if (!showCollections) return;
    let live = true;
    void desktop.entryCollections(entry.id).then(result => { if (live) setCollections(result); },
      error => { if (live) setCollectionError(errorMessage(error)); });
    return () => { live = false; };
  }, [entry.id, showCollections]);
  const readOnly = locked || entry.deletedAt !== null;
  function updateProperty(id: number, update: (property: PropertyDraft) => PropertyDraft) {
    setProperties(current => current.map(property => property.id === id ? update(property) : property));
  }
  function showBuiltin(name: Builtin) {
    setShown(current => new Set([...current, name, ...(sourceFields.includes(name) && !values.sourceUrl ? ["sourceUrl" as const] : [])]));
    focusAfterAdd.current = `property-${name}`;
  }
  function setValue(name: Builtin, value: string, commit = false) {
    updateDraft({ values: { ...draftRef.current.values, [name]: value } });
    mark(fieldScope(name));
    if (commit) void saveScope(fieldScope(name));
  }
  function saveScope(scope: string): Promise<boolean> {
    const revision = dirty.current.get(scope);
    if (revision === undefined) return Promise.resolve(true);
    if (readOnly) return Promise.resolve(false);
    const existing = pending.current.get(scope);
    if (existing?.revision === revision) return existing.promise;
    const current = draftRef.current;
    const values = current.values;
    let change: Partial<EntryFields>;
    let publication: { id: number; value: PublicationPlatform | null } | undefined;
    const invalid = (message: string) => { conflicts.current.delete(scope); setError(scope, message); return Promise.resolve(false); };
    const validUrl = (value: string) => !value || /^https?:\/\//i.test(value) && URL.canParse(value);
    if (scope.startsWith("publication:")) {
      const id = Number(scope.slice("publication:".length));
      const row = current.publications.find(row => row.id === id);
      publication = { id, value: row ? { platform: row.platform.trim(), url: row.url.trim() } : null };
      if (publication.value) {
        const { platform, url } = publication.value;
        if (!platform && !url && !acceptedPublications.current.has(id)) { dirty.current.delete(scope); setError(scope, ""); return Promise.resolve(true); }
        if (!platform) return invalid("请选择或输入平台名称");
        if (current.publications.some(other => other.id !== id && other.platform.trim().toLowerCase() === platform.toLowerCase())) return invalid(`「${platform}」已添加`);
        if (!validUrl(url)) return invalid("请输入完整的 HTTP 或 HTTPS 链接");
      }
      change = {};
    } else if (scope === "source") {
      const url = values.sourceUrl.trim();
      if (!url && (values.author.trim() || values.accountName.trim() || values.originalDate)) return invalid("请先填写原文链接，再保存来源信息");
      if (!validUrl(url)) return invalid("请输入完整的 HTTP 或 HTTPS 链接");
      change = { source: url ? { url, author: values.author.trim(), accountName: values.accountName.trim(),
        originalPublishedAt: readPropertyDate(values.originalDate, saved.current.source?.originalPublishedAt),
        importedAt: saved.current.source?.importedAt ?? null } : null };
    } else if (scope === "custom") {
      const customProperties: CustomProperty[] = current.properties.map(({ key, kind, value, tagDraft }) => kind === "tags"
        ? { key: key.trim(), kind, value: addTag(value, tagDraft, []) } : { key: key.trim(), kind, value })
        .filter(property => property.key || property.value.length > 0);
      const keys = customProperties.map(property => property.key.toLowerCase());
      if (keys.some(key => !key) || new Set(keys).size !== keys.length) return invalid("自定义属性名称不能为空或重复");
      updateDraft({ properties: current.properties.map(property => property.kind === "tags"
        ? { ...property, value: addTag(property.value, property.tagDraft, []), tagDraft: "" } : property) });
      change = { customProperties };
    } else if (scope === "tags") {
      const tags = addTag(current.tags, current.tagDraft, tagSuggestions);
      updateDraft({ tags, tagDraft: "" });
      change = { tags };
    } else if (scope === "cover") change = { coverAssetId: current.cover };
    else if (scope === "category") change = { categoryId: values.category || null };
    else if (scope === "status" || scope === "publishedDate") {
      const publishedAt = readPropertyDate(values.publishedDate, saved.current.publishedAt)
        ?? (values.status === "published" ? saved.current.publishedAt ?? Date.now() : null);
      change = { publishedAt, ...(scope === "status" ? { status: values.status as Entry["status"] } : {}) };
      if (scope === "status") updateDraft({ values: { ...values, publishedDate: formatPropertyDate(publishedAt) } });
    } else if (scope === "publishedUrl") {
      const publishedUrl = values.publishedUrl.trim();
      if (!validUrl(publishedUrl)) return invalid("请输入完整的 HTTP 或 HTTPS 链接");
      change = { publishedUrl };
    } else change = { [scope]: values[scope as Builtin].trim() };
    const run = async () => {
      const nextPublications = new Map(acceptedPublications.current);
      if (publication) {
        if (publication.value) nextPublications.set(publication.id, publication.value);
        else nextPublications.delete(publication.id);
        change = { publicationPlatforms: [...nextPublications.values()] };
      }
      try {
        await onSave(entry, change);
        saved.current = { ...saved.current, ...change };
        if (publication) acceptedPublications.current = nextPublications;
        conflicts.current.delete(scope);
        if (dirty.current.get(scope) === revision) { dirty.current.delete(scope); setError(scope, ""); }
        return true;
      } catch (error) {
        if (isConflict(error)) {
          conflicts.current.set(scope, revision);
          if (publication) acceptedPublications.current = nextPublications;
        }
        else conflicts.current.delete(scope);
        if (dirty.current.get(scope) === revision) setError(scope, errorMessage(error));
        return false;
      } finally {
        if (pending.current.get(scope)?.revision === revision) pending.current.delete(scope);
      }
    };
    const promise = serial.current.then(run);
    serial.current = promise;
    pending.current.set(scope, { revision, promise });
    return promise;
  }
  async function flush(closing = false) {
    const results = await Promise.all([...dirty.current.keys()].map(saveScope));
    await serial.current;
    if (results.every(Boolean) && dirty.current.size === 0) return true;
    if (closing && onConflict && dirty.current.size > 0 && [...dirty.current].every(([scope, revision]) => conflicts.current.get(scope) === revision)) {
      onConflict(entry);
      return true;
    }
    return false;
  }
  useLayoutEffect(() => { flushRef.current = flush; return () => { flushRef.current = null; }; });

  function builtinRow(name: Builtin) {
    const field = builtinFields[name];
    const Icon = "icon" in field ? field.icon : propertyTypes[field.kind].icon;
    const id = `property-${name}`;
    const fixed = readOnly || name === "createdDate";
    let editor: ReactNode;
    if (name === "tags") {
      editor = <TagInput id={id} tags={tags} onTags={setTags}
        draft={tagDraft} onDraft={setTagDraft}
        history={tagSuggestions} readOnly={readOnly} label={field.label} />;
    } else if (name === "status") {
      editor = <Select.Root size="1" value={values.status} onValueChange={value => setValue(name, value, true)} disabled={readOnly}>
        <Select.Trigger id={id} aria-label={field.label} />
        <Select.Content>{statuses[entry.kind].map(value => <Select.Item value={value} key={value}>{statusLabels[value]}</Select.Item>)}</Select.Content>
      </Select.Root>;
    } else if (name === "category") {
      editor = <FolderSelect id={id} categories={categories} value={values.category || "none"}
        onChange={value => setValue(name, value === "none" ? "" : value, true)} label={field.label} defaultLabel="根目录" disabled={readOnly} />;
    } else if (name === "summary") {
      editor = <textarea className="property-value" id={id} name={name} rows={1} readOnly={fixed} value={values[name]}
        onChange={event => setValue(name, event.target.value)} placeholder="没有值" />;
    } else {
      const type = field.kind === "date" ? "date" : name === "sourceUrl" || name === "publishedUrl" ? "url" : "text";
      editor = <input className="property-value" id={id} name={name} type={type} readOnly={fixed} value={values[name]}
        onChange={event => setValue(name, event.target.value)} placeholder="没有值" />;
    }
    return <div className="property-row" key={name} data-property-scope={fieldScope(name)}>
      <span className="property-icon" title={propertyTypes[field.kind].label}><Icon size={16} /></span>
      <label htmlFor={id} className="property-name">{field.label}</label>
      <div className="property-editor">{editor}</div>
    </div>;
  }

  const available = builtinNames.filter(name => name !== "createdDate" && name !== "publishedUrl" && !shown.has(name));
  const globalErrors = Object.entries(errors);
  return <form className="properties-form" onSubmit={event => { event.preventDefault(); void flush(); }} noValidate
    onBlur={event => {
      const scope = event.target.closest<HTMLElement>("[data-property-scope]")?.dataset.propertyScope;
      if (scope) void saveScope(scope);
    }}>
    <div className="properties-fields">
      <div className="property-list">
        {builtinNames.filter(name => shown.has(name)).map(builtinRow)}
        {publications.map(({ id, platform, url }) => <PublicationProperty key={id} id={id} value={{ platform, url }} readOnly={readOnly}
          error={errors[`publication:${id}`]} onChange={value => {
            updateDraft({ publications: draftRef.current.publications.map(row => row.id === id ? { id, ...value } : row) });
            mark(`publication:${id}`);
          }} onCommit={() => void saveScope(`publication:${id}`)} onRemove={() => {
            updateDraft({ publications: draftRef.current.publications.filter(row => row.id !== id) });
            mark(`publication:${id}`); void saveScope(`publication:${id}`);
          }} />)}
        {properties.filter(property => !hidden.has(property.id)).map(property => {
          const { icon: Icon, label } = propertyTypes[property.kind];
          const update = (change: (old: PropertyDraft) => PropertyDraft) => updateProperty(property.id, change);
          return <div key={property.id} className="property-row custom-property" data-property-scope="custom">
            {readOnly ? <span className="property-icon" title={label}><Icon size={16} /></span>
              : <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger>
                  <button type="button" className="property-icon" title={label} aria-label={`属性类型：${property.key || "新属性"}`}>
                    <Icon size={16} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content size="1" align="start">
                  <DropdownMenu.Label>属性类型</DropdownMenu.Label>
                  <DropdownMenu.RadioGroup value={property.kind} onValueChange={value => {
                    const converted = changePropertyType(property, value as CustomProperty["kind"]);
                    if (converted) {
                      update(() => converted);
                      void saveScope("custom");
                    } else {
                      setError("custom", "请先清空原值，或将它改为 YYYY-MM-DD 格式");
                    }
                  }}>
                    {Object.entries(propertyTypes).map(([kind, { label, icon: TypeIcon }]) =>
                      <DropdownMenu.RadioItem value={kind} key={kind}><TypeIcon size={14} />{label}</DropdownMenu.RadioItem>)}
                  </DropdownMenu.RadioGroup>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item color="red" onSelect={() => {
                    setProperties(current => current.filter(value => value.id !== property.id));
                    void saveScope("custom");
                  }}><Trash2 size={14} />移除属性</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>}
            <input className="property-name property-key" id={`custom-property-${property.id}`} aria-label="属性名称"
              placeholder="属性名称" readOnly={readOnly} value={property.key}
              onChange={event => {
                const key = event.target.value;
                update(old => ({ ...old, key }));
              }} />
            <div className="property-editor">
              {property.kind === "tags" ? <TagInput label="属性值" tags={property.value} draft={property.tagDraft}
                history={tagSuggestions} readOnly={readOnly}
                onTags={tags => {
                  update(old => ({ ...old, kind: "tags", value: tags }));
                  queueMicrotask(() => void saveScope("custom"));
                }}
                onDraft={tagDraft => update(old => ({ ...old, tagDraft }))} />
                : <input className="property-value" aria-label="属性值" placeholder="没有值" type={property.kind}
                  readOnly={readOnly} value={property.value} onChange={event => {
                    const value = event.target.value;
                    update(old => old.kind === "tags" ? old : { ...old, value });
                  }} />}
            </div>
          </div>;
        })}
        {!readOnly && <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger><button className="property-add" type="button"><Plus size={16} />添加属性</button></DropdownMenu.Trigger>
          <DropdownMenu.Content size="1" align="start" onCloseAutoFocus={event => {
            const id = focusAfterAdd.current;
            if (!id) return;
            event.preventDefault();
            focusAfterAdd.current = null;
            requestAnimationFrame(() => document.getElementById(id)?.focus());
          }}>
            <DropdownMenu.Item onSelect={() => {
              const id = nextPublicationId.current++;
              updateDraft({ publications: [...draftRef.current.publications, { id, platform: "", url: "" }] });
              focusAfterAdd.current = `publication-platform-${id}`;
            }}><Send size={14} />发布平台</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => {
              const id = nextPropertyId.current++;
              setProperties(current => [...current, { id, key: "", kind: "text", value: "", tagDraft: "" }]);
              focusAfterAdd.current = `custom-property-${id}`;
            }}><Plus size={14} />新建自定义属性</DropdownMenu.Item>
            {available.length > 0 && <>
              <DropdownMenu.Separator />
              <DropdownMenu.Label>内置属性</DropdownMenu.Label>
              {available.map(name => {
                const field = builtinFields[name];
                const Icon = "icon" in field ? field.icon : propertyTypes[field.kind].icon;
                return <DropdownMenu.Item key={name} onSelect={() => showBuiltin(name)}><Icon size={14} />{field.label}</DropdownMenu.Item>;
              })}
            </>}
            {hidden.size > 0 && <>
              <DropdownMenu.Separator />
              <DropdownMenu.Label>自定义属性</DropdownMenu.Label>
              {properties.filter(property => hidden.has(property.id)).map(property => {
                const Icon = propertyTypes[property.kind].icon;
                return <DropdownMenu.Item key={property.id} onSelect={() => {
                  setHidden(current => new Set([...current].filter(id => id !== property.id)));
                  focusAfterAdd.current = `custom-property-${property.id}`;
                }}><Icon size={14} />{property.key}</DropdownMenu.Item>;
              })}
            </>}
          </DropdownMenu.Content>
        </DropdownMenu.Root>}
      </div>
      {fields.source?.importedAt && <span className="muted-text">收录于 {dateLabel(fields.source.importedAt)}</span>}
      {cover && <div className="asset-details">
        <span>封面</span><AssetThumb id={cover} name="文章封面" />
        {!readOnly && <Button type="button" size="1" variant="soft" onClick={() => setCover(null)}>移除封面</Button>}
      </div>}
      {entry.links.length > 0 && <div className="linked-entries">
        <span>关联内容</span>
        {entry.links.map(link => <Button key={link.id} variant="soft" size="1" type="button" onClick={async () => { if (await flush()) { onClose(); onOpen(link.id); } }}>
          {link.title || untitled}
        </Button>)}
      </div>}
      {collections.length > 0 && onOpenCollection && <div className="linked-entries">
        <span>所属专题</span>
        {collections.map(collection => <Button key={collection.id} variant="soft" size="1" type="button"
          onClick={async () => { if (await flush()) { onClose(); onOpenCollection(collection.id); } }}>{collection.title}</Button>)}
      </div>}
      {<div className="action-error-slot" tabIndex={(collectionError) ? 0 : -1}>{collectionError ? <p role="alert" className="inline-error">无法读取所属专题。{collectionError}</p> : null}</div>}
      <div className="action-error-slot" tabIndex={globalErrors.length ? 0 : -1}>{globalErrors.length > 0 && <p role="alert" className="inline-error">{globalErrors.map(([scope, message], index) =>
        <span key={scope} id={scope.startsWith("publication:") ? `publication-error-${scope.slice("publication:".length)}` : undefined}>{index > 0 ? "；" : ""}{message}</span>)}</p>}</div>
    </div>
  </form>;
}

export function RevisionsDialog({ id, onClose, onCopy }: {
  id: string;
  onClose(): void;
  onCopy(text: string): Promise<void>;
}) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState("");
  const buttons = useButtonFeedback();
  useEffect(() => {
    void desktop.revisions(id).then(setRevisions, error => setError(errorMessage(error)));
  }, [id]);
  const revision = revisions?.[current];
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Content maxWidth="580px" aria-describedby={undefined}>
    <Dialog.Title>历史版本</Dialog.Title>
    {<div className="action-error-slot" tabIndex={(error) ? 0 : -1}>{error ? <p className="inline-error" role="alert">{error}</p> : null}</div>}
    {revisions === null && !error && <p>正在载入…</p>}
    {revisions?.length === 0 && <p>尚无手动保存的版本</p>}
    {revision && <>
      <div className="button-strip revision-list">
        {revisions!.map((item, index) => <Button size="1" key={item.version} variant={current === index ? "solid" : "soft"} onClick={() => setCurrent(index)}>
          版本 {item.version}
        </Button>)}
      </div>
      <p className="muted-text">{dateLabel(revision.createdAt)} {revision.reason === "manual" ? "手动保存" : "AI 改写前"}</p>
      <TextArea aria-label="该版本正文" readOnly rows={12} value={revision.contentMd} />
    </>}
    <div className="dialog-actions">
      {revision && <Button size="2" variant="soft" {...buttons.props(`copy:${revision.version}`)} loading={buttons.status(`copy:${revision.version}`) === "pending"}
        onClick={() => void buttons.run(`copy:${revision.version}`, () => onCopy(revision.contentMd))}>
        {buttons.label(`copy:${revision.version}`, "复制正文", "已复制")}</Button>}
      <Dialog.Close><Button variant="soft" color="gray">关闭</Button></Dialog.Close>
    </div>
    <ActionError error={revision && buttons.error(`copy:${revision.version}`)} />
  </Dialog.Content></Dialog.Root>;
}

export function DeleteCategoryDialog({ target, onClose, onConfirm }: {
  target: Category;
  onClose(): void;
  onConfirm(trashContents: boolean): Promise<void>;
}) {
  const [trashContents, setTrashContents] = useState(false);
  return <Confirm title="删除文件夹" text={trashContents ? "文档将移入回收站，所有子文件夹将删除。"
    : target.parentId ? "子文件夹和文档将上移到父文件夹。" : "子文件夹和文档将上移到根目录。"}
    action="删除文件夹" onClose={onClose} onConfirm={() => onConfirm(trashContents)}>
    {saving => <RadixText as="label" size="2" className="button-strip" mt="3">
      <Checkbox checked={trashContents} disabled={saving} onCheckedChange={value => setTrashContents(value === true)} />
      同时删除所有子文件夹和文档
    </RadixText>}
  </Confirm>;
}

export function Confirm({ title, text, action, children, onClose, onConfirm }: {
  title: string;
  text: string;
  action: string;
  children?: (saving: boolean) => ReactNode;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const buttons = useButtonFeedback();
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <Dialog.Content maxWidth="410px">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{text}</Dialog.Description>
      {children?.(saving)}
      {<div className="action-error-slot" tabIndex={(error) ? 0 : -1}>{error ? <p role="alert" className="inline-error">{error}</p> : null}</div>}
      <div className="dialog-actions">
        <Dialog.Close><Button variant="soft" color="gray" disabled={saving}>取消</Button></Dialog.Close>
        <Button color="red" loading={saving} {...buttons.props("confirm")} onClick={() => {
          if (!buttons.start("confirm")) return;
          setError("");
          setSaving(true);
          void onConfirm().then(onClose, error => { buttons.finish("confirm", false); setError(errorMessage(error)); }).finally(() => setSaving(false));
        }}>{action}</Button>
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}
