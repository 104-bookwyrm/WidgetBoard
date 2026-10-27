// Alarm: rings at a set clock time, once or on chosen weekdays. Sound, volume, ring count and captions are the
// timer's (Settings › 타이머). The time is read in the viewer's zone (Settings time zone, else this computer's).
import { icon } from "../icons.js";
import { beep, unlockAudio } from "./timekit.js";
import { zonedToInstant, parseYmd, osZone, weekStart, formatTime } from "../util.js";

const DAY = 86400000;
// ponytail: an alarm missed by more than this (app closed, PC asleep) is skipped silently, not rung late
const GRACE = 10 * 60000;

export default {
  size: { w: 2, h: 2 },
  min: { w: 2, h: 1 },
  defaults: { time: "07:00", days: [], on: false, fired: 0 }, // days: 0 = Sunday; none = once
  css: `
    .al { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 4cqh; box-sizing: border-box; padding: var(--head-h) var(--pad) var(--pad); }
    .al-time { font-weight: 600; font-family: var(--font-num, var(--font)); font-variant-numeric: tabular-nums; line-height: 1;
      white-space: nowrap; cursor: text; font-size: min(calc(150cqw / var(--len, 5)), 40cqh); }
    .al-time input { font: inherit; font-size: .55em; max-width: 100%; color: inherit; background: none; border: 0; border-bottom: 2px solid var(--c2); outline: none; }
    .al-row { display: flex; align-items: center; gap: var(--space-2); max-width: 100%; flex: none; }
    .al-sub { font-size: var(--fs-small); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .al.off .al-time, .al.off .al-sub { color: var(--text-faint); }
    .al.ringing .al-time { color: var(--c2); animation: al-blink .7s steps(2) infinite; }
    body.reduce-motion .al.ringing .al-time { animation: none; text-decoration: underline; text-decoration-thickness: 3px; }
    @keyframes al-blink { 50% { opacity: .3; } }
    .al-cap { font-size: var(--fs-small); font-weight: 600; padding: 2px 10px; border-radius: 999px; flex: none; max-width: 100%;
      background: var(--c2); color: var(--on-accent, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @container (max-height: 5em) { .al-row { display: none; } }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    const zone = () => api.config?.ui?.currentTz || osZone();
    const ui = () => api.config?.ui ?? {};
    const volume = () => (ui().timerSound === false ? 0 : Math.min(Math.max((ui().timerVolume ?? 60) / 100, 0), 1));
    const rings = () => Math.min(Math.max(ui().timerRings ?? 10, 1), 60);

    // repair odd saved values (hand-edited layout.json etc.)
    if (!/^\d\d:\d\d$/.test(s.time)) s.time = "07:00";
    s.days = Array.isArray(s.days) ? [...new Set(s.days)].filter((d) => Number.isInteger(d) && d >= 0 && d < 7) : [];
    s.on = !!s.on;
    s.fired = Number.isFinite(+s.fired) ? +s.fired : 0;

    root.innerHTML = `
      <div class="al">
        <div class="al-time" title="${t("alarm.edit")}"></div>
        <div class="al-cap" role="status" hidden></div>
        <div class="al-row"><span class="al-sub"></span><button class="al-bell"><span class="ico">${icon("bell")}</span></button></div>
      </div>`;
    const box = root.firstElementChild;
    const timeEl = box.querySelector(".al-time");
    const subEl = box.querySelector(".al-sub");
    const bell = box.querySelector(".al-bell");
    const cap = box.querySelector(".al-cap");

    const hm = () => s.time.split(":").map(Number);
    const timeLabel = () =>
      formatTime(lang, Date.UTC(2000, 0, 1, ...hm()), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }, ui().timeFormat);
    // 2026-01-04 is a Sunday
    const dayName = (d, weekday) => new Intl.DateTimeFormat(lang, { weekday, timeZone: "UTC" }).format(Date.UTC(2026, 0, 4 + d));
    const order = () => [0, 1, 2, 3, 4, 5, 6].map((i) => (i + weekStart()) % 7);
    const is = (...ds) => s.days.length === ds.length && ds.every((d) => s.days.includes(d));
    const repeatLabel = () =>
      !s.days.length ? ""
      : s.days.length === 7 ? t("alarm.daily")
      : is(1, 2, 3, 4, 5) ? t("alarm.weekdays")
      : is(0, 6) ? t("alarm.weekends")
      : order().filter((d) => s.days.includes(d)).map((d) => dayName(d, "short")).join(" ");

    let editing = false;
    function render() {
      if (!editing) {
        timeEl.textContent = timeLabel();
        timeEl.style.setProperty("--len", Math.max(5, timeEl.textContent.length));
      }
      subEl.textContent = repeatLabel();
      box.classList.toggle("off", !s.on);
      bell.classList.toggle("primary", s.on);
      bell.setAttribute("aria-pressed", s.on);
      bell.title = t("alarm.toggle");
    }

    // any change to the alarm turns it on; a time that has just passed today waits for its next day
    function arm(on = true) {
      s.on = on;
      s.fired = Date.now();
      if (on) unlockAudio(); // during the click, so the alarm may play
      api.save();
      render();
    }

    // the latest scheduled moment at or before `now`: today's, else yesterday's (just after midnight)
    function lastDue(now) {
      const tz = zone();
      for (let back = 0; back < 2; back++) {
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now - back * DAY); // YYYY-MM-DD
        if (s.days.length && !s.days.includes(parseYmd(day).getDay())) continue;
        const at = zonedToInstant(day, s.time, tz);
        if (at <= now) return at;
      }
      return 0;
    }
    function check() {
      if (!s.on) return;
      const now = Date.now();
      const at = lastDue(now);
      if (!(at > s.fired)) return;
      s.fired = at;
      if (!s.days.length) s.on = false; // a one-time alarm turns itself off
      api.save();
      render();
      if (now - at < GRACE) ring();
    }

    let ringTimer;
    function ring() {
      stopRing();
      box.classList.add("ringing");
      api.alert?.(t("alarm.ringing"), timeLabel());
      let n = 0;
      const one = () => {
        beep(volume());
        caption(++n);
      };
      one();
      ringTimer = setInterval(() => (n >= rings() ? stopRing() : one()), 1500);
    }
    // Sound captions (Settings → 청각): say on screen what the speaker is doing
    function caption(n) {
      if (!ui().soundCaptions) return (cap.hidden = true);
      cap.textContent = volume() ? t("alarm.caption", { n, total: rings() }) : t("alarm.caption_muted");
      cap.hidden = false;
    }
    function stopRing() {
      clearInterval(ringTimer);
      box.classList.remove("ringing");
      cap.hidden = true;
    }

    // a click that silences the alarm does only that
    let hush = false;
    box.addEventListener("pointerdown", () => {
      hush = box.classList.contains("ringing");
      stopRing();
    }, true);
    const unhushed = () => !hush || (hush = false); // false once, for the click that silenced it
    bell.onclick = () => unhushed() && arm(!s.on);
    timeEl.addEventListener("click", () => {
      if (!unhushed() || editing) return;
      editing = true;
      timeEl.innerHTML = `<input type="time" value="${s.time}">`;
      const inp = timeEl.firstChild;
      inp.focus();
      const done = (commit) => {
        if (!editing) return;
        editing = false;
        if (commit && /^\d\d:\d\d/.test(inp.value)) {
          s.time = inp.value.slice(0, 5);
          arm();
        } else render();
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      });
      inp.addEventListener("blur", () => done(true));
    });

    render();
    api.onConfig?.(render); // time format (Settings › 일반)
    check(); // missed while the app was closed: settles it without ringing (past the grace) or rings now
    const tick = setInterval(check, 1000);

    return {
      destroy() {
        clearInterval(tick);
        clearInterval(ringTimer);
      },
      summary: () => (s.on ? t("sum.alarm_on", { time: timeLabel() }) : t("sum.alarm_off", { time: timeLabel() })),
      menu: () => [
        { text: (s.on ? "✓ " : "") + t("alarm.toggle"), action: () => arm(!s.on) },
        {
          text: t("alarm.repeat_menu"),
          items: [
            { text: (s.days.length ? "" : "✓ ") + t("alarm.once"), action: () => ((s.days = []), arm()) },
            { item: "Separator" },
            ...order().map((d) => ({
              text: (s.days.includes(d) ? "✓ " : "") + dayName(d, "long"),
              action: () => {
                s.days = s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort();
                arm();
              },
            })),
          ],
        },
      ],
    };
  },
};
