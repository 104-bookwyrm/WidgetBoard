// Timer widget with three modes (s.mode): "timer" (countdown, below), "stopwatch" (stopwatch.js), "pomodoro" (pomodoro.js).
// Each mode is its own renderer in its own host element, so its listeners go away with it. A switch first halts the
// current mode (a running one stops and its time goes to the record), then resets the keys the modes share (remaining,
// endAt, startedAt, runId, cuts, away); every other key belongs to one mode and is kept.
import { icon } from "../icons.js";
import { fmt, beep, unlockAudio } from "./timekit.js";
import { stopwatch, swMode } from "./stopwatch.js";
import { pomodoro, pmMode } from "./pomodoro.js";

export { fmt, beep, unlockAudio };

// "25" = 25 min, "1:30" = 1 min 30 s, "1:00:00" = 1 h
const parse = (str) => {
  str = str.trim();
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str) * 60000 || null;
  const parts = str.split(":").map(Number);
  if (!str || parts.some(isNaN)) return null;
  if (parts.length > 3 || parts.some((v) => v < 0)) return null;
  const ms = parts.reduce((acc, v) => acc * 60 + v, 0) * 1000;
  return ms > 0 ? ms : null;
};

const css = `
    .timer { height: 100%; box-sizing: border-box; padding: calc(var(--head-h) - 6px) var(--pad) var(--pad);
      display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 7cqh; }
    .t-display { font-size: min(calc(108cqw / var(--len, 5)), 34cqh); white-space: nowrap; font-weight: 600; line-height: 1; font-family: var(--font-num, var(--font));
      font-variant-numeric: tabular-nums; cursor: text; }
    .t-display input { width: 5.5ch; font: inherit; text-align: center; background: none;
      border: 0; border-bottom: 2px solid var(--c2); outline: none; }
    .t-ctrl { display: flex; gap: var(--space-3); max-width: 100%; flex: none; }
    /* icon-only: the label stays as the button's title (tooltip and screen-reader name) */
    .t-ctrl .lbl { display: none; }
    .timer.ringing .t-display { color: var(--c2); animation: t-blink .7s steps(2) infinite; }
    body.reduce-motion .timer.ringing .t-display { text-decoration: underline; text-decoration-thickness: 3px; }
    @keyframes t-blink { 50% { opacity: .3; } }
    .t-cap { font-size: var(--fs-small); font-weight: 600; padding: 2px 10px; border-radius: 999px; flex: none; max-width: 100%;
      background: var(--c2); color: var(--on-accent, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* which time widget this is (hourglass / stopwatch), where the pomodoro shows its phase pill */
    .tw-mode { color: var(--text-muted); font-size: min(10cqh, 1.5em); line-height: 1; flex: none; display: flex; }
    /* em-based, so larger text hides the buttons sooner instead of overflowing */
    /* ringing: the stop button shows at any size (beside the digits when short); reset waits until it is quiet */
    @container (max-height: 5.5em) { .t-ctrl, .tw-mode { display: none; } .timer.ringing { flex-direction: row; } }
    .timer.ringing .t-ctrl { display: flex; }
    .timer.ringing [data-a=reset] { display: none; }
  `;

