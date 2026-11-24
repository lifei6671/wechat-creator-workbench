use super::{Assets, image_header, local_error, remote_image};
use crate::db::{AppError, Result};
use http::{HeaderMap, Request, StatusCode, header, response};
use http_cache_semantics::{AfterResponse, BeforeRequest, CacheOptions, CachePolicy, ResponseLike};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, Weak},
    time::SystemTime,
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use url::Url;

const CAPACITY: i64 = 128 * 1024 * 1024;
const MAX_ENTRIES: i64 = 1024;
const LABEL: &str = "外链图片";
const NETWORK_ERROR: &str = "IMAGE_NETWORK";
const TIMEOUT_ERROR: &str = "IMAGE_TIMEOUT";

pub(super) struct ImageCache {
    db: Arc<Mutex<Connection>>,
    requests: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

struct Entry {
    policy: CachePolicy,
    bytes: Vec<u8>,
}

impl ImageCache {
    pub(super) fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory).map_err(local_error)?;
        let db = Connection::open(directory.join("images.sqlite3"))?;
        db.execute_batch(
            "PRAGMA auto_vacuum = FULL;
             CREATE TABLE IF NOT EXISTS images (
                 id INTEGER PRIMARY KEY,
                 url_key TEXT UNIQUE NOT NULL,
                 policy TEXT NOT NULL,
                 bytes BLOB NOT NULL
             );",
        )?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            requests: Mutex::new(HashMap::new()),
        })
    }

    pub(super) async fn read(
        &self,
        client: &reqwest::Client,
        address: &Url,
        retry: bool,
    ) -> Result<Vec<u8>> {
        let mut address = address.clone();
        address.set_fragment(None);
        let key = hex::encode(Sha256::digest(address.as_str()));
        let request_lock = self.request_lock(&key).lock_owned().await;
        let mut request = Request::get(address.as_str())
            .body(())
            .map_err(|_| AppError::invalid("图片地址无效"))?;
        let mut cached = if retry {
            request.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-cache"),
            );
            None
        } else {
            self.lookup(key.clone()).await
        };
        if let Some(entry) = cached.take() {
            match entry.policy.before_request(&request, SystemTime::now()) {
                BeforeRequest::Fresh(_) => return Ok(entry.bytes),
                BeforeRequest::Stale {
                    request: next,
                    matches: true,
                } => {
                    *request.headers_mut() = next.headers;
                    cached = Some(entry);
                }
                BeforeRequest::Stale { matches: false, .. } => {}
            }
        }

        let mut response = request_image(client, &address, request.headers()).await?;
        if response.status() == StatusCode::NOT_MODIFIED
            && (request.headers().contains_key(header::IF_NONE_MATCH)
                || request.headers().contains_key(header::IF_MODIFIED_SINCE))
            && let Some(entry) = cached
        {
            let now = SystemTime::now();
            if response.url() == &address
                && let Some(updated) =
                    revalidated_headers(&entry.policy, &request, &mut response, now)
            {
                return self
                    .save(
                        key,
                        cache_policy(&request, &updated, now),
                        entry.bytes,
                        request_lock,
                    )
                    .await;
            }
            request.headers_mut().remove(header::IF_NONE_MATCH);
            request.headers_mut().remove(header::IF_MODIFIED_SINCE);
            response = request_image(client, &address, request.headers()).await?;
        }

        // A redirected response has its own cache policy, separate from the URL in the document.
        let policy = if response.url() == &address && response.status() == StatusCode::OK {
            cache_policy(&request, &response, SystemTime::now())
        } else {
            None
        };
        let bytes = Assets::read_image_body(response, LABEL, NETWORK_ERROR, TIMEOUT_ERROR).await?;
        let bytes = remote_image::normalize(bytes).await?;
        self.save(key, policy, bytes, request_lock).await
    }

    fn request_lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut requests = self
            .requests
            .lock()
            .expect("image cache request map is poisoned");
        requests.retain(|_, lock| lock.strong_count() > 0);
        let current = requests.entry(key.to_owned()).or_default();
        current.upgrade().unwrap_or_else(|| {
            let lock = Arc::new(AsyncMutex::new(()));
            *current = Arc::downgrade(&lock);
            lock
        })
    }

    async fn lookup(&self, key: String) -> Option<Entry> {
        let db = Arc::clone(&self.db);
        tokio::task::spawn_blocking(move || {
            let (policy, bytes): (String, Vec<u8>) = db
                .lock()
                .ok()?
                .query_row(
                    "SELECT policy, bytes FROM images WHERE url_key = ?1",
                    [&key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok()?;
            let policy = serde_json::from_str(&policy).ok()?;
            image_header(&bytes).ok()?;
            Some(Entry { policy, bytes })
        })
        .await
        .ok()
        .flatten()
    }

    async fn save(
        &self,
        key: String,
        policy: Option<CachePolicy>,
        bytes: Vec<u8>,
        request_lock: OwnedMutexGuard<()>,
    ) -> Result<Vec<u8>> {
        let db = Arc::clone(&self.db);
        tokio::task::spawn_blocking(move || {
            let _request_lock = request_lock;
            // Cache I/O is optional once the image has been retrieved.
            if let Ok(mut db) = db.lock() {
                let policy = policy
                    .filter(CachePolicy::is_storable)
                    .and_then(|policy| serde_json::to_string(&policy).ok());
                let _ = write_entry(&mut db, &key, policy.as_deref(), &bytes);
            }
            bytes
        })
        .await
        .map_err(|error| AppError::new("ASSET_FILE", error.to_string()))
    }
}

async fn request_image(
    client: &reqwest::Client,
    address: &Url,
    headers: &HeaderMap,
) -> Result<reqwest::Response> {
    client
        .get(address.clone())
        .headers(headers.clone())
        .send()
        .await
        .map_err(|error| Assets::image_network_error(error, LABEL, NETWORK_ERROR, TIMEOUT_ERROR))
}

fn cache_policy(
    request: &Request<()>,
    response: &impl ResponseLike,
    now: SystemTime,
) -> Option<CachePolicy> {
    // Bound Age before the policy adds the time spent in the local cache.
    if response.headers().get_all(header::AGE).iter().any(|value| {
        value
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .is_none()
    }) {
        return None;
    }
    Some(CachePolicy::new_options(
        request,
        response,
        now,
        CacheOptions {
            shared: false,
            ..CacheOptions::default()
        },
    ))
}

fn revalidated_headers(
    stored: &CachePolicy,
    request: &Request<()>,
    response: &mut reqwest::Response,
    now: SystemTime,
) -> Option<response::Parts> {
    // A 304 may omit Last-Modified when If-Modified-Since was the only validator.
    if !request.headers().contains_key(header::IF_NONE_MATCH)
        && !response.headers().contains_key(header::LAST_MODIFIED)
        && let Some(value) = request.headers().get(header::IF_MODIFIED_SINCE)
    {
        response
            .headers_mut()
            .insert(header::LAST_MODIFIED, value.clone());
    }
    let AfterResponse::NotModified(_, mut updated) = stored.after_response(request, response, now)
    else {
        return None;
    };
    updated.headers.remove(header::AGE);
    // The policy library only replaces fields already present in the cached response.
    for name in [
        header::CACHE_CONTROL,
        header::EXPIRES,
        header::VARY,
        header::AGE,
        header::DATE,
    ] {
        if response.headers().contains_key(&name) {
            updated.headers.remove(&name);
            for value in response.headers().get_all(&name) {
                updated.headers.append(name.clone(), value.clone());
            }
        }
    }
    Some(updated)
}

fn write_entry(
    db: &mut Connection,
    key: &str,
    policy: Option<&str>,
    bytes: &[u8],
) -> rusqlite::Result<()> {
    let Some(policy) = policy else {
        db.execute("DELETE FROM images WHERE url_key = ?1", [key])?;
        return Ok(());
    };
    let tx = db.transaction()?;
    tx.execute(
        "INSERT OR REPLACE INTO images (url_key, policy, bytes) VALUES (?1, ?2, ?3)",
        params![key, policy, bytes],
    )?;
    tx.execute(
        "DELETE FROM images WHERE id IN (
           SELECT id FROM (
             SELECT id, row_number() OVER (ORDER BY id DESC) AS position,
               sum(length(bytes) + length(CAST(policy AS BLOB))) OVER (ORDER BY id DESC) AS size
             FROM images
           ) WHERE size > ?1 OR position > ?2
         )",
        params![CAPACITY, MAX_ENTRIES],
    )?;
    tx.commit()
}
