use crate::{
    assets::{Assets, MAX_BYTES, references},
    db::{AppError, Result, Workspace, id, now},
};
use lol_html::{RewriteStrSettings, element, rewrite_str};
use rusqlite::{Connection, OptionalExtension, params};
use scraper::{Html, Selector};
use serde::Serialize;
use std::{collections::BTreeMap, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use url::Url;

pub struct Imports {
    client: reqwest::Client,
    operation: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    url: String,
    status: String,
    entry_id: Option<String>,
    error: Option<String>,
    pending_images: i64,
}

struct Article {
    title: String,
    account: String,
    author: String,
    published: Option<i64>,
    canonical: Url,
    markdown: String,
    images: BTreeMap<String, String>,
}

enum ImportTarget<'a> {
    Desktop(Option<&'a str>),
    Mcp,
}

impl Imports {
    pub async fn wait_idle(&self) {
        let _operation = self.operation.lock().await;
    }

    pub fn new(db: &Workspace) -> Result<Self> {
        db.write(|tx| {
            tx.execute("UPDATE jobs SET status='failed',error='上次导入中断，可手动重试' WHERE (kind IN ('wechat_import','import_image') AND status='running') OR (kind='wechat_import' AND status='queued')", [])?;
            Ok(())
        })?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) WeChatCreatorWorkbench/0.1")
            .build()
            .map_err(network)?;
        Ok(Self {
            client,
            operation: tokio::sync::Mutex::new(()),
        })
    }

    pub async fn import(
        &self,
        db: &Workspace,
        assets: &Assets,
        url: &str,
        category_id: Option<&str>,
    ) -> Result<ImportJob> {
        let url = normalize(url)?;
        let _operation = self.operation.lock().await;
        let (job, existing) = db.write(|tx| {
            let existing = lookup(tx, url.as_str())?;
            let job = tx.query_row("SELECT id FROM jobs WHERE kind='wechat_import' AND source_url=?1",
                [url.as_str()], |r| r.get::<_, String>(0)).optional()?.unwrap_or_else(id);
            if existing.is_some() {
                tx.execute("INSERT INTO jobs(id,kind,status,entry_id,source_url,created_at,updated_at)
                    VALUES (?1,'wechat_import','completed',?2,?3,?4,?4)
                    ON CONFLICT(id) DO UPDATE SET entry_id=excluded.entry_id,status='completed',error=NULL,updated_at=excluded.updated_at",
                    params![job, existing, url.as_str(), now()])?;
            } else {
                tx.execute("INSERT INTO jobs(id,kind,status,source_url,created_at,updated_at)
                    VALUES (?1,'wechat_import','running',?2,?3,?3)
                    ON CONFLICT(id) DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at",
                    params![job, url.as_str(), now()])?;
            }
            Ok((job, existing))
        })?;
        if existing.is_some() {
            return db.read(|conn| job_info(conn, &job));
        }
        self.run_import(
            db,
            assets,
            url,
            &job,
            ImportTarget::Desktop(category_id),
            &CancellationToken::new(),
        )
        .await
    }

    pub fn enqueue(&self, db: &Workspace, url: &str) -> Result<(ImportJob, bool)> {
        let url = normalize(url)?;
        db.write(|tx| {
            let existing = lookup(tx, url.as_str())?;
            let job = tx.query_row("SELECT id FROM jobs WHERE kind='wechat_import' AND source_url=?1",
                [url.as_str()], |r| r.get::<_, String>(0)).optional()?.unwrap_or_else(id);
            let start = if existing.is_some() {
                tx.execute("INSERT INTO jobs(id,kind,status,entry_id,source_url,created_at,updated_at)
                    VALUES (?1,'wechat_import','completed',?2,?3,?4,?4)
                    ON CONFLICT(id) DO UPDATE SET entry_id=excluded.entry_id,status='completed',error=NULL,updated_at=excluded.updated_at
                    WHERE jobs.status<>'running'",params![job, existing, url.as_str(), now()])?;
                false
            } else {
                tx.execute("INSERT INTO jobs(id,kind,status,source_url,created_at,updated_at)
                    VALUES (?1,'wechat_import','queued',?2,?3,?3)
                    ON CONFLICT(id) DO UPDATE SET status='queued',error=NULL,updated_at=excluded.updated_at
                    WHERE jobs.status NOT IN ('queued','running')",params![job, url.as_str(), now()])? > 0
            };
            Ok((job_info(tx, &job)?, start))
        })
    }

    pub async fn run_queued(
        &self,
        db: &Workspace,
        assets: &Assets,
        job: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let _operation = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return db.maintenance(|tx| {
                    tx.execute("UPDATE jobs SET status='failed',error='导入已停止，可手动重试',updated_at=?2 WHERE id=?1 AND status='queued'", params![job,now()])?;
                    Ok(())
                });
            }
            lock = self.operation.lock() => lock,
        };
        let url = db.maintenance(|tx| {
            Ok(tx.query_row("UPDATE jobs SET status='running',updated_at=?2 WHERE id=?1 AND status='queued' RETURNING source_url", params![job, now()], |row| row.get::<_,String>(0)).optional()?)
        })?;
        if let Some(url) = url {
            self.run_import(db, assets, normalize(&url)?, job, ImportTarget::Mcp, cancel)
                .await?;
        }
        Ok(())
    }

    async fn run_import(
        &self,
        db: &Workspace,
        assets: &Assets,
        url: Url,
        job: &str,
        target: ImportTarget<'_>,
        cancel: &CancellationToken,
    ) -> Result<ImportJob> {
        let work = async {
            let (entry_kind, entry_status, category_id) = match target {
                ImportTarget::Desktop(category_id) => ("article", "draft", category_id),
                ImportTarget::Mcp => ("reference", "unread", None),
            };
            let (bytes, origin) = self.fetch(url.clone(), false).await?;
            let html = String::from_utf8(bytes)
                .map_err(|_| AppError::new("WECHAT_HTML", "公众号页面不是有效的 UTF-8"))?;
            let article = parse(&html, &origin)?;
            let (entry, inserted) = db.write(|tx| {
                if let Some(entry) = lookup(tx, article.canonical.as_str())?.or(lookup(tx, origin.as_str())?) {
                    tx.execute("INSERT OR IGNORE INTO wechat_sources VALUES (?1,?2)", params![url.as_str(), entry])?;
                    tx.execute("UPDATE jobs SET entry_id=?2,status='completed',updated_at=?3 WHERE id=?1", params![job, entry, now()])?;
                    return Ok((entry, false));
                }
                let source_id = id();
                let entry_id = id();
                let timestamp = now();
                let source_id: String = tx.query_row("INSERT INTO sources VALUES (?1,?2,?3,?4,?5,?6)
                    ON CONFLICT(source_url) DO UPDATE SET author=excluded.author,account_name=excluded.account_name,
                    original_published_at=excluded.original_published_at,imported_at=excluded.imported_at RETURNING id",
                    params![source_id,article.canonical.as_str(),article.author,article.account,article.published,timestamp], |row| row.get(0))?;
                tx.execute("INSERT INTO entries (id,kind,title,content_md,status,source_id,created_at,updated_at,wechat_imported,category_id)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?7,1,?8)",
                    params![entry_id,entry_kind,article.title,article.markdown,entry_status,source_id,timestamp,category_id])?;
                for alias in [url.as_str(), origin.as_str(), article.canonical.as_str()] {
                    if let Ok(alias) = normalize(alias) {
                        tx.execute("INSERT OR IGNORE INTO wechat_sources VALUES (?1,?2)",params![alias.as_str(),entry_id])?;
                    }
                }
                for (image, asset_id) in article.images {
                    tx.execute("INSERT INTO assets (id,kind,created_at,name) VALUES (?1,'original',?2,'公众号图片')",params![asset_id,timestamp])?;
                    tx.execute("INSERT INTO jobs(id,kind,status,entry_id,asset_id,source_url,created_at,updated_at)
                        VALUES (?1,'import_image','queued',?2,?3,?4,?5,?5)",params![id(),entry_id,asset_id,image,timestamp])?;
                }
                references::sync_entry(tx, &entry_id, &article.markdown)?;
                tx.execute("UPDATE jobs SET entry_id=?2,updated_at=?3 WHERE id=?1",params![job,entry_id,timestamp])?;
                Ok((entry_id, true))
            })?;
            if inserted {
                self.download_images(db, assets, &entry, None).await?;
            }
            Ok(())
        };
        let result: Result<()> = tokio::select! {
            biased;
            () = cancel.cancelled() => Err(AppError::new("IMPORT_STOPPED", "导入已停止，可手动重试")),
            result = work => result,
        };
        if let Err(error) = result {
            let status = if error.code() == "WECHAT_RESTRICTED" {
                "needs_attention"
            } else {
                "failed"
            };
            db.maintenance(|tx| {
                tx.execute("UPDATE jobs SET status='failed',error=?2,updated_at=?3 WHERE kind='import_image' AND status='running'
                    AND entry_id=(SELECT entry_id FROM jobs WHERE id=?1)", params![job,error.to_string(),now()])?;
                tx.execute(
                    "UPDATE jobs SET status=?2,error=?3,updated_at=?4 WHERE id=?1",
                    params![job, status, error.to_string(), now()],
                )?;
                Ok(())
            })?;
        }
        self.job(db, job)
    }

    pub fn job(&self, db: &Workspace, job: &str) -> Result<ImportJob> {
        db.read(|conn| job_info(conn, job))
    }

    pub async fn retry(&self, db: &Workspace, assets: &Assets, entry: &str) -> Result<ImportJob> {
        let _operation = self.operation.lock().await;
        self.download_images(db, assets, entry, None).await?;
        db.read(|conn| {
            let first: String = conn.query_row("SELECT id FROM jobs WHERE kind='wechat_import' AND entry_id=?1 ORDER BY created_at LIMIT 1",
                [entry], |row| row.get(0))?;
            job_info(conn, &first)
        })
    }

    pub(crate) async fn retry_asset(
        &self,
        db: &Workspace,
        assets: &Assets,
        asset: &str,
    ) -> Result<bool> {
        let _operation = self.operation.lock().await;
        let job: Option<(String, String)> = db.read_running(|conn| {
            Ok(conn
                .query_row(
                    "SELECT entry_id,id FROM jobs WHERE kind='import_image' AND asset_id=?1
                AND status IN ('queued','failed','skipped')",
                    [asset],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        })?;
        let Some((entry, job)) = job else {
            return Ok(false);
        };
        self.download_images(db, assets, &entry, Some(asset))
            .await?;
        db.read(|conn| {
            let error: Option<String> = conn
                .query_row(
                    "SELECT error FROM jobs WHERE id=?1 AND status='failed'",
                    [job],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            if let Some(error) = error {
                return Err(AppError::new("WECHAT_IMAGE", error));
            }
            Ok(true)
        })
    }

    async fn download_images(
        &self,
        db: &Workspace,
        assets: &Assets,
        entry: &str,
        asset: Option<&str>,
    ) -> Result<()> {
        let tasks = db.read_running(|conn| {
            let mut query = conn.prepare("SELECT id,asset_id,source_url FROM jobs WHERE kind='import_image' AND entry_id=?1
                AND (?2 IS NULL OR asset_id=?2) AND status IN ('queued','failed','skipped') ORDER BY created_at,id")?;
            Ok(query.query_map(params![entry,asset], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })?;
        for (job, asset, source) in tasks {
            if !assets.is_referenced(db, &asset)? {
                image_status(db, &job, "skipped", None)?;
                continue;
            }
            image_status(db, &job, "running", None)?;
            let url = Url::parse(&source).map_err(|_| AppError::invalid("原图地址无效"));
            let result = async {
                let (bytes, _) = self.fetch(url?, true).await?;
                assets.fill(db, &asset, bytes).await?;
                Ok::<_, AppError>(())
            }
            .await;
            match result {
                Ok(()) => image_status(db, &job, "completed", None)?,
                Err(error) if error.code() == "ASSET_UNUSED" => {
                    image_status(db, &job, "skipped", None)?
                }
                Err(error) => image_status(db, &job, "failed", Some(&error.to_string()))?,
            }
        }
        db.maintenance(|tx| {
            tx.execute(
                "UPDATE jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM jobs image WHERE image.kind='import_image'
                AND image.entry_id=?1 AND image.status NOT IN ('completed','skipped')) THEN 'partial' ELSE 'completed' END,
                error=NULL,updated_at=?2 WHERE kind='wechat_import' AND entry_id=?1",params![entry,now()])?;
            Ok(())
        })
    }

    async fn fetch(&self, mut url: Url, image: bool) -> Result<(Vec<u8>, Url)> {
        let limit = if image { MAX_BYTES } else { 8 * 1024 * 1024 };
        for _ in 0..=3 {
            validate_host(&url, image)?;
            let mut response = self.client.get(url.clone()).send().await.map_err(network)?;
            if response.status().is_redirection() {
                let target = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| AppError::new("WECHAT_HTTP", "重定向缺少有效地址"))?;
                url = url
                    .join(target)
                    .map_err(|_| AppError::new("WECHAT_HTTP", "重定向地址无效"))?;
                continue;
            }
            let status = response.status();
            if !image && matches!(status.as_u16(), 401 | 403 | 429) {
                return Err(AppError::new(
                    "WECHAT_RESTRICTED",
                    format!("微信限制访问（HTTP {status}）"),
                ));
            }
            if !status.is_success() {
                return Err(AppError::new(
                    "WECHAT_HTTP",
                    format!("下载失败（HTTP {status}）"),
                ));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network)? {
                if bytes.len() + chunk.len() > limit {
                    return Err(AppError::new("WECHAT_SIZE", "下载内容超出大小限制"));
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok((bytes, url));
        }
        Err(AppError::new("WECHAT_HTTP", "重定向次数超限"))
    }
}

fn network(error: reqwest::Error) -> AppError {
    AppError::new(
        "WECHAT_NETWORK",
        format!("下载失败：{}", error.without_url()),
    )
}

fn validate_host(url: &Url, image: bool) -> Result<()> {
    let host = url.host_str().unwrap_or_default();
    let host_ok = if image {
        matches!(host, "mmbiz.qpic.cn" | "mmbiz.qlogo.cn")
    } else {
        host == "mp.weixin.qq.com"
    };
    if url.scheme() != "https"
        || !host_ok
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::new(
            "WECHAT_ADDRESS",
            "只允许访问微信公开文章及其 HTTPS 图片服务",
        ));
    }
    Ok(())
}

fn normalize(value: &str) -> Result<Url> {
    let url =
        Url::parse(value.trim()).map_err(|_| AppError::invalid("请输入完整的公众号文章链接"))?;
    validate_host(&url, false)?;
    let mut canonical = Url::parse("https://mp.weixin.qq.com/s").expect("fixed WeChat base");
    let path = url.path();
    if let Some(token) = path.strip_prefix("/s/") {
        if token.is_empty()
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err(AppError::invalid("公众号文章短链接无效"));
        }
        canonical.set_path(path);
    } else if path == "/s" {
        let fields: BTreeMap<_, _> = url.query_pairs().collect();
        if ["__biz", "mid", "idx"]
            .iter()
            .any(|key| !fields.get(*key).is_some_and(|value| !value.is_empty()))
        {
            return Err(AppError::invalid("公众号文章链接缺少文章参数"));
        }
        let mut query = canonical.query_pairs_mut();
        for key in ["__biz", "mid", "idx", "sn"] {
            if let Some(value) = fields.get(key) {
                query.append_pair(key, value);
            }
        }
    } else {
        return Err(AppError::invalid("请选择公众号公开文章链接"));
    }
    Ok(canonical)
}

fn parse(html: &str, origin: &Url) -> Result<Article> {
    let document = Html::parse_document(html);
    let select = |css: &str| {
        document
            .select(&Selector::parse(css).expect("fixed WeChat selector"))
            .next()
    };
    let text = |css| {
        select(css)
            .map(|element| element.text().collect::<String>().trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let meta = |css| {
        select(css)
            .and_then(|element| element.attr("content"))
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let body = select("#js_content").ok_or_else(|| {
        let restriction = select("#js_verify, #js_cgi_verify, .weui-msg").is_some()
            || [
                "环境异常",
                "访问受限",
                "需要验证",
                "已被删除",
                "已删除",
                "内容无法查看",
            ]
            .iter()
            .any(|word| html.contains(word));
        AppError::new(
            if restriction {
                "WECHAT_RESTRICTED"
            } else {
                "WECHAT_HTML"
            },
            if restriction {
                "微信要求验证，或原文不可访问"
            } else {
                "找不到公众号文章正文"
            },
        )
    })?;
    let title = text("#activity-name")
        .or_else(|| meta("meta[property='og:title']").map(str::to_owned))
        .ok_or_else(|| AppError::new("WECHAT_HTML", "找不到公众号文章标题"))?;
    let account = text("#js_name")
        .or_else(|| text("#profileBt"))
        .unwrap_or_default();
    let author = text("#js_author_name")
        .or_else(|| text("#meta_content .rich_media_meta_text"))
        .unwrap_or_default();
    let published = meta("meta[property='article:published_time']")
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|date| date.timestamp_millis())
        .or_else(|| {
            let pattern = regex_lite::Regex::new(r#"\b(?:ct|publish_time)\s*=\s*['"]?(\d{10})\b"#)
                .expect("fixed timestamp pattern");
            pattern
                .captures(html)?
                .get(1)?
                .as_str()
                .parse::<i64>()
                .ok()
                .map(|seconds| seconds * 1000)
        });
    let canonical = meta("meta[property='og:url']")
        .and_then(|url| normalize(url).ok())
        .or_else(|| {
            select("link[rel='canonical']")
                .and_then(|link| link.attr("href"))
                .and_then(|url| normalize(url).ok())
        })
        .map_or_else(|| normalize(origin.as_str()), Ok)?;

    let mut images = BTreeMap::new();
    let clean = ammonia::Builder::default()
        .add_tag_attributes("img", ["data-src"])
        .add_tags(["section"])
        .url_relative(ammonia::UrlRelative::RewriteWithBase(origin.clone()))
        .clean(&body.inner_html())
        .to_string();
    let rewritten = rewrite_str(
        &clean,
        RewriteStrSettings {
            element_content_handlers: vec![element!("img", |image| {
                let url = image
                    .get_attribute("data-src")
                    .filter(|src| !src.trim().is_empty())
                    .or_else(|| image.get_attribute("src"))
                    .filter(|src| !src.trim().is_empty());
                let Some(url) = url
                    .and_then(|src| {
                        origin
                            .join(html_escape::decode_html_entities(&src).trim())
                            .ok()
                    })
                    .filter(|url| matches!(url.scheme(), "http" | "https"))
                else {
                    image.remove();
                    return Ok(());
                };
                let asset = images.entry(url.to_string()).or_insert_with(id);
                image.remove_attribute("data-src");
                image.set_attribute("src", &format!("asset://{asset}"))?;
                Ok(())
            })],
            ..RewriteStrSettings::default()
        },
    )
    .map_err(|e| AppError::new("WECHAT_HTML", e.to_string()))?;
    let markdown =
        htmd::convert(&rewritten).map_err(|e| AppError::new("WECHAT_HTML", e.to_string()))?;
    if markdown.trim().is_empty() {
        return Err(AppError::new("WECHAT_HTML", "公众号正文为空"));
    }
    Ok(Article {
        title,
        account,
        author,
        published,
        canonical,
        markdown,
        images,
    })
}

fn lookup(conn: &Connection, url: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT entry_id FROM wechat_sources WHERE url=?1
        UNION SELECT e.id FROM entries e JOIN sources s ON s.id=e.source_id WHERE s.source_url=?1 LIMIT 1",
        [url], |r| r.get(0)).optional()?)
}

fn image_status(db: &Workspace, job: &str, status: &str, error: Option<&str>) -> Result<()> {
    let update = |tx: &rusqlite::Transaction<'_>| {
        tx.execute(
            "UPDATE jobs SET status=?2,error=?3,updated_at=?4 WHERE id=?1",
            params![job, status, error, now()],
        )?;
        Ok(())
    };
    if status == "running" {
        db.write(update)
    } else {
        db.maintenance(update)
    }
}

fn job_info(conn: &Connection, job: &str) -> Result<ImportJob> {
    Ok(conn.query_row("SELECT j.id,j.source_url,j.status,j.entry_id,
        COALESCE(j.error,(SELECT i.error FROM jobs i WHERE i.kind='import_image' AND i.entry_id=j.entry_id AND i.status='failed' ORDER BY i.updated_at LIMIT 1)),
        (SELECT COUNT(*) FROM jobs i WHERE i.kind='import_image' AND i.entry_id=j.entry_id AND i.status NOT IN ('completed','skipped'))
        FROM jobs j WHERE j.id=?1 AND j.kind='wechat_import'", [job], |r| {
        let pending_images = r.get(5)?;
        let status: String = r.get(2)?;
        let entry_id: Option<String> = r.get(3)?;
        Ok(ImportJob { id:r.get(0)?, url:r.get(1)?,
            status: if entry_id.is_some() && status!="running" {
                if pending_images > 0 { "partial".into() } else { "completed".into() }
            } else {status},
            entry_id,error:r.get(4)?,pending_images })
    })?)
}

#[tauri::command]
pub async fn wechat_retry_images(
    app: AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    imports: State<'_, Imports>,
    entry: String,
) -> Result<ImportJob> {
    let result = imports.retry(&db, &assets, &entry).await?;
    let _ = app.emit("assets-changed", ());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queued_imports_are_deduplicated_and_cancellable_before_network_access() {
        let dir = tempfile::tempdir().unwrap();
        let db = Workspace::open(&dir.path().join("content.db")).unwrap();
        let assets = Assets::new(dir.path().join("assets"), &db).unwrap();
        let imports = Imports::new(&db).unwrap();
        let (job, start) = imports
            .enqueue(&db, "https://mp.weixin.qq.com/s/abc?tracking=1")
            .unwrap();
        assert!(start);
        assert_eq!(job.status, "queued");
        let (same, start) = imports
            .enqueue(&db, "https://mp.weixin.qq.com/s/abc")
            .unwrap();
        assert!(!start);
        assert_eq!(job.id, same.id);
        let cancel = CancellationToken::new();
        cancel.cancel();
        imports
            .run_queued(&db, &assets, &job.id, &cancel)
            .await
            .unwrap();
        assert_eq!(imports.job(&db, &job.id).unwrap().status, "failed");
        let (retried, start) = imports
            .enqueue(&db, "https://mp.weixin.qq.com/s/abc")
            .unwrap();
        assert!(start);
        assert_eq!(retried.id, job.id);
    }

    #[test]
    fn normalizes_share_links_and_limits_image_and_page_targets() {
        let long = normalize(
            "https://mp.weixin.qq.com/s?scene=2&idx=1&mid=12&__biz=ABC%3D&sn=token#wechat_redirect",
        )
        .unwrap();
        assert_eq!(
            long.as_str(),
            "https://mp.weixin.qq.com/s?__biz=ABC%3D&mid=12&idx=1&sn=token"
        );
        assert_eq!(
            normalize("https://mp.weixin.qq.com/s/a_b-6?from=groupmessage")
                .unwrap()
                .path(),
            "/s/a_b-6"
        );
        assert!(normalize("https://mp.weixin.qq.com.example.test/s/abc").is_err());
        assert!(normalize("https://mp.weixin.qq.com:8443/s/abc").is_err());
        assert!(validate_host(&Url::parse("https://192.168.1.1/x.png").unwrap(), true).is_err());
        assert!(validate_host(&Url::parse("https://mmbiz.qpic.cn/x.png").unwrap(), true).is_ok());
    }

    #[test]
    fn extracts_metadata_and_deduplicates_lazy_images_without_saving_html() {
        let html = r#"<meta property="og:url" content="https://mp.weixin.qq.com/s/canonical">
          <h1 id="activity-name">文章标题</h1><a id="js_name">测试公众号</a>
          <span id="js_author_name">李四</span><script>var ct = "1762345678";</script>
          <div id="js_content"><h2>小标题</h2><p>这是<strong>正文</strong></p>
          <img data-src="https://mmbiz.qpic.cn/test.png?a=1&amp;b=2" src="loading.png" alt="图片" onerror="alert(1)">
          <img data-src="https://mmbiz.qpic.cn/test.png?a=1&amp;b=2"><script>dirty text</script></div>"#;
        let origin = Url::parse("https://mp.weixin.qq.com/redirected").unwrap();
        let page = parse(html, &origin).unwrap();
        assert_eq!(page.title, "文章标题");
        assert_eq!(page.account, "测试公众号");
        assert_eq!(page.author, "李四");
        assert_eq!(page.published, Some(1762345678000));
        assert_eq!(page.canonical.path(), "/s/canonical");
        assert!(page.markdown.contains("## 小标题"));
        assert!(page.markdown.contains("**正文**"));
        assert!(!page.markdown.contains("dirty text"));
        let id = &page.images["https://mmbiz.qpic.cn/test.png?a=1&b=2"];
        assert_eq!(page.markdown.matches(&format!("asset://{id}")).count(), 2);
        assert_eq!(page.images.len(), 1);
    }

    #[test]
    fn reports_wechat_verification_without_extracting_a_document() {
        let url = normalize("https://mp.weixin.qq.com/s/abc").unwrap();
        let error = parse("<main id='js_verify'>环境异常，需要验证</main>", &url)
            .err()
            .unwrap();
        assert_eq!(error.code(), "WECHAT_RESTRICTED");
    }
}
