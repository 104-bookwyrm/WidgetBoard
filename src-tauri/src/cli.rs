//! `WidgetBoard.exe cli ...`: read and change widget contents from a terminal or an AI agent.
//! Reads come from the saved files. A change goes to the running app, which saves it through the same commands the
//! widgets use, so the boards update at once; with the app closed it goes straight to the file.
use crate::{content, now_secs, read_json, valid_date, valid_key, write_atomic, AppState};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Map, Value};
use std::{fs, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

const USAGE: &str = "usage:
  WidgetBoard cli list                    widgets on the boards, Library items, stores, diary dates
  WidgetBoard cli get <target>            print a target
  WidgetBoard cli set <target> <file|->   replace a target from a UTF-8 file, or stdin with -
targets:
  <widget-id>          a widget's content (memo, images, timer...); set replaces its data object
  store:<key>          shared data, e.g. store:events (calendar, checklist, D-day); set replaces the whole value
  diary:<YYYY-MM-DD>   a diary page as text; set with empty text deletes the page";

/// First argument of a change forwarded to the running app (see `forward`).
pub const APPLY: &str = "cli-apply";
/// `src` on the change events, so every widget treats the change as someone else's.
const SRC: &str = "cli";

enum Target {
    Item(String),
    Store(String),
    Diary(String),
}

impl Target {
    fn parse(t: &str) -> Result<Self, String> {
        if let Some(k) = t.strip_prefix("store:") {
            // content.json is the Library, held in memory by the app: reach it by widget id instead
            return if valid_key(k) && k != "content" { Ok(Self::Store(k.into())) } else { Err(format!("bad store name: {k}")) };
        }
        if let Some(d) = t.strip_prefix("diary:") {
            return if valid_date(d) { Ok(Self::Diary(d.into())) } else { Err(format!("bad date (YYYY-MM-DD): {d}")) };
        }
        if valid_key(t) { Ok(Self::Item(t.into())) } else { Err(format!("bad target: {t}")) }
    }

    fn parts(&self) -> (&str, &str) {
        match self {
            Self::Item(id) => ("item", id),
            Self::Store(k) => ("store", k),
            Self::Diary(d) => ("diary", d),
        }
    }

    fn from_parts(kind: &str, key: &str) -> Option<Self> {
        Self::parse(&match kind {
            "store" => format!("store:{key}"),
            "diary" => format!("diary:{key}"),
            _ => key.to_string(),
        })
        .ok()
    }
}

/// Run a `cli` launch and return its exit code; None when this launch is not the CLI.
pub fn run(identifier: &str) -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("cli") {
        return None;
    }
    attach_console();
    let dir = PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join(identifier); // Tauri's app_data_dir
    match exec(&dir, identifier, &args[1..]) {
        Ok(out) => {
            println!("{out}");
            Some(0)
        }
        Err(e) => {
            eprintln!("{e}");
            Some(1)
        }
    }
}

fn exec(dir: &Path, identifier: &str, args: &[String]) -> Result<String, String> {
    match args {
        [c] if c == "list" => Ok(pretty(&list(dir))),
        [c, t] if c == "get" => get(dir, &Target::parse(t)?),
        [c, t, src] if c == "set" => {
            let target = Target::parse(t)?;
            let text = if src == "-" { std::io::read_to_string(std::io::stdin()) } else { fs::read_to_string(src) };
            let text = text.map_err(|e| format!("{src}: {e}"))?;
            let text = text.trim_start_matches('\u{feff}'); // PowerShell's Out-File writes a BOM
            check(dir, &target, text)?;
            if forward(identifier, &target, text) {
                // the send waits for the app's handler, so the file already shows whether it saved
                return if saved(dir, &target, text) { Ok("saved (running app)".into()) } else { Err("the running app did not save it".into()) };
            }
            write_files(dir, &target, text)?;
            Ok("saved".into())
        }
        _ => Err(USAGE.into()),
    }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))
}

/// Library items read without content::load, which moves a broken file aside: a read must not touch anything.
fn items(dir: &Path) -> Map<String, Value> {
    read_json::<Value>(&dir.join("data").join("content.json"))
        .and_then(|v| v.get("items").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

fn list(dir: &Path) -> Value {
    let items = items(dir);
    let widgets = read_json::<Value>(&dir.join("layout.json"))
        .and_then(|v| v.get("widgets").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let on_board: Vec<&str> = widgets.iter().filter_map(|w| w["id"].as_str()).collect();
    let name = |w: &Value, id: &str| match w.get("name").and_then(Value::as_str) {
        Some(n) if !n.is_empty() => json!(n),
        _ => items.get(id).map_or(json!(""), |i| i["name"].clone()),
    };
    let widgets: Vec<Value> = widgets
        .iter()
        .map(|w| {
            let id = w["id"].as_str().unwrap_or_default();
            json!({ "id": id, "type": w["type"], "name": name(w, id), "content": items.contains_key(id) })
        })
        .collect();
    let library: Vec<Value> = items
        .values()
        .filter(|i| i["deletedAt"].is_null() && !on_board.contains(&i["id"].as_str().unwrap_or_default()))
        .map(|i| json!({ "id": i["id"], "type": i["type"], "name": i["name"] }))
        .collect();
    let names = |sub: &str, ext: &str| -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir.join(sub))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(ext).map(String::from))
            .filter(|n| n != "content")
            .collect();
        v.sort();
        v
    };
    json!({ "widgets": widgets, "library": library, "stores": names("data", ".json"), "diary": names("diary", ".md") })
}

