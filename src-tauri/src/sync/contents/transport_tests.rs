use super::*;
use axum::{Router, http::HeaderMap, routing::head};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn hydrate_rejects_ambiguous_body_modes_before_requesting_a_blob() {
    let sync = SyncConnection::new().unwrap();
    let remote = Remote { image_gc: 0,
        sync: &sync,
        base: Url::parse("http://127.0.0.1:1/").unwrap(),
        token: "test-token".into(),
        binding: Binding { url: "http://127.0.0.1:1/".into(), instance_id: "instance".into(),
            epoch: "epoch".into(), device_id: "device".into(), paused: false, pause_reason: None },
    };
    for payload in [
        json!({"kind":"article","title":"正文","contentMd":"inline","contentBlobHash":"a".repeat(64),"contentBlobSize":6}),
        json!({"kind":"article","title":"正文","contentMd":"inline","contentBlobSize":6}),
        json!({"kind":"article","title":"正文","contentBlobHash":7,"contentBlobSize":6}),
    ] {
        let mut entity = Entity { key: Key { entity_type: Kind::Entry, entity_id: "entry".into() },
            remote_revision: 1, deleted_at: None, payload };
        assert_eq!(remote.hydrate(&mut entity).await.unwrap_err().code(), "SYNC_PROTOCOL");
    }
    let mut web = Entity { key: Key { entity_type: Kind::CollectionNode, entity_id: "web".into() },
        remote_revision: 1, deleted_at: None,
        payload: json!({"kind":"web","externalUrl":"https://example.com","contentMd":"","contentBlobSize":1}) };
    remote.hydrate(&mut web).await.unwrap();
}

#[tokio::test]
async fn hydrate_checks_body_size_digest_and_utf8_before_apply() {
    use axum::routing::get;
    for (bytes, wrong_size, wrong_hash, accepted) in [
        ("多字节正文".as_bytes().to_vec(), false, false, true),
        (vec![0xc3, 0x28], false, false, false),
        (b"body".to_vec(), true, false, false),
        (b"body".to_vec(), false, true, false),
    ] {
        let served = bytes.clone();
        let app = Router::new().route("/v1/blobs/{hash}", get(move || async move { served }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let sync = SyncConnection::new().unwrap();
        let remote = Remote { image_gc: 0, sync: &sync, base: Url::parse(&url).unwrap(), token: "test-token".into(),
            binding: Binding { url, instance_id: "instance".into(), epoch: "epoch".into(), device_id: "device".into(), paused: false, pause_reason: None } };
        let mut entity = Entity { key: Key { entity_type: Kind::Entry, entity_id: "entry".into() }, remote_revision: 1,
            deleted_at: None, payload: json!({"kind":"article","title":"正文","contentBlobHash":if wrong_hash { "0".repeat(64) } else { digest(&bytes) },"contentBlobSize":bytes.len()+usize::from(wrong_size)}) };
        let result = remote.hydrate(&mut entity).await;
        server.abort();
        assert_eq!(result.is_ok(), accepted);
        if accepted { assert_eq!(entity.payload["contentMd"], "多字节正文"); }
    }
}

#[tokio::test]
async fn attachment_upload_checks_protocol_before_skipping_or_putting_blob() {
    for exists in [false, true] {
        let puts = Arc::new(AtomicUsize::new(0));
        let writes = puts.clone();
        let app = Router::new().route(
            "/v1/blobs/{hash}",
            head(move |headers: HeaderMap| async move {
                if headers
                    .get("x-sync-protocol")
                    .and_then(|value| value.to_str().ok())
                    != Some("3")
                {
                    StatusCode::UPGRADE_REQUIRED
                } else if exists {
                    StatusCode::OK
                } else {
                    StatusCode::NOT_FOUND
                }
            })
            .put(
                move |headers: HeaderMap, body: axum::body::Bytes| async move {
                    assert_eq!(headers["x-sync-protocol"], "3");
                    assert_eq!(body.as_ref(), b"attachment bytes");
                    writes.fetch_add(1, Ordering::SeqCst);
                    StatusCode::OK
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let sync = SyncConnection::new().unwrap();
        let remote = Remote { image_gc: 0,
            sync: &sync,
            base: Url::parse(&url).unwrap(),
            token: "test-token".into(),
            binding: Binding {
                url,
                instance_id: "instance".into(),
                epoch: "epoch".into(),
                device_id: "device".into(),
                paused: false,
                pause_reason: None,
            },
        };
        let bytes = b"attachment bytes".to_vec();
        let result = remote.upload(&digest(&bytes), bytes).await;
        server.abort();
        result.unwrap();
        assert_eq!(puts.load(Ordering::SeqCst), usize::from(!exists));
    }
}
