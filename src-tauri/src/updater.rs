//! Update scheduling and small state files. Installer acquisition and verification use Tauri's signed updater.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const CURRENT: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_URL: Option<&str> = Some(
    "https://github.com/104-bookwyrm/WidgetBoard/releases/latest/download/latest-installer.json",
);
const DAY: u64 = 24 * 3600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Offer {
    pub version: String,
    pub notes: String,
}
#[derive(Debug, Clone, PartialEq)]
pub enum InstallOutcome {
    None,
    Completed(String),
    Incomplete(String),
}

pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut i = v.trim().trim_start_matches('v').split('.');
    let result = (
        i.next()?.parse().ok()?,
        i.next()?.parse().ok()?,
        i.next()?.parse().ok()?,
    );
    i.next().is_none().then_some(result)
}
pub fn is_newer(candidate: &str, than: &str) -> bool {
    matches!((parse_version(candidate), parse_version(than)), (Some(a), Some(b)) if a > b)
}
pub fn is_due(check: &str, last: u64, now: u64) -> bool {
    let every = match check {
        "off" => return false,
        "daily" => DAY,
        _ => 7 * DAY,
    };
    now < last || now - last >= every
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(p).ok()?).ok()
}
fn write_json(p: &Path, v: &Value) -> Result<(), String> {
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&tmp, p).map_err(|e| e.to_string())
}
pub fn last_check(dir: &Path) -> u64 {
    read_json(&dir.join("state.json"))
        .and_then(|v| v["last_check"].as_u64())
        .unwrap_or(0)
}
pub fn state(dir: &Path) -> Value {
    read_json(&dir.join("state.json")).unwrap_or(json!({}))
}
pub fn record_offer(dir: &Path, now: u64, offer: Option<Offer>, error: Option<&str>) {
    let mut v = state(dir);
    v["last_check"] = json!(now);
    v["last_error"] = json!(error);
    if error.is_none() {
        v["last_found"] = json!(offer.as_ref().map(|o| &o.version));
        v["notes"] = json!(offer.as_ref().map(|o| &o.notes));
    }
    let _ = write_json(&dir.join("state.json"), &v);
}
pub fn record_error(dir: &Path, error: &str) {
    let mut v = state(dir);
    v["last_error"] = json!(error);
    let _ = write_json(&dir.join("state.json"), &v);
}
pub fn available(dir: &Path) -> Option<Offer> {
    available_as(dir, CURRENT)
}
pub fn available_as(dir: &Path, current: &str) -> Option<Offer> {
    let s = state(dir);
    let version = s["last_found"].as_str()?;
    (is_newer(version, current) && s["skipped"].as_str() != Some(version)).then(|| Offer {
        version: version.into(),
        notes: s["notes"].as_str().unwrap_or("").into(),
    })
}
pub fn skip(dir: &Path, version: Option<&str>) {
    let mut v = state(dir);
    v["skipped"] = json!(version);
    let _ = write_json(&dir.join("state.json"), &v);
}
pub fn mark_installing(dir: &Path, version: &str) -> Result<(), String> {
    write_json(
        &dir.join("updates/installing.json"),
        &json!({"version":version}),
    )
}
pub fn take_install_outcome(dir: &Path) -> InstallOutcome {
    let path = dir.join("updates/installing.json");
    if !path.exists() {
        return InstallOutcome::None;
    }
    let outcome = match read_json(&path).and_then(|v| v["version"].as_str().map(str::to_owned)) {
        Some(v) if v == CURRENT => InstallOutcome::Completed(v),
        Some(v) => InstallOutcome::Incomplete(v),
        None => InstallOutcome::Incomplete("unknown".into()),
    };
    let _ = fs::remove_file(path);
    outcome
}
pub fn discard_legacy_pending(dir: &Path) {
    let _ = fs::remove_file(dir.join("pending.exe"));
    let _ = fs::remove_file(dir.join("pending.json"));
    let _ = fs::remove_file(dir.join("pending.exe.part"));
}

