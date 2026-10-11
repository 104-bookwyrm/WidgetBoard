// v0.12: standalone settings window (settings.html).
// Increment 1 — window shell + General page. Increment 2 — Accessibility + About/updates pages.
// Increment 3 — Timer & calendar page (presets editor + holidays).
// Increment 4 — Backup & data page (backup/restore, auto schedule).
// Increment 5a — Appearance page (theme editor).
// Increment 5b — Widgets & layout page (list/add/move/close, presets, saved layouts).
import { chromium, ready, settled } from "./browser.mjs";
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
  { width = 1024, height = 800, seedConfig, seedTheme, seedWidgets } = {},
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
    ({ cfg, theme, widgets }) => {
      localStorage.clear();
      if (cfg) localStorage.setItem("wb-config", JSON.stringify(cfg));
      if (theme) localStorage.setItem("wb-theme", theme);
      if (widgets) localStorage.setItem("wb-widgets", JSON.stringify(widgets));
    },
    { cfg: seedConfig, theme: seedTheme, widgets: seedWidgets },
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
      "일반|모양|위젯 · 배치|타이머 · 달력|접근성|백업 · 데이터|정보 · 업데이트",
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

  // a later config-changed (file watcher echo) must not snap toggles back
  await p.evaluate(() => window.__mock.emit("config-changed", { ui: {} }));
  ok(
    await p.$eval("#set-autostart", (e) => e.checked),
    "autostart stays on after config-changed",
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

  // nothing offered until a check finds something
  ok(
    await p.$eval("#about-update-offer", (e) => e.hidden),
    "no update offer before a check",
  );
  await p.evaluate(() => { window.__mockUpdate = { found: "0.12.1", notes: "New: x\nFixed: y" }; });
  // check-now finds a version: notes as plain text + Install / Later / Skip
  await p.click("#about-update-now");
  await p.waitForTimeout(100);
  ok(
    await p.$eval("#about-update-offer", (e) => !e.hidden),
    "offer appears when an update is found",
  );
  ok(
    /0\.12\.1/.test(
      await p.$eval("#about-update-title", (e) => e.textContent),
    ) &&
      (await p.$eval("#about-update-notes", (e) => e.textContent)) ===
        "New: x\nFixed: y",
    "offer shows the version and the notes",
  );
  // skip hides it; a manual check shows it again
  await p.click("#about-update-skip");
  await p.waitForTimeout(50);
  ok(
    (await p.evaluate(() => window.__updSkipped)) === "0.12.1" &&
      (await p.$eval("#about-update-offer", (e) => e.hidden)),
    "skip this version hides the offer",
  );
  await p.click("#about-update-now");
  await p.waitForTimeout(100);
  ok(
    await p.$eval("#about-update-offer", (e) => !e.hidden),
    "manual check shows a skipped version again",
  );
  await p.click("#about-update-apply");
  await p.waitForTimeout(50);
  ok(
    await p.evaluate(() => window.__installed === true),
    "install triggers update_install",
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

// --- Widgets & layout page ---
{
  const p = await page("ko", {
    seedWidgets: [
      { id: "a", type: "memo", display: "D1" },
      { id: "b", type: "timer", display: "D2" },
    ],
  });
  await p.click(".set-nav button[data-page=widgets]");
  await p.waitForTimeout(100);
  const body = await p.$eval(
    ".set-main [data-page=widgets]",
    (e) => e.innerText,
  );
  ok(
    !RAW.test(body),
    "no raw keys on widgets page (ko)",
    (body.match(RAW) || [])[0],
  );
  let rows = await p.$$eval("#wg-list .set-list-row", (r) => r.length);
  ok(rows === 2, "widget list shows seeded widgets", String(rows));

  // close a widget → the owning board closes its live copy (widget-close)
  const nat = () => p.evaluate(() => window.__native || []);
  const sent = async (ev, test) =>
    (await nat()).some(([c, e, pl]) => c === "emit" && e === ev && test(pl));
  await p.click("#wg-list .set-list-row:first-child button:last-child");
  await p.waitForTimeout(100);
  ok(
    await sent("widget-close", (pl) => pl === "a"),
    "close asks the board to close the widget",
  );
  ok(
    (await p.evaluate(() => __mock.widgets().length)) === 2,
    "the settings window itself rewrites nothing",
  );
  // what the board then does, so the rest of the page can be checked
  await p.evaluate(() => {
    const ws = __mock.widgets();
    localStorage.setItem("wb-widgets", JSON.stringify(ws.filter((w) => w.id !== "a")));
  });
  await p.click(".set-nav button[data-page=widgets]");
  await p.waitForTimeout(500);

  // name: focusing it locates the widget, changing it renames via widget-patch
  const nm = "#wg-list .set-list-row:first-child input";
  await p.focus(nm);
  await p.fill(nm, "Groceries");
  await p.press(nm, "Tab");
  await p.waitForTimeout(50);
  ok(
    await sent("widget-locate", (pl) => pl === "b"),
    "focusing a name locates the widget",
  );
  ok(
    await sent(
      "widget-patch",
      (pl) => pl.id === "b" && pl.patch.name === "Groceries",
    ),
    "rename sends widget-patch",
  );
  // hide (first button in the row)
  await p.click("#wg-list .set-list-row:first-child button");
  await p.waitForTimeout(50);
  ok(
    await sent(
      "widget-patch",
      (pl) => pl.id === "b" && pl.patch.hidden === true,
    ),
    "hide sends widget-patch hidden",
  );
  ok(
    await p.$eval("#wg-list .set-list-row:first-child", (e) =>
      e.classList.contains("is-hidden"),
    ),
    "hidden widget marked in the list",
  );

  // closed widgets live in the Library now; the page only opens it
  await p.click("#wg-library");
  ok(
    (await p.evaluate(() => window.__native || [])).some(([c]) => c === "open_library"),
    "Open Library opens the Library window",
  );

  // memo archive: visible opt-in → config.archive.memos; versions grouped per memo
  ok(
    !(await p.$eval("#wg-archive", (e) => e.checked)),
    "memo archive is off by default",
  );
  await p.evaluate(() =>
    localStorage.setItem(
      "wb-archive",
      JSON.stringify([
        { t: 1790000000, id: "m1", name: "", text: "milk, eggs" },
        { t: 1790000100, id: "m1", name: "", text: "milk, eggs, bread" },
      ]),
    ),
  );
  await p.click("#wg-archive");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).archive?.memos,
    )) === true,
    "archive opt-in saved to config.archive.memos",
  );
  ok(
    (await p.$$eval("#wg-archive-list details", (d) => d.length)) === 1,
    "archived versions grouped into one memo",
  );
  // opened straight on the Widgets page, init and showPage both render the list: still one entry
  await p.goto("http://localhost:8765/settings.html?lang=ko&page=widgets");
  await p.waitForTimeout(500);
  ok(
    (await p.$$eval("#wg-archive-list details", (d) => d.length)) === 1,
    "RT14: archive list not doubled when opened on the Widgets page",
  );
  await p.click("#wg-archive-list summary");
  await p.waitForTimeout(50);
  ok(
    (await p.$$eval("#wg-archive-list pre", (d) => d.length)) === 2,
    "opening a memo lists its versions",
  );

  // add a widget → emit_primary add-widget to the board
  await p.selectOption("#wg-add-type", "calendar");
  await p.click("#wg-add");
  await p.waitForTimeout(100);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(
        ([c, ev, pl]) =>
          c === "emit_primary" && ev === "add-widget" && pl === "calendar",
      ),
    ),
    "add widget emits add-widget to the primary board",
  );

  // lock layout → config.ui.lockLayout
  await p.click("#wg-lock");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-config")).ui.lockLayout,
    )) === true,
    "lock layout saved to config.ui",
  );

  // edit layout → set_edit_mode
  await p.click("#wg-edit");
  await p.waitForTimeout(50);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(
        ([c, on]) => c === "set_edit_mode" && on === true,
      ),
    ),
    "edit layout enables edit mode",
  );

  // preset → emit_primary apply-preset
  await p.click("#wg-preset-work");
  await p.waitForTimeout(50);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(
        ([c, ev, pl]) =>
          c === "emit_primary" && ev === "apply-preset" && pl === "work",
      ),
    ),
    "preset emits apply-preset",
  );

  // save a named layout → store
  await p.fill("#wg-layout-name", "My setup");
  await p.click("#wg-layout-save");
  await p.waitForTimeout(100);
  ok(
    (await p.evaluate(
      () => JSON.parse(localStorage.getItem("wb-store-layouts"))[0].name,
    )) === "My setup",
    "layout saved to the layouts store",
  );
  ok(
    (await p.$$eval("#wg-layouts .set-list-row", (r) => r.length)) === 1,
    "saved layout listed",
  );
  // apply goes to the board, which merges current contents into the saved positions
  await p.click("#wg-layouts .set-list-row button");
  await p.waitForTimeout(50);
  ok(
    await p.evaluate(() =>
      (window.__native || []).some(
        ([c, ev, pl]) =>
          c === "emit_primary" && ev === "apply-layout" && pl === "My setup",
      ),
    ),
    "apply emits apply-layout with the layout name",
  );
  ok(
    (await p.$$eval("#wg-add-type option", (o) => o.length)) === 13,
    "add list offers every widget type",
  );
  // delete asks first
  await p.click("#wg-layouts .set-list-row button:last-child");
  ok(
    /My setup/.test(await p.textContent("#wg-layouts .set-list-row")) &&
      JSON.parse(await p.evaluate(() => localStorage.getItem("wb-store-layouts"))).length === 1,
    "deleting a layout asks for confirmation first",
  );
  await p.click("#wg-layouts .set-list-row button.primary");
  await p.waitForTimeout(100);
  ok(
    JSON.parse(await p.evaluate(() => localStorage.getItem("wb-store-layouts"))).length === 0,
    "confirmed delete removes the layout",
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
  ok(
    await p.evaluate(() => document.body.inert && !!document.getElementById("restoring")?.textContent),
    "restore blocks input and says changes are not saved",
  );
  await p.close();
}

