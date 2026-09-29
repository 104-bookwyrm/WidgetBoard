//! "Now playing": reads Windows' system media controls (the same source as the volume flyout /
//! lock screen), so YouTube in Chrome/Edge/Whale/Firefox, Spotify, the Media Player app etc. all work.
//! A background thread polls once a second and emits a `media` event only when something changed;
//! commands (play/pause, next, previous, seek, switch source) are sent to that thread over a channel.

use serde_json::{json, Value};
use std::sync::{mpsc, Arc, Mutex};

pub enum Cmd {
    PlayPause,
    Next,
    Prev,
    Seek(f64), // seconds from the start
    Cycle,     // show the next media source (e.g. Spotify <-> Chrome)
}

pub struct Media {
    tx: Mutex<Option<mpsc::Sender<Cmd>>>,
    pub last: Arc<Mutex<Value>>,
}

impl Media {
    pub fn new() -> Self {
        Self { tx: Mutex::new(None), last: Arc::new(Mutex::new(json!({ "has": false }))) }
    }

    /// Start the watcher on first use (nothing runs while no Now Playing widget exists).
    pub fn ensure_started(&self, emit: impl Fn(Value) + Send + 'static) {
        let mut tx = self.tx.lock().unwrap();
        if tx.is_some() {
            return;
        }
        let (s, r) = mpsc::channel();
        *tx = Some(s);
        imp::run(r, self.last.clone(), emit);
    }

    pub fn send(&self, cmd: Cmd) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(cmd);
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::Cmd;
    use base64::Engine;
    use serde_json::{json, Value};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    const TICKS: f64 = 10_000_000.0; // 100 ns units per second
    const EPOCH_1601_TO_1970_TICKS: i64 = 116_444_736_000_000_000;

    fn sessions(m: &Manager) -> Vec<Session> {
        m.GetSessions()
            .map(|v| (0..v.Size().unwrap_or(0)).filter_map(|i| v.GetAt(i).ok()).collect())
            .unwrap_or_default()
    }
    fn source(s: &Session) -> String {
        s.SourceAppUserModelId().map(|h| h.to_string_lossy()).unwrap_or_default()
    }
    /// The pinned source if it is still there, otherwise whatever Windows considers current.
    fn pick(m: &Manager, pinned: &Option<String>) -> Option<Session> {
        if let Some(p) = pinned {
            if let Some(s) = sessions(m).into_iter().find(|s| &source(s) == p) {
                return Some(s);
            }
        }
        m.GetCurrentSession().ok()
    }

