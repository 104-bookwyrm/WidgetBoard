import assert from "node:assert/strict";
import { chromium, ready } from "./browser.mjs";
const b = await chromium.launch();
try {
 const p = await b.newPage({viewport:{width:1920,height:1080}});
 await p.goto('http://localhost:8765/index.html?demo&lang=en'); await ready(p);
 const step = async n => assert.equal(await p.locator('#tutorial-count').textContent(), `${n} / 10`);
 const drag = async (selector, dx, dy) => { const box = await p.locator(selector).boundingBox(); assert.ok(box, selector); const x=box.x+box.width/2,y=box.y+box.height/2; await p.mouse.move(x,y); await p.mouse.down(); await p.mouse.move(x+dx,y+dy,{steps:5}); await p.mouse.up(); };
 await step(1); await p.locator('#demo-tray').click({button:'right'});
 await step(2); await p.evaluate(() => window.__mock.menus.at(-1).find(x => x.text === 'Edit layout').action());
 await step(3); await p.locator('#tutorial-next').click();
 await step(4); await drag('[data-id="demo-timer"] .w-head',-90,90);
 await step(5); await drag('[data-id="demo-timer"] .w-resize',90,0);
 await step(6); await drag('[data-id="demo-timer"] .w-head',90,-90);
 await step(7); await p.locator('[data-id="demo-timer"] .w-head').click({button:'right'});
 await step(8); await p.locator('#board').click({button:'right',position:{x:50,y:850}});
 await p.evaluate(() => { const find = items => { for (const x of items) { if (x.text === 'Memo' && x.action) return x; if (x.items) { const y = find(x.items); if (y) return y; } } }; const item = find(window.__mock.menus.at(-1)); if (!item) throw Error('Memo menu item missing'); item.action(); });
 await step(9); await p.locator('#edit-done').click();
 await step(10); await p.locator('#tutorial-next').click();
 assert.equal(await p.evaluate(() => window.__mock.closed), true);
 console.log('PASS tutorial interaction path');
} finally { await b.close(); }
