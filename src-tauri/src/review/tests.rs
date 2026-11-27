use super::*;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn response(fragment: &str, label: u8) -> Value {
    json!({"status":"success","labels_ratio":{"0":0.2,"1":0.5,"2":0.3},
        "ratio_confidence":0.8,"softmax_confidence":0.9,
        "segment_labels":[{"text":fragment,"label":label,"conf":0.8,"order":1,"position":[0,1]}],
        "makers_models_usage":{"total_tokens":30},"usage":{"total_tokens":999}})
}

fn parse(value: &Value, text: &str) -> Result<ReviewResult> {
    zhuque::parse(&serde_json::to_vec(value).unwrap(), text, 1, "hash".into())
}

fn input(text: &str, force: bool) -> CheckInput<'_> {
    CheckInput {
        text,
        version: 1,
        force,
        connection_test: false,
        context: None,
    }
}

#[test]
fn legacy_cache_migrates_without_guessing_article_ownership() {
    for version in [0, 1] {
        let root = tempfile::tempdir().unwrap();
        let legacy = rusqlite::Connection::open(root.path().join("review-cache.sqlite3")).unwrap();
        legacy.execute_batch("CREATE TABLE review_cache(cache_key TEXT PRIMARY KEY,result_json TEXT NOT NULL,checked_at INTEGER NOT NULL);").unwrap();
        if version == 1 {
            legacy.execute_batch("ALTER TABLE review_cache ADD COLUMN title TEXT NOT NULL DEFAULT ''; ALTER TABLE review_cache ADD COLUMN scope TEXT; PRAGMA user_version=1;").unwrap();
        }
        let result = parse(&response("不保存的原文", 1), "不保存的原文").unwrap();
        legacy
            .execute(
                "INSERT INTO review_cache(cache_key,result_json,checked_at) VALUES('legacy',?1,?2)",
                rusqlite::params![serde_json::to_string(&result).unwrap(), result.checked_at],
            )
            .unwrap();
        drop(legacy);
        let mut conn = cache::open(root.path()).unwrap();
        assert!(cache::list(&conn, "article-a", now()).unwrap().is_empty());
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        let context = ReviewContext {
            entry_id: "article-a".into(),
            title: "文章标题".into(),
            scope: ReviewScope::Selection,
        };
        let cached = cache::lookup(&mut conn, "legacy", now(), Some(&context))
            .unwrap()
            .unwrap();
        assert!(cached.cache_hit);
        assert_eq!(cached.charged_tokens, Some(0));
        let entries =
            serde_json::to_value(cache::list(&conn, "article-a", now()).unwrap()).unwrap();
        assert_eq!(entries[0]["title"], "文章标题");
        assert_eq!(entries[0]["scope"], "selection");
        assert!(!entries.to_string().contains("不保存的原文"));
        assert!(entries[0].get("findings").is_none());
        assert!(cache::list(&conn, "article-b", now()).unwrap().is_empty());
        drop(conn);
        assert_eq!(
            cache::list(&cache::open(root.path()).unwrap(), "article-a", now())
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn shared_cache_keeps_article_records_and_deletion_scopes_independent() {
    let root = tempfile::tempdir().unwrap();
    let mut conn = cache::open(&root.path().join("workspace-a")).unwrap();
    let result = parse(&response("不保存的原文", 1), "不保存的原文").unwrap();
    let a = ReviewContext {
        entry_id: "article-a".into(),
        title: "同名文章".into(),
        scope: ReviewScope::Document,
    };
    let b = ReviewContext {
        entry_id: "article-b".into(),
        title: "同名文章".into(),
        scope: ReviewScope::Selection,
    };
    cache::save(&mut conn, Some("shared"), &result, Some(&a)).unwrap();
    cache::lookup(&mut conn, "shared", now(), Some(&b))
        .unwrap()
        .unwrap();
    let records_a = serde_json::to_value(cache::list(&conn, "article-a", now()).unwrap()).unwrap();
    let records_b = serde_json::to_value(cache::list(&conn, "article-b", now()).unwrap()).unwrap();
    assert_eq!(records_a[0]["scope"], "document");
    assert_eq!(records_b[0]["scope"], "selection");
    assert!(cache::list(&conn, "article-c", now()).unwrap().is_empty());
    cache::save(&mut conn, Some("only-a"), &result, Some(&a)).unwrap();
    cache::save(&mut conn, Some("only-b"), &result, Some(&b)).unwrap();
    let before = serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap();
    cache::delete(&mut conn, "article-a", Some("only-b")).unwrap();
    assert_eq!(cache::list(&conn, "article-b", now()).unwrap().len(), 2);
    cache::delete(&mut conn, "article-a", Some("shared")).unwrap();
    assert_eq!(cache::list(&conn, "article-a", now()).unwrap().len(), 1);
    assert_eq!(cache::list(&conn, "article-b", now()).unwrap().len(), 2);
    cache::clear(&mut conn, Some("article-a")).unwrap();
    assert!(cache::list(&conn, "article-a", now()).unwrap().is_empty());
    assert_eq!(cache::list(&conn, "article-b", now()).unwrap().len(), 2);
    assert!(
        cache::lookup(&mut conn, "only-a", now(), None)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap(),
        before
    );
    let mut other = cache::open(&root.path().join("workspace-b")).unwrap();
    cache::save(&mut other, Some("shared"), &result, Some(&a)).unwrap();
    cache::clear(&mut conn, None).unwrap();
    assert!(cache::list(&conn, "article-b", now()).unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap(),
        before
    );
    assert_eq!(cache::list(&other, "article-a", now()).unwrap().len(), 1);
    assert!(
        cache::list(&other, "article-a", now() + 31 * 24 * 60 * 60 * 1000)
            .unwrap()
            .is_empty()
    );
    let associations: i64 = other
        .query_row("SELECT count(*) FROM review_cache_articles", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(associations, 0);
}

async fn mock(
    status: u16,
    body: String,
    delay: Duration,
) -> (String, tokio::task::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/classify", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut calls = 0;
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_millis(250), listener.accept()).await
        {
            let mut bytes = Vec::new();
            let (header_end, content_length) = loop {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]).to_ascii_lowercase();
                    assert!(headers.contains("authorization: bearer synthetic-test-key"));
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    break (index + 4, length);
                }
            };
            while bytes.len() < header_end + content_length {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            let body_sent: Value =
                serde_json::from_slice(&bytes[header_end..header_end + content_length]).unwrap();
            assert_eq!(body_sent["is_merge"], false);
            assert!(body_sent["text"].is_string());
            calls += 1;
            tokio::time::sleep(delay).await;
            let output = format!(
                "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:1/private\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(output.as_bytes()).await;
        }
        calls
    });
    (endpoint, server)
}

