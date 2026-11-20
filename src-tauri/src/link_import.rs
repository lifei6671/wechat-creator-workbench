use crate::{
    assets::Assets,
    content::{Source, http_url},
    db::{AppError, Result, Workspace},
    github_import,
    wechat_import::{ImportJob, Imports},
};
use encoding_rs::{Encoding, UTF_8};
use reqwest::header::CONTENT_TYPE;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use url::Url;

const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedLink {
    pub(crate) entry_id: String,
    pub(crate) existing: bool,
    pub(crate) deleted: bool,
    pub(crate) unavailable_images: usize,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkImportResult {
    Wechat { job: ImportJob },
    Article { article: ImportedLink },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClippedArticle {
    title: String,
    content_md: String,
    source: Source,
    summary: String,
    tags: Vec<String>,
}

#[tauri::command]
pub async fn import_clipping(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    clipping: ClippedArticle,
    category_id: Option<String>,
    download_images: bool,
) -> Result<ImportedLink> {
    let mut source = clipping.source;
    let mut address = http_url(&source.url)?;
    address.set_fragment(None);
    source.url = address.into();
    if let Some((entry_id, deleted)) = db.web_reference(&source.url)? {
        return Ok(ImportedLink {
            entry_id,
            existing: true,
            deleted,
            unavailable_images: 0,
        });
    }
    let (markdown, unavailable_images) = assets
        .import_link_images(&db, clipping.content_md, download_images)
        .await?;
    let (entry_id, existing, deleted) = db.import_web_article(
        source,
        clipping.title,
        markdown,
        clipping.summary,
        category_id,
        clipping.tags,
    )?;
    if download_images && !existing {
        let _ = app.emit("assets-changed", ());
    }
    Ok(ImportedLink {
        entry_id,
        existing,
        deleted,
        unavailable_images: if existing { 0 } else { unavailable_images },
    })
}

#[tauri::command]
pub async fn import_link(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    imports: State<'_, Imports>,
    url: String,
    category_id: Option<String>,
    download_images: bool,
) -> Result<LinkImportResult> {
    let mut address = http_url(&url)?;
    address.set_fragment(None);
    if address.host_str() == Some("mp.weixin.qq.com") {
        let job = imports
            .import(&db, &assets, address.as_str(), category_id.as_deref())
            .await?;
        let _ = app.emit("assets-changed", ());
        return Ok(LinkImportResult::Wechat { job });
    }
    let article = if github_import::repository(address.as_str()).is_ok() {
        github_import::import_readme(&db, &assets, address.as_str(), category_id, download_images)
            .await?
    } else {
        import_page(&db, &assets, address, category_id, download_images).await?
    };
    if download_images && !article.existing {
        let _ = app.emit("assets-changed", ());
    }
    Ok(LinkImportResult::Article { article })
}

async fn import_page(
    db: &Workspace,
    assets: &Assets,
    address: Url,
    category_id: Option<String>,
    download_images: bool,
) -> Result<ImportedLink> {
    if let Some((entry_id, deleted)) = db.web_reference(address.as_str())? {
        return Ok(ImportedLink {
            entry_id,
            existing: true,
            deleted,
            unavailable_images: 0,
        });
    }
    let mut response = assets.fetch_external_page(&address).await?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "LINK_HTTP",
            format!(
                "网页返回 HTTP {}，请确认链接可公开访问",
                response.status().as_u16()
            ),
        ));
    }
    let mut origin = response.url().clone();
    origin.set_fragment(None);
    if let Some((entry_id, deleted)) = db.web_reference(origin.as_str())? {
        return Ok(ImportedLink {
            entry_id,
            existing: true,
            deleted,
            unavailable_images: 0,
        });
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(mime.as_str(), "" | "text/html" | "application/xhtml+xml") {
        return Err(AppError::invalid("该链接返回的内容不是网页"));
    }
    let too_large = || AppError::new("LINK_SIZE", "网页内容过大，无法导入");
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PAGE_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::new("LINK_NETWORK", "网页读取中断，请重试"))?
    {
        if bytes.len() + chunk.len() > MAX_PAGE_BYTES {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    let page = tauri::async_runtime::spawn_blocking(move || {
        let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
        let charset = regex_lite::Regex::new(r#"(?i)charset\s*=\s*["']?\s*([a-z0-9_-]+)"#)
            .expect("charset pattern");
        let encoding = charset
            .captures(&content_type)
            .or_else(|| charset.captures(&prefix))
            .and_then(|capture| Encoding::for_label(capture[1].as_bytes()))
            .unwrap_or(UTF_8);
        parse_page(&encoding.decode(&bytes).0, &origin)
    })
    .await
    .map_err(|_| AppError::new("LINK_HTML", "网页解析失败"))??;
    let (markdown, unavailable_images) = assets
        .import_link_images(db, page.markdown, download_images)
        .await?;
    let (entry_id, existing, deleted) = db.import_web_article(
        page.source,
        page.title,
        markdown,
        page.summary,
        category_id,
        vec![],
    )?;
    Ok(ImportedLink {
        entry_id,
        existing,
        deleted,
        unavailable_images: if existing { 0 } else { unavailable_images },
    })
}

struct PageArticle {
    title: String,
    markdown: String,
    summary: String,
    source: Source,
}

fn parse_page(html: &str, origin: &Url) -> Result<PageArticle> {
    let mut article = libreadability::extract(html, Some(origin.as_str()))
        .map_err(|_| AppError::new("LINK_HTML", "无法解析网页正文"))?;
    if matches!(origin.host_str(), Some("www.v2ex.com" | "v2ex.com"))
        && origin.path().starts_with("/t/")
    {
        let document = Html::parse_document(html);
        let selector = Selector::parse(".topic_content").expect("V2EX selector");
        if let Some(topic) = document.select(&selector).next() {
            article.content = topic.html();
            article.excerpt = topic.text().collect::<Vec<_>>().join(" ");
            for (selector, field) in [
                ("#Main .header h1", &mut article.title),
                (
                    "#Main .header small a[href^='/member/']",
                    &mut article.byline,
                ),
            ] {
                let selector = Selector::parse(selector).expect("V2EX metadata selector");
                if let Some(element) = document.select(&selector).next() {
                    *field = element.text().collect::<String>().trim().to_owned();
                }
            }
        }
    }
    let clean = ammonia::Builder::default()
        .url_relative(ammonia::UrlRelative::RewriteWithBase(origin.clone()))
        .clean(&article.content)
        .to_string();
    let markdown =
        htmd::convert(&clean).map_err(|_| AppError::new("LINK_HTML", "无法转换网页正文"))?;
    let markdown = markdown.trim().to_owned();
    if markdown.is_empty() {
        return Err(AppError::new(
            "LINK_EMPTY",
            "网页没有可提取的正文，可能需要登录或由脚本加载",
        ));
    }
    let domain = origin.host_str().unwrap_or_default();
    let published = chrono::DateTime::parse_from_rfc3339(&article.published_time)
        .ok()
        .map(|date| date.timestamp_millis())
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(&article.published_time, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis())
        });
    Ok(PageArticle {
        title: if article.title.trim().is_empty() {
            domain.into()
        } else {
            article.title.trim().into()
        },
        markdown,
        summary: article
            .excerpt
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(300)
            .collect(),
        source: Source {
            url: origin.to_string(),
            author: article.byline,
            account_name: if article.site_name.is_empty() {
                domain.into()
            } else {
                article.site_name
            },
            original_published_at: published,
            imported_at: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_article_body_and_metadata_with_absolute_urls() {
        let origin = Url::parse("https://example.com/posts/entry").unwrap();
        let page = parse_page(r#"<!doctype html><html><head>
            <title>页面标题</title>
            <meta property="og:title" content="Importing a blog post">
            <meta property="og:site_name" content="Test Blog">
            <meta name="author" content="Lin">
            <meta name="description" content="A short summary">
            <meta property="article:published_time" content="2026-11-19T10:00:00+08:00">
          </head><body>
            <nav><a href="/subscribe">Navigation menu</a></nav>
            <main><article><h1>Importing a blog post</h1>
            <p>A public article may have a complete body that is readable without JavaScript. This paragraph deliberately contains several complete sentences so the extractor can distinguish article text from the rest of the page.</p>
            <p>This paragraph has a <a href="../guide">related guide</a> and an image that both use relative addresses. The converted Markdown must resolve their addresses relative to the original page.</p>
            <figure><img src="images/chart.png" alt="Example chart"><figcaption>A chart</figcaption></figure>
            <script>script_marker()</script><p><a href="javascript:alert(1)">Unsafe link</a></p>
            </article></main>
            <footer>Site footer</footer></body></html>"#, &origin).unwrap();
        assert_eq!(page.title, "Importing a blog post");
        assert_eq!(page.summary, "A short summary");
        assert_eq!(page.source.author, "Lin");
        assert_eq!(page.source.account_name, "Test Blog");
        assert_eq!(
            page.source.original_published_at,
            Some(
                chrono::DateTime::parse_from_rfc3339("2026-11-19T02:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
        assert!(
            page.markdown
                .contains("[related guide](https://example.com/guide)"),
            "{}",
            page.markdown
        );
        assert!(
            page.markdown
                .contains("https://example.com/posts/images/chart.png"),
            "{}",
            page.markdown
        );
        for removed in [
            "Navigation menu",
            "Site footer",
            "script_marker",
            "javascript:",
        ] {
            assert!(!page.markdown.contains(removed), "{}", page.markdown);
        }
    }

    #[test]
    fn extracts_v2ex_topic_without_replies() {
        let page = parse_page(r#"<html><head><title>一个主题 - V2EX</title></head><body>
            <div id="Main"><div class="box"><div class="header"><h1>一个主题</h1>
            <small><a href="/member/author">主题作者</a></small></div>
            <div class="topic_content"><p>主题正文，包含 <a href="/go/codex">链接</a>。</p></div></div>
            <div class="box"><p>这里是一条很长的回复。这条回复出现在评论区，导入外部文章时不会跟随主题正文进入笔记。</p></div>
            </div></body></html>"#, &Url::parse("https://www.v2ex.com/t/1").unwrap()).unwrap();
        assert_eq!(page.title, "一个主题");
        assert_eq!(page.source.author, "主题作者");
        assert!(
            page.markdown
                .contains("主题正文，包含 [链接](https://www.v2ex.com/go/codex)")
        );
        assert!(!page.markdown.contains("这里是一条很长的回复"));
        assert!(page.summary.starts_with("主题正文"));
    }
}
