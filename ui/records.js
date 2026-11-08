// 기록 tab of the widget menu window: the shared time log (data/time.json, timelog.js) by day, week or month.
// Totals by to-do and tag, a day's timeline, and editing that day's entries (times, what it was for, category,
// delete). A stopwatch or pomodoro adds its time when it stops or pauses, so a run in progress is not here yet.
// Writes go through store_read / store_set with the revision, like a widget, so the timers re-read the log.
import { t } from "./i18n.js";
import { esc, ymd, parseYmd, addDays, weekFirstDay, formatTime } from "./util.js";
import { CATS, spent } from "./timelog.js";
import { fmtTotal } from "./widgets/timekit.js";

const DAY = 86400000;
const VIEWS = ["day", "week", "month"];
const p2 = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => `${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}`; // <input type=time> value
/** Counted ms of entry `e` between `from` and `to`. */
const within = (e, from, to) => spent({ ...e, end: Math.min(e.end, to) }, from);

const css = `
  .lib-records { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .rec-bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; flex-wrap: wrap;
    border-bottom: var(--line-width) var(--line-style) var(--line-color); }
  .rec-bar .label { min-width: 12em; text-align: center; font-weight: 600; }
  .rec-views { display: flex; gap: 2px; margin-right: auto; }
  .rec-views button[aria-pressed="true"] { background: var(--c2); color: #fff; border-color: var(--c2); }
  .rec-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 240px; }
  .rec-main { overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .rec-side { overflow-y: auto; padding: 14px 16px; border-left: var(--line-width) var(--line-style) var(--line-color); }
  .rec-side h3 { margin: 0 0 6px; font-size: .8em; font-weight: normal; color: var(--text-muted); }
  .rec-side h3:not(:first-child) { margin-top: 16px; }
  .rec-side p, .rec-sum { display: flex; gap: 8px; margin: 0 0 4px; }
  .rec-side p span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rec-num { font-variant-numeric: tabular-nums; }
  .rec-sum { gap: 18px; font-size: 1.05em; }
  .rec-sum b { font-weight: 600; }
  .rec-dot { display: inline-block; width: .7em; height: .7em; border-radius: 2px; margin-right: 4px; background: var(--c2); }
  .rec-dot.other { background: color-mix(in srgb, var(--c3) 45%, transparent); }
  .rec-line { position: relative; height: 22px; border-radius: 4px; background: color-mix(in srgb, var(--c3) 8%, transparent); }
  .rec-line i { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: 2px; background: var(--c2); }
  .rec-line i.other { background: color-mix(in srgb, var(--c3) 45%, transparent); }
  .rec-hours { display: flex; justify-content: space-between; font-size: .75em; color: var(--text-muted); margin-top: 2px; }
  .rec-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .rec-list li { display: flex; align-items: center; gap: 10px; padding: 4px 6px; border-radius: 6px; }
  .rec-list li:hover { background: color-mix(in srgb, var(--c3) 6%, transparent); }
  .rec-list .when { flex: none; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .rec-list .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rec-list .act { visibility: hidden; padding: 0 6px; font-size: .85em; }
  .rec-list li:hover .act, .rec-list li:focus-within .act, .rec-list .act.ask { visibility: visible; }
  .rec-list .act.ask { color: var(--danger); border-color: var(--danger); }
  .rec-list li.editing { flex-wrap: wrap; background: color-mix(in srgb, var(--c3) 6%, transparent); }
  .rec-list li.editing select { max-width: 16em; }
  .rec-days { display: grid; gap: 4px; align-items: end; min-height: 160px; }
  .rec-days button { display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; gap: 1px;
    height: 160px; padding: 2px; border: 0; background: none; border-radius: 4px; }
  .rec-days button:hover { background: color-mix(in srgb, var(--c3) 6%, transparent); }
  .rec-days button i { display: block; border-radius: 2px; background: var(--c2); }
  .rec-days button i.other { background: color-mix(in srgb, var(--c3) 45%, transparent); }
  .rec-days button small { margin-top: 3px; text-align: center; font-size: .75em; color: var(--text-muted); white-space: nowrap; }
  .rec-days button.today small { color: var(--c3); font-weight: 600; }
  .rec-empty { color: var(--text-muted); text-align: center; padding: 30px 0; }
`;

