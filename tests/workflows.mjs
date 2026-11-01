import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('CI workflow declares push and pull request triggers', () => {
  assert.match(ci, /^on:\r?\n  push:\r?\n  pull_request:\r?\n/m);
});

test('CI workflow grants read-only repository permissions', () => {
  assert.match(ci, /^permissions:\r?\n  contents: read\r?\n/m);
  assert.doesNotMatch(ci, /^  (?:contents|id-token|attestations):\s*write\s*$/m);
});

test('CI workflow runs the complete Windows test and NSIS diagnostic gate', () => {
  for (const command of [
    'npm ci',
    'npx playwright install chromium',
    'npm test',
    'cargo test --locked --manifest-path src-tauri/Cargo.toml',
    'npx tauri build --bundles nsis --no-sign',
  ]) assert.ok(ci.includes(command), `CI is missing ${command}`);
  assert.match(ci, /name:\s*unsigned-nsis-diagnostic/);
  assert.match(ci, /src-tauri\/target\/release\/bundle\/nsis\/\*setup\.exe/);
});

test('release workflow triggers on version tags and validates before protected approval', () => {
  assert.match(release, /^on:\r?\n  push:\r?\n    tags:\r?\n      - ['"]?v\*['"]?\r?\n/m);
  const validationJob = release.slice(release.indexOf('  validate:'), release.indexOf('  release:'));
  const releaseJob = release.slice(release.indexOf('  release:'));
  assert.doesNotMatch(validationJob, /^\s+(?:contents|id-token|attestations):\s*write\s*$/m);
  assert.doesNotMatch(validationJob, /environment:\s*release/);
  assert.match(validationJob, /tools\/release\/validate\.mjs/);
  assert.match(validationJob, /--tag \$env:RELEASE_TAG --sha \$env:RELEASE_SHA --notes RELEASE_NOTES\.md/);
  assert.match(releaseJob, /environment:\s*release/);
});

test('release workflow limits write permissions to the protected job', () => {
  const releaseJob = release.slice(release.indexOf('  release:'));
  assert.match(release, /^permissions:\r?\n  contents: read\r?\n/m);
  assert.match(releaseJob, /permissions:\r?\n      contents: write\r?\n      id-token: write\r?\n      attestations: write/);
  assert.doesNotMatch(release.slice(0, release.indexOf('  release:')), /^\s+(?:contents|id-token|attestations):\s*write\s*$/m);
});

test('release workflow fails closed on absent signing inputs and never requests unsigned output', () => {
  for (const value of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'WIDGETBOARD_AUTHENTICODE_ADAPTER', 'WIDGETBOARD_AUTHENTICODE_SUBJECT']) {
    assert.ok(release.includes(value), `Release workflow does not check ${value}`);
  }
  assert.match(release, /Test-Path[^\n]+WIDGETBOARD_AUTHENTICODE_ADAPTER/);
  assert.ok(release.indexOf('Check protected signing inputs') < release.indexOf('Build signed NSIS release'));
  assert.doesNotMatch(release, /tauri build[^\n]*--no-sign/i);
});

test('release workflow attests, uploads, verifies, publishes, and re-verifies named installer assets', () => {
  assert.match(release, /actions\/attest-build-provenance@/);
  assert.match(release, /draft/);
  assert.match(release, /gh release create \$env:RELEASE_TAG --verify-tag --draft/);
  assert.match(release, /gh release upload \$env:RELEASE_TAG @assetPaths/);
  assert.match(release, /gh release download/);
  assert.match(release, /tools\/release\/verify\.ps1/);
  assert.match(release, /gh release edit[^\n]+--draft=false/);
  const expectedAssets = [
    'WidgetBoard-$($env:RELEASE_VERSION)-setup-x86_64.exe',
    'WidgetBoard-$($env:RELEASE_VERSION)-setup-x86_64.exe.sig',
    'latest-installer.json',
    'release-metadata.json',
    'SHA256SUMS.txt',
  ];
  for (const asset of expectedAssets) assert.ok(release.includes(asset), `Release workflow does not name ${asset}`);
  assert.match(release, /Compare-Object \$expected \$actual/);
  assert.doesNotMatch(release, /git\s+tag\b|gh\s+release\s+create\b(?![^\n]*--verify-tag)/i);
});

