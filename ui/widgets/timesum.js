// Time summary: today's (or this week's) logged time from the shared time log (timelog.js), with what the timers
// are counting right now added live (their "time-running" broadcasts). The face is the number, a goal bar when a
// goal is set and an optional strip of today's timeline; period, category, tag and goal live in the menu.
import { spent, readLog, watchEvents } from "../timelog.js";
import { ymd, parseYmd, addDays, weekFirstDay, formatTime } from "../util.js";

const DAY = 86400000;
const PERIODS = ["today", "week"];
const SCOPES = ["focus", "other", "all"];
// goal choices in hours, per period
const GOALS = { today: [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8], week: [5, 10, 15, 20, 25, 30, 40] };

export default {
  size: { w: 2, h: 2 },
  min: { w: 2, h: 1 },
  defaults: { period: "today", scope: "focus", tag: "", goal: 0, line: false }, // goal in minutes, 0 = none
  css: `
    .ts { position: absolute; inset: 0; box-sizing: border-box; padding: var(--head-h) var(--pad) var(--pad);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6cqh; }
    .ts-main { font-weight: 600; line-height: 1; white-space: nowrap; font-family: var(--font-num, var(--font));
      font-variant-numeric: tabular-nums; font-size: min(calc(150cqw / var(--len, 4)), 46cqh); }
    .ts.done .ts-main { color: var(--c2); }
    .ts-bar, .ts-line { width: 100%; flex: none; border-radius: 3px; overflow: hidden; position: relative;
      background: color-mix(in srgb, var(--c3) 12%, transparent); }
    .ts-bar { height: 5px; }
    .ts-bar i { display: block; height: 100%; width: 0; background: var(--c2); transition: width .4s; }
    .ts-line { height: 8px; }
    .ts-line i { position: absolute; top: 0; bottom: 0; min-width: 1px; background: var(--c2); }
    .ts-line i.other { background: color-mix(in srgb, var(--c3) 45%, transparent); }
    body.reduce-motion .ts-bar i { transition: none; }
    @container (max-height: 5em) { .ts-line { display: none; } }
    @container (max-height: 3.6em) { .ts-bar { display: none; } }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    if (!PERIODS.includes(s.period)) s.period = "today";
    if (!SCOPES.includes(s.scope)) s.scope = "focus";
    if (typeof s.tag !== "string") s.tag = "";
    s.goal = Number.isFinite(+s.goal) && +s.goal > 0 ? Math.round(+s.goal) : 0;
    s.line = !!s.line;

    root.innerHTML = `<div class="ts"><div class="ts-main" role="timer"></div>
      <div class="ts-bar" hidden><i></i></div><div class="ts-line" hidden></div></div>`;
    const box = root.firstElementChild;
    const q = (c) => box.querySelector(c);
    let log = [];
    const runs = new Map(); // widget id -> what it counts now (timelog.js runAnnouncer)
    const events = watchEvents(api);
    let reached = null; // the period whose goal is met (its toast was shown, or it was met when first seen)
    let watching = false; // false while (re)loading: a goal already met then gets no toast

    const range = () => {
      const d = ymd();
      const first = s.period === "week" ? weekFirstDay(d) : d;
      return [parseYmd(first).getTime(), parseYmd(addDays(first, s.period === "week" ? 7 : 1)).getTime(), first];
    };
    const counts = (e) => (s.scope === "all" || e.cat === s.scope) && (!s.tag || (e.tags ?? []).includes(s.tag));
    const live = () => [...runs.values()].map((r) => ({ ...r, end: Math.min(Date.now(), r.end ?? Infinity) }));
    const within = (e, from, to) => spent({ ...e, end: Math.min(e.end, to) }, from);
    const hm = (ms) => {
      const m = Math.floor(ms / 60000);
      return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
    };
    const hours = (min) =>
      min < 60 ? t("ts.minutes", { n: min }) : min % 60 ? t("ts.hm", { h: Math.floor(min / 60), m: min % 60 }) : t("ts.hours", { n: min / 60 });
    /** What this widget counts, in words (the tooltip, the screen reader). */
    const what = () =>
      [t("ts." + s.period), s.scope === "all" ? t("ts.all") : t("time." + s.scope), ...(s.tag ? ["#" + s.tag] : [])].join(" · ");

    function render() {
      const [from, to, key] = range();
      const list = [...log, ...live()].filter(counts);
      const ms = list.reduce((n, e) => n + within(e, from, to), 0);
      const main = q(".ts-main");
      const shown = hm(ms);
      if (main.textContent !== shown) (main.textContent = shown), main.style.setProperty("--len", Math.max(4, shown.length));
      const goal = s.goal * 60000;
      const p = goal ? Math.min(1, ms / goal) : 0;
      q(".ts-bar").hidden = !goal;
      q(".ts-bar i").style.width = `${p * 100}%`;
      box.classList.toggle("done", !!goal && p >= 1);
      main.title =
        what() + (goal ? ` · ${t("ts.of_goal", { goal: hours(s.goal), p: Math.floor(p * 100) })}` : "");
      // a goal reached while watching gets one toast per period
      if (goal && p >= 1 && reached !== key) {
        if (watching) api.toast?.(t("ts.goal_done"));
        reached = key;
      }
      // today's strip: when the time was logged
      const line = q(".ts-line");
      line.hidden = !(s.line && s.period === "today");
      if (!line.hidden) {
        const day = parseYmd(ymd()).getTime();
        line.innerHTML = list
          .filter((e) => e.end > day && e.start < day + DAY)
          .map((e) => {
            const a = Math.max(e.start, day),
              b = Math.min(e.end, day + DAY);
            const tip = `${formatTime(lang, a, { hour: "numeric", minute: "2-digit" }, api.config?.ui?.timeFormat)} - ${formatTime(lang, b, { hour: "numeric", minute: "2-digit" }, api.config?.ui?.timeFormat)}`;
            return `<i class="${e.cat === "other" ? "other" : ""}" style="left:${((a - day) / DAY) * 100}%;width:${((b - a) / DAY) * 100}%" title="${tip}"></i>`;
          })
          .join("");
      }
    }

    /** Render without the goal toast (opening, a changed option, a new day). */
    const quiet = () => ((watching = false), (reached = null), render(), (watching = true));
    let first = true;
    async function load() {
      log = await readLog(api).catch(() => []);
      first ? quiet() : render();
      first = false;
    }
    api.onStore("time", load);
    api.on("time-running", (p) => {
      if (!p?.id) return;
      p.run ? runs.set(p.id, p.run) : runs.delete(p.id);
      render();
    });
    api.onDayChange(quiet);
    api.emit?.("time-running-ask"); // the timers say what they count right now
    const tick = setInterval(render, 15000); // running time grows; minutes are enough
    render();
    load();

    const set = (k, v) => () => ((s[k] = v), k === "period" && (s.goal = 0), api.save(), quiet());
    const mark = (on) => (on ? "✓ " : "");
    const tags = () =>
      [...new Set([...events().flatMap((e) => e?.tags ?? []), ...[...log, ...runs.values()].flatMap((e) => e?.tags ?? []), ...(s.tag ? [s.tag] : [])])].sort();
    return {
      destroy: () => clearInterval(tick),
      summary: () => `${what()}: ${q(".ts-main").textContent}`,
      menu: () => [
        { text: t("ts.period"), items: PERIODS.map((v) => ({ text: mark(s.period === v) + t("ts." + v), action: set("period", v) })) },
        {
          text: t("sw.cat_menu"),
          items: SCOPES.map((v) => ({ text: mark(s.scope === v) + (v === "all" ? t("ts.all") : t("time." + v)), action: set("scope", v) })),
        },
        {
          text: t("ts.tag"),
          items: [
            { text: mark(!s.tag) + t("ts.any_tag"), action: set("tag", "") },
            ...tags().map((g) => ({ text: mark(s.tag === g) + "#" + g, action: set("tag", g) })),
          ],
        },
        {
          text: t("ts.goal"),
          items: [
            { text: mark(!s.goal) + t("ts.no_goal"), action: set("goal", 0) },
            ...GOALS[s.period].map((h) => ({ text: mark(s.goal === h * 60) + hours(h * 60), action: set("goal", h * 60) })),
          ],
        },
        { text: mark(s.line) + t("ts.line"), action: () => ((s.line = !s.line), api.save(), render()) },
      ],
    };
  },
};
