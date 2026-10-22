import assert from "node:assert/strict";
import { chromium, ready, settled } from "./browser.mjs";

const seededPage = async (browser, { widgets = [], help = {}, welcomed = true, justUpdated = null } = {}) => {
  const page = await browser.newPage();
  await page.addInitScript(
    ({ widgets, help, welcomed, justUpdated }) => {
      if (!sessionStorage.getItem("wb-test-seeded")) {
        localStorage.setItem("wb-widgets", JSON.stringify(widgets));
        localStorage.setItem("wb-store-help", JSON.stringify({
          demoDone: false,
          hintsSeen: [],
          typesUsed: [],
          whatsNewSeen: null,
          ...help,
        }));
        localStorage.setItem("wb-store-welcomed", JSON.stringify(welcomed));
        sessionStorage.setItem("wb-test-seeded", "1");
      }
      window.__mockJustUpdated = justUpdated;
    },
    { widgets, help, welcomed, justUpdated },
  );
  return page;
};

const browser = await chromium.launch();
try {
  const firstRun = await seededPage(browser, { welcomed: false });
  await firstRun.goto("http://localhost:8765/index.html?lang=en");
  await ready(firstRun);
  await firstRun.locator("#wc-skip").click();
  await firstRun.locator("#wc-blank").click();
  const trayHint = firstRun.locator('[data-help-id="hint.tray_pin"]');
  await trayHint.waitFor();
  assert.equal(await firstRun.locator(".help-tray-pin").count(), 1, "the tray hint includes its animated pin");
  assert.match(await trayHint.textContent(), /taskbar/i);
  await trayHint.locator("button").dispatchEvent("keydown", { key: "Return" });
  await trayHint.waitFor({ state: "detached" });
  assert.ok(
    await firstRun.evaluate(() => JSON.parse(localStorage.getItem("wb-store-help")).hintsSeen.includes("hint.tray_pin")),
    "the tray hint is persisted as seen",
  );
  await firstRun.reload();
  await ready(firstRun);
  assert.equal(await firstRun.locator('[data-help-id="hint.tray_pin"]').count(), 0, "the tray hint is shown once");
  await firstRun.close();

  const memo = {
    id: "memo-onboarding",
    type: "memo",
    display: "D1",
    x: 0,
    y: 0,
    w: 3,
    h: 2,
    settings: { text: "" },
  };
  const edit = await seededPage(browser, {
    widgets: [memo],
    help: { hintsSeen: ["hint.tray_pin"] },
  });
  await edit.goto("http://localhost:8765/index.html?lang=en");
  await ready(edit);
  await edit.evaluate(() => window.__mock.emit("edit-mode", true));
  const editHint = edit.locator('[data-help-id="hint.edit_first"]');
  await editHint.waitFor();
  assert.ok(
    await edit.evaluate(() => JSON.parse(localStorage.getItem("wb-store-help")).hintsSeen.includes("hint.edit_first")),
    "the first edit hint is persisted as seen",
  );
  await edit.keyboard.press("Enter");
  await editHint.waitFor({ state: "detached" });
  await edit.evaluate(() => window.__mock.emit("edit-mode", false));
  await edit.reload();
  await ready(edit);
  await edit.evaluate(() => window.__mock.emit("edit-mode", true));
  assert.equal(await edit.locator('[data-help-id="hint.edit_first"]').count(), 0, "the edit hint is shown once");
  await edit.close();

  const manual = await seededPage(browser, {
    widgets: [memo],
    help: { hintsSeen: ["hint.tray_pin", "hint.edit_first"] },
  });
  await manual.goto("http://localhost:8765/index.html?lang=en");
  await ready(manual);
  await manual.evaluate(() => window.__mock.emit("add-widget", "clock"));
  await settled(manual);
  const pin = manual.locator('[data-guide-pin="clock"]');
  await pin.waitFor();
  await pin.click();
  assert.deepEqual(
    await manual.evaluate(() => window.__native.at(-1)),
    ["open_settings", { page: "guide.clock" }],
    "the first-use pin opens the exact Guide entry",
  );
  assert.ok(
    await manual.evaluate(() => JSON.parse(localStorage.getItem("wb-store-help")).typesUsed.includes("clock")),
    "the first manual use is persisted",
  );
  await manual.evaluate(() => window.__mock.emit("add-widget", "clock"));
  await settled(manual);
  assert.equal(await manual.locator('[data-guide-pin="clock"]').count(), 0, "the pin does not repeat for a used type");
  await manual.close();

  const preset = await seededPage(browser, {
    help: { hintsSeen: ["hint.edit_first"] },
    welcomed: false,
  });
  await preset.goto("http://localhost:8765/index.html?lang=en");
  await ready(preset);
  await preset.locator("#wc-skip").click();
  await Promise.all([
    preset.waitForEvent("framenavigated"),
    preset.locator('[data-preset="work"]').click(),
  ]);
  await ready(preset);
  await preset.locator('[data-help-id="hint.tray_pin"]').waitFor();
  assert.deepEqual(
    await preset.evaluate(() => JSON.parse(localStorage.getItem("wb-store-help")).typesUsed),
    [],
    "preset widgets do not consume first-use pins",
  );
  assert.equal(await preset.locator("[data-guide-pin]").count(), 0);
  await preset.close();

  const update = await seededPage(browser, {
    widgets: [memo],
    help: { hintsSeen: ["hint.tray_pin", "hint.edit_first"] },
    justUpdated: "0.15.0",
  });
  await update.goto("http://localhost:8765/index.html?lang=en");
  await ready(update);
  await update.waitForFunction(() =>
    window.__native?.some(([cmd, args]) => cmd === "open_settings" && args?.page === "tutorial.new"),
  );

  const shared = await browser.newContext();
  await shared.addInitScript(() => {
    localStorage.setItem("wb-store-welcomed", "true");
    localStorage.setItem("wb-store-help", JSON.stringify({
      demoDone: false,
      hintsSeen: ["hint.tray_pin"],
      typesUsed: [],
      whatsNewSeen: null,
    }));
  });
  const [primary, secondary] = await Promise.all([shared.newPage(), shared.newPage()]);
  await Promise.all([
    primary.goto("http://localhost:8765/index.html?lang=en&display=D1"),
    secondary.goto("http://localhost:8765/index.html?lang=en&display=D2"),
  ]);
  await Promise.all([ready(primary), ready(secondary)]);
  await primary.evaluate(() => window.__mock.invoke("set_edit_mode", { on: true }));
  await primary.locator('[data-help-id="hint.edit_first"]').waitFor();
  assert.equal(await secondary.locator('[data-help-id="hint.edit_first"]').count(), 0, "only the primary board shows the shared edit hint");
  // ponytail: no simultaneous two-board pin claim here. The mock's rev check is not atomic across browser
  // processes (localStorage lags between pages); Rust's with_rev holds a mutex, so the real app claims once.
  await shared.close();
  console.log("PASS onboarding hints persist, first-use pins stay manual, and updates open What's New");
} finally {
  await browser.close();
}
