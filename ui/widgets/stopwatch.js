// Stopwatch that counts up. Each finished run goes to the shared time log (timelog.js) in the stopwatch's category
// (focus / other); the TOTAL line is that category's time from every widget, pomodoros included.
// Stores start timestamps (not ticks): it stays exact through sleep. Closing the app stops it (app.js leftover).
//   session: this run (reset with the reset button when stopped); laps belong to the session
//   total: the category's logged time since "reset total" (click twice), which counts from then on and deletes nothing
import { icon } from "../icons.js";
import { CATS, spent, total as logTotal, readLog, addEntry, cutEntry, awayHtml } from "../timelog.js";
import { p2, fmtTotal } from "./timekit.js";

export { fmtTotal };

function fmtSession(ms) {
  const t = Math.floor(ms / 100); // tenths
  const h = Math.floor(t / 36000),
    m = Math.floor((t % 36000) / 600),
    s = Math.floor((t % 600) / 10),
    d = t % 10;
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}.${d}`;
}

const css = `
    .sw { height: 100%; box-sizing: border-box; padding: calc(var(--head-h) - 4px) var(--pad) var(--pad);
      display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 5cqh; }
    .sw-main { font-size: min(calc(108cqw / var(--len, 7)), 30cqh); font-weight: 600; line-height: 1; font-family: var(--font-num, var(--font));
      font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
    .sw.running .sw-main { color: var(--c2); }
    .sw-total { font-size: var(--fs-small); color: var(--text-muted); white-space: nowrap; display: flex; gap: var(--space-3); align-items: center; flex: none;
      font-variant-numeric: tabular-nums; }
    .sw-total b { font-weight: 600; color: var(--c3); }
    .sw-total button { padding: 0 6px; font-size: var(--fs-small); }
    .sw-total .sw-cat { padding: 0 8px; border-radius: 999px; }
    .sw-total button.confirm { background: var(--danger); border-color: var(--danger); color: #fff; }
    .sw-ctrl { display: flex; gap: var(--space-3); flex: none; max-width: 100%; }
    .sw-ctrl button { white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .sw-ctrl .ico { display: none; }
    .sw-laps { align-self: stretch; flex: 1 1 0; min-height: 0; overflow-y: auto; font-size: var(--fs-meta); scrollbar-width: thin;
      font-variant-numeric: tabular-nums; }
    .sw-laps div { display: flex; justify-content: space-between; gap: var(--space-4); padding: 1px 4px; color: var(--text-muted); }
    .sw-laps div span:first-child { color: var(--text-faint); }
    /* a short widget hides the lap list: the latest lap stays as one line */
    .sw-last { display: none; }
    .sw-last div { justify-content: center; }
    @container (max-width: 12em) { .sw-ctrl .ico { display: inline; } .sw-ctrl .lbl { display: none; } }
    @container (max-height: 14em) { .sw-laps { display: none; } .sw-last.has { display: block; flex: none; } }
    @container (max-height: 6.5em) { .sw-total, .sw-last.has { display: none; } }
  `;

export function stopwatch(root, s, api) {
  const { t } = api;
  const num = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : 0);
  s.elapsed = num(s.elapsed);
  s.total = num(s.total);
  s.startedAt =
    s.startedAt && num(s.startedAt) <= Date.now() ? num(s.startedAt) : null;
  s.laps = Array.isArray(s.laps)
    ? s.laps.filter((l) => l && Number.isFinite(l.at)).slice(0, 99)
    : [];
  if (!CATS.includes(s.cat)) s.cat = "focus";
  s.since = num(s.since);
  s.cuts = Array.isArray(s.cuts) ? s.cuts.filter((c) => Array.isArray(c) && c[1] > c[0]) : [];
  if (s.startedAt && !s.runId) s.runId = crypto.randomUUID();
  if (!(s.away && s.away.to > s.away.from)) s.away = null;

  root.innerHTML = `
    <div class="sw">
      <div class="sw-main"></div>
      <div class="sw-total" title="${t("sw.total_hint")}"><button class="sw-cat" data-a="cat" title="${t("sw.cat_hint")}"></button>
        ${t("sw.total")} <b></b>
        <button data-a="reset-total" title="${t("sw.reset_total")}">${icon("reset")}</button></div>
      <div class="tl-away" role="status" hidden></div>
      <div class="sw-ctrl">
        <button class="primary" data-a="go"></button>
        <button data-a="lap"></button>
      </div>
      <div class="sw-laps"></div>
      <div class="sw-laps sw-last"></div>
    </div>`;
  const box = root.firstElementChild;
  const q = (c) => box.querySelector(c);
  let log = []; // the shared time log, re-read when another widget adds to it
  const running = () => ({ start: s.startedAt, end: Date.now(), cuts: s.cuts });
  const run = () => (s.startedAt ? spent(running()) : 0);
  const session = () => s.elapsed + run();
  const total = () => logTotal(log, s.cat, s.since) + (s.startedAt ? spent(running(), s.since) : 0);
  let confirmTimer = null;

  // Buttons are rebuilt only when their label changes, never on the 100 ms tick: replacing the element under a
  // pressed mouse button can cost the click (Stop "ignored").
  const label = (btn, k, ico) => {
    if (btn.dataset.k === k) return;
    btn.dataset.k = k;
    btn.innerHTML = `<span class="ico">${icon(ico)}</span><span class="lbl">${t(k)}</span>`;
    btn.title = t(k);
  };
  function render() {
    const main = q(".sw-main");
    main.textContent = fmtSession(session());
    main.style.setProperty("--len", Math.max(7, main.textContent.length));
    q(".sw-total b").textContent = fmtTotal(total());
    const cat = t("time." + s.cat);
    if (q(".sw-cat").textContent !== cat) q(".sw-cat").textContent = cat;
    box.classList.toggle("running", !!s.startedAt);
    const go = q("[data-a=go]");
    label(go, s.startedAt ? "sw.stop" : session() ? "sw.resume" : "sw.start", s.startedAt ? "pause" : "play");
    const lap = q("[data-a=lap]");
    label(lap, s.startedAt ? "sw.lap" : "sw.reset", s.startedAt ? "flag" : "reset");
    const off = !s.startedAt && !session();
    if (lap.disabled !== off) lap.disabled = off;
  }
  function renderAway() {
    const a = q(".tl-away");
    a.innerHTML = awayHtml(t, s.away, fmtTotal);
    a.hidden = !s.away;
  }
  function renderLaps() {
    const row = (l) =>
      `<div><span>#${Number(l.n) || ""}</span><span>+${fmtSession(l.split)}</span><span>${fmtSession(l.at)}</span></div>`;
    q(".sw-laps").hidden = !s.laps.length; // keeps the clock centred until there are laps
    q(".sw-laps").innerHTML = s.laps.map(row).join("");
    q(".sw-last").classList.toggle("has", !!s.laps.length);
    q(".sw-last").innerHTML = s.laps.length ? row(s.laps[0]) : "";
  }

  let tick,
    last = Date.now();
  function loop() {
    clearInterval(tick);
    last = Date.now();
    if (s.startedAt)
      tick = setInterval(() => {
        const now = Date.now(),
          gap = api.awayMs?.() ?? 0;
        // the PC slept with the stopwatch running: it keeps counting (off-screen work), and asks
        if (gap && now - last >= gap && !s.away) {
          s.away = { from: last, to: now, id: s.runId };
          api.save();
          renderAway();
        }
        last = now;
        render();
      }, 100);
  }
  function start() {
    s.startedAt = Date.now();
    s.runId = crypto.randomUUID();
    s.cuts = [];
    api.save();
    loop();
    render();
  }
  /** End this run at `at`: it goes to the session and, as one entry, to the time log. */
  function stop(at = Date.now()) {
    const e = { id: s.runId, cat: s.cat, start: s.startedAt, end: Math.max(at, s.startedAt), src: api.id };
    if (s.cuts.length) e.cuts = s.cuts;
    s.elapsed += spent(e);
    Object.assign(s, { startedAt: null, runId: null, cuts: [] });
    if (e.end > e.start) {
      log = [...log.filter((x) => x.id !== e.id), e];
      addEntry(api, e).then(load); // own writes are not announced back: re-read so a read in flight cannot drop it
    }
    api.save();
    loop();
    render();
  }
  /** Keep the time away, or take it out of the run (still running) or of its log entry (already stopped). */
  function answerAway(keep) {
    const a = s.away;
    s.away = null;
    if (!keep && a) {
      const cut = [a.from, a.to];
      if (s.startedAt && a.id === s.runId) s.cuts.push(cut);
      else {
        const e = log.find((x) => x.id === a.id);
        if (e) {
          const before = spent(e);
          e.cuts = [...(e.cuts ?? []), cut];
          s.elapsed = Math.max(0, s.elapsed - (before - spent(e)));
        }
        cutEntry(api, a.id, cut).then(load);
      }
    }
    api.save();
    renderAway();
    render();
  }

  box.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "go") s.startedAt ? stop() : start();
    if (a === "away-keep" || a === "away-cut") answerAway(a === "away-keep");
    if (a === "cat") {
      // a running stopwatch splits its run: the time so far stays in the old category
      const was = !!s.startedAt;
      if (was) stop();
      s.cat = CATS[(CATS.indexOf(s.cat) + 1) % CATS.length];
      if (was) start();
      api.save();
      render();
    }
    if (a === "lap") {
      if (s.startedAt) {
        const at = session();
        s.laps.unshift({
          n: (s.laps[0]?.n ?? 0) + 1,
          at,
          split: at - (s.laps[0]?.at ?? 0),
        });
        s.laps = s.laps.slice(0, 99);
      } else {
        s.elapsed = 0;
        s.laps = [];
      }
      api.save();
      renderLaps();
      render();
    }
    if (a === "reset-total") {
      // two clicks within 3 s; the total then counts from now (the log keeps everything)
      const btn = e.target.closest("button");
      if (!confirmTimer) {
        btn.classList.add("confirm");
        btn.textContent = t("sw.sure");
        confirmTimer = setTimeout(() => {
          confirmTimer = null;
          btn.classList.remove("confirm");
          btn.innerHTML = icon("reset");
        }, 3000);
        return;
      }
      clearTimeout(confirmTimer);
      confirmTimer = null;
      btn.classList.remove("confirm");
      btn.innerHTML = icon("reset");
      s.since = Date.now();
      api.save();
      render();
    }
  });

  // The time log: other widgets (pomodoros, other stopwatches) add to the same totals.
  const carryId = "carry-" + api.id;
  async function load() {
    log = await readLog(api).catch(() => []);
    if (!Array.isArray(log)) log = [];
    // the total from before the log: one entry, dated 1970 so "reset total" always leaves it out. Once it is in
    // the log the old field is cleared (an undo or restore that brings the field back finds the entry, clears again).
    if (s.total > 0) {
      if (log.some((x) => x.id === carryId)) (s.total = 0), api.save();
      else {
        const e = { id: carryId, cat: s.cat, start: 1, end: 1 + s.total, src: api.id };
        log = [...log, e];
        addEntry(api, e).then(load);
      }
    }
    render();
  }
  api.onStore?.("time", load);

  // Running from before this launch: the app closed properly then (stop there), or crashed (stop at this launch
  // and ask whether that run counts).
  const lo = s.startedAt && api.leftover?.(s.startedAt);
  if (lo) {
    const from = s.startedAt,
      id = s.runId;
    stop(lo.at);
    if (lo.crash) s.away = { from, to: lo.at, id, crash: true };
    api.save();
  }
  renderLaps();
  renderAway();
  render();
  loop();
  load();
  return {
    destroy: () => (clearInterval(tick), clearTimeout(confirmTimer)),
    summary: () =>
      t(s.startedAt ? "sum.sw_running" : "sum.sw_stopped", {
        now: fmtTotal(session()),
        total: fmtTotal(total()),
      }),
  };
}

export const swMode = {
  size: { w: 3, h: 3 },
  min: { w: 2, h: 2 },
  // total: the pre-log total, carried into the log once (see carryId)
  defaults: { startedAt: null, elapsed: 0, total: 0, laps: [], cat: "focus", since: 0, runId: null, cuts: [], away: null },
  css,
  /** Not safe to switch away: a run is going, or its keep / take-out question is unanswered. */
  busy: (s) => !!(s.startedAt || s.runId || s.away),
  /** The keys shared between modes, at rest. */
  idle: () => ({ remaining: 0, endAt: null, startedAt: null, runId: null, cuts: [], away: null }),
};
