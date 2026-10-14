// Pomodoro and stopwatch on the shared time log; stop on close, crash and away questions; stopwatch buttons not rebuilt on every tick.
import { chromium, ready, settled } from "./browser.mjs";
const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
let fails = 0,
  passes = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) passes++;
  else {
    fails++;
    console.log("FAIL:", msg, extra);
  }
};
const errs = [];
const P = ".widget[data-widget=pomodoro]";
const S = ".widget[data-widget=stopwatch]";
const MIN = 60000;

async function page(widgets, extra = {}, url = "index.html?lang=ko") {
  const p = await b.newPage({ viewport: { width: 1440, height: 810 } });
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && !/404|mock failure/.test(m.text()) && errs.push(m.text()));
  await p.addInitScript(() => {
    window.__osc = 0;
    const o = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      window.__osc++;
      return o.call(this);
    };
  });
  await p.clock.install({ time: new Date("2026-10-13T09:00:00+09:00") });
  await p.goto(`http://localhost:8765/${url}`);
  await p.evaluate(
    ({ widgets, extra }) => {
      localStorage.clear();
      localStorage.setItem("wb-widgets", JSON.stringify(widgets));
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, JSON.stringify(v));
    },
    { widgets, extra },
  );
  await p.reload();
  await ready(p);
  return p;
}
const sw = (id = "s", settings = {}) => ({ id, type: "stopwatch", x: 0, y: 0, w: 3, h: 3, settings });
const pomo = (settings = {}) => ({ id: "p", type: "pomodoro", x: 4, y: 0, w: 3, h: 3, settings });
const pm = (p) =>
  p.evaluate(
    ({ P }) => ({
      phase: document.querySelector(P + " .pm-phase").textContent,
      time: document.querySelector(P + " .pm-time").textContent,
      dots: document.querySelectorAll(P + " .pm-dots i.on").length,
      running: document.querySelector(P + " .pm").classList.contains("running"),
      ringing: document.querySelector(P + " .pm").classList.contains("ringing"),
      link: document.querySelector(P + " .pm-link").textContent,
      beeps: window.__osc / 3,
    }),
    { P },
  );
const total = (p, sel = S) => p.textContent(`${sel} .sw-total b`);
const stored = (p, id) => p.evaluate((id) => __mock.content()[id]?.data, id);
const logged = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("wb-store-time") || "[]"));
// fake-clock pages: advance time until no save is queued (settled() alone would wait on a paused debounce)
const calm = async (p) => {
  for (let i = 0; i < 20 && !(await p.evaluate(() => window.__wbIdle())); i++) await p.clock.runFor(500);
};
const T0 = new Date("2026-10-13T09:00:00+09:00").getTime();

// ===== 1. a full focus block goes to the time log; a focus stopwatch's total shows it, its own run is untouched =====
{
  const p = await page([sw(), pomo()]);
  let st = await pm(p);
  ok(st.phase === "집중" && st.time === "25:00" && /오늘 0회/.test(st.link), "1: starts as a 25:00 focus block", JSON.stringify(st));
  ok((await p.textContent(`${S} .sw-cat`)) === "집중", "1: a stopwatch counts focus by default");
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(24 * MIN + 59000);
  st = await pm(p);
  ok(st.running && st.time === "00:01" && st.beeps === 0, "1: still focusing at 24:59", JSON.stringify(st));
  await p.clock.runFor(1500);
  st = await pm(p);
  ok(st.phase === "짧은 휴식" && st.time === "05:00" && !st.running && st.ringing && st.beeps === 1 && st.dots === 1,
    "1: focus ends → rings, short break waits, one dot", JSON.stringify(st));
  await p.clock.runFor(1000);
  await calm(p);
  ok((await total(p)) === "0:25:00", "1: stopwatch total +25:00", await total(p));
  ok((await p.textContent(`${S} .sw-main`)) === "00:00.0", "1: stopwatch run untouched");
  const log = await logged(p);
  ok(log.length === 1 && log[0].cat === "focus" && log[0].end - log[0].start === 25 * MIN && log[0].src === "p",
    "1: one focus entry in the log", JSON.stringify(log));
  // a break adds nothing
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(5 * MIN + 500);
  st = await pm(p);
  ok(st.phase === "집중" && (await total(p)) === "0:25:00", "1: break over → focus, total unchanged", JSON.stringify(st));
  await p.close();
}