// --- Board: names, hide, locate, bin, memo archive ---
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:8765/index.html?lang=en");
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "wb-widgets",
      JSON.stringify([
        {
          id: "m",
          type: "memo",
          display: "D1",
          x: 0,
          y: 0,
          w: 3,
          h: 3,
          settings: { text: "hello world" },
        },
      ]),
    );
  });
  await p.reload();
  await ready(p);
  const el = '.widget[data-id="m"]';
  const emit = (ev, pl) =>
    p.evaluate(([e, x]) => window.__mock.emit(e, x), [ev, pl]);
  const calls = () => p.evaluate(() => window.__calls || []);

  await emit("widget-patch", { id: "m", patch: { name: "Groceries" } });
  ok(
    (await p.$eval(el + " .title", (e) => e.textContent)) === "Groceries",
    "board shows the custom name",
  );
  ok(
    (await p.$eval(el, (e) => e.getAttribute("aria-label"))) === "Groceries",
    "custom name is the accessible label",
  );

  await emit("widget-patch", { id: "m", patch: { hidden: true } });
  ok(
    (await p.$eval(el, (e) => getComputedStyle(e).display)) === "none",
    "hidden widget is not drawn",
  );
  await emit("edit-mode", true);
  await p.waitForTimeout(50);
  ok(
    await p.$eval(
      el,
      (e) =>
        getComputedStyle(e).display !== "none" &&
        +getComputedStyle(e).opacity < 0.5,
    ),
    "hidden widget is a translucent ghost in edit mode",
  );
  await emit("edit-mode", false);
  await p.waitForTimeout(400); // save debounce
  const stored = JSON.parse(
    await p.evaluate(() => localStorage.getItem("wb-widgets")),
  )[0];
  ok(
    stored.name === "Groceries" && stored.hidden === true,
    "name and hidden persist",
    JSON.stringify(stored),
  );

  await emit("widget-patch", { id: "m", patch: { hidden: false } });
  await emit("widget-locate", "m");
  ok(
    await p.$eval(el, (e) => e.classList.contains("w-locate")),
    "locate highlights the widget",
  );

  await p.$eval(el + " [data-act=remove]", (e) => e.click());
  await p.waitForTimeout(50);
  ok(
    (await calls()).some(
      ([c, a]) => c === "content_put" && a.item.id === "m" && a.item.placement?.id === "m",
    ),
    "closing keeps the content in the Library with where it was",
  );
  ok(
    (await calls()).some(
      ([c, a]) =>
        c === "memo_archive" &&
        a.text === "hello world" &&
        a.name === "Groceries",
    ),
    "closing a memo archives its text at once",
  );
  await p.click("#toast button");
  await p.waitForTimeout(50);
  ok(!!(await p.$(el)), "undo restores the widget");
  await p.close();
}

