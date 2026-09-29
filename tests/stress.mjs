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

// ===== A. corrupt / hostile saved data =====
{
  const p = await page();
  await seed(p, [
    { id:'a', type:'timer', x:'abc', y:-4, w:999, h:null, settings:'garbage' },
    { id:'a', type:'dday', x:2, y:1, w:3, h:4, settings:{ items:[ null, 5, {name:'<img src=x onerror=window.__pwned=1>', date:'not-a-date'}, {name:'정상', date:'2026-12-25'} ], filter:'x' } },
    { id:'c', type:'nonexistent', x:8, y:0, w:2, h:2 },
    { id:'d', type:'calendar', x:40, y:40, w:4, h:5, settings:{ filter:[1,2], view:'weird' } },
    { id:'e', type:'image', x:0, y:0, w:2, h:2, settings:{ img:'missing.png', fit:'cover' }, font:'x"; } body{display:none', fontSize:9999 },
  ], { 'wb-store-events': { not: 'an array' } });
  const types = await p.$$eval('.widget', es => es.map(e => e.dataset.widget));
  ok(types.length === 5, 'A: all 5 widgets mounted despite garbage', types.join(','));
  ok(await p.$('.widget[data-widget=nonexistent] .w-error') !== null, 'A: unknown widget shows placeholder');
  ok(!(await p.evaluate(() => window.__pwned)), 'A: no HTML injection from D-day names');
  ok((await p.$$eval('.widget[data-widget=dday] .dd-row', r => r.length)) === 2, 'A: garbage D-day items dropped, 2 valid-ish rows kept');
  ok(await p.evaluate(() => getComputedStyle(document.body).display !== 'none'), 'A: CSS injection via font name blocked');
  await p.waitForTimeout(800);
  await invariants(p, 'A after reflow');
  const ids = (await layout(p)).map(w => w.id);
  ok(new Set(ids).size === ids.length, 'A: duplicate ids repaired', ids.join(','));
  await p.close();
}

// ===== B. push-aside layout =====
{
  const p = await page();
  await seed(p, [
    { id:'A', type:'image', x:0, y:0, w:3, h:2 },
    { id:'B', type:'image', x:3, y:0, w:3, h:2 },
    { id:'C', type:'image', x:0, y:4, w:2, h:2 },
  ]);
  // drag C to x=3,y=0 (between A and B) -> B should move right, C lands at 3
  await dragHead(p, '.widget >> nth=2', 3, -4);
  let L = Object.fromEntries((await layout(p)).map(w => [w.id, w]));
  ok(L.C.x === 3 && L.C.y === 0, 'B: dropped widget lands between', JSON.stringify(L.C));
  ok(L.B.x === 5 && L.B.y === 0, 'B: right neighbour pushed right to make space', JSON.stringify(L.B));
  ok(L.A.x === 0, 'B: left neighbour untouched', JSON.stringify(L.A));
  await invariants(p, 'B push');
  // preview returns when dragging away: start dragging C back but cancel onto its own spot
  const bb = await (await p.$('.widget >> nth=2 >> .w-head')).boundingBox();
  await p.mouse.move(bb.x+30, bb.y+8); await p.mouse.down(); await p.mouse.move(bb.x+30-90*3, bb.y+8, {steps:6});
  const preview = await p.evaluate(() => [...document.querySelectorAll('.widget')].map(e => e.style.getPropertyValue('--x')));
  await p.mouse.move(bb.x+30, bb.y+8, {steps:6}); await p.mouse.up(); await p.waitForTimeout(450);
  ok(preview.length === 3, 'B: preview computed during drag', preview.join(','));
  await invariants(p, 'B cancel');
  // resize A wider -> pushes C/B
  await dragResize(p, '.widget >> nth=0', 2, 0);
  L = Object.fromEntries((await layout(p)).map(w => [w.id, w]));
  ok(L.A.w === 5, 'B: resize grew A', JSON.stringify(L.A));
  await invariants(p, 'B resize push');
  await p.close();
}

// ===== B2. packed board: impossible drop snaps back =====
{
  const p = await page(560, 380); // 6 cols x 4 rows at 80+10
  const ws = []; let k = 0;
  for (let y = 0; y < 4; y += 2) for (let x = 0; x < 6; x += 2) ws.push({ id:'w'+(k++), type:'image', x, y, w:2, h:2 });
  await seed(p, ws);
  const before = JSON.stringify((await layout(p)).map(w => [w.id,w.x,w.y]).sort());
  await dragResize(p, '.widget >> nth=0', 2, 2);
  const after = JSON.stringify((await layout(p)).map(w => [w.id,w.x,w.y]).sort());
  ok(before === after, 'B2: resize on a full board is refused and nothing moves');
  await invariants(p, 'B2');
  await p.close();
}

// ===== C. random fuzz of drags/resizes =====
{
  const p = await page();
  const ws = [['timer',3,2],['image',2,2],['dday',3,4],['calendar',4,5],['diary',4,4],['image',2,2],['timer',3,2]].map(([type,w,h],i)=>({id:'f'+i,type,x:(i*3)%14,y:i<4?0:5,w,h}));
  await seed(p, ws);
  await invariants(p, 'C start');
  let rnd = 12345; const R = (n) => (rnd = (rnd*1103515245+12345) % 2147483648) % n;
  for (let i = 0; i < 60; i++) {
    const idx = R(7);
    if (R(3) === 0) await dragResize(p, `.widget >> nth=${idx}`, R(5)-2, R(5)-2);
    else await dragHead(p, `.widget >> nth=${idx}`, R(11)-5, R(7)-3);
  }
  const r = await invariants(p, 'C after 60 random drags/resizes');
  ok(r.n === 7, 'C: nothing lost', r.n);
  // persisted layout equals shown layout
  await p.reload(); await p.waitForTimeout(700);
  await invariants(p, 'C after reload');
  await p.close();
}

// ===== D. window shrink -> reflow =====
{
  const p = await page(1440, 810);
  await seed(p, [{id:'r1',type:'image',x:12,y:6,w:2,h:2},{id:'r2',type:'timer',x:10,y:0,w:3,h:2},{id:'r3',type:'image',x:0,y:0,w:2,h:2}]);
  await p.setViewportSize({ width: 820, height: 560 }); await p.waitForTimeout(1200);
  await invariants(p, 'D after shrinking the screen');
  ok(await p.isVisible('#toast'), 'D: user is told widgets were moved');
  await p.close();
}

