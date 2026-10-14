// Free placement (Settings → 배치 방식 → 자유 배치): pixel positions up to the screen edges, any size, overlap with a
// stacking order, snap guides (Alt: none), and each mode keeping its own arrangement.
import { chromium, ready, settled } from "./browser.mjs";
const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
let fails = 0,
  passes = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) passes++;
  else {
    fails++;
    console.log("FAIL:", msg, extra);
  }
};
const errs = [];
const VW = 1440,
  VH = 810;

async function page(widgets, ui = {}) {
  const p = await b.newPage({ viewport: { width: VW, height: VH } });
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && !/404|mock failure/.test(m.text()) && errs.push(m.text()));
  await p.goto("http://localhost:8765/index.html?lang=ko");
  await p.evaluate(
    ({ widgets, ui }) => {
      localStorage.clear();
      localStorage.setItem("wb-widgets", JSON.stringify(widgets));
      if (Object.keys(ui).length) localStorage.setItem("wb-config", JSON.stringify({ ...(window.__mockConfig ?? {}), ui }));
    },
    { widgets, ui },
  );
  await p.reload();
  await ready(p);
  return p;
}
const setMode = async (p, mode) => {
  await p.evaluate((mode) => __mock.invoke("save_config", { patch: { ui: { layoutMode: mode } } }), mode);
  await p.waitForTimeout(150);
};
const rect = (p, id) =>
  p.$eval(`.widget[data-id="${id}"]`, (e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) };
  });
const saved = (p, id) => p.evaluate((id) => __mock.widgets().find((w) => w.id === id), id);
const memo = (id, x, y, w = 3, h = 3) => ({ id, type: "memo", x, y, w, h, settings: { text: id } });
/** Drag a widget by its top strip (or its resize corner) by dx, dy px; `alt` holds Alt. */
async function drag(p, id, dx, dy, { resize = false, alt = false, check } = {}) {
  const sel = `.widget[data-id="${id}"] ${resize ? ".w-resize" : ".w-head"}`;
  await p.hover(`.widget[data-id="${id}"]`);
  const bb = await (await p.$(sel)).boundingBox();
  const sx = bb.x + (resize ? bb.width / 2 : 40),
    sy = bb.y + bb.height / 2;
  await p.mouse.move(sx, sy);
  if (alt) await p.keyboard.down("Alt");
  await p.mouse.down();
  await p.mouse.move(sx + dx, sy + dy, { steps: 8 });
  const during = check ? await check() : null;
  await p.mouse.up();
  if (alt) await p.keyboard.up("Alt");
  await p.waitForTimeout(250);
  return during;
}
const guides = (p) => p.evaluate(() => document.querySelectorAll("#guides i").length);
const topAt = (p, x, y) => p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".widget")?.dataset.id, { x, y });

