//! Automatic backup schedules and retention. Files without a completed manifest are never recovery points.

use std::{fs, path::{Path, PathBuf}, time::UNIX_EPOCH};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier { Daily, Fortnight, Monthly }

impl Tier {
    pub fn key(self) -> &'static str {
        match self { Self::Daily => "daily", Self::Fortnight => "fortnight", Self::Monthly => "monthly" }
    }
    pub fn tag(self) -> &'static str {
        match self { Self::Daily => "auto", Self::Fortnight => "auto-fortnight", Self::Monthly => "auto-monthly" }
    }
}

pub struct Snapshot {
    pub path: PathBuf,
    pub tier: Option<Tier>,
    pub at: u64,
    pub stamp: String,
}

pub fn snapshots(root: &Path) -> Vec<Snapshot> {
    fs::read_dir(root).into_iter().flatten().flatten().filter_map(|entry| {
        if !entry.file_type().ok()?.is_dir() { return None; }
        let path = entry.path();
        let name = path.file_name()?.to_str()?;
        if name.ends_with(".partial") { return None; }
        let manifest = path.join("manifest.json");
        let m: Value = serde_json::from_slice(&fs::read(&manifest).ok()?).ok()?;
        if !m.get("files")?.is_array() { return None; }
        let tier = match m.get("tier").and_then(Value::as_str) {
            Some("daily") => Some(Tier::Daily),
            Some("fortnight") => Some(Tier::Fortnight),
            Some("monthly") => Some(Tier::Monthly),
            // Old automatic snapshots have no tier. Count collision-suffixed names as well.
            None if name.strip_prefix("WidgetBoard-backup-").is_some_and(|n| {
                n.ends_with("-auto") || n.rsplit_once("-auto-").is_some_and(|(_, s)| s.parse::<u64>().is_ok())
            }) => Some(Tier::Daily),
            _ => None,
        };
        let at = m.get("createdUnix").and_then(Value::as_u64).or_else(|| {
            fs::metadata(&manifest).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
        })?;
        Some(Snapshot { path, tier, at, stamp: m.get("created").and_then(Value::as_str).unwrap_or("").into() })
    }).collect()
}

pub fn due(root: &Path, mode: &str, now: u64, stamp: &str) -> Vec<Tier> {
    if !["daily", "weekly"].contains(&mode) { return vec![]; }
    let all = snapshots(root);
    [Tier::Daily, Tier::Fortnight, Tier::Monthly].into_iter().filter(|tier| {
        let latest = all.iter().filter(|s| s.tier == Some(*tier)).max_by_key(|s| s.at);
        let Some(last) = latest else { return true; };
        if now < last.at { return false; } // clock went backwards; do not erase newer recovery points
        match tier {
            Tier::Daily if mode == "weekly" => now - last.at >= 7 * 86400,
            Tier::Daily => period_changed(&last.stamp, stamp, 8).unwrap_or(now - last.at >= 86400),
            Tier::Fortnight => now - last.at >= 14 * 86400,
            Tier::Monthly => period_changed(&last.stamp, stamp, 6).unwrap_or(now - last.at >= 31 * 86400),
        }
    }).collect()
}

fn period_changed(before: &str, after: &str, digits: usize) -> Option<bool> {
    // Windows stamps are local YYYYMMDD-HHMM. Other platforms fall back to an interval.
    if before.as_bytes().get(8) != Some(&b'-') || after.as_bytes().get(8) != Some(&b'-') { return None; }
    Some(after.get(..digits)? > before.get(..digits)?)
}

pub fn prune(root: &Path, tier: Tier, daily_keep: usize) -> Result<(), String> {
    let mut all: Vec<_> = snapshots(root).into_iter().filter(|s| s.tier == Some(tier)).collect();
    all.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.path.cmp(&a.path)));
    let keep = if tier == Tier::Daily { daily_keep.max(1) } else { 1 };
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    for old in all.into_iter().skip(keep) {
        let resolved = old.path.canonicalize().map_err(|e| e.to_string())?;
        if resolved.parent() != Some(canonical_root.as_path()) { return Err("backup path escaped its root".into()); }
        fs::remove_dir_all(resolved).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn root(name: &str) -> PathBuf {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-artifacts/native")
            .join(format!("backup-{name}-{}", crate::now_secs()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn snapshot(root: &std::path::Path, name: &str, tier: &str, at: u64, date: &str) {
        let p = root.join(name);
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("manifest.json"), serde_json::json!({
            "tier": tier, "createdUnix": at, "created": date, "files": []
        }).to_string()).unwrap();
    }

    #[test]
    fn defaults_enable_three_independent_schedules() {
        let cfg: serde_json::Value = serde_json::from_str(crate::DEFAULT_CONFIG).unwrap();
        assert_eq!(cfg["backup"]["auto"], "daily");
        let p = root("empty");
        assert_eq!(due(&p, "daily", 100, "20261011-1200"), vec![Tier::Daily, Tier::Fortnight, Tier::Monthly]);
        assert!(due(&p, "off", 100, "20261011-1200").is_empty());
    }

    #[test]
    fn schedules_do_not_postpone_each_other() {
        let p = root("due");
        let now = 2_000_000;
        snapshot(&p, "daily", "daily", now, "20261101-1200");
        snapshot(&p, "fortnight", "fortnight", now - 14 * 86400, "20261018-1200");
        snapshot(&p, "monthly", "monthly", now - 86400, "20261031-1200");
        assert_eq!(due(&p, "daily", now, "20261101-1200"), vec![Tier::Fortnight, Tier::Monthly]);
        snapshot(&p, "monthly-new", "monthly", now, "20261101-1200");
        assert_eq!(due(&p, "daily", now, "20261101-1400"), vec![Tier::Fortnight]);
    }

    #[test]
    fn prune_keeps_seven_daily_and_one_each_long_term() {
        let p = root("retention");
        for i in 0..10 {
            snapshot(&p, &format!("d{i}"), "daily", i, "20261011-1200");
        }
        for tier in ["fortnight", "monthly"] {
            snapshot(&p, &format!("{tier}-old"), tier, 1, "20260911-1200");
            snapshot(&p, &format!("{tier}-new"), tier, 10, "20261011-1200");
        }
        snapshot(&p, "manual", "", 1, "20260911-1200");
        fs::create_dir_all(p.join("failed-auto-monthly.partial")).unwrap();
        for tier in [Tier::Daily, Tier::Fortnight, Tier::Monthly] { prune(&p, tier, 7).unwrap(); }
        assert_eq!(snapshots(&p).iter().filter(|s| s.tier == Some(Tier::Daily)).count(), 7);
        assert!(p.join("monthly-new").exists());
        assert!(!p.join("monthly-old").exists());
        assert!(p.join("fortnight-new").exists());
        assert!(p.join("manual").exists());
        assert!(p.join("failed-auto-monthly.partial").exists());
    }

    #[test]
    fn incomplete_replacement_does_not_expire_the_previous_snapshot() {
        let p = root("failure");
        snapshot(&p, "monthly-old", "monthly", 1, "20260911-1200");
        fs::create_dir_all(p.join("monthly-new.partial")).unwrap();
        prune(&p, Tier::Monthly, 7).unwrap();
        assert!(p.join("monthly-old").exists());
        assert!(due(&p, "daily", 4_000_000, "20261011-1200").contains(&Tier::Monthly));
    }
}