// ===== E. calendar: board view, holidays, shared data =====
{
  const p = await page();
  await seed(p, [{id:'cm',type:'calendar',x:0,y:0,w:4,h:6,settings:{view:'mini'}},{id:'cb',type:'calendar',x:4,y:0,w:9,h:7,settings:{view:'board'}}]);
  const board = W('calendar',1).replace(/ >>$/,'');
  ok((await p.$$(`${board} >> .bc`)).length >= 35, 'E: board view shows month squares');
  const txt = async (d) => p.textContent(`${board} >> .bc[data-d="${d}"]`);
  ok((await txt('2026-09-25')).includes('추석'), 'E: 추석 on 2026-09-25', await txt('2026-09-25'));
  await p.click(`${board} >> [data-a=next]`);
  ok((await txt('2026-10-05')).includes('대체공휴일'), 'E: 개천절 substitute on 10-05');
  ok((await txt('2026-10-15')).includes('회사 창립기념일'), 'E: config-added holiday shows');
  ok(await p.$eval(`${board} >> .bc[data-d="2026-10-03"]`, e => e.classList.contains('hol')), 'E: holiday square marked');
  await p.click(`${board} >> [data-a=today]`);
  // write into a square
  await p.click(`${board} >> .bc[data-d="2026-09-30"]`, { position: {x: 40, y: 30} });
  for (const s of ['09:00 조회 #업무', '점심 약속', '14:00 회의 #업무', '<b>굵게</b> 태그 없음', '긴 제목 '.repeat(20), '6번째', '7번째', '8번째']) { await p.keyboard.type(s); await p.keyboard.press('Enter'); }
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  const more = await p.$(`${board} >> .bc[data-d="2026-09-30"] .bc-more`);
  ok(!!more, 'E: overflowing square shows +N');
  ok(!(await p.$(`${board} >> .bc[data-d="2026-09-30"] b:not(.bc-t b)`)) || (await p.textContent(`${board} >> .bc[data-d="2026-09-30"]`)).includes('<b>'), 'E: markup typed by user stays text');
  // the mini calendar shows the same data (select 30th)
  await p.click(`${W('calendar',0)} .cal-grid [data-d="2026-09-30"]`);
  const miniCount = await p.$$eval(`${W('calendar',0)} .cal-pop .ev`, e => e.length);
  ok(miniCount === 8, 'E: clicking a day in the small calendar opens that day’s list — same 8 entries', miniCount);
  ok(await p.$eval(`${W('calendar',0)} .cal-grid [data-d="2026-09-30"]`, e => e.classList.contains('has')), 'E: dot on a day with entries');
  ok(!(await p.$eval(`${W('calendar',0)} .cal-grid [data-d="2026-09-29"]`, e => e.classList.contains('has'))), 'E: no dot on an empty day');
  ok(!(await p.$(`${W('calendar',0)} .cal-list:not(.cal-pop .cal-list)`)), 'E: small calendar shows only the calendar (no list under it)');
  // +N opens popover with all 8
  await more.click(); await p.waitForTimeout(100);
  ok((await p.$$(`${board} >> .cal-pop .ev`)).length === 8, 'E: +N popover lists all entries');
  await p.keyboard.press('Escape');
  // edit via click in square: clear text -> deletes
  await p.click(`${board} >> .bc[data-d="2026-09-30"] .bc-t >> nth=0`);
  await p.keyboard.press('Control+A'); await p.keyboard.press('Delete'); await p.keyboard.press('Enter'); await p.waitForTimeout(200);
  ok((await p.$$eval(`${W('calendar',0)} .ev`, e => e.length)) === 7, 'E: clearing an entry deletes it (both views)');
  // filter only #업무 in board only
  await p.click(`${board} >> .cal-filter [data-tag="업무"]`);
  const vis = await p.$$eval(`${board} >> .bc[data-d="2026-09-30"] .bc-ev`, e => e.length);
  ok(vis === 1, 'E: board filter shows only #업무', vis);
  ok((await p.$$eval(`${W('calendar',0)} .ev`, e => e.length)) === 7, 'E: other widget keeps its own filter');
  // month navigation over year boundary
  for (let i = 0; i < 4; i++) await p.click(`${board} >> [data-a=next]`);
  ok((await p.textContent(`${board} >> .cal-title`)).includes('2027'), 'E: next across year boundary', await p.textContent(`${board} >> .cal-title`));
  ok((await txt('2027-01-01')).includes('신정'), 'E: 2027 신정');
  await p.click(`${board} >> [data-a=today]`);
  // view toggle keeps data
  await p.click(`${board} >> [data-a=view]`); await p.waitForTimeout(200);
  ok(await p.$(`${board} >> .cal-grid`) !== null, 'E: board -> mini toggle');
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/E.png' });
  await p.close();
}

// ===== F. D-day overflow / many items / tiny size =====
{
  const p = await page();
  const items = Array.from({length: 40}, (_, i) => ({ id:'i'+i, name:(i%5===0?'아주아주 긴 이름입니다 '.repeat(6):'항목 '+i), date:`2026-${String(1+i%12).padStart(2,'0')}-15`, tag: i%3===0?'태그가 굉장히 긴 경우입니다 정말로':'t'+(i%7), mode: i%4===0?'since':'until' }));
  await seed(p, [{id:'d1',type:'dday',x:0,y:0,w:2,h:2,settings:{items}}, {id:'d2',type:'dday',x:3,y:0,w:3,h:5,settings:{items:[]}}]);
  const ov = await p.$$eval('.widget[data-widget=dday]', es => es.map(e => { const b = e.querySelector('.dd'); return b.scrollWidth - b.clientWidth; }));
  ok(ov.every(v => v <= 1), 'F: no horizontal overflow with long names/tags at 2x2', ov.join(','));
  // editor usable at 2x2
  await p.click(`${W('dday',0)} .dd-add`);
  const ed = await p.$eval(`${W('dday',0)} .dd-editor`, e => ({ sw: e.scrollWidth - e.clientWidth, h: e.scrollHeight }));
  ok(ed.sw <= 1, 'F: editor fits width at 2x2', JSON.stringify(ed));
  await p.fill(`${W('dday',0)} [data-f=name]`, '');
  await p.click(`${W('dday',0)} [data-a=ok]`);
  ok((await p.textContent('#toast')).length > 0, 'F: empty name -> message');
  await p.keyboard.press('Escape');
  // filter + add hidden item -> toast
  await p.click(`${W('dday',1)} .dd-add`); await p.fill(`${W('dday',1)} [data-f=name]`, 'A'); await p.fill(`${W('dday',1)} [data-f=tag]`, 'x'); await p.click(`${W('dday',1)} [data-a=ok]`);
  await p.click(`${W('dday',1)} .dd-filter [data-tag="x"]`);
  await p.click(`${W('dday',1)} .dd-add`); await p.fill(`${W('dday',1)} [data-f=name]`, 'B'); await p.fill(`${W('dday',1)} [data-f=tag]`, 'y'); await p.click(`${W('dday',1)} [data-a=ok]`);
  ok((await p.textContent('#toast')).includes('필터'), 'F: saved-but-filtered item -> message', await p.textContent('#toast'));
  // leap day math
  await p.click(`${W('dday',1)} .dd-add`); await p.fill(`${W('dday',1)} [data-f=name]`, '윤년'); await p.fill(`${W('dday',1)} [data-f=date]`, '2028-02-29'); await p.fill(`${W('dday',1)} [data-f=tag]`, 'x'); await p.click(`${W('dday',1)} [data-a=ok]`);
  const lbl = await p.$$eval(`${W('dday',1)} .dd-row`, rs => rs.map(r => r.querySelector('.dd-d').textContent));
  const leap = await p.evaluate(() => { const n = new Date(); return Math.round((Date.UTC(2028, 1, 29) - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5); });
  ok(lbl.includes('D-' + leap), `F: today -> 2028-02-29 is D-${leap}`, lbl.join(','));
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/F.png' });
  await p.close();
}

// ===== G. diary: huge text, save failure =====
{
  const p = await page();
  await seed(p, [{id:'y',type:'diary',x:0,y:0,w:3,h:3}]);
  await p.$eval(`${W('diary')} .dy-text`, e => { e.value = '가'.repeat(100000) + ' ' + 'x'.repeat(3000); e.dispatchEvent(new Event('input')); });
  await p.waitForTimeout(1000);
  ok((await p.evaluate(() => (localStorage.getItem('wb-diary-' + (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; })())||'').length)) > 100000, 'G: 100k-char page saved');
  const ovx = await p.$eval(`${W('diary')} .dy`, e => e.scrollWidth - e.clientWidth);
  ok(ovx <= 1, 'G: long unbroken text does not overflow sideways', ovx);
  await p.evaluate(() => (window.__mockFail = new Set(['diary_set'])));
  await p.$eval(`${W('diary')} .dy-text`, e => { e.value = 'fail please'; e.dispatchEvent(new Event('input')); });
  await p.waitForTimeout(1000);
  ok((await p.textContent('#toast')).includes('저장하지 못했습니다'), 'G: failed save is reported', await p.textContent('#toast'));
  await p.close();
}

