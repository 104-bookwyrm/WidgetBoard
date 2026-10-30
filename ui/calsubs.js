// Calendar subscriptions: read-only import of .ics links (Settings > 달력, config.calendar.subscriptions).
// The primary board fetches each link, expands it into single dated entries and writes data/calsubs.json:
// { [subId]: { at, items: [{ date, time?, title, url? }], error? } }. Only the calendar reads it: no reminders,
// no checklist or D-day rows, and nothing here ever touches the user's own events.
import { addDays, ymd } from "./util.js";

export const REFRESH_MS = 3 * 3600e3; // Google refreshes its own subscriptions every few hours
const RANGE = 365; // days kept on each side of today
const MAX_ITEMS = 5000; // per subscription
const MAX_STEPS = 20000; // recurrence steps per event (a daily series from 1990 still reaches today)
const MAX_SPAN = 60; // an all-day event longer than this shows on its first 60 days only

export const subsOf = (config) =>
  (Array.isArray(config?.calendar?.subscriptions) ? config.calendar.subscriptions : []).filter(
    (s) => s && typeof s.id === "string" && typeof s.url === "string" && s.url,
  );

const pad = (n) => String(n).padStart(2, "0");
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dateOf = (t) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;

/** .ics text -> dated entries from a year back to a year ahead, local time. `ICAL` = the vendored ical.js. */
export function expandIcs(ICAL, text, today = ymd()) {
  const from = addDays(today, -RANGE);
  const to = addDays(today, RANGE);
  const cal = new ICAL.Component(ICAL.parse(text));
  for (const tz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
  const vevents = cal.getAllSubcomponents("vevent");
  // moved or edited occurrences (RECURRENCE-ID), handed to their series up front: ical.js would otherwise
  // rescan every VEVENT for each series
  const moved = {};
  const series = new Set();
  for (const v of vevents) {
    const uid = v.getFirstPropertyValue("uid");
    if (v.hasProperty("recurrence-id")) (moved[uid] ||= []).push(v);
    else series.add(uid);
  }
  const out = [];
  const add = (start, end, ev) => {
    const title = String(ev.summary || "").trim();
    if (!title) return;
    const url = String(ev.component.getFirstPropertyValue("url") || "");
    const extra = /^https?:\/\//i.test(url) ? { url } : {};
    if (start.isDate) {
      // all-day: DTEND is the day after the last one
      const last = end ? addDays(dateOf(end), -1) : dateOf(start);
      for (let d = dateOf(start), i = 0; d <= last && i < MAX_SPAN; d = addDays(d, 1), i++)
        if (d >= from && d <= to) out.push({ date: d, title, ...extra });
      return;
    }
    const js = start.toJSDate(); // TZID / UTC -> this PC's zone; a floating time stays as written
    const date = ymd(js);
    if (date >= from && date <= to) out.push({ date, time: hm(js), title, ...extra });
  };
  for (const v of vevents) {
    if (out.length >= MAX_ITEMS) break;
    if (v.hasProperty("recurrence-id") && series.has(v.getFirstPropertyValue("uid"))) continue; // drawn through its series
    const ev = new ICAL.Event(v, { exceptions: moved[v.getFirstPropertyValue("uid")] || [] });
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      add(ev.startDate, ev.endDate, ev);
      continue;
    }
    const it = ev.iterator();
    for (let next, i = 0; (next = it.next()) && i < MAX_STEPS && out.length < MAX_ITEMS; i++) {
      if (dateOf(next) > to) break;
      if (addDays(dateOf(next), MAX_SPAN) < from) continue;
      const o = ev.getOccurrenceDetails(next);
      add(o.startDate, o.endDate, o.item);
    }
  }
  return out.slice(0, MAX_ITEMS);
}

let ICAL = null;
let running = null;
/** Fetch and expand every subscription, then write the calsubs store once. A failed link keeps its last copy. */
export function refreshSubs(invoke, config) {
  // one refresh at a time; a request during one waits for it and then runs again with the newer config
  const run = async () => {
    const subs = subsOf(config());
    const old = (await invoke("store_get", { key: "calsubs" }).catch(() => null)) || {};
    const next = {};
    for (const s of subs) {
      try {
        ICAL ||= (await import("./vendor/ical.js")).default;
        const text = await invoke("fetch_ics", { url: s.url });
        next[s.id] = { at: Date.now(), items: expandIcs(ICAL, text) };
      } catch (e) {
        next[s.id] = { at: old[s.id]?.at || 0, items: old[s.id]?.items || [], error: String(e?.message || e) };
      }
    }
    await invoke("store_set", { key: "calsubs", value: next, src: "calsubs" }).catch(() => {});
  };
  const p = (running || Promise.resolve()).then(run, run).finally(() => {
    if (running === p) running = null;
  });
  return (running = p);
}
