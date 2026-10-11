//! One-time conversion to Library content (layout schema 3): memo text, photo lists, timers... leave widget
//! settings for data/content.json. Runs at startup before any board loads.
//! Safety: a pre-migration snapshot first, then a marker naming it. A run that stops midway is redone from that
//! snapshot on the next start. layout.json version 3 is written last and is the "done" mark.
use crate::{backup_to, now_secs, read_json, restore_from, write_atomic};
use serde_json::{json, Map, Value};
use std::{collections::HashMap, fs, path::Path};

pub const LAYOUT_SCHEMA: u64 = 3;
/// Which settings keys are Library content, per widget type. The board reads the same file.
const CONTENT_KEYS: &str = include_str!("../../ui/widgets/content-keys.json");

fn content_keys() -> Map<String, Value> {
    serde_json::from_str(CONTENT_KEYS).expect("content-keys.json")
}
fn keys_of<'a>(keys: &'a Map<String, Value>, ty: &str) -> Option<Vec<&'a str>> {
    keys.get(ty)?.as_array().map(|a| a.iter().filter_map(Value::as_str).collect())
}

/// Ok(true) when data was converted. Ok(false): already converted, or nothing saved yet.
pub fn run(dir: &Path, backups: &Path) -> Result<bool, String> {
    let marker = dir.join("migration.json");
    let version = |d: &Path| read_json::<Value>(&d.join("layout.json")).and_then(|v| v["version"].as_u64()).unwrap_or(0);
    if version(dir) >= LAYOUT_SCHEMA || !dir.join("layout.json").exists() {
        let _ = fs::remove_file(&marker);
        return Ok(false);
    }
    match read_json::<Value>(&marker).and_then(|m| m["snapshot"].as_str().map(std::path::PathBuf::from)) {
        Some(snapshot) => restore_from(&snapshot, dir)?, // interrupted before: start again from untouched data
        None => {
            let snapshot = backup_to(dir, backups, "pre-migration")?;
            write_atomic(&marker, json!({ "snapshot": snapshot }).to_string().as_bytes())?;
        }
    }
    convert(dir)?;
    let _ = fs::remove_file(&marker);
    Ok(true)
}

struct Candidate {
    item: Value,     // the content item
    rank: (u8, u64), // (source tier, time): active 2 > shelf/bin 1 (newest first) > saved layout 0
    placement: Value,
}

