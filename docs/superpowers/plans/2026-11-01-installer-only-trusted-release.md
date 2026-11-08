# Installer-Only Trusted Windows Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship WidgetBoard as one per-user NSIS application with Tauri-managed updates and a fail-closed Authenticode release path.

**Architecture:** The existing Settings UI keeps its four update commands. Rust replaces the portable EXE swap with `tauri-plugin-updater`. Tauri builds and signs the inner application before NSIS packaging. The release tools verify final bytes and assemble one installer feed.

**Tech Stack:** Rust 1.98.1, Tauri 2.11, `tauri-plugin-updater` 2.11.0, `@tauri-apps/cli` 2.11.4, Node 24.15.0, PowerShell, GitHub Actions, NSIS

**Spec:** `docs/superpowers/specs/2026-11-01-provider-independent-trusted-release-design.md`

## Global Constraints

- Ship Windows x86-64 only.
- Ship one per-user NSIS installer.
- Publish no new portable artifact.
- Use `tauri-plugin-updater = "=2.11.0"`.
- Use `@tauri-apps/cli = "2.11.4"`.
- Use the endpoint `https://github.com/104-bookwyrm/WidgetBoard/releases/latest/download/latest-installer.json`.
- Use NSIS `currentUser` mode and updater `passive` mode.
- Preserve `app.widgetboard.desktop` and its existing `%APPDATA%` data.
- Preserve the existing update UI command and response shape.
- End the old portable feed. The three known users migrate by installing once.
- Run Authenticode through Tauri `signCommand` before updater signatures are made.
- Store updater signing secrets only in the protected GitHub `release` environment.
- Keep provider IDs and API shapes outside application code.
- Do not edit `README.md`, `AI_THEME_PROMPT.md`, or `ui/ai-theme-prompt.md`.
- Do not delete the ignored local `release.cmd` without separate owner approval.

## External Prerequisites

These are release prerequisites. They do not block pure unit work.

1. The owner generates one Tauri updater key pair with the pinned CLI.
2. Only the Tauri public key enters `tauri.conf.json`.
3. The private key and password enter the protected GitHub `release` environment.
4. An Authenticode provider installs an adapter that accepts `sign <absolute PE path>`.
5. The protected environment defines the expected publisher subject.

## Review Focus

- A user edits a widget during update download. The second flush must preserve that edit before Tauri exits.
- A portable autostart entry is disabled in Task Manager. Migration must change its path without enabling it.
- Authenticode mutates an installer. The Tauri updater signature and checksum must cover the mutated bytes.
- A failed or canceled installer leaves the previous installed application and user data intact.
- An old portable client checks its retired feed. The installed release must never serve it a Tauri manifest under the old filename.

---

### Task 1: Pin tools and enforce the tag contract