// ===== 1. switching to free keeps every widget where it was =====
{
  const p = await page([memo("a", 0, 0), memo("b", 4, 0), memo("c", 0, 4, 2, 2)]);
  const before = { a: await rect(p, "a"), b: await rect(p, "b"), c: await rect(p, "c") };
  await setMode(p, "free");
  ok(await p.$eval("#board", (e) => e.classList.contains("free")), "1: board in free mode");
  const after = { a: await rect(p, "a"), b: await rect(p, "b"), c: await rect(p, "c") };
  ok(JSON.stringify(before) === JSON.stringify(after), "1: nothing moves on the switch", JSON.stringify({ before, after }));
  await settled(p);
  const sa = await saved(p, "a");
  ok(sa.free && sa.free.x === before.a.x && sa.free.w === before.a.w, "1: free rect saved", JSON.stringify(sa.free));

  // ===== 2. the edges: drag to within a few px of the right edge → flush; Alt → exact =====
  const a0 = await rect(p, "a");
  const during = await drag(p, "a", VW - a0.r - 4, 0, { check: () => guides(p) });
  let a = await rect(p, "a");
  ok(a.r === VW, "2: right edge flush with the screen (the old unreachable strip)", JSON.stringify(a));
  ok(during > 0 && (await guides(p)) === 0, "2: guides while dragging, gone after", during);
  await drag(p, "a", 0, VH - a.b - 3);
  a = await rect(p, "a");
  ok(a.b === VH && a.r === VW, "2: bottom-right corner reachable", JSON.stringify(a));
  await drag(p, "a", -33, -27, { alt: true });
  const a2 = await rect(p, "a");
  ok(a2.r === VW - 33 && a2.b === VH - 27, "2: Alt places exactly, no snapping", JSON.stringify(a2));
  await drag(p, "a", 500, 500);
  ok((await rect(p, "a")).r === VW && (await rect(p, "a")).b === VH, "2: can't be dragged off the screen");

  // ===== 3. snapping to another widget: left edges line up =====
  const bR = await rect(p, "b");
  const cR = await rect(p, "c");
  await drag(p, "c", bR.x - cR.x + 5, 300, { alt: false });
  ok((await rect(p, "c")).x === bR.x, "3: left edge sticks to the other widget's left edge", JSON.stringify({ b: bR, c: await rect(p, "c") }));

  // ===== 4. overlap + stacking =====
  const b1 = await rect(p, "b");
  const c1 = await rect(p, "c");
  await drag(p, "c", b1.x + 30 - c1.x, b1.y + 30 - c1.y, { alt: true });
  const c2 = await rect(p, "c");
  ok(c2.x === b1.x + 30 && c2.y === b1.y + 30, "4: dropped overlapping another widget", JSON.stringify(c2));
  const px = c2.x + 20,
    py = c2.y + 40;
  ok((await topAt(p, px, py)) === "c", "4: the later widget is in front");
  // drag b (behind) by its uncovered top strip
  await p.mouse.move(b1.x + 40, b1.y + 10);
  await p.waitForTimeout(100);
  await p.keyboard.down("Alt");
  await p.mouse.down();
  await p.mouse.move(b1.x + 50, b1.y + 14, { steps: 4 });
  await p.mouse.up();
  await p.keyboard.up("Alt");
  ok((await rect(p, "b")).x === b1.x + 10 && (await topAt(p, px, py)) === "c", "4: moving a widget leaves the order alone (art-program layers)");
  await p.click(`.widget[data-id="c"]`, { button: "right", position: { x: 60, y: 8 } });
  await p.evaluate(() => __mock.menus.at(-1).find((i) => i.text === "맨 뒤로").action());
  ok((await topAt(p, px, py)) === "b", "4: 맨 뒤로 sends it behind");
  await p.$eval(`.widget[data-id="c"]`, (e) => e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))); // it is hidden behind b now
  ok(!!(await p.evaluate(() => __mock.menus.at(-1).find((i) => i.text === "맨 앞으로"))), "4: 맨 앞으로 in the menu");

  // ===== 5. any size, but not below the minimum =====
  const bb0 = await rect(p, "b");
  await drag(p, "b", 37, 13, { resize: true, alt: true });
  const bb1 = await rect(p, "b");
  ok(bb1.w === bb0.w + 37 && bb1.h === bb0.h + 13, "5: resized by pixels", JSON.stringify({ bb0, bb1 }));
  await drag(p, "b", -2000, -2000, { resize: true });
  const bb2 = await rect(p, "b");
  ok(bb2.w === 170 && bb2.h === 170, "5: stops at the memo's minimum (2×2 = 170 px)", JSON.stringify(bb2));

  // ===== 6. keyboard =====
  await p.focus(`.widget[data-id="b"] .grip`);
  await p.keyboard.press("ArrowRight"); await p.waitForTimeout(250); // the 0.12 s slide
  ok((await rect(p, "b")).x === bb2.x + 10, "6: arrow moves 10 px", JSON.stringify([bb2, await rect(p, "b")]));
  await p.keyboard.press("Alt+ArrowDown"); await p.waitForTimeout(250); // the 0.12 s slide
  ok((await rect(p, "b")).y === bb2.y + 1, "6: Alt+arrow moves 1 px");
  await p.keyboard.press("Shift+ArrowRight"); await p.waitForTimeout(250); // the 0.12 s slide
  ok((await rect(p, "b")).w === 180, "6: Shift+arrow resizes");

  // ===== 7. persistence =====
  await settled(p);
  const keep = { a: await rect(p, "a"), b: await rect(p, "b"), c: await rect(p, "c") };
  await p.reload();
  await ready(p);
  const back = { a: await rect(p, "a"), b: await rect(p, "b"), c: await rect(p, "c") };
  ok(JSON.stringify(keep) === JSON.stringify(back), "7: free layout survives a restart", JSON.stringify({ keep, back }));
  ok((await topAt(p, px, py)) === "b", "7: stacking order survives too");

  // ===== 8. back to the grid: the grid arrangement returns; a widget added while free gets its own cell =====
  await p.evaluate(() => document.body.classList.add("edit"));
  await setMode(p, "grid");
  ok(JSON.stringify(await rect(p, "a")) === JSON.stringify(before.a), "8: grid positions come back", JSON.stringify(await rect(p, "a")));
  await setMode(p, "free");
  ok(JSON.stringify(await rect(p, "b")) === JSON.stringify(keep.b), "8: …and the free ones when switching again");
  await p.close();
}

