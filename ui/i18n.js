// Tiny i18n: flat JSON files in ./locales/<lang>/ (ko = default, en = fallback), merged into one map per language.
// A page loads common, native, its own file, help and every widget file (widgets/<host>.json).
import GROUPS from "./widgets/groups.json" with { type: "json" };

let strings = {};
let fallback = {};

const widgetFiles = () => GROUPS.flatMap((g) => g.widgets).map((w) => `widgets/${w}`);

async function fetchPart(code, name) {
  try {
    return await (await fetch(`locales/${code}/${name}.json`)).json();
  } catch {
    return {};
  }
}

async function fetchLocale(code, page) {
  const parts = await Promise.all(["common", "native", page, "help", ...widgetFiles()].map((n) => fetchPart(code, n)));
  return Object.assign({}, ...parts);
}

/** page: "board" | "settings" | "library", the per-page file to load. */
export async function loadLang(code, page) {
  fallback = await fetchLocale("en", page);
  strings = code === "en" ? fallback : await fetchLocale(code, page);
  document.documentElement.lang = code;
  applyStatic();
}

/** t('menu.display', { n: 2 }) -> "모니터 2" */
export function t(key, vars = {}) {
  let s = strings[key] ?? fallback[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/** Fill every element that has data-i18n="key". */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]"))
    el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-title]"))
    el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]"))
    el.placeholder = t(el.dataset.i18nPlaceholder);
}
