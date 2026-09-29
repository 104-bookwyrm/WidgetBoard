// WidgetBoard front end (one instance per monitor): grid layout, drag/resize, theme, widget host.
import { loadLang, t } from './i18n.js';
import { esc, wheelScrollX } from './util.js';
import timer from './widgets/timer.js';
import image from './widgets/image.js';
import dday from './widgets/dday.js';
import checklist from './widgets/checklist.js';
import stopwatch from './widgets/stopwatch.js';
import memo from './widgets/memo.js';
import nowplaying from './widgets/nowplaying.js';
import calendar from './widgets/calendar.js';
import diary from './widgets/diary.js';

/** Widget registry. Add a widget = add a module here and an id in main.rs WIDGETS. */
const REGISTRY = { checklist, calendar, dday, diary, memo, nowplaying, timer, stopwatch, image };

const T = window.__TAURI__ ?? mockTauri();
const invoke = (cmd, args, opts) => T.core.invoke(cmd, args, opts);
/** Writes that fail (disk full, file locked, ...) tell the user instead of failing silently. */
const saveFailed = (e) => {
  console.error(e);
  toast(t('toast.save_failed'));
  const err = e instanceof Error ? e : new Error(String(e));
  err.reported = true; // the global handler must not replace this message
  throw err;
};
const write = (cmd, args, opts) => invoke(cmd, args, opts).catch(saveFailed);
const win = T.webviewWindow.getCurrentWebviewWindow();
const listen = (ev, h) => win.listen(ev, h); // only events for this board (or broadcasts)

const $ = (s) => document.querySelector(s);
const board = $('#board');
const mounted = new Map(); // id -> { el, inst }
let widgets = [];          // widgets on this monitor
let myDisplay = '';
let displays = [];         // [{ label, display, index, primary }]
let assetsDir = '';
let themeCss = '';
let editMode = false;
let lang = 'ko';
let config = {};
let reduceMotion = false;
/** Reduced motion: the tray setting, or Windows' own "Animation effects: off". */
const motionReduced = () => reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
function setMotion(on) {
  reduceMotion = !!on;
  document.body.classList.toggle('reduce-motion', motionReduced());
}
const storeSubs = new Set();  // { key, src, cb }
const configSubs = new Set(); // cb(config)

// ---------------- geometry ----------------
function metrics() {
  const cs = getComputedStyle(document.documentElement);
  const cell = parseFloat(cs.getPropertyValue('--cell')) || 80;
  const gap = parseFloat(cs.getPropertyValue('--gap')) || 10;
  const step = cell + gap;
  return {
    step,
    cols: Math.max(1, Math.floor((board.clientWidth - gap) / step)),
    rows: Math.max(1, Math.floor((board.clientHeight - gap) / step)),
  };
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function fits(r, ignoreId) {
  const m = metrics();
  if (r.x < 0 || r.y < 0 || r.x + r.w > m.cols || r.y + r.h > m.rows) return false;
  return !widgets.some((o) => o.id !== ignoreId && overlaps(r, o));
}
function findSpot(w, h, ignoreId) {
  const m = metrics();
  for (let y = 0; y + h <= m.rows; y++)
    for (let x = 0; x + w <= m.cols; x++) if (fits({ x, y, w, h }, ignoreId)) return { x, y };
  return null;
}

/**
 * Make room: place `rect` for widget `moverId` and push overlapping widgets aside
 * (cheapest of right / down / left / up, recursively). Returns Map id -> rect, or null if impossible.
 */
function resolve(moverId, rect) {
  const m = metrics();
  const inb = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= m.cols && r.y + r.h <= m.rows;
  if (!inb(rect)) return null;
  let pos = new Map(widgets.map((o) => [o.id, { id: o.id, x: o.x, y: o.y, w: o.w, h: o.h }]));
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
    if (commit && layout && (r.x !== w.x || r.y !== w.y || r.w !== w.w || r.h !== w.h)) {
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
  const m = metrics();
  let moved = 0;
  for (const w of widgets) {
    if (w.x >= 0 && w.y >= 0 && w.x + w.w <= m.cols && w.y + w.h <= m.rows) continue;
    const min = REGISTRY[w.type]?.min ?? { w: 1, h: 1 };
    const nw = clamp(w.w, min.w, m.cols), nh = clamp(w.h, min.h, m.rows);
    let r = { x: clamp(w.x, 0, m.cols - nw), y: clamp(w.y, 0, m.rows - nh), w: nw, h: nh };
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
    toast(t('toast.reflowed'));
    syncHits();
  }
}
let reflowTimer;
const reflowSoon = () => {
  clearTimeout(reflowTimer);
  reflowTimer = setTimeout(reflow, 600);
};
function place(el, r) {
  for (const k of ['x', 'y', 'w', 'h']) el.style.setProperty('--' + k, r[k]);
}

// ---------------- persistence (per widget; Rust owns layout.json) ----------------
const pending = new Map();
function save(w) {
  clearTimeout(pending.get(w.id));
  pending.set(w.id, setTimeout(() => {
    pending.delete(w.id);
    write('put_widget', { widget: w }).catch(() => {});
  }, 300));
}

// Tell Rust where the widgets are so clicks elsewhere pass through to the desktop / windows.
let hitTimer;
function syncHits() {
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => {
    const rects = [...document.querySelectorAll('.widget, [data-hit]:not([hidden])')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      })
      .filter((r) => r.w > 0 && r.h > 0); // hidden by focus mode etc.
    invoke('set_hit_rects', { rects }).catch(console.error);
  }, 160); // after the snap transition settles
}

