// Time log (shared store "time", data/time.json): one entry per finished stretch of counted time, from any widget.
//   { id, cat: "focus" | "other", start, end, src, cuts?: [[from, to]] }   (ms; cuts = time taken back out)
// Totals are sums over entries, so no widget writes another widget's data, and two boards adding at the same
// moment merge by id (app.js writeStore).
// ponytail: the whole list is rewritten on every add; ~10 entries a day stays small for years. Split by year if not.
// An entry may also say what the time was for: task (a to-do or calendar entry id) with its title, and tags
// (the to-do's own, or one picked in a timing widget's menu). Totals by task or tag read those.
import { formatTime, ymd, eventDone, tickDay } from "./util.js";
export const CATS = ["focus", "other"];
const after = (a, b, since) => Math.max(0, b - Math.max(a, since)); // length of [a, b] from `since` on

/** Counted ms of one entry (or a running stretch) from `since` on. */
export function spent(e, since = 0) {
  let ms = after(e.start, e.end, since);
  for (const [a, b] of e.cuts ?? []) {
    const ca = Math.max(a, e.start),
      cb = Math.min(b, e.end);
    if (cb > ca) ms -= after(ca, cb, since);
  }
  return Math.max(0, ms);
}
export const total = (list, cat, since = 0) =>
  (Array.isArray(list) ? list : []).filter((e) => e?.cat === cat).reduce((n, e) => n + spent(e, since), 0);
/** Ms logged for to-do `task` between `from` and `to` (both categories). */
export const taskTotal = (list, task, from = 0, to = Infinity) =>
  (Array.isArray(list) ? list : [])
    .filter((e) => e?.task === task && e.start < to)
    .reduce((n, e) => n + spent({ ...e, end: Math.min(e.end, to) }, from), 0);

/** The entry fields for what a timing widget works on. `focus` = { task?, title?, tags? } or null. */
export function focusFields(focus) {
  const o = {};
  if (focus?.task) (o.task = focus.task), (o.title = focus.title ?? "");
  if (focus?.tags?.length) o.tags = focus.tags;
  return o;
}

/**
 * Tell summary widgets (any window) what this widget is counting right now, so their totals include it before it
 * reaches the log. Call the returned function from render(); it sends only when the run changes, and again when a
 * new summary widget asks. run = { start, end?, cat, cuts?, task?, title?, tags? } or null.
 */
export function runAnnouncer(api) {
  let last = "null";
  const send = (run, force) => {
    const key = JSON.stringify(run ?? null);
    if (key === last && !force) return;
    last = key;
    api.emit?.("time-running", { id: api.id, run: run ?? null });
  };
  api.on?.("time-running-ask", () => send(JSON.parse(last), true));
  return send;
}

/** The shared entries (to-dos, calendar), kept current for a timing widget's menu, which is built synchronously. */
export function watchEvents(api) {
  let events = [];
  const load = () =>
    api.store.get("events").then((d) => (events = Array.isArray(d) ? d : [])).catch(() => {});
  api.onStore?.("events", load);
  load();
  return () => events;
}

/**
 * "Working on" submenu for the timer, stopwatch and pomodoro: none, an open to-do, or a tag. `set(focus)` applies
 * the pick (a running widget splits its run there, so time so far stays with the old pick).
 */
export function focusMenu(api, current, events, set) {
  const { t } = api;
  const d = ymd();
  const cut = (x) => (x.length > 40 ? x.slice(0, 39) + "…" : x);
  const open = events.filter(
    (e) => e?.todo && typeof e.title === "string" && (e.repeat ? !eventDone(e, tickDay(e, d)) : !e.done && e.date <= d),
  );
  const tags = [...new Set(events.flatMap((e) => (Array.isArray(e?.tags) ? e.tags : [])))].sort();
  const mark = (on) => (on ? "✓ " : "");
  const items = [
    { text: mark(!current?.task && !current?.tags?.length) + t("focus.nothing"), action: () => set(null) },
    ...(open.length ? [{ item: "Separator" }] : []),
    ...open.slice(0, 20).map((e) => ({
      text: mark(current?.task === e.id) + cut(e.title),
      action: () => set({ task: e.id, title: e.title, tags: e.tags ?? [] }),
    })),
    ...(tags.length ? [{ item: "Separator" }] : []),
    ...tags.map((g) => ({
      text: mark(!current?.task && current?.tags?.[0] === g) + "#" + g,
      action: () => set({ tags: [g] }),
    })),
  ];
  const now = current?.task ? cut(current.title ?? "") : current?.tags?.length ? "#" + current.tags[0] : "";
  return { text: now ? t("focus.menu_on", { what: now }) : t("focus.menu"), items };
}

// One queue per window: a widget's read between another of its reads and its write would refresh the revision
// that write is checked against, letting a stale list through (store writes merge only on a stale revision).
let queue = Promise.resolve();
const queued = (fn) => {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
};
const read = async (api) => {
  const list = await api.store.get("time");
  return Array.isArray(list) ? list : [];
};
/** The whole log. */
export const readLog = (api) => queued(() => read(api));
/** Add (or replace, by id) one entry. */
export const addEntry = (api, e) =>
  queued(async () => {
    if (!(e.end > e.start)) return;
    const list = (await read(api)).filter((x) => x.id !== e.id);
    list.push(e);
    await api.store.set("time", list);
  });
/** Take [from, to] back out of a logged entry. False when the entry is not in the log. */
export const cutEntry = (api, id, cut) =>
  queued(async () => {
    const list = await read(api);
    const e = list.find((x) => x.id === id);
    if (!e) return false;
    e.cuts = [...(e.cuts ?? []), cut];
    await api.store.set("time", list);
    return true;
  });

/** Take [from, to] out of every entry widget `src` logged in that span (time away from the keyboard). */
export const cutRange = (api, src, from, to) =>
  queued(async () => {
    const list = await read(api);
    const hit = list.filter((e) => e.src === src && e.start < to && e.end > from);
    for (const e of hit) e.cuts = [...(e.cuts ?? []), [Math.max(from, e.start), Math.min(to, e.end)]];
    if (hit.length) await api.store.set("time", list);
  });
/**
 * Away from the keyboard: Rust sends "user-back" { from, to } when input comes back after a minute or more. When the
 * gap reaches Settings' away time and this widget counted during it (`running(to)`: a run that began before `to`, or entries in the log),
 * `ask(from, to)` sets up the keep / take-out question.
 */
export function watchIdle(api, running, ask) {
  api.on?.("user-back", async (p) => {
    const gap = api.awayMs?.() ?? 0;
    if (!gap || !(p?.to - p?.from >= gap)) return;
    const logged = () => readLog(api).then((l) => l.some((e) => e.src === api.id && e.start < p.to && e.end > p.from));
    if (running(p.to) || (await logged())) ask(p.from, p.to);
  });
}

/**
 * The keep / take-out question after time away (sleep, or a crash left something running), as a toast that stays
 * until answered; the widget face stays clean. `away` = { from, to, id, crash? }; `name` says which widget asks.
 */
export function askAway(api, name, away, fmt, answer, cat = "focus") {
  if (!away) return;
  const { t } = api;
  const label = t("time." + cat);
  const msg = away.crash
    ? t("away.crash", { name, cat: label, since: formatTime(api.lang, away.from, { hour: "numeric", minute: "2-digit" }, api.config?.ui?.timeFormat) })
    : t("away.text", { name, cat: label, t: fmt(away.to - away.from) });
  api.ask?.(msg, [
    { label: t("away.keep"), fn: () => answer(true) },
    { label: t("away.cut"), fn: () => answer(false) },
  ]);
}
