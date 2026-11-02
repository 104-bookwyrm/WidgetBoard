# Backup Restore Restart Coordination Report

## Result

Backup restore now starts its replacement process with `--wait-restore-parent <pid>`. Startup parses this restore-only argument and waits for the parent process before initializing Tauri and its single-instance plugin. Ordinary launches and Tauri updater installation do not supply this argument.

The Windows wait is bounded at 15 seconds. If the parent has already exited, startup continues. If the process handle cannot be opened for another reason, or the wait times out or fails, the replacement exits with code 1 before Tauri initializes.

Implementation commit: `5f45250268c37109fe1fd5f1192f0620a506c37d` (`fix: coordinate backup restore restart`).

## Root Cause

At base `ff6f82761351e550fe424fd9f20c31ac7bf4daf3`, `restore_backup` copied the selected backup and called `relaunch`. `relaunch` spawned the current executable without arguments and then called `app.exit(0)`. The new process could initialize `tauri-plugin-single-instance` while the old process still held its mutex.

Commit `a435550` used `--wait-pid <pid>` and waited before `tauri::Builder`. That wait was removed along with portable updater restart coordination. Reusing the generic option would also change updater startup behavior. The fix restores the parent wait under a backup-restore-specific argument.

## Red and Green Evidence

Red command:

```powershell
$env:TEMP=(Resolve-Path test-artifacts/native).Path
$env:TMP=$env:TEMP
cargo test --locked --manifest-path src-tauri/Cargo.toml only_restore_relaunch_arguments_request_parent_coordination
```

Result: expected compile failure because `restore_relaunch_args` and `restore_parent_pid` did not exist.

Focused green command:

```powershell
$env:TEMP=(Resolve-Path test-artifacts/native).Path
$env:TMP=$env:TEMP
cargo test --locked --manifest-path src-tauri/Cargo.toml restore_relaunch
```

Result: 2 passed. The tests prove that restore relaunch arguments contain the current PID, that ordinary launches do not request coordination, and that the retired updater `--wait-pid` argument is ignored.

Full locked Rust suite used the same worktree-local `TEMP` and `TMP`:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Result: 38 passed, 0 failed. `git diff --check` passed. Cargo emitted an incremental compilation warning because hard links were unavailable; it copied cache files instead.

## Runtime Gap

The Windows native wait code compiled as part of the Rust test build. No isolated-identifier single-instance runtime test was added because it would need to initialize Tauri's GUI runtime and plugin. The regression is covered at the argument and startup-coordination boundary.
