#[cfg(any(windows, target_os = "macos", test))]
use crate::db::Workspace;
use crate::db::{AppError, Result};
#[cfg(any(windows, target_os = "macos", test))]
use rusqlite::params;
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[cfg(any(windows, target_os = "macos", test))]
use std::{fs, io::Write};
use std::{
    io,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, ipc::Response};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewKey {
    collection_id: String,
    node_id: String,
    url: String,
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn cache_root(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("canvas-previews").join("v1"))
        .map_err(|error| AppError::new("WEB_PREVIEW", format!("无法定位网页预览缓存：{error}")))
}

impl PreviewKey {
    fn path(&self, root: &Path) -> PathBuf {
        root.join(digest(&self.collection_id))
            .join(digest(&self.node_id))
            .join(format!("{}.png", digest(&self.url)))
    }
}

#[tauri::command]
pub(crate) async fn canvas_preview_cache_read(app: AppHandle, key: PreviewKey) -> Result<Response> {
    let path = key.path(&cache_root(&app)?);
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(Response::new(Vec::<u8>::new()))
        }
        Err(error) => Err(cache_error(error)),
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn save(app: &AppHandle, key: &PreviewKey, png: &[u8]) -> Result<()> {
    save_existing(&app.state::<Workspace>(), &cache_root(app)?, key, png)
}

#[cfg(any(windows, target_os = "macos", test))]
fn save_existing(db: &Workspace, root: &Path, key: &PreviewKey, png: &[u8]) -> Result<()> {
    // Serialize with node deletion so a late native capture cannot recreate an evicted cache.
    db.read(|conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_nodes
             WHERE id=?1 AND collection_id=?2 AND external_url=?3 AND kind='web')",
            params![key.node_id, key.collection_id, key.url],
            |row| row.get(0),
        )?;
        if exists {
            let path = key.path(root);
            let parent = path
                .parent()
                .expect("preview path contains its node directory");
            fs::create_dir_all(parent).map_err(cache_error)?;
            // tempfile uses MoveFileExW on Windows, which needs a verbatim path past MAX_PATH.
            let parent = parent.canonicalize().map_err(cache_error)?;
            let filename = path
                .file_name()
                .expect("preview path contains its PNG filename");
            let mut temporary = tempfile::NamedTempFile::new_in(&parent).map_err(cache_error)?;
            temporary.write_all(png).map_err(cache_error)?;
            temporary
                .persist(parent.join(filename))
                .map_err(|error| cache_error(error.error))?;
        }
        Ok(())
    })
}

pub(crate) async fn delete(app: &AppHandle, collection_id: &str, node_id: Option<&str>) {
    let result = async {
        let mut path = cache_root(app)?.join(digest(collection_id));
        if let Some(node_id) = node_id {
            path.push(digest(node_id));
        }
        match tokio::fs::remove_dir_all(path).await {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(cache_error(error)),
            _ => Ok(()),
        }
    }
    .await;
    if let Err(error) = result {
        eprintln!("Could not remove canvas preview cache: {error}");
    }
}

fn cache_error(error: io::Error) -> AppError {
    AppError::new("WEB_PREVIEW", format!("无法读写网页预览缓存：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_is_scoped_to_the_current_node_url_and_cannot_return_after_deletion() {
        let root = tempfile::tempdir().unwrap();
        let db = Workspace::open(&root.path().join("workspace.sqlite3")).unwrap();
        let cache = root.path().join("workspace".repeat(12));
        let mut key = PreviewKey {
            collection_id: "topic".into(),
            node_id: "web".into(),
            url: "https://one.test/".into(),
        };
        db.write(|tx| {
            tx.execute("INSERT INTO collections (id,title,created_at,updated_at) VALUES ('topic','预览',0,0)", [])?;
            tx.execute(
                "INSERT INTO collection_nodes (id,collection_id,kind,external_url,created_at,updated_at)
                 VALUES ('web','topic','web',?1,0,0)",
                [&key.url],
            )?;
            Ok(())
        }).unwrap();
        let path = key.path(&cache);
        save_existing(&db, &cache, &key, b"first").unwrap();
        save_existing(&db, &cache, &key, b"latest").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"latest");
        let original = std::mem::replace(&mut key.url, "https://two.test/".into());
        save_existing(&db, &cache, &key, b"wrong URL").unwrap();
        assert!(!key.path(&cache).exists());
        key.url = original;
        let owner = db.delete_collection_node(&key.node_id).unwrap();
        assert_eq!(owner.as_deref(), Some(key.collection_id.as_str()));
        fs::remove_file(&path).unwrap();
        save_existing(&db, &cache, &key, b"late capture").unwrap();
        assert!(!path.exists());
    }
}
