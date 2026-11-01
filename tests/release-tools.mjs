import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test, { after } from 'node:test';
import { parseGitStatus, validateRelease } from '../tools/release/lib.mjs';
import { signArtifact } from '../tools/release/authenticode.mjs';
import { assembleRelease } from '../tools/release/assemble.mjs';
import { fakeAdapter, fakeSignatureInspector } from './fixtures/fake-authenticode-adapter.mjs';

function fixture() {
  const fixtureRoot = path.join(process.cwd(), 'test-artifacts', 'release-fixtures');
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(path.join(fixtureRoot, 'widgetboard-release-'));
  const gitRun = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  gitRun('init', '-b', 'main');
  gitRun('config', 'user.email', 'release-test@example.invalid');
  gitRun('config', 'user.name', 'Release Test');
  mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  mkdirSync(path.join(root, 'tools', 'release'), { recursive: true });
  mkdirSync(path.join(root, 'xdist'), { recursive: true });
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "widgetboard"\nversion = "1.2.3"\n');
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "widgetboard"\nversion = "1.2.3"\n');
  writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(path.join(root, 'xdist', 'source.js'), 'const source = true;\n');
  writeFileSync(path.join(root, '.gitignore'), 'dist/\nsrc-tauri/target/\nsrc-tauri/gen/\nignored-source.txt\n');
  writeFileSync(path.join(root, 'RELEASE_NOTES.md'), 'WidgetBoard 1.2.3\n');
  writeFileSync(path.join(root, 'empty.md'), ' \r\n\t');
  gitRun('add', '.');
  gitRun('commit', '-m', 'release fixture');
  const sha = gitRun('rev-parse', 'HEAD');
  gitRun('tag', 'v1.2.3', sha);
  gitRun('update-ref', 'refs/remotes/origin/main', sha);
  const git = {
    head: () => gitRun('rev-parse', 'HEAD'),
    tagTarget: (tag) => gitRun('rev-parse', `${tag}^{commit}`),
    isAncestor: (commit, ref) => {
      try { gitRun('merge-base', '--is-ancestor', commit, ref); return true; }
      catch { return false; }
    },
    status: () => parseGitStatus(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], { cwd: root, encoding: 'utf8' })),
  };
  return { root, sha, git, gitRun };
}

function withFixture(fn) {
  const f = fixture();
  try { return fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

test('accepts matching vX.Y.Z tag and versions', () => withFixture(({ root, sha, git }) => {
  const context = validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git });
  assert.equal(context.version, '1.2.3');
  assert.equal(context.tag, 'v1.2.3');
  assert.equal(context.sha, sha);
  assert.equal(context.versions.cargo, '1.2.3');
  assert.equal(context.versions.tauri, '1.2.3');
  assert.equal(context.versions.cargoLock, '1.2.3');
}));

test('rejects malformed or prerelease tags', () => withFixture(({ root, sha, git }) => {
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v01.2.3']) {
    assert.throws(() => validateRelease({ root, tag, sha, notesPath: 'RELEASE_NOTES.md', git }), /tag/i);
  }
}));

test('rejects Cargo and Tauri version mismatch', () => withFixture(({ root, sha, git }) => {
  writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '1.2.4' }));
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /version/i);
  writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "widgetboard"\nversion = "1.2.4"\n');
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /version/i);
}));

test('rejects Cargo.lock package mismatch', () => withFixture(({ root, sha, git }) => {
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "widgetboard"\nversion = "1.2.4"\n');
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /Cargo.lock/i);
}));

test('rejects tag target mismatch', () => withFixture(({ root, sha, git }) => {
  git.tagTarget = () => 'different-commit';
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /tag target/i);
}));

test('rejects a clean checkout at another commit with unchanged versions', () => withFixture(({ root, sha, git, gitRun }) => {
  writeFileSync(path.join(root, 'later.txt'), 'same versions');
  gitRun('add', 'later.txt'); gitRun('commit', '-m', 'later source commit');
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /checked-out.*SHA/i);
}));

