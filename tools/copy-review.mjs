#!/usr/bin/env node
// Korean UI copy review (Node 18+, no packages). The owner reviews Korean only; English is a reference line.
//
//   node tools/copy-review.mjs serve [port]    Review page on http://localhost:8766 (default). Each Korean string not yet
//                                              approved is an editable box: an edit saves straight into ui/locales/ko,
//                                              승인 marks it reviewed, 메모 leaves a note for Claude.
//   node tools/copy-review.mjs status          Unreviewed keys and notes, for Claude.
//   node tools/copy-review.mjs init <commit>   Seeds tools/copy-reviewed.json: the Korean as of <commit> counts as approved.
//   node tools/copy-review.mjs test            Self-check.
//
// tools/copy-reviewed.json: { approved: { key: approved Korean text }, notes: { key: note } }. A key is unreviewed when its
// current Korean differs from its approved text, so any later edit (by anyone) puts it back on the list.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = path.join(root, "tools", "copy-reviewed.json");
const dir = (lang) => path.join(root, "ui", "locales", lang);
const files = (lang) =>
  fs.readdirSync(dir(lang), { recursive: true }).map((f) => f.replaceAll("\\", "/")).filter((f) => f.endsWith(".json")).sort();
const readJson = (lang, file) => JSON.parse(fs.readFileSync(path.join(dir(lang), file), "utf8"));

/** Every Korean key with its file, the English beside it. */
function current() {
  const out = {};
  for (const file of files("ko")) for (const [key, ko] of Object.entries(readJson("ko", file))) out[key] = { file, ko };
  for (const file of files("en")) for (const [key, en] of Object.entries(readJson("en", file))) if (out[key]) out[key].en = en;
  return out;
}
const loadSnap = () => {
  const s = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) : {};
  return { approved: s.approved ?? {}, notes: s.notes ?? {} };
};
const saveSnap = (s) => fs.writeFileSync(SNAPSHOT, JSON.stringify(s, null, 1) + "\n");

