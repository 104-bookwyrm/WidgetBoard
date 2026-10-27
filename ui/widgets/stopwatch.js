// Stopwatch that counts up. Each finished run goes to the shared time log (timelog.js) in the stopwatch's category
// (focus / other); the total is that category's time from every widget, pomodoros included.
// Stores start timestamps (not ticks): it stays exact through sleep. Closing the app stops it (app.js leftover).
// The face shows only the time and two icon buttons; category, total, "reset total" and the laps are in the menu.
//   session: this run (reset with the reset button when stopped); laps belong to the session
//   total: the category's logged time since "reset total", which counts from then on and deletes nothing
import { icon } from "../icons.js";
import { CATS, spent, total as logTotal, readLog, addEntry, cutEntry, askAway } from "../timelog.js";
import { p2, fmtTotal } from "./timekit.js";

export { fmtTotal };

// whole seconds, the hour only once there is one
function fmtSession(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

const css = `
    .sw { height: 100%; box-sizing: border-box; padding: calc(var(--head-h) - 4px) var(--pad) var(--pad);
      display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 7cqh; }
    .sw-main { font-size: min(calc(108cqw / var(--len, 5)), 34cqh); font-weight: 600; line-height: 1; font-family: var(--font-num, var(--font));
      font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
    .sw.running .sw-main { color: var(--c2); }
    .sw-ctrl { display: flex; gap: var(--space-3); flex: none; max-width: 100%; }
    /* icon-only: the label stays as the button's title (tooltip and screen-reader name) */
    .sw-ctrl .lbl { display: none; }
    @container (max-height: 5.5em) { .sw-ctrl { display: none; } }
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
      <div class="tw-mode">${icon("stopwatch")}</div>
      <div class="sw-main" role="timer"></div>
      <div class="sw-ctrl">
        <button class="primary" data-a="go"></button>
        <button data-a="lap"></button>
      </div>
    </div>`;
  const box = root.firstElementChild;
  const q = (c) => box.querySelector(c);
  let log = []; // the shared time log, re-read when another widget adds to it
  const running = () => ({ start: s.startedAt, end: Date.now(), cuts: s.cuts });
  const run = () => (s.startedAt ? spent(running()) : 0);
  const session = () => s.elapsed + run();
  const total = () => logTotal(log, s.cat, s.since) + (s.startedAt ? spent(running(), s.since) : 0);

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
    const shown = fmtSession(session());
    if (main.textContent !== shown) {
      main.textContent = shown;
      main.style.setProperty("--len", Math.max(5, shown.length));
    }
    // the category's total is a tooltip, not text on the face
    main.title = `${t("time." + s.cat)} · ${t("sw.total")} ${fmtTotal(total())}`;
    box.classList.toggle("running", !!s.startedAt);
    const go = q("[data-a=go]");
    label(go, s.startedAt ? "sw.stop" : session() ? "sw.resume" : "sw.start", s.startedAt ? "pause" : "play");
    const lap = q("[data-a=lap]");
    label(lap, s.startedAt ? "sw.lap" : "sw.reset", s.startedAt ? "flag" : "reset");
    const off = !s.startedAt && !session();
    if (lap.disabled !== off) lap.disabled = off;
  }
  function renderAway() {
    askAway(api, t("widget.stopwatch"), s.away, fmtTotal, answerAway, s.cat);
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

  /** A running stopwatch splits its run: the time so far stays in the old category. */
  function setCat(c) {
    if (c === s.cat) return;
    const was = !!s.startedAt;
    if (was) stop();
    s.cat = c;
    if (was) start();
    api.save();
    render();
  }

  box.addEventListener("pointerdown", () => s.away && renderAway()); // another toast replaced the question: ask again
  box.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "go") s.startedAt ? stop() : start();
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
  renderAway();
  render();
  loop();
  load();
  return {
    destroy: () => clearInterval(tick),
    // before a switch to another mode: the run ends and goes to the record; an open keep / take-out question keeps it
    halt() {
      if (s.startedAt) stop();
      if (s.away) answerAway(true);
    },
    menu: () => [
      {
        text: t("sw.cat_menu"),
        items: CATS.map((c) => ({ text: (s.cat === c ? "✓ " : "") + t("time." + c), action: () => setCat(c) })),
      },
      // the total counts from now on; the log keeps everything, so nothing is lost
      { text: t("sw.reset_total_menu"), action: () => ((s.since = Date.now()), api.save(), render()) },
      ...(s.laps.length
        ? [
            {
              text: t("sw.laps_menu", { n: s.laps.length }),
              items: s.laps.map((l) => ({
                text: `#${Number(l.n) || ""}   +${fmtSession(l.split)}   ${fmtSession(l.at)}`,
                enabled: false,
              })),
            },
          ]
        : []),
    ],
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
  /** The keys shared between modes, at rest. */
  idle: () => ({ remaining: 0, endAt: null, startedAt: null, runId: null, cuts: [], away: null }),
};
