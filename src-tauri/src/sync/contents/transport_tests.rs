use super::*;
use axum::{Router, http::HeaderMap, routing::head};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

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
                    != Some("2")
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
                    assert_eq!(headers["x-sync-protocol"], "2");
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
        let remote = Remote {
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