const placeholders = (s) => [...String(s ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
/** The review list: unreviewed first (new, then changed), each with its approved text and note. */
function items(snap, now, all = false) {
  return Object.entries(now)
    .map(([key, c]) => {
      const was = snap.approved[key];
      const state = was === undefined ? "new" : was === c.ko ? "ok" : "changed";
      return { key, file: c.file, ko: c.ko, en: c.en ?? "", was: was ?? null, state, note: snap.notes[key] ?? "" };
    })
    .filter((it) => all || it.state !== "ok");
}
/** Writes one Korean string into its file, keeping key order. Refuses unknown keys and lost placeholders. */
function saveKo(key, text, now = current()) {
  const c = now[key];
  if (!c) throw new Error("없는 키입니다: " + key);
  if (typeof text !== "string" || text.length > 5000) throw new Error("문구가 너무 깁니다.");
  if (c.en !== undefined && placeholders(text) !== placeholders(c.en))
    throw new Error(`저장하지 않았습니다. 영어 문구의 {${placeholders(c.en).split(",").join("} {")}}를 그대로 넣으십시오.`);
  const data = readJson("ko", c.file);
  data[key] = text;
  fs.writeFileSync(path.join(dir("ko"), c.file), JSON.stringify(data, null, 2) + "\n");
}

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>문구 검토</title><style>
:root{--bg:#f6f3ee;--card:#fff;--text:#222;--muted:#777;--line:#ddd;--accent:#c4366a;--ok:#2e7d4f;--warn:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1e1f22;--card:#2b2d31;--text:#e6e6e6;--muted:#9a9a9a;--line:#3a3c42;--accent:#e2689a;--ok:#5cc28a;--warn:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,"Malgun Gothic",sans-serif}
header{position:sticky;top:0;z-index:1;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
header b{margin-right:auto}header select,header input{font:inherit;padding:3px 6px}
main{max-width:860px;margin:0 auto;padding:12px 16px 60px;display:flex;flex-direction:column;gap:12px}
.it{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.it.ok{opacity:.75}.top{display:flex;gap:8px;align-items:baseline;font-size:.85em;color:var(--muted)}.top code{color:var(--text)}.top .f{margin-left:auto}
.tag{font-size:.75em;padding:0 6px;border-radius:999px;border:1px solid currentColor}.tag.new{color:var(--accent)}.tag.changed{color:#c77d00}.tag.ok{color:var(--ok)}
.en{color:var(--muted);font-size:.9em}.was{color:var(--muted);font-size:.85em}.was s{opacity:.8}
textarea{font:inherit;width:100%;box-sizing:border-box;resize:vertical;min-height:2.4em;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
textarea.ko{font-size:1.05em}textarea.note{font-size:.85em;min-height:1.8em}
.row{display:flex;gap:8px;align-items:center}.row .msg{margin-right:auto;font-size:.8em;color:var(--muted)}.row .msg.err{color:var(--warn)}
button{font:inherit;padding:3px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
button.ok{background:var(--accent);border-color:var(--accent);color:#fff}
.empty{text-align:center;color:var(--muted);padding:40px}
</style></head><body>
<header><b id="count"></b><select id="file"><option value="">모든 파일</option></select>
<select id="show"><option value="open">검토 전</option><option value="all">전체</option></select><input id="q" type="search" placeholder="키나 문구 검색"></header>
<main id="list"></main>
<script>
const $=(s)=>document.querySelector(s);let data=[];
const api=(p,b)=>fetch(p,b?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}:{}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error);return j});
const esc=(s)=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const label={new:"새 문구",changed:"바뀜",ok:"승인됨"};
async function load(){const r=await api("/api/items?all="+($("#show").value==="all"?1:0));data=r.items;
$("#count").textContent="검토 전 "+r.open+" · 승인 "+r.ok;
const f=$("#file"),cur=f.value;f.innerHTML='<option value="">모든 파일</option>'+[...new Set(data.map(i=>i.file))].sort().map(x=>'<option>'+esc(x)+'</option>').join("");f.value=cur;draw()}
function draw(){const q=$("#q").value.trim().toLowerCase(),file=$("#file").value;
const shown=data.filter(i=>(!file||i.file===file)&&(!q||(i.key+" "+i.ko+" "+i.en).toLowerCase().includes(q)));
$("#list").innerHTML=shown.length?shown.map(i=>'<section class="it '+i.state+'" data-key="'+esc(i.key)+'">'+
'<div class="top"><code>'+esc(i.key)+'</code><span class="tag '+i.state+'">'+label[i.state]+'</span><span class="f">'+esc(i.file)+'</span></div>'+
'<div class="en">EN '+esc(i.en)+'</div>'+
'<textarea class="ko" rows="1">'+esc(i.ko)+'</textarea>'+
(i.state==="changed"?'<div class="was">승인본: <s>'+esc(i.was)+'</s></div>':'')+
'<textarea class="note" rows="1" placeholder="메모 (Claude에게)">'+esc(i.note)+'</textarea>'+
'<div class="row"><span class="msg"></span>'+(i.state==="ok"?'':'<button class="ok" data-a="approve">승인</button>')+'</div></section>').join("")
:'<p class="empty">검토할 문구가 없습니다.</p>';
for(const t of document.querySelectorAll("textarea"))fit(t)}
const fit=(t)=>{t.style.height="auto";t.style.height=t.scrollHeight+2+"px"};
const msg=(sec,text,err)=>{const m=sec.querySelector(".msg");m.textContent=text;m.classList.toggle("err",!!err)};
async function saveKo(sec){const key=sec.dataset.key,it=data.find(i=>i.key===key),t=sec.querySelector(".ko");
if(t.value===it.ko)return true;try{await api("/api/save",{key,ko:t.value});it.ko=t.value;msg(sec,"저장했습니다 (ko 파일)");return true}catch(e){msg(sec,e.message,true);return false}}
document.addEventListener("input",e=>{if(e.target.matches("textarea"))fit(e.target)});
document.addEventListener("focusout",async e=>{const sec=e.target.closest("[data-key]");if(!sec)return;
if(e.target.matches(".ko"))saveKo(sec);
if(e.target.matches(".note")){const key=sec.dataset.key,it=data.find(i=>i.key===key);if(e.target.value!==it.note){await api("/api/note",{key,note:e.target.value});it.note=e.target.value;msg(sec,"메모를 남겼습니다")}}});
document.addEventListener("click",async e=>{const b=e.target.closest("[data-a=approve]");if(!b)return;const sec=b.closest("[data-key]");
if(!(await saveKo(sec)))return;try{await api("/api/approve",{key:sec.dataset.key});await load()}catch(err){msg(sec,err.message,true)}});
for(const id of ["#file","#q"])$(id).addEventListener("input",draw);$("#show").addEventListener("change",load);
addEventListener("focus",()=>{if(!document.activeElement?.matches("textarea"))load()});load();
</script></body></html>`;

function serve(port) {
  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const body = (req) =>
    new Promise((ok, fail) => {
      let s = "";
      req.on("data", (d) => (s += d).length > 100000 && req.destroy());
      req.on("end", () => {
        try {
          ok(JSON.parse(s || "{}"));
        } catch (e) {
          fail(e);
        }
      });
    });
  http
    .createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html");
        if (req.method === "GET" && url.pathname === "/api/items") {
          const snap = loadSnap(),
            now = current(),
            list = items(snap, now, url.searchParams.get("all") === "1"),
            open = items(snap, now).length;
          return send(res, 200, { items: list.sort((a, b) => (a.state === "ok") - (b.state === "ok")), open, ok: Object.keys(now).length - open });
        }
        if (req.method !== "POST") return send(res, 404, { error: "not found" });
        const b = await body(req);
        const snap = loadSnap();
        if (url.pathname === "/api/save") saveKo(b.key, b.ko);
        else if (url.pathname === "/api/approve") {
          const c = current()[b.key];
          if (!c) throw new Error("없는 키입니다: " + b.key);
          snap.approved[b.key] = c.ko;
          delete snap.notes[b.key];
          saveSnap(snap);
        } else if (url.pathname === "/api/note") {
          if (!(b.key in current())) throw new Error("없는 키입니다: " + b.key);
          const note = String(b.note ?? "").trim().slice(0, 2000);
          if (note) snap.notes[b.key] = note;
          else delete snap.notes[b.key];
          saveSnap(snap);
        } else return send(res, 404, { error: "not found" });
        send(res, 200, { ok: true });
      } catch (e) {
        send(res, 400, { error: e.message });
      }
    })
    .listen(port, "127.0.0.1", () => console.log(`copy review on http://localhost:${port}`));
}

function selfTest() {
  const snap = { approved: { a: "가", b: "나" }, notes: {} };
  const now = { a: { file: "x.json", ko: "가", en: "A" }, b: { file: "x.json", ko: "다", en: "B" }, c: { file: "x.json", ko: "라", en: "C" } };
  const list = items(snap, now);
  console.assert(list.map((i) => i.key + ":" + i.state).join() === "b:changed,c:new", "states", list);
  console.assert(placeholders("{n}개 중 {done}") === placeholders("{done} of {n}"), "placeholder sets");
  console.assert(placeholders("{n}개") !== placeholders("{n} of {total}"), "missing placeholder caught");
  console.log("copy-review self-test done");
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "test") selfTest();
else if (cmd === "init") {
  if (!arg) throw new Error("usage: node tools/copy-review.mjs init <commit>");
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  const approved = {};
  for (const f of git("ls-tree", "-r", "--name-only", arg, "ui/locales/ko/").split("\n").filter((f) => f.endsWith(".json")))
    Object.assign(approved, JSON.parse(git("show", `${arg}:${f}`)));
  saveSnap({ approved, notes: {} });
  console.log(`${Object.keys(approved).length} Korean strings from ${arg} marked approved`);
} else if (cmd === "status") {
  const list = items(loadSnap(), current());
  for (const i of list) console.log(`${i.state.padEnd(7)} ${i.key}  ${i.ko}${i.note ? `\n        메모: ${i.note}` : ""}`);
  console.log(`${list.length} unreviewed`);
} else if (cmd === "serve") serve(+arg || 8766);
else console.log("usage: node tools/copy-review.mjs serve [port] | status | init <commit> | test");
