import assert from 'node:assert/strict';
import { chromium } from './browser.mjs';
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:8765/settings.html?lang=ko&page=backup');
  await page.waitForSelector('#backup-auto');
  assert.equal(await page.locator('#backup-auto').inputValue(), 'daily');
  assert.equal(await page.locator('#backup-keep').inputValue(), '7');
  assert.match(await page.locator('#backup-policy').innerText(), /매주/);
  assert.match(await page.locator('#backup-policy').innerText(), /매월/);
  console.log('PASS Korean backup policy exposes daily and long-term recovery points');
  await page.locator('#backup-auto').selectOption('off');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('wb-config')).backup.auto === 'off');
  await page.reload();
  assert.equal(await page.locator('#backup-auto').inputValue(), 'off');
  console.log('PASS explicit backup opt-out survives reload');
  await page.evaluate(() => {
    localStorage.setItem('wb-backup-status', JSON.stringify({ error: 'Disk unavailable' }));
    __mock.emit('backup-status', { error: 'Disk unavailable' });
  });
  await page.waitForFunction(() => document.querySelector('#backup-status').textContent.includes('Disk unavailable'));
  console.log('PASS scheduler failure is visible in backup settings');
} finally { await browser.close(); }
