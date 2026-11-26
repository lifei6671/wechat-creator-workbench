use super::{Finding, ReviewResult, Summary, TextRange};
use crate::db::{AppError, Result};
use reqwest::{Client, StatusCode, header::HeaderValue};
use serde::Deserialize;

pub(super) const ENDPOINT: &str =
    "https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify";
// A local resource limit, not a documented vendor maximum. Do not split inference requests.
pub(super) const MAX_TEXT_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
struct Envelope {
    status: String,
}

#[derive(Deserialize)]
struct Response {
    labels_ratio: Ratios,
    ratio_confidence: f64,
    softmax_confidence: f64,
    segment_labels: Vec<Segment>,
    makers_models_usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Ratios {
    #[serde(rename = "0")]
    human: f64,
    #[serde(rename = "1")]
    ai: f64,
    #[serde(rename = "2")]
    suspected: f64,
}

#[derive(Deserialize)]
struct Segment {
    text: String,
    label: u8,
    conf: f64,
    // Live Makers probes: Unicode scalar start + length, not an end offset.
    position: Option<[usize; 2]>,
}

#[derive(Deserialize)]
struct Usage {
    total_tokens: u64,
}

pub(super) fn validate_input(text: &str, version: u32) -> Result<()> {
    if text.trim().is_empty() {
        return Err(AppError::invalid("没有可检测的正文"));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(AppError::invalid(
            "超过本机单次检测的 128 KiB 文本上限，请选择部分正文",
        ));
    }
    if version != 1 {
        return Err(AppError::invalid("不支持的正文投影版本"));
    }
    Ok(())
}

pub(super) async fn classify(
    client: &Client,
    endpoint: &str,
    authorization: HeaderValue,
    text: &str,
    version: u32,
    hash: String,
) -> Result<ReviewResult> {
    let mut response = client
        .post(endpoint)
        .header(reqwest::header::AUTHORIZATION, authorization)
        .json(&serde_json::json!({ "text": text, "is_merge": false }))
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    if !status.is_success() {
        let (code, message) = match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                ("REVIEW_AUTH", "朱雀凭据无效或没有调用权限，请检查 API Key")
            }
            StatusCode::TOO_MANY_REQUESTS => ("REVIEW_QUOTA", "朱雀请求受限，请稍后重试或检查额度"),
            status if status.is_server_error() => (
                "REVIEW_REMOTE",
                "朱雀服务暂时不可用，本次是否扣减额度尚不确定",
            ),
            _ => (
                "REVIEW_HTTP",
                "朱雀未接受本次请求，请检查检测范围或服务配置",
            ),
        };
        return Err(AppError::new(code, format!("{message}（HTTP {status}）")));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(invalid_response());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse(&bytes, text, version, hash)
}

fn network_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new(
            "REVIEW_TIMEOUT",
            "朱雀请求超时，本次是否扣减额度尚不确定；未自动重试",
        )
    } else {
        AppError::new(
            "REVIEW_NETWORK",
            "无法完成朱雀请求，本次是否扣减额度尚不确定；未自动重试",
        )
    }
}

fn invalid_response() -> AppError {
    AppError::new(
        "REVIEW_RESPONSE",
        "朱雀响应不符合已知接口契约，请稍后重新检测",
    )
}

fn ratio(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

// This fallback does not infer the vendor's offset unit, normalize text, or disambiguate repeats.
fn unique_range(text: &str, fragment: &str) -> Option<TextRange> {
    if fragment.is_empty() {
        return None;
    }
    let from = text.find(fragment)?;
    if text[from + text[from..].chars().next()?.len_utf8()..].contains(fragment) {
        return None;
    }
    Some(TextRange {
        from: text[..from].encode_utf16().count(),
        to: text[..from + fragment.len()].encode_utf16().count(),
    })
}

pub(super) fn parse(bytes: &[u8], text: &str, version: u32, hash: String) -> Result<ReviewResult> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| invalid_response())?;
    if envelope.status != "success" {
        return Err(AppError::new(
            "REVIEW_REJECTED",
            "朱雀未完成本次检测，请检查检测范围或服务额度",
        ));
    }
    let response: Response = serde_json::from_slice(bytes).map_err(|_| invalid_response())?;
    if ![
        response.labels_ratio.human,
        response.labels_ratio.ai,
        response.labels_ratio.suspected,
        response.ratio_confidence,
        response.softmax_confidence,
    ]
    .into_iter()
    .all(ratio)
        || response
            .makers_models_usage
            .as_ref()
            .is_some_and(|usage| usage.total_tokens > i64::MAX as u64)
    {
        return Err(invalid_response());
    }
    let mut findings = Vec::new();
    let mut positions = Vec::new();
    let mut utf16 = 0;
    for (byte, scalar) in text.char_indices() {
        positions.push((byte, utf16));
        utf16 += scalar.len_utf16();
    }
    positions.push((text.len(), utf16));
    for (index, segment) in response.segment_labels.into_iter().enumerate() {
        if segment.label > 2 || !ratio(segment.conf) {
            return Err(invalid_response());
        }
        if segment.label == 0 {
            continue;
        }
        findings.push(Finding {
            id: format!("zhuque-{index}"),
            category: if segment.label == 1 {
                "ai_generated"
            } else {
                "ai_suspected"
            }
            .into(),
            range: segment
                .position
                .and_then(|[start, length]| {
                    let end = start.checked_add(length)?;
                    let &(from, utf16_from) = positions.get(start)?;
                    let &(to, utf16_to) = positions.get(end)?;
                    (length > 0 && text[from..to] == segment.text).then_some(TextRange {
                        from: utf16_from,
                        to: utf16_to,
                    })
                })
                .or_else(|| unique_range(text, &segment.text)),
            confidence: segment.conf,
        });
    }
    Ok(ReviewResult {
        checker_id: "zhuque_text".into(),
        content_hash: hash,
        projection_version: version,
        checked_at: crate::db::now(),
        cache_hit: false,
        cached: false,
        persistence_error: None,
        settings_revision: 0,
        charged_tokens: response.makers_models_usage.map(|usage| usage.total_tokens),
        summary: Summary {
            human_ratio: response.labels_ratio.human,
            ai_ratio: response.labels_ratio.ai,
            suspected_ratio: response.labels_ratio.suspected,
            ratio_confidence: response.ratio_confidence,
            softmax_confidence: response.softmax_confidence,
        },
        findings,
    })
}
