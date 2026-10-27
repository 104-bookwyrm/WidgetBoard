// WidgetBoard — v0.11
// Rust side: one transparent board window per monitor, tray menu (translated), click-through
// hit testing, layout/settings storage, theme hot-reload.
// Everything visual lives in ../ui (plain HTML/CSS/JS, no build step).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

mod backup_policy;
mod content;
mod flush;
mod layer;
mod media;
mod migrate;
mod updater;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    ipc::{InvokeBody, Request},
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::ScrollBarStyle,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

const DEFAULT_THEME: &str = include_str!("../../ui/default-theme.css");
const DEFAULT_CONFIG: &str = include_str!("default-config.json");
const TRAY_ID: &str = "main";

/// Widget groups for the add menus (same file the UI loads); ids must match the REGISTRY in ui/app.js.
fn widget_groups() -> &'static Vec<(String, Vec<String>)> {
    static G: OnceLock<Vec<(String, Vec<String>)>> = OnceLock::new();
    G.get_or_init(|| {
        #[derive(Deserialize)]
        struct Group { id: String, widgets: Vec<String> }
        let v: Vec<Group> = serde_json::from_str(include_str!("../../ui/widgets/groups.json")).unwrap_or_default();
        v.into_iter().map(|g| (g.id, g.widgets)).collect()
    })
}
fn widget_ids() -> Vec<&'static str> {
    widget_groups().iter().flat_map(|(_, w)| w.iter().map(String::as_str)).collect()
}

/// Tray menu order (same file the demo reads): (id, label key) per entry, "-" is a separator.
/// Ids must be ones `build_menu` knows (TRAY_PLAIN plus the special-cased add and edit).
/// Kept short on purpose: language, theme, data folder and update checks live in Settings.
const TRAY_PLAIN: &[&str] = &["toggle", "library", "settings", "quit"];
fn tray_menu() -> &'static Vec<(String, String)> {
    static M: OnceLock<Vec<(String, String)>> = OnceLock::new();
    M.get_or_init(|| {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Entry { Item { id: String, label: String }, Sep(#[allow(dead_code)] String) }
        let v: Vec<Entry> = serde_json::from_str(include_str!("../../ui/tray-menu.json")).unwrap_or_default();
        v.into_iter()
            .map(|e| match e {
                Entry::Item { id, label } => (id, label),
                Entry::Sep(_) => ("-".to_string(), String::new()),
            })
            .collect()
    })
}

/// Embedded translations: only native.json (the keys Rust reads); the UI loads the rest. First entry is the default language.
const LOCALES: &[(&str, &str)] = &[
    ("ko", include_str!("../../ui/locales/ko/native.json")),
    ("en", include_str!("../../ui/locales/en/native.json")),
];

fn locales() -> &'static HashMap<&'static str, HashMap<String, String>> {
    static L: OnceLock<HashMap<&'static str, HashMap<String, String>>> = OnceLock::new();
    L.get_or_init(|| {
        LOCALES
            .iter()
            .map(|(code, src)| (*code, serde_json::from_str(src).unwrap_or_default()))
            .collect()
    })
}

fn tr(lang: &str, key: &str) -> String {
    [lang, "en"]
        .iter()
        .find_map(|l| locales().get(l).and_then(|m| m.get(key)).cloned())
        .unwrap_or_else(|| key.to_string())
}

// ---------- state ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    lang: String,
    reduce_motion: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self { lang: LOCALES[0].0.into(), reduce_motion: false }
    }
}

#[derive(Serialize, Clone)]
struct Board {
    label: String,   // window label, e.g. board-0
    display: String, // monitor name, e.g. \\.\DISPLAY2 (stored on each widget)
    index: usize,    // 1-based, for "Display 2"
    primary: bool,
}

#[derive(Deserialize, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

struct TrayItems {
    edit: CheckMenuItem<Wry>,
}

struct AppState {
    dir: PathBuf,
    widgets: Mutex<Vec<Value>>,
    content: Mutex<serde_json::Map<String, Value>>, // Library items (content.rs)
    revs: Mutex<HashMap<String, u64>>, // per-session revision of each shared store / diary page
    migrate_error: Option<String>, // shown once on the primary board
    settings: Mutex<Settings>,
    boards: Mutex<Vec<Board>>,
    hits: Mutex<HashMap<String, Vec<Rect>>>,
    interacting: AtomicBool,
    edit: AtomicBool,
    tray_items: Mutex<Option<TrayItems>>,
    generation: AtomicUsize, // board windows are recreated when monitors change
    media: media::Media,
    // accessibility (all off by default)
    kbd: AtomicBool,           // keyboard mode (global shortcut): boards take the keyboard and mouse
    dwell_ms: AtomicUsize,     // hover this long before a widget takes clicks
    zoom: Mutex<f64>,          // whole-UI zoom
    // self-update (portable exe): see updater.rs
    update_busy: AtomicBool,
    just_updated: Mutex<Option<String>>, // shown once as a toast after an update installed
    demo_origin: Mutex<String>, // latest window that requested the reusable tutorial demo
    session: Value, // { launched, closed } in ms: this launch, and the last proper exit before it (closed.json)
}

impl AppState {
    fn persist_widgets(&self) -> Result<(), String> {
        let data = json!({ "version": migrate::LAYOUT_SCHEMA, "widgets": *self.widgets.lock().unwrap() });
        write_atomic(&self.dir.join("layout.json"), serde_json::to_string_pretty(&data).unwrap().as_bytes())
    }
    fn persist_settings(&self) {
        // app settings now live under config.json "app" (merged from the old settings.json in v0.12).
        if config_broken(&self.dir) {
            return; // applies for this session; the unreadable file is left for the user to fix
        }
        let s = self.settings.lock().unwrap().clone();
        let mut cfg = read_config(&self.dir);
        if !cfg.is_object() {
            cfg = json!({});
        }
        cfg["app"] = serde_json::to_value(&s).unwrap_or(Value::Null);
        let _ = write_atomic(
            &self.dir.join("config.json"),
            serde_json::to_string_pretty(&cfg).unwrap().as_bytes(),
        );
    }
    fn primary_label(&self) -> Option<String> {
        let boards = self.boards.lock().unwrap();
        boards.iter().find(|b| b.primary).or(boards.first()).map(|b| b.label.clone())
    }
    fn labels(&self) -> Vec<String> {
        self.boards.lock().unwrap().iter().map(|b| b.label.clone()).collect()
    }
}

// ---------- helpers ----------

/// Set while a backup restore copies files: data writes are refused until the relaunch, so a late save
/// can't put stale data over the restored files. Windows show it (the `restoring` event).
static RESTORING: AtomicBool = AtomicBool::new(false);
fn writable() -> Result<(), String> {
    if RESTORING.load(Ordering::SeqCst) { Err("restoring a backup".into()) } else { Ok(()) }
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    writable()?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// FNV-1a 64 — stable content hash so identical uploads share one file.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn open_path(p: &Path) {
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(p).spawn();
    #[cfg(not(windows))]
    let _ = std::process::Command::new("xdg-open").arg(p).spawn();
}

/// Open an http(s) link in the default browser (event reminder / calendar links). Only http(s) is
/// allowed so we never hand an arbitrary scheme (file:, javascript:, …) to the shell.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("unsupported url scheme".into());
    }
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(&url).spawn();
    #[cfg(not(windows))]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    Ok(())
}