// ===== 9. adding while free: next to the others; with the grid full, still added; grid tidies on return =====
{
  const full = [];
  for (let y = 0; y + 3 <= 8; y += 3) for (let x = 0; x + 3 <= 15; x += 3) full.push(memo(`m${x}-${y}`, x, y));
  const p = await page(full, { layoutMode: "free" });
  const n0 = await p.$$eval(".widget", (e) => e.length);
  await p.evaluate(() => __mock.emit("add-widget", "clock"));
  await p.waitForTimeout(300);
  const n1 = await p.$$eval(".widget", (e) => e.length);
  ok(n1 === n0 + 1, "9: a widget can be added even when the grid is full", `${n0} → ${n1}`);
  const clock = await p.evaluate(() => __mock.widgets().find((w) => w.type === "clock"));
  await setMode(p, "grid");
  await settled(p);
  const overl = await p.evaluate(() => {
    const ws = __mock.widgets();
    let n = 0;
    for (const a of ws) for (const b of ws) if (a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++;
    return n;
  });
  ok(!!clock && overl === 0, "9: back on the grid nothing overlaps (room was found)", overl);
  await p.close();
}

// ===== 10. a smaller screen brings free widgets back inside =====
{
  const p = await page([memo("a", 0, 0)], { layoutMode: "free" });
  await drag(p, "a", 2000, 2000);
  await p.setViewportSize({ width: 1000, height: 600 });
  await p.waitForTimeout(1200);
  const a = await rect(p, "a");
  ok(a.r <= 1000 && a.b <= 600 && a.r === 1000, "10: clamped inside the smaller board", JSON.stringify(a));
  await p.close();
}

// ===== 11. simple mode is untouched: cells and push-aside =====
{
  const p = await page([memo("a", 0, 0), memo("b", 3, 0)]);
  await drag(p, "a", 95, 0);
  await settled(p);
  const ws = await p.evaluate(() => __mock.widgets().map((w) => [w.id, w.x, w.y, !!w.free]));
  ok(JSON.stringify(ws) === JSON.stringify([["a", 1, 0, false], ["b", 4, 0, false]]) ||
     JSON.stringify(ws.sort()) === JSON.stringify([["a", 1, 0, false], ["b", 4, 0, false]]),
     "11: grid drag still pushes the neighbour one cell", JSON.stringify(ws));
  await p.close();
}

// ===== 12. layers: one order per widget, the panel, lock, shortcuts, select below, open panels on top =====
{
  const pomo = { id: "p", type: "pomodoro", x: 0, y: 0, w: 3, h: 3, settings: {} };
  const p = await page([memo("a", 0, 0), memo("b", 0, 0), pomo], { layoutMode: "free" });
  await p.waitForTimeout(700);
  await settled(p);
  const zs = await p.evaluate(() => __mock.widgets().map((w) => w.z).sort().join());
  ok(zs === "1,2,3", "12: each widget has its own layer", zs);
  const a0 = await rect(p, "a");
  const px = a0.x + 60,
    py = a0.y + 60;
  ok((await topAt(p, px, py)) === "p", "12: the last one added is in front");
  await p.click(`.widget[data-id="p"]`, { button: "right", position: { x: 60, y: 60 } });
  const pick = await p.evaluate(() => __mock.menus.at(-1).find((i) => i.text === "아래 위젯 선택")?.items.map((i) => i.text));
  ok(pick?.length === 2, "12: select below lists the two widgets under the pointer", JSON.stringify(pick));
  await p.evaluate(() => __mock.menus.at(-1).find((i) => i.text === "레이어").action());
  const rows = () => p.$$eval("#layers-list li", (ls) => ls.map((l) => l.dataset.id).join());
  ok((await rows()) === "p,b,a", "12: the panel lists front first", await rows());
  await p.dragAndDrop('#layers-list li[data-id="a"] .ly-name', '#layers-list li[data-id="p"] .ly-name', { targetPosition: { x: 5, y: 2 } });
  ok((await rows()) === "a,p,b" && (await topAt(p, px, py)) === "a", "12: dragging a row to the top brings it to the front", await rows());
  await p.click('#layers-list li[data-id="a"] [data-l=eye]');
  await settled(p);
  ok((await saved(p, "a")).hidden === true, "12: the eye hides it");
  await p.click('#layers-list li[data-id="a"] [data-l=eye]');
  await p.click('#layers-list li[data-id="b"] [data-l=lock]');
  const b0 = await rect(p, "b");
  await p.click('#layers-list li[data-id="b"] [data-l=pick]');
  ok((await p.evaluate(() => document.activeElement?.closest(".widget")?.dataset.id)) === "b", "12: picking a row selects it");
  await p.keyboard.press("ArrowRight");
  ok((await rect(p, "b")).x === b0.x, "12: a locked widget does not move");
  await p.click('#layers-list li[data-id="b"] [data-l=lock]');
  await p.click('#layers-list li[data-id="b"] [data-l=pick]');
  await p.keyboard.press("ArrowRight");
  await settled(p); // the slide into place
  ok((await rect(p, "b")).x === b0.x + 10, "12: unlocked, the arrow keys move it again", JSON.stringify(await rect(p, "b")));
  await p.keyboard.press("Control+Shift+BracketRight");
  ok((await topAt(p, px + 10, py)) === "b" && (await rows()).startsWith("b"), "12: Ctrl+Shift+] brings it to the front", await rows());
  await p.keyboard.press("Control+BracketLeft");
  ok((await rows()).split(",")[1] === "b", "12: Ctrl+[ sends it one layer back", await rows());
  // a widget with its own panel open sits on top while the panel is open
  await p.evaluate(() => document.querySelector('.widget[data-id="p"] .pm-link').click());
  ok((await p.$eval('.widget[data-id="p"]', (e) => getComputedStyle(e).zIndex)) === "99999", "12: an open panel lifts its widget");
  await p.evaluate(() => document.querySelector('.widget[data-id="p"] [data-a=set-close]').click());
  ok((await p.$eval('.widget[data-id="p"]', (e) => getComputedStyle(e).zIndex)) !== "99999", "12: and drops back when it closes");
  // the order survives a reload (z is saved per widget)
  const before = await rows();
  await settled(p);
  await p.reload();
  await ready(p);
  await p.evaluate(() => __mock.menus.length = 0);
  await p.click(`.widget[data-id="${before.split(",")[0]}"]`, { button: "right", position: { x: 60, y: 8 } });
  await p.waitForFunction(() => __mock.menus.length > 0);
  await p.evaluate(() => __mock.menus.at(-1).find((i) => i.text === "레이어").action());
  ok((await rows()) === before, "12: the order survives a reload", `${before} → ${await rows()}`);
  await p.close();
}

await b.close();
console.log(`\n${passes} passed, ${fails} failed`);
console.log("page errors:", errs);
process.exit(fails || errs.length ? 1 : 0);
