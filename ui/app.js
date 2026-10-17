// WidgetBoard front end (one instance per monitor): grid layout, drag/resize, theme, widget host.
import { loadLang, t } from "./i18n.js";
import {
  esc,
  wheelScrollX,
  osZone,
  occursOn,
  eventDone,
  zonedToInstant,
  ymd,
  addDays,
  syncScheme,
  isLight,
  mergeById,
  setWeekStart,
  assetUrl as assetUrlOf,
} from "./util.js";
import { sanitize, toHex, firstFamily, cleanFont } from "./theme.js";
import { icon } from "./icons.js";
import REGISTRY from "./widgets/index.js";
import CONTENT_KEYS from "./widgets/content-keys.json" with { type: "json" };
import GROUPS from "./widgets/groups.json" with { type: "json" };
import { createMockTauri } from "./mock-tauri.js";

const T = window.__TAURI__ ?? createMockTauri();
const invoke = (cmd, args, opts) => T.core.invoke(cmd, args, opts);
/** Writes that fail (disk full, file locked, ...) tell the user instead of failing silently. */
const saveFailed = (e) => {
  console.error(e);
  toast(t("toast.save_failed"));
  const err = e instanceof Error ? e : new Error(String(e));
  err.reported = true; // the global handler must not replace this message
  throw err;
};
const activeWrites = new Set();
const write = (cmd, args, opts) => {
  const promise = invoke(cmd, args, opts).catch(saveFailed);
  activeWrites.add(promise);
  promise.then(() => activeWrites.delete(promise), () => activeWrites.delete(promise));
  return promise;
};
/** Count a write the flush must wait for. */
const tracked = (promise) => {
  activeWrites.add(promise);
  promise.then(() => activeWrites.delete(promise), () => activeWrites.delete(promise));
  return promise;
};
const win = T.webviewWindow.getCurrentWebviewWindow();
const listen = (ev, h) => win.listen(ev, h); // only events for this board (or broadcasts)

const $ = (s) => document.querySelector(s);
const board = $("#board");
const mounted = new Map(); // id -> { el, inst }
const retired = new WeakSet(); // widget elements unmounted from this board (closed, moved, type changed)
let widgets = []; // widgets on this monitor
let myDisplay = "";
let displays = []; // [{ label, display, index, primary }]
let assetsDir = "";
let editMode = false;
let lang = "ko";
let config = {};
let reduceMotion = false;
/** Reduced motion: the tray setting, or Windows' own "Animation effects: off". */
const motionReduced = () =>
  reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
function setMotion(on) {
  reduceMotion = !!on;
  document.body.classList.toggle("reduce-motion", motionReduced());
}
const storeSubs = new Set(); // { key, src, cb }
let session = { launched: 0, closed: null }; // this launch and the last proper exit (ms), from load_state
const configSubs = new Set(); // cb(config)
// One date watcher for every widget (api.onDayChange); a minute's lag at midnight is fine.
const daySubs = new Set(); // cb(ymd)
let curDay = ymd();
setInterval(() => {
  if (ymd() === curDay) return;
  curDay = ymd();
  daySubs.forEach((cb) => cb(curDay));
}, 60000);

// ---------------- geometry ----------------
function metrics() {
  const cs = getComputedStyle(document.documentElement);
  const cell = parseFloat(cs.getPropertyValue("--cell")) || 80;
  const gap = parseFloat(cs.getPropertyValue("--gap")) || 10;
  const step = cell + gap;
  return {
    step,
    cols: Math.max(1, Math.floor((board.clientWidth - gap) / step)),
    rows: Math.max(1, Math.floor((board.clientHeight - gap) / step)),
  };
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function fits(r, ignoreId) {
  const m = metrics();
  if (r.x < 0 || r.y < 0 || r.x + r.w > m.cols || r.y + r.h > m.rows)
    return false;
  return !widgets.some((o) => o.id !== ignoreId && overlaps(r, o));
}
/** First free w×h spot, row by row. `fromRight` scans each row right to left (new widgets: desktop icons live top-left). */
function findSpot(w, h, ignoreId, fromRight = false) {
  const m = metrics();
  for (let y = 0; y + h <= m.rows; y++)
    for (let i = 0; i + w <= m.cols; i++) {
      const x = fromRight ? m.cols - w - i : i;
      if (fits({ x, y, w, h }, ignoreId)) return { x, y };
    }
  return null;
}

/**
 * Make room: place `rect` for widget `moverId` and push overlapping widgets aside
 * (cheapest of right / down / left / up, recursively). Returns Map id -> rect, or null if impossible.
 */
function resolve(moverId, rect) {
  const m = metrics();
  const inb = (r) =>
    r.x >= 0 && r.y >= 0 && r.x + r.w <= m.cols && r.y + r.h <= m.rows;
  if (!inb(rect)) return null;
  let pos = new Map(
    widgets.map((o) => [o.id, { id: o.id, x: o.x, y: o.y, w: o.w, h: o.h }]),
  );
  pos.set(moverId, { id: moverId, ...rect });
  let fixed = new Set([moverId]);
  let budget = 3000;
  function settle(id, depth) {
    for (;;) {
      if (--budget < 0 || depth > 20) return false;
      const p = pos.get(id);
      const o = [...pos.values()].find((q) => q.id !== id && overlaps(p, q));
      if (!o) return true;
      if (fixed.has(o.id)) return false;
      const opts = [
        { x: p.x + p.w, y: o.y, c: p.x + p.w - o.x }, // right
        { x: o.x, y: p.y + p.h, c: p.y + p.h - o.y }, // down
        { x: p.x - o.w, y: o.y, c: o.x + o.w - p.x }, // left
        { x: o.x, y: p.y - o.h, c: o.y + o.h - p.y }, // up
      ].sort((a, b) => a.c - b.c);
      let ok = false;
      for (const op of opts) {
        const cand = { ...o, x: op.x, y: op.y };
        if (!inb(cand)) continue;
        const snap = new Map([...pos].map(([k, v]) => [k, { ...v }]));
        const fsnap = new Set(fixed);
        pos.set(o.id, cand);
        fixed.add(o.id);
        if (settle(o.id, depth + 1)) {
          ok = true;
          break;
        }
        pos = snap;
        fixed = fsnap;
      }
      if (!ok) return false;
    }
  }
  return settle(moverId, 0) ? pos : null;
}

/** Apply a resolved layout to every widget (optionally only as a preview). */
function applyLayout(layout, { commit }) {
  for (const w of widgets) {
    const r = layout?.get(w.id) ?? w;
    const el = mounted.get(w.id)?.el;
    if (el) place(el, r);
    if (
      commit &&
      layout &&
      (r.x !== w.x || r.y !== w.y || r.w !== w.w || r.h !== w.h)
    ) {
      Object.assign(w, { x: r.x, y: r.y, w: r.w, h: r.h });
      save(w);
      mounted.get(w.id)?.inst.resized?.();
    }
  }
}

/**
 * Bring widgets that ended up outside the board (resolution / cell size changed) back inside.
 * Skipped while the board has an implausible size (window still being placed).
 */
function reflow() {
  if (board.clientWidth < 300 || board.clientHeight < 200) return;
  if (freeMode()) {
    // free mode: only what ended up outside the board (smaller screen, scaling change) comes back in
    let moved = 0;
    for (const w of widgets) {
      if (!w.free || !ensureFree(w)) continue;
      const el = mounted.get(w.id)?.el;
      if (el) place(el, w);
      save(w);
      moved++;
    }
    if (moved) (toast(t("toast.reflowed")), syncHits());
    return;
  }
  const m = metrics();
  let moved = 0;
  for (const w of widgets) {
    if (w.x >= 0 && w.y >= 0 && w.x + w.w <= m.cols && w.y + w.h <= m.rows)
      continue;
    const min = REGISTRY[w.type]?.min ?? { w: 1, h: 1 };
    const nw = clamp(w.w, min.w, m.cols),
      nh = clamp(w.h, min.h, m.rows);
    let r = {
      x: clamp(w.x, 0, m.cols - nw),
      y: clamp(w.y, 0, m.rows - nh),
      w: nw,
      h: nh,
    };
    if (!fits(r, w.id)) {
      const full = findSpot(nw, nh, w.id);
      const small = full ? null : findSpot(min.w, min.h, w.id);
      if (full) r = { ...full, w: nw, h: nh };
      else if (small) r = { ...small, w: min.w, h: min.h }; // else: stays overlapping but visible
    }
    Object.assign(w, r);
    const el = mounted.get(w.id)?.el;
    if (el) place(el, w);
    save(w);
    moved++;
  }
  if (moved) {
    toast(t("toast.reflowed"));
    syncHits();
  }
}
let reflowTimer;
const reflowSoon = () => {
  clearTimeout(reflowTimer);
  reflowTimer = setTimeout(reflow, 600);
};
function place(el, r) {
  for (const k of ["x", "y", "w", "h"]) el.style.setProperty("--" + k, r[k]);
  if (r.free)
    for (const k of ["x", "y", "w", "h"]) el.style.setProperty("--f" + k, r.free[k] + "px");
  el.style.setProperty("--z", Number.isFinite(r.z) ? r.z : 0);
}

// ---------------- free placement (Settings → 배치 방식 → 자유 배치) ----------------
// Simple mode is the grid with push-aside. In free mode every widget also has `free` = { x, y, w, h } in CSS px
// on this board, and a stacking order `z`; widgets may overlap. The grid position is kept, so each mode keeps its
// own arrangement: switching back to simple shows the grid layout again.
const freeMode = () => ui().layoutMode === "free";
const SNAP = 8; // px: how close a dragged edge must come to a guide to stick to it
function cellGap() {
  const cs = getComputedStyle(document.documentElement);
  return {
    cell: parseFloat(cs.getPropertyValue("--cell")) || 80,
    gap: parseFloat(cs.getPropertyValue("--gap")) || 10,
  };
}
/** Pixel rect of a grid rect (the same maths as the .widget CSS). */
function gridPx(r) {
  const { cell, gap } = cellGap();
  return {
    x: gap + r.x * (cell + gap),
    y: gap + r.y * (cell + gap),
    w: r.w * cell + (r.w - 1) * gap,
    h: r.h * cell + (r.h - 1) * gap,
  };
}
/** A widget's smallest free size: its grid minimum, in px. */
function minPx(w) {
  const min = (REGISTRY[w.type] ?? UNKNOWN).min ?? { w: 1, h: 1 };
  const p = gridPx({ x: 0, y: 0, ...min });
  return { w: p.w, h: p.h };
}
const boardOk = () => board.clientWidth >= 300 && board.clientHeight >= 200; // not while the window is being placed
/** Whole pixels, at least the minimum size, inside the board. */
function clampFree(f, w) {
  const r = { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) };
  const mn = minPx(w);
  if (!boardOk()) return { ...r, w: Math.max(r.w, mn.w), h: Math.max(r.h, mn.h) };
  const W = board.clientWidth,
    H = board.clientHeight;
  r.w = clamp(r.w, Math.min(mn.w, W), W);
  r.h = clamp(r.h, Math.min(mn.h, H), H);
  r.x = clamp(r.x, 0, W - r.w);
  r.y = clamp(r.y, 0, H - r.h);
  return r;
}
const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
/** Give `w` a free rect (from its grid spot) if it has none, and keep it legal. True when it changed. */
function ensureFree(w) {
  const before = w.free && { ...w.free };
  const f = clampFree(w.free ?? gridPx(w), w);
  w.free = f;
  if (!Number.isFinite(w.z)) w.z = 0;
  return !sameRect(before, f);
}
const topZ = () => Math.max(0, ...widgets.map((o) => (Number.isFinite(o.z) ? o.z : 0)));
// Layers (free mode), as in art programs: the order changes only on request (menu, Ctrl+[ ], the Layers panel);
// clicking or moving a widget leaves it where it is. Each widget has its own z, so nothing depends on DOM order.
/** Widgets, front first (equal z, from before z was kept unique: the later one is in front, as drawn). */
function layerOrder() {
  const at = new Map(widgets.map((o, i) => [o, i]));
  return [...widgets].sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || at.get(b) - at.get(a));
}
/** Renumber z from `order` (front first) as n..1; place and save the widgets whose z changed. */
function setLayers(order) {
  order.forEach((o, i) => {
    const z = order.length - i;
    if (o.z === z) return;
    o.z = z;
    const el = mounted.get(o.id)?.el;
    if (el) place(el, o);
    save(o);
  });
  if (!$("#layers-panel").hidden) renderLayers();
}
/** Move `w` one layer "up" / "down", or to the "front" / "back". */
function restack(w, to) {
  const order = layerOrder();
  const i = order.indexOf(w);
  order.splice(i, 1);
  const at = { front: 0, back: order.length, up: Math.max(0, i - 1), down: Math.min(order.length, i + 1) }[to];
  order.splice(at, 0, w);
  setLayers(order);
  announce(t("a11y.layer", { n: at + 1, total: order.length }));
}
/** Position lock (free mode): the widget can't be dragged, resized or moved with the keys. */
function setLocked(w, on) {
  if (on) w.locked = true;
  else delete w.locked;
  mounted.get(w.id)?.el.classList.toggle("locked", !!on);
  save(w);
  if (!$("#layers-panel").hidden) renderLayers();
}
/** Select a widget (the active layer): its grip takes the focus, so the arrow keys move it. */
function selectWidget(id) {
  const el = mounted.get(id)?.el;
  if (!el) return;
  el.querySelector(".grip")?.focus();
  locate(id);
}
function renderLayers() {
  const list = $("#layers-list");
  list.innerHTML = layerOrder()
    .map(
      (o) => `<li draggable="true" data-id="${esc(o.id)}">
        <button data-l="eye" title="${esc(t(o.hidden ? "layers.show" : "layers.hide"))}" aria-pressed="${!o.hidden}">${icon(o.hidden ? "eye-off" : "eye")}</button>
        <button data-l="lock" title="${esc(t(o.locked ? "layers.unlock" : "layers.lock"))}" aria-pressed="${!!o.locked}">${icon(o.locked ? "lock" : "lock-open")}</button>
        <button data-l="pick" class="ly-name${o.hidden ? " off" : ""}">${esc(widgetName(o))}</button>
        <button data-l="up" title="${esc(t("menu.forward"))}">${icon("up")}</button>
        <button data-l="down" title="${esc(t("menu.backward"))}">${icon("down")}</button>
      </li>`,
    )
    .join("");
}
function openLayers() {
  renderLayers();
  $("#layers-panel").hidden = false;
  $("#layers-list button")?.focus();
  syncHits();
}
$("#layers-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-l]");
  const w = widgets.find((o) => o.id === b?.closest("li").dataset.id);
  if (!w) return;
  const a = b.dataset.l;
  if (a === "eye") (setHidden(w, !w.hidden, true), renderLayers());
  else if (a === "lock") setLocked(w, !w.locked);
  else if (a === "pick") return selectWidget(w.id); // the widget keeps the focus: arrows move it
  else restack(w, a);
  $(`#layers-list li[data-id="${CSS.escape(w.id)}"] [data-l="${a}"]`)?.focus(); // the list was redrawn
});
// drag a row to reorder; drop above the row under the pointer (below it on its lower half)
let layerDrag = null;
$("#layers-list").addEventListener("dragstart", (e) => {
  layerDrag = e.target.closest("li")?.dataset.id ?? null;
  e.dataTransfer.effectAllowed = "move";
});
$("#layers-list").addEventListener("dragover", (e) => {
  if (!layerDrag) return;
  e.preventDefault();
  const li = e.target.closest("li");
  for (const x of $("#layers-list").children) x.classList.remove("drop-above", "drop-below");
  if (li) li.classList.add(e.offsetY > li.offsetHeight / 2 ? "drop-below" : "drop-above");
});
$("#layers-list").addEventListener("drop", (e) => {
  e.preventDefault();
  const li = e.target.closest("li");
  const w = widgets.find((o) => o.id === layerDrag);
  layerDrag = null;
  if (!li || !w || li.dataset.id === w.id) return renderLayers();
  const order = layerOrder().filter((o) => o !== w);
  const target = order.findIndex((o) => o.id === li.dataset.id);
  order.splice(target + (li.classList.contains("drop-below") ? 1 : 0), 0, w);
  setLayers(order);
  renderLayers();
});
$("#layers-list").addEventListener("dragend", () => ((layerDrag = null), renderLayers()));
$("#layers-close").onclick = () => (($("#layers-panel").hidden = true), syncHits());
$("#edit-layers").onclick = () => openLayers();
/** A free spot for a new w×h (px) widget: at `at` if given, else the first gap from the top-right; else on top. */
function freeSpot(size, at, ignoreId) {
  const W = board.clientWidth,
    H = board.clientHeight;
  const { cell, gap } = cellGap();
  const others = widgets.filter((o) => o.id !== ignoreId && o.free && !o.hidden).map((o) => o.free);
  if (at) return { x: at.x, y: at.y, ...size };
  const step = cell + gap;
  for (let y = gap; y + size.h <= H; y += step)
    for (let x = W - gap - size.w; x >= 0; x -= step) {
      const r = { x, y, ...size };
      if (!others.some((o) => overlaps(r, o))) return r;
    }
  return { x: W - gap - size.w, y: gap, ...size };
}
/** Back to simple mode: widgets placed while free may share grid cells; give them free cells where possible. */
function tidyGrid() {
  const m = metrics();
  const placed = [];
  let crowded = 0;
  for (const w of widgets) {
    const inb = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= m.cols && r.y + r.h <= m.rows;
    if (inb(w) && !placed.some((o) => overlaps(w, o))) {
      placed.push(w);
      continue;
    }
    const min = (REGISTRY[w.type] ?? UNKNOWN).min ?? { w: 1, h: 1 };
    let spot = null;
    for (const size of [{ w: w.w, h: w.h }, min]) {
      for (let y = 0; !spot && y + size.h <= m.rows; y++)
        for (let x = m.cols - size.w; !spot && x >= 0; x--) {
          const r = { x, y, ...size };
          if (!placed.some((o) => overlaps(r, o))) spot = r;
        }
      if (spot) break;
    }
    if (spot) Object.assign(w, spot);
    else crowded++;
    placed.push(w);
    save(w);
  }
  if (crowded) toast(t("toast.overlap"));
}
let shownMode = null;
/** Draw the board in the current mode; on a switch, prepare the other mode's positions. */
function applyLayoutMode() {
  const free = freeMode();
  if (free === shownMode) return;
  const switching = shownMode !== null;
  shownMode = free;
  board.classList.toggle("free", free);
  $("#edit-layers").hidden = !free;
  if (!switching) return; // boot: mount() prepares each widget
  if (free) {
    for (const w of widgets) if (ensureFree(w)) save(w);
    setLayers(layerOrder());
  } else tidyGrid();
  for (const w of widgets) {
    const el = mounted.get(w.id)?.el;
    if (el) place(el, w);
  }
  hideGuides();
  $("#edit-layers").hidden = !free;
  if (!free) $("#layers-panel").hidden = true;
  syncHits();
}

