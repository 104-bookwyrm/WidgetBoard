// Theme folders (themes/<name>/palette.png + theme.txt) turned into CSS for the board.
// Each level names a theme; the most specific wins: one widget > all widgets of its type > the board.
// A theme applied to a level brings its board row plus its row for the widget's type; empty squares fall through.
// Hand-picked colours from a widget's Look panel are inline styles, so they still win over every level.
import { readSheet, drawSheet, BLOCKS, BASIC, slotsOf, encodeCode, decodeCode } from "./palette.js";
import { cleanFont } from "./theme.js";
import { isLight } from "./util.js";

export { encodeCode, decodeCode, drawSheet, BLOCKS, BASIC, slotsOf };

const cache = new Map(); // name -> { mtime, theme }

/** theme.txt: "key = value" lines, "#" comments. Known keys become CSS variables; the rest is ignored. */
export function parseTxt(txt) {
  const vars = {};
  for (const line of String(txt || "").split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").match(/^\s*([a-z]+)\s*=\s*(.+?)\s*$/i);
    if (!m) continue;
    const [, k, v] = m, n = parseFloat(v);
    const key = k.toLowerCase();
    if (key === "font" && cleanFont(v)) vars["--font"] = `"${cleanFont(v)}", "Malgun Gothic", sans-serif`;
    else if (key === "size" && n >= 9 && n <= 36) vars["--font-size"] = `${n}px`;
    else if (key === "corners" && n >= 0 && n <= 60) vars["--radius"] = `${n}px`;
    else if (key === "outline" && n >= 0 && n <= 8) vars["--line-width"] = `${n}px`;
    else if (key === "opacity" && n >= 0 && n <= 1) vars["--widget-opacity"] = String(n);
  }
  return vars;
}

/** Decode a palette.png without premultiplying alpha (premultiplying shifts see-through colours). */
async function decode(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  return readSheet(g.getImageData(0, 0, bmp.width, bmp.height));
}

/**
 * Load every theme folder: [{ name, colors: { board: {...}, clock: {...} }, vars: {...from theme.txt} }].
 * info.png (browser mock) is a data URL; otherwise the file is read through the asset protocol.
 */
export async function loadThemes(invoke, themesDir, convert) {
  const list = await invoke("list_themes").catch(() => []);
  const sep = themesDir.includes("\\") ? "\\" : "/";
  const out = [];
  for (const info of Array.isArray(list) ? list : []) {
    const hit = cache.get(info.name);
    if (hit && hit.mtime === info.mtime) {
      out.push(hit.theme);
      continue;
    }
    const url = info.png ?? `${convert(themesDir + sep + String(info.file).split("/").join(sep))}?v=${info.mtime}`;
    const colors = await decode(url).catch(() => null);
    if (!colors) continue; // unreadable image: leave it out rather than break the board
    const theme = { name: info.name, colors, vars: parseTxt(info.txt), txt: info.txt || "", url };
    cache.set(info.name, { mtime: info.mtime, theme });
    out.push(theme);
  }
  return out;
}

// A row's colours as CSS declarations. Where the accent is set but its partners are not, derive them the same way
// the Look panel does, since inherited values were already resolved against the board's accent.
function decls(vars, derive) {
  const v = { ...vars };
  if (derive && v["--c2"] && !v["--on-accent"]) v["--on-accent"] = isLight(v["--c2"]) ? "#111111" : "#ffffff";
  if (derive && v["--c2"] && !v["--line-color"]) v["--line-color"] = `color-mix(in srgb, ${v["--c2"]} 55%, transparent)`;
  return Object.entries(v).map(([k, val]) => `${k}: ${val};`).join(" ");
}
/** What theme `t` gives a widget of `type`: its board row, its type row on top, theme.txt settings. */
const forType = (t, type) => ({ ...t.colors.board, ...t.colors[type], ...t.vars });

/**
 * One stylesheet for every level. assign: { board: name, types: { clock: name } }; widgets: [{ id, type, theme }],
 * type being what the user sees (a stopwatch, not the timer it is stored as), matched by the widget's data-kind.
 * Order is the cascade: board, then type rules, then single-widget rules.
 */