fn auth() -> HeaderValue {
    settings::authorization("synthetic-test-key").unwrap()
}

#[test]
fn official_fixture_and_unknown_usage_keep_vendor_contracts() {
    let result = zhuque::parse(
        include_bytes!("fixtures/official-success.json"),
        "hello world",
        1,
        "hash".into(),
    )
    .unwrap();
    assert_eq!(result.charged_tokens, Some(30));
    assert!(result.findings.is_empty());
    assert_eq!(result.summary.human_ratio, 1.0);
    let mut value = response("synthetic", 2);
    value.as_object_mut().unwrap().remove("makers_models_usage");
    value["extra"] = json!({"future":true});
    let result = parse(&value, "synthetic").unwrap();
    assert_eq!(result.charged_tokens, None);
    assert_eq!(result.findings[0].category, "ai_suspected");
}

#[test]
fn live_unicode_fixture_and_repeated_segments_use_scalar_start_plus_length() {
    let fixture: Value =
        serde_json::from_slice(include_bytes!("fixtures/live-unicode.json")).unwrap();
    let text = fixture["text"].as_str().unwrap();
    let result = parse(&fixture["response"], text).unwrap();
    let original = fixture["response"]["segment_labels"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|segment| segment["label"] != 0);
    assert_eq!(result.findings.len(), original.clone().count());
    assert!(result.findings.len() > 2);
    for (finding, segment) in result.findings.iter().zip(original) {
        let range = finding
            .range
            .as_ref()
            .expect("live Unicode segments must locate");
        let slice: Vec<u16> = text
            .encode_utf16()
            .skip(range.from)
            .take(range.to - range.from)
            .collect();
        assert_eq!(
            String::from_utf16(&slice).unwrap(),
            segment["text"].as_str().unwrap()
        );
    }
    let text = "重复😀\n\n重复😀";
    let mut value = response("重复😀", 1);
    value["segment_labels"] = json!([
        {"text":"重复😀","label":1,"conf":0.8,"position":[0,3]},
        {"text":"重复😀","label":1,"conf":0.8,"position":[5,3]}
    ]);
    let result = parse(&value, text).unwrap();
    assert_eq!(result.findings[0].range, Some(TextRange { from: 0, to: 4 }));
    assert_eq!(
        result.findings[1].range,
        Some(TextRange { from: 6, to: 10 })
    );
    value["segment_labels"][1]["position"] = json!([usize::MAX, 10]);
    assert_eq!(parse(&value, text).unwrap().findings[1].range, None);
}

