use crate::db::{AppError, Result, Workspace, workspace_id};

pub fn entry(db: &Workspace, purpose: &str) -> Result<keyring::Entry> {
    let workspace = db.read(workspace_id)?;
    keyring::Entry::new(
        "wechat-creator-workbench",
        &format!("{workspace}/{purpose}"),
    )
    .map_err(error)
}

pub fn error(_: keyring::Error) -> AppError {
    AppError::new("CREDENTIALS", "无法访问系统凭据")
}
