// Calendar + to-do, two views over the SAME shared events (data/events.json):
//  • mini:  just the month grid; a dot marks days that have entries; click a day to open its list
//  • board: big month squares; click a square to open its list, double-click to write in it,
//            click an entry to edit it; entries that don't fit collapse into "+N".
// Either view can show the month or a rolling run of 1-6 weeks (widget menu › rows shown).
// The search row lights up matching entries and dims the rest; Enter / ‹ › jump between matches.
// Each widget keeps its own view and tag filter. Tag chips cycle: normal → only this tag → hidden.
// Korean public holidays are shown in both views (see ../holidays.js).
// Day and tag colours are shared by every calendar (data/calcolors.json) and stored as a palette
// number, so a theme can recolour them through --mark-1 … --mark-6.
// Calendar subscriptions (Settings > 달력, ../calsubs.js) show read-only, tagged with the subscription's name;
// they are kept apart from `events`, so nothing here can write them.
import {
  esc,
  ymd,
  parseYmd,
  addDays,
  pad,
  uid,
  wheelScrollX,
  deferWhileEditing,
  editInlineText,
  throttle,
  occursOn,
  eventDone,
  setEventDone,
  REPEATS,
  repeatEvery,
  repeatDays,
  lunarOf,
  tzOptions,
  osZone,
  dateOpts,
  fold,
} from "../util.js";
import { loadHolidays, holidayName } from "../holidays.js";
import { icon } from "../icons.js";
import { subsOf } from "../calsubs.js";

