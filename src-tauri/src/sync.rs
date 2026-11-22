use crate::{
    db::{AppError, Result, Workspace},
    secrets,
};
use reqwest::{Client, RequestBuilder, StatusCode};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;
use std::{
    fmt::Write,
    net::IpAddr,
    sync::atomic::{AtomicU8, Ordering},
    time::Duration,
};
use tauri::State;
use tokio::sync::{Mutex, Notify};
use url::{Host, Url};

pub(crate) mod contents;
pub(crate) mod scheduler;
pub(crate) use contents::{finish_category_delete, record_category_delete, synced_blob};

pub struct SyncConnection {
    http: Client,
    local_http: Client,
    gate: Mutex<()>,
    wake: Notify,
    wake_sources: AtomicU8,
    runtime: std::sync::Mutex<scheduler::RuntimeState>,
    app: std::sync::OnceLock<tauri::AppHandle>,
}

impl SyncConnection {
    pub fn new() -> Result<Self> {
        let client = || {
            Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
        };
        Ok(Self {
            http: client().build().map_err(network_error)?,
            local_http: client().no_proxy().build().map_err(network_error)?,
            gate: Mutex::new(()),
            wake: Notify::new(),
            wake_sources: AtomicU8::new(0),
            runtime: std::sync::Mutex::new(scheduler::RuntimeState::default()),
            app: std::sync::OnceLock::new(),
        })
    }

    pub(crate) fn wake(&self) {
        self.request_wake(WakeSource::Immediate);
    }

    fn request_wake(&self, source: WakeSource) {
        self.wake_sources.fetch_or(source as u8, Ordering::AcqRel);
        self.wake.notify_one();
    }

    fn phase(&self, phase: &str) {
        self.runtime
            .lock()
            .expect("sync runtime lock poisoned")
            .phase = phase.into();
        if let Some(app) = self.app.get() {
            self.changed(app);
        }
    }

    pub(crate) fn changed(&self, app: &tauri::AppHandle) {
        use tauri::Emitter;
        let _ = app.emit("sync-status-changed", ());
    }

    fn client(&self, url: &Url) -> &Client {
        if url.scheme() == "http" {
            &self.local_http
        } else {
            &self.http
        }
    }

    async fn meta(&self, url: &Url) -> Result<Meta> {
        let meta: Meta = response(
            self.client(url)
                .get(url.join("v1/meta").map_err(invalid_response)?),
        )
        .await?;
        if meta.protocol_version != 2
            || !valid_id(&meta.server_instance_id)
            || !valid_id(&meta.sync_epoch)
        {
            return Err(AppError::new(
                "SYNC_PROTOCOL",
                "同步服务协议或实例标识不兼容",
            ));
        }
        if !meta.canvas_sync || !meta.unified_connect || !meta.operation_receipt_lookup {
            return Err(AppError::new(
                "SYNC_SERVER_UPDATE",
                "请先更新同步服务和数据库迁移，再继续同步",
            ));
        }
        Ok(meta)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    url: String,
    instance_id: String,
    epoch: String,
    device_id: String,
    paused: bool,
    pause_reason: Option<String>,
}

impl Binding {
    fn read(db: &Workspace) -> Result<Option<Self>> {
        db.read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT url,instance_id,epoch,device_id,paused,pause_reason FROM sync_binding WHERE id=1",
                    [],
                    |row| {
                        Ok(Self {
                            url: row.get(0)?,
                            instance_id: row.get(1)?,
                            epoch: row.get(2)?,
                            device_id: row.get(3)?,
                            paused: row.get(4)?,
                            pause_reason: row.get(5)?,
                        })
                    },
                )
                .optional()?)
        })
    }

    fn matches(&self, meta: &Meta) -> bool {
        self.instance_id == meta.server_instance_id && self.epoch == meta.sync_epoch
    }

    fn key(&self, db: &Workspace) -> Result<keyring::Entry> {
        credential(db, &self.url, &self.instance_id, &self.epoch)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    protocol_version: u32,
    #[serde(default)]
    canvas_sync: bool,
    #[serde(default)]
    connection_recovery: bool,
    #[serde(default)]
    workspace_access: bool,
    #[serde(default)]
    unified_connect: bool,
    #[serde(default)]
    operation_receipt_lookup: bool,
    server_instance_id: String,
    sync_epoch: String,
    seed_status: String,
    #[serde(default)]
    seed_device_id: Option<String>,
}