fn boards(app: &AppHandle) -> Vec<WebviewWindow> {
    let st = app.state::<AppState>();
    st.labels().iter().filter_map(|l| app.get_webview_window(l)).collect()
}

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 40 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn valid_date(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// config.json exists but isn't valid JSON (a hand-edit typo). It must never be overwritten then:
/// the user's settings are still in it. The app runs on defaults until the file is fixed.
fn config_broken(dir: &Path) -> bool {
    fs::read_to_string(dir.join("config.json"))
        .map_or(false, |s| serde_json::from_str::<Value>(&s).is_err())
}

fn read_config(dir: &Path) -> Value {
    read_json(&dir.join("config.json"))
        .or_else(|| serde_json::from_str(DEFAULT_CONFIG).ok())
        .unwrap_or(Value::Null)
}

/// App settings: from config.json "app" (v0.12+), falling back to the old settings.json.
fn load_settings(dir: &Path) -> Settings {
    let cfg = read_config(dir);
    if let Some(app) = cfg.get("app") {
        if app.is_object() {
            if let Ok(s) = serde_json::from_value::<Settings>(app.clone()) {
                return s;
            }
        }
    }
    read_json(&dir.join("settings.json")).unwrap_or_default()
}

/// One-time v0.12 migration: fold settings.json into config.json "app", and the legacy
/// checklist.weekStart into ui.weekStart. Idempotent; leaves settings.json in place for rollback.
fn migrate_config(dir: &Path) {
    if config_broken(dir) {
        return; // never replace a file we can't read
    }
    let mut cfg = read_config(dir);
    if !cfg.is_object() {
        cfg = json!({});
    }
    let mut changed = false;
    if cfg.get("app").map_or(true, |a| !a.is_object()) {
        let legacy: Settings = read_json(&dir.join("settings.json")).unwrap_or_default();
        cfg["app"] = serde_json::to_value(&legacy).unwrap_or(Value::Null);
        changed = true;
    }
    if cfg.get("ui").and_then(|u| u.get("weekStart")).is_none() {
        if let Some(wk) = cfg.get("checklist").and_then(|c| c.get("weekStart")).cloned() {
            if !cfg.get("ui").map_or(false, |u| u.is_object()) {
                cfg["ui"] = json!({});
            }
            cfg["ui"]["weekStart"] = wk;
            changed = true;
        }
    }
    if changed {
        let _ = write_atomic(
            &dir.join("config.json"),
            serde_json::to_string_pretty(&cfg).unwrap().as_bytes(),
        );
    }
}

fn widget_id(w: &Value) -> Option<&str> {
    w.get("id").and_then(Value::as_str)
}

// ---------- commands ----------

/// Everything a board window needs at startup: its display, its widgets, theme, language.
#[tauri::command]
fn load_state(window: WebviewWindow, state: State<AppState>) -> Value {
    let boards = state.boards.lock().unwrap().clone();
    let me = boards.iter().find(|b| b.label == window.label()).cloned();
    let (my_display, i_am_primary) =
        me.as_ref().map(|b| (b.display.clone(), b.primary)).unwrap_or_default();
    let present: HashSet<&str> = boards.iter().map(|b| b.display.as_str()).collect();
    let pin = window.label().strip_prefix("pin-");
    // Widgets whose monitor is missing (unplugged, or older layout) show on the primary board.
    // A pin window gets only its own widget.
    let widgets: Vec<Value> = state
        .widgets
        .lock()
        .unwrap()
        .iter()
        .filter(|w| match (pin, w.get("display").and_then(Value::as_str)) {
            (Some(id), _) => widget_id(w) == Some(id),
            (None, Some(d)) if present.contains(d) => d == my_display,
            _ => i_am_primary,
        })
        .cloned()
        .collect();
    let my_display = match pin {
        Some(_) => widgets.first().and_then(|w| w.get("display")).and_then(Value::as_str).unwrap_or_default().to_string(),
        None => my_display,
    };
    // a board keeps a pinned widget's spot but does not run it (its pin window does)
    let pinned: Vec<String> = match pin {
        Some(_) => vec![],
        None => pins(window.app_handle()).iter().filter_map(|w| w.label().strip_prefix("pin-").map(str::to_string)).collect(),
    };
    let theme =
        fs::read_to_string(state.dir.join("theme.css")).unwrap_or_else(|_| DEFAULT_THEME.into());
    let settings = state.settings.lock().unwrap().clone();
    json!({
        "display": my_display,
        "primary": i_am_primary,
        "displays": boards,
        "widgets": widgets,
        "pinned": pinned,
        "theme": theme,
        "lang": settings.lang,
        "reduceMotion": settings.reduce_motion,
        "edit": state.edit.load(Ordering::Relaxed),
        "config": read_config(&state.dir),
        "autostart": autostart_get(),
        "configBroken": i_am_primary && config_broken(&state.dir),
        "migrateError": if i_am_primary { state.migrate_error.clone() } else { None },
        "assetsDir": state.dir.join("assets"),
        "version": updater::CURRENT,
        "justUpdated": if i_am_primary { state.just_updated.lock().unwrap().take() } else { None },
        "session": state.session,
    })
}

/// Insert or replace one widget (matched by id).
#[tauri::command]
fn put_widget(state: State<AppState>, widget: Value) -> Result<(), String> {
    let id = widget_id(&widget).ok_or("widget without id")?.to_string();
    {
        let mut ws = state.widgets.lock().unwrap();
        match ws.iter_mut().find(|w| widget_id(w) == Some(&id)) {
            Some(slot) => *slot = widget,
            None => ws.push(widget),
        }
    }
    state.persist_widgets()
}

#[tauri::command]
fn remove_widget(state: State<AppState>, id: String) -> Result<(), String> {
    state.widgets.lock().unwrap().retain(|w| widget_id(w) != Some(&id));
    state.persist_widgets()
}

/// Hand a widget to another monitor's board; that board finds a free spot for it.
#[tauri::command]
fn move_widget(app: AppHandle, state: State<AppState>, id: String, display: String) -> Result<(), String> {
    let label = state
        .boards
        .lock()
        .unwrap()
        .iter()
        .find(|b| b.display == display)
        .map(|b| b.label.clone())
        .ok_or("display not found")?;
    let widget = {
        let mut ws = state.widgets.lock().unwrap();
        let w = ws.iter_mut().find(|w| widget_id(w) == Some(&id)).ok_or("widget not found")?;
        w["display"] = json!(display);
        w.clone()
    };
    state.persist_widgets()?;
    app.emit_to(&label, "widget-arrived", widget).map_err(|e| e.to_string())
}

/// Shared JSON data (e.g. calendar events) in data/<key>.json, visible to every widget/monitor.
#[tauri::command]
fn store_get(state: State<AppState>, key: String) -> Result<Value, String> {
    if !valid_key(&key) {
        return Err("bad key".into());
    }
    Ok(read_json(&state.dir.join("data").join(format!("{key}.json"))).unwrap_or(Value::Null))
}

/// A shared store's value with its revision, for a later `store_set` with `rev`.
#[tauri::command]
fn store_read(state: State<AppState>, key: String) -> Result<Value, String> {
    let rev = state.revs.lock().unwrap().get(&format!("store:{key}")).copied().unwrap_or(0);
    Ok(json!({ "value": store_get(state, key)?, "rev": rev }))
}

/// Compare `rev` (when given) and bump the revision under one lock; `write` runs inside it. Err("conflict") if stale.
fn with_rev(state: &AppState, slot: String, rev: Option<u64>, write: impl FnOnce() -> Result<(), String>) -> Result<u64, String> {
    let mut revs = state.revs.lock().unwrap();
    let current = revs.get(&slot).copied().unwrap_or(0);
    if rev.is_some_and(|r| r != current) {
        return Err("conflict".into());
    }
    write()?;
    revs.insert(slot, current + 1);
    Ok(current + 1)
}

/// `src` identifies the writing widget so it can ignore its own change notification. `rev` (optional) is the
/// revision the writer last read; a stale one is refused. Returns the new revision.
#[tauri::command]
fn store_set(app: AppHandle, state: State<AppState>, key: String, value: Value, src: String, rev: Option<u64>) -> Result<u64, String> {
    if !valid_key(&key) {
        return Err("bad key".into());
    }
    let s = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    let path = state.dir.join("data").join(format!("{key}.json"));
    let rev = with_rev(&state, format!("store:{key}"), rev, || write_atomic(&path, s.as_bytes()))?;
    let _ = app.emit("store-changed", json!({ "key": key, "src": src, "rev": rev }));
    Ok(rev)
}

/// Diary: one Markdown file per day in diary/YYYY-MM-DD.md.
#[tauri::command]
fn diary_get(state: State<AppState>, date: String) -> Result<String, String> {
    if !valid_date(&date) {
        return Err("bad date".into());
    }
    Ok(fs::read_to_string(state.dir.join("diary").join(format!("{date}.md"))).unwrap_or_default())
}

/// A diary page with its revision, for a later `diary_set` with `rev`.
#[tauri::command]
fn diary_read(state: State<AppState>, date: String) -> Result<Value, String> {
    let rev = state.revs.lock().unwrap().get(&format!("diary:{date}")).copied().unwrap_or(0);
    Ok(json!({ "text": diary_get(state, date)?, "rev": rev }))
}

#[tauri::command]
fn diary_set(app: AppHandle, state: State<AppState>, date: String, text: String, src: String, rev: Option<u64>) -> Result<u64, String> {
    if !valid_date(&date) {
        return Err("bad date".into());
    }
    writable()?;
    let path = state.dir.join("diary").join(format!("{date}.md"));
    let rev = with_rev(&state, format!("diary:{date}"), rev, || {
        if text.trim().is_empty() {
            let _ = fs::remove_file(&path);
            Ok(())
        } else {
            write_atomic(&path, text.as_bytes())
        }
    })?;
    let _ = app.emit("store-changed", json!({ "key": "diary", "date": date, "src": src, "rev": rev }));
    Ok(rev)
}

/// Every diary page as { date: text }, for search.
#[tauri::command]
fn diary_all(state: State<AppState>) -> serde_json::Map<String, Value> {
    diary_dates(state.clone())
        .into_iter()
        .filter_map(|d| Some((d.clone(), json!(fs::read_to_string(state.dir.join("diary").join(format!("{d}.md"))).ok()?))))
        .collect()
}

/// Dates that have a diary page, sorted ascending.
#[tauri::command]
fn diary_dates(state: State<AppState>) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(state.dir.join("diary"))
        .map(|rd| {
            rd.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter_map(|n| n.strip_suffix(".md").map(str::to_string))
                .filter(|d| valid_date(d))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Uploaded images, newest first (for the D-day icon picker).
#[tauri::command]
fn list_assets(state: State<AppState>) -> Vec<String> {
    let mut v: Vec<(SystemTime, String)> = fs::read_dir(state.dir.join("assets"))
        .map(|rd| {
            rd.filter_map(|e| {
                let e = e.ok()?;
                let t = e.metadata().ok()?.modified().ok()?;
                Some((t, e.file_name().into_string().ok()?))
            })
            .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, n)| n).collect()
}

/// Installed font families (from the Windows font registry), de-duplicated.
#[tauri::command]
fn list_fonts() -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        const STYLES: &[&str] = &[
            "Regular", "Bold", "Italic", "Oblique", "Light", "Thin", "Medium", "Black", "Heavy",
            "Semibold", "SemiBold", "Semilight", "SemiLight", "ExtraLight", "ExtraBold", "UltraLight",
            "UltraBold", "DemiBold", "Demibold", "Condensed", "SemiCondensed", "Narrow", "Book",
        ];
        let path = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            let Ok(key) = RegKey::predef(hive).open_subkey(path) else { continue };
            for (name, _) in key.enum_values().flatten() {
                let base = name.split(" (").next().unwrap_or(&name).to_string();
                for part in base.split(" & ") {
                    let mut words: Vec<&str> = part.split_whitespace().collect();
                    while words.len() > 1 && STYLES.contains(words.last().unwrap()) {
                        words.pop();
                    }
                    let fam = words.join(" ");
                    if !fam.is_empty() {
                        set.insert(fam);
                    }
                }
            }
        }
    }
    set.into_iter().collect()
}

#[tauri::command]
fn save_theme(app: AppHandle, state: State<AppState>, css: String) -> Result<(), String> {
    write_atomic(&state.dir.join("theme.css"), css.as_bytes())?;
    let _ = app.emit("theme-changed", css); // instant preview; don't wait for the file-watch poll
    Ok(())
}

/// Raw binary upload. JS: invoke('save_asset', uint8array, { headers: { ext: 'png' } })
#[tauri::command]
fn save_asset(state: State<AppState>, request: Request) -> Result<String, String> {
    writable()?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let ext: String = request
        .headers()
        .get("ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("png")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect::<String>()
        .to_lowercase();
    let ext = if ext.is_empty() { "png".into() } else { ext };
    let name = format!("{:016x}.{}", fnv1a(bytes), ext);
    let path = state.dir.join("assets").join(&name);
    if !path.exists() {
        fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(name)
}

/// Widget rectangles in CSS pixels, relative to the calling board window.
#[tauri::command]
fn set_hit_rects(window: WebviewWindow, state: State<AppState>, rects: Vec<Rect>) {
    state.hits.lock().unwrap().insert(window.label().to_string(), rects);
}

/// True while the user drags/resizes, so the window keeps the mouse even outside widgets.
#[tauri::command]
fn set_interacting(state: State<AppState>, on: bool) {
    state.interacting.store(on, Ordering::Relaxed);
}

#[tauri::command]
fn set_edit_mode(app: AppHandle, on: bool) {
    apply_edit_mode(&app, on);
}

#[tauri::command]
fn open_theme_file(state: State<AppState>) {
    open_path(&state.dir.join("theme.css"));
}

/// Merge `patch` into config.json (objects merge recursively; other values replace). Used by the Settings panel.
#[tauri::command]
fn save_config(app: AppHandle, state: State<AppState>, patch: Value) -> Result<(), String> {
    fn merge(base: &mut Value, patch: Value) {
        match (base, patch) {
            (Value::Object(b), Value::Object(p)) => {
                for (k, v) in p {
                    // A null in a patch deletes the key (lets the UI remove e.g. a custom holiday).
                    if v.is_null() {
                        b.remove(&k);
                    } else {
                        merge(b.entry(k).or_insert(Value::Null), v);
                    }
                }
            }
            (b, p) => *b = p,
        }
    }
    if config_broken(&state.dir) {
        return Err("config_broken".into()); // the UI tells the user; their file stays untouched
    }
    let mut cfg = read_config(&state.dir);
    if !cfg.is_object() {
        cfg = json!({});
    }
    merge(&mut cfg, patch);
    let s = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    write_atomic(&state.dir.join("config.json"), s.as_bytes())?;
    let _ = app.emit("config-changed", cfg);
    Ok(())
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// The Run / StartupApproved value name: "WidgetBoard" for the production build, its own name for any other
/// build (devtest), so toggling autostart there never repoints the real entry. Set once at startup.
static RUN_NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
fn run_name() -> &'static str {
    RUN_NAME.get().map(String::as_str).unwrap_or("WidgetBoard")
}

/// Task Manager's Startup tab keeps its own on/off here: a REG_BINARY whose first byte is 02 when enabled and
/// 03 (plus a timestamp) when the user disabled it. Odd = disabled (checked against this machine's entries).
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

/// The Run entry's target, quotes removed (None = no entry).
fn autostart_target() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        return RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|k| k.get_value::<String, _>(run_name()))
            .ok()
            .map(|v| v.trim().trim_matches('"').to_string());
    }
    #[allow(unreachable_code)]
    None
}

