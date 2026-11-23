use super::restore::{PendingRestore, file_error, make_snapshot, prepare_file};
use crate::db::{AppError, Result, workspace_id};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};
use tempfile::{Builder, NamedTempFile};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

fn archive_error(error: zip::result::ZipError) -> AppError {
    AppError::new("MIGRATION_ZIP", format!("无法处理工作区迁移包：{error}"))
}

fn assets(database: &Path) -> Result<Vec<(String, String, bool)>> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = db.prepare(
        "SELECT DISTINCT relative_path,sha256,EXISTS (
            SELECT 1 FROM asset_locations WHERE asset_locations.sha256=assets.sha256
            AND uploaded_at IS NOT NULL AND deleted_at IS NULL
         ) FROM assets WHERE relative_path IS NOT NULL",
    )?;
    let sources = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(sources.collect::<rusqlite::Result<_>>()?)
}

fn write_entry(archive: &mut ZipWriter<&mut File>, name: &str, path: &Path) -> Result<()> {
    archive
        .start_file(name, SimpleFileOptions::default().large_file(true))
        .map_err(archive_error)?;
    let mut source = File::open(path).map_err(file_error)?;
    io::copy(&mut source, archive).map_err(file_error)?;
    Ok(())
}

pub(super) fn export(
    database: &Path,
    stage: &Path,
    workspace: &str,
    output: &Path,
    preferences: &BTreeMap<String, serde_json::Value>,
) -> Result<()> {
    write_archive(database, stage, workspace, output, preferences, false)
}

pub(super) fn export_recovery(
    database: &Path,
    stage: &Path,
    workspace: &str,
    output: &Path,
) -> Result<()> {
    write_archive(database, stage, workspace, output, &BTreeMap::new(), true)
}