**Files:**
- Create: `.node-version`
- Create: `rust-toolchain.toml`
- Create: `RELEASE_NOTES.md`
- Create: `tools/release/lib.mjs`
- Create: `tools/release/validate.mjs`
- Create: `tests/release-tools.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Cargo package metadata and Tauri JSON configuration.
- Produces: `readProjectVersions(root) -> { cargo, tauri, cargoLock }`.
- Produces: `validateRelease({ root, tag, sha, notesPath, git }) -> ReleaseContext`.
- Produces: package scripts `test:release` and `tauri`.

- [ ] **Step 1: Write release-tool tests**

Add Node tests named:

```text
accepts matching vX.Y.Z tag and versions
rejects malformed or prerelease tags
rejects Cargo and Tauri version mismatch
rejects Cargo.lock package mismatch
rejects tag target mismatch
rejects commit outside origin/main
rejects empty release notes
rejects tracked and untracked source changes
```

Use temporary fixture repositories. Keep Git calls behind the injected `git` interface.

- [ ] **Step 2: Run the release tests and prove the tool is absent**

Run: `node --test tests/release-tools.mjs`

Expected: FAIL because `tools/release/lib.mjs` does not exist.

- [ ] **Step 3: Implement the release validation library and CLI**

`validate.mjs` accepts `--tag`, `--sha`, and `--notes`. It prints one JSON `ReleaseContext` on success. It exits non-zero on every failed condition.

The clean-tree check includes untracked files. It ignores declared build outputs only.

- [ ] **Step 4: Pin Node, Rust, and Tauri CLI**

Set `.node-version` to `24.15.0`. Set `rust-toolchain.toml` to `1.98.1`. Add exact `@tauri-apps/cli` version `2.11.4` to `devDependencies`.

Add `test:release` to `npm test`. Add `tauri` as `tauri`.

- [ ] **Step 5: Run the task gates**

Run:

```powershell
npm ci
npm run test:release
npx tauri --version
```

Expected: tests pass and Tauri CLI reports `2.11.4`.

- [ ] **Step 6: Commit**

```powershell
git add .node-version rust-toolchain.toml RELEASE_NOTES.md tools/release/lib.mjs tools/release/validate.mjs tests/release-tools.mjs package.json package-lock.json
git commit -m "build: enforce release source contract"
```

---

### Task 2: Replace the portable updater with Tauri updater

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/updater.rs`
- Modify: `ui/mock-tauri.js`
- Modify: `tests/mock.mjs`
- Delete: `src-tauri/updater.pub`
- Delete: `tools/updater-test/Cargo.toml`
- Delete: `tools/updater-test/Cargo.lock`
- Delete: `tools/updater-test/run.sh`
- Delete: `tools/updater-test/src/main.rs`

**Interfaces:**
- Consumes: Tauri updater endpoint and committed Tauri public key.
- Produces: unchanged commands `update_status`, `update_check`, `update_install`, and `update_skip`.
- Produces: unchanged status fields `current`, `check`, `configured`, `lastCheck`, `lastError`, `available`, and `busy`.
- Produces: `updater::Offer { version: String, notes: String }`.
- Produces: `mark_installing(dir: &Path, version: &str) -> Result<(), String>`.
- Produces: `InstallOutcome::{None, Completed(String), Incomplete(String)}`.
- Produces: `take_install_outcome(dir: &Path) -> InstallOutcome`.
- Produces: `discard_legacy_pending(dir: &Path)`.
- Produces: `record_closed(state: &AppState) -> Result<(), String>`.

- [ ] **Step 1: Move portable state tests into Rust unit tests**

Add tests in `updater.rs` for:

```text
daily and weekly schedule decisions
numeric version ordering
offer record and skip behavior
matching installing marker completes once
wrong-version marker reports incomplete once
invalid marker reports incomplete once
legacy pending.exe and pending.json are discarded
```

Remove signature and EXE-swap cases from the old host harness.

- [ ] **Step 2: Add browser assertions for the preserved UI contract**

Extend `tests/mock.mjs` to prove an offered update renders its notes. Prove Skip hides that version. Prove Install invokes `update_install`.

- [ ] **Step 3: Run focused tests and capture the expected failures**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml updater
node tests/mock.mjs
```

Expected: new Rust helpers are missing. The existing browser mock test may pass until its new assertions are added.

- [ ] **Step 4: Add the updater plugin and retire custom cryptography**

Add exact `tauri-plugin-updater = "=2.11.0"`. Remove `ed25519-dalek`. Keep `sha2` because backup verification uses it. Keep the Windows Web HTTP features because iCal fetching uses `updater::fetch`.

Register `tauri_plugin_updater::Builder::new().build()` in `main.rs`. Import `tauri_plugin_updater::UpdaterExt`.

- [ ] **Step 5: Reduce `updater.rs` to scheduling, state, and bounded HTTPS**

Keep `CURRENT`, version helpers, schedule helpers, `fetch`, and the small state file helpers. Replace the custom manifest with `Offer`.

Delete custom public-key verification. Delete pending download logic. Delete EXE swap logic and the writability probe.

- [ ] **Step 6: Convert update checks to the plugin**

Make `run_update_check(app: &AppHandle, manual: bool)` async. Call `app.updater()?.check().await`. Store `Update.version` and `Update.body` as an `Offer`.

Keep the existing events and tray refresh. Keep the current daily or weekly schedule.

- [ ] **Step 7: Convert update installation to the plugin**

Implement this order inside `update_install`:

```text
claim update_busy
-> recheck through Tauri
-> flush boards in spawn_blocking
-> make pre-update backup in spawn_blocking
-> download and verify through Tauri
-> flush boards again
-> write updates/installing.json
-> record data/closed.json
-> call Update::install(bytes)
```

On Windows the last call launches NSIS and exits. On a returned error remove the marker. Then reset busy and emit `update-failed`.

- [ ] **Step 8: Remove portable restart code from startup**

Delete `wait_for_parent`, `restart_for_update`, and `install_pending_update`. Keep `relaunch` for backup restore.

At startup call `discard_legacy_pending`. Then call `take_install_outcome` after the update directory exists. A completed version populates `AppState.just_updated`. An incomplete version records `install_incomplete` once. Every consumed marker is removed.

Factor the normal shutdown timestamp into `record_closed`. Call it from normal exit and before updater installation.

- [ ] **Step 9: Configure the Tauri updater**

Add the approved public key and the `latest-installer.json` endpoint. Configure Windows updater mode as `passive`.

Do not expose updater plugin permissions to web content. The frontend continues through Rust commands.

- [ ] **Step 10: Run updater and UI tests**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml
node tests/mock.mjs
npm test
```

