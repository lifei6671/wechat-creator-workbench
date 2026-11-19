use crate::{
    db::{AppError, Result, Workspace},
    secrets,
};
use reqwest::{Client, RequestBuilder, StatusCode};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;
use std::{fmt::Write, net::IpAddr, time::Duration};
use tauri::State;
use tokio::sync::Mutex;
use url::{Host, Url};

pub(crate) mod contents;
pub(crate) use contents::{finish_category_delete, record_category_delete, synced_blob};

pub struct SyncConnection {
    http: Client,
    local_http: Client,
    gate: Mutex<()>,
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
        })
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
        if meta.protocol_version != 1
            || !valid_id(&meta.server_instance_id)
            || !valid_id(&meta.sync_epoch)
        {
            return Err(AppError::new(
                "SYNC_PROTOCOL",
                "同步服务协议或实例标识不兼容",
            ));
        }
        if !meta.canvas_sync {
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
}

impl Binding {
    fn read(db: &Workspace) -> Result<Option<Self>> {
        db.read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT url,instance_id,epoch,device_id,paused FROM sync_binding WHERE id=1",
                    [],
                    |row| {
                        Ok(Self {
                            url: row.get(0)?,
                            instance_id: row.get(1)?,
                            epoch: row.get(2)?,
                            device_id: row.get(3)?,
                            paused: row.get(4)?,
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
    server_instance_id: String,
    sync_epoch: String,
    seed_status: String,
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

fn network_error(_: reqwest::Error) -> AppError {
    AppError::new("SYNC_NETWORK", "无法连接同步服务，请检查地址和网络")
}

fn invalid_response(_: impl std::fmt::Display) -> AppError {
    AppError::new("SYNC_PROTOCOL", "同步服务返回了无效的数据")
}

async fn send(request: RequestBuilder) -> Result<reqwest::Response> {
    let response = request.send().await.map_err(network_error)?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let code: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    let error = match code["error"].as_str() {
        Some("invalid_setup_secret") => AppError::new("SYNC_CODE", "认领密钥无效"),
        Some("invalid_access_key") => AppError::new("SYNC_CODE", "工作区接入密钥无效或已更换"),
        Some("invalid_recovery_key") => AppError::new("SYNC_CODE", "恢复密钥无效、已使用或已撤销"),
        Some("already_claimed") => AppError::new("SYNC_CLAIMED", "服务已认领，请使用接入密钥或恢复连接"),
        Some("device_required") => AppError::new(
            "SYNC_DEVICE_REQUIRED",
            "请保留首次上传设备和至少一台有效设备",
        ),
        Some("reset_required") => AppError::new("SYNC_RESET", "同步基线已失效，需重新建立"),
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
    db.write(|tx| {
        tx.execute("UPDATE sync_binding SET paused=1 WHERE id=1", [])?;
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
        pause(db)?;
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
            Win32::System::SystemInformation::{ComputerNamePhysicalDnsHostname, GetComputerNameExW},
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
    db: State<'_, Workspace>,
    sync: State<'_, SyncConnection>,
    url: String,
    name: String,
    method: ConnectWith,
    code: String,
    rebuild: Option<bool>,
) -> Result<Binding> {
    if rebuild == Some(true) {
        return register(&db, &sync, &url, &name, method, &code, true).await;
    }
    connect(&db, &sync, &url, &name, method, &code).await
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
    if !valid_device_name(name) || !valid_token(code) {
        return Err(AppError::invalid(
            "请填写设备名和 64 位十六进制密钥",
        ));
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
        pause(db)?;
        return Err(AppError::new(
            "SYNC_PAUSED",
            "同步服务身份已变化，连接已暂停",
        ));
    }
    match method {
        ConnectWith::Join => meta.require_workspace_access()?,
        ConnectWith::Recover => {
            meta.require_connection_recovery()?;
            if old.is_none() && meta.seed_status == "ready" {
                db.read(contents::require_empty)?;
            }
        }
        ConnectWith::Claim => {}
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
        id
    } else {
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
                ConnectWith::Claim => (
                    "v1/setup/claim",
                    json!({ "name": name, "setupSecret": code, "deviceToken": token }),
                ),
                ConnectWith::Join => (
                    "v1/devices/join",
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
    };
    db.write(|tx| {
        tx.execute(
            "INSERT INTO sync_binding (id,url,instance_id,epoch,device_id,paused) VALUES (1,?1,?2,?3,?4,?5)
             ON CONFLICT (id) DO UPDATE SET device_id=excluded.device_id,
               instance_id=excluded.instance_id,epoch=excluded.epoch,paused=excluded.paused",
            params![
                binding.url,
                binding.instance_id,
                binding.epoch,
                binding.device_id,
                binding.paused,
            ],
        )?;
        if rebuild {
            tx.execute_batch("DELETE FROM sync_bootstrap; UPDATE sync_progress SET bootstrap_cursor=NULL")?;
        }
        Ok(())
    })?;
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
        return Err(AppError::new("SYNC_PROTOCOL", "同步服务返回了无效的接入密钥"));
    }
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
