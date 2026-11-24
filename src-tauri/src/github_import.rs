use crate::db::{AppError, Result, Workspace};
use crate::link_import::ImportedLink;
use base64::{Engine, engine::general_purpose::STANDARD};
use lol_html::{RewriteStrSettings, element, rewrite_str};
use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd};
use reqwest::{StatusCode, redirect::Policy};
use serde::Deserialize;
use std::{borrow::Cow, time::Duration};
use url::Url;

const MAX_README: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 2 * MAX_README;

#[derive(Deserialize)]
struct Readme {
    path: String,
    html_url: String,
    download_url: String,
    encoding: String,
    content: String,
    size: usize,
}

pub(crate) async fn import_readme(
    state: &Workspace,
    assets: &crate::assets::Assets,
    url: &str,
    category_id: Option<String>,
    download_images: bool,
) -> Result<ImportedLink> {
    let (owner, repo) = repository(url)?;
    let canonical = format!("https://github.com/{owner}/{repo}").to_ascii_lowercase();
    if let Some((entry_id, deleted)) = state.github_reference(&canonical)? {
        return Ok(ImportedLink {
            entry_id,
            existing: true,
            deleted,
            unavailable_images: 0,
        });
    }

    let client = reqwest::Client::builder()
        .user_agent("wechat-creator-workbench")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() < 3
                && attempt.url().scheme() == "https"
                && attempt.url().host_str() == Some("api.github.com")
            {
                attempt.follow()
            } else {
                attempt.error("GitHub API redirect rejected")
            }
        }))
        .build()
        .map_err(request_error)?;
    let mut response = client
        .get(format!(
            "https://api.github.com/repos/{owner}/{repo}/readme"
        ))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(request_error)?;
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS
        || (status == StatusCode::FORBIDDEN
            && (response.headers().contains_key("retry-after")
                || response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|value| value == "0")))
    {
        return Err(AppError::new(
            "GITHUB_RATE_LIMIT",
            "GitHub 请求达到限额，请稍后重试",
        ));
    }
    if status == StatusCode::NOT_FOUND {
        return Err(AppError::new(
            "GITHUB_NOT_FOUND",
            "找不到公开仓库或默认 README",
        ));
    }
    if status == StatusCode::FORBIDDEN {
        let body = read_body(&mut response).await?;
        if serde_json::from_slice::<ApiError>(&body)
            .is_ok_and(|failure| failure.message.to_ascii_lowercase().contains("rate limit"))
        {
            return Err(AppError::new(
                "GITHUB_RATE_LIMIT",
                "GitHub 请求达到限额，请稍后重试",
            ));
        }
    }
    if !status.is_success() {
        return Err(AppError::new(
            "GITHUB_HTTP",
            format!("GitHub 返回 HTTP {status}"),
        ));
    }
    let bytes = read_body(&mut response).await?;
    let readme: Readme = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::new("GITHUB_README", format!("无法解析 GitHub README：{error}"))
    })?;
    let (title, markdown) = prepare_readme(readme, &repo)?;
    let (markdown, unavailable_images) = assets
        .import_link_images(state, markdown, download_images)
        .await?;
    let (entry_id, existing, deleted) =
        state.import_github_reference(canonical, title, markdown, category_id)?;
    Ok(ImportedLink {
        entry_id,
        existing,
        deleted,
        unavailable_images: if existing { 0 } else { unavailable_images },
    })
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

async fn read_body(response: &mut reqwest::Response) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) fn repository(value: &str) -> Result<(String, String)> {
    let invalid = || AppError::invalid("请输入公开的 GitHub 仓库或 README 网页地址");
    let url = Url::parse(value.trim()).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    let mut parts = url.path().trim_matches('/').split('/');
    let owner = parts.next().ok_or_else(invalid)?;
    let repo = parts.next().ok_or_else(invalid)?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if owner.is_empty()
        || repo.is_empty()
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || !repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(invalid());
    }
    match parts.next() {
        None => {}
        Some("blob")
            if parts.next().is_some_and(|branch| !branch.is_empty())
                && parts.next_back().is_some_and(is_readme) => {}
        _ => return Err(invalid()),
    }
    Ok((owner.to_owned(), repo.to_owned()))
}

