import assert from "node:assert/strict";
import { chromium } from "./browser.mjs";

const browser = await chromium.launch();
try {
  const unseen = await browser.newPage();
  await unseen.addInitScript(() => {
    window.__mockMetadata = { ...window.__mockMetadata, version: "0.15.0" };
  });
  await unseen.goto("http://localhost:8765/settings.html?page=general&lang=en");
  await unseen.waitForSelector('[data-page="general"]:not([hidden])');
  assert.equal(
    await unseen.evaluate(() => JSON.parse(localStorage.getItem("wb-store-help"))?.whatsNewSeen ?? null),
    null,
    "opening another Settings page does not consume What's New",
  );
  await unseen.locator('.set-nav button[data-page="tutorial"]').click();
  await unseen.waitForFunction(() => JSON.parse(localStorage.getItem("wb-store-help"))?.whatsNewSeen === "0.15.0");
  await unseen.close();

  const tutorial = await browser.newPage();
  await tutorial.addInitScript(() => {
    window.__mockMetadata = { ...window.__mockMetadata, version: "0.15.0" };
  });
  await tutorial.goto("http://localhost:8765/settings.html?page=tutorial.new&lang=en");
  await tutorial.waitForSelector('[data-page="tutorial"]:not([hidden])');

  assert.equal(await tutorial.locator('.set-nav button[data-page="tutorial"]').count(), 1);
  assert.equal(await tutorial.locator('.set-nav button[data-page="guide"]').count(), 1);
  assert.equal(await tutorial.locator(".help-level").count(), 3, "the ledger groups every feature into three levels");
  const catalogue = (await import("../ui/help/catalogue.json", { with: { type: "json" } })).default;
  const ledger = catalogue.filter((e) => e.kind === "ledger");
  assert.equal(await tutorial.locator(".help-ledger-item").count(), ledger.length, "every ledger entry is visible from the start");
  const fresh = ledger.filter((e) => e.since === "0.15.0").length;
  assert.equal(await tutorial.locator("#tutorial-whats-new .help-entry").count(), fresh, "What's New lists every ledger entry new in v0.15.0");

  await tutorial.locator("#tutorial-replay").click();
  assert.deepEqual(await tutorial.evaluate(() => window.__native.at(-1)), [
    "open_demo",
    { origin: "settings", focus: null },
  ]);

  const guide = await browser.newPage();
  await guide.goto("http://localhost:8765/settings.html?page=guide.timer&lang=en");
  await guide.waitForSelector('[data-page="guide"]:not([hidden])');
  assert.equal(await guide.locator(".help-guide-item").count(), catalogue.filter((e) => e.kind === "guide").length, "the Guide has one entry per host widget type");
  assert.equal(await guide.locator('[data-guide="timer"].help-focus').count(), 1, "the route focuses the requested Guide entry");
  assert.equal(await guide.locator('[data-guide="timer"] h4').count(), 3, "Timer explains all three modes");
  assert.deepEqual(
    await guide.locator('[data-guide="timer"] h4').allTextContents(),
    ["Timer", "Stopwatch", "Pomodoro"],
    "mode headings reuse the labels shown in the app",
  );
  assert.equal(await guide.locator('[data-guide="timer"] p').count(), 4, "mode explanations remain paragraphs");

  await guide.locator('[data-guide-try="timer"]').click();
  assert.deepEqual(await guide.evaluate(() => window.__native.at(-1)), [
    "open_demo",
    { origin: "settings", focus: "timer" },
  ]);
  console.log("PASS Settings renders the tutorial ledger, What's New and focused Guide replay");
} finally {
  await browser.close();
}