// Snap guides (free mode): screen edges, margins and centre, other widgets' edges and centres, and the spacings
// already used between neighbours (equal spacing). Alt while dragging places exactly.
function snapLines(others) {
  const W = board.clientWidth,
    H = board.clientHeight;
  const { gap } = cellGap();
  const xs = [0, gap, W - gap, W],
    ys = [0, gap, H - gap, H],
    cx = [W / 2],
    cy = [H / 2];
  const dx = new Set([gap]),
    dy = new Set([gap]);
  for (const a of others)
    for (const b of others) {
      if (a === b) continue;
      if (a.y < b.y + b.h && b.y < a.y + a.h && b.x >= a.x + a.w && b.x - (a.x + a.w) <= 240)
        dx.add(b.x - (a.x + a.w));
      if (a.x < b.x + b.w && b.x < a.x + a.w && b.y >= a.y + a.h && b.y - (a.y + a.h) <= 240)
        dy.add(b.y - (a.y + a.h));
    }
  for (const o of others) {
    xs.push(o.x, o.x + o.w);
    ys.push(o.y, o.y + o.h);
    for (const d of dx) xs.push(o.x + o.w + d, o.x - d);
    for (const d of dy) ys.push(o.y + o.h + d, o.y - d);
    cx.push(o.x + o.w / 2);
    cy.push(o.y + o.h / 2);
  }
  return { xs, ys, cx, cy };
}
/** Nearest guide for any of `edges` (and `centres`); { d, at } or null. */
function nearest(edges, targets, centres = [], ctargets = []) {
  let best = null;
  const tryAll = (ls, ts) => {
    for (const l of ls)
      for (const tg of ts) {
        const d = tg - l;
        if (Math.abs(d) <= SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: tg };
      }
  };
  tryAll(edges, targets);
  tryAll(centres, ctargets);
  return best;
}
function snapRect(r, mode, others) {
  const g = snapLines(others);
  const out = { ...r };
  const lines = [];
  if (mode === "move") {
    const sx = nearest([r.x, r.x + r.w], g.xs, [r.x + r.w / 2], g.cx);
    const sy = nearest([r.y, r.y + r.h], g.ys, [r.y + r.h / 2], g.cy);
    if (sx) (out.x += sx.d), lines.push({ v: sx.at });
    if (sy) (out.y += sy.d), lines.push({ h: sy.at });
  } else {
    const sx = nearest([r.x + r.w], g.xs);
    const sy = nearest([r.y + r.h], g.ys);
    if (sx) (out.w += sx.d), lines.push({ v: sx.at });
    if (sy) (out.h += sy.d), lines.push({ h: sy.at });
  }
  return { r: out, lines };
}
function showGuides(lines) {
  let g = $("#guides");
  if (!g) {
    g = document.createElement("div");
    g.id = "guides";
    g.setAttribute("aria-hidden", "true");
    document.body.append(g);
  }
  const b = board.getBoundingClientRect();
  g.innerHTML = lines
    .map((l) =>
      l.v != null
        ? `<i class="g-v" style="left:${b.left + l.v}px"></i>`
        : `<i class="g-h" style="top:${b.top + l.h}px"></i>`,
    )
    .join("");
}
const hideGuides = () => $("#guides")?.replaceChildren();

// ---------------- persistence (per widget; Rust owns layout.json and content.json) ----------------
const pending = new Map();
const unsaved = new Map();
/**
 * Library content (memo text, photo lists, timers...) lives in content.json, keyed by the placement id
 * (one placement per item). Widgets still see one merged `settings`; saving splits it again.
 */
const contents = new Map(); // id -> stored content item (with rev)
const isLibrary = (type) => !!CONTENT_KEYS[type];
const CONTENT_SRC = crypto.randomUUID(); // this window, so it can skip its own content-changed echo
/** [placement without content keys, content data or null for tools] */
function splitContent(w) {
  const keys = CONTENT_KEYS[w.type];
  if (!keys) return [w, null];
  const settings = { ...w.settings };
  const data = {};
  for (const k of keys)
    if (k in settings) {
      data[k] = settings[k];
      delete settings[k];
    }
  return [{ ...w, settings }, data];
}
/** Compare-and-write one content item. A stale revision adopts the newer item (a memo draft is archived first). */
async function persistContent(w, data, extra = {}) {
  const cur = contents.get(w.id);
  const name = w.name || "";
  const same =
    cur &&
    JSON.stringify(cur.data) === JSON.stringify(data) &&
    (cur.name || "") === name &&
    !Object.keys(extra).length;
  if (same) return;
  const item = { ...cur, id: w.id, type: w.type, name, data, ...extra };
  delete item.rev;
  const promise = invoke("content_put", { item, rev: cur?.rev ?? null, src: CONTENT_SRC }).then(
    (stored) => contents.set(w.id, stored),
    (e) => {
      if (e && "conflict" in e && e.conflict) return adoptNewer(w, e.conflict, data);
      return saveFailed(e?.error ?? e);
    },
  );
  activeWrites.add(promise);
  promise.finally(() => activeWrites.delete(promise));
  return promise;
}
function adoptNewer(w, item, draft) {
  if (w.type === "memo" && draft.text && draft.text !== item.data?.text)
    invoke("memo_archive", { id: w.id, name: w.name || "", text: draft.text, force: true }).catch(() => {});
  if (mounted.has(w.id)) remountWith(w, item);
  else contents.set(item.id, item);
}
/** A widget instance leaves this board: its element goes, and its late saves and pending undo with it. */
function retire(m) {
  if (!m) return;
  m.el.remove();
  retired.add(m.el);
  if (toastOwner === m.el) hideToast();
}
/** Show a newer version of a widget's content: drop its unsaved edit, then mount again. */
function remountWith(w, item) {
  const m = mounted.get(w.id);
  m?.inst.destroy?.();
  m?.inst.unsub?.();
  clearTimeout(pending.get(w.id)); // the destroy's flushed edit is the stale one
  pending.delete(w.id);
  unsaved.delete(w.id);
  retire(m);
  mounted.delete(w.id);
  contents.set(item.id, item);
  mount(w);
  save(w); // the placement's name copy follows a rename; unchanged content is not written again
  syncHits();
}
async function persistWidget(w) {
  const revision = unsaved.get(w.id);
  const [placement, data] = splitContent(w);
  if (data) await persistContent(w, data);
  await write("put_widget", { widget: placement });
  if (unsaved.get(w.id) === revision) unsaved.delete(w.id);
}
function save(w) {
  unsaved.set(w.id, { w });
  clearTimeout(pending.get(w.id));
  pending.set(
    w.id,
    setTimeout(() => {
      pending.delete(w.id);
      persistWidget(w).catch(() => {});
    }, 300),
  );
  if (w.type === "memo") archiveMemo(w);
}