Expected: all pass.

- [ ] **Step 11: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/src/main.rs src-tauri/src/updater.rs ui/mock-tauri.js tests/mock.mjs
git add -u src-tauri/updater.pub tools/updater-test
git commit -m "feat: use Tauri installer updates"
```

---

### Task 3: Migrate autostart ownership and configure NSIS

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/windows/hooks.nsh`

**Interfaces:**
- Consumes: existing HKCU Run value named `WidgetBoard`.
- Produces: `normalized_autostart_target(raw: &str) -> PathBuf`.
- Produces: `should_repair_autostart(existing: Option<&str>, current: &Path) -> bool`.
- Produces: `write_autostart_target() -> Result<(), String>`.
- Produces: one NSIS pre-uninstall hook.

- [ ] **Step 1: Write pure autostart decision tests**

Add cases for a missing entry and matching path. Add cases for a quoted portable path and case differences. Add one case for an installed path with spaces.

Assert that a missing entry stays absent. Assert that a different existing target is repaired.

- [ ] **Step 2: Run the focused Rust tests**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml autostart`

Expected: FAIL because the pure helpers do not exist.

- [ ] **Step 3: Separate registry path repair from user enablement**

`write_autostart_target` writes the current executable. It does not touch `StartupApproved`.

`set_autostart(true)` calls that helper and clears a disabled flag because the user chose Enable.

`repair_autostart` repoints any existing production entry whose normalized target differs. It preserves Task Manager's disabled state. It leaves a missing entry absent.

- [ ] **Step 4: Add the NSIS uninstall hook**

The hook removes the Run value and its StartupApproved value only when the Run target equals `$INSTDIR\${MAINBINARYNAME}.exe`.

Configure `bundle.windows.nsis.installMode` as `currentUser`. Configure `installerHooks` as `./windows/hooks.nsh`.

- [ ] **Step 5: Build an unsigned NSIS probe**

Run:

```powershell
npx tauri build --bundles nsis --no-sign
```

Expected: one setup EXE under `src-tauri/target/release/bundle/nsis`.

Inspect its generated uninstall behavior in a disposable current-user installation. Confirm the default path is below LocalAppData.

- [ ] **Step 6: Run tests and commit**

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/main.rs src-tauri/tauri.conf.json src-tauri/windows/hooks.nsh
git commit -m "fix: migrate installed autostart ownership"
```

---

### Task 4: Add the Authenticode boundary and final artifact assembly

**Files:**
- Create: `src-tauri/tauri.release.conf.json`
- Create: `tools/release/authenticode.mjs`
- Create: `tools/release/assemble.mjs`
- Create: `tools/release/verify.ps1`
- Create: `tests/fixtures/fake-authenticode-adapter.mjs`
- Modify: `tests/release-tools.mjs`
- Delete: `tools/release.mjs`