/** "14:00 회의 #work" -> { title: '회의', time: '14:00', tags: ['work'] } */
export function parseEntry(text) {
  text = String(text ?? "").slice(0, 500);
  const tags = [...text.matchAll(/#([^\s#]+)/g)].map((m) => m[1].slice(0, 40));
  let rest = text.replace(/#[^\s#]+/g, " ");
  // "@weekly" / "@매주" (and daily, monthly, yearly) mark a repeating entry; "@lunar" / "@음력" = yearly by lunar date.
  let repeat = null;
  let lunar = false;
  const lunarToken = /(^|\s)@(lunar|음력)(?=\s|$)/i;
  if (lunarToken.test(rest)) {
    repeat = "yearly";
    lunar = true;
    rest = rest.replace(lunarToken, " ");
  }
  for (const [token, kind] of [
    [/(^|\s)@(daily|매일)(?=\s|$)/i, "daily"],
    [/(^|\s)@(weekly|매주)(?=\s|$)/i, "weekly"],
    [/(^|\s)@(monthly|매월)(?=\s|$)/i, "monthly"],
    [/(^|\s)@(yearly|매년)(?=\s|$)/i, "yearly"],
  ]) {
    if (token.test(rest)) {
      repeat = kind;
      lunar = false;
      rest = rest.replace(token, " ");
    }
  }
  let time = null;
  const tm = rest.match(/(^|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/);
  if (tm) {
    time = `${pad(+tm[2])}:${tm[3]}`;
    rest = rest.replace(tm[0], " ");
  }
  return {
    title: rest.replace(/\s+/g, " ").trim(),
    time,
    tags: [...new Set(tags)],
    repeat, // 'daily' | 'weekly' | 'monthly' | 'yearly' | null: null so editing clears a previous repeat
    lunar, // yearly by the lunar date; false so editing clears it
  };
}
const unparse = (ev) =>
  [
    ev.time,
    ev.title,
    ...(ev.tags || []).map((x) => "#" + x),
    ev.repeat === "yearly" && ev.lunar ? "@lunar" : REPEATS.includes(ev.repeat) ? "@" + ev.repeat : "",
  ]
    .filter(Boolean)
    .join(" ");
// Title for the repeat marker (↻) shown on a recurring entry.
const repeatLabel = (t, ev) => t(ev.repeat === "yearly" && ev.lunar ? "cal.yearly_lunar" : "cal." + ev.repeat);
const isEvent = (e) =>
  e &&
  typeof e === "object" &&
  typeof e.date === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(e.date);
// Day/tag palette: fallbacks for themes that don't set --mark-n. Stored values are 1-based indexes.
const MARKS = ["#e5534b", "#e8913a", "#d9b836", "#4caf72", "#4a90e2", "#9b6bd6"];
const markVar = (n) =>
  Number.isInteger(n) && n >= 1 && n <= MARKS.length ? `var(--m${n})` : null;
/** Keep only valid { key: palette index } pairs. */
const cleanMarks = (o) =>
  Object.fromEntries(
    Object.entries(o && typeof o === "object" && !Array.isArray(o) ? o : {}).filter(([, n]) => markVar(n)),
  );

export default {
  size: { w: 4, h: 5 },
  min: { w: 3, h: 3 },
  defaults: { filter: {}, view: "mini" },
  // theme sheet colours after surface/accent/text (append only; see palette.js)
  palette: MARKS.map((hex, i) => ({ short: `cal.mark_${i + 1}`, v: `--mark-${i + 1}`, default: hex })),
  css: `
    .cal { position: absolute; inset: 0; padding: var(--head-h) var(--pad) var(--pad); box-sizing: border-box;
      display: flex; flex-direction: column; gap: var(--space-3);
      ${MARKS.map((hex, i) => `--m${i + 1}: var(--mark-${i + 1}, ${hex});`).join(" ")} }
    .cal-head { display: flex; align-items: center; gap: var(--space-2); flex: none; min-width: 0; }
    .cal-head button { padding: 0 7px; font-size: var(--fs-small); flex: none; }
    .cal-title { flex: 1; min-width: 0; text-align: center; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cal-filter { display: flex; gap: var(--space-2); overflow-x: auto; scrollbar-width: none; flex: none;
      mask-image: linear-gradient(to right, #000 88%, transparent); }
    .cal-filter .chip { max-width: 9em; overflow: hidden; text-overflow: ellipsis; }
    .cal-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }

    /* search row: matches light up, the rest dims */
    .cal-search { display: flex; align-items: center; gap: var(--space-2); flex: none; min-width: 0; }
    .cal-search[hidden] { display: none; }
    .cal-search input { flex: 1; min-width: 4em; box-sizing: border-box; font-size: 1em; }
    .cal-search button { padding: 0 6px; flex: none; }
    .cal-hits { font-size: var(--fs-meta); color: var(--text-muted); white-space: nowrap; flex: none; }
    .searching .cal-grid .d:not(.hit), .searching .bc:not(.hit) { opacity: .3; }
    .searching .cal-grid .d.hit { background: color-mix(in srgb, var(--c2) 22%, transparent); }
    .searching .bc-ev:not(.hit), .searching .ev:not(.hit) { opacity: .35; }
    .searching .bc-ev.hit, .searching .ev.hit { background: color-mix(in srgb, var(--c2) 22%, transparent); border-radius: var(--r-inner); }

    /* mini view */
    .cal-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--space-1);
      font-size: var(--fs-small); text-align: center; }
    .cal-grid .wd { color: var(--text-faint); font-size: var(--fs-small); align-self: end; padding-bottom: 2px; }
    .cal-grid .wd.sun { color: color-mix(in srgb, var(--hol) 80%, var(--c1)); }
    .cal-grid .wd.sat { color: color-mix(in srgb, var(--sat) 80%, var(--c1)); }
    .cal-grid .d { position: relative; border-radius: var(--r-inner); cursor: pointer; font-variant-numeric: tabular-nums;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 0; }
    .cal-grid .d:hover { background: color-mix(in srgb, var(--c3) 10%, transparent); }
    .cal-grid .d.dc { background: color-mix(in srgb, var(--day) 30%, transparent); }
    .cal-grid .d.sun, .cal-grid .d.hol { color: var(--hol); }
    .cal-grid .d.sat { color: var(--sat); }
    .cal-grid .d.other { opacity: .3; }
    .cal-grid .dn { min-width: 1.75em; line-height: 1.75em; border-radius: 999px; flex: none; }
    .cal-grid .d.today .dn { background: var(--c2); color: var(--on-accent); font-weight: 800; }
    .cal-grid .d.sel .dn { box-shadow: 0 0 0 1.5px var(--c2); }
    .cal-grid .d.today.sel .dn { box-shadow: 0 0 0 1.5px var(--c1), 0 0 0 3px var(--c2); }
    /* the dot's room is kept on every day so the numbers line up */
    .cal-grid .d::after { content: ""; width: 5px; height: 5px; border-radius: 50%; flex: none; }
    .cal-grid .d.has::after { background: var(--dot, var(--c2)); }
    .cal-grid .d.alldone::after { background: transparent; box-shadow: inset 0 0 0 1.2px currentColor; opacity: .7; }
    .cal-dayhead { font-size: var(--fs-meta); color: var(--text-muted); flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hol-name { color: var(--hol); margin-left: 6px; }
    .lun-name { color: var(--text-faint); margin-left: 6px; font-weight: 400; }
    .cal-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-1); scrollbar-width: thin; }
    .ev { display: flex; align-items: center; gap: var(--space-3); padding: 3px 4px; border-radius: var(--r-inner); min-width: 0; }
    .ev:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .ev input[type=checkbox] { accent-color: var(--c2); margin: 0; flex: none; }
    .ev-rep { flex: none; color: color-mix(in srgb, var(--c2) 55%, var(--c1)); width: 1.1em; text-align: center; }
    .bc-ev .ev-rep { font-size: .95em; width: .95em; }
    .ev-time { color: var(--c2); font-size: var(--fs-small); font-variant-numeric: tabular-nums; flex: none; }
    .ev-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
    .ev-title input, .bc-t input { width: 100%; box-sizing: border-box; font-size: 1em; }
    .ev-tags { font-size: var(--fs-meta); color: var(--text-faint); white-space: nowrap; max-width: 35%; overflow: hidden; text-overflow: ellipsis; }
    .ev.done .ev-title, .ev.done .ev-time { text-decoration: line-through; color: var(--text-faint); }
    .ev-bell { flex: none; font-size: var(--fs-meta); color: var(--text-muted); }
    .ev-link, .ev-cfg, .ev-del { padding: 0 5px; font-size: var(--fs-meta); opacity: 0; flex: none; background: none; border: 0; cursor: pointer; }
    .ev:hover .ev-link, .ev:hover .ev-cfg, .ev:hover .ev-del { opacity: .8; }
    .ev-link { color: var(--text-faint); }
    .ev:hover .ev-link { opacity: 1; }
    .ev.tc { box-shadow: inset 3px 0 var(--tag); padding-left: 7px; }
    .ev.tc .ev-tags { color: color-mix(in srgb, var(--tag) 70%, var(--c3)); }
    .cal-filter .chip.tc { box-shadow: inset 3px 0 var(--tag); }

    /* colour swatches (day colour in the day list, tag colour in details) */
    .cal-sw { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); flex: none; }
    .cal-sw button, .cal-sw button:hover { width: 1.3em; height: 1.3em; padding: 0; border: 0; border-radius: 50%; background: var(--sw); flex: none; }
    .cal-sw button:hover { filter: brightness(1.2); }
    .cal-sw button.on { box-shadow: 0 0 0 2px var(--c1), 0 0 0 3.5px var(--c3); }
    .cal-sw button.none, .cal-sw button.none:hover { background: none; box-shadow: inset 0 0 0 1.5px var(--text-faint); display: grid; place-items: center;
      color: var(--text-faint); font-size: .8em; }
    .cal-sw button.none.on { box-shadow: inset 0 0 0 1.5px var(--text-faint), 0 0 0 2px var(--c1), 0 0 0 3.5px var(--c3); }

    /* what the add box recognised, or the syntax while it's empty */
    .cal-parse { display: flex; flex-wrap: wrap; gap: var(--space-2); flex: none; font-size: var(--fs-meta); color: var(--text-faint); min-height: 1.5em; }
    .cal-parse .pc { padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--c2) 18%, transparent); color: var(--c3); }

    /* event details editor (url / time / zone / reminder) */
    .cal-ed { position: absolute; inset: calc(var(--head-h) + 2px) 6px 6px; z-index: 7; padding: 10px; overflow-y: auto;
      display: flex; flex-direction: column; gap: var(--space-4); scrollbar-width: thin;
      background: color-mix(in srgb, var(--c1) 97%, transparent); border: var(--line-width) var(--line-style) var(--line-color);
      border-radius: calc(var(--radius) * .6); box-shadow: 0 8px 24px rgb(0 0 0 / .45); }
    .cal-ed label { display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--fs-small); color: var(--text-muted); }
    .cal-ed label.cal-ed-chk { flex-direction: row; align-items: center; gap: var(--space-3); color: var(--c3); }
    .cal-ed label.cal-ed-chk input { width: auto; flex: none; }
    .cal-ed input, .cal-ed select { width: 100%; box-sizing: border-box; font-size: 1em; }
    .cal-ed-lead input { width: 5em; }
    .cal-ed-rule { display: flex; flex-direction: column; gap: var(--space-4); }
    .cal-ed-days { display: flex; gap: var(--space-2); flex-wrap: wrap; }
    .cal-ed-days button { min-width: 2em; padding: 2px 4px; }
    .cal-ed-days button[aria-pressed=true] { background: var(--c2); border-color: var(--c2); color: var(--on-accent); }
    .cal-ed-tags { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
    .cal-ed-tags .chips { display: contents; }
    .cal-ed-tags .chip { display: inline-flex; align-items: center; gap: 2px; padding: 0 2px 0 6px; border-radius: 999px;
      background: color-mix(in srgb, var(--c2) 18%, transparent); color: var(--c3); }
    .cal-ed-tags .chip button { padding: 0 2px; background: none; border: 0; }
    .cal-ed-tags .chip.tc { box-shadow: inset 0 0 0 1.5px var(--tag); }
    .cal-ed-tags .chip.picking { outline: 1.5px solid var(--c2); }
    .cal-ed-tags .chip span { cursor: pointer; }
    .cal-ed-tags input { flex: 1; min-width: 6em; width: auto; }
    .cal-ed-btns { display: flex; gap: var(--space-3); margin-top: auto; }
    .cal-ed-btns .sp { flex: 1; }
    .cal-empty { color: var(--text-faint); font-size: var(--fs-small); padding: 6px 4px; }
    .cal-add { flex: none; width: 100%; box-sizing: border-box; }

    /* board view: big writable squares */
    .cal-board { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--space-1); }
    .cal-board .wd { font-size: var(--fs-meta); color: var(--text-faint); text-align: center; }
    .cal-board .wd.sun { color: color-mix(in srgb, var(--hol) 80%, var(--c1)); }
    .cal-board .wd.sat { color: color-mix(in srgb, var(--sat) 80%, var(--c1)); }
    .bc { position: relative; min-height: 0; min-width: 0; overflow: hidden; border-radius: var(--r-inner); padding: 2px 3px;
      display: flex; flex-direction: column; cursor: text; font-size: var(--fs-meta);
      background: color-mix(in srgb, var(--c3) 5%, transparent); }
    .bc:hover { background: color-mix(in srgb, var(--c3) 11%, transparent); }
    .bc.dc { background: color-mix(in srgb, var(--day) 24%, transparent); }
    .bc-ev.tc { box-shadow: inset 2px 0 var(--tag); padding-left: 4px; }
    .bc.other { opacity: .4; }
    .bc.today { box-shadow: inset 0 0 0 1.5px var(--c2); }
    .bc-top { display: flex; gap: var(--space-2); align-items: baseline; flex: none; white-space: nowrap; overflow: hidden; }
    .bc-num { font-weight: 600; font-variant-numeric: tabular-nums; }
    .bc.sun .bc-num, .bc.hol .bc-num { color: var(--hol); }
    .bc.sat .bc-num { color: var(--sat); }
    .bc-hol { font-size: var(--fs-small); color: var(--hol); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .bc-lun { margin-left: auto; font-size: var(--fs-small); color: var(--text-faint); flex: none; font-variant-numeric: tabular-nums; }
    .bc-evs { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: var(--space-1); }
    .bc-ev { display: flex; align-items: center; gap: var(--space-2); white-space: nowrap; min-width: 0; flex: none; }
    .bc-ev input[type=checkbox] { margin: 0; width: .95em; height: .95em; flex: none; accent-color: var(--c2); }
    .bc-t { flex: 1; overflow: hidden; text-overflow: ellipsis; min-width: 0; cursor: pointer; }
    .bc-t b { color: var(--c2); font-weight: 600; }
    .bc-ev.done .bc-t { text-decoration: line-through; color: var(--text-faint); }
    .bc-more { font-size: var(--fs-small); color: var(--text-muted); cursor: pointer; flex: none; }
    .bc-more:hover { color: var(--c2); opacity: 1; }
    input.bc-add { position: absolute; left: 2px; right: 2px; bottom: 2px; z-index: 2; font-size: 1em; padding: 1px 4px; }

    /* day popover (board "+N") */
    .cal-pop { position: absolute; inset: calc(var(--head-h) + 2px) 6px 6px; z-index: 6; padding: 8px; display: flex; flex-direction: column; gap: var(--space-3);
      background: color-mix(in srgb, var(--c1) 97%, transparent); border: var(--line-width) var(--line-style) var(--line-color);
      border-radius: calc(var(--radius) * .6); box-shadow: 0 8px 24px rgb(0 0 0 / .45); }
    .pop-head { display: flex; gap: var(--space-3); align-items: center; min-width: 0; }
    .pop-head b { flex: 1; min-width: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pop-head button { padding: 0 7px; }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    if (!s.filter || typeof s.filter !== "object" || Array.isArray(s.filter))
      s.filter = {};
    if (s.view !== "board") s.view = "mini";
    let events = [];
    let subRaw = {}; // data/calsubs.json
    let subList = []; // imported entries, read-only
    let subDays = new Map(); // date -> imported entries that day
    let colors = { days: {}, tags: {} }; // shared: { days: { ymd: n }, tags: { tag: n } }
    let hol = {};
    let month = ymd().slice(0, 7) + "-01";
    let anchor = null; // rolling weeks: the first day shown (null = this week, so it follows the date)
    let query = ""; // search row text (not saved)
    let popDate = null;
    let daySw = false; // the day list's colour row is open
    let boardClick = null; // big squares: a single click waits so a double-click can type in place
    const defaultTz = () => api.config?.ui?.currentTz || osZone(); // the viewer's zone, as app.js currentTz()

    root.innerHTML = `
      <div class="cal">
        <div class="cal-head">
          <button data-a="prev">${icon("left")}</button><span class="cal-title" aria-live="polite"></span><button data-a="next">${icon("right")}</button>
          <button data-a="search" title="${esc(t("cal.search"))}" aria-expanded="false">${icon("search")}</button>
          <button data-a="today">${esc(t("cal.today"))}</button>
          <button data-a="view"></button>
        </div>
        <div class="cal-search" hidden>
          <input type="search" aria-label="${esc(t("cal.search"))}" placeholder="${esc(t("cal.search_ph"))}">
          <span class="cal-hits" aria-live="polite"></span>
          <button data-a="hit-prev" title="${esc(t("cal.hit_prev"))}">${icon("left")}</button>
          <button data-a="hit-next" title="${esc(t("cal.hit_next"))}">${icon("right")}</button>
          <button data-a="search-close" title="${esc(t("theme.close"))}">${icon("x")}</button>
        </div>
        <div class="cal-filter" title="${esc(t("cal.filter_hint"))}"></div>
        <div class="cal-body"></div>
        <div class="cal-pop" hidden></div>
        <div class="cal-ed" hidden></div>
      </div>`;
    const box = root.firstElementChild;
    const q = (c) => box.querySelector(c);
    wheelScrollX(q(".cal-filter"));
    const fmt = (opts, d) =>
      new Intl.DateTimeFormat(lang, dateOpts(opts, api.config?.ui?.dateFormat)).format(parseYmd(d));
    const dayLabel = (d) =>
      fmt({ month: "long", day: "numeric", weekday: "short" }, d);
    const holName = (d) => holidayName(hol, api.config, lang, d);
    // lunar date "9.16" (leap month "윤6.1"); shown when the widget menu's lunar option is on
    const lunarText = (d) => {
      const l = lunarOf(d);
      return `${l.leap ? t("cal.lunar_leap", { m: l.m }) : l.m}.${l.d}`;
    };
    const lunarLabel = (d) => t("cal.lunar", { date: lunarText(d) });

    const all = () => events.concat(subList);
    const allTags = () =>
      [...new Set(all().flatMap((e) => e.tags || []))].sort();
    // checklist daily routines live in the checklist only (not in every day square)
    const routine = (ev) => ev.todo && ev.repeat === "daily";
    function shown(ev) {
      if (routine(ev)) return false;
      const tags = ev.tags || [];
      if (tags.some((x) => s.filter[x] === "hide")) return false;
      const only = Object.keys(s.filter).filter((k) => s.filter[k] === "only");
      return !only.length || tags.some((x) => only.includes(x));
    }
    // occursOn and eventDone are shared from util.js so reminders and the checklist agree.
    const dayEvents = (d) =>
      events
        .filter((e) => occursOn(e, d) && shown(e))
        .concat((subDays.get(d) || []).filter(shown))
        .sort(
          (a, b) =>
            eventDone(a, d) - eventDone(b, d) ||
            (a.time ? 0 : 1) - (b.time ? 0 : 1) ||
            (a.time || "").localeCompare(b.time || ""),
        );
    const persist = () => api.store.set("events", events).catch(() => {});
    const persistColors = () => api.store.set("calcolors", colors).catch(() => {});
    const byId = (id) => events.find((e) => e.id === id);
    // ---- search: title or tag contains the text ("#" optional for tags) ----
    const searchKey = () => fold(query.trim());
    function matches(e) {
      const k = searchKey();
      if (!k) return false;
      const tag = k.replace(/^#/, "");
      return fold(e.title).includes(k) || (e.tags || []).some((x) => fold(x).includes(tag));
    }
    const hits = () => all().filter((e) => !routine(e) && shown(e) && matches(e));
    const hitCount = () => {
      if (!searchKey()) return "";
      const n = hits().length;
      return n ? t("cal.hits", { n }) : t("cal.no_hits");
    };
    /** Show the period holding `d` (month, or the rolling weeks starting at its week). */
    function showDate(d) {
      if (rolling()) {
        const { start, weeks } = monthCells();
        if (d < start || d > addDays(start, weeks * 7 - 1)) anchor = weekOf(d);
      } else if (d.slice(0, 7) !== month.slice(0, 7)) month = d.slice(0, 7) + "-01";
    }
    /** ‹ › / Enter: the next (dir 1) or previous match date outside what's shown; repeats count from their first date. */
    function hitJump(dir) {
      const dates = [...new Set(hits().map((e) => e.date))].sort();
      if (!dates.length) return;
      const { start, weeks } = monthCells();
      const [lo, hi] = rolling()
        ? [start, addDays(start, weeks * 7 - 1)]
        : [month, ymd(new Date(+month.slice(0, 4), +month.slice(5, 7), 0))];
      let to = dir > 0 ? dates.find((d) => d > hi) : dates.findLast((d) => d < lo);
      // Enter with nothing further on: land on the latest earlier match instead of doing nothing
      if (!to && dir > 0 && !dates.some((d) => d >= lo && d <= hi)) to = dates.findLast((d) => d < lo);
      if (!to) return;
      showDate(to);
      render();
    }
    // an entry takes the colour of its first coloured tag
    const tagMark = (ev) => (ev.tags || []).map((x) => markVar(colors.tags[x])).find(Boolean) || null;
    const tagAttrs = (ev) => {
      const c = tagMark(ev);
      return c ? { cls: " tc", style: ` style="--tag:${c}"` } : { cls: "", style: "" };
    };
    /** Day-cell colour vars: the day's own colour, and (small view) the dot's colour. */
    function dayAttrs(d, evs) {
      const vars = [];
      const day = markVar(colors.days[d]);
      if (day) vars.push(`--day:${day}`);
      const dot = evs.map(tagMark).find(Boolean);
      if (dot) vars.push(`--dot:${dot}`);
      return { cls: day ? "dc" : "", style: vars.length ? ` style="${vars.join(";")}"` : "" };
    }
    /** A row of palette buttons; `cur` = the chosen index (0/undefined = none). */
    const swatches = (cur) =>
      `<button class="none ${markVar(cur) ? "" : "on"}" data-a="sw" data-n="0" title="${esc(t("cal.mark_none"))}" aria-label="${esc(t("cal.mark_none"))}">${icon("x")}</button>` +
      MARKS.map(
        (_, i) =>
          `<button class="${cur === i + 1 ? "on" : ""}" data-a="sw" data-n="${i + 1}" style="--sw:var(--m${i + 1})" title="${esc(t("cal.mark_" + (i + 1)))}" aria-label="${esc(t("cal.mark_" + (i + 1)))}"></button>`,
      ).join("");
    /** Under the add box: what the text will become, or the syntax while it's empty. */
    function parseHtml(text) {
      if (!text.trim()) return esc(t("cal.syntax"));
      const p = parseEntry(text);
      return [
        p.time && p.time,
        ...p.tags.map((x) => "#" + x),
        p.repeat && t(p.lunar ? "cal.yearly_lunar" : "cal." + p.repeat),
      ]
        .filter(Boolean)
        .map((x) => `<span class="pc">${esc(x)}</span>`)
        .join("");
    }

    // ---------------- rendering ----------------
    function render() {
      const v = q("[data-a=view]");
      v.innerHTML = icon(s.view === "mini" ? "grid" : "list");
      v.title = t(s.view === "mini" ? "cal.view_board" : "cal.view_mini");
      if (rolling()) {
        const { start, weeks } = monthCells();
        // the year only when the run isn't in this year
        const md = { month: "long", day: "numeric", ...(start.slice(0, 4) !== ymd().slice(0, 4) && { year: "numeric" }) };
        q(".cal-title").textContent = `${fmt(md, start)} - ${fmt(md, addDays(start, weeks * 7 - 1))}`;
      } else q(".cal-title").textContent = fmt({ year: "numeric", month: "long" }, month);
      q("[data-a=prev]").title = t(rolling() ? "cal.prev_week" : "cal.prev_month");
      q("[data-a=next]").title = t(rolling() ? "cal.next_week" : "cal.next_month");
      box.classList.toggle("searching", !!searchKey());
      if (!q(".cal-search").hidden) q(".cal-hits").textContent = hitCount();

      const tags = allTags();
      for (const k of Object.keys(s.filter))
        if (!tags.includes(k)) delete s.filter[k];
      q(".cal-filter").hidden = !tags.length;
      q(".cal-filter").innerHTML = tags
        .map((x) => {
          const c = markVar(colors.tags[x]);
          return `<button class="chip ${s.filter[x] === "only" ? "on" : s.filter[x] === "hide" ? "off" : ""}${c ? " tc" : ""}" data-tag="${esc(x)}" title="#${esc(x)}"${c ? ` style="--tag:${c}"` : ""}>#${esc(x)}</button>`;
        })
        .join("");

      if (s.view === "mini") renderMini();
      else renderBoard();
      renderPop();
    }

    // week start: Settings → 한 주의 시작 (config ui.weekStart), Sunday by default for the calendar
    const ws = () => ((api.config?.ui?.weekStart ?? "sun") === "mon" ? 1 : 0);
    const dowOf = (i) => (ws() + i) % 7; // column index -> 0 = Sunday … 6 = Saturday
    const weekdays = () =>
      [...Array(7)].map((_, i) =>
        fmt({ weekday: "narrow" }, addDays("2023-01-01", dowOf(i))),
      );
    const wdClass = (i) =>
      dowOf(i) === 0 ? "sun" : dowOf(i) === 6 ? "sat" : "";
    // rows shown: 0 = the month, 1-6 = that many weeks from `anchor` (this week by default)
    const rolling = () => Number.isInteger(s.rows) && s.rows >= 1 && s.rows <= 6;
    const weekOf = (d) => addDays(d, -((parseYmd(d).getDay() - ws() + 7) % 7));
    function monthCells() {
      if (rolling()) return { start: anchor || weekOf(ymd()), weeks: s.rows };
      const first = parseYmd(month);
      const lead = (first.getDay() - ws() + 7) % 7;
      const start = addDays(month, -lead);
      const days = new Date(
        first.getFullYear(),
        first.getMonth() + 1,
        0,
      ).getDate();
      const weeks = Math.ceil((lead + days) / 7);
      return { start, weeks };
    }
    function dayClasses(d, i) {
      return [
        dowOf(i % 7) === 0 && "sun",
        dowOf(i % 7) === 6 && "sat",
        holName(d) && "hol",
        !rolling() && d.slice(0, 7) !== month.slice(0, 7) && "other",
        d === ymd() && "today",
      ].filter(Boolean);
    }

    function agendaHtml(d) {
      const evs = dayEvents(d);
      return evs.length
        ? evs
            .map(
              (e) => `
            <div class="ev ${eventDone(e, d) ? "done" : ""}${tagAttrs(e).cls}${matches(e) ? " hit" : ""}" data-id="${esc(e.id)}" data-d="${d}"${tagAttrs(e).style}>
              ${
                e.ro
                  ? `<span class="ev-rep" title="${esc(t("cal.imported", { name: e.tags[0] }))}">${icon("calendar")}</span>`
                  : e.dday
                  ? `<span class="ev-rep" title="${esc(t("cal.dday_item"))}">${icon("pin")}</span>`
                  : `<input type="checkbox" ${eventDone(e, d) ? "checked" : ""}>${e.repeat ? `<span class="ev-rep" title="${esc(repeatLabel(t, e))}">${icon("repeat")}</span>` : ""}`
              }
              ${e.time ? `<span class="ev-time">${esc(e.time)}</span>` : ""}
              ${e.notify ? `<span class="ev-bell" title="${esc(t("cal.notify"))}">${icon("bell")}</span>` : ""}
              <span class="ev-title" title="${esc(e.title)}${e.ro ? "" : ` - ${esc(t("cal.click_edit"))}`}">${esc(e.title)}</span>
              <span class="ev-tags" title="${esc((e.tags || []).map((x) => "#" + x).join(" "))}">${esc((e.tags || []).map((x) => "#" + x).join(" "))}</span>
              ${e.url ? `<button class="ev-link" title="${esc(e.url)}">${icon("link")}</button>` : ""}
              ${e.ro ? "" : `<button class="ev-cfg" title="${esc(t("cal.details"))}">${icon("settings")}</button>
              <button class="ev-del" title="${esc(t("dday.delete"))}">${icon("x")}</button>`}
            </div>`,
            )
            .join("")
        : `<div class="cal-empty">${esc(t("cal.empty"))}</div>`;
    }

    /** Mini view: only the month. Dots mark days with entries (hollow = all done); click a day to open its list. */
    function renderMini() {
      const { start, weeks } = monthCells();
      let html = weekdays()
        .map((w, i) => `<div class="wd ${wdClass(i)}">${esc(w)}</div>`)
        .join("");
      for (let i = 0; i < weeks * 7; i++) {
        const d = addDays(start, i);
        const evs = dayEvents(d);
        const hn = holName(d);
        const da = dayAttrs(d, evs);
        const cls = [
          "d",
          ...dayClasses(d, i),
          da.cls,
          d === popDate && "sel",
          evs.length && "has",
          evs.length && evs.every((e) => eventDone(e, d)) && "alldone",
          evs.some(matches) && "hit",
        ]
          .filter(Boolean)
          .join(" ");
        const tip = [hn, s.lunar ? lunarLabel(d) : "", evs.length ? t("cal.count", { n: evs.length }) : ""]
          .filter(Boolean)
          .join(" · ");
        const label = [dayLabel(d), tip].filter(Boolean).join(", ");
        html += `<div class="${cls}" data-d="${d}" role="button" tabindex="0" aria-label="${esc(label)}"${tip ? ` title="${esc(tip)}"` : ""}${da.style}><span class="dn">${+d.slice(8)}</span></div>`;
      }
      q(".cal-body").innerHTML =
        `<div class="cal-grid" style="grid-template-rows: auto repeat(${weeks}, minmax(0, 1fr))">${html}</div>`;
    }

    function renderBoard() {
      const { start, weeks } = monthCells();
      let html = weekdays()
        .map((w, i) => `<div class="wd ${wdClass(i)}">${esc(w)}</div>`)
        .join("");
      for (let i = 0; i < weeks * 7; i++) {
        const d = addDays(start, i);
        const hn = holName(d);
        const evs = dayEvents(d);
        const da = dayAttrs(d, []);
        html += `
          <div class="bc ${dayClasses(d, i).join(" ")} ${da.cls}${evs.some(matches) ? " hit" : ""}" data-d="${d}" tabindex="0" aria-label="${esc([dayLabel(d), hn, evs.length ? t("cal.count", { n: evs.length }) : ""].filter(Boolean).join(", "))}" title="${esc(hn || "")}"${da.style}>
            <div class="bc-top"><span class="bc-num">${+d.slice(8)}</span>${hn ? `<span class="bc-hol">${esc(hn)}</span>` : ""}${s.lunar ? `<span class="bc-lun" title="${esc(lunarLabel(d))}">${esc(lunarText(d))}</span>` : ""}</div>
            <div class="bc-evs">${evs
              .map(
                (e) => `
              <div class="bc-ev ${eventDone(e, d) ? "done" : ""}${tagAttrs(e).cls}${matches(e) ? " hit" : ""}" data-id="${esc(e.id)}" title="${esc(unparse(e))}"${tagAttrs(e).style}>
                ${
                  e.ro
                    ? `<span class="ev-rep" title="${esc(t("cal.imported", { name: e.tags[0] }))}">${icon("calendar")}</span>`
                    : e.dday
                    ? `<span class="ev-rep" title="${esc(t("cal.dday_item"))}">${icon("pin")}</span>`
                    : `<input type="checkbox" ${eventDone(e, d) ? "checked" : ""}>${e.repeat ? `<span class="ev-rep" title="${esc(repeatLabel(t, e))}">${icon("repeat")}</span>` : ""}`
                }<span class="bc-t">${e.time ? `<b>${esc(e.time)}</b> ` : ""}${esc(e.title)}</span>
              </div>`,
              )
              .join("")}</div>
          </div>`;
      }
      q(".cal-body").innerHTML =
        `<div class="cal-board" style="grid-template-rows: auto repeat(${weeks}, minmax(0, 1fr))">${html}</div>`;
      fitCells();
    }

    /** Entries that don't fit a square collapse into "+N". */
    function fitCells() {
      for (const list of box.querySelectorAll(".bc-evs")) {
        list.querySelector(".bc-more")?.remove();
        const lines = [...list.querySelectorAll(".bc-ev")];
        lines.forEach((l) => (l.hidden = false));
        if (list.scrollHeight <= list.clientHeight + 1) continue;
        const more = document.createElement("div");
        more.className = "bc-more";
        list.append(more);
        let hidden = 0;
        more.textContent = t("cal.more", { n: 1 });
        for (
          let i = lines.length - 1;
          i >= 0 && list.scrollHeight > list.clientHeight + 1;
          i--
        ) {
          lines[i].hidden = true;
          more.textContent = t("cal.more", { n: ++hidden });
        }
        more.title = t("cal.more_hint");
      }
    }

    function renderPop() {
      const pop = q(".cal-pop");
      if (!popDate) {
        pop.hidden = true;
        pop.innerHTML = "";
        return;
      }
      const hn = holName(popDate);
      // keep a half-typed entry across a re-render (e.g. picking a day colour)
      const typed = pop.querySelector(".cal-add")?.dataset.date === popDate ? pop.querySelector(".cal-add").value : "";
      pop.innerHTML = `
        <div class="pop-head"><button data-a="pop-prev" title="${esc(t("cal.prev_day"))}">${icon("left")}</button>
          <b>${esc(dayLabel(popDate))}${hn ? `<span class="hol-name">${esc(hn)}</span>` : ""}${s.lunar ? `<span class="lun-name">${esc(lunarLabel(popDate))}</span>` : ""}</b>
          <button data-a="pop-next" title="${esc(t("cal.next_day"))}">${icon("right")}</button>
          <button data-a="pop-color" title="${esc(t("cal.day_color"))}" aria-expanded="${daySw}">${icon("palette")}</button>
          <button data-a="pop-close" title="${esc(t("theme.close"))}">${icon("x")}</button></div>
        ${daySw ? `<div class="cal-sw" role="group" aria-label="${esc(t("cal.day_color"))}">${swatches(colors.days[popDate])}</div>` : ""}
        <div class="cal-list">${agendaHtml(popDate)}</div>
        <input class="cal-add" data-date="${popDate}" placeholder="${esc(t("cal.add_placeholder"))}">
        <div class="cal-parse" aria-hidden="true"></div>`;
      pop.querySelector(".cal-add").value = typed;
      pop.querySelector(".cal-parse").innerHTML = parseHtml(typed);
      pop.hidden = false;
    }

    // ---------------- editing ----------------
    function addEntry(date, text) {
      const p = parseEntry(text);
      if (!p.title) {
        if (text.trim()) api.toast(t("cal.need_title"));
        return false;
      }
      events.push({ id: uid(), date, done: false, ...p });
      persist();
      return true;
    }

    /** Replace `span` with an input for `ev`; Enter saves, Esc cancels, empty text deletes. */
    function editInline(span, ev) {
      editInlineText(span, unparse(ev), (text) => {
        const current = byId(ev.id);
        if (!current) return;
        if (!text) events = events.filter((item) => item.id !== ev.id);
        else {
          const parsed = parseEntry(text);
          if (parsed.title) Object.assign(current, parsed);
        }
        persist();
      }, render);
    }

    /** Write directly into a board square. Enter adds and keeps the box open for the next line. */
    function addInCell(cell) {
      const existing = cell.querySelector(".bc-add");
      if (existing) return existing.focus();
      const d = cell.dataset.d;
      const inp = document.createElement("input");
      inp.className = "bc-add";
      inp.placeholder = t("cal.cell_placeholder");
      cell.append(inp);
      inp.focus();
      let closed = false;
      inp.addEventListener("keydown", (k) => {
        if (k.key === "Enter") {
          if (addEntry(d, inp.value)) {
            closed = true;
            render();
            const again = box.querySelector(`.bc[data-d="${d}"]`);
            if (again) addInCell(again);
          }
        }
        if (k.key === "Escape") {
          k.stopPropagation();
          closed = true;
          inp.remove();
        }
      });
      inp.addEventListener("blur", () => {
        if (closed) return;
        closed = true;
        const added = addEntry(d, inp.value);
        inp.remove();
        if (added) render();
      });
    }

    /** Details editor for one entry: date, time, repeat, tags, link, time zone, reminder (+ lead minutes). */
    function closeDetails() {
      const ed = q(".cal-ed");
      ed.hidden = true;
      ed.innerHTML = "";
    }
    function openDetails(ev) {
      if (!ev) return;
      const ed = q(".cal-ed");
      const tz = ev.tz || defaultTz();
      let tags = [...(ev.tags || [])];
      // "yearly-lunar" is only a select value: it saves as repeat "yearly" + lunar
      const repeatOpts = ["", ...REPEATS, "yearly-lunar"]
        .map((r) => `<option value="${r}">${esc(t(r ? "cal." + r.replace("-", "_") : "cal.repeat_none"))}</option>`)
        .join("");
      const startDow = (date) => parseYmd(date).getDay();
      const chosenDays = repeatDays(ev) || [startDow(ev.date)];
      const dayBtns = [...Array(7)]
        .map((_, i) => dowOf(i))
        .map(
          (w) =>
            `<button type="button" data-a="wd" data-w="${w}" aria-pressed="${chosenDays.includes(w)}">${esc(fmt({ weekday: "narrow" }, addDays("2023-01-01", w)))}</button>`,
        )
        .join("");
      const ruleHtml = `
        <div class="cal-ed-rule" hidden>
          <label class="cal-ed-lead">${esc(t("cal.every"))}<span><input data-f="every" type="number" min="1" max="99" step="1" inputmode="numeric" value="${repeatEvery(ev)}"> <span class="cal-ed-unit"></span></span></label>
          <div class="cal-ed-days" role="group" aria-label="${esc(t("cal.on_days"))}">${dayBtns}</div>
          <label>${esc(t("cal.until"))}<input data-f="until" type="date" value="${esc(typeof ev.until === "string" ? ev.until : "")}"></label>
        </div>`;
      ed.innerHTML = `
        <div class="pop-head"><b>${esc(t("cal.details"))}</b>
          <button data-a="ed-close" title="${esc(t("theme.close"))}">${icon("x")}</button></div>
        <label>${esc(t("cal.date"))}<input data-f="date" type="date" value="${esc(ev.date)}" required></label>
        <label>${esc(t("cal.time"))}<input data-f="time" type="time" value="${esc(ev.time || "")}"></label>
        ${ev.dday || ev.quota ? "" : `<label>${esc(t("cal.repeat"))}<select data-f="repeat">${repeatOpts}</select></label>${ruleHtml}`}
        <label>${esc(t("cal.tags"))}<span class="cal-ed-tags"><span class="chips"></span><input data-f="tag" placeholder="${esc(t("cal.tag_add"))}"></span><span class="cal-sw" role="group" hidden></span></label>
        <label>${esc(t("cal.url"))}<input data-f="url" type="url" inputmode="url" value="${esc(ev.url || "")}" placeholder="https://"></label>
        <label>${esc(t("clock.zone"))}<select data-f="tz">${tzOptions(tz, { common: t("set.tz_common"), all: t("set.tz_all") })}</select></label>
        <label class="cal-ed-chk"><input data-f="notify" type="checkbox" ${ev.notify ? "checked" : ""}> ${esc(t("cal.notify"))}</label>
        <label class="cal-ed-lead">${esc(t("cal.lead"))}<span><input data-f="lead" type="number" min="0" step="5" inputmode="numeric" value="${ev.lead ?? ""}" placeholder="0"> ${esc(t("cal.lead_min"))}</span></label>
        <div class="cal-ed-btns"><span class="sp"></span><button class="primary" data-a="ed-save">${esc(t("cal.save"))}</button></div>`;
      ed.hidden = false;
      ed.querySelector("[data-f=tz]").value = tz;
      const f = (n) => ed.querySelector(`[data-f=${n}]`);
      // the rule rows (interval, weekdays, end date) follow the repeat choice
      const syncRule = () => {
        const v = f("repeat").value;
        ed.querySelector(".cal-ed-rule").hidden = !v;
        ed.querySelector(".cal-ed-days").hidden = v !== "weekly";
        if (v) ed.querySelector(".cal-ed-unit").textContent = t("cal.unit_" + v.replace("-lunar", ""));
      };
      if (f("repeat")) {
        f("repeat").value =
          ev.repeat === "yearly" && ev.lunar ? "yearly-lunar" : REPEATS.includes(ev.repeat) ? ev.repeat : "";
        f("repeat").addEventListener("change", syncRule);
        syncRule();
      }
      let picking = null; // the tag whose colour row is open
      const drawTags = () => {
        if (!tags.includes(picking)) picking = null;
        ed.querySelector(".chips").innerHTML = tags
          .map((x, i) => {
            const c = markVar(colors.tags[x]);
            return `<span class="chip${c ? " tc" : ""}${x === picking ? " picking" : ""}"${c ? ` style="--tag:${c}"` : ""}><span data-a="tag-pick" data-i="${i}" title="${esc(t("cal.tag_color", { tag: x }))}">#${esc(x)}</span><button data-a="tag-del" data-i="${i}" title="${esc(t("cal.tag_remove", { tag: x }))}">${icon("x")}</button></span>`;
          })
          .join("");
        const sw = ed.querySelector(".cal-sw");
        sw.hidden = !picking;
        sw.innerHTML = picking ? swatches(colors.tags[picking]) : "";
        sw.setAttribute("aria-label", picking ? t("cal.tag_color", { tag: picking }) : "");
      };
      drawTags();
      const addTag = () => {
        const x = f("tag").value.trim().replace(/^#/, "").replace(/\s+/g, "").slice(0, 40);
        if (x && !tags.includes(x)) tags.push(x);
        f("tag").value = "";
        drawTags();
      };
      f("tag").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addTag();
        }
      });
      ed.onclick = (e) => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (a === "ed-close") return closeDetails();
        if (a === "tag-del") {
          // the chips sit inside a <label>: without this, a re-rendered chip passes the click on to the next ✕
          e.preventDefault();
          tags.splice(+e.target.closest("[data-i]").dataset.i, 1);
          return drawTags();
        }
        if (a === "wd") {
          const b = e.target.closest("[data-w]");
          b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
          return;
        }
        if (a === "tag-pick") {
          e.preventDefault();
          const x = tags[+e.target.closest("[data-i]").dataset.i];
          picking = picking === x ? null : x;
          return drawTags();
        }
        if (a === "sw" && picking) {
          // a tag's colour is shared by every entry with it, so it applies now (not on Save)
          e.preventDefault();
          const n = +e.target.closest("[data-n]").dataset.n;
          if (markVar(n)) colors.tags[picking] = n;
          else delete colors.tags[picking];
          persistColors();
          drawTags();
          return render();
        }
        if (a === "ed-save") {
          // the live copy: another widget may have re-synced `events` while the panel was open
          const cur = byId(ev.id);
          if (!cur) return (closeDetails(), render()); // deleted meanwhile
          addTag(); // a tag typed but not yet entered still counts
          if (/^\d{4}-\d{2}-\d{2}$/.test(f("date").value)) cur.date = f("date").value;
          if (f("repeat")) {
            const v = f("repeat").value;
            const r = v === "yearly-lunar" ? "yearly" : v || null;
            const lunar = v === "yearly-lunar";
            // per-occurrence ticks belong to the old rule
            if (r !== (cur.repeat ?? null) || lunar !== !!cur.lunar) delete cur.doneDates;
            cur.repeat = r;
            // a to-do given a dated repeat becomes a calendar entry (the checklist then shows it on its days)
            if (cur.todo && r && r !== "daily") delete cur.todo;
            for (const k of ["lunar", "every", "days", "until"]) delete cur[k];
            if (lunar) cur.lunar = true;
            if (r) {
              const n = Math.floor(+f("every").value || 1);
              if (n > 1) cur.every = Math.min(n, 99);
              const days = [...ed.querySelectorAll("[data-a=wd][aria-pressed=true]")].map((b) => +b.dataset.w).sort();
              // only the start date's weekday = the plain weekly rule
              if (r === "weekly" && days.length && !(days.length === 1 && days[0] === startDow(cur.date))) cur.days = days;
              const until = f("until").value;
              if (/^\d{4}-\d{2}-\d{2}$/.test(until) && until >= cur.date) cur.until = until;
            }
          }
          cur.tags = tags;
          cur.time = f("time").value || null;
          const url = f("url").value.trim();
          // open_url only takes http(s), so "www.naver.com" would give a dead link button
          cur.url = !url ? null : /^https?:\/\//i.test(url) ? url : "https://" + url;
          cur.tz = f("tz").value || defaultTz();
          cur.notify = f("notify").checked;
          cur.lead = Math.max(0, Math.floor(+f("lead").value || 0)) || null;
          persist();
          closeDetails();
          render();
        }
      };
      ed.onkeydown = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          closeDetails();
        }
      };
      f("date").focus();
    }

    /** Open a day's list (from the mini grid, a "+N", or ‹ › inside the list). */
    function openDay(d) {
      closeDetails();
      popDate = d;
      showDate(d);
      render();
      q(".cal-pop .cal-add")?.focus(); // type right away; Esc closes
    }
    // a search result in the Library: open that day
    api.on("goto-date", (p) => p?.type === "calendar" && openDay(p.date));
    function go(dir) {
      // rolling weeks step one week at a time
      if (rolling()) {
        anchor = addDays(monthCells().start, 7 * dir);
        return render();
      }
      const d = parseYmd(month);
      d.setDate(1);
      d.setMonth(d.getMonth() + dir);
      month = ymd(d);
      render();
    }
    function toggleView() {
      s.view = s.view === "mini" ? "board" : "mini";
      popDate = null;
      q(".cal-body").innerHTML = "";
      if (s.view === "board") {
        const cur = api.size;
        if (cur.w < 6 || cur.h < 5) {
          s.miniSize = cur; // folded back on the way out of big squares
          api.requestSize({ w: Math.max(cur.w, 7), h: Math.max(cur.h, 6) });
        }
      } else if (s.miniSize) {
        api.requestSize(s.miniSize);
        delete s.miniSize;
      }
      api.save();
      render();
    }

    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "prev") return go(-1);
      if (a === "next") return go(1);
      if (a === "today") {
        month = ymd().slice(0, 7) + "-01";
        anchor = null;
        return render();
      }
      if (a === "search") return openSearch(q(".cal-search").hidden);
      if (a === "search-close") return openSearch(false);
      if (a === "hit-prev" || a === "hit-next") return hitJump(a === "hit-next" ? 1 : -1);
      if (a === "view") return toggleView();
      if (a === "pop-close") {
        popDate = null;
        daySw = false;
        closeDetails();
        return render();
      }
      if (a === "pop-prev" || a === "pop-next")
        return openDay(addDays(popDate, a === "pop-prev" ? -1 : 1));
      if (a === "pop-color") {
        daySw = !daySw;
        return renderPop();
      }
      if (a === "sw" && e.target.closest(".cal-pop")) {
        const n = +e.target.closest("[data-n]").dataset.n;
        if (markVar(n)) colors.days[popDate] = n;
        else delete colors.days[popDate];
        persistColors();
        return render();
      }
      const chip = e.target.closest(".cal-filter [data-tag]");
      if (chip) {
        const x = chip.dataset.tag;
        const next = { undefined: "only", only: "hide", hide: undefined }[
          s.filter[x]
        ];
        if (next) s.filter[x] = next;
        else delete s.filter[x];
        api.save();
        return render();
      }
      if (e.target.closest(".ev-link")) {
        const id = e.target.closest("[data-id]").dataset.id;
        const ev = all().find((x) => x.id === id);
        if (ev?.url) api.openUrl(ev.url);
        return;
      }
      if (e.target.closest(".ev-cfg"))
        return openDetails(byId(e.target.closest("[data-id]").dataset.id));
      if (e.target.closest(".ev-del")) {
        const ev = byId(e.target.closest("[data-id]").dataset.id);
        const i = events.indexOf(ev);
        events = events.filter((x) => x !== ev);
        persist();
        render();
        return api.deleted(() => {
          events.splice(Math.min(i, events.length), 0, ev);
          persist();
          render();
        });
      }
      const more = e.target.closest(".bc-more");
      if (more) return openDay(more.closest(".bc").dataset.d);
      // one click edits an entry's text, in the day list and in big squares alike
      const line = e.target.closest(".bc-t, .ev-title");
      const lineEv = line && byId(line.closest("[data-id]").dataset.id); // undefined for an imported entry
      if (lineEv && !line.querySelector("input")) return editInline(line, lineEv);
      // one click opens the day list in both views; in big squares a double-click types in place instead
      const cell = e.target.closest(".bc");
      if (cell && !e.target.closest("input")) {
        clearTimeout(boardClick);
        if (e.detail >= 2) return addInCell(cell);
        boardClick = setTimeout(() => openDay(cell.dataset.d), 250);
        return;
      }
      const d = e.target.closest(".cal-grid [data-d]")?.dataset.d;
      if (d) openDay(d);
    });
    box.addEventListener("input", (e) => {
      if (e.target.matches(".cal-add"))
        q(".cal-pop .cal-parse").innerHTML = parseHtml(e.target.value);
      if (e.target.matches(".cal-search input")) {
        query = e.target.value;
        render();
      }
    });
    /** Open or close the search row; closing clears the search. */
    function openSearch(on) {
      const row = q(".cal-search");
      row.hidden = !on;
      q("[data-a=search]").setAttribute("aria-expanded", on);
      if (on) row.querySelector("input").focus();
      else {
        query = "";
        row.querySelector("input").value = "";
      }
      render();
    }
    box.addEventListener("change", (e) => {
      if (e.target.type !== "checkbox") return;
      const ev = byId(e.target.closest("[data-id]")?.dataset.id);
      const d = e.target.closest("[data-d]")?.dataset.d ?? popDate;
      if (!ev || !d) return;
      setEventDone(ev, d, e.target.checked); // a repeating entry: this occurrence only
      persist();
      render();
    });
    box.addEventListener("keydown", (e) => {
      if (e.target.matches(".cal-search input")) {
        if (e.key === "Enter") return hitJump(e.shiftKey ? -1 : 1);
        if (e.key === "Escape") {
          e.stopPropagation();
          return openSearch(false);
        }
        return;
      }
      // keyboard: Enter/Space on a day opens its list (both views); F2 edits an entry
      if (
        (e.key === "Enter" || e.key === " ") &&
        e.target.matches(".cal-grid .d, .bc")
      ) {
        e.preventDefault();
        return openDay(e.target.dataset.d);
      }
      if (e.key === "F2") {
        const row = e.target.closest(".ev, .bc-ev");
        const span = row?.querySelector(".ev-title, .bc-t");
        if (span && byId(row.dataset.id)) {
          e.preventDefault();
          return editInline(span, byId(row.dataset.id));
        }
      }
      if (e.target.matches(".cal-add") && e.key === "Enter") {
        if (addEntry(e.target.dataset.date || ymd(), e.target.value)) {
          const keep = e.target.dataset.date;
          e.target.value = "";
          render();
          box.querySelector(`.cal-add[data-date="${keep}"]`)?.focus();
        }
      }
      if (
        e.key === "Escape" &&
        popDate &&
        !e.target.matches("input:not(.cal-add)")
      ) {
        e.stopPropagation();
        popDate = null;
        render();
      }
    });
    const wheelGo = throttle((dir) => go(dir), 220);
    box.addEventListener(
      "wheel",
      (e) => {
        if (
          !e.target.closest(".cal-grid, .cal-board") ||
          Math.abs(e.deltaY) < 4
        )
          return;
        e.preventDefault();
        wheelGo(e.deltaY > 0 ? 1 : -1);
      },
      { passive: false },
    );

    // ---------------- lifecycle ----------------
    const ro = new ResizeObserver(() => s.view === "board" && fitCells());
    ro.observe(box);

    const renderLater = deferWhileEditing(box, render); // don't wipe a half-typed entry
    const load = async () => {
      const data = await api.store.get("events").catch(() => null);
      events = Array.isArray(data)
        ? data.filter(isEvent).map((e) => ({
            ...e,
            id: e.id || uid(),
            title: String(e.title ?? ""),
          }))
        : [];
      renderLater();
    };
    api.onStore("events", load);
    const loadColors = async () => {
      const c = await api.store.get("calcolors").catch(() => null);
      colors = { days: cleanMarks(c?.days), tags: cleanMarks(c?.tags) };
      renderLater();
    };
    api.onStore("calcolors", loadColors);
    // imported entries, for the subscriptions Settings lists now (a removed one vanishes at once, a rename shows)
    const buildSubs = () => {
      subList = [];
      subDays = new Map();
      for (const sub of subsOf(api.config))
        (subRaw[sub.id]?.items || []).forEach((it, i) => {
          if (typeof it?.date !== "string" || typeof it.title !== "string") return;
          const e = { ...it, id: `ics:${sub.id}:${i}`, tags: [sub.name || "iCal"], ro: true };
          subList.push(e);
          if (!subDays.has(e.date)) subDays.set(e.date, []);
          subDays.get(e.date).push(e);
        });
    };
    const loadSubs = async () => {
      const c = await api.store.get("calsubs").catch(() => null);
      subRaw = c && typeof c === "object" ? c : {};
      buildSubs();
      renderLater();
    };
    api.onStore("calsubs", loadSubs);
    api.onConfig(() => {
      buildSubs();
      renderLater();
    });
    loadHolidays().then((h) => {
      hol = h;
      renderLater();
    });
    api.onDayChange(renderLater);
    render();
    load();
    loadColors();
    loadSubs();
    return {
      destroy() {
        ro.disconnect();
        clearTimeout(boardClick);
      },
      resized: () => (s.view === "board" ? fitCells() : null),
      summary: () => {
        const d = ymd();
        const label = (e) =>
          (e.time ? e.time + " " : "") + e.title + (eventDone(e, d) ? " ✓" : "");
        const today = events.filter((e) => occursOn(e, d) && !routine(e));
        let next = null;
        for (let i = 1; i <= 366 && !next; i++) {
          const dd = addDays(d, i);
          const hit = events.find((e) => occursOn(e, dd) && !routine(e));
          if (hit) next = { date: dd, title: hit.title };
        }
        const h = holName(d);
        return [
          h ? t("sum.cal_hol", { name: h }) : "",
          today.length
            ? t("sum.cal_today", { n: today.length }) +
              " - " +
              today.slice(0, 6).map(label).join(", ")
            : t("sum.cal_none"),
          next ? t("sum.cal_next", { date: next.date, title: next.title }) : "",
        ]
          .filter(Boolean)
          .join(". ");
      },
      menu: () => [
        {
          text: t(s.view === "mini" ? "cal.view_board" : "cal.view_mini"),
          action: toggleView,
        },
        {
          text: t("cal.rows"),
          items: [0, 1, 2, 3, 4, 5, 6].map((n) => ({
            text: ((rolling() ? s.rows : 0) === n ? "✓ " : "") + (n ? t("cal.rows_n", { n }) : t("cal.rows_month")),
            action: () => {
              s.rows = n;
              anchor = null;
              api.save();
              render();
            },
          })),
        },
        {
          text: (s.lunar ? "✓ " : "") + t("cal.show_lunar"),
          action: () => {
            s.lunar = !s.lunar;
            api.save();
            render();
          },
        },
      ],
    };
  },
};
