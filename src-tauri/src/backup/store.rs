use crate::{
    assets::s3::{S3Storage, http_base, sdk_error},
    db::{AppError, Result, Workspace},
    secrets,
};
use aws_sdk_s3::{primitives::ByteStream, types::Object};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path, time::Duration};
use uuid::Uuid;

pub use crate::assets::s3::Secret;

const SETTINGS: &str = "backup_target";
const NAMESPACE: &str = "wechat-creator-workbench";
const RETAIN: usize = 5;
const PAGE_SIZE: i32 = 1_000;
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
}

impl Target {
    fn validated(mut self) -> Result<Self> {
        self.endpoint = http_base(&self.endpoint, false)?;
        self.region = self.region.trim().to_owned();
        self.bucket = self.bucket.trim().to_owned();
        self.prefix = self.prefix.trim().trim_matches('/').to_owned();
        if self.region.is_empty()
            || self.bucket.is_empty()
            || !self
                .bucket
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
            || self
                .prefix
                .split('/')
                .any(|part| matches!(part, "." | ".."))
        {
            return Err(AppError::invalid("请填写有效的区域、桶名和对象前缀"));
        }
        Ok(self)
    }

    fn credential(&self, db: &Workspace) -> Result<keyring::Entry> {
        let scope = format!("{}\0{}\0{}", self.endpoint, self.bucket, self.prefix);
        secrets::entry(
            db,
            &format!("backup-{}", hex::encode(Sha256::digest(scope.as_bytes()))),
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub target: Option<Target>,
    pub has_key: bool,
}

pub fn settings(db: &Workspace) -> Result<Settings> {
    let target = db.setting::<Target>(SETTINGS)?;
    let has_key = if let Some(target) = &target {
        read_secret(&target.credential(db)?)?.is_some()
    } else {
        false
    };
    Ok(Settings { target, has_key })
}

pub fn configure(db: &Workspace, target: Target, secret: Option<Secret>) -> Result<()> {
    let target = target.validated()?;
    let entry = target.credential(db)?;
    if let Some(secret) = secret {
        db.read_running(|_| Ok(()))?;
        secret.validate()?;
        entry
            .set_password(&serde_json::to_string(&secret).expect("S3 fields are serializable"))
            .map_err(secrets::error)?;
    } else if read_secret(&entry)?.is_none() {
        return Err(AppError::invalid("请填写备份桶的访问密钥"));
    }
    db.write(|tx| {
        if let Some(scope)=super::retention::scope(tx)? {
            tx.execute("INSERT OR IGNORE INTO app_settings VALUES(?1,'false')",[format!("asset-backup-state:{scope}")])?;
        }
        Ok(())
    })?;
    db.set_setting(SETTINGS, &target)
}

fn read_secret(entry: &keyring::Entry) -> Result<Option<Secret>> {
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| AppError::new("CREDENTIALS", "备份凭据格式无效，请在设置中重新填写")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(secrets::error(error)),
    }
}

pub fn store(db: &Workspace) -> Result<Store> {
    let target = db
        .setting::<Target>(SETTINGS)?
        .ok_or_else(|| AppError::new("BACKUP_CONFIG", "请先配置 S3 数据库备份"))?;
    let secret = read_secret(&target.credential(db)?)?
        .ok_or_else(|| AppError::new("CREDENTIALS", "请在设置中填写备份桶的访问密钥"))?;
    Ok(Store::new(target, secret))
}

pub struct Store {
    scope_target:serde_json::Value,
    s3: S3Storage,
    root: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub name: String,
    pub created_at: i64,
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub backup: Backup,
    pub warning: Option<String>,
}

impl Store {
    fn new(target: Target, secret: Secret) -> Self {
        let root = if target.prefix.is_empty() {
            format!("{NAMESPACE}/")
        } else {
            format!("{}/{NAMESPACE}/", target.prefix)
        };
        Self {
            scope_target:serde_json::to_value(&target).expect("backup target serializes"),
            s3: S3Storage::for_bucket(
                &target.endpoint,
                &target.region,
                &target.bucket,
                secret,
                TRANSFER_TIMEOUT,
            ),
            root,
        }
    }

