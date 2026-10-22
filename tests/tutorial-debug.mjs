import assert from 'node:assert/strict';
import { chromium, ready } from './browser.mjs';
const b = await chromium.launch();
try {
 const p = await b.newPage();
 await p.addInitScript(() => { window.__tutorialDebug = true; localStorage.setItem('wb-store-welcomed', JSON.stringify(true)); });
 await p.goto('http://localhost:8765/index.html?lang=en'); await ready(p);
 assert.equal(await p.locator('#welcome').isVisible(), true, 'debug launch reopens first-run welcome');
 await p.locator('#wc-skip').click();
 assert.equal(await p.locator('#wc-presets').isVisible(), true);
 console.log('PASS debug first-run trigger');
} finally { await b.close(); }

