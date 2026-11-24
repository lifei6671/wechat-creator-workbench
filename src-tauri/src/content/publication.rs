use crate::db::{AppError, Result, Workspace, now};
use pulldown_cmark::{Event, Parser};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use url::Url;

#[cfg(test)]
mod tests;

#[derive(Clone, Deserialize, Serialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recommendation {
    pub entry_id: String,
    pub title: String,
    pub url: String,
}

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Auto,
    Manual,
}

#[derive(Clone, Deserialize, Serialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recommendations {
    pub enabled: bool,
    pub mode: Mode,
    pub count_override: Option<u32>,
    pub input_fingerprint: Option<String>,
    pub items: Vec<Recommendation>,
}

#[derive(Clone, Deserialize, Serialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publication {
    pub schema_version: u32,
    pub recommendations: Recommendations,
}

impl Publication {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.recommendations.count_override == Some(0) {
            return Err(AppError::invalid("公众号配置版本或推荐数量无效"));
        }
        if self
            .recommendations
            .input_fingerprint
            .as_ref()
            .is_some_and(|value| {
                value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(AppError::invalid("推荐输入指纹无效"));
        }
        let mut ids = HashSet::new();
        let mut urls = HashSet::new();
        for item in &self.recommendations.items {
            let canonical = article_url(&item.url)
                .ok_or_else(|| AppError::invalid("推荐文章必须使用有效的微信发布链接"))?;
            if item.entry_id.trim().is_empty()
                || item.title.trim().is_empty()
                || !ids.insert(&item.entry_id)
                || !urls.insert(canonical)
            {
                return Err(AppError::invalid("推荐文章不能为空或重复"));
            }
        }
        if serde_json::to_vec(self)
            .expect("publication serializes")
            .len()
            > 256 * 1024
        {
            return Err(AppError::invalid("推荐列表过长，请减少条目后重试"));
        }
        Ok(())
    }
}

