use crate::db::{AppError, Result, Workspace};
use base64::{Engine, engine::general_purpose::STANDARD};
use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd};
use reqwest::{StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubImport {
    entry_id: String,
    existing: bool,
    deleted: bool,
}

#[tauri::command]
pub async fn github_import(
    state: State<'_, Workspace>,
    url: String,
    category_id: Option<String>,
) -> Result<GitHubImport> {
    let (owner, repo) = repository(&url)?;
    let canonical = format!("https://github.com/{owner}/{repo}").to_ascii_lowercase();
    if let Some((entry_id, deleted)) = state.github_reference(&canonical)? {
        return Ok(GitHubImport {
            entry_id,
            existing: true,
            deleted,
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
    let (entry_id, existing, deleted) =
        state.import_github_reference(canonical, title, markdown, category_id)?;
    Ok(GitHubImport {
        entry_id,
        existing,
        deleted,
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

fn repository(value: &str) -> Result<(String, String)> {
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
    let html_root = repository_root(&html, &readme.path)?;
    let raw_root = repository_root(&raw, &readme.path)?;
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH;
    let mut title = String::new();
    let mut in_title = false;
    let mut changed = false;
    let mut events = Vec::new();
    for mut event in Parser::new_ext(markdown, options) {
        match &mut event {
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
            }) => {
                changed |= resolve_link(link_type, dest_url, &raw, &raw_root);
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => {
                changed |= resolve_link(link_type, dest_url, &html, &html_root);
            }
            _ => {}
        }
        events.push(event);
    }
    let title = title.trim();
    let title = if title.is_empty() { repository } else { title }.to_owned();
    let mut output = String::new();
    if changed {
        let mut format_options = pulldown_cmark_to_cmark::Options::default();
        if let Some(tokens) =
            pulldown_cmark_to_cmark::calculate_code_block_token_count(events.iter())
        {
            format_options.code_block_token_count = tokens;
        }
        pulldown_cmark_to_cmark::cmark_with_options(
            events.iter(),
            &mut output,
            options,
            format_options,
        )
        .map_err(|error| AppError::new("GITHUB_README", format!("README 链接转换失败：{error}")))?;
    } else {
        output.push_str(markdown);
    }
    Ok((title, output))
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
    if Url::parse(destination).is_ok() {
        return false;
    }
    let resolved = if let Some(path) = destination
        .strip_prefix('/')
        .filter(|path| !path.starts_with('/'))
    {
        root.join(path)
    } else {
        base.join(destination)
    };
    if let Ok(url) = resolved
        && url.scheme() == "https"
    {
        *link_type = LinkType::Inline;
        *destination = url.to_string().into();
        return true;
    }
    false
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
        let source = "Intro\n\n# A **tool**\n\n[Guide](../guide.md#setup) [root](/LICENSE)\n\n[![logo][badge]](../)\n\n[badge]: assets/logo.png\n\n| Column |\n| --- |\n| value |\n\n```markdown\n[leave](./sample)\n```";
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
        assert!(
            Parser::new_ext(&output, Options::ENABLE_TABLES)
                .any(|event| matches!(event, Event::Start(Tag::Table(_))))
        );
        assert!(output.contains("[leave](./sample)"));
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
