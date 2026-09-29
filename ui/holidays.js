// Public holidays. Built-in table: holidays/kr.json (2020–2050, generated from python-holidays,
// lunar dates cross-checked with KASI data). config.json can add/remove days or turn them off:
//   "holidays": { "country": "KR" | "none", "add": { "2026-06-03": "임시공휴일" }, "remove": ["2026-05-01"] }
let cache = null;
export function loadHolidays() {
  cache ??= fetch('holidays/kr.json')
    .then((r) => r.json())
    .then((j) => j.days || {})
    .catch(() => ({}));
  return cache;
}

/** Holiday name for 'YYYY-MM-DD', or null. */
export function holidayName(days, config, lang, date) {
  const h = (config && config.holidays) || {};
  if (Array.isArray(h.remove) && h.remove.includes(date)) return null;
  const added = h.add && h.add[date];
  if (typeof added === 'string' && added.trim()) return added.trim();
  if ((h.country ?? 'KR') === 'none') return null;
  const v = days[date];
  if (!v) return null;
  return lang === 'ko' ? v[0] : v[1] || v[0];
}