**Interfaces:**
- Consumes: `WIDGETBOARD_AUTHENTICODE_ADAPTER` executable path.
- Consumes: `WIDGETBOARD_AUTHENTICODE_SUBJECT` expected certificate subject.
- Produces: signer invocation `adapter sign <absolute PE path>`.
- Produces: JSONL signing evidence under the runner temporary directory.
- Produces: `assembleRelease({ root, context, installer, signature, evidence })`.
- Produces: `dist/release/latest-installer.json`.
- Produces: `dist/release/SHA256SUMS.txt`.
- Produces: `dist/release/release-metadata.json`.

- [ ] **Step 1: Write signer and assembly tests**

Add tests named:

```text
signer invokes one configured adapter with an absolute path
signer rejects missing adapter
signer rejects nonzero adapter exit
signer rejects an unchanged unsigned file
assembler requires one installer and matching sig
manifest uses windows-x86_64-nsis
manifest embeds sig file content
manifest preserves Korean UTF-8 notes
checksums cover the final installer and metadata
assembler rejects a filename or version mismatch
```

The fake adapter may support dependency-injected signature inspection only. The production CLI has no flag that bypasses Windows verification.

- [ ] **Step 2: Run release-tool tests and prove the tools are absent**

Run: `npm run test:release`

Expected: FAIL because signer and assembly modules are missing.

- [ ] **Step 3: Probe Tauri `signCommand` once**

Add a temporary recording adapter outside tracked files. Run the release config against an unsigned local build. Record the working directory and every PE path passed by Tauri.

If path resolution fails twice then stop. Report the evidence before changing the boundary.

- [ ] **Step 4: Implement the provider-neutral signer shim**

`authenticode.mjs` accepts the `%1` path from Tauri. It invokes the configured adapter. It then calls PowerShell signature inspection.

Require `Status == Valid`. Require the configured publisher subject. Require a timestamp certificate. Append path and certificate evidence to JSONL.

- [ ] **Step 5: Configure release-only Authenticode signing**

`tauri.release.conf.json` merges `bundle.windows.signCommand`. The command calls `node ../tools/release/authenticode.mjs %1` from the verified working directory.

Keep `signCommand` out of the ordinary Tauri config.

- [ ] **Step 6: Let Tauri create updater artifacts after Authenticode**

Set `bundle.createUpdaterArtifacts` to `true` in `tauri.release.conf.json`. Keep it out of the base config so unsigned CI builds do not require the private updater key. Tauri must emit the final NSIS setup EXE and its `.sig` after every Windows signing callback succeeds.

- [ ] **Step 7: Implement assembly and final verification**

Copy the installer without changing its bytes. Rename it to `WidgetBoard-<version>-setup-x86_64.exe`. Copy the signature as the same name plus `.sig`.

Generate `latest-installer.json` with the immutable tag asset URL. Generate release metadata with tag and commit. Include tool versions and signer evidence. Generate SHA-256 checksums last.

`verify.ps1` checks the final Authenticode subject and timestamp. It checks the installer hash against metadata and the checksum file. It also confirms every Tauri signing callback recorded success.

- [ ] **Step 8: Run release-tool tests**

Run: `npm run test:release`

Expected: all pass.

- [ ] **Step 9: Commit**

```powershell
git add src-tauri/tauri.release.conf.json src-tauri/tauri.conf.json tools/release tests/release-tools.mjs tests/fixtures/fake-authenticode-adapter.mjs
git add -u tools/release.mjs
git commit -m "build: add trusted Windows release boundary"
```

---

### Task 5: Add CI and tagged release workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Tasks 1 through 4.
- Produces: PR and push test gate.
- Produces: protected `v*` tag release job.
- Produces: GitHub provenance for the final installer.

- [ ] **Step 1: Add the ordinary CI workflow**

Use read-only permissions. Run on pull requests and pushes.

Run these gates:

```text
npm ci
npx playwright install chromium
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
npx tauri build --bundles nsis --no-sign
```

Upload the unsigned NSIS output only as a CI diagnostic artifact. Label it as unsigned.