// --- English ---
{
  const p = await page("en");
  const body = await p.$eval("body", (e) => e.innerText);
  ok(
    /General/.test(body) &&
      !/Always on top/.test(body) &&
      /Start with Windows/.test(body),
    "English General page",
  );
  ok(!RAW.test(body), "no raw keys visible (en)", (body.match(RAW) || [])[0]);
  await p.close();
}

// --- config.json typo: saves are refused and the window says why ---
{
  const p = await page();
  await p.evaluate(() => (window.__mockConfigBroken = true));
  await p.click(".set-nav button[data-page=a11y]");
  await p.waitForTimeout(100);
  await p.check("#a11y-highContrast");
  await p.waitForTimeout(400);
  ok(
    /config\.json/.test(await p.textContent(".set-saved")),
    "a refused save explains the config.json problem",
    await p.textContent(".set-saved"),
  );
  await p.close();
}

// --- Library window: everything that was ever on the board, plus Recently deleted ---
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const board = await ctx.newPage();
  board.on("pageerror", (e) => errs.push(e.message));
  await board.goto("http://localhost:8765/index.html?lang=en");
  const item = (id, type, data, extra = {}) =>
    ({ id, type, name: "", tags: [], rev: 1, created: 1, updated: 1, deletedAt: null, data, ...extra });
  await board.evaluate(
    ({ items }) => {
      localStorage.clear();
      localStorage.setItem("wb-widgets", JSON.stringify([
        { id: "on", type: "memo", display: "D1", x: 0, y: 0, w: 3, h: 3, settings: {} },
      ]));
      localStorage.setItem("wb-content", JSON.stringify(items));
    },
    {
      items: {
        on: item("on", "memo", { text: "on the board", color: "yellow" }, { updated: 3 }),
        off: item("off", "memo", { text: "closed earlier", color: "pink" }, {
          updated: 2, placement: { id: "off", type: "memo", display: "D1", x: 6, y: 0, w: 3, h: 3, settings: {} },
        }),
        gone: item("gone", "timer", { duration: 60000, remaining: 60000, endAt: null }, { deletedAt: 5 }),
      },
    },
  );
  await board.reload();
  await ready(board);
  const lib = await ctx.newPage();
  lib.on("pageerror", (e) => errs.push(e.message));
  await lib.goto("http://localhost:8765/library.html?lang=en");
  await lib.waitForSelector("html[data-ready]", { state: "attached" });
  const card = (id) => `.lib-card[data-id="${id}"]`;
  ok(
    (await lib.$$(".lib-card")).length === 2 && !(await lib.$(card("gone"))),
    "Library lists live content, not deleted",
  );
  ok(/On the board/.test(await lib.textContent(card("on"))), "content on the board says so");
  await lib.click(`${card("off")} [data-act=show]`);
  await board.waitForSelector('.widget[data-id="off"]');
  await settled(board);
  const back = await board.evaluate(() => __mock.widgets().find((w) => w.id === "off"));
  ok(back.x === 6 && back.settings.text === "closed earlier", "Show on board puts it back where it was", JSON.stringify(back));
  await lib.click(`${card("on")} [data-act=rename]`);
  await lib.fill(".lib-name", "Groceries");
  await lib.press(".lib-name", "Enter");
  await board.waitForFunction(() => document.querySelector('.widget[data-id="on"] .title')?.textContent === "Groceries");
  ok(true, "renaming in the Library renames the widget");
  await lib.click(`${card("on")} [data-act=delete]`);
  await board.waitForSelector('.widget[data-id="on"]', { state: "detached" });
  ok(true, "deleting takes it off the board");
  await lib.click("[data-filter=deleted]");
  await lib.waitForSelector(card("on"));
  ok((await lib.$$(".lib-card")).length === 2, "Recently deleted lists both deleted items");
  await lib.click(`${card("on")} [data-act=restore]`);
  await lib.click("[data-filter=all]");
  ok(!!(await lib.$(card("on"))), "restore brings it back to the Library");
  await lib.click("[data-filter=deleted]");
  await lib.click(`${card("gone")} [data-act=erase]`);
  ok(/can't be undone/.test(await lib.textContent(card("gone"))), "delete permanently asks first");
  await lib.click(`${card("gone")} [data-act=erase-yes]`);
  await lib.waitForSelector(card("gone"), { state: "detached" });
  ok(
    !(await lib.evaluate(async () => (await __mock.invoke("content_list")).some((c) => c.id === "gone"))),
    "delete permanently removes it",
  );
  await ctx.close();
}

console.log(`\n${passes} passed, ${fails} failed`);
console.log("page errors:", JSON.stringify(errs));
await b.close();
process.exit(fails ? 1 : 0);
