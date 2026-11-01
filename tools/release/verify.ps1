param(
  [Parameter(Mandatory = $true)][string]$ReleaseDirectory,
  [Parameter(Mandatory = $true)][string]$ExpectedSubject
)
$ErrorActionPreference = 'Stop'
$release = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$metadataPath = Join-Path $release 'release-metadata.json'
$manifestPath = Join-Path $release 'latest-installer.json'
$checksumsPath = Join-Path $release 'SHA256SUMS.txt'
foreach ($required in @($metadataPath, $manifestPath, $checksumsPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing release file: $required" }
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$installer = Join-Path $release $metadata.installer
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Missing final installer: $installer" }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ([string]$signature.Status -ne 'Valid') { throw "Final Authenticode Status must be Valid. Received: $($signature.Status)" }
if ([string]$signature.SignerCertificate.Subject -cne $ExpectedSubject) { throw "Final Authenticode subject mismatch: $($signature.SignerCertificate.Subject)" }
if (-not $signature.TimeStamperCertificate -or -not $signature.TimeStamperCertificate.Subject) { throw 'Final installer has no timestamp certificate' }
$installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installerHash -ne [string]$metadata.installerSha256) { throw 'Installer SHA-256 does not match release metadata' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne $metadata.version) { throw 'Manifest version does not match release metadata' }
if (-not $manifest.platforms.'windows-x86_64-nsis') { throw 'Manifest has no windows-x86_64-nsis platform entry' }
$sumEntries = @{}
foreach ($line in Get-Content -LiteralPath $checksumsPath -Encoding ASCII) {
  if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Invalid checksum line: $line" }
  if ($sumEntries.ContainsKey($Matches[2])) { throw "Duplicate checksum entry: $($Matches[2])" }
  $sumEntries[$Matches[2]] = $Matches[1].ToLowerInvariant()
}
foreach ($name in @($metadata.installer, $metadata.signature, 'latest-installer.json', 'release-metadata.json')) {
  if (-not $sumEntries.ContainsKey($name)) { throw "Checksum file omits $name" }
  $path = Join-Path $release $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Checksum target is missing: $name" }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sumEntries[$name]) { throw "SHA-256 mismatch for $name" }
}
$evidence = @($metadata.signerEvidence)
if ($evidence.Count -eq 0) { throw 'Release metadata has no Authenticode callback evidence' }
foreach ($entry in $evidence) {
  if ($entry.status -ne 'success' -or $entry.authenticodeStatus -ne 'Valid' -or $entry.subject -cne $ExpectedSubject -or -not $entry.timestampSubject) {
    throw 'Release metadata contains incomplete or unsuccessful Authenticode callback evidence'
  }
}
$sourceLeaf = Split-Path -Leaf ([string]$metadata.installerSourcePath)
if (-not ($evidence | Where-Object { (Split-Path -Leaf ([string]$_.path)) -eq $sourceLeaf })) { throw 'Callback evidence does not include the final Tauri installer' }
Write-Output "Verified $($metadata.tag) installer $($metadata.installer)"
