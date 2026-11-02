param(
  [Parameter(Mandatory = $true)][string]$ReleaseDirectory,
  [Parameter(Mandatory = $true)][string]$ExpectedSubject
)
$ErrorActionPreference = 'Stop'
function ConvertTo-NormalizedPathIdentity([string]$Value) {
  return [System.IO.Path]::GetFullPath($Value).Replace('\', '/').ToLowerInvariant()
}
$release = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$scriptRepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.'))
$repositoryRoot = $scriptRepositoryRoot
$metadataPath = Join-Path $release 'release-metadata.json'
$manifestPath = Join-Path $release 'latest-installer.json'
$checksumsPath = Join-Path $release 'SHA256SUMS.txt'
foreach ($required in @($metadataPath, $manifestPath, $checksumsPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing release file: $required" }
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$metadata.tag -cne "v$($metadata.version)") { throw 'Release tag and version do not match' }
if ([string]$metadata.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Release version is not canonical X.Y.Z' }
if ([string]$metadata.commit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Release commit must be a full 40-character SHA' }
$canonicalInstaller = "WidgetBoard-$($metadata.version)-setup-x86_64.exe"
if ([string]$metadata.installer -cne $canonicalInstaller) { throw 'Installer basename is not canonical for the release version' }
$canonicalSignature = "$canonicalInstaller.sig"
if ([string]$metadata.signature -cne $canonicalSignature) { throw 'Signature basename does not match the canonical installer basename' }
$expectedNames = @($canonicalInstaller, $canonicalSignature, 'latest-installer.json', 'release-metadata.json', 'SHA256SUMS.txt')
$actualNames = @(Get-ChildItem -LiteralPath $release -Force | ForEach-Object { $_.Name })
if ($actualNames.Count -ne $expectedNames.Count -or @($actualNames | Where-Object { $_ -notin $expectedNames }).Count -ne 0) { throw 'Release directory contains missing or extra artifacts' }
$installer = Join-Path $release $canonicalInstaller
$signaturePath = Join-Path $release $canonicalSignature
$signatureBytes = [System.IO.File]::ReadAllBytes($signaturePath)
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$manifest.version -cne [string]$metadata.version) { throw 'Manifest version does not match release metadata' }
$platformName = 'windows-x86_64-nsis'
$platform = $manifest.platforms.$platformName
if (-not $platform) { throw 'Manifest has no windows-x86_64-nsis platform entry' }
$expectedUrl = "https://github.com/104-bookwyrm/WidgetBoard/releases/download/$($metadata.tag)/$canonicalInstaller"
if ([string]$platform.url -cne $expectedUrl -or [string]$metadata.manifestUrl -cne $expectedUrl) { throw 'Manifest URL is not the immutable URL for this tag and installer' }
$manifestSignatureBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$platform.signature)
if ([Convert]::ToBase64String($manifestSignatureBytes) -cne [Convert]::ToBase64String($signatureBytes)) { throw 'Manifest signature bytes do not match the .sig file' }
$checksumLines = @(Get-Content -LiteralPath $checksumsPath -Encoding ASCII)
if ($checksumLines.Count -ne 4) { throw 'Checksum file must contain exactly four targets' }
$sumEntries = @{}
foreach ($line in $checksumLines) {
  if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Invalid checksum line: $line" }
  if ($sumEntries.ContainsKey($Matches[2])) { throw "Duplicate checksum target: $($Matches[2])" }
  $sumEntries[$Matches[2]] = $Matches[1].ToLowerInvariant()
}
$expectedTargets = @($canonicalInstaller, $canonicalSignature, 'latest-installer.json', 'release-metadata.json')
if ($sumEntries.Count -ne 4 -or @($sumEntries.Keys | Where-Object { $_ -notin $expectedTargets }).Count -ne 0) { throw 'Checksum file contains missing or extra targets' }
foreach ($name in $expectedTargets) {
  if (-not $sumEntries.ContainsKey($name)) { throw "Checksum file omits $name" }
  $path = Join-Path $release $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Checksum target is missing: $name" }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sumEntries[$name]) { throw "SHA-256 mismatch for $name" }
}
$installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installerHash -ne [string]$metadata.installerSha256) { throw 'Installer SHA-256 does not match release metadata' }
$sourceInstaller = Join-Path $repositoryRoot "src-tauri\target\release\bundle\nsis\WidgetBoard_$($metadata.version)_x64-setup.exe"
if ((ConvertTo-NormalizedPathIdentity ([string]$metadata.installerSourcePath)) -cne (ConvertTo-NormalizedPathIdentity $sourceInstaller)) { throw 'Metadata source installer path is not canonical' }
if (-not (Test-Path -LiteralPath $sourceInstaller -PathType Leaf)) { throw 'The Tauri source installer required for callback verification is missing' }
$sourceHash = (Get-FileHash -LiteralPath $sourceInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHash -ne $installerHash) { throw 'Final installer bytes differ from the Tauri source installer' }
$tauriConfig = Get-Content -LiteralPath (Join-Path $repositoryRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$verifierManifest = Join-Path $PSScriptRoot 'minisign-verifier\Cargo.toml'
$verifierTarget = Join-Path $scriptRepositoryRoot 'src-tauri\target\release-tools-minisign'
& cargo run --quiet --locked --manifest-path $verifierManifest --target-dir $verifierTarget -- $tauriConfig.plugins.updater.pubkey $signaturePath $installer
if ($LASTEXITCODE -ne 0) { throw 'Tauri updater signature verification failed for the final installer' }
$expectedRoles = @(
  'application',
  'nsis-plugin:nsisdl.dll',
  'nsis-plugin:startmenu.dll',
  'nsis-plugin:system.dll',
  'nsis-plugin:nsdialogs.dll',
  'nsis-plugin:additional/nsis_tauri_utils.dll',
  'nsis-uninstaller',
  'final-installer'
)
$metadataRoles = @($metadata.expectedCallbackRoles | ForEach-Object { [string]$_ })
if ($metadataRoles.Count -ne $expectedRoles.Count -or @($expectedRoles | Where-Object { $_ -notin $metadataRoles }).Count -ne 0) { throw 'Metadata does not declare the complete Tauri callback role set' }
$expectedCallbacks = @{}
$targetRoot = Join-Path $repositoryRoot 'src-tauri\target\release'
$expectedCallbacks['application'] = Join-Path $targetRoot 'widgetboard.exe'
$pluginRoot = Join-Path $targetRoot 'nsis\x64\Plugins\x86-unicode'
$expectedCallbacks['nsis-plugin:nsisdl.dll'] = Join-Path $pluginRoot 'NSISdl.dll'
$expectedCallbacks['nsis-plugin:startmenu.dll'] = Join-Path $pluginRoot 'StartMenu.dll'
$expectedCallbacks['nsis-plugin:system.dll'] = Join-Path $pluginRoot 'System.dll'
$expectedCallbacks['nsis-plugin:nsdialogs.dll'] = Join-Path $pluginRoot 'nsDialogs.dll'
$expectedCallbacks['nsis-plugin:additional/nsis_tauri_utils.dll'] = Join-Path $pluginRoot 'additional\nsis_tauri_utils.dll'
$expectedCallbacks['final-installer'] = $sourceInstaller
$evidenceDirectory = [System.IO.Path]::GetFullPath([string]$metadata.signerEvidenceDirectory)
if (-not $metadata.signerEvidenceDirectory -or -not [System.IO.Path]::IsPathRooted($evidenceDirectory)) { throw 'Signer evidence directory must be an absolute path' }
$preservedUninstaller = Join-Path (Join-Path $evidenceDirectory 'widgetboard-authenticode-evidence') 'nsis-uninstaller.exe'
$evidence = @($metadata.signerEvidence)
if ($evidence.Count -ne $expectedRoles.Count) { throw 'Release metadata has missing or extra Authenticode callback evidence' }
$seenRoles = @{}
$seenIdentities = @{}
foreach ($entry in $evidence) {
  $role = [string]$entry.callbackRole
  if ($role -notin $expectedRoles) { throw "Unexpected callback role: $role" }
  if ($seenRoles.ContainsKey($role)) { throw "Duplicate callback role: $role" }
  if ([string]$entry.status -cne 'success' -or [string]$entry.authenticodeStatus -cne 'Valid') { throw "Unsuccessful callback evidence: $role" }
  if ([string]$entry.path -notmatch '^[A-Za-z]:\\') { throw "Callback path must be absolute: $role" }
  $identity = ConvertTo-NormalizedPathIdentity ([string]$entry.path)
  if ((ConvertTo-NormalizedPathIdentity ([string]$entry.identity)) -cne $identity) { throw "Callback identity is not the normalized full path: $role" }
  if ($seenIdentities.ContainsKey($identity)) { throw "Duplicate callback identity: $identity" }
  if ([string]$entry.sha256Before -notmatch '^[0-9a-fA-F]{64}$' -or [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Callback evidence lacks required SHA-256 digests: $role" }
  if (-not [string]$entry.subject -or -not [string]$entry.timestampSubject -or -not [string]$entry.timestampThumbprint) { throw "Callback evidence lacks publisher or timestamp data: $role" }
  if ($role -eq 'nsis-uninstaller') {
    if ([System.IO.Path]::GetFileName([string]$entry.path) -notmatch '^nst.*\.tmp$') { throw 'NSIS uninstaller callback must identify an nst*.tmp input' }
    if ((ConvertTo-NormalizedPathIdentity ([string]$entry.preservedPath)) -cne (ConvertTo-NormalizedPathIdentity $preservedUninstaller)) { throw 'Preserved NSIS uninstaller path is not canonical' }
    if ([string]$entry.preservedSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Preserved NSIS uninstaller SHA-256 is required' }
    if (-not (Test-Path -LiteralPath $preservedUninstaller -PathType Leaf)) { throw 'Preserved NSIS uninstaller bytes are missing' }
    $callbackHash = (Get-FileHash -LiteralPath $preservedUninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($callbackHash -ne [string]$entry.sha256 -or $callbackHash -ne [string]$entry.preservedSha256) { throw 'Preserved NSIS uninstaller SHA-256 mismatch' }
    $uninstallerSignature = Get-AuthenticodeSignature -LiteralPath $preservedUninstaller
    if ([string]$uninstallerSignature.Status -ne 'Valid') { throw 'Preserved NSIS uninstaller Authenticode Status must be Valid' }
    if ([string]$uninstallerSignature.SignerCertificate.Subject -cne $ExpectedSubject) { throw 'Preserved NSIS uninstaller subject mismatch' }
    if (-not $uninstallerSignature.TimeStamperCertificate -or -not $uninstallerSignature.TimeStamperCertificate.Subject) { throw 'Preserved NSIS uninstaller has no timestamp certificate' }
  } else {
    if ((ConvertTo-NormalizedPathIdentity ([string]$entry.path)) -cne (ConvertTo-NormalizedPathIdentity ([string]$expectedCallbacks[$role]))) { throw "Callback path mismatch: $role" }
    if (-not (Test-Path -LiteralPath ([string]$entry.path) -PathType Leaf)) { throw "Callback source file is missing: $role" }
    $callbackHash = (Get-FileHash -LiteralPath ([string]$entry.path) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($callbackHash -ne [string]$entry.sha256) { throw "Callback SHA-256 does not match current bytes: $role" }
  }
  if ($role -eq 'final-installer') {
    if ((ConvertTo-NormalizedPathIdentity ([string]$entry.path)) -cne (ConvertTo-NormalizedPathIdentity ([string]$metadata.installerSourcePath))) { throw 'Final installer evidence path does not match the full normalized source path' }
    if ($callbackHash -ne $installerHash) { throw 'Final installer callback digest differs from assembled installer' }
  }
  $seenRoles[$role] = $true
  $seenIdentities[$identity] = $true
}
foreach ($role in $expectedRoles) { if (-not $seenRoles.ContainsKey($role)) { throw "Missing Tauri signing callback identity: $role" } }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ([string]$signature.Status -ne 'Valid') { throw "Final Authenticode Status must be Valid. Received: $($signature.Status)" }
if ([string]$signature.SignerCertificate.Subject -cne $ExpectedSubject) { throw "Final Authenticode subject mismatch: $($signature.SignerCertificate.Subject)" }
if (-not $signature.TimeStamperCertificate -or -not $signature.TimeStamperCertificate.Subject) { throw 'Final installer has no timestamp certificate' }
foreach ($entry in $evidence) {
  if ([string]$entry.subject -cne $ExpectedSubject) { throw "Callback publisher subject mismatch: $($entry.callbackRole)" }
}
Write-Output "Verified $($metadata.tag) installer $($metadata.installer)"