/// Disabled in Task Manager (the Run entry stays, but Windows will not start it).
fn disabled_by_windows() -> bool {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        return RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(APPROVED_KEY)
            .and_then(|k| k.get_raw_value(run_name()))
            .is_ok_and(|v| v.bytes.first().is_some_and(|b| b & 1 == 1));
    }
    #[allow(unreachable_code)]
    false
}

/// Start with Windows: a Run entry pointing at this exe that Task Manager has not disabled.
fn autostart_get() -> bool {
    autostart_target().is_some() && !disabled_by_windows()
}

/// At startup: a Run entry whose exe is gone (the app was moved) is pointed at this exe. Only an entry that
/// already exists is touched, and only by the production build, so a devtest run never takes it over.
fn repair_autostart(identifier: &str) {
    if identifier != PRODUCTION_IDENTIFIER {
        return;
    }
    if let Some(target) = autostart_target() {
        if !Path::new(&target).exists() {
            let _ = set_autostart(true);
        }
    }
}

#[tauri::command]
fn set_autostart(on: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            key.set_value(run_name(), &format!("\"{}\"", exe.display())).map_err(|e| e.to_string())?;
            // turning it on here also clears a "Disabled" set in Task Manager
            if let Ok(approved) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(APPROVED_KEY, winreg::enums::KEY_SET_VALUE) {
                let _ = approved.delete_value(run_name());
            }
        } else {
            let _ = key.delete_value(run_name());
        }
    }
    let _ = on;
    Ok(autostart_get())
}

// ---------- assets + memo archive ----------

/// Delete asset files that only `gone` referenced. A name still mentioned in layout.json, config.json,
/// theme.css or any data/*.json (content, saved layouts, undo) is kept.
// ponytail: substring scan over a few small JSON files; index asset refs if this ever gets slow
fn purge_assets(dir: &Path, gone: &[Value]) {
    if gone.is_empty() {
        return;
    }
    let refs = serde_json::to_string(gone).unwrap_or_default();
    let mut keep: String = ["layout.json", "config.json", "theme.css"]
        .iter()
        .map(|f| fs::read_to_string(dir.join(f)).unwrap_or_default())
        .collect();
    for e in fs::read_dir(dir.join("data")).into_iter().flatten().flatten() {
        if e.path().extension().is_some_and(|x| x == "json") {
            keep.push_str(&fs::read_to_string(e.path()).unwrap_or_default());
        }
    }
    for e in fs::read_dir(dir.join("assets")).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if refs.contains(&name) && !keep.contains(&name) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Opt-in (config.archive.memos): append-only memo history in archive/memos.jsonl. Survives deletion,
/// erase and restore (restore never touches archive/); backups include it.
static MEMO_LAST: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[tauri::command]
/// `force`: kept even with automatic history off (a stale draft the newer version replaced).
fn memo_archive(state: State<AppState>, id: String, name: String, text: String, force: Option<bool>) -> Result<(), String> {
    writable()?;
    let on = force == Some(true)
        || read_config(&state.dir).pointer("/archive/memos").and_then(Value::as_bool).unwrap_or(false);
    if !on || text.trim().is_empty() {
        return Ok(());
    }
    let mut g = MEMO_LAST.lock().unwrap();
    let last = g.get_or_insert_with(HashMap::new);
    if last.get(&id) == Some(&text) {
        return Ok(()); // unchanged since the last version
    }
    let dir = state.dir.join("archive");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let line = json!({ "t": now_secs(), "id": id, "name": name, "text": text }).to_string() + "\n";
    use std::io::Write;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("memos.jsonl"))
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .map_err(|e| e.to_string())?;
    last.insert(id, text);
    Ok(())
}

#[tauri::command]
fn memo_archive_list(state: State<AppState>) -> Vec<Value> {
    fs::read_to_string(state.dir.join("archive").join("memos.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok()) // a torn last line is skipped, never fatal
        .collect()
}

// ---------- settings window ----------

/// Everything the standalone settings window needs in one call.
#[tauri::command]
fn get_settings(state: State<AppState>) -> Value {
    let s = state.settings.lock().unwrap().clone();
    let widgets: Vec<Value> = state
        .widgets
        .lock()
        .unwrap()
        .iter()
        .map(|w| json!({
            "id": w.get("id").and_then(Value::as_str),
            "type": w.get("type").and_then(Value::as_str),
            "display": w.get("display").and_then(Value::as_str),
        }))
        .collect();
    let theme = fs::read_to_string(state.dir.join("theme.css")).unwrap_or_else(|_| DEFAULT_THEME.into());
    json!({
        "app": { "lang": s.lang, "reduceMotion": s.reduce_motion },
        "theme": theme,
        "config": read_config(&state.dir),
        "autostart": { "on": autostart_get(), "disabledByWindows": autostart_target().is_some() && disabled_by_windows() },
        "version": updater::CURRENT,
        "displays": state.boards.lock().unwrap().clone(),
        "widgets": widgets,
        "widgetTypes": widget_ids(),
        "dataDir": state.dir.to_string_lossy(),
        "assetsDir": state.dir.join("assets"),
    })
}

/// Apply app-level settings from the settings window: any of lang / reduceMotion.
/// Mirrors the tray handlers in `on_menu` so both entry points behave identically.
#[tauri::command]
fn set_app(app: AppHandle, state: State<AppState>, patch: Value) -> Result<(), String> {
    let (mut lang_changed, mut motion): (bool, Option<bool>) = (false, None);
    {
        let mut s = state.settings.lock().unwrap();
        if let Some(v) = patch.get("lang").and_then(Value::as_str) {
            if locales().contains_key(v) && v != s.lang {
                s.lang = v.to_string();
                lang_changed = true;
            }
        }
        if let Some(v) = patch.get("reduceMotion").and_then(Value::as_bool) {
            if v != s.reduce_motion {
                s.reduce_motion = v;
                motion = Some(v);
            }
        }
    }
    state.persist_settings();
    if lang_changed {
        refresh_tray(&app);
        let lang = state.settings.lock().unwrap().lang.clone();
        retitle_windows(&app, &lang);
        let _ = app.emit("lang-changed", lang);
    }
    if let Some(on) = motion {
        refresh_tray(&app);
        let _ = app.emit("motion-changed", on);
    }
    Ok(())
}

/// Native window titles are set at creation; a language switch renames the open Settings and Library windows.
fn retitle_windows(app: &AppHandle, lang: &str) {
    for (label, key) in [("settings", "set.title"), ("library", "lib.title")] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_title(&tr(lang, key));
        }
    }
}

/// Open (or focus) the standalone settings window on the given page.
fn open_settings_window(app: &AppHandle, page: &str) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        w.set_focus()?;
        let _ = app.emit_to("settings", "settings-page", page);
        return Ok(());
    }
    let lang = app.state::<AppState>().settings.lock().unwrap().lang.clone();
    let w = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(format!("settings.html?page={page}").into()))
        .scroll_bar_style(ScrollBarStyle::FluentOverlay) // all windows alike (Tauri: one style per data dir)
        .title(tr(&lang, "set.title"))
        .inner_size(760.0, 560.0)
        .min_inner_size(560.0, 420.0)
        .resizable(true)
        .skip_taskbar(false)
        .center() // ponytail: primary/current monitor; per-cursor centring if it matters
        .build()?;
    let _ = w.set_focus();
    Ok(())
}

/// Margin (logical px) between the demo window and the edges of the monitor's work area.
const DEMO_MARGIN: f64 = 24.0;

fn demo_query(focus: Option<&str>) -> String {
    let mut query = String::from("demo");
    if let Some(f) = focus.filter(|f| widget_ids().contains(f)) {
        query.push_str("&focus=");
        query.push_str(f);
    }
    query
}

/// The tutorial demo: a normal opaque window running index.html?demo on the in-memory mock backend.
/// It gets the user's theme and config as a snapshot (window.__demoInit) and never reads their files itself.
/// `origin` is the label of the window that asked ("settings", a board); it is told when the demo closes.
fn open_demo_window(app: &AppHandle, origin: &str, focus: Option<&str>) -> tauri::Result<()> {
    *app.state::<AppState>().demo_origin.lock().unwrap() = origin.to_string();
    if let Some(w) = app.get_webview_window("demo") {
        let mut url = w.url()?;
        url.set_query(Some(&demo_query(focus)));
        w.navigate(url)?;
        let _ = w.unminimize();
        let _ = w.show();
        return w.set_focus();
    }
    let state = app.state::<AppState>();
    let lang = state.settings.lock().unwrap().lang.clone();
    let theme = fs::read_to_string(state.dir.join("theme.css")).unwrap_or_else(|_| DEFAULT_THEME.into());
    let mut config = read_config(&state.dir);
    if !config.is_object() {
        config = json!({});
    }
    if !config.get("ui").is_some_and(Value::is_object) {
        config["ui"] = json!({});
    }
    config["ui"]["layoutMode"] = json!("grid"); // push-aside only exists in grid mode
    config["ui"]["flashAlert"] = json!(true); // reminders and timers show the board's in-window alert, whatever the user set
    let init = format!("window.__demoInit = {};", json!({ "theme": theme, "config": config }));
    let url = format!("index.html?{}", demo_query(focus));
    let w = WebviewWindowBuilder::new(app, "demo", WebviewUrl::App(url.into()))
        .scroll_bar_style(ScrollBarStyle::FluentOverlay) // all windows alike (Tauri: one style per data dir)
        .title(tr(&lang, "demo.title"))
        .initialization_script(init)
        .background_color(tauri::window::Color(24, 25, 28, 255)) // opaque: the desktop never shows through
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .resizable(true)
        .visible(false) // fitted below, then shown
        .build()?;
    // fill the work area of the origin window's monitor (primary if unknown), minus a margin
    let monitor = app
        .get_webview_window(origin)
        .and_then(|o| o.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let wa = m.work_area();
        let margin = (DEMO_MARGIN * m.scale_factor()).round() as i32;
        let _ = w.set_position(tauri::PhysicalPosition::new(wa.position.x + margin, wa.position.y + margin));
        // set_size is the inner size: take the frame (title bar, borders) off the target
        if let (Ok(outer), Ok(inner)) = (w.outer_size(), w.inner_size()) {
            let frame_w = outer.width.saturating_sub(inner.width);
            let frame_h = outer.height.saturating_sub(inner.height);
            let want_w = wa.size.width.saturating_sub(2 * margin as u32).saturating_sub(frame_w);
            let want_h = wa.size.height.saturating_sub(2 * margin as u32).saturating_sub(frame_h);
            let _ = w.set_size(tauri::PhysicalSize::new(want_w.max(480), want_h.max(360)));
        }
    }
    let handle = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            let origin = handle.state::<AppState>().demo_origin.lock().unwrap().clone();
            let _ = handle.emit("demo-closed", json!({ "origin": origin }));
            if origin == "settings" {
                if let Some(s) = handle.get_webview_window("settings") {
                    let _ = s.unminimize();
                    let _ = s.show();
                    let _ = s.set_focus();
                }
            }
        }
    });
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/// async: building a window inside a sync command deadlocks the IPC on Windows (tauri docs).
#[tauri::command]
async fn open_demo(app: AppHandle, origin: String, focus: Option<String>) -> Result<(), String> {
    open_demo_window(&app, &origin, focus.as_deref()).map_err(|e| e.to_string())
}