export function buildCss(themes, assign, widgets) {
  const by = new Map(themes.map((t) => [t.name, t]));
  const out = [];
  const board = by.get(assign?.board);
  if (board) {
    out.push(`:root { ${decls({ ...board.colors.board, ...board.vars }, false)} }`);
    for (const [type, row] of Object.entries(board.colors))
      if (type !== "board") out.push(`.widget[data-kind="${CSS.escape(type)}"] { ${decls(row, true)} }`);
  }
  for (const [type, name] of Object.entries(assign?.types || {})) {
    const t = by.get(name);
    if (t) out.push(`.widget[data-kind="${CSS.escape(type)}"] { ${decls(forType(t, type), true)} }`);
  }
  for (const w of widgets) {
    const t = w.theme && by.get(w.theme);
    if (t) out.push(`.widget[data-id="${CSS.escape(w.id)}"] { ${decls(forType(t, w.type), true)} }`);
  }
  return out.join("\n");
}

/** A theme's text code (colours only). */
export const codeOf = (t) => encodeCode(t.colors);

/** PNG bytes of a sheet, base64 (for save_theme_pack). */
export async function sheetBase64(colors, rows = BLOCKS.length) {
  const c = await drawSheet(colors, rows);
  return c.toDataURL("image/png").split(",")[1];
}

// "rgb(1 2 3)" / "color(srgb .1 .2 .3)" -> "#010203"; null when see-through (the sheet holds no alpha)
function hexOf(css) {
  const n = css.match(/[\d.]+/g);
  if (!n || n.length < 3 || (n.length > 3 && +n[3] < 1)) return null;
  const k = css.startsWith("color(") ? 255 : 1;
  return "#" + n.slice(0, 3).map((x) => Math.round(+x * k).toString(16).padStart(2, "0")).join("");
}

/** What a theme.css text looks like as a theme: { colors: { board, plus widget defaults }, txt }. */
export function fromCss(css) {
  const style = Object.assign(document.createElement("style"), { textContent: css.replace(/:root\b/g, ".wb-css-probe") });
  const box = Object.assign(document.createElement("div"), { className: "wb-css-probe", hidden: true });
  const probe = box.appendChild(document.createElement("span"));
  document.head.append(style);
  document.body.append(box);
  const cs = getComputedStyle(box);
  const colors = {};
  for (const block of BLOCKS)
    for (const s of slotsOf(block)) {
      let hex = s.default ?? null;
      if (block === "board" && cs.getPropertyValue(s.v).trim()) {
        probe.style.color = `var(${s.v})`;
        hex = hexOf(getComputedStyle(probe).color) ?? hex;
      }
      if (hex) (colors[block] ??= {})[s.v] = hex;
    }
  const num = (v) => parseFloat(cs.getPropertyValue(v));
  const font = cs.getPropertyValue("--font").split(",")[0].trim().replace(/^["']|["']$/g, "");
  const txt = [
    font && `font = ${font}`,
    num("--font-size") && `size = ${num("--font-size")}`,
    Number.isFinite(num("--radius")) && `corners = ${num("--radius")}`,
    Number.isFinite(num("--line-width")) && `outline = ${num("--line-width")}`,
    Number.isFinite(num("--widget-opacity")) && `opacity = ${num("--widget-opacity")}`,
  ].filter(Boolean).join("\n") + "\n";
  style.remove();
  box.remove();
  return { colors, txt };
}

/** "내 테마", "내 테마 2", ... the first one no folder uses yet. */
export function uniqueName(base, taken) {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) {
    const n = i === 1 ? base : `${base} ${i}`;
    if (!lower.has(n.toLowerCase())) return n;
  }
}

/** Write a theme folder; returns the name used. full = also write full.png (the Full template). */
export async function saveTheme(invoke, name, colors, txt, { rows, full = false, overwrite = false } = {}) {
  const used = await invoke("save_theme_pack", { name, png: await sheetBase64(colors, rows), txt, overwrite });
  if (full) await invoke("save_theme_pack", { name: used, png: await sheetBase64(colors), txt, overwrite: true, file: "full.png" });
  return used;
}

/**
 * First run: 기본 (the built-in look), 내 테마 (the user's current theme.css, to edit) and 빈 템플릿
 * (an empty Basic sheet as palette.png and an empty Full sheet as full.png). names: { base, mine, blank }.
 */
export async function seedThemes(invoke, defaultCss, currentCss, names) {
  // colours only: a theme.txt here would quietly override the font, size and slider settings under the cards
  const base = fromCss(defaultCss), mine = fromCss(currentCss);
  await saveTheme(invoke, names.base, base.colors, "", { rows: BASIC }).catch(() => {});
  await saveTheme(invoke, names.mine, mine.colors, "", { rows: BASIC }).catch(() => {});
  await saveTheme(invoke, names.blank, {}, "", { rows: BASIC, full: true }).catch(() => {});
}
