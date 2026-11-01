import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RELEASE_BASE = 'https://github.com/104-bookwyrm/WidgetBoard/releases/download';
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJsonl = (file) => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); }
  catch { throw new Error(`Invalid Authenticode evidence on line ${index + 1}`); }
});

export function assembleRelease({ root, context, installer, signature, evidence }) {
  if (!context || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(context.tag ?? '') || context.tag !== `v${context.version}`) {
    throw new Error('Release tag and version do not match');
  }
  const sourceInstaller = path.resolve(root, installer);
  const sourceSignature = path.resolve(root, signature);
  if (!/\.exe$/i.test(sourceInstaller)) throw new Error('Installer must be an .exe file');
  if (sourceSignature !== `${sourceInstaller}.sig`) throw new Error('Installer signature must match the installer .sig path');
  const expectedSourceName = `WidgetBoard_${context.version}_x64-setup.exe`;
  if (path.basename(sourceInstaller) !== expectedSourceName) throw new Error(`Installer filename must be ${expectedSourceName}`);
  const evidenceRecords = readJsonl(path.resolve(root, evidence));
  if (!evidenceRecords.length || evidenceRecords.some((entry) => entry.status !== 'success' || entry.authenticodeStatus !== 'Valid' || !entry.subject || !entry.timestampSubject)) {
    throw new Error('Complete successful Authenticode callback evidence is required');
  }
  if (!evidenceRecords.some((entry) => path.resolve(entry.path) === sourceInstaller)) throw new Error('Signing evidence does not include the final installer callback');
  const notes = readFileSync(path.resolve(root, context.notesPath), 'utf8');
  const signatureText = readFileSync(sourceSignature, 'utf8');
  if (!signatureText.trim()) throw new Error('Installer signature file must not be empty');
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tauriCli = packageJson.devDependencies?.['@tauri-apps/cli'];
  if (!tauriCli) throw new Error('Pinned Tauri CLI version is missing from package.json');
  const outputDir = path.join(root, 'dist', 'release');
  mkdirSync(outputDir, { recursive: true });
  const filename = `WidgetBoard-${context.version}-setup-x86_64.exe`;
  const outputInstaller = path.join(outputDir, filename);
  const outputSignature = `${outputInstaller}.sig`;
  copyFileSync(sourceInstaller, outputInstaller);
  copyFileSync(sourceSignature, outputSignature);
  if (sha256(sourceInstaller) !== sha256(outputInstaller)) throw new Error('Installer bytes changed during assembly');
  const manifest = {
    version: context.version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64-nsis': {
        signature: signatureText,
        url: `${RELEASE_BASE}/${context.tag}/${filename}`,
      },
    },
  };
  const manifestPath = path.join(outputDir, 'latest-installer.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const metadata = {
    tag: context.tag,
    version: context.version,
    commit: context.sha,
    installer: filename,
    installerSourcePath: sourceInstaller,
    installerSha256: sha256(outputInstaller),
    signature: path.basename(outputSignature),
    tools: { node: process.version, tauriCli },
    signerEvidence: evidenceRecords,
  };
  const metadataPath = path.join(outputDir, 'release-metadata.json');
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const checksumsPath = path.join(outputDir, 'SHA256SUMS.txt');
  const sumFiles = [outputInstaller, outputSignature, manifestPath, metadataPath];
  writeFileSync(checksumsPath, sumFiles.map((file) => `${sha256(file)}  ${path.basename(file)}`).join('\n') + '\n', 'utf8');
  return { directory: outputDir, installer: outputInstaller, signature: outputSignature, manifest: manifestPath, metadata: metadataPath, checksums: checksumsPath };
}
