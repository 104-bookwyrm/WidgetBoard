// Smoke suite: a short list of the bugs that keep coming back. Not a spec of every behaviour: when something
// breaks, debug it then. Checks state and structure, never displayed text (copy is meant to change).
import { readFile } from "node:fs/promises";
import { chromium, ready } from "./browser.mjs";

const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let fails = 0,
  passes = 0;
const ok = (cond, msg, extra = "") => (cond ? passes++ : (fails++, console.log("FAIL:", msg, extra)));
const errs = [];
const MIN = 60000;
const T0 = new Date("2026-10-13T09:00:00+09:00").getTime();
const idle = (p) => p.waitForFunction(() => window.__wbIdle?.());

async function page(widgets, extra = {}, { clock = false, path = "index.html" } = {}) {
  const p = await b.newPage({ viewport: { width: 1440, height: 810 } });
  p.on("pageerror", (e) => errs.push(e.message));
  if (clock) await p.clock.install({ time: T0 });
  await p.goto(`http://localhost:8765/${path}?lang=ko`);
  await p.evaluate(
    ({ widgets, extra }) => {
      localStorage.clear();
      localStorage.setItem("wb-widgets", JSON.stringify(widgets));
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, JSON.stringify(v));
    },
    { widgets, extra },
  );
  await p.reload();
  if (path === "index.html") await ready(p);
  return p;
}
const at = (id, type, x, y, settings = {}) => ({ id, type, x, y, w: 3, h: 3, settings });
const rect = (p, id) => p.$eval(`.widget[data-id="${id}"]`, (e) => e.getBoundingClientRect().toJSON());

// 1. every widget type the tray offers mounts without errors
{
  const groups = JSON.parse(await readFile(new URL("../ui/widgets/groups.json", import.meta.url), "utf8"));
  const types = groups.flatMap((g) => g.widgets);
  const p = await page(types.map((t, i) => at("w" + i, t, (i % 4) * 4, Math.floor(i / 4) * 3)));
  const n = await p.$$eval(".widget:not(.invalid)", (ws) => ws.length);
  ok(n === types.length, "1: every widget type mounts", `${n}/${types.length}`);
  await p.close();
}

// 2. a save survives a reload
{
  const p = await page([at("m", "memo", 0, 0)]);
  await p.fill('.widget[data-id="m"] textarea', "smoke");
  await p.waitForTimeout(1500); // the memo's own typing buffer, then the board's save
  await idle(p);
  await p.reload();
  await ready(p);
  ok((await p.inputValue('.widget[data-id="m"] textarea')) === "smoke", "2: memo text survives a reload");
  await p.close();
}

// 3. grid: arrow keys move a widget and push the neighbour aside
{
  const p = await page([at("a", "memo", 0, 0), at("b", "memo", 3, 0)]);
  await p.focus('.widget[data-id="a"] .grip');
  await p.keyboard.press("ArrowRight");
  await idle(p);
  const ws = await p.evaluate(() => __mock.widgets().map((w) => [w.id, w.x]));
  ok(JSON.stringify(ws.sort()) === JSON.stringify([["a", 1], ["b", 4]]), "3: grid move pushes the neighbour", JSON.stringify(ws));
  await p.close();
}

// 4. free mode: positions kept on the switch, one layer each, keys move by pixels
{
  const p = await page([at("a", "memo", 0, 0), at("b", "memo", 4, 0)]);
  const before = await rect(p, "b");
  await p.evaluate(() => __mock.invoke("save_config", { patch: { ui: { layoutMode: "free" } } }));
  await p.waitForTimeout(300);
  ok((await rect(p, "b")).x === before.x, "4: switching to free keeps the position");
  await p.focus('.widget[data-id="b"] .grip');
  await p.keyboard.press("ArrowRight");
  await idle(p);
  const ws = await p.evaluate(() => __mock.widgets());
  ok(new Set(ws.map((w) => w.z)).size === 2, "4: each widget has its own layer", JSON.stringify(ws.map((w) => w.z)));
  ok(ws.find((w) => w.id === "b").free.x === Math.round(before.x) + 10, "4: arrow moves 10 px", JSON.stringify(ws.find((w) => w.id === "b").free));
  await p.close();
}

// 5. time log: pomodoro focus lands in the log that focus stopwatches total
{
  const p = await page([at("s", "stopwatch", 0, 0), at("p", "pomodoro", 4, 0)], {}, { clock: true });
  await p.click('.widget[data-id="p"] [data-a=go]');
  await p.clock.runFor(MIN);
  await p.click('.widget[data-id="p"] [data-a=go]');
  await p.clock.runFor(1000);
  const log = await p.evaluate(() => JSON.parse(localStorage.getItem("wb-store-time") || "[]"));
  ok(log.length === 1 && log[0].cat === "focus" && Math.abs(log[0].end - log[0].start - MIN) < 1000, "5: one focus minute logged", JSON.stringify(log));
  await p.close();
}

