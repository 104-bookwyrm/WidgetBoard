# Windows release operations

WidgetBoard publishes one per-user x86-64 NSIS installer. The release workflow is `.github/workflows/release.yml`. The ignored local `release.cmd` is obsolete and is not a release path.

## Prepare and tag

1. Start from a clean checkout. Fetch the current source and tags with `git fetch origin main --tags`.
2. Confirm the release commit is on `origin/main`. Confirm `package.json` and `src-tauri/tauri.conf.json` versions agree. Confirm Cargo package and lockfile versions agree. All must match the exact canonical tag `vX.Y.Z`.
3. Update `RELEASE_NOTES.md`. The validator rejects empty notes, source changes, mismatched versions, and a commit outside `origin/main`.
4. Commit the release inputs to `main`, then create and push an annotated version tag:

   ```powershell
   git tag -a vX.Y.Z <full-commit-sha> -m "WidgetBoard vX.Y.Z"
   git push origin vX.Y.Z
   ```

   Replace `vX.Y.Z` and `<full-commit-sha>` with the actual version and 40-character commit. Do not retarget a published version tag.

The tag starts a read-only validation job on `windows-latest`. The protected job runs only after validation.

## GitHub and runner setup

- Create a GitHub environment named `release` and require reviewer approval before its job receives credentials.
- Register a dedicated Windows x64 self-hosted runner with labels `self-hosted`, `windows`, `x64`, and `widgetboard-release`. Keep it dedicated to this repository's release work.
- Install GitHub CLI, rustup, Visual Studio Build Tools with the MSVC target and Windows SDK, and the provider Authenticode adapter. Use Actions runner version 2.329.0 or later. The workflow selects Node 24.15.0 and Rust 1.98.1. Tauri's pinned bundler obtains its verified NSIS 3.11 package; a separate NSIS install is not required.
- Allow outbound access to GitHub, npm, Rust distribution servers, Playwright browser downloads, and the Tauri NSIS package source.
- Enable GitHub artifact attestations.
- Store `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as secrets in the protected `release` environment. Keep the updater private key out of the repository and ordinary CI.
- Set `WIDGETBOARD_AUTHENTICODE_ADAPTER` and `WIDGETBOARD_AUTHENTICODE_SUBJECT` as environment variables in `release`. The adapter must be an executable on the runner and implement `sign <absolute PE path>`. It must sign each Tauri PE callback in place. The verifier checks signed bytes, callback identity, certificate subject, chain status, and timestamp evidence.

Keep the signer replaceable. Provider account details and APIs belong in the runner adapter. The repository and GitHub account can use a pseudonymous identity. Windows displays the publisher subject from the issued code-signing certificate. A certificate provider may require verified legal or personal identity. Do not assume it will issue a certificate to an unverified pseudonym.

Keep third-party Actions pinned to reviewed full commit SHAs. When updating a pin, review the upstream release and commit, update version comments and the workflow pin tests, then run `npm test`.

## Approval and published files

Review the protected `release` job before approving it. The workflow runs JavaScript and locked Rust tests, signs the app and NSIS installer, verifies the updater signature and Authenticode evidence, assembles assets, attests the final installer digest, uploads a draft, verifies downloaded bytes, publishes, then verifies the published download.

The release has exactly five assets:

- `WidgetBoard-<version>-setup-x86_64.exe`
- `WidgetBoard-<version>-setup-x86_64.exe.sig`
- `latest-installer.json`
- `release-metadata.json`
- `SHA256SUMS.txt`

`THIRD_PARTY_NOTICES.md` stays in the repository. It is not a release asset. The unsigned NSIS artifact from ordinary CI is diagnostic only. Label it unsigned and never publish or describe it as trusted.

An empty draft can be reused. If an upload stops after some assets exist, a fresh run may produce different timestamped signing data. The workflow fails on any byte mismatch and never overwrites or deletes existing assets. Inspect the partial draft in GitHub, delete that draft while keeping the tag, then start a fresh workflow run. Do not publish a draft that has not passed downloaded-asset verification.

## Certificate expiry and updater-key compromise

Before the code-signing certificate expires, arrange renewal with the provider. Update the runner adapter or expected subject if the renewed certificate changes them. Build and verify a new release with a valid timestamp. Record the observed publisher and timestamp.

If the Tauri updater private key may be compromised, stop releases and updater publication. Treat the key as unable to be revoked for existing clients. Generate a new updater key pair, update the application public key, and publish a newly Authenticode-signed release through a channel users can verify. Do not resume updates until the new trust root and signed installer have passed the release checks.

## Manual recovery

If signing, assembly, attestation, or verification fails, leave the release unpublished. Read the failed job and draft state. Correct the runner or configuration problem, remove a partial draft as described above, and rerun from the same verified tag only when the produced release bytes can be validated from the start. Do not hand-upload or substitute assets.