- [ ] **Step 2: Add the tagged release workflow**

Trigger on `v*` tags. Validate the tag before the protected environment job.

The release job uses the `release` environment. It receives the Tauri private key and password. It receives the Authenticode adapter path and expected subject.

Run:

```text
the complete test gate
npx tauri build --bundles nsis --config src-tauri/tauri.release.conf.json
final PowerShell verification
release assembly
final verification again
GitHub artifact attestation
draft release creation
draft publication
published asset verification
```

The job fails before publication when the Authenticode adapter is absent. It never falls back to unsigned output.

- [ ] **Step 3: Check workflow syntax and permissions**

Confirm ordinary CI has no write permission. Confirm only the release job has `contents: write`, `id-token: write`, and `attestations: write`.

Confirm the tag is never created by a workflow.

- [ ] **Step 4: Commit**

```powershell
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: add tested Windows release workflow"
```

---

### Task 6: Add compact policy and operator documentation

**Files:**
- Create: `SECURITY.md`
- Create: `SUPPORT.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `RELEASE.md`
- Create: `CLEAN_WINDOWS_CHECKLIST.md`
- Force-add: `docs/superpowers/specs/2026-11-01-provider-independent-trusted-release-design.md`
- Force-add: `docs/superpowers/plans/2026-11-01-installer-only-trusted-release.md`

**Interfaces:**
- Consumes: final commands and artifact names from Tasks 1 through 5.
- Produces: one operator path from tag to verified release.
- Produces: one manual migration path for the three portable users.

- [ ] **Step 1: Write the policy files**

`SECURITY.md` uses GitHub private vulnerability reporting. `SUPPORT.md` directs ordinary reports to GitHub issues and the existing external form.

`THIRD_PARTY_NOTICES.md` lists the shipped MPL, ISC, MIT, and SIL OFL materials already present in the repository.
It remains repository documentation. The published release inventory is the five assets assembled by Task 4.

- [ ] **Step 2: Write the release operator guide**

Document tag creation and release-environment approval. Document updater-key storage and Authenticode adapter setup. Document certificate expiry and key compromise actions.

State that the ignored local `release.cmd` is obsolete. Do not delete it.

- [ ] **Step 3: Write the clean Windows checklist**

Cover Windows 10 and Windows 11 standard-user installation. Cover the Start menu and uninstall entry. Cover data reuse and autostart migration. Cover passive update and relaunch. Cover uninstall data retention and SmartScreen observation.

- [ ] **Step 4: Run the complete local gate**

Run:

```powershell
npm ci
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
npx tauri build --bundles nsis --no-sign
git diff --check
```

Expected: all automated gates pass. The NSIS artifact remains unsigned and must not be called trusted.

- [ ] **Step 5: Run the signed release gate when credentials exist**

Run the tagged release workflow through the protected environment. Verify the Authenticode publisher. Verify the Tauri updater signature. Verify checksums and the GitHub attestation.

Record the Windows 10 and Windows 11 checklist results before public release.

- [ ] **Step 6: Commit**

```powershell
git add SECURITY.md SUPPORT.md THIRD_PARTY_NOTICES.md RELEASE.md CLEAN_WINDOWS_CHECKLIST.md
git add -f docs/superpowers/specs/2026-11-01-provider-independent-trusted-release-design.md docs/superpowers/plans/2026-11-01-installer-only-trusted-release.md
git commit -m "docs: define trusted release operations"
```

---

## Completion Evidence

Implementation is complete only when:

1. All six task commits exist on the isolated branch.
2. `npm test` passes from a clean checkout.
3. `cargo test --locked` passes from a clean checkout.
4. An unsigned NSIS smoke build succeeds and is labeled unsigned.
5. A real Authenticode provider signs every Tauri PE callback.
6. The final NSIS installer has the approved publisher and timestamp.
7. The Tauri updater signature verifies against the committed public key.
8. The final checksums and release metadata match the published bytes.
9. The GitHub provenance subject equals the published installer digest.
10. The manual migration works with one copy of existing WidgetBoard data.
11. The dirty prompt and README edits remain unchanged in the original checkout.
