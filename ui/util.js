// Small shared helpers for widgets.
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const pad = (n) => String(n).padStart(2, '0');

/** Local date as 'YYYY-MM-DD'. */
export const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
/** Whole days from a to b (b - a). */
export const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
export const uid = () => crypto.randomUUID();

/** Let a horizontally scrolling chip bar scroll with the normal mouse wheel. */
export function wheelScrollX(el) {
  el.addEventListener('wheel', (e) => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
}

/**
 * Wrap a render function so it waits while the user is typing inside `box`
 * (a data change from another widget must not wipe a half-written entry).
 */
export function deferWhileEditing(box, fn) {
  let pending = false;
  box.addEventListener('focusout', () =>
    setTimeout(() => {
      if (pending && !box.contains(document.activeElement)) {
        pending = false;
        fn();
      }
    }),
  );
  return () => {
    const a = document.activeElement;
    if (a && box.contains(a) && a.matches('input:not([type=checkbox]), textarea, select')) {
      pending = true;
      return;
    }
    fn();
  };
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