/** Mounts the tab into `root`. `ctx` = { invoke, lang(), timeFormat(), flash(msg) }. */
export function records(root, ctx) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);

  let view = "day";
  let anchor = ymd(); // a day inside the shown period
  let log = [];
  let events = []; // to-dos and tags for the "what was it for" picker
  let editing = null; // entry id being edited
  let confirming = null; // entry id asking "delete?"

  const fmtDate = (opts, d) => new Intl.DateTimeFormat(ctx.lang(), opts).format(parseYmd(d));
  const clock = (ms) => formatTime(ctx.lang(), ms, { hour: "numeric", minute: "2-digit" }, ctx.timeFormat());
  function period() {
    if (view === "day") return [anchor, anchor];
    if (view === "week") return [weekFirstDay(anchor), addDays(weekFirstDay(anchor), 6)];
    const first = anchor.slice(0, 8) + "01";
    return [first, addDays(addDays(first, 31).slice(0, 8) + "01", -1)];
  }
  const msOf = (d) => parseYmd(d).getTime();
  const label = (e) =>
    e.task ? e.title || t("rec.untitled") : e.tags?.length ? e.tags.map((g) => "#" + g).join(" ") : t("time." + e.cat);
  function periodLabel() {
    const [a, b] = period();
    if (view === "day") return fmtDate({ year: "numeric", month: "long", day: "numeric", weekday: "short" }, a);
    if (view === "week") return `${fmtDate({ month: "long", day: "numeric" }, a)} - ${fmtDate({ month: "long", day: "numeric" }, b)}`;
    return fmtDate({ year: "numeric", month: "long" }, a);
  }

  // ---- totals ----
  function totals(from, to) {
    const cat = Object.fromEntries(CATS.map((c) => [c, 0]));
    const byTask = new Map(),
      byTag = new Map();
    for (const e of log) {
      const ms = within(e, from, to);
      if (!ms) continue;
      if (e.cat in cat) cat[e.cat] += ms;
      if (e.task) {
        const x = byTask.get(e.task) ?? { name: e.title || t("rec.untitled"), ms: 0 };
        x.ms += ms;
        byTask.set(e.task, x);
      }
      for (const g of e.tags ?? []) byTag.set(g, (byTag.get(g) ?? 0) + ms);
    }
    return { cat, byTask, byTag };
  }
  const sideRows = (rows) =>
    rows.length
      ? rows
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 20)
          .map((r) => `<p><span title="${esc(r.name)}">${esc(r.name)}</span><span class="rec-num">${fmtTotal(r.ms)}</span></p>`)
          .join("")
      : `<p class="hint">${esc(t("rec.none"))}</p>`;

  // ---- the day: timeline and entries ----
  function dayHtml(from) {
    const to = from + DAY;
    const list = log.filter((e) => within(e, from, to) > 0).sort((a, b) => a.start - b.start);
    const blocks = list
      .map((e) => {
        const a = Math.max(e.start, from),
          b = Math.min(e.end, to);
        return `<i class="${esc(e.cat)}" style="left:${((a - from) / DAY) * 100}%;width:${((b - a) / DAY) * 100}%"
          title="${esc(`${clock(a)} - ${clock(b)} · ${label(e)}`)}"></i>`;
      })
      .join("");
    const rows = list.map((e) => (e.id === editing ? editRow(e) : row(e))).join("");
    return `
      <div><div class="rec-line">${blocks}</div>
        <div class="rec-hours"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>
      ${list.length ? `<ul class="rec-list">${rows}</ul>` : `<p class="rec-empty">${esc(t("rec.empty_day"))}</p>`}`;
  }
  function row(e) {
    const ask = confirming === e.id;
    return `<li data-id="${esc(e.id)}">
      <span class="when">${esc(clock(e.start))} - ${esc(clock(e.end))}</span>
      <span class="what" title="${esc(label(e))}"><span class="rec-dot ${esc(e.cat)}"></span>${esc(label(e))}</span>
      <span class="rec-num">${fmtTotal(spent(e))}</span>
      <button class="act" data-a="edit">${esc(t("rec.edit"))}</button>
      <button class="act ${ask ? "ask" : ""}" data-a="del">${esc(t(ask ? "rec.del_confirm" : "rec.del"))}</button>
    </li>`;
  }
  // what the time was for: nothing, a to-do (open ones and the entry's own), or a tag
  function whatOptions(e) {
    const todos = events.filter((x) => x?.todo && typeof x.title === "string");
    if (e.task && !todos.some((x) => x.id === e.task)) todos.unshift({ id: e.task, title: e.title || t("rec.untitled") });
    const tags = [...new Set([...events.flatMap((x) => x?.tags ?? []), ...(e.tags ?? [])])].sort();
    const cur = e.task ? "task:" + e.task : e.tags?.length ? "tag:" + e.tags[0] : "";
    const opt = (v, text) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(text)}</option>`;
    return [
      opt("", t("focus.nothing")),
      ...todos.slice(0, 60).map((x) => opt("task:" + x.id, x.title.slice(0, 60))),
      ...tags.map((g) => opt("tag:" + g, "#" + g)),
    ].join("");
  }
  function editRow(e) {
    return `<li data-id="${esc(e.id)}" class="editing">
      <input type="time" data-f="start" value="${hhmm(e.start)}" aria-label="${esc(t("rec.start"))}"> -
      <input type="time" data-f="end" value="${hhmm(e.end)}" aria-label="${esc(t("rec.end"))}">
      <select data-f="what" aria-label="${esc(t("focus.menu"))}">${whatOptions(e)}</select>
      <select data-f="cat" aria-label="${esc(t("sw.cat_menu"))}">${CATS.map((c) => `<option value="${c}" ${c === e.cat ? "selected" : ""}>${esc(t("time." + c))}</option>`).join("")}</select>
      <button class="primary" data-a="save">${esc(t("rec.save"))}</button>
      <button data-a="cancel">${esc(t("rec.cancel"))}</button>
    </li>`;
  }

  // ---- a week or month: one column per day, click to open that day ----
  function daysHtml(a, b) {
    const days = [];
    for (let d = a; d <= b; d = addDays(d, 1)) days.push(d);
    const per = days.map((d) => totals(msOf(d), msOf(addDays(d, 1))).cat);
    const max = Math.max(1, ...per.map((c) => c.focus + c.other));
    const today = ymd();
    const cols = days
      .map((d, i) => {
        const c = per[i];
        const h = (ms) => (ms / max) * 120;
        const name = view === "week" ? fmtDate({ weekday: "short", day: "numeric" }, d) : String(+d.slice(8));
        return `<button data-day="${d}" class="${d === today ? "today" : ""}"
          title="${esc(`${fmtDate({ month: "long", day: "numeric", weekday: "short" }, d)} · ${t("time.focus")} ${fmtTotal(c.focus)} · ${t("time.other")} ${fmtTotal(c.other)}`)}">
          <i class="other" style="height:${h(c.other)}px"></i><i style="height:${h(c.focus)}px"></i><small>${esc(name)}</small></button>`;
      })
      .join("");
    return `<div class="rec-days" style="grid-template-columns:repeat(${days.length}, minmax(0, 1fr))">${cols}</div>`;
  }

  function render() {
    const [a, b] = period();
    const from = msOf(a),
      to = msOf(addDays(b, 1));
    const { cat, byTask, byTag } = totals(from, to);
    root.innerHTML = `
      <div class="rec-bar">
        <div class="rec-views">${VIEWS.map((v) => `<button data-view="${v}" aria-pressed="${v === view}">${esc(t("rec." + v))}</button>`).join("")}</div>
        <button data-a="prev" title="${esc(t("rec.prev"))}">‹</button>
        <span class="label">${esc(periodLabel())}</span>
        <button data-a="next" title="${esc(t("rec.next"))}">›</button>
        <button data-a="today">${esc(t("rec.today"))}</button>
      </div>
      <div class="rec-body">
        <section class="rec-main">
          <div class="rec-sum">${CATS.map((c) => `<span><span class="rec-dot ${c}"></span>${esc(t("time." + c))} <b class="rec-num">${fmtTotal(cat[c])}</b></span>`).join("")}</div>
          ${view === "day" ? dayHtml(from) : daysHtml(a, b)}
          <p class="hint">${esc(t("rec.hint"))}</p>
        </section>
        <aside class="rec-side">
          <h3>${esc(t("rec.by_task"))}</h3>${sideRows([...byTask.values()])}
          <h3>${esc(t("rec.by_tag"))}</h3>${sideRows([...byTag].map(([g, ms]) => ({ name: "#" + g, ms })))}
        </aside>
      </div>`;
    root.querySelector(".rec-list .editing input")?.focus();
  }

  // ---- writing ----
  /** Apply `fn` to the latest log and save it with its revision (a timer may have added an entry meanwhile). */
  async function change(fn) {
    for (let i = 0; i < 3; i++) {
      const { value, rev } = await ctx.invoke("store_read", { key: "time" });
      const list = Array.isArray(value) ? value : [];
      if (fn(list) === false) return false;
      try {
        await ctx.invoke("store_set", { key: "time", value: list, src: "library", rev });
        log = list;
        return true;
      } catch (e) {
        if (e !== "conflict") throw e;
      }
    }
    return false;
  }
  async function save(li) {
    const id = li.dataset.id;
    const f = (k) => li.querySelector(`[data-f=${k}]`).value;
    const old = log.find((e) => e.id === id);
    if (!old || !f("start") || !f("end")) return;
    // the times are on the entry's own day; an end before the start is the next morning
    const day = msOf(ymd(new Date(old.start)));
    const at = (v) => day + (+v.slice(0, 2) * 60 + +v.slice(3, 5)) * 60000;
    const start = at(f("start"));
    let end = at(f("end"));
    if (end <= start) end += DAY;
    const what = f("what");
    const task = what.startsWith("task:") ? what.slice(5) : null;
    const todo = task && (events.find((x) => x.id === task) ?? { id: task, title: old.title, tags: old.tags });
    const ok = await change((list) => {
      const e = list.find((x) => x.id === id);
      if (!e) return false;
      Object.assign(e, { start, end, cat: f("cat") });
      if (e.cuts) e.cuts = e.cuts.filter(([a, b]) => b > start && a < end);
      delete e.task, delete e.title, delete e.tags;
      if (todo) Object.assign(e, { task: todo.id, title: todo.title ?? "", ...(todo.tags?.length && { tags: todo.tags }) });
      else if (what.startsWith("tag:")) e.tags = [what.slice(4)];
    }).catch(() => false);
    editing = null;
    if (!ok) ctx.flash(t("rec.save_failed"));
    render();
  }

  root.addEventListener("click", async (ev) => {
    const v = ev.target.closest("[data-view]")?.dataset.view;
    if (v) return (view = v), (editing = confirming = null), render();
    const day = ev.target.closest("[data-day]")?.dataset.day;
    if (day) return (view = "day"), (anchor = day), render();
    const a = ev.target.closest("[data-a]")?.dataset.a;
    const id = ev.target.closest("[data-id]")?.dataset.id;
    if (a !== "del") confirming = null;
    if (a === "prev" || a === "next") {
      const n = a === "prev" ? -1 : 1;
      if (view === "day") anchor = addDays(anchor, n);
      else if (view === "week") anchor = addDays(anchor, 7 * n);
      else anchor = addDays(anchor.slice(0, 8) + "15", 30 * n).slice(0, 8) + "01";
      editing = null;
      render();
    } else if (a === "today") (anchor = ymd()), (editing = null), render();
    else if (a === "edit") (editing = id), render();
    else if (a === "cancel") (editing = null), render();
    else if (a === "save") save(ev.target.closest("li"));
    else if (a === "del") {
      if (confirming !== id) return (confirming = id), render();
      confirming = null;
      const ok = await change((list) => {
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) return false;
        list.splice(i, 1);
      }).catch(() => false);
      if (ok) ctx.flash(t("rec.deleted"));
      render();
    }
  });
  root.addEventListener("keydown", (ev) => {
    const li = ev.target.closest("li.editing");
    if (!li) return;
    if (ev.key === "Enter") save(li);
    if (ev.key === "Escape") ev.preventDefault(), (editing = null), render(); // handled: the window stays open
  });

  /** Re-read the log and the to-dos (another window changed them). An open edit waits. */
  async function reload() {
    const [l, e] = await Promise.all([
      ctx.invoke("store_get", { key: "time" }).catch(() => []),
      ctx.invoke("store_get", { key: "events" }).catch(() => []),
    ]);
    log = Array.isArray(l) ? l.filter((x) => x && x.end > x.start) : [];
    events = Array.isArray(e) ? e : [];
    if (!editing) render();
  }
  return { reload, render };
}
