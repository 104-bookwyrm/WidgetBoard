//! Self-updater for the portable build (no installer).
//!
//! On a slow schedule (weekly by default) it fetches a small manifest (`latest.json`), downloads the new
//! `WidgetBoard.exe`, and checks it against the ed25519 public key compiled into this exe. A verified download is
//! kept in `updates/` and swapped in the next time the app starts (or right away from the tray): Windows lets a
//! running exe be renamed, so the swap is  exe → exe.old,  new → exe,  relaunch.
//!
//! The signature covers `widgetboard-update:v1\n{version}\n{sha256 hex}\n`, so a signed file can't be passed off as
//! another version, and nothing older than the running version is ever installed.
//!
//! This file has no Tauri dependency so the logic can be tested on any OS (`tools/updater-test`).

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub const CURRENT: &str = env!("CARGO_PKG_VERSION");
/// Release public key (base64, 32 bytes). Made with `node tools/release.mjs keygen`.
pub const PUBLIC_KEY: &str = include_str!("../updater.pub");
/// Where to look when config.json has no `update.url` (set at build time: WIDGETBOARD_UPDATE_URL=...).
pub const DEFAULT_URL: Option<&str> = option_env!("WIDGETBOARD_UPDATE_URL");

const MAX_MANIFEST: usize = 64 * 1024;
const MAX_EXE: usize = 64 * 1024 * 1024;
const DAY: u64 = 24 * 3600;

// ---------------------------------------------------------------- versions
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split('.');
    let p = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
    if it.next().is_some() {
        return None;
    }
    Some(p)
}
pub fn is_newer(candidate: &str, than: &str) -> bool {
    matches!((parse_version(candidate), parse_version(than)), (Some(a), Some(b)) if a > b)
}

// ---------------------------------------------------------------- schedule
/// `check`: "daily" | "weekly" | "off" (anything else = weekly). `last` = unix seconds of the last attempt.
pub fn is_due(check: &str, last: u64, now: u64) -> bool {
    let every = match check {
        "off" => return false,
        "daily" => DAY,
        _ => 7 * DAY,
    };
    now < last || now - last >= every // clock moved backwards → check
}

// ---------------------------------------------------------------- signatures
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
pub fn signed_message(version: &str, sha_hex: &str) -> Vec<u8> {
    format!("widgetboard-update:v1\n{version}\n{sha_hex}\n").into_bytes()
}
fn b64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|_| "bad base64".to_string())
}
/// Ok(sha256 hex) when `bytes` is exactly what the release key signed for `version`.
pub fn verify(public_key_b64: &str, version: &str, bytes: &[u8], signature_b64: &str) -> Result<String, String> {
    let key: [u8; 32] = b64(public_key_b64)?.try_into().map_err(|_| "public key must be 32 bytes")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "invalid public key")?;
    let sig: [u8; 64] = b64(signature_b64)?.try_into().map_err(|_| "signature must be 64 bytes")?;
    let sha = sha256_hex(bytes);
    key.verify(&signed_message(version, &sha), &Signature::from_bytes(&sig))
        .map_err(|_| "signature does not match".to_string())?;
    Ok(sha)
}

// ---------------------------------------------------------------- manifest
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub signature: String,
    pub notes: String,
}
pub fn parse_manifest(bytes: &[u8], manifest_url: &str) -> Result<Manifest, String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("manifest is not JSON: {e}"))?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let m = Manifest {
        version: s("version"),
        url: resolve(manifest_url, &s("url")),
        sha256: s("sha256").to_lowercase(),
        signature: s("signature"),
        notes: s("notes").chars().take(2000).collect(),
    };
    if parse_version(&m.version).is_none() {
        return Err("manifest: bad version".into());
    }
    if m.url.is_empty() || m.signature.is_empty() {
        return Err("manifest: url and signature are required".into());
    }
    Ok(m)
}
/// A relative `url` in the manifest is relative to the manifest's own folder.
pub fn resolve(base: &str, url: &str) -> String {
    if url.is_empty() || url.contains("://") {
        return url.to_string();
    }
    match base.rfind('/') {
        Some(i) => format!("{}/{}", &base[..i], url.trim_start_matches("./")),
        None => url.to_string(),
    }
}

// ---------------------------------------------------------------- fetching
/// https:// (Windows' own HTTP stack: system proxy and certificates) or file:// (local mirror, tests).
pub fn fetch(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    if let Some(p) = url.strip_prefix("file://") {
        let p = p.strip_prefix('/').filter(|q| q.as_bytes().get(1) == Some(&b':')).unwrap_or(p); // file:///C:/x
        let meta = fs::metadata(p).map_err(|e| format!("{p}: {e}"))?;
        if meta.len() as usize > limit {
            return Err("download too large".into());
        }
        return fs::read(p).map_err(|e| e.to_string());
    }
    if !url.starts_with("https://") {
        return Err("only https:// update addresses are allowed".into());
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
        if let Ok(h) = client.DefaultRequestHeaders() {
            let _ = h.UserAgent().and_then(|ua| ua.TryParseAdd(&HSTRING::from(format!("WidgetBoard/{}", super::CURRENT))));
        }
        let uri = Uri::CreateUri(&HSTRING::from(url)).map_err(e)?;
        let resp = client
            .GetWithOptionAsync(&uri, HttpCompletionOption::ResponseHeadersRead)
            .and_then(|op| op.get())
            .map_err(e)?;
        let status = resp.StatusCode().map_err(e)?.0;
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}"));
        }
        if let Ok(len) = resp.Content().and_then(|c| c.Headers()).and_then(|h| h.ContentLength()).and_then(|l| l.Value()) {
            if len as usize > limit {
                return Err("download too large".into());
            }
        }
        let buf = resp.Content().and_then(|c| c.ReadAsBufferAsync()).and_then(|op| op.get()).map_err(e)?;
        let n = buf.Length().map_err(e)? as usize;
        if n > limit {
            return Err("download too large".into());
        }
        let reader = DataReader::FromBuffer(&buf).map_err(e)?;
        let mut out = vec![0u8; n];
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

