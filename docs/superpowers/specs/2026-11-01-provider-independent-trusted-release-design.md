# WidgetBoard Trusted Windows Release Design

**Status:** Approved on 2026-11-01
**Repository state inspected:** `master` at `a435550`
**Target:** Windows 10 and Windows 11 on x86-64

## Intent

WidgetBoard will ship as one installed Windows application. New users download a per-user NSIS installer. Future updates use Tauri's updater plugin and the same installer format.

This work exists to add Windows Authenticode trust and standard release discipline. WidgetBoard has three known users. The release system should match that scale.

## User experience

First installation follows this path:

```text
download Setup.exe
-> run the installer
-> WidgetBoard installs for the current user
-> launch from the Start menu
```

Future updates follow this path:

```text
WidgetBoard reports an update
-> the user approves it
-> Tauri downloads and verifies the NSIS update
-> WidgetBoard exits
-> the installer updates the application
-> WidgetBoard opens again
```

The installer uses Tauri's `currentUser` mode. It installs below `%LOCALAPPDATA%` and requires no administrator elevation.

User data remains below `%APPDATA%\app.widgetboard.desktop`. Installation and updates must preserve it.

## Approved decisions

1. Ship one installed edition.
2. Stop publishing a portable edition.
3. Use the official Tauri updater plugin.
4. Use a per-user NSIS installer.
5. Preserve the existing application identifier and data path.
6. Move the three known users through a manual one-time installation.
7. Keep the release process small and provider-independent.
8. Use Authenticode for Windows publisher trust.
9. Use Tauri's updater signature for update authenticity.
10. Preserve the current WidgetBoard update screen where practical.

## Current state

The current application is an installer-free executable. It stores data in `%APPDATA%`. Moving the executable does not move its data.

The current updater downloads a raw executable. It verifies a custom Ed25519 manifest. It swaps the executable during restart.

`src-tauri/tauri.conf.json` already declares an NSIS bundle target. The current release script runs plain Cargo and never builds that target.

The existing custom update key remains valid only for the old portable releases. The installed application starts a new Tauri updater trust root.

## Scope

### Application changes

- Add `tauri-plugin-updater`.
- Configure `latest-installer.json` as the static GitHub Releases update endpoint.
- Configure one Tauri updater public key.
- Route the existing update UI through the plugin.
- Use passive NSIS updates.
- Remove the portable executable swap path from installed builds.
- Preserve the pre-update data backup.
- Fix autostart migration from an old portable path.

### Installer changes

- Build one x86-64 NSIS installer.
- Use `currentUser` install mode.
- Install below `%LOCALAPPDATA%`.
- Create normal Start menu and uninstall entries.
- Preserve `%APPDATA%` data on upgrade.
- Tauri's generated `Delete app data` checkbox is unchecked by default. Leave it unchecked to retain user data. Checking the box authorizes data deletion.

### Release changes

- Build releases from an exact `vX.Y.Z` tag.
- Require Cargo and Tauri versions to equal the tag.
- Run the existing browser tests.
- Run Rust tests with the lockfile.
- Build the NSIS installer with the pinned Tauri CLI.
- Authenticode-sign the application and installer through a replaceable signing adapter.
- Verify the final Authenticode publisher and timestamp.
- Generate the Tauri update signature after Authenticode signing.
- Generate SHA-256 checksums from final bytes.
- Record the tag and commit in release metadata.
- Create GitHub build provenance for the final installer.
- Publish only after every check passes.

### Repository policy

- Add `SECURITY.md` with GitHub private vulnerability reporting.
- Add `SUPPORT.md` with the public support route.
- Add a compact third-party notice.
- Add a release operator guide.
- Add a clean Windows test checklist.

## Signing order

The required order is:

```text
build application
-> Authenticode-sign application
-> package signed application into NSIS
-> Authenticode-sign NSIS installer
-> verify Authenticode
-> create Tauri updater signature
-> calculate SHA-256
-> attest final installer digest
-> publish
```

Authenticode changes file bytes. Tauri update signing and SHA-256 calculation therefore occur after Authenticode.