test('rejects commit outside origin/main', () => withFixture(({ root, sha, git, gitRun }) => {
  writeFileSync(path.join(root, 'later.txt'), 'later');
  gitRun('add', 'later.txt'); gitRun('commit', '-m', 'later');
  const outside = gitRun('rev-parse', 'HEAD');
  gitRun('tag', '--force', 'v1.2.3', outside);
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha: outside, notesPath: 'RELEASE_NOTES.md', git }), /origin\/main/i);
}));

test('rejects empty release notes', () => withFixture(({ root, sha, git }) => {
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'empty.md', git }), /notes/i);
}));

test('rejects tracked and untracked source changes', () => withFixture(({ root, sha, git }) => {
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "widgetboard"\nversion = "1.2.3"\n# changed\n');
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /clean/i);
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "widgetboard"\nversion = "1.2.3"\n');
  writeFileSync(path.join(root, 'untracked-source.txt'), 'source');
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /clean/i);
}));

test('rejects ignored source changes while allowing declared build outputs', () => withFixture(({ root, sha, git }) => {
  writeFileSync(path.join(root, 'ignored-source.txt'), 'source');
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'release.bin'), 'build output');
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /clean/i);
  rmSync(path.join(root, 'ignored-source.txt'));
  assert.doesNotThrow(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }));
}));

test('rejects a tracked source change whose path starts with xdist', () => withFixture(({ root, sha, git }) => {
  writeFileSync(path.join(root, 'xdist', 'source.js'), 'const source = false;\n');
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha, notesPath: 'RELEASE_NOTES.md', git }), /clean/i);
}));

function signingFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'widgetboard-signer-test-'));
  const tmp = path.join(root, 'runner-temp');
  mkdirSync(tmp);
  const pe = path.join(root, 'WidgetBoard.exe');
  writeFileSync(pe, Buffer.from('MZ unsigned fixture'));
  return { root, tmp, pe };
}

function signTest(f, options = {}) {
  return signArtifact({
    file: f.pe,
    env: { WIDGETBOARD_AUTHENTICODE_ADAPTER: 'fake-adapter', WIDGETBOARD_AUTHENTICODE_SUBJECT: 'CN=WidgetBoard Test Publisher', RUNNER_TEMP: f.tmp, ...options.env },
    runAdapter: options.runAdapter ?? fakeAdapter,
    inspectSignature: options.inspectSignature ?? fakeSignatureInspector,
  });
}

