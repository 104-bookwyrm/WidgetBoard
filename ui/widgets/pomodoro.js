// Pomodoro: focus blocks and breaks (25 / 5 / 15 min, a long break after every 4 focus blocks by default).
// Every minute spent in a focus block (finished, paused or skipped partway) goes to the shared time log as focus
// time (timelog.js), so focus stopwatches count it in their total. Like the timer it stores end timestamps, not
// ticks, so it stays exact through sleep. Closing the app pauses it (app.js leftover).
import { icon } from "../icons.js";
import { fmt, beep, unlockAudio, fmtTotal } from "./timekit.js";
import { addEntry, cutEntry, askAway } from "../timelog.js";

const PHASES = ["work", "short", "long"];
const LIMITS = { work: [1, 180], short: [1, 60], long: [1, 120], every: [1, 12] };
const today = () => new Date().toLocaleDateString("sv"); // local YYYY-MM-DD

const DEFAULTS = {
  phase: "work",
  remaining: 25 * 60000,
  endAt: null,
  round: 0, // focus blocks finished in this cycle (the dots)
  workFrom: null, // start of the running focus time not yet in the time log
  runId: null, // its log entry id
  runStart: null, // when the running phase (re)started: tells a run from before this launch
  cuts: [], // time away taken out of the running focus time
  away: null, // { from, to, id, crash? }: the keep / take-out question
  work: 25,
  short: 5,
  long: 15,
  every: 4,
  auto: true, // the next phase starts by itself (toggle beside skip)
  day: null,
  done: 0, // focus blocks finished on `day`
};

const css = `
    .pm { height: 100%; box-sizing: border-box; padding: calc(var(--head-h) - 4px) var(--pad) var(--pad); position: relative;
      display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 5cqh; }
    .pm-top { display: flex; align-items: center; gap: var(--space-3); flex: none; max-width: 100%; font-size: var(--fs-small); }
    .pm-phase { font-weight: 600; padding: 1px 10px; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: var(--c2); color: var(--on-accent, #fff); }
    .pm.brk .pm-phase { background: color-mix(in srgb, var(--c3) 22%, transparent); color: var(--c3); }
    .pm-time { font-size: min(calc(108cqw / var(--len, 5)), 32cqh); font-weight: 600; line-height: 1; white-space: nowrap; flex: none;
      font-family: var(--font-num, var(--font)); font-variant-numeric: tabular-nums; }
    .pm.running.work .pm-time { color: var(--c2); }
    .pm.ringing .pm-phase { animation: pm-blink .7s steps(2) infinite; }
    body.reduce-motion .pm.ringing .pm-phase { animation: none; outline: 3px solid var(--c2); }
    @keyframes pm-blink { 50% { opacity: .3; } }
    .pm-ctrl { display: flex; gap: var(--space-3); flex: none; max-width: 100%; }
    /* icon-only: the label stays as the button's title (tooltip and screen-reader name) */
    .pm-ctrl .lbl { display: none; }
    .pm-ctrl [data-a=auto][aria-pressed=true] { color: var(--c2); border-color: var(--c2); }
    .pm-cap { font-size: var(--fs-small); font-weight: 600; padding: 2px 10px; border-radius: 999px; flex: none; max-width: 100%;
      background: var(--c2); color: var(--on-accent, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pm-set { position: absolute; inset: calc(var(--head-h) + 2px) 6px 6px; z-index: 7; padding: 10px; overflow-y: auto; scrollbar-width: thin;
      display: flex; flex-direction: column; gap: var(--space-4);
      background: color-mix(in srgb, var(--c1) 97%, transparent); border: var(--line-width) var(--line-style) var(--line-color);
      border-radius: calc(var(--radius) * .6); box-shadow: 0 8px 24px rgb(0 0 0 / .45); }
    .pm-set .pop-head { display: flex; gap: var(--space-3); align-items: center; }
    .pm-set .pop-head b { flex: 1; text-align: center; }
    .pm-set .pop-head button { padding: 0 7px; }
    .pm-set label { display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--fs-small); color: var(--text-muted); }
    .pm-set label.chk { flex-direction: row; align-items: center; gap: var(--space-3); color: var(--c3); }
    .pm-set label.chk input { width: auto; flex: none; }
    .pm-set input, .pm-set select { width: 100%; box-sizing: border-box; font-size: 1em; }
    .pm-set input[type=number] { background: color-mix(in srgb, var(--c3) 8%, transparent); color-scheme: var(--scheme, dark);
      border: var(--line-width) var(--line-style) color-mix(in srgb, var(--c3) 20%, transparent);
      border-radius: calc(var(--radius) * .4); padding: 3px 6px; outline: none; min-width: 0; }
    .pm-set input[type=number]:focus { border-color: var(--c2); }
    .pm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(7em, 1fr)); gap: var(--space-3); }
    @container (max-width: 13em) { .pm-ctrl [data-a=auto] { display: none; } } /* four buttons don't fit; the settings panel keeps it */
    /* ringing: the stop button shows at any size (alone, beside the digits, when short) */
    @container (max-height: 6em) { .pm-ctrl, .pm-top { display: none; } .pm.ringing { flex-direction: row; }
      .pm.ringing .pm-ctrl button:not([data-a=go]) { display: none; } }
    .pm.ringing .pm-ctrl { display: flex; }
  `;

