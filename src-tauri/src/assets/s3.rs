use super::Assets;
use crate::db::{AppError, Result, Workspace, id, workspace_id};
use aws_sdk_s3::{
    Client,
    config::{BehaviorVersion, Credentials, Region, retry::RetryConfig, timeout::TimeoutConfig},
    error::{ProvideErrorMetadata, SdkError},
    primitives::ByteStream,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

const SERVICE: &str = "io.github.lifei6671.wechat-creator-workbench.s3";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub public_base: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub(crate) access_key: String,
    pub(crate) secret_key: String,
}

#[derive(Clone)]
pub struct Profile {
    pub id: String,
    pub target: Target,
    credential_ref: String,
}

impl Target {
    pub fn validated(mut self) -> Result<Self> {
        self.endpoint = http_base(&self.endpoint, false)?;
        self.public_base = http_base(&self.public_base, true)?;
        self.region = self.region.trim().to_owned();
        self.bucket = self.bucket.trim().to_owned();
        self.prefix = self.prefix.trim().trim_matches('/').to_owned();
        if self.region.is_empty()
            || self.bucket.is_empty()
            || !self
                .bucket
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            || self.prefix.split('/').any(|s| s == "." || s == "..")
        {
            return Err(AppError::invalid("请填写区域和有效的桶名及对象前缀"));
        }
        Ok(self)
    }

    pub fn public_url(&self, key: &str) -> String {
        let mut url = Url::parse(&self.public_base).expect("saved public base is a URL");
        url.path_segments_mut()
            .expect("HTTP base has path segments")
            .pop_if_empty()
            .extend(key.split('/'));
        url.into()
    }

    pub fn contains_public_url(&self, url: &Url) -> bool {
        let prefix =
            Url::parse(&self.public_url(&self.prefix)).expect("configured public URL is valid");
        let path = prefix.path().trim_end_matches('/');
        url.origin() == prefix.origin()
            && url
                .path()
                .strip_prefix(path)
                .is_some_and(|rest| rest.starts_with('/') && rest.len() > 1)
    }

    pub fn key(&self, workspace: &str, name: &str) -> String {
        if self.prefix.is_empty() {
            format!("{workspace}/{name}")
        } else {
            format!("{}/{workspace}/{name}", self.prefix)
        }
    }
}

