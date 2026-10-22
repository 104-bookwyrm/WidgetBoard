import assert from "node:assert/strict";
import test from "node:test";

import { artifact, chromium } from "./browser.mjs";

let browser;
test.before(async () => {
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
});
test.after(async () => browser?.close());

test("the laboratory runs and inspects the naturalness audit", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://localhost:8765/dev/grid-placement-lab.html");

  await page.locator("#run-audit").click({ timeout: 1000 });
  const auditState = await page.locator("#audit-panel").evaluate((element) => ({ ...element.dataset }));
  assert.deepEqual(auditState, { total: "49", pass: "48", review: "1", fail: "0" });

  await page.locator('button[data-audit-id="former-dead-zone"]').click();
  assert.equal(await page.locator("#face-status").getAttribute("data-status"), "accepted");
  assert.equal(await page.locator("#movement-facts").getAttribute("data-neighbours"), "1");
  assert.equal(await page.locator("#intent-data").getAttribute("data-face"), "top");
  assert.match(await page.locator("#scenario option:checked").textContent({ timeout: 1000 }), /Former center dead zone/);

  await page.locator("#run-audit").click();
  await page.locator('button[data-audit-id="feasible-corner"]').click();
  assert.equal(await page.locator("#face-status").getAttribute("data-status"), "accepted");
  assert.equal(await page.locator("#intent-data").getAttribute("data-face"), "right");

  await page.locator("#run-audit").click();
  await page.locator('button[data-audit-id="locked-chain"]').click();
  assert.equal(await page.locator("#face-status").getAttribute("data-status"), "locked");
  assert.equal(await page.locator("#adopt-face").isDisabled(), true);
  await page.locator("#run-audit").click();
  assert.equal(await page.locator("#audit-results").evaluate((element) => element.scrollTop), 0);
  await page.setViewportSize({ width: 900, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: artifact("grid-placement-lab-audit.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});
