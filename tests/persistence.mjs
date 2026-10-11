import assert from "node:assert/strict";
import { chromium, ready } from "./browser.mjs";
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
let failed = 0;
const widget = (id, type, x = 0) => ({
  id,
  type,
  display: "D1",
  x,
  y: 0,
  w: 4,
  h: 4,
  settings: type === "memo" ? { text: "old", color: "yellow" } : {},
});
async function page(widgets, store = {}) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://localhost:8765/index.html?lang=en");
  await p.evaluate(
    ({ widgets, store }) => {
      localStorage.clear();
      localStorage.setItem("wb-widgets", JSON.stringify(widgets));
      for (const [k, v] of Object.entries(store))
        localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    },
    { widgets, store },
  );
  await p.reload();
  await ready(p);
  return p;
}
async function test(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (e) {
    failed++;
    console.error("FAIL", name, e.message);
  }
}
await test("saved layout restores latest stashed content and preserves other types", async () => {
  const w = widget("m", "memo");
  const p = await page(
    [
      {
        ...w,
        type: "timer",
        settings: { duration: 420000, remaining: 420000, endAt: null },
        stash: {
          memo: { text: "newest", color: "pink" },
          image: { imgs: ["kept.png"] },
        },
      },
    ],
    { "wb-store-layouts": [{ name: "saved", widgets: [w] }] },
  );
  await p.evaluate(() => __mock.emit("apply-layout", "saved"));
  await p.waitForFunction(() => !!document.querySelector(".memo textarea"));
  assert.equal(await p.locator(".memo textarea").inputValue(), "newest");
  const saved = await p.evaluate(
    () => JSON.parse(localStorage.getItem("wb-widgets"))[0],
  );
  assert.equal(saved.stash.timer.duration, 420000);
  assert.deepEqual(saved.stash.image.imgs, ["kept.png"]);
  assert.equal(saved.stash.memo, undefined);
  await p.close();
});
await test("layout flush captures memo text before the widget debounce", async () => {
  const w = widget("m", "memo");
  const p = await page([w], {
    "wb-store-layouts": [{ name: "saved", widgets: [w] }],
  });
  await p.evaluate(() => {
    const ta = document.querySelector(".memo textarea");
    ta.focus();
    ta.value = "last keystrokes";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    __mock.emit("apply-layout", "saved");
  });
  await p.waitForTimeout(700);
  assert.equal(
    await p.locator(".memo textarea").inputValue(),
    "last keystrokes",
  );
  await p.close();
});
await test("checklist edit commits to refreshed item by id", async () => {
  const p = await page(
    [widget("a", "checklist"), widget("b", "checklist", 5)],
    {
      "wb-store-checklist": [
        { id: "item", title: "original", date: "2020-01-01", done: false },
      ],
    },
  );
  await p.locator('[data-id="a"] .ck-title').dblclick();
  await p.locator('[data-id="a"] .ck-title input').fill("edited");
  await p.evaluate(() => {
    const items = JSON.parse(localStorage.getItem("wb-store-checklist"));
    items.push({
      id: "other",
      title: "added elsewhere",
      date: "2020-01-01",
      done: false,
    });
    localStorage.setItem("wb-store-checklist", JSON.stringify(items));
    __mock.emit("store-changed", { key: "checklist", src: "b" });
  });
  await p.waitForTimeout(50);
  await p.locator('[data-id="a"] .ck-title input').press("Enter");
  const saved = await p.evaluate(() =>
    JSON.parse(localStorage.getItem("wb-store-checklist")),
  );
  assert.equal(saved.find((x) => x.id === "item").title, "edited");
  assert.equal(saved.find((x) => x.id === "other").title, "added elsewhere");
  await p.close();
});
await test("diary navigation retains unsaved text on write failure and can retry", async () => {
  const p = await page([widget("d", "diary")], {
    "wb-diary-2020-01-01": "prior page",
  });
  await p.evaluate(() => {
    const ta = document.querySelector(".dy-text");
    ta.value = "unsaved";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    window.__mockFail = new Set(["diary_set"]);
    const picker = document.querySelector(".dy-picker");
    picker.value = "2020-01-01";
    picker.dispatchEvent(new Event("change"));
  });
  await p.waitForTimeout(100);
  assert.equal(await p.locator(".dy-text").inputValue(), "unsaved");
  assert.notEqual(await p.locator(".dy-status").textContent(), "");
  await p.evaluate(() => {
    window.__mockFail.clear();
    document.querySelector(".dy-picker").dispatchEvent(new Event("change"));
  });
  await p.waitForTimeout(100);
  assert.equal(await p.locator(".dy-text").inputValue(), "prior page");
  assert.equal(
    await p.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("wb-diary-"))
        .some((k) => localStorage.getItem(k) === "unsaved"),
    ),
    true,
  );
  await p.close();
});

