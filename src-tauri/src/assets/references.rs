use crate::db::{AppError, Result};
use lol_html::{HtmlRewriter, Settings, element};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, ops::Range};

pub fn source_key(kind: &str, source: &str) -> String {
    hex::encode(Sha256::digest(
        format!("{kind}\0{}", source.trim().replace("\r\n", "\n")).as_bytes(),
    ))
}

#[derive(serde::Serialize)]
pub struct DerivedSource {
    pub kind: &'static str,
    pub source: String,
    pub line: usize,
}

pub fn derived_sources(markdown: &str) -> Vec<DerivedSource> {
    use pulldown_cmark::CodeBlockKind;
    let mut sources = Vec::new();
    let mut diagram = None;
    let breaks: Vec<_> = markdown
        .match_indices('\n')
        .map(|(offset, _)| offset)
        .collect();
    let mut add = |kind, source: &str, offset: usize| {
        sources.push(DerivedSource {
            kind,
            source: source.trim().replace("\r\n", "\n"),
            line: breaks.partition_point(|end| *end < offset),
        });
    };
    for (event, range) in Parser::new_ext(
        markdown,
        Options::ENABLE_MATH | Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES,
    )
    .into_offset_iter()
    {
        match event {
            Event::InlineMath(source) => add("math-inline", &source, range.start),
            Event::DisplayMath(source) => add("math-block", &source, range.start),
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(fence)))
                if fence.split_whitespace().next() == Some("mermaid") =>
            {
                diagram = Some((String::new(), range.start));
            }
            Event::Text(text) => {
                if let Some((diagram, _)) = &mut diagram {
                    diagram.push_str(&text);
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((diagram, start)) = diagram.take() {
                    add("mermaid", &diagram, start);
                }
            }
            _ => {}
        }
    }
    sources
}

pub fn derived_keys(markdown: &str) -> BTreeSet<String> {
    derived_sources(markdown)
        .into_iter()
        .map(|source| source_key(source.kind, &source.source))
        .collect()
}

pub enum Image {
    Markdown {
        range: Range<usize>,
        url: String,
        alt: String,
        title: String,
    },
    Html(Vec<Range<usize>>),
}

pub fn canonical_url(value: &str) -> String {
    let value = value.trim();
    let mut url = match url::Url::parse(value) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => return value.to_owned(),
    };
    url.set_fragment(None);
    url.into()
}

pub fn images(markdown: &str) -> Vec<Image> {
    let mut images = Vec::new();
    let mut image = None;
    let mut html_block = None;
    for (event, range) in Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_MATH
            | Options::ENABLE_FOOTNOTES,
    )
    .into_offset_iter()
    {
        match event {
            Event::Start(Tag::Image {
                dest_url, title, ..
            }) if image.is_none() => {
                image = Some((
                    range.start,
                    canonical_url(&dest_url),
                    String::new(),
                    String::from(title),
                    1,
                ));
            }
            Event::Start(Tag::Image { .. }) => {
                if let Some((_, _, _, _, depth)) = &mut image {
                    *depth += 1;
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, _, alt, _, _)) = &mut image {
                    alt.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, _, alt, _, _)) = &mut image {
                    alt.push(' ');
                }
            }
            Event::End(TagEnd::Image) => {
                if let Some((_, _, _, _, depth)) = &mut image {
                    *depth -= 1;
                }
                if matches!(image, Some((_, _, _, _, 0)))
                    && let Some((start, url, alt, title, _)) = image.take()
                {
                    images.push(Image::Markdown {
                        range: start..range.end,
                        url,
                        alt,
                        title,
                    });
                }
            }
            Event::Start(Tag::HtmlBlock) => html_block = Some(Vec::new()),
            Event::End(TagEnd::HtmlBlock) => {
                images.push(Image::Html(
                    html_block.take().expect("HTML block was opened"),
                ));
            }
            Event::Html(_) | Event::InlineHtml(_) if image.is_none() => {
                if let Some(parts) = &mut html_block {
                    parts.push(range);
                } else {
                    images.push(Image::Html(vec![range]));
                }
            }
            _ => {}
        }
    }
    images
}

pub struct HtmlImage {
    pub url: String,
    pub attributes: Vec<Vec<Range<usize>>>,
}