export function pomodoro(root, s, api) {
  const { t } = api;
  // ---- repair odd saved values (hand-edited content.json etc.)
  const int = (v, [lo, hi], d) => (Number.isFinite(+v) ? Math.min(Math.max(Math.round(+v), lo), hi) : d);
  for (const k of ["work", "short", "long", "every"]) s[k] = int(s[k], LIMITS[k], DEFAULTS[k]);
  if (!PHASES.includes(s.phase)) s.phase = "work";
  const len = (ph = s.phase) => s[ph] * 60000;
  const ts = (v) => (Number.isFinite(+v) && +v > 0 ? +v : null);
  s.endAt = ts(s.endAt);
  s.workFrom = s.phase === "work" && s.endAt ? ts(s.workFrom) : null;
  s.remaining = Number.isFinite(+s.remaining) ? Math.min(Math.max(+s.remaining, 0), len()) : len();
  s.round = int(s.round, [0, 12], 0);
  s.runStart = s.endAt ? ts(s.runStart) : null;
  s.cuts = Array.isArray(s.cuts) ? s.cuts.filter((c) => Array.isArray(c) && c[1] > c[0]) : [];
  if (!(s.away && s.away.to > s.away.from)) s.away = null;
  s.auto = s.auto !== false;
  s.done = Math.max(0, Math.round(+s.done || 0));
  if (s.day !== today()) (s.day = today()), (s.done = 0);

  root.innerHTML = `
    <div class="pm">
      <div class="pm-top"><span class="pm-phase"></span></div>
      <div class="pm-time" role="timer"></div>
      <div class="pm-cap" role="status" hidden></div>
      <div class="pm-ctrl">
        <button class="primary" data-a="go"></button>
        <button data-a="skip" title="${t("pomo.skip")}"><span class="ico">${icon("next")}</span><span class="lbl">${t("pomo.skip")}</span></button>
        <button data-a="reset" title="${t("pomo.reset")}"><span class="ico">${icon("reset")}</span><span class="lbl">${t("pomo.reset")}</span></button>
        <button data-a="auto" title="${t("pomo.auto")}"><span class="ico">${icon("repeat")}</span><span class="lbl">${t("pomo.auto")}</span></button>
      </div>
      <div class="pm-set" hidden></div>
    </div>`;
  const box = root.firstElementChild;
  const q = (c) => box.querySelector(c);
  const ui = () => api.config?.ui ?? {};
  const volume = () =>
    ui().timerSound === false ? 0 : Math.min(Math.max((ui().timerVolume ?? 60) / 100, 0), 1);
  const rings = () => Math.min(Math.max(ui().timerRings ?? 10, 1), 60);
  const left = () => (s.endAt ? Math.max(0, s.endAt - Date.now()) : s.remaining);
  const ringing = () => box.classList.contains("ringing");
  let tick, ringTimer;
  let last = Date.now();

  /** Focus time from `workFrom` up to `to` goes to the time log as one entry. */
  function credit(to = Date.now()) {
    if (s.workFrom == null) return;
    const e = { id: s.runId ?? crypto.randomUUID(), cat: "focus", start: s.workFrom, end: Math.min(to, s.endAt ?? to), src: api.id };
    if (s.cuts.length) e.cuts = s.cuts;
    s.workFrom = null;
    s.cuts = [];
    if (e.end > e.start) addEntry(api, e);
  }

  // ---- rendering (buttons only when their label changes, so a press is never lost to a rebuild)
  const label = (btn, k, ico) => {
    if (btn.dataset.k === k) return;
    btn.dataset.k = k;
    btn.innerHTML = `<span class="ico">${icon(ico)}</span><span class="lbl">${t(k)}</span>`;
    btn.title = t(k);
  };
  function render() {
    const time = q(".pm-time");
    time.textContent = fmt(left());
    time.style.setProperty("--len", Math.max(5, time.textContent.length));
    const phase = t("pomo." + s.phase);
    if (q(".pm-phase").textContent !== phase) q(".pm-phase").textContent = phase;
    box.classList.toggle("running", !!s.endAt);
    box.classList.toggle("work", s.phase === "work");
    box.classList.toggle("brk", s.phase !== "work");
    if (ringing()) label(q("[data-a=go]"), "timer.stop", "bell-off");
    else
      label(
        q("[data-a=go]"),
        s.endAt ? "timer.pause" : s.remaining > 0 && s.remaining < len() ? "timer.resume" : "timer.start",
        s.endAt ? "pause" : "play",
      );
    q("[data-a=auto]").setAttribute("aria-pressed", s.auto);
  }
  // the round and today's count are the phase pill's tooltip, not text on the face
  function renderTip() {
    q(".pm-phase").title = `${t("pomo.round", { n: Math.min(s.round, s.every), total: s.every })} · ${t("pomo.today", { n: s.done })}`;
  }
  function renderAway() {
    askAway(api, t("widget.pomodoro"), s.away, fmtTotal, answerAway);
  }
  /** Keep the focus time away, or take it out (of the running block, or of its log entry once it ended). */
  function answerAway(keep) {
    const a = s.away;
    s.away = null;
    if (!keep && a) {
      const cut = [a.from, a.to];
      if (s.workFrom != null && a.id === s.runId) s.cuts.push(cut);
      else cutEntry(api, a.id, cut);
    }
    api.save();
    renderAway();
  }

  // ---- running
  function run() {
    clearInterval(tick);
    last = Date.now();
    if (s.endAt)
      tick = setInterval(() => {
        const now = Date.now(),
          gap = api.awayMs?.() ?? 0;
        // the PC slept during a focus block: it still counts (off-screen work), and asks
        if (gap && now - last >= gap && s.phase === "work" && s.workFrom != null && !s.away) {
          s.away = { from: last, to: Math.min(now, s.endAt), id: s.runId };
          api.save();
          renderAway();
        }
        last = now;
        left() <= 0 ? finish(true) : render();
      }, 250);
  }
  function begin(now = Date.now()) {
    if (s.remaining <= 0) s.remaining = len();
    s.endAt = now + s.remaining;
    s.runStart = now;
    s.workFrom = s.phase === "work" ? now : null;
    s.runId = crypto.randomUUID();
    s.cuts = [];
  }
  /** The phase after `ended`; a long break follows `every` finished focus blocks and starts a new cycle. */
  function next(ended) {
    if (ended === "work") return s.round >= s.every ? "long" : "short";
    if (ended === "long" || s.round >= s.every) s.round = 0;
    return "work";
  }
  function moveOn(ended, start) {
    s.phase = next(ended);
    s.remaining = len();
    s.endAt = null;
    s.workFrom = null;
    if (start) begin();
  }
  function finish(sound) {
    clearInterval(tick);
    const ended = s.phase;
    if (ended === "work") {
      credit(s.endAt ?? Date.now());
      s.round++;
      if (s.day !== today()) (s.day = today()), (s.done = 0);
      s.done++;
    }
    // a phase that ended while the app was closed never starts the next one by itself
    moveOn(ended, sound && s.auto);
    api.save();
    run();
    stopRing();
    box.classList.add("ringing");
    render();
    renderTip();
    if (!sound) return;
    const msg = t(ended === "work" ? "pomo.done_work" : "pomo.done_break");
    api.alert?.(msg, t("pomo.next", { phase: t("pomo." + s.phase), t: fmt(len()) }));
    let n = 0;
    const ring = (k) => {
      beep(volume());
      caption(k);
    };
    ring(1);
    ringTimer = setInterval(() => (++n >= rings() ? stopRing() : ring(n + 1)), 1500);
  }
  function caption(n) {
    const cap = q(".pm-cap");
    if (!ui().soundCaptions) return (cap.hidden = true);
    cap.textContent = volume() ? t("pomo.caption", { n, total: rings() }) : t("pomo.caption_muted");
    cap.hidden = false;
  }
  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
    box.classList.remove("ringing");
    q(".pm-cap").hidden = true;
    render();
  }
  function start() {
    unlockAudio(); // during the click, so the end-of-phase sound may play
    stopRing();
    begin();
    api.save();
    run();
    render();
  }
  function pause() {
    if (s.phase === "work") credit();
    s.remaining = left();
    s.endAt = null;
    clearInterval(tick);
    if (s.remaining <= 0) return finish(true); // paused in the moment it ran out: it still rings
    api.save();
    render();
  }
  function skip() {
    stopRing();
    clearInterval(tick);
    if (s.endAt && s.phase === "work") credit();
    moveOn(s.phase, s.auto);
    api.save();
    run();
    render();
  }
  function reset() {
    stopRing();
    clearInterval(tick);
    if (s.endAt && s.phase === "work") credit();
    Object.assign(s, { phase: "work", round: 0, endAt: null, workFrom: null });
    s.remaining = len();
    api.save();
    render();
  }

  // ---- settings panel
  const esc = (x) =>
    String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function openSettings() {
    const p = q(".pm-set");
    const num = (k) =>
      `<label>${esc(t("pomo." + k + "_min"))}<input data-f="${k}" type="number" inputmode="numeric" min="${LIMITS[k][0]}" max="${LIMITS[k][1]}" value="${s[k]}"></label>`;
    p.innerHTML = `
      <div class="pop-head"><b>${esc(t("pomo.settings"))}</b>
        <button data-a="set-close" title="${esc(t("theme.close"))}">${icon("x")}</button></div>
      <div class="pm-grid">${num("work")}${num("short")}${num("long")}${num("every")}</div>
      <label class="chk"><input data-f="auto" type="checkbox" ${s.auto ? "checked" : ""}> ${esc(t("pomo.auto"))}</label>`;
    p.hidden = false;
    p.querySelector("[data-f=work]").focus();
  }
  function closeSettings() {
    q(".pm-set").hidden = true;
    q("[data-a=go]").focus();
  }
  q(".pm-set").addEventListener("change", (e) => {
    const f = e.target.dataset.f;
    if (f === "auto") s.auto = e.target.checked;
    else if (LIMITS[f]) {
      const was = len();
      s[f] = int(e.target.value, LIMITS[f], s[f]);
      e.target.value = s[f];
      // an untouched, stopped phase takes the new length; a running or paused one keeps its own
      if (!s.endAt && s.remaining === was) s.remaining = len();
    }
    api.save();
    render();
    renderTip();
  });
  q(".pm-set").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeSettings();
    }
  });

  // While it rings, a click anywhere on the face silences it. The buttons do it in their own click (re-rendering the
  // button on pointerdown would swallow that click), and the stop button only silences: the next phase runs on.
  box.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".pm-set, button")) stopRing();
    if (s.away) renderAway(); // another toast replaced the question: ask again
  });
  box.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "go" && ringing()) return stopRing();
    if (e.target.closest(".pm-ctrl button")) stopRing(); // skip, reset or auto while it rings: silence and act
    if (a === "go") s.endAt ? pause() : start();
    else if (a === "skip") skip();
    else if (a === "auto") {
      s.auto = !s.auto;
      api.save();
      render();
    }
    else if (a === "reset") reset();
    else if (a === "set-close") closeSettings();
  });
  api.onDayChange?.(() => {
    s.day = today();
    s.done = 0;
    api.save();
    renderTip();
  });

  // Running from before this launch: the app closed properly then (pause there), or crashed (pause at this launch
  // and ask whether that focus time counts). A phase that ended before that counts, silently.
  const lo = s.endAt && api.leftover?.(s.runStart ?? 0);
  if (lo) {
    const from = s.workFrom,
      id = s.runId;
    if (s.endAt <= lo.at) finish(false);
    else {
      if (s.phase === "work") credit(lo.at);
      s.remaining = s.endAt - lo.at;
      s.endAt = null;
      api.save();
    }
    if (lo.crash && from != null) (s.away = { from, to: lo.at, id, crash: true }), api.save();
  } else if (s.endAt && s.endAt <= Date.now()) finish(false); // ended while asleep: count it, show it, no sound
  run();
  render();
  renderTip();
  renderAway();
  return {
    destroy() {
      clearInterval(tick);
      clearInterval(ringTimer);
    },
    // before a switch to another mode: pause (focus time so far goes to the record); an open question keeps it
    halt() {
      stopRing();
      if (s.endAt) pause();
      if (s.away) answerAway(true);
    },
    menu: () => [{ text: t("pomo.settings_menu"), action: openSettings }],
    summary: () => {
      const phase = t("pomo." + s.phase);
      return s.endAt
        ? t("sum.pomo_running", { phase, left: fmt(left()) })
        : s.remaining < len() && s.remaining > 0
          ? t("sum.pomo_paused", { phase, left: fmt(s.remaining) })
          : t("sum.pomo_idle", { phase, left: fmt(len()), n: s.done });
    },
  };
}

export const pmMode = {
  size: { w: 3, h: 3 },
  min: { w: 2, h: 2 },
  defaults: DEFAULTS,
  css,
  /** The keys shared between modes, at rest: the current phase untouched. */
  idle: (s) => {
    const phase = PHASES.includes(s.phase) ? s.phase : "work";
    return { remaining: (Number(s[phase]) || DEFAULTS[phase]) * 60000, endAt: null, startedAt: null, runId: null, cuts: [], away: null };
  },
};
