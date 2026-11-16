mod search;
pub mod taxonomy;
#[cfg(test)]
mod tests;

use crate::db::{AppError, Result, Workspace, id, now};
use rusqlite::{
    Connection, OptionalExtension, Row, Transaction, params, params_from_iter, types::Value,
};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;
use url::Url;

const PAGE_SIZE: i64 = 60;
const HEAD: &str = "e.id, e.kind, e.title, e.status, e.updated_at, e.deleted_at";

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
    url: String,
    author: String,
    account_name: String,
    original_published_at: Option<i64>,
    imported_at: Option<i64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fields {
    #[serde(skip_serializing)]
    title: String,
    content_md: String,
    #[serde(skip_serializing)]
    status: String,
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRow {
    id: String,
    kind: String,
    title: String,
    status: String,
    updated_at: i64,
    deleted_at: Option<i64>,
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

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub sort: Option<EntrySort>,
    pub kind: Option<Kind>,
    pub status: Option<String>,
    pub category_id: Option<String>,
    #[serde(default)]
    pub exact_category: bool,
    pub tag_ids: Option<Vec<String>>,
    pub query: Option<String>,
    pub workspace_search: Option<search::WorkspaceSearch>,
    pub deleted: bool,
    #[serde(default)]
    pub wechat_imported: bool,
    pub offset: i64,
    pub limit: Option<NonZeroU32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntrySort {
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
    pub fn entries(&self, filter: Filter) -> Result<Page> {
        self.read(|conn| {
            let mut values: Vec<Value> = Vec::new();
            let mut sql = format!("SELECT {HEAD} FROM entries e WHERE e.deleted_at IS {}NULL",
                if filter.deleted { "NOT " } else { "" });
            if filter.wechat_imported {
                sql.push_str(" AND e.wechat_imported = 1");
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
            if let Some(search) = filter.workspace_search {
                search.apply(conn, &mut sql, &mut values)?;
            }
            sql.push_str(match filter.sort {
                Some(EntrySort::Name) => " ORDER BY e.title COLLATE NOCASE, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::NameDesc) => " ORDER BY e.title COLLATE NOCASE DESC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::UpdatedAsc) => " ORDER BY e.updated_at ASC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::Created) => " ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::CreatedAsc) => " ORDER BY e.created_at ASC, e.id DESC LIMIT ? OFFSET ?",
                None if filter.exact_category && !filter.deleted => " ORDER BY e.folder_sort_order ASC NULLS LAST, e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?",
                Some(EntrySort::Updated) | None => " ORDER BY e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?",
            });
            let limit = filter.limit.map_or(PAGE_SIZE, |limit| i64::from(limit.get()));
            values.push((limit + 1).into());
            let offset = filter.offset.max(0);
            values.push(offset.into());
            let mut statement = conn.prepare(&sql)?;
            let mut items = statement.query_map(params_from_iter(values), entry_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let next_offset = (items.len() > limit as usize).then(|| offset + limit);
            items.truncate(limit as usize);
            Ok(Page { items, next_offset })
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
            let base = source_entry_id.as_deref().map(|source_id| get_entry(tx, source_id)).transpose()?;
            if let Some(base) = &base
                && (kind != Kind::Article || base.row.kind == "article" || base.row.deleted_at.is_some())
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
            let timestamp = now();
            let entry_id = id();
            let source_id = validate_fields(tx, &entry_id, kind, &fields, timestamp)?;
            tx.execute(
                "INSERT INTO entries (id, kind, title, content_md, status, category_id, source_id, summary,
                                      created_at, updated_at, published_at, published_url, cover_asset_id, theme_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10,?11,?12,?13)",
                params![entry_id, kind.key(), fields.title, fields.content_md, fields.status,
                        fields.category_id, source_id, fields.summary, timestamp, fields.published_at, fields.published_url, fields.cover_asset_id, fields.theme_id],
            )?;
            crate::assets::references::sync_entry(tx, &entry_id, &fields.content_md)?;
            taxonomy::replace_tags(tx, &entry_id, &fields.tags)?;
            if let Some(source_entry_id) = source_entry_id {
                tx.execute("INSERT INTO entry_links VALUES (?1, ?2)", params![entry_id, source_entry_id])?;
            }
            get_entry(tx, &entry_id)
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
            let source_id = validate_fields(tx, id, Kind::from_key(&kind), &fields, timestamp)?;
            if matches!(mode, SaveMode::AiReplace) {
                record_revision(tx, id, "before_ai_replace", timestamp)?;
            }
            tx.execute(
                "UPDATE entries SET title=?2, content_md=?3, status=?4, category_id=?5, source_id=?6, summary=?7,
                 published_at=?8, published_url=?9, version=version+1, updated_at=?10, cover_asset_id=?11, theme_id=?12 WHERE id=?1",
                params![id, fields.title, fields.content_md, fields.status, fields.category_id, source_id,
                        fields.summary, fields.published_at, fields.published_url, timestamp, fields.cover_asset_id, fields.theme_id],
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

    pub fn reorder_entry(
        &self,
        id: &str,
        anchor: &str,
        placement: taxonomy::CategoryPlacement,
    ) -> Result<()> {
        self.write(|tx| {
            let folder: Option<String> = tx.query_row(
                "SELECT category_id FROM entries WHERE id=?1 AND deleted_at IS NULL",
                [id], |row| row.get(0),
            )?;
            if id == anchor { return Ok(()); }
            let mut statement = tx.prepare(
                "SELECT id, deleted_at IS NULL FROM entries WHERE category_id IS ?1 AND id<>?2
                 ORDER BY folder_sort_order ASC NULLS LAST, updated_at DESC, id DESC",
            )?;
            let mut siblings = statement.query_map(params![folder, id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            let index = siblings.iter().position(|(other, active)| *active && other == anchor)
                .ok_or_else(|| AppError::invalid("只能在同一目录中排序有效文档"))?;
            let index = index + usize::from(matches!(placement, taxonomy::CategoryPlacement::After));
            siblings.insert(index, (id.to_owned(), true));
            let mut update = tx.prepare("UPDATE entries SET folder_sort_order=?1 WHERE id=?2 AND folder_sort_order IS NOT ?1")?;
            for (rank, (entry, _)) in (0i64..).zip(siblings) {
                update.execute(params![rank, entry])?;
            }
            Ok(())
        })
    }

    pub fn set_deleted(&self, id: &str, expected_version: i64, deleted: bool) -> Result<Entry> {
        self.write(|tx| {
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
        }
    }
}

fn entry_row(row: &Row<'_>) -> rusqlite::Result<EntryRow> {
    Ok(EntryRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        status: row.get(3)?,
        updated_at: row.get(4)?,
        deleted_at: row.get(5)?,
    })
}

fn get_entry(conn: &Connection, id: &str) -> Result<Entry> {
    let sql = format!("SELECT {HEAD}, e.content_md, e.category_id, e.summary, e.published_at, e.published_url, e.version,
           s.source_url, s.author, s.account_name, s.original_published_at, s.imported_at, e.cover_asset_id, e.theme_id
        FROM entries e LEFT JOIN sources s ON s.id=e.source_id WHERE e.id=?1");
    let mut entry = conn.query_row(&sql, [id], |r| {
        let row = entry_row(r)?;
        let source = r
            .get::<_, Option<String>>(12)?
            .map(|url| -> rusqlite::Result<_> {
                Ok(Source {
                    url,
                    author: r.get(13)?,
                    account_name: r.get(14)?,
                    original_published_at: r.get(15)?,
                    imported_at: r.get(16)?,
                })
            })
            .transpose()?;
        let fields = Fields {
            title: row.title.clone(),
            content_md: r.get(6)?,
            status: row.status.clone(),
            category_id: r.get(7)?,
            cover_asset_id: r.get(17)?,
            theme_id: r.get(18)?,
            tags: vec![],
            summary: r.get(8)?,
            source,
            published_at: r.get(9)?,
            published_url: r.get(10)?,
        };
        Ok(Entry {
            row,
            fields,
            version: r.get(11)?,
            links: vec![],
        })
    })?;
    let mut tags = conn.prepare("SELECT t.name FROM tags t JOIN entry_tags r ON r.tag_id=t.id WHERE r.entry_id=?1 ORDER BY t.normalized")?;
    entry.fields.tags = tags
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let links = format!(
        "SELECT {HEAD} FROM entry_links l JOIN entries e
        ON e.id=CASE WHEN l.article_id=?1 THEN l.source_entry_id ELSE l.article_id END
        WHERE l.article_id=?1 OR l.source_entry_id=?1 ORDER BY e.updated_at DESC"
    );
    entry.links = conn
        .prepare(&links)?
        .query_map([id], entry_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(entry)
}

fn validate_fields(
    conn: &Connection,
    entry_id: &str,
    kind: Kind,
    fields: &Fields,
    timestamp: i64,
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
        let already_collected: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sources s JOIN entries e ON e.source_id=s.id
                           WHERE s.source_url=?1 AND e.id<>?2)",
            params![url.as_str(), entry_id], |row| row.get(0),
        )?;
        if already_collected {
            return Err(AppError::invalid("此原文链接已收录，请使用已有笔记"));
        }
        let source_id = conn.query_row(
            "INSERT INTO sources VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(source_url) DO UPDATE SET author=excluded.author, account_name=excluded.account_name,
             original_published_at=excluded.original_published_at RETURNING id",
            params![id(), url.as_str(), source.author, source.account_name, source.original_published_at, timestamp],
            |r| r.get(0),
        )?;
        Ok(source_id)
    }).transpose()
}

fn http_url(value: &str) -> Result<Url> {
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
