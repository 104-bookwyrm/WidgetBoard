//! Library content in data/content.json: one item per memo, image list, timer... with a per-item revision.
//! A save names the revision it started from; Rust compares and writes under one lock, so a stale writer gets
//! the newer item back instead of overwriting it. Every window hears `content-changed`.
use crate::{now_secs, write_atomic, AppState};
use serde_json::{json, Map, Value};
use std::{fs, path::Path};
use tauri::{AppHandle, Emitter, State};

pub const SCHEMA: u64 = 1;

fn path(dir: &Path) -> std::path::PathBuf {
    dir.join("data").join("content.json")
}

/// Items from content.json. An unreadable file is moved aside (kept, never overwritten) and the store starts empty.
pub fn load(dir: &Path) -> Map<String, Value> {
    let p = path(dir);
    let Ok(text) = fs::read_to_string(&p) else { return Map::new() };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => v.get("items").and_then(Value::as_object).cloned().unwrap_or_default(),
        Err(_) => {
            let _ = fs::rename(&p, p.with_extension(format!("broken-{}.json", now_secs())));
            Map::new()
        }
    }
}

/// Store `item` if `rev` is the stored revision (None = the item must be new). Ok(stored item), or Err(current
/// item) on a stale revision. Fills rev, created, updated and the contract's default fields.
pub fn put(items: &mut Map<String, Value>, mut item: Value, rev: Option<u64>, now: u64) -> Result<Value, Value> {
    let id = item.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let current = items.get(&id);
    let current_rev = current.and_then(|c| c.get("rev")).and_then(Value::as_u64);
    if current_rev != rev {
        return Err(current.cloned().unwrap_or(Value::Null));
    }
    let created = current.and_then(|c| c.get("created")).cloned().unwrap_or(json!(now));
    item["rev"] = json!(current_rev.unwrap_or(0) + 1);
    item["created"] = created;
    item["updated"] = json!(now);
    for (k, default) in [("name", json!("")), ("tags", json!([])), ("deletedAt", Value::Null), ("data", json!({}))] {
        if item.get(k).is_none() {
            item[k] = default;
        }
    }
    items.insert(id, item.clone());
    Ok(item)
}

#[tauri::command]
pub fn content_list(state: State<AppState>) -> Vec<Value> {
    state.content.lock().unwrap().values().cloned().collect()
}

/// Err is `{ conflict: <current item> }` for a stale revision, or `{ error }`.
#[tauri::command]
pub fn content_put(app: AppHandle, state: State<AppState>, item: Value, rev: Option<u64>, src: String) -> Result<Value, Value> {
    let ok_id = item.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
        && item.get("type").and_then(Value::as_str).is_some_and(|t| !t.is_empty());
    if !ok_id {
        return Err(json!({ "error": "content needs an id and a type" }));
    }
    let mut items = state.content.lock().unwrap();
    let before = items.clone();
    let stored = put(&mut items, item, rev, now_secs()).map_err(|current| json!({ "conflict": current }))?;
    let file = json!({ "version": SCHEMA, "items": &*items });
    if let Err(e) = write_atomic(&path(&state.dir), serde_json::to_string_pretty(&file).unwrap().as_bytes()) {
        *items = before; // not on disk, so not stored
        return Err(json!({ "error": e }));
    }
    drop(items);
    let _ = app.emit("content-changed", json!({ "item": &stored, "src": src }));
    Ok(stored)
}

/// "Delete permanently": only for an item already in Recently deleted. Image/audio files nothing else uses go too.
#[tauri::command]
pub fn content_erase(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let mut items = state.content.lock().unwrap();
    let Some(item) = items.get(&id).cloned() else { return Ok(()) };
    if item.get("deletedAt").is_none_or(Value::is_null) {
        return Err("only deleted content can be erased".into());
    }
    items.remove(&id);
    let file = json!({ "version": SCHEMA, "items": &*items });
    if let Err(e) = write_atomic(&path(&state.dir), serde_json::to_string_pretty(&file).unwrap().as_bytes()) {
        items.insert(id, item);
        return Err(e);
    }
    drop(items);
    crate::purge_assets(&state.dir, &[item]);
    let _ = app.emit("content-erased", json!({ "id": id }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_checks_the_revision_and_fills_contract_fields() {
        let mut items = Map::new();
        let a = put(&mut items, json!({ "id": "m1", "type": "memo", "data": { "text": "a" } }), None, 10).unwrap();
        assert_eq!((a["rev"].as_u64(), a["created"].as_u64(), a["tags"].clone()), (Some(1), Some(10), json!([])));
        assert!(a["deletedAt"].is_null());
        // a second "new" item with the same id is stale
        assert_eq!(put(&mut items, json!({ "id": "m1", "type": "memo" }), None, 11).unwrap_err()["rev"], 1);
        let b = put(&mut items, json!({ "id": "m1", "type": "memo", "data": { "text": "b" } }), Some(1), 12).unwrap();
        assert_eq!((b["rev"].as_u64(), b["created"].as_u64(), b["updated"].as_u64()), (Some(2), Some(10), Some(12)));
        // a writer still on rev 1 gets the newer item back; nothing changes
        let stale = put(&mut items, json!({ "id": "m1", "type": "memo", "data": { "text": "old" } }), Some(1), 13);
        assert_eq!(stale.unwrap_err()["data"]["text"], "b");
        assert_eq!(items["m1"]["data"]["text"], "b");
    }

    #[test]
    fn an_unreadable_file_is_kept_aside() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../test-artifacts/native")
            .join(format!("content-broken-{}", now_secs()));
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(path(&dir), b"{ not json").unwrap();
        assert!(load(&dir).is_empty());
        assert!(!path(&dir).exists());
        let kept = fs::read_dir(dir.join("data")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("broken"));
        assert!(kept);
    }
}