await test("backup waits for memo and diary buffers on every board", async () => {
  const secondary = { ...widget("secondary", "memo"), display: "D2" };
  const p = await page([
    widget("m", "memo"),
    widget("d", "diary", 5),
    secondary,
  ]);
  const second = await p.context().newPage();
  await second.goto("http://localhost:8765/index.html?lang=en&display=D2");
  await ready(second);
  const settings = await p.context().newPage();
  await settings.goto("http://localhost:8765/settings.html?lang=en");
  await settings.waitForFunction(() => !!window.__mock);
  await p.evaluate(() => {
    window.__mockDelay = { diary_set: 250 };
    const ta = document.querySelector(".dy-text");
    ta.value = "new diary";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await second.evaluate(() => {
    window.__mockDelay = { put_widget: 400 };
    const ta = document.querySelector(".memo textarea");
    ta.value = "second monitor edit";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settings.evaluate(() => __mock.invoke("backup_now"));
  const snapshot = await settings.evaluate(() =>
    JSON.parse(localStorage.getItem("wb-backup-snapshot")),
  );
  assert.equal(
    snapshot.widgets.find((w) => w.id === "secondary").settings.text,
    "second monitor edit",
  );
  assert.ok(Object.values(snapshot.diary).includes("new diary"));
  await p.context().close();
});
await test("failed flush aborts layout replacement and retries the retained memo", async () => {
  const w = widget("m", "memo");
  const p = await page([w], {
    "wb-store-layouts": [
      {
        name: "saved",
        widgets: [{ ...w, type: "timer", settings: { duration: 1000 } }],
      },
    ],
  });
  await p.evaluate(() => {
    window.__mockFail = new Set(["put_widget"]);
    const ta = document.querySelector(".memo textarea");
    ta.value = "keep this";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    __mock.emit("apply-layout", "saved");
  });
  await p.waitForTimeout(900);
  assert.equal(await p.locator(".memo textarea").inputValue(), "keep this");
  assert.equal(
    await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-widgets"))[0].type,
    ),
    "memo",
  );
  await p.evaluate(() => {
    window.__mockFail.clear();
    __mock.emit("apply-layout", "saved");
  });
  await p.waitForFunction(() => !!document.querySelector(".timer"));
  assert.equal(
    await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-widgets"))[0].stash.memo.text,
    ),
    "keep this",
  );
  await p.close();
});
await test("diary navigation waits for an already-running save", async () => {
  const p = await page([widget("d", "diary")], {
    "wb-diary-2020-01-01": "older",
  });
  await p.evaluate(() => {
    window.__mockDelay = { diary_set: 200 };
    const ta = document.querySelector(".dy-text");
    ta.value = "pending";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("blur"));
    const picker = document.querySelector(".dy-picker");
    picker.value = "2020-01-01";
    picker.dispatchEvent(new Event("change"));
  });
  await p.waitForTimeout(50);
  assert.equal(await p.locator(".dy-text").inputValue(), "pending");
  await p.waitForFunction(
    () => document.querySelector(".dy-text").value === "older",
  );
  assert.ok(
    await p.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("wb-diary-"))
        .some((k) => localStorage.getItem(k) === "pending"),
    ),
  );
  await p.close();
});
await test("deleting an edited checklist item elsewhere does not resurrect it", async () => {
  const p = await page([widget("a", "checklist")], {
    "wb-store-checklist": [
      { id: "item", title: "original", date: "2020-01-01", done: false },
    ],
  });
  await p.locator(".ck-title").dblclick();
  await p.locator(".ck-title input").fill("edited");
  await p.evaluate(() => {
    localStorage.setItem("wb-store-checklist", "[]");
    __mock.emit("store-changed", { key: "checklist", src: "other" });
  });
  await p.waitForTimeout(50);
  await p.locator(".ck-title input").press("Enter");
  assert.deepEqual(
    await p.evaluate(() =>
      JSON.parse(localStorage.getItem("wb-store-checklist")),
    ),
    [],
  );
  await p.close();
});
await browser.close();
if (failed) process.exitCode = 1;