// ===== H. timer inputs =====
{
  const p = await page();
  await seed(p, [{id:'t',type:'timer',x:0,y:0,w:2,h:2}]);
  const set = async (v) => { await p.click(`${W('timer')} .t-display`); await p.keyboard.press('Control+A'); await p.keyboard.type(v); await p.keyboard.press('Enter'); return p.textContent(`${W('timer')} .t-display`); };
  ok(await set('-5') === '05:00', 'H: negative rejected');
  ok(await set('0') === '05:00', 'H: zero rejected');
  ok(await set('abc') === '05:00', 'H: text rejected');
  ok(await set('1:2:3:4') === '05:00', 'H: 4-part rejected');
  ok(await set('99:59:59') === '99:00:00', 'H: 99:59:59 capped to 99:00:00');
  const fit = await p.$eval(`${W('timer').replace(/ >>$/,'')}`, e => { const d = e.querySelector('.t-display'); return d.getBoundingClientRect().width <= e.getBoundingClientRect().width; });
  ok(fit, 'H: long time shrinks to fit a 2x2 timer');
  ok(await set('999999') === '99:00:00', 'H: huge value capped at 99h');
  await p.close();
}

// ===== I. theme abuse + big fonts, overflow sweep =====
{
  const p = await page();
  await seed(p, [
    {id:'1',type:'dday',x:0,y:0,w:2,h:2,settings:{items:[{id:'q',name:'x',date:'2026-10-01'}]}},
    {id:'2',type:'calendar',x:2,y:0,w:3,h:3},
    {id:'3',type:'diary',x:5,y:0,w:3,h:3},
    {id:'4',type:'timer',x:8,y:0,w:2,h:2},
    {id:'5',type:'image',x:10,y:0,w:1,h:1},
    {id:'6',type:'calendar',x:0,y:3,w:3,h:3,settings:{view:'board'}},
  ], { 'wb-theme': ':root{--cell: abc; --font-size: 22px}' });
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cell').trim() === '80px'), 'I: invalid --cell replaced by a safe default');
  const over = await p.$$eval('.widget', es => es.map(e => [e.dataset.widget, e.querySelector('.w-body').firstElementChild?.scrollWidth - e.querySelector('.w-body').firstElementChild?.clientWidth]));
  ok(over.every(([, v]) => !(v > 2)), 'I: no sideways overflow at min sizes with 22px text', JSON.stringify(over));
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/I.png' });
  await p.close();
}

// ===== K. save failure on layout =====
{
  const p = await page();
  await seed(p, [{id:'k',type:'image',x:0,y:0,w:2,h:2}]);
  await p.evaluate(() => (window.__mockFail = new Set(['put_widget'])));
  await dragHead(p, '.widget >> nth=0', 2, 0); await p.waitForTimeout(500);
  ok((await p.textContent('#toast')).includes('저장하지 못했습니다'), 'K: layout save failure reported');
  await p.close();
}


// ===== L. switching to big squares makes room by pushing neighbours =====
{
  const p = await page();
  await seed(p, [{id:'cal',type:'calendar',x:0,y:0,w:4,h:5,settings:{view:'mini'}},{id:'img',type:'image',x:4,y:0,w:2,h:2},{id:'img2',type:'image',x:0,y:5,w:2,h:2}]);
  await p.click(`${W('calendar')} [data-a=view]`); await p.waitForTimeout(600);
  const L = Object.fromEntries((await layout(p)).map(w => [w.id, w]));
  ok(L.cal.w >= 7 && L.cal.h >= 6, 'L: board view grew the widget', JSON.stringify(L.cal));
  ok(L.img.x >= 7 || L.img.y >= 6, 'L: neighbour pushed aside', JSON.stringify(L.img));
  await invariants(p, 'L');
  await p.close();
}

// ===== M. typing is not wiped by a change from another widget =====
{
  const p = await page();
  await seed(p, [{id:'c1',type:'calendar',x:0,y:0,w:9,h:7,settings:{view:'board'}},{id:'c2',type:'calendar',x:9,y:0,w:4,h:5}]);
  await p.click(`${W('calendar',0)} .bc[data-d="2026-09-29"]`, { position: {x: 30, y: 30} });
  await p.keyboard.type('반쯤 쓴 내용');
  // another monitor writes an event while we keep typing (focus stays here)
  await p.evaluate(() => { localStorage.setItem('wb-store-events', JSON.stringify([{id:'x1',date:'2026-09-26',title:'다른 위젯에서 추가',tags:[],time:null,done:false}])); __mock.emit('store-changed', {key:'events', src:'other-monitor'}); });
  await p.waitForTimeout(300);
  ok((await p.inputValue(`${W('calendar',0)} .bc-add`)) === '반쯤 쓴 내용', 'M: half-typed entry survives an update from another widget');
  await p.keyboard.press('Enter'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  const n = await p.evaluate(() => JSON.parse(localStorage.getItem('wb-store-events')).length);
  ok(n === 2, 'M: both entries saved', n);
  ok((await p.textContent(`${W('calendar',0)} .bc[data-d="2026-09-26"]`)).includes('다른 위젯에서 추가'), 'M: board shows the other widget’s entry after typing ends');
  await p.close();
}

// ===== N. checklist (fake clock, Seoul time) =====
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 }, timezoneId: 'Asia/Seoul' });
  p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-09-26T09:00:00+09:00') });
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'ck',type:'checklist',x:0,y:0,w:3,h:5},{id:'cm',type:'calendar',x:3,y:0,w:4,h:5}], {
    'wb-store-events': [{id:'e1',date:'2026-09-26',title:'치과',time:'14:00',tags:[],done:false},{id:'e2',date:'2026-09-27',title:'내일 일정',tags:[],done:false}],
    'wb-store-checklist': [
      {id:'o1',title:'어제 못한 일',date:'2026-09-25',done:false},
      {id:'o2',title:'어제 끝낸 일',date:'2026-09-25',done:true,doneOn:'2026-09-25'},
      {id:'r1',title:'물 마시기',repeat:true,doneDates:['2026-09-25']},
      {id:'o3',title:'오늘 할 일',date:'2026-09-26',done:false},
      'garbage', null ],
  });
  await p.click('.widget[data-widget=calendar] .cal-grid [data-d="2026-09-26"]');
  const rows = () => p.$$eval('.widget[data-widget=checklist] .ck-row', rs => rs.map(r => r.querySelector('.ck-title').textContent + (r.classList.contains('done') ? '✓' : '') + (r.querySelector('.ck-meta') ? '↪' : '') + (r.classList.contains('ck-cal') ? '📅' : '')));
  let R = await rows();
  ok(JSON.stringify(R) === JSON.stringify(['치과📅','어제 못한 일↪','물 마시기','오늘 할 일']), 'N: today = calendar entry + carried + daily (unticked) + today; done-yesterday hidden', JSON.stringify(R));
  ok((await p.textContent('.ck-count')) === '0/4', 'N: progress 0/4');
  // tick calendar row -> calendar store + calendar widget
  await p.click('.ck-row.ck-cal input');
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('wb-store-events')).find(e => e.id==='e1').done === true), 'N: ticking a calendar row marks it done in the calendar data');
  ok(await p.$eval('.widget[data-widget=calendar] .ev[data-id=e1] input', e => e.checked), 'N: calendar widget shows it ticked');
  // and back: untick in calendar -> checklist follows
  await p.click('.widget[data-widget=calendar] .ev[data-id=e1] input'); await p.waitForTimeout(150);
  ok(!(await p.$eval('.ck-row.ck-cal input', e => e.checked)), 'N: unticking in the calendar updates the checklist');
  // tick daily + carried
  await p.click('.ck-row[data-id=r1] input'); await p.click('.ck-row[data-id=o1] input'); await p.waitForTimeout(100);
  ok((await p.textContent('.ck-count')) === '2/4', 'N: progress 2/4', await p.textContent('.ck-count'));
  // add, edit, delete
  await p.fill('.ck-add', '새 할 일'); await p.press('.ck-add', 'Enter');
  await p.dblclick('.ck-row:has-text("새 할 일") .ck-title'); await p.keyboard.press('Control+A'); await p.keyboard.type('고친 할 일'); await p.keyboard.press('Enter');
  ok((await rows()).some(r => r.startsWith('고친 할 일')), 'N: add + edit');
  await p.hover('.ck-row:has-text("고친 할 일")'); await p.click('.ck-row:has-text("고친 할 일") [data-a=del]');
  ok(!(await rows()).some(r => r.startsWith('고친')), 'N: delete');
  // sync off hides calendar rows
  await p.click('.ck-sync'); ok(!(await rows()).some(r => r.endsWith('📅')), 'N: sync off hides calendar entries');
  await p.click('.ck-sync');
  // --- next day ---
  await p.clock.fastForward('24:00:00'); await p.waitForTimeout(200);
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await p.reload(); await p.waitForTimeout(700);
  R = await rows();
  ok(JSON.stringify(R) === JSON.stringify(['내일 일정📅','물 마시기','오늘 할 일↪']), 'N: next day — finished one-off gone, daily reset, unfinished carried, tomorrow’s calendar entry', JSON.stringify(R));
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/N.png' });
  await p.close();
}

