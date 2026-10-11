//! Wait for each board to acknowledge persisted editor buffers before taking a snapshot.
use crate::AppState;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Listener, Manager};

static NEXT_REQUEST: AtomicUsize = AtomicUsize::new(1);
#[derive(Deserialize)]
struct Ack {
    request: usize,
    label: String,
    error: Option<String>,
}

fn wait_for(
    rx: mpsc::Receiver<Ack>,
    request: usize,
    mut labels: HashSet<String>,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while !labels.is_empty() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let ack = rx
            .recv_timeout(remaining)
            .map_err(|_| "Timed out saving board edits".to_string())?;
        if ack.request != request || !labels.remove(&ack.label) {
            continue;
        }
        if let Some(error) = ack.error {
            return Err(error);
        }
    }
    Ok(())
}

/// Must run off the UI thread so boards can invoke their write commands while we wait.
pub fn boards(app: &AppHandle) -> Result<(), String> {
    let labels: HashSet<String> = app.state::<AppState>().labels().into_iter().collect();
    if labels.is_empty() {
        return Ok(());
    }
    let request = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    let listener = app.listen("saves-flushed", move |event| {
        if let Ok(ack) = serde_json::from_str::<Ack>(event.payload()) {
            let _ = tx.send(ack);
        }
    });
    let result = (|| {
        for label in &labels {
            app.emit_to(label, "flush-saves", json!({ "request": request }))
                .map_err(|e| e.to_string())?;
        }
        wait_for(rx, request, labels, Duration::from_secs(10))
    })();
    app.unlisten(listener);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ack(request: usize, label: &str, error: Option<&str>) -> Ack {
        Ack {
            request,
            label: label.into(),
            error: error.map(str::to_string),
        }
    }
    fn labels() -> HashSet<String> {
        ["a".into(), "b".into()].into_iter().collect()
    }
    #[test]
    fn waits_for_every_board_and_ignores_other_requests() {
        let (tx, rx) = mpsc::channel();
        tx.send(ack(0, "b", None)).unwrap();
        tx.send(ack(1, "a", None)).unwrap();
        tx.send(ack(1, "a", None)).unwrap();
        tx.send(ack(1, "b", None)).unwrap();
        assert!(wait_for(rx, 1, labels(), Duration::from_secs(1)).is_ok());
    }
    #[test]
    fn failed_save_prevents_snapshot() {
        let (tx, rx) = mpsc::channel();
        tx.send(ack(1, "a", Some("disk full"))).unwrap();
        assert_eq!(
            wait_for(rx, 1, labels(), Duration::from_secs(1)),
            Err("disk full".into())
        );
    }
    #[test]
    fn missing_board_prevents_snapshot() {
        let (tx, rx) = mpsc::channel();
        tx.send(ack(1, "a", None)).unwrap();
        assert!(wait_for(rx, 1, labels(), Duration::from_millis(1)).is_err());
    }
}
