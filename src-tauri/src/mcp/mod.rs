mod tools;

use crate::{
    clipboard,
    db::{AppError, Result, Workspace, id},
    secrets,
};
use axum::{
    Router,
    extract::{Request, State as HttpState},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use serde::{Deserialize, Serialize};
use std::{
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, State};
use tokio::{net::TcpListener, sync::Mutex as AsyncMutex, task::JoinHandle};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const SETTING: &str = "mcp_config";
const CREDENTIAL: &str = "mcp";

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Permission {
    Read,
    Write,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub struct McpConfig {
    enabled: bool,
    port: u16,
    permission: Permission,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 17321,
            permission: Permission::Read,
        }
    }
}

#[derive(Serialize)]
pub struct McpStatus {
    config: McpConfig,
    running: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct McpServer(AsyncMutex<ServerState>);

#[derive(Default)]
struct ServerState {
    running: Option<Running>,
    suspended: bool,
    error: Option<String>,
}

struct Running {
    config: McpConfig,
    cancel: CancellationToken,
    server: JoinHandle<()>,
    tasks: TaskTracker,
}

impl McpServer {
    pub async fn start(&self, app: &AppHandle, db: &Workspace) {
        let mut state = self.0.lock().await;
        if !state.suspended {
            state.try_start_saved(app, db).await;
        }
    }

    pub async fn suspend(&self) {
        let mut state = self.0.lock().await;
        state.suspended = true;
        state.stop().await;
    }

    pub async fn resume(&self, app: &AppHandle, db: &Workspace) {
        let mut state = self.0.lock().await;
        state.suspended = false;
        state.try_start_saved(app, db).await;
    }
}

impl ServerState {
    async fn try_start_saved(&mut self, app: &AppHandle, db: &Workspace) {
        self.error = self
            .start_saved(app, db)
            .await
            .err()
            .map(|error| error.to_string());
    }

    async fn start_saved(&mut self, app: &AppHandle, db: &Workspace) -> Result<()> {
        let config = load(db)?;
        if config.enabled && self.running.is_none() {
            let token = access_token(db)?;
            self.running = Some(Running::start(
                app,
                config,
                bind(config.port).await?,
                &token,
            ));
        }
        Ok(())
    }

    async fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.cancel.cancel();
            let server = running.server.await;
            running.tasks.close();
            running.tasks.wait().await;
            if server.is_err() {
                eprintln!("MCP stop MCP_SERVER");
            }
        }
    }

    fn status(&self, config: McpConfig) -> McpStatus {
        McpStatus {
            config,
            running: self
                .running
                .as_ref()
                .is_some_and(|running| !running.server.is_finished()),
            error: self.error.clone(),
        }
    }
}

impl Running {
    fn start(app: &AppHandle, config: McpConfig, listener: TcpListener, token: &str) -> Self {
        let cancel = CancellationToken::new();
        let tasks = TaskTracker::new();
        let tools = tools::Tools::new(
            app.clone(),
            config.permission,
            cancel.clone(),
            tasks.clone(),
        );
        let service = StreamableHttpService::new(
            move || Ok(tools.clone()),
            Arc::new(LocalSessionManager::default()),
            transport_config(cancel.clone()),
        );
        let guard = Arc::new(RequestGate {
            token: token.as_bytes().to_vec(),
            limit: Mutex::new((Instant::now(), 0)),
            cancel: cancel.clone(),
        });
        let router = Router::new()
            .route_service("/mcp", service)
            .route_layer(middleware::from_fn_with_state(guard, authenticate));
        let server = tokio::spawn(serve(listener, router, cancel.clone(), tasks.clone()));
        Self {
            config,
            cancel,
            server,
            tasks,
        }
    }
}

async fn serve(
    mut listener: TcpListener,
    router: Router,
    cancel: CancellationToken,
    tasks: TaskTracker,
) {
    loop {
        let (stream, _) = tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            stream = axum::serve::Listener::accept(&mut listener) => stream,
        };
        let service = TowerToHyperService::new(router.clone());
        let cancel = cancel.clone();
        tasks.spawn(async move {
            tokio::select! {
                biased;
                () = cancel.cancelled() => {},
                _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service) => {},
            }
        });
    }
}

