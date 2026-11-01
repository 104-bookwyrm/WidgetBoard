#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const normalizeIdentity = (file) => path.resolve(file).replaceAll('\\', '/').toLowerCase();
const nsisPlugins = new Set(['nsisdl.dll', 'startmenu.dll', 'system.dll', 'nsdialogs.dll', 'nsis_tauri_utils.dll']);

function callbackRole(file) {
  const normalized = normalizeIdentity(file);
  const basename = path.basename(file).toLowerCase();
  if (basename === 'widgetboard.exe' && normalized.includes('/src-tauri/target/release/')) return 'application';
  if (basename === 'uninstall.exe') return 'nsis-uninstaller';
  if (nsisPlugins.has(basename) && normalized.includes('/nsis/x64/plugins/x86-unicode/')) {
    const relative = normalized.split('/nsis/x64/plugins/x86-unicode/').at(-1);
    return `nsis-plugin:${relative}`;
  }
  if (/^widgetboard_.+_x64-setup\.exe$/i.test(path.basename(file))) return 'final-installer';
  return 'unclassified';
}

function requireSetting(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export async function signArtifact({ file, env = process.env, runAdapter, inspectSignature }) {
  const adapter = requireSetting(env, 'WIDGETBOARD_AUTHENTICODE_ADAPTER');
  const expectedSubject = requireSetting(env, 'WIDGETBOARD_AUTHENTICODE_SUBJECT');
  const runnerTemp = requireSetting(env, 'RUNNER_TEMP');
  const absoluteFile = path.resolve(file);
  if (!path.isAbsolute(absoluteFile)) throw new Error('PE path must be absolute');
  const before = sha256(absoluteFile);
  const result = await runAdapter(adapter, ['sign', absoluteFile]);
  if (result?.code !== 0) throw new Error(`Authenticode adapter failed with exit code ${result?.code ?? 'unknown'}`);
  const after = sha256(absoluteFile);
  if (after === before) throw new Error('Authenticode adapter left the unsigned file unchanged');
  const signature = await inspectSignature(absoluteFile);
  if (signature?.status !== 'Valid') throw new Error(`Authenticode Status must be Valid; received ${signature?.status ?? 'missing'}`);
  if (signature?.subject !== expectedSubject) throw new Error(`Authenticode subject mismatch: expected ${expectedSubject}; received ${signature?.subject ?? 'missing'}`);
  if (typeof signature?.timestampSubject !== 'string' || !signature.timestampSubject.trim()) throw new Error('Authenticode timestamp certificate is required');
  const record = {
    status: 'success',
    path: absoluteFile,
    identity: normalizeIdentity(absoluteFile),
    callbackRole: callbackRole(absoluteFile),
    sha256Before: before,
    sha256: after,
    authenticodeStatus: signature.status,
    subject: signature.subject,
    timestampSubject: signature.timestampSubject,
    timestampThumbprint: signature.timestampThumbprint ?? null,
    signedAt: new Date().toISOString(),
  };
  mkdirSync(runnerTemp, { recursive: true });
  appendFileSync(path.join(runnerTemp, 'widgetboard-authenticode.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

async function runConfiguredAdapter(adapter, args) {
  const result = spawnSync(adapter, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Authenticode adapter failed with exit code ${result.status}: ${result.stderr?.trim() ?? ''}`);
  return { code: result.status };
}

async function inspectWindowsSignature(file) {
  const script = [
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:WIDGETBOARD_PE_PATH',
    '$result = [ordered]@{ status = [string]$sig.Status; subject = [string]$sig.SignerCertificate.Subject; timestampSubject = [string]$sig.TimeStamperCertificate.Subject; timestampThumbprint = [string]$sig.TimeStamperCertificate.Thumbprint }',
    '$result | ConvertTo-Json -Compress',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, WIDGETBOARD_PE_PATH: file },
  });
  if (result.error || result.status !== 0) throw new Error(`PowerShell Authenticode inspection failed: ${result.error?.message ?? result.stderr?.trim()}`);
  try { return JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`PowerShell returned invalid Authenticode inspection JSON: ${result.stdout.trim()}`); }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Tauri must supply exactly one PE path');
    const file = process.argv[2];
    if (!file) throw new Error('Tauri must supply one PE path');
    await signArtifact({ file, runAdapter: runConfiguredAdapter, inspectSignature: inspectWindowsSignature });
  } catch (error) {
    console.error(`Authenticode signing failed: ${error.message}`);
    process.exitCode = 1;
  }
}