#[test]
fn unverified_offsets_never_guess_and_unique_text_maps_to_utf16() {
    let text = "前😀e\u{301}\n\n唯一片段\r\n末尾";
    let result = parse(&response("唯一片段", 1), text).unwrap();
    let from = "前😀e\u{301}\n\n".encode_utf16().count();
    assert_eq!(
        result.findings[0].range,
        Some(TextRange { from, to: from + 4 })
    );
    for (text, fragment) in [
        ("重复\n\n重复", "重复"),
        ("aaa", "aa"),
        ("原文", "不存在"),
        ("原文", ""),
    ] {
        assert_eq!(
            parse(&response(fragment, 1), text).unwrap().findings[0].range,
            None
        );
    }
    // A matching substring does not require accepting contradictory vendor offsets.
    assert_eq!(
        parse(&response("😀", 1), "前😀后").unwrap().findings[0].range,
        Some(TextRange { from: 1, to: 3 })
    );
}

#[test]
fn invalid_payloads_and_inputs_are_explicit_errors_without_echoes() {
    for patch in [
        json!({"status":"failed","msg":"synthetic-test-key private text"}),
        json!({"labels_ratio":{"0":-0.2,"1":1.2,"2":0}}),
        json!({"segment_labels":[{"text":"private text","label":3,"conf":0.5}]}),
        json!({"makers_models_usage":{"total_tokens":-1}}),
        json!({"segment_labels":[{"text":"x","label":1,"conf":0.5,"position":[2]}]}),
    ] {
        let mut value = response("private text", 1);
        for (key, item) in patch.as_object().unwrap() {
            value[key] = item.clone();
        }
        let error = parse(&value, "private text").unwrap_err().to_string();
        assert!(!error.contains("private text"));
        assert!(!error.contains("synthetic-test-key"));
    }
    let mut value = response("x", 1);
    value.as_object_mut().unwrap().remove("ratio_confidence");
    assert!(parse(&value, "x").is_err());
    assert!(zhuque::validate_input(" \n", 1).is_err());
    assert!(zhuque::validate_input(&"中".repeat(50_000), 1).is_err());
    assert!(zhuque::validate_input("text", 2).is_err());
    assert!(settings::authorization("key\r\ninjected").is_err());
    assert!(format!("{:?}", auth()).contains("Sensitive"));
}

#[tokio::test]
async fn http_success_cache_force_scope_and_usage_are_integrated() {
    let root = tempfile::tempdir().unwrap();
    let (endpoint, server) = mock(200, response("合成文本", 1).to_string(), Duration::ZERO).await;
    let mut service = ReviewService::new(root.path().into()).unwrap();
    service.endpoint = endpoint;
    let context = ReviewContext {
        entry_id: "article-a".into(),
        title: "文章标题".into(),
        scope: ReviewScope::Selection,
    };
    let result = service
        .perform(
            "workspace-a",
            7,
            auth(),
            CheckInput {
                context: Some(&context),
                ..input("合成文本", false)
            },
        )
        .await
        .unwrap();
    assert_eq!(result.charged_tokens, Some(30));
    assert!(result.cached);
    assert!(!result.cache_hit);
    assert_eq!(result.settings_revision, 7);
    let store = cache::open(&service.directory("workspace-a")).unwrap();
    let records = serde_json::to_value(cache::list(&store, "article-a", now()).unwrap()).unwrap();
    assert_eq!(records[0]["title"], "文章标题");
    assert_eq!(records[0]["scope"], "selection");
    assert!(records[0].get("findings").is_none());
    assert!(records[0].get("contentHash").is_none());
    let second_article = ReviewContext {
        entry_id: "article-b".into(),
        title: "另一篇文章".into(),
        scope: ReviewScope::Document,
    };
    let cached = service
        .perform(
            "workspace-a",
            8,
            auth(),
            CheckInput {
                context: Some(&second_article),
                ..input("合成文本", false)
            },
        )
        .await
        .unwrap();
    assert!(cached.cache_hit);
    assert_eq!(cached.charged_tokens, Some(0));
    assert_eq!(cached.settings_revision, 8);
    assert_eq!(cache::list(&store, "article-a", now()).unwrap().len(), 1);
    let second_records =
        serde_json::to_value(cache::list(&store, "article-b", now()).unwrap()).unwrap();
    assert_eq!(second_records[0]["title"], "另一篇文章");
    assert_eq!(second_records[0]["scope"], "document");
    service
        .perform("workspace-a", 8, auth(), input("合成文本", true))
        .await
        .unwrap();
    service
        .perform("workspace-b", 8, auth(), input("合成文本", false))
        .await
        .unwrap();
    let mut conn = cache::open(&service.directory("workspace-a")).unwrap();
    let usage = serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap();
    assert_eq!(usage["knownTokens"], 60);
    assert_eq!(usage["successfulCalls"], 2);
    assert_eq!(usage["cacheHits"], 1);
    let json: String = conn
        .query_row("SELECT result_json FROM review_cache", [], |r| r.get(0))
        .unwrap();
    assert!(!json.contains("合成文本"));
    assert!(!json.contains("synthetic-test-key"));
    cache::clear(&mut conn, None).unwrap();
    assert_eq!(
        serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap()["knownTokens"],
        60
    );
    assert_eq!(server.await.unwrap(), 3);
}