fn transport_config(cancel: CancellationToken) -> StreamableHttpServerConfig {
    StreamableHttpServerConfig::default()
        .with_allowed_hosts(["127.0.0.1"])
        .enforce_origin_validation()
        .with_cancellation_token(cancel)
        .with_max_request_body_bytes(1024 * 1024)
}

struct RequestGate {
    token: Vec<u8>,
    limit: Mutex<(Instant, u32)>,
    cancel: CancellationToken,
}

impl RequestGate {
    fn admit(&self, headers: &HeaderMap) -> std::result::Result<(), StatusCode> {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        if !values
            .next()
            .and_then(|value| value.as_bytes().split_at_checked(7))
            .is_some_and(|(scheme, token)| {
                scheme.eq_ignore_ascii_case(b"Bearer ") && bool::from(token.ct_eq(&self.token))
            })
            || values.next().is_some()
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let mut window = self.limit.lock().expect("MCP rate limit mutex poisoned");
        if window.0.elapsed() >= Duration::from_secs(60) {
            *window = (Instant::now(), 0);
        }
        if window.1 >= 120 {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        window.1 += 1;
        Ok(())
    }
}

async fn authenticate(
    HttpState(guard): HttpState<Arc<RequestGate>>,
    request: Request,
    next: Next,
) -> Response {
    if let Err(status) = guard.admit(request.headers()) {
        return status.into_response();
    }
    tokio::select! {
        biased;
        () = guard.cancel.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        response = next.run(request) => response,
    }
}

fn load(db: &Workspace) -> Result<McpConfig> {
    Ok(db.setting(SETTING)?.unwrap_or_default())
}

fn access_token(db: &Workspace) -> Result<String> {
    let entry = secrets::entry(db, CREDENTIAL)?;
    match entry.get_password() {
        Ok(token) => Ok(token),
        Err(keyring::Error::NoEntry) => {
            let token = id();
            entry.set_password(&token).map_err(secrets::error)?;
            Ok(token)
        }
        Err(error) => Err(secrets::error(error)),
    }
}

async fn bind(port: u16) -> Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|error| AppError::new("MCP_PORT", format!("无法监听本机端口 {port}：{error}")))
}

#[tauri::command]
pub async fn mcp_status(db: State<'_, Workspace>, mcp: State<'_, McpServer>) -> Result<McpStatus> {
    let state = mcp.0.lock().await;
    Ok(state.status(load(&db)?))
}

#[tauri::command]
pub async fn mcp_save(
    app: AppHandle,
    db: State<'_, Workspace>,
    mcp: State<'_, McpServer>,
    config: McpConfig,
) -> Result<McpStatus> {
    if config.port == 0 {
        return Err(AppError::invalid("端口须在 1 到 65535 之间"));
    }
    let mut state = mcp.0.lock().await;
    if state.suspended {
        return Err(AppError::new("EXIT_PENDING", "正在保存并退出"));
    }
    if state
        .running
        .as_ref()
        .is_some_and(|running| running.config == config && !running.server.is_finished())
    {
        return Ok(state.status(config));
    }
    if !config.enabled {
        db.set_setting(SETTING, &config)?;
        state.stop().await;
    } else {
        let token = access_token(&db)?;
        if state
            .running
            .as_ref()
            .is_some_and(|running| running.config.port == config.port)
        {
            state.stop().await;
        }
        let listener = bind(config.port).await?;
        db.set_setting(SETTING, &config)?;
        state.stop().await;
        state.running = Some(Running::start(&app, config, listener, &token));
    }
    state.error = None;
    Ok(state.status(config))
}

