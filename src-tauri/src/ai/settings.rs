use super::{authorization, read_key};
use crate::db::{AppError, Result, Workspace};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use url::{Host, Url};
use uuid::Uuid;

const SETTINGS: &str = "ai_targets";
const LEGACY_SETTINGS: &str = "ai_config";
const LEGACY_MODEL_ID: &str = "legacy";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Codex,
    ClaudeCode,
}

impl Agent {
    pub const ALL: [Self; 2] = [Self::Codex, Self::ClaudeCode];

    pub fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
        }
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Target {
    Agent(Agent),
    Model(String),
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    Local,
    Custom,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub endpoint: String,
    pub model: String,
    pub timeout_seconds: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    id: String,
    kind: ModelKind,
    #[serde(default)]
    name: String,
    #[serde(flatten)]
    pub config: ModelConfig,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub default_target: Option<Target>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub preferences: Preferences,
    models: Vec<Model>,
}

#[derive(Serialize)]
pub struct AgentStatus {
    id: Agent,
    installed: bool,
}

#[derive(Serialize)]
pub struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    agents: Vec<AgentStatus>,
}

pub(super) fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host == "localhost",
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

impl ModelConfig {
    pub(super) fn validate(mut self, kind: ModelKind) -> Result<Self> {
        let mut url = Url::parse(self.endpoint.trim())
            .map_err(|_| AppError::invalid("请输入有效的模型接口地址"))?;
        let on_device = loopback(&url);
        if (url.scheme() != "https" && !(url.scheme() == "http" && on_device))
            || !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AppError::invalid(
                "请输入不含凭据、参数和片段的 HTTPS 接口地址，本机模型可用 HTTP",
            ));
        }
        if kind == ModelKind::Local && !on_device {
            return Err(AppError::invalid("本地模型须使用 localhost 或本机回环地址"));
        }
        self.model = self.model.trim().to_owned();
        if self.model.is_empty() || self.model.len() > 512 {
            return Err(AppError::invalid("请输入有效的模型名"));
        }
        if !(1..=180).contains(&self.timeout_seconds) {
            return Err(AppError::invalid("超时须为 1 至 180 秒"));
        }
        let path = url.path().trim_end_matches('/');
        if !path.ends_with("/chat/completions") {
            let path = format!("{path}/chat/completions");
            url.set_path(&path);
        }
        self.endpoint = url.into();
        Ok(self)
    }
}

impl Model {
    pub fn credential(&self, db: &Workspace) -> Result<keyring::Entry> {
        let endpoint = Sha256::digest(self.config.endpoint.as_bytes());
        let purpose = if self.id == LEGACY_MODEL_ID {
            format!("ai-{endpoint:x}")
        } else {
            format!("ai-{}-{endpoint:x}", self.id)
        };
        crate::secrets::entry(db, &purpose)
    }
}

impl Settings {
    pub fn load(db: &Workspace) -> Result<Self> {
        if let Some(settings) = db.setting(SETTINGS)? {
            return Ok(settings);
        }
        let model = db
            .setting::<ModelConfig>(LEGACY_SETTINGS)?
            .map(|config| Model {
                id: LEGACY_MODEL_ID.into(),
                name: String::new(),
                kind: if Url::parse(&config.endpoint).is_ok_and(|url| loopback(&url)) {
                    ModelKind::Local
                } else {
                    ModelKind::Custom
                },
                config,
            });
        Ok(Self {
            preferences: Preferences {
                enabled: model.is_some(),
                default_target: model.as_ref().map(|model| Target::Model(model.id.clone())),
            },
            models: model.into_iter().collect(),
        })
    }

    pub fn model(&self, id: &str) -> Result<&Model> {
        self.models
            .iter()
            .find(|model| model.id == id)
            .ok_or_else(|| AppError::new("AI_CONFIG", "找不到已保存的 AI 模型"))
    }

    fn view(self) -> SettingsView {
        SettingsView {
            settings: self,
            agents: Agent::ALL
                .into_iter()
                .map(|id| AgentStatus {
                    id,
                    installed: super::agent::executable(id).is_some(),
                })
                .collect(),
        }
    }

    fn save(self, db: &Workspace) -> Result<SettingsView> {
        db.set_setting(SETTINGS, &self)?;
        Ok(self.view())
    }
}

fn delete_key(entry: &keyring::Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(super::credential_error()),
    }
}

#[tauri::command]
pub fn ai_settings(db: State<'_, Workspace>) -> Result<SettingsView> {
    Ok(Settings::load(&db)?.view())
}

#[tauri::command]
pub async fn ai_agent_versions() -> [(Agent, Option<String>); 2] {
    let (codex, claude_code) = tokio::join!(
        super::agent::version(Agent::Codex),
        super::agent::version(Agent::ClaudeCode),
    );
    [(Agent::Codex, codex), (Agent::ClaudeCode, claude_code)]
}

#[tauri::command]
pub fn ai_save_preferences(
    db: State<'_, Workspace>,
    preferences: Preferences,
) -> Result<SettingsView> {
    let mut settings = Settings::load(&db)?;
    if let Some(Target::Model(id)) = &preferences.default_target {
        settings.model(id)?;
    }
    settings.preferences = preferences;
    settings.save(&db)
}