// Memo archive (opt-in, config.archive.memos; Rust checks the flag and skips repeats).
// At most one version per memo per minute while typing; at once on close / quit, and before a big deletion.
const archiveTimers = new Map();
const memoPrev = new Map();
function archiveMemo(w, now) {
  const text = String(w.settings?.text ?? "");
  const prev = memoPrev.get(w.id) ?? text;
  memoPrev.set(w.id, text);
  const send = (txt) =>
    invoke("memo_archive", { id: w.id, name: w.name || "", text: txt }).catch(
      () => {},
    );
  if (text.length < prev.length / 2) send(prev); // cleared or mostly deleted: keep what was there
  if (now) {
    clearTimeout(archiveTimers.get(w.id));
    archiveTimers.delete(w.id);
    return send(text);
  }
  if (!archiveTimers.has(w.id))
    archiveTimers.set(
      w.id,
      setTimeout(() => {
        archiveTimers.delete(w.id);
        send(String(w.settings?.text ?? ""));
      }, 60000),
    );
}

// Tell Rust where the widgets are so clicks elsewhere pass through to the desktop / windows.
let hitTimer;
function syncHits() {
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => {
    const rects = [
      ...document.querySelectorAll(".widget, [data-hit]:not([hidden])"),
    ]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      })
      .filter((r) => r.w > 0 && r.h > 0); // hidden by focus mode etc.
    invoke("set_hit_rects", { rects }).catch(console.error);
  }, 160); // after the snap transition settles
}

