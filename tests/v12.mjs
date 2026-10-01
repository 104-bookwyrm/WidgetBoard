// v0.12: standalone settings window (settings.html).
// Increment 1 — window shell + General page. Increment 2 — Accessibility + About/updates pages.
// Increment 3 — Timer & calendar page (presets editor + holidays).
// Increment 4 — Backup & data page (backup/restore, auto schedule).
// Increment 5a — Appearance page (theme editor).
import { chromium } from "playwright";
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
async function page(
  lang = "ko",
  { width = 1024, height = 800, seedConfig, seedTheme } = {},
) {
  const p = await b.newPage({ viewport: { width, height } });
  p.on("pageerror", (e) => errs.push(e.message));
  p.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !/404|mock failure/.test(m.text()) &&
      errs.push(m.text()),
  );
  await p.goto(`http://localhost:8765/settings.html?lang=${lang}`);
  await p.evaluate(
    ({ cfg, theme }) => {
      localStorage.clear();
      if (cfg) localStorage.setItem("wb-config", JSON.stringify(cfg));
      if (theme) localStorage.setItem("wb-theme", theme);
    },
    { cfg: seedConfig, theme: seedTheme },
  );
  await p.reload();
  await p.waitForTimeout(300);
  return p;
}
const RAW = /\bset\.[a-z][a-z_.]+/; // an unresolved i18n key leaked into the DOM

// --- Korean: shell, nav, General controls ---
{
  const p = await page();
  const nav = await p.$$eval(".set-nav button", (bs) =>
    bs.map((b) => b.textContent.trim()),
  );
  ok(nav.length === 7, "seven sidebar pages", String(nav.length));
  ok(
    nav.join("|") ===
      "일반|모양|위젯과 배치|타이머 · 달력|접근성|백업 · 데이터|정보 · 업데이트",
    "nav localized (ko)",
    nav.join("|"),
  );
  ok((await p.title()) === "설정", "window title localized");
  const body = await p.$eval("body", (e) => e.innerText);
  ok(!RAW.test(body), "no raw keys visible (ko)", (body.match(RAW) || [])[0]);
  ok(
    await p.$eval(".set-main [data-page=general]", (s) => !s.hidden),
    "general shown by default",
  );

  // page switching keeps the nav visible (regression: nav buttons also carry data-page)
  await p.click(".set-nav button[data-page=about]");
  ok(
    await p.$eval(".set-main [data-page=about]", (s) => !s.hidden),
    "about page shows on click",
  );
  ok(
    await p.$eval(".set-main [data-page=general]", (s) => s.hidden),
    "general hidden after switch",
  );
  ok(
    await p.$eval(".set-nav button[data-page=general]", (btn) => !btn.hidden),
    "nav buttons stay visible",
  );
  await p.click(".set-nav button[data-page=general]");

  // autostart writes through and confirms
  await p.click("#set-autostart");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(() => localStorage.getItem("wb-autostart"))) === "1",
    "autostart persisted",
  );
  ok(
    await p.$eval(".set-saved", (e) => e.classList.contains("show")),
    "saved feedback shown",
  );

  // always-on-top routes to set_app
  await p.click("#set-ontop");
  await p.waitForTimeout(100);
  const native = await p.evaluate(() => window.__native || []);
  ok(
    native.some(([c, a]) => c === "set_app" && a.onTop === true),
    "onTop sent via set_app",
    JSON.stringify(native),
  );

  // week start writes ui.weekStart
  await p.selectOption("#set-weekstart", "sun");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).ui.weekStart,
    )) === "sun",
    "weekStart saved to config.ui.weekStart",
  );

  // language change re-renders the nav in the new language
  await p.selectOption("#set-lang", "en");
  await p.waitForTimeout(200);
  ok(
    (await p.$eval(".set-nav button[data-page=general]", (btn) =>
      btn.textContent.trim(),
    )) === "General",
    "nav re-renders after language change",
  );

  // Esc closes the window
  await p.keyboard.press("Escape");
  await p.waitForTimeout(50);
  ok(
    await p.evaluate(() => window.__mock.closed === true),
    "Esc closes the window",
  );
  await p.close();
}

// --- narrow layout: sidebar collapses to a <select> ---
{
  const p = await page("ko", { width: 500 });
  ok(
    (await p.$eval(".set-nav", (e) => getComputedStyle(e).display)) === "none",
    "sidebar hidden when narrow",
  );
  ok(
    (await p.$eval(".set-nav-select", (e) => getComputedStyle(e).display)) !==
      "none",
    "page select shown when narrow",
  );
  await p.selectOption(".set-nav-select", "timer");
  ok(
    await p.$eval(".set-main [data-page=timer]", (s) => !s.hidden),
    "select navigates pages",
  );
  await p.close();
}

// --- window mirrors the app's accessibility settings ---
{
  const p = await page("ko", {
    seedConfig: {
      ui: {
        highContrast: true,
        readableFont: "lexend",
        zoom: 1.5,
        shortLines: true,
      },
    },
  });
  const cls = await p.$eval("body", (e) => e.className);
  ok(/high-contrast/.test(cls), "high contrast applied", cls);
  ok(/font-lexend/.test(cls), "readable font applied", cls);
  ok(/short-lines/.test(cls), "short lines applied", cls);
  ok(
    (await p.$eval("html", (e) => e.style.zoom)) === "1.5",
    "zoom applied in-page",
  );
  await p.close();
}