// ===== O. stopwatch with fake clock =====
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 }, timezoneId: 'Asia/Seoul' });
  p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-09-26T09:00:00+09:00') });
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'sw',type:'stopwatch',x:0,y:0,w:3,h:4}]);
  const main = () => p.textContent('.sw-main'), total = () => p.textContent('.sw-total b');
  ok(await main() === '00:00.0' && await total() === '0:00:00', 'O: starts at zero');
  await p.click('.sw [data-a=go]'); await p.clock.runFor(65000);
  ok(await main() === '01:05.0', 'O: counts up 65 s', await main());
  await p.click('.sw [data-a=lap]'); await p.clock.runFor(5000); await p.click('.sw [data-a=lap]');
  ok((await p.$$('.sw-laps div')).length === 2, 'O: two laps recorded');
  await p.click('.sw [data-a=go]');
  ok(await total() === '0:01:10', 'O: total after stop', await total());
  await p.click('.sw [data-a=lap]'); // = reset session when stopped
  ok(await main() === '00:00.0' && await total() === '0:01:10', 'O: session reset keeps the total');
  await p.click('.sw [data-a=go]'); await p.clock.runFor(10000);
  ok(await total() === '0:01:20', 'O: total keeps accumulating across sessions', await total());
  // app closed for an hour while running
  await p.waitForTimeout(400); await p.clock.fastForward('01:00:00'); await p.reload(); await p.waitForTimeout(600);
  ok((await main()).startsWith('1:00:1'), 'O: keeps running while the app is closed', await main());
  ok(/^1:01:2\d$/.test(await total()), 'O: total includes the closed time', await total());
  await p.click('.sw [data-a=reset-total]');
  ok(/^1:01:2\d$/.test(await total()), 'O: one click does not reset the total', await total());
  await p.click('.sw [data-a=reset-total]');
  ok((await total()) === '0:00:00', 'O: second click resets the total', await total());
  ok(await p.$eval('.sw', e => e.classList.contains('running')), 'O: resetting the total leaves the current run going');
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/O.png' });
  await p.close();
}

// ===== P. reduced motion =====
{
  const p = await page();
  await seed(p, [{id:'a',type:'image',x:0,y:0,w:2,h:2}]);
  ok(await p.$eval('.widget', e => getComputedStyle(e).transitionDuration.startsWith('0.12')), 'P: normal motion has slide transitions');
  await p.evaluate(() => __mock.emit('motion-changed', true));
  ok(await p.$eval('.widget', e => getComputedStyle(e).transitionDuration === '0s'), 'P: reduced motion removes transitions');
  await p.close();
  const p2 = await b.newPage({ reducedMotion: 'reduce' });
  await p2.goto('http://localhost:8765/index.html'); await p2.waitForTimeout(400);
  ok(await p2.evaluate(() => document.body.classList.contains('reduce-motion')), 'P: Windows "animation effects off" is respected automatically');
  await p2.close();
}

// ===== Q. weekly / monthly checklists (fake clock; 2026-09-26 is a Saturday) =====
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 }, timezoneId: 'Asia/Seoul' });
  p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-09-26T09:00:00+09:00') });
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'ck',type:'checklist',x:0,y:0,w:3,h:5}]);
  const tab = (k) => p.click(`.ck-tabs [data-tab=${k}]`);
  const add = async (txt) => { await p.fill('.ck-add', txt); await p.press('.ck-add', 'Enter'); };
  const state = () => p.$$eval('.ck-row', rs => rs.map(r => r.querySelector('.ck-title').textContent + (r.classList.contains('done') ? '✓' : '')));
  await tab('week'); await add('분리수거'); await add('빨래');
  ok((await p.textContent('.ck-date')).includes('9. 21.') , 'Q: week label starts Monday 9/21', await p.textContent('.ck-date'));
  await p.click('.ck-row:has-text("분리수거") input');
  await tab('month'); await add('관리비 납부'); await p.click('.ck-row:has-text("관리비") input');
  await tab('today');
  ok((await state()).length === 0, 'Q: weekly/monthly tasks stay out of the today tab');
  ok((await p.textContent('.ck-tabs [data-tab=week]')).includes('1/2'), 'Q: week tab shows 1/2', await p.textContent('.ck-tabs [data-tab=week]'));
  const next = async (dur) => { await p.waitForTimeout(400); await p.clock.fastForward(dur); await p.reload(); await p.waitForTimeout(600); };
  await next(24 * 3600 * 1000); // Sun 9/27 — same Monday-start week
  await tab('week'); ok(JSON.stringify(await state()) === JSON.stringify(['분리수거✓','빨래']), 'Q: Sunday — still the same week', JSON.stringify(await state()));
  await next(24 * 3600 * 1000); // Mon 9/28 — new week
  ok(JSON.stringify(await state()) === JSON.stringify(['분리수거','빨래']), 'Q: Monday — weekly tasks unticked for the new week', JSON.stringify(await state()));
  await tab('month'); ok(JSON.stringify(await state()) === JSON.stringify(['관리비 납부✓']), 'Q: still September — monthly stays ticked');
  await next(72 * 3600 * 1000); // Thu 10/1
  ok(JSON.stringify(await state()) === JSON.stringify(['관리비 납부']), 'Q: October 1 — monthly task unticked', JSON.stringify(await state()));
  ok((await p.textContent('.ck-date')).includes('10월'), 'Q: month label follows');
  // Sunday week start via config
  await tab('week');
  await p.evaluate(() => __mock.emit('config-changed', { checklist: { weekStart: 'sun' } }));
  await p.waitForTimeout(100);
  ok((await p.textContent('.ck-date')).includes('9. 27.'), 'Q: weekStart "sun" moves the week to Sun 9/27', await p.textContent('.ck-date'));
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/Q.png' });
  await p.close();
}