pub(crate) fn http_base(value: &str, public: bool) -> Result<String> {
    let url = Url::parse(value.trim())
        .map_err(|_| AppError::invalid("请输入完整的 HTTP 或 HTTPS 地址"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (!public && url.path() != "/")
    {
        return Err(AppError::invalid(if public {
            "公开地址不能包含凭据、查询参数或片段"
        } else {
            "S3 端点只能包含协议、域名和端口"
        }));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn credential_error(error: impl std::fmt::Display) -> AppError {
    AppError::new("S3_CREDENTIALS", format!("无法访问系统凭据：{error}"))
}

fn keychain(reference: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, reference).map_err(credential_error)
}

impl Secret {
    pub fn validate(&self) -> Result<()> {
        if self.access_key.trim().is_empty() || self.secret_key.trim().is_empty() {
            return Err(AppError::invalid("请填写访问密钥 ID 和秘密访问密钥"));
        }
        Ok(())
    }
}

impl Profile {
    pub fn read(conn: &Connection, profile_id: &str) -> Result<Self> {
        Ok(conn.query_row(
            "SELECT id, endpoint, region, bucket, object_prefix, public_base_url, credential_ref FROM storage_profiles WHERE id=?1 AND purpose='images'",
            [profile_id],
            |r| Ok(Self { id: r.get(0)?, target: Target {
                endpoint: r.get(1)?, region: r.get(2)?, bucket: r.get(3)?,
                prefix: r.get(4)?, public_base: r.get(5)?,
            }, credential_ref: r.get(6)? }),
        )?)
    }

    fn matching(conn: &Connection, target: &Target) -> Result<Option<Self>> {
        let existing = conn.query_row(
            "SELECT id FROM storage_profiles WHERE purpose='images' AND endpoint=?1 AND region=?2 AND bucket=?3 AND object_prefix=?4",
            params![target.endpoint, target.region, target.bucket, target.prefix],
            |r| r.get::<_, String>(0),
        ).optional()?;
        existing.map(|id| Self::read(conn, &id)).transpose()
    }

    pub fn active(conn: &Connection) -> Result<Option<Self>> {
        let id = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key='image_storage_profile'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        id.map(|id| Self::read(conn, &id)).transpose()
    }

    fn secret(&self) -> Result<Secret> {
        let value = keychain(&self.credential_ref)?
            .get_password()
            .map_err(credential_error)?;
        serde_json::from_str(&value).map_err(credential_error)
    }

    pub fn provider(&self) -> Result<S3Storage> {
        Ok(S3Storage::new(&self.target, self.secret()?))
    }
}

impl Assets {
    pub fn configure(
        &self,
        db: &Workspace,
        target: Option<Target>,
        secret: Option<Secret>,
    ) -> Result<()> {
        let Some(target) = target.map(Target::validated).transpose()? else {
            return db.write(|tx| {
                tx.execute(
                    "DELETE FROM app_settings WHERE key='image_storage_profile'",
                    [],
                )?;
                pause_uploads(tx, None)?;
                Ok(())
            });
        };
        db.write(|tx| {
            let existing = Profile::matching(tx, &target)?;
            let profile_id = existing.as_ref().map_or_else(id, |p| p.id.clone());
            let reference = existing
                .as_ref()
                .map_or_else(|| profile_id.clone(), |p| p.credential_ref.clone());
            if let Some(secret) = secret {
                secret.validate()?;
                let encoded =
                    serde_json::to_string(&secret).expect("credential pair is serializable");
                keychain(&reference)?
                    .set_password(&encoded)
                    .map_err(credential_error)?;
            } else if let Some(profile) = &existing {
                profile.secret()?;
            } else {
                return Err(AppError::invalid("新存储目标需要填写访问密钥"));
            }
            tx.execute(
                "INSERT INTO storage_profiles VALUES (?1,'images',?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET public_base_url=excluded.public_base_url",
                params![
                    profile_id,
                    target.endpoint,
                    target.region,
                    target.bucket,
                    target.prefix,
                    target.public_base,
                    reference
                ],
            )?;
            tx.execute(
                "INSERT INTO app_settings VALUES ('image_storage_profile',?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [&profile_id],
            )?;
            db_register_public_urls(tx, &profile_id, &target)?;
            pause_uploads(tx, Some(&profile_id))?;
            Ok(())
        })
    }

    pub async fn test(&self, db: &Workspace, target: Target, secret: Option<Secret>) -> Result<()> {
        let target = target.validated()?;
        let workspace = db.read_running(workspace_id)?;
        let secret = match secret {
            Some(secret) => {
                secret.validate()?;
                secret
            }
            None => db
                .read(|conn| Profile::matching(conn, &target))?
                .ok_or_else(|| AppError::invalid("测试新目标需要填写访问密钥"))?
                .secret()?,
        };
        let store = S3Storage::new(&target, secret);
        let key = target.key(&workspace, "connection-test/probe");
        let sample = b"wechat-creator-workbench-s3-test";
        let result = async {
            store
                .put(&key, "application/octet-stream", sample.to_vec())
                .await?;
            let result = store.get(&key).await?;
            if result != sample {
                return Err(AppError::new("S3_TEST", "测试对象内容不一致"));
            }
            Ok(())
        }
        .await;
        let deletion = store.delete(&key).await;
        match (result, deletion) {
            (Ok(()), result) | (result @ Err(_), Ok(())) => result,
            (Err(operation), Err(cleanup)) => Err(AppError::new(
                "S3_TEST",
                format!("{operation}；删除测试对象失败：{cleanup}"),
            )),
        }
    }
}

fn pause_uploads(conn: &Connection, active: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE jobs SET status='failed',error='此图床已停用，可在当前图床上传',updated_at=?2
         WHERE kind='upload' AND status IN ('queued','retrying') AND storage_profile_id IS NOT ?1",
        params![active, crate::db::now()],
    )?;
    Ok(())
}

fn db_register_public_urls(conn: &Connection, profile: &str, target: &Target) -> Result<()> {
    let mut query =
        conn.prepare("SELECT sha256, object_key FROM asset_locations WHERE storage_profile_id=?1")?;
    let items = query.query_map([profile], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for item in items {
        let (hash, key) = item?;
        let url = target.public_url(&key);
        conn.execute(
            "UPDATE asset_locations SET public_url=?1 WHERE sha256=?2 AND storage_profile_id=?3",
            params![url, hash, profile],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO asset_urls VALUES (?1,?2,?3)",
            params![url, hash, profile],
        )?;
    }
    Ok(())
}

pub struct S3Storage {
    pub(crate) client: Client,
    pub(crate) bucket: String,
}

impl S3Storage {
    fn new(target: &Target, secret: Secret) -> Self {
        Self::for_bucket(
            &target.endpoint,
            &target.region,
            &target.bucket,
            secret,
            Duration::from_secs(25),
        )
    }

    pub(crate) fn for_bucket(
        endpoint: &str,
        region: &str,
        bucket: &str,
        secret: Secret,
        timeout: Duration,
    ) -> Self {
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(endpoint)
            .region(Region::new(region.to_owned()))
            .force_path_style(true)
            .credentials_provider(Credentials::new(
                secret.access_key,
                secret.secret_key,
                None,
                None,
                "system-keyring",
            ))
            .request_checksum_calculation(
                aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired,
            )
            .response_checksum_validation(
                aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired,
            )
            .retry_config(RetryConfig::disabled())
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(Duration::from_secs(5))
                    .operation_timeout(timeout)
                    .build(),
            )
            .build();
        Self {
            client: Client::from_conf(config),
            bucket: bucket.to_owned(),
        }
    }

    pub async fn put(&self, key: &str, mime: &str, bytes: Vec<u8>) -> Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(mime)
            .body(ByteStream::from(bytes))
            .send()
            .await
            .map_err(|e| sdk_error("上传", &e))?;
        Ok(())
    }

    pub async fn get(&self, key: &str) -> Result<Vec<u8>> {
        let download = async {
            let response = self
                .client
                .get_object()
                .bucket(&self.bucket)
                .key(key)
                .send()
                .await
                .map_err(|e| sdk_error("下载", &e))?;
            let mut body = response.body;
            let mut bytes = Vec::new();
            while let Some(chunk) = body
                .try_next()
                .await
                .map_err(|e| AppError::new("S3_NETWORK", format!("下载对象失败：{e}")))?
            {
                if bytes.len() + chunk.len() > super::MAX_BYTES {
                    return Err(AppError::new("IMAGE_SIZE", "远程图片超过 20 MB"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        };
        tokio::time::timeout(Duration::from_secs(25), download)
            .await
            .map_err(|_| AppError::new("S3_TIMEOUT", "下载对象超时"))?
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        if let Err(error) = self
            .client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            let error = sdk_error("删除", &error);
            if error.code() != "S3_NOT_FOUND" {
                return Err(error);
            }
        }
        Ok(())
    }
}

pub(crate) fn sdk_error<E: ProvideErrorMetadata, R>(
    operation: &str,
    error: &SdkError<E, R>,
) -> AppError {
    match error {
        SdkError::TimeoutError(_) => AppError::new("S3_TIMEOUT", format!("{operation}对象超时")),
        SdkError::DispatchFailure(_) | SdkError::ResponseError(_) => {
            AppError::new("S3_NETWORK", format!("{operation}对象时连接中断或响应无效"))
        }
        SdkError::ServiceError(e) => {
            let code = e.err().code().unwrap_or("Unknown");
            let kind = match code {
                "AccessDenied" | "InvalidAccessKeyId" | "SignatureDoesNotMatch" | "Forbidden" => {
                    "S3_PERMISSION"
                }
                "NoSuchKey" | "NotFound" => "S3_NOT_FOUND",
                _ => "S3_SERVICE",
            };
            AppError::new(kind, format!("{operation}对象失败（{code}）"))
        }
        _ => AppError::new("S3_REQUEST", format!("无法发出{operation}请求")),
    }
}
