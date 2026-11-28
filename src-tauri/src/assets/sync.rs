use super::{AssetFile, Assets, image_header, local_error};
use crate::db::{AppError, Result, Workspace};
use image::ImageFormat;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sha256: Option<String>,
    pub bytes: Option<i64>,
    mime_type: Option<String>,
    kind: String,
    source_key: Option<String>,
    #[serde(default)]
    created_at: i64,
    name: String,
    width: Option<i64>,
    height: Option<i64>,
    #[serde(default)]
    retain_on_exit: bool,
}

impl Snapshot {
    pub(crate) fn relative(&self) -> Result<Option<String>> {
        let Some(hash) = self.sha256.as_deref() else {
            return Ok(None);
        };
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(AppError::invalid("素材哈希无效"));
        }
        let format = match self.mime_type.as_deref() {
            Some("image/png") => ImageFormat::Png,
            Some("image/jpeg") => ImageFormat::Jpeg,
            Some("image/gif") => ImageFormat::Gif,
            Some("image/webp") => ImageFormat::WebP,
            _ => return Err(AppError::invalid("云端素材的图片格式不受支持")),
        };
        Ok(Some(format!(
            "{}/{}/{}.{}",
            &hash[..2],
            &hash[2..4],
            hash,
            format.extensions_str()[0]
        )))
    }
}

pub fn snapshot(conn: &Connection, id: &str) -> Result<Option<Snapshot>> {
    Ok(conn.query_row(
        "SELECT sha256,bytes,mime_type,kind,source_key,created_at,name,width,height,retain_on_exit FROM assets WHERE id=?1",
        [id], |row| Ok(Snapshot {
            sha256: row.get(0)?, bytes: row.get(1)?, mime_type: row.get(2)?,
            kind: row.get(3)?, source_key: row.get(4)?, created_at: row.get(5)?,
            name: row.get(6)?, width: row.get(7)?, height: row.get(8)?, retain_on_exit: row.get(9)?,
        })
    ).optional()?)
}

pub fn apply(conn: &Connection, id: &str, asset: &Snapshot) -> Result<()> {
    crate::image_canvas::guard_asset_change(conn,id,asset.sha256.as_deref())?;
    if let Some(previous)=snapshot(conn,id)? && previous.sha256.is_some()
        && crate::image_canvas::asset_referenced(conn,id)?
        && (previous.bytes!=asset.bytes || previous.mime_type!=asset.mime_type || previous.width!=asset.width
            || previous.height!=asset.height || previous.kind!=asset.kind || previous.source_key!=asset.source_key) {
        return Err(AppError::new("IMAGE_ASSET_CONFLICT","原图已被图片工程引用，无法替换其格式或尺寸"));
    }
    let relative = asset.relative()?;
    conn.execute(
        "INSERT INTO assets (id,sha256,bytes,mime_type,kind,source_key,created_at,name,width,height,retain_on_exit,relative_path)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256,bytes=excluded.bytes,mime_type=excluded.mime_type,
           width=excluded.width,height=excluded.height,relative_path=excluded.relative_path,
           name=excluded.name,retain_on_exit=excluded.retain_on_exit",
        params![id,asset.sha256,asset.bytes,asset.mime_type,asset.kind,asset.source_key,asset.created_at,
            asset.name,asset.width,asset.height,asset.retain_on_exit,relative],
    )?;
    Ok(())
}