// --- Accessibility page: ports the in-board a11y controls ---
{
  const p = await page("ko");
  await p.click(".set-nav button[data-page=a11y]");
  await p.waitForTimeout(50);
  const body = await p.$eval(".set-main [data-page=a11y]", (e) => e.innerText);
  ok(
    !RAW.test(body),
    "no raw keys on a11y page (ko)",
    (body.match(RAW) || [])[0],
  );

  // a config checkbox writes config.ui.* and confirms
  await p.click("#a11y-highContrast");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).ui.highContrast,
    )) === true,
    "highContrast saved to config.ui",
  );
  ok(
    await p.$eval(".set-saved", (e) => e.classList.contains("show")),
    "saved feedback shown on a11y change",
  );

  // a numeric select is stored as a number, not a string
  await p.selectOption("#a11y-zoom", "1.5");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).ui.zoom,
    )) === 1.5,
    "zoom saved as number",
  );

  // reduce motion routes to set_app (app setting, not config.ui)
  await p.click("#a11y-motion");
  await p.waitForTimeout(100);
  const native = await p.evaluate(() => window.__native || []);
  ok(
    native.some(([c, a]) => c === "set_app" && a.reduceMotion === true),
    "reduceMotion sent via set_app",
    JSON.stringify(native),
  );
  await p.close();
}

// --- About & updates page ---
{
  const p = await page("en");
  await p.click(".set-nav button[data-page=about]");
  await p.waitForTimeout(100);
  const sec = await p.$eval(".set-main [data-page=about]", (e) => e.innerText);
  ok(
    !RAW.test(sec),
    "no raw keys on about page (en)",
    (sec.match(RAW) || [])[0],
  );
  ok(/0\.12\.0/.test(sec), "version shown", sec);
  ok(
    /Current version v0\.12\.0/.test(sec),
    "update status shows current version",
    sec,
  );

  // schedule select persists to config.update.check
  await p.selectOption("#about-update", "daily");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).update.check,
    )) === "daily",
    "update schedule saved to config.update.check",
  );

  // check-now surfaces a pending install; apply triggers update_restart
  await p.click("#about-update-now");
  await p.waitForTimeout(100);
  ok(
    await p.$eval("#about-update-apply", (a) => !a.hidden),
    "apply button appears when an update is pending",
  );
  await p.click("#about-update-apply");
  await p.waitForTimeout(50);
  ok(
    await p.evaluate(() => window.__restarted === true),
    "apply triggers update_restart",
  );
  await p.close();
}

// --- Timer & calendar page: presets editor + holidays ---
{
  const p = await page("ko", {
    seedConfig: {
      ui: {},
      timer: {
        presets: [
          { label: "", time: "5" },
          { label: "Tea", time: "3" },
        ],
      },
      holidays: { country: "KR", add: {}, remove: [] },
    },
  });
  await p.click(".set-nav button[data-page=timer]");
  await p.waitForTimeout(50);
  const body = await p.$eval(".set-main [data-page=timer]", (e) => e.innerText);
  ok(
    !RAW.test(body),
    "no raw keys on timer page (ko)",
    (body.match(RAW) || [])[0],
  );

  let rows = await p.$$eval("#timer-presets .set-list-row", (r) => r.length);
  ok(rows === 2, "presets seeded (2 rows)", String(rows));

  // editing a preset time saves the whole array
  await p.fill(
    "#timer-presets .set-list-row:nth-child(1) input:nth-child(2)",
    "9",
  );
  await p.waitForTimeout(400);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).timer.presets[0].time,
    )) === "9",
    "preset time saved to config.timer.presets",
  );

  // add then remove a preset
  await p.click("#timer-preset-add");
  rows = await p.$$eval("#timer-presets .set-list-row", (r) => r.length);
  ok(rows === 3, "add preset adds a row", String(rows));
  await p.click("#timer-presets .set-list-row:nth-child(1) button:last-child");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).timer.presets.length,
    )) === 2,
    "remove preset persists",
  );

  // alarm repeats → config.ui (numeric)
  await p.selectOption("#timer-rings", "10");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).ui.timerRings,
    )) === 10,
    "timerRings saved to config.ui as number",
  );

  // holiday country
  await p.selectOption("#cal-country", "none");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).holidays.country,
    )) === "none",
    "holiday country saved",
  );

  // add a custom day, then remove it (null-delete)
  await p.fill("#cal-add-date", "2026-06-03");
  await p.fill("#cal-add-name", "임시공휴일");
  await p.click("#cal-add-btn");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () =>
        JSON.parse(localStorage.getItem("wb-config")).holidays.add[
          "2026-06-03"
        ],
    )) === "임시공휴일",
    "custom day added to holidays.add",
  );
  ok(
    (await p.$$eval("#cal-add-list .set-list-row", (r) => r.length)) === 1,
    "custom day listed",
  );
  await p.click("#cal-add-list .set-list-row:first-child button");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () =>
        "2026-06-03" in
        (JSON.parse(localStorage.getItem("wb-config")).holidays.add || {}),
    )) === false,
    "custom day removed via null-delete",
  );

  // exclude a day
  await p.fill("#cal-remove-date", "2026-05-01");
  await p.click("#cal-remove-btn");
  await p.waitForTimeout(100);
  ok(
    await p.evaluate(() =>
      JSON.parse(localStorage.getItem("wb-config")).holidays.remove.includes(
        "2026-05-01",
      ),
    ),
    "excluded day saved to holidays.remove",
  );
  await p.close();
}

