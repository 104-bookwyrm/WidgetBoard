// Tiny i18n: flat JSON files in ./locales (ko = default, en = fallback).
let strings = {};
let fallback = {};

async function fetchLocale(code) {
  try {
    return await (await fetch(`locales/${code}.json`)).json();
  } catch {
    return {};
  }
}

export async function loadLang(code) {
  fallback = await fetchLocale('en');
  strings = code === 'en' ? fallback : await fetchLocale(code);
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
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