// ---------------- assets ----------------
function assetUrl(name) {
  if (!name) return '';
  if (!assetsDir) return name; // browser mock
  const sep = assetsDir.includes('\\') ? '\\' : '/';
  return T.core.convertFileSrc(assetsDir + sep + name);
}
function pickFiles(multiple) {
  return new Promise((resolve) => {
    const input = $('#file-picker');
    input.value = '';
    input.multiple = multiple;
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}
const pickImage = async () => (await pickFiles(false))[0] || null;
const pickImages = () => pickFiles(true);
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif' };
async function uploadImage(file) {
  if (file.size > 30 * 1024 * 1024) {
    toast(t('toast.too_big'));
    throw new Error('file too large');
  }
  const ext = MIME_EXT[file.type] || (file.name.includes('.') ? file.name.split('.').pop() : 'png').toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke('save_asset', bytes, { headers: { ext } });
}

// ---------------- widgets ----------------
const injectedCss = new Set();
const UNKNOWN = {
  min: { w: 1, h: 1 },
  mount: (root, s, api) => {
    root.innerHTML = `<div class="w-error">${esc(api.t('toast.unknown_widget'))}</div>`;
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
  w.settings = w.settings && typeof w.settings === 'object' && !Array.isArray(w.settings) ? { ...defaults, ...w.settings } : defaults;
  if (typeof w.font !== 'string' || !w.font) delete w.font;
  if (!(w.fontSize >= 6 && w.fontSize <= 96)) delete w.fontSize;
  if (!w.colors || typeof w.colors !== 'object' || Array.isArray(w.colors)) delete w.colors;
  if (w.frame !== undefined && w.frame !== 'custom' && !FRAMES.includes(w.frame)) delete w.frame;
  if (typeof w.frameSvg !== 'string' || !w.frameSvg.startsWith('data:image/svg+xml')) delete w.frameSvg;
}
const cleanFont = (f) => String(f || '').replace(/["';{}\\<>]/g, '').trim().slice(0, 80);

function mount(w) {
  const def = REGISTRY[w.type] ?? UNKNOWN;
  sanitizeWidget(w, def);
  if (def.css && !injectedCss.has(w.type)) {
    const st = document.createElement('style');
    st.textContent = def.css;
    document.head.insertBefore(st, $('#user-theme')); // theme can still override
    injectedCss.add(w.type);
  }
  const el = document.createElement('div');
  el.className = 'widget';
  el.dataset.widget = w.type;
  el.dataset.id = w.id;
  const name = t('widget.' + w.type);
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', name);
  el.innerHTML = `
    <div class="w-bg" hidden></div>
    <div class="w-body"></div>
    <div class="w-frame" aria-hidden="true"></div>
    <div class="w-head">
      <button class="grip" data-act="grip" title="${esc(t('a11y.grip', { name }))}">⋮⋮</button><span class="title">${esc(name)}</span>
      <span class="w-hint" title="${esc(t('hint.' + w.type))}">${esc(t('hint.' + w.type))}</span>
      <button data-act="remove" title="${esc(t('menu.close'))}">✕</button>
    </div>
    <div class="w-resize" aria-hidden="true"></div>`;
  place(el, w);
  board.append(el);

  const subs = [];
  const api = {
    save: () => save(w), pickImage, pickImages, uploadImage, assetUrl, toast, t, lang, wheelScrollX,
    /** Frameless: no background/outline, so transparent images sit directly on the desktop. */
    setFrameless: (on) => el.classList.toggle('frameless', !!on),
    /** Listen to an app event (e.g. 'media'); removed automatically when the widget closes. */
    on: (event, cb) => {
      let off = null, gone = false;
      listen(event, (e) => cb(e.payload)).then((u) => (gone ? u() : (off = u)));
      subs.push(() => ((gone = true), off?.()));
    },
    media: {
      subscribe: () => invoke('media_subscribe'),
      control: (action, seconds) => invoke('media_control', { action, seconds }).catch(() => {}),
    },
    get size() { return { w: w.w, h: w.h }; },
    get reduceMotion() { return motionReduced(); },
    announce: (msg) => announce(msg),
    /** Something needs attention (timer done…): sound is the widget's job; this adds the opt-in visual/Windows alerts. */
    alert: (title, body) => alertUser(title, body),
    get config() { return config; },
    setInteracting: (on) => invoke('set_interacting', { on }),
    listAssets: () => invoke('list_assets'),
    store: {
      get: (key) => invoke('store_get', { key }),
      set: (key, value) => write('store_set', { key, value, src: w.id }),
    },
    diary: {
      get: (date) => invoke('diary_get', { date }),
      set: (date, text) => write('diary_set', { date, text, src: w.id }),
      dates: () => invoke('diary_dates'),
    },
    /** cb(payload) when another widget changes `key` ('diary' for diary pages). */
    onStore: (key, cb) => { const s = { key, src: w.id, cb }; storeSubs.add(s); subs.push(() => storeSubs.delete(s)); },
    onConfig: (cb) => { configSubs.add(cb); subs.push(() => configSubs.delete(cb)); },
    /** Ask for a bigger/smaller size; neighbours are pushed aside if needed. Returns true on success. */
    requestSize: (size) => {
      const m = metrics();
      const r = { w: clamp(size.w, def.min?.w ?? 1, m.cols), h: clamp(size.h, def.min?.h ?? 1, m.rows) };
      r.x = clamp(w.x, 0, m.cols - r.w);
      r.y = clamp(w.y, 0, m.rows - r.h);
      const layout = resolve(w.id, r);
      if (!layout) return toast(t('toast.no_room')), false;
      applyLayout(layout, { commit: true });
      syncHits();
      return true;
    },
  };
  let inst;
  const body = el.querySelector('.w-body');
  try {
    inst = def.mount(body, w.settings, api);
    if (!inst || typeof inst !== 'object') inst = {};
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="w-error">${esc(t('toast.widget_error'))}<small>${esc(e?.message ?? e)}</small></div>`;
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
  const bg = el.querySelector('.w-bg');
  bg.hidden = !w.bg;
  bg.style.backgroundImage = w.bg ? `url("${assetUrl(w.bg)}")` : '';
}

function applyFont(el, w) {
  el.style.setProperty('--font', w.font ? `"${cleanFont(w.font)}", "Malgun Gothic", sans-serif` : '');
  el.style.setProperty('--font-size', w.fontSize ? `${w.fontSize}px` : '');
}

// ---- font list + per-widget font panel ----
let fontsLoaded = false;
async function loadFonts() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  const fonts = await invoke('list_fonts').catch(() => []);
  $('#font-list').innerHTML = (fonts || []).map((f) => `<option value="${esc(f)}">`).join('');
}
let fontTarget = null;
function openFontPanel(w, el) {
  loadFonts();
  fontTarget = { w, el };
  const p = $('#font-panel');
  const cs = getComputedStyle(el);
  $('#fp-family').value = w.font || '';
  $('#fp-family').placeholder = firstFamily(cs.getPropertyValue('--font'));
  $('#fp-size').value = w.fontSize || parseFloat(cs.getPropertyValue('--font-size')) || 14;
  $('#fp-size-out').textContent = $('#fp-size').value + 'px';
  fillLook(w, el);
  p.hidden = false;
  const r = el.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
  const left = r.right + 8 + pw < innerWidth ? r.right + 8 : Math.max(8, r.left - pw - 8);
  p.style.left = left + 'px';
  p.style.top = clamp(r.top, 8, innerHeight - ph - 8) + 'px';
  syncHits();
}
function closeFontPanel() {
  $('#font-panel').hidden = true;
  fontTarget = null;
  syncHits();
}
const firstFamily = (v) => (v || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
$('#fp-family').addEventListener('change', () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  w.font = cleanFont($('#fp-family').value) || undefined;
  applyFont(el, w);
  save(w);
});
$('#fp-size').addEventListener('input', () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  w.fontSize = +$('#fp-size').value;
  $('#fp-size-out').textContent = w.fontSize + 'px';
  applyFont(el, w);
  save(w);
});
$('#fp-reset').onclick = () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  for (const k of ['font', 'fontSize', 'colors', 'frame', 'frameSvg']) delete w[k];
  applyFont(el, w);
  applyColors(el, w);
  applyFrame(el, w);
  save(w);
  openFontPanel(w, el);
};
/** Per-widget colours: an unset colour follows the theme (shown faded, no ↺). */
function fillLook(w, el) {
  const c = w.colors || {};
  const cs = getComputedStyle(el);
  for (const lab of document.querySelectorAll('#font-panel [data-col]')) {
    const k = lab.dataset.col;
    const inp = lab.querySelector('input');
    const set = c[k] !== undefined && c[k] !== '';
    lab.classList.toggle('unset', !set);
    if (k === 'opacity') inp.value = set ? c[k] : parseFloat(cs.getPropertyValue('--widget-opacity')) || 0.85;
    else inp.value = set ? c[k] : toHex(k === 'frame' ? cs.getPropertyValue('--frame-color') || cs.getPropertyValue('--c2') : cs.getPropertyValue('--' + k));
  }
  $('#fp-frame').value = w.frame ?? '';
}
for (const lab of document.querySelectorAll('#font-panel [data-col]')) {
  const k = lab.dataset.col;
  const inp = lab.querySelector('input');
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
  inp.addEventListener('input', () => setCol(k === 'opacity' ? +inp.value : inp.value));
  lab.querySelector('.mini').onclick = (e) => (e.preventDefault(), setCol(undefined));
}
$('#fp-frame').addEventListener('change', async () => {
  if (!fontTarget) return;
  const { w, el } = fontTarget;
  const v = $('#fp-frame').value;
  if (v === 'custom' && !w.frameSvg) return $('#fp-svg').click();
  if (v) w.frame = v;
  else delete w.frame;
  applyFrame(el, w);
  save(w);
});
/** Custom frame: any SVG, drawn 9-slice (outer 30% = corners) in the frame colour. Stored inline, max 100 KB. */
$('#fp-svg').onclick = async () => {
  if (!fontTarget) return;
  const target = fontTarget;
  const input = $('#file-picker');
  input.accept = 'image/svg+xml,.svg';
  const f = (await pickFiles(false))[0];
  input.accept = 'image/*';
  const { w, el } = target;
  if (!f) return fillLook(w, el);
  if (f.size > 100 * 1024) return toast(t('look.svg_big')), fillLook(w, el);
  const txt = await f.text();
  if (!/<svg[\s>]/i.test(txt)) return toast(t('look.svg_bad')), fillLook(w, el);
  w.frameSvg = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(txt)));
  w.frame = 'custom';
  applyFrame(el, w);
  save(w);
  if (fontTarget === target) fillLook(w, el);
};
$('#fp-close').onclick = closeFontPanel;

function unmount(w) {
  clearTimeout(pending.get(w.id));
  pending.delete(w.id);
  const m = mounted.get(w.id);
  m?.inst.destroy?.();
  m?.inst.unsub?.();
  m?.el.remove();
  mounted.delete(w.id);
  widgets = widgets.filter((o) => o.id !== w.id);
  if (fontTarget?.w.id === w.id) closeFontPanel();
  syncHits();
}

let lastClosed = null;
function removeWidget(w) {
  lastClosed = structuredClone(w);
  unmount(w);
  write('remove_widget', { id: w.id }).catch(() => {});
  toast(t('toast.closed', { name: t('widget.' + w.type) }), { label: t('toast.undo'), fn: restoreClosed });
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

/**
 * Change a widget's type in place (timer → stopwatch …). Position, monitor, background and font stay;
 * each type's own settings are kept in w.stash, so switching back restores them (memo text, photo list…).
 */
function changeType(w, type) {
  const def = REGISTRY[type];
  if (!def || type === w.type) return;
  w.stash = w.stash && typeof w.stash === 'object' ? w.stash : {};
  w.stash[w.type] = w.settings;
  const m = mounted.get(w.id);
  m?.inst.destroy?.();
  m?.inst.unsub?.();
  m?.el.remove();
  mounted.delete(w.id);
  w.type = type;
  w.settings = w.stash[type] ?? structuredClone(def.defaults ?? {});
  delete w.stash[type];
  const min = def.min ?? { w: 1, h: 1 };
  if (w.w < min.w || w.h < min.h) {
    const g = metrics();
    const r = { w: clamp(Math.max(w.w, min.w), 1, g.cols), h: clamp(Math.max(w.h, min.h), 1, g.rows) };
    r.x = clamp(w.x, 0, g.cols - r.w);
    r.y = clamp(w.y, 0, g.rows - r.h);
    const lay = resolve(w.id, r);
    if (lay) applyLayout(lay, { commit: true });
    else Object.assign(w, r), toast(t('toast.overlap'));
  }
  mount(w);
  save(w);
  syncHits();
  announce(t('a11y.type_changed', { name: t('widget.' + type) }));
}

async function setBg(w, el) {
  const f = await pickImage();
  if (!f) return;
  w.bg = await uploadImage(f);
  applyBg(el, w);
  save(w);
}

async function moveTo(w, display) {
  unmount(w);
  await invoke('move_widget', { id: w.id, display });
}

const displayName = (d) => t('menu.display', { n: d.index }) + (d.primary ? ' ' + t('menu.primary') : '');

// Right-click menu on every widget (native Windows menu).
let lastMenu;
async function openMenu(w, el) {
  const others = displays.filter((d) => d.display !== myDisplay);
  const items = [
    { text: t('menu.set_bg'), action: () => setBg(w, el) },
    ...(w.bg ? [{ text: t('menu.clear_bg'), action: () => { delete w.bg; applyBg(el, w); save(w); } }] : []),
    ...(others.length
      ? [{ text: t('menu.move_to'), items: others.map((d) => ({ text: displayName(d), action: () => moveTo(w, d.display) })) }]
      : []),
    ...(mounted.get(w.id)?.inst.menu?.() ?? []),
    {
      text: t('menu.change_type'),
      items: Object.keys(REGISTRY).filter((k) => k !== w.type).map((k) => ({ text: t('widget.' + k), action: () => changeType(w, k) })),
    },
    { text: t('menu.look'), action: () => openFontPanel(w, el) },
    { text: t('menu.summary'), action: () => announceSummary(w) },
    document.body.classList.contains('focus-mode')
      ? { text: t('focus.exit'), action: exitFocus }
      : { text: t('focus.enter'), action: () => enterFocus(w.id) },
    { text: t('menu.edit_layout'), action: () => invoke('set_edit_mode', { on: !editMode }) },
    { item: 'Separator' },
    { text: t('menu.close'), action: () => removeWidget(w) },
  ];
  try {
    await lastMenu?.close();
  } catch {}
  lastMenu = await T.menu.Menu.new({ items });
  await lastMenu.popup();
}

function wireFrame(el, w, def, inst) {
  el.querySelector('[data-act=remove]').onclick = () => removeWidget(w);
  el.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    e.preventDefault();
    openMenu(w, el);
  });
  // keyboard: Menu key / Shift+F10 opens the widget menu from anywhere inside it
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && !e.target.closest('input, textarea')) {
      e.preventDefault();
      openMenu(w, el);
    }
  });

  const min = def.min ?? { w: 1, h: 1 };
  // keyboard: focus the ⋮⋮ grip, arrows move, Shift+arrows resize, Delete closes (with undo)
  const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  el.querySelector('.grip').addEventListener('keydown', (e) => {
    if (e.key === 'Delete') {
      e.preventDefault();
      return removeWidget(w);
    }
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      return announceSummary(w);
    }
    const d = DIRS[e.key];
    if (!d) return;
    e.preventDefault();
    const g = metrics();
    const r = e.shiftKey
      ? { x: w.x, y: w.y, w: clamp(w.w + d[0], min.w, g.cols - w.x), h: clamp(w.h + d[1], min.h, g.rows - w.y) }
      : { x: clamp(w.x + d[0], 0, g.cols - w.w), y: clamp(w.y + d[1], 0, g.rows - w.h), w: w.w, h: w.h };
    if (r.x === w.x && r.y === w.y && r.w === w.w && r.h === w.h) return announce(t('a11y.edge'));
    const lay = resolve(w.id, r);
    if (!lay) return announce(t('toast.no_room'));
    applyLayout(lay, { commit: true });
    syncHits();
    announce(t(e.shiftKey ? 'a11y.resized' : 'a11y.moved', { x: w.x + 1, y: w.y + 1, w: w.w, h: w.h }));
  });
  const drag = (handle, mode) =>
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button:not(.grip)')) return;
      if (ui().lockLayout && !editMode) return; // Settings → 레이아웃 잠금
      e.preventDefault();
      const carry = !!ui().clickDrag; // motor accessibility: click to pick up, move, click again to drop
      if (!carry) handle.setPointerCapture(e.pointerId);
      invoke('set_interacting', { on: true });
      const m = metrics();
      const s = { px: e.clientX, py: e.clientY, x: w.x, y: w.y, w: w.w, h: w.h };
      let cand = { x: w.x, y: w.y, w: w.w, h: w.h };
      let layout = null; // pushed-aside arrangement for the current candidate
      let lastKey = '';
      el.classList.add('moving');
      board.classList.add('arranging');

      const move = (ev) => {
        const dx = Math.round((ev.clientX - s.px) / m.step);
        const dy = Math.round((ev.clientY - s.py) / m.step);
        cand =
          mode === 'move'
            ? { x: clamp(s.x + dx, 0, m.cols - s.w), y: clamp(s.y + dy, 0, m.rows - s.h), w: s.w, h: s.h }
            : { x: s.x, y: s.y, w: clamp(s.w + dx, min.w, m.cols - s.x), h: clamp(s.h + dy, min.h, m.rows - s.y) };
        const key = `${cand.x},${cand.y},${cand.w},${cand.h}`;
        if (key === lastKey) return;
        lastKey = key;
        layout = resolve(w.id, cand);
        applyLayout(layout, { commit: false }); // others slide aside (or back) as a preview
        place(el, cand);
        el.classList.toggle('invalid', !layout);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerdown', drop, true);
        removeEventListener('keydown', cancelCarry, true);
        el.classList.remove('moving', 'invalid');
        board.classList.remove('arranging');
        const changed = cand.x !== w.x || cand.y !== w.y || cand.w !== w.w || cand.h !== w.h;
        applyLayout(changed ? layout : null, { commit: true }); // invalid drop -> everything snaps back
        place(el, w);
        invoke('set_interacting', { on: false });
        syncHits();
      };
      const drop = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        up();
      };
      const cancelCarry = (ev) => {
        if (ev.key !== 'Escape') return;
        ev.stopPropagation();
        cand = { x: w.x, y: w.y, w: w.w, h: w.h };
        layout = null;
        up();
      };
      if (carry) {
        document.addEventListener('pointermove', move);
        setTimeout(() => document.addEventListener('pointerdown', drop, true)); // the next click drops it
        addEventListener('keydown', cancelCarry, true);
        announce(t('a11y.carrying'));
        return;
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  drag(el.querySelector('.w-head'), 'move');
  drag(el.querySelector('.w-resize'), 'resize');
}

/** Find room for a widget on this board: preferred size, then minimum size. */
function findRoom(def, pref) {
  for (const size of [pref, def.min].filter(Boolean)) {
    const spot = findSpot(size.w, size.h);
    if (spot) return { ...spot, w: size.w, h: size.h };
  }
  return null;
}

function addWidget(type) {
  const def = REGISTRY[type];
  if (!def) return;
  const room = findRoom(def, def.size);
  if (!room) return toast(t('toast.no_space'));
  const w = { id: crypto.randomUUID(), type, display: myDisplay, ...room, settings: structuredClone(def.defaults ?? {}) };
  widgets.push(w);
  mount(w);
  save(w);
  syncHits();
}

// A widget moved here from another monitor.
function receiveWidget(w) {
  const def = REGISTRY[w.type];
  if (!def || mounted.has(w.id)) return;
  const room = findRoom(def, { w: w.w, h: w.h });
  if (room) {
    Object.assign(w, room);
  } else {
    Object.assign(w, { x: 0, y: 0 });
    toast(t('toast.overlap'));
  }
  w.display = myDisplay;
  widgets.push(w);
  mount(w);
  save(w);
  syncHits();
}

// ---------------- theme ----------------
const PANEL_VARS = [...document.querySelectorAll('#theme-panel [data-var]')];
function sanitize(css) {
  // Shared themes may not pull remote content.
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?\s*(https?:|\/\/)[^)]*\)/gi, 'none');
}
function applyTheme(css) {
  themeCss = typeof css === 'string' ? css : '';
  for (const i of PANEL_VARS) document.documentElement.style.removeProperty(i.dataset.var);
  $('#user-theme').textContent = sanitize(themeCss);
  // a broken theme (e.g. --cell: abc) must not wreck the grid
  const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell'));
  if (!(cell >= 24 && cell <= 400)) document.documentElement.style.setProperty('--cell', '80px');
  fillPanel();
  syncHits();
  reflowSoon();
}
function setVar(css, name, value) {
  const esc = name.replace(/[-]/g, '\\-');
  const re = new RegExp(`(^|[\\s;{])(${esc}\\s*:\\s*)([^;]*)(;)`, 'm');
  if (re.test(css)) return css.replace(re, `$1$2${value}$4`);
  if (/:root\s*\{/.test(css)) return css.replace(/:root\s*\{/, (m) => `${m}\n  ${name}: ${value};`);
  return `${css}\n:root { ${name}: ${value}; }\n`;
}
const cvs = document.createElement('canvas').getContext('2d');
function toHex(color) {
  cvs.fillStyle = '#000';
  cvs.fillStyle = color.trim();
  return cvs.fillStyle.startsWith('#') ? cvs.fillStyle : '#000000';
}
function fillPanel() {
  const cs = getComputedStyle(document.documentElement);
  $('#theme-font').value = firstFamily(cs.getPropertyValue('--font'));
  for (const i of PANEL_VARS) {
    const v = cs.getPropertyValue(i.dataset.var).trim();
    i.value = i.type === 'color' ? toHex(v) : parseFloat(v) || 0;
  }
}
for (const i of PANEL_VARS) {
  const val = () => i.value + (i.dataset.unit ?? '');
  i.addEventListener('input', () => {
    document.documentElement.style.setProperty(i.dataset.var, val());
    syncHits();
  });
  i.addEventListener('change', () => {
    themeCss = setVar(themeCss, i.dataset.var, val());
    write('save_theme', { css: themeCss }).catch(() => {});
  });
}
$('#theme-font').addEventListener('change', () => {
  const name = cleanFont($('#theme-font').value);
  const val = name ? `"${name}", "Malgun Gothic", system-ui, sans-serif` : '"Segoe UI Variable", "Segoe UI", "Malgun Gothic", system-ui, sans-serif';
  themeCss = setVar(themeCss, '--font', val);
  write('save_theme', { css: themeCss }).catch(() => {});
});
$('#theme-close').onclick = () => {
  $('#theme-panel').hidden = true;
  syncHits();
};
$('#theme-file').onclick = () => invoke('open_theme_file');

// ---------------- AI themes: copy the master prompt, paste the answer back ----------------
/** Pull the CSS out of an AI answer: the first ``` block if there is one, otherwise the whole text. */
function extractCss(text) {
  const m = String(text).match(/```(?:css)?\s*\n([\s\S]*?)```/i);
  return (m ? m[1] : String(text)).trim();
}
/** Check a theme before using it. Returns { ok, css, warnings[], error }. */
function checkTheme(text) {
  const css = extractCss(text);
  if (!css) return { ok: false, error: t('ai.err_empty') };
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(sanitize(css));
  } catch {
    return { ok: false, error: t('ai.err_syntax') };
  }
  const rules = [...sheet.cssRules];
  const style = rules.filter((r) => r.style);
  if (!style.some((r) => [...r.style].some((p) => p.startsWith('--')))) return { ok: false, error: t('ai.err_no_vars') };
  const warnings = [];
  const outside = style.filter((r) => !/^(:root|\[data-widget=("|')?[a-z]+("|')?\])(\s*,\s*(:root|\[data-widget=("|')?[a-z]+("|')?\]))*$/.test(r.selectorText));
  if (outside.length || rules.length !== style.length) warnings.push(t('ai.warn_outside', { n: outside.length + rules.length - style.length }));
  if (/@import|url\(\s*['"]?\s*(https?:|\/\/)/i.test(css)) warnings.push(t('ai.warn_remote'));
  if (/--(cell|gap)\s*:/.test(css)) warnings.push(t('ai.warn_grid'));
  return { ok: true, css, warnings };
}
/** WCAG contrast ratio between two CSS colours (as resolved by the browser). */
function contrast(a, b) {
  const lum = (c) => {
    const p = document.createElement('i');
    p.style.color = c;
    document.body.append(p);
    const v = getComputedStyle(p).color;
    p.remove();
    const n = v.match(/[\d.]+/g)?.map(Number) || [0, 0, 0];
    const rgb = v.startsWith('color(') ? n.slice(0, 3).map((x) => x * 255) : n.slice(0, 3);
    const ch = rgb.map((x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function contrastWarnings() {
  const w = [];
  const text = contrast('var(--c3)', 'var(--c1)');
  const acc = contrast('var(--on-accent)', 'var(--c2)');
  if (text < 4.5) w.push(t('ai.warn_contrast_text', { r: text.toFixed(1) }));
  if (acc < 3) w.push(t('ai.warn_contrast_accent', { r: acc.toFixed(1) }));
  return w;
}
let themeBackup = null;
async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: txt });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
$('#theme-ai-copy').onclick = async () => {
  const prompt = await fetch('ai-theme-prompt.md').then((r) => r.text()).catch(() => '');
  const body = prompt.split('<!-- PROMPT START -->')[1]?.split('<!-- PROMPT END -->')[0]?.trim() || prompt;
  const full = `${body}\n\n## My current theme (start from this if I ask to change it)\n\`\`\`css\n${themeCss.trim()}\n\`\`\`\n\n## What I want\n`;
  toast(t((await copyText(full)) ? 'ai.copied' : 'ai.copy_failed'));
};
$('#theme-ai-paste').onclick = () => {
  $('#paste-panel').hidden = false;
  $('#paste-result').textContent = '';
  $('#paste-text').focus();
  syncHits();
};
$('#paste-cancel').onclick = () => {
  $('#paste-panel').hidden = true;
  syncHits();
};
$('#paste-apply').onclick = async () => {
  const res = $('#paste-result');
  const r = checkTheme($('#paste-text').value);
  res.className = '';
  if (!r.ok) {
    res.className = 'bad';
    res.textContent = r.error;
    return;
  }
  themeBackup = themeCss;
  invoke('store_set', { key: 'theme_backup', value: themeBackup, src: 'host' }).catch(() => {});
  applyTheme(r.css);
  await write('save_theme', { css: r.css }).catch(() => {});
  const warnings = [...r.warnings, ...contrastWarnings()];
  res.className = warnings.length ? 'warn' : '';
  res.textContent = warnings.length ? warnings.join(' · ') : t('ai.applied');
  $('#theme-undo').hidden = false;
};
$('#theme-undo').onclick = async () => {
  const prev = themeBackup ?? (await invoke('store_get', { key: 'theme_backup' }).catch(() => null));
  if (typeof prev !== 'string') return toast(t('ai.no_backup'));
  applyTheme(prev);
  await write('save_theme', { css: prev }).catch(() => {});
  themeBackup = null;
  $('#theme-undo').hidden = true;
  toast(t('ai.undone'));
};

// ---------------- edit mode ----------------
function setEdit(on) {
  editMode = on;
  document.body.classList.toggle('edit', on);
  $('#editbar').hidden = !on;
  if (!on) $('#theme-panel').hidden = $('#paste-panel').hidden = $('#settings-panel').hidden = $('#layouts-panel').hidden = true;
  syncHits();
}
$('#edit-done').onclick = () => invoke('set_edit_mode', { on: false });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#font-panel').hidden) return closeFontPanel();
  if (!$('#overview-panel').hidden) return $('#overview-close').click();
  if (!$('#layouts-panel').hidden) return $('#layouts-close').click();
  if (!$('#settings-panel').hidden) return $('#settings-close').click();
  if (document.body.classList.contains('focus-mode')) return exitFocus();
  if (document.body.classList.contains('kbd-mode')) return invoke('set_kbd_mode', { on: false });
  if (editMode) invoke('set_edit_mode', { on: false });
});

// ---------------- misc ----------------
let toastTimer;
/** toast('text') or toast('text', { label: '되돌리기', fn }) — an action keeps it up longer. */
function toast(msg, action) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => {
      el.hidden = true;
      syncHits();
      action.fn();
    };
    el.append(' ', b);
  }
  el.hidden = false;
  syncHits();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    syncHits();
  }, action ? 7000 : 2600);
}
/** Screen-reader announcement without a visible toast. */
function announce(msg) {
  const sr = $('#sr');
  sr.textContent = '';
  setTimeout(() => (sr.textContent = msg), 30);
}

// Screen readers: icon-only buttons get their tooltip as their accessible name (kept in sync as widgets redraw).
function labelButtons() {
  for (const b of document.querySelectorAll('button[title]')) if (b.getAttribute('aria-label') !== b.title) b.setAttribute('aria-label', b.title);
}
let labelRaf = 0;
new MutationObserver(() => {
  if (!labelRaf) labelRaf = requestAnimationFrame(() => ((labelRaf = 0), labelButtons()));
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

// ---------------- settings: layout, behaviour, accessibility (config.json → "ui") ----------------
const UI_DEFAULTS = {
  header: 'hover', density: 'normal', lockLayout: false, weekStart: 'default',
  timerSound: true, timerVolume: 60, timerRings: 10,
  highContrast: false, bigTargets: false, wideText: false, showControls: false,
  // accessibility — every one of these is OFF until the user turns it on
  hotkey: '', dwellMs: 0, clickDrag: false, // keyboard & motor
  zoom: 1, // low vision
  flashAlert: false, notifyAlert: false, soundCaptions: false, // deaf / hard of hearing
  cvd: false, // colour vision
  showHints: false, readableFont: 'none', shortLines: false, reminderTime: '', // cognitive load
  frame: 'none', // decoration default for every widget
};
const ui = () => ({ ...UI_DEFAULTS, ...(config.ui && typeof config.ui === 'object' ? config.ui : {}) });
function applyUi() {
  const u = ui();
  const c = document.body.classList;
  c.toggle('header-always', u.header === 'always');
  c.toggle('header-hidden', u.header === 'hidden');
  for (const d of ['compact', 'normal', 'roomy']) c.toggle('density-' + d, u.density === d);
  c.toggle('lock-layout', !!u.lockLayout);
  c.toggle('high-contrast', !!u.highContrast);
  c.toggle('big-targets', !!u.bigTargets);
  c.toggle('wide-text', !!u.wideText);
  c.toggle('show-controls', !!u.showControls || !!u.highContrast);
  c.toggle('cvd-safe', !!u.cvd);
  c.toggle('show-hints', !!u.showHints);
  c.toggle('short-lines', !!u.shortLines);
  for (const f of ['atkinson', 'lexend', 'opendyslexic']) c.toggle('font-' + f, u.readableFont === f);
  // native side, only when something changed
  const nat = { dwell: +u.dwellMs || 0, zoom: +u.zoom || 1, hotkey: String(u.hotkey || '') };
  if (sentNative.dwell !== nat.dwell) invoke('set_dwell', { ms: nat.dwell }).catch(() => {});
  if (sentNative.zoom !== nat.zoom) invoke('set_zoom', { zoom: nat.zoom }).catch(() => {});
  if (sentNative.hotkey !== nat.hotkey && isPrimary)
    invoke('set_hotkey', { accel: nat.hotkey }).catch(() => nat.hotkey && toast(t('a11y.hotkey_taken', { key: nat.hotkey })));
  sentNative = nat;
  for (const [id, m] of mounted) applyFrame(m.el, widgets.find((x) => x.id === id));
  fillSettings();
  syncHits();
}
let sentNative = { dwell: 0, zoom: 1, hotkey: '' };
let isPrimary = false;

// ---------------- accessibility helpers ----------------
function summaryOf(w) {
  try {
    return mounted.get(w.id)?.inst.summary?.() || t('sum.empty');
  } catch {
    return t('sum.empty');
  }
}
function announceSummary(w) {
  const text = `${t('widget.' + w.type)}: ${summaryOf(w)}`;
  announce(text);
  toast(text);
}
/** Text-only overview of every widget (screen readers, low vision, "what's on my board?"). */
function openOverview() {
  const list = $('#overview-list');
  list.innerHTML = widgets
    .map((w) => `<li><button data-goto="${esc(w.id)}">${esc(t('widget.' + w.type))}</button> <span>${esc(summaryOf(w))}</span></li>`)
    .join('') || `<li>${esc(t('sum.empty'))}</li>`;
  $('#overview-panel').hidden = false;
  list.querySelector('button')?.focus();
  syncHits();
}
$('#overview-list').addEventListener('click', (e) => {
  const id = e.target.closest('[data-goto]')?.dataset.goto;
  if (!id) return;
  $('#overview-panel').hidden = true;
  mounted.get(id)?.el.querySelector('.grip')?.focus();
  syncHits();
});
$('#overview-close').onclick = () => (($('#overview-panel').hidden = true), syncHits());
$('#settings-overview').onclick = openOverview;

// focus mode (cognitive load): show one widget, hide the rest until you leave
function enterFocus(id) {
  document.body.classList.add('focus-mode');
  for (const [k, m] of mounted) m.el.classList.toggle('focused', k === id);
  $('#focusbar').hidden = false;
  syncHits();
}
function exitFocus() {
  document.body.classList.remove('focus-mode');
  for (const m of mounted.values()) m.el.classList.remove('focused');
  $('#focusbar').hidden = true;
  syncHits();
}
$('#focus-exit').onclick = exitFocus;

// deaf / hard of hearing: visual + Windows alerts (both opt-in)
function alertUser(title, body) {
  const u = ui();
  if (u.flashAlert) {
    const f = $('#flash');
    f.querySelector('b').textContent = title;
    f.classList.toggle('steady', motionReduced());
    f.hidden = false;
    clearTimeout(f._t);
    f._t = setTimeout(() => (f.hidden = true), 6000);
  }
  if (u.notifyAlert) invoke('notify', { title, body: body || '' }).catch(() => {});
  announce(`${title}. ${body || ''}`);
}

// gentle reminder (cognitive load): at a chosen time, how many to-dos are left today — once a day, primary board only
let remindedOn = '';
async function checkReminder() {
  const at = ui().reminderTime;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (!isPrimary || !at || hm !== at || remindedOn === today) return;
  remindedOn = today;
  const items = (await invoke('store_get', { key: 'checklist' }).catch(() => null)) || [];
  const events = (await invoke('store_get', { key: 'events' }).catch(() => null)) || [];
  const left =
    (Array.isArray(items) ? items : []).filter((i) =>
      i && (i.repeat === 'daily' || i.repeat === true ? !(i.doneKeys || i.doneDates || []).includes(today) : !i.repeat && !i.done && (i.date || today) <= today),
    ).length + (Array.isArray(events) ? events : []).filter((e) => e && e.date === today && !e.done).length;
  if (!left) return;
  const msg = t('remind.left', { n: left });
  toast(msg);
  if (ui().notifyAlert) invoke('notify', { title: 'WidgetBoard', body: msg }).catch(() => {});
  announce(msg);
}
setInterval(checkReminder, 20000);

// keyboard mode (global shortcut): widgets come forward and take the keyboard; Esc leaves
function setKbd(on) {
  document.body.classList.toggle('kbd-mode', on);
  $('#kbdbar').hidden = !on;
  if (on && isPrimary) setTimeout(() => board.querySelector('.grip')?.focus(), 80);
  syncHits();
}
addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('kbd-mode') || e.target.closest('input, textarea, select')) return;
  if (e.key === 'l' || e.key === 'L') openOverview();
});
addEventListener('blur', () => document.body.classList.contains('kbd-mode') && invoke('set_kbd_mode', { on: false }));

// ---------------- per-widget appearance: colours, opacity, frames ----------------
/**
 * Built-in frames: 48×48 SVGs drawn 9-slice (16px corners) as a MASK, so they take any colour
 * (--frame-color, default the accent). Only the alpha of the SVG matters.
 */
const FRAME_SVG = (() => {
  const sv = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#000">${body}</svg>`;
  const dots = [4, 12, 20, 28, 36, 44].flatMap((v) => [[v, 5], [v, 43], [5, v], [43, v]]);
  const curl = '<path d="M2 16Q2 2 16 2" stroke-width="2.2"/><path d="M7 16Q7 7 16 7" stroke-width="1"/><circle cx="11" cy="11" r="2.2" fill="#000" stroke="none"/>';
  const px = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  return {
    corners: sv('<path d="M3 17V3h14M31 3h14v14M45 31v14H31M17 45H3V31" stroke-width="3"/>'),
    double: sv('<rect x="2" y="2" width="44" height="44" stroke-width="2"/><rect x="7" y="7" width="34" height="34" stroke-width="1"/>'),
    stitch: sv('<rect x="5" y="5" width="38" height="38" rx="3" stroke-width="1.6" stroke-dasharray="4 4"/>'),
    dots: sv(`<g fill="#000" stroke="none">${[...new Set(dots.map(String))].map((p) => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="1.7"/>`).join('')}</g>`),
    ornate: sv(`<path d="M16 4H32M16 44H32M4 16V32M44 16V32" stroke-width="1"/>${[0, 90, 180, 270].map((r) => `<g transform="rotate(${r} 24 24)">${curl}</g>`).join('')}`),
    pixel: sv(`<g fill="#000" stroke="none" shape-rendering="crispEdges">${px(6, 0, 36, 3)}${px(6, 45, 36, 3)}${px(0, 6, 3, 36)}${px(45, 6, 3, 36)}${px(3, 3, 3, 3)}${px(42, 3, 3, 3)}${px(3, 42, 3, 3)}${px(42, 42, 3, 3)}</g>`),
    tape: sv('<g fill="#000" fill-opacity=".6" stroke="none"><rect x="-1" y="5" width="18" height="7" transform="rotate(-45 8 8.5)"/><rect x="31" y="5" width="18" height="7" transform="rotate(45 40 8.5)"/></g>'),
  };
})();
const FRAMES = ['none', ...Object.keys(FRAME_SVG)];
const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
function applyFrame(el, w) {
  if (!el || !w) return;
  const kind = w.frame ?? ui().frame;
  const f = el.querySelector('.w-frame');
  if (!f) return;
  const custom = kind === 'custom' && typeof w.frameSvg === 'string' && w.frameSvg.startsWith('data:image/svg+xml');
  f.dataset.kind = custom ? 'custom' : FRAME_SVG[kind] ? kind : 'none';
  f.style.setProperty('--frame-mask', custom ? `url("${w.frameSvg}")` : FRAME_SVG[kind] ? svgUrl(FRAME_SVG[kind]) : '');
}
function onAccentFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#111111' : '#ffffff';
}
function applyColors(el, w) {
  const c = w.colors && typeof w.colors === 'object' ? w.colors : {};
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '');
  el.style.setProperty('--c1', hex(c.c1));
  el.style.setProperty('--c2', hex(c.c2));
  el.style.setProperty('--c3', hex(c.c3));
  el.style.setProperty('--on-accent', hex(c.onAccent) || (hex(c.c2) ? onAccentFor(c.c2) : ''));
  el.style.setProperty('--line-color', hex(c.c2) ? `color-mix(in srgb, ${c.c2} 55%, transparent)` : '');
  el.style.setProperty('--frame-color', hex(c.frame));
  el.style.setProperty('--widget-opacity', c.opacity >= 0 && c.opacity <= 1 ? String(c.opacity) : '');
}
// ---------------- layouts: presets (업무용 / 공부용) + saved arrangements ----------------
/** [type, w, h, settings override]. Packed from the top-right corner (desktop icons live top-left). */
const PRESETS = {
  work: [['calendar', 5, 4, { view: 'board' }], ['checklist', 3, 4], ['memo', 3, 3], ['timer', 3, 2], ['dday', 3, 3], ['nowplaying', 4, 2]],
  study: [['timer', 3, 2], ['stopwatch', 3, 2], ['checklist', 3, 4], ['diary', 4, 4], ['dday', 3, 3], ['calendar', 4, 4, { view: 'mini' }]],
};
/** Pack slots onto an empty cols×rows grid, right-aligned. Returns [{slot, x, y, w, h}] (slots that don't fit are left out). */
function packSlots(slots, cols, rows) {
  const placed = [];
  const free = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= cols && r.y + r.h <= rows && !placed.some((p) => overlaps(p, r));
  for (const slot of slots) {
    const def = REGISTRY[slot[0]];
    if (!def) continue;
    const min = def.min ?? { w: 1, h: 1 };
    let spot = null;
    for (const size of [{ w: slot[1], h: slot[2] }, min]) {
      for (let y = 0; !spot && y + size.h <= rows; y++)
        for (let x = cols - size.w; !spot && x >= 0; x--) if (free({ x, y, ...size })) spot = { x, y, ...size };
      if (spot) break;
    }
    if (spot) placed.push({ slot, ...spot });
  }
  return placed;
}
async function flushSaves() {
  for (const [id, timer] of [...pending]) {
    clearTimeout(timer);
    pending.delete(id);
    const w = widgets.find((x) => x.id === id);
    if (w) await write('put_widget', { widget: w }).catch(() => {});
  }
}
/**
 * Widgets a layout puts away go on a shelf (latest copy per id, max 60), so switching layouts back and forth
 * never loses a memo or a photo list: presets reuse shelved widgets of the same type, saved layouts their own ids.
 */
async function getShelf() {
  const s = await invoke('store_get', { key: 'layouts_shelf' }).catch(() => null);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}
async function replaceAll(next, label) {
  await flushSaves();
  const before = await invoke('get_all_widgets');
  const shelf = await getShelf();
  const now = Date.now();
  for (const w of before) if (!next.some((n) => n.id === w.id)) shelf[w.id] = { at: now, w };
  for (const n of next) delete shelf[n.id];
  const keep = Object.entries(shelf).sort((a, b) => b[1].at - a[1].at).slice(0, 60);
  await write('store_set', { key: 'layouts_shelf', value: Object.fromEntries(keep), src: 'layouts' });
  await write('store_set', { key: 'layouts_undo', value: before, src: 'layouts' });
  try { sessionStorage.setItem('wb-layout-applied', label); } catch {}
  await write('replace_widgets', { widgets: next }); // every board reloads
}
async function applyPreset(name) {
  const slots = PRESETS[name];
  if (!slots) return;
  await flushSaves();
  const all = await invoke('get_all_widgets');
  const others = all.filter((w) => !widgets.some((m) => m.id === w.id)); // other monitors stay as they are
  // reuse same-type widgets (this board first, then the shelf): notes, photos, settings survive
  const shelved = Object.values(await getShelf()).sort((a, b) => b.at - a.at).map((e) => e.w)
    .filter((w) => w && w.id && !all.some((a) => a.id === w.id));
  const pool = [...widgets, ...shelved].map((w) => structuredClone(w));
  const m = metrics();
  const packed = packSlots(slots, m.cols, m.rows);
  const mine = packed.map(({ slot, x, y, w, h }) => {
    const i = pool.findIndex((p) => p.type === slot[0]);
    const base = i >= 0 ? pool.splice(i, 1)[0] : { id: crypto.randomUUID(), type: slot[0], settings: structuredClone(REGISTRY[slot[0]].defaults ?? {}) };
    if (slot[3]) base.settings = { ...base.settings, ...slot[3] };
    return { ...base, display: myDisplay, x, y, w, h };
  });
  if (packed.length < slots.length) toast(t('lay.partial'));
  await replaceAll([...others, ...mine], t('lay.' + name));
}
let savedLayouts = [];
async function renderLayouts() {
  const list = await invoke('store_get', { key: 'layouts' }).catch(() => null);
  savedLayouts = (Array.isArray(list) ? list : []).filter((l) => l && typeof l.name === 'string' && Array.isArray(l.widgets));
  $('#layout-list').innerHTML = savedLayouts.length
    ? savedLayouts.map((l, i) => `<li><span title="${esc(l.name)}">${esc(l.name)}</span><small>${esc(t('lay.count', { n: l.widgets.length }))}</small>
        <button data-apply="${i}">${esc(t('lay.apply'))}</button><button class="mini" data-del="${i}" title="${esc(t('lay.delete', { name: l.name }))}">✕</button></li>`).join('')
    : `<li class="empty">${esc(t('lay.none'))}</li>`;
  const undo = await invoke('store_get', { key: 'layouts_undo' }).catch(() => null);
  $('#layout-undo').hidden = !Array.isArray(undo);
}
function openLayouts() {
  for (const p of ['#theme-panel', '#paste-panel', '#settings-panel']) $(p).hidden = true;
  $('#layouts-panel').hidden = false;
  renderLayouts();
  $('#layouts-panel .presets button').focus();
  syncHits();
}
$('#layouts-close').onclick = () => (($('#layouts-panel').hidden = true), syncHits());
$('#settings-layouts').onclick = openLayouts;
$('#layouts-panel .presets').onclick = (e) => {
  const b = e.target.closest('[data-preset]');
  if (b) applyPreset(b.dataset.preset).catch(reportError);
};
$('#layout-save').onclick = async () => {
  await flushSaves();
  const now = new Date();
  const name = $('#layout-name').value.trim().slice(0, 40) ||
    t('lay.default_name', { date: `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
  const all = await invoke('get_all_widgets');
  const next = [...savedLayouts.filter((l) => l.name !== name), { name, saved: now.toISOString(), widgets: all }].slice(-20);
  await write('store_set', { key: 'layouts', value: next, src: 'layouts' });
  $('#layout-name').value = '';
  toast(t('lay.saved_as', { name }));
  renderLayouts();
};
$('#layout-name').addEventListener('keydown', (e) => e.key === 'Enter' && $('#layout-save').click());
$('#layout-list').onclick = async (e) => {
  const a = e.target.closest('[data-apply]'), d = e.target.closest('[data-del]');
  if (a) {
    const l = savedLayouts[+a.dataset.apply];
    if (!l) return;
    await flushSaves();
    const current = await invoke('get_all_widgets');
    const shelf = await getShelf();
    // positions come from the layout; contents (memo text…) come from the newest copy: on the board, else the shelf
    const next = l.widgets.filter((w) => w && w.id).map((w) => {
      const c = current.find((x) => x.id === w.id && x.type === w.type) ?? (shelf[w.id]?.w?.type === w.type ? shelf[w.id].w : null);
      return c ? { ...structuredClone(w), settings: c.settings, stash: c.stash } : structuredClone(w);
    });
    await replaceAll(next, l.name);
  } else if (d) {
    const i = +d.dataset.del;
    const gone = savedLayouts[i];
    const next = savedLayouts.filter((_, k) => k !== i);
    await write('store_set', { key: 'layouts', value: next, src: 'layouts' });
    renderLayouts();
    toast(t('lay.deleted', { name: gone.name }), {
      label: t('toast.undo'),
      fn: async () => {
        await write('store_set', { key: 'layouts', value: [...savedLayouts, gone], src: 'layouts' });
        renderLayouts();
      },
    });
  }
};
async function undoLayout() {
  const prev = await invoke('store_get', { key: 'layouts_undo' }).catch(() => null);
  if (!Array.isArray(prev)) return;
  await write('store_set', { key: 'layouts_undo', value: null, src: 'layouts' });
  await write('replace_widgets', { widgets: prev });
}
$('#layout-undo').onclick = () => undoLayout().catch(reportError);

function fillSettings() {
  const u = ui();
  for (const i of document.querySelectorAll('#settings-panel [data-ui]')) {
    const v = u[i.dataset.ui];
    if (i.type === 'checkbox') i.checked = !!v;
    else i.value = String(v);
  }
}
for (const i of document.querySelectorAll('#settings-panel [data-ui]')) {
  i.addEventListener(i.type === 'range' ? 'input' : 'change', () => {
    const k = i.dataset.ui;
    const v = i.type === 'checkbox' ? i.checked : /^-?\d+(\.\d+)?$/.test(i.value) ? +i.value : i.value;
    config = { ...config, ui: { ...(config.ui || {}), [k]: v } };
    applyUi();
    configSubs.forEach((cb) => cb(config));
    clearTimeout(i._t);
    i._t = setTimeout(() => write('save_config', { patch: { ui: { [k]: v } } }).catch(() => {}), 250);
  });
}
$('#set-autostart').addEventListener('change', async (e) => {
  const on = await invoke('set_autostart', { on: e.target.checked }).catch(() => !e.target.checked);
  e.target.checked = !!on;
});
$('#settings-close').onclick = () => {
  $('#settings-panel').hidden = true;
  syncHits();
};
$('#settings-file').onclick = () => invoke('open_config_file');
function openSettings() {
  $('#theme-panel').hidden = $('#paste-panel').hidden = true;
  fillSettings();
  invoke('update_status').then(showUpdate).catch(() => {});
  $('#settings-panel').hidden = false;
  $('#settings-panel select, #settings-panel input')?.focus();
  syncHits();
}
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());
addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, [contenteditable]')) e.preventDefault();
});
addEventListener('resize', () => {
  syncHits();
  reflowSoon();
});
// Unexpected errors: keep running, tell the user once in a while.
let lastErr = 0;
function reportError(e) {
  if (e?.reported) return;
  console.error(e);
  if (Date.now() - lastErr > 10000) toast(t('toast.error'));
  lastErr = Date.now();
}
addEventListener('error', (e) => reportError(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => reportError(e.reason));

// ---------------- boot ----------------
(async function boot() {
  const st = await invoke('load_state');
  lang = st.lang || 'ko';
  config = st.config || {};
  setMotion(st.reduceMotion);
  isPrimary = !!st.primary;
  applyUi();
  $('#set-autostart').checked = !!st.autostart;
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => setMotion(reduceMotion));
  await loadLang(lang);
  myDisplay = st.display || '';
  isPrimary = !!st.primary;
  displays = st.displays || [];
  assetsDir = st.assetsDir || '';
  applyTheme(st.theme);
  const seen = new Set();
  widgets = (Array.isArray(st.widgets) ? st.widgets : []).filter((w) => w && typeof w === 'object');
  for (const w of widgets) {
    if (!w.id || seen.has(w.id)) w.id = crypto.randomUUID();
    seen.add(w.id);
    try {
      mount(w); // one broken widget must never stop the others from loading
    } catch (e) {
      reportError(e);
    }
  }
  setTimeout(reflow, 400);
  setEdit(!!st.edit);
  syncHits();

  await listen('add-widget', (e) => addWidget(e.payload));
  await listen('widget-arrived', (e) => receiveWidget(e.payload));
  await listen('edit-mode', (e) => setEdit(!!e.payload));
  await listen('theme-changed', (e) => applyTheme(e.payload));
  await listen('lang-changed', () => location.reload());
  await listen('toast', (e) => toast(t(e.payload)));
  await listen('motion-changed', (e) => setMotion(e.payload));
  await listen('config-changed', (e) => {
    config = e.payload || {};
    applyUi();
    configSubs.forEach((cb) => cb(config));
  });
  await listen('open-settings', openSettings);
  await listen('open-layouts', openLayouts);
  await listen('kbd-mode', (e) => setKbd(!!e.payload));
  await listen('layout-replaced', () => location.reload());
  await listen('store-changed', (e) => {
    const p = e.payload || {};
    for (const s of storeSubs) if (s.key === p.key && s.src !== p.src) s.cb(p);
  });
  invoke('store_get', { key: 'theme_backup' }).then((b) => ($('#theme-undo').hidden = typeof b !== 'string')).catch(() => {});
  await listen('open-theme-panel', () => {
    $('#settings-panel').hidden = true;
    loadFonts();
    fillPanel();
    $('#theme-panel').hidden = false;
    syncHits();
  });
  let applied = null;
  try {
    applied = sessionStorage.getItem('wb-layout-applied');
    sessionStorage.removeItem('wb-layout-applied');
  } catch {}
  if (applied) toast(t('lay.applied', { name: applied }), { label: t('toast.undo'), fn: () => undoLayout().catch(reportError) });
  else if (st.justUpdated) toast(t('upd.done', { v: st.justUpdated }));
  else if (st.primary && !widgets.length) toast(t('toast.empty'));

  await listen('update-status', (e) => showUpdate(e.payload));
  await listen('update-ready', (e) => {
    const v = e.payload?.version;
    if (v) toast(t('upd.ready', { v }), { label: t('upd.restart'), fn: applyUpdate });
  });
  await listen('update-failed', (e) => toast(t('upd.failed', { e: updateError(e.payload) })));
  await listen('flush-saves', () => flushSaves());
})();

// ---------------- updates (checked by Rust on a slow schedule; see updater.rs) ----------------
const updateError = (e) => (e === 'not_configured' ? t('upd.not_configured') : String(e || ''));
function showUpdate(info) {
  if (!info) return;
  $('#set-update').value = ['weekly', 'daily', 'off'].includes(info.check) ? info.check : 'weekly';
  const when = info.lastCheck ? new Date(info.lastCheck * 1000).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const lines = [t('upd.current', { v: info.current })];
  if (info.busy) lines.push(t('upd.checking'));
  else if (info.pending) lines.push(t('upd.ready', { v: info.pending.version }) + (info.pending.notes ? ` — ${info.pending.notes}` : ''));
  else if (!info.configured) lines.push(t('upd.not_configured'));
  else if (info.lastError) lines.push(t('upd.failed', { e: updateError(info.lastError) }));
  else if (when) lines.push(t('upd.last', { when }));
  $('#update-status').textContent = lines.join(' · ');
  $('#update-now').disabled = !!info.busy;
  const a = $('#update-apply');
  a.hidden = !info.pending;
  a.textContent = info.pending ? t('upd.apply', { v: info.pending.version }) : '';
}
async function applyUpdate() {
  await flushSaves();
  invoke('update_restart').catch((e) => toast(t('upd.failed', { e: updateError(e) })));
}
$('#update-now').onclick = () => invoke('update_check').catch(() => {});
$('#update-apply').onclick = applyUpdate;
$('#set-update').addEventListener('change', async () => {
  await write('save_config', { patch: { update: { check: $('#set-update').value } } }).catch(() => {});
  invoke('update_status').then(showUpdate).catch(() => {});
});

// Lets the UI run in a normal browser for quick testing (no Rust side).
function mockTauri() {
  const handlers = {};
  const emit = (ev, payload) => (handlers[ev] || []).forEach((h) => h({ payload }));
  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const all = () => JSON.parse(ls.get('wb-widgets') || '[]');
  const lang = new URLSearchParams(location.search).get('lang') || 'ko';
  window.__mock = { emit, menus: [] };
  return {
    core: {
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        if (window.__mockFail?.has(cmd)) throw new Error('mock failure: ' + cmd);
        switch (cmd) {
          case 'save_config': {
            const merge = (b, p) => { for (const [k, v] of Object.entries(p)) b[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(b[k] && typeof b[k] === 'object' ? b[k] : {}, v) : v; return b; };
            const cfg = merge(JSON.parse(ls.get('wb-config') || 'null') || window.__mockConfig, args.patch);
            ls.set('wb-config', JSON.stringify(cfg));
            return emit('config-changed', cfg);
          }
          case 'set_autostart': ls.set('wb-autostart', args.on ? '1' : ''); return !!args.on;
          case 'set_dwell': case 'set_zoom': case 'set_hotkey': case 'notify':
            (window.__native ||= []).push([cmd, args]); return;
          case 'set_kbd_mode': return emit('kbd-mode', args.on);
          case 'get_all_widgets': return all();
          case 'update_status': {
            const cfg = JSON.parse(ls.get('wb-config') || 'null') || {};
            return { current: '0.11.0', check: cfg.update?.check || 'weekly', configured: !!window.__mockUpdate, lastCheck: null, lastError: null,
              pending: window.__mockUpdate?.pending ?? null, busy: false };
          }
          case 'update_check': {
            const u = window.__mockUpdate;
            if (!u) return emit('update-failed', 'not_configured');
            if (u.found) { u.pending = { version: u.found, notes: u.notes || '' }; emit('update-status', await this.invoke('update_status')); return emit('update-ready', u.pending); }
            return emit('toast', 'upd.latest');
          }
          case 'update_restart': (window.__native ||= []).push([cmd, args]); return;
          case 'replace_widgets': ls.set('wb-widgets', JSON.stringify(args.widgets)); return emit('layout-replaced');
          case 'load_state':
            return {
              autostart: !!ls.get('wb-autostart'),
              display: 'D1', primary: true, lang, widgets: all().filter((w) => !w.display || w.display === 'D1' || !['D1', 'D2'].includes(w.display)), reduceMotion: new URLSearchParams(location.search).has('rm'),
              config: JSON.parse(ls.get('wb-config') || 'null') || (window.__mockConfig = { timer: { presets: [{ label: '', time: '1' }, { label: '라면', time: '3' }, { label: '', time: '1:30' }] }, holidays: { country: 'KR', add: { '2026-10-15': '회사 창립기념일' }, remove: [] } }),
              theme: ls.get('wb-theme') || '', assetsDir: '',
              displays: [{ label: 'board-0', display: 'D1', index: 1, primary: true }, { label: 'board-1', display: 'D2', index: 2, primary: false }],
            };
          case 'put_widget': return ls.set('wb-widgets', JSON.stringify([...all().filter((w) => w.id !== args.widget.id), args.widget]));
          case 'remove_widget': return ls.set('wb-widgets', JSON.stringify(all().filter((w) => w.id !== args.id)));
          case 'move_widget': return ls.set('wb-widgets', JSON.stringify(all().map((w) => (w.id === args.id ? { ...w, display: args.display } : w))));
          case 'save_theme': ls.set('wb-theme', args.css); return setTimeout(() => emit('theme-changed', args.css), 20);
          case 'save_asset': return URL.createObjectURL(new Blob([args]));
          case 'set_edit_mode': return emit('edit-mode', args.on);
          case 'set_hit_rects': window.__hits = args.rects; return;
          case 'store_get': return JSON.parse(ls.get('wb-store-' + args.key) || 'null');
          case 'store_set': ls.set('wb-store-' + args.key, JSON.stringify(args.value)); return emit('store-changed', { key: args.key, src: args.src });
          case 'diary_get': return ls.get('wb-diary-' + args.date) || '';
          case 'diary_set':
            if (args.text.trim()) ls.set('wb-diary-' + args.date, args.text); else localStorage.removeItem('wb-diary-' + args.date);
            return emit('store-changed', { key: 'diary', date: args.date, src: args.src });
          case 'diary_dates': return Object.keys(localStorage).filter((k) => k.startsWith('wb-diary-')).map((k) => k.slice(9)).sort();
          case 'list_assets': return [];
          case 'list_fonts': return ['Malgun Gothic', 'Segoe UI', 'Arial', 'Consolas'];
          case 'media_subscribe': return window.__mockMedia || { has: false };
          case 'media_control': (window.__mockMediaCmds ||= []).push([args.action, args.seconds]); return;
          default: return null;
        }
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ listen: async (ev, h) => {
      (handlers[ev] ||= []).push(h);
      return () => (handlers[ev] = handlers[ev].filter((x) => x !== h));
    } }) },
    menu: { Menu: { new: async ({ items }) => ({ items, popup: async () => window.__mock.menus.push(items), close: async () => {} }) } },
  };
}
