import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function namedStep(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step ${name}`);
  const next = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function assertActionsPinned(workflow) {
  const usesLines = workflow.split(/\r?\n/).filter((line) => /^\s*(?:-\s+)?uses:\s*/.test(line));
  assert.ok(usesLines.length > 0);
  for (const line of usesLines) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+/i, `Unpinned third-party action: ${line}`);
}

test('CI triggers on pushes and pull requests with read-only permissions', () => {
  assert.match(ci, /^on:\r?\n  push:\r?\n  pull_request:\r?\n/m);
  assert.match(ci, /^permissions:\r?\n  contents: read\r?\n/m);
  assert.doesNotMatch(ci, /^  (?:contents|id-token|attestations):\s*write\s*$/m);
  assert.match(ci, /runs-on:\s*windows-latest/);
});

test('CI runs the test, pinned toolchain, and unsigned NSIS diagnostic gates', () => {
  for (const command of [
    'npm ci',
    'npx playwright install chromium',
    'npm test',
    'cargo test --locked --manifest-path src-tauri/Cargo.toml',
    'npx tauri build --bundles nsis --no-sign',
    'rustup toolchain install 1.98.1',
  ]) assert.ok(ci.includes(command), `CI is missing ${command}`);
  assert.match(ci, /name:\s*unsigned-nsis-diagnostic/);
  assert.match(ci, /src-tauri\/target\/release\/bundle\/nsis\/\*setup\.exe/);
  assert.doesNotMatch(ci, /choco\s+install\s+nsis|dtolnay\/rust-toolchain/);
});

test('workflow tests run as part of npm test', () => {
  assert.equal(packageJson.scripts['test:workflows'], 'node --test tests/workflows.mjs');
  assert.match(packageJson.scripts.test, /npm run test:workflows/);
});

test('release validates tags before the protected self-hosted runner job', () => {
  assert.match(release, /^on:\r?\n  push:\r?\n    tags:\r?\n      - ['"]?v\*['"]?\r?\n/m);
  const validationJob = release.slice(release.indexOf('  validate:'), release.indexOf('  release:'));
  const releaseJob = release.slice(release.indexOf('  release:'));
  assert.match(validationJob, /runs-on:\s*windows-latest/);
  assert.doesNotMatch(validationJob, /environment:\s*release/);
  assert.match(validationJob, /tools\/release\/validate\.mjs/);
  assert.match(validationJob, /--tag \$env:RELEASE_TAG --sha \$env:RELEASE_SHA --notes RELEASE_NOTES\.md/);
  assert.match(releaseJob, /environment:\s*release/);
  assert.match(releaseJob, /runs-on:\s*\[self-hosted, windows, x64, widgetboard-release\]/);
});

test('only the protected release job has write permissions', () => {
  const releaseJob = release.slice(release.indexOf('  release:'));
  assert.match(release, /^permissions:\r?\n  contents: read\r?\n/m);
  assert.match(releaseJob, /permissions:\r?\n      contents: write\r?\n      id-token: write\r?\n      attestations: write/);
  assert.doesNotMatch(release.slice(0, release.indexOf('  release:')), /^\s+(?:contents|id-token|attestations):\s*write\s*$/m);
});

test('all third-party actions are pinned to full SHAs with version comments', () => {
  assertActionsPinned(`${ci}\n${release}`);
  assert.doesNotMatch(`${ci}\n${release}`, /dtolnay\/rust-toolchain|@master\b/);
});

test('action pin check rejects unpinned shorthand and list-item uses forms', () => {
  assert.throws(() => assertActionsPinned('steps:\n  uses: owner/action@v1'), /Unpinned third-party action/);
  assert.throws(() => assertActionsPinned('steps:\n  - uses: owner/action@v1'), /Unpinned third-party action/);
});

test('signing secrets are scoped to the signed build and checked before Tauri runs', () => {
  const releaseJob = release.slice(release.indexOf('  release:'));
  const jobEnv = releaseJob.slice(releaseJob.indexOf('    env:'), releaseJob.indexOf('    steps:'));
  const buildStep = namedStep(release, 'Build signed NSIS release');
  for (const value of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
    assert.match(buildStep, new RegExp(`${value}: \\$\\{\\{ secrets\\.${value} \\}\\}`));
    assert.doesNotMatch(jobEnv, new RegExp(`\\b${value}\\b`));
  }
  assert.match(buildStep, /foreach \(\$name in @\('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'\)\)/);
  assert.match(buildStep, /IsNullOrWhiteSpace\(\[Environment\]::GetEnvironmentVariable\(\$name\)\)/);
  assert.match(buildStep, /Test-Path[^\n]+WIDGETBOARD_AUTHENTICODE_ADAPTER/);
  assert.doesNotMatch(jobEnv, /\bGH_TOKEN\b/);
  const ghTokenSteps = release.split(/(?=^      - )/m).filter((step) => step.includes('GH_TOKEN:'));
  assert.ok(ghTokenSteps.length > 0);
  for (const step of ghTokenSteps) assert.match(step, /\bgh (?:release|api)\b/);
  assert.doesNotMatch(release, /tauri build[^\n]*--no-sign/i);
});

test('release publication follows attestation, safe draft recovery, and verification', () => {
  const orderedSteps = [
    '      - name: Attest final installer digest',
    '      - name: Create or reuse draft release',
    '      - name: Verify existing draft assets and upload only missing assets',
    '      - name: Verify downloaded draft assets',
    '      - name: Verify draft release bytes',
    '      - name: Publish release',
    '      - name: Verify published assets',
    '      - name: Verify published release bytes',
  ].map((step) => release.indexOf(step));
  assert.ok(orderedSteps.every((step) => step >= 0));
  assert.deepEqual(orderedSteps, [...orderedSteps].sort((a, b) => a - b));
  assert.match(release, /actions\/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4\.2\.2/);
});

test('reruns reuse only drafts, reject unknown or changed assets, and upload missing names only', () => {
  const draftStep = namedStep(release, 'Create or reuse draft release');
  const assetStep = namedStep(release, 'Verify existing draft assets and upload only missing assets');
  assert.match(draftStep, /gh release list --limit 1000 --json tagName,isDraft/);
  assert.match(draftStep, /if \(-not \$matchingReleases\[0\]\.isDraft\) \{ throw/);
  assert.match(draftStep, /gh release create \$env:RELEASE_TAG --verify-tag --draft/);
  assert.match(assetStep, /\$existingNames \| Where-Object \{ \$_ -notin \$expected \}/);
  assert.match(assetStep, /gh release download \$env:RELEASE_TAG --dir \$download/);
  assert.match(assetStep, /fc\.exe \/b \$localFile \$downloadedFile/);
  assert.match(assetStep, /\$missingNames = @\(\$expected \| Where-Object \{ \$_ -notin \$existingNames \}\)/);
  assert.doesNotMatch(assetStep, /--clobber|gh release delete/);
  assert.doesNotMatch(release, /gh release delete/);
});

test('release names the exact five assets and never creates a tag', () => {
  const expectedAssets = [
    'WidgetBoard-$($env:RELEASE_VERSION)-setup-x86_64.exe',
    'WidgetBoard-$($env:RELEASE_VERSION)-setup-x86_64.exe.sig',
    'latest-installer.json',
    'release-metadata.json',
    'SHA256SUMS.txt',
  ];
  for (const asset of expectedAssets) assert.ok(release.includes(asset), `Release workflow omits ${asset}`);
  assert.match(release, /\$unexpectedNames = @\(\$existingNames \| Where-Object \{ \$_ -notin \$expected \}\)/);
  assert.match(release, /tools\/release\/verify\.ps1/);
  assert.doesNotMatch(release, /git\s+tag\b|gh\s+release\s+create\b(?![^\n]*--verify-tag)/i);
});
