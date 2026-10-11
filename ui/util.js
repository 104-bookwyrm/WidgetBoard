// Small shared helpers for widgets.
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const pad = (n) => String(n).padStart(2, "0");

/** Local date as 'YYYY-MM-DD'. */
export const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
/** Whole days from a to b (b - a). */
export const daysBetween = (a, b) =>
  Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
/** Add n calendar months to 'YYYY-MM-DD', clamping to the month's last day (Aug 31 + 6mo -> Feb 28/29). */
export const addMonths = (s, n) => {
  const d = parseYmd(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymd(d);
};
export const uid = () => crypto.randomUUID();

/** Milliseconds `tz` is ahead of UTC at instant `at` (handles DST for the date in question). */
function tzOffset(tz, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  // round to the whole minute: real tz offsets are whole minutes, and `at`'s sub-second ms would
  // otherwise shave the formatted (second-truncated) time down by up to 999ms (9:00 -> 8:59).
  return Math.round((asUTC - at) / 60000) * 60000;
}

/**
 * Epoch ms for a wall-clock date + time read in an IANA timezone.
 * zonedToInstant('2026-03-14', '20:00', 'Asia/Tokyo') -> the instant 8pm is in Tokyo that day.
 * DST-free zones (KST/JST/UTC) are exact; the second pass resolves DST transitions.
 */
export function zonedToInstant(ymdStr, hm, tz = "UTC") {
  const [y, mo, d] = ymdStr.split("-").map(Number);
  const [h, mi] = (hm || "00:00").split(":").map(Number);
  const wallUTC = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  let t = wallUTC - tzOffset(tz, wallUTC);
  t = wallUTC - tzOffset(tz, t); // refine once for DST boundaries
  return t;
}

/**
 * Does event `e` occur on day `d` ('YYYY-MM-DD')? Shared by the calendar grid, the
 * checklist "today" view and the reminder engine so recurrence is defined once.
 * ponytail: yearly + weekly only — no monthly/RRULE until a real need shows up.
 * ponytail: Feb-29 yearly entries don't render in non-leap years (no such grid cell); rare, left as-is.
 */
export function occursOn(e, d) {
  if (!e || typeof e.date !== "string") return false;
  if (e.date === d) return true;
  if (e.repeat === "yearly") return e.date.slice(5) === d.slice(5);
  // weekly: same weekday, on or after the anchor (a recurrence starts at its first date)
  if (e.repeat === "weekly")
    return d >= e.date && parseYmd(d).getDay() === parseYmd(e.date).getDay();
  return false;
}

// The short list shown on top of every zone picker.
export const TZ_COMMON = [
  "Asia/Seoul",
  "Asia/Tokyo",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
];
export const osZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const allZones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [...TZ_COMMON];
  }
};
const offsetStr = (ms) => {
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms),
    h = Math.floor(abs / 3600000),
    mi = Math.floor((abs % 3600000) / 60000);
  return "UTC" + sign + h + (mi ? ":" + String(mi).padStart(2, "0") : "");
};
/** "Seoul (UTC+9)" — city name + the zone's current offset. */
export const tzLabel = (zone) =>
  zone === "UTC"
    ? "UTC"
    : `${zone.split("/").pop().replace(/_/g, " ")} (${offsetStr(tzOffset(zone, Date.now()))})`;
/**
 * <option>/<optgroup> markup for a timezone <select>. The common zones sit on top, then every
 * IANA zone. `labels` supplies localized text: { auto?, common, all }; pass auto to add an
 * "Auto" entry (value ""). Reused by the settings picker, reminder editor and clock widget.
 */
export function tzOptions(selected, labels) {
  const o = (v, text) =>
    `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(text)}</option>`;
  const common = TZ_COMMON.map((z) => o(z, tzLabel(z))).join("");
  const all = allZones()
    .filter((z) => !TZ_COMMON.includes(z))
    .map((z) => o(z, z.replace(/_/g, " ")))
    .join("");
  return (
    (labels.auto != null ? o("", labels.auto) : "") +
    `<optgroup label="${esc(labels.common)}">${common}</optgroup>` +
    `<optgroup label="${esc(labels.all)}">${all}</optgroup>`
  );
}

/** Let a horizontally scrolling chip bar scroll with the normal mouse wheel. */
export function wheelScrollX(el) {
  el.addEventListener(
    "wheel",
    (e) => {
      if (
        el.scrollWidth <= el.clientWidth ||
        Math.abs(e.deltaX) > Math.abs(e.deltaY)
      )
        return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
}

/**
 * Wrap a render function so it waits while the user is typing inside `box`
 * (a data change from another widget must not wipe a half-written entry).
 */
export function deferWhileEditing(box, fn) {
  let pending = false;
  box.addEventListener("focusout", () =>
    setTimeout(() => {
      if (pending && !box.contains(document.activeElement)) {
        pending = false;
        fn();
      }
    }),
  );
  return () => {
    const a = document.activeElement;
    if (
      a &&
      box.contains(a) &&
      a.matches("input:not([type=checkbox]), textarea, select")
    ) {
      pending = true;
      return;
    }
    fn();
  };
}

/** Inline editor shared by calendar and checklist. Resolve live data inside onCommit. */
export function editInlineText(span, value, onCommit, render) {
  const input = document.createElement("input");
  input.value = value;
  span.replaceChildren(input);
  input.focus();
  let finished = false;
  const finish = (keep) => {
    if (finished) return;
    finished = true;
    if (keep) onCommit(input.value.trim());
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") {
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** WCAG relative luminance (0-1) of any CSS colour, var() included, as the browser resolves it. */
export function luminance(color) {
  const p = document.createElement("i");
  p.style.color = color;
  document.body.append(p);
  const v = getComputedStyle(p).color;
  p.remove();
  const n = v.match(/[\d.]+/g)?.map(Number) || [0, 0, 0];
  const rgb = v.startsWith("color(") ? n.slice(0, 3).map((x) => x * 255) : n.slice(0, 3);
  const ch = rgb.map((x) =>
    (x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** WCAG contrast ratio between two CSS colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** True when dark text contrasts better than white on `color`. */
export function isLight(color) {
  const L = luminance(color);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05);
}
/**
 * Set --scheme to 'light' or 'dark' from the theme surface (--c1), so native pickers
 * (date/time inputs) match a light theme instead of always drawing dark.
 */
export function syncScheme() {
  document.documentElement.style.setProperty("--scheme", isLight("var(--c1)") ? "light" : "dark");
}

/**
 * Accept files dragged onto `el`: while dragging it shows `label` over it (CSS .w-dropping),
 * then calls onFiles(FileList). The counter stops the overlay flickering over child elements.
 */
export function dropZone(el, label, onFiles) {
  let n = 0;
  const files = (e) => e.dataTransfer?.types.includes("Files"); // ignore text/image drags from the page
  const show = (on) => {
    el.classList.toggle("w-dropping", on);
    if (on) el.dataset.dropLabel = label;
  };
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  el.addEventListener("dragenter", (e) => {
    if (!files(e)) return;
    e.preventDefault();
    if (++n === 1) show(true);
  });
  el.addEventListener("dragleave", (e) => {
    if (files(e) && --n <= 0) ((n = 0), show(false));
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    n = 0;
    show(false);
    onFiles(e.dataTransfer.files);
  });
}

/** Throttle: run at most once per `ms`. */
export function throttle(fn, ms) {
  let last = 0;
  return (...a) => {
    if (Date.now() - last < ms) return;
    last = Date.now();
    fn(...a);
  };
}
