use super::{
    AiResult, MAX_RESPONSE_BYTES, Operation, ProviderUsage, Usage, network,
    parse_provider_response, parse_result, read_json, response_error,
};
use crate::db::{AppError, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sse_stream::SseStream;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChatEvent {
    Started,
    Delta { text: String },
}

#[derive(Deserialize)]
struct Chunk {
    choices: Vec<Choice>,
    usage: Option<ProviderUsage>,
}

#[derive(Deserialize)]
struct Choice {
    index: usize,
    delta: Delta,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Delta {
    content: Option<String>,
}

pub(super) async fn read(
    response: reqwest::Response,
    emit: &mut (impl FnMut(ChatEvent) + Send),
) -> Result<(Result<AiResult>, Usage)> {
    // Some compatible endpoints return a complete JSON answer even when asked to stream.
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .is_some_and(|header| {
            header
                .split(';')
                .next()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    if !is_sse {
        return Ok(parse_provider_response(
            Operation::Chat,
            read_json(response).await?,
        ));
    }
    let mut bytes = 0;
    let events = SseStream::from_bytes_stream(response.bytes_stream().map(|chunk| {
        let chunk = chunk.map_err(network)?;
        bytes += chunk.len();
        if bytes > MAX_RESPONSE_BYTES {
            return Err(response_error());
        }
        Ok(chunk)
    }));
    futures_util::pin_mut!(events);
    let mut reply = String::new();
    let mut usage = Usage::default();
    let mut finished = false;
    while let Some(event) = events.next().await {
        let event = match event {
            Ok(event) => event,
            Err(sse_stream::Error::Body(error)) => {
                return Ok((
                    Err(error
                        .downcast::<AppError>()
                        .map_or_else(|_| response_error(), |error| *error)),
                    usage,
                ));
            }
            Err(_) => return Ok((Err(response_error()), usage)),
        };
        let Some(data) = event.data else {
            continue;
        };
        if data == "[DONE]" {
            finished = true;
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Chunk>(&data) else {
            return Ok((Err(response_error()), usage));
        };
        if let Some(total) = chunk.usage {
            usage = total.into();
        }
        if let Some(choice) = chunk.choices.into_iter().find(|choice| choice.index == 0) {
            if let Some(text) = choice.delta.content.filter(|text| !text.is_empty()) {
                reply.push_str(&text);
                emit(ChatEvent::Delta { text });
            }
            finished |= choice.finish_reason.is_some();
        }
    }
    Ok((
        if finished {
            parse_result(Operation::Chat, &reply)
        } else {
            Err(response_error())
        },
        usage,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, Bytes},
        http::Response,
        routing::get,
    };
    use std::convert::Infallible;

    #[tokio::test]
    async fn fragmented_utf8_sse_yields_deltas_and_records_usage() {
        let first = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}\r\n\r\n";
        let split = first.find('你').unwrap() + 1;
        let rest = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"，世界\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":6,\"completion_tokens\":4,\"total_tokens\":10}}\n\n",
            "data: [DONE]\n\n",
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/",
                    get(move || async move {
                        let chunks = [
                            &first.as_bytes()[..split],
                            &first.as_bytes()[split..],
                            rest.as_bytes(),
                        ];
                        Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(Body::from_stream(futures_util::stream::iter(
                                chunks.map(|bytes| Ok::<_, Infallible>(Bytes::from_static(bytes))),
                            )))
                            .unwrap()
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(endpoint)
            .send()
            .await
            .unwrap();
        let mut deltas = Vec::new();
        let (result, usage) = read(response, &mut |event| {
            if let ChatEvent::Delta { text } = event {
                deltas.push(text);
            }
        })
        .await
        .unwrap();
        server.abort();
        assert_eq!(deltas, ["你好", "，世界"]);
        assert_eq!(usage.total_tokens, Some(10));
        assert!(matches!(result.unwrap(), AiResult::Chat(result) if result.reply == "你好，世界"));
    }
}