fn get(dir: &Path, t: &Target) -> Result<String, String> {
    match t {
        Target::Item(id) => items(dir).get(id).map(pretty).ok_or_else(|| format!("no widget content with id {id}")),
        Target::Store(k) => read_json::<Value>(&dir.join("data").join(format!("{k}.json"))).map(|v| pretty(&v)).ok_or_else(|| format!("no store {k}")),
        Target::Diary(d) => Ok(fs::read_to_string(dir.join("diary").join(format!("{d}.md"))).unwrap_or_default()),
    }
}

/// Everything that can be refused is refused here, before anything is sent or written.
fn check(dir: &Path, t: &Target, text: &str) -> Result<(), String> {
    match t {
        Target::Item(id) => {
            if !items(dir).contains_key(id) {
                return Err(format!("no widget content with id {id}"));
            }
            if !parse_json(text)?.is_object() {
                return Err("a widget's data must be a JSON object".into());
            }
        }
        Target::Store(_) => drop(parse_json(text)?),
        Target::Diary(_) => {}
    }
    Ok(())
}

/// Whether the files now hold `text` for `t` (after a forwarded change).
fn saved(dir: &Path, t: &Target, text: &str) -> bool {
    match t {
        Target::Item(id) => items(dir).get(id).map(|i| &i["data"]) == parse_json(text).ok().as_ref(),
        Target::Store(k) => read_json::<Value>(&dir.join("data").join(format!("{k}.json"))) == parse_json(text).ok(),
        Target::Diary(d) => {
            let want = if text.trim().is_empty() { "" } else { text };
            fs::read_to_string(dir.join("diary").join(format!("{d}.md"))).unwrap_or_default() == want
        }
    }
}

/// The app is closed: nothing holds the data in memory, so write the files the way the app would.
fn write_files(dir: &Path, t: &Target, text: &str) -> Result<(), String> {
    match t {
        Target::Item(id) => {
            let mut items = items(dir);
            let mut item = items.get(id).cloned().ok_or("no such item")?;
            let rev = item["rev"].as_u64();
            item["data"] = parse_json(text)?;
            content::put(&mut items, item, rev, now_secs()).map_err(|_| "conflict")?;
            let file = json!({ "version": content::SCHEMA, "items": items });
            write_atomic(&dir.join("data").join("content.json"), pretty(&file).as_bytes())
        }
        Target::Store(k) => write_atomic(&dir.join("data").join(format!("{k}.json")), pretty(&parse_json(text)?).as_bytes()),
        Target::Diary(d) => {
            let path = dir.join("diary").join(format!("{d}.md"));
            if text.trim().is_empty() {
                let _ = fs::remove_file(&path);
                Ok(())
            } else {
                fs::create_dir_all(dir.join("diary")).map_err(|e| e.to_string())?;
                write_atomic(&path, text.as_bytes())
            }
        }
    }
}

/// In the running app: a change the CLI forwarded. `args` = [APPLY, kind, key, base64 text].
pub fn apply_forwarded(app: &AppHandle, args: &[String]) {
    let [_, kind, key, b64] = args else { return };
    let (Some(t), Some(text)) = (Target::from_parts(kind, key), B64.decode(b64).ok().and_then(|b| String::from_utf8(b).ok())) else { return };
    // the CLI reads the files back and reports a failure, so nothing to do with the error here
    let _ = apply_live(app, t, text);
}

fn apply_live(app: &AppHandle, t: Target, text: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    match t {
        Target::Item(id) => {
            let mut item = state.content.lock().unwrap().get(&id).cloned().ok_or("no such item")?;
            let rev = item["rev"].as_u64();
            item["data"] = parse_json(&text)?;
            content::content_put(app.clone(), state, item, rev, SRC.into()).map(drop).map_err(|e| e.to_string())
        }
        Target::Store(k) => crate::store_set(app.clone(), state, k, parse_json(&text)?, SRC.into(), None).map(drop),
        Target::Diary(d) => crate::diary_set(app.clone(), state, d, text, SRC.into(), None).map(drop),
    }
}

/// Hand a change to the running app; false when it is not running.
#[cfg(windows)]
fn forward(identifier: &str, t: &Target, text: &str) -> bool {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LPARAM, WPARAM},
            System::DataExchange::COPYDATASTRUCT,
            UI::WindowsAndMessaging::{FindWindowW, SendMessageW, WM_COPYDATA},
        },
    };
    // ponytail: borrows tauri-plugin-single-instance 2.4.5's window names, message id and "cwd|arg|arg" payload
    // (platform_impl/windows.rs). 2.5 changes the payload: recheck this on a plugin upgrade (the CLI then reports
    // "did not save").
    let wide = |s: String| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (class, name) = (wide(format!("{identifier}-sic")), wide(format!("{identifier}-siw")));
    let Ok(hwnd) = (unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(name.as_ptr())) }) else { return false };
    if hwnd.is_invalid() {
        return false;
    }
    let (kind, key) = t.parts();
    // base64 keeps any "|" in the text from splitting the payload; the first arg stands in for the exe path
    let data = format!(".|widgetboard|{APPLY}|{kind}|{key}|{}\0", B64.encode(text));
    let cds = COPYDATASTRUCT { dwData: 1542, cbData: data.len() as u32, lpData: data.as_ptr() as *mut _ };
    unsafe { SendMessageW(hwnd, WM_COPYDATA, Some(WPARAM(0)), Some(LPARAM(&cds as *const _ as isize))) };
    true
}

#[cfg(not(windows))]
fn forward(_: &str, _: &Target, _: &str) -> bool {
    false
}

/// Release builds are GUI apps with no console: print into the terminal that started them.
fn attach_console() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
        if GetStdHandle(STD_OUTPUT_HANDLE).map_or(true, |h| h.is_invalid() || h.0.is_null()) {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}
