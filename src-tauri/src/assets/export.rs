use super::{AssetFile, Assets, by_id, local_error, publication_file, references};
use crate::db::{AppError, Result, Workspace};
use rusqlite::Connection;
use serde_json::json;
use std::{collections::BTreeMap, io::Write, path::Path};
use zip::{ZipWriter, write::SimpleFileOptions};

impl Assets {
    pub async fn export_markdown_file(
        &self,
        db: &Workspace,
        markdown: &str,
        path: &Path,
    ) -> Result<()> {
        let (rewritten, files) = db.read(|conn| prepare(self, conn, markdown))?;
        let parent = path.parent().expect("save dialog returns an absolute path");
        if !files.is_empty() {
            std::fs::create_dir_all(parent.join("assets")).map_err(local_error)?;
            for (name, file) in files {
                let bytes = self.read_export_file(db, &file, &name).await?;
                std::fs::write(parent.join(name), bytes).map_err(local_error)?;
            }
        }
        let mut output = tempfile::NamedTempFile::new_in(parent).map_err(local_error)?;
        output
            .write_all(rewritten.as_bytes())
            .map_err(local_error)?;
        output
            .persist(path)
            .map_err(|error| local_error(error.error))?;
        Ok(())
    }

    pub async fn export(&self, db: &Workspace, entry: &str, path: &Path) -> Result<()> {
        let (markdown, assets, metadata) = db.read(|conn| {
            let (title, body, kind, status, version, updated, cover): (String, String, String, String, i64, i64, Option<String>) = conn.query_row(
                "SELECT title,content_md,kind,status,version,updated_at,cover_asset_id FROM entries WHERE id=?1", [entry],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
            )?;
            let (markdown, mut assets) = prepare(self, conn, &body)?;
            let cover = cover.map(|id| add_file(self, conn, &mut assets, by_id(conn, &id)?)).transpose()?;
            let metadata = json!({"entryId": entry, "title": title, "kind": kind, "status": status,
                "version": version, "updatedAt": updated, "cover": cover});
            Ok((markdown, assets, metadata))
        })?;
        let mut temporary = tempfile::NamedTempFile::new_in(
            path.parent().expect("save dialog returns absolute path"),
        )
        .map_err(local_error)?;
        let mut zip = ZipWriter::new(temporary.as_file_mut());
        let options = SimpleFileOptions::default();
        zip.start_file("article.md", options).map_err(zip_error)?;
        zip.write_all(markdown.as_bytes()).map_err(local_error)?;
        zip.start_file("article.json", options).map_err(zip_error)?;
        zip.write_all(
            &serde_json::to_vec_pretty(&metadata).expect("export metadata is serializable"),
        )
        .map_err(local_error)?;
        for (name, asset) in assets {
            let bytes = self.read_export_file(db, &asset, &name).await?;
            zip.start_file(name, options).map_err(zip_error)?;
            zip.write_all(&bytes).map_err(local_error)?;
        }
        zip.finish().map_err(zip_error)?;
        temporary.persist(path).map_err(|e| local_error(e.error))?;
        Ok(())
    }
}

fn prepare(
    media: &Assets,
    conn: &Connection,
    markdown: &str,
) -> Result<(String, BTreeMap<String, AssetFile>)> {
    let mut assets = BTreeMap::new();
    let mut resolved = BTreeMap::new();
    let resolve = |url: &str| -> Result<Option<String>> {
        let file = publication_file(conn, url).map_err(|err| {
            if err.code() == "NOT_FOUND" {
                AppError::new(
                    "ASSET_MISSING",
                    format!("导出前请将这张图片导入素材库：{url}"),
                )
            } else {
                err
            }
        })?;
        let Some(file) = file else {
            return Ok(None);
        };
        let name = add_file(media, conn, &mut assets, file)?;
        resolved.insert(url.to_owned(), name.clone());
        Ok(Some(name))
    };
    let mut rewrite = references::image_edits(markdown, resolve)?;
    for (label, link) in pulldown_cmark::Parser::new(markdown)
        .reference_definitions()
        .iter()
    {
        if let Some(name) = resolved.get(&references::canonical_url(&link.dest)) {
            let title = link.title.as_deref().map_or_else(String::new, |title| {
                format!(" \"{}\"", title.replace('\\', "\\\\").replace('"', "\\\""))
            });
            rewrite.push((link.span.clone(), format!("[{label}]: {name}{title}")));
        }
    }
    Ok((references::apply_image_edits(markdown, rewrite), assets))
}

fn add_file(
    media: &Assets,
    conn: &Connection,
    assets: &mut BTreeMap<String, AssetFile>,
    file: AssetFile,
) -> Result<String> {
    let name = format!("assets/{}", media.export_name(conn, &file)?);
    assets.entry(name.clone()).or_insert(file);
    Ok(name)
}

fn zip_error(error: zip::result::ZipError) -> AppError {
    AppError::new(
        "EXPORT_FAILED",
        format!("无法生成 Markdown 压缩包：{error}"),
    )
}