test('signer invokes one configured adapter with an absolute path', async () => {
  const f = signingFixture();
  try {
    const calls = [];
    await signTest(f, { runAdapter: async (adapter, args) => { calls.push({ adapter, args }); return fakeAdapter(adapter, args); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].adapter, 'fake-adapter');
    assert.deepEqual(calls[0].args.slice(0, 1), ['sign']);
    assert.equal(calls[0].args.length, 2);
    assert.equal(path.isAbsolute(calls[0].args[1]), true);
    assert.equal(calls[0].args[1], f.pe);
    const record = JSON.parse(readFileSync(path.join(f.tmp, 'widgetboard-authenticode.jsonl'), 'utf8').trim());
    assert.equal(record.status, 'success');
    assert.equal(record.subject, 'CN=WidgetBoard Test Publisher');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('signer preserves a signed NSIS nst temporary uninstaller before it is deleted', async () => {
  const f = signingFixture();
  f.pe = path.join(f.root, 'nstA17F.tmp');
  writeFileSync(f.pe, Buffer.from('MZ temporary NSIS uninstaller'));
  try {
    const record = await signTest(f);
    const preserved = path.join(f.tmp, 'widgetboard-authenticode-evidence', 'nsis-uninstaller.exe');
    assert.equal(record.callbackRole, 'nsis-uninstaller');
    assert.equal(record.path, f.pe);
    assert.equal(record.identity, normalizeIdentity(f.pe));
    assert.equal(record.preservedPath, preserved);
    assert.equal(record.preservedSha256, crypto.createHash('sha256').update(readFileSync(preserved)).digest('hex'));
    unlinkSync(f.pe);
    assert.equal(readFileSync(preserved).toString().includes('FAKE-AUTHENTICODE-SIGNATURE'), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('signer rejects missing adapter', async () => {
  const f = signingFixture();
  try { await assert.rejects(signTest(f, { env: { WIDGETBOARD_AUTHENTICODE_ADAPTER: '' } }), /WIDGETBOARD_AUTHENTICODE_ADAPTER/); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('signer rejects nonzero adapter exit', async () => {
  const f = signingFixture();
  try { await assert.rejects(signTest(f, { runAdapter: async () => { throw new Error('adapter exited 9'); } }), /adapter exited 9/); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('signer rejects an unchanged unsigned file', async () => {
  const f = signingFixture();
  try { await assert.rejects(signTest(f, { runAdapter: async () => ({ code: 0 }) }), /unchanged/); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('signer requires valid Authenticode status, expected publisher, and timestamp', async (t) => {
  for (const [label, inspection, pattern] of [
    ['valid status', { status: 'NotSigned', subject: 'CN=WidgetBoard Test Publisher', timestampSubject: 'CN=Timestamp' }, /Status must be Valid/],
    ['expected publisher', { status: 'Valid', subject: 'CN=Other Publisher', timestampSubject: 'CN=Timestamp' }, /subject/],
    ['timestamp certificate', { status: 'Valid', subject: 'CN=WidgetBoard Test Publisher', timestampSubject: null }, /timestamp/],
  ]) {
    await t.test(label, async () => {
      const f = signingFixture();
      try { await assert.rejects(signTest(f, { inspectSignature: async () => inspection }), pattern); }
      finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }
});

function assemblyFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'widgetboard-assembly-test-'));
  const keys = getTestSigningKeys();
  const installer = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis', 'WidgetBoard_1.2.3_x64-setup.exe');
  mkdirSync(path.dirname(installer), { recursive: true });
  const signature = `${installer}.sig`;
  const bytes = Buffer.from('signed NSIS installer bytes');
  writeFileSync(installer, bytes);
  writeFileSync(signature, keys.signature);
  writeFileSync(path.join(root, 'RELEASE_NOTES.md'), '수정 사항\n한국어 업데이트 안내\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@tauri-apps/cli': '2.11.4' } }));
  mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '1.2.3', plugins: { updater: { pubkey: keys.pubkey } } }));
  cpSync(path.join(process.cwd(), 'tools', 'release', 'minisign-verifier'), path.join(root, 'tools', 'release', 'minisign-verifier'), { recursive: true });
  const pluginDir = path.join(root, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'Plugins', 'x86-unicode');
  mkdirSync(pluginDir, { recursive: true });
  const uninstaller = path.join(root, 'nsis-temp', 'nstA17F.tmp');
  const runnerTemp = path.join(root, 'runner-temp');
  const preservedUninstaller = path.join(runnerTemp, 'widgetboard-authenticode-evidence', 'nsis-uninstaller.exe');
  mkdirSync(path.dirname(preservedUninstaller), { recursive: true });
  const callbackPaths = [
    path.join(root, 'src-tauri', 'target', 'release', 'widgetboard.exe'),
    ...['NSISdl.dll', 'StartMenu.dll', 'System.dll', 'nsDialogs.dll', 'additional/nsis_tauri_utils.dll'].map((name) => path.join(pluginDir, name)),
    uninstaller,
    installer,
  ];
  for (const [index, file] of callbackPaths.entries()) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (file !== installer) writeFileSync(file, Buffer.from(`callback PE ${index}`));
  }
  writeFileSync(preservedUninstaller, Buffer.concat([readFileSync(uninstaller), Buffer.from('\nAUTHENTICODE-SIGNED') ]));
  unlinkSync(uninstaller);
  const evidence = path.join(runnerTemp, 'widgetboard-authenticode.jsonl');
  const roles = ['application', 'nsis-plugin:nsisdl.dll', 'nsis-plugin:startmenu.dll', 'nsis-plugin:system.dll', 'nsis-plugin:nsdialogs.dll', 'nsis-plugin:additional/nsis_tauri_utils.dll', 'nsis-uninstaller', 'final-installer'];
  const records = callbackPaths.map((file, index) => {
    const bytes = index === 6 ? readFileSync(preservedUninstaller) : readFileSync(file);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    return { status: 'success', authenticodeStatus: 'Valid', path: file, identity: normalizeIdentity(file), callbackRole: roles[index], sha256Before: 'b'.repeat(64), sha256: digest, ...(index === 6 ? { preservedPath: preservedUninstaller, preservedSha256: digest } : {}), subject: 'CN=WidgetBoard', timestampSubject: 'CN=Timestamp', timestampThumbprint: 'T'.repeat(40) };
  });
  writeFileSync(evidence, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { root, installer, signature, bytes, evidence, context: { tag: 'v1.2.3', version: '1.2.3', sha: 'a'.repeat(40), notesPath: 'RELEASE_NOTES.md' } };
}

function runPowerShellVerifier(fixture, output) {
  const scriptDirectory = path.join(fixture.root, 'tools', 'release');
  mkdirSync(scriptDirectory, { recursive: true });
  const sourceScript = readFileSync(path.join(process.cwd(), 'tools', 'release', 'verify.ps1'), 'utf8');
  const targetRoot = process.cwd().replaceAll("'", "''");
  const fixtureRoot = fixture.root.replaceAll("'", "''");
  const testScript = sourceScript
    .replace(/^\$scriptRepositoryRoot = .*$/m, `$scriptRepositoryRoot = '${targetRoot}'`)
    .replace(/^\$repositoryRoot = \$scriptRepositoryRoot$/m, `$repositoryRoot = '${fixtureRoot}'`);
  const script = path.join(scriptDirectory, 'verify.ps1');
  writeFileSync(script, testScript, 'utf8');
  const command = `$ErrorActionPreference='Stop'; function global:Get-AuthenticodeSignature { param([string]$LiteralPath) [pscustomobject]@{ Status='Valid'; SignerCertificate=[pscustomobject]@{ Subject='CN=WidgetBoard'; Thumbprint='A' }; TimeStamperCertificate=[pscustomobject]@{ Subject='CN=Timestamp'; Thumbprint='B' } } }; function global:Get-FileHash { param([string]$LiteralPath,[string]$Algorithm) $sha=[System.Security.Cryptography.SHA256]::Create(); try { $stream=[System.IO.File]::OpenRead($LiteralPath); try { $hex=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') } finally { $stream.Dispose() } } finally { $sha.Dispose() }; [pscustomobject]@{ Hash=$hex } }; & '${script.replaceAll("'", "''")}' -ReleaseDirectory '${output.directory.replaceAll("'", "''")}' -ExpectedSubject 'CN=WidgetBoard'`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: process.cwd(), encoding: 'utf8' });
}

let testSigningKeys;
let testSigningRoot;
const testSigningPassword = 'widgetboard fixture signing password';
const tauriCli = path.join(process.cwd(), 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

function generateTestKey(name) {
  const privateKey = path.join(testSigningRoot, `${name}.key`);
  execFileSync(process.execPath, [tauriCli, 'signer', 'generate', '--ci', '--password', testSigningPassword, '--write-keys', privateKey], { cwd: process.cwd(), stdio: 'ignore' });
  return { privateKey, pubkey: readFileSync(`${privateKey}.pub`, 'utf8').trim() };
}

function getTestSigningKeys() {
  if (testSigningKeys) return testSigningKeys;
  testSigningRoot = mkdtempSync(path.join(os.tmpdir(), 'widgetboard-tauri-test-keys-'));
  const key = generateTestKey('valid');
  const payload = path.join(testSigningRoot, 'WidgetBoard_1.2.3_x64-setup.exe');
  writeFileSync(payload, Buffer.from('signed NSIS installer bytes'));
  execFileSync(process.execPath, [tauriCli, 'signer', 'sign', '--private-key-path', key.privateKey, '--password', testSigningPassword, payload], { cwd: process.cwd(), stdio: 'ignore' });
  testSigningKeys = { ...key, signature: readFileSync(`${payload}.sig`, 'utf8') };
  return testSigningKeys;
}

function normalizeIdentity(file) {
  return path.resolve(file).replaceAll('\\', '/').toLowerCase();
}

after(() => {
  if (testSigningRoot) rmSync(testSigningRoot, { recursive: true, force: true });
});

test('assembler requires one installer and matching sig', () => {
  const f = assemblyFixture();
  try {
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: path.join(f.root, 'missing.exe'), signature: f.signature, evidence: f.evidence }), /installer/i);
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: path.join(f.root, 'wrong.sig'), evidence: f.evidence }), /signature|\.sig/i);
    writeFileSync(f.signature, '  \n');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /signature.*empty/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembly CLI creates a release and prints its output paths', () => {
  const f = assemblyFixture();
  try {
    const cli = path.join(process.cwd(), 'tools', 'release', 'assemble.mjs');
    const result = spawnSync(process.execPath, [cli,
      '--tag', f.context.tag,
      '--sha', f.context.sha,
      '--notes', f.context.notesPath,
      '--installer', path.relative(f.root, f.installer),
      '--signature', path.relative(f.root, f.signature),
      '--evidence', path.relative(f.root, f.evidence),
    ], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.directory, path.join(f.root, 'dist', 'release'));
    assert.equal(summary.installer, path.join(summary.directory, 'WidgetBoard-1.2.3-setup-x86_64.exe'));
    assert.equal(summary.signature, `${summary.installer}.sig`);
    assert.equal(readFileSync(summary.installer).equals(f.bytes), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembly CLI rejects malformed arguments', () => {
  const f = assemblyFixture();
  try {
    const cli = path.join(process.cwd(), 'tools', 'release', 'assemble.mjs');
    const required = ['--tag', f.context.tag, '--sha', f.context.sha, '--notes', f.context.notesPath, '--installer', path.relative(f.root, f.installer), '--signature', path.relative(f.root, f.signature), '--evidence', path.relative(f.root, f.evidence)];
    for (const args of [
      required.slice(0, -2),
      [...required, '--tag', f.context.tag],
      [...required, '--unexpected', 'value'],
      required.map((value, index) => index === 1 ? 'v1.2.3-rc.1' : value),
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: 'utf8' });
      assert.notEqual(result.status, 0, `unexpectedly accepted arguments: ${args.join(' ')}`);
      assert.match(result.stderr, /argument|tag|version|unknown|required|duplicate/i);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('updater signature verifies with the configured key for exact final installer bytes', async () => {
  const f = assemblyFixture();
  try {
    const tools = await import('../tools/release/assemble.mjs');
    assert.equal(typeof tools.verifyUpdaterSignature, 'function');
    assert.equal(tools.verifyUpdaterSignature({ root: f.root, signature: f.signature, installer: f.installer }), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('updater signature verification rejects a different key', async () => {
  const f = assemblyFixture();
  try {
    const tools = await import('../tools/release/assemble.mjs');
    const wrong = generateTestKey('wrong');
    const configPath = path.join(f.root, 'src-tauri', 'tauri.conf.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.plugins.updater.pubkey = wrong.pubkey;
    writeFileSync(configPath, JSON.stringify(config));
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /signature|key|verify/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('updater signature verification rejects different installer bytes', async () => {
  const f = assemblyFixture();
  try {
    const tools = await import('../tools/release/assemble.mjs');
    const changed = path.join(path.dirname(f.installer), 'different-installer.exe');
    writeFileSync(changed, Buffer.from('different final installer bytes'));
    assert.throws(() => tools.verifyUpdaterSignature({ root: f.root, signature: f.signature, installer: changed }), /signature|verify/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembler rejects missing duplicate or unbound signing callbacks', () => {
  const f = assemblyFixture();
  try {
    const records = readFileSync(f.evidence, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    writeFileSync(f.evidence, records.slice(0, -1).map(JSON.stringify).join('\n') + '\n');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /missing|complete|callback/i);
    writeFileSync(f.evidence, [...records, records[0]].map(JSON.stringify).join('\n') + '\n');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /duplicate|identity/i);
    const missingDigest = records.map((entry) => entry.path === f.installer ? (({ sha256Before, ...rest }) => rest)(entry) : entry);
    writeFileSync(f.evidence, missingDigest.map(JSON.stringify).join('\n') + '\n');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /digest/i);
    const wrongInstaller = records.map((entry) => entry.path === f.installer ? { ...entry, sha256: 'f'.repeat(64) } : entry);
    writeFileSync(f.evidence, wrongInstaller.map(JSON.stringify).join('\n') + '\n');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /digest|hash|bytes/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembler rejects an unsafe release identity or source path', () => {
  const f = assemblyFixture();
  try {
    assert.throws(() => assembleRelease({ root: f.root, context: { ...f.context, sha: 'bad' }, installer: f.installer, signature: f.signature, evidence: f.evidence }), /commit|sha/i);
    assert.throws(() => assembleRelease({ root: f.root, context: { ...f.context, tag: 'v1.2.4' }, installer: f.installer, signature: f.signature, evidence: f.evidence }), /tag|version/i);
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: path.join(f.root, 'outside.exe'), signature: path.join(f.root, 'outside.exe.sig'), evidence: f.evidence }), /canonical|installer|path/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembler refuses stale release staging output', () => {
  const f = assemblyFixture();
  try {
    const staging = path.join(f.root, 'dist', 'release');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, 'old-artifact.txt'), 'stale');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /empty|stale|nonempty/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembler and PowerShell verifier accept a deleted nst temporary uninstaller with preserved signed bytes', { skip: process.platform !== 'win32' }, () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    const metadata = JSON.parse(readFileSync(out.metadata, 'utf8'));
    metadata.installerSourcePath = metadata.installerSourcePath.toUpperCase();
    metadata.signerEvidenceDirectory = metadata.signerEvidenceDirectory.toUpperCase();
    for (const entry of metadata.signerEvidence) {
      entry.path = entry.path.toUpperCase();
      if (entry.preservedPath) entry.preservedPath = entry.preservedPath.toUpperCase();
    }
    writeFileSync(out.metadata, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const metadataHash = crypto.createHash('sha256').update(readFileSync(out.metadata)).digest('hex');
    const checksums = readFileSync(out.checksums, 'utf8').replace(/^[0-9a-f]{64}(  release-metadata\.json)$/m, `${metadataHash}$1`);
    writeFileSync(out.checksums, checksums, 'utf8');
    const stdout = runPowerShellVerifier(f, out);
    assert.match(stdout, /Verified v1\.2\.3 installer/);
    const uninstaller = metadata.signerEvidence.find((entry) => entry.callbackRole === 'nsis-uninstaller');
    assert.equal(readFileSync(uninstaller.preservedPath.toLowerCase()).length > 0, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('PowerShell verifier rejects missing or changed preserved NSIS uninstaller bytes', { skip: process.platform !== 'win32' }, () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    const metadata = JSON.parse(readFileSync(out.metadata, 'utf8'));
    const uninstaller = metadata.signerEvidence.find((entry) => entry.callbackRole === 'nsis-uninstaller');
    unlinkSync(uninstaller.preservedPath);
    assert.throws(() => runPowerShellVerifier(f, out), /preserved NSIS uninstaller bytes are missing/i);
    writeFileSync(uninstaller.preservedPath, 'changed preserved bytes');
    assert.throws(() => runPowerShellVerifier(f, out), /preserved NSIS uninstaller SHA-256 mismatch/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembler rejects missing or changed preserved uninstaller bytes', () => {
  const f = assemblyFixture();
  try {
    let records = readFileSync(f.evidence, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const uninstaller = records.find((entry) => entry.callbackRole === 'nsis-uninstaller');
    unlinkSync(uninstaller.preservedPath);
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /preserved|uninstaller/i);
    writeFileSync(uninstaller.preservedPath, 'changed');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /preserved|digest|uninstaller/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('manifest uses windows-x86_64-nsis', () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    const manifest = JSON.parse(readFileSync(out.manifest, 'utf8'));
    assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64-nsis']);
    assert.equal(manifest.platforms['windows-x86_64-nsis'].url, 'https://github.com/104-bookwyrm/WidgetBoard/releases/download/v1.2.3/WidgetBoard-1.2.3-setup-x86_64.exe');
    assert.deepEqual(readFileSync(out.installer), f.bytes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('manifest embeds sig file content', () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    const manifest = JSON.parse(readFileSync(out.manifest, 'utf8'));
    assert.deepEqual(Buffer.from(manifest.platforms['windows-x86_64-nsis'].signature), readFileSync(out.signature));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('manifest preserves Korean UTF-8 notes', () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    assert.equal(JSON.parse(readFileSync(out.manifest, 'utf8')).notes, '수정 사항\n한국어 업데이트 안내\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('checksums cover the final installer and metadata', () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    const sums = readFileSync(out.checksums, 'utf8');
    assert.match(sums, /WidgetBoard-1\.2\.3-setup-x86_64\.exe/);
    assert.match(sums, /release-metadata\.json/);
    const expected = crypto.createHash('sha256').update(readFileSync(out.installer)).digest('hex');
    assert.match(sums, new RegExp(expected));
    const checksumNames = sums.trim().split(/\r?\n/).map((line) => line.slice(66));
    assert.equal(new Set(checksumNames).size, 4);
    assert.equal(checksumNames.length, 4);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembler rejects a filename or version mismatch', () => {
  const f = assemblyFixture();
  try {
    assert.throws(() => assembleRelease({ root: f.root, context: { ...f.context, version: '2.0.0' }, installer: f.installer, signature: f.signature, evidence: f.evidence }), /canonical|filename|version/i);
    const wrongInstaller = path.join(path.dirname(f.installer), 'WidgetBoard_1.2.4_x64-setup.exe');
    writeFileSync(wrongInstaller, f.bytes);
    writeFileSync(`${wrongInstaller}.sig`, 'sig');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: wrongInstaller, signature: `${wrongInstaller}.sig`, evidence: f.evidence }), /canonical|filename|version/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release signing config stays out of the base Tauri config', () => {
  const base = JSON.parse(readFileSync(path.join(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const release = JSON.parse(readFileSync(path.join(process.cwd(), 'src-tauri', 'tauri.release.conf.json'), 'utf8'));
  assert.equal(base.bundle.createUpdaterArtifacts, undefined);
  assert.equal(base.bundle.windows.signCommand, undefined);
  assert.equal(release.bundle.createUpdaterArtifacts, true);
  assert.equal(release.bundle.windows.signCommand, 'node ../tools/release/authenticode.mjs %1');
});

test('PowerShell verifier rejects checksum inventory extras before Authenticode checks', { skip: process.platform !== 'win32' }, () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    writeFileSync(out.checksums, `${readFileSync(out.checksums, 'utf8')}0000000000000000000000000000000000000000000000000000000000000000  unexpected.bin\n`);
    const script = path.join(process.cwd(), 'tools', 'release', 'verify.ps1');
    assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ReleaseDirectory', out.directory, '-ExpectedSubject', 'CN=WidgetBoard'], { cwd: process.cwd(), encoding: 'utf8' }), /four|checksum|target/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('PowerShell verifier rejects manifest signature bytes that differ from .sig', { skip: process.platform !== 'win32' }, () => {
  const f = assemblyFixture();
  try {
    const out = assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence });
    const manifest = JSON.parse(readFileSync(out.manifest, 'utf8'));
    manifest.platforms['windows-x86_64-nsis'].signature += 'tampered';
    writeFileSync(out.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const updatedManifestHash = crypto.createHash('sha256').update(readFileSync(out.manifest)).digest('hex');
    const sums = readFileSync(out.checksums, 'utf8').replace(/^[0-9a-f]{64}(  latest-installer\.json)$/m, `${updatedManifestHash}$1`);
    writeFileSync(out.checksums, sums, 'utf8');
    const script = path.join(process.cwd(), 'tools', 'release', 'verify.ps1');
    assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ReleaseDirectory', out.directory, '-ExpectedSubject', 'CN=WidgetBoard'], { cwd: process.cwd(), encoding: 'utf8' }), /manifest signature bytes/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
