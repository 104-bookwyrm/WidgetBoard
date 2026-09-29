import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = 0, passes = 0;
const ok = (cond, msg, extra='') => { if (cond) passes++; else { fails++; console.log('FAIL:', msg, extra); } };
const errs = [];
async function page(w=1440, h=810, lang='ko') {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => m.type()==='error' && !/404|mock failure/.test(m.text()) && errs.push(m.text()));
  await p.goto(`http://localhost:8765/index.html?lang=${lang}`);
  return p;
}
const layout = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('wb-widgets')||'[]'));
async function invariants(p, label) {
  const r = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const cell = parseFloat(cs.getPropertyValue('--cell')), gap = parseFloat(cs.getPropertyValue('--gap'));
    const b = document.getElementById('board');
    const cols = Math.floor((b.clientWidth - gap)/(cell+gap)), rows = Math.floor((b.clientHeight - gap)/(cell+gap));
    const ws = [...document.querySelectorAll('.widget')].map(e => ({ x:+e.style.getPropertyValue('--x'), y:+e.style.getPropertyValue('--y'), w:+e.style.getPropertyValue('--w'), h:+e.style.getPropertyValue('--h'), t:e.dataset.widget }));
    const ov = []; for (let i=0;i<ws.length;i++) for (let j=i+1;j<ws.length;j++){const a=ws[i],c=ws[j]; if(a.x<c.x+c.w&&c.x<a.x+a.w&&a.y<c.y+c.h&&c.y<a.y+a.h) ov.push([a,c]);}
    const oob = ws.filter(a => a.x<0||a.y<0||a.x+a.w>cols||a.y+a.h>rows);
    return { ov: ov.length, oob: oob.length, n: ws.length, cols, rows };
  });
  ok(r.ov === 0, `${label}: no overlaps`, JSON.stringify(r));
  ok(r.oob === 0, `${label}: all in bounds`, JSON.stringify(r));
  return r;
}
async function seed(p, widgets, extra = {}) {
  await p.evaluate(({widgets, extra}) => { localStorage.clear(); localStorage.setItem('wb-widgets', JSON.stringify(widgets)); for (const [k,v] of Object.entries(extra)) localStorage.setItem(k, typeof v==='string'?v:JSON.stringify(v)); }, {widgets, extra});
  await p.reload(); await p.waitForTimeout(700);
}
const W = (type, i=0) => `.widget[data-widget=${type}] >> nth=${i} >>`;
async function dragHead(p, sel, dxCells, dyCells) {
  const bb = await (await p.$(`${sel} >> .w-head`)).boundingBox();
  await p.mouse.move(bb.x+30, bb.y+8); await p.mouse.down();
  await p.mouse.move(bb.x+30+dxCells*90, bb.y+8+dyCells*90, {steps:10}); await p.mouse.up(); await p.waitForTimeout(450);
}
async function dragResize(p, sel, dw, dh) {
  const bb = await (await p.$(`${sel} >> .w-resize`)).boundingBox();
  await p.mouse.move(bb.x+8, bb.y+8); await p.mouse.down();
  await p.mouse.move(bb.x+8+dw*90, bb.y+8+dh*90, {steps:10}); await p.mouse.up(); await p.waitForTimeout(450);
}
const cls = (p) => p.evaluate(() => [...document.body.classList]);
const native = (p) => p.evaluate(() => window.__native || []);
const openSettings = async (p) => { await p.evaluate(() => window.__mock.emit('open-settings')); await p.waitForTimeout(150); };
const setUi = async (p, key, value) => {
  await p.evaluate(({ key, value }) => {
    const i = document.querySelector(`#settings-panel [data-ui="${key}"]`);
    if (i.type === 'checkbox') i.checked = value; else i.value = value;
    i.dispatchEvent(new Event(i.type === 'range' ? 'input' : 'change'));
  }, { key, value });
  await p.waitForTimeout(350);
};
const menuAction = async (p, id, text) => {
  await p.evaluate(({ id, text }) => {
    document.querySelector(`.widget[data-id="${id}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, { id, text });
  await p.waitForTimeout(80);
  return p.evaluate((text) => { const m = window.__mock.menus.at(-1); const it = m.find((x) => x.text === text); if (!it) return false; it.action(); return true; }, text);
};
const BASE = [
  { id: 'ck', type: 'checklist', x: 0, y: 0, w: 3, h: 4, settings: {} },
  { id: 'tm', type: 'timer', x: 3, y: 0, w: 3, h: 2, settings: {} },
  { id: 'me', type: 'memo', x: 6, y: 0, w: 3, h: 3, settings: { text: '장보기: 우유, 달걀' } },
  { id: 'ca', type: 'calendar', x: 9, y: 0, w: 4, h: 4, settings: {} },
  { id: 'dd', type: 'dday', x: 0, y: 4, w: 3, h: 3, settings: { items: [{ id: 'x', name: '시험', date: '2026-12-01' }] } },
  { id: 'sw', type: 'stopwatch', x: 3, y: 2, w: 3, h: 2, settings: {} },
  { id: 'im', type: 'image', x: 6, y: 3, w: 2, h: 2, settings: {} },
  { id: 'np', type: 'nowplaying', x: 9, y: 4, w: 4, h: 2, settings: {} },
  { id: 'di', type: 'diary', x: 13, y: 0, w: 3, h: 3, settings: {} },
];

// ===== 1. everything new is OFF by default =====
{
  const p = await page();
  await seed(p, BASE);
  const c = await cls(p);
  const banned = ['cvd-safe', 'show-hints', 'short-lines', 'font-atkinson', 'font-lexend', 'font-opendyslexic', 'kbd-mode', 'focus-mode',
    'high-contrast', 'big-targets', 'wide-text', 'show-controls', 'lock-layout', 'header-always', 'header-hidden'];
  ok(!c.some((x) => banned.includes(x)), '1: no opt-in class on a fresh board', c.join(' '));
  ok((await native(p)).length === 0, '1: no dwell/zoom/hotkey sent to Windows by default', JSON.stringify(await native(p)));
  const st = await p.evaluate(() => ({
    frames: [...document.querySelectorAll('.w-frame')].map((f) => f.dataset.kind),
    frameVisible: [...document.querySelectorAll('.w-frame')].some((f) => getComputedStyle(f).display !== 'none'),
    hints: [...document.querySelectorAll('.w-hint')].some((h) => getComputedStyle(h).display !== 'none'),
    bars: ['#flash', '#kbdbar', '#focusbar', '#overview-panel', '#layouts-panel'].map((s) => document.querySelector(s).hidden),
    caps: [...document.querySelectorAll('.t-cap')].every((x) => x.hidden),
    styleVars: [...document.querySelectorAll('.widget')].some((e) => e.style.getPropertyValue('--c2')),
  }));
  ok(st.frames.length === 9 && st.frames.every((k) => k === 'none') && !st.frameVisible, '1: no frames by default', JSON.stringify(st.frames));
  ok(!st.hints, '1: hints hidden by default');
  ok(st.bars.every(Boolean), '1: flash/kbd/focus bars and new panels hidden', JSON.stringify(st.bars));
  ok(st.caps, '1: timer caption hidden');
  ok(!st.styleVars, '1: no per-widget colour overrides by default');
  await openSettings(p);
  const vals = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('#settings-panel [data-ui]')].map((i) => [i.dataset.ui, i.type === 'checkbox' ? i.checked : i.value])));
  const offChecks = ['clickDrag', 'flashAlert', 'notifyAlert', 'soundCaptions', 'cvd', 'showHints', 'shortLines', 'highContrast', 'bigTargets', 'wideText', 'showControls', 'lockLayout'];
  ok(offChecks.every((k) => vals[k] === false), '1: all accessibility checkboxes unchecked', JSON.stringify(vals));
  ok(vals.hotkey === '' && vals.dwellMs === '0' && vals.zoom === '1' && vals.readableFont === 'none' && vals.reminderTime === '' && vals.frame === 'none', '1: selects at off values', JSON.stringify(vals));
  const keysShown = await p.$eval('#settings-panel', (e) => e.innerText.match(/\b(set|look|lay|ov|sum|hint)\.[a-z_.]+/g));
  ok(!keysShown, '1: no raw i18n keys in settings (ko)', String(keysShown));
  await p.screenshot({ path: 'shots/v10-settings-ko.png' });
  // tall panel scrolls instead of running off screen
  const sp = await p.$eval('#settings-panel', (e) => ({ h: e.getBoundingClientRect().bottom, sh: e.scrollHeight, ch: e.clientHeight }));
  ok(sp.h <= 810 && sp.sh > sp.ch, '1: settings panel scrolls within the screen', JSON.stringify(sp));
  await p.close();
}

// ===== 2. each setting switches on and off =====
{
  const p = await page();
  await seed(p, BASE);
  await openSettings(p);
  for (const [k, c] of [['cvd', 'cvd-safe'], ['showHints', 'show-hints'], ['shortLines', 'short-lines']]) {
    await setUi(p, k, true);
    ok((await cls(p)).includes(c), `2: ${k} on → ${c}`);
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('wb-config')).ui);
    ok(saved[k] === true, `2: ${k} saved to config.ui`);
    await setUi(p, k, false);
    ok(!(await cls(p)).includes(c), `2: ${k} off again`);
  }
  await setUi(p, 'showHints', true);
  const hint = await p.$eval('.widget[data-widget=timer] .w-hint', (h) => ({ d: getComputedStyle(h).display, t: h.textContent }));
  ok(hint.d !== 'none' && hint.t.length > 3 && !hint.t.startsWith('hint.'), '2: timer hint visible and translated', JSON.stringify(hint));
  await setUi(p, 'showHints', false);
  await setUi(p, 'cvd', true);
  const hol = await p.evaluate(() => getComputedStyle(document.querySelector('.widget[data-widget=calendar]')).getPropertyValue('--hol'));
  ok(/d55e00|color-mix/i.test(hol) || hol.includes('rgb'), '2: cvd changes --hol', hol);
  const sunDeco = await p.evaluate(() => { const d = document.querySelector('.cal-grid .d.sun'); return d ? getComputedStyle(d).textDecorationLine : 'none?'; });
  ok(sunDeco.includes('underline'), '2: cvd underlines Sundays (shape cue, not only colour)', sunDeco);
  await setUi(p, 'cvd', false);
  await setUi(p, 'readableFont', 'lexend');
  ok((await cls(p)).includes('font-lexend'), '2: readable font class');
  await p.waitForTimeout(400);
  const ff = await p.evaluate(async () => { await document.fonts.ready; return { fam: getComputedStyle(document.querySelector('.widget[data-widget=memo]')).fontFamily, loaded: document.fonts.check('14px Lexend') }; });
  ok(ff.fam.includes('Lexend') && ff.loaded, '2: Lexend applied and bundled font loads', JSON.stringify(ff));
  await setUi(p, 'readableFont', 'none');
  ok(!(await cls(p)).some((c) => c.startsWith('font-')), '2: readable font off');
  await setUi(p, 'shortLines', true);
  const mw = await p.$eval('.memo textarea', (t) => getComputedStyle(t).maxWidth);
  ok(mw !== 'none', '2: short lines limit memo width', mw);
  await setUi(p, 'shortLines', false);
  await setUi(p, 'dwellMs', '800');
  await setUi(p, 'zoom', '1.5');
  await setUi(p, 'hotkey', 'Ctrl+Alt+W');
  const n = await native(p);
  ok(n.some(([c, a]) => c === 'set_dwell' && a.ms === 800), '2: dwell sent', JSON.stringify(n));
  ok(n.some(([c, a]) => c === 'set_zoom' && a.zoom === 1.5), '2: zoom sent as number');
  ok(n.some(([c, a]) => c === 'set_hotkey' && a.accel === 'Ctrl+Alt+W'), '2: hotkey sent');
  await setUi(p, 'dwellMs', '0'); await setUi(p, 'zoom', '1'); await setUi(p, 'hotkey', '');
  const n2 = (await native(p)).slice(-3);
  ok(n2.some(([c, a]) => c === 'set_dwell' && a.ms === 0) && n2.some(([c, a]) => c === 'set_zoom' && a.zoom === 1) && n2.some(([c, a]) => c === 'set_hotkey' && a.accel === ''), '2: turning off resets native side', JSON.stringify(n2));
  const before = (await native(p)).length;
  await setUi(p, 'cvd', true);
  ok((await native(p)).length === before, '2: unrelated change does not resend native settings');
  await setUi(p, 'cvd', false);
  // reminder time accepts HH:MM and clearing
  await setUi(p, 'reminderTime', '18:00');
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem('wb-config')).ui.reminderTime)) === '18:00', '2: reminder time stored as text');
  await setUi(p, 'reminderTime', '');
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem('wb-config')).ui.reminderTime)) === '', '2: reminder time cleared');
  await p.close();
}

// ===== 3. deaf / hard of hearing: timer alerts =====
{
  const p = await page();
  await seed(p, [{ id: 'tm', type: 'timer', x: 0, y: 0, w: 3, h: 3, settings: { duration: 60000, remaining: 1200, endAt: null } }]);
  // all off: only the screen-reader announcement
  await p.click('.widget[data-widget=timer] [data-a=go]');
  await p.waitForTimeout(2200);
  let st = await p.evaluate(() => ({ flash: document.querySelector('#flash').hidden, cap: document.querySelector('.t-cap').hidden, sr: document.querySelector('#sr').textContent, n: (window.__native || []).filter((x) => x[0] === 'notify').length }));
  ok(st.flash && st.cap && st.n === 0, '3: nothing visual/Windows when options are off', JSON.stringify(st));
  ok(/타이머/.test(st.sr), '3: screen reader still hears it', st.sr);
  await p.click('.widget[data-widget=timer] .t-display', { position: { x: 5, y: 5 } }).catch(() => {});
  await p.keyboard.press('Escape');
  await openSettings(p);
  for (const k of ['flashAlert', 'notifyAlert', 'soundCaptions']) await setUi(p, k, true);
  await p.click('#settings-close');
  await p.evaluate(() => { const w = JSON.parse(localStorage.getItem('wb-widgets')); w[0].settings = { duration: 60000, remaining: 1200, endAt: null }; localStorage.setItem('wb-widgets', JSON.stringify(w)); });
  await p.reload(); await p.waitForTimeout(600);
  await p.click('.widget[data-widget=timer] [data-a=go]');
  await p.waitForTimeout(2300);
  st = await p.evaluate(() => ({ flash: document.querySelector('#flash').hidden, ft: document.querySelector('#flash b').textContent, cap: document.querySelector('.t-cap').hidden, ct: document.querySelector('.t-cap').textContent, n: (window.__native || []).filter((x) => x[0] === 'notify') }));
  ok(!st.flash && /타이머/.test(st.ft), '3: screen-edge flash shows the message', JSON.stringify(st));
  ok(!st.cap && /🔔/.test(st.ct), '3: sound caption visible while ringing', st.ct);
  ok(st.n.length === 1 && st.n[0][1].title.includes('타이머'), '3: Windows notification requested', JSON.stringify(st.n));
  await p.screenshot({ path: 'shots/v10-flash.png' });
  const hitsBefore = await p.evaluate(() => window.__hits.length);
  ok(await p.$eval('#flash', (f) => !f.hasAttribute('data-hit') && getComputedStyle(f).pointerEvents === 'none'), '3: flash never blocks clicks');
  await p.click('.widget[data-widget=timer] .timer', { position: { x: 10, y: 60 } });
  await p.waitForTimeout(100);
  ok(await p.$eval('.t-cap', (c) => c.hidden), '3: clicking the timer stops ringing and hides caption');
  await p.close();
  // reduced motion: steady flash
  const p2 = await page(1440, 810);
  await p2.goto('http://localhost:8765/index.html?rm');
  await seed(p2, [{ id: 'tm', type: 'timer', x: 0, y: 0, w: 3, h: 3, settings: { duration: 60000, remaining: 800, endAt: null } }], { 'wb-config': { ui: { flashAlert: true } } });
  await p2.click('.widget[data-widget=timer] [data-a=go]');
  await p2.waitForTimeout(1600);
  ok(await p2.$eval('#flash', (f) => !f.hidden && f.classList.contains('steady') && getComputedStyle(f).animationName === 'none'), '3: reduced motion → flash does not blink');
  await p2.close();
}

// ===== 4. summaries, overview, focus mode, keyboard mode =====
{
  const p = await page();
  await p.evaluate(() => localStorage.setItem('wb-store-checklist', JSON.stringify([])));
  const today = await p.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await seed(p, BASE, { 'wb-store-events': [{ id: 'e1', date: today, title: '회의', time: '10:00', tags: [] }], 'wb-store-checklist': [{ id: 'c1', title: '보고서', date: today, done: false, repeat: null }] });
  const sums = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.widget')].map((e) => [e.dataset.widget, null])));
  for (const id of BASE.map((w) => w.id)) {
    await p.focus(`.widget[data-id="${id}"] .grip`);
    await p.keyboard.press('s');
    await p.waitForTimeout(60);
    const txt = await p.$eval('#toast', (e) => e.textContent);
    const type = BASE.find((w) => w.id === id).type;
    sums[type] = txt;
    ok(txt.length > 4 && !/\b(sum|hint)\.[a-z_]+/.test(txt), `4: summary for ${type}`, txt);
  }
  ok(/보고서/.test(sums.checklist) && /1개 중 0개|2개 중 0개/.test(sums.checklist), '4: checklist summary lists what is left', sums.checklist);
  ok(/회의/.test(sums.calendar), '4: calendar summary has today\'s event', sums.calendar);
  ok(/시험 D-/.test(sums.dday), '4: dday summary', sums.dday);
  ok(/우유/.test(sums.memo), '4: memo summary has the text', sums.memo);
  ok(/5:00|05:00/.test(sums.timer), '4: timer summary', sums.timer);
  // overview
  await openSettings(p);
  await p.click('#settings-overview');
  const ov = await p.$$eval('#overview-list li', (l) => l.map((x) => x.textContent));
  ok(ov.length === 9 && ov.some((x) => /우유/.test(x)), '4: overview lists every widget with its summary', ov.length);
  ok(await p.evaluate(() => document.activeElement.closest('#overview-list') !== null), '4: overview focuses the first entry');
  await p.click('#overview-list [data-goto="me"]');
  ok(await p.evaluate(() => document.activeElement.closest('.widget')?.dataset.id === 'me' && document.activeElement.classList.contains('grip')), '4: overview jumps to the widget');
  await p.keyboard.press('Escape'); // closes settings
  // focus mode
  const hits0 = await p.evaluate(() => window.__hits.length);
  ok(await menuAction(p, 'me', '이 위젯에만 집중'), '4: focus entry in menu');
  await p.waitForTimeout(250);
  const f = await p.evaluate(() => ({ vis: [...document.querySelectorAll('.widget')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.dataset.id), bar: !document.querySelector('#focusbar').hidden, hits: window.__hits.length }));
  ok(f.vis.length === 1 && f.vis[0] === 'me' && f.bar, '4: focus mode shows one widget + exit bar', JSON.stringify(f));
  ok(f.hits < hits0, '4: hidden widgets stop catching clicks', `${hits0} -> ${f.hits}`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(100);
  ok(await p.evaluate(() => [...document.querySelectorAll('.widget')].every((e) => getComputedStyle(e).display !== 'none') && document.querySelector('#focusbar').hidden), '4: Esc leaves focus mode');
  // keyboard mode (global shortcut → Rust emits kbd-mode)
  await p.evaluate(() => document.activeElement.blur());
  await p.evaluate(() => window.__mock.emit('kbd-mode', true));
  await p.waitForTimeout(200);
  ok((await cls(p)).includes('kbd-mode') && !(await p.$eval('#kbdbar', (e) => e.hidden)), '4: keyboard mode bar shown');
  ok(await p.evaluate(() => document.activeElement.classList.contains('grip')), '4: keyboard mode focuses the first widget');
  await p.keyboard.press('l');
  ok(!(await p.$eval('#overview-panel', (e) => e.hidden)), '4: L opens the overview');
  await p.keyboard.press('Escape');
  ok(await p.$eval('#overview-panel', (e) => e.hidden) && (await cls(p)).includes('kbd-mode'), '4: first Esc closes the overview only');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(100);
  ok(!(await cls(p)).includes('kbd-mode'), '4: second Esc leaves keyboard mode');
  // L outside keyboard mode does nothing (typing!)
  await p.focus('.memo textarea');
  await p.keyboard.type('L');
  ok(await p.$eval('#overview-panel', (e) => e.hidden), '4: L while typing is just a letter');
  await p.close();
}

// ===== 5. click-to-carry (motor) =====
{
  const p = await page();
  await seed(p, [{ id: 'tm', type: 'timer', x: 0, y: 0, w: 3, h: 2, settings: {} }], { 'wb-config': { ui: { clickDrag: true } } });
  const bb = await (await p.$('.widget[data-id=tm] .w-head')).boundingBox();
  await p.mouse.click(bb.x + 40, bb.y + 8);
  await p.waitForTimeout(100);
  ok(await p.$eval('.widget[data-id=tm]', (e) => e.classList.contains('moving')), '5: one click picks the widget up');
  await p.mouse.move(bb.x + 40 + 3 * 90, bb.y + 8 + 2 * 90, { steps: 5 });
  await p.mouse.click(bb.x + 40 + 3 * 90, bb.y + 8 + 2 * 90);
  await p.waitForTimeout(500);
  let L = await layout(p);
  ok(L[0].x === 3 && L[0].y === 2, '5: second click drops it', JSON.stringify(L[0]));
  await p.mouse.click(bb.x + 40 + 3 * 90, bb.y + 8 + 2 * 90);
  await p.mouse.move(bb.x + 40 + 6 * 90, bb.y + 8 + 2 * 90, { steps: 5 });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  L = await layout(p);
  ok(L[0].x === 3 && L[0].y === 2 && !(await p.$eval('.widget[data-id=tm]', (e) => e.classList.contains('moving'))), '5: Esc cancels a carry', JSON.stringify(L[0]));
  await p.close();
}

// ===== 6. reminder at a set time (clock) =====
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-09-26T17:59:30') });
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{ id: 'ck', type: 'checklist', x: 0, y: 0, w: 3, h: 4, settings: {} }], {
    'wb-config': { ui: { reminderTime: '18:00', notifyAlert: true } },
    'wb-store-checklist': [{ id: 'a', title: 'A', date: '2026-09-26', done: false, repeat: null }, { id: 'b', title: 'B', date: '2026-09-20', done: false, repeat: null }, { id: 'c', title: 'C', date: '2026-09-26', done: true, repeat: null }, { id: 'd', title: 'D', repeat: 'daily', doneKeys: ['2026-09-26'] }],
  });
  await p.clock.fastForward('00:25');
  await p.waitForTimeout(200);
  ok(!/남은 할 일/.test(await p.$eval('#toast', (e) => (e.hidden ? '' : e.textContent))), '6: no reminder before the time');
  await p.clock.fastForward('00:25');
  await p.waitForTimeout(300);
  const t1 = await p.$eval('#toast', (e) => e.textContent);
  ok(/남은 할 일 2개/.test(t1), '6: reminder counts today\'s open + carried tasks (done & daily-done skipped)', t1);
  ok((await native(p)).some(([c, a]) => c === 'notify' && /2개/.test(a.body)), '6: reminder also a Windows notification (opted in)');
  const cnt = (await native(p)).filter(([c]) => c === 'notify').length;
  await p.clock.fastForward('00:40');
  ok((await native(p)).filter(([c]) => c === 'notify').length === cnt, '6: only once a day');
  await p.close();
}

// ===== 7. per-widget colours & frames =====
{
  const p = await page();
  await seed(p, BASE);
  ok(await menuAction(p, 'tm', '모양 (글꼴·색·테두리)…'), '7: appearance entry in menu');
  await p.waitForTimeout(150);
  ok(!(await p.$eval('#font-panel', (e) => e.hidden)), '7: appearance panel opens');
  ok(await p.$eval('#font-panel [data-col=c2]', (l) => l.classList.contains('unset')), '7: colours start unset (follow theme)');
  await p.$eval('#font-panel [data-col=c2] input', (i) => { i.value = '#ff8800'; i.dispatchEvent(new Event('input')); });
  await p.$eval('#font-panel [data-col=opacity] input', (i) => { i.value = '0.5'; i.dispatchEvent(new Event('input')); });
  await p.waitForTimeout(400);
  let st = await p.$eval('.widget[data-id=tm]', (e) => ({ c2: e.style.getPropertyValue('--c2'), on: e.style.getPropertyValue('--on-accent'), op: e.style.getPropertyValue('--widget-opacity'), btn: getComputedStyle(e.querySelector('button.primary')).backgroundColor }));
  ok(st.c2 === '#ff8800' && st.btn === 'rgb(255, 136, 0)', '7: accent applies to this widget only', JSON.stringify(st));
  ok(st.on === '#111111', '7: text on accent picked for contrast (dark on orange)', st.on);
  ok(st.op === '0.5', '7: per-widget opacity');
  const other = await p.$eval('.widget[data-id=sw] button.primary', (b) => getComputedStyle(b).backgroundColor);
  ok(other !== 'rgb(255, 136, 0)', '7: other widgets untouched', other);
  let L = await layout(p);
  ok(L.find((w) => w.id === 'tm').colors?.c2 === '#ff8800', '7: colours saved with the widget');
  await p.$eval('#fp-frame', (s) => { s.value = 'pixel'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(350);
  ok(await p.$eval('.widget[data-id=tm] .w-frame', (f) => f.dataset.kind === 'pixel' && getComputedStyle(f).display !== 'none' && getComputedStyle(f).webkitMaskBoxImageSource.startsWith('url(')), '7: pixel frame drawn via SVG mask');
  await p.reload(); await p.waitForTimeout(600);
  ok(await p.$eval('.widget[data-id=tm]', (e) => e.style.getPropertyValue('--c2') === '#ff8800' && e.querySelector('.w-frame').dataset.kind === 'pixel'), '7: colours + frame survive restart');
  // settings default frame applies to widgets without their own
  await openSettings(p);
  await setUi(p, 'frame', 'corners');
  const kinds = await p.$$eval('.w-frame', (fs) => Object.fromEntries(fs.map((f) => [f.closest('.widget').dataset.id, f.dataset.kind])));
  ok(kinds.tm === 'pixel' && kinds.me === 'corners' && kinds.ca === 'corners', '7: default frame for all, own frame wins', JSON.stringify(kinds));
  await p.click('#settings-close');
  // showcase every frame for a visual check
  const frames = ['corners', 'double', 'stitch', 'dots', 'ornate', 'pixel', 'tape'];
  await seed(p, frames.map((f, i) => ({ id: 'f' + i, type: 'memo', x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3, frame: f, settings: { text: f } })).concat([{ id: 'hx', type: 'memo', x: 9, y: 3, w: 3, h: 3, frame: 'corners', colors: { frame: '#ff0000', c1: '#202830' }, settings: { text: 'colours' } }]));
  await p.screenshot({ path: 'shots/v10-frames.png' });
  // frame pixels really drawn (corner of widget is frame-coloured, centre is not)
  const px = await p.evaluate(() => { const f = document.querySelector('[data-id=hx] .w-frame'); const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const shot = await p.screenshot({ clip: { x: px.x, y: px.y, width: px.w, height: px.h } });
  const { PNG } = await import('pngjs');
  const img = PNG.sync.read(shot);
  const at = (x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const red = (c) => c[0] > 150 && c[1] < 90 && c[2] < 90;
  let cornerRed = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (red(at(x, y))) cornerRed++;
  let midRed = 0; for (let y = 60; y < 80; y++) for (let x = 60; x < 80; x++) if (red(at(x, y))) midRed++;
  ok(cornerRed > 20 && midRed === 0, '7: frame drawn at the corner in its own colour, centre clear', `${cornerRed}/${midRed}`);
  // custom SVG upload
  await menuAction(p, 'hx', '모양 (글꼴·색·테두리)…');
  await p.waitForTimeout(150);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><rect x="1" y="1" width="28" height="28" fill="none" stroke="#000" stroke-width="4"/></svg>';
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#fp-svg')]);
  await fc.setFiles({ name: 'my.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await p.waitForTimeout(400);
  const cu = await p.$eval('[data-id=hx] .w-frame', (f) => ({ k: f.dataset.kind, m: getComputedStyle(f).webkitMaskBoxImageSource.slice(0, 40) }));
  ok(cu.k === 'custom' && cu.m.includes('data:image/svg+xml'), '7: custom SVG frame applied', JSON.stringify(cu));
  ok(await p.$eval('#fp-frame', (s) => s.value === 'custom') && await p.$eval('#file-picker', (i) => i.accept === 'image/*'), '7: picker restored to images after SVG');
  const [fc2] = await Promise.all([p.waitForEvent('filechooser'), p.click('#fp-svg')]);
  await fc2.setFiles({ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('hello not svg') });
  await p.waitForTimeout(300);
  ok(/SVG/.test(await p.$eval('#toast', (e) => e.textContent)), '7: non-SVG rejected with a message');
  await p.click('#fp-reset');
  await p.waitForTimeout(350);
  L = await layout(p);
  const hx = L.find((w) => w.id === 'hx');
  ok(!hx.colors && !hx.frame && !hx.frameSvg, '7: reset all clears colours and frame', JSON.stringify(hx));
  // hostile saved values
  await seed(p, [{ id: 'z', type: 'memo', x: 0, y: 0, w: 3, h: 3, frame: 'javascript:x', frameSvg: 'http://evil/x.svg', colors: { c1: 'red;}body{display:none', c2: '#12345', opacity: 7 }, settings: {} }]);
  const z = await p.$eval('[data-id=z]', (e) => ({ c1: e.style.getPropertyValue('--c1'), c2: e.style.getPropertyValue('--c2'), op: e.style.getPropertyValue('--widget-opacity'), k: e.querySelector('.w-frame').dataset.kind }));
  ok(!z.c1 && !z.c2 && !z.op && z.k === 'none', '7: bad colour / frame values ignored', JSON.stringify(z));
  await p.close();
}

// ===== 8. layouts: presets + saved =====
{
  const p = await page();
  await seed(p, [
    { id: 'me', type: 'memo', x: 0, y: 0, w: 3, h: 3, settings: { text: '내 메모 그대로' } },
    { id: 'im', type: 'image', x: 3, y: 0, w: 2, h: 2, settings: {} },
    { id: 'far', type: 'memo', display: 'D2', x: 0, y: 0, w: 3, h: 3, settings: { text: 'other monitor' } },
  ]);
  await p.evaluate(() => window.__mock.emit('open-layouts'));
  await p.waitForTimeout(200);
  ok(!(await p.$eval('#layouts-panel', (e) => e.hidden)), '8: layouts panel opens from tray');
  ok(/아직/.test(await p.$eval('#layout-list', (e) => e.textContent)), '8: empty saved list says so');
  await p.screenshot({ path: 'shots/v10-layouts.png' });
  await p.click('[data-preset=work]');
  await p.waitForTimeout(1200);
  let L = await layout(p);
  const types = L.filter((w) => w.display === 'D1').map((w) => w.type).sort();
  ok(JSON.stringify(types) === JSON.stringify(['calendar', 'checklist', 'dday', 'memo', 'nowplaying', 'timer']), '8: work preset widgets', types.join(','));
  ok(L.find((w) => w.id === 'me')?.settings.text === '내 메모 그대로', '8: existing memo reused with its text');
  ok(!L.some((w) => w.id === 'im'), '8: widget not in the preset put away');
  ok(L.some((w) => w.id === 'far' && w.display === 'D2'), '8: other monitor untouched');
  ok(L.find((w) => w.type === 'calendar').settings.view === 'board', '8: work calendar uses the big squares');
  await invariants(p, '8 work');
  const right = await p.evaluate(() => { const b = document.getElementById('board').getBoundingClientRect(); return [...document.querySelectorAll('.widget')].some((e) => b.right - e.getBoundingClientRect().right < 100); });
  ok(right, '8: preset hugs the right edge (desktop icons stay free)');
  const tt = await p.$eval('#toast', (e) => e.textContent);
  ok(/업무용/.test(tt) && /되돌리기/.test(tt), '8: after reload: applied toast with undo', tt);
  await p.screenshot({ path: 'shots/v10-work.png' });
  await p.click('#toast button');
  await p.waitForTimeout(1200);
  L = await layout(p);
  ok(L.some((w) => w.id === 'im') && L.length === 3, '8: undo restores the previous board', L.map((w) => w.type).join(','));
  // save → change → apply
  await p.evaluate(() => window.__mock.emit('open-layouts'));
  await p.waitForTimeout(200);
  await p.fill('#layout-name', '내 책상');
  await p.click('#layout-save');
  await p.waitForTimeout(300);
  ok(/내 책상/.test(await p.$eval('#layout-list', (e) => e.textContent)), '8: saved layout listed');
  // write in the memo AFTER saving, then switch to study (memo put away) and back: the new text must survive
  await p.keyboard.press('Escape');
  await p.fill('.memo textarea', '새로 쓴 내용');
  await p.evaluate(() => document.activeElement.blur());
  await p.waitForTimeout(500);
  await p.evaluate(() => window.__mock.emit('open-layouts'));
  await p.waitForTimeout(200);
  await p.click('[data-preset=study]');
  await p.waitForTimeout(1200);
  L = await layout(p);
  ok(L.filter((w) => w.display === 'D1').length === 6 && L.some((w) => w.type === 'stopwatch') && !L.some((w) => w.id === 'me'), '8: study preset (memo put away)', L.map((w) => w.type).join(','));
  await invariants(p, '8 study');
  const L0study = { timer: L.find((w) => w.type === 'timer').id };
  // study → work: the shelved memo comes back instead of a blank one
  await p.evaluate(() => window.__mock.emit('open-layouts'));
  await p.waitForTimeout(200);
  await p.click('[data-preset=work]');
  await p.waitForTimeout(1200);
  L = await layout(p);
  ok(L.find((w) => w.type === 'memo' && w.display === 'D1')?.id === 'me' && L.find((w) => w.type === 'memo' && w.display === 'D1').settings.text === '새로 쓴 내용', '8: switching presets brings the same memo back', JSON.stringify(L.find((w) => w.type === 'memo')?.settings));
  ok(L.find((w) => w.type === 'timer')?.id === L0study.timer, '8: …and the same timer from study', '');
  await p.evaluate(() => window.__mock.emit('open-layouts'));
  await p.waitForTimeout(250);
  await p.click('#layout-list [data-apply="0"]');
  await p.waitForTimeout(1200);
  L = await layout(p);
  const me = L.find((w) => w.id === 'me');
  ok(me && me.x === 0 && me.y === 0 && me.w === 3 && L.some((w) => w.id === 'im'), '8: saved layout restores positions and put-away widgets', JSON.stringify(me));
  ok(me?.settings.text === '새로 쓴 내용', '8: …but keeps the memo text written since', me?.settings.text);
  // delete with undo
  await p.evaluate(() => window.__mock.emit('open-layouts'));
  await p.waitForTimeout(250);
  await p.click('#layout-list [data-del="0"]');
  await p.waitForTimeout(250);
  ok(/아직/.test(await p.$eval('#layout-list', (e) => e.textContent)), '8: layout deleted');
  await p.click('#toast button');
  await p.waitForTimeout(300);
  ok(/내 책상/.test(await p.$eval('#layout-list', (e) => e.textContent)), '8: delete undone');
  ok(!(await p.$eval('#layout-undo', (e) => e.hidden)), '8: undo button available in the panel');
  await p.keyboard.press('Escape');
  ok(await p.$eval('#layouts-panel', (e) => e.hidden), '8: Esc closes layouts');
  await p.close();
  // tiny screen: preset drops what doesn't fit, still no overlaps
  const s = await page(800, 560);
  await seed(s, []);
  await s.evaluate(() => window.__mock.emit('open-layouts'));
  await s.waitForTimeout(200);
  await s.click('[data-preset=study]');
  await s.waitForTimeout(1200);
  await invariants(s, '8 small study');
  ok((await layout(s)).length >= 2, '8: small screen still gets a usable layout', (await layout(s)).length);
  await s.close();
}

// ===== 9. English: no raw keys anywhere new =====
{
  const p = await page(1440, 900, 'en');
  await seed(p, BASE, { 'wb-config': { ui: { showHints: true } } });
  await openSettings(p);
  const txt = await p.evaluate(() => ['#settings-panel', '#font-panel', '#layouts-panel', '#overview-panel', '#kbdbar', '#focusbar'].map((s) => document.querySelector(s).innerText + document.querySelector(s).textContent).join('\n') + [...document.querySelectorAll('.w-hint, [title]')].map((e) => e.textContent + e.title).join('\n'));
  const raw = txt.match(/\b(set|look|lay|ov|sum|hint|focus|kbd|menu|a11y|timer)\.[a-z_.]+\b/g);
  ok(!raw, '9: no raw keys in English UI', String(raw));
  await p.screenshot({ path: 'shots/v10-settings-en.png' });
  await p.close();
}

console.log(`\n${passes} passed, ${fails} failed`);
console.log('page errors:', JSON.stringify(errs));
await b.close();
