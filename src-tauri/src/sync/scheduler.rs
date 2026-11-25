use super::{Binding, SyncConnection, WakeSource, contents};
use crate::{
    assets::Assets,
    db::{Result, Workspace},
};
use serde::Serialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const CHECK: Duration = Duration::from_secs(5);
const UPLOAD_DELAY: Duration = Duration::from_secs(30);
const PULL_INTERVAL: Duration = Duration::from_secs(300);
const FOREGROUND_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
pub(super) struct RuntimeError {
    code: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeState {
    pub phase: String,
    pub error: Option<RuntimeError>,
    pub last_exchange_at: Option<i64>,
    #[serde(skip)]
    last_exchange: Option<Instant>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            error: None,
            last_exchange_at: None,
            last_exchange: None,
        }
    }
}

pub(super) fn snapshot(sync: &SyncConnection) -> RuntimeState {
    sync.runtime
        .lock()
        .expect("sync runtime lock poisoned")
        .clone()
}

pub(super) fn set_phase(sync: &SyncConnection, app: &AppHandle, phase: &str) {
    sync.phase(phase);
    if sync.app.get().is_none() {
        sync.changed(app);
    }
}

pub(super) fn settled(sync: &SyncConnection, app: &AppHandle, error: Option<&crate::db::AppError>) {
    let mut state = sync.runtime.lock().expect("sync runtime lock poisoned");
    state.phase = "idle".into();
    if let Some(error) = error {
        state.error = Some(RuntimeError {
            code: error.code().into(),
            message: error.to_string(),
        });
    }
    drop(state);
    sync.changed(app);
}

pub(super) fn finish(sync: &SyncConnection, app: &AppHandle, result: &Result<()>) {
    let mut state = sync.runtime.lock().expect("sync runtime lock poisoned");
    state.phase = "idle".into();
    match result {
        Ok(()) => {
            state.error = None;
            state.last_exchange = Some(Instant::now());
            state.last_exchange_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system clock is after UNIX epoch")
                    .as_millis() as i64,
            );
        }
        Err(error) if error.code() == "SYNC_WAITING_SEED" => {
            state.phase = "waiting_seed".into();
            state.error = None;
        }
        Err(error) => {
            state.error = Some(RuntimeError {
                code: error.code().into(),
                message: error.to_string(),
            })
        }
    }
    drop(state);
    sync.changed(app);
}

pub(super) enum RunSource { Manual, Automatic }

pub(super) async fn run(
    app: &AppHandle,
    db: &Workspace,
    assets: &Assets,
    sync: &SyncConnection,
    source: RunSource,
) -> Result<()> {
    let lifetime = db.running_lifetime();
    let result = tokio::select! {
        biased;
        _ = lifetime.cancelled() => Err(crate::db::AppError::new("EXIT_PENDING", "正在保存并退出")),
        result = async {
            let _guard = sync.gate.lock().await;
            set_phase(sync, app, "syncing");
            let result = async {
                if matches!(source, RunSource::Manual) { contents::retry_repaired_assets(db, assets).await?; }
                contents::run(db, assets, sync).await
            }.await;
            finish(sync, app, &result);
            result
        } => result,
    };
    if lifetime.is_cancelled() {
        settled(sync, app, None);
    }
    result
}

struct Schedule {
    pending_since: Option<Instant>,
    next_pull: Instant,
    retry_at: Instant,
    failures: u32,
}

impl Schedule {
    fn new(now: Instant) -> Self {
        Self {
            pending_since: None,
            next_pull: now,
            retry_at: now,
            failures: 0,
        }
    }

    fn requested(&mut self, now: Instant, sources: u8, last_exchange: Option<Instant>) -> bool {
        if sources & WakeSource::Foreground as u8 != 0
            && last_exchange.is_none_or(|last| now.duration_since(last) >= FOREGROUND_INTERVAL)
        {
            self.next_pull = self.next_pull.min(now);
        }
        sources & WakeSource::Immediate as u8 != 0
    }

    fn due(&mut self, now: Instant, pending: bool, wake: bool) -> bool {
        self.pending_since = if pending {
            Some(self.pending_since.unwrap_or(now))
        } else {
            None
        };
        (wake || now >= self.retry_at)
            && (wake
                || now >= self.next_pull
                || self
                    .pending_since
                    .is_some_and(|since| now.duration_since(since) >= UPLOAD_DELAY))
    }