fn convert(dir: &Path) -> Result<(), String> {
    let keys = content_keys();
    let now = now_secs();
    let data = dir.join("data");
    let active: Vec<Value> = read_json::<Value>(&dir.join("layout.json"))
        .and_then(|v| v["widgets"].as_array().cloned())
        .unwrap_or_default();
    let mut layouts: Vec<Value> = read_json(&data.join("layouts.json")).unwrap_or_default();
    let shelf: Map<String, Value> = read_json(&data.join("layouts_shelf.json")).unwrap_or_default();
    let bin: Vec<Value> = read_json(&data.join("bin.json")).unwrap_or_default();

    // One id may have meant two types over time (memo switched to timer, then a saved layout still has the memo).
    // The id belongs to the type of its newest copy; other types get `<id>-<type>`, as a stash does.
    let mut home: HashMap<String, ((u8, u64), String)> = HashMap::new();
    {
        let mut see = |w: &Value, rank: (u8, u64)| {
            let (Some(id), Some(ty)) = (w["id"].as_str(), w["type"].as_str()) else { return };
            let e = home.entry(id.to_string()).or_insert((rank, ty.to_string()));
            if rank > e.0 {
                *e = (rank, ty.to_string());
            }
        };
        active.iter().for_each(|w| see(w, (2, u64::MAX)));
        shelf.values().for_each(|e| see(&e["w"], (1, e["at"].as_u64().unwrap_or(0))));
        bin.iter().for_each(|e| see(&e["w"], (1, e["at"].as_u64().unwrap_or(0) * 1000)));
        for l in &layouts {
            l["widgets"].as_array().into_iter().flatten().for_each(|w| see(w, (0, 0)));
        }
    }
    let content_id = |id: &str, ty: &str| match home.get(id) {
        Some((_, t)) if t != ty => format!("{id}-{ty}"),
        _ => id.to_string(),
    };
    let mut found: HashMap<String, Vec<Candidate>> = HashMap::new();
    let mut collect = |w: &Value, rank: (u8, u64)| {
        let Some(id) = w["id"].as_str() else { return };
        let ty = w["type"].as_str().unwrap_or_default();
        let id = &content_id(id, ty);
        let mut add = |id: String, ty: &str, settings: &Value, name: &Value| {
            let Some(k) = keys_of(&keys, ty) else { return };
            let data: Map<String, Value> =
                k.iter().filter_map(|key| Some((key.to_string(), settings.get(*key)?.clone()))).collect();
            let item = json!({ "id": id, "type": ty, "name": name.as_str().unwrap_or(""), "tags": [], "rev": 1,
                "created": now, "updated": now, "deletedAt": null, "data": data });
            found.entry(id).or_default().push(Candidate { item, rank, placement: strip(w, &keys) });
        };
        add(id.clone(), ty, &w["settings"], &w["name"]);
        // a type stash (memo kept behind a widget switched to clock...) becomes its own unplaced item
        for (sty, settings) in w["stash"].as_object().into_iter().flatten() {
            add(format!("{id}-{sty}"), sty, settings, &Value::Null);
        }
    };
    for w in &active {
        collect(w, (2, u64::MAX));
    }
    for e in shelf.values() {
        collect(&e["w"], (1, e["at"].as_u64().unwrap_or(0))); // shelf `at` is ms
    }
    for e in &bin {
        collect(&e["w"], (1, e["at"].as_u64().unwrap_or(0) * 1000)); // bin `at` is seconds
    }
    for l in &layouts {
        for w in l["widgets"].as_array().into_iter().flatten() {
            collect(w, (0, 0));
        }
    }

    let placed: std::collections::HashSet<&str> = active.iter().filter_map(|w| w["id"].as_str()).collect();
    let mut items = Map::new();
    let mut archive = String::new();
    for (id, mut copies) in found {
        copies.sort_by(|a, b| b.rank.cmp(&a.rank));
        let mut copies = copies.into_iter();
        let Candidate { mut item, placement, .. } = copies.next().unwrap();
        if !placed.contains(id.as_str()) {
            item["placement"] = placement; // reopening from the Library restores where it was
        }
        // other versions of a memo's text are kept in the memo archive, never merged or dropped
        if item["type"] == "memo" {
            let mut seen = vec![item["data"]["text"].clone()];
            for c in copies {
                let text = &c.item["data"]["text"];
                if text.as_str().is_some_and(|t| !t.trim().is_empty()) && !seen.contains(text) {
                    seen.push(text.clone());
                    archive += &(json!({ "t": now, "id": id, "name": c.item["name"], "text": text }).to_string() + "\n");
                }
            }
        }
        items.insert(id, item);
    }

    // write order: content first, layout.json version 3 last (the "done" mark)
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    write_atomic(&data.join("content.json"), pretty(&json!({ "version": crate::content::SCHEMA, "items": items })).as_bytes())?;
    if !archive.is_empty() {
        use std::io::Write;
        fs::create_dir_all(dir.join("archive")).map_err(|e| e.to_string())?;
        fs::OpenOptions::new().create(true).append(true).open(dir.join("archive").join("memos.jsonl"))
            .and_then(|mut f| f.write_all(archive.as_bytes()))
            .map_err(|e| e.to_string())?;
    }
    for l in layouts.iter_mut() {
        if let Some(ws) = l["widgets"].as_array_mut() {
            for w in ws.iter_mut() {
                let id = content_id(w["id"].as_str().unwrap_or_default(), w["type"].as_str().unwrap_or_default());
                *w = strip(w, &keys);
                w["id"] = json!(id); // the placement id is its content id
            }
        }
    }
    if data.join("layouts.json").exists() {
        write_atomic(&data.join("layouts.json"), pretty(&json!(layouts)).as_bytes())?;
    }
    for (file, empty) in [("layouts_shelf.json", json!({})), ("bin.json", json!([])), ("layouts_undo.json", Value::Null)] {
        if data.join(file).exists() {
            write_atomic(&data.join(file), pretty(&empty).as_bytes())?;
        }
    }
    let widgets: Vec<Value> = active.iter().map(|w| strip(w, &keys)).collect();
    write_atomic(&dir.join("layout.json"), pretty(&json!({ "version": LAYOUT_SCHEMA, "widgets": widgets })).as_bytes())
}

