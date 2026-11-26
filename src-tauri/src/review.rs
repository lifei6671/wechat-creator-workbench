mod cache;
pub mod settings;
#[cfg(test)]
mod tests;
mod zhuque;

use crate::db::{AppError, Result, Workspace, now, workspace_id};
use reqwest::{Client, header::HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::State;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TextRange {
    from: usize,
    to: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    id: String,
    category: String,
    range: Option<TextRange>,
    confidence: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    human_ratio: f64,
    ai_ratio: f64,
    suspected_ratio: f64,
    ratio_confidence: f64,
    softmax_confidence: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    checker_id: String,
    content_hash: String,
    projection_version: u32,
    checked_at: i64,
    cache_hit: bool,
    charged_tokens: Option<u64>,
    summary: Summary,
    findings: Vec<Finding>,
    cached: bool,
    persistence_error: Option<String>,
    settings_revision: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewScope {
    Document,
    Selection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewContext {
    entry_id: String,
    title: String,
    scope: ReviewScope,
}

pub struct ReviewService {
    client: Client,
    root: PathBuf,
    endpoint: String,
    // Reject overlapping inference rather than queueing hidden quota-consuming POSTs.
    request: tokio::sync::Mutex<()>,
    configuration: Mutex<()>,
    revision: AtomicU64,
}

struct CheckInput<'a> {
    text: &'a str,
    version: u32,
    force: bool,
    connection_test: bool,
    context: Option<&'a ReviewContext>,
}

impl ReviewService {
    pub fn new(root: PathBuf) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|_| AppError::new("REVIEW_CONFIG", "无法创建审查服务网络连接"))?,
            root,
            endpoint: zhuque::ENDPOINT.into(),
            request: tokio::sync::Mutex::new(()),
            configuration: Mutex::new(()),
            revision: AtomicU64::new(0),
        })
    }

    fn directory(&self, workspace: &str) -> PathBuf {
        self.root
            .join(hex::encode(Sha256::digest(workspace.as_bytes())))
    }

    async fn check(
        &self,
        db: &Workspace,
        checker: &str,
        input: CheckInput<'_>,
        api_key: Option<&str>,
    ) -> Result<ReviewResult> {
        if checker != "zhuque_text" {
            return Err(AppError::invalid("不支持的审查项目"));
        }
        zhuque::validate_input(input.text, input.version)?;
        let _request = self
            .request
            .try_lock()
            .map_err(|_| AppError::new("REVIEW_BUSY", "已有审查请求正在执行"))?;
        let (workspace, revision, authorization) = {
            let _configuration = self
                .configuration
                .lock()
                .expect("review configuration lock poisoned");
            if !input.connection_test && !settings::load(db)?.enabled {
                return Err(AppError::new("REVIEW_DISABLED", "请先启用朱雀文本检测"));
            }
            (
                db.read_running(workspace_id)?,
                self.revision.load(Ordering::SeqCst),
                match api_key.map(str::trim).filter(|key| !key.is_empty()) {
                    Some(key) => settings::authorization(key)?,
                    None => settings::credential(db)?,
                },
            )
        };
        self.perform(&workspace, revision, authorization, input)
            .await
    }

    async fn perform(
        &self,
        workspace: &str,
        revision: u64,
        authorization: HeaderValue,
        input: CheckInput<'_>,
    ) -> Result<ReviewResult> {
        let CheckInput {
            text,
            version,
            force,
            connection_test,
            context,
        } = input;
        let directory = self.directory(workspace);
        // A captured directory owns this request's result even if the active workspace changes.
        let mut store = cache::open(&directory)?;
        let hash = hex::encode(Sha256::digest(text.as_bytes()));
        let key = cache_key(text, version);
        if !force
            && !connection_test
            && let Some(mut result) = cache::lookup(&mut store, &key, now(), context)?
        {
            result.settings_revision = revision;
            return Ok(result);
        }
        drop(store);
        let mut result = zhuque::classify(
            &self.client,
            &self.endpoint,
            authorization,
            text,
            version,
            hash,
        )
        .await?;
        result.settings_revision = revision;
        // Inference succeeded: persistence errors must not cause an automatic second paid call.
        let saved = cache::open(&directory).and_then(|mut store| {
            cache::save(
                &mut store,
                (!connection_test).then_some(key.as_str()),
                &result,
                context,
            )
        });
        match saved {
            Ok(()) => result.cached = !connection_test,
            Err(_) => result.persistence_error = Some(cache::storage_error().to_string()),
        }
        Ok(result)
    }
}

fn cache_key(text: &str, version: u32) -> String {
    let identity = serde_json::to_vec(&(
        "zhuque_text",
        "@makers/zhuque-text",
        2_u32,
        version,
        false,
        text,
    ))
    .expect("review cache identity serializes");
    hex::encode(Sha256::digest(identity))
}

#[tauri::command]
pub async fn review_check(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
    checker_id: String,
    text: String,
    projection_version: u32,
    force: bool,
    context: Option<ReviewContext>,
) -> Result<ReviewResult> {
    service
        .check(
            &db,
            &checker_id,
            CheckInput {
                text: &text,
                version: projection_version,
                force,
                connection_test: false,
                context: context.as_ref(),
            },
            None,
        )
        .await
}

#[tauri::command]
pub async fn review_test_connection(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
    api_key: Option<String>,
) -> Result<ReviewResult> {
    const SAMPLE: &str = "这是用于验证文本分类接口的合成测试段落，不包含个人文章或其他私人信息。清晨的图书馆逐渐热闹起来，管理员整理书架，读者安静地翻阅书籍。\n\n这也是合成内容。雨后的街道映着灯光，一辆公交车停在路边，乘客依次上车。";
    service
        .check(
            &db,
            "zhuque_text",
            CheckInput {
                text: SAMPLE,
                version: 1,
                force: true,
                connection_test: true,
                context: None,
            },
            api_key.as_deref(),
        )
        .await
}

#[tauri::command]
pub fn review_usage(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
) -> Result<cache::Usage> {
    let directory = service.directory(&db.read_running(workspace_id)?);
    cache::usage(&cache::open(&directory)?, now())
}

#[tauri::command]
pub fn review_cache_list(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
    entry_id: String,
) -> Result<Vec<cache::CacheEntry>> {
    let directory = service.directory(&db.read_running(workspace_id)?);
    cache::list(&cache::open(&directory)?, &entry_id, now())
}

#[tauri::command]
pub fn review_cache_delete(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
    entry_id: String,
    id: String,
) -> Result<()> {
    let _request = service
        .request
        .try_lock()
        .map_err(|_| AppError::new("REVIEW_BUSY", "检测进行中，请稍后删除记录"))?;
    let directory = service.directory(&db.read_running(workspace_id)?);
    cache::delete(&mut cache::open(&directory)?, &entry_id, Some(&id))
}

#[tauri::command]
pub fn review_clear_cache(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
    entry_id: Option<String>,
) -> Result<()> {
    let _request = service
        .request
        .try_lock()
        .map_err(|_| AppError::new("REVIEW_BUSY", "检测进行中，请稍后清理缓存"))?;
    let directory = service.directory(&db.read_running(workspace_id)?);
    cache::clear(&mut cache::open(&directory)?, entry_id.as_deref())
}