## Signing boundary

The repository defines a small signer contract:

```text
sign(input path, artifact kind) -> signed artifact plus evidence
verify(input path, expected publisher) -> publisher, chain, timestamp, digest
```

The release policy owns the required publisher and verification result. A provider adapter owns account IDs and API calls.

SignPath can implement the contract later. Azure Artifact Signing or a local certificate can implement the same contract.

Release publication fails when no production signer is configured. Ordinary CI never receives signing credentials.

## Tauri updater trust

The installed application uses a Tauri updater key pair. The private key and password live in the protected GitHub `release` environment. Ordinary CI cannot read them.

The operator signs the final Authenticode-signed NSIS installer. The resulting signature is added to the static Tauri update JSON.

The existing portable Ed25519 key is not reused. Its format and release protocol belong to the retired portable updater.

## Release artifacts

Each release contains:

```text
WidgetBoard-<version>-setup-x86_64.exe
WidgetBoard-<version>-setup-x86_64.exe.sig
latest-installer.json
SHA256SUMS.txt
release-metadata.json
```

`THIRD_PARTY_NOTICES.md` is repository documentation and is not a release asset.

`latest-installer.json` uses Tauri's static updater format. It contains one `windows-x86_64-nsis` installer entry.

## Migration for the three existing users

1. Close the old WidgetBoard executable.
2. Run the new NSIS installer once.
3. Launch the installed copy.
4. Confirm that existing widgets and settings appear.
5. Confirm startup repoints an existing old portable autostart entry to the installed path while preserving its Task Manager disabled state.
6. Delete the old executable after confirmation.

No automated portable-to-installer bridge is built.

The old portable feed ends when the installer release becomes latest. An old portable copy can show an update-check error until its user performs the manual installation. This is an accepted migration cost for three known users.

## Verification

Current automated workflow gates cover:

- exact tag and version agreement
- complete browser test suite
- Rust tests with `--locked`
- unsigned NSIS artifact creation in ordinary CI
- Authenticode callback, publisher, and timestamp verification in a protected release run
- Tauri updater signature verification
- SHA-256 checksums and final artifact inventory
- GitHub provenance for the final installer digest

The signed release workflow has not been run with a production signing provider. Its signing and publication checks remain unverified.

The following require manual clean-machine acceptance on Windows 10 and Windows 11:

- standard-user installation without an administrator prompt
- Start menu and uninstall entries
- launch and update relaunch
- upgrade and data preservation
- uninstall behavior and data-retention checkbox
- portable autostart migration and disabled-state preservation
- SmartScreen observation

No Windows 10 or Windows 11 installation, upgrade, relaunch, uninstall, migration, or SmartScreen acceptance has been recorded. SmartScreen reputation is an observation, not a deterministic CI gate.

## Non-goals

- Portable releases
- Microsoft Store packaging
- Winget publishing
- MSI packaging
- More than x86-64 Windows
- Automated migration for three known users
- A custom update protocol
- A custom installer launcher
- SignPath-specific application code
- Bit-for-bit reproducibility claims
- Automatic data rollback after a failed application launch

## Acceptance criteria

1. One tracked workflow produces the NSIS release candidate from an exact tag.
2. Cargo and Tauri versions must match the tag.
3. Existing browser tests and Rust tests pass before packaging.
4. The installer uses current-user mode without elevation.
5. The installed application uses Tauri's updater plugin.
6. The installed application contains no portable executable swap path.
7. Existing `%APPDATA%` data survives installation and upgrade.
8. Old portable autostart ownership is repaired during migration.
9. The final installer passes Authenticode policy verification.
10. The Tauri updater signature covers the final Authenticode-signed installer.
11. Checksums cover every downloadable executable.
12. Provenance names the final installer digest.
13. Publication rejects missing or extra executable assets.
14. Signing-provider details stay behind the signer contract.
15. Security and support policy files are tracked.
16. The clean Windows checklist is tracked.
17. The three existing dirty prompt-document files remain untouched.
