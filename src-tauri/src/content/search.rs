use pulldown_cmark::{Event, Options, Parser, Tag};
use rusqlite::{Connection, functions::FunctionFlags, types::Value};
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, ops::Range};

const PATH: &str = "(COALESCE((SELECT COALESCE(p.name || '/', '') || c.name || '/'
    FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=e.category_id),'') || e.title)";
const SOURCE: &str = "COALESCE((SELECT s.source_url || ' ' || s.author || ' ' || s.account_name
    FROM sources s WHERE s.id=e.source_id),'')";
const MATCH_PAGE_SIZE: usize = 12;
const SNIPPET_LEADING_CHARS: usize = 40;
const SNIPPET_CHARS: usize = 180;
const SEARCH_FUNCTION_FLAGS: FunctionFlags = FunctionFlags::SQLITE_UTF8
    .union(FunctionFlags::SQLITE_DETERMINISTIC)
    .union(FunctionFlags::SQLITE_DIRECTONLY);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearch {
    pub(super) text: String,
    pub(super) case_sensitive: bool,
    pub(super) match_page: Option<MatchPage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MatchPage {
    pub entry_id: String,
    pub offset: usize,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Field {
    Text,
    Content,
    File,
    Path,
    Tag,
    Line,
    Section,
    Status,
    Summary,
    Source,
    UnknownProperty,
}

#[derive(Clone, Serialize)]
pub(super) struct Clause {
    field: Field,
    terms: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct SearchInfo {
    pub total: i64,
    pub clauses: Vec<Clause>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Matches {
    pub version: i64,
    pub items: Vec<Hit>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Hit {
    line: usize,
    #[serde(flatten)]
    snippet: Snippet,
    #[serde(skip_serializing_if = "Option::is_none")]
    expanded: Option<Snippet>,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Serialize)]
struct Snippet {
    start: usize,
    text: String,
    ranges: Vec<Range<usize>>,
    leading: bool,
    trailing: bool,
}

pub(super) struct Query {
    pub clauses: Vec<Clause>,
    pub match_page: Option<MatchPage>,
    case_sensitive: bool,
}

impl WorkspaceSearch {
    pub(super) fn parse(self) -> Query {
        Query {
            clauses: terms(&self.text).into_iter().filter_map(clause).collect(),
            match_page: self.match_page,
            case_sensitive: self.case_sensitive,
        }
    }
}

impl Query {
    pub(super) fn apply(
        &self,
        conn: &Connection,
        sql: &mut String,
        values: &mut Vec<Value>,
    ) -> rusqlite::Result<()> {
        if let Some(page) = &self.match_page {
            sql.push_str(" AND e.id=?");
            values.push(page.entry_id.clone().into());
        }
        if self.clauses.is_empty() {
            sql.push_str(" AND 0");
        }
        if !self.case_sensitive {
            conn.create_scalar_function("workspace_contains", 2, SEARCH_FUNCTION_FLAGS, |args| {
                let text = args.get::<String>(0)?;
                let needle = args.get::<String>(1)?;
                Ok(text.to_lowercase().contains(&needle))
            })?;
        }
        let mut scoped = Vec::new();
        for Clause { field, terms } in &self.clauses {
            let column = match field {
                Field::Text => "(e.title || char(10) || e.content_md)",
                Field::Content | Field::Line | Field::Section => "e.content_md",
                Field::File => "e.title",
                Field::Path => PATH,
                Field::Tag => "t.name",
                Field::Status => "e.status",
                Field::Summary => "e.summary",
                Field::Source => SOURCE,
                Field::UnknownProperty => {
                    sql.push_str(" AND 0");
                    continue;
                }
            };
            if matches!(field, Field::Line | Field::Section) {
                sql.push_str(" AND workspace_scope(e.content_md, ?)");
                values.push((scoped.len() as i64).into());
                scoped.push((
                    *field,
                    terms
                        .iter()
                        .map(|word| self.fold(word).into_owned())
                        .collect::<Vec<_>>(),
                ));
                continue;
            }
            if terms.is_empty() {
                sql.push_str(&format!(" AND {column} <> ''"));
                continue;
            }
            if *field == Field::Tag {
                sql.push_str(" AND EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=e.id");
            }
            for word in terms {
                if *field == Field::Text && !self.case_sensitive && word.chars().count() >= 3 {
                    sql.push_str(
                        " AND e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)",
                    );
                    values.push(format!("\"{}\"", word.replace('"', "\"\"")).into());
                } else {
                    let word = if *field == Field::Status {
                        status_key(word)
                    } else {
                        word
                    };
                    if self.case_sensitive {
                        sql.push_str(&format!(" AND instr({column}, ?) > 0"));
                    } else {
                        sql.push_str(&format!(" AND workspace_contains({column}, ?)"));
                    }
                    values.push(self.fold(word).into_owned().into());
                }
            }
            if *field == Field::Tag {
                sql.push(')');
            }
        }
        if !scoped.is_empty() {
            let case_sensitive = self.case_sensitive;
            conn.create_scalar_function(
                "workspace_scope",
                2,
                SEARCH_FUNCTION_FLAGS,
                move |args| {
                    let body = args.get::<String>(0)?;
                    let (field, words) = &scoped[args.get::<i64>(1)? as usize];
                    let matches = |text: &str| {
                        let text = folded(text, case_sensitive);
                        words.iter().all(|word| text.contains(word))
                    };
                    Ok(if *field == Field::Section {
                        sections(&body).any(|range| matches(&body[range]))
                    } else {
                        body.lines().any(matches)
                    })
                },
            )?;
        }
        Ok(())
    }

    pub(super) fn register_relevance(&self, conn: &Connection) -> rusqlite::Result<()> {
        let mut title_words: Vec<_> = self
            .clauses
            .iter()
            .filter(|clause| matches!(clause.field, Field::Text | Field::File))
            .flat_map(|clause| &clause.terms)
            .map(|word| self.fold(word).into_owned())
            .collect();
        let phrase = title_words.join(" ");
        title_words.sort_unstable();
        title_words.dedup();
        let case_sensitive = self.case_sensitive;
        conn.create_scalar_function(
            "workspace_title_rank",
            1,
            SEARCH_FUNCTION_FLAGS,
            move |args| {
                let title = args.get::<String>(0)?;
                let title = folded(title.trim(), case_sensitive);
                let count = if !phrase.is_empty() && title == phrase {
                    title_words.len() + 1
                } else {
                    title_words
                        .iter()
                        .filter(|word| title.contains(word.as_str()))
                        .count()
                };
                Ok(count as i64)
            },
        )?;
        let query = Query {
            clauses: self.clauses.clone(),
            match_page: None,
            case_sensitive,
        };
        conn.create_scalar_function(
            "workspace_line_count",
            1,
            SEARCH_FUNCTION_FLAGS,
            move |args| {
                let body = args.get::<String>(0)?;
                Ok(query.collect_matches(&body, None).0 as i64)
            },
        )
    }

    fn fold<'a>(&self, value: &'a str) -> Cow<'a, str> {
        folded(value, self.case_sensitive)
    }

    pub(super) fn matches(&self, body: &str, version: i64) -> Matches {
        let first = self.match_page.as_ref().map_or(0, |page| page.offset);
        let (total, items) = self.collect_matches(body, Some(first));
        let next = first + items.len();
        Matches {
            version,
            items,
            total,
            next_offset: (next < total).then_some(next),
        }
    }

    fn collect_matches(&self, body: &str, first: Option<usize>) -> (usize, Vec<Hit>) {
        let clauses: Vec<_> = self
            .clauses
            .iter()
            .filter(|clause| {
                matches!(
                    clause.field,
                    Field::Text | Field::Content | Field::Line | Field::Section
                )
            })
            .map(|clause| {
                (
                    clause.field,
                    clause
                        .terms
                        .iter()
                        .map(|word| self.fold(word))
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        if clauses.is_empty() {
            return (0, Vec::new());
        }
        let mut total = 0;
        let mut items = Vec::new();
        let mut section_ranges = clauses
            .iter()
            .any(|(field, _)| *field == Field::Section)
            .then(|| sections(body).peekable());
        let mut section_words = Vec::new();
        let mut lines = body.split_inclusive('\n').peekable();
        let (mut byte_start, mut utf16_start, mut number) = (0, 0, 0);
        let mut previous = None;
        while let Some(raw) = lines.next() {
            number += 1;
            let line = source_line(raw);
            if let Some(sections) = &mut section_ranges {
                while let Some(range) =
                    sections.next_if(|section| section.start < byte_start + raw.len())
                {
                    let text = self.fold(&body[range]);
                    section_words = clauses
                        .iter()
                        .filter(|(field, words)| {
                            *field == Field::Section
                                && words.iter().all(|word| text.contains(word.as_ref()))
                        })
                        .flat_map(|(_, words)| words)
                        .collect();
                }
            }
            let searchable = self.fold(line);
            let candidates = clauses
                .iter()
                .filter(|(field, words)| match field {
                    Field::Text | Field::Content => true,
                    Field::Line => words.iter().all(|word| searchable.contains(word.as_ref())),
                    _ => false,
                })
                .flat_map(|(_, words)| words)
                .chain(section_words.iter().copied())
                .map(Cow::as_ref);
            let mut words = candidates
                .filter(|word| searchable.contains(word))
                .peekable();
            if words.peek().is_some() {
                if first.is_some_and(|first| total >= first) && items.len() < MATCH_PAGE_SIZE {
                    let mut words = words.collect::<Vec<_>>();
                    words.sort_unstable();
                    words.dedup();
                    let folded = words
                        .iter()
                        .copied()
                        .flat_map(|word| {
                            searchable
                                .match_indices(word)
                                .map(move |(start, _)| start..start + word.len())
                        })
                        .collect();
                    items.push(snippet(
                        line,
                        folded,
                        self.case_sensitive,
                        number,
                        utf16_start,
                        previous,
                        lines.peek().copied(),
                    ));
                }
                total += 1;
            }
            byte_start += raw.len();
            if first.is_some() {
                utf16_start += raw.encode_utf16().count();
            }
            previous = Some(raw);
        }
        (total, items)
    }
}

fn clause(token: &str) -> Option<Clause> {
    let (field, value, property) = if let Some(token) = token.strip_prefix('[') {
        let (name, value) = token
            .strip_suffix(']')?
            .split_once(':')
            .unwrap_or((token.trim_end_matches(']'), ""));
        (
            match name.trim() {
                "状态" | "status" => Field::Status,
                "摘要" | "summary" => Field::Summary,
                "来源" | "source" => Field::Source,
                _ => Field::UnknownProperty,
            },
            value,
            true,
        )
    } else {
        let field = token.split_once(':').and_then(|(scope, value)| {
            let field = match scope {
                "file" => Field::File,
                "path" => Field::Path,
                "tag" => Field::Tag,
                "content" => Field::Content,
                "line" => Field::Line,
                "section" => Field::Section,
                _ => return None,
            };
            Some((field, value))
        });
        let (field, value) = field.unwrap_or((Field::Text, token));
        (field, value, false)
    };
    let words = if let Some(group) = value
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
    {
        terms(group)
    } else {
        vec![value]
    };
    let terms = words
        .into_iter()
        .map(phrase)
        .map(|word| {
            if field == Field::Tag {
                word.trim_start_matches('#').to_owned()
            } else {
                word
            }
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    (property || !terms.is_empty() || field == Field::UnknownProperty)
        .then_some(Clause { field, terms })
}

fn status_key(value: &str) -> &str {
    match value {
        "待整理" => "inbox",
        "已计划" => "planned",
        "已采用" => "used",
        "已归档" => "archived",
        "未读" => "unread",
        "已整理" => "reviewed",
        "草稿" => "draft",
        "待发布" => "ready",
        "已发布" => "published",
        _ => value,
    }
}

fn folded(value: &str, case_sensitive: bool) -> Cow<'_, str> {
    if case_sensitive {
        Cow::Borrowed(value)
    } else {
        Cow::Owned(value.to_lowercase())
    }
}

fn sections(body: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    let mut start = 0;
    Parser::new_ext(
        body,
        Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_GFM,
    )
    .into_offset_iter()
    .filter_map(|(event, range)| {
        matches!(event, Event::Start(Tag::Heading { .. })).then_some(range.start)
    })
    .chain(std::iter::once(body.len()))
    .filter_map(move |end| {
        let range = start..end;
        start = end;
        (!range.is_empty()).then_some(range)
    })
}

fn snippet(
    line: &str,
    mut matches: Vec<Range<usize>>,
    case_sensitive: bool,
    number: usize,
    offset: usize,
    before: Option<&str>,
    after: Option<&str>,
) -> Hit {
    if !case_sensitive {
        let mut lowered = 0;
        let mut bounds: Vec<_> = line
            .char_indices()
            .map(|(byte, ch)| {
                let start = lowered;
                lowered += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
                (start, byte)
            })
            .collect();
        bounds.push((lowered, line.len()));
        for range in &mut matches {
            range.start = bounds[bounds.partition_point(|(start, _)| *start <= range.start) - 1].1;
            range.end = bounds[bounds.partition_point(|(start, _)| *start < range.end)].1;
        }
    }
    matches.sort_unstable_by_key(|range| range.start);
    let start = line[..matches[0].start]
        .char_indices()
        .rev()
        .nth(SNIPPET_LEADING_CHARS - 1)
        .map_or(0, |(byte, _)| byte);
    let end = line[start..]
        .char_indices()
        .nth(SNIPPET_CHARS)
        .map_or(line.len(), |(byte, _)| start + byte);
    let snippet = render_snippet(line, &matches, offset, start..end);
    let expanded = (snippet.leading || snippet.trailing)
        .then(|| render_snippet(line, &matches, offset, 0..line.len()));
    let context = |text: &str| {
        let text = source_line(text);
        text.char_indices()
            .nth(100)
            .map_or_else(|| text.to_owned(), |(end, _)| format!("{}…", &text[..end]))
    };
    Hit {
        line: number,
        snippet,
        expanded,
        before: before.map(context),
        after: after.map(context),
    }
}

fn render_snippet(
    line: &str,
    matches: &[Range<usize>],
    offset: usize,
    Range { start, end }: Range<usize>,
) -> Snippet {
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut byte_end = start;
    for range in matches.iter().take_while(|range| range.start < end) {
        let stop = range.end.min(end);
        if let Some(last) = ranges.last_mut()
            && range.start < byte_end
        {
            if stop > byte_end {
                last.end += line[byte_end..stop].encode_utf16().count();
                byte_end = stop;
            }
        } else {
            let previous_end = ranges.last().map_or(0, |last| last.end);
            let from = previous_end + line[byte_end..range.start].encode_utf16().count();
            let to = from + line[range.start..stop].encode_utf16().count();
            ranges.push(from..to);
            byte_end = stop;
        }
    }
    Snippet {
        start: offset + line[..start].encode_utf16().count(),
        text: line[start..end].to_owned(),
        ranges,
        leading: start > 0,
        trailing: end < line.len(),
    }
}

fn source_line(raw: &str) -> &str {
    let line = raw.strip_suffix('\n').unwrap_or(raw);
    line.strip_suffix('\r').unwrap_or(line)
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
