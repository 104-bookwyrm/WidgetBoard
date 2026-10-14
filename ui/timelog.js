// Time log (shared store "time", data/time.json): one entry per finished stretch of counted time, from any widget.
//   { id, cat: "focus" | "other", start, end, src, cuts?: [[from, to]] }   (ms; cuts = time taken back out)
// Totals are sums over entries, so no widget writes another widget's data, and two boards adding at the same
// moment merge by id (app.js writeStore).
// ponytail: the whole list is rewritten on every add; ~10 entries a day stays small for years. Split by year if not.
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

/**
 * The keep / take-out question after time away (sleep, or a crash left something running).
 * `away` = { from, to, id, crash? }. Buttons: data-a="away-keep" / "away-cut".
 */
export function awayHtml(t, away, fmt) {
  if (!away) return "";
  const msg = away.crash
    ? t("away.crash", { since: new Date(away.from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
    : t("away.text", { t: fmt(away.to - away.from) });
  return `<span>${msg}</span><button data-a="away-keep">${t("away.keep")}</button><button data-a="away-cut">${t("away.cut")}</button>`;
}