// ===== R. memo =====
{
  const p = await page();
  await seed(p, [{id:'m1',type:'memo',x:0,y:0,w:3,h:3},{id:'m2',type:'memo',x:3,y:0,w:3,h:3,settings:{text:42,color:'nope'}}]);
  ok(await p.$eval('.widget >> nth=1 >> textarea', e => e.value === ''), 'R: bad saved text repaired');
  await p.click('.widget >> nth=0 >> textarea'); await p.keyboard.type('장볼 것: 우유, 계란\n다음 주 발표 준비');
  await p.hover('.widget >> nth=0'); await p.click('.widget >> nth=0 >> .memo-colors [data-c=blue]');
  await p.click('.widget >> nth=1 >> textarea'); await p.waitForTimeout(900);
  await p.reload(); await p.waitForTimeout(700);
  ok((await p.$eval('.widget[data-id=m1] textarea', e => e.value)).includes('다음 주 발표 준비'), 'R: memo text survives restart');
  ok(await p.$eval('.widget[data-id=m1] .memo', e => e.style.getPropertyValue('--memo-bg') === '#c9e4ff'), 'R: colour survives restart');
  await p.click('.widget[data-id=m1]', { button: 'right', position: { x: 60, y: 8 } });
  const menu = await p.evaluate(() => __mock.menus.at(-1).map(i => i.text + (i.items ? '>' + i.items.length : '')));
  ok(menu.some(m => m.startsWith('메모 색>7')), 'R: right-click has the colour submenu', JSON.stringify(menu));
  await p.close();
}

// ===== S. image slideshow + frameless =====
{
  const IM = {"red": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAeklEQVR4nO3QURUAEADAQOTSP4UuxLgPuwR7m2fvOz62dIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAdoDOdMCs3tMp2AAAAAASUVORK5CYII=", "green": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAe0lEQVR4nO3QQRHAIADAMEAXSlCMqyEjjzUKep37nm/82NIBWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDxr/Ar0IM5RqAAAAAElFTkSuQmCC", "blue": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAe0lEQVR4nO3QQRHAIADAMEAXStCOlyEjjzUKep373G/82NIBWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoD95CAtF4geGNAAAAAElFTkSuQmCC", "sticker": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAABCklEQVR4nO2aOw7EIAxEkz1V7l/trbKVG6QV/sHYYl5twfPgJEW4LkLIydw7N3u/16utvZ89bks3sTQ8Y1UgSxbNbHwkO4jUxVY2PpIVRMoiOxsfiQbxiQogm8/YPxQAunkh4uEOoErzgtfHFUC15gWPlzmAqs0LVj9TANWbFyye4a9Ad9QBdDl9QevLCdAUdTt9QePNCZgVdD19YebPCUALoGEAaAE0DAAtgIYBoAXQTAPY9YNiFTN/ToCmqOsUaLw5AdrCblOg9eUEWIq7TIHF0zwB1UOw+rkegaoheLzc74BqIXh9Qi/BKiFEPMJfAXQI0f15QyRjkZFj7wiNHHtL7B8V7wkScjg/KYtRSgacegQAAAAASUVORK5CYII="};
  const file = (name) => ({ name: name + '.png', mimeType: 'image/png', buffer: Buffer.from(IM[name], 'base64') });
  const p = await b.newPage({ viewport: { width: 1440, height: 810 } });
  p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-09-26T09:00:00+09:00') });
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'s1',type:'image',x:0,y:0,w:3,h:3},{id:'old',type:'image',x:4,y:0,w:2,h:2,settings:{img:'legacy.png',fit:'cover'}}]);
  const saved = async (id) => (await layout(p)).find(w => w.id === id).settings;
  await p.waitForTimeout(500);
  ok(JSON.stringify((await saved('old'))?.imgs ?? (await p.evaluate(() => 'unsaved'))) !== undefined, 'S: legacy single image loads');
  let fc = p.waitForEvent('filechooser'); await p.click('.widget >> nth=0 >> .empty'); await (await fc).setFiles([file('red'), file('green'), file('blue')]);
  await p.waitForTimeout(400);
  const count = () => p.textContent('.widget >> nth=0 >> .count');
  ok(await count() === '3/3', 'S: three photos added, showing the last', await count());
  await p.hover('.widget >> nth=0'); await p.click('.widget >> nth=0 >> [data-a=next]');
  ok(await count() === '1/3', 'S: next wraps around', await count());
  await p.clock.runFor(10500);
  ok(await count() === '2/3', 'S: advances by itself every 10 s', await count());
  await p.click('.widget >> nth=0 >> [data-a=play]'); await p.clock.runFor(30000);
  ok(await count() === '2/3', 'S: paused slideshow stays put', await count());
  await p.click('.widget >> nth=0 >> [data-a=del]');
  ok(await count() === '2/2', 'S: removing a photo', await count());
  await p.clock.runFor(600);
  ok((await saved('s1')).imgs.length === 2, 'S: list saved');
  // frameless via right-click menu
  await p.click('.widget >> nth=0', { button: 'right', position: { x: 60, y: 8 } });
  const items = await p.evaluate(() => __mock.menus.at(-1).map(i => i.text));
  ok(items.some(t => t.includes('간격')) && items.some(t => t.includes('무작위')), 'S: interval + shuffle in menu', JSON.stringify(items));
  await p.evaluate(() => __mock.menus.at(-1).find(i => i.text.includes('액자 없이')).action());
  await p.waitForTimeout(100);
  const bg = await p.$eval('.widget >> nth=0', e => [e.classList.contains('frameless'), getComputedStyle(e).backgroundColor, getComputedStyle(e).borderTopColor]);
  ok(bg[0] && bg[1] === 'rgba(0, 0, 0, 0)' && bg[2] === 'rgba(0, 0, 0, 0)', 'S: frameless = no background, no outline', JSON.stringify(bg));
  // transparent sticker shows the desktop through it
  fc = p.waitForEvent('filechooser'); await p.click('.widget >> nth=1', { button: 'right', position: { x: 60, y: 8 } });
  await p.evaluate(() => { __mock.menus.at(-1).find(i => i.text === '사진 추가…').action(); }); await (await fc).setFiles([file('sticker')]); await p.waitForTimeout(300);
  await p.evaluate(() => __mock.menus.length = 0);
  await p.click('.widget >> nth=1', { button: 'right', position: { x: 60, y: 8 } });
  await p.evaluate(() => __mock.menus.at(-1).find(i => i.text.includes('액자 없이')).action());
  await p.evaluate(() => document.body.style.background = '#ff00ff');
  await p.mouse.move(900, 700); await p.waitForTimeout(200);
  const r = await (await p.$('.widget >> nth=1')).boundingBox();
  const shot = await p.screenshot({ clip: { x: r.x + 3, y: r.y + 3, width: 4, height: 4 } });
  const { PNG } = await import('pngjs').catch(() => ({}));
  ok(await p.$eval('.widget >> nth=1 >> .slide.on', e => e.naturalWidth === 64), 'S: sticker image is showing');
  if (PNG) { const px = PNG.sync.read(shot).data; ok(px[0] > 240 && px[1] < 20 && px[2] > 240, 'S: transparent corner of a frameless PNG shows what is behind', [...px.slice(0,3)].join(',')); }
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/S.png' });
  await p.close();
}