fn is_readme(name: &str) -> bool {
    name.split('.')
        .next()
        .is_some_and(|stem| stem.eq_ignore_ascii_case("readme"))
}

fn prepare_readme(readme: Readme, repository: &str) -> Result<(String, String)> {
    if readme.size > MAX_README {
        return Err(too_large());
    }
    if readme.encoding != "base64" {
        return Err(AppError::new(
            "GITHUB_README",
            "GitHub 未返回可读取的 README 内容",
        ));
    }
    let encoded: Vec<_> = readme
        .content
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| AppError::new("GITHUB_README", format!("README 解码失败：{error}")))?;
    if bytes.len() > MAX_README {
        return Err(too_large());
    }
    let markdown = String::from_utf8(bytes)
        .map_err(|_| AppError::new("GITHUB_README", "README 不是 UTF-8 文本"))?;
    let markdown = markdown.trim_start_matches('\u{feff}');
    let html = readme_url(&readme.html_url, &["github.com"])?;
    let raw = readme_url(
        &readme.download_url,
        &["raw.githubusercontent.com", "github.com"],
    )?;
    prepare_markdown(markdown, repository, &html, &raw, &readme.path, true)
}

pub(crate) fn convert_saved_html(markdown: &str, source: &str) -> Result<Option<String>> {
    if !markdown
        .as_bytes()
        .windows(4)
        .any(|part| part.eq_ignore_ascii_case(b"<img"))
        && !contains_disclosure(markdown)
    {
        return Ok(None);
    }
    let Ok((owner, repo)) = repository(source) else {
        return Ok(None);
    };
    let html = Url::parse(&format!(
        "https://github.com/{owner}/{repo}/blob/HEAD/README.md"
    ))
    .expect("valid repository name");
    let raw = Url::parse(&format!(
        "https://raw.githubusercontent.com/{owner}/{repo}/HEAD/README.md"
    ))
    .expect("valid repository name");
    let (_, converted) = prepare_markdown(markdown, &repo, &html, &raw, "README.md", false)?;
    Ok((converted != markdown).then_some(converted))
}

