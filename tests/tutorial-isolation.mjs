import assert from 'node:assert/strict';
import { chromium, ready } from './browser.mjs';
const b = await chromium.launch();
try {
 const p = await b.newPage({viewport:{width:1440,height:900}});
 await p.addInitScript(() => { localStorage.setItem('wb-store-events', '[{"id":"real-data"}]'); });
 await p.goto('http://localhost:8765/index.html?demo&lang=ko'); await ready(p);
 assert.equal(await p.locator('#tutorial-count').textContent(), '1 / 10');
 assert.equal(await p.evaluate(() => localStorage.getItem('wb-store-events')), '[{"id":"real-data"}]');
 assert.equal(await p.evaluate(async () => (await __mock.invoke('store_get', {key:'events'})).some(x => x.id === 'real-data')), false);
 await p.locator('#tutorial-skip').click();
 assert.equal(await p.evaluate(() => localStorage.getItem('wb-store-events')), '[{"id":"real-data"}]');
 console.log('PASS Korean demo keeps sample data in private memory');
} finally { await b.close(); }
