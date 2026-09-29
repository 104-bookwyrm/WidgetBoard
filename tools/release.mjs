#!/usr/bin/env node
// WidgetBoard release signing (Node 18+, no packages needed).
//
//   node tools/release.mjs keygen [--key <file>]
//       Makes a new release key pair. The PRIVATE key goes to <file> (default: ~/.widgetboard/updater.key) —
//       keep it safe and never commit it. The PUBLIC key is written to src-tauri/updater.pub and compiled into the app.
//       Apps built with a different public key will refuse your updates (and vice versa).
//
//   node tools/release.mjs sign <WidgetBoard.exe> --version 0.11.0 [--key <file>] [--url <download url>]
//                                [--notes "what changed"] [--out latest.json]
//       Writes latest.json for that exe. Upload BOTH files to the release. Without --url the manifest says
//       "WidgetBoard.exe", i.e. "next to latest.json" — right for GitHub's releases/latest/download/ links.
//
//   node tools/release.mjs verify <latest.json> <WidgetBoard.exe>
//       Checks a manifest + exe against src-tauri/updater.pub, the way the app will.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pubFile = path.join(root, 'src-tauri', 'updater.pub');
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const keyFile = () => opt('key', path.join(os.homedir(), '.widgetboard', 'updater.key'));
const message = (version, sha) => Buffer.from(`widgetboard-update:v1\n${version}\n${sha}\n`);
const die = (m) => (console.error('error: ' + m), process.exit(1));

if (cmd === 'keygen') {
  const file = keyFile();
  if (fs.existsSync(file)) die(`${file} already exists — refusing to overwrite a release key`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  fs.writeFileSync(pubFile, raw.toString('base64') + '\n');
  console.log(`private key: ${file}  (back it up; never commit or share it)`);
  console.log(`public key:  ${pubFile}  = ${raw.toString('base64')}`);
} else if (cmd === 'sign') {
  const exe = args.shift() || die('which exe?');
  const version = opt('version') || die('--version is required, e.g. --version 0.11.0');
  if (!/^\d+\.\d+\.\d+$/.test(version)) die('version must look like 1.2.3');
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile()));
  const bytes = fs.readFileSync(exe);
  if (bytes.subarray(0, 2).toString() !== 'MZ') die(`${exe} is not a Windows exe`);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const signature = crypto.sign(null, message(version, sha), key).toString('base64');
  const manifest = {
    version,
    notes: opt('notes', ''),
    pub_date: new Date().toISOString(),
    url: opt('url', 'WidgetBoard.exe'),
    size: bytes.length,
    sha256: sha,
    signature,
  };
  const out = opt('out', path.join(path.dirname(exe), 'latest.json'));
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out} for ${version} (${bytes.length} bytes, sha256 ${sha.slice(0, 12)}…)`);
} else if (cmd === 'verify') {
  const [mf, exe] = args;
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const bytes = fs.readFileSync(exe);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const raw = Buffer.from(fs.readFileSync(pubFile, 'utf8').trim(), 'base64');
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  const ok = crypto.verify(null, message(m.version, sha), pub, Buffer.from(m.signature, 'base64'));
  console.log(ok && (!m.sha256 || m.sha256 === sha) ? `OK: ${m.version} is signed by this app's key` : 'FAILED: signature or hash does not match');
  process.exit(ok ? 0 : 1);
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