    pub async fn workspaces(&self) -> Result<Vec<String>> {
        let objects = self.objects(&self.root, PAGE_SIZE).await?;
        Ok(objects
            .iter()
            .filter_map(|object| {
                let (workspace, suffix) =
                    object.key()?.strip_prefix(&self.root)?.split_once('/')?;
                let name = suffix.strip_prefix("backups/")?;
                if !canonical_uuid(workspace) || snapshot_time(name).is_none() {
                    return None;
                }
                Some(workspace.to_owned())
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect())
    }

    fn workspace_prefix(&self, workspace: &str) -> Result<String> {
        if !canonical_uuid(workspace) {
            return Err(AppError::invalid("工作区 ID 无效"));
        }
        Ok(format!("{}{workspace}/backups/", self.root))
    }

    pub(super) fn asset_scope(&self,workspace:&str)->String {
        super::retention::scope_for(&self.scope_target,workspace)
    }

    pub async fn list(&self, workspace: &str) -> Result<Vec<Backup>> {
        let prefix = self.workspace_prefix(workspace)?;
        self.list_prefix(&prefix, PAGE_SIZE).await
    }

    async fn list_prefix(&self, prefix: &str, page_size: i32) -> Result<Vec<Backup>> {
        let mut backups: Vec<_> = self
            .objects(prefix, page_size)
            .await?
            .iter()
            .filter_map(|object| parse_object(prefix, object))
            .collect();
        backups.sort_unstable_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.name.cmp(&left.name))
        });
        Ok(backups)
    }

    async fn objects(&self, prefix: &str, page_size: i32) -> Result<Vec<Object>> {
        let mut continuation = None;
        let mut objects = Vec::new();
        loop {
            let page = self
                .s3
                .client
                .list_objects_v2()
                .bucket(&self.s3.bucket)
                .prefix(prefix)
                .max_keys(page_size)
                .set_continuation_token(continuation)
                .send()
                .await
                .map_err(|error| sdk_error("列出备份", &error))?;
            objects.extend_from_slice(page.contents());
            if page.is_truncated() != Some(true) {
                return Ok(objects);
            }
            continuation = Some(
                page.next_continuation_token()
                    .filter(|token| !token.is_empty())
                    .ok_or_else(|| AppError::new("S3_LIST", "图床返回的备份列表缺少下页标记"))?
                    .to_owned(),
            );
        }
    }

    pub async fn upload(&self, workspace: &str, path: &Path, name: String, stamp: i64) -> Result<UploadResult> {
        self.upload_named(workspace, path, name, stamp).await
    }

    async fn upload_named(
        &self,
        workspace: &str,
        path: &Path,
        name: String,
        stamp: i64,
    ) -> Result<UploadResult> {
        let prefix = self.workspace_prefix(workspace)?;
        let bytes = tokio::fs::metadata(path).await.map_err(backup_file)?.len();
        let body = ByteStream::from_path(path)
            .await
            .map_err(|_| AppError::new("BACKUP_FILE", "无法读取要上传的数据库快照"))?;
        let key = format!("{prefix}{name}");
        self.s3
            .client
            .put_object()
            .bucket(&self.s3.bucket)
            .key(&key)
            .content_type("application/vnd.sqlite3")
            .body(body)
            .send()
            .await
            .map_err(|error| sdk_error("上传备份", &error))?;

        let warning = match self.prune(&prefix).await {
            Ok(()) => None,
            Err(error) => Some(format!("备份已上传，清理更早的备份失败：{error}")),
        };
        Ok(UploadResult {
            backup: Backup {
                name,
                created_at: stamp,
                bytes,
            },
            warning,
        })
    }

    async fn prune(&self, prefix: &str) -> Result<()> {
        for backup in self
            .list_prefix(prefix, PAGE_SIZE)
            .await?
            .into_iter()
            .skip(RETAIN)
        {
            self.s3.delete(&format!("{prefix}{}", backup.name)).await?;
        }
        Ok(())
    }

    pub async fn download(&self, workspace: &str, name: &str, path: &Path) -> Result<()> {
        let prefix = self.workspace_prefix(workspace)?;
        if snapshot_time(name).is_none() {
            return Err(AppError::invalid("备份文件名无效"));
        }
        let directory = path.parent().expect("backup staging path has a parent");
        let temporary = tempfile::NamedTempFile::new_in(directory).map_err(backup_file)?;
        let fetch = async {
            let response = self
                .s3
                .client
                .get_object()
                .bucket(&self.s3.bucket)
                .key(format!("{prefix}{name}"))
                .send()
                .await
                .map_err(|error| sdk_error("下载备份", &error))?;
            let mut input = response.body.into_async_read();
            let mut output = tokio::fs::File::from_std(temporary.reopen().map_err(backup_file)?);
            tokio::io::copy(&mut input, &mut output)
                .await
                .map_err(backup_file)?;
            output.sync_all().await.map_err(backup_file)?;
            Ok::<_, AppError>(())
        };
        tokio::time::timeout(TRANSFER_TIMEOUT, fetch)
            .await
            .map_err(|_| AppError::new("S3_TIMEOUT", "下载备份超时"))??;
        temporary
            .persist(path)
            .map_err(|error| backup_file(error.error))?;
        Ok(())
    }
}

