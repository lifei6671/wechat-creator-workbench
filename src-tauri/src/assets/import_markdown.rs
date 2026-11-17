use super::{Assets, MAX_BYTES, local_error, references, s3::Profile};
use crate::db::{AppError, Result, Workspace};
use futures_util::{StreamExt, stream};
use std::{collections::BTreeMap, path::Path};
use tokio::io::AsyncReadExt;
use url::Url;

impl Assets {
    pub(crate) async fn import_markdown_images(
        &self,
        db: &Workspace,
        markdown: &str,
        directory: &Path,
    ) -> Result<(String, usize)> {
        let running = db.running_lifetime();
        let download_remote = db.read_running(Profile::automatic)?.is_some();
        tokio::select! {
            biased;
            () = running.cancelled() => Err(AppError::new("EXIT_PENDING", "正在保存并退出")),
            result = self.download_markdown_images(db, markdown, directory, download_remote) => result,
        }
    }

    async fn download_markdown_images(
        &self,
        db: &Workspace,
        markdown: &str,
        directory: &Path,
        download_remote: bool,
    ) -> Result<(String, usize)> {
        let sources = references::urls(markdown)?;
        let root = tokio::fs::canonicalize(directory).await.ok();
        let base = Url::from_directory_path(directory).ok();
        let downloads = stream::iter(
            sources
                .into_iter()
                .filter(|url| !url.starts_with("asset://") && (download_remote || !is_http(url))),
        )
        .map(|source| {
            let root = root.as_deref();
            let base = base.as_ref();
            async move {
                let imported = if is_http(&source) {
                    self.localize(db, &source).await
                } else {
                    self.import_relative_image(db, root, base, &source).await
                };
                (source, imported)
            }
        })
        .buffer_unordered(4);
        let mut downloads = std::pin::pin!(downloads);
        let mut replacements = BTreeMap::new();
        let mut unavailable = 0;
        while let Some((source, imported)) = downloads.next().await {
            match imported {
                Ok(image) if image != source => {
                    replacements.insert(source, image);
                }
                Ok(_) => {}
                Err(_) => unavailable += 1,
            }
        }
        let edits = references::image_edits(markdown, |url| Ok(replacements.get(url).cloned()))?;
        Ok((references::apply_image_edits(markdown, edits), unavailable))
    }

    async fn import_relative_image(
        &self,
        db: &Workspace,
        root: Option<&Path>,
        base: Option<&Url>,
        source: &str,
    ) -> Result<String> {
        let path = base
            .filter(|_| !source.starts_with(['/', '\\', '#']) && Url::parse(source).is_err())
            .and_then(|base| base.join(source).ok())
            .and_then(|url| url.to_file_path().ok())
            .ok_or_else(|| AppError::invalid("本地图片必须位于 Markdown 文件所在目录"))?;
        let path = tokio::fs::canonicalize(path).await.map_err(local_error)?;
        if !root.is_some_and(|root| path.starts_with(root))
            || !tokio::fs::metadata(&path)
                .await
                .map_err(local_error)?
                .is_file()
        {
            return Err(AppError::invalid("本地图片必须位于 Markdown 文件所在目录"));
        }
        let file = tokio::fs::File::open(&path).await.map_err(local_error)?;
        let mut bytes = Vec::new();
        file.take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(local_error)?;
        let name = path
            .file_name()
            .expect("an opened image has a file name")
            .to_string_lossy();
        Ok(format!("asset://{}", self.import(db, &name, &bytes)?))
    }
}

fn is_http(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}
