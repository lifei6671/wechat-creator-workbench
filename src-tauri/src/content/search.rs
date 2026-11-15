use pulldown_cmark::{Event, Parser, Tag};
use rusqlite::{Connection, functions::FunctionFlags, types::Value};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearch {
    pub(super) text: String,
    pub(super) case_sensitive: bool,
}

const PATH: &str = "(COALESCE((SELECT COALESCE(p.name || '/', '') || c.name || '/'
    FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=e.category_id),'') || e.title)";
const SOURCE: &str = "COALESCE((SELECT s.source_url || ' ' || s.author || ' ' || s.account_name
    FROM sources s WHERE s.id=e.source_id),'')";

impl WorkspaceSearch {
    pub(super) fn apply(
        self,
        conn: &Connection,
        sql: &mut String,
        values: &mut Vec<Value>,
    ) -> rusqlite::Result<()> {
        let flags = FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_DIRECTONLY;
        if !self.case_sensitive {
            conn.create_scalar_function("workspace_contains", 2, flags, |args| {
                let text = args.get::<String>(0)?;
                let needle = args.get::<String>(1)?;
                Ok(text.to_lowercase().contains(&needle))
            })?;
        }
        let mut scoped = Vec::new();
        for token in terms(&self.text) {
            if let Some(property) = token.strip_prefix('[') {
                if let Some(property) = property.strip_suffix(']') {
                    self.property(property, sql, values);
                }
                continue;
            }
            if let Some((scope, value)) = token.split_once(':') {
                if matches!(scope, "line" | "section") {
                    let words = scope_terms(value, self.case_sensitive);
                    if words.is_empty() {
                        continue;
                    }
                    sql.push_str(" AND workspace_scope(e.content_md, ?)");
                    values.push((scoped.len() as i64).into());
                    scoped.push((scope == "section", words));
                    continue;
                }
                if matches!(scope, "file" | "path" | "tag") {
                    let value = phrase(value);
                    if value.is_empty() {
                        continue;
                    }
                    match scope {
                        "file" => self.contains(sql, values, "e.title", value),
                        "path" => self.contains(sql, values, PATH, value),
                        _ => {
                            sql.push_str(" AND EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=e.id");
                            self.contains(
                                sql,
                                values,
                                "t.name",
                                value.trim_start_matches('#').to_owned(),
                            );
                            sql.push(')');
                        }
                    }
                    continue;
                }
            }
            let value = phrase(token);
            if value.is_empty() {
                continue;
            }
            if !self.case_sensitive && value.chars().count() >= 3 {
                sql.push_str(
                    " AND e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)",
                );
                values.push(format!("\"{}\"", value.replace('"', "\"\"")).into());
            } else {
                self.contains(sql, values, "(e.title || char(10) || e.content_md)", value);
            }
        }
        if !scoped.is_empty() {
            let case_sensitive = self.case_sensitive;
            conn.create_scalar_function("workspace_scope", 2, flags, move |args| {
                let body = args.get::<String>(0)?;
                let (section, words) = &scoped[args.get::<i64>(1)? as usize];
                let matches = |text: &str| {
                    let text = if case_sensitive {
                        std::borrow::Cow::Borrowed(text)
                    } else {
                        std::borrow::Cow::Owned(text.to_lowercase())
                    };
                    words.iter().all(|word| text.contains(word))
                };
                if *section {
                    Ok(sections(&body, matches))
                } else {
                    Ok(body.lines().any(matches))
                }
            })?;
        }
        Ok(())
    }

    fn contains(&self, sql: &mut String, values: &mut Vec<Value>, column: &str, value: String) {
        if self.case_sensitive {
            sql.push_str(&format!(" AND instr({column}, ?) > 0"));
            values.push(value.into());
        } else {
            sql.push_str(&format!(" AND workspace_contains({column}, ?)"));
            values.push(value.to_lowercase().into());
        }
    }

    fn property(&self, property: &str, sql: &mut String, values: &mut Vec<Value>) {
        let (name, value) = property.split_once(':').unwrap_or((property, ""));
        let column = match name.trim() {
            "状态" | "status" => "e.status",
            "摘要" | "summary" => "e.summary",
            "来源" | "source" => SOURCE,
            _ => {
                sql.push_str(" AND 0");
                return;
            }
        };
        let value = phrase(value);
        if value.is_empty() {
            sql.push_str(&format!(" AND {column} <> ''"));
        } else if column == "e.status" {
            let key = match value.as_str() {
                "待整理" => "inbox",
                "已计划" => "planned",
                "已采用" => "used",
                "已归档" => "archived",
                "未读" => "unread",
                "已整理" => "reviewed",
                "草稿" => "draft",
                "待发布" => "ready",
                "已发布" => "published",
                _ => &value,
            };
            self.contains(sql, values, column, key.to_owned());
        } else {
            self.contains(sql, values, column, value);
        }
    }
}

fn terms(text: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut depth = 0_u32;
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in text.char_indices() {
        if std::mem::take(&mut escaped) {
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            c if c.is_whitespace() && depth == 0 => {
                if start < index {
                    result.push(&text[start..index]);
                }
                start = index + c.len_utf8();
            }
            _ => {}
        }
    }
    if start < text.len() {
        result.push(&text[start..]);
    }
    result
}

fn phrase(text: &str) -> String {
    let text = text.trim();
    let text = text.strip_prefix('"').unwrap_or(text);
    text.strip_suffix('"').unwrap_or(text).replace("\\\"", "\"")
}

fn scope_terms(text: &str, case_sensitive: bool) -> Vec<String> {
    let text = text.trim();
    let body = text
        .strip_prefix('(')
        .and_then(|open| open.strip_suffix(')'))
        .unwrap_or(text);
    terms(body)
        .into_iter()
        .map(phrase)
        .filter(|term| !term.is_empty())
        .map(|term| {
            if case_sensitive {
                term
            } else {
                term.to_lowercase()
            }
        })
        .collect()
}

fn sections(body: &str, matches: impl Fn(&str) -> bool) -> bool {
    let starts = Parser::new(body)
        .into_offset_iter()
        .filter_map(|(event, range)| {
            matches!(event, Event::Start(Tag::Heading { .. })).then_some(range.start)
        });
    let mut start = 0;
    for end in starts.chain(std::iter::once(body.len())) {
        if end > start && matches(&body[start..end]) {
            return true;
        }
        start = end;
    }
    false
}