// ---------------- assets ----------------
const assetUrl = (name) => assetUrlOf(assetsDir, name, T.core.convertFileSrc);
function pickFiles(multiple) {
  return new Promise((resolve) => {
    const input = $("#file-picker");
    input.value = "";
    input.multiple = multiple;
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}
const pickImage = async () => (await pickFiles(false))[0] || null;
const pickImages = () => pickFiles(true);
const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/avif": "avif",
};
async function uploadImage(file, tooBigKey = "toast.too_big") {
  if (file.size > 30 * 1024 * 1024) {
    toast(t(tooBigKey));
    throw new Error("file too large");
  }
  const ext =
    MIME_EXT[file.type] ||
    (file.name.includes(".")
      ? file.name.split(".").pop()
      : "png"
    ).toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke("save_asset", bytes, { headers: { ext } });
}

// ---------------- widgets ----------------
const injectedCss = new Set();
const UNKNOWN = {
  min: { w: 1, h: 1 },
  mount: (root, s, api) => {
    root.innerHTML = `<div class="w-error">${esc(api.t("toast.unknown_widget"))}</div>`;
  },
};
/** Repair whatever a hand-edited or older layout.json may contain. */
function sanitizeWidget(w, def) {
  const min = def.min ?? { w: 1, h: 1 };
  const int = (v, d) => (Number.isFinite(+v) ? Math.round(+v) : d);
  w.x = Math.max(0, int(w.x, 0));
  w.y = Math.max(0, int(w.y, 0));
  w.w = Math.max(min.w, int(w.w, def.size?.w ?? min.w));
  w.h = Math.max(min.h, int(w.h, def.size?.h ?? min.h));
  const defaults = structuredClone(def.defaults ?? {});
  w.settings =
    w.settings && typeof w.settings === "object" && !Array.isArray(w.settings)
      ? { ...defaults, ...w.settings }
      : defaults;
  const f = w.free;
  if (f && typeof f === "object" && ["x", "y", "w", "h"].every((k) => Number.isFinite(+f[k])))
    w.free = { x: Math.round(+f.x), y: Math.round(+f.y), w: Math.round(+f.w), h: Math.round(+f.h) };
  else delete w.free;
  if (Number.isFinite(+w.z) && w.z !== null && w.z !== "") w.z = Math.round(+w.z);
  else delete w.z;
  if (typeof w.name === "string") w.name = w.name.trim().slice(0, 40);
  if (!w.name || typeof w.name !== "string") delete w.name;
  if (w.hidden !== true) delete w.hidden;
  if (w.locked !== true) delete w.locked;
  if (typeof w.font !== "string" || !w.font) delete w.font;
  if (!(w.fontSize >= 6 && w.fontSize <= 96)) delete w.fontSize;
  if (!w.colors || typeof w.colors !== "object" || Array.isArray(w.colors))
    delete w.colors;
  if (
    w.frame !== undefined &&
    w.frame !== "custom" &&
    !FRAMES.includes(w.frame)
  )
    delete w.frame;
  if (
    typeof w.frameSvg !== "string" ||
    !w.frameSvg.startsWith("data:image/svg+xml")
  )
    delete w.frameSvg;
}

function mount(w) {
  const def = REGISTRY[w.type] ?? UNKNOWN;
  // the id already names another type's content (hand-edited data): new content, never overwrite that one
  if (isLibrary(w.type) && contents.has(w.id) && contents.get(w.id).type !== w.type) w.id = crypto.randomUUID();
  const item = isLibrary(w.type) ? contents.get(w.id) : null;
  if (item) {
    w.settings = { ...w.settings, ...item.data };
    if (item.name) w.name = item.name;
    else delete w.name;
  }
  sanitizeWidget(w, def);
  const freed = freeMode() && ensureFree(w);
  if ((isLibrary(w.type) && !item) || freed) save(w); // new (or pre-Library) content gets its item now
  if (w.type === "memo") memoPrev.set(w.id, String(w.settings?.text ?? ""));
  if (def.css && !injectedCss.has(w.type)) {
    const st = document.createElement("style");
    st.textContent = def.css;
    document.head.insertBefore(st, $("#user-theme")); // theme can still override
    injectedCss.add(w.type);
  }
  const el = document.createElement("div");
  el.className = "widget";
  el.dataset.widget = w.type;
  el.dataset.id = w.id;
  el.classList.toggle("w-hidden", !!w.hidden);
  el.classList.toggle("locked", !!w.locked);
  const name = widgetName(w);
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", name);
  el.innerHTML = `
    <div class="w-bg" hidden></div>
    <div class="w-body"></div>
    <div class="w-frame" aria-hidden="true"></div>
    <div class="w-head">
      <button class="grip" data-act="grip" title="${esc(t("a11y.grip", { name }))}">${icon("grip")}</button><span class="title">${esc(name)}</span>
      <span class="w-hint" title="${esc(t("hint." + w.type))}">${esc(t("hint." + w.type))}</span>
      <button data-act="remove" title="${esc(t("menu.close"))}">${icon("x")}</button>
    </div>
    <div class="w-resize" aria-hidden="true"></div>`;
  place(el, w);
  board.append(el);

  const subs = [];
  // Shared stores: each write names the revision this widget last read. A stale one is merged by id with
  // what is stored now (mergeById), then the widget re-reads so it shows the merged list.
  const seen = new Map(); // key -> { value, rev }
  async function writeStore(key, value) {
    for (let tries = 0; tries < 3; tries++) {
      const base = seen.get(key);
      try {
        const rev = await invoke("store_set", { key, value, src: w.id, rev: base?.rev ?? null });
        seen.set(key, { value: structuredClone(value), rev });
        if (tries) for (const s of storeSubs) if (s.key === key && s.src === w.id) s.cb({ key, src: "merge" });
        return;
      } catch (e) {
        if (e !== "conflict") return saveFailed(e);
        const latest = await invoke("store_read", { key });
        value = mergeById(base?.value, value, latest.value);
        seen.set(key, { value: structuredClone(latest.value), rev: latest.rev });
      }
    }
    saveFailed("conflict");
  }
  // Diary pages are plain text: on a stale revision the latest typing wins.
  async function writeDiary(date, text) {
    for (let tries = 0; tries < 3; tries++) {
      try {
        const rev = await invoke("diary_set", { date, text, src: w.id, rev: seen.get("diary:" + date)?.rev ?? null });
        seen.set("diary:" + date, { rev });
        return;
      } catch (e) {
        if (e !== "conflict") return saveFailed(e);
        seen.set("diary:" + date, { rev: (await invoke("diary_read", { date })).rev });
      }
    }
    saveFailed("conflict");
  }
  const api = {
    save: () => !retired.has(el) && save(w), // a late callback from a closed or moved widget never writes
    pickImage,
    pickImages,
    uploadImage,
    assetUrl,
    toast,
    /** "Deleted" toast with an undo button; restore() puts the item back. */
    deleted: (restore) =>
      toast(t("toast.deleted"), { label: t("toast.undo"), fn: restore }, el),
    t,
    lang,
    wheelScrollX,
    /** Frameless: no background/outline, so transparent images sit directly on the desktop. */
    setFrameless: (on) => el.classList.toggle("frameless", !!on),
    /** Listen to an app event (e.g. 'media'); removed automatically when the widget closes. */
    on: (event, cb) => {
      let off = null,
        gone = false;
      listen(event, (e) => cb(e.payload)).then((u) => (gone ? u() : (off = u)));
      subs.push(() => ((gone = true), off?.()));
    },
    media: {
      subscribe: () => invoke("media_subscribe"),
      control: (action, seconds) =>
        invoke("media_control", { action, seconds }).catch(() => {}),
    },
    get id() {
      return w.id;
    },
    /**
     * A run that started at `start` (ms) before this launch: { at } = the app was closed properly then, stop it
     * there; { at, crash: true } = it never closed properly (crash, killed), `at` is this launch. Null otherwise.
     */
    leftover: (start) =>
      !(start < session.launched)
        ? null
        : session.closed >= start
          ? { at: session.closed }
          : { at: session.launched, crash: true },
    /** A gap between two ticks this long (ms) means the PC slept: counting widgets ask whether to keep it. 0 = never. */
    awayMs: () => Math.max(0, Number(ui().awayMinutes) || 0) * 60000,
    get size() {
      return { w: w.w, h: w.h };
    },
    get reduceMotion() {
      return motionReduced();
    },
    announce: (msg) => announce(msg),
    /** Something needs attention (timer done…): sound is the widget's job; this adds the opt-in visual/Windows alerts. */
    alert: (title, body) => alertUser(title, body),
    get config() {
      return config;
    },
    setInteracting: (on) => invoke("set_interacting", { on }),
    /** Open an http(s) link in the default browser (event links; the native side guards the scheme). */
    openUrl: (url) => invoke("open_url", { url }).catch(() => {}),
    listAssets: () => invoke("list_assets"),
    store: {
      get: async (key) => {
        const r = await invoke("store_read", { key });
        seen.set(key, { value: structuredClone(r.value), rev: r.rev });
        return r.value;
      },
      set: (key, value) => tracked(writeStore(key, value)),
    },
    diary: {
      get: async (date) => {
        const r = await invoke("diary_read", { date });
        seen.set("diary:" + date, { rev: r.rev });
        return r.text;
      },
      set: (date, text) => tracked(writeDiary(date, text)),
      dates: () => invoke("diary_dates"),
    },
    /** cb(payload) when another widget changes `key` ('diary' for diary pages). */
    onStore: (key, cb) => {
      const s = { key, src: w.id, cb };
      storeSubs.add(s);
      subs.push(() => storeSubs.delete(s));
    },
    onConfig: (cb) => {
      configSubs.add(cb);
      subs.push(() => configSubs.delete(cb));
    },
    /** cb(ymd) when the local date changes (midnight, or waking up on a later day). */
    onDayChange: (cb) => {
      daySubs.add(cb);
      subs.push(() => daySubs.delete(cb));
    },
    /** Ask for a bigger/smaller size; neighbours are pushed aside if needed. Returns true on success. */
    requestSize: (size) => {
      if (freeMode() && w.free) {
        // free mode: the asked cell size in px, grown from the same corner, nothing pushed
        const p = gridPx({ x: 0, y: 0, ...size });
        w.free = clampFree({ ...w.free, w: p.w, h: p.h }, w);
        place(el, w);
        save(w);
        syncHits();
        return true;
      }
      const m = metrics();
      const r = {
        w: clamp(size.w, def.min?.w ?? 1, m.cols),
        h: clamp(size.h, def.min?.h ?? 1, m.rows),
      };
      r.x = clamp(w.x, 0, m.cols - r.w);
      r.y = clamp(w.y, 0, m.rows - r.h);
      const layout = resolve(w.id, r);
      if (!layout) return (toast(t("toast.no_room")), false);
      applyLayout(layout, { commit: true });
      syncHits();
      return true;
    },
  };
  let inst;
  const body = el.querySelector(".w-body");
  try {
    inst = def.mount(body, w.settings, api);
    if (!inst || typeof inst !== "object") inst = {};
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="w-error">${esc(t("toast.widget_error"))}<small>${esc(e?.message ?? e)}</small></div>`;
    inst = {};
  }
  inst.unsub = () => subs.forEach((f) => f());
  mounted.set(w.id, { el, inst });
  applyBg(el, w);
  applyFont(el, w);
  applyColors(el, w);
  applyFrame(el, w);
  wireFrame(el, w, def, inst);
}

function applyBg(el, w) {
  const bg = el.querySelector(".w-bg");
  bg.hidden = !w.bg;
  bg.style.backgroundImage = w.bg ? `url("${assetUrl(w.bg)}")` : "";
}

function applyFont(el, w) {
  el.style.setProperty(
    "--font",
    w.font ? `"${cleanFont(w.font)}", "Malgun Gothic", sans-serif` : "",
  );
  el.style.setProperty("--font-size", w.fontSize ? `${w.fontSize}px` : "");
}

// ---- font list + per-widget font panel ----
let fontsLoaded = false;
async function loadFonts() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  const fonts = await invoke("list_fonts").catch(() => []);
  $("#font-list").innerHTML = (fonts || [])
    .map((f) => `<option value="${esc(f)}">`)
    .join("");
}
let fontTarget = null;
function openFontPanel(w, el) {
  loadFonts();
  fontTarget = { w, el };
  const p = $("#font-panel");
  const cs = getComputedStyle(el);
  $("#fp-family").value = w.font || "";
  $("#fp-family").placeholder = firstFamily(cs.getPropertyValue("--font"));
  $("#fp-size").value =
    w.fontSize || parseFloat(cs.getPropertyValue("--font-size")) || 14;
  $("#fp-size-out").textContent = $("#fp-size").value + "px";
  fillLook(w, el);
  p.hidden = false;
  const r = el.getBoundingClientRect(),
    pw = p.offsetWidth,
    ph = p.offsetHeight;
  const left =
    r.right + 8 + pw < innerWidth ? r.right + 8 : Math.max(8, r.left - pw - 8);
  p.style.left = left + "px";
  p.style.top = clamp(r.top, 8, innerHeight - ph - 8) + "px";
  syncHits();
}
function closeFontPanel() {
  $("#font-panel").hidden = true;
  fontTarget = null;
  syncHits();
}
$("#fp-family").addEventListener("change", () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  w.font = cleanFont($("#fp-family").value) || undefined;
  applyFont(el, w);
  save(w);
});
$("#fp-size").addEventListener("input", () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  w.fontSize = +$("#fp-size").value;
  $("#fp-size-out").textContent = w.fontSize + "px";
  applyFont(el, w);
  save(w);
});
$("#fp-reset").onclick = () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  for (const k of ["font", "fontSize", "colors", "frame", "frameSvg"])
    delete w[k];
  applyFont(el, w);
  applyColors(el, w);
  applyFrame(el, w);
  save(w);
  openFontPanel(w, el);
};
for (const b of document.querySelectorAll("#font-panel .mini")) b.innerHTML = icon("reset");
/** Per-widget colours: an unset colour follows the theme (shown faded, no reset button). */
function fillLook(w, el) {
  const c = w.colors || {};
  const cs = getComputedStyle(el);
  for (const lab of document.querySelectorAll("#font-panel [data-col]")) {
    const k = lab.dataset.col;
    const inp = lab.querySelector("input");
    const set = c[k] !== undefined && c[k] !== "";
    lab.classList.toggle("unset", !set);
    if (k === "opacity")
      inp.value = set
        ? c[k]
        : parseFloat(cs.getPropertyValue("--widget-opacity")) || 0.85;
    else
      inp.value = set
        ? c[k]
        : toHex(
            k === "frame"
              ? cs.getPropertyValue("--frame-color") ||
                  cs.getPropertyValue("--c2")
              : cs.getPropertyValue("--" + k),
          );
  }
  $("#fp-frame").value = w.frame ?? "";
}
for (const lab of document.querySelectorAll("#font-panel [data-col]")) {
  const k = lab.dataset.col;
  const inp = lab.querySelector("input");
  const setCol = (v) => {
    if (!fontTarget) return;
    const { w, el } = fontTarget;
    const c = { ...(w.colors || {}) };
    if (v === undefined) delete c[k];
    else c[k] = v;
    if (Object.keys(c).length) w.colors = c;
    else delete w.colors;
    applyColors(el, w);
    save(w);
    fillLook(w, el);
  };
  inp.addEventListener("input", () =>
    setCol(k === "opacity" ? +inp.value : inp.value),
  );
  lab.querySelector(".mini").onclick = (e) => (
    e.preventDefault(),
    setCol(undefined)
  );
}
$("#fp-frame").addEventListener("change", async () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  const v = $("#fp-frame").value;
  if (v === "custom" && !w.frameSvg) return $("#fp-svg").click();
  if (v) w.frame = v;
  else delete w.frame;
  applyFrame(el, w);
  save(w);
});
/** Custom frame: any SVG, drawn 9-slice (outer 30% = corners) in the frame colour. Stored inline, max 100 KB. */
$("#fp-svg").onclick = async () => {
  if (!fontTarget) return;
  const target = fontTarget;
  const input = $("#file-picker");
  input.accept = "image/svg+xml,.svg";
  const f = (await pickFiles(false))[0];
  input.accept = "image/*";
  const { w, el } = target;
  if (!f) return fillLook(w, el);
  if (f.size > 100 * 1024) return (toast(t("look.svg_big")), fillLook(w, el));
  const txt = await f.text();
  if (!/<svg[\s>]/i.test(txt))
    return (toast(t("look.svg_bad")), fillLook(w, el));
  w.frameSvg =
    "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(txt)));
  w.frame = "custom";
  applyFrame(el, w);
  save(w);
  if (fontTarget === target) fillLook(w, el);
};
$("#fp-close").onclick = closeFontPanel;

function unmount(w) {
  const m = mounted.get(w.id);
  m?.inst.destroy?.(); // may flush a last edit into w (memo) and queue a save...
  m?.inst.unsub?.();
  clearTimeout(pending.get(w.id)); // ...which must not land after a remove/move: callers write w themselves
  pending.delete(w.id);
  unsaved.delete(w.id);
  retire(m);
  mounted.delete(w.id);
  widgets = widgets.filter((o) => o.id !== w.id);
  if (fontTarget?.w.id === w.id) closeFontPanel();
  syncHits();
}

/** Off the board. Library content stays, remembering where it was so reopening puts it back. */
function closeContent(w) {
  if (w.type === "memo") archiveMemo(w, true);
  const [placement, data] = splitContent(w);
  if (data) persistContent(w, data, { placement }).catch(() => {});
  write("remove_widget", { id: w.id }).catch(() => {});
}
let lastClosed = null;
function removeWidget(w) {
  unmount(w); // first: the widget's destroy flushes its latest edit into w
  lastClosed = structuredClone(w);
  closeContent(w);
  toast(t("toast.closed", { name: widgetName(w) }), {
    label: t("toast.undo"),
    fn: restoreClosed,
  });
}
function restoreClosed() {
  const w = lastClosed;
  lastClosed = null;
  if (!w || mounted.has(w.id)) return;
  if (!fits(w, w.id)) {
    const room = findRoom(REGISTRY[w.type] ?? UNKNOWN, { w: w.w, h: w.h });
    if (room) Object.assign(w, room);
  }
  widgets.push(w);
  mount(w);
  save(w);
  syncHits();
}

const widgetName = (w) => w.name || t("widget." + w.type);
function applyName(w) {
  const el = mounted.get(w.id)?.el;
  if (!el) return;
  const name = widgetName(w);
  el.setAttribute("aria-label", name);
  el.querySelector(".w-head .title").textContent = name;
  el.querySelector(".grip").title = t("a11y.grip", { name });
}
/** Hidden: kept alive with its grid space, not drawn (a ghost in edit mode). Shown again from settings. */
function setHidden(w, on, quiet) {
  if (on) w.hidden = true;
  else delete w.hidden;
  mounted.get(w.id)?.el.classList.toggle("w-hidden", !!on);
  save(w);
  syncHits();
  if (on && !quiet)
    toast(t("toast.hidden", { name: widgetName(w) }), {
      label: t("toast.undo"),
      fn: () => setHidden(w, false, true),
    });
}
function locate(id) {
  const el = mounted.get(id)?.el;
  if (!el) return;
  el.classList.remove("w-locate");
  void el.offsetWidth; // restart the pulse
  el.classList.add("w-locate");
  setTimeout(() => el.classList.remove("w-locate"), 1700);
}

/**
 * Change a widget's type (timer → stopwatch …): the old widget closes (its content stays in the Library) and a
 * new one takes its place. Position, monitor, background and font stay.
 */
function changeType(w, type) {
  const def = REGISTRY[type];
  if (!def || type === w.type) return;
  const from = { type: w.type, settings: w.settings };
  const m = mounted.get(w.id);
  m?.inst.destroy?.(); // flushes the last edit into w
  m?.inst.unsub?.();
  clearTimeout(pending.get(w.id));
  pending.delete(w.id);
  unsaved.delete(w.id);
  retire(m);
  mounted.delete(w.id);
  closeContent(structuredClone(w));
  w.id = crypto.randomUUID();
  w.type = type;
  w.settings = { ...structuredClone(def.defaults ?? {}), ...carried(from, type) };
  delete w.name;
  delete w.stash;
  const min = def.min ?? { w: 1, h: 1 };
  if (w.w < min.w || w.h < min.h) {
    const g = metrics();
    const r = {
      w: clamp(Math.max(w.w, min.w), 1, g.cols),
      h: clamp(Math.max(w.h, min.h), 1, g.rows),
    };
    r.x = clamp(w.x, 0, g.cols - r.w);
    r.y = clamp(w.y, 0, g.rows - r.h);
    const lay = resolve(w.id, r);
    if (lay) applyLayout(lay, { commit: true });
    else (Object.assign(w, r), toast(t("toast.overlap")));
  }
  mount(w);
  save(w);
  syncHits();
  announce(t("a11y.type_changed", { name: t("widget." + type) }));
}

// Switching inside Images keeps the pictures (imgs), their labels, fit and frameless.
// Switching between Now Playing and its "audioplayer" alias keeps the tracks and playback settings.
// ponytail: Time widgets' run states don't map.
// "collection" is no longer in groups.json (it is the Image widget's alias), so it counts as an Images member here.
function carried(from, type) {
  const media = (k) => k === "audioplayer" || k === "nowplaying";
  if (media(from.type) && media(type)) {
    const s = from.settings ?? {};
    const out = {};
    for (const k of ["tracks", "current", "volume", "shuffle", "loop"]) if (k in s) out[k] = structuredClone(s[k]);
    return out;
  }
  const images = (k) => k === "collection" || groupOf(k)?.id === "images";
  if (!images(from.type) || !images(type)) return {};
  const s = from.settings ?? {};
  const to = REGISTRY[type].defaults ?? {};
  const out = { frameless: !!s.frameless, imgs: Array.isArray(s.imgs) ? [...s.imgs] : [] };
  for (const k of ["labels", "fit"]) if (k in to && s[k]) out[k] = structuredClone(s[k]);
  return out;
}

const groupOf = (type) => GROUPS.find((g) => g.widgets.includes(type));
// Menu items for widget types; pick(type) runs on click.
const typeItems = (types, pick) =>
  types.filter((k) => REGISTRY[k]).map((k) => ({ text: t("widget." + k), action: () => pick(k) }));
// One submenu per group (groups.json), leaving out `skip`; a group of one widget is a plain item.
const groupMenus = (pick, skip) =>
  GROUPS.filter((g) => g !== skip).flatMap((g) => {
    const items = typeItems(g.widgets, pick);
    return items.length === 1 ? items : [{ text: t("group." + g.id), items }];
  });

async function setBg(w, el) {
  const f = await pickImage();
  if (!f) return;
  w.bg = await uploadImage(f);
  applyBg(el, w);
  save(w);
}

async function moveTo(w, display) {
  unmount(w); // destroy flushes the latest edit into w; its queued save is dropped
  await persistWidget(w).catch(() => {});
  await invoke("move_widget", { id: w.id, display });
}

const displayName = (d) =>
  t("menu.display", { n: d.index }) +
  (d.primary ? " " + t("menu.primary") : "");

// Right-click menu on a widget. Lean while viewing; arrangement tools appear in edit mode.
let lastMenu;
async function openMenu(w, el, at) {
  const own = mounted.get(w.id)?.inst.menu?.() ?? [];
  const ownBlock = own.length ? [...own, { item: "Separator" }] : [];
  // free mode: widgets under the pointer, to select one that is covered (art programs: pick a layer)
  const under = at
    ? [...new Set(document.elementsFromPoint(at.x, at.y).map((n) => n.closest?.(".widget")?.dataset.id))]
        .map((id) => widgets.find((o) => o.id === id))
        .filter((o) => o && o !== w)
    : [];
  const stack = freeMode()
    ? [
        { item: "Separator" },
        { text: t("menu.forward"), action: () => restack(w, "up") },
        { text: t("menu.backward"), action: () => restack(w, "down") },
        { text: t("menu.front"), action: () => restack(w, "front") },
        { text: t("menu.back"), action: () => restack(w, "back") },
        { text: (w.locked ? "✓ " : "") + t("menu.lock"), action: () => setLocked(w, !w.locked) },
        ...(under.length
          ? [{ text: t("menu.pick"), items: under.map((o) => ({ text: widgetName(o), action: () => selectWidget(o.id) })) }]
          : []),
        { text: t("layers.open"), action: () => openLayers() },
      ]
    : [];
  const manage = [
    ...stack,
    { item: "Separator" },
    w.hidden
      ? { text: t("menu.show"), action: () => setHidden(w, false) }
      : { text: t("menu.hide"), action: () => setHidden(w, true) },
    { text: t("menu.close"), action: () => removeWidget(w) },
    { text: t("menu.library"), action: () => invoke("open_library").catch(() => {}) },
    { text: t("menu.search"), action: () => invoke("open_library", { page: "search" }).catch(() => {}) },
  ];
  let items;
  if (editMode) {
    // Edit layout: customise and arrange this widget.
    const others = displays.filter((d) => d.display !== myDisplay);
    items = [
      ...ownBlock,
      { text: t("menu.look"), action: () => openFontPanel(w, el) },
      { text: t("menu.set_bg"), action: () => setBg(w, el) },
      ...(w.bg
        ? [
            {
              text: t("menu.clear_bg"),
              action: () => {
                delete w.bg;
                applyBg(el, w);
                save(w);
              },
            },
          ]
        : []),
      {
        // siblings in the same group first, then every other group
        text: t("menu.change_type"),
        items: [
          ...typeItems(groupOf(w.type)?.widgets.filter((k) => k !== w.type) ?? [], (k) => changeType(w, k)),
          ...(groupOf(w.type)?.widgets.length > 1 ? [{ item: "Separator" }] : []),
          { text: t("menu.other_types"), items: groupMenus((k) => changeType(w, k), groupOf(w.type)) },
        ],
      },
      ...(others.length
        ? [
            {
              text: t("menu.move_to"),
              items: others.map((d) => ({
                text: displayName(d),
                action: () => moveTo(w, d.display),
              })),
            },
          ]
        : []),
      ...manage,
    ];
  } else {
    // Viewing: the widget's own options plus the few things people reach for.
    items = [
      ...ownBlock,
      { text: t("menu.look"), action: () => openFontPanel(w, el) },
      document.body.classList.contains("focus-mode")
        ? { text: t("focus.exit"), action: exitFocus }
        : { text: t("focus.enter"), action: () => enterFocus(w.id) },
      ...(ui().announceSummary
        ? [{ text: t("menu.summary"), action: () => announceSummary(w) }]
        : []),
      ...manage,
    ];
  }
  try {
    await lastMenu?.close();
  } catch {}
  lastMenu = await T.menu.Menu.new({ items });
  await lastMenu.popup();
}

// Right-click menu on empty board space (edit mode only): add a widget where clicked.
async function openAddMenu(cell, at) {
  const items = [
    ...groupMenus((k) => addWidgetAt(k, cell, at)),
    { item: "Separator" },
    { text: t("edit.done"), action: () => invoke("set_edit_mode", { on: false }) },
  ];
  try {
    await lastMenu?.close();
  } catch {}
  lastMenu = await T.menu.Menu.new({ items });
  await lastMenu.popup();
}

function wireFrame(el, w, def, inst) {
  el.querySelector("[data-act=remove]").onclick = () => removeWidget(w);
  el.addEventListener("contextmenu", (e) => {
    if (e.target.closest("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    openMenu(w, el, { x: e.clientX, y: e.clientY });
  });
  // keyboard: Menu key / Shift+F10 opens the widget menu from anywhere inside it
  el.addEventListener("keydown", (e) => {
    if (
      (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) &&
      !e.target.closest("input, textarea")
    ) {
      e.preventDefault();
      openMenu(w, el);
    }
  });

  const min = def.min ?? { w: 1, h: 1 };
  // keyboard: focus the ⋮⋮ grip, arrows move, Shift+arrows resize, Delete closes (with undo)
  const DIRS = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  el.querySelector(".grip").addEventListener("keydown", (e) => {
    if (e.key === "Delete") {
      e.preventDefault();
      return removeWidget(w);
    }
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      return announceSummary(w);
    }
    if (freeMode() && e.ctrlKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
      // art-program shortcuts: Ctrl+] / Ctrl+[ one layer, with Shift to the front / back
      e.preventDefault();
      const up = e.code === "BracketRight";
      return restack(w, e.shiftKey ? (up ? "front" : "back") : up ? "up" : "down");
    }
    const d = DIRS[e.key];
    if (!d) return;
    e.preventDefault();
    if (freeMode() && w.locked) return announce(t("layers.locked"));
    if (freeMode()) {
      // free mode: 10 px per press, 1 px with Alt; Shift resizes
      const n = e.altKey ? 1 : 10;
      const f = w.free;
      const next = clampFree(
        e.shiftKey
          ? { ...f, w: f.w + d[0] * n, h: f.h + d[1] * n }
          : { ...f, x: f.x + d[0] * n, y: f.y + d[1] * n },
        w,
      );
      if (sameRect(next, f)) return announce(t("a11y.edge"));
      w.free = next;
      place(el, w);
      save(w);
      syncHits();
      return announce(
        t(e.shiftKey ? "a11y.resized_px" : "a11y.moved_px", { x: next.x, y: next.y, w: next.w, h: next.h }),
      );
    }
    const g = metrics();
    const r = e.shiftKey
      ? {
          x: w.x,
          y: w.y,
          w: clamp(w.w + d[0], min.w, g.cols - w.x),
          h: clamp(w.h + d[1], min.h, g.rows - w.y),
        }
      : {
          x: clamp(w.x + d[0], 0, g.cols - w.w),
          y: clamp(w.y + d[1], 0, g.rows - w.h),
          w: w.w,
          h: w.h,
        };
    if (r.x === w.x && r.y === w.y && r.w === w.w && r.h === w.h)
      return announce(t("a11y.edge"));
    const lay = resolve(w.id, r);
    if (!lay) return announce(t("toast.no_room"));
    applyLayout(lay, { commit: true });
    syncHits();
    announce(
      t(e.shiftKey ? "a11y.resized" : "a11y.moved", {
        x: w.x + 1,
        y: w.y + 1,
        w: w.w,
        h: w.h,
      }),
    );
  });
  /** Free mode drag/resize: pixels, snap guides (Alt: none), overlap allowed; a moved widget comes to the front. */
  function freeDrag(e, handle, mode, carry) {
    const f0 = { ...w.free };
    let cand = { ...f0 };
    const others = widgets.filter((o) => o.id !== w.id && !o.hidden && o.free).map((o) => o.free);
    el.classList.add("moving");
    board.classList.add("arranging");
    const move = (ev) => {
      const dx = ev.clientX - e.clientX,
        dy = ev.clientY - e.clientY;
      let r =
        mode === "move"
          ? { ...f0, x: f0.x + dx, y: f0.y + dy }
          : { ...f0, w: f0.w + dx, h: f0.h + dy };
      const snap = ev.altKey ? null : snapRect(r, mode, others);
      if (snap) r = snap.r;
      cand = clampFree(r, w);
      showGuides(snap?.lines ?? []);
      place(el, { ...w, free: cand });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", drop, true);
      removeEventListener("keydown", cancelCarry, true);
      el.classList.remove("moving");
      board.classList.remove("arranging");
      hideGuides();
      if (!sameRect(cand, w.free)) {
        w.free = cand;
        save(w);
        mounted.get(w.id)?.inst.resized?.();
      }
      place(el, w);
      invoke("set_interacting", { on: false });
      syncHits();
    };
    const drop = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      up();
    };
    const cancelCarry = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      cand = { ...w.free };
      up();
    };
    if (carry) {
      document.addEventListener("pointermove", move);
      setTimeout(() => document.addEventListener("pointerdown", drop, true));
      addEventListener("keydown", cancelCarry, true);
      announce(t("a11y.carrying"));
      return;
    }
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }
  const drag = (handle, mode) =>
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button:not(.grip)")) return;
      if (ui().lockLayout && !editMode) return; // Settings → 레이아웃 잠금
      if (freeMode() && w.locked) return toast(t("layers.locked"));
      e.preventDefault();
      const carry = !!ui().clickDrag; // motor accessibility: click to pick up, move, click again to drop
      if (!carry) handle.setPointerCapture(e.pointerId);
      invoke("set_interacting", { on: true });
      if (freeMode() && w.free) return freeDrag(e, handle, mode, carry);
      const m = metrics();
      const s = {
        px: e.clientX,
        py: e.clientY,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
      };
      let cand = { x: w.x, y: w.y, w: w.w, h: w.h };
      let layout = null; // pushed-aside arrangement for the current candidate
      let lastKey = "";
      el.classList.add("moving");
      board.classList.add("arranging");

      const move = (ev) => {
        const dx = Math.round((ev.clientX - s.px) / m.step);
        const dy = Math.round((ev.clientY - s.py) / m.step);
        cand =
          mode === "move"
            ? {
                x: clamp(s.x + dx, 0, m.cols - s.w),
                y: clamp(s.y + dy, 0, m.rows - s.h),
                w: s.w,
                h: s.h,
              }
            : {
                x: s.x,
                y: s.y,
                w: clamp(s.w + dx, min.w, m.cols - s.x),
                h: clamp(s.h + dy, min.h, m.rows - s.y),
              };
        const key = `${cand.x},${cand.y},${cand.w},${cand.h}`;
        if (key === lastKey) return;
        lastKey = key;
        layout = resolve(w.id, cand);
        applyLayout(layout, { commit: false }); // others slide aside (or back) as a preview
        place(el, cand);
        el.classList.toggle("invalid", !layout);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerdown", drop, true);
        removeEventListener("keydown", cancelCarry, true);
        el.classList.remove("moving", "invalid");
        board.classList.remove("arranging");
        const changed =
          cand.x !== w.x || cand.y !== w.y || cand.w !== w.w || cand.h !== w.h;
        applyLayout(changed ? layout : null, { commit: true }); // invalid drop -> everything snaps back
        place(el, w);
        invoke("set_interacting", { on: false });
        syncHits();
      };
      const drop = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        up();
      };
      const cancelCarry = (ev) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        cand = { x: w.x, y: w.y, w: w.w, h: w.h };
        layout = null;
        up();
      };
      if (carry) {
        document.addEventListener("pointermove", move);
        setTimeout(() => document.addEventListener("pointerdown", drop, true)); // the next click drops it
        addEventListener("keydown", cancelCarry, true);
        announce(t("a11y.carrying"));
        return;
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  drag(el.querySelector(".w-head"), "move");
  drag(el.querySelector(".w-resize"), "resize");
}

/** Find room for a widget on this board: preferred size, then minimum size, from the top-right like the presets. */
function findRoom(def, pref) {
  for (const size of [pref, def.min].filter(Boolean)) {
    const spot = findSpot(size.w, size.h, undefined, true);
    if (spot) return { ...spot, w: size.w, h: size.h };
  }
  return null;
}

function placeWidget(type, room, at) {
  const def = REGISTRY[type];
  if (!def) return;
  const free = freeMode();
  if (!room && !free) return toast(t("toast.no_space"));
  // free mode: the grid spot only matters for simple mode, so a full grid is no reason to refuse
  room ??= { x: 0, y: 0, w: def.size?.w ?? 1, h: def.size?.h ?? 1 };
  const w = {
    id: crypto.randomUUID(),
    type,
    display: myDisplay,
    ...room,
    settings: structuredClone(def.defaults ?? {}),
  };
  if (free) {
    const p = gridPx({ x: 0, y: 0, ...(def.size ?? room) });
    w.free = clampFree(freeSpot({ w: p.w, h: p.h }, at), w);
    w.z = topZ() + 1;
  }
  widgets.push(w);
  mount(w);
  save(w);
  syncHits();
}

// Tray / keyboard add: first free spot.
function addWidget(type) {
  const def = REGISTRY[type];
  if (def) placeWidget(type, findRoom(def, def.size));
}

// Board grid cell under a client point, clamped to the grid (null if no board).
function cellAt(clientX, clientY) {
  if (!board) return null;
  const m = metrics();
  const b = board.getBoundingClientRect();
  const cs = getComputedStyle(document.documentElement);
  const gap = parseFloat(cs.getPropertyValue("--gap")) || 10;
  const x = Math.floor((clientX - b.left - gap) / m.step);
  const y = Math.floor((clientY - b.top - gap) / m.step);
  return {
    x: Math.max(0, Math.min(m.cols - 1, x)),
    y: Math.max(0, Math.min(m.rows - 1, y)),
  };
}

// Nearest free w×h spot to target cell (0 distance if the target sits inside it); null if none fits.
function nearestSpot(w, h, tx, ty) {
  const m = metrics();
  let best = null,
    bestD = Infinity;
  for (let y = 0; y + h <= m.rows; y++)
    for (let x = 0; x + w <= m.cols; x++) {
      if (!fits({ x, y, w, h })) continue;
      const dx = tx < x ? x - tx : tx >= x + w ? tx - (x + w - 1) : 0;
      const dy = ty < y ? y - ty : ty >= y + h ? ty - (y + h - 1) : 0;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  return best;
}

// Add at the cursor: land in the nearest fitting spot to the clicked cell when that cell is
// open; if the cell is occupied (no room there), fall back to the first free spot.
function addWidgetAt(type, cell, at) {
  const def = REGISTRY[type];
  if (!def) return;
  if (freeMode()) return placeWidget(type, findRoom(def, def.size), at); // free: right where you clicked
  let room = null;
  if (cell && fits({ x: cell.x, y: cell.y, w: 1, h: 1 })) {
    for (const size of [def.size, def.min].filter(Boolean)) {
      const spot = nearestSpot(size.w, size.h, cell.x, cell.y);
      if (spot) {
        room = { ...spot, w: size.w, h: size.h };
        break;
      }
    }
  }
  placeWidget(type, room || findRoom(def, def.size));
}

// A widget moved here from another monitor.
function receiveWidget(w) {
  const def = REGISTRY[w.type];
  if (!def || mounted.has(w.id)) return;
  // its free rect belonged to the other monitor's board
  const size = w.free ? { w: w.free.w, h: w.free.h } : null;
  delete w.free;
  delete w.z;
  const room = findRoom(def, { w: w.w, h: w.h });
  if (room) {
    Object.assign(w, room);
  } else {
    Object.assign(w, { x: 0, y: 0 });
    if (!freeMode()) toast(t("toast.overlap"));
  }
  if (freeMode()) {
    const p = size ?? gridPx(w);
    w.free = clampFree(freeSpot({ w: p.w, h: p.h }), w);
    w.z = topZ() + 1;
  }
  w.display = myDisplay;
  widgets.push(w);
  mount(w);
  save(w);
  syncHits();
}

// ---------------- theme (edited in the settings window; theme-changed brings it here) ----------------
function applyTheme(css) {
  $("#user-theme").textContent = sanitize(typeof css === "string" ? css : "");
  // a broken theme (e.g. --cell: abc) must not wreck the grid
  document.documentElement.style.removeProperty("--cell");
  const cell = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--cell"),
  );
  if (!(cell >= 24 && cell <= 400))
    document.documentElement.style.setProperty("--cell", "80px");
  syncScheme();
  syncHits();
  reflowSoon();
}

// ---------------- edit mode ----------------
function setEdit(on) {
  editMode = on;
  document.body.classList.toggle("edit", on);
  $("#editbar").hidden = !on;
  syncHits();
}
$("#edit-done").onclick = () => invoke("set_edit_mode", { on: false });
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#font-panel").hidden) return closeFontPanel();
  if (!$("#overview-panel").hidden) return $("#overview-close").click();
  if (!$("#welcome").hidden) return hideWelcome();
  if (document.body.classList.contains("focus-mode")) return exitFocus();
  if (document.body.classList.contains("kbd-mode"))
    return invoke("set_kbd_mode", { on: false });
  if (editMode) invoke("set_edit_mode", { on: false });
});

// ---------------- misc ----------------
let toastTimer;
let toastOwner = null; // the widget element an undo toast belongs to
function hideToast() {
  $("#toast").hidden = true;
  toastOwner = null;
  syncHits();
}
/** toast('text') or toast('text', { label: '되돌리기', fn }, widgetEl) - an action keeps it up longer. */
function toast(msg, action, owner = null) {
  toastOwner = owner;
  const el = $("#toast");
  el.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => {
      el.hidden = true;
      syncHits();
      action.fn();
    };
    el.append(" ", b);
  }
  el.hidden = false;
  syncHits();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
      syncHits();
    },
    action ? 7000 : 2600,
  );
}
/** Screen-reader announcement without a visible toast. */
function announce(msg) {
  const sr = $("#sr");
  sr.textContent = "";
  setTimeout(() => (sr.textContent = msg), 30);
}

// Screen readers: icon-only buttons get their tooltip as their accessible name (kept in sync as widgets redraw).
function labelButtons() {
  for (const b of document.querySelectorAll("button[title]"))
    if (b.getAttribute("aria-label") !== b.title)
      b.setAttribute("aria-label", b.title);
}
let labelRaf = 0;
new MutationObserver(() => {
  if (!labelRaf)
    labelRaf = requestAnimationFrame(() => ((labelRaf = 0), labelButtons()));
}).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["title"],
});

// ---------------- settings: layout, behaviour, accessibility (config.json → "ui") ----------------
const UI_DEFAULTS = {
  header: "hover",
  density: "normal",
  lockLayout: false,
  awayMinutes: 30, // a sleep gap this long while a stopwatch or pomodoro counts: ask keep / take out (0 = never)
  layoutMode: "grid", // "grid": cells + push-aside (simple) · "free": pixel placement, snap guides, overlap
  weekStart: "default",
  timerSound: true,
  timerVolume: 60,
  timerRings: 10,
  highContrast: false,
  bigTargets: false,
  wideText: false,
  showControls: false,
  // accessibility — every one of these is OFF until the user turns it on
  hotkey: "",
  dwellMs: 0,
  clickDrag: false, // keyboard & motor
  zoom: 1, // low vision
  flashAlert: false,
  notifyAlert: false,
  soundCaptions: false, // deaf / hard of hearing
  cvd: false, // colour vision
  showHints: false,
  readableFont: "none",
  shortLines: false,
  reminderTime: "", // cognitive load
  announceSummary: false, // show "Announce summary" in the widget right-click menu
  currentTz: "", // the viewer's timezone for display/countdowns; "" = follow the OS
  frame: "none", // decoration default for every widget
};
/** The viewer's effective timezone: their chosen one, or the OS zone when on Auto. */
const currentTz = () => ui().currentTz || osZone();
const ui = () => ({
  ...UI_DEFAULTS,
  ...(config.ui && typeof config.ui === "object" ? config.ui : {}),
});
function applyUi() {
  const u = ui();
  setWeekStart(u.weekStart); // one week for the calendar, checklist quotas and D-day
  const c = document.body.classList;
  c.toggle("header-always", u.header === "always");
  c.toggle("header-hidden", u.header === "hidden");
  for (const d of ["compact", "normal", "roomy"])
    c.toggle("density-" + d, u.density === d);
  c.toggle("lock-layout", !!u.lockLayout);
  applyLayoutMode();
  c.toggle("high-contrast", !!u.highContrast);
  c.toggle("big-targets", !!u.bigTargets);
  c.toggle("wide-text", !!u.wideText);
  c.toggle("show-controls", !!u.showControls || !!u.highContrast);
  c.toggle("cvd-safe", !!u.cvd);
  c.toggle("show-hints", !!u.showHints);
  c.toggle("short-lines", !!u.shortLines);
  for (const f of ["atkinson", "lexend", "opendyslexic"])
    c.toggle("font-" + f, u.readableFont === f);
  // native side, only when something changed
  const nat = {
    dwell: +u.dwellMs || 0,
    zoom: +u.zoom || 1,
    hotkey: String(u.hotkey || ""),
  };
  if (sentNative.dwell !== nat.dwell)
    invoke("set_dwell", { ms: nat.dwell }).catch(() => {});
  if (sentNative.zoom !== nat.zoom)
    invoke("set_zoom", { zoom: nat.zoom }).catch(() => {});
  if (sentNative.hotkey !== nat.hotkey && isPrimary)
    invoke("set_hotkey", { accel: nat.hotkey }).catch(
      () => nat.hotkey && toast(t("a11y.hotkey_taken", { key: nat.hotkey })),
    );
  sentNative = nat;
  for (const [id, m] of mounted)
    applyFrame(
      m.el,
      widgets.find((x) => x.id === id),
    );
  syncHits();
}
let sentNative = { dwell: 0, zoom: 1, hotkey: "" };
let isPrimary = false;

// ---------------- accessibility helpers ----------------
function summaryOf(w) {
  try {
    return mounted.get(w.id)?.inst.summary?.() || t("sum.empty");
  } catch {
    return t("sum.empty");
  }
}
function announceSummary(w) {
  const text = `${widgetName(w)}: ${summaryOf(w)}`;
  announce(text);
  toast(text);
}
/** Text-only overview of every widget (screen readers, low vision, "what's on my board?"). */
function openOverview() {
  const list = $("#overview-list");
  list.innerHTML =
    widgets
      .map(
        (w) =>
          `<li><button data-goto="${esc(w.id)}">${esc(widgetName(w))}</button> <span>${esc(summaryOf(w))}</span></li>`,
      )
      .join("") || `<li>${esc(t("sum.empty"))}</li>`;
  $("#overview-panel").hidden = false;
  list.querySelector("button")?.focus();
  syncHits();
}
$("#overview-list").addEventListener("click", (e) => {
  const id = e.target.closest("[data-goto]")?.dataset.goto;
  if (!id) return;
  $("#overview-panel").hidden = true;
  mounted.get(id)?.el.querySelector(".grip")?.focus();
  syncHits();
});
$("#overview-close").onclick = () => (
  ($("#overview-panel").hidden = true),
  syncHits()
);

// focus mode (cognitive load): show one widget, hide the rest until you leave
function enterFocus(id) {
  document.body.classList.add("focus-mode");
  for (const [k, m] of mounted) m.el.classList.toggle("focused", k === id);
  $("#focusbar").hidden = false;
  syncHits();
}
function exitFocus() {
  document.body.classList.remove("focus-mode");
  for (const m of mounted.values()) m.el.classList.remove("focused");
  $("#focusbar").hidden = true;
  syncHits();
}
$("#focus-exit").onclick = exitFocus;

// deaf / hard of hearing: visual + Windows alerts (both opt-in)
function alertUser(title, body) {
  const u = ui();
  if (u.flashAlert) {
    const f = $("#flash");
    f.querySelector("b").textContent = title;
    f.classList.toggle("steady", motionReduced());
    f.hidden = false;
    clearTimeout(f._t);
    f._t = setTimeout(() => (f.hidden = true), 6000);
  }
  if (u.notifyAlert)
    invoke("notify", { title, body: body || "" }).catch(() => {});
  announce(`${title}. ${body || ""}`);
}

// gentle reminder (cognitive load): at a chosen time, how many to-dos are left today — once a day, primary board only
let remindedOn = "";
async function checkReminder() {
  const at = ui().reminderTime;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (!isPrimary || !at || hm !== at || remindedOn === today) return;
  remindedOn = today;
  const events =
    (await invoke("store_get", { key: "events" }).catch(() => null)) || [];
  // what the checklist's 오늘 tab shows unticked: to-dos due or carried over, dailies, today's entries
  const left = (Array.isArray(events) ? events : []).filter((e) => {
    if (!e || typeof e.date !== "string" || e.dday || e.quota) return false;
    if (e.todo && !e.repeat) return !e.done && e.date <= today;
    return occursOn(e, today) && !eventDone(e, today);
  }).length;
  if (!left) return;
  const msg = t("remind.left", { n: left });
  toast(msg);
  if (ui().notifyAlert)
    invoke("notify", { title: "WidgetBoard", body: msg }).catch(() => {});
  announce(msg);
}

// Per-event reminders: an event with `notify` fires at its wall-time (in its own zone) minus
// `lead` minutes — a desktop notification plus a clickable toast that opens the event's link.
// De-dupe per occurrence and fire time (id + date + instant) so each fires once, and an edited time fires
// again; primary board only.
const FIRED_KEY = "wb-reminder-fired";
let firedSet = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || "[]"));
  } catch {
    return new Set();
  }
})();
const saveFired = () => {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify([...firedSet]));
  } catch {}
};
function fireEventReminder(e) {
  const title = (e.time ? e.time + " " : "") + e.title;
  const body = t("remind.event", { title });
  if (e.url) lastReminderUrl = e.url; // for a native OS-toast click (see wiring below)
  invoke("notify", { title: "WidgetBoard", body }).catch(() => {});
  if (e.url)
    toast(body, {
      label: t("remind.open"),
      fn: () => invoke("open_url", { url: e.url }).catch(() => {}),
    });
  else toast(body);
  announce(body);
}
// Native OS-notification click → open the reminded event's link via the notification plugin's JS
// onAction. ponytail: single-slot (one live reminder at a time) and MANUAL-VERIFY-ONLY — the headless
// suite can't trigger a real OS toast click. Guarded so a missing/changed plugin API can't break boot.
let lastReminderUrl = null;
(async () => {
  try {
    const notif = window.__TAURI__?.notification;
    if (typeof notif?.onAction !== "function") return;
    await notif.onAction(() => {
      if (!lastReminderUrl) return;
      invoke("open_url", { url: lastReminderUrl }).catch(() => {});
      lastReminderUrl = null;
    });
  } catch {}
})();
async function checkEventReminders() {
  if (!isPrimary) return;
  const events = await invoke("store_get", { key: "events" }).catch(() => null);
  if (!Array.isArray(events)) return;
  const now = Date.now();
  const today = ymd();
  // An event's date is in its own zone: one in a zone behind ours (LA seen from Seoul) can fire on our
  // next or second-next day (UTC+14 vs UTC-12), so look two days back. Tomorrow too, for long leads.
  const oldest = addDays(today, -2);
  const days = [oldest, addDays(today, -1), today, addDays(today, 1)];
  for (const e of events) {
    if (!e || !e.notify) continue;
    for (const d of days) {
      if (!occursOn(e, d) || eventDone(e, d)) continue; // done ahead of time: no reminder for that occurrence
      const tz = e.tz || currentTz();
      // ponytail: notify without a time fires at 09:00 of its own zone (an all-day nudge).
      const fireAt =
        zonedToInstant(d, e.time || "09:00", tz) - (+e.lead || 0) * 60000;
      if (now < fireAt) continue;
      const key = e.id + "|" + d + "|" + fireAt;
      if (firedSet.has(key) || firedSet.has(e.id + "|" + d)) continue; // id|date: fired before this rule
      for (const k of firedSet) if (k.startsWith(e.id + "|" + d + "|")) firedSet.delete(k); // the old time's
      firedSet.add(key);
      saveFired();
      // don't flood with stale reminders after the app was closed a long while
      if (now - fireAt <= 12 * 3600000) fireEventReminder(e);
    }
  }
  // prune keys older than anything still checked, so the set can't grow without bound (and nothing re-fires)
  for (const key of firedSet)
    if (key.slice(key.indexOf("|") + 1) < oldest) firedSet.delete(key);
}
setInterval(() => {
  checkReminder();
  checkEventReminders();
}, 20000);

// keyboard mode (global shortcut): widgets come forward and take the keyboard; Esc leaves
function setKbd(on) {
  document.body.classList.toggle("kbd-mode", on);
  $("#kbdbar").hidden = !on;
  if (on && isPrimary)
    setTimeout(() => board.querySelector(".grip")?.focus(), 80);
  syncHits();
}
addEventListener("keydown", (e) => {
  if (
    !document.body.classList.contains("kbd-mode") ||
    e.target.closest("input, textarea, select")
  )
    return;
  if (e.key === "l" || e.key === "L") openOverview();
});
addEventListener(
  "blur",
  () =>
    document.body.classList.contains("kbd-mode") &&
    invoke("set_kbd_mode", { on: false }),
);

// ---------------- per-widget appearance: colours, opacity, frames ----------------
/**
 * Built-in frames: 48×48 SVGs drawn 9-slice (16px corners) as a MASK, so they take any colour
 * (--frame-color, default the accent). Only the alpha of the SVG matters.
 */
const FRAME_SVG = (() => {
  const sv = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#000">${body}</svg>`;
  const dots = [4, 12, 20, 28, 36, 44].flatMap((v) => [
    [v, 5],
    [v, 43],
    [5, v],
    [43, v],
  ]);
  const curl =
    '<path d="M2 16Q2 2 16 2" stroke-width="2.2"/><path d="M7 16Q7 7 16 7" stroke-width="1"/><circle cx="11" cy="11" r="2.2" fill="#000" stroke="none"/>';
  const px = (x, y, w, h) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  return {
    corners: sv(
      '<path d="M3 17V3h14M31 3h14v14M45 31v14H31M17 45H3V31" stroke-width="3"/>',
    ),
    double: sv(
      '<rect x="2" y="2" width="44" height="44" stroke-width="2"/><rect x="7" y="7" width="34" height="34" stroke-width="1"/>',
    ),
    stitch: sv(
      '<rect x="5" y="5" width="38" height="38" rx="3" stroke-width="1.6" stroke-dasharray="4 4"/>',
    ),
    dots: sv(
      `<g fill="#000" stroke="none">${[...new Set(dots.map(String))].map((p) => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="1.7"/>`).join("")}</g>`,
    ),
    ornate: sv(
      `<path d="M16 4H32M16 44H32M4 16V32M44 16V32" stroke-width="1"/>${[0, 90, 180, 270].map((r) => `<g transform="rotate(${r} 24 24)">${curl}</g>`).join("")}`,
    ),
    pixel: sv(
      `<g fill="#000" stroke="none" shape-rendering="crispEdges">${px(6, 0, 36, 3)}${px(6, 45, 36, 3)}${px(0, 6, 3, 36)}${px(45, 6, 3, 36)}${px(3, 3, 3, 3)}${px(42, 3, 3, 3)}${px(3, 42, 3, 3)}${px(42, 42, 3, 3)}</g>`,
    ),
    tape: sv(
      '<g fill="#000" fill-opacity=".6" stroke="none"><rect x="-1" y="5" width="18" height="7" transform="rotate(-45 8 8.5)"/><rect x="31" y="5" width="18" height="7" transform="rotate(45 40 8.5)"/></g>',
    ),
  };
})();
const FRAMES = ["none", ...Object.keys(FRAME_SVG)];
const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
function applyFrame(el, w) {
  if (!el || !w) return;
  const kind = w.frame ?? ui().frame;
  const f = el.querySelector(".w-frame");
  if (!f) return;
  const custom =
    kind === "custom" &&
    typeof w.frameSvg === "string" &&
    w.frameSvg.startsWith("data:image/svg+xml");
  f.dataset.kind = custom ? "custom" : FRAME_SVG[kind] ? kind : "none";
  f.style.setProperty(
    "--frame-mask",
    custom
      ? `url("${w.frameSvg}")`
      : FRAME_SVG[kind]
        ? svgUrl(FRAME_SVG[kind])
        : "",
  );
}
function onAccentFor(hex) {
  return isLight(hex) ? "#111111" : "#ffffff";
}
function applyColors(el, w) {
  const c = w.colors && typeof w.colors === "object" ? w.colors : {};
  const hex = (v) =>
    typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : "";
  el.style.setProperty("--c1", hex(c.c1));
  el.style.setProperty("--c2", hex(c.c2));
  el.style.setProperty("--c3", hex(c.c3));
  el.style.setProperty(
    "--on-accent",
    hex(c.onAccent) || (hex(c.c2) ? onAccentFor(c.c2) : ""),
  );
  el.style.setProperty(
    "--line-color",
    hex(c.c2) ? `color-mix(in srgb, ${c.c2} 55%, transparent)` : "",
  );
  el.style.setProperty("--frame-color", hex(c.frame));
  el.style.setProperty(
    "--widget-opacity",
    c.opacity >= 0 && c.opacity <= 1 ? String(c.opacity) : "",
  );
}
// ---------------- layouts: presets (업무용 / 공부용) + saved arrangements ----------------
/** [type, w, h, settings override]. Packed from the top-right corner (desktop icons live top-left). */
const PRESETS = {
  work: [
    ["calendar", 5, 4, { view: "board" }],
    ["checklist", 3, 4],
    ["memo", 3, 3],
    ["timer", 3, 2],
    ["dday", 3, 3],
    ["nowplaying", 4, 2],
  ],
  study: [
    ["timer", 3, 2],
    ["stopwatch", 3, 2],
    ["checklist", 3, 4],
    ["diary", 4, 4],
    ["dday", 3, 3],
    ["calendar", 4, 4, { view: "mini" }],
  ],
  oshi: [
    ["showcase", 4, 4],
    ["collection", 3, 4],
    ["dday", 3, 3],
    ["image", 3, 3],
    ["audioplayer", 3, 2],
  ],
};
/** Pack slots onto an empty cols×rows grid, right-aligned. Returns [{slot, x, y, w, h}] (slots that don't fit are left out). */
function packSlots(slots, cols, rows) {
  const placed = [];
  const free = (r) =>
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= cols &&
    r.y + r.h <= rows &&
    !placed.some((p) => overlaps(p, r));
  for (const slot of slots) {
    const def = REGISTRY[slot[0]];
    if (!def) continue;
    const min = def.min ?? { w: 1, h: 1 };
    let spot = null;
    for (const size of [{ w: slot[1], h: slot[2] }, min]) {
      for (let y = 0; !spot && y + size.h <= rows; y++)
        for (let x = cols - size.w; !spot && x >= 0; x--)
          if (free({ x, y, ...size })) spot = { x, y, ...size };
      if (spot) break;
    }
    if (spot) placed.push({ slot, ...spot });
  }
  return placed;
}
async function flushSaves() {
  // Editors own their debounce buffers. Drain them before consulting the board queue.
  for (const { inst } of mounted.values()) {
    if (await inst.flush?.() === false) throw new Error(t("diary.save_failed"));
  }
  await Promise.all([...activeWrites]);
  for (const id of [...archiveTimers.keys()]) {
    const w = widgets.find((x) => x.id === id);
    if (w) await archiveMemo(w, true);
  }
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  // Retain failed writes for the next flush attempt, even after their debounce fired.
  for (const { w } of [...unsaved.values()]) await persistWidget(w);
  await Promise.all([...activeWrites]);
}
const flushBoards = () => invoke("flush_boards");

/** Replace every board's widgets. Library content taken off the board remembers where it was. */
async function replaceAll(next, label, { undo = true } = {}) {
  await flushBoards();
  const before = await invoke("get_all_widgets");
  for (const w of before)
    if (isLibrary(w.type) && !next.some((n) => n.id === w.id) && contents.has(w.id))
      await persistContent({ ...w, name: contents.get(w.id).name }, contents.get(w.id).data, { placement: w });
  await write("store_set", {
    key: "layouts_undo",
    value: undo ? before : null,
    src: "layouts",
  });
  try {
    if (label) sessionStorage.setItem("wb-layout-applied", label);
  } catch {}
  // placements only: in-memory widgets carry their merged content
  await write("replace_widgets", { widgets: next.map((w) => splitContent(w)[0]) }); // every board reloads
}
/** Library content a preset slot may show: not deleted, not on another monitor, not already used. */
const usable = (id, type, skip) => {
  const c = contents.get(id);
  return !!c && c.type === type && !c.deletedAt && !skip.has(id);
};
/**
 * A built-in preset on this monitor. A Library slot shows the content it showed last time in this preset,
 * else the most recently used content of that type, else new content. Tools reuse this board's widgets.
 */
async function applyPreset(name) {
  const slots = PRESETS[name];
  if (!slots) return;
  await flushBoards();
  const all = await invoke("get_all_widgets");
  const others = all.filter((w) => !widgets.some((m) => m.id === w.id)); // other monitors stay as they are
  const skip = new Set(others.map((w) => w.id));
  const bindings = (await invoke("store_get", { key: "preset_bindings" }).catch(() => null)) || {};
  const bound = (bindings[name] ||= {});
  const tools = widgets.filter((w) => !isLibrary(w.type)).map((w) => structuredClone(w));
  const m = metrics();
  const packed = packSlots(slots, m.cols, m.rows);
  const mine = packed.map(({ slot, x, y, w, h }) => {
    const [type, , , preset] = slot;
    const i = slots.indexOf(slot);
    let base;
    if (isLibrary(type)) {
      const recent = [...contents.values()]
        .filter((c) => usable(c.id, type, skip))
        .sort((a, b) => b.updated - a.updated)[0];
      const id = usable(bound[i], type, skip) ? bound[i] : recent?.id;
      const here = widgets.find((o) => o.id === id);
      base = id
        ? structuredClone(here ?? { ...contents.get(id).placement, id, type })
        : { id: crypto.randomUUID(), type, settings: { ...structuredClone(REGISTRY[type].defaults ?? {}), ...preset } };
      base.settings ??= {};
      skip.add(base.id);
      bound[i] = base.id;
    } else {
      const j = tools.findIndex((o) => o.type === type);
      base =
        j >= 0
          ? tools.splice(j, 1)[0]
          : { id: crypto.randomUUID(), type, settings: structuredClone(REGISTRY[type].defaults ?? {}) };
      if (preset) base.settings = { ...base.settings, ...preset };
    }
    delete base.hidden; // a reused widget shows in its preset slot
    return { ...base, display: myDisplay, x, y, w, h };
  });
  if (packed.length < slots.length) toast(t("lay.partial"));
  await write("store_set", { key: "preset_bindings", value: bindings, src: "layouts" });
  await replaceAll([...others, ...mine], t("lay." + name));
}
/**
 * Apply a saved layout (sent by the settings window): positions come from the layout, content by reference.
 */
async function applySavedLayout(name) {
  const list = await invoke("store_get", { key: "layouts" }).catch(() => null);
  const l = (Array.isArray(list) ? list : []).find(
    (x) => x && x.name === name && Array.isArray(x.widgets),
  );
  if (!l) return;
  await replaceAll(await withLatestContents(l.widgets), l.name);
}
/** Undo the last layout change: positions go back, what was typed since stays. */
async function undoLayout() {
  const prev = await invoke("store_get", { key: "layouts_undo" }).catch(
    () => null,
  );
  if (!Array.isArray(prev)) return;
  await replaceAll(await withLatestContents(prev), null, { undo: false });
}
/**
 * Placements from `layout`. Library content resolves by id (deleted content is skipped: deleted is deleted);
 * tools take their current settings when they are still on a board.
 */
async function withLatestContents(layout) {
  await flushBoards();
  const current = await invoke("get_all_widgets");
  return layout
    .filter((w) => w && w.id)
    .filter((w) => {
      const c = isLibrary(w.type) && contents.get(w.id);
      return !c || (!c.deletedAt && c.type === w.type); // deleted is deleted; missing content is made on mount
    })
    .map((w) => {
      const c = !isLibrary(w.type) && current.find((x) => x.id === w.id);
      return c ? { ...structuredClone(w), settings: structuredClone(c.settings) } : structuredClone(w);
    });
}

// first-run card: a preset, or an empty board. Leaving it any way is remembered, so it doesn't come back.
function hideWelcome() {
  if (!$("#welcome").hidden) write("store_set", { key: "welcomed", value: true, src: "host" }).catch(() => {});
  $("#welcome").hidden = true;
  syncHits();
}
$("#welcome").onclick = (e) => {
  const b = e.target.closest("[data-preset]");
  if (b) return hideWelcome(), applyPreset(b.dataset.preset).catch(reportError);
  if (e.target.closest("#wc-blank")) hideWelcome();
};

addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => e.preventDefault());
addEventListener("contextmenu", (e) => {
  const editable = e.target.closest("input, textarea, [contenteditable]");
  if (!editable) e.preventDefault();
  // Edit mode: right-click on empty board space adds a widget there. (In normal mode the
  // window is click-through over empty space, so this event only ever arrives while editing.)
  if (
    editMode &&
    !editable &&
    !e.target.closest(".widget") &&
    e.target.closest("#board")
  )
    openAddMenu(cellAt(e.clientX, e.clientY), {
      x: e.clientX - board.getBoundingClientRect().left,
      y: e.clientY - board.getBoundingClientRect().top,
    });
});
addEventListener("resize", () => {
  syncHits();
  reflowSoon();
});
// Unexpected errors: keep running, tell the user once in a while.
let lastErr = 0;
function reportError(e) {
  if (e?.reported) return;
  console.error(e);
  if (Date.now() - lastErr > 10000) toast(t("toast.error"));
  lastErr = Date.now();
}
addEventListener("error", (e) => reportError(e.error ?? e.message));
addEventListener("unhandledrejection", (e) => reportError(e.reason));

// ---------------- boot ----------------
(async function boot() {
  const st = await invoke("load_state");
  session = { launched: 0, closed: null, ...st.session };
  lang = st.lang || "ko";
  config = st.config || {};
  setMotion(st.reduceMotion);
  isPrimary = !!st.primary;
  applyUi();
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.(
    "change",
    () => setMotion(reduceMotion),
  );
  await loadLang(lang);
  myDisplay = st.display || "";
  isPrimary = !!st.primary;
  displays = st.displays || [];
  assetsDir = st.assetsDir || "";
  applyTheme(st.theme);
  for (const item of await invoke("content_list").catch(() => [])) contents.set(item.id, item);
  // before mounting: a widget's first write (a Showcase birthday, a D-day migration) must reach its siblings
  await listen("store-changed", (e) => {
    const p = e.payload || {};
    for (const s of storeSubs) if (s.key === p.key && s.src !== p.src) s.cb(p);
  });
  const seen = new Set();
  widgets = (Array.isArray(st.widgets) ? st.widgets : []).filter(
    (w) => w && typeof w === "object",
  );
  for (const w of widgets) {
    if (!w.id || seen.has(w.id)) w.id = crypto.randomUUID();
    seen.add(w.id);
    try {
      mount(w); // one broken widget must never stop the others from loading
    } catch (e) {
      reportError(e);
    }
  }
  if (freeMode()) setLayers(layerOrder()); // one z per widget (older layouts could share one)
  setTimeout(() => (reflow(), (document.documentElement.dataset.reflowed = "")), 400);
  setEdit(!!st.edit);
  syncHits();

  await listen("add-widget", (e) => (hideWelcome(), addWidget(e.payload)));
  await listen("apply-preset", (e) =>
    applyPreset(e.payload).catch(reportError),
  );
  await listen("widget-arrived", (e) => receiveWidget(e.payload));
  // from the settings window (broadcast; each board acts only on its own widgets)
  await listen("widget-patch", (e) => {
    const { id, patch } = e.payload || {};
    const w = widgets.find((x) => x.id === id);
    if (!w || !patch) return;
    if ("name" in patch) {
      w.name = String(patch.name || "")
        .trim()
        .slice(0, 40);
      if (!w.name) delete w.name;
      applyName(w);
    }
    if ("hidden" in patch) setHidden(w, !!patch.hidden, true);
    save(w);
  });
  await listen("widget-locate", (e) => locate(e.payload));
  // close / move from the settings window: the owning board acts on its live copy (unsaved edits included)
  await listen("widget-close", (e) => {
    const w = widgets.find((x) => x.id === e.payload);
    if (w) removeWidget(w);
  });
  await listen("widget-move", (e) => {
    const { id, display } = e.payload || {};
    const w = widgets.find((x) => x.id === id);
    if (w && display && display !== w.display)
      moveTo(w, display).catch(reportError);
  });
  await listen("undo-layout", () => undoLayout().catch(reportError));
  // "Show on board" from the Library: the board of its last monitor takes it (the primary if that monitor is gone)
  await listen("widget-restore", (e) => {
    const w = e.payload;
    const def = REGISTRY[w?.type];
    if (!w?.id || !def) return;
    if (mounted.has(w.id)) return locate(w.id); // already here
    w.w ??= def.size?.w ?? def.min?.w ?? 2;
    w.h ??= def.size?.h ?? def.min?.h ?? 2;
    const known = displays.some((d) => d.display === w.display);
    if (w.display === myDisplay && Number.isFinite(w.x) && Number.isFinite(w.y) && fits(w, w.id)) {
      widgets.push(w); // its old spot is free: put it back exactly there
      mount(w);
      save(w);
      syncHits();
    } else if (w.display === myDisplay || (!known && isPrimary))
      receiveWidget(w);
  });
  await listen("edit-mode", (e) => setEdit(!!e.payload));
  await listen("theme-changed", (e) => applyTheme(e.payload));
  await listen("lang-changed", () => location.reload());
  await listen("toast", (e) => toast(t(e.payload)));
  await listen("motion-changed", (e) => setMotion(e.payload));
  await listen("config-changed", (e) => {
    config = e.payload || {};
    applyUi();
    configSubs.forEach((cb) => cb(config));
  });
  await listen("apply-layout", (e) =>
    applySavedLayout(e.payload).catch(reportError),
  );
  await listen("kbd-mode", (e) => setKbd(!!e.payload));
  await listen("layout-replaced", () => location.reload());
  // content saved by another window (the settings window, another monitor): show the newer version
  await listen("content-changed", (e) => {
    const { item, src } = e.payload || {};
    if (!item?.id || src === CONTENT_SRC) return;
    if ((contents.get(item.id)?.rev ?? 0) >= item.rev) return;
    const w = widgets.find((x) => x.id === item.id);
    if (w && mounted.has(w.id) && item.deletedAt) {
      // deleted in the Library: off the board too (the content stays in Recently deleted)
      contents.set(item.id, item);
      unmount(w);
      write("remove_widget", { id: w.id }).catch(() => {});
    } else if (w && mounted.has(w.id)) remountWith(w, item);
    else contents.set(item.id, item);
  });
  // backup restore: nothing typed now could be saved, so the widgets stop taking input until the relaunch
  await listen("restoring", () => {
    $("#board").inert = true;
    toast(t("restore.busy"));
    clearTimeout(toastTimer); // stays up until the relaunch
  });
  await listen("restore-failed", () => {
    $("#board").inert = false;
    $("#toast").hidden = true;
    syncHits();
  });
  let applied = null;
  try {
    applied = sessionStorage.getItem("wb-layout-applied");
    sessionStorage.removeItem("wb-layout-applied");
  } catch {}
  if (applied)
    toast(t("lay.applied", { name: applied }), {
      label: t("toast.undo"),
      fn: () => undoLayout().catch(reportError),
    });
  else if (st.migrateError) toast(t("toast.migrate_failed"));
  else if (st.configBroken) toast(t("toast.config_bad"));
  else if (st.justUpdated) toast(t("upd.done", { v: st.justUpdated }));
  else if (st.primary && !widgets.length && !(await invoke("get_all_widgets").catch(() => [])).length) {
    // an empty board is invisible and click-through: offer a start until "empty board" is picked once
    const welcomed = await invoke("store_get", { key: "welcomed" }).catch(() => null);
    if (welcomed) toast(t("toast.empty"));
    else {
      $("#welcome").hidden = false;
      syncHits();
      $("#welcome button").focus();
    }
  }

  await listen("update-available", (e) => {
    const v = e.payload?.version;
    if (v)
      toast(t("upd.available", { v }), {
        label: t("upd.details"),
        fn: () => invoke("open_settings", { page: "about" }).catch(() => {}),
      });
  });
  await listen("update-failed", (e) =>
    toast(t("upd.failed", { e: updateError(e.payload) })),
  );
  await listen("flush-saves", async (event) => {
    let error = null;
    try { await flushSaves(); }
    catch (e) { error = String(e?.message ?? e); }
    if (event.payload?.request != null)
      await T.event.emit("saves-flushed", { request: event.payload.request, label: win.label, error });
    else if (error) reportError(new Error(error));
  });
  document.documentElement.dataset.ready = ""; // tests wait on html[data-ready] (and data-reflowed)
  window.__wbIdle = () => !pending.size && !activeWrites.size; // tests: no widget save queued or in flight
})();

// ---------------- updates (checked by Rust on a slow schedule; see updater.rs) ----------------
const updateError = (e) =>
  e === "not_configured" || e === "not_writable" ? t("upd." + e) : String(e || "");