// ===== 2. paused and skipped focus time counts too; an old stopwatch total carries over once =====
{
  const p = await page([sw("s", { total: 60 * MIN }), pomo()]);
  await p.clock.runFor(1000);
  await calm(p);
  ok((await total(p)) === "1:00:00", "2: the old total carried over", await total(p));
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(2 * MIN);
  await p.click(`${P} [data-a=go]`); // pause
  await p.clock.runFor(1000);
  ok((await total(p)) === "1:02:00", "2: pause adds the 2 min focused", await total(p));
  await p.clock.runFor(30 * MIN); // paused time is not focus
  await p.click(`${P} [data-a=go]`); // resume
  await p.clock.runFor(1 * MIN);
  await p.click(`${P} [data-a=skip]`);
  await p.clock.runFor(1000);
  const st = await pm(p);
  ok((await total(p)) === "1:03:00", "2: skip adds the 1 min since resuming", await total(p));
  ok(st.phase === "짧은 휴식" && st.dots === 0, "2: a skipped block moves on without a dot", JSON.stringify(st));
  await calm(p);
  ok((await stored(p, "s"))?.total === 0 && (await logged(p)).filter((e) => e.id === "carry-s").length === 1,
    "2: the old field is cleared once the carry entry is in the log", JSON.stringify(await stored(p, "s")));
  await p.reload();
  await ready(p);
  await p.clock.runFor(1000);
  ok((await total(p)) === "1:03:00", "2: not carried twice after a reload", await total(p));
  await p.close();
}

// ===== 3. cycle: a long break after `every` focus blocks, then a new cycle; auto-start =====
{
  const p = await page([sw(), pomo({ work: 1, short: 1, long: 2, every: 2, auto: true })]);
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(MIN + 500);
  let st = await pm(p);
  ok(st.phase === "짧은 휴식" && st.running, "3: auto-start runs the break", JSON.stringify(st));
  await p.clock.runFor(MIN + 500);
  await p.clock.runFor(MIN + 500);
  st = await pm(p);
  ok(st.phase === "긴 휴식" && st.dots === 2 && st.time.startsWith("01:5"), "3: long break after 2 blocks", JSON.stringify(st));
  await p.clock.runFor(2 * MIN + 500);
  st = await pm(p);
  ok(st.phase === "집중" && st.dots === 0, "3: new cycle", JSON.stringify(st));
  ok((await total(p)) === "0:02:00", "3: two 1-min blocks in the total", await total(p));
  ok(/오늘 2회/.test(st.link), "3: today's count", st.link);
  await p.close();
}

// ===== 4. categories: "other" leaves focus out; switching while running splits the run =====
{
  const a = sw("a"),
    o = sw("o", { cat: "other" });
  const p = await page([{ ...a, x: 0 }, { ...o, x: 4 }, { ...pomo(), x: 8 }]);
  const A = `.widget[data-id=a]`,
    O = `.widget[data-id=o]`;
  ok((await p.textContent(`${O} .sw-cat`)) === "그 외", "4: other category shown");
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(1 * MIN);
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(1000);
  ok((await total(p, A)) === "0:01:00" && (await total(p, O)) === "0:00:00", "4: pomodoro focus counts in focus only",
    `${await total(p, A)} ${await total(p, O)}`);
  await p.click(`${O} [data-a=go]`);
  await p.clock.runFor(20000);
  await p.click(`${O} [data-a=cat]`); // other → focus while running
  await p.clock.runFor(30000);
  await p.click(`${O} [data-a=go]`);
  await p.clock.runFor(1000);
  ok((await total(p, A)) === "0:01:30", "4: the 30 s after switching are focus, in every focus total", await total(p, A));
  ok((await p.textContent(`${O} .sw-main`)) === "00:50.0", "4: the session is one 50 s run", await p.textContent(`${O} .sw-main`));
  const log = await logged(p);
  ok(log.filter((e) => e.src === "o").map((e) => e.cat).join() === "other,focus", "4: two entries, one per category", JSON.stringify(log));
  await p.close();
}