pub fn html_images(markdown: &str, parts: &[Range<usize>]) -> Result<Vec<HtmlImage>> {
    let html: String = parts.iter().map(|range| &markdown[range.clone()]).collect();
    let mut images = Vec::new();
    let spans = |range: Range<usize>| {
        let mut offset = 0;
        let mut result = Vec::new();
        for part in parts {
            let end = offset + part.len();
            let from = offset.max(range.start);
            let to = end.min(range.end);
            if from < to {
                result.push((part.start + from - offset)..(part.start + to - offset));
            }
            offset = end;
        }
        result
    };
    let mut writer = HtmlRewriter::new(
        Settings::default().append_element_content_handler(element!("img[src]", |element| {
            let attributes = element.attributes();
            if let Some(src) = attributes
                .iter()
                .find(|attribute| attribute.name() == "src")
                && let Some(location) = src.value_source_location()
                && !location.bytes().is_empty()
            {
                let mut locations = vec![spans(location.bytes())];
                if let Some(srcset) = attributes
                    .iter()
                    .find(|attribute| attribute.name() == "srcset")
                    .and_then(|attribute| attribute.value_source_location())
                {
                    locations.push(spans(srcset.bytes()));
                }
                images.push(HtmlImage {
                    url: canonical_url(&html_escape::decode_html_entities(&src.value())),
                    attributes: locations,
                });
            }
            Ok(())
        })),
        |_: &[u8]| {},
    );
    writer
        .write(html.as_bytes())
        .and_then(|()| writer.end())
        .map_err(|e| AppError::new("ASSET_MARKDOWN", e.to_string()))?;
    Ok(images)
}

pub fn urls(markdown: &str) -> Result<BTreeSet<String>> {
    let mut urls = BTreeSet::new();
    for image in images(markdown) {
        match image {
            Image::Markdown { url, .. } => {
                urls.insert(url);
            }
            Image::Html(parts) => urls.extend(
                html_images(markdown, &parts)?
                    .into_iter()
                    .map(|image| image.url),
            ),
        }
    }
    Ok(urls)
}

pub fn image_edits(
    markdown: &str,
    mut resolve: impl FnMut(&str) -> Result<Option<String>>,
) -> Result<Vec<(Range<usize>, String)>> {
    let mut edits = Vec::new();
    for image in images(markdown) {
        match image {
            Image::Markdown {
                range,
                url,
                alt,
                title,
            } => {
                let Some(name) = resolve(&url)? else { continue };
                let alt = alt
                    .replace('\\', "\\\\")
                    .replace('[', "\\[")
                    .replace(']', "\\]");
                let title = if title.is_empty() {
                    String::new()
                } else {
                    format!(" \"{}\"", title.replace('\\', "\\\\").replace('"', "\\\""))
                };
                edits.push((range, format!("![{alt}]({name}{title})")));
            }
            Image::Html(parts) => {
                for image in html_images(markdown, &parts)? {
                    let Some(name) = resolve(&image.url)? else {
                        continue;
                    };
                    for spans in image.attributes {
                        let mut parts = spans.into_iter();
                        if let Some(first) = parts.next() {
                            edits.push((first, name.clone()));
                            edits.extend(parts.map(|rest| (rest, String::new())));
                        }
                    }
                }
            }
        }
    }
    Ok(edits)
}

pub fn apply_image_edits(markdown: &str, mut edits: Vec<(Range<usize>, String)>) -> String {
    edits.sort_unstable_by_key(|(range, _)| range.start);
    let mut output = markdown.to_owned();
    for (range, replacement) in edits.into_iter().rev() {
        output.replace_range(range, &replacement);
    }
    output
}

pub(crate) fn cancel_cleanup(conn: &Connection, markdown: &str) -> Result<()> {
    if !conn.query_row("SELECT EXISTS(SELECT 1 FROM asset_cleanup_candidates)",[],|row|row.get::<_,bool>(0))? { return Ok(()); }
    for url in urls(markdown)? {
        conn.execute("DELETE FROM asset_cleanup_candidates WHERE sha256 IN (SELECT sha256 FROM assets WHERE id=?1
            OR sha256 IN (SELECT sha256 FROM asset_urls WHERE url=?2))",params![url.strip_prefix("asset://"),url])?;
    }
    for key in derived_keys(markdown) {
        conn.execute("DELETE FROM asset_cleanup_candidates WHERE sha256 IN (SELECT sha256 FROM assets WHERE source_key=?1)",[key])?;
    }
    Ok(())
}

pub fn sync_entry(conn: &Connection, entry_id: &str, markdown: &str) -> Result<()> {
    conn.execute("DELETE FROM entry_assets WHERE entry_id=?1", [entry_id])?;
    let mut insert = conn.prepare_cached(
        "INSERT OR IGNORE INTO entry_assets
         SELECT ?1, id FROM assets WHERE id=?2 OR sha256 IN (SELECT sha256 FROM asset_urls WHERE url=?3)",
    )?;
    for url in urls(markdown)? {
        insert.execute(params![entry_id, url.strip_prefix("asset://"), url])?;
    }
    conn.execute("DELETE FROM asset_cleanup_candidates WHERE sha256 IN (SELECT sha256 FROM assets WHERE id IN
        (SELECT asset_id FROM entry_assets WHERE entry_id=?1 UNION SELECT cover_asset_id FROM entries WHERE id=?1))",[entry_id])?;
    cancel_cleanup(conn,markdown)?;
    conn.execute(
        "DELETE FROM jobs WHERE kind='cleanup' AND status<>'completed' AND sha256 IN (
         SELECT sha256 FROM assets WHERE id IN (SELECT asset_id FROM entry_assets WHERE entry_id=?1
             UNION SELECT cover_asset_id FROM entries WHERE id=?1))",
        [entry_id],
    )?;
    Ok(())
}
