import { readFileSync } from 'node:fs';
import path from 'node:path';

const BUILD_OUTPUTS = ['node_modules/', 'src-tauri/target/', 'src-tauri/gen/', 'dist/', 'test-artifacts/'];

function fail(message) {
  throw new Error(message);
}

function isBuildOutput(statusLine) {
  const changedPath = statusLine.slice(3).replace(/^"(.*)"$/, '$1').replaceAll('\\', '/');
  return BUILD_OUTPUTS.some((output) => {
    const prefix = output.replace(/^\.\//, '');
    return changedPath === prefix.slice(0, -1) || changedPath.startsWith(prefix);
  });
}

function packageVersion(toml, label) {
  const match = toml.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) fail(`Could not read ${label} version`);
  return match[1];
}

export function readProjectVersions(root) {
  const cargoToml = readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoLock = readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
  const tauri = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const lockPackages = [...cargoLock.matchAll(/\[\[package\]\]([\s\S]*?)(?=\n\[\[package\]\]|$)/g)]
    .map(([, block]) => ({
      name: block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1],
      version: block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1],
    }));
  const locked = lockPackages.find((item) => item.name === 'widgetboard');
  if (!locked?.version) fail('Cargo.lock package widgetboard is missing');
  return {
    cargo: packageVersion(cargoToml, 'Cargo'),
    tauri: tauri.version,
    cargoLock: locked.version,
  };
}

export function validateRelease({ root, tag, sha, notesPath, git }) {
  if (!git || typeof git.head !== 'function' || typeof git.tagTarget !== 'function' || typeof git.isAncestor !== 'function' || typeof git.status !== 'function') {
    fail('An injected Git interface is required');
  }
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? '');
  if (!match) fail('Release tag must be an exact vX.Y.Z version without prerelease metadata');
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const versions = readProjectVersions(root);
  for (const [name, actual] of Object.entries(versions)) {
    if (actual !== version) fail(`${name === 'cargoLock' ? 'Cargo.lock' : name} version ${actual} does not match tag ${tag}`);
  }
  if (git.head() !== sha) fail(`Checked-out commit does not match requested SHA ${sha}`);
  if (git.tagTarget(tag) !== sha) fail(`Release tag target does not match commit ${sha}`);
  if (!git.isAncestor(sha, 'origin/main')) fail(`Commit ${sha} is outside origin/main`);
  const changes = git.status().filter((entry) => !isBuildOutput(entry));
  if (changes.length) fail(`Working tree must be clean; found: ${changes.join(', ')}`);
  const notes = readFileSync(path.resolve(root, notesPath), 'utf8');
  if (!notes.trim()) fail('Release notes must not be empty');
  return {
    tag,
    version,
    sha,
    notesPath: path.relative(root, path.resolve(root, notesPath)).replaceAll('\\', '/'),
    versions,
  };
}

export { BUILD_OUTPUTS };