// ===== 5. reset total counts from now; the log keeps everything =====
{
  const p = await page([sw("s", { total: 30 * MIN }), pomo()]);
  await p.clock.runFor(1000);
  await calm(p);
  await p.click(`${S} [data-a=reset-total]`);
  await p.click(`${S} [data-a=reset-total]`);
  ok((await total(p)) === "0:00:00", "5: total counts from now", await total(p));
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(1 * MIN);
  await p.click(`${P} [data-a=go]`);
  await p.clock.runFor(1000);
  ok((await total(p)) === "0:01:00", "5: new focus time counts after a reset", await total(p));
  ok((await logged(p)).some((e) => e.id === "carry-s"), "5: the carried time is still in the log");
  await p.close();
}

// ===== 6. a block that ended while asleep is counted once, silently =====
{
  const p = await page([sw(), pomo({ phase: "work", remaining: 25 * MIN, endAt: T0 - 5 * MIN, workFrom: T0 - 20 * MIN, runId: "w1" })]);
  await p.clock.runFor(1000);
  const st = await pm(p);
  ok(st.phase === "짧은 휴식" && !st.running && st.ringing && st.beeps === 0, "6: shows the next phase, no sound", JSON.stringify(st));
  ok((await total(p)) === "0:15:00", "6: the 15 min focused before it ended were added", await total(p));
  await calm(p);
  await p.reload();
  await ready(p);
  await p.clock.runFor(1000);
  ok((await total(p)) === "0:15:00", "6: not added twice after a reload", await total(p));
  await p.close();
}

// ===== 7. two boards (monitors): the pomodoro on one, a running stopwatch on the other =====
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 810 } });
  const open = async (display) => {
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(`http://localhost:8765/index.html?lang=ko&display=${display}`);
    return p;
  };
  const a = await open("D1");
  await a.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("wb-widgets", JSON.stringify([
      { id: "p", type: "pomodoro", display: "D1", x: 4, y: 0, w: 3, h: 3, settings: {} },
      { id: "s", type: "stopwatch", display: "D2", x: 0, y: 0, w: 3, h: 3, settings: {} },
    ]));
  });
  await a.reload();
  await ready(a);
  const d = await open("D2");
  await ready(d);
  await d.click(`${S} [data-a=go]`);
  await a.click(`${P} [data-a=go]`);
  await a.waitForTimeout(1200);
  await a.click(`${P} [data-a=go]`); // pause after ~1.2 s of focus
  await d.waitForTimeout(600);
  await d.click(`${S} [data-a=go]`); // stop it there
  await d.waitForTimeout(800);
  await settled(d);
  const data = await d.evaluate(() => __mock.content().s.data);
  const log = await logged(d);
  const focus = log.find((e) => e.src === "p");
  ok(data.startedAt === null && log.length === 2 && focus && focus.end - focus.start >= 1100 && focus.end - focus.start < 2500,
    "7: both boards' entries are in the log, the stopwatch stopped", JSON.stringify({ data, log }));
  const shown = await d.textContent(`${S} .sw-total b`);
  ok(shown === "0:00:0" + Math.floor((data.elapsed + focus.end - focus.start) / 1000), "7: its total counts both", shown);
  await ctx.close();
}