// Countdown. Stores the end timestamp (not ticks), so it stays correct across sleep/restart.
function countdown(root, s, api) {
  const { t } = api;
  root.innerHTML = `
    <div class="timer">
      <div class="tw-mode">${icon("hourglass")}</div>
      <div class="t-display" title="${t("timer.hint")}"></div>
      <div class="t-cap" role="status" hidden></div>
      <div class="t-ctrl"><button class="primary" data-a="go"></button><button data-a="reset" title="${t("timer.reset")}"><span class="ico">${icon("reset")}</span><span class="lbl">${t("timer.reset")}</span></button></div>
    </div>`;
  const box = root.firstElementChild;
  const disp = box.querySelector(".t-display");
  const go = box.querySelector("[data-a=go]");
  let tick,
    ringTimer,
    editing = false;
  const ui = () => api.config?.ui ?? {};
  const volume = () =>
    ui().timerSound === false
      ? 0
      : Math.min(Math.max((ui().timerVolume ?? 60) / 100, 0), 1);
  const rings = () => Math.min(Math.max(ui().timerRings ?? 10, 1), 60);

  // repair odd saved values (hand-edited layout.json etc.)
  const num = (v, d) => (Number.isFinite(+v) && +v >= 0 ? +v : d);
  s.duration = Math.min(num(s.duration, 300000) || 300000, 99 * 3600000);
  s.remaining = Math.min(num(s.remaining, s.duration), s.duration);
  s.endAt = s.endAt ? num(s.endAt, null) : null;
  const left = () =>
    s.endAt ? Math.max(0, s.endAt - Date.now()) : s.remaining;
  const ringing = () => box.classList.contains("ringing");
  function render() {
    if (!editing) {
      disp.textContent = fmt(left());
      disp.style.setProperty("--len", Math.max(5, disp.textContent.length));
    }
    const k = ringing()
      ? "timer.stop"
      : s.endAt
        ? "timer.pause"
        : s.remaining > 0 && s.remaining < s.duration
          ? "timer.resume"
          : "timer.start";
    go.innerHTML = `<span class="ico">${icon(ringing() ? "bell-off" : s.endAt ? "pause" : "play")}</span><span class="lbl">${t(k)}</span>`;
    go.title = t(k);
    box.classList.toggle("running", !!s.endAt);
  }
  function run() {
    clearInterval(tick);
    if (!s.endAt) return;
    tick = setInterval(() => (left() <= 0 ? finish(true) : render()), 250);
  }
  function finish(sound) {
    clearInterval(tick);
    s.endAt = null;
    s.remaining = 0;
    api.save();
    box.classList.add("ringing");
    render();
    if (sound) {
      api.alert?.(t("timer.done"), fmt(s.duration));
      const ring = (n) => {
        beep(volume());
        caption(n);
      };
      let n = 0;
      ring(1);
      ringTimer = setInterval(
        () => (++n >= rings() ? stopRing() : ring(n + 1)),
        1500,
      );
    }
  }
  // Sound captions (Settings → 청각): say on screen what the speaker is doing
  const cap = box.querySelector(".t-cap");
  function caption(n) {
    if (!ui().soundCaptions) return (cap.hidden = true);
    cap.textContent = volume()
      ? t("timer.caption", { n, total: rings() })
      : t("timer.caption_muted");
    cap.hidden = false;
  }
  function stopRing() {
    clearInterval(ringTimer);
    box.classList.remove("ringing");
    cap.hidden = true;
    render();
  }
  function start() {
    unlockAudio(); // during the click, so the alarm may play
    stopRing(); // a preset started while it rings: the old ring loop would cut the next alarm short
    if (s.remaining <= 0) s.remaining = s.duration;
    s.startedAt = Date.now();
    s.endAt = s.startedAt + s.remaining;
    api.save();
    run();
    render();
  }
  function pause() {
    s.remaining = left();
    s.endAt = null;
    clearInterval(tick);
    if (s.remaining <= 0) return finish(true); // paused in the moment it ran out: it still rings
    api.save();
    render();
  }
  function setDuration(ms) {
    ms = Math.min(Math.max(ms, 1000), 99 * 3600000);
    stopRing();
    clearInterval(tick);
    Object.assign(s, { duration: ms, remaining: ms, endAt: null });
    api.save();
    render();
  }

  // While it rings, a click anywhere on the face silences it. The buttons do it in their own click (re-rendering the
  // button on pointerdown would swallow that click), and the stop button only silences: it never starts over.
  box.addEventListener("pointerdown", (e) => e.target.closest("button") || stopRing());
  go.onclick = () => (ringing() ? stopRing() : s.endAt ? pause() : start());
  box.querySelector("[data-a=reset]").onclick = () => (ringing() ? stopRing() : setDuration(s.duration));
  // Presets come from config.json (timer.presets: [{ label, time }]); label may be empty. They live in the
  // right-click menu (빠른 시작): picking one sets that time and starts it.
  const DEFAULT_PRESETS = [
    { time: "1" },
    { time: "5" },
    { time: "10" },
    { time: "25" },
  ];
  function presets() {
    const list = api.config?.timer?.presets;
    return (Array.isArray(list) ? list : DEFAULT_PRESETS).flatMap((p) => {
      const ms = parse(String(p?.time ?? ""));
      if (!ms) return [];
      const label = p.label || (ms % 60000 === 0 ? t("timer.min", { n: ms / 60000 }) : fmt(ms));
      return [{ text: label, action: () => (setDuration(ms), start()) }];
    });
  }
  disp.addEventListener("wheel", (e) => {
    if (s.endAt) return;
    e.preventDefault();
    setDuration(
      Math.round(s.duration / 60000) * 60000 +
        (e.deltaY < 0 ? 60000 : -60000),
    );
  });
  disp.addEventListener("click", () => {
    if (s.endAt || editing) return;
    editing = true;
    const shown = fmt(s.remaining || s.duration);
    disp.innerHTML = `<input value="${shown}">`;
    const inp = disp.firstChild;
    inp.focus();
    inp.select();
    const done = (commit) => {
      if (!editing) return;
      editing = false;
      const ms = commit ? parse(inp.value) : null;
      ms ? setDuration(ms) : render();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(inp.value.trim() !== shown);
      if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    });
    // clicking away keeps an edit, but an untouched display (a paused timer) keeps its duration
    inp.addEventListener("blur", () => done(inp.value.trim() !== shown));
  });

  // Finished while the app was closed/asleep: show it, no sound.
  // Counting down when the app closed (or crashed: then at this launch): paused there with the time it had left.
  const lo = s.endAt && api.leftover?.(num(s.startedAt, 0));
  if (lo && s.endAt > lo.at) {
    s.remaining = s.endAt - lo.at;
    s.endAt = null;
    api.save();
  } else if (s.endAt && s.endAt <= Date.now()) finish(false);
  run();
  render();
  return {
    destroy() {
      clearInterval(tick);
      clearInterval(ringTimer);
    },
    // before a switch to another mode: stop as the pause button would
    halt() {
      stopRing();
      if (s.endAt) pause();
    },
    menu: () => {
      const items = presets();
      return items.length ? [{ text: t("timer.presets_menu"), items }] : [];
    },
    summary: () =>
      s.endAt
        ? t("sum.timer_running", { left: fmt(left()) })
        : box.classList.contains("ringing") || s.remaining === 0
          ? t("sum.timer_done")
          : s.remaining < s.duration
            ? t("sum.timer_paused", { left: fmt(s.remaining) })
            : t("sum.timer_idle", { dur: fmt(s.duration) }),
  };
}

