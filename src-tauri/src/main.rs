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

mod media;
mod updater;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    ipc::{InvokeBody, Request},
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

const DEFAULT_THEME: &str = include_str!("../../ui/default-theme.css");
const DEFAULT_CONFIG: &str = include_str!("default-config.json");
const TRAY_ID: &str = "main";

/// Widget types offered in the tray; ids must match the REGISTRY in ui/app.js.
const WIDGETS: &[&str] = &["checklist", "calendar", "dday", "diary", "memo", "nowplaying", "timer", "stopwatch", "image"];

/// Embedded translations (same files the UI loads). First entry is the default language.
const LOCALES: &[(&str, &str)] = &[
    ("ko", include_str!("../../ui/locales/ko.json")),
    ("en", include_str!("../../ui/locales/en.json")),
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
    on_top: bool,
    reduce_motion: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self { lang: LOCALES[0].0.into(), on_top: false, reduce_motion: false }
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
}

impl AppState {
    fn persist_widgets(&self) -> Result<(), String> {
        let data = json!({ "version": 2, "widgets": *self.widgets.lock().unwrap() });
        write_atomic(&self.dir.join("layout.json"), serde_json::to_string_pretty(&data).unwrap().as_bytes())
    }
    fn persist_settings(&self) {
        let s = serde_json::to_string_pretty(&*self.settings.lock().unwrap()).unwrap();
        let _ = write_atomic(&self.dir.join("settings.json"), s.as_bytes());
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

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
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

fn read_config(dir: &Path) -> Value {
    read_json(&dir.join("config.json"))
        .or_else(|| serde_json::from_str(DEFAULT_CONFIG).ok())
        .unwrap_or(Value::Null)
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
    // Widgets whose monitor is missing (unplugged, or older layout) show on the primary board.
    let widgets: Vec<Value> = state
        .widgets
        .lock()
        .unwrap()
        .iter()
        .filter(|w| match w.get("display").and_then(Value::as_str) {
            Some(d) if present.contains(d) => d == my_display,
            _ => i_am_primary,
        })
        .cloned()
        .collect();
    let theme =
        fs::read_to_string(state.dir.join("theme.css")).unwrap_or_else(|_| DEFAULT_THEME.into());
    let settings = state.settings.lock().unwrap().clone();
    json!({
        "display": my_display,
        "primary": i_am_primary,
        "displays": boards,
        "widgets": widgets,
        "theme": theme,
        "lang": settings.lang,
        "onTop": settings.on_top,
        "reduceMotion": settings.reduce_motion,
        "edit": state.edit.load(Ordering::Relaxed),
        "config": read_config(&state.dir),
        "autostart": autostart_get(),
        "assetsDir": state.dir.join("assets"),
        "version": updater::CURRENT,
        "justUpdated": if i_am_primary { state.just_updated.lock().unwrap().take() } else { None },
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

/// `src` identifies the writing widget so it can ignore its own change notification.
#[tauri::command]
fn store_set(app: AppHandle, state: State<AppState>, key: String, value: Value, src: String) -> Result<(), String> {
    if !valid_key(&key) {
        return Err("bad key".into());
    }
    let s = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    write_atomic(&state.dir.join("data").join(format!("{key}.json")), s.as_bytes())?;
    let _ = app.emit("store-changed", json!({ "key": key, "src": src }));
    Ok(())
}

/// Diary: one Markdown file per day in diary/YYYY-MM-DD.md.
#[tauri::command]
fn diary_get(state: State<AppState>, date: String) -> Result<String, String> {
    if !valid_date(&date) {
        return Err("bad date".into());
    }
    Ok(fs::read_to_string(state.dir.join("diary").join(format!("{date}.md"))).unwrap_or_default())
}

#[tauri::command]
fn diary_set(app: AppHandle, state: State<AppState>, date: String, text: String, src: String) -> Result<(), String> {
    if !valid_date(&date) {
        return Err("bad date".into());
    }
    let path = state.dir.join("diary").join(format!("{date}.md"));
    if text.trim().is_empty() {
        let _ = fs::remove_file(&path);
    } else {
        write_atomic(&path, text.as_bytes())?;
    }
    let _ = app.emit("store-changed", json!({ "key": "diary", "date": date, "src": src }));
    Ok(())
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
fn save_theme(state: State<AppState>, css: String) -> Result<(), String> {
    write_atomic(&state.dir.join("theme.css"), css.as_bytes())
}

/// Raw binary upload. JS: invoke('save_asset', uint8array, { headers: { ext: 'png' } })
#[tauri::command]
fn save_asset(state: State<AppState>, request: Request) -> Result<String, String> {
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
                    merge(b.entry(k).or_insert(Value::Null), v);
                }
            }
            (b, p) => *b = p,
        }
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

/// Start with Windows: a value under HKCU\...\Run pointing at this exe.
fn autostart_get() -> bool {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        return RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|k| k.get_value::<String, _>("WidgetBoard"))
            .is_ok();
    }
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
fn set_autostart(on: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            key.set_value("WidgetBoard", &format!("\"{}\"", exe.display())).map_err(|e| e.to_string())?;
        } else {
            let _ = key.delete_value("WidgetBoard");
        }
    }
    let _ = on;
    Ok(autostart_get())
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
    for w in boards(&app) {
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

/// Replace every widget at once (loading a layout preset); all boards reload.
#[tauri::command]
fn replace_widgets(app: AppHandle, state: State<AppState>, widgets: Vec<Value>) -> Result<(), String> {
    *state.widgets.lock().unwrap() = widgets.into_iter().filter(|w| widget_id(w).is_some()).collect();
    state.persist_widgets()?;
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

// ---------- behaviour ----------

/// Boards are on top when "always on top" is set or while editing; otherwise on the desktop layer.
fn apply_layer(app: &AppHandle) {
    let st = app.state::<AppState>();
    let top = st.edit.load(Ordering::Relaxed) || st.kbd.load(Ordering::Relaxed) || st.settings.lock().unwrap().on_top;
    for w in boards(app) {
        if top {
            let _ = w.set_always_on_bottom(false);
            let _ = w.set_always_on_top(true);
        } else {
            let _ = w.set_always_on_top(false);
            let _ = w.set_always_on_bottom(true);
        }
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
    let show = !ws.iter().any(|w| w.is_visible().unwrap_or(false));
    for w in ws {
        let _ = if show { w.show() } else { w.hide() };
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
    let on_top = st.settings.lock().unwrap().on_top;

    for (b, m) in list.iter().zip(monitors.iter()) {
        let wa = m.work_area();
        let sf = m.scale_factor();
        let w = WebviewWindowBuilder::new(app, &b.label, WebviewUrl::App("index.html".into()))
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
            .always_on_bottom(!on_top)
            .always_on_top(on_top)
            .disable_drag_drop_handler()
            .build()?;
        w.set_position(wa.position)?; // position first: a DPI change may resize the window
        w.set_size(wa.size)?;
        let _ = w.set_ignore_cursor_events(true);
        w.show()?;
    }
    Ok(())
}

// ---------- self-update ----------
fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
/// config.json → "update": { "check": "weekly" | "daily" | "off", "url": "https://…/latest.json" }
fn update_config(dir: &Path) -> (String, String) {
    let c = read_config(dir);
    let check = c["update"]["check"].as_str().unwrap_or("weekly").to_string();
    let url = c["update"]["url"].as_str().map(str::trim).filter(|u| !u.is_empty()).or(updater::DEFAULT_URL).unwrap_or("").to_string();
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
        "pending": updater::pending(&dir),
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
/// Check → download → verify. `manual` = the user asked, so also report "up to date" and errors.
fn run_update_check(app: &AppHandle, manual: bool) {
    let st = app.state::<AppState>();
    if st.update_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("update-status", update_info(&st));
    let dir = st.dir.join("updates");
    let (_, url) = update_config(&st.dir);
    let res = if url.is_empty() {
        Err("not_configured".to_string())
    } else {
        updater::check_and_download(&dir, &url, updater::PUBLIC_KEY)
    };
    if !url.is_empty() {
        updater::record(&dir, now_secs(), &res);
    }
    st.update_busy.store(false, Ordering::SeqCst);
    let info = update_info(&st);
    let _ = app.emit("update-status", info.clone());
    match (&res, st.primary_label()) {
        (Ok(Some(_)), Some(label)) => {
            refresh_tray(app);
            let _ = app.emit_to(&label, "update-ready", info["pending"].clone());
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
fn spawn_updater(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(180));
        loop {
            let (due, dir) = {
                let st = app.state::<AppState>();
                let (check, url) = update_config(&st.dir);
                let dir = st.dir.join("updates");
                (!url.is_empty() && updater::is_due(&check, updater::last_check(&dir), now_secs()), dir)
            };
            if due && updater::pending(&dir).is_none() {
                run_update_check(&app, false);
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}
/// Relaunch this exe after we exit; the new process waits for us (single-instance) and installs the update.
fn restart_for_update(app: &AppHandle) {
    let _ = app.emit("flush-saves", ());
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700)); // let pending widget saves land
        if let Ok(exe) = std::env::current_exe() {
            if std::process::Command::new(exe).args(["--wait-pid", &std::process::id().to_string()]).spawn().is_ok() {
                h.exit(0);
            }
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
#[tauri::command]
fn update_restart(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if updater::pending(&state.dir.join("updates")).is_none() {
        return Err("nothing to install".into());
    }
    restart_for_update(&app);
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let st = app.state::<AppState>();
    let s = st.settings.lock().unwrap().clone();
    let t = |k: &str| tr(&s.lang, k);

    let add_items = WIDGETS
        .iter()
        .map(|id| MenuItem::with_id(app, format!("add:{id}"), t(&format!("widget.{id}")), true, None::<&str>))
        .collect::<Result<Vec<_>, _>>()?;
    let add_refs: Vec<&dyn IsMenuItem<Wry>> = add_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let add = Submenu::with_items(app, t("tray.add_widget"), true, &add_refs)?;

    let edit = CheckMenuItem::with_id(app, "edit", t("tray.edit_layout"), true, st.edit.load(Ordering::Relaxed), None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "on_top", t("tray.on_top"), true, s.on_top, None::<&str>)?;
    let motion = CheckMenuItem::with_id(app, "motion", t("tray.reduce_motion"), true, s.reduce_motion, None::<&str>)?;
    let theme = MenuItem::with_id(app, "theme", t("tray.theme"), true, None::<&str>)?;

    let lang_items = LOCALES
        .iter()
        .map(|(code, _)| {
            let name = locales().get(code).and_then(|m| m.get("_name")).cloned().unwrap_or(code.to_string());
            CheckMenuItem::with_id(app, format!("lang:{code}"), name, true, *code == s.lang, None::<&str>)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let lang_refs: Vec<&dyn IsMenuItem<Wry>> = lang_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let lang = Submenu::with_items(app, t("tray.language"), true, &lang_refs)?;

    let toggle = MenuItem::with_id(app, "toggle", t("tray.show_hide"), true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", t("tray.open_folder"), true, None::<&str>)?;
    let config = MenuItem::with_id(app, "config", t("tray.open_config"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", t("tray.settings"), true, None::<&str>)?;
    let layouts = MenuItem::with_id(app, "layouts", t("tray.layouts"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t("tray.quit"), true, None::<&str>)?;
    let update = match updater::pending(&st.dir.join("updates")) {
        Some(p) => {
            let text = t("tray.update_apply").replace("{v}", p["version"].as_str().unwrap_or(""));
            MenuItem::with_id(app, "update-apply", text, true, None::<&str>)?
        }
        None => MenuItem::with_id(app, "update", t("tray.update_check"), true, None::<&str>)?,
    };
    let sep = || PredefinedMenuItem::separator(app);

    let menu = Menu::with_items(
        app,
        &[&add, &edit, &on_top, &motion, &theme, &settings, &layouts, &sep()?, &lang, &toggle, &folder, &config, &update, &sep()?, &quit],
    )?;
    *st.tray_items.lock().unwrap() = Some(TrayItems { edit });
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    let st = app.state::<AppState>();
    if let Some(kind) = id.strip_prefix("add:") {
        if let Some(label) = st.primary_label() {
            for w in boards(app) {
                let _ = w.show();
            }
            let _ = app.emit_to(&label, "add-widget", kind);
        }
        return;
    }
    if let Some(code) = id.strip_prefix("lang:") {
        st.settings.lock().unwrap().lang = code.to_string();
        st.persist_settings();
        if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app)) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = app.emit("lang-changed", code);
        return;
    }
    match id {
        "edit" => apply_edit_mode(app, !st.edit.load(Ordering::Relaxed)),
        "on_top" => {
            {
                let mut s = st.settings.lock().unwrap();
                s.on_top = !s.on_top;
            }
            st.persist_settings();
            apply_layer(app);
        }
        "motion" => {
            let on = {
                let mut s = st.settings.lock().unwrap();
                s.reduce_motion = !s.reduce_motion;
                s.reduce_motion
            };
            st.persist_settings();
            let _ = app.emit("motion-changed", on);
        }
        "settings" | "layouts" => {
            apply_edit_mode(app, true);
            if let Some(label) = st.primary_label() {
                let _ = app.emit_to(&label, if id == "settings" { "open-settings" } else { "open-layouts" }, ());
            }
        }
        "theme" => {
            apply_edit_mode(app, true); // the panel needs the mouse
            if let Some(label) = st.primary_label() {
                let _ = app.emit_to(&label, "open-theme-panel", ());
            }
        }
        "toggle" => toggle_boards(app),
        "folder" => open_path(&st.dir),
        "config" => open_path(&st.dir.join("config.json")),
        "quit" => app.exit(0),
        "update" => {
            let h = app.clone();
            std::thread::spawn(move || run_update_check(&h, true));
        }
        "update-apply" => restart_for_update(app),
        _ => {} // e.g. widget right-click menus, handled in JS
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("WidgetBoard")
        .menu(&build_menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                toggle_boards(tray.app_handle());
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
            for w in boards(app) {
                let _ = w.show();
            }
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
            let widgets = read_json::<Value>(&dir.join("layout.json"))
                .and_then(|v| v.get("widgets").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            let settings: Settings = read_json(&dir.join("settings.json")).unwrap_or_default();
            app.manage(AppState {
                dir,
                widgets: Mutex::new(widgets),
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
            });

            let handle = app.handle().clone();
            create_boards(&handle)?;
            build_tray(&handle)?;
            spawn_hit_test(handle.clone());
            spawn_monitor_watch(handle.clone());
            spawn_updater(handle.clone());
            spawn_file_watch(handle, app.state::<AppState>().dir.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            put_widget,
            remove_widget,
            move_widget,
            save_theme,
            save_asset,
            store_get,
            store_set,
            diary_get,
            diary_set,
            diary_dates,
            list_assets,
            list_fonts,
            open_config_file,
            media_subscribe,
            media_control,
            save_config,
            set_autostart,
            set_dwell,
            set_zoom,
            set_kbd_mode,
            set_hotkey,
            notify,
            get_all_widgets,
            replace_widgets,
            update_status,
            update_check,
            update_restart,
            set_hit_rects,
            set_interacting,
            set_edit_mode,
            open_theme_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running WidgetBoard");
}
