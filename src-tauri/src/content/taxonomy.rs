use crate::db::{AppError, Result, Workspace, id, now, workspace_id};
use rusqlite::{
    Connection, OptionalExtension, Row, params,
    types::{FromSql, FromSqlError, FromSqlResult, ValueRef},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CategoryIcon {
    #[default]
    Folder,
    Lightbulb,
    Book,
    File,
    Bookmark,
    Newspaper,
    Archive,
    Star,
    Code,
    Terminal,
    Globe,
    Link,
    Image,
    Camera,
    Video,
    Music,
    Mic,
    Podcast,
    Headphones,
    Pen,
    Notebook,
    Clipboard,
    Briefcase,
    Graduation,
    Flask,
    Cpu,
    Rocket,
    Sparkles,
    Heart,
    Calendar,
    List,
    Tag,
}

impl CategoryIcon {
    fn key(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Lightbulb => "lightbulb",
            Self::Book => "book",
            Self::File => "file",
            Self::Bookmark => "bookmark",
            Self::Newspaper => "newspaper",
            Self::Archive => "archive",
            Self::Star => "star",
            Self::Code => "code",
            Self::Terminal => "terminal",
            Self::Globe => "globe",
            Self::Link => "link",
            Self::Image => "image",
            Self::Camera => "camera",
            Self::Video => "video",
            Self::Music => "music",
            Self::Mic => "mic",
            Self::Podcast => "podcast",
            Self::Headphones => "headphones",
            Self::Pen => "pen",
            Self::Notebook => "notebook",
            Self::Clipboard => "clipboard",
            Self::Briefcase => "briefcase",
            Self::Graduation => "graduation",
            Self::Flask => "flask",
            Self::Cpu => "cpu",
            Self::Rocket => "rocket",
            Self::Sparkles => "sparkles",
            Self::Heart => "heart",
            Self::Calendar => "calendar",
            Self::List => "list",
            Self::Tag => "tag",
        }
    }
}

impl FromSql for CategoryIcon {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let icon =
            serde::de::value::StrDeserializer::<serde::de::value::Error>::new(value.as_str()?);
        Self::deserialize(icon).map_err(|error| FromSqlError::Other(Box::new(error)))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CategoryPlacement {
    Before,
    After,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub(super) id: String,
    pub parent_id: Option<String>,
    name: String,
    sort_order: i64,
    pub(super) icon: CategoryIcon,
}

fn category_row(row: &Row<'_>) -> rusqlite::Result<Category> {
    Ok(Category {
        id: row.get("id")?,
        parent_id: row.get("parent_id")?,
        name: row.get("name")?,
        sort_order: row.get("sort_order")?,
        icon: row.get("icon")?,
    })
}

#[derive(Serialize)]
pub struct Tag {
    id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryChange {
    id: String,
    category_id: Option<String>,
    version: i64,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CategoryDeleteMode {
    #[default]
    Promote,
    Trash,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    workspace_id: String,
    pub categories: Vec<Category>,
    pub tags: Vec<Tag>,
    tag_suggestions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    article_counts: Option<ArticleCounts>,
}

#[derive(Serialize)]
struct ArticleCounts {
    root: i64,
    folders: BTreeMap<String, i64>,
    tags: BTreeMap<String, i64>,
    untagged: i64,
}

fn article_counts(conn: &Connection) -> Result<ArticleCounts> {
    let mut root = 0;
    let mut folders = BTreeMap::new();
    let mut counts = conn.prepare(
        "SELECT category_id, COUNT(*) FROM entries
         WHERE kind='article' AND deleted_at IS NULL GROUP BY category_id",
    )?;
    for row in counts.query_map([], |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get(1)?))
    })? {
        let (category, count) = row?;
        if let Some(id) = category {
            folders.insert(id, count);
        } else {
            root = count;
        }
    }
    let tags = conn
        .prepare(
            "SELECT r.tag_id, COUNT(*) FROM entries e JOIN entry_tags r ON r.entry_id=e.id
         WHERE e.kind='article' AND e.deleted_at IS NULL GROUP BY r.tag_id",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let untagged = conn.query_row(
        "SELECT COUNT(*) FROM entries e WHERE e.kind='article' AND e.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM entry_tags WHERE entry_id=e.id)",
        [],
        |row| row.get(0),
    )?;
    Ok(ArticleCounts {
        root,
        folders,
        tags,
        untagged,
    })
}

