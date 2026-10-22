import assert from "node:assert/strict";
import { chromium, ready } from "./browser.mjs";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:8765/index.html?demo&lang=en&focus=diary");
  await ready(page);

  const diary = page.locator('.widget[data-widget="diary"]');
  assert.equal(await diary.count(), 1, "focused replay adds a sample widget when the base dataset lacks that type");
  assert.equal(await diary.isVisible(), true);
  assert.equal(await diary.evaluate((el) => el.classList.contains("tutorial-target")), true);
  assert.equal(await page.locator("#tutorial-count").count(), 0, "focused replay does not start the ten-step tour");
  assert.match(await page.locator("#tutorial-card").innerText(), /Diary/i);

  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.__mock.closed), true, "Return closes the focused replay");

  const small = await browser.newPage({ viewport: { width: 480, height: 360 } });
  await small.goto("http://localhost:8765/index.html?demo&lang=en&focus=showcase");
  await ready(small);
  assert.equal(await small.locator('[data-widget="showcase"].tutorial-target').count(), 1, "the focused widget packs first on the minimum demo size");
  console.log("PASS guide replay focuses the requested widget and accepts Return");
} finally {
  await browser.close();
}
