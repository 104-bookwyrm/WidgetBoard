import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateRelease } from '../tools/release/lib.mjs';

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
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "widgetboard"\nversion = "1.2.3"\n');
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "widgetboard"\nversion = "1.2.3"\n');
  writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(path.join(root, '.gitignore'), 'dist/\nsrc-tauri/target/\nsrc-tauri/gen/\n');
  writeFileSync(path.join(root, 'RELEASE_NOTES.md'), 'WidgetBoard 1.2.3\n');
  writeFileSync(path.join(root, 'empty.md'), ' \r\n\t');
  gitRun('add', '.');
  gitRun('commit', '-m', 'release fixture');
  const sha = gitRun('rev-parse', 'HEAD');
  gitRun('tag', 'v1.2.3', sha);
  gitRun('update-ref', 'refs/remotes/origin/main', sha);
  const git = {
    tagTarget: (tag) => gitRun('rev-parse', `${tag}^{commit}`),
    isAncestor: (commit, ref) => {
      try { gitRun('merge-base', '--is-ancestor', commit, ref); return true; }
      catch { return false; }
    },
    status: () => gitRun('status', '--porcelain', '--untracked-files=all').split(/\r?\n/).filter(Boolean),
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
  assert.throws(() => validateRelease({ root, tag: 'v1.2.3', sha: `${sha.slice(0, -1)}0`, notesPath: 'RELEASE_NOTES.md', git }), /tag target/i);
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