/// Bounded HTTPS fetch via the Windows HTTP stack. iCal fetches also use this helper.
pub fn fetch(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") {
        return Err("only https:// addresses are allowed".into());
    }
    net::get(url, limit)
}
#[cfg(windows)]
mod net {
    use windows::core::HSTRING;
    use windows::Foundation::Uri;
    use windows::Storage::Streams::DataReader;
    use windows::Web::Http::{HttpClient, HttpCompletionOption};
    pub fn get(url: &str, limit: usize) -> Result<Vec<u8>, String> {
        let e = |x: windows::core::Error| x.message().to_string();
        let client = HttpClient::new().map_err(e)?;
        let uri = Uri::CreateUri(&HSTRING::from(url)).map_err(e)?;
        let resp = client
            .GetWithOptionAsync(&uri, HttpCompletionOption::ResponseHeadersRead)
            .and_then(|op| op.get())
            .map_err(e)?;
        let status = resp.StatusCode().map_err(e)?.0;
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}"));
        }
        if let Ok(len) = resp
            .Content()
            .and_then(|c| c.Headers())
            .and_then(|h| h.ContentLength())
            .and_then(|l| l.Value())
        {
            if len as usize > limit {
                return Err("download too large".into());
            }
        }
        let buf = resp
            .Content()
            .and_then(|c| c.ReadAsBufferAsync())
            .and_then(|op| op.get())
            .map_err(e)?;
        let n = buf.Length().map_err(e)? as usize;
        if n > limit {
            return Err("download too large".into());
        }
        let reader = DataReader::FromBuffer(&buf).map_err(e)?;
        let mut out = vec![0; n];
        reader.ReadBytes(&mut out).map_err(e)?;
        Ok(out)
    }
}
#[cfg(not(windows))]
mod net {
    pub fn get(_url: &str, _limit: usize) -> Result<Vec<u8>, String> {
        Err("https downloads are only implemented on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!(
            "widgetboard-updater-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    #[test]
    fn schedule_and_version_ordering() {
        assert!(is_due("daily", 1, 1 + DAY));
        assert!(!is_due("daily", 1, 1 + DAY - 1));
        assert!(is_due("weekly", 1, 1 + 7 * DAY));
        assert!(!is_due("off", 1, u64::MAX));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.2.3", "1.2.3"));
    }
    #[test]
    fn offer_record_and_skip_behavior() {
        let dir = temp();
        let offer = Offer {
            version: "9.0.0".into(),
            notes: "notes".into(),
        };
        record_offer(&dir, 42, Some(offer.clone()), None);
        assert_eq!(available_as(&dir, "1.0.0"), Some(offer));
        skip(&dir, Some("9.0.0"));
        assert_eq!(available_as(&dir, "1.0.0"), None);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn matching_wrong_and_invalid_markers_are_consumed_once_and_legacy_files_discarded() {
        let cases = [
            (format!(r#"{{"version":"{}"}}"#, CURRENT), true),
            (r#"{"version":"1.0.0"}"#.into(), false),
            ("{".into(), false),
        ];
        for (marker, completed) in cases {
            let dir = temp();
            fs::create_dir_all(dir.join("updates")).unwrap();
            fs::write(dir.join("updates/installing.json"), marker).unwrap();
            fs::write(dir.join("updates/pending.exe"), b"old").unwrap();
            fs::write(dir.join("updates/pending.json"), b"{}").unwrap();
            discard_legacy_pending(&dir.join("updates"));
            assert!(!dir.join("updates/pending.exe").exists());
            assert!(!dir.join("updates/pending.json").exists());
            assert_eq!(
                matches!(take_install_outcome(&dir), InstallOutcome::Completed(_)),
                completed
            );
            assert!(!dir.join("updates/installing.json").exists());
            assert_eq!(take_install_outcome(&dir), InstallOutcome::None);
            let _ = fs::remove_dir_all(dir);
        }
    }
    #[test]
    fn mark_installing_records_version() {
        let dir = temp();
        mark_installing(&dir, "2.0.0").unwrap();
        assert_eq!(
            read_json(&dir.join("updates/installing.json")).unwrap()["version"],
            "2.0.0"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