    fn thumbnail(s: &Session) -> Option<String> {
        let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()?;
        if size == 0 || size > 8 * 1024 * 1024 {
            return None;
        }
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        reader.LoadAsync(size as u32).ok()?.get().ok()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).ok()?;
        let ct = stream.ContentType().map(|h| h.to_string_lossy()).unwrap_or_default();
        let ct = if ct.starts_with("image/") { ct } else { "image/png".into() };
        Some(format!("data:{ct};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
    }

    struct Cache {
        key: String,
        thumb: Option<String>,
    }

    fn describe(s: &Session, count: usize, cache: &mut Cache) -> windows::core::Result<Value> {
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let title = props.Title()?.to_string_lossy();
        let artist = props.Artist()?.to_string_lossy();
        let album = props.AlbumTitle().map(|h| h.to_string_lossy()).unwrap_or_default();
        let src = source(s);
        let key = format!("{src}\u{1}{title}\u{1}{artist}");
        if key != cache.key {
            cache.key = key;
            cache.thumb = thumbnail(s); // only re-read when the track changes
        }
        let info = s.GetPlaybackInfo()?;
        let status = match info.PlaybackStatus()? {
            Status::Playing => "playing",
            Status::Paused => "paused",
            Status::Stopped => "stopped",
            _ => "other",
        };
        let c = info.Controls()?;
        let tl = s.GetTimelineProperties()?;
        let start = tl.StartTime().map(|t| t.Duration).unwrap_or(0) as f64 / TICKS;
        let end = tl.EndTime().map(|t| t.Duration).unwrap_or(0) as f64 / TICKS;
        let pos = tl.Position().map(|t| t.Duration).unwrap_or(0) as f64 / TICKS;
        let updated = tl
            .LastUpdatedTime()
            .map(|d| (d.UniversalTime - EPOCH_1601_TO_1970_TICKS) / 10_000)
            .unwrap_or(0);
        Ok(json!({
            "has": true,
            "title": title, "artist": artist, "album": album, "source": src,
            "status": status,
            "position": (pos - start).max(0.0), "duration": (end - start).max(0.0), "updatedAt": updated,
            "canPlayPause": c.IsPlayPauseToggleEnabled().unwrap_or(true),
            "canNext": c.IsNextEnabled().unwrap_or(false),
            "canPrev": c.IsPreviousEnabled().unwrap_or(false),
            "canSeek": c.IsPlaybackPositionEnabled().unwrap_or(false),
            "sessions": count,
            "thumb": cache.thumb,
        }))
    }

    pub fn run(rx: mpsc::Receiver<Cmd>, last: Arc<Mutex<Value>>, emit: impl Fn(Value) + Send + 'static) {
        std::thread::spawn(move || {
            unsafe {
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
            }
            let mut mgr: Option<Manager> = None;
            let mut pinned: Option<String> = None;
            let mut cache = Cache { key: String::new(), thumb: None };
            loop {
                let cmd = match rx.recv_timeout(Duration::from_millis(1000)) {
                    Ok(c) => Some(c),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(_) => return,
                };
                if mgr.is_none() {
                    mgr = Manager::RequestAsync().and_then(|op| op.get()).ok();
                }
                let Some(m) = mgr.as_ref() else { continue };
                if let Some(cmd) = cmd {
                    let cur = pick(m, &pinned);
                    match (cmd, cur.as_ref()) {
                        (Cmd::Cycle, cur) => {
                            let all = sessions(m);
                            if !all.is_empty() {
                                let i = cur.and_then(|c| all.iter().position(|s| source(s) == source(c)));
                                pinned = Some(source(&all[i.map_or(0, |i| (i + 1) % all.len())]));
                            }
                        }
                        (Cmd::PlayPause, Some(s)) => drop(s.TryTogglePlayPauseAsync().and_then(|o| o.get())),
                        (Cmd::Next, Some(s)) => drop(s.TrySkipNextAsync().and_then(|o| o.get())),
                        (Cmd::Prev, Some(s)) => drop(s.TrySkipPreviousAsync().and_then(|o| o.get())),
                        (Cmd::Seek(sec), Some(s)) => {
                            let start = s.GetTimelineProperties().and_then(|t| t.StartTime()).map(|t| t.Duration).unwrap_or(0);
                            drop(s.TryChangePlaybackPositionAsync(start + (sec.max(0.0) * TICKS) as i64).and_then(|o| o.get()));
                        }
                        _ => {}
                    }
                    std::thread::sleep(Duration::from_millis(150)); // let the player react before re-reading
                }
                let count = sessions(m).len();
                let payload = match pick(m, &pinned) {
                    Some(s) => describe(&s, count, &mut cache).unwrap_or_else(|_| json!({ "has": false })),
                    None => json!({ "has": false }),
                };
                let mut l = last.lock().unwrap();
                if *l != payload {
                    *l = payload.clone();
                    drop(l);
                    emit(payload);
                }
            }
        });
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Cmd;
    use serde_json::{json, Value};
    use std::sync::{mpsc, Arc, Mutex};
    pub fn run(_rx: mpsc::Receiver<Cmd>, last: Arc<Mutex<Value>>, _emit: impl Fn(Value) + Send + 'static) {
        *last.lock().unwrap() = json!({ "has": false, "unsupported": true });
    }
}
