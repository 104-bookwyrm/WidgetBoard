// Korean copy check: every string in ui/locales/ko must follow tools/glossary.json (tone patterns and banned term
// variants, some scoped to key prefixes). A hit prints `file key: text  <- rule` and fails the run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rules = JSON.parse(fs.readFileSync(path.join(root, "tools/glossary.json"), "utf8"));
const koDir = path.join(root, "ui/locales/ko");
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : [],
  );
const prefixed = (key, prefixes) => prefixes.some((p) => key === p || key.startsWith(p));
const patterns = rules.patterns.map((p) => ({ ...p, re: new RegExp(p.re) }));
const terms = rules.terms.map((t) => ({ ...t, re: new RegExp(t.ban) }));

const hits = [];
let checked = 0;
for (const file of walk(koDir)) {
  const short = path.relative(koDir, file).replaceAll("\\", "/");
  for (const [key, raw] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
    if (typeof raw !== "string" || prefixed(key, rules.skip)) continue;
    checked++;
    const text = rules.allow.reduce((s, phrase) => s.replaceAll(phrase, ""), raw);
    for (const p of patterns) {
      if (p.skipFiles?.includes(short) || p.allowKeys?.includes(key)) continue;
      if (p.re.test(text)) hits.push(`${short} ${key}: ${raw}  <- ${p.why}`);
    }
    for (const t of terms) {
      if (t.keys && !prefixed(key, t.keys)) continue;
      if (t.allowKeys?.includes(key)) continue;
      if (t.re.test(text)) hits.push(`${short} ${key}: ${raw}  <- ${t.use} (금지: ${t.ban})`);
    }
  }
}
for (const h of hits) console.log(h);
console.log(`${checked} Korean strings checked, ${hits.length} problems`);
assert.equal(hits.length, 0, "Korean copy breaks tools/glossary.json; see the list above");