fn parse_object(prefix: &str, object: &Object) -> Option<Backup> {
    let name = object.key()?.strip_prefix(prefix)?;
    let stamp = snapshot_time(name)?;
    let bytes = u64::try_from(object.size()?).ok()?;
    let created_at = object
        .last_modified()
        .and_then(|stamp| stamp.to_millis().ok())
        .unwrap_or(stamp);
    Some(Backup {
        name: name.to_owned(),
        created_at,
        bytes,
    })
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| uuid.hyphenated().to_string() == value)
}

fn snapshot_time(name: &str) -> Option<i64> {
    let (stamp, uuid) = name.strip_suffix(".sqlite")?.split_once('-')?;
    if stamp.len() != 13
        || !stamp.bytes().all(|byte| byte.is_ascii_digit())
        || !canonical_uuid(uuid)
    {
        return None;
    }
    stamp.parse().ok()
}

fn backup_file(error: std::io::Error) -> AppError {
    AppError::new("BACKUP_FILE", format!("无法处理数据库快照文件：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{id,now};

    #[test]
    fn a_captured_store_keeps_its_scope_when_the_active_backup_target_changes() {
        let db=Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let target=Target{endpoint:"https://s3.example.test".into(),region:"auto".into(),bucket:"first".into(),prefix:String::new()};
        let store=Store::new(target,Secret{access_key:"test".into(),secret_key:"test".into()});
        let workspace=db.read(crate::db::workspace_id).unwrap();
        let captured=store.asset_scope(&workspace);
        let replacement=Target{endpoint:"https://s3.example.test".into(),region:"auto".into(),bucket:"second".into(),prefix:String::new()};
        db.set_setting("backup_target",&replacement).unwrap();
        db.write(|tx|{
            let current=super::super::retention::scope(tx)?.unwrap();
            assert_ne!(captured,current);
            super::super::retention::reserve(tx,&current,"valid.sqlite")?;
            tx.execute("UPDATE backup_asset_manifests SET status='confirmed'",[])?;
            super::super::retention::reconcile(tx,&captured,&[])?;
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM backup_asset_manifests WHERE scope=?1",[current],|row|row.get::<_,i64>(0))?,1);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn retention_classifies_only_canonical_database_objects_in_the_selected_workspace() {
        let workspace = "715990f8-2dd8-486a-8e16-f5693dfa40df";
        let sibling = "c515d13a-8f17-4a34-b719-e4dd50c50db8";
        let name = "1750000000000-c6da3240-6250-4989-9a50-23ef2983dea1.sqlite";
        let prefix = format!("shared/{NAMESPACE}/{workspace}/backups/");
        for key in [
            format!("{prefix}{name}"),
            format!("{prefix}sub/{name}"),
            format!("{prefix}../{name}"),
            format!("{prefix}readme.md"),
            format!("shared/{NAMESPACE}/{sibling}/backups/{name}"),
            format!("shared/{NAMESPACE}/{workspace}/archive/{name}"),
            format!("{prefix}{}", name.to_uppercase()),
        ] {
            let object = Object::builder().key(&key).size(8).build();
            let result = parse_object(&prefix, &object);
            assert_eq!(result.is_some(), key == format!("{prefix}{name}"));
        }
    }

    #[derive(Deserialize)]
    struct ProbeConfig {
        endpoint: String,
        region: String,
        bucket: String,
        prefix: String,
        primary: ProbeSecret,
        reader: ProbeSecret,
    }

    #[derive(Deserialize)]
    struct ProbeSecret {
        access_key_id: String,
        secret_access_key: String,
    }

    impl From<ProbeSecret> for Secret {
        fn from(secret: ProbeSecret) -> Self {
            Self {
                access_key: secret.access_key_id,
                secret_key: secret.secret_access_key,
            }
        }
    }

    fn probe_check(ok: bool, message: &'static str) -> Result<()> {
        if ok {
            Ok(())
        } else {
            Err(AppError::new("TEST_PROBE", message))
        }
    }

    #[tokio::test]
    #[ignore = "writes only to a unique probe prefix on the configured private R2 test bucket"]
    async fn r2_stream_backup_pagination_download_and_retention() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("s3-r2-test.local.json");
        let raw = std::fs::read_to_string(path).expect("read the local R2 fixture");
        let config: ProbeConfig = serde_json::from_str(&raw)
            .unwrap_or_else(|_| panic!("invalid local R2 fixture format"));
        let base = config.prefix.trim().trim_matches('/');
        assert!(
            !base.is_empty(),
            "R2 probe requires an explicit test prefix"
        );
        let target = Target {
            endpoint: config.endpoint,
            region: config.region,
            bucket: config.bucket,
            prefix: format!("{base}/p5-probe-{}", id()),
        }
        .validated()
        .expect("valid R2 test target");
        let store = Store::new(target.clone(), config.primary.into());
        let reader = Store::new(target, config.reader.into());
        let workspace = id();
        let prefix = store.workspace_prefix(&workspace).unwrap();
        let staging = tempfile::tempdir().unwrap();
        let source = staging.path().join("source.sqlite");
        let downloaded = staging.path().join("downloaded.sqlite");
        let live_path = staging.path().join("live.sqlite");
        let live = Workspace::open(&live_path).unwrap();
        let publication = serde_json::json!({"schemaVersion":1,"recommendations":{"enabled":true,"mode":"manual","countOverride":7,
            "inputFingerprint":null,"items":[{"entryId":"second","title":"第二篇","url":"https://mp.weixin.qq.com/s/second"},
            {"entryId":"first","title":"第一篇","url":"https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1&sn=complete"}]}});
        let empty = serde_json::json!({"schemaVersion":1,"recommendations":{"enabled":false,"mode":"manual","countOverride":null,"inputFingerprint":null,"items":[]}});
        live.write(|tx| {
            tx.execute("UPDATE app_settings SET value=?1 WHERE key='workspace_id'", [&workspace])?;
            tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at,wechat_publication) VALUES('configured','article','推荐配置','draft','正文',1,1,?1)", [publication.to_string()])?;
            tx.execute("INSERT INTO entries(id,kind,title,status,content_md,created_at,updated_at,wechat_publication) VALUES('empty','article','人工删空','draft','正文',1,1,?1)", [empty.to_string()])?;
            crate::content::publication::apply_defaults(tx, "default", &serde_json::json!({"schemaVersion":1,"recommendationCount":8,"updatedAt":1}))?;
            tx.execute("INSERT INTO sync_binding(id,url,instance_id,epoch,device_id) VALUES(1,'https://sync.example.test/','instance','epoch','device')", [])?;
            Ok(())
        }).unwrap();
        std::fs::File::create(&source).unwrap();
        super::super::restore::make_snapshot(&live_path, &source, &workspace).unwrap();
        let source_bytes = std::fs::read(&source).unwrap();
        let mut names = Vec::new();
        let outcome = async {
            for step in 0..=RETAIN {
                let time = now() + step as i64;
                let name = format!("{time:013}-{}.sqlite", id());
                names.push(name.clone());
                let output = store.upload_named(&workspace, &source, name, time).await?;
                probe_check(output.warning.is_none(), "R2 保留策略未完成")?;
                probe_check(
                    output.backup.bytes == source_bytes.len() as u64,
                    "上传大小不一致",
                )?;
            }
            let backups = reader.list_prefix(&prefix, 2).await?;
            probe_check(backups.len() == RETAIN, "分页列表未保留 5 份备份")?;
            probe_check(
                !backups.iter().any(|object| object.name == names[0]),
                "最早的备份没有移除",
            )?;
            probe_check(
                reader.workspaces().await? == [workspace.clone()],
                "工作区发现清单不一致",
            )?;
            probe_check(
                reader
                    .list(&workspace)
                    .await?
                    .into_iter()
                    .map(|backup| backup.name)
                    .collect::<Vec<_>>()
                    == backups
                        .iter()
                        .map(|backup| backup.name.clone())
                        .collect::<Vec<_>>(),
                "分页与普通列表的对象不一致",
            )?;
            reader
                .download(&workspace, &backups[0].name, &downloaded)
                .await?;
            probe_check(
                std::fs::read(&downloaded).map_err(backup_file)? == source_bytes,
                "下载的快照与上传字节不一致",
            )?;
            super::super::restore::prepare_file(&downloaded, &super::super::restore::PendingRestore {
                workspace: workspace.clone(), name: "remote.sqlite".into(), migration: None,
            })?;
            let recovered = Workspace::open(&downloaded)?;
            recovered.read(|conn| {
                for (id, expected) in [("configured", &publication), ("empty", &empty)] {
                    let raw: String = conn.query_row("SELECT wechat_publication FROM entries WHERE id=?1", [id], |row| row.get(0))?;
                    probe_check(serde_json::from_str::<serde_json::Value>(&raw).unwrap() == *expected, "恢复后的推荐配置不一致")?;
                }
                probe_check(crate::content::publication::defaults_snapshot(conn, "default")?.unwrap()["recommendationCount"] == 8, "恢复后的默认设置不一致")?;
                let pause: String = conn.query_row("SELECT pause_reason FROM sync_binding WHERE paused=1", [], |row| row.get(0))?;
                probe_check(pause == "backup_restored", "恢复后同步未暂停")
            })
        }
        .await;
        let mut cleanup_error = None;
        for name in names {
            if let Err(error) = store.s3.delete(&format!("{prefix}{name}")).await {
                cleanup_error.get_or_insert(error);
            }
        }
        if let Some(error) = cleanup_error {
            panic!("failed to remove the isolated R2 probe objects: {error}");
        }
        outcome.expect("isolated R2 backup used the expected object contract");
    }
}
