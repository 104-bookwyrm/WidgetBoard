// v0.11: update UI (the Rust updater itself is covered by tools/updater-test)
import { chromium } from "./browser.mjs";
// ponytail: default = playwright's own browser; PW_CHROMIUM env overrides for other environments
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
async function page(lang = "ko") {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on("pageerror", (e) => errs.push(e.message));
  p.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !/404|mock failure/.test(m.text()) &&
      errs.push(m.text()),
  );
  await p.goto(`http://localhost:8765/index.html?lang=${lang}`);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(500);
  return p;
}
// The update controls live in the settings window (tests/v12.mjs). The board only shows the
// toasts Rust sends and flushes pending saves before a restart.
{
  const p = await page();
  const toastText = () => p.$eval("#toast", (e) => e.textContent);
  await p.evaluate(() => window.__mock.emit("update-failed", "not_configured"));
  ok(
    /주소가 설정되지 않았습니다/.test(await toastText()),
    "manual check explains what is missing",
  );
  await p.evaluate(() => window.__mock.emit("toast", "upd.latest"));
  ok(/최신 버전/.test(await toastText()), "up-to-date message");
  await p.evaluate(() =>
    window.__mock.emit("update-available", { version: "0.12.0" }),
  );
  const tt = await toastText();
  ok(
    /0\.12\.0/.test(tt) && /자세히/.test(tt),
    "found toast offers details",
    tt,
  );
  await p.click("#toast button");
  ok(
    (await p.evaluate(() => window.__native || [])).some(
      ([c, a]) => c === "open_settings" && a?.page === "about",
    ),
    "details opens the settings window on the about page",
  );
  // flush-saves (sent by Rust before an update restart, and from the tray)
  await p.evaluate(() => window.__mock.emit("add-widget", "memo"));
  await p.waitForTimeout(300);
  await p.fill(".memo textarea", "저장돼야 함");
  await p.evaluate(() => {
    document.activeElement.blur();
    window.__mock.emit("flush-saves");
  });
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () =>
        JSON.parse(localStorage.getItem("wb-widgets")).find(
          (w) => w.type === "memo",
        )?.settings.text,
    )) === "저장돼야 함",
    "flush-saves event writes immediately",
  );
  await p.evaluate(() => window.__mock.emit("update-failed", "HTTP 404"));
  ok(/HTTP 404/.test(await toastText()), "failure shown with reason");
  await p.close();
}
console.log(`\n${passes} passed, ${fails} failed`);
console.log("page errors:", JSON.stringify(errs));
await b.close();
