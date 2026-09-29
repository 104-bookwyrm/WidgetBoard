// Test fixtures: a throwaway key pair, fake exes and signed manifests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const msg = (v, sha) => Buffer.from(`widgetboard-update:v1\n${v}\n${sha}\n`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const key = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const pub = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
fs.writeFileSync(path.join(dir, 'pub.txt'), pub);
const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]);
fs.writeFileSync(path.join(dir, 'WidgetBoard.exe'), exe);
const man = (name, o) => fs.writeFileSync(path.join(dir, name), JSON.stringify(o));
const sig = (v, b, k = key.privateKey) => crypto.sign(null, msg(v, sha(b)), k).toString('base64');
man('good.json', { version: '0.11.0', url: 'WidgetBoard.exe', sha256: sha(exe), signature: sig('0.11.0', exe), notes: 'new' });
man('relabel.json', { version: '0.12.0', url: 'WidgetBoard.exe', signature: sig('0.11.0', exe) }); // signature for another version
man('otherkey.json', { version: '0.11.0', url: 'WidgetBoard.exe', signature: sig('0.11.0', exe, other.privateKey) });
man('badsha.json', { version: '0.11.0', url: 'WidgetBoard.exe', sha256: 'ab'.repeat(32), signature: sig('0.11.0', exe) });
const notexe = Buffer.from('hello, not a program');
fs.writeFileSync(path.join(dir, 'notexe.bin'), notexe);
man('notexe.json', { version: '0.11.0', url: 'notexe.bin', signature: sig('0.11.0', notexe) });
man('http.json', { version: '0.11.0', url: 'http://example.com/WidgetBoard.exe', signature: sig('0.11.0', exe) });
man('badver.json', { version: 'latest', url: 'WidgetBoard.exe', signature: sig('0.11.0', exe) });
fs.writeFileSync(path.join(dir, 'garbage.json'), '<html>404</html>');