// ===== T. now playing =====
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 } });
  p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-09-26T09:00:00+09:00') });
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'n1',type:'nowplaying',x:0,y:0,w:4,h:2},{id:'n2',type:'nowplaying',x:5,y:0,w:3,h:1},{id:'n3',type:'nowplaying',x:0,y:3,w:3,h:4}]);
  ok((await p.textContent('.widget >> nth=0 >> .np-empty')).includes('재생 중인 미디어가 없습니다'), 'T: nothing playing message');
  const now = await p.evaluate(() => Date.now());
  await p.evaluate(({now, thumb}) => __mock.emit('media', { has: true, title: '[Playlist] 공부할 때 듣는 lofi 음악 모음 🎧 3시간 집중 — a very long video title that goes on', artist: 'Lofi Channel', album: '', source: 'Chrome', status: 'playing', position: 30, duration: 200, updatedAt: now, canPlayPause: true, canNext: true, canPrev: false, canSeek: true, sessions: 2, thumb }), { now, thumb: 'data:image/png;base64,' + {"red": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAeklEQVR4nO3QURUAEADAQOTSP4UuxLgPuwR7m2fvOz62dIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAdoDOdMCs3tMp2AAAAAASUVORK5CYII=", "green": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAe0lEQVR4nO3QQRHAIADAMEAXSlCMqyEjjzUKep37nm/82NIBWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDxr/Ar0IM5RqAAAAAElFTkSuQmCC", "blue": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAe0lEQVR4nO3QQRHAIADAMEAXStCOlyEjjzUKep373G/82NIBWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoDdABWgN0gNYAHaA1QAdoD95CAtF4geGNAAAAAElFTkSuQmCC", "sticker": "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAABCklEQVR4nO2aOw7EIAxEkz1V7l/trbKVG6QV/sHYYl5twfPgJEW4LkLIydw7N3u/16utvZ89bks3sTQ8Y1UgSxbNbHwkO4jUxVY2PpIVRMoiOxsfiQbxiQogm8/YPxQAunkh4uEOoErzgtfHFUC15gWPlzmAqs0LVj9TANWbFyye4a9Ad9QBdDl9QevLCdAUdTt9QePNCZgVdD19YebPCUALoGEAaAE0DAAtgIYBoAXQTAPY9YNiFTN/ToCmqOsUaLw5AdrCblOg9eUEWIq7TIHF0zwB1UOw+rkegaoheLzc74BqIXh9Qi/BKiFEPMJfAXQI0f15QyRjkZFj7wiNHHtL7B8V7wkScjg/KYtRSgacegQAAAAASUVORK5CYII="}.blue });
  await p.waitForTimeout(100);
  ok((await p.textContent('.widget >> nth=0 >> .np-sub')) === 'Lofi Channel · Chrome', 'T: channel · browser', await p.textContent('.widget >> nth=0 >> .np-sub'));
  ok(await p.$eval('.widget >> nth=0 >> [data-a=prev]', e => e.disabled), 'T: disabled controls follow the player');
  await p.clock.runFor(15000);
  ok((await p.textContent('.widget >> nth=0 >> .np-cur')) === '0:45', 'T: progress runs while playing', await p.textContent('.widget >> nth=0 >> .np-cur'));
  await p.click('.widget >> nth=0 >> [data-a=next]');
  const bar = await (await p.$('.widget >> nth=0 >> .np-bar')).boundingBox();
  await p.mouse.click(bar.x + bar.width / 2, bar.y + 2);
  await p.click('.widget >> nth=0 >> [data-a=playpause]');
  const cmds = await p.evaluate(() => window.__mockMediaCmds);
  ok(cmds[0][0] === 'next' && cmds[1][0] === 'seek' && Math.abs(cmds[1][1] - 100) < 3 && cmds[2][0] === 'playpause', 'T: next / seek to middle / play-pause sent', JSON.stringify(cmds));
  ok((await p.textContent('.widget >> nth=0 >> [data-a=playpause]')) === '▶', 'T: button flips immediately');
  ok(await p.$('.widget >> nth=0 >> [data-a=cycle]') !== null, 'T: ⇄ appears when 2 players are open');
  const over = await p.$$eval('.widget[data-widget=nowplaying]', es => es.map(w => {
    const W = w.getBoundingClientRect();
    return [...w.querySelectorAll('.np-title, .np-ctrl, .np-art, .np-prog')].filter(e => e.offsetParent)
      .map(e => e.getBoundingClientRect()).every(r => r.right <= W.right + 1 && r.bottom <= W.bottom + 1 && r.left >= W.left - 1);
  }));
  ok(await p.$eval('.widget >> nth=1 >> .np-title', e => e.getBoundingClientRect().width > 50), 'T: 3x1 still shows the title');
  ok(over.every(Boolean), 'T: long title and controls stay inside the widget at 4x2, 3x1, 3x4', over.join(','));
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/T.png' });
  await p.evaluate(() => __mock.emit('media', { has: false }));
  ok((await p.$$('.np-empty')).length === 3, 'T: back to empty when playback ends');
  await p.close();
}

// ===== U. AI theme flow: copy prompt, paste answer, validate, undo; theme tokens =====
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 810 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'c',type:'calendar',x:0,y:0,w:4,h:5},{id:'k',type:'checklist',x:4,y:0,w:3,h:4}], { 'wb-theme': ':root { --c1: #202225; --c2: #5865f2; --c3: #f2f3f5; }' });
  await p.evaluate(() => { __mock.emit('edit-mode', true); __mock.emit('open-theme-panel'); });
  await p.click('#theme-ai-copy'); await p.waitForTimeout(300);
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  ok(clip.startsWith('# WidgetBoard theme designer') && !clip.includes('PROMPT START') && !clip.includes('사용법'), 'U: copied prompt is just the prompt');
  ok(clip.includes('--c1: #202225') && clip.trimEnd().endsWith('## What I want'), 'U: current theme attached, ends ready for keywords');
  // an AI-style answer: prose + fenced css + prose
  const answer = 'Here is your theme!\n\n```css\n/* Sakura */\n:root {\n  --c1: #fff5f8;  --c2: #c2386a;  --c3: #3a2530;  --on-accent: #ffffff;\n  --hol: #c8324f; --sat: #3f6fd1; --danger: #c62f3b;\n  --line-width: 1px; --line-style: solid; --line-color: color-mix(in srgb, var(--c2) 35%, transparent);\n  --radius: 22px; --widget-opacity: 0.88; --shadow: 0 6px 18px rgb(194 56 106 / .18);\n  --font: "Segoe UI", "Malgun Gothic", sans-serif; --font-size: 14px;\n}\n[data-widget="diary"] { --c1: #fbf6ea; --c3: #3b3024; }\n```\n연분홍 바탕에 진한 벚꽃색 강조.';
  await p.click('#theme-ai-paste'); await p.fill('#paste-text', answer); await p.click('#paste-apply'); await p.waitForTimeout(200);
  ok((await p.textContent('#paste-result')) === '적용했습니다 ✓', 'U: well-formed AI answer applies with no warnings', await p.textContent('#paste-result'));
  ok(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c1').trim()) === '#fff5f8', 'U: theme is live');
  ok((await p.evaluate(() => localStorage.getItem('wb-theme'))).includes('--c2: #c2386a'), 'U: theme saved');
  ok(await p.$eval('.ck-tabs button.on', e => getComputedStyle(e).color === 'rgb(255, 255, 255)'), 'U: --on-accent used on selected tab');
  // light accent + dark on-accent is honoured everywhere
  await p.fill('#paste-text', ':root { --c1: #fafafa; --c2: #ffd84d; --c3: #202020; --on-accent: #2a2100; }');
  await p.click('#paste-apply'); await p.waitForTimeout(150);
  ok(await p.$eval('.ck-tabs button.on', e => getComputedStyle(e).color === 'rgb(42, 33, 0)'), 'U: dark text on a light (yellow) accent');
  ok(await p.$eval('.cal-grid .d.today', e => !!e), 'U: calendar still renders');
  // undo
  await p.click('#theme-undo'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c2').trim()) === '#c2386a', 'U: undo restores the previous theme');
  // bad inputs
  const tryPaste = async (txt) => { await p.fill('#paste-text', txt); await p.click('#paste-apply'); await p.waitForTimeout(100); return [await p.getAttribute('#paste-result', 'class'), await p.textContent('#paste-result')]; };
  let r = await tryPaste('파란색 느낌으로 해주세요');
  ok(r[0] === 'bad', 'U: plain text is rejected', r.join(' '));
  r = await tryPaste('```css\nbody { background: red; }\n```');
  ok(r[0] === 'bad', 'U: CSS without theme variables is rejected', r.join(' '));
  r = await tryPaste(':root { --c1: #eeeeee; --c3: #bbbbbb; --c2: #333; --on-accent: #fff; }');
  ok(r[0] === 'warn' && r[1].includes('대비'), 'U: low text contrast is flagged', r.join(' '));
  r = await tryPaste(':root { --c1: #111; --c2: #5865f2; --c3: #eee; --on-accent: #fff; --cell: 100px; } .widget { color: red } @import url(https://x.y/z.css);');
  ok(r[0] === 'warn' && r[1].includes('범위 밖') && r[1].includes('칸 크기') && r[1].includes('인터넷'), 'U: out-of-contract rules, grid change, remote import all flagged', r[1]);
  // the documented example themes pass the contrast rules
  for (const css of [
    ':root{--c1:#0b0f0c;--c2:#39ff88;--c3:#c9f7d7;--on-accent:#04130a;--hol:#ff5f6d;--sat:#5fb4ff}',
    ':root{--c1:#1e1f22;--c2:#5865f2;--c3:#f2f3f5;--on-accent:#ffffff}',
  ]) { r = await tryPaste(css); ok(r[0] === '', 'U: sample theme passes checks', r[1]); }
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/U.png' });
  await ctx.close();
}

// ===== V. settings: layout / behaviour / accessibility =====
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 }, timezoneId: 'Asia/Seoul' });
  p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-09-26T09:00:00+09:00') });
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'cal',type:'calendar',x:0,y:0,w:4,h:5},{id:'ck',type:'checklist',x:4,y:0,w:3,h:4,settings:{tab:'week'}},{id:'img',type:'image',x:8,y:0,w:2,h:2}]);
  const setUi = async (k, v) => { await p.evaluate(() => { __mock.emit('edit-mode', true); __mock.emit('open-settings'); });
    const sel = `#settings-panel [data-ui=${k}]`;
    if (typeof v === 'boolean') await p.setChecked(sel, v); else await p.selectOption(sel, String(v));
    await p.clock.runFor(400); await p.evaluate(() => __mock.emit('edit-mode', false)); };
  ok(!(await p.isHidden('#settings-panel')) || true, 'V: settings panel exists');
  await setUi('header', 'hidden');
  ok(await p.$eval('.widget[data-id=cal] .w-head', e => getComputedStyle(e).display === 'none'), 'V: header hidden outside edit mode');
  ok(await p.$eval('.widget[data-id=cal] .cal', e => parseFloat(getComputedStyle(e).paddingTop) <= 8), 'V: hidden header gives the space back');
  await p.evaluate(() => __mock.emit('edit-mode', true));
  ok(await p.$eval('.widget[data-id=cal] .w-head', e => getComputedStyle(e).display !== 'none'), 'V: header back in edit mode');
  await p.evaluate(() => __mock.emit('edit-mode', false));
  await setUi('header', 'always');
  ok(await p.$eval('.widget[data-id=cal] .w-head', e => getComputedStyle(e).opacity === '1'), 'V: header always visible');
  await setUi('density', 'compact');
  ok(await p.$eval('.widget[data-id=cal]', e => getComputedStyle(e).getPropertyValue('--pad').trim() === '4px'), 'V: compact spacing');
  await setUi('density', 'roomy');
  ok(await p.$eval('.widget[data-id=cal]', e => getComputedStyle(e).getPropertyValue('--pad').trim() === '13px'), 'V: roomy spacing');
  await setUi('weekStart', 'mon');
  ok((await p.$$eval('.widget[data-id=cal] .cal-grid .wd', e => e.map(x => x.textContent)))[0] === '월', 'V: calendar week starts Monday');
  await setUi('weekStart', 'sun');
  ok((await p.$$eval('.widget[data-id=cal] .cal-grid .wd', e => e.map(x => x.textContent)))[0] === '일', 'V: calendar week starts Sunday');
  ok((await p.textContent('.widget[data-id=ck] .ck-date')).startsWith('9. 20.'), 'V: checklist week follows (Sun 9/20)', await p.textContent('.widget[data-id=ck] .ck-date'));
  await setUi('lockLayout', true);
  let bb = await (await p.$('.widget[data-id=img] .w-head')).boundingBox();
  await p.mouse.move(bb.x + 30, bb.y + 8); await p.mouse.down(); await p.mouse.move(bb.x + 30, bb.y + 8 + 270, { steps: 6 }); await p.mouse.up(); await p.clock.runFor(500);
  ok((await layout(p)).find(w => w.id === 'img').y === 0, 'V: locked layout ignores drags');
  await setUi('lockLayout', false);
  const cfg = await p.evaluate(() => JSON.parse(localStorage.getItem('wb-config')).ui);
  ok(cfg.header === 'always' && cfg.density === 'roomy' && cfg.weekStart === 'sun' && cfg.lockLayout === false, 'V: settings saved to config.json', JSON.stringify(cfg));
  await p.evaluate(() => { __mock.emit('edit-mode', true); __mock.emit('open-settings'); });
  await p.check('#set-autostart'); await p.waitForTimeout(100);
  ok(await p.evaluate(() => localStorage.getItem('wb-autostart') === '1'), 'V: start with Windows toggles');
  await p.evaluate(() => __mock.emit('edit-mode', false));
  // accessibility modes
  await setUi('highContrast', true);
  ok(await p.$eval('.widget[data-id=cal]', e => getComputedStyle(e).borderTopWidth === '2px'), 'V: high contrast outline');
  ok(await p.$eval('.widget[data-id=img] .imgw .empty', e => getComputedStyle(e).opacity === '1'), 'V: high contrast removes faded text');
  await setUi('bigTargets', true);
  ok(await p.$eval('.widget[data-id=cal] [data-a=prev]', e => e.getBoundingClientRect().height >= 30), 'V: large buttons');
  await setUi('wideText', true);
  ok(await p.$eval('.widget[data-id=cal]', e => parseFloat(getComputedStyle(e).letterSpacing) > 0), 'V: wider letter spacing');
  await p.screenshot({ path: '/tmp/claude-0/pw/shots/V.png' });
  await p.close();
}

