import assert from "node:assert/strict";
import { chromium, ready } from "./browser.mjs";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:8765/index.html?demo&lang=en");
  await ready(page);
  assert.equal(await page.locator("#tutorial-card").count(), 1, "tutorial opens on the demo");
  assert.match(await page.locator("#tutorial-card").innerText(), /Right-click/i);
  await page.locator("#demo-tray").click({ button: "right" });
  await page.waitForFunction(() => document.querySelector("#tutorial-card")?.textContent.includes("Choose Edit layout"));
  await page.evaluate(() => window.__mock.menus.at(-1).find((item) => item.text === "Edit layout").action());
  await page.waitForFunction(() => document.body.classList.contains("edit"));
  assert.match(await page.locator("#tutorial-card").innerText(), /grid/i);
  await page.locator("#tutorial-skip").click();
  assert.equal(await page.locator("#tutorial-card").count(), 0);
  assert.equal(await page.evaluate(() => window.__mock.closed), true);

  const keys = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await keys.goto("http://localhost:8765/index.html?demo&lang=en");
  await ready(keys);
  const step = async (n) => assert.equal(await keys.locator("#tutorial-count").textContent(), `${n} / 10`);
  await step(1);
  await keys.keyboard.press("Enter");
  await step(2);
  await keys.locator("#tutorial-next").focus();
  await keys.keyboard.press("Enter");
  await step(3); // the global Return control and the focused button must not advance twice
  await keys.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Return", bubbles: true })));
  await step(4);
  console.log("PASS tutorial opens, advances and skips");
} finally { await browser.close(); }
