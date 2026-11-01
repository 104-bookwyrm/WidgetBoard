import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_BASE = 'https://github.com/104-bookwyrm/WidgetBoard/releases/download';
const NSIS_PLUGIN_FILES = ['NSISdl.dll', 'StartMenu.dll', 'System.dll', 'nsDialogs.dll', 'additional/nsis_tauri_utils.dll'];
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFIER_MANIFEST = path.join(REPOSITORY_ROOT, 'tools', 'release', 'minisign-verifier', 'Cargo.toml');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const normalizePath = (file) => path.resolve(file).replaceAll('\\', '/').toLowerCase();

function fail(message) {
  throw new Error(message);
}

function containedPath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readJsonl(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { fail(`Invalid Authenticode evidence on line ${index + 1}`); }
  });
}

export function verifyUpdaterSignature({ root = REPOSITORY_ROOT, signature, installer }) {
  const projectRoot = path.resolve(root);
  const configPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json');
  if (!existsSync(VERIFIER_MANIFEST) || !existsSync(configPath)) fail('Pinned Tauri minisign verifier inputs are missing');
  const publicKey = JSON.parse(readFileSync(configPath, 'utf8')).plugins?.updater?.pubkey;
  if (typeof publicKey !== 'string' || !publicKey.trim()) fail('Committed Tauri updater public key is required');
  const signaturePath = path.resolve(signature);
  const installerPath = path.resolve(installer);
  if (!existsSync(signaturePath) || !readFileSync(signaturePath).length) fail('Tauri updater signature file is missing or empty');
  if (!existsSync(installerPath)) fail('Final installer file is missing');
  try {
    execFileSync('cargo', [
      'run', '--quiet', '--locked', '--manifest-path', VERIFIER_MANIFEST,
      '--target-dir', path.join(REPOSITORY_ROOT, 'src-tauri', 'target', 'release-tools-minisign'), '--',
      publicKey, signaturePath, installerPath,
    ], { cwd: REPOSITORY_ROOT, encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    fail(`Tauri updater signature verification failed: ${details}`);
  }
}

function expectedCallbackFiles(root, installer) {
  const target = path.join(root, 'src-tauri', 'target', 'release');
  const pluginRoot = path.join(target, 'nsis', 'x64', 'Plugins', 'x86-unicode');
  return [
    { role: 'application', path: path.join(target, 'widgetboard.exe') },
    ...NSIS_PLUGIN_FILES.map((name) => ({ role: `nsis-plugin:${name.toLowerCase()}`, path: path.join(pluginRoot, name) })),
    { role: 'final-installer', path: installer },
  ];
}

function validateCallbackEvidence({ root, installer, evidence }) {
  const records = readJsonl(evidence);
  if (!records.length) fail('Complete successful Authenticode callback evidence is required');
  const evidenceFile = path.resolve(evidence);
  const runnerTemp = realpathSync(path.dirname(evidenceFile));
  const preservedUninstallerPath = path.join(runnerTemp, 'widgetboard-authenticode-evidence', 'nsis-uninstaller.exe');
  const expected = expectedCallbackFiles(root, installer);
  const expectedByIdentity = new Map(expected.map((entry) => [normalizePath(entry.path), entry]));
  for (const entry of expected) {
    if (!existsSync(entry.path)) fail(`Expected Tauri signing callback input is missing: ${entry.path}`);
  }
  const seenIdentities = new Set();
  const seenRoles = new Set();
  for (const record of records) {
    if (record.status !== 'success' || record.authenticodeStatus !== 'Valid') fail('Unsuccessful Authenticode callback evidence');
    if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) fail('Callback evidence must contain a full absolute path');
    const identity = normalizePath(record.path);
    if (record.identity !== identity) fail(`Callback identity is not the normalized full path: ${record.path}`);
    if (seenIdentities.has(identity)) fail(`Duplicate Authenticode callback identity: ${record.identity}`);
    seenIdentities.add(identity);
    const staticCallback = expectedByIdentity.get(identity);
    let role = staticCallback?.role;
    if (!role && /^nst.*\.tmp$/i.test(path.basename(record.path))) role = 'nsis-uninstaller';
    if (!role) fail(`Unexpected Authenticode callback identity: ${record.identity}`);
    if (record.callbackRole !== role) fail(`Authenticode callback role mismatch for ${record.identity}`);
    if (seenRoles.has(role)) fail(`Duplicate Authenticode callback role: ${role}`);
    seenRoles.add(role);
    if (!/^[0-9a-f]{64}$/i.test(record.sha256Before ?? '') || !/^[0-9a-f]{64}$/i.test(record.sha256 ?? '')) {
      fail(`Callback evidence is missing required SHA-256 digests: ${record.identity}`);
    }
    if (!record.subject || !record.timestampSubject || !record.timestampThumbprint) fail(`Callback evidence is missing certificate evidence: ${record.identity}`);
    if (role === 'nsis-uninstaller') {
      if (!/^nst.*\.tmp$/i.test(path.basename(record.path))) fail('NSIS uninstaller callback must identify an nst*.tmp input');
      if (normalizePath(record.preservedPath ?? '') !== normalizePath(preservedUninstallerPath)) fail('Preserved NSIS uninstaller must use the fixed runner evidence path');
      if (!containedPath(runnerTemp, record.preservedPath)) fail('Preserved NSIS uninstaller escapes RUNNER_TEMP');
      if (!existsSync(record.preservedPath) || normalizePath(realpathSync(record.preservedPath)) !== normalizePath(preservedUninstallerPath)) fail('Preserved NSIS uninstaller bytes are missing or redirected');
      if (!/^[0-9a-f]{64}$/i.test(record.preservedSha256 ?? '')) fail('Preserved NSIS uninstaller digest is required');
      const preservedDigest = sha256(record.preservedPath);
      if (preservedDigest !== record.sha256.toLowerCase() || preservedDigest !== record.preservedSha256.toLowerCase()) fail('Preserved NSIS uninstaller bytes do not match callback evidence');
    } else {
      if (!existsSync(record.path) || sha256(record.path) !== record.sha256.toLowerCase()) fail(`Callback SHA-256 does not bind to current bytes: ${record.identity}`);
      if (!containedPath(path.join(root, 'src-tauri', 'target'), record.path)) fail(`Callback path is outside the Tauri release target: ${record.path}`);
    }
  }
  const requiredRoles = [...expected.map((entry) => entry.role), 'nsis-uninstaller'];
  for (const role of requiredRoles) {
    if (!seenRoles.has(role)) fail(`Missing Tauri signing callback identity: ${role}`);
  }
  if (seenRoles.size !== requiredRoles.length) fail('Tauri signing callback identity set is incomplete');
  const installerRecord = records.find((record) => record.callbackRole === 'final-installer');
  if (normalizePath(installerRecord.path) !== normalizePath(installer)) fail('Final installer evidence path does not match the full normalized source path');
  const sourceInstallerSha256 = sha256(installer);
  if (installerRecord.sha256.toLowerCase() !== sourceInstallerSha256) fail('Final installer evidence SHA-256 does not match source installer bytes');
  return records;
}

export function assembleRelease({ root, context, installer, signature, evidence }) {
  const releaseRoot = realpathSync(root);
  if (!context || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(context.tag ?? '') || context.tag !== `v${context.version}`) {
    fail('Release tag and version do not match');
  }
  if (!/^[0-9a-f]{40}$/i.test(context.sha ?? '')) fail('Release commit SHA must be a full 40-character hexadecimal commit');
  const expectedSource = path.join(releaseRoot, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `WidgetBoard_${context.version}_x64-setup.exe`);
  const sourceInstaller = path.resolve(releaseRoot, installer);
  const sourceSignature = path.resolve(releaseRoot, signature);
  if (!existsSync(sourceInstaller) || normalizePath(realpathSync(sourceInstaller)) !== normalizePath(expectedSource)) {
    fail(`Installer path must be the canonical Tauri NSIS artifact ${expectedSource}`);
  }
  if (!containedPath(releaseRoot, sourceInstaller)) fail('Installer is outside the repository release root');
  if (sourceSignature !== `${sourceInstaller}.sig` || !existsSync(sourceSignature) || normalizePath(realpathSync(sourceSignature)) !== normalizePath(`${expectedSource}.sig`)) {
    fail('Installer signature must be the canonical matching .sig path');
  }
  if (!containedPath(releaseRoot, sourceSignature)) fail('Installer signature is outside the repository release root');
  const notes = readFileSync(path.resolve(releaseRoot, context.notesPath), 'utf8');
  const packageJson = JSON.parse(readFileSync(path.join(releaseRoot, 'package.json'), 'utf8'));
  const tauriCli = packageJson.devDependencies?.['@tauri-apps/cli'];
  if (!tauriCli) fail('Pinned Tauri CLI version is missing from package.json');
  const signatureBytes = readFileSync(sourceSignature);
  const signatureText = signatureBytes.toString('utf8');
  if (!signatureText.trim()) fail('Installer signature file must not be empty');
  verifyUpdaterSignature({ root: releaseRoot, signature: sourceSignature, installer: sourceInstaller });
  const evidenceRecords = validateCallbackEvidence({ root: releaseRoot, installer: sourceInstaller, evidence: path.resolve(releaseRoot, evidence) });
  const outputDir = path.join(releaseRoot, 'dist', 'release');
  if (existsSync(outputDir) && readdirSync(outputDir).length !== 0) fail('Release staging directory must be empty before assembly');
  mkdirSync(outputDir, { recursive: true });
  if (!containedPath(releaseRoot, realpathSync(outputDir))) fail('Release output directory escapes the repository');
  const filename = `WidgetBoard-${context.version}-setup-x86_64.exe`;
  const outputInstaller = path.join(outputDir, filename);
  const outputSignature = `${outputInstaller}.sig`;
  copyFileSync(sourceInstaller, outputInstaller);
  copyFileSync(sourceSignature, outputSignature);
  if (sha256(sourceInstaller) !== sha256(outputInstaller)) fail('Installer bytes changed during assembly');
  if (!readFileSync(outputSignature).equals(signatureBytes)) fail('Installer signature bytes changed during assembly');
  const immutableUrl = `${RELEASE_BASE}/${context.tag}/${filename}`;
  const manifest = {
    version: context.version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64-nsis': {
        signature: signatureText,
        url: immutableUrl,
      },
    },
  };
  if (!Buffer.from(manifest.platforms['windows-x86_64-nsis'].signature).equals(readFileSync(outputSignature))) fail('Manifest signature is not byte-identical to .sig');
  const manifestPath = path.join(outputDir, 'latest-installer.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const metadata = {
    tag: context.tag,
    version: context.version,
    commit: context.sha.toLowerCase(),
    installer: filename,
    installerSourcePath: realpathSync(sourceInstaller),
    installerSha256: sha256(outputInstaller),
    signature: path.basename(outputSignature),
    manifestUrl: immutableUrl,
    tools: { node: process.version, tauriCli },
    expectedCallbackRoles: [...expectedCallbackFiles(releaseRoot, sourceInstaller).map((entry) => entry.role), 'nsis-uninstaller'],
    signerEvidenceDirectory: realpathSync(path.dirname(path.resolve(evidence))),
    signerEvidence: evidenceRecords,
  };
  const metadataPath = path.join(outputDir, 'release-metadata.json');
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const checksumsPath = path.join(outputDir, 'SHA256SUMS.txt');
  const sumFiles = [outputInstaller, outputSignature, manifestPath, metadataPath];
  const sums = sumFiles.map((file) => `${sha256(file)}  ${path.basename(file)}`).join('\n') + '\n';
  writeFileSync(checksumsPath, sums, 'utf8');
  return { directory: outputDir, installer: outputInstaller, signature: outputSignature, manifest: manifestPath, metadata: metadataPath, checksums: checksumsPath };
}