// --- Appearance page: theme editor ---
{
  const theme =
    ':root{\n--c1:#101014;\n--c2:#5b8cff;\n--c3:#e8e8ee;\n--radius:12px;\n--cell:80px;\n--font:"Lexend",sans-serif;\n}\n';
  const p = await page("ko", { seedTheme: theme });
  await p.click(".set-nav button[data-page=appearance]");
  await p.waitForTimeout(50);
  const body = await p.$eval(
    ".set-main [data-page=appearance]",
    (e) => e.innerText,
  );
  ok(
    !RAW.test(body),
    "no raw keys on appearance page (ko)",
    (body.match(RAW) || [])[0],
  );

  // controls reflect the seeded theme
  ok(
    (await p.$eval("#th-c2", (e) => e.value.toLowerCase())) === "#5b8cff",
    "accent colour reflects theme",
  );

  // changing a slider saves theme.css with the new value
  await p.$eval("#th-radius", (e) => {
    e.value = "20";
    e.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(100);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(
        ([c, css]) => c === "save_theme" && /--radius:\s*20px/.test(css),
      ),
    ),
    "slider change saves theme.css",
  );

  // board setting (header strip) routes to config.ui
  await p.selectOption("#ap-header", "always");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).ui.header,
    )) === "always",
    "header strip saved to config.ui",
  );

  // AI paste: a valid theme applies and reveals undo
  await p.click("#th-ai-paste");
  await p.fill("#th-paste-text", ":root{ --c2:#ff0000; }");
  await p.click("#th-paste-apply");
  await p.waitForTimeout(100);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(
        ([c, css]) => c === "save_theme" && /--c2:\s*#ff0000/.test(css),
      ),
    ),
    "AI paste applies the theme",
  );
  ok(
    await p.$eval("#th-undo", (e) => !e.hidden),
    "undo appears after AI paste",
  );

  // reset writes the default theme
  await p.click("#th-reset");
  await p.waitForTimeout(100);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(([c]) => c === "save_theme"),
    ),
    "reset saves a theme",
  );
  await p.close();
}

// --- Backup & data page ---
{
  const p = await page("en");
  await p.click(".set-nav button[data-page=backup]");
  await p.waitForTimeout(100);
  const sec = await p.$eval(".set-main [data-page=backup]", (e) => e.innerText);
  ok(
    !RAW.test(sec),
    "no raw keys on backup page (en)",
    (sec.match(RAW) || [])[0],
  );
  ok(/C:\/mock\/Backups/.test(sec), "backup location shown", sec);
  ok(/No backups yet/.test(sec), "empty state when no backups");

  // back up now adds a listed backup
  await p.click("#backup-now");
  await p.waitForTimeout(100);
  const rows = await p.$$eval("#backup-list .set-list-row", (r) => r.length);
  ok(rows === 1, "backup now adds a backup to the list", String(rows));

  // auto schedule + keep persist to config.backup
  await p.selectOption("#backup-auto", "weekly");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).backup.auto,
    )) === "weekly",
    "auto schedule saved to config.backup",
  );
  await p.fill("#backup-keep", "3");
  await p.dispatchEvent("#backup-keep", "change");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).backup.keep,
    )) === 3,
    "keep count saved to config.backup",
  );

  // open folder routes to the backend
  await p.click("#backup-open");
  await p.waitForTimeout(50);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(([c]) => c === "open_backups_folder"),
    ),
    "open folder invokes backend",
  );

  // restore: inline confirm, then restore_backup with the folder path
  await p.click("#backup-list .set-list-row:first-child button");
  await p.waitForTimeout(50);
  await p.click("#backup-list .set-list-row:first-child button.primary");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(() => window.__restored || "")).includes(
      "WidgetBoard-backup",
    ),
    "restore invokes restore_backup with the backup path",
  );
  await p.close();
}

// --- English ---
{
  const p = await page("en");
  const body = await p.$eval("body", (e) => e.innerText);
  ok(
    /General/.test(body) &&
      /Always on top/.test(body) &&
      /Start with Windows/.test(body),
    "English General page",
  );
  ok(!RAW.test(body), "no raw keys visible (en)", (body.match(RAW) || [])[0]);
  await p.close();
}

console.log(`\n${passes} passed, ${fails} failed`);
console.log("page errors:", JSON.stringify(errs));
await b.close();
process.exit(fails ? 1 : 0);