// 6. closing the app stops a running stopwatch there; a crash asks
{
  const sw = at("s", "stopwatch", 0, 0, { startedAt: T0 - 30 * MIN, runId: "r1" });
  let p = await page([sw], { "wb-session": { launched: T0, closed: T0 - 10 * MIN } }, { clock: true });
  await p.clock.runFor(500);
  const d = await p.evaluate(() => __mock.content().s?.data ?? __mock.widgets()[0].settings);
  ok(d.startedAt === null && d.elapsed === 20 * MIN, "6: stopped at the close", JSON.stringify(d));
  ok(await p.$eval(".tl-away", (e) => e.hidden), "6: no question after a proper close");
  await p.close();
  p = await page([sw], { "wb-session": { launched: T0, closed: T0 - 120 * MIN } }, { clock: true });
  await p.clock.runFor(500);
  ok(!(await p.$eval(".tl-away", (e) => e.hidden)), "6: a crash asks");
  await p.close();
}

// 7. a timer rings when it runs out
{
  const p = await page([{ ...at("t", "timer", 0, 0, { duration: 2000, remaining: 2000 }), h: 2 }], {}, { clock: true });
  await p.click('.widget[data-id="t"] [data-a=go]');
  await p.clock.runFor(3000);
  ok(!!(await p.$('.widget[data-id="t"] .ringing')), "7: timer rings");
  await p.close();
}

// 8. the Settings and Library windows open
for (const path of ["settings.html", "library.html"]) {
  const p = await page([at("m", "memo", 0, 0)], {}, { path });
  await p.waitForLoadState("networkidle");
  ok((await p.$$eval("button", (x) => x.length)) > 3, `8: ${path} renders`);
  await p.close();
}

// 9. both languages have the same keys
{
  const keys = async (l) => Object.keys(JSON.parse(await readFile(new URL(`../ui/locales/${l}.json`, import.meta.url), "utf8")));
  const [en, ko] = [await keys("en"), await keys("ko")];
  const diff = [...en.filter((k) => !ko.includes(k)), ...ko.filter((k) => !en.includes(k))];
  ok(!diff.length, "9: en and ko have the same keys", diff.join(", "));
}

// 10. an old Collection widget opens as the merged Image widget and keeps pictures and labels
{
  const old = at("c", "collection", 0, 0, { items: [{ img: "a.png", label: "A" }, { img: "b.png", label: "" }] });
  const p = await page([old]);
  const cells = () => p.$$eval('.widget[data-id="c"] .coll-item', (e) => e.length);
  ok((await cells()) === 2, "10: old collection mounts as a grid", String(await cells()));
  await idle(p);
  await p.reload();
  await ready(p);
  ok((await cells()) === 2, "10: grid cells survive a reload");
  const d = await p.evaluate(() => __mock.content().c?.data);
  ok(d?.imgs?.length === 2 && d.labels?.["a.png"] === "A" && !("items" in d), "10: migrated content keeps pictures and labels", JSON.stringify(d));
  await p.close();
}

// 11. an old Audio Player widget opens as Now Playing with its file list, and keeps its tracks
{
  const old = at("a", "audioplayer", 0, 0, { tracks: [{ file: "a.mp3", label: "A" }] });
  const p = await page([old]);
  const rows = () => p.$$eval('.widget[data-id="a"] .np-track', (e) => e.length);
  ok((await rows()) === 1, "11: old audio player shows its track list", String(await rows()));
  await idle(p);
  await p.reload();
  await ready(p);
  ok((await rows()) === 1, "11: track list survives a reload");
  const d = await p.evaluate(() => __mock.content().a?.data);
  ok(d?.tracks?.length === 1 && d.tracks[0].file === "a.mp3", "11: tracks stay in the Library content", JSON.stringify(d));
  await p.close();
}

// 12. old Stopwatch and Pomodoro widgets open as the Timer widget in their mode and keep their state
{
  const lap = (n, at) => ({ n, at, split: 1000 });
  const old = [
    at("s", "stopwatch", 0, 0, { laps: [lap(1, 1000), lap(2, 2000)], cat: "other" }),
    at("p", "pomodoro", 4, 0, { work: 50 }),
  ];
  const p = await page(old);
  const modes = () => p.evaluate(() => ["s", "p"].map((id) => [!!document.querySelector(`.widget[data-id="${id}"] .sw`), !!document.querySelector(`.widget[data-id="${id}"] .pm`)]));
  ok(JSON.stringify(await modes()) === "[[true,false],[false,true]]", "12: old widgets mount in their mode", JSON.stringify(await modes()));
  await idle(p);
  await p.reload();
  await ready(p);
  ok(JSON.stringify(await modes()) === "[[true,false],[false,true]]", "12: modes survive a reload");
  const c = await p.evaluate(() => __mock.content());
  ok(c.s?.data?.laps?.length === 2 && c.s.data.cat === "other", "12: stopwatch laps stay in the Library content", JSON.stringify(c.s?.data));
  ok(c.p?.data?.work === 50, "12: pomodoro length stays in the Library content", JSON.stringify(c.p?.data));
  await p.close();
}

await b.close();
console.log(`\n${passes} passed, ${fails} failed`);
console.log("page errors:", errs);
process.exit(fails || errs.length ? 1 : 0);