impl Meta {
    fn require_workspace_access(&self) -> Result<()> {
        if self.workspace_access {
            Ok(())
        } else {
            Err(AppError::new(
                "SYNC_ACCESS_UNSUPPORTED",
                "请先升级同步服务以使用工作区接入密钥",
            ))
        }
    }

    fn require_connection_recovery(&self) -> Result<()> {
        if self.connection_recovery {
            Ok(())
        } else {
            Err(AppError::new(
                "SYNC_RECOVERY_UNSUPPORTED",
                "请先升级同步服务以使用连接恢复",
            ))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    device_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    device_id: String,
    name: String,
    created_at: i64,
    revoked_at: Option<i64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    current_device_id: String,
    devices: Vec<Device>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessKey {
    access_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryKey {
    recovery_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectWith {
    Claim,
    Join,
    Recover,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn service_url(input: &str) -> Result<Url> {
    let error = || AppError::invalid("请输入同步服务的 HTTPS 根地址，本机测试可使用 HTTP");
    let url = Url::parse(input.trim()).map_err(|_| error())?;
    let local = match url.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        _ => false,
    };
    if !url.has_host()
        || !(url.scheme() == "https" || url.scheme() == "http" && local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error());
    }
    Ok(url)
}

fn network_error(error: reqwest::Error) -> AppError {
    let message = if error.is_timeout() {
        "同步请求超时，请稍后重试"
    } else if error.is_connect() {
        "无法连接同步服务，请检查地址和网络"
    } else {
        "同步传输中断，请稍后重试"
    };
    eprintln!("Sync transport failed: {:?}", error.without_url());
    AppError::new("SYNC_NETWORK", message)
}

fn invalid_response(_: impl std::fmt::Display) -> AppError {
    AppError::new("SYNC_PROTOCOL", "同步服务返回了无效的数据")
}

async fn send(request: RequestBuilder) -> Result<reqwest::Response> {
    let response = request.header("X-Sync-Protocol", "2").send().await.map_err(network_error)?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let code: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    let error = match code["error"].as_str() {
        Some("unsupported_protocol") => AppError::new("SYNC_PROTOCOL", "同步协议不兼容，请配套更新同步服务与所有设备上的客户端"),
        Some("invalid_setup_secret") => AppError::new("SYNC_CODE", "认领密钥无效"),
        Some("invalid_access_key") => AppError::new("SYNC_CODE", "连接密钥无效或已更换"),
        Some("invalid_recovery_key") => AppError::new("SYNC_CODE", "恢复密钥无效、已使用或已撤销"),
        Some("already_claimed") => {
            AppError::new("SYNC_CLAIMED", "服务已认领，请使用接入密钥或恢复连接")
        }
        Some("device_required") => AppError::new(
            "SYNC_DEVICE_REQUIRED",
            "请保留首次上传设备和至少一台有效设备",
        ),
        Some("reset_required") => match code["reason"].as_str() {
            Some("cursor_expired") => AppError::new("SYNC_CURSOR_EXPIRED", "正在重新核对云端内容"),
            Some("cursor_ahead") => {
                AppError::new("SYNC_HISTORY", "云端同步历史与本机不一致，已暂停同步")
            }
            Some("instance_changed" | "epoch_changed") => {
                AppError::new("SYNC_IDENTITY", "同步服务身份已变化，已暂停同步")
            }
            _ => AppError::new("SYNC_RESET_LEGACY", "同步基线需要人工核对，已暂停同步"),
        },
        Some("operation_id_reused") => {
            AppError::new("SYNC_OPERATION_MISMATCH", "原操作回执与本地载荷不匹配")
        }
        Some("seed_in_progress") => AppError::new("SYNC_WAITING_SEED", "等待云端初始化"),
        _ if status == StatusCode::UNAUTHORIZED => {
            AppError::new("SYNC_CREDENTIAL", "同步设备凭据已失效")
        }
        _ => AppError::new("SYNC_HTTP", format!("同步服务请求失败（HTTP {status}）")),
    };
    Err(error)
}

async fn response<T: DeserializeOwned>(request: RequestBuilder) -> Result<T> {
    send(request).await?.json().await.map_err(invalid_response)
}

fn generate_secret() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| AppError::new("CREDENTIALS", "无法生成安全随机令牌"))?;
    let mut result = String::with_capacity(64);
    for byte in bytes {
        write!(result, "{byte:02x}").expect("writing to a string cannot fail");
    }
    Ok(result)
}

fn credential(db: &Workspace, url: &str, instance: &str, epoch: &str) -> Result<keyring::Entry> {
    use sha2::{Digest, Sha256};
    let origin = format!("{:x}", Sha256::digest(url.as_bytes()));
    secrets::entry(db, &format!("sync/{origin}/{instance}/{epoch}"))
}

#[derive(Default, Deserialize, Serialize)]
struct Credential {
    active: Option<String>,
    pending: Option<String>,
    #[serde(default)]
    access_key: Option<String>,
}

impl Credential {
    fn read(key: &keyring::Entry) -> Result<Self> {
        match key.get_password() {
            Ok(data) => serde_json::from_str(&data)
                .map_err(|_| AppError::new("SYNC_CREDENTIAL", "无法读取同步设备凭据")),
            Err(keyring::Error::NoEntry) => Ok(Self::default()),
            Err(error) => Err(secrets::error(error)),
        }
    }

    fn store(&self, key: &keyring::Entry) -> Result<()> {
        let data = serde_json::to_string(self).expect("credential contains only strings");
        key.set_password(&data).map_err(secrets::error)
    }
}

fn pause(db: &Workspace) -> Result<()> {
    pause_with_reason(db, "legacy_review")
}

fn pause_with_reason(db: &Workspace, reason: &str) -> Result<()> {
    db.write(|tx| {
        tx.execute(
            "UPDATE sync_binding SET paused=1,pause_reason=?1 WHERE id=1",
            [reason],
        )?;
        Ok(())
    })
}

async fn fetch_devices(client: &Client, url: &Url, token: &str) -> Result<Devices> {
    response(
        client
            .get(url.join("v1/devices").map_err(invalid_response)?)
            .bearer_auth(token),
    )
    .await
}

async fn connected(db: &Workspace, sync: &SyncConnection) -> Result<(Url, String, Meta)> {
    let binding = Binding::read(db)?.ok_or_else(|| AppError::invalid("请先连接同步服务"))?;
    if binding.paused {
        return Err(AppError::new(
            "SYNC_PAUSED",
            "同步连接已暂停，需重新建立同步基线",
        ));
    }
    let url = service_url(&binding.url)?;
    let meta = sync.meta(&url).await?;
    if !binding.matches(&meta) {
        pause_with_reason(db, "identity_changed")?;
        return Err(AppError::new(
            "SYNC_PAUSED",
            "同步服务身份已变化，连接已暂停",
        ));
    }
    let token = Credential::read(&binding.key(db)?)?
        .active
        .ok_or_else(|| AppError::new("SYNC_CREDENTIAL", "同步设备凭据已失效"))?;
    Ok((url, token, meta))
}

#[tauri::command]
pub fn sync_status(db: State<'_, Workspace>) -> Result<Option<Binding>> {
    Binding::read(&db)
}

#[tauri::command]
pub async fn sync_default_device_name() -> Option<String> {
    #[cfg(windows)]
    let name = {
        use windows::{
            Win32::System::SystemInformation::{
                ComputerNamePhysicalDnsHostname, GetComputerNameExW,
            },
            core::PWSTR,
        };
        let mut buffer = [0u16; 256];
        let mut len = buffer.len() as u32;
        // The API receives the writable buffer capacity and reports the UTF-16 length.
        unsafe {
            GetComputerNameExW(
                ComputerNamePhysicalDnsHostname,
                Some(PWSTR(buffer.as_mut_ptr())),
                &mut len,
            )
        }
        .ok()?;
        String::from_utf16(&buffer[..len as usize]).ok()?
    };
    #[cfg(target_os = "macos")]
    let name = {
        let output = tokio::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok()?
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let name = String::new();

    let name = name.trim();
    valid_device_name(name).then(|| name.to_owned())
}

fn valid_device_name(name: &str) -> bool {
    !name.is_empty() && name.encode_utf16().count() <= 128 && !name.contains('\0')
}

#[tauri::command]
pub fn sync_generate_secret() -> Result<String> {
    generate_secret()
}

#[tauri::command]
pub async fn sync_connect(
    app: tauri::AppHandle,
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
    url: String,
    name: String,
    access_key: Option<String>,
) -> Result<Binding> {
    scheduler::set_phase(&sync, &app, "connecting");
    let result = connect(
        &db,
        &sync,
        &url,
        &name,
        ConnectWith::Join,
        access_key.as_deref().unwrap_or(""),
    )
    .await;
    if result.is_ok() {
        sync.runtime
            .lock()
            .expect("sync runtime lock poisoned")
            .error = None;
    }
    scheduler::settled(&sync, &app, result.as_ref().err());
    result
}

#[tauri::command]
pub async fn sync_recover(
    app: tauri::AppHandle,
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
    url: String,
    name: String,
    recovery_key: String,
) -> Result<Binding> {
    let rebuild = Binding::read(&db)?.is_some_and(|binding| binding.paused);
    scheduler::set_phase(&sync, &app, "connecting");
    let result = register(
        &db,
        &sync,
        &url,
        &name,
        ConnectWith::Recover,
        &recovery_key,
        rebuild,
    )
    .await;
    if result.is_ok() {
        sync.runtime
            .lock()
            .expect("sync runtime lock poisoned")
            .error = None;
    }
    scheduler::settled(&sync, &app, result.as_ref().err());
    result
}

#[tauri::command]
pub async fn sync_reauthorize(
    app: tauri::AppHandle,
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
    url: String,
    name: String,
    access_key: String,
) -> Result<Binding> {
    scheduler::set_phase(&sync, &app, "connecting");
    let result = register(
        &db,
        &sync,
        &url,
        &name,
        ConnectWith::Join,
        &access_key,
        true,
    )
    .await;
    if result.is_ok() {
        sync.runtime
            .lock()
            .expect("sync runtime lock poisoned")
            .error = None;
    }
    scheduler::settled(&sync, &app, result.as_ref().err());
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    url: String,
    access_key: String,
}

#[tauri::command]
pub fn sync_connection_info(db: State<'_, Workspace>) -> Result<ConnectionInfo> {
    let binding = Binding::read(&db)?.ok_or_else(|| AppError::invalid("请先连接同步服务"))?;
    let access_key = Credential::read(&binding.key(&db)?)?
        .access_key
        .ok_or_else(|| AppError::new("SYNC_KEY_MISSING", "请填写现有连接密钥，或更换连接密钥"))?;
    Ok(ConnectionInfo {
        url: binding.url,
        access_key,
    })
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum WakeSource {
    Immediate = 1,
    Foreground = 2,
}

#[tauri::command]
pub fn sync_wake(sync: State<'_, SyncConnection>, source: Option<WakeSource>) {
    sync.request_wake(source.unwrap_or(WakeSource::Immediate));
}

async fn connect(
    db: &Workspace,
    sync: &SyncConnection,
    url: &str,
    name: &str,
    method: ConnectWith,
    code: &str,
) -> Result<Binding> {
    register(db, sync, url, name, method, code, false).await
}

async fn register(
    db: &Workspace,
    sync: &SyncConnection,
    url: &str,
    name: &str,
    method: ConnectWith,
    code: &str,
    rebuild: bool,
) -> Result<Binding> {
    let _guard = sync.gate.lock().await;
    let url = service_url(url)?;
    let name = name.trim();
    let code = code.trim();
    if !valid_device_name(name) || (!code.is_empty() && !valid_token(code)) {
        return Err(AppError::invalid("请填写设备名和 64 位十六进制密钥"));
    }
    let old = Binding::read(db)?;
    if rebuild && old.as_ref().is_none_or(|binding| !binding.paused) {
        return Err(AppError::invalid("请先暂停同步连接，再重新建立基线"));
    }
    if let Some(binding) = old.as_ref()
        && ((binding.paused && !rebuild) || binding.url != url.as_str())
    {
        return Err(AppError::new(
            "SYNC_PAUSED",
            "该工作区已有同步绑定，需重新建立同步基线",
        ));
    }
    let meta = sync.meta(&url).await?;
    if !rebuild && old.as_ref().is_some_and(|binding| !binding.matches(&meta)) {
        pause_with_reason(db, "identity_changed")?;
        return Err(AppError::new(
            "SYNC_PAUSED",
            "同步服务身份已变化，连接已暂停",
        ));
    }
    match method {
        ConnectWith::Join | ConnectWith::Claim => {}
        ConnectWith::Recover => {
            meta.require_connection_recovery()?;
        }
    }
    let key = credential(db, url.as_str(), &meta.server_instance_id, &meta.sync_epoch)?;
    let client = sync.client(&url);
    let mut credential = Credential::read(&key)?;
    let active_id = if let Some(token) = credential.active.as_deref() {
        registered_device(client, &url, token).await?
    } else {
        None
    };
    let device_id = if let Some(id) = active_id {
        if !matches!(method, ConnectWith::Recover) && !code.is_empty() {
            let confirmed: Registration = response(
                client
                    .post(url.join("v1/connect").map_err(invalid_response)?)
                    .header("X-Sync-Instance", &meta.server_instance_id)
                    .header("X-Sync-Epoch", &meta.sync_epoch)
                    .json(&json!({"name":name,"accessKey":code,"deviceToken":credential.active})),
            )
            .await?;
            if confirmed.device_id != id {
                return Err(invalid_response("device identity changed"));
            }
            credential.access_key = Some(code.to_owned());
            credential.store(&key)?;
        }
        id
    } else {
        if code.is_empty() {
            return Err(AppError::new(
                "SYNC_CREDENTIAL",
                "请填写连接密钥重新授权此设备",
            ));
        }
        let (token, pending_id) = if let Some(token) = credential.pending.take() {
            let id = registered_device(client, &url, &token).await?;
            (token, id)
        } else {
            let token = generate_secret()?;
            credential.pending = Some(token.clone());
            credential.store(&key)?;
            (token, None)
        };
        let id = if let Some(id) = pending_id {
            id
        } else {
            let (route, payload) = match method {
                ConnectWith::Claim | ConnectWith::Join => (
                    "v1/connect",
                    json!({ "name": name, "accessKey": code, "deviceToken": token }),
                ),
                ConnectWith::Recover => (
                    "v1/recover",
                    json!({ "name": name, "recoveryKey": code, "deviceToken": token }),
                ),
            };
            let result: Registration = response(
                client
                    .post(url.join(route).map_err(invalid_response)?)
                    .header("X-Sync-Instance", &meta.server_instance_id)
                    .header("X-Sync-Epoch", &meta.sync_epoch)
                    .json(&payload),
            )
            .await?;
            result.device_id
        };
        if !valid_id(&id) {
            return Err(AppError::new(
                "SYNC_PROTOCOL",
                "同步服务返回了无效的设备标识",
            ));
        }
        Credential {
            active: Some(token),
            pending: None,
            access_key: if matches!(method, ConnectWith::Recover) {
                credential.access_key
            } else {
                Some(code.to_owned())
            },
        }
        .store(&key)?;
        id
    };
    if !valid_id(&device_id) {
        return Err(AppError::new(
            "SYNC_PROTOCOL",
            "同步服务返回了无效的设备标识",
        ));
    }
    let binding = Binding {
        url: url.into(),
        instance_id: meta.server_instance_id,
        epoch: meta.sync_epoch,
        device_id,
        paused: rebuild,
        pause_reason: if rebuild {
            old.as_ref()
                .and_then(|binding| binding.pause_reason.clone())
        } else {
            None
        },
    };
    db.write(|tx| {
        tx.execute(
            "INSERT INTO sync_binding (id,url,instance_id,epoch,device_id,paused,pause_reason) VALUES (1,?1,?2,?3,?4,?5,?6)
             ON CONFLICT (id) DO UPDATE SET device_id=excluded.device_id,
               instance_id=excluded.instance_id,epoch=excluded.epoch,paused=excluded.paused,pause_reason=excluded.pause_reason",
            params![
                binding.url,
                binding.instance_id,
                binding.epoch,
                binding.device_id,
                binding.paused,
                binding.pause_reason,
            ],
        )?;
        if rebuild {
            tx.execute_batch("DELETE FROM sync_bootstrap; UPDATE sync_progress SET bootstrap_cursor=NULL")?;
        }
        Ok(())
    })?;
    sync.wake();
    Ok(binding)
}

async fn registered_device(client: &Client, url: &Url, token: &str) -> Result<Option<String>> {
    match fetch_devices(client, url, token).await {
        Ok(devices) => Ok(Some(devices.current_device_id)),
        Err(error) if error.code() == "SYNC_CREDENTIAL" => Ok(None),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn sync_devices(
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
) -> Result<Devices> {
    let _guard = sync.gate.lock().await;
    let (url, token, _) = connected(&db, &sync).await?;
    fetch_devices(sync.client(&url), &url, &token).await
}

#[tauri::command]
pub async fn sync_create_access_key(
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
) -> Result<String> {
    create_access_key(&db, &sync).await
}

async fn create_access_key(db: &Workspace, sync: &SyncConnection) -> Result<String> {
    let _guard = sync.gate.lock().await;
    let (url, token, meta) = connected(db, sync).await?;
    meta.require_workspace_access()?;
    let result: AccessKey = response(
        sync.client(&url)
            .post(url.join("v1/access-key").map_err(invalid_response)?)
            .bearer_auth(token),
    )
    .await?;
    if !valid_token(&result.access_key) {
        return Err(AppError::new(
            "SYNC_PROTOCOL",
            "同步服务返回了无效的接入密钥",
        ));
    }
    let binding = Binding::read(db)?.ok_or_else(|| AppError::invalid("请先连接同步服务"))?;
    let key = binding.key(db)?;
    let mut credential = Credential::read(&key)?;
    credential.access_key = Some(result.access_key.clone());
    credential.store(&key)?;
    Ok(result.access_key)
}

#[tauri::command]
pub async fn sync_create_recovery_key(
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
) -> Result<String> {
    create_recovery_key(&db, &sync).await
}

async fn create_recovery_key(db: &Workspace, sync: &SyncConnection) -> Result<String> {
    let _guard = sync.gate.lock().await;
    let (url, token, meta) = connected(db, sync).await?;
    meta.require_connection_recovery()?;
    let result: RecoveryKey = response(
        sync.client(&url)
            .post(url.join("v1/recovery-key").map_err(invalid_response)?)
            .bearer_auth(token),
    )
    .await?;
    if !valid_token(&result.recovery_key) {
        return Err(AppError::new(
            "SYNC_PROTOCOL",
            "同步服务返回了无效的恢复密钥",
        ));
    }
    Ok(result.recovery_key)
}

#[tauri::command]
pub async fn sync_revoke_device(
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
    device_id: String,
) -> Result<()> {
    if !valid_id(&device_id) {
        return Err(AppError::invalid("设备标识无效"));
    }
    let _guard = sync.gate.lock().await;
    let (url, token, _) = connected(&db, &sync).await?;
    let route = format!("v1/devices/{device_id}");
    send(
        sync.client(&url)
            .delete(url.join(&route).map_err(invalid_response)?)
            .bearer_auth(token),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn network_errors_distinguish_timeouts_from_connection_failures() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let client = Client::builder().no_proxy().build().unwrap();
        let error = client
            .get(format!("http://{address}/"))
            .timeout(std::time::Duration::from_millis(100))
            .send()
            .await
            .unwrap_err();
        let timeout = network_error(error);
        assert_eq!(timeout.code(), "SYNC_NETWORK");
        assert!(timeout.to_string().contains("请求超时"));
        server.abort();
        let _ = server.await;
        let error = client
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap_err();
        let connection = network_error(error);
        assert_eq!(connection.code(), "SYNC_NETWORK");
        assert!(connection.to_string().contains("无法连接同步服务"));
    }

    #[test]
    fn service_addresses_protect_credentials() {
        for url in [
            "https://example.test",
            "http://127.0.0.1:8787/",
            "http://[::1]:8787",
            "http://localhost:8787",
        ] {
            assert!(service_url(url).is_ok(), "{url}");
        }
        for url in [
            "http://example.test",
            "https://example.test/sync",
            "https://user:secret@example.test/",
            "https://example.test/?token=x",
            "https://example.test/#x",
        ] {
            assert!(service_url(url).is_err(), "{url}");
        }
        let a = generate_secret().unwrap();
        let b = generate_secret().unwrap();
        assert!(valid_token(&a) && valid_token(&b));
        assert_ne!(a, b);
    }

    #[tokio::test]
    #[ignore = "requires an isolated fresh v1 service and a native system keyring"]
    async fn claim_join_and_reconnect_using_real_service() {
        let url = std::env::var("WCB_SYNC_TEST_URL").unwrap();
        let setup = std::env::var("WCB_SYNC_TEST_SETUP").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let first_db = Workspace::open(&dir.path().join("first.sqlite")).unwrap();
        let peer_db = Workspace::open(&dir.path().join("peer.sqlite")).unwrap();
        let sync = SyncConnection::new().unwrap();
        let restore_binding = connect(
            &first_db,
            &sync,
            &url,
            "测试设备一",
            ConnectWith::Claim,
            &setup,
        )
        .await
        .unwrap();
        let first_key = restore_binding.key(&first_db).unwrap();
        let token = Credential::read(&first_key).unwrap().active.unwrap();
        assert!(valid_token(&token));
        first_db
            .write(|tx| {
                tx.execute("DELETE FROM sync_binding", [])?;
                Ok(())
            })
            .unwrap();
        let first = connect(
            &first_db,
            &sync,
            &url,
            "测试设备一",
            ConnectWith::Claim,
            &setup,
        )
        .await
        .unwrap();
        assert_eq!(first.device_id, restore_binding.device_id);
        assert_eq!(Credential::read(&first_key).unwrap().active, Some(token));
        let (base, authenticated, _) = connected(&first_db, &sync).await.unwrap();
        let access_key = create_access_key(&first_db, &sync).await.unwrap();
        let peer = connect(
            &peer_db,
            &sync,
            &url,
            "测试设备二",
            ConnectWith::Join,
            &access_key,
        )
        .await
        .unwrap();
        let peer_key = peer.key(&peer_db).unwrap();
        let devices = fetch_devices(&sync.http, &base, &authenticated)
            .await
            .unwrap();
        assert_eq!(devices.devices.len(), 2);
        assert_ne!(peer.device_id, first.device_id);
        let route = format!("v1/devices/{}", peer.device_id);
        send(
            sync.http
                .delete(base.join(&route).unwrap())
                .bearer_auth(&authenticated),
        )
        .await
        .unwrap();
        let token = Credential::read(&peer_key).unwrap().active.unwrap();
        let error = fetch_devices(&sync.http, &base, &token)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code(), "SYNC_CREDENTIAL");
        assert_eq!(
            connect(
                &peer_db,
                &sync,
                &url,
                "测试设备二",
                ConnectWith::Join,
                &"0".repeat(64)
            )
            .await
            .err()
            .unwrap()
            .code(),
            "SYNC_CODE"
        );
        let pending = Credential::read(&peer_key).unwrap().pending.unwrap();
        let reconnected = connect(
            &peer_db,
            &sync,
            &url,
            "测试设备二",
            ConnectWith::Join,
            &access_key,
        )
        .await
        .unwrap();
        assert_ne!(reconnected.device_id, peer.device_id);
        assert_eq!(Credential::read(&peer_key).unwrap().active, Some(pending));
        first_db
            .write(|tx| {
                tx.execute("UPDATE sync_binding SET epoch='old' WHERE id=1", [])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            connected(&first_db, &sync).await.unwrap_err().code(),
            "SYNC_PAUSED"
        );
        assert!(Binding::read(&first_db).unwrap().unwrap().paused);
        first_key.delete_credential().unwrap();
        peer_key.delete_credential().unwrap();
    }
}
