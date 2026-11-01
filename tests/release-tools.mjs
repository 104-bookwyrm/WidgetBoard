import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
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
  const installerDir = path.join(root, 'bundle');
  mkdirSync(installerDir);
  const installer = path.join(installerDir, 'WidgetBoard_1.2.3_x64-setup.exe');
  const signature = `${installer}.sig`;
  const bytes = Buffer.from('signed NSIS installer bytes');
  writeFileSync(installer, bytes);
  writeFileSync(signature, 'tauri-update-signature\n');
  writeFileSync(path.join(root, 'RELEASE_NOTES.md'), '수정 사항\n한국어 업데이트 안내\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@tauri-apps/cli': '2.11.4' } }));
  const evidence = path.join(root, 'authenticode.jsonl');
  writeFileSync(evidence, `${JSON.stringify({ status: 'success', authenticodeStatus: 'Valid', path: installer, subject: 'CN=WidgetBoard', timestampSubject: 'CN=Timestamp' })}\n`);
  return { root, installer, signature, bytes, evidence, context: { tag: 'v1.2.3', version: '1.2.3', sha: 'a'.repeat(40), notesPath: 'RELEASE_NOTES.md' } };
}

test('assembler requires one installer and matching sig', () => {
  const f = assemblyFixture();
  try {
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: path.join(f.root, 'missing.exe'), signature: f.signature, evidence: f.evidence }), /installer/i);
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: path.join(f.root, 'wrong.sig'), evidence: f.evidence }), /signature|\.sig/i);
    writeFileSync(f.signature, '  \n');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: f.installer, signature: f.signature, evidence: f.evidence }), /signature.*empty/i);
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
    assert.equal(manifest.platforms['windows-x86_64-nsis'].signature, 'tauri-update-signature\n');
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
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembler rejects a filename or version mismatch', () => {
  const f = assemblyFixture();
  try {
    assert.throws(() => assembleRelease({ root: f.root, context: { ...f.context, version: '2.0.0' }, installer: f.installer, signature: f.signature, evidence: f.evidence }), /filename|version/i);
    const wrongInstaller = path.join(path.dirname(f.installer), 'WidgetBoard_1.2.4_x64-setup.exe');
    writeFileSync(wrongInstaller, f.bytes);
    writeFileSync(`${wrongInstaller}.sig`, 'sig');
    assert.throws(() => assembleRelease({ root: f.root, context: f.context, installer: wrongInstaller, signature: `${wrongInstaller}.sig`, evidence: f.evidence }), /filename|version/i);
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
