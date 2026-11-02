# Trusted Windows release handoff

Updated 2026-11-02 KST.

## Current state

- Pull request: <https://github.com/104-bookwyrm/WidgetBoard/pull/1>
- Remote branch: `codex/trusted-windows-release`
- Handoff commit before this document: `c2b71d9c169499ef050fc92d4f1f7e7137dae9a2`
- Worktree: `C:\Users\Home\.codex\worktrees\trusted-windows-release\WidgetBoard`
- Worktree checkout: detached `HEAD`. Push updates with `git push origin HEAD:refs/heads/codex/trusted-windows-release`.
- The original checkout at `G:\hermes-workspace\WidgetBoard\WidgetBoard` contains owner edits. Preserve them. Do not copy the worktree over that checkout.

PR Windows CI passed once at `c2b71d9`. A duplicate run from the second event was still active when this handoff was written. Both runs passed the JavaScript step. Read the PR checks again before merging.

## Approved release channel

WidgetBoard ships one Windows x86-64 edition:

```text
per-user NSIS installer
-> installed application under LocalAppData
-> official Tauri updater
-> passive NSIS updates
```

Do not add a portable release. The three existing portable users install once. Their data remains in `%APPDATA%\app.widgetboard.desktop`.

The release boundary is provider-neutral. Tauri calls an executable adapter through `sign <absolute PE path>`. SignPath can supply that adapter. Another Authenticode provider can supply the same contract. Provider account IDs and API payloads stay outside this repository.

The repository and GitHub identity may remain pseudonymous. Windows displays the subject from the Authenticode certificate. Certificate providers can still require private legal identity verification.

## Implemented work

- The portable executable-swap updater was replaced with `tauri-plugin-updater`.
- The existing update screen and Rust command shape were preserved.
- The installer uses NSIS `currentUser` mode.
- Updates use NSIS `passive` mode.
- Existing app data and the application identifier remain unchanged.
- Portable autostart entries migrate to the installed executable without enabling a disabled entry.
- Backup restore relaunch uses explicit parent coordination.
- Node, Rust, Tauri CLI, and updater dependencies are pinned.
- Release validation rejects bad tags, mismatched versions, dirty source trees, and commits outside `origin/main`.
- The Authenticode adapter records callback evidence for the app, NSIS plugins, temporary uninstaller, and final installer.
- Final assembly verifies Authenticode evidence, the Tauri updater signature, hashes, release metadata, and the five-file asset inventory.
- Ordinary CI runs JavaScript tests, locked Rust tests, and an unsigned NSIS diagnostic build.
- The protected tag workflow signs, verifies, attests, stages a draft, verifies downloaded assets, publishes, and verifies the published download.
- Operator policy and the clean Windows checklist are tracked.

The last CI fix normalizes both recorded and recomputed Windows path identities. This handles DOS short paths such as `RUNNER~1` and their expanded form.

## Verification recorded

- `npm test`: passed on 2026-11-02. The smoke suite reported 370 passed. Workflow tests reported 11 passed. Release-tool tests reported 40 passed.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: 41 passed in the implementation review.
- `npx tauri build --bundles nsis --no-sign`: passed in the implementation review.
- The generated installer was `src-tauri/target/release/bundle/nsis/WidgetBoard_0.16.0_x64-setup.exe`.
- The diagnostic installer was confirmed unsigned. It is not a trusted release artifact.
- GitHub's JavaScript step passed at `c2b71d9` after the Windows path fix.

Re-run current gates before relying on these results. CI status and the repository can change after this handoff.

## Remaining work

### Merge preparation

1. Read the final PR diff.
2. Confirm every required PR check is green.
3. Merge PR 1 into `main`.
4. Use the resulting `origin/main` commit for any release tag. A squash or merge commit changes the tag target.

### One-time release infrastructure

1. Create a protected GitHub environment named `release` with required reviewer approval.
2. Register a dedicated Windows x64 self-hosted runner with labels `self-hosted`, `windows`, `x64`, and `widgetboard-release`.
3. Install GitHub CLI, rustup, Visual Studio Build Tools, the Windows SDK, and the chosen Authenticode adapter on that runner.
4. Store `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as environment secrets.
5. Set `WIDGETBOARD_AUTHENTICODE_ADAPTER` and `WIDGETBOARD_AUTHENTICODE_SUBJECT` as environment variables.
6. Confirm the stored Tauri private key matches the public key committed in `src-tauri/tauri.conf.json`. Possession of that private key was not verified in this session.
7. Enable GitHub artifact attestations.

### First signed release

1. Follow `RELEASE.md` exactly.
2. Update the three version sources and `RELEASE_NOTES.md`.
3. Merge the release inputs to `main` before tagging.
4. Create an annotated `vX.Y.Z` tag on the exact `origin/main` commit.
5. Approve the protected release job after checking its source commit and expected certificate subject.
6. Let the workflow publish the five generated assets. Do not hand-upload replacements.
7. Run every item in `CLEAN_WINDOWS_CHECKLIST.md` on clean Windows 10 and Windows 11 standard-user machines.
8. Migrate each of the three portable users. Keep the old executable until the installed copy has loaded the existing data.

The production Authenticode path has not run. The signed Tauri updater path has not run. No clean-machine install, update, uninstall, migration, or SmartScreen result has been recorded.

## Start of the next session

```powershell
Set-Location C:\Users\Home\.codex\worktrees\trusted-windows-release\WidgetBoard
git status --short --branch
git rev-parse HEAD
git fetch origin main codex/trusted-windows-release
```

Then read:

1. This handoff.
2. `docs/superpowers/specs/2026-11-01-provider-independent-trusted-release-design.md`.
3. `docs/superpowers/plans/2026-11-01-installer-only-trusted-release.md`.
4. `RELEASE.md`.
5. `CLEAN_WINDOWS_CHECKLIST.md`.

Use live Git and PR checks as the source of truth.