fn write_archive(
    database: &Path,
    stage: &Path,
    workspace: &str,
    output: &Path,
    preferences: &BTreeMap<String, serde_json::Value>,
    recovery: bool,
) -> Result<()> {
    let draft = NamedTempFile::new_in(stage).map_err(file_error)?;
    make_snapshot(database, draft.path(), workspace)?;
    let root = database.with_file_name("assets");
    if recovery {
        let snapshot = Connection::open(draft.path())?;
        let mut cached = snapshot.prepare(
            "SELECT DISTINCT a.relative_path FROM assets a JOIN sync_revisions r
              ON r.entity_type='asset' AND r.entity_id=a.id
             WHERE a.relative_path IS NOT NULL
               AND NOT EXISTS(SELECT 1 FROM sync_dirty d WHERE d.entity_type='asset' AND d.entity_id=a.id)",
        )?;
        let paths = cached
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for path in paths {
            if !root.join(&path).try_exists().map_err(file_error)? {
                snapshot.execute(
                    "UPDATE assets SET relative_path=NULL WHERE relative_path=?1
                     AND EXISTS(SELECT 1 FROM sync_revisions r WHERE r.entity_type='asset' AND r.entity_id=assets.id)
                     AND NOT EXISTS(SELECT 1 FROM sync_dirty d WHERE d.entity_type='asset' AND d.entity_id=assets.id)",
                    [&path],
                )?;
            }
        }
    }
    if !preferences.is_empty() {
        let snapshot =
            Connection::open_with_flags(draft.path(), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        snapshot.execute(
            "INSERT OR REPLACE INTO app_settings VALUES ('migration_preferences',?1)",
            [serde_json::to_string(preferences).expect("preferences are serializable")],
        )?;
    }
    let parent = output
        .parent()
        .ok_or_else(|| AppError::invalid("请选择有效的迁移包保存目录"))?;
    let mut packed = NamedTempFile::new_in(parent).map_err(file_error)?;
    let mut archive = ZipWriter::new(packed.as_file_mut());
    write_entry(&mut archive, "content.db", draft.path())?;
    for (path, hash, hosted) in assets(draft.path())? {
        let source = root.join(&path);
        if hosted && !source.try_exists().map_err(file_error)? {
            continue;
        }
        verify_asset(&source, &hash)?;
        write_entry(&mut archive, &format!("assets/{path}"), &source)?;
    }
    archive.finish().map_err(archive_error)?;
    packed.as_file().sync_all().map_err(file_error)?;
    packed
        .persist(output)
        .map_err(|error| file_error(error.error))?;
    Ok(())
}

fn extract(
    archive: &mut ZipArchive<File>,
    name: &str,
    target: &mut File,
    limit: u64,
) -> Result<()> {
    let entry = archive.by_name(name).map_err(archive_error)?;
    if !entry.is_file() || entry.size() > limit {
        return Err(AppError::invalid("迁移包包含无效文件"));
    }
    if io::copy(&mut entry.take(limit.saturating_add(1)), target).map_err(file_error)? > limit {
        return Err(AppError::invalid("迁移包中的文件超出限制"));
    }
    target.sync_all().map_err(file_error)
}

pub(super) fn prepare(path: &Path, stage: &Path, incoming: &Path) -> Result<PendingRestore> {
    let mut archive =
        ZipArchive::new(File::open(path).map_err(file_error)?).map_err(archive_error)?;
    let mut draft = NamedTempFile::new_in(stage).map_err(file_error)?;
    extract(&mut archive, "content.db", draft.as_file_mut(), u64::MAX)?;
    let database = Connection::open_with_flags(draft.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let workspace = workspace_id(&database)?;
    drop(database);
    let folder = Builder::new()
        .prefix("migration-")
        .tempdir_in(stage)
        .map_err(file_error)?;
    let staging = folder
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let pending = PendingRestore {
        workspace,
        name: "工作区迁移包".into(),
        migration: Some(staging),
    };
    prepare_file(draft.path(), &pending)?;
    for (name, hash, hosted) in assets(draft.path())? {
        let entry = format!("assets/{name}");
        if hosted && archive.index_for_name(&entry).is_none() {
            continue;
        }
        let target = folder.path().join(&name);
        fs::create_dir_all(target.parent().unwrap()).map_err(file_error)?;
        let mut file = File::create(&target).map_err(file_error)?;
        extract(&mut archive, &entry, &mut file, 20 * 1024 * 1024)?;
        drop(file);
        verify_asset(&target, &hash)?;
    }
    draft
        .persist(incoming)
        .map_err(|error| file_error(error.error))?;
    let _ = folder.keep();
    Ok(pending)
}

fn verify_asset(path: &Path, hash: &str) -> Result<()> {
    let mut file = File::open(path).map_err(|error| {
        AppError::new(
            "MIGRATION_ASSET",
            format!(
                "无法读取素材 {}：{error}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = match file.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(file_error(error)),
        };
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if hex::encode(digest.finalize()) != hash {
        return Err(AppError::new("MIGRATION_ASSET", "迁移包中的素材校验失败"));
    }
    Ok(())
}

pub(super) fn install_assets(stage: &Path, root: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(stage).min_depth(1) {
        let entry = entry.map_err(|error| AppError::new("MIGRATION_ASSET", error.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(stage)
            .expect("asset is within the stage");
        let target: PathBuf = root.join(relative);
        let hash = target.file_stem().unwrap().to_string_lossy();
        verify_asset(entry.path(), &hash)?;
        if target.try_exists().map_err(file_error)? {
            verify_asset(&target, &hash)?;
            continue;
        }
        let parent = target.parent().unwrap();
        fs::create_dir_all(parent).map_err(file_error)?;
        let mut file = NamedTempFile::new_in(parent).map_err(file_error)?;
        io::copy(
            &mut File::open(entry.path()).map_err(file_error)?,
            file.as_file_mut(),
        )
        .map_err(file_error)?;
        file.as_file().sync_all().map_err(file_error)?;
        file.persist_noclobber(target)
            .map_err(|error| file_error(error.error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{assets::Assets, backup::restore::Files, db::Workspace};
    use std::io::Cursor;

    #[test]
    fn migrated_asset_hashes_keep_their_streaming_sha256_representation() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("large-asset");
        let bytes: Vec<_> = (0..=255_u8).cycle().take(256 * 513).collect();
        fs::write(&path, &bytes).unwrap();
        verify_asset(
            &path,
            "91f86bc16210e6eab1715b5e77465cc1a906243e758bcecb884060dbe9a26fe3",
        )
        .unwrap();
        fs::write(&path, &bytes[1..]).unwrap();
        assert_eq!(
            verify_asset(
                &path,
                "91f86bc16210e6eab1715b5e77465cc1a906243e758bcecb884060dbe9a26fe3"
            )
            .unwrap_err()
            .code(),
            "MIGRATION_ASSET"
        );
    }

    #[test]
    fn workspace_archive_restores_settings_and_original_assets_into_another_directory() {
        let old = tempfile::tempdir().unwrap();
        let source_files = Files::new(old.path()).unwrap();
        let (source, _) = source_files.open().unwrap();
        let identity = source.read(workspace_id).unwrap();
        source.set_setting("migration_test", &"kept").unwrap();
        let media = Assets::new(old.path().join("assets"), &source).unwrap();
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(5, 5)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let bytes = png.into_inner();
        media.import(&source, "test.png", &bytes).unwrap();
        let package = old.path().join("migration.zip");
        export(
            &source_files.database,
            &source_files.stage,
            &identity,
            &package,
            &BTreeMap::from([("appearance".into(), serde_json::json!("dark"))]),
        )
        .unwrap();

        let new = tempfile::tempdir().unwrap();
        let destination = Files::new(new.path()).unwrap();
        drop(Workspace::open(&destination.database).unwrap());
        let pending = prepare(&package, &destination.stage, &destination.incoming).unwrap();
        assert!(!new.path().join("assets").exists());
        destination.write_marker(&pending).unwrap();
        let (restored, notice) = destination.open().unwrap();
        assert!(!notice.unwrap().failed);
        assert_eq!(restored.read(workspace_id).unwrap(), identity);
        assert_eq!(
            restored
                .setting::<String>("migration_test")
                .unwrap()
                .as_deref(),
            Some("kept")
        );
        assert_eq!(
            restored
                .setting::<serde_json::Value>("migration_preferences")
                .unwrap()
                .unwrap()["appearance"],
            "dark"
        );
        let (relative, _, _) = &assets(&destination.database).unwrap()[0];
        assert_eq!(
            fs::read(new.path().join("assets").join(relative)).unwrap(),
            bytes
        );
    }

    #[test]
    fn workspace_archive_allows_missing_originals_only_with_a_hosted_copy() {
        let old = tempfile::tempdir().unwrap();
        let files = Files::new(old.path()).unwrap();
        let (source, _) = files.open().unwrap();
        let identity = source.read(workspace_id).unwrap();
        let media = Assets::new(old.path().join("assets"), &source).unwrap();
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(6, 6)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        media.import(&source, "hosted.png", png.get_ref()).unwrap();
        let (name, hash, _) = &assets(&files.database).unwrap()[0];
        fs::remove_file(old.path().join("assets").join(name)).unwrap();
        let package = old.path().join("migration.zip");
        let save = || {
            export(
                &files.database,
                &files.stage,
                &identity,
                &package,
                &BTreeMap::new(),
            )
        };
        assert_eq!(save().unwrap_err().code(), "MIGRATION_ASSET");
        assert!(!package.exists());

        source.write(|tx| {
            tx.execute("INSERT INTO storage_profiles VALUES ('cdn','images','https://s3.example.test','auto','images','','https://cdn.example.test','unused')", [])?;
            let key = format!("{identity}/2026-{hash}.png");
            tx.execute("INSERT INTO asset_locations (sha256,storage_profile_id,object_key,public_url,uploaded_at) VALUES (?1,'cdn',?2,?3,1)", rusqlite::params![hash, key, format!("https://cdn.example.test/{key}")])?;
            Ok(())
        }).unwrap();
        save().unwrap();
        prepare(&package, &files.stage, &files.incoming).unwrap();
        assert_eq!(
            assets(&files.incoming).unwrap(),
            vec![(name.clone(), hash.clone(), true)]
        );
    }
}