const timerMode = {
  size: { w: 3, h: 2 },
  min: { w: 2, h: 2 },
  defaults: { duration: 300000, remaining: 300000, endAt: null, startedAt: null },
  css,
  /** The keys shared between modes, at rest: the full duration. */
  idle: (s) => ({
    remaining: s.duration > 0 ? s.duration : timerMode.defaults.duration,
    endAt: null,
    startedAt: null,
    runId: null,
    cuts: [],
    away: null,
  }),
};

const MODES = { timer: timerMode, stopwatch: swMode, pomodoro: pmMode };
const RENDER = { timer: countdown, stopwatch, pomodoro };

// Settings saved before the modes existed have no `mode`: tell it from the keys the old widget stored.
// True when something was converted (the caller saves once).
function normalize(s) {
  if (Object.hasOwn(MODES, s.mode)) return false;
  const has = (...ks) => ks.some((k) => k in s);
  s.mode = has("laps", "elapsed", "cat", "since")
    ? "stopwatch"
    : has("phase", "round", "work", "short", "long", "every")
      ? "pomodoro"
      : "timer";
  return true;
}

// A renderer's api.on* subscriptions outlive its destroy(); through this copy they go quiet with it.
function scope(api) {
  let live = true;
  const inner = Object.create(api);
  for (const k of ["on", "onStore", "onConfig", "onDayChange"])
    if (api[k])
      inner[k] = (...args) => {
        const cb = args.pop();
        return api[k](...args, (...a) => live && cb(...a));
      };
  return { api: inner, off: () => (live = false) };
}

export default {
  size: timerMode.size,
  min: timerMode.min,
  // where modes share a key, the timer's value
  defaults: { ...pmMode.defaults, ...swMode.defaults, ...timerMode.defaults, mode: "timer" },
  css: `.tw-host { position: absolute; inset: 0; }` + css + swMode.css + pmMode.css,
  mount(root, s, api) {
    const { t } = api;
    if (normalize(s)) api.save();
    // each mode gets its own host element, so its listeners go away with it
    let host, inner, scoped;
    const start = () => {
      host = document.createElement("div");
      host.className = "tw-host";
      root.append(host);
      scoped = scope(api);
      inner = RENDER[s.mode](host, s, scoped.api);
    };
    const stop = () => {
      inner.destroy?.();
      scoped.off();
    };
    // a running mode stops first (its time goes to the record), then the shared keys reset
    const switchTo = (mode) => {
      if (s.mode === mode) return;
      inner.halt?.();
      stop();
      host.remove();
      Object.assign(s, MODES[mode].idle(s), { mode });
      start();
      api.save();
    };
    start();
    return {
      destroy: stop,
      resized: () => inner.resized?.(),
      summary: () => inner.summary(),
      menu: () => inner.menu?.() ?? [],
      // the board's change-type menu lists the modes as widgets; picking one switches here (true = handled)
      showType(type) {
        if (!Object.hasOwn(MODES, type)) return false;
        switchTo(type);
        return true;
      },
    };
  },
};
