#[path = "../../../src-tauri/src/updater.rs"]
#[allow(dead_code)]
mod updater;
use std::{fs, path::PathBuf};
use updater::*;

fn main() {
    let fx = PathBuf::from(std::env::var("FIXTURES").expect("run via run.sh"));
    let pubk = fs::read_to_string(fx.join("pub.txt")).unwrap();
    let url = |n: &str| format!("file://{}", fx.join(n).display());
    let (mut pass, mut fail) = (0, 0);
    let mut ok = |c: bool, m: &str| if c { pass += 1 } else { fail += 1; println!("FAIL: {m}") };

    // versions & schedule
    ok(parse_version("v0.10.2") == Some((0, 10, 2)) && parse_version("1.2") .is_none() && parse_version("1.2.3.4").is_none(), "parse_version");
    ok(is_newer("0.11.0", "0.10.9") && is_newer("0.10.10", "0.10.9") && !is_newer("0.10.0", "0.10.0") && !is_newer("x", "0.1.0"), "is_newer (numeric, not text)");
    ok(!is_due("off", 0, 10_000_000), "off never checks");
    ok(is_due("weekly", 0, 8 * 86400) && !is_due("weekly", 86400, 3 * 86400), "weekly");
    ok(is_due("daily", 0, 86400) && !is_due("daily", 1000, 2000), "daily");
    ok(is_due("weekly", 5000, 100), "clock moved backwards → due");
    ok(resolve("https://h/a/b/latest.json", "WidgetBoard.exe") == "https://h/a/b/WidgetBoard.exe", "relative url");
    ok(resolve("https://h/latest.json", "https://cdn/x.exe") == "https://cdn/x.exe", "absolute url kept");
    ok(PUBLIC_KEY.trim().len() == 44, "compiled-in public key present");

    // download + verify
    let d = fx.join("updates");
    let r = check_and_download_as(&d, &url("good.json"), &pubk, "0.10.0");
    ok(r == Ok(Some("0.11.0".into())), &format!("good update downloads: {r:?}"));
    ok(d.join("pending.exe").exists() && d.join("pending.json").exists(), "pending files written");
    ok(fs::read(d.join("pending.exe")).unwrap() == fs::read(fx.join("WidgetBoard.exe")).unwrap(), "pending is the exact bytes");
    ok(check_and_download_as(&d, &url("good.json"), &pubk, "0.10.0") == Ok(Some("0.11.0".into())), "second check reuses the download");
    ok(check_and_download_as(&d, &url("good.json"), &pubk, "0.11.0") == Ok(None), "same version → nothing to do");
    ok(check_and_download_as(&d, &url("good.json"), &pubk, "0.12.0") == Ok(None), "never downgrade");
    let e = fx.join("e");
    for (name, why) in [
        ("relabel.json", "signature for another version rejected"),
        ("otherkey.json", "signature by another key rejected"),
        ("badsha.json", "sha256 mismatch rejected"),
        ("notexe.json", "non-exe rejected"),
        ("http.json", "plain http rejected"),
        ("badver.json", "bad version rejected"),
        ("garbage.json", "non-JSON manifest rejected"),
        ("missing.json", "missing manifest is an error, not a crash"),
    ] {
        let r = check_and_download_as(&e, &url(name), &pubk, "0.10.0");
        ok(r.is_err() && !e.join("pending.exe").exists(), &format!("{why}: {r:?}"));
    }
    ok(check_and_download_as(&e, "http://example.com/latest.json", &pubk, "0.10.0").is_err(), "http manifest rejected");

    // install (swap) — simulate the app folder
    let app = fx.join("app");
    fs::create_dir_all(&app).unwrap();
    let exe = app.join("WidgetBoard.exe");
    fs::write(&exe, b"MZ old version").unwrap();
    ok(apply_pending_as(&d, &exe, &pubk, "0.10.0") == Ok(Some("0.11.0".into())), "apply swaps");
    ok(fs::read(&exe).unwrap() == fs::read(fx.join("WidgetBoard.exe")).unwrap(), "exe is now the new version");
    ok(fs::read(app.join("WidgetBoard.exe.old")).unwrap() == b"MZ old version", "old version kept as .old");
    ok(!d.join("pending.exe").exists() && !d.join("pending.json").exists(), "pending cleared after install");
    cleanup_old(&exe);
    ok(!app.join("WidgetBoard.exe.old").exists(), ".old removed on cleanup");
    ok(apply_pending_as(&d, &exe, &pubk, "0.11.0") == Ok(None), "nothing pending → no-op");

    // tampered pending file is never installed
    check_and_download_as(&d, &url("good.json"), &pubk, "0.10.0").unwrap();
    let mut b = fs::read(d.join("pending.exe")).unwrap();
    b[100] ^= 1;
    fs::write(d.join("pending.exe"), b).unwrap();
    fs::write(&exe, b"MZ current").unwrap();
    let r = apply_pending_as(&d, &exe, &pubk, "0.10.0");
    ok(r.is_err() && fs::read(&exe).unwrap() == b"MZ current", &format!("tampered pending refused, exe untouched: {r:?}"));
    ok(!d.join("pending.exe").exists(), "tampered pending discarded");

    // already-installed pending is tidied, not reinstalled
    check_and_download_as(&d, &url("good.json"), &pubk, "0.10.0").unwrap();
    ok(apply_pending_as(&d, &exe, &pubk, "0.11.0") == Ok(None) && !d.join("pending.json").exists(), "stale pending tidied");

    // status helpers
    record(&d, 12345, &Ok(Some("0.11.0".into())));
    ok(last_check(&d) == 12345 && state(&d)["last_found"] == "0.11.0", "state.json round-trip");
    record(&d, 12346, &Err("HTTP 404".into()));
    ok(state(&d)["last_error"] == "HTTP 404", "errors recorded");

    println!("\n{pass} passed, {fail} failed");
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