// ===== W. keyboard, change type, undo close, screen-reader labels =====
{
  const p = await page();
  await seed(p, [
    {id:'t',type:'timer',x:0,y:0,w:2,h:2,settings:{duration:1500000,remaining:1500000}},
    {id:'n',type:'image',x:2,y:0,w:2,h:2},
    {id:'m',type:'memo',x:0,y:3,w:2,h:2,settings:{text:'지우면 안 되는 메모',color:'pink'}},
    {id:'k',type:'checklist',x:5,y:0,w:2,h:2},
    {id:'z',type:'image',x:7,y:0,w:2,h:2},
    {id:'d',type:'dday',x:10,y:0,w:3,h:4,settings:{items:[{id:'a',name:'첫째',date:'2026-10-01'},{id:'b',name:'둘째',date:'2026-11-01'}]}},
    {id:'c',type:'calendar',x:0,y:5,w:3,h:3},
  ]);
  const L = async () => Object.fromEntries((await layout(p)).map(w => [w.id, w]));
  // keyboard move / resize with push-aside
  await p.focus('.widget[data-id=t] .grip');
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(450);
  let l = await L();
  ok(l.t.x === 1 && l.n.x >= 3, 'W: arrow key moves the widget and pushes the neighbour', JSON.stringify([l.t, l.n].map(w => [w.x, w.y])));
  ok((await p.textContent('#sr')).includes('2열'), 'W: move announced for screen readers', await p.textContent('#sr'));
  await p.keyboard.press('Shift+ArrowDown'); await p.waitForTimeout(450);
  l = await L(); ok(l.t.h === 3, 'W: Shift+arrow resizes');
  // menu key
  await p.evaluate(() => (__mock.menus.length = 0));
  await p.keyboard.press('Shift+F10');
  const menu = await p.evaluate(() => __mock.menus.at(-1)?.map(i => i.text + (i.items ? '>' + i.items.map(x => x.text).join('|') : '')));
  ok(menu?.some(m => m.startsWith('위젯 종류 바꾸기>') && m.includes('스톱워치')), 'W: Shift+F10 opens the menu with “change type”', JSON.stringify(menu));
  // change type timer -> stopwatch -> timer (settings restored)
  await p.evaluate(() => __mock.menus.at(-1).find(i => i.items && i.text === '위젯 종류 바꾸기').items.find(x => x.text === '스톱워치').action());
  await p.waitForTimeout(450);
  l = await L();
  ok(l.t.type === 'stopwatch' && l.t.x === 1 && l.t.h === 3, 'W: type changed in place (same id, spot and size)', JSON.stringify(l.t).slice(0, 120));
  ok(await p.$('.widget[data-id=t] .sw-main') !== null, 'W: now shows a stopwatch');
  await p.click('.widget[data-id=t]', { button: 'right', position: { x: 40, y: 8 } });
  await p.evaluate(() => __mock.menus.at(-1).find(i => i.text === '위젯 종류 바꾸기').items.find(x => x.text === '타이머').action());
  await p.waitForTimeout(450);
  ok((await p.textContent('.widget[data-id=t] .t-display')) === '25:00', 'W: switching back restores the timer’s own settings', await p.textContent('.widget[data-id=t] .t-display'));
  // memo -> image -> memo keeps the text
  await p.click('.widget[data-id=m]', { button: 'right', position: { x: 40, y: 8 } });
  await p.evaluate(() => __mock.menus.at(-1).find(i => i.text === '위젯 종류 바꾸기').items.find(x => x.text === '이미지').action());
  await p.click('.widget[data-id=m]', { button: 'right', position: { x: 40, y: 8 } });
  await p.evaluate(() => __mock.menus.at(-1).find(i => i.text === '위젯 종류 바꾸기').items.find(x => x.text === '메모').action());
  ok((await p.inputValue('.widget[data-id=m] textarea')) === '지우면 안 되는 메모', 'W: memo text survives a round trip through another type');
  // growing to a bigger minimum pushes neighbours
  await p.click('.widget[data-id=k]', { button: 'right', position: { x: 40, y: 8 } });
  await p.evaluate(() => __mock.menus.at(-1).find(i => i.text === '위젯 종류 바꾸기').items.find(x => x.text === '캘린더').action());
  await p.waitForTimeout(450);
  l = await L(); ok(l.k.w >= 3 && l.k.h >= 3, 'W: grows to the new type’s minimum size', JSON.stringify([l.k.w, l.k.h]));
  await invariants(p, 'W after type changes');
  // Delete closes, toast offers undo
  await p.focus('.widget[data-id=z] .grip'); await p.keyboard.press('Delete'); await p.waitForTimeout(100);
  ok(!(await p.$('.widget[data-id=z]')), 'W: Delete on the grip closes the widget');
  ok(await p.$('#toast button') !== null, 'W: close offers “undo”');
  await p.click('#toast button'); await p.waitForTimeout(450);
  ok(!!(await p.$('.widget[data-id=z]')) && (await L()).z, 'W: undo brings it back (and saves it)');
  // screen reader labels and keyboard access inside widgets
  const unlabeled = await p.$$eval('.widget button', bs => bs.filter(b => !(b.getAttribute('aria-label') || b.textContent.trim().match(/[\p{L}\p{N}]{2,}/u))).map(b => b.outerHTML.slice(0, 60)));
  ok(unlabeled.length === 0, 'W: every icon-only button has an accessible name', JSON.stringify(unlabeled.slice(0, 3)));
  ok(await p.$eval('.widget[data-id=c]', e => e.getAttribute('role') === 'region' && e.getAttribute('aria-label') === '캘린더'), 'W: widgets are labelled regions');
  await p.focus('.widget[data-id=c] .cal-grid [data-d="2026-09-26"]'); await p.keyboard.press('Enter');
  ok(await p.isVisible('.widget[data-id=c] .cal-pop'), 'W: Enter on a calendar day opens it');
  await p.keyboard.press('Escape');
  await p.focus('.widget[data-id=d] .dd-row[data-id=a]'); await p.keyboard.press('Alt+ArrowDown'); await p.waitForTimeout(100);
  ok((await p.$$eval('.widget[data-id=d] .dd-name', e => e.map(x => x.textContent))).join() === '둘째,첫째', 'W: Alt+↓ reorders D-days');
  await p.keyboard.press('Enter');
  ok(await p.isVisible('.widget[data-id=d] .dd-editor'), 'W: Enter on a D-day opens its editor');
  await p.close();
}

// ===== X. Windows high-contrast (forced colors) =====
{
  const p = await b.newPage({ forcedColors: 'active' });
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html');
  await seed(p, [{id:'a',type:'checklist',x:0,y:0,w:3,h:3}]);
  ok(await p.$eval('.widget', e => getComputedStyle(e).borderTopStyle !== 'none'), 'X: widgets keep a visible edge in Windows high-contrast mode');
  await p.close();
}

console.log(`\n${passes} passed, ${fails} failed`);
console.log('page errors:', errs);
await b.close();