fn prepare_markdown(
    markdown: &str,
    repository: &str,
    html: &Url,
    raw: &Url,
    path: &str,
    resolve_markdown_links: bool,
) -> Result<(String, String)> {
    let html_root = repository_root(html, path)?;
    let raw_root = repository_root(raw, path)?;
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH;
    let markdown = separate_disclosures(markdown, options);
    let mut title = String::new();
    let mut in_title = false;
    let mut changed = false;
    let mut events = Vec::new();
    let mut parser = Parser::new_ext(&markdown, options).peekable();
    let mut sanitizer = ammonia::Builder::default();
    sanitizer.link_rel(None).add_url_schemes(["asset"]);
    let converter = htmd::HtmlToMarkdown::builder()
        .add_handler(
            vec!["img"],
            |_: &dyn htmd::element_handler::Handlers, image: &htmd::Element| {
                let url = Url::parse(&image.node.attr("src")?).ok()?;
                if !matches!(url.scheme(), "http" | "https" | "asset") {
                    return None;
                }
                let alt = image
                    .node
                    .attr("alt")
                    .as_deref()
                    .unwrap_or_default()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .replace('\\', "\\\\")
                    .replace('[', "\\[")
                    .replace(']', "\\]");
                let title = image.node.attr("title").map_or(String::new(), |title| {
                    format!(
                        " \"{}\"",
                        title
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .replace('\\', "\\\\")
                            .replace('"', "\\\"")
                    )
                });
                Some(format!("![{alt}](<{url}>{title})").into())
            },
        )
        .build();
    while let Some(event) = parser.next() {
        let block = matches!(event, Event::Start(Tag::HtmlBlock));
        let mut fragment = match event {
            Event::Start(Tag::HtmlBlock) => String::new(),
            Event::InlineHtml(value) => value.into_string(),
            _ => {
                events.push(event);
                continue;
            }
        };
        if block {
            for event in parser.by_ref() {
                match event {
                    Event::Html(line) => fragment.push_str(&line),
                    Event::End(TagEnd::HtmlBlock) => break,
                    _ => unreachable!("only HTML may occur inside an HTML block"),
                }
            }
        } else {
            while let Some(Event::InlineHtml(_)) = parser.peek() {
                let Some(Event::InlineHtml(line)) = parser.next() else {
                    unreachable!()
                };
                fragment.push_str(&line);
            }
        }
        let mut has_image = false;
        let mut has_disclosure = false;
        let rewritten = rewrite_str(
            &fragment,
            RewriteStrSettings::default()
                .append_element_content_handler(element!("details", |_| {
                    has_disclosure = true;
                    Ok(())
                }))
                .append_element_content_handler(element!("img[src], a[href]", |element| {
                    let image = element.tag_name() == "img";
                    let (attribute, base, root) = if image {
                        ("src", raw, &raw_root)
                    } else {
                        ("href", html, &html_root)
                    };
                    let source = element.get_attribute(attribute).unwrap();
                    let destination = html_escape::decode_html_entities(&source);
                    let destination = destination.trim();
                    if image {
                        has_image = true;
                    }
                    if !destination.is_empty()
                        && !destination.starts_with('#')
                        && let Some(url) = resolve_relative(destination, base, root)
                    {
                        element.set_attribute(
                            attribute,
                            &html_escape::encode_double_quoted_attribute(url.as_str()),
                        )?;
                    }
                    Ok(())
                })),
        )
        .map_err(readme_conversion_error)?;
        if has_image && !has_disclosure {
            let clean = sanitizer.clean(&rewritten).to_string();
            let converted = converter.convert(&clean).map_err(readme_conversion_error)?;
            let parsed: Vec<_> = Parser::new_ext(&converted, options)
                .map(Event::into_static)
                .collect();
            if parsed
                .iter()
                .any(|event| matches!(event, Event::Start(Tag::Image { .. })))
            {
                changed = true;
                events.extend(parsed.into_iter().filter(|event| {
                    block
                        || !matches!(
                            event,
                            Event::Start(Tag::Paragraph) | Event::End(TagEnd::Paragraph)
                        )
                }));
                continue;
            }
        }
        if resolve_markdown_links && fragment != rewritten {
            changed = true;
            fragment = rewritten;
        }
        if block {
            events.extend([
                Event::Start(Tag::HtmlBlock),
                Event::Html(fragment.into()),
                Event::End(TagEnd::HtmlBlock),
            ]);
        } else {
            events.push(Event::InlineHtml(fragment.into()));
        }
    }
    for event in &mut events {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) if title.is_empty() => in_title = true,
            Event::End(TagEnd::Heading(HeadingLevel::H1)) => in_title = false,
            Event::Text(text) | Event::Code(text) if in_title => title.push_str(text),
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                ..
            }) if resolve_markdown_links => {
                changed |= resolve_link(link_type, dest_url, raw, &raw_root);
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) if resolve_markdown_links => {
                changed |= resolve_link(link_type, dest_url, html, &html_root);
            }
            _ => {}
        }
    }
    let title = title.trim();
    let title = if title.is_empty() { repository } else { title }.to_owned();
    if !changed {
        return Ok((title, markdown.into_owned()));
    }
    let mut output = String::new();
    let mut format_options = pulldown_cmark_to_cmark::Options::default();
    if let Some(tokens) = pulldown_cmark_to_cmark::calculate_code_block_token_count(events.iter()) {
        format_options.code_block_token_count = tokens;
    }
    pulldown_cmark_to_cmark::cmark_with_options(
        events.iter(),
        &mut output,
        options,
        format_options,
    )
    .map_err(readme_conversion_error)?;
    Ok((title, separate_disclosures(&output, options).into_owned()))
}

fn contains_disclosure(markdown: &str) -> bool {
    markdown
        .as_bytes()
        .windows(8)
        .any(|part| part.eq_ignore_ascii_case(b"<details"))
}