impl Assets {
    pub(crate) async fn prepare_image_project_export(&self,db:&Workspace)->Result<()> {
        let ids=db.read(crate::image_canvas::required_asset_ids)?;
        for id in ids {self.read_canvas_original(db,&format!("asset://{id}")).await?;}
        let staged=db.read(|conn|{
            let mut query=conn.prepare("SELECT relative_path,sha256 FROM image_render_staging")?;
            Ok(query.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?)
        })?;
        for (path,hash) in staged {crate::backup::verify_asset_file(&self.root.join(path),&hash)?;}
        Ok(())
    }
    pub(crate) async fn prepare_synced_workspace_export(&self, db: &Workspace) -> Result<()> {
        self.prepare_image_project_export(db).await?;
        let required=db.read(super::version_cleanup::backup_hashes)?;
        for hash in &required {
            let id=db.read(|conn|Ok(conn.query_row("SELECT id FROM assets WHERE sha256=?1 ORDER BY id LIMIT 1",[hash],|r|r.get::<_,String>(0))?))?;
            self.read_canvas_original(db,&format!("asset://{id}")).await?;
        }
        let required=serde_json::to_string(&required).expect("hash list serializes");
        let ids = db.read(|conn| {
            let mut query = conn.prepare(
                "SELECT a.id FROM assets a JOIN sync_revisions r ON r.entity_type='asset' AND r.entity_id=a.id
                 WHERE a.relative_path IS NOT NULL AND (NOT EXISTS (
                    SELECT 1 FROM asset_locations l WHERE l.sha256=a.sha256
                      AND l.uploaded_at IS NOT NULL AND l.deleted_at IS NULL))
                   AND (a.sha256 IN(SELECT value FROM json_each(?1)) OR NOT EXISTS(SELECT 1 FROM image_gc_remote g
                   WHERE g.sha256=a.sha256 AND g.state IN ('retired','expired') AND g.payload_json->>'$.current'=1 AND g.payload_json->>'$.backend'='private') AND NOT EXISTS(SELECT 1 FROM image_version_cleanup c WHERE c.sha256=a.sha256 AND c.state='expired'))",
            )?;
            Ok(query.query_map([required], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
        })?;
        for id in ids {
            let file = db.read(|conn| super::by_id(conn, &id))?;
            if let Some(relative) = file.path.as_deref()
                && !self.root.join(relative).try_exists().map_err(local_error)?
            {
                self.read_synced_file(db, &file).await?;
            }
        }
        Ok(())
    }

    pub async fn sync_upload_bytes(
        &self,
        id: &str,
        asset: &Snapshot,
        db: &Workspace,
    ) -> Result<Vec<u8>> {
        let file = AssetFile {
            id: id.into(),
            hash: asset.sha256.clone(),
            path: asset.relative()?,
        };
        let bytes = self.read_without_session(db, &file).await?;
        if Some(hex::encode(Sha256::digest(&bytes))) != asset.sha256
            || i64::try_from(bytes.len()).ok() != asset.bytes
        {
            return Err(AppError::new(
                "SYNC_ASSET",
                "素材原图缺失或与同步快照不一致",
            ));
        }
        Ok(bytes)
    }

    pub(super) async fn read_synced_file(
        &self,
        db: &Workspace,
        file: &AssetFile,
    ) -> Result<Option<Vec<u8>>> {
        let (Some(hash), Some(relative)) = (&file.hash, &file.path) else {
            return Ok(None);
        };
        let size = db.read(|conn| {
            Ok(conn.query_row(
                "SELECT a.bytes FROM assets a JOIN sync_revisions r ON r.entity_type='asset' AND r.entity_id=a.id
                 WHERE a.id=?1 AND a.sha256=?2 AND r.deleted=0",
                params![file.id, hash], |row| row.get::<_, i64>(0),
            ).optional()?)
        })?;
        let Some(size) = size else {
            return Ok(None);
        };
        let bytes = crate::sync::synced_blob(db, hash, size).await?;
        let (format, _, _) = image_header(&bytes)?;
        if relative.rsplit('.').next() != Some(format.extensions_str()[0]) {
            return Err(AppError::new("SYNC_ASSET", "同步图片格式与记录不一致"));
        }
        self.cache_original(relative,&bytes)?;
        Ok(Some(bytes))
    }
    pub(crate) fn cache_original(&self, relative: &str, bytes: &[u8]) -> Result<()> {
        let path = self.root.join(relative);
        std::fs::create_dir_all(path.parent().expect("asset path has a parent"))
            .map_err(local_error)?;
        let mut staged =
            tempfile::NamedTempFile::new_in(path.parent().expect("asset path has a parent"))
                .map_err(local_error)?;
        staged.write_all(bytes).map_err(local_error)?;
        staged
            .persist(path)
            .map_err(|error| local_error(error.error))?;
        Ok(())
    }

}