// ===== 8. closing the app stops them; a crash asks =====
{
  // closed properly 10 min ago: each stops where it was then
  const p = await page(
    [
      sw("s", { startedAt: T0 - 30 * MIN, runId: "r1" }),
      pomo({ phase: "work", remaining: 25 * MIN, endAt: T0 + 5 * MIN, runStart: T0 - 20 * MIN, workFrom: T0 - 20 * MIN, runId: "p1" }),
      { id: "t", type: "timer", x: 8, y: 4, w: 3, h: 3, settings: { duration: 20 * MIN, remaining: 20 * MIN, endAt: T0 + 2 * MIN, startedAt: T0 - 18 * MIN } },
    ],
    { "wb-session": { launched: T0, closed: T0 - 10 * MIN } },
  );
  await p.clock.runFor(1000);
  await calm(p);
  ok(!(await p.$eval(`${S} .sw`, (e) => e.classList.contains("running"))) && (await p.textContent(`${S} .sw-main`)) === "20:00.0",
    "8: stopwatch stopped at the close", await p.textContent(`${S} .sw-main`));
  const st = await pm(p);
  ok(!st.running && st.time === "15:00", "8: pomodoro paused with the time it had left then", JSON.stringify(st));
  ok((await p.textContent(".widget[data-widget=timer] .t-display"))?.includes("12:00"),
    "8: timer paused at the close", await p.textContent(".widget[data-widget=timer]"));
  ok((await total(p)) === "0:30:00", "8: 20 min stopwatch + 10 min focus", await total(p));
  ok(await p.$eval(`${S} .tl-away`, (e) => e.hidden), "8: no question after a proper close");
  await p.close();
}
{
  // never closed properly after it started: a crash
  const p = await page([sw("s", { startedAt: T0 - 30 * MIN, runId: "r1" })], { "wb-session": { launched: T0, closed: T0 - 120 * MIN } });
  await p.clock.runFor(1000);
  ok(/예기치 않게/.test(await p.textContent(`${S} .tl-away`)) && (await total(p)) === "0:30:00", "8: crash: stopped at launch, asks",
    await p.textContent(`${S} .tl-away`));
  await p.click(`${S} [data-a=away-cut]`);
  await p.clock.runFor(1000);
  ok((await total(p)) === "0:00:00" && (await p.textContent(`${S} .sw-main`)) === "00:00.0", "8: take out drops that run",
    `${await total(p)} ${await p.textContent(`${S} .sw-main`)}`);
  await p.close();
}

// ===== 9. time away (sleep) while counting: it counts, and asks =====
{
  const p = await page([sw()]);
  await p.click(`${S} [data-a=go]`);
  await p.clock.runFor(1 * MIN);
  await p.clock.fastForward(45 * MIN); // asleep: no ticks for 45 min
  await p.clock.runFor(200);
  ok(/0:45:00/.test(await p.textContent(`${S} .tl-away`)) && (await total(p)).startsWith("0:46"), "9: counted, and asks",
    `${await p.textContent(`${S} .tl-away`)} ${await total(p)}`);
  await p.click(`${S} [data-a=away-cut]`);
  ok((await total(p)).startsWith("0:01"), "9: take out leaves the 1 min", await total(p));
  await p.click(`${S} [data-a=go]`);
  await p.clock.runFor(1000);
  ok((await total(p)).startsWith("0:01") && (await logged(p))[0].cuts?.length === 1, "9: the log entry carries the cut", JSON.stringify(await logged(p)));
  await p.close();
}

// ===== 10. stopwatch buttons are rebuilt only when their label changes =====
{
  const p = await page([sw()]);
  await p.click(`${S} [data-a=go]`);
  const before = await p.$eval(`${S} [data-a=go] .lbl`, (e) => ((window.__lbl = e), e.textContent));
  await p.clock.runFor(2000);
  const same = await p.$eval(`${S} [data-a=go] .lbl`, (e) => e === window.__lbl && e.isConnected);
  ok(before === "정지" && same, "10: Stop label element survives the 100 ms ticks");
  await p.mouse.move(0, 0);
  const bb = await (await p.$(`${S} [data-a=go] .lbl`)).boundingBox();
  await p.mouse.move(bb.x + 5, bb.y + 5);
  await p.mouse.down();
  await p.clock.runFor(300);
  await p.mouse.up();
  ok(!(await p.$eval(`${S} .sw`, (e) => e.classList.contains("running"))), "10: a slow press on Stop stops it");
  await p.close();
}

// ===== 11. English strings, summary, small size =====
{
  const p = await page([sw(), { ...pomo(), w: 2, h: 2 }], {}, "index.html?lang=en");
  const st = await pm(p);
  ok(st.phase === "Focus" && st.time === "25:00", "11: English", JSON.stringify(st));
  const fits = await p.$eval(P, (e) => {
    const r = e.getBoundingClientRect();
    return [...e.querySelectorAll(".pm-time, .pm-ctrl")].every((c) => {
      const q = c.getBoundingClientRect();
      return !q.width || (q.left >= r.left - 1 && q.right <= r.right + 1 && q.bottom <= r.bottom + 1);
    });
  });
  ok(fits, "11: 2×2 fits");
  await p.close();
}

await b.close();
console.log(`\n${passes} passed, ${fails} failed`);
console.log("page errors:", errs);
process.exit(fails || errs.length ? 1 : 0);