fn separate_disclosures(markdown: &str, options: Options) -> Cow<'_, str> {
    if !contains_disclosure(markdown) {
        return Cow::Borrowed(markdown);
    }
    let lines: Vec<_> = markdown.split_inclusive('\n').collect();
    let mut offsets = vec![0];
    offsets.extend(markdown.match_indices('\n').map(|(offset, _)| offset + 1));
    let mut html_lines = vec![false; lines.len()];
    let mut raw_text = false;
    for (event, range) in Parser::new_ext(markdown, options).into_offset_iter() {
        match event {
            Event::Start(Tag::HtmlBlock) => {
                let first = markdown[range]
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim_start()
                    .to_ascii_lowercase();
                raw_text = first.starts_with("<!")
                    || ["<pre", "<script", "<style", "<textarea"]
                        .iter()
                        .any(|tag| first.starts_with(tag));
            }
            Event::End(TagEnd::HtmlBlock) => raw_text = false,
            Event::Html(_) | Event::InlineHtml(_) if !raw_text && !range.is_empty() => {
                let start = offsets.partition_point(|offset| *offset <= range.start) - 1;
                let end = offsets.partition_point(|offset| *offset < range.end);
                html_lines[start..end].fill(true);
            }
            _ => {}
        }
    }
    let mut breaks = vec![false; lines.len()];
    let line_break = |line: &str| {
        matches!(
            line.trim().to_ascii_lowercase().as_str(),
            "<br>" | "<br/>" | "<br />"
        )
    };
    let mut depth = 0usize;
    for (index, line) in lines.iter().enumerate() {
        if !html_lines[index] || line.len() - line.trim_start().len() > 3 {
            continue;
        }
        let tag = line.trim().to_ascii_lowercase();
        let start = tag.starts_with("<details>") || tag.starts_with("<details ");
        if start && !tag.contains("</details>") {
            depth += 1;
            breaks[index] = true;
        }
        if depth == 0 {
            continue;
        }
        if tag == "</details>" {
            depth -= 1;
            breaks[index] = true;
            if let Some(next) = breaks.get_mut(index + 1) {
                *next = true;
            }
        } else if (start || tag.starts_with("<summary")) && tag.ends_with("</summary>") {
            let next = index
                + 1
                + lines[index + 1..]
                    .iter()
                    .take_while(|line| line_break(line))
                    .count();
            if let Some(next) = breaks.get_mut(next) {
                *next = true;
            }
        }
    }
    let mut output = String::with_capacity(markdown.len());
    let mut changed = false;
    for (index, line) in lines.iter().enumerate() {
        if breaks[index]
            && index > 0
            && !line.trim().is_empty()
            && !lines[index - 1].trim().is_empty()
        {
            output.push('\n');
            changed = true;
        }
        output.push_str(line);
    }
    if changed {
        Cow::Owned(output)
    } else {
        Cow::Borrowed(markdown)
    }
}

fn readme_conversion_error(error: impl std::fmt::Display) -> AppError {
    AppError::new("GITHUB_README", format!("README 内容转换失败：{error}"))
}

fn readme_url(value: &str, hosts: &[&str]) -> Result<Url> {
    Url::parse(value)
        .ok()
        .filter(|url| {
            url.scheme() == "https" && url.host_str().is_some_and(|host| hosts.contains(&host))
        })
        .ok_or_else(|| AppError::new("GITHUB_README", "GitHub 返回了无效的 README 地址"))
}

fn repository_root(readme: &Url, path: &str) -> Result<Url> {
    let mut root = readme.clone();
    let mut segments = root
        .path_segments_mut()
        .map_err(|_| AppError::new("GITHUB_README", "GitHub 返回了无效的 README 路径"))?;
    for _ in path.split('/') {
        segments.pop();
    }
    segments.push("");
    drop(segments);
    Ok(root)
}

fn resolve_link(
    link_type: &mut LinkType,
    destination: &mut pulldown_cmark::CowStr<'_>,
    base: &Url,
    root: &Url,
) -> bool {
    let Some(url) = resolve_relative(destination, base, root) else {
        return false;
    };
    *link_type = LinkType::Inline;
    *destination = url.to_string().into();
    true
}

fn resolve_relative(destination: &str, base: &Url, root: &Url) -> Option<Url> {
    if Url::parse(destination).is_ok() {
        return None;
    }
    let resolved = if let Some(path) = destination
        .strip_prefix('/')
        .filter(|path| !path.starts_with('/'))
    {
        root.join(path)
    } else {
        base.join(destination)
    };
    resolved.ok().filter(|url| url.scheme() == "https")
}

fn request_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new("GITHUB_TIMEOUT", "连接 GitHub 超时，请稍后重试")
    } else {
        AppError::new("GITHUB_NETWORK", format!("无法读取 GitHub README：{error}"))
    }
}

