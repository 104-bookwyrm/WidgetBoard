import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export async function fakeAdapter(adapter, args) {
  if (adapter !== 'fake-adapter' || args[0] !== 'sign' || args.length !== 2) throw new Error('unexpected fake adapter invocation');
  const file = args[1];
  const bytes = readFileSync(file);
  writeFileSync(file, Buffer.concat([bytes, Buffer.from('\nFAKE-AUTHENTICODE-SIGNATURE')]));
  return { code: 0 };
}

export async function fakeSignatureInspector(file) {
  return { status: 'Valid', subject: 'CN=WidgetBoard Test Publisher', timestampSubject: 'CN=Test Timestamp Authority', file };
}

export function createEvidenceWriter(file) {
  return (record) => appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}
