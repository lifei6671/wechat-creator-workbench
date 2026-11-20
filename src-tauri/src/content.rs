pub mod collections;
mod search;
pub(crate) mod sync;
pub mod taxonomy;
pub mod trash;
#[cfg(test)]
mod tests;

use crate::db::{AppError, Result, Workspace, id, now};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use rusqlite::{
    Connection, OptionalExtension, Row, Transaction, params, params_from_iter, types::Value,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, num::NonZeroU32};
use url::Url;

const PAGE_SIZE: i64 = 60;
const HEAD: &str = "e.id, e.kind, e.title, e.status, e.updated_at, e.deleted_at, e.created_at, e.category_id, e.purged_at";
const DIRECTORY_PIN: &str = "e.pinned_order";
const ENTRY_TAG_NAMES: &str = "SELECT t.name FROM tags t JOIN entry_tags r ON r.tag_id=t.id WHERE r.entry_id=?1 ORDER BY t.normalized";

#[derive(Clone, Copy, Deserialize, PartialEq, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Idea,
    Reference,
    Article,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Idea => "idea",
            Self::Reference => "reference",
            Self::Article => "article",
        }
    }
    fn statuses(self) -> [&'static str; 4] {
        match self {
            Self::Idea => ["inbox", "planned", "used", "archived"],
            Self::Reference => ["unread", "reviewed", "used", "archived"],
            Self::Article => ["draft", "ready", "published", "archived"],
        }
    }
    fn from_key(key: &str) -> Self {
        match key {
            "idea" => Self::Idea,
            "reference" => Self::Reference,
            "article" => Self::Article,
            _ => unreachable!("entries.kind is constrained by the migration"),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub(crate) url: String,
    pub(crate) author: String,
    pub(crate) account_name: String,
    pub(crate) original_published_at: Option<i64>,
    pub(crate) imported_at: Option<i64>,
}

#[derive(Deserialize, Serialize)]
struct CustomProperty {
    key: String,
    #[serde(flatten)]
    value: PropertyValue,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum PropertyValue {
    Text(String),
    Date(String),
    Tags(Vec<String>),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fields {
    #[serde(skip_serializing)]
    title: String,
    content_md: String,
    #[serde(skip_serializing)]
    status: String,
    #[serde(skip_serializing)]
    category_id: Option<String>,
    #[serde(default)]
    cover_asset_id: Option<String>,
    #[serde(default)]
    theme_id: Option<String>,
    tags: Vec<String>,
    summary: String,
    source: Option<Source>,
    published_at: Option<i64>,
    published_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    custom_properties: Option<Vec<CustomProperty>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRow {
    id: String,
    kind: String,
    title: String,
    status: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purged_at: Option<i64>,
    category_id: Option<String>,
    pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<EntryPreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_matches: Option<search::Matches>,
}

#[derive(Serialize)]
struct EntryPreview {
    summary: String,
    image: Option<String>,
    tags: Vec<String>,
}

#[derive(Serialize)]
pub struct Entry {
    #[serde(flatten)]
    row: EntryRow,
    #[serde(flatten)]
    fields: Fields,
    version: i64,
    links: Vec<EntryRow>,
}

impl Entry {
    pub(crate) fn with_github_images(mut self) -> Result<Self> {
        if let Some(source) = &self.fields.source
            && source.account_name == "GitHub"
            && let Some(markdown) =
                crate::github_import::convert_saved_html(&self.fields.content_md, &source.url)?
        {
            self.fields.content_md = markdown;
        }
        Ok(self)
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub sort: Option<EntrySort>,
    pub pinned: Option<bool>,
    pub timeline_scope: Option<TimelineSelection>,
    pub kind: Option<Kind>,
    pub status: Option<String>,
    pub category_id: Option<String>,
    #[serde(default)]
    pub exact_category: bool,
    #[serde(default)]
    pub include_preview: bool,
    pub tag_ids: Option<Vec<String>>,
    #[serde(default)]
    pub untagged: bool,
    pub query: Option<String>,
    pub workspace_search: Option<search::WorkspaceSearch>,
    pub deleted: bool,
    #[serde(default)]
    pub wechat_imported: bool,
    #[serde(default)]
    pub external_imported: bool,
    pub offset: i64,
    pub limit: Option<NonZeroU32>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TimelineSelection {
    Root,
    Folder { id: String },
    Tag { id: String },
    Untagged,
}

impl TimelineSelection {
    fn pin_key(&self) -> String {
        match self {
            Self::Root => "root".into(),
            Self::Folder { id } => format!("folder:{id}"),
            Self::Tag { id } => format!("tag:{id}"),
            Self::Untagged => "untagged".into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntrySort {
    Relevance,
    Name,
    NameDesc,
    Updated,
    UpdatedAsc,
    Created,
    CreatedAsc,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    items: Vec<EntryRow>,
    next_offset: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search: Option<search::SearchInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveMode {
    Auto,
    Manual,
    AiReplace,
    #[serde(skip)]
    External,
}

#[derive(Default, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryPatch {
    pub title: Option<String>,
    pub content_md: Option<String>,
    pub status: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub category_id: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
    pub summary: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub published_at: Option<Option<i64>>,
    pub published_url: Option<String>,
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> std::result::Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(de).map(Some)
}

impl EntryPatch {
    fn apply(self, fields: &mut Fields) {
        if let Some(value) = self.title {
            fields.title = value;
        }
        if let Some(value) = self.content_md {
            fields.content_md = value;
        }
        if let Some(value) = self.status {
            fields.status = value;
        }
        if let Some(value) = self.category_id {
            fields.category_id = value;
        }
        if let Some(value) = self.tags {
            fields.tags = value;
        }
        if let Some(value) = self.summary {
            fields.summary = value;
        }
        if let Some(value) = self.published_at {
            fields.published_at = value;
        }
        if let Some(value) = self.published_url {
            fields.published_url = value;
        }
    }
}

#[derive(Serialize)]
pub struct SaveResult {
    version: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    version: i64,
    content_md: String,
    reason: String,
    created_at: i64,
}

impl Workspace {
    pub fn github_reference(&self, url: &str) -> Result<Option<(String, bool)>> {
        self.read_running(|conn| github_reference(conn, url))
    }

    pub fn import_github_reference(
        &self,
        url: String,
        title: String,
        markdown: String,
        category_id: Option<String>,
    ) -> Result<(String, bool, bool)> {
        self.write(|tx| {
            if let Some((entry_id, deleted)) = github_reference(tx, &url)? {
                return Ok((entry_id, true, deleted));
            }
            let kind = Kind::Reference;
            let mut fields = Fields::empty(kind);
            fields.title = title;
            fields.content_md = markdown;
            fields.category_id = category_id;
            fields.source = Some(Source {
                url,
                author: String::new(),
                account_name: "GitHub".into(),
                original_published_at: None,
                imported_at: None,
            });
            let entry = insert_entry(tx, kind, fields, None)?;
            tx.execute("UPDATE entries SET external_imported=1 WHERE id=?1", [&entry.row.id])?;
            Ok((entry.row.id, false, false))
        })
    }

    pub(crate) fn web_reference(&self, url: &str) -> Result<Option<(String, bool)>> {
        self.read_running(|conn| web_reference(conn, url))
    }

    pub(crate) fn import_web_article(
        &self,
        source: Source,
        title: String,
        markdown: String,
        summary: String,
        category_id: Option<String>,
        tags: Vec<String>,
    ) -> Result<(String, bool, bool)> {
        self.write(|tx| {
            if let Some((entry_id, deleted)) = web_reference(tx, &source.url)? {
                return Ok((entry_id, true, deleted));
            }
            let mut fields = Fields::empty(Kind::Article);
            fields.title = title;
            fields.content_md = markdown;
            fields.summary = summary;
            fields.tags = tags;
            fields.category_id = category_id;
            fields.source = Some(source);
            let entry = insert_entry(tx, Kind::Article, fields, None)?;
            tx.execute("UPDATE entries SET external_imported=1 WHERE id=?1", [&entry.row.id])?;
            Ok((entry.row.id, false, false))
        })
    }

    pub fn entries(&self, filter: Filter) -> Result<Page> {
        let search = filter.workspace_search.map(search::WorkspaceSearch::parse);
        let (rows, next_offset, total) = self.read(|conn| {
            let mut values: Vec<Value> = Vec::new();
            let preview_columns = if filter.include_preview { ", e.summary, e.cover_asset_id, e.content_md" } else { "" };
            let search_columns = if search.is_some() { ", e.version AS search_version, COUNT(*) OVER() AS search_total" } else { "" };
            let (pin_order, pin_join) = if let Some(scope) = &filter.timeline_scope {
                values.push(scope.pin_key().into());
                ("tp.pin_order", " LEFT JOIN timeline_entry_pins tp ON tp.scope=? AND tp.entry_id=e.id")
            } else {
                (DIRECTORY_PIN, "")
            };
            let mut sql = format!("SELECT {HEAD}, {pin_order} IS NOT NULL AS pinned{preview_columns}{search_columns}
                FROM entries e{pin_join} WHERE e.purged_at IS NULL AND e.deleted_at IS {}NULL",
                if filter.deleted { "NOT " } else { "" });
            if filter.wechat_imported {
                sql.push_str(" AND e.wechat_imported = 1");
            }
            if filter.external_imported {
                sql.push_str(" AND (e.wechat_imported = 1 OR e.external_imported = 1)");
            }
            if let Some(pinned) = filter.pinned {
                sql.push_str(&format!(" AND {pin_order} IS {}NULL", if pinned { "NOT " } else { "" }));
            }
            if let Some(kind) = filter.kind {
                sql.push_str(" AND e.kind = ?");
                values.push(kind.key().to_owned().into());
            }
            if let Some(status) = filter.status {
                sql.push_str(" AND e.status = ?");
                values.push(status.into());
            }
            if filter.exact_category {
                sql.push_str(" AND e.category_id IS ?");
                values.push(filter.category_id.map_or(Value::Null, Value::Text));
            } else if let Some(category) = filter.category_id {
                sql.push_str(" AND e.category_id IN (SELECT id FROM categories WHERE id = ? OR parent_id = ?)");
                values.push(category.clone().into());
                values.push(category.into());
            }
            for tag in filter.tag_ids.into_iter().flatten() {
                sql.push_str(" AND EXISTS (SELECT 1 FROM entry_tags WHERE entry_id = e.id AND tag_id = ?)");
                values.push(tag.into());
            }
            if filter.untagged {
                sql.push_str(" AND NOT EXISTS (SELECT 1 FROM entry_tags WHERE entry_id = e.id)");
            }
            if let Some(query) = filter.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if query.chars().count() >= 3 {
                    sql.push_str(" AND e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)");
                    values.push(format!("\"{}\"", query.replace('"', "\"\"")).into());
                } else {
                    sql.push_str(" AND (e.title LIKE ? ESCAPE '\\' OR e.content_md LIKE ? ESCAPE '\\')");
                    let literal = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
                    values.push(literal.clone().into());
                    values.push(literal.into());
                }
            }
            if let Some(search) = &search {
                search.apply(conn, &mut sql, &mut values)?;
            }
            if filter.pinned == Some(true) {
                sql.push_str(&format!(" ORDER BY {pin_order}, e.id LIMIT ? OFFSET ?"));
            } else if let (Some(EntrySort::Relevance), Some(search)) = (&filter.sort, &search) {
                search.register_relevance(conn)?;
                sql.push_str(" ORDER BY workspace_title_rank(e.title) DESC, workspace_line_count(e.content_md) DESC,
                    e.title COLLATE NOCASE, e.id DESC LIMIT ? OFFSET ?");
            } else {
                sql.push_str(match filter.sort {
                Some(EntrySort::Name) => " ORDER BY e.title COLLATE NOCASE, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::NameDesc) => " ORDER BY e.title COLLATE NOCASE DESC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::UpdatedAsc) => " ORDER BY e.updated_at ASC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::Created) => " ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::CreatedAsc) => " ORDER BY e.created_at ASC, e.id DESC LIMIT ? OFFSET ?",
                None if filter.exact_category && !filter.deleted => " ORDER BY e.folder_sort_order ASC NULLS LAST, e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::Updated | EntrySort::Relevance) | None => " ORDER BY e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?",
                });
            }
            let limit = filter.limit.map_or(PAGE_SIZE, |limit| i64::from(limit.get()));
            values.push((limit + 1).into());
            let offset = filter.offset.max(0);
            values.push(offset.into());
            let mut statement = conn.prepare(&sql)?;
            let mut tag_names = filter.include_preview.then(|| conn.prepare(ENTRY_TAG_NAMES)).transpose()?;
            let mut search_body = search.as_ref().map(|_| conn.prepare_cached("SELECT content_md FROM entries WHERE id=?1")).transpose()?;
            let mut items = statement.query_map(params_from_iter(values), |row| {
                let entry = entry_row(row)?;
                let preview = if let Some(tags) = &mut tag_names {
                    let summary: String = row.get("summary")?;
                    let cover: Option<String> = row.get("cover_asset_id")?;
                    let markdown = if summary.trim().is_empty() || cover.is_none() {
                        row.get("content_md")?
                    } else {
                        String::new()
                    };
                    let tags = tags.query_map([&entry.id], |row| row.get(0))?
                        .collect::<rusqlite::Result<_>>()?;
                    Some((summary, cover, markdown, tags))
                } else { None };
                let search_result = if let Some(body) = &mut search_body {
                    let body: String = body.query_row([&entry.id], |row| row.get(0))?;
                    Some((body, row.get::<_, i64>("search_version")?, row.get::<_, i64>("search_total")?))
                } else { None };
                Ok((entry, preview, search_result))
            })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let next_offset = (items.len() > limit as usize).then(|| offset + limit);
            let total = items.first().and_then(|(_, _, result)| result.as_ref().map(|(_, _, total)| *total)).unwrap_or(0);
            items.truncate(limit as usize);
            Ok((items, next_offset, total))
        })?;
        let items = rows
            .into_iter()
            .map(|(mut row, preview, search_result)| {
                if let Some((summary, cover, markdown, tags)) = preview {
                    row.preview = Some(entry_preview(&summary, cover, &markdown, tags));
                }
                if let (Some(query), Some((body, version, _))) = (&search, search_result) {
                    row.search_matches = Some(query.matches(&body, version));
                }
                row
            })
            .collect();
        Ok(Page {
            items,
            next_offset,
            search: search.map(|query| search::SearchInfo {
                total,
                clauses: query.clauses,
            }),
        })
    }

    pub fn get_entry(&self, id: &str) -> Result<Entry> {
        self.read(|conn| get_entry(conn, id))
    }

    pub fn create_external(&self, kind: Kind, patch: EntryPatch) -> Result<Entry> {
        let mut fields = Fields::empty(kind);
        patch.apply(&mut fields);
        self.create_entry(kind, Some(fields), None)
    }

    pub fn update_external(
        &self,
        id: &str,
        expected_version: i64,
        patch: EntryPatch,
    ) -> Result<SaveResult> {
        let mut fields = self.get_entry(id)?.fields;
        patch.apply(&mut fields);
        self.save_entry(id, expected_version, fields, SaveMode::External)
    }

    pub fn create_entry(
        &self,
        kind: Kind,
        fields: Option<Fields>,
        source_entry_id: Option<String>,
    ) -> Result<Entry> {
        self.write(|tx| {
            let base = source_entry_id
                .as_deref()
                .map(|source_id| get_entry(tx, source_id))
                .transpose()?;
            if let Some(base) = &base
                && (kind != Kind::Article
                    || base.row.kind == "article"
                    || base.row.deleted_at.is_some())
            {
                return Err(AppError::invalid("只能从待整理的旧笔记创建发布副本"));
            }
            let fields = fields.unwrap_or_else(|| {
                let mut fields = Fields::empty(kind);
                if let Some(base) = &base {
                    fields.title.clone_from(&base.fields.title);
                    fields.content_md.clone_from(&base.fields.content_md);
                }
                fields
            });
            insert_entry(tx, kind, fields, source_entry_id.as_deref())
        })
    }

    pub fn save_entry(
        &self,
        id: &str,
        expected_version: i64,
        fields: Fields,
        mode: SaveMode,
    ) -> Result<SaveResult> {
        let operation = |tx: &Transaction<'_>| {
            let (kind, version, deleted): (String, i64, bool) = tx.query_row(
                "SELECT kind, version, deleted_at IS NOT NULL FROM entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            if version != expected_version {
                return Err(AppError::conflict(version));
            }
            if deleted {
                return Err(AppError::invalid("请先从回收站恢复内容"));
            }
            let timestamp = now();
            let source_id = validate_fields(tx, id, Kind::from_key(&kind), &fields, timestamp, false)?;
            if matches!(mode, SaveMode::AiReplace) {
                record_revision(tx, id, "before_ai_replace", timestamp)?;
            }
            tx.execute(
                "UPDATE entries SET title=?2, content_md=?3, status=?4, category_id=?5, source_id=?6, summary=?7,
                 published_at=?8, published_url=?9, version=version+1, updated_at=?10, cover_asset_id=?11, theme_id=?12,
                 custom_properties=COALESCE(?13, custom_properties), source_details=?14 WHERE id=?1",
                params![id, fields.title, fields.content_md, fields.status, fields.category_id, source_id,
                        fields.summary, fields.published_at, fields.published_url, timestamp, fields.cover_asset_id,
                        fields.theme_id, fields.encoded_properties()?, source_details(&fields, timestamp)],
            )?;
            crate::assets::references::sync_entry(tx, id, &fields.content_md)?;
            taxonomy::replace_tags(tx, id, &fields.tags)?;
            if matches!(mode, SaveMode::Manual) {
                record_revision(tx, id, "manual", timestamp)?;
            }
            Ok(SaveResult {
                version: version + 1,
            })
        };
        match mode {
            SaveMode::Auto | SaveMode::Manual | SaveMode::AiReplace => self.save(operation),
            SaveMode::External => self.write(operation),
        }
    }

    pub fn set_entry_pinned(&self, id: &str, pinned: bool) -> Result<()> {
        self.write(|tx| {
            let changed = tx.execute(
                "UPDATE entries SET pinned_order = CASE WHEN ?2 THEN
                    COALESCE(pinned_order, (SELECT COALESCE(MIN(pinned_order), 0) - 1 FROM entries))
                    ELSE NULL END WHERE id = ?1 AND deleted_at IS NULL",
                params![id, pinned],
            )?;
            if changed == 0 {
                return Err(AppError::new("NOT_FOUND", "找不到可置顶的文档"));
            }
            Ok(())
        })
    }

    pub fn set_timeline_entry_pinned(&self, id: &str, scope: &TimelineSelection, pinned: bool) -> Result<()> {
        let scope = scope.pin_key();
        self.write(|tx| {
            if pinned {
                let changed = tx.execute(
                    "INSERT INTO timeline_entry_pins(scope, entry_id, pin_order)
                    SELECT ?1, e.id, (SELECT COALESCE(MIN(pin_order), 0) - 1 FROM timeline_entry_pins WHERE scope=?1)
                    FROM entries e WHERE e.id=?2 AND e.kind='article' AND e.deleted_at IS NULL
                    ON CONFLICT(scope, entry_id) DO UPDATE SET pin_order=timeline_entry_pins.pin_order",
                    params![scope, id],
                )?;
                if changed == 0 {
                    return Err(AppError::new("NOT_FOUND", "找不到可置顶的文章"));
                }
            } else {
                tx.execute("DELETE FROM timeline_entry_pins WHERE scope=?1 AND entry_id=?2", params![scope, id])?;
            }
            Ok(())
        })
    }

    pub fn reorder_entry(
        &self,
        id: &str,
        anchor: &str,
        placement: taxonomy::CategoryPlacement,
    ) -> Result<()> {
        self.write(|tx| {
            let (folder, pinned): (Option<String>, bool) = tx.query_row(
                "SELECT category_id, pinned_order IS NOT NULL FROM entries WHERE id=?1 AND deleted_at IS NULL",
                [id], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if id == anchor { return Ok(()); }
            let column = if pinned { "pinned_order" } else { "folder_sort_order" };
            let mut statement = tx.prepare(&format!(
                "SELECT id, deleted_at IS NULL AND (pinned_order IS NOT NULL) = ?3
                 FROM entries WHERE id <> ?1
                 AND CASE WHEN ?3 THEN pinned_order IS NOT NULL ELSE category_id IS ?2 END
                 ORDER BY {column} ASC NULLS LAST, updated_at DESC, id DESC",
            ))?;
            let mut siblings = statement.query_map(params![id, folder, pinned], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            let index = siblings.iter().position(|(other, active)| *active && other == anchor)
                .ok_or_else(|| AppError::invalid(if pinned { "只能在置顶区排序置顶文档" } else { "只能在同一目录中排序未置顶文档" }))?;
            let index = index + usize::from(matches!(placement, taxonomy::CategoryPlacement::After));
            siblings.insert(index, (id.to_owned(), true));
            let mut update = tx.prepare(&format!("UPDATE entries SET {column}=?1 WHERE id=?2 AND {column} IS NOT ?1"))?;
            for (rank, (entry, _)) in (0i64..).zip(siblings) {
                update.execute(params![rank, entry])?;
            }
            Ok(())
        })
    }

    pub fn set_deleted(&self, id: &str, expected_version: i64, deleted: bool) -> Result<Entry> {
        self.write(|tx| {
            if tx.query_row("SELECT purged_at IS NOT NULL FROM entries WHERE id=?1", [id], |row| row.get::<_,bool>(0))? {
                return Err(AppError::invalid("内容已永久删除"));
            }
            let version: i64 =
                tx.query_row("SELECT version FROM entries WHERE id=?1", [id], |row| {
                    row.get(0)
                })?;
            if version != expected_version {
                return Err(AppError::conflict(version));
            }
            let timestamp = now();
            tx.execute(
                "UPDATE entries SET deleted_at=?2, updated_at=?3, version=version+1 WHERE id=?1",
                params![id, deleted.then_some(timestamp), timestamp],
            )?;
            get_entry(tx, id)
        })
    }

    pub fn export_text(&self, id: &str) -> Result<(String, String)> {
        self.read(|conn| {
            Ok(conn.query_row(
                "SELECT title, content_md FROM entries WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
    }

    pub fn revisions(&self, id: &str) -> Result<Vec<Revision>> {
        self.read(|conn| {
            let mut statement = conn.prepare("SELECT version, content_md, reason, created_at FROM entry_revisions WHERE entry_id=?1 ORDER BY version DESC")?;
            Ok(statement.query_map([id], |r| Ok(Revision {
                version: r.get(0)?, content_md: r.get(1)?, reason: r.get(2)?, created_at: r.get(3)?,
            }))?.collect::<rusqlite::Result<_>>()?)
        })
    }
}

impl Fields {
    fn empty(kind: Kind) -> Self {
        Self {
            title: String::new(),
            content_md: String::new(),
            status: kind.statuses()[0].into(),
            category_id: None,
            cover_asset_id: None,
            theme_id: None,
            tags: Vec::new(),
            summary: String::new(),
            source: None,
            published_at: None,
            published_url: String::new(),
            custom_properties: None,
        }
    }

    fn encoded_properties(&self) -> Result<Option<String>> {
        let Some(properties) = &self.custom_properties else { return Ok(None) };
        let mut keys = HashSet::new();
        for property in properties {
            let key = property.key.trim();
            if key.is_empty() || !keys.insert(key.to_lowercase()) {
                return Err(AppError::invalid("自定义属性名称不能为空或重复"));
            }
            if let PropertyValue::Date(date) = &property.value
                && !date.is_empty()
                && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
                return Err(AppError::invalid("自定义日期无效"));
            }
        }
        Ok(Some(serde_json::to_string(properties).expect("properties serialize to JSON")))
    }
}

fn entry_row(row: &Row<'_>) -> rusqlite::Result<EntryRow> {
    Ok(EntryRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        status: row.get(3)?,
        created_at: row.get("created_at")?,
        updated_at: row.get(4)?,
        deleted_at: row.get(5)?,
        purged_at: row.get("purged_at")?,
        category_id: row.get("category_id")?,
        pinned: row.get("pinned")?,
        preview: None,
        search_matches: None,
    })
}

fn entry_preview(
    summary: &str,
    cover: Option<String>,
    markdown: &str,
    tags: Vec<String>,
) -> EntryPreview {
    const SUMMARY_LENGTH: usize = 200;
    let mut image = cover.map(|id| format!("asset://{id}"));
    let mut summary = summary
        .trim()
        .chars()
        .take(SUMMARY_LENGTH)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let needs_summary = summary.is_empty();
    let find_image = image.is_none() && markdown.contains("![");
    if !needs_summary && !find_image {
        return EntryPreview {
            summary,
            image,
            tags,
        };
    }
    let markdown = if find_image {
        markdown
    } else {
        &markdown[..markdown.floor_char_boundary(16_384)]
    };
    let mut image_depth = 0;
    let mut in_code = false;
    for event in Parser::new_ext(
        markdown,
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES,
    ) {
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => {
                image_depth += 1;
                if image.is_none()
                    && ["asset://", "http://", "https://"]
                        .iter()
                        .any(|prefix| dest_url.starts_with(prefix))
                {
                    image = Some(dest_url.into_string());
                }
            }
            Event::End(TagEnd::Image) => image_depth -= 1,
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Text(text) | Event::Code(text)
                if needs_summary
                    && image_depth == 0
                    && !in_code
                    && summary.chars().count() < SUMMARY_LENGTH =>
            {
                summary.extend(text.chars().take(SUMMARY_LENGTH - summary.chars().count()));
            }
            Event::SoftBreak
            | Event::HardBreak
            | Event::End(TagEnd::Paragraph | TagEnd::Heading(_))
                if needs_summary
                    && !summary.is_empty()
                    && !summary.ends_with(char::is_whitespace)
                    && summary.chars().count() < SUMMARY_LENGTH =>
            {
                summary.push(' ');
            }
            _ => {}
        }
        if (!needs_summary || summary.chars().count() == SUMMARY_LENGTH)
            && (image.is_some() || !find_image)
        {
            break;
        }
    }
    EntryPreview {
        summary: summary.split_whitespace().collect::<Vec<_>>().join(" "),
        image,
        tags,
    }
}

fn get_entry(conn: &Connection, id: &str) -> Result<Entry> {
    let sql = format!("SELECT {HEAD}, {DIRECTORY_PIN} IS NOT NULL AS pinned, e.content_md, e.summary, e.published_at, e.published_url, e.version, e.custom_properties,
           s.source_url,
           COALESCE(e.source_details->>'$.author',s.author) AS author,
           COALESCE(e.source_details->>'$.accountName',s.account_name) AS account_name,
           CASE WHEN e.source_details IS NULL THEN s.original_published_at
                ELSE e.source_details->>'$.originalPublishedAt' END AS original_published_at,
           COALESCE(e.source_details->>'$.importedAt',s.imported_at) AS imported_at,
           e.cover_asset_id, e.theme_id
        FROM entries e LEFT JOIN sources s ON s.id=e.source_id WHERE e.id=?1");
    let mut entry = conn.query_row(&sql, [id], |r| {
        let row = entry_row(r)?;
        let properties_column = r.as_ref().column_index("custom_properties")?;
        let source = r
            .get::<_, Option<String>>("source_url")?
            .map(|url| -> rusqlite::Result<_> {
                Ok(Source {
                    url,
                    author: r.get("author")?,
                    account_name: r.get("account_name")?,
                    original_published_at: r.get("original_published_at")?,
                    imported_at: r.get("imported_at")?,
                })
            })
            .transpose()?;
        let fields = Fields {
            title: row.title.clone(),
            content_md: r.get("content_md")?,
            status: row.status.clone(),
            category_id: row.category_id.clone(),
            cover_asset_id: r.get("cover_asset_id")?,
            theme_id: r.get("theme_id")?,
            tags: vec![],
            summary: r.get("summary")?,
            source,
            published_at: r.get("published_at")?,
            published_url: r.get("published_url")?,
            custom_properties: serde_json::from_str::<Vec<CustomProperty>>(&r.get::<_, String>("custom_properties")?)
                .map(Some)
                .map_err(|error| rusqlite::Error::FromSqlConversionFailure(
                    properties_column, rusqlite::types::Type::Text, Box::new(error)
                ))?,
        };
        Ok(Entry {
            row,
            fields,
            version: r.get("version")?,
            links: vec![],
        })
    })?;
    let mut tags = conn.prepare(ENTRY_TAG_NAMES)?;
    entry.fields.tags = tags
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let links = format!(
        "SELECT {HEAD}, {DIRECTORY_PIN} IS NOT NULL AS pinned FROM entry_links l JOIN entries e
        ON e.id=CASE WHEN l.article_id=?1 THEN l.source_entry_id ELSE l.article_id END
        WHERE l.article_id=?1 OR l.source_entry_id=?1 ORDER BY e.updated_at DESC"
    );
    entry.links = conn
        .prepare(&links)?
        .query_map([id], entry_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(entry)
}

fn github_reference(conn: &Connection, url: &str) -> Result<Option<(String, bool)>> {
    Ok(conn
        .query_row(
            "SELECT e.id,e.deleted_at IS NOT NULL FROM entries e JOIN sources s ON s.id=e.source_id
         WHERE RTRIM(s.source_url, '/') = ?1 COLLATE NOCASE
         ORDER BY e.deleted_at IS NOT NULL,e.created_at,e.id LIMIT 1",
            [url],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn web_reference(conn: &Connection, url: &str) -> Result<Option<(String, bool)>> {
    Ok(conn.query_row(
        "SELECT e.id, e.deleted_at IS NOT NULL FROM entries e JOIN sources s ON s.id=e.source_id
         WHERE s.source_url=?1 ORDER BY e.deleted_at IS NOT NULL,e.created_at,e.id LIMIT 1",
        [url], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?)
}

fn insert_entry(
    tx: &Transaction<'_>,
    kind: Kind,
    fields: Fields,
    source_entry_id: Option<&str>,
) -> Result<Entry> {
    let timestamp = now();
    let entry_id = id();
    let source_id = validate_fields(tx, &entry_id, kind, &fields, timestamp, false)?;
    tx.execute(
        "INSERT INTO entries (id, kind, title, content_md, status, category_id, source_id, summary,
                              created_at, updated_at, published_at, published_url, cover_asset_id, theme_id, custom_properties, source_details)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10,?11,?12,?13,COALESCE(?14,'[]'),?15)",
        params![entry_id, kind.key(), fields.title, fields.content_md, fields.status,
                fields.category_id, source_id, fields.summary, timestamp, fields.published_at, fields.published_url, fields.cover_asset_id, fields.theme_id,
                fields.encoded_properties()?, source_details(&fields, timestamp)],
    )?;
    crate::assets::references::sync_entry(tx, &entry_id, &fields.content_md)?;
    taxonomy::replace_tags(tx, &entry_id, &fields.tags)?;
    if let Some(source_entry_id) = source_entry_id {
        tx.execute(
            "INSERT INTO entry_links VALUES (?1, ?2)",
            params![entry_id, source_entry_id],
        )?;
    }
    get_entry(tx, &entry_id)
}

fn source_details(fields: &Fields, timestamp: i64) -> Option<String> {
    fields.source.as_ref().map(|source| serde_json::json!({
        "author": source.author,
        "accountName": source.account_name,
        "originalPublishedAt": source.original_published_at,
        "importedAt": source.imported_at.unwrap_or(timestamp),
    }).to_string())
}

fn validate_fields(
    conn: &Connection,
    entry_id: &str,
    kind: Kind,
    fields: &Fields,
    timestamp: i64,
    allow_shared_source: bool,
) -> Result<Option<String>> {
    if !kind.statuses().contains(&fields.status.as_str()) {
        return Err(AppError::invalid("状态与内容类型不匹配"));
    }
    if let Some(category) = &fields.category_id {
        conn.query_row("SELECT id FROM categories WHERE id=?1", [category], |_| {
            Ok(())
        })
        .optional()?
        .ok_or_else(|| AppError::invalid("所选文件夹已不存在"))?;
    }
    if !fields.published_url.trim().is_empty() {
        http_url(&fields.published_url)?;
    }
    fields.source.as_ref().map(|source| {
        let mut url = http_url(&source.url)?;
        url.set_fragment(None);
        if !allow_shared_source && conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sources s JOIN entries e ON e.source_id=s.id
                           WHERE s.source_url=?1 AND e.id<>?2
                           AND NOT EXISTS(SELECT 1 FROM entries current
                                          WHERE current.id=?2 AND current.source_id=s.id))",
            params![url.as_str(), entry_id], |row| row.get::<_, bool>(0),
        )? {
            return Err(AppError::invalid("此原文链接已收录，请使用已有笔记"));
        }
        conn.execute(
            "INSERT INTO sources VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(source_url) DO NOTHING",
            params![id(), url.as_str(), source.author, source.account_name, source.original_published_at, timestamp],
        )?;
        Ok(conn.query_row("SELECT id FROM sources WHERE source_url=?1", [url.as_str()], |row| row.get(0))?)
    }).transpose()
}

pub(crate) fn http_url(value: &str) -> Result<Url> {
    Url::parse(value.trim())
        .ok()
        .filter(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.has_host()
                && u.username().is_empty()
                && u.password().is_none()
        })
        .ok_or_else(|| AppError::invalid("请输入有效的 HTTP 或 HTTPS 链接"))
}

fn record_revision(conn: &Connection, id: &str, reason: &str, timestamp: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO entry_revisions SELECT id, version, content_md, ?2, ?3 FROM entries WHERE id=?1
         ON CONFLICT(entry_id, version) DO NOTHING",
        params![id, reason, timestamp],
    )?;
    conn.execute(
        "DELETE FROM entry_revisions WHERE entry_id=?1 AND version NOT IN
         (SELECT version FROM entry_revisions WHERE entry_id=?1 ORDER BY version DESC LIMIT 3)",
        [id],
    )?;
    Ok(())
}