#[tauri::command]
pub fn ai_model_has_key(db: State<'_, Workspace>, id: String) -> Result<bool> {
    let settings = Settings::load(&db)?;
    Ok(read_key(&settings.model(&id)?.credential(&db)?)?.is_some())
}

#[tauri::command]
pub fn ai_save_model(
    db: State<'_, Workspace>,
    id: Option<String>,
    kind: ModelKind,
    name: String,
    config: ModelConfig,
    api_key: Option<String>,
) -> Result<SettingsView> {
    let mut settings = Settings::load(&db)?;
    let config = config.validate(kind)?;
    let name = name.trim().to_owned();
    if name.chars().count() > 80 {
        return Err(AppError::invalid("显示名称最多 80 个字"));
    }
    let previous = id.as_deref().map(|id| settings.model(id)).transpose()?;
    let model = Model {
        id: id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        kind,
        name,
        config,
    };
    let old_entry = previous
        .filter(|item| item.config.endpoint != model.config.endpoint)
        .map(|item| item.credential(&db))
        .transpose()?;
    let key = api_key.as_deref().map(str::trim);
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        authorization(key)?;
    }
    let new_entry = key.map(|_| model.credential(&db)).transpose()?;
    if let Some(existing) = settings.models.iter_mut().find(|item| item.id == model.id) {
        *existing = model;
    } else {
        settings.models.push(model);
    }
    db.set_setting_with(SETTINGS, &settings, || {
        if let Some((entry, key)) = new_entry.as_ref().zip(key) {
            if key.is_empty() {
                delete_key(entry)?;
            } else {
                entry
                    .set_password(key)
                    .map_err(|_| super::credential_error())?;
            }
        }
        if let Some(old_entry) = &old_entry
            && let Err(error) = delete_key(old_entry)
        {
            // The previous profile remains active if removing its old key fails.
            if let Some(new_entry) = &new_entry {
                delete_key(new_entry)?;
            }
            return Err(error);
        }
        Ok(())
    })?;
    Ok(settings.view())
}

#[tauri::command]
pub fn ai_delete_model(db: State<'_, Workspace>, id: String) -> Result<SettingsView> {
    let mut settings = Settings::load(&db)?;
    let entry = settings.model(&id)?.credential(&db)?;
    settings.models.retain(|model| model.id != id);
    if settings.preferences.default_target == Some(Target::Model(id)) {
        settings.preferences.default_target = None;
    }
    db.set_setting_with(SETTINGS, &settings, || delete_key(&entry))?;
    Ok(settings.view())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_the_legacy_default_and_starts_new_workspaces_disabled() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let empty = Settings::load(&db).unwrap();
        assert!(!empty.preferences.enabled);
        assert_eq!(empty.preferences.default_target, None);
        db.set_setting(
            LEGACY_SETTINGS,
            &ModelConfig {
                endpoint: "http://[::1]:11434/v1/chat/completions".into(),
                model: "qwen".into(),
                timeout_seconds: 37,
            },
        )
        .unwrap();

        let mut migrated = Settings::load(&db).unwrap();
        assert!(migrated.preferences.enabled);
        assert_eq!(
            migrated.preferences.default_target,
            Some(Target::Model(LEGACY_MODEL_ID.into()))
        );
        let model = migrated.model(LEGACY_MODEL_ID).unwrap();
        assert!(model.kind == ModelKind::Local);
        assert_eq!(model.config.model, "qwen");
        assert_eq!(model.config.timeout_seconds, 37);
        migrated.preferences.enabled = false;
        migrated.save(&db).unwrap();
        let reopened = Settings::load(&db).unwrap();
        assert!(!reopened.preferences.enabled);
        assert_eq!(
            reopened.model(LEGACY_MODEL_ID).unwrap().config.model,
            "qwen"
        );
    }

    #[test]
    fn provider_addresses_enforce_the_local_and_remote_boundaries() {
        let config = |endpoint: &str| ModelConfig {
            endpoint: endpoint.into(),
            model: "qwen".into(),
            timeout_seconds: 60,
        };
        assert!(
            config("http://127.0.0.1/v1/chat/completions")
                .validate(ModelKind::Local)
                .is_ok()
        );
        assert!(
            config("https://example.com/v1/chat/completions")
                .validate(ModelKind::Local)
                .is_err()
        );
        assert!(
            config("http://example.com/v1/chat/completions")
                .validate(ModelKind::Custom)
                .is_err()
        );
        assert!(
            config("https://example.com/v1/chat/completions")
                .validate(ModelKind::Custom)
                .is_ok()
        );
        assert!(
            config("https://key@example.com/v1/chat/completions")
                .validate(ModelKind::Custom)
                .is_err()
        );
        assert_eq!(
            config("https://example.com/v1/")
                .validate(ModelKind::Custom)
                .unwrap()
                .endpoint,
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn settings_are_not_saved_when_the_credential_change_fails() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let mut settings = Settings::load(&db).unwrap();
        settings.preferences.enabled = true;
        let result =
            db.set_setting_with(
                SETTINGS,
                &settings,
                || Err(super::super::credential_error()),
            );
        assert_eq!(result.unwrap_err().code(), "AI_KEYRING");
        assert!(!Settings::load(&db).unwrap().preferences.enabled);
    }
}