impl Workspace {
    pub fn library(&self) -> Result<Library> {
        self.library_with_article_counts(false)
    }

    pub fn library_with_article_counts(&self, include_counts: bool) -> Result<Library> {
        self.read(|conn| {
            let categories = conn.prepare("SELECT id, parent_id, name, sort_order, icon FROM categories ORDER BY sort_order, id")?
                .query_map([], category_row)?
                .collect::<rusqlite::Result<_>>()?;
            let tags = conn.prepare("SELECT t.id, t.name FROM tags t WHERE EXISTS(SELECT 1 FROM entry_tags WHERE tag_id=t.id) ORDER BY t.normalized")?
                .query_map([], |r| Ok(Tag { id:r.get(0)?, name:r.get(1)? }))?.collect::<rusqlite::Result<_>>()?;
            let tag_suggestions = conn.prepare("SELECT name FROM tags ORDER BY normalized")?
                .query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
            let article_counts = include_counts.then(|| article_counts(conn)).transpose()?;
            Ok(Library { workspace_id: workspace_id(conn)?, categories, tags, tag_suggestions, article_counts })
        })
    }

    pub fn save_category(
        &self,
        category_id: Option<&str>,
        parent_id: Option<&str>,
        name: &str,
        icon: Option<CategoryIcon>,
    ) -> Result<Category> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::invalid("请输入文件夹名称"));
        }
        self.write(|tx| {
            let parent_id = match category_id {
                Some(id) => tx.query_row("SELECT parent_id FROM categories WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0))?,
                None => {
                    if let Some(parent) = parent_id {
                        let depth: i64 = tx.query_row("SELECT depth FROM categories WHERE id=?1", [parent], |r| r.get(0))?;
                        if depth != 1 { return Err(AppError::invalid("文件夹最多两级")); }
                    }
                    parent_id.map(str::to_owned)
                }
            };
            let duplicate: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE AND id IS NOT ?3)",
                params![parent_id, name, category_id], |r| r.get(0),
            )?;
            if duplicate { return Err(AppError::invalid("同一级文件夹已存在此名称")); }
            let category = if let Some(category_id) = category_id {
                tx.query_row(
                    "UPDATE categories SET name=?1,icon=COALESCE(?3,icon) WHERE id=?2
                     RETURNING id,parent_id,name,sort_order,icon",
                    params![name, category_id, icon.map(CategoryIcon::key)],
                    category_row,
                )?
            } else {
                let depth = if parent_id.is_some() { 2 } else { 1 };
                tx.query_row(
                    "INSERT INTO categories (id,parent_id,name,depth,sort_order,icon)
                     SELECT ?1,?2,?3,?4,COALESCE(MAX(sort_order)+1,0),?5 FROM categories WHERE parent_id IS ?2
                     RETURNING id,parent_id,name,sort_order,icon",
                    params![id(), parent_id, name, depth, icon.unwrap_or_default().key()],
                    category_row,
                )?
            };
            Ok(category)
        })
    }

    pub fn delete_category(
        &self,
        id: &str,
        mode: CategoryDeleteMode,
    ) -> Result<Vec<CategoryChange>> {
        self.write(|tx| {
            let parent: Option<String> =
                tx.query_row("SELECT parent_id FROM categories WHERE id=?1", [id], |r| {
                    r.get(0)
                })?;
            crate::sync::record_category_delete(tx, id, mode)?;
            let moved = tx
                .prepare(
                    "UPDATE entries SET category_id=?2, version=version+1, updated_at=?3,
                        deleted_at=CASE WHEN ?4 THEN COALESCE(deleted_at,?3) ELSE deleted_at END
                 WHERE category_id=?1 OR (?4 AND category_id IN (SELECT id FROM categories WHERE parent_id=?1))
                 RETURNING id, category_id, version",
                )?
                .query_map(params![id, parent, now(), matches!(mode, CategoryDeleteMode::Trash)], |row| {
                    Ok(CategoryChange {
                        id: row.get(0)?,
                        category_id: row.get(1)?,
                        version: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if matches!(mode, CategoryDeleteMode::Trash) {
                tx.execute("DELETE FROM categories WHERE parent_id=?1", [id])?;
            } else {
                let children = tx.prepare("SELECT id,name FROM categories WHERE parent_id=?1 ORDER BY sort_order,id")?
                    .query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                // Release the deleted folder's name before promoting a same-named child.
                if !children.is_empty() {
                    tx.execute("UPDATE categories SET name=?2 WHERE id=?1", params![id, crate::db::id()])?;
                }
                let rank: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM categories WHERE parent_id IS ?1", [&parent], |row| row.get(0))?;
                for (rank, (child, name)) in (rank..).zip(children) {
                    let mut promoted_name = name.clone();
                    let mut suffix = 2;
                    while tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE)",
                        params![parent, promoted_name], |row| row.get::<_, bool>(0))? {
                        promoted_name = format!("{name} ({suffix})");
                        suffix += 1;
                    }
                    tx.execute("UPDATE categories SET parent_id=?2,depth=?3,name=?4,sort_order=?5 WHERE id=?1",
                        params![child, parent, if parent.is_some() { 2 } else { 1 }, promoted_name, rank])?;
                }
            }
            tx.execute("DELETE FROM categories WHERE id=?1", [id])?;
            crate::sync::finish_category_delete(tx)?;
            Ok(moved)
        })
    }

    pub fn move_category(&self, id: &str, up: bool) -> Result<()> {
        self.write(|tx| {
            let (parent, rank): (Option<String>, i64) = tx.query_row(
                "SELECT parent_id,sort_order FROM categories WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?)),
            )?;
            let sql = if up {
                "SELECT id, sort_order FROM categories WHERE parent_id IS ?1 AND sort_order<?2 ORDER BY sort_order DESC LIMIT 1"
            } else {
                "SELECT id, sort_order FROM categories WHERE parent_id IS ?1 AND sort_order>?2 ORDER BY sort_order ASC LIMIT 1"
            };
            if let Some((other, other_rank)) = tx.query_row(sql, params![parent, rank], |r| {
                Ok((r.get::<_, String>(0)?,r.get::<_, i64>(1)?))
            }).optional()? {
                tx.execute("UPDATE categories SET sort_order=?1 WHERE id=?2", params![rank, other])?;
                tx.execute("UPDATE categories SET sort_order=?1 WHERE id=?2", params![other_rank, id])?;
            }
            Ok(())
        })
    }

    /// Reorder a folder relative to another folder in the same parent.
    pub fn reorder_category(
        &self,
        id: &str,
        anchor: &str,
        placement: CategoryPlacement,
    ) -> Result<()> {
        self.write(|tx| {
            let parent: Option<String> = tx.query_row(
                "SELECT parent_id FROM categories WHERE id=?1",
                [id],
                |row| row.get(0),
            )?;
            if id == anchor {
                return Ok(());
            }
            let siblings: Vec<String> = tx.prepare(
                "SELECT id FROM categories WHERE parent_id IS ?1 AND id<>?2 ORDER BY sort_order,id",
            )?.query_map(params![parent, id], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
            let index = siblings
                .iter()
                .position(|other| other == anchor)
                .ok_or_else(|| AppError::invalid("只能在同一级目录内排序"))?;
            let index = index + usize::from(matches!(placement, CategoryPlacement::After));
            let mut update =
                tx.prepare("UPDATE categories SET sort_order=?1 WHERE id=?2 AND sort_order<>?1")?;
            let order = siblings[..index]
                .iter()
                .map(String::as_str)
                .chain(std::iter::once(id))
                .chain(siblings[index..].iter().map(String::as_str));
            for (rank, folder) in (0i64..).zip(order) {
                update.execute(params![rank, folder])?;
            }
            Ok(())
        })
    }
}

pub(super) fn replace_tags(conn: &Connection, entry_id: &str, tags: &[String]) -> Result<()> {
    conn.execute("DELETE FROM entry_tags WHERE entry_id=?1", [entry_id])?;
    for label in tags {
        let name = label.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            continue;
        }
        let normalized = name.to_lowercase();
        conn.execute(
            "INSERT INTO tags VALUES (?1,?2,?3) ON CONFLICT(normalized) DO NOTHING",
            params![id(), name, normalized],
        )?;
        conn.execute(
            "INSERT INTO entry_tags SELECT ?1, id FROM tags WHERE normalized=?2 ON CONFLICT DO NOTHING",
            params![entry_id, normalized],
        )?;
    }
    Ok(())
}