/// The Library: every content item, on the board or not, plus Recently deleted.
/// `page`: "items" (default), "search" (cursor in the search box), "browse" or "layouts" (those tabs).
fn open_library_window(app: &AppHandle, page: &str) -> tauri::Result<()> {
    let page = if ["search", "layouts", "browse"].contains(&page) { page } else { "items" };
    if let Some(w) = app.get_webview_window("library") {
        let _ = w.unminimize();
        let _ = app.emit_to("library", "library-page", page);
        return w.set_focus();
    }
    let lang = app.state::<AppState>().settings.lock().unwrap().lang.clone();
    let w = WebviewWindowBuilder::new(app, "library", WebviewUrl::App(format!("library.html?page={page}").into()))
        .scroll_bar_style(ScrollBarStyle::FluentOverlay) // all windows alike (Tauri: one style per data dir)
        .title(tr(&lang, "lib.title"))
        .inner_size(960.0, 620.0)
        .min_inner_size(420.0, 360.0)
        .resizable(true)
        .center()
        .build()?;
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
async fn open_library(app: AppHandle, page: Option<String>) -> Result<(), String> {
    open_library_window(&app, page.as_deref().unwrap_or("items")).map_err(|e| e.to_string())
}

/// async: building a window inside a sync command deadlocks the IPC on Windows (tauri docs).
#[tauri::command]
async fn open_settings(app: AppHandle, page: Option<String>) -> Result<(), String> {
    open_settings_window(&app, page.as_deref().unwrap_or("general")).map_err(|e| e.to_string())
}

// ---------- accessibility commands ----------

#[tauri::command]
fn set_dwell(state: State<AppState>, ms: usize) {
    state.dwell_ms.store(ms.min(5000), Ordering::Relaxed);
}

/// Whole-UI zoom for every board (low vision). Hit testing is scaled to match.
#[tauri::command]
fn set_zoom(app: AppHandle, state: State<AppState>, zoom: f64) {
    let z = if zoom.is_finite() { zoom.clamp(0.75, 3.0) } else { 1.0 };
    *state.zoom.lock().unwrap() = z;
    for w in boards(&app).into_iter().chain(pins(&app)) {
        let _ = w.set_zoom(z);
    }
}

/// Keyboard mode: the widgets come to the front and take keyboard focus (entered with the global shortcut).
fn apply_kbd_mode(app: &AppHandle, on: bool) {
    let st = app.state::<AppState>();
    st.kbd.store(on, Ordering::Relaxed);
    apply_layer(app);
    if on {
        if let Some(w) = st.primary_label().and_then(|l| app.get_webview_window(&l)) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
    let _ = app.emit("kbd-mode", on);
}

#[tauri::command]
fn set_kbd_mode(app: AppHandle, on: bool) {
    apply_kbd_mode(&app, on);
}

/// Register (or clear, with an empty string) the global shortcut that enters keyboard mode.
#[tauri::command]
fn set_hotkey(app: AppHandle, accel: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if accel.trim().is_empty() {
        return Ok(());
    }
    gs.on_shortcut(accel.as_str(), |app, _sc, ev| {
        if ev.state == ShortcutState::Pressed {
            let on = !app.state::<AppState>().kbd.load(Ordering::Relaxed);
            apply_kbd_mode(app, on);
        }
    })
    .map_err(|e| e.to_string())
}

/// Windows notification (deaf/hard-of-hearing alerts, reminders). A portable app needs its app id registered
/// once under HKCU so Windows shows its toasts; that happens here, on first use only.
#[tauri::command]
fn notify(app: AppHandle, state: State<AppState>, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let id = app.config().identifier.clone();
        if let Ok((k, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!(r"Software\Classes\AppUserModelId\{id}")) {
            let icon = state.dir.join("notify-icon.png");
            if !icon.exists() {
                let _ = fs::write(&icon, include_bytes!("../icons/icon.png"));
            }
            let _ = k.set_value("DisplayName", &"WidgetBoard");
            let _ = k.set_value("IconUri", &icon.to_string_lossy().to_string());
        }
    }
    let _ = &state;
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

// ---------- layouts ----------

/// All widgets on all monitors (for saving a layout preset).
#[tauri::command]
fn get_all_widgets(state: State<AppState>) -> Vec<Value> {
    state.widgets.lock().unwrap().clone()
}

/// Forward an event to the primary board (the settings window drives board-only actions this way,
/// e.g. add-widget / apply-preset, which need board geometry).
#[tauri::command]
fn emit_primary(app: AppHandle, state: State<AppState>, event: String, payload: Value) -> Result<(), String> {
    if let Some(label) = state.primary_label() {
        app.emit_to(&label, &event, payload).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replace every widget at once (loading a layout preset); all boards reload.
#[tauri::command]
fn replace_widgets(app: AppHandle, state: State<AppState>, widgets: Vec<Value>) -> Result<(), String> {
    *state.widgets.lock().unwrap() = widgets.into_iter().filter(|w| widget_id(w).is_some()).collect();
    state.persist_widgets()?;
    for w in pins(&app) {
        let _ = w.destroy(); // the caller flushed every window first; the widgets follow the new layout
    }
    let _ = app.emit("layout-replaced", ());
    Ok(())
}

/// Now Playing: start watching system media (first call) and return the current state.
#[tauri::command]
fn media_subscribe(app: AppHandle, state: State<AppState>) -> Value {
    let h = app.clone();
    state.media.ensure_started(move |v| {
        let _ = h.emit("media", v);
    });
    state.media.last.lock().unwrap().clone()
}

#[tauri::command]
fn media_control(state: State<AppState>, action: String, seconds: Option<f64>) {
    let cmd = match action.as_str() {
        "playpause" => media::Cmd::PlayPause,
        "next" => media::Cmd::Next,
        "prev" => media::Cmd::Prev,
        "seek" => media::Cmd::Seek(seconds.unwrap_or(0.0)),
        "cycle" => media::Cmd::Cycle,
        _ => return,
    };
    state.media.send(cmd);
}

#[tauri::command]
fn open_config_file(state: State<AppState>) {
    open_path(&state.dir.join("config.json"));
}

#[tauri::command]
fn open_data_folder(state: State<AppState>) {
    open_path(&state.dir);
}

// ---------- behaviour ----------

/// Boards are ordinary windows (normal z-order); editing / keyboard mode lifts them to the top so nothing hides them.
fn apply_layer(app: &AppHandle) {
    let st = app.state::<AppState>();
    let top = st.edit.load(Ordering::Relaxed) || st.kbd.load(Ordering::Relaxed);
    for w in boards(app) {
        layer::set_topmost(&w, top);
    }
}

fn apply_edit_mode(app: &AppHandle, on: bool) {
    let st = app.state::<AppState>();
    st.edit.store(on, Ordering::Relaxed);
    if let Some(items) = st.tray_items.lock().unwrap().as_ref() {
        let _ = items.edit.set_checked(on);
    }
    for w in boards(app) {
        let _ = w.show();
    }
    apply_layer(app);
    let _ = app.emit("edit-mode", on);
}

fn toggle_boards(app: &AppHandle) {
    let ws = boards(app);
    if !ws.iter().any(|w| w.is_visible().unwrap_or(false)) {
        return raise_boards(app);
    }
    for w in ws {
        let _ = w.hide();
    }
}

/// Show every board in front of other apps once (an explicit request: tray, second launch, Widget menu).
fn raise_boards(app: &AppHandle) {
    for w in boards(app) {
        let _ = w.show();
        layer::raise(&w);
    }
}

#[tauri::command]
fn raise_board(window: WebviewWindow) {
    layer::raise(&window);
}

/// Pinned widgets: each runs alone in an always-on-top window `pin-<id>` (index.html?pin=<id>). Which widgets are
/// pinned is just which of these windows exist, so a restart puts every widget back on its board.
fn pins(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("pin-")).map(|(_, w)| w).collect()
}

/// A widget's rect on a board (CSS px) -> physical screen x, y, w, h, from the board's client origin.
fn pin_rect(origin: (i32, i32), r: Rect, zoom: f64, scale: f64) -> (i32, i32, u32, u32) {
    let k = zoom * scale;
    let px = |v: f64| (v * k).round();
    (origin.0 + px(r.x) as i32, origin.1 + px(r.y) as i32, px(r.w) as u32, px(r.h) as u32)
}

/// Pin a widget from `window` (its board): it opens over its own spot, in front of every app, until released.
/// async: building a window inside a sync command deadlocks the IPC on Windows (tauri docs).
#[tauri::command]
async fn pin_widget(app: AppHandle, window: WebviewWindow, id: String, rect: Rect) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad id".into()); // becomes a window label and a URL query
    }
    let label = format!("pin-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let z = *app.state::<AppState>().zoom.lock().unwrap();
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (x, y, w, h) = pin_rect((origin.x, origin.y), rect, z, scale);
    let pin = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?pin={id}").into()))
        .scroll_bar_style(ScrollBarStyle::FluentOverlay) // all windows alike (Tauri: one style per data dir)
        .title("WidgetBoard")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true) // no layer::keep_back: this window is meant to stay in front
        .skip_taskbar(true)
        .resizable(true)
        .min_inner_size(96.0, 64.0)
        .visible(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    let _ = pin.set_position(tauri::PhysicalPosition::new(x, y)); // position first: a DPI change may resize the window
    let _ = pin.set_size(tauri::PhysicalSize::new(w.max(1), h.max(1)));
    let _ = pin.set_zoom(z);
    let handle = app.clone();
    pin.on_window_event(move |e| match e {
        // Alt+F4 and the like: the page saves first, then calls unpin_widget
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = handle.emit_to(&label, "pin-release", ());
        }
        tauri::WindowEvent::Destroyed => {
            let st = handle.state::<AppState>();
            let widget = st.widgets.lock().unwrap().iter().find(|w| widget_id(w) == Some(&id)).cloned();
            let _ = handle.emit("widget-unpinned", json!({ "id": id, "widget": widget }));
        }
        _ => {}
    });
    let _ = pin.show();
    let _ = pin.set_focus();
    Ok(())
}

/// A pin window lets go once its saves are flushed; its board shows the widget again (`widget-unpinned`).
#[tauri::command]
fn unpin_widget(window: WebviewWindow) {
    if window.label().starts_with("pin-") {
        let _ = window.destroy();
    }
}

/// Poll the cursor ~30x/s; each board ignores the mouse unless it is over one of its widgets.
fn spawn_hit_test(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: HashMap<String, bool> = HashMap::new();
        let mut entered: HashMap<String, Instant> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_millis(33));
            let st = app.state::<AppState>();
            let hold = st.edit.load(Ordering::Relaxed)
                || st.interacting.load(Ordering::Relaxed)
                || st.kbd.load(Ordering::Relaxed);
            let dwell = Duration::from_millis(st.dwell_ms.load(Ordering::Relaxed) as u64);
            let zoom = *st.zoom.lock().unwrap();
            let Ok(cursor) = app.cursor_position() else { continue };
            for w in boards(&app) {
                if !w.is_visible().unwrap_or(false) {
                    continue;
                }
                let over = hold || {
                    let rects = st.hits.lock().unwrap().get(w.label()).cloned().unwrap_or_default();
                    match (w.inner_position(), w.scale_factor()) {
                        (Ok(p), Ok(s)) => {
                            let x = (cursor.x - p.x as f64) / (s * zoom);
                            let y = (cursor.y - p.y as f64) / (s * zoom);
                            rects.iter().any(|r| x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
                        }
                        _ => true,
                    }
                };
                // dwell (motor accessibility): the pointer must rest on a widget before it takes clicks
                let over = if hold || dwell.is_zero() {
                    over
                } else if over {
                    let since = *entered.entry(w.label().to_string()).or_insert_with(Instant::now);
                    since.elapsed() >= dwell
                } else {
                    entered.remove(w.label());
                    false
                };
                let ignore = !over;
                if last.get(w.label()) != Some(&ignore) {
                    let _ = w.set_ignore_cursor_events(ignore);
                    last.insert(w.label().to_string(), ignore);
                }
            }
        }
    });
}