#[tokio::test]
async fn http_failures_timeouts_and_redirects_do_not_retry_or_leak() {
    for (status, body, expected, delay) in [
        (401, "private text", "REVIEW_AUTH", 0),
        (403, "private text", "REVIEW_AUTH", 0),
        (429, "private text", "REVIEW_QUOTA", 0),
        (500, "private text", "REVIEW_REMOTE", 0),
        (302, "private text", "REVIEW_HTTP", 0),
        (400, "private text", "REVIEW_HTTP", 0),
        (200, "not json", "REVIEW_RESPONSE", 0),
        (
            200,
            "{\"status\":\"failed\",\"msg\":\"private text\"}",
            "REVIEW_REJECTED",
            0,
        ),
        (200, "{}", "REVIEW_TIMEOUT", 100),
    ] {
        let (endpoint, server) = mock(status, body.into(), Duration::from_millis(delay)).await;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(if expected == "REVIEW_TIMEOUT" {
                Duration::from_millis(50)
            } else {
                Duration::from_secs(2)
            })
            .build()
            .unwrap();
        let error = zhuque::classify(&client, &endpoint, auth(), "private text", 1, "hash".into())
            .await
            .unwrap_err();
        assert_eq!(error.code(), expected, "HTTP {status}");
        assert!(!error.to_string().contains("private text"));
        assert!(!error.to_string().contains("synthetic-test-key"));
        assert_eq!(server.await.unwrap(), 1);
    }
}

#[test]
fn expiry_unknown_usage_and_independent_database_preserve_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("content.db")).unwrap();
    assert!(!settings::load(&db).unwrap().enabled);
    let service = ReviewService::new(root.path().join("derived")).unwrap();
    let directory = service.directory(&db.read(workspace_id).unwrap());
    let mut conn = cache::open(&directory).unwrap();
    let mut result = parse(&response("片段", 1), "片段").unwrap();
    result.checked_at = now() - 31 * 24 * 60 * 60 * 1000;
    result.charged_tokens = None;
    cache::save(&mut conn, Some("expired"), &result, None).unwrap();
    assert!(
        cache::lookup(&mut conn, "expired", now(), None)
            .unwrap()
            .is_none()
    );
    let usage = serde_json::to_value(cache::usage(&conn, result.checked_at).unwrap()).unwrap();
    assert_eq!(usage["knownTokens"], 0);
    assert_eq!(usage["unknownCalls"], 1);
    db.read(|main| {
        assert_eq!(
            main.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('review_cache','review_usage')",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            main.query_row("SELECT COUNT(*) FROM sync_dirty", [], |row| row
                .get::<_, i64>(0))?,
            0
        );
        Ok(())
    })
    .unwrap();
    assert_ne!(cache_key("x", 1), cache_key("x", 2));
    assert_ne!(cache_key(" x", 1), cache_key("x", 1));
}

