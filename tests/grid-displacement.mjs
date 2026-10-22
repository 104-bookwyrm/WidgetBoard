import assert from 'node:assert/strict';
import { chromium, ready, settled } from './browser.mjs';
const b = await chromium.launch();
try {
 const p=await b.newPage({viewport:{width:1440,height:900}});
 await p.goto('http://localhost:8765/index.html?demo&lang=en'); await ready(p);
 await p.evaluate(()=>__mock.invoke('set_edit_mode',{on:true}));
 const before=await p.evaluate(()=>Object.fromEntries(__mock.widgets().map(({id,x,y,w,h})=>[id,{x,y,w,h}])));
 const h=await p.locator('[data-id="demo-clock"] .w-head').boundingBox();
 const x=h.x+h.width/2,y=h.y+h.height/2;
 await p.mouse.move(x,y); await p.mouse.down(); await p.mouse.move(x-540,y-90); await p.mouse.up(); await settled(p);
 const after=await p.evaluate(()=>Object.fromEntries(__mock.widgets().map(({id,x,y,w,h})=>[id,{x,y,w,h}])));
 assert.deepEqual(after['demo-clock'], { ...before['demo-clock'], x:3,y:3 });
 for (const id of ['demo-timer','demo-dday','demo-checklist','demo-calendar','demo-memo']) assert.deepEqual(after[id],before[id],`${id} should remain in place`);
 assert.notDeepEqual(after['demo-nowplaying'],before['demo-nowplaying']);
 assert.notDeepEqual(after['demo-image'],before['demo-image']);
 console.log('PASS available space avoids unnecessary collision chain');
 const narrow=await b.newPage({viewport:{width:910,height:280}});
 await narrow.addInitScript(() => localStorage.setItem('wb-widgets', JSON.stringify([
   {id:'a',type:'memo',x:0,y:0,w:3,h:3,settings:{}},
   {id:'b',type:'memo',x:3,y:0,w:3,h:3,settings:{}},
   {id:'c',type:'memo',x:6,y:0,w:3,h:3,settings:{}},
 ])));
 await narrow.goto('http://localhost:8765/index.html?lang=en'); await ready(narrow);
 await narrow.locator('.widget[data-id="a"] .grip').focus(); await narrow.keyboard.press('ArrowRight'); await settled(narrow);
 const positions=await narrow.evaluate(()=>Object.fromEntries(__mock.widgets().map(w=>[w.id,w.x])));
 assert.deepEqual(positions,{a:1,b:4,c:7});
 console.log('PASS necessary pushes still propagate');
} finally { await b.close(); }
