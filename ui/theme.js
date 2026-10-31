// Theme helpers shared by the board (app.js) and the settings window (settings.js).
import { t } from "./i18n.js";
import { contrast } from "./util.js";

/** Shared themes may not pull remote content. */
export const sanitize = (css) =>
  css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*['"]?\s*(https?:|\/\/)[^)]*\)/gi, "none");

/** Set `name: value` inside the theme CSS, adding it to :root if missing. */
export function setVar(css, name, value) {
  const esc = name.replace(/[-]/g, "\\-");
  const re = new RegExp(`(^|[\\s;{])(${esc}\\s*:\\s*)([^;]*)(;)`, "m");
  if (re.test(css)) return css.replace(re, `$1$2${value}$4`);
  if (/:root\s*\{/.test(css))
    return css.replace(/:root\s*\{/, (m) => `${m}\n  ${name}: ${value};`);
  return `${css}\n:root { ${name}: ${value}; }\n`;
}

const cvs = document.createElement("canvas").getContext("2d");
/** Any CSS colour as #rrggbb (for <input type=color>); unknown -> black. */
export function toHex(color) {
  cvs.fillStyle = "#000";
  cvs.fillStyle = color.trim();
  return cvs.fillStyle.startsWith("#") ? cvs.fillStyle : "#000000";
}

export const firstFamily = (v) =>
  (v || "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");

export const cleanFont = (f) =>
  String(f || "")
    .replace(/["';{}\\<>]/g, "")
    .trim()
    .slice(0, 80);

/** A font field with a suggestion list. Chromium only suggests fonts containing the typed text, so the field
 * empties while focused (the current font shows as the placeholder) and gets it back if nothing was picked. */
export function fontField(input) {
  let kept = "",
    hint = "";
  input.addEventListener("focus", () => {
    kept = input.value;
    hint = input.placeholder;
    if (kept) input.placeholder = kept;
    input.value = "";
  });
  input.addEventListener("blur", () => {
    input.placeholder = hint;
    if (!input.value) input.value = kept;
  });
}

/** Pull the CSS out of an AI answer: the first ``` block if there is one, otherwise the whole text. */
export function extractCss(text) {
  const m = String(text).match(/```(?:css)?\s*\n([\s\S]*?)```/i);
  return (m ? m[1] : String(text)).trim();
}

/** Check a theme before using it. Returns { ok, css, warnings[], error }. */
export function checkTheme(text) {
  const css = extractCss(text);
  if (!css) return { ok: false, error: t("ai.err_empty") };
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(sanitize(css));
  } catch {
    return { ok: false, error: t("ai.err_syntax") };
  }
  const rules = [...sheet.cssRules];
  const style = rules.filter((r) => r.style);
  if (!style.some((r) => [...r.style].some((p) => p.startsWith("--"))))
    return { ok: false, error: t("ai.err_no_vars") };
  const warnings = [];
  const outside = style.filter(
    (r) =>
      !/^(:root|\[data-widget=("|')?[a-z]+("|')?\])(\s*,\s*(:root|\[data-widget=("|')?[a-z]+("|')?\]))*$/.test(
        r.selectorText,
      ),
  );
  if (outside.length || rules.length !== style.length)
    warnings.push(
      t("ai.warn_outside", { n: outside.length + rules.length - style.length }),
    );
  if (/@import|url\(\s*['"]?\s*(https?:|\/\/)/i.test(css))
    warnings.push(t("ai.warn_remote"));
  if (/--(cell|gap)\s*:/.test(css)) warnings.push(t("ai.warn_grid"));
  return { ok: true, css, warnings };
}

/** Readability warnings for the theme currently applied to the page. */
export function contrastWarnings() {
  const w = [];
  const text = contrast("var(--c3)", "var(--c1)");
  const acc = contrast("var(--on-accent)", "var(--c2)");
  if (text < 4.5) w.push(t("ai.warn_contrast_text", { r: text.toFixed(1) }));
  if (acc < 3) w.push(t("ai.warn_contrast_accent", { r: acc.toFixed(1) }));
  return w;
}

export async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch {
    const ta = Object.assign(document.createElement("textarea"), {
      value: txt,
    });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