fn too_large() -> AppError {
    AppError::new("GITHUB_README_SIZE", "README 超过 1 MiB，无法导入")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::EntryPatch;

    #[test]
    fn accepts_repository_and_readme_urls_only() {
        for input in [
            "https://github.com/Owner/Repo/",
            "https://github.com/Owner/Repo.git",
            "https://github.com/Owner/Repo/blob/main/docs/README.md?plain=1#install",
            "https://github.com/Owner/Repo#readme",
        ] {
            assert_eq!(repository(input).unwrap(), ("Owner".into(), "Repo".into()));
        }
        for input in [
            "http://github.com/Owner/Repo",
            "https://github.com.evil.test/Owner/Repo",
            "https://user@github.com/Owner/Repo",
            "https://github.com/Owner/Repo/issues",
            "https://github.com/Owner/Repo/blob/main/src/test.rs",
        ] {
            assert!(repository(input).is_err(), "{input}");
        }
    }

    #[test]
    fn resolves_nested_readme_links_and_images_without_rewriting_code() {
        let source = "Intro\n\n# A **tool**\n\n[Guide](../guide.md#setup) [root](/LICENSE)\n\n[![logo][badge]](../)\n\n[badge]: assets/logo.png\n\n<p><a href='../guide.md'><img src='/assets/hero.png?x=1&amp;y=2'></a></p>\n\nInline <img src='./assets/mini.png'>\n\n| Column |\n| --- |\n| value |\n\n```markdown\n[leave](./sample)\n<img src='./sample.png'>\n```";
        let readme = Readme {
            path: "docs/README.md".into(),
            html_url: "https://github.com/Owner/Repo/blob/main/docs/README.md".into(),
            download_url: "https://raw.githubusercontent.com/Owner/Repo/main/docs/README.md".into(),
            size: source.len(),
            encoding: "base64".to_owned(),
            content: STANDARD.encode(source),
        };
        let (title, output) = prepare_readme(readme, "Repo").unwrap();
        assert_eq!(title, "A tool");
        assert!(
            output.contains("https://github.com/Owner/Repo/blob/main/guide.md#setup"),
            "{output}"
        );
        assert!(
            output.contains("https://github.com/Owner/Repo/blob/main/LICENSE"),
            "{output}"
        );
        assert!(
            output
                .contains("https://raw.githubusercontent.com/Owner/Repo/main/docs/assets/logo.png"),
            "{output}"
        );
        let parsed: Vec<_> = Parser::new_ext(&output, Options::ENABLE_TABLES).collect();
        let images: Vec<_> = parsed
            .iter()
            .filter_map(|event| match event {
                Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.as_ref()),
                _ => None,
            })
            .collect();
        assert!(
            images.contains(
                &"https://raw.githubusercontent.com/Owner/Repo/main/assets/hero.png?x=1&y=2"
            ),
            "{output}"
        );
        assert!(
            images.contains(
                &"https://raw.githubusercontent.com/Owner/Repo/main/docs/assets/mini.png"
            ),
            "{output}"
        );
        assert!(parsed.iter().any(|event| matches!(event, Event::Start(Tag::Link { dest_url, .. }) if dest_url.as_ref() == "https://github.com/Owner/Repo/blob/main/guide.md")));
        assert!(output.contains("<img src='./sample.png'>"));
        assert!(
            Parser::new_ext(&output, Options::ENABLE_TABLES)
                .any(|event| matches!(event, Event::Start(Tag::Table(_))))
        );
        assert!(output.contains("[leave](./sample)"));
    }

    #[test]
    fn saved_github_pictures_open_as_editable_markdown_images_without_changing_the_saved_body() {
        let source = r#"<p align="center"><picture>
<source media="(prefers-color-scheme: light)" srcset="./images/light.png">
<img src="./images/banner.png" alt="SnowAir [轻雪]" title="横幅" onerror="alert(1)">
</picture></p>
<script>alert(1)</script>

| 功能 |
| --- |
| <picture><source srcset="./alt.svg"><img src="asset://saved" alt="截图" height="20"></picture>&nbsp;截图 |

<details><summary>展开</summary>说明</details>

本地编辑 [相对位置](./my-notes.md)"#;
        let folder = tempfile::tempdir().unwrap();
        let db = Workspace::open(&folder.path().join("workspace.db")).unwrap();
        let (id, _, _) = db
            .import_github_reference(
                "https://github.com/CM-idea/SnowAir".into(),
                "SnowAir".into(),
                source.into(),
                None,
            )
            .unwrap();
        let entry = db.get_entry(&id).unwrap().with_github_images().unwrap();
        let entry = serde_json::to_value(entry).unwrap();
        let body = entry["contentMd"].as_str().unwrap();
        let images: Vec<_> = crate::assets::references::images(body)
            .into_iter()
            .filter_map(|image| match image {
                crate::assets::references::Image::Markdown {
                    url, alt, title, ..
                } => Some((url, alt, title)),
                _ => None,
            })
            .collect();
        assert_eq!(
            images,
            [
                (
                    "https://raw.githubusercontent.com/CM-idea/SnowAir/HEAD/images/banner.png"
                        .into(),
                    "SnowAir [轻雪]".into(),
                    "横幅".into()
                ),
                ("asset://saved".into(), "截图".into(), String::new()),
            ],
            "{body}"
        );
        assert!(
            Parser::new_ext(body, Options::ENABLE_TABLES)
                .any(|event| matches!(event, Event::Start(Tag::Table(_))))
        );
        assert!(
            !body.contains("alert(1)") && !body.contains("srcset"),
            "{body}"
        );
        assert!(
            body.contains("<details><summary>展开</summary>说明</details>"),
            "{body}"
        );
        assert!(body.contains("[相对位置](./my-notes.md)"), "{body}");
        let saved = serde_json::to_value(db.get_entry(&id).unwrap()).unwrap();
        assert_eq!(saved["contentMd"], source);
        assert!(
            convert_saved_html(body, "https://github.com/CM-idea/SnowAir")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn adjacent_disclosures_keep_their_markdown_bodies() {
        let source = concat!(
            "安装说明\n<details open>\n<summary>软件下载</summary>\n<br/>\n可在线下载。\n</details>\n",
            "<details>\n<summary><strong>开源范围</strong></summary>\n<br/>\n\n",
            "**许可协议**，请从 [Releases](https://github.com/CM-idea/SnowAir/releases) 下载 `SnowAir.exe`。\n\n",
            "</details>\n## 其他\n\n",
            "```html\n<details>\n<summary>示例</summary>\n</details>\n```",
        );
        let output = convert_saved_html(source, "https://github.com/CM-idea/SnowAir")
            .unwrap()
            .unwrap();
        assert!(output.contains("说明\n\n<details open>"), "{output}");
        assert!(
            output.contains("<br/>\n\n可在线下载。\n\n</details>\n\n<details>"),
            "{output}"
        );
        assert!(output.contains("</details>\n\n## 其他"), "{output}");
        assert!(
            output.contains("```html\n<details>\n<summary>示例</summary>\n</details>\n```"),
            "{output}"
        );
        let events: Vec<_> = Parser::new(&output).collect();
        assert!(
            events
                .iter()
                .any(|event| matches!(event, Event::Start(Tag::Strong)))
        );
        assert!(
            events.iter().any(
                |event| matches!(event, Event::Code(value) if value.as_ref() == "SnowAir.exe")
            )
        );
    }

    #[test]
    fn repeated_import_keeps_local_edits_and_the_existing_reference() {
        let folder = tempfile::tempdir().unwrap();
        let db = Workspace::open(&folder.path().join("workspace.db")).unwrap();
        let url = "https://github.com/owner/repo";
        let (entry_id, existing, deleted) = db
            .import_github_reference(url.into(), "Repo".into(), "README".into(), None)
            .unwrap();
        assert!(!existing && !deleted);
        db.update_external(
            &entry_id,
            1,
            EntryPatch {
                content_md: Some("edited locally".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let saved = db
            .import_github_reference(
                url.to_ascii_uppercase(),
                "New".into(),
                "overwritten".into(),
                None,
            )
            .unwrap();
        assert_eq!(saved, (entry_id.clone(), true, false));
        let entry = serde_json::to_value(db.get_entry(&entry_id).unwrap()).unwrap();
        assert_eq!(entry["kind"], "reference");
        assert_eq!(entry["status"], "unread");
        assert_eq!(entry["contentMd"], "edited locally");
        db.set_deleted(&entry_id, 2, true).unwrap();
        assert_eq!(db.github_reference(url).unwrap(), Some((entry_id, true)));
    }
}