/// Hot-reload theme.css and config.json when they change on disk (Notepad, an AI, ...).
fn spawn_file_watch(app: AppHandle, dir: PathBuf) {
    std::thread::spawn(move || {
        let mtime = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
        let (theme, config) = (dir.join("theme.css"), dir.join("config.json"));
        let (mut lt, mut lc) = (mtime(&theme), mtime(&config));
        loop {
            std::thread::sleep(Duration::from_millis(800));
            let (t, c) = (mtime(&theme), mtime(&config));
            if t != lt {
                lt = t;
                if let Ok(css) = fs::read_to_string(&theme) {
                    let _ = app.emit("theme-changed", css);
                }
            }
            if c != lc {
                lc = c;
                if let Some(v) = read_json::<Value>(&config) {
                    let _ = app.emit("config-changed", v);
                }
            }
        }
    });
}

type MonitorSig = Vec<(String, i32, i32, u32, u32)>;

fn monitor_sig(app: &AppHandle) -> Option<MonitorSig> {
    let mut v: MonitorSig = app
        .available_monitors()
        .ok()?
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let wa = m.work_area();
            let name = m.name().cloned().unwrap_or_else(|| format!("display-{i}"));
            (name, wa.position.x, wa.position.y, wa.size.width, wa.size.height)
        })
        .collect();
    v.sort();
    Some(v)
}

/// Watch for monitors being added/removed or resized (resolution, taskbar) and adapt the boards.
/// A change must be seen twice in a row (~4 s) before acting, to ride out display sleep flicker.
fn spawn_monitor_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut current = monitor_sig(&app);
        let mut candidate: Option<MonitorSig> = None;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let Some(now) = monitor_sig(&app) else { continue };
            if Some(&now) == current.as_ref() || now.is_empty() {
                candidate = None;
                continue;
            }
            if candidate.as_ref() != Some(&now) {
                candidate = Some(now);
                continue;
            }
            let names = |s: &MonitorSig| s.iter().map(|m| m.0.clone()).collect::<Vec<_>>();
            let same_set = current.as_ref().map(names) == Some(names(&now));
            if same_set {
                // same monitors, new geometry: move/resize the existing boards
                let st = app.state::<AppState>();
                let boards_info = st.boards.lock().unwrap().clone();
                if let Ok(mons) = app.available_monitors() {
                    for b in boards_info {
                        let m = mons.iter().enumerate().find(|(i, m)| {
                            m.name().cloned().unwrap_or_else(|| format!("display-{i}")) == b.display
                        });
                        if let (Some((_, m)), Some(w)) = (m, app.get_webview_window(&b.label)) {
                            let wa = m.work_area();
                            let _ = w.set_position(wa.position);
                            let _ = w.set_size(wa.size);
                        }
                    }
                }
            } else {
                rebuild_boards(&app);
            }
            current = candidate.take();
        }
    });
}

/// Close every board and create fresh ones for the current monitors (widgets live in Rust state).
fn rebuild_boards(app: &AppHandle) {
    let st = app.state::<AppState>();
    let old = st.labels();
    st.hits.lock().unwrap().clear();
    for l in old {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
    let _ = create_boards(app);
    apply_layer(app);
    let z = *app.state::<AppState>().zoom.lock().unwrap();
    for w in boards(app) {
        let _ = w.set_zoom(z);
    }
}

/// One transparent, borderless board per monitor, covering its work area (minus taskbar).
fn create_boards(app: &AppHandle) -> tauri::Result<()> {
    let monitors = app.available_monitors()?;
    let gen = app.state::<AppState>().generation.fetch_add(1, Ordering::Relaxed);
    let primary_name = app.primary_monitor()?.and_then(|m| m.name().cloned());
    let mut list: Vec<Board> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let display = m.name().cloned().unwrap_or_else(|| format!("display-{i}"));
            Board {
                label: format!("board-{gen}-{i}"),
                primary: primary_name.as_ref() == Some(&display),
                display,
                index: i + 1,
            }
        })
        .collect();
    if !list.iter().any(|b| b.primary) {
        if let Some(b) = list.first_mut() {
            b.primary = true;
        }
    }
    let st = app.state::<AppState>();
    *st.boards.lock().unwrap() = list.clone(); // before windows load and ask for it

    for (b, m) in list.iter().zip(monitors.iter()) {
        let wa = m.work_area();
        let sf = m.scale_factor();
        let tutorial_debug = cfg!(debug_assertions)
            && app.config().identifier == "app.widgetboard.devtest"
            && std::env::args().any(|arg| arg == "--tutorial-debug");
        let init = if tutorial_debug { "window.__tutorialDebug = true;" } else { "" };
        let w = WebviewWindowBuilder::new(app, &b.label, WebviewUrl::App("index.html".into()))
        .initialization_script(init)
        .scroll_bar_style(ScrollBarStyle::FluentOverlay) // all windows alike (Tauri: one style per data dir)
            .title("WidgetBoard")
            // start at the right size so the page never lays out on a wrong-sized board
            .position(wa.position.x as f64 / sf, wa.position.y as f64 / sf)
            .inner_size(wa.size.width as f64 / sf, wa.size.height as f64 / sf)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .disable_drag_drop_handler()
            .build()?;
        w.set_position(wa.position)?; // position first: a DPI change may resize the window
        w.set_size(wa.size)?;
        let _ = w.set_ignore_cursor_events(true);
        layer::keep_back(&w);
        w.show()?;
    }
    Ok(())
}

// ---------- self-update ----------
fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
/// config.json → "update": { "check": "weekly" | "daily" | "off" }. The URL is build-time only
/// (updater::DEFAULT_URL), so an edited or restored config.json can't redirect update checks.
fn update_config(dir: &Path) -> (String, String) {
    let c = read_config(dir);
    let check = c["update"]["check"].as_str().unwrap_or("weekly").to_string();
    let url = updater::DEFAULT_URL.unwrap_or("").to_string();
    (check, url)
}
fn update_info(st: &AppState) -> Value {
    let dir = st.dir.join("updates");
    let (check, url) = update_config(&st.dir);
    let s = updater::state(&dir);
    json!({
        "current": updater::CURRENT,
        "check": check,
        "configured": !url.is_empty(),
        "lastCheck": s["last_check"],
        "lastError": s["last_error"],
        "available": updater::available(&dir),
        "busy": st.update_busy.load(Ordering::Relaxed),
    })
}
fn refresh_tray(app: &AppHandle) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (h.tray_by_id(TRAY_ID), build_menu(&h)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}
/// Look at the manifest only; announce a newer version. `manual` = the user asked, so a skipped version is
/// shown again and "up to date" and errors are reported too.
fn run_update_check(app: &AppHandle, manual: bool) {
    let st = app.state::<AppState>();
    if st.update_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("update-status", update_info(&st));
    let dir = st.dir.join("updates");
    let (_, url) = update_config(&st.dir);
    let res = if url.is_empty() { Err("not_configured".to_string()) } else { updater::check(&url) };
    if !url.is_empty() {
        updater::record(&dir, now_secs(), &res);
    }
    if manual && matches!(res, Ok(Some(_))) {
        updater::skip(&dir, None);
    }
    st.update_busy.store(false, Ordering::SeqCst);
    let info = update_info(&st);
    let _ = app.emit("update-status", info.clone());
    refresh_tray(app);
    match (&res, st.primary_label()) {
        (Ok(Some(_)), Some(label)) if !info["available"].is_null() => {
            let _ = app.emit_to(&label, "update-available", info["available"].clone());
        }
        (Ok(None), Some(label)) if manual => {
            let _ = app.emit_to(&label, "toast", "upd.latest");
        }
        (Err(e), Some(label)) if manual => {
            let _ = app.emit_to(&label, "update-failed", e.clone());
        }
        _ => {}
    }
}
/// Slow schedule: first look 3 minutes after start, then re-evaluate every hour against "daily"/"weekly".
// ---------- backup & restore (timestamped folder copies; no zip dependency) ----------
const BACKUP_FILES: [&str; 4] = ["layout.json", "config.json", "settings.json", "theme.css"];
const BACKUP_DIRS: [&str; 3] = ["data", "diary", "assets"];

