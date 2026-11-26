use super::ReviewService;
use crate::db::{AppError, Result, Workspace};
use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::State;

const SETTINGS: &str = "review_zhuque";
const PURPOSE: &str = "review-zhuque-makers";

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Settings {
    pub(super) enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    enabled: bool,
    has_key: bool,
    revision: u64,
    max_text_bytes: usize,
}

pub(super) fn authorization(key: &str) -> Result<HeaderValue> {
    let mut value = HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| AppError::invalid("API Key 含有无效字符"))?;
    value.set_sensitive(true);
    Ok(value)
}

fn read_key(entry: &keyring::Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(crate::secrets::error(error)),
    }
}

pub(super) fn load(db: &Workspace) -> Result<Settings> {
    Ok(db.setting(SETTINGS)?.unwrap_or_default())
}

pub(super) fn credential(db: &Workspace) -> Result<HeaderValue> {
    let key = read_key(&crate::secrets::entry(db, PURPOSE)?)?
        .filter(|key| !key.is_empty())
        .ok_or_else(|| AppError::new("REVIEW_CONFIG", "请先配置朱雀 API Key"))?;
    authorization(&key)
}

fn view(db: &Workspace, service: &ReviewService) -> Result<SettingsView> {
    Ok(SettingsView {
        enabled: load(db)?.enabled,
        has_key: read_key(&crate::secrets::entry(db, PURPOSE)?)?.is_some(),
        revision: service.revision.load(Ordering::SeqCst),
        max_text_bytes: super::zhuque::MAX_TEXT_BYTES,
    })
}

#[tauri::command]
pub fn review_settings(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
) -> Result<SettingsView> {
    view(&db, &service)
}

#[tauri::command]
pub fn review_save_settings(
    db: State<'_, Workspace>,
    service: State<'_, ReviewService>,
    enabled: bool,
    api_key: Option<String>,
) -> Result<SettingsView> {
    save(&db, &service, enabled, api_key.as_deref())
}

pub(super) fn save(
    db: &Workspace,
    service: &ReviewService,
    enabled: bool,
    api_key: Option<&str>,
) -> Result<SettingsView> {
    let _guard = service
        .configuration
        .lock()
        .expect("review configuration lock poisoned");
    let key = api_key.map(str::trim);
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        authorization(key)?;
    }
    let entry = crate::secrets::entry(db, PURPOSE)?;
    db.set_setting_with(SETTINGS, &Settings { enabled }, || {
        if let Some(key) = key {
            if key.is_empty() {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => (),
                    Err(error) => return Err(crate::secrets::error(error)),
                }
            } else {
                entry.set_password(key).map_err(crate::secrets::error)?;
            }
        }
        Ok(())
    })?;
    service.revision.fetch_add(1, Ordering::SeqCst);
    view(db, service)
}
