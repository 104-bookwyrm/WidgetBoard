// v0.11: update UI (the Rust updater itself is covered by tools/updater-test)
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = 0, passes = 0;
const ok = (cond, msg, extra = '') => { if (cond) passes++; else { fails++; console.log('FAIL:', msg, extra); } };
const errs = [];
async function page(lang = 'ko') {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/404|mock failure/.test(m.text()) && errs.push(m.text()));
  await p.goto(`http://localhost:8765/index.html?lang=${lang}`);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(500);
  return p;
}
const openSettings = async (p) => { await p.evaluate(() => window.__mock.emit('open-settings')); await p.waitForTimeout(200); };

{
  const p = await page();
  await openSettings(p);
  ok(await p.$eval('#set-update', (s) => s.value) === 'weekly', 'weekly is the default schedule');
  const st = await p.$eval('#update-status', (e) => e.textContent);
  ok(/v0\.11\.0/.test(st) && /주소가 아직 없습니다/.test(st), 'status shows version and "not configured"', st);
  ok(await p.$eval('#update-apply', (e) => e.hidden), 'no install button without a download');
  await p.click('#update-now');
  await p.waitForTimeout(150);
  ok(/주소가 아직 없습니다/.test(await p.$eval('#toast', (e) => e.textContent)), 'manual check explains what is missing');
  await p.selectOption('#set-update', 'daily');
  await p.waitForTimeout(250);
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem('wb-config')).update.check)) === 'daily', 'schedule saved to config.update.check');
  await p.selectOption('#set-update', 'off');
  await p.waitForTimeout(250);
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem('wb-config')).update.check)) === 'off', 'can be switched off');
  // configured, up to date
  await p.evaluate(() => (window.__mockUpdate = {}));
  await p.click('#update-now');
  await p.waitForTimeout(150);
  ok(/최신 버전/.test(await p.$eval('#toast', (e) => e.textContent)), 'up-to-date message');
  // an update is found
  await p.evaluate(() => (window.__mockUpdate = { found: '0.12.0', notes: '버그 수정' }));
  await p.click('#update-now');
  await p.waitForTimeout(250);
  const tt = await p.$eval('#toast', (e) => e.textContent);
  ok(/v0\.12\.0 준비됨/.test(tt) && /지금 다시 시작/.test(tt), 'ready toast offers restart', tt);
  const st2 = await p.$eval('#update-status', (e) => e.textContent);
  ok(/0\.12\.0/.test(st2) && /버그 수정/.test(st2), 'settings status shows the pending version + notes', st2);
  ok(!(await p.$eval('#update-apply', (e) => e.hidden)) && /0\.12\.0/.test(await p.$eval('#update-apply', (e) => e.textContent)), 'install button appears');
  // unsaved widget change is flushed before restart
  await p.evaluate(() => window.__mock.emit('add-widget', 'memo'));
  await p.waitForTimeout(300);
  await p.fill('.memo textarea', '저장돼야 함');
  await p.evaluate(() => document.activeElement.blur());
  await p.click('#update-apply');
  await p.waitForTimeout(300);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('wb-widgets')).find((w) => w.type === 'memo')?.settings.text);
  ok(saved === '저장돼야 함', 'pending saves flushed before restarting', saved);
  ok((await p.evaluate(() => window.__native || [])).some(([c]) => c === 'update_restart'), 'restart requested');
  // flush-saves from the tray path
  await p.fill('.memo textarea', '트레이에서도');
  await p.evaluate(() => { document.activeElement.blur(); window.__mock.emit('flush-saves'); });
  await p.waitForTimeout(100);
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem('wb-widgets')).find((w) => w.type === 'memo')?.settings.text)) === '트레이에서도', 'flush-saves event writes immediately');
  // failure message
  await p.evaluate(() => window.__mock.emit('update-failed', 'HTTP 404'));
  ok(/HTTP 404/.test(await p.$eval('#toast', (e) => e.textContent)), 'failure shown with reason');
  const raw = await p.$eval('#settings-panel', (e) => e.innerText.match(/\bupd\.[a-z_]+/g));
  ok(!raw, 'no raw keys (ko)', String(raw));
  await p.close();
}
{
  const p = await page('en');
  await openSettings(p);
  const t = await p.$eval('#settings-panel', (e) => e.innerText);
  ok(/Updates/.test(t) && /Weekly \(default\)/.test(t) && /No update address yet/.test(t) && !/\bupd\.[a-z_]+/.test(t), 'English update section');
  await p.close();
}
console.log(`\n${passes} passed, ${fails} failed`);
console.log('page errors:', JSON.stringify(errs));
await b.close();