// ---------------------------------------------------------------- state on disk (updates/)
fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(p).ok()?).ok()
}
fn write_json(p: &Path, v: &Value) -> Result<(), String> {
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(v).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, p).map_err(|e| e.to_string())
}
pub fn last_check(dir: &Path) -> u64 {
    read_json(&dir.join("state.json")).and_then(|v| v["last_check"].as_u64()).unwrap_or(0)
}
pub fn record(dir: &Path, now: u64, result: &Result<Option<String>, String>) {
    let _ = fs::create_dir_all(dir);
    let v = json!({
        "last_check": now,
        "last_error": result.as_ref().err(),
        "last_found": result.as_ref().ok().cloned().flatten(),
    });
    let _ = write_json(&dir.join("state.json"), &v);
}
pub fn state(dir: &Path) -> Value {
    read_json(&dir.join("state.json")).unwrap_or(json!({}))
}

/// The verified download waiting to be installed: `{version, notes, sha256, signature}` (only if newer).
pub fn pending(dir: &Path) -> Option<Value> {
    let p = read_json(&dir.join("pending.json"))?;
    let v = p["version"].as_str()?;
    (is_newer(v, CURRENT) && dir.join("pending.exe").exists()).then_some(p)
}

/// Check the manifest; download + verify when newer. Ok(Some(version)) = an update is ready to install.
pub fn check_and_download(dir: &Path, manifest_url: &str, public_key: &str) -> Result<Option<String>, String> {
    check_and_download_as(dir, manifest_url, public_key, CURRENT)
}
pub fn check_and_download_as(dir: &Path, manifest_url: &str, public_key: &str, current: &str) -> Result<Option<String>, String> {
    let m = parse_manifest(&fetch(manifest_url, MAX_MANIFEST)?, manifest_url)?;
    if !is_newer(&m.version, current) {
        return Ok(None);
    }
    if let Some(p) = read_json(&dir.join("pending.json")) {
        if p["version"].as_str() == Some(m.version.as_str()) && dir.join("pending.exe").exists() {
            return Ok(Some(m.version)); // already downloaded
        }
    }
    let bytes = fetch(&m.url, MAX_EXE)?;
    let sha = verify(public_key, &m.version, &bytes, &m.signature)?;
    if !m.sha256.is_empty() && m.sha256 != sha {
        return Err("sha256 does not match the manifest".into());
    }
    if !bytes.starts_with(b"MZ") {
        return Err("download is not a Windows program".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("pending.exe.part");
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("pending.exe")).map_err(|e| e.to_string())?;
    write_json(
        &dir.join("pending.json"),
        &json!({ "version": m.version, "notes": m.notes, "sha256": sha, "signature": m.signature }),
    )?;
    Ok(Some(m.version))
}

fn discard_pending(dir: &Path) {
    let _ = fs::remove_file(dir.join("pending.exe"));
    let _ = fs::remove_file(dir.join("pending.json"));
}

/// Install the pending update over `exe` (the running program). Ok(Some(version)) = swapped; the caller must
/// relaunch `exe` and exit. On any failure the original exe is left (or put back) in place.
pub fn apply_pending(dir: &Path, exe: &Path, public_key: &str) -> Result<Option<String>, String> {
    apply_pending_as(dir, exe, public_key, CURRENT)
}
pub fn apply_pending_as(dir: &Path, exe: &Path, public_key: &str, current: &str) -> Result<Option<String>, String> {
    let Some(p) = read_json(&dir.join("pending.json")) else { return Ok(None) };
    let version = p["version"].as_str().unwrap_or("").to_string();
    if !is_newer(&version, current) {
        discard_pending(dir); // already installed (or older): tidy up
        return Ok(None);
    }
    let bytes = fs::read(dir.join("pending.exe")).map_err(|e| e.to_string());
    let verified = bytes.and_then(|b| verify(public_key, &version, &b, p["signature"].as_str().unwrap_or("")).map(|_| b));
    let bytes = match verified {
        Ok(b) => b,
        Err(e) => {
            discard_pending(dir); // damaged or tampered with: never install, fetch again next time
            return Err(e);
        }
    };
    let new = sibling(exe, "new");
    let old = sibling(exe, "old");
    fs::write(&new, &bytes).map_err(|e| format!("cannot write next to WidgetBoard.exe: {e}"))?;
    let _ = fs::remove_file(&old);
    if let Err(e) = fs::rename(exe, &old) {
        let _ = fs::remove_file(&new);
        return Err(format!("cannot replace WidgetBoard.exe: {e}"));
    }
    if let Err(e) = fs::rename(&new, exe) {
        let _ = fs::rename(&old, exe); // put the working version back
        return Err(format!("cannot replace WidgetBoard.exe: {e}"));
    }
    discard_pending(dir);
    Ok(Some(version))
}
/// After an update: remove WidgetBoard.exe.old (best effort — it may still be in use for a moment).
pub fn cleanup_old(exe: &Path) {
    let _ = fs::remove_file(sibling(exe, "old"));
}
fn sibling(exe: &Path, ext: &str) -> PathBuf {
    let mut s = exe.as_os_str().to_owned();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}