/// Returns an identity for deduplication, preserving the original URL for output.
pub fn article_url(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str() != Some("mp.weixin.qq.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if let Some(token) = url.path().strip_prefix("/s/")
        && !token.is_empty()
        && !token.contains('/')
    {
        return Some(format!("https://mp.weixin.qq.com/s/{token}"));
    }
    if url.path() != "/s" {
        return None;
    }
    let pairs = url.query_pairs().collect::<HashMap<_, _>>();
    let identity = ["__biz", "mid", "idx"]
        .into_iter()
        .map(|key| {
            pairs
                .get(key)
                .filter(|value| !value.is_empty())
                .map(|value| (key, value.to_string()))
        })
        .collect::<Option<Vec<_>>>()?;
    let mut canonical = Url::parse("https://mp.weixin.qq.com/s").expect("static URL");
    canonical.query_pairs_mut().extend_pairs(identity);
    Some(canonical.to_string())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefaultsConfig {
    pub schema_version: u32,
    pub recommendation_count: u32,
    #[serde(default)]
    pub recommendation_authors: Vec<String>,
}

impl DefaultsConfig {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.recommendation_count == 0 {
            return Err(AppError::invalid("默认推荐数量必须是大于 0 的整数"));
        }
        let mut authors = HashSet::new();
        if self.recommendation_authors.iter().any(|author| {
            author.trim().is_empty() || author != author.trim() || !authors.insert(author)
        }) {
            return Err(AppError::invalid("推荐作者不能为空或重复"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    #[serde(flatten)]
    pub config: DefaultsConfig,
    pub version: i64,
    pub updated_at: i64,
}

pub fn defaults(conn: &Connection) -> Result<Defaults> {
    let row = conn
        .query_row(
            "SELECT config,version,updated_at FROM wechat_publication_defaults WHERE id='default'",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match row {
        Some((config, version, updated_at)) => Ok(Defaults {
            config: serde_json::from_str(&config).map_err(invalid)?,
            version,
            updated_at,
        }),
        None => Ok(Defaults {
            config: DefaultsConfig {
                schema_version: 1,
                recommendation_count: 5,
                recommendation_authors: vec![],
            },
            version: 0,
            updated_at: 0,
        }),
    }
}

pub fn defaults_snapshot(conn: &Connection, id: &str) -> Result<Option<Value>> {
    if id != "default" {
        return Err(AppError::invalid("公众号默认配置标识无效"));
    }
    let value = defaults(conn)?;
    if value.version == 0 {
        return Ok(None);
    }
    let mut snapshot = json!({ "schemaVersion": value.config.schema_version,
        "recommendationCount": value.config.recommendation_count,
        "updatedAt": value.updated_at });
    if !value.config.recommendation_authors.is_empty() {
        snapshot["recommendationAuthors"] = json!(value.config.recommendation_authors);
    }
    Ok(Some(snapshot))
}

pub fn apply_defaults(conn: &Connection, id: &str, payload: &Value) -> Result<()> {
    if id != "default" {
        return Err(AppError::invalid("公众号默认配置标识无效"));
    }
    let mut config = payload.clone();
    config
        .as_object_mut()
        .ok_or_else(|| AppError::invalid("公众号默认配置无效"))?
        .remove("updatedAt");
    let config: DefaultsConfig = serde_json::from_value(config).map_err(invalid)?;
    config.validate()?;
    conn.execute("INSERT INTO wechat_publication_defaults(id,config,version,updated_at) VALUES('default',?1,1,?2)
        ON CONFLICT(id) DO UPDATE SET config=excluded.config,version=wechat_publication_defaults.version+1,updated_at=excluded.updated_at",
        params![serde_json::to_string(&config).expect("defaults serialize"), payload["updatedAt"].as_i64().unwrap_or_else(now)])?;
    Ok(())
}

impl Workspace {
    pub fn wechat_defaults(&self) -> Result<Defaults> {
        self.read_running(defaults)
    }

    pub fn save_wechat_defaults(
        &self,
        expected_version: i64,
        config: DefaultsConfig,
    ) -> Result<Defaults> {
        config.validate()?;
        self.write(|tx| {
            let current = defaults(tx)?;
            if current.version != expected_version {
                return Err(AppError::conflict(current.version));
            }
            apply_defaults(
                tx,
                "default",
                &json!({ "schemaVersion": config.schema_version,
                "recommendationCount": config.recommendation_count,
                "recommendationAuthors": config.recommendation_authors, "updatedAt": now() }),
            )?;
            defaults(tx)
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub entry_id: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub content_md: String,
    pub category_id: Option<String>,
    pub status: String,
    pub published_at: Option<i64>,
    pub count: u32,
    #[serde(default)]
    pub authors: Vec<String>,
}

impl Input {
    pub fn fingerprint(&self) -> String {
        let input = json!([
            1,
            self.title,
            self.summary,
            self.tags,
            self.content_md,
            self.category_id,
            self.status,
            self.published_at,
            self.count,
            self.authors
        ]);
        hex::encode(Sha256::digest(input.to_string().as_bytes()))
    }

    fn cutoff(&self) -> i64 {
        if self.status == "published" {
            self.published_at.unwrap_or_else(now).min(now())
        } else {
            now()
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    #[serde(flatten)]
    pub article: Recommendation,
    pub summary: String,
    pub tags: Vec<String>,
    pub published_at: Option<i64>,
    #[serde(skip)]
    category_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatePage {
    pub items: Vec<Candidate>,
    pub next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationResult {
    pub input_fingerprint: String,
    pub items: Vec<Recommendation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidItem {
    entry_id: String,
    message: String,
}

#[derive(Serialize)]
pub struct Resolved {
    pub items: Vec<Recommendation>,
    pub invalid: Vec<InvalidItem>,
}

fn candidates(conn: &Connection, input: &Input, filter_authors: bool) -> Result<Vec<Candidate>> {
    if input.count == 0 {
        return Err(AppError::invalid("推荐数量必须大于 0"));
    }
    let mut query = conn.prepare("SELECT e.id,e.title,e.summary,e.category_id,e.published_at,e.published_url,e.publication_platforms,
        COALESCE((SELECT json_group_array(t.name) FROM tags t JOIN entry_tags r ON r.tag_id=t.id WHERE r.entry_id=e.id),'[]')
        FROM entries e WHERE e.kind='article' AND e.status='published' AND e.deleted_at IS NULL AND e.purged_at IS NULL
        AND e.id<>?1 AND (e.published_at IS NULL OR e.published_at<=?2)
        AND (?3 OR e.id IN (SELECT entry_id FROM wechat_author_entries WHERE author IN (SELECT value FROM json_each(?4))))
        ORDER BY e.published_at DESC,e.id")?;
    let rows = query.query_map(params![input.entry_id, input.cutoff(), !filter_authors || input.authors.is_empty(),
        serde_json::to_string(&input.authors).expect("authors serialize")], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (entry_id, title, summary, category_id, published_at, legacy, platforms, tags) = row?;
        let platforms: Vec<super::PublicationPlatform> =
            serde_json::from_str(&platforms).map_err(invalid)?;
        let wechat = platforms
            .iter()
            .find(|platform| platform.platform.trim() == "微信公众号");
        let url = wechat
            .map_or(legacy.as_str(), |platform| platform.url.as_str())
            .trim();
        if title.trim().is_empty() || article_url(url).is_none() {
            continue;
        }
        result.push(Candidate {
            article: Recommendation {
                entry_id,
                title,
                url: url.into(),
            },
            summary,
            tags: serde_json::from_str(&tags).map_err(invalid)?,
            published_at,
            category_id,
        });
    }
    Ok(result)
}

fn terms(text: &str) -> HashSet<String> {
    const STOP: &[&str] = &[
        "ai",
        "的",
        "是",
        "我们",
        "一个",
        "可以",
        "如何",
        "什么",
        "这个",
        "那个",
        "文章",
        "公众号",
        "方法",
        "使用",
        "教程",
        "工具",
        "分享",
        "自己",
        "这些",
        "进行",
        "内容",
    ];
    let mut result = HashSet::new();
    let text = text.to_lowercase();
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        if word.is_ascii() {
            if word.len() >= 2 && !STOP.contains(&word) {
                result.insert(word.into());
            }
        } else {
            let chars = word.chars().collect::<Vec<_>>();
            for length in [2, 3] {
                for part in chars.windows(length) {
                    let term = part.iter().collect::<String>();
                    if !STOP.contains(&term.as_str()) {
                        result.insert(term);
                    }
                }
            }
        }
    }
    result
}

fn rank(conn: &Connection, input: &Input, pool: Vec<Candidate>) -> Result<Vec<Candidate>> {
    let linked = Parser::new(&input.content_md)
        .filter_map(|event| match event {
            Event::Start(pulldown_cmark::Tag::Link { dest_url, .. }) => article_url(&dest_url),
            _ => None,
        })
        .collect::<HashSet<_>>();
    let mut identities = HashSet::new();
    let pool = pool
        .into_iter()
        .filter(|candidate| {
            let canonical = article_url(&candidate.article.url).expect("candidate link checked");
            !linked.contains(&canonical) && identities.insert(canonical)
        })
        .collect::<Vec<_>>();
    let corpus_size = pool.len() as f64;
    let mut weights = BTreeMap::<String, f64>::new();
    let body = Parser::new(&input.content_md)
        .filter_map(|event| match event {
            Event::Text(text) => Some(text.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    for (text, weight) in [(&input.title, 5.0), (&input.summary, 2.0), (&body, 0.5)] {
        for term in terms(&text.chars().take(12000).collect::<String>()) {
            *weights.entry(term).or_default() += weight;
        }
    }
    let topic_terms = weights.keys().cloned().collect::<HashSet<_>>();
    for tag in &input.tags {
        for term in terms(tag) {
            *weights.entry(term).or_default() += 6.0;
        }
    }
    let mut features = weights.into_iter().collect::<Vec<_>>();
    features.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    features.truncate(48);
    if features.is_empty() {
        return Ok(vec![]);
    }
    let documents = pool
        .iter()
        .map(|candidate| {
            terms(&format!(
                "{} {} {}",
                candidate.article.title,
                candidate.summary,
                candidate.tags.join(" ")
            ))
        })
        .collect::<Vec<_>>();
    let frequencies = features
        .iter()
        .map(|(term, _)| {
            documents
                .iter()
                .filter(|document| document.contains(term))
                .count()
        })
        .collect::<Vec<_>>();
    let fts_query = features
        .iter()
        .filter(|(term, _)| term.chars().count() >= 3 && topic_terms.contains(term))
        .map(|(term, _)| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut body_rank = HashMap::new();
    if !fts_query.is_empty() {
        let eligible = serde_json::to_string(
            &pool
                .iter()
                .map(|item| &item.article.entry_id)
                .collect::<Vec<_>>(),
        )
        .expect("candidate IDs serialize");
        let mut fts = conn.prepare("SELECT e.id FROM entries_fts JOIN entries e ON e.rowid=entries_fts.rowid
            WHERE entries_fts MATCH ?1 AND e.kind='article' AND e.status='published' AND e.deleted_at IS NULL
            AND e.id<>?2 AND (e.published_at IS NULL OR e.published_at<=?3)
            AND e.id IN (SELECT value FROM json_each(?5))
            ORDER BY bm25(entries_fts,5.0,1.0),e.id LIMIT ?4")?;
        for (index, id) in fts
            .query_map(
                params![
                    fts_query,
                    input.entry_id,
                    input.cutoff(),
                    i64::from(input.count).saturating_mul(10).max(50),
                    eligible,
                ],
                |row| row.get::<_, String>(0),
            )?
            .enumerate()
        {
            body_rank.insert(id?, 0.15 / (1.0 + index as f64 / 10.0));
        }
    }
    let mut scored = Vec::new();
    for (candidate, document) in pool.into_iter().zip(documents) {
        let candidate_topic = terms(&format!(
            "{} {}",
            candidate.article.title, candidate.summary
        ));
        if topic_terms.is_disjoint(&candidate_topic)
            && !body_rank.contains_key(&candidate.article.entry_id)
        {
            continue;
        }
        let mut matched = 0.0;
        let mut total = 0.0;
        for ((term, weight), frequency) in features.iter().zip(&frequencies) {
            let weight = weight * (1.0 + (corpus_size + 2.0) / (*frequency as f64 + 1.0)).ln();
            total += weight;
            if document.contains(term) {
                matched += weight;
            }
        }
        let mut score = matched / total.max(1.0)
            + body_rank
                .get(&candidate.article.entry_id)
                .copied()
                .unwrap_or(0.0);
        if score < 0.1 {
            continue;
        }
        if input.category_id.is_some() && candidate.category_id == input.category_id {
            score += 0.01;
        }
        scored.push((score, candidate));
    }
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.published_at.cmp(&a.1.published_at))
            .then_with(|| a.1.article.entry_id.cmp(&b.1.article.entry_id))
    });
    let mut urls = HashSet::new();
    Ok(scored
        .into_iter()
        .map(|(_, candidate)| candidate)
        .filter(|candidate| {
            urls.insert(article_url(&candidate.article.url).expect("candidate link checked"))
        })
        .collect())
}

impl Workspace {
    pub fn wechat_authors(&self) -> Result<Vec<String>> {
        self.read_running(|conn| {
            let mut query = conn.prepare("SELECT author FROM wechat_author_options ORDER BY author")?;
            Ok(query.query_map([], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?)
        })
    }

    pub fn wechat_recommend(&self, input: &Input) -> Result<RecommendationResult> {
        self.read_running(|conn| {
            Ok(RecommendationResult {
                input_fingerprint: input.fingerprint(),
                items: rank(conn, input, candidates(conn, input, true)?)?
                    .into_iter()
                    .take(input.count as usize)
                    .map(|candidate| candidate.article)
                    .collect(),
            })
        })
    }

    pub fn wechat_candidates(
        &self,
        input: &Input,
        query: &str,
        related: bool,
        offset: usize,
    ) -> Result<CandidatePage> {
        self.read_running(|conn| {
            let mut pool = candidates(conn, input, true)?;
            if related {
                pool = rank(conn, input, pool)?;
            }
            let words = query
                .to_lowercase()
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let mut urls = HashSet::new();
            let matches = pool
                .into_iter()
                .filter(|candidate| {
                    let text = format!(
                        "{} {} {}",
                        candidate.article.title,
                        candidate.summary,
                        candidate.tags.join(" ")
                    )
                    .to_lowercase();
                    words.iter().all(|word| text.contains(word))
                        && urls.insert(
                            article_url(&candidate.article.url).expect("candidate link checked"),
                        )
                })
                .skip(offset)
                .take(61)
                .collect::<Vec<_>>();
            let next_offset = (matches.len() > 60).then_some(offset + 60);
            Ok(CandidatePage {
                items: matches.into_iter().take(60).collect(),
                next_offset,
            })
        })
    }

    pub fn wechat_resolve(&self, input: &Input, items: &[Recommendation]) -> Result<Resolved> {
        self.read_running(|conn| {
            let pool = candidates(conn, input, false)?
                .into_iter()
                .map(|candidate| (candidate.article.entry_id.clone(), candidate.article))
                .collect::<HashMap<_, _>>();
            let mut resolved = Resolved {
                items: vec![],
                invalid: vec![],
            };
            let mut urls = HashSet::new();
            for item in items {
                match pool.get(&item.entry_id) {
                    Some(current)
                        if urls
                            .insert(article_url(&current.url).expect("candidate link checked")) =>
                    {
                        resolved.items.push(current.clone())
                    }
                    Some(_) => resolved.invalid.push(InvalidItem {
                        entry_id: item.entry_id.clone(),
                        message: "微信发布链接与另一条推荐重复".into(),
                    }),
                    None => resolved.invalid.push(InvalidItem {
                        entry_id: item.entry_id.clone(),
                        message: "文章已删除、尚未发布或缺少有效的微信发布链接".into(),
                    }),
                }
            }
            Ok(resolved)
        })
    }
}

fn invalid(error: serde_json::Error) -> AppError {
    AppError::new("INVALID_INPUT", format!("公众号配置无效：{error}"))
}