/// Filesystem-sortable local timestamp "YYYYMMDD-HHMM".
#[cfg(windows)]
fn local_stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    format!("{:04}{:02}{:02}-{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute)
}
#[cfg(not(windows))]
fn local_stamp() -> String {
    now_secs().to_string()
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() {
            copy_dir(&p, &dst.join(entry.file_name()))?;
        } else if p.extension().map_or(true, |e| e != "tmp") {
            copy_verified(&p, &dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn copy_verified(src: &Path, dst: &Path) -> Result<(), String> {
    use std::io::Read;
    use sha2::{Digest, Sha256};
    fn hash(path: &Path) -> Result<Vec<u8>, String> {
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            digest.update(&buf[..n]);
        }
        Ok(digest.finalize().to_vec())
    }
    fs::copy(src, dst).map_err(|e| e.to_string())?;
    if hash(src)? != hash(dst)? { return Err(format!("backup verification failed: {}", src.display())); }
    Ok(())
}

/// Where backups live: config backup.dir if set, else Documents\WidgetBoard\Backups, else <appdata>\Backups.
fn backups_root(app: &AppHandle, dir: &Path) -> PathBuf {
    let cfg = read_config(dir);
    let custom = cfg.get("backup").and_then(|b| b.get("dir")).and_then(|v| v.as_str()).unwrap_or("");
    if !custom.is_empty() {
        return PathBuf::from(custom);
    }
    // other builds (devtest) keep their own folder: production must never count, prune or restore their snapshots
    let id = &app.config().identifier;
    let folder = if id == PRODUCTION_IDENTIFIER { "Backups".to_string() } else { format!("Backups-{id}") };
    app.path()
        .document_dir()
        .map(|d| d.join("WidgetBoard").join(&folder))
        .unwrap_or_else(|_| dir.join(&folder))
}
const PRODUCTION_IDENTIFIER: &str = "app.widgetboard.desktop"; // tauri.conf.json

/// Copy the live data into a new timestamped folder under `root`. `tag` ("", "auto", "pre-restore")
/// is appended to the folder name. Returns the folder path.
fn backup_to(src_dir: &Path, root: &Path, tag: &str) -> Result<PathBuf, String> {
    // Serialize writers so names and staging folders cannot collide.
    static BACKUP_LOCK: Mutex<()> = Mutex::new(());
    let _guard = BACKUP_LOCK.lock().map_err(|e| e.to_string())?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    for name in BACKUP_DIRS.into_iter().chain(["archive"]) {
        if let Ok(source) = src_dir.join(name).canonicalize() {
            if canonical_root.starts_with(source) { return Err("backup folder is inside content being backed up".into()); }
        }
    }
    let stamp = local_stamp();
    let name = if tag.is_empty() {
        format!("WidgetBoard-backup-{stamp}")
    } else {
        format!("WidgetBoard-backup-{stamp}-{tag}")
    };
    // same-minute backups (e.g. undoing a restore at once) get a suffix instead of overwriting the source
    let mut dest = root.join(&name);
    let mut n = 2;
    while dest.exists() || dest.with_extension("partial").exists() {
        dest = root.join(format!("{name}-{n}"));
        n += 1;
    }
    let completed = dest;
    let dest = completed.with_extension("partial");
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut files = vec![];
    for f in BACKUP_FILES {
        let p = src_dir.join(f);
        if p.exists() {
            copy_verified(&p, &dest.join(f))?;
            files.push(f.to_string());
        }
    }
    for d in BACKUP_DIRS {
        let p = src_dir.join(d);
        if p.is_dir() {
            copy_dir(&p, &dest.join(d))?;
            files.push(format!("{d}/"));
        }
    }
    // archive/ is backed up but never restored over: it is append-only history
    if src_dir.join("archive").is_dir() {
        copy_dir(&src_dir.join("archive"), &dest.join("archive"))?;
        files.push("archive/".to_string());
    }
    let tier = backup_policy::Tier::from_tag(tag).map_or("", |t| t.key());
    let manifest = json!({ "app": env!("CARGO_PKG_VERSION"), "created": stamp, "createdUnix": now_secs(), "tier": tier, "files": files });
    write_atomic(&dest.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap().as_bytes())?;
    fs::rename(&dest, &completed).map_err(|e| e.to_string())?;
    Ok(completed)
}

/// A restore point must be whole before it may replace anything: every file its manifest lists is there, and
/// layout.json and data/*.json parse. (config.json is left out: a hand-edited typo is restored as it was and the
/// app already handles it.) Err("damaged:<file>") names the first problem.
fn validate_backup(src: &Path) -> Result<(), String> {
    let m: Value = read_json(&src.join("manifest.json")).ok_or("damaged:manifest.json")?;
    let files = m["files"].as_array().ok_or("damaged:manifest.json")?;
    for f in files.iter().filter_map(Value::as_str) {
        if !src.join(f.trim_end_matches('/')).exists() {
            return Err(format!("damaged:{f}"));
        }
    }
    let data = fs::read_dir(src.join("data")).into_iter().flatten().flatten().map(|e| e.path());
    for path in std::iter::once(src.join("layout.json")).chain(data) {
        if path.extension().is_some_and(|x| x == "json") && path.exists() {
            let text = fs::read_to_string(&path).unwrap_or_default();
            if serde_json::from_str::<Value>(&text).is_err() {
                let name = path.strip_prefix(src).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                return Err(format!("damaged:{name}"));
            }
        }
    }
    Ok(())
}

/// Overwrite the live data from a backup folder (an exact snapshot: content dirs are replaced wholesale).
fn restore_from(src: &Path, dir: &Path) -> Result<(), String> {
    for f in BACKUP_FILES {
        let p = src.join(f);
        if p.exists() {
            fs::copy(&p, dir.join(f)).map_err(|e| e.to_string())?;
        }
    }
    for d in BACKUP_DIRS {
        let p = src.join(d);
        if p.is_dir() {
            let target = dir.join(d);
            let _ = fs::remove_dir_all(&target);
            copy_dir(&p, &target)?;
        }
    }
    Ok(())
}

/// Flush editor buffers on every monitor before layouts read the current contents.
#[tauri::command]
async fn flush_boards(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || flush::boards(&app)).await.map_err(|e| e.to_string())?
}

/// async + blocking thread: a sync command runs on the main thread, which would freeze every window during the
/// copy and hold back the boards' flush-saves writes until after it.
#[tauri::command]
async fn backup_now(app: AppHandle, state: State<'_, AppState>, dir: Option<String>) -> Result<String, String> {
    let root = dir
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| backups_root(&app, &state.dir));
    let src = state.dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        flush::boards(&app)?;
        backup_to(&src, &root, "").map(|d| d.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_backups(app: AppHandle, state: State<AppState>) -> Value {
    let root = backups_root(&app, &state.dir);
    let mut items: Vec<Value> = fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| !p.extension().is_some_and(|e| e == "partial") && p.join("manifest.json").exists())
        .map(|p| {
            let m: Value = read_json(&p.join("manifest.json")).unwrap_or(json!({}));
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            // what made it: a schedule tier, a restore / data upgrade safety net, or the user
            let kind = match m.get("tier").and_then(Value::as_str).unwrap_or("") {
                "" if name.contains("-pre-migration") => "pre-migration",
                "" if name.contains("-pre-restore") => "pre-restore",
                "" if name.contains("-auto") => "daily",
                "" => "manual",
                "fortnight" => "weekly",
                t => t,
            };
            json!({
                "name": name,
                "kind": kind,
                "path": p.to_string_lossy(),
                "created": m.get("created").and_then(|v| v.as_str()).unwrap_or(""),
                "app": m.get("app").and_then(|v| v.as_str()).unwrap_or(""),
            })
        })
        .collect();
    items.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str())); // newest first
    let backup = read_config(&state.dir).get("backup").cloned().unwrap_or(json!({}));
    json!({ "root": root.to_string_lossy(), "items": items, "backup": backup,
        "status": read_json::<Value>(&state.dir.join("backup-status.json")).unwrap_or(Value::Null) })
}

#[tauri::command]
fn open_backups_folder(app: AppHandle, state: State<AppState>) {
    let root = backups_root(&app, &state.dir);
    let _ = fs::create_dir_all(&root);
    open_path(&root);
}

#[tauri::command]
fn restore_backup(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    let src = PathBuf::from(&path);
    validate_backup(&src)?; // nothing is touched for a damaged restore point
    // Flush, snapshot, copy, relaunch — off-thread so the flush lands before the snapshot.
    let dir = state.dir.clone();
    let root = backups_root(&app, &state.dir);
    let app2 = app.clone();
    std::thread::spawn(move || {
        // windows block input first; the flush still saves what was typed before
        let _ = app2.emit("restoring", true);
        // Safety net: no snapshot of the current state, no overwrite.
        let res = flush::boards(&app2)
            .and_then(|_| backup_to(&dir, &root, "pre-restore"))
            .and_then(|_| {
                RESTORING.store(true, Ordering::SeqCst);
                restore_from(&src, &dir)
            })
            // after the copy: the folder being restored may itself be the oldest pre-restore snapshot
            .map(|_| { let _ = backup_policy::prune(&root, backup_policy::Tier::PreRestore, 0); });
        match res {
            Ok(()) => relaunch(&app2),
            Err(e) => {
                RESTORING.store(false, Ordering::SeqCst);
                let _ = app2.emit("restore-failed", e);
            }
        }
    });
    Ok(())
}