    fn completed(&mut self, now: Instant, success: bool, waiting: bool) {
        if success || waiting {
            self.failures = 0;
            self.retry_at = now;
            self.next_pull = now + if waiting { CHECK } else { PULL_INTERVAL };
            self.pending_since = None;
        } else {
            self.retry_at =
                now + Duration::from_secs((15u64 * 2u64.pow(self.failures.min(5))).min(300));
            self.failures += 1;
        }
    }
}

pub(crate) fn spawn(app: AppHandle) {
    app.state::<SyncConnection>()
        .app
        .set(app.clone())
        .expect("sync scheduler starts once");
    tauri::async_runtime::spawn(async move {
        let mut clock = tokio::time::interval(CHECK);
        let mut schedule = Schedule::new(Instant::now());
        loop {
            let sync = app.state::<SyncConnection>();
            tokio::select! {
                _ = sync.wake.notified() => {},
                _ = clock.tick() => {},
            }
            let sources = sync
                .wake_sources
                .swap(0, std::sync::atomic::Ordering::AcqRel);
            let last_exchange = snapshot(&sync).last_exchange;
            let explicit_wake = schedule.requested(Instant::now(), sources, last_exchange);
            let db = app.state::<Workspace>();
            // A cancelled exit replaces this token. The application task stays alive.
            if db.running_lifetime().is_cancelled() {
                continue;
            }
            let attempt = async {
                let Some(binding) = Binding::read(&db)? else {
                    return Ok(None);
                };
                if binding.paused {
                    return Ok(None);
                };
                if !explicit_wake
                    && snapshot(&sync).error.as_ref().is_some_and(|error| {
                        matches!(error.code.as_str(), "SYNC_CREDENTIAL" | "SYNC_REAUTH")
                    })
                {
                    return Ok(None);
                }
                let Some(activity) = contents::activity(&db)? else {
                    return Ok(None);
                };
                if contents::has_staged_baseline(&db)? {
                    return Ok(None);
                };
                if !schedule.due(Instant::now(), activity.pending, explicit_wake) {
                    return Ok(None);
                };
                let result = run(&app, &db, &app.state::<Assets>(), &sync, RunSource::Automatic).await;
                Ok(Some(result))
            }
            .await;
            match attempt {
                Ok(Some(result)) => {
                    let waiting = result
                        .as_ref()
                        .is_err_and(|error| error.code() == "SYNC_WAITING_SEED");
                    schedule.completed(Instant::now(), result.is_ok(), waiting);
                }
                Ok(None) => {}
                Err(error) => {
                    let result: Result<()> = Err(error);
                    finish(&sync, &app, &result);
                    schedule.completed(Instant::now(), false, false);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_delay_pull_backoff_and_explicit_wake() {
        let now = Instant::now();
        let mut clock = Schedule::new(now);
        assert!(clock.due(now, false, false));
        clock.completed(now, true, false);
        assert!(!clock.due(now, true, false));
        assert!(!clock.due(now + Duration::from_secs(29), true, false));
        assert!(clock.due(now + UPLOAD_DELAY, true, false));
        clock.completed(now, false, false);
        assert!(!clock.due(now + Duration::from_secs(14), true, false));
        assert!(clock.due(now, true, true));
        clock.completed(now, true, false);
        assert!(clock.due(now + PULL_INTERVAL, false, false));
        clock.completed(now, false, true);
        assert!(!clock.due(now + Duration::from_secs(4), false, false));
        assert!(clock.due(now + CHECK, false, false));
    }

    #[test]
    fn foreground_skips_recent_success_without_scheduling_a_delayed_pull() {
        let now = Instant::now();
        let mut clock = Schedule::new(now);
        clock.completed(now, true, false);
        for second in [1, 5, 29] {
            let instant = now + Duration::from_secs(second);
            assert!(!clock.requested(instant, WakeSource::Foreground as u8, Some(now)));
            assert!(!clock.due(instant, false, false));
        }
        assert!(!clock.due(now + FOREGROUND_INTERVAL, false, false));
        assert!(!clock.requested(
            now + FOREGROUND_INTERVAL,
            WakeSource::Foreground as u8,
            Some(now)
        ));
        assert!(clock.due(now + FOREGROUND_INTERVAL, false, false));
    }

    #[test]
    fn foreground_uses_latest_success_including_manual_sync() {
        let now = Instant::now();
        let mut clock = Schedule::new(now);
        clock.completed(now, true, false);
        let manual_success = now + Duration::from_secs(25);
        let restored = now + Duration::from_secs(35);
        assert!(!clock.requested(restored, WakeSource::Foreground as u8, Some(manual_success)));
        assert!(!clock.due(restored, false, false));
        let restored = manual_success + FOREGROUND_INTERVAL;
        assert!(!clock.requested(restored, WakeSource::Foreground as u8, Some(manual_success)));
        assert!(clock.due(restored, false, false));
    }

    #[test]
    fn foreground_without_success_checks_immediately() {
        let now = Instant::now();
        let mut clock = Schedule::new(now);
        clock.next_pull = now + PULL_INTERVAL;
        assert!(!clock.requested(now, WakeSource::Foreground as u8, None));
        assert!(clock.due(now, false, false));
    }

    #[test]
    fn immediate_wake_bypasses_foreground_interval_and_failure_backoff() {
        let now = Instant::now();
        let mut clock = Schedule::new(now);
        clock.completed(now, true, false);
        clock.completed(now + CHECK, false, false);
        for sources in [
            WakeSource::Immediate as u8,
            WakeSource::Immediate as u8 | WakeSource::Foreground as u8,
        ] {
            let immediate = clock.requested(now + CHECK, sources, Some(now));
            assert!(immediate);
            assert!(clock.due(now + CHECK, false, immediate));
        }
    }

    #[test]
    fn foreground_advances_pull_but_keeps_failed_retry_deadline() {
        let now = Instant::now();
        let mut clock = Schedule::new(now);
        clock.completed(now - FOREGROUND_INTERVAL, true, false);
        assert!(!clock.due(now + CHECK, false, false));
        assert!(!clock.requested(
            now + CHECK,
            WakeSource::Foreground as u8,
            Some(now - FOREGROUND_INTERVAL)
        ));
        assert!(clock.due(now + CHECK, false, false));

        clock.completed(now + CHECK, false, false);
        for second in 6..20 {
            let instant = now + Duration::from_secs(second);
            assert!(!clock.requested(
                instant,
                WakeSource::Foreground as u8,
                Some(now - FOREGROUND_INTERVAL)
            ));
            assert!(!clock.due(instant, false, false));
        }
        assert!(clock.due(now + Duration::from_secs(20), false, false));
        clock.completed(now + Duration::from_secs(20), true, false);
        assert!(!clock.due(now + Duration::from_secs(21), false, false));
    }

    #[test]
    fn foreground_waiting_for_baseline_keeps_the_advanced_pull() {
        let now = Instant::now();
        let mut clock = Schedule::new(now);
        clock.completed(now, true, false);
        clock.requested(
            now + FOREGROUND_INTERVAL,
            WakeSource::Foreground as u8,
            Some(now),
        );
        // The completed baseline prevents an exchange until the next safe replay.
        assert!(clock.due(now + FOREGROUND_INTERVAL + CHECK, false, false));
    }

    #[tokio::test]
    async fn merged_wake_sources_keep_immediate_priority_in_either_order() {
        use std::sync::atomic::Ordering;
        for first in [WakeSource::Foreground, WakeSource::Immediate] {
            let sync = SyncConnection::new().unwrap();
            sync.request_wake(first);
            sync.request_wake(WakeSource::Foreground);
            sync.wake();
            sync.request_wake(WakeSource::Foreground);
            sync.wake.notified().await;
            let sources = sync.wake_sources.swap(0, Ordering::AcqRel);
            assert_eq!(
                sources,
                WakeSource::Foreground as u8 | WakeSource::Immediate as u8
            );
            let now = Instant::now();
            let mut clock = Schedule::new(now);
            clock.completed(now, false, false);
            let immediate = clock.requested(now, sources, None);
            assert!(immediate);
            assert!(clock.due(now, false, immediate));
            assert_eq!(sync.wake_sources.load(Ordering::Acquire), 0);
        }
    }
}
