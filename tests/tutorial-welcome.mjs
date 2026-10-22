import assert from "node:assert/strict";
import { chromium, ready } from "./browser.mjs";
const browser = await chromium.launch();
try {
 const page = await browser.newPage();
 await page.goto("http://localhost:8765/index.html?lang=en");
 await ready(page);
 assert.equal(await page.locator("#wc-try").count(), 1, "welcome offers the demo");
 assert.equal(await page.locator("#wc-presets").isVisible(), false);
 await page.locator("#wc-try").click();
 await page.evaluate(() => window.__mock.emit("demo-closed", { origin: "board-0" }));

 assert.equal(await page.locator("#wc-presets").isVisible(), true);

 const escape = await browser.newPage();
 await escape.goto("http://localhost:8765/index.html?lang=en");
 await ready(escape);
 await escape.keyboard.press("Escape");
 assert.equal(await escape.locator("#wc-presets").isVisible(), true, "Escape from the introduction reaches preset choice");
 console.log("PASS welcome offers demo and skip reaches presets");
} finally { await browser.close(); }