/// Check after startup and every minute. Each tier advances only after a verified snapshot.
fn spawn_auto_backup(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        loop {
            let st = app.state::<AppState>();
            let cfg = read_config(&st.dir);
            let b = cfg.get("backup");
            let mode = b.and_then(|b| b.get("auto")).and_then(Value::as_str).unwrap_or("daily");
            let keep = b.and_then(|b| b.get("keep")).and_then(Value::as_u64).unwrap_or(7).clamp(1, 99) as usize;
            let root = backups_root(&app, &st.dir);
            let due = backup_policy::due(&root, mode, now_secs(), &local_stamp());
            if !due.is_empty() && !config_broken(&st.dir) {
                let result = flush::boards(&app).and_then(|_| {
                    for tier in due {
                        backup_to(&st.dir, &root, tier.tag())?;
                        backup_policy::prune(&root, tier, keep)?;
                    }
                    Ok(())
                });
                let status = match result {
                    Ok(()) => json!({ "checked": local_stamp(), "error": null }),
                    Err(error) => json!({ "checked": local_stamp(), "error": error }),
                };
                let _ = write_atomic(&st.dir.join("backup-status.json"), status.to_string().as_bytes());
                let _ = app.emit("backup-status", status);
            }
            drop(st);
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

fn spawn_updater(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(180));
        loop {
            let due = {
                let st = app.state::<AppState>();
                let (check, url) = update_config(&st.dir);
                !url.is_empty() && updater::is_due(&check, updater::last_check(&st.dir.join("updates")), now_secs())
            };
            if due {
                run_update_check(&app, false);
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}
/// Start a fresh copy of this exe, then exit; the new process waits for us (single-instance).
fn relaunch(app: &AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        if std::process::Command::new(exe).args(["--wait-pid", &std::process::id().to_string()]).spawn().is_ok() {
            app.exit(0);
        }
    }
}
/// Relaunch this exe after we exit; the new process waits for us (single-instance) and installs the update.
fn restart_for_update(app: &AppHandle) {
    let h = app.clone();
    std::thread::spawn(move || {
        match flush::boards(&h) {
            Ok(()) => relaunch(&h),
            Err(e) => { let _ = h.emit("update-failed", e); }
        }
    });
}
/// `--wait-pid N`: we were started by an app that is about to quit — wait for it (max 15 s).
fn wait_for_parent() {
    let args: Vec<String> = std::env::args().collect();
    let Some(pid) = args.iter().position(|a| a == "--wait-pid").and_then(|i| args.get(i + 1)).and_then(|p| p.parse::<u32>().ok()) else {
        return;
    };
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(h, 15_000);
            let _ = CloseHandle(h);
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
}
/// Startup: install a verified pending update (then relaunch the new exe and quit); tidy up after the last one.
/// Returns the version just installed, once, for a "updated to vX" toast.
fn install_pending_update(dir: &Path) -> Option<String> {
    let updates = dir.join("updates");
    let exe = std::env::current_exe().ok()?;
    updater::cleanup_old(&exe);
    let done = fs::read_to_string(updates.join("installed.txt")).ok();
    let _ = fs::remove_file(updates.join("installed.txt"));
    match updater::apply_pending(&updates, &exe, updater::PUBLIC_KEY) {
        Ok(Some(v)) => {
            let _ = fs::write(updates.join("installed.txt"), &v);
            if std::process::Command::new(&exe).args(["--wait-pid", &std::process::id().to_string()]).spawn().is_ok() {
                std::process::exit(0);
            }
            None
        }
        Ok(None) => done.map(|v| v.trim().to_string()).filter(|v| v == updater::CURRENT),
        Err(e) => {
            updater::record(&updates, now_secs(), &Err(format!("install: {e}")));
            None
        }
    }
}

#[tauri::command]
fn update_status(state: State<AppState>) -> Value {
    update_info(&state)
}
#[tauri::command]
fn update_check(app: AppHandle) {
    std::thread::spawn(move || run_update_check(&app, true));
}
/// The user picked Install: back up, download + verify, then restart into the swap (install_pending_update).
/// Backup comes first so a verified download never sits waiting without one.
#[tauri::command]
fn update_install(app: AppHandle) {
    std::thread::spawn(move || {
        let st = app.state::<AppState>();
        if st.update_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let dir = st.dir.join("updates");
        // no backup, download or restart when the exe can't be replaced
        if !std::env::current_exe().map(|e| updater::can_replace(&e)).unwrap_or(false) {
            st.update_busy.store(false, Ordering::SeqCst);
            updater::record(&dir, now_secs(), &Err("not_writable".into()));
            let _ = app.emit("update-failed", "not_writable");
            let _ = app.emit("update-status", update_info(&st));
            return;
        }
        let _ = app.emit("update-status", update_info(&st));
        let (_, url) = update_config(&st.dir);
        let res = flush::boards(&app)
            .and_then(|_| backup_to(&st.dir, &backups_root(&app, &st.dir), "pre-update"))
            .and_then(|_| updater::check_and_download(&dir, &url, updater::PUBLIC_KEY));
        st.update_busy.store(false, Ordering::SeqCst);
        match res {
            Ok(Some(_)) => restart_for_update(&app),
            Ok(None) => updater::record(&dir, now_secs(), &Ok(None)), // withdrawn or already current
            Err(e) => {
                updater::record(&dir, now_secs(), &Err(format!("install: {e}")));
                let _ = app.emit("update-failed", e);
            }
        }
        let _ = app.emit("update-status", update_info(&st));
        refresh_tray(&app);
    });
}
/// "Skip this version".
#[tauri::command]
fn update_skip(app: AppHandle, state: State<AppState>, version: String) -> Value {
    updater::skip(&state.dir.join("updates"), Some(&version));
    refresh_tray(&app);
    let info = update_info(&state);
    let _ = app.emit("update-status", info.clone());
    info
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let st = app.state::<AppState>();
    let s = st.settings.lock().unwrap().clone();
    let t = |k: &str| tr(&s.lang, k);

    // a group of one widget is a plain item, bigger groups are submenus
    let add_groups = widget_groups()
        .iter()
        .map(|(group, ids)| {
            let items = ids
                .iter()
                .map(|id| MenuItem::with_id(app, format!("add:{id}"), t(&format!("widget.{id}")), true, None::<&str>))
                .collect::<Result<Vec<_>, _>>()?;
            if items.len() == 1 {
                return Ok(Box::new(items.into_iter().next().unwrap()) as Box<dyn IsMenuItem<Wry>>);
            }
            let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
            Ok(Box::new(Submenu::with_items(app, t(&format!("group.{group}")), true, &refs)?) as Box<dyn IsMenuItem<Wry>>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let add_refs: Vec<&dyn IsMenuItem<Wry>> = add_groups.iter().map(|i| i.as_ref()).collect();
    let add = Submenu::with_items(app, t("tray.add_widget"), true, &add_refs)?;

    let edit = CheckMenuItem::with_id(app, "edit", t("tray.edit_layout"), true, st.edit.load(Ordering::Relaxed), None::<&str>)?;

    // order and labels come from ui/tray-menu.json; add and edit are special items
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for (id, label) in tray_menu() {
        match id.as_str() {
            "-" => items.push(Box::new(PredefinedMenuItem::separator(app)?)),
            "add" => items.push(Box::new(add.clone())),
            "edit" => items.push(Box::new(edit.clone())),
            plain if TRAY_PLAIN.contains(&plain) => items.push(Box::new(MenuItem::with_id(app, plain, t(label), true, None::<&str>)?)),
            _ => {}
        }
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;
    let sep = || PredefinedMenuItem::separator(app);
    // a found (not skipped) update sits at the very bottom until it is installed or skipped
    if let Some(a) = updater::available(&st.dir.join("updates")) {
        let text = t("tray.update_available").replace("{v}", a["version"].as_str().unwrap_or(""));
        menu.append(&sep()?)?;
        menu.append(&MenuItem::with_id(app, "update-available", text, true, None::<&str>)?)?;
    }
    *st.tray_items.lock().unwrap() = Some(TrayItems { edit });
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    let st = app.state::<AppState>();
    if let Some(kind) = id.strip_prefix("add:") {
        if let Some(label) = st.primary_label() {
            raise_boards(app);
            let _ = app.emit_to(&label, "add-widget", kind);
        }
        return;
    }
    match id {
        "edit" => apply_edit_mode(app, !st.edit.load(Ordering::Relaxed)),
        "settings" => {
            let _ = open_settings_window(app, "general");
        }
        "library" => {
            let _ = open_library_window(app, "items");
        }
        "toggle" => toggle_boards(app),
        "quit" => app.exit(0),
        "update-available" => {
            let _ = open_settings_window(app, "about");
        }
        _ => {} // e.g. widget right-click menus, handled in JS
    }
}

/// A non-production build (devtest) marks its tray icon with an orange dot, so it never passes for the real app.
fn dev_mark(icon: &tauri::image::Image) -> tauri::image::Image<'static> {
    let (w, h) = (icon.width() as usize, icon.height() as usize);
    let mut px = icon.rgba().to_vec();
    let (cx, cy, r) = (w as f64 * 0.72, h as f64 * 0.72, w as f64 * 0.28);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
            if d <= r {
                let rgba = if d > r * 0.8 { [255, 255, 255, 255] } else { [255, 120, 0, 255] }; // white rim, orange fill
                px[(y * w + x) * 4..][..4].copy_from_slice(&rgba);
            }
        }
    }
    tauri::image::Image::new_owned(px, w as u32, h as u32)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let icon = app.default_window_icon().cloned().expect("icon");
    let dev = app.config().identifier != PRODUCTION_IDENTIFIER;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(if dev { dev_mark(&icon) } else { icon })
        .tooltip(if dev { "WidgetBoard (dev)" } else { "WidgetBoard" })
        .menu(&build_menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        .on_tray_icon_event(|tray, ev| {
            // left-click only shows (a stray click must not hide anything); hiding is the menu's Show/hide
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                raise_boards(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    wait_for_parent(); // relaunched for an update: let the old copy exit first
    tauri::Builder::default()
        // a second launch just shows the running app instead of starting a rival copy
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            raise_boards(app);
            let _ = app.emit("toast", "toast.already_running");
        }))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let just_updated = install_pending_update(&dir); // may relaunch the new exe and exit
            for sub in ["assets", "data", "diary", "updates"] {
                fs::create_dir_all(dir.join(sub))?;
            }
            for (file, default) in [("theme.css", DEFAULT_THEME), ("config.json", DEFAULT_CONFIG)] {
                if !dir.join(file).exists() {
                    fs::write(dir.join(file), default)?;
                }
            }
            // before anything reads layout.json: content moves out of widget settings (schema 3)
            let migrate_error = migrate::run(&dir, &backups_root(app.handle(), &dir)).err();
            let widgets = read_json::<Value>(&dir.join("layout.json"))
                .and_then(|v| v.get("widgets").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            migrate_config(&dir); // v0.12: fold settings.json + checklist.weekStart into config.json
            // 2026-10-12: checklist items join the shared entry store (needs ui.weekStart, so after the fold)
            let migrate_error = migrate_error.or(migrate::merge_checklist(&dir, &backups_root(app.handle(), &dir)).err());
            let settings = load_settings(&dir);
            let id = app.config().identifier.clone();
            let _ = RUN_NAME.set(if id == PRODUCTION_IDENTIFIER { "WidgetBoard".into() } else { format!("WidgetBoard ({id})") });
            repair_autostart(&id);
            let content = content::load(&dir);
            // timers, stopwatches and pomodoros that ran when the app last closed stop at that moment (app.js)
            let closed = read_json::<Value>(&dir.join("data").join("closed.json")).and_then(|v| v["at"].as_u64());
            let session = json!({ "launched": now_ms(), "closed": closed });
            app.manage(AppState {
                dir,
                widgets: Mutex::new(widgets),
                content: Mutex::new(content),
                revs: Mutex::new(HashMap::new()),
                migrate_error,
                settings: Mutex::new(settings),
                boards: Mutex::new(vec![]),
                hits: Mutex::new(HashMap::new()),
                interacting: AtomicBool::new(false),
                edit: AtomicBool::new(false),
                tray_items: Mutex::new(None),
                generation: AtomicUsize::new(0),
                media: media::Media::new(),
                kbd: AtomicBool::new(false),
                dwell_ms: AtomicUsize::new(0),
                zoom: Mutex::new(1.0),
                update_busy: AtomicBool::new(false),
                just_updated: Mutex::new(just_updated),
                demo_origin: Mutex::new(String::new()),
                session,
            });

            let handle = app.handle().clone();
            create_boards(&handle)?;
            build_tray(&handle)?;
            spawn_hit_test(handle.clone());
            spawn_monitor_watch(handle.clone());
            spawn_updater(handle.clone());
            spawn_auto_backup(handle.clone());
            spawn_file_watch(handle, app.state::<AppState>().dir.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            raise_board,
            load_state,
            put_widget,
            remove_widget,
            move_widget,
            save_theme,
            save_asset,
            store_get,
            store_read,
            store_set,
            content::content_list,
            content::content_put,
            content::content_erase,
            open_library,
            diary_get,
            diary_read,
            diary_set,
            diary_dates,
            diary_all,
            list_assets,
            list_fonts,
            open_config_file,
            open_data_folder,
            media_subscribe,
            media_control,
            save_config,
            set_autostart,
            memo_archive,
            memo_archive_list,
            set_dwell,
            set_zoom,
            set_kbd_mode,
            set_hotkey,
            notify,
            open_url,
            get_all_widgets,
            replace_widgets,
            update_status,
            update_check,
            update_install,
            update_skip,
            set_hit_rects,
            set_interacting,
            pin_widget,
            unpin_widget,
            set_edit_mode,
            open_theme_file,
            get_settings,
            set_app,
            open_settings,
            open_demo,
            flush_boards,
            backup_now,
            restore_backup,
            list_backups,
            open_backups_folder,
            emit_primary
        ])
        .build(tauri::generate_context!())
        .expect("error while running WidgetBoard")
        .run(|app, event| {
            // Quit from the tray, an update restart, and Windows shutting down (WM_ENDSESSION) all end here; a crash
            // does not, so the boards can tell the two apart.
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app.try_state::<AppState>() {
                    let data = st.dir.join("data");
                    let _ = fs::create_dir_all(&data);
                    let _ = write_atomic(&data.join("closed.json"), json!({ "at": now_ms() }).to_string().as_bytes());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_rect_maps_css_px_to_physical_screen() {
        let r = Rect { x: 100.0, y: 50.0, w: 200.0, h: 120.0 };
        assert_eq!(pin_rect((0, 0), r, 1.0, 1.0), (100, 50, 200, 120));
        assert_eq!(pin_rect((1920, 0), r, 1.0, 1.5), (1920 + 150, 75, 300, 180)); // second monitor at 150%
        assert_eq!(pin_rect((0, 40), r, 1.25, 1.0), (125, 40 + 63, 250, 150)); // UI zoom, taskbar on top; 62.5 rounds up
    }

    #[test]
    fn tray_menu_ids_and_labels_exist() {
        let menu = tray_menu();
        assert!(!menu.is_empty(), "tray-menu.json parses");
        for (id, label) in menu {
            if id == "-" {
                continue;
            }
            assert!(TRAY_PLAIN.contains(&id.as_str()) || ["add", "edit"].contains(&id.as_str()), "build_menu does not know tray id {id}");
            for (code, src) in LOCALES {
                let m: HashMap<String, String> = serde_json::from_str(src).unwrap();
                assert!(m.contains_key(label), "{code}.json lacks tray label {label}");
            }
        }
    }

    #[test]
    fn demo_query_keeps_only_known_focus_types() {
        assert_eq!(demo_query(None), "demo");
        assert_eq!(demo_query(Some("timer")), "demo&focus=timer");
        assert_eq!(demo_query(Some("retired-widget")), "demo");
    }

    #[test]
    fn purge_assets_keeps_shared_images() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-artifacts/native").join(format!("wb-purge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::create_dir_all(dir.join("data")).unwrap();
        for f in ["only.png", "live.png", "saved.png", "other.png"] {
            fs::write(dir.join("assets").join(f), b"x").unwrap();
        }
        fs::write(dir.join("layout.json"), br#"{"widgets":[{"bg":"live.png"}]}"#).unwrap();
        fs::write(dir.join("data").join("layouts.json"), br#"[{"widgets":[{"bg":"saved.png"}]}]"#).unwrap();
        let gone = vec![json!({ "w": { "bg": "only.png", "settings": { "imgs": ["live.png", "saved.png"] } } })];
        purge_assets(&dir, &gone);
        let has = |f: &str| dir.join("assets").join(f).exists();
        assert!(!has("only.png"), "image only the erased widget used is deleted");
        assert!(has("live.png"), "image a live widget uses stays");
        assert!(has("saved.png"), "image a saved layout uses stays");
        assert!(has("other.png"), "unrelated image stays");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_restore_roundtrip() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-artifacts/native").join(format!("wb-test-{}", std::process::id()));
        let live = base.join("live");
        let backups = base.join("backups");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(live.join("data")).unwrap();
        fs::write(live.join("config.json"), b"{\"a\":1}").unwrap();
        fs::write(live.join("data").join("checklist.json"), b"[1,2,3]").unwrap();
        fs::write(live.join("data").join("skip.tmp"), b"junk").unwrap();

        let dest = backup_to(&live, &backups, "test").unwrap();
        assert!(dest.join("manifest.json").exists());
        assert!(dest.join("config.json").exists());
        assert_eq!(fs::read(dest.join("data").join("checklist.json")).unwrap(), b"[1,2,3]");
        assert!(!dest.join("data").join("skip.tmp").exists(), ".tmp files are not backed up");

        // Mutate live, then restore from the backup.
        fs::write(live.join("config.json"), b"{\"a\":999}").unwrap();
        fs::write(live.join("data").join("extra.json"), b"new").unwrap();
        restore_from(&dest, &live).unwrap();
        assert_eq!(fs::read(live.join("config.json")).unwrap(), b"{\"a\":1}", "file restored");
        assert!(live.join("data").join("checklist.json").exists(), "backed-up file is back");
        assert!(
            !live.join("data").join("extra.json").exists(),
            "content dirs are replaced wholesale, so files added after the backup are gone"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_damaged_backup_is_refused_before_anything_is_touched() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-artifacts/native").join(format!("wb-validate-{}", now_secs()));
        let (live, backups) = (base.join("live"), base.join("backups"));
        fs::create_dir_all(live.join("data")).unwrap();
        fs::write(live.join("layout.json"), br#"{"version":3,"widgets":[]}"#).unwrap();
        fs::write(live.join("data").join("content.json"), br#"{"version":1,"items":{}}"#).unwrap();
        let good = backup_to(&live, &backups, "").unwrap();
        assert_eq!(validate_backup(&good), Ok(()));
        let broken = backup_to(&live, &backups, "").unwrap();
        fs::write(broken.join("data").join("content.json"), b"{ cut off").unwrap();
        assert_eq!(validate_backup(&broken), Err("damaged:data/content.json".into()));
        let partial = backup_to(&live, &backups, "").unwrap();
        fs::remove_file(partial.join("layout.json")).unwrap();
        assert_eq!(validate_backup(&partial), Err("damaged:layout.json".into()));
        let _ = fs::remove_dir_all(&base);
    }

    /// Date-shaped strings under keys the demo loader does not shift (ui/tutorial/dataset.js shifts date, doneOn, doneDates).
    fn unshifted_dates(v: &Value, key: &str, shifted: &[&str], bad: &mut Vec<String>) {
        match v {
            Value::String(s) if valid_date(s) && !shifted.contains(&key) => bad.push(format!("{key}: {s}")),
            Value::Array(a) => a.iter().for_each(|x| unshifted_dates(x, key, shifted, bad)),
            Value::Object(o) => o.iter().for_each(|(k, x)| unshifted_dates(x, k, shifted, bad)),
            _ => {}
        }
    }

    #[test]
    fn tutorial_dataset_is_a_valid_backup() {
        let ui = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui");
        let ds = ui.join("tutorial/dataset");
        assert_eq!(validate_backup(&ds), Ok(()), "the demo dataset is a whole backup folder");
        let manifest: Value = read_json(&ds.join("manifest.json")).unwrap();
        assert!(valid_date(manifest["anchor"].as_str().unwrap_or("")), "manifest.anchor is a YYYY-MM-DD date");

        // layout.json: what persist_widgets writes
        let layout: Value = read_json(&ds.join("layout.json")).unwrap();
        assert_eq!(layout["version"], migrate::LAYOUT_SCHEMA);
        let placements = layout["widgets"].as_array().expect("layout.json widgets");
        assert!(placements.iter().any(|w| w["hidden"] == true), "one hidden widget, so edit mode shows a ghost");
        let content_keys: serde_json::Map<String, Value> = serde_json::from_str(include_str!("../../ui/widgets/content-keys.json")).unwrap();
        let known: Vec<&str> = widget_ids();
        let mut seen = HashSet::new();

        // content.json: read by content::load (only after validate_backup, so a broken file is never moved aside)
        assert!(read_json::<Value>(&ds.join("data/content.json")).unwrap()["items"].is_object());
        let content = content::load(&ds);
        for w in placements {
            let (id, ty) = (w["id"].as_str().expect("widget id"), w["type"].as_str().expect("widget type"));
            assert!(seen.insert(id), "widget id {id} is unique");
            assert!(known.contains(&ty), "{ty} is a widget type");
            assert!(w["w"].as_u64().unwrap_or(0) > 0 && w["h"].as_u64().unwrap_or(0) > 0, "{id} has a size to pack with");
            let keys: Vec<&str> = content_keys.get(ty).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            for k in &keys {
                assert!(w["settings"].get(*k).is_none(), "{id}: content key {k} belongs in content.json, not in the placement");
            }
            if keys.is_empty() {
                assert!(!content.contains_key(id), "{id} is not Library content");
                continue;
            }
            let item = content.get(id).unwrap_or_else(|| panic!("{id} has a content item"));
            assert_eq!((item["id"].as_str(), item["type"].as_str()), (Some(id), Some(ty)));
            assert!(item["deletedAt"].is_null() && item["rev"].as_u64().is_some() && item["data"].is_object());
            for k in item["data"].as_object().unwrap().keys() {
                assert!(keys.contains(&k.as_str()), "{id}: {k} is not a {ty} content key");
            }
            // the loader shifts no timestamp: a timer that ran or is running would show a wrong time
            for k in ["endAt", "startedAt", "runStart", "workFrom", "away", "since"] {
                let v = &item["data"][k];
                assert!(v.is_null() || *v == json!(0), "{id}: {k} is a time the loader does not shift");
            }
        }
        assert_eq!(content.len(), placements.iter().filter(|w| content.contains_key(w["id"].as_str().unwrap())).count(), "no content item without a widget");

        // data/events.json: the shared entry store
        let events: Vec<Value> = read_json(&ds.join("data/events.json")).expect("events.json is a list");
        let mut ids = HashSet::new();
        for e in &events {
            assert!(ids.insert(e["id"].as_str().expect("event id")), "event ids are unique");
            assert!(e["title"].is_string() && valid_date(e["date"].as_str().unwrap_or("")), "event needs a title and a date");
            assert!(e.get("doneOn").is_none_or(|d| valid_date(d.as_str().unwrap_or(""))));
            assert!(e["doneDates"].as_array().is_none_or(|a| a.iter().all(|d| valid_date(d.as_str().unwrap_or("")))));
        }
        let mut bad = vec![];
        unshifted_dates(&Value::Array(events.clone()), "", &["date", "doneOn", "doneDates"], &mut bad);
        for f in ["layout.json", "data/content.json"] {
            unshifted_dates(&read_json::<Value>(&ds.join(f)).unwrap(), "", &[], &mut bad);
        }
        assert!(bad.is_empty(), "dates the demo loader does not shift: {bad:?}");

        // files the sample names exist, and every sample text key exists in both languages
        let assets = ui.join("tutorial/assets");
        for (_, item) in &content {
            let data = &item["data"];
            let names = data["imgs"].as_array().into_iter().flatten().chain(data["tracks"].as_array().into_iter().flatten().map(|t| &t["file"]));
            for n in names {
                assert!(assets.join(n.as_str().unwrap()).exists(), "asset {n} is missing from ui/tutorial/assets");
            }
        }
        let text = format!("{}{}{}", fs::read_to_string(ds.join("layout.json")).unwrap(), fs::read_to_string(ds.join("data/events.json")).unwrap(), fs::read_to_string(ds.join("data/content.json")).unwrap());
        for lang in ["en", "ko"] {
            let board: HashMap<String, String> = serde_json::from_str(&fs::read_to_string(ui.join(format!("locales/{lang}/board.json"))).unwrap()).unwrap();
            for key in text.split('"').filter(|s| s.starts_with("demo.sample.")) {
                assert!(board.contains_key(key), "locales/{lang}/board.json lacks {key}");
            }
        }
    }

    #[test]
    fn restoring_a_pre_library_backup_is_converted_on_the_next_start() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-artifacts/native").join(format!("wb-oldrestore-{}", now_secs()));
        let (live, backups) = (base.join("live"), base.join("backups"));
        fs::create_dir_all(live.join("data")).unwrap();
        // an old (schema 2) state, backed up
        fs::write(live.join("layout.json"), br#"{"version":2,"widgets":[{"id":"m","type":"memo","settings":{"text":"old note"}}]}"#).unwrap();
        let old = backup_to(&live, &backups, "").unwrap();
        // the app moved on: schema 3 with a content store
        fs::write(live.join("layout.json"), br#"{"version":3,"widgets":[]}"#).unwrap();
        fs::write(live.join("data").join("content.json"), br#"{"version":1,"items":{"x":{"id":"x"}}}"#).unwrap();
        validate_backup(&old).unwrap();
        restore_from(&old, &live).unwrap();
        assert!(!live.join("data").join("content.json").exists(), "the old state has no content store");
        assert!(migrate::run(&live, &backups).unwrap(), "the relaunch converts it");
        let content: Value = read_json(&live.join("data").join("content.json")).unwrap();
        assert_eq!(content["items"]["m"]["data"]["text"], "old note");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn migrate_folds_settings_and_weekstart() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-artifacts/native").join(format!("wb-mig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::write(
            base.join("settings.json"),
            br#"{"lang":"en","on_top":true,"reduce_motion":false}"#,
        )
        .unwrap();
        fs::write(base.join("config.json"), br#"{"checklist":{"weekStart":"sun"}}"#).unwrap();

        migrate_config(&base);
        let s = load_settings(&base);
        assert_eq!(s.lang, "en");
        let cfg = read_config(&base);
        assert_eq!(cfg["app"]["lang"], "en", "settings folded into config.app");
        assert_eq!(cfg["ui"]["weekStart"], "sun", "weekStart moved to ui");

        // Idempotent: once config.app exists, a changed settings.json is ignored.
        fs::write(base.join("settings.json"), br#"{"lang":"ko"}"#).unwrap();
        migrate_config(&base);
        assert_eq!(load_settings(&base).lang, "en");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn broken_config_is_never_overwritten() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-artifacts/native").join(format!("wb-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let typo = r#"{"ui":{"weekStart":"sun",},"timer":{"presets":[]}}"#; // trailing comma
        fs::write(base.join("config.json"), typo).unwrap();
        assert!(config_broken(&base));
        migrate_config(&base);
        assert_eq!(fs::read_to_string(base.join("config.json")).unwrap(), typo, "file kept as is");
        let _ = fs::remove_dir_all(&base);
    }
}