#[tokio::test]
async fn disabled_unknown_checker_and_overlapping_requests_fail_before_network() {
    let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(ReviewService::new(root.path().into()).unwrap());
    assert_eq!(
        service
            .check(&db, "unknown", input("text", false), None)
            .await
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
    assert_eq!(
        service
            .check(&db, "zhuque_text", input("text", false), None)
            .await
            .unwrap_err()
            .code(),
        "REVIEW_DISABLED"
    );
    let _guard = service.request.lock().await;
    assert_eq!(
        service
            .check(&db, "zhuque_text", input("text", false), None)
            .await
            .unwrap_err()
            .code(),
        "REVIEW_BUSY"
    );
}

#[tokio::test]
async fn successful_inference_with_failed_persistence_returns_result_without_resending() {
    let root = tempfile::tempdir().unwrap();
    let (endpoint, server) = mock(
        200,
        response("合成", 1).to_string(),
        Duration::from_millis(100),
    )
    .await;
    let mut service = ReviewService::new(root.path().into()).unwrap();
    service.endpoint = endpoint;
    let future = service.perform("a", 0, auth(), input("合成", false));
    let (result, _) = tokio::join!(future, async {
        // Only mutate the temporary fixture's database after the request has released it.
        tokio::time::sleep(Duration::from_millis(30)).await;
        let conn = cache::open(&service.directory("a")).unwrap();
        conn.execute_batch("CREATE TRIGGER refuse_cache BEFORE INSERT ON review_cache BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    });
    let result = result.unwrap();
    assert!(!result.cached);
    assert!(result.persistence_error.is_some());
    assert_eq!(result.charged_tokens, Some(30));
    assert_eq!(result.findings.len(), 1);
    assert_eq!(server.await.unwrap(), 1);
    let conn = cache::open(&service.directory("a")).unwrap();
    assert_eq!(
        serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap()["successfulCalls"],
        0
    );
}

#[tokio::test]
async fn unsaved_connection_key_works_while_disabled_without_persisting_configuration() {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("content.db")).unwrap();
    let (endpoint, server) = mock(200, response("合成", 0).to_string(), Duration::ZERO).await;
    let mut service = ReviewService::new(root.path().join("derived")).unwrap();
    service.endpoint = endpoint;
    let result = service
        .check(
            &db,
            "zhuque_text",
            CheckInput {
                connection_test: true,
                ..input("合成", true)
            },
            Some("  synthetic-test-key  "),
        )
        .await
        .unwrap();
    assert!(!result.cached);
    assert!(!settings::load(&db).unwrap().enabled);
    assert!(db.setting::<Value>("review_zhuque").unwrap().is_none());
    assert_eq!(service.revision.load(Ordering::SeqCst), 0);
    let conn = cache::open(&service.directory(&db.read(workspace_id).unwrap())).unwrap();
    let usage = serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap();
    assert_eq!(usage["knownTokens"], 30);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM review_cache", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(server.await.unwrap(), 1);
    assert_eq!(
        service
            .check(&db, "zhuque_text", input("合成", false), None)
            .await
            .unwrap_err()
            .code(),
        "REVIEW_DISABLED"
    );
}

#[tokio::test]
#[ignore = "requires a native system keyring; uses and deletes an isolated synthetic credential"]
async fn native_connection_test_prefers_unsaved_key_and_falls_back_without_saving() {
    struct CredentialCleanup(keyring::Entry);
    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("content.db")).unwrap();
    let mut service = ReviewService::new(root.path().join("derived")).unwrap();
    let _cleanup = CredentialCleanup(crate::secrets::entry(&db, "review-zhuque-makers").unwrap());
    for (saved_key, draft) in [
        ("old-synthetic-key", Some("synthetic-test-key")),
        ("synthetic-test-key", None),
        ("synthetic-test-key", Some("   ")),
    ] {
        settings::save(&db, &service, false, Some(saved_key)).unwrap();
        let revision = service.revision.load(Ordering::SeqCst);
        let (endpoint, server) = mock(200, response("合成", 0).to_string(), Duration::ZERO).await;
        service.endpoint = endpoint;
        let result = service
            .check(
                &db,
                "zhuque_text",
                CheckInput {
                    connection_test: true,
                    ..input("合成", true)
                },
                draft,
            )
            .await
            .unwrap();
        assert!(!result.cached);
        assert_eq!(
            settings::credential(&db).unwrap(),
            settings::authorization(saved_key).unwrap()
        );
        assert!(!settings::load(&db).unwrap().enabled);
        assert_eq!(service.revision.load(Ordering::SeqCst), revision);
        assert_eq!(server.await.unwrap(), 1);
    }
}

#[tokio::test]
async fn connection_tests_charge_usage_without_populating_the_article_cache() {
    let root = tempfile::tempdir().unwrap();
    let (endpoint, server) = mock(200, response("合成", 0).to_string(), Duration::ZERO).await;
    let mut service = ReviewService::new(root.path().into()).unwrap();
    service.endpoint = endpoint;
    let result = service
        .perform(
            "a",
            0,
            auth(),
            CheckInput {
                connection_test: true,
                ..input("合成", true)
            },
        )
        .await
        .unwrap();
    assert!(!result.cached);
    let mut conn = cache::open(&service.directory("a")).unwrap();
    assert!(
        cache::lookup(&mut conn, &cache_key("合成", 1), now(), None)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        serde_json::to_value(cache::usage(&conn, now()).unwrap()).unwrap()["knownTokens"],
        30
    );
    assert_eq!(server.await.unwrap(), 1);
}

#[test]
#[ignore = "requires a native system keyring; uses and deletes an isolated synthetic credential"]
fn native_keyring_settings_roundtrip_keeps_plaintext_out_of_workspace() {
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("content.db")).unwrap();
    let other = Workspace::open(&root.path().join("other.db")).unwrap();
    let service = ReviewService::new(root.path().join("derived")).unwrap();
    let saved = settings::save(&db, &service, true, Some("synthetic-test-key")).unwrap();
    // Always attempt cleanup before assertions, including a failed read.
    let found = settings::credential(&db);
    let other_credential = settings::credential(&other);
    let unchanged = settings::save(&db, &service, true, None);
    let removed = settings::save(&db, &service, false, Some(""));
    assert!(found.is_ok());
    assert!(other_credential.is_err());
    assert!(
        serde_json::to_value(unchanged.unwrap()).unwrap()["hasKey"]
            .as_bool()
            .unwrap()
    );
    assert!(
        !serde_json::to_value(removed.unwrap()).unwrap()["hasKey"]
            .as_bool()
            .unwrap()
    );
    assert!(
        !serde_json::to_string(&saved)
            .unwrap()
            .contains("synthetic-test-key")
    );
    assert_eq!(service.revision.load(Ordering::SeqCst), 3);
    db.read(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM app_settings WHERE value LIKE '%synthetic-test-key%'",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            0
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
#[ignore = "requires MAKERS_MODELS_KEY_FILE, a native keyring, and consumes real Makers quota"]
async fn live_makers_review_uses_production_service_keyring_and_cache() {
    struct CredentialCleanup(keyring::Entry);
    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let path = std::env::var("MAKERS_MODELS_KEY_FILE").expect("provide a local JSON key file path");
    let config: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let key = config["key"].as_str().expect("JSON file needs a key field");
    let root = tempfile::tempdir().unwrap();
    let db = Workspace::open(&root.path().join("content.db")).unwrap();
    let service = ReviewService::new(root.path().join("cache")).unwrap();
    let cleanup = CredentialCleanup(crate::secrets::entry(&db, "review-zhuque-makers").unwrap());
    settings::save(&db, &service, true, Some(key)).unwrap();
    let fixture: Value =
        serde_json::from_slice(include_bytes!("fixtures/live-unicode.json")).unwrap();
    let text = fixture["text"].as_str().unwrap();
    let result = service
        .check(&db, "zhuque_text", input(text, false), None)
        .await;
    let deleted = settings::save(&db, &service, false, Some(""));
    drop(cleanup);
    deleted.expect("remove the isolated real credential after the request");
    let result = result.expect("production Makers request must succeed");
    assert!(result.cached);
    assert!(result.charged_tokens.is_some());
    assert!(
        result
            .findings
            .iter()
            .all(|finding| finding.range.is_some())
    );
    let mut conn = cache::open(&service.directory(&db.read(workspace_id).unwrap())).unwrap();
    let cached = cache::lookup(&mut conn, &cache_key(text, 1), now(), None)
        .unwrap()
        .unwrap();
    assert!(cached.cache_hit);
    assert_eq!(cached.charged_tokens, Some(0));
    assert!(!serde_json::to_string(&result).unwrap().contains(key));
    println!(
        "Production Makers call: {} findings; observed tokens={:?}; cached=true; isolated credential removed",
        result.findings.len(),
        result.charged_tokens
    );
}