/// A placement without its content: content keys and the type stash leave. The name stays as a display copy
/// (the settings window lists placements); the content item's name is the real one.
fn strip(w: &Value, keys: &Map<String, Value>) -> Value {
    let mut w = w.clone();
    if let Some(o) = w.as_object_mut() {
        o.remove("stash");
    }
    let ty = w["type"].as_str().unwrap_or_default().to_string();
    if let Some(k) = keys_of(keys, &ty) {
        if let Some(s) = w["settings"].as_object_mut() {
            for key in k {
                s.remove(key);
            }
        }
    }
    w
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn setup(name: &str) -> (PathBuf, PathBuf) {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../test-artifacts/native")
            .join(format!("migrate-{name}-{}", now_secs()));
        let (dir, backups) = (base.join("live"), base.join("backups"));
        fs::create_dir_all(dir.join("data")).unwrap();
        let w = |v: Value| v;
        fs::write(dir.join("layout.json"), json!({ "version": 2, "widgets": [
            w(json!({ "id": "m1", "type": "memo", "name": "Groceries", "x": 0, "y": 0, "w": 3, "h": 3,
                "settings": { "text": "milk", "color": "blue" } })),
            w(json!({ "id": "c1", "type": "clock", "x": 3, "y": 0, "w": 2, "h": 2,
                "settings": { "tz": "Asia/Seoul" }, "stash": { "memo": { "text": "behind the clock", "color": "yellow" } } })),
            w(json!({ "id": "i1", "type": "image", "x": 5, "y": 0, "w": 3, "h": 3,
                "settings": { "imgs": ["a.png"], "fit": "contain" } })),
        ] }).to_string()).unwrap();
        fs::write(dir.join("data").join("layouts_shelf.json"), json!({
            "m1": { "at": 5000, "w": { "id": "m1", "type": "memo", "settings": { "text": "eggs" } } },
            "t1": { "at": 9000, "w": { "id": "t1", "type": "timer", "x": 1, "y": 1, "w": 3, "h": 3,
                "settings": { "duration": 60000, "remaining": 1000, "endAt": null } } },
        }).to_string()).unwrap();
        fs::write(dir.join("data").join("bin.json"), json!([
            { "at": 3, "w": { "id": "m2", "type": "memo", "settings": { "text": "closed note" } } },
            { "at": 4, "w": { "id": "k1", "type": "clock", "settings": {} } },
        ]).to_string()).unwrap();
        fs::write(dir.join("data").join("layouts.json"), json!([
            { "name": "desk", "widgets": [ { "id": "m1", "type": "memo", "x": 9, "y": 9, "w": 3, "h": 3,
                "settings": { "text": "milk", "color": "blue" } },
                { "id": "i1", "type": "memo", "settings": { "text": "before it was an image" } } ] },
        ]).to_string()).unwrap();
        (dir, backups)
    }
    fn items(dir: &Path) -> Map<String, Value> {
        read_json::<Value>(&dir.join("data").join("content.json")).unwrap()["items"].as_object().unwrap().clone()
    }

    #[test]
    fn content_leaves_settings_and_nothing_is_lost() {
        let (dir, backups) = setup("convert");
        assert!(run(&dir, &backups).unwrap());
        let items = items(&dir);
        assert_eq!(items["m1"]["data"], json!({ "text": "milk", "color": "blue" })); // the board copy beats the shelf
        assert_eq!(items["m1"]["name"], "Groceries");
        assert_eq!(items["c1-memo"]["data"]["text"], "behind the clock"); // stash -> own item
        assert_eq!(items["t1"]["data"]["remaining"], 1000); // shelved timer keeps its state
        assert_eq!(items["t1"]["placement"]["x"], 1);
        assert_eq!(items["m2"]["data"]["text"], "closed note"); // bin -> Library
        assert!(!items.contains_key("k1")); // tools are not content
        assert!(items["m1"].get("placement").is_none()); // on the board
        let layout: Value = read_json(&dir.join("layout.json")).unwrap();
        assert_eq!(layout["version"], 3);
        let m1 = &layout["widgets"][0];
        assert!(m1["settings"].get("text").is_none());
        assert!(layout["widgets"][1].get("stash").is_none());
        assert_eq!(layout["widgets"][1]["settings"]["tz"], "Asia/Seoul");
        assert_eq!(layout["widgets"][2]["settings"], json!({ "fit": "contain" }));
        let saved: Value = read_json(&dir.join("data").join("layouts.json")).unwrap();
        assert!(saved[0]["widgets"][0]["settings"].get("text").is_none());
        assert_eq!(saved[0]["widgets"][0]["x"], 9);
        // i1 is an image now; the saved layout's older memo copy keeps its own item
        assert_eq!(saved[0]["widgets"][1]["id"], "i1-memo");
        assert_eq!(items["i1-memo"]["data"]["text"], "before it was an image");
        assert_eq!(items["i1"]["type"], "image");
        assert_eq!(read_json::<Value>(&dir.join("data").join("bin.json")).unwrap(), json!([]));
        let archive = fs::read_to_string(dir.join("archive").join("memos.jsonl")).unwrap();
        assert!(archive.contains("eggs")); // the older shelf text is kept, not merged
        assert!(!dir.join("migration.json").exists());
        assert!(fs::read_dir(&backups).unwrap().flatten().any(|e| e.file_name().to_string_lossy().ends_with("pre-migration")));
        // idempotent
        assert!(!run(&dir, &backups).unwrap());
        assert_eq!(super::tests::items(&dir).len(), items.len());
    }

    #[test]
    fn an_interrupted_run_starts_again_from_the_snapshot() {
        let (dir, backups) = setup("resume");
        let snapshot = backup_to(&dir, &backups, "pre-migration").unwrap();
        fs::write(dir.join("migration.json"), json!({ "snapshot": snapshot }).to_string()).unwrap();
        // the first run got as far as emptying the bin, then stopped
        fs::write(dir.join("data").join("bin.json"), b"[]").unwrap();
        assert!(run(&dir, &backups).unwrap());
        assert_eq!(items(&dir)["m2"]["data"]["text"], "closed note");
    }
}