#[tauri::command]
pub async fn mcp_token(
    db: State<'_, Workspace>,
    mcp: State<'_, McpServer>,
    rotate: bool,
) -> Result<()> {
    let state = mcp.0.lock().await;
    if state.suspended {
        return Err(AppError::new("EXIT_PENDING", "正在保存并退出"));
    }
    if rotate {
        if state.running.is_some() {
            return Err(AppError::invalid("请先停止 MCP 再重置令牌"));
        }
        let token = id();
        secrets::entry(&db, CREDENTIAL)?
            .set_password(&token)
            .map_err(secrets::error)?;
        return clipboard::clipboard_write(token);
    }
    clipboard::clipboard_write(access_token(&db)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http};
    use rmcp::ServerHandler;
    use tower::ServiceExt;

    #[tokio::test]
    async fn transport_validates_bearer_origin_host_and_request_size() {
        #[derive(Clone)]
        struct Stub;
        impl ServerHandler for Stub {}

        let cancel = CancellationToken::new();
        let sdk = StreamableHttpService::new(
            || Ok(Stub),
            Arc::new(LocalSessionManager::default()),
            transport_config(cancel.clone()),
        );
        let router =
            Router::new()
                .route_service("/mcp", sdk)
                .route_layer(middleware::from_fn_with_state(
                    Arc::new(RequestGate {
                        token: b"local-token".to_vec(),
                        limit: Mutex::new((Instant::now(), 0)),
                        cancel,
                    }),
                    authenticate,
                ));
        let request = |host: &str, token: &str| {
            http::Request::post("/mcp")
                .header(header::HOST, host)
                .header(header::AUTHORIZATION, token)
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header(header::CONTENT_TYPE, "application/json")
        };
        let valid = "Bearer local-token";
        for (request, expected) in [
            (
                request("127.0.0.1:17321", "Bearer invalid")
                    .body(Body::empty())
                    .unwrap(),
                StatusCode::UNAUTHORIZED,
            ),
            (
                request("127.0.0.1:17321", valid)
                    .header(header::ORIGIN, "https://example.test")
                    .body(Body::empty())
                    .unwrap(),
                StatusCode::FORBIDDEN,
            ),
            (
                request("example.test:17321", valid)
                    .body(Body::empty())
                    .unwrap(),
                StatusCode::FORBIDDEN,
            ),
            (
                request("127.0.0.1:17321", valid)
                    .body(Body::from(vec![b' '; 1024 * 1024 + 1]))
                    .unwrap(),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            assert_eq!(
                router.clone().oneshot(request).await.unwrap().status(),
                expected
            );
        }
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}"#;
        let response = router
            .oneshot(
                request("127.0.0.1:17321", valid)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key("mcp-session-id"));
        let body = axum::body::to_bytes(response.into_body(), 32 * 1024)
            .await
            .unwrap();
        let content = std::str::from_utf8(&body).unwrap();
        assert!(content.contains("2025-11-25"));
    }

    #[test]
    fn authenticated_requests_are_rate_limited() {
        let gate = RequestGate {
            token: b"token".to_vec(),
            limit: Mutex::new((Instant::now(), 119)),
            cancel: CancellationToken::new(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer token".parse().unwrap());
        assert!(gate.admit(&headers).is_ok());
        assert_eq!(gate.admit(&headers), Err(StatusCode::TOO_MANY_REQUESTS));
    }

    #[tokio::test]
    async fn stopping_the_listener_also_closes_an_open_http_connection() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpStream,
        };

        let listener = bind(0).await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let tasks = TaskTracker::new();
        let router = Router::new().route("/fixture", axum::routing::get(|| async { "ok" }));
        let server = tokio::spawn(serve(listener, router, cancel.clone(), tasks.clone()));
        let mut client = TcpStream::connect(address).await.unwrap();
        client
            .write_all(b"GET /fixture HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut response_head = [0u8; 15];
        client.read_exact(&mut response_head).await.unwrap();
        assert_eq!(&response_head, b"HTTP/1.1 200 OK");

        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(2), async {
            server.await.unwrap();
            tasks.close();
            tasks.wait().await;
            let mut remaining = Vec::new();
            client.read_to_end(&mut remaining).await.unwrap();
        })
        .await
        .expect("HTTP connection should close when MCP stops");
    }
}
