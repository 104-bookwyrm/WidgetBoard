import { createMockTauri } from "./mock-tauri.js";
// Standalone settings window. Plain module, no build step (like the rest of ui/).
// Reads everything once via get_settings, applies changes instantly, mirrors the app's a11y settings.
import { loadLang, t, applyStatic } from "./i18n.js";
import { loadCatalogue, readHelp, patchHelp } from "./help.js";
import { tzOptions, osZone, syncScheme, appWindow, DATE_STYLES, dateStyleSample } from "./util.js";
import {
  sanitize,
  setVar,
  toHex,
  firstFamily,
  cleanFont,
  checkTheme,
  contrastWarnings,
  copyText,
} from "./theme.js";

// RULE: every backend call goes through T. Never call window.__TAURI__ directly: the mock (tests, browser
// preview, the demo) only replaces T, so a direct call reaches real app data from a page that must not touch it.
const T = window.__TAURI__ ?? createMockTauri();
appWindow();
const invoke = (cmd, args) =>
  T.core.invoke(cmd, args).catch((e) => {
    // a hand-edit typo in config.json: Rust refuses to overwrite it, so say why nothing saved
    if (e === "config_broken") flash(t("toast.config_bad"));
    throw e;
  });
// ...and that refusal is already explained, so callers without a .catch need not report it again
addEventListener("unhandledrejection", (e) => {
  if (e.reason === "config_broken") e.preventDefault();
});
const win = T.webviewWindow.getCurrentWebviewWindow();
const listen = (ev, h) => win.listen(ev, (e) => h(e.payload));

const PAGES = [
  "general",
  "appearance",
  "widgets",
  "a11y",
  "tutorial",
  "guide",
  "backup",
  "about",
];
const LANGS = [
  ["ko", "한국어"],
  ["en", "English"],
];

let data = null; // last get_settings result
let themeCss = ""; // current theme.css text, kept in sync with the board
let helpCatalogue = [];
let helpState = null;
let whatsNewVisible = false;
const $ = (sel) => document.querySelector(sel);
const cfgUi = () =>
  data?.config?.ui && typeof data.config.ui === "object" ? data.config.ui : {};

// ---- transient status toast (reuses the .set-saved pill) ----
let savedTimer;
function flash(msg) {
  const el = $(".set-saved");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("show"), 1600);
}
const saved = () => flash(t("set.saved"));

// ---- theme + accessibility (the window respects the app's own a11y) ----
function applyTheme(css) {
  themeCss = typeof css === "string" ? css : "";
  let s = document.getElementById("theme-css");
  if (!s) {
    s = document.createElement("style");
    s.id = "theme-css";
    document.head.appendChild(s);
  }
  s.textContent = sanitize(themeCss);
  syncScheme();
}
function applyA11y() {
  const u = cfgUi();
  const c = document.body.classList;
  c.toggle("high-contrast", !!u.highContrast);
  c.toggle("big-targets", !!u.bigTargets);
  c.toggle("wide-text", !!u.wideText);
  c.toggle("cvd-safe", !!u.cvd);
  c.toggle("show-hints", !!u.showHints);
  c.toggle("short-lines", !!u.shortLines);
  for (const f of ["atkinson", "lexend", "opendyslexic"])
    c.toggle("font-" + f, u.readableFont === f);
  c.toggle("reduce-motion", !!data?.app?.reduceMotion);
  // The board zoom command only scales boards; scale this window in-page instead.
  document.documentElement.style.zoom = +u.zoom || 1;
}

// ---- page routing ----
function routeOf(route) {
  const [page, focus = ""] = String(route || "").split(".", 2);
  return { page: PAGES.includes(page) ? page : "general", focus };
}
function showPage(route) {
  const { page, focus } = routeOf(route);
  for (const sec of document.querySelectorAll(".set-main [data-page]"))
    sec.hidden = sec.dataset.page !== page;
  for (const b of document.querySelectorAll(".set-nav button"))
    b.setAttribute("aria-current", b.dataset.page === page ? "page" : "false");
  const sel = $(".set-nav-select");
  if (sel.value !== page) sel.value = page;
  const main = $(".set-main");
  main.scrollTop = 0;
  main.focus();
  for (const entry of document.querySelectorAll(".help-focus")) entry.classList.remove("help-focus");
  if (page === "guide" && focus) {
    const entry = document.querySelector(`[data-guide="${CSS.escape(focus)}"]`);
    entry?.classList.add("help-focus");
    entry?.scrollIntoView({ block: "center" });
  }
  if (page === "tutorial" && whatsNewVisible && helpState?.whatsNewSeen !== data.version)
    patchHelp(invoke, { whatsNewSeen: data.version })
      .then((latest) => (helpState = latest))
      .catch(console.error);
}
function currentPage() {
  return (
    document.querySelector(".set-nav button[aria-current='page']")?.dataset
      .page || "general"
  );
}
function cyclePage(dir) {
  const i = PAGES.indexOf(currentPage());
  showPage(PAGES[(i + dir + PAGES.length) % PAGES.length]);
}

function buildNav() {
  const nav = $(".set-nav");
  const sel = $(".set-nav-select");
  nav.innerHTML = "";
  sel.innerHTML = "";
  for (const page of PAGES) {
    const b = document.createElement("button");
    b.dataset.page = page;
    b.textContent = t("set.nav." + page);
    b.setAttribute("aria-current", "false");
    b.onclick = () => showPage(page);
    nav.appendChild(b);
    const o = document.createElement("option");
    o.value = page;
    o.textContent = t("set.nav." + page);
    sel.appendChild(o);
  }
  sel.onchange = () => showPage(sel.value);
}

const GUIDE_SECTION_TITLES = {
  "calendar.board": "cal.view_board",
  "calendar.mini": "cal.view_mini",
  "timer.countdown": "widget.timer",
  "timer.stopwatch": "widget.stopwatch",
  "timer.pomodoro": "widget.pomodoro",
  "image.slideshow": "image.slideshow",
  "image.grid": "image.grid",
  "nowplaying.windows": "widget.nowplaying",
  "nowplaying.files": "np.files",
};

function helpEntry(entry, className = "") {
  const article = document.createElement("article");
  article.className = `help-entry ${className}`.trim();
  const title = document.createElement("h3");
  title.textContent = t(`help.${entry.id}.title`);
  const body = document.createElement("p");
  body.textContent = t(`help.${entry.id}.body`);
  article.append(title, body);
  for (const section of entry.sections || []) {
    const heading = document.createElement("h4");
    heading.textContent = t(GUIDE_SECTION_TITLES[`${entry.type}.${section}`]);
    const detail = document.createElement("p");
    detail.textContent = t(`help.${entry.id}.${section}`);
    article.append(heading, detail);
  }
  return article;
}

function renderHelpPages() {
  const ledger = helpCatalogue.filter((entry) => entry.kind === "ledger");
  const levels = $("#tutorial-levels");
  levels.replaceChildren();
  for (const level of [1, 2, 3]) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "help-level";
    const legend = document.createElement("legend");
    legend.textContent = t("set.tutorial.level", { n: level });
    const grid = document.createElement("div");
    grid.className = "help-grid";
    for (const entry of ledger.filter((item) => item.level === level)) {
      const seen = helpState?.hintsSeen?.includes(entry.id) || (level === 1 && helpState?.demoDone);
      const article = helpEntry(entry, `help-ledger-item${seen ? " help-seen" : ""}`);
      if (seen) article.setAttribute("aria-label", `${t(`help.${entry.id}.title`)}, ${t("set.tutorial.seen")}`);
      grid.append(article);
    }
    fieldset.append(legend, grid);
    levels.append(fieldset);
  }

  const fresh = ledger.filter((entry) => entry.since === data.version);
  const whatsNew = $("#tutorial-whats-new");
  whatsNew.hidden = !whatsNewVisible || !fresh.length;
  whatsNew.querySelector(".help-grid").replaceChildren(...fresh.map((entry) => helpEntry(entry)));

  const guide = $("#guide-list");
  guide.replaceChildren();
  for (const entry of helpCatalogue.filter((item) => item.kind === "guide")) {
    const article = helpEntry(entry, "help-guide-item");
    article.dataset.guide = entry.type;
    const button = document.createElement("button");
    button.dataset.guideTry = entry.type;
    button.textContent = t("set.guide.try");
    button.onclick = () => invoke("open_demo", { origin: win.label, focus: entry.type });
    article.append(button);
    guide.append(article);
  }
}

// ---- General page ----
function fillGeneral() {
  const lang = $("#set-lang");
  lang.innerHTML = "";
  for (const [code, name] of LANGS) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = name;
    lang.appendChild(o);
  }
  lang.value = data.app.lang;
  lang.onchange = () =>
    invoke("set_app", { patch: { lang: lang.value } }).then(saved);

  const auto = $("#set-autostart");
  auto.checked = !!data.autostart.on;
  $("#set-autostart-hint").hidden = !data.autostart.disabledByWindows;
  auto.onchange = () =>
    invoke("set_autostart", { on: auto.checked }).then((on) => {
      auto.checked = data.autostart.on = !!on;
      saved();
    });

  const week = $("#set-weekstart");
  week.value = cfgUi().weekStart || "default";
  week.onchange = () =>
    invoke("save_config", { patch: { ui: { weekStart: week.value } } }).then(
      saved,
    );

  const dateFmt = $("#set-datefmt"); // saved by the shared [data-ui] binding
  dateFmt.innerHTML = DATE_STYLES.map((v) => `<option value="${v}">${dateStyleSample(data.app.lang, v)}</option>`).join("");
  dateFmt.value = cfgUi().dateFormat ?? "";

  const tz = $("#set-tz");
  const cur = cfgUi().currentTz || "";
  tz.innerHTML = tzOptions(cur, {
    auto: t("set.tz_auto", { zone: osZone() }),
    common: t("set.tz_common"),
    all: t("set.tz_all"),
  });
  tz.value = cur;
  tz.onchange = () =>
    invoke("save_config", { patch: { ui: { currentTz: tz.value } } }).then(
      saved,
    );
}

// ---- shared [data-ui] controls → config.ui.* ----
// Keys are config.ui (the board reads them in applyUi). Only save_config is needed: boards re-apply
// native effects (zoom/dwell/hotkey) themselves on config-changed.
function bindUiControls(sel) {
  for (const i of document.querySelectorAll(sel)) {
    let tmr;
    i.addEventListener(i.type === "range" ? "input" : "change", () => {
      const k = i.dataset.ui;
      const v =
        i.type === "checkbox"
          ? i.checked
          : /^-?\d+(\.\d+)?$/.test(i.value)
            ? +i.value
            : i.value;
      const go = () =>
        invoke("save_config", { patch: { ui: { [k]: v } } }).then(saved);
      if (i.type === "range") (clearTimeout(tmr), (tmr = setTimeout(go, 250)));
      else go();
    });
  }
}
function fillUiControls(sel) {
  const u = cfgUi();
  for (const i of document.querySelectorAll(sel)) {
    const v = u[i.dataset.ui];
    if (i.type === "checkbox") i.checked = !!v;
    else if (v != null) i.value = String(v);
  }
}

// ---- Accessibility page ----
function bindA11y() {
  bindUiControls('[data-page="a11y"] [data-ui]');
  const rm = $("#a11y-motion");
  rm.addEventListener("change", () =>
    invoke("set_app", { patch: { reduceMotion: rm.checked } }).then(saved),
  );
}
function fillA11y() {
  fillUiControls('[data-page="a11y"] [data-ui]');
  $("#a11y-motion").checked = !!data?.app?.reduceMotion;
}

// ---- About & updates page ----
let offered = null; // version shown in the update offer
function showUpdate(info) {
  if (!info) return;
  const sel = $("#about-update");
  sel.value = ["weekly", "daily", "off"].includes(info.check)
    ? info.check
    : "weekly";
  const when = info.lastCheck
    ? new Date(info.lastCheck * 1000).toLocaleString(
        data.app.lang === "ko" ? "ko-KR" : "en-US",
        { dateStyle: "medium", timeStyle: "short" },
      )
    : "";
  const lines = [t("upd.current", { v: info.current })];
  if (info.busy) lines.push(t("upd.checking"));
  else if (!info.configured) lines.push(t("upd.not_configured"));
  else if (info.lastError)
    lines.push(
      t("upd.failed", {
        e:
          info.lastError === "not_configured" || info.lastError === "not_writable"
            ? t("upd." + info.lastError)
            : String(info.lastError || ""),
      }),
    );
  else if (when) lines.push(t("upd.last", { when }));
  $("#about-update-status").textContent = lines.join(" · ");
  $("#about-update-now").disabled = !!info.busy;
  // the offer: notes as plain text, then Install / Later / Skip this version
  const av = info.available;
  $("#about-update-offer").hidden = !av;
  offered = av ? av.version : null;
  if (!av) return;
  $("#about-update-title").textContent = t("upd.available", { v: av.version });
  $("#about-update-notes").textContent = av.notes || "";
  $("#about-update-notes").hidden = !av.notes;
  const a = $("#about-update-apply");
  a.textContent = t("upd.apply", { v: av.version });
  a.disabled = $("#about-update-skip").disabled = !!info.busy;
}
function bindAbout() {
  $("#about-update").onchange = () =>
    invoke("save_config", {
      patch: { update: { check: $("#about-update").value } },
    }).then(() => {
      saved();
      invoke("update_status")
        .then(showUpdate)
        .catch(() => {});
    });
  $("#about-update-now").onclick = () => invoke("update_check").catch(() => {});
  // Rust backs up, downloads + verifies, then restart_for_update flushes saves and relaunches.
  $("#about-update-apply").onclick = () =>
    invoke("update_install").catch(() => {});
  $("#about-update-later").onclick = () => win.close();
  $("#about-update-skip").onclick = () =>
    offered &&
    invoke("update_skip", { version: offered })
      .then(showUpdate)
      .catch(() => {});
}
function fillAbout() {
  $("#about-version").textContent = `WidgetBoard v${data.version || ""}`.trim();
  invoke("update_status")
    .then(showUpdate)
    .catch(() => {});
}

// ---- Timer & calendar page ----
// Presets (config.timer.presets) and holidays (config.holidays) had no UI before — edited by hand.
const holidays = () => (data?.config && data.config.holidays) || {};
function btn(text, onclick, cls = "del") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

// -- timer presets: full-array replace on every change (save_config replaces arrays) --
let presets = []; // working copy; arrays can't partial-merge, so we always send the whole list
function savePresets() {
  if (data.config)
    data.config.timer = { ...(data.config.timer || {}), presets };
  invoke("save_config", { patch: { timer: { presets } } }).then(saved);
}
function renderPresets() {
  const host = $("#timer-presets");
  host.innerHTML = "";
  presets.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "set-list-row";
    const label = document.createElement("input");
    label.type = "text";
    label.className = "grow";
    label.value = p.label || "";
    label.placeholder = t("set.timer.label_ph");
    label.setAttribute("aria-label", t("set.timer.label_ph"));
    const time = document.createElement("input");
    time.type = "text";
    time.size = 6;
    time.value = p.time || "";
    time.placeholder = "25";
    time.setAttribute("aria-label", t("set.timer.time"));
    let tmr;
    // the row's own object takes every keystroke at once; only the save waits, so a quick ↑/↓/✕ can't
    // land a pending edit in another row. No re-render here: keep focus/caret while typing.
    label.oninput = time.oninput = () => {
      p.label = label.value;
      p.time = time.value;
      clearTimeout(tmr);
      tmr = setTimeout(savePresets, 300);
    };
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= presets.length) return;
      [presets[i], presets[j]] = [presets[j], presets[i]];
      savePresets();
      renderPresets();
    };
    row.append(
      label,
      time,
      btn("↑", () => move(-1)),
      btn("↓", () => move(1)),
      btn("✕", () => {
        presets.splice(i, 1);
        savePresets();
        renderPresets();
      }),
    );
    host.append(row);
  });
}

// -- holidays: country + custom-added days + excluded days --
function renderHolidayAdds() {
  const host = $("#cal-add-list");
  host.innerHTML = "";
  const add = holidays().add || {};
  for (const [date, name] of Object.entries(add)) {
    if (typeof name !== "string" || !name.trim()) continue;
    const row = document.createElement("div");
    row.className = "set-list-row";
    const txt = document.createElement("span");
    txt.className = "grow";
    txt.textContent = `${date} - ${name}`;
    row.append(
      txt,
      btn("✕", () => {
        // null deletes the key (save_config merge convention)
        invoke("save_config", {
          patch: { holidays: { add: { [date]: null } } },
        }).then(() => {
          if (data.config?.holidays?.add) delete data.config.holidays.add[date];
          saved();
          renderHolidayAdds();
        });
      }),
    );
    host.append(row);
  }
}
function renderHolidayRemoves() {
  const host = $("#cal-remove-list");
  host.innerHTML = "";
  const rem = Array.isArray(holidays().remove) ? holidays().remove : [];
  rem.forEach((date) => {
    const row = document.createElement("div");
    row.className = "set-list-row";
    const txt = document.createElement("span");
    txt.className = "grow";
    txt.textContent = date;
    row.append(
      txt,
      btn("✕", () => saveRemoves(rem.filter((d) => d !== date))),
    );
    host.append(row);
  });
}
function saveRemoves(arr) {
  if (data.config)
    data.config.holidays = { ...(data.config.holidays || {}), remove: arr };
  invoke("save_config", { patch: { holidays: { remove: arr } } }).then(() => {
    saved();
    renderHolidayRemoves();
  });
}
function bindTimer() {
  bindUiControls('[data-page="widgets"] [data-ui]');
  $("#timer-preset-add").onclick = () => {
    presets.push({ label: "", time: "" });
    renderPresets();
  };
  $("#cal-country").onchange = () => {
    const country = $("#cal-country").value;
    if (data.config)
      data.config.holidays = { ...(data.config.holidays || {}), country };
    invoke("save_config", { patch: { holidays: { country } } }).then(saved);
  };
  $("#cal-add-btn").onclick = () => {
    const date = $("#cal-add-date").value;
    const name = $("#cal-add-name").value.trim();
    if (!date || !name) return;
    if (data.config) {
      data.config.holidays = data.config.holidays || {};
      data.config.holidays.add = {
        ...(data.config.holidays.add || {}),
        [date]: name,
      };
    }
    invoke("save_config", {
      patch: { holidays: { add: { [date]: name } } },
    }).then(() => {
      $("#cal-add-date").value = $("#cal-add-name").value = "";
      saved();
      renderHolidayAdds();
    });
  };
  $("#cal-remove-btn").onclick = () => {
    const date = $("#cal-remove-date").value;
    if (!date) return;
    const cur = Array.isArray(holidays().remove) ? holidays().remove : [];
    $("#cal-remove-date").value = "";
    if (!cur.includes(date)) saveRemoves([...cur, date]);
  };
}
function fillTimer() {
  fillUiControls('[data-page="widgets"] [data-ui]');
  presets = Array.isArray(data?.config?.timer?.presets)
    ? data.config.timer.presets.map((p) => ({
        label: p.label || "",
        time: p.time || "",
      }))
    : [];
  renderPresets();
  $("#cal-country").value = holidays().country ?? "KR";
  renderHolidayAdds();
  renderHolidayRemoves();
}

// ---- Backup & data page ----
// Backups are timestamped folder copies (Rust side). Restore flushes, copies, then relaunches.
function prettyStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(s || "");
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s || "";
}
function renderBackupList(items) {
  const host = $("#backup-list");
  host.innerHTML = "";
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = t("set.backup.none");
    host.append(p);
    return;
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "set-list-row";
    const txt = document.createElement("span");
    txt.className = "grow";
    txt.textContent =
      prettyStamp(it.created) +
      (it.kind ? ` · ${t("set.backup.kind." + it.kind)}` : "") +
      (it.app ? ` · v${it.app}` : "");
    row.append(
      txt,
      btn(t("set.backup.restore"), () => confirmRestore(row, it.path), ""),
    );
    host.append(row);
  }
}
function confirmRestore(row, path) {
  // inline confirm (no native confirm); restore relaunches the app on the Rust side
  row.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "grow";
  msg.textContent = t("set.backup.confirm");
  const yes = btn(
    t("set.backup.confirm_yes"),
    () => {
      invoke("restore_backup", { path })
        .then(() => (msg.textContent = t("set.backup.restoring")))
        .catch((e) => (msg.textContent = restoreError(e)));
    },
    "primary",
  );
  const no = btn(t("set.close"), () => fillBackup(), "");
  row.append(msg, yes, no);
}
function bindBackup() {
  $("#backup-open").onclick = () =>
    invoke("open_backups_folder").catch(() => {});
  $("#backup-folder").onclick = () =>
    invoke("open_data_folder").catch(() => {});
  $("#backup-config").onclick = () =>
    invoke("open_config_file").catch(() => {});
  $("#backup-now").onclick = () => {
    $("#backup-now-msg").textContent = t("set.backup.working");
    invoke("backup_now", {})
      .then(() => {
        $("#backup-now-msg").textContent = t("set.backup.done");
        saved();
        fillBackup();
      })
      .catch((e) => ($("#backup-now-msg").textContent = String(e)));
  };
  $("#backup-auto").onchange = () => {
    showBackupPolicy();
    invoke("save_config", {
      patch: { backup: { auto: $("#backup-auto").value } },
    }).then(saved);
  };
  $("#backup-keep").onchange = () => {
    const n = Math.max(1, Math.min(99, +$("#backup-keep").value || 7));
    $("#backup-keep").value = n;
    showBackupPolicy();
    invoke("save_config", { patch: { backup: { keep: n } } }).then(saved);
  };
}
async function fillBackup() {
  const info = await invoke("list_backups").catch(() => null);
  if (!info) return;
  $("#backup-location").textContent = info.root || "";
  const b = info.backup || {};
  $("#backup-auto").value = ["off", "daily", "weekly"].includes(b.auto)
    ? b.auto
    : "off";
  $("#backup-keep").value = b.keep != null ? b.keep : 7;
  showBackupPolicy();
  showBackupStatus(info.status);
  renderBackupList(info.items || []);
}
/** What the schedule keeps, so nobody has to guess which restore points exist. */
function showBackupPolicy() {
  $("#backup-policy").textContent =
    $("#backup-auto").value === "off"
      ? t("set.backup.policy_off")
      : t("set.backup.policy", { n: $("#backup-keep").value || 7 });
}
/** The scheduler's last failure (disk gone, folder not writable...) stays visible until a run succeeds. */
function showBackupStatus(status) {
  $("#backup-status").textContent = status?.error
    ? t("set.backup.status_error", { e: status.error })
    : "";
}
/** Rust's "damaged:<file>" -> a sentence; anything else as it came. */
const restoreError = (e) =>
  String(e).startsWith("damaged:")
    ? t("set.backup.damaged", { file: String(e).slice(8) })
    : String(e);

// ---- Appearance page (theme editor; helpers in theme.js) ----
// theme.css is the source of truth; save_theme persists and emits theme-changed for instant board preview.
const themeVars = () => [
  ...document.querySelectorAll('[data-page="appearance"] [data-var]'),
];

function saveTheme(css) {
  for (const i of themeVars())
    document.documentElement.style.removeProperty(i.dataset.var);
  applyTheme(css);
  invoke("save_theme", { css })
    .then(saved)
    .catch(() => {});
  fillTheme();
}
function fillTheme() {
  const cs = getComputedStyle(document.documentElement);
  $("#th-font").value = firstFamily(cs.getPropertyValue("--font"));
  for (const i of themeVars()) {
    const v = cs.getPropertyValue(i.dataset.var).trim();
    i.value = i.type === "color" ? toHex(v) : parseFloat(v) || 0;
  }
  fillUiControls('[data-page="appearance"] [data-ui]');
}

// --- AI theme copy/paste (validation lives in theme.js) ---
let themeBackup = null;
async function aiCopy() {
  const prompt = await fetch("ai-theme-prompt.md")
    .then((r) => r.text())
    .catch(() => "");
  const body = (
    prompt
      .split("<!-- PROMPT START -->")[1]
      ?.split("<!-- PROMPT END -->")[0]
      ?.trim() || prompt
  ).replace(
    // the shipped widget list, so a new widget is themeable without editing the prompt
    /TYPE is one of: [^.]*\./,
    `TYPE is one of: ${(data.widgetTypes || []).join(", ")}.`,
  );
  const full = `${body}\n\n## My current theme (start from this if I ask to change it)\n\`\`\`css\n${themeCss.trim()}\n\`\`\`\n\n## What I want\n`;
  flash(t((await copyText(full)) ? "ai.copied" : "ai.copy_failed"));
}
async function aiApply() {
  const res = $("#th-paste-result");
  const r = checkTheme($("#th-paste-text").value);
  res.className = "";
  if (!r.ok) {
    res.className = "bad";
    res.textContent = r.error;
    return;
  }
  themeBackup = themeCss;
  invoke("store_set", {
    key: "theme_backup",
    value: themeBackup,
    src: "host",
  }).catch(() => {});
  saveTheme(r.css);
  const warnings = [...r.warnings, ...contrastWarnings()];
  res.className = warnings.length ? "warn" : "";
  res.textContent = warnings.length ? warnings.join(" · ") : t("ai.applied");
  $("#th-undo").hidden = false;
}
async function aiUndo() {
  const prev =
    themeBackup ??
    (await invoke("store_get", { key: "theme_backup" }).catch(() => null));
  if (typeof prev !== "string") return flash(t("ai.no_backup"));
  saveTheme(prev);
  themeBackup = null;
  $("#th-undo").hidden = true;
  flash(t("ai.undone"));
}
function bindAppearance() {
  bindUiControls('[data-page="appearance"] [data-ui]');
  for (const i of themeVars()) {
    const val = () => i.value + (i.dataset.unit ?? "");
    i.addEventListener("input", () =>
      document.documentElement.style.setProperty(i.dataset.var, val()),
    );
    i.addEventListener("change", () =>
      saveTheme(setVar(themeCss, i.dataset.var, val())),
    );
  }
  $("#th-font").addEventListener("change", () => {
    const name = cleanFont($("#th-font").value);
    const val = name
      ? `"${name}", "Malgun Gothic", system-ui, sans-serif`
      : '"Segoe UI Variable", "Segoe UI", "Malgun Gothic", system-ui, sans-serif';
    saveTheme(setVar(themeCss, "--font", val));
  });
  $("#th-file").onclick = () => invoke("open_theme_file").catch(() => {});
  $("#th-reset").onclick = async () => {
    const def = await fetch("default-theme.css")
      .then((r) => r.text())
      .catch(() => "");
    if (def) saveTheme(def);
  };
  $("#th-ai-copy").onclick = aiCopy;
  $("#th-ai-paste").onclick = () => {
    $("#th-paste").hidden = false;
    $("#th-paste-result").textContent = "";
    $("#th-paste-text").focus();
  };
  $("#th-paste-cancel").onclick = () => ($("#th-paste").hidden = true);
  $("#th-paste-apply").onclick = aiApply;
  $("#th-undo").onclick = aiUndo;
}
async function fillFontList() {
  const fonts = await invoke("list_fonts").catch(() => []);
  const dl = $("#th-font-list");
  dl.innerHTML = "";
  for (const f of Array.isArray(fonts) ? fonts : []) {
    const o = document.createElement("option");
    o.value = f;
    dl.append(o);
  }
}

// ---- Widgets & layout page ----
// Board-geometry actions (add, presets, applying a saved layout) go to the primary board via
// emit_primary; everything else (close, move, save/undo layouts, lock) is plain commands.
// ---- Widgets page: memo archive on/off (the versions live in the Library's memo History) ----
function bindWidgets() {
  $("#wg-archive").onchange = () =>
    invoke("save_config", {
      patch: { archive: { memos: $("#wg-archive").checked } },
    }).then(saved);
  bindUiControls('[data-page="general"] [data-ui]'); // layout lock
}
function fillWidgets() {
  $("#wg-archive").checked = !!data.config?.archive?.memos;
  fillUiControls('[data-page="general"] [data-ui]');
}

// ---- init ----
async function init() {
  data = await invoke("get_settings");
  applyTheme(data.theme);
  await loadLang(data.app.lang, "settings");
  [helpCatalogue, helpState] = await Promise.all([loadCatalogue(), readHelp(invoke)]);
  whatsNewVisible = helpState.whatsNewSeen !== data.version && helpCatalogue.some((entry) => entry.since === data.version);
  buildNav();
  applyStatic();
  renderHelpPages();
  $("#tutorial-replay").onclick = () => invoke("open_demo", { origin: win.label, focus: null });
  applyA11y();
  fillGeneral();
  bindA11y();
  fillA11y();
  bindAbout();
  fillAbout();
  bindTimer();
  fillTimer();
  bindBackup();
  fillBackup();
  bindAppearance();
  fillTheme();
  fillFontList();
  bindWidgets();
  fillWidgets();
  showPage(new URLSearchParams(location.search).get("page") || "general");

  await listen("settings-page", showPage);
  await listen("lang-changed", async (code) => {
    data.app.lang = code || data.app.lang;
    await loadLang(data.app.lang, "settings");
    buildNav();
    applyStatic();
    renderHelpPages();
    fillA11y();
    fillAbout();
    fillTimer();
    fillBackup();
    fillTheme();
    fillWidgets();
    showPage(currentPage());
  });
  await listen("theme-changed", (css) => {
    applyTheme(css);
    fillTheme();
  });
  await listen("motion-changed", (on) => {
    if (data) data.app.reduceMotion = !!on;
    applyA11y();
    $("#a11y-motion").checked = !!data?.app?.reduceMotion;
  });
  await listen("config-changed", (cfg) => {
    if (data) data.config = cfg;
    applyA11y();
    fillGeneral();
    fillA11y();
    fillUiControls('[data-page="appearance"] [data-ui]');
    fillUiControls('[data-page="widgets"] [data-ui]');
  });
  await listen("update-status", showUpdate);
  await listen("restoring", () => {
    const o = document.createElement("div");
    o.id = "restoring";
    o.setAttribute("role", "alert");
    o.textContent = t("restore.busy");
    document.body.inert = true;
    document.documentElement.append(o); // outside the inert body
  });
  await listen("restore-failed", (e) => {
    document.body.inert = false;
    document.getElementById("restoring")?.remove();
    fillBackup(); // drop the stuck "restoring…" row
    $("#backup-now-msg").textContent = restoreError(e);
  });
  await listen("backup-status", showBackupStatus);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#th-paste").hidden && e.target.closest?.("#th-paste")) {
      // Esc in the AI-theme paste box closes the box, not the window (a pasted theme isn't lost)
      $("#th-paste").hidden = true;
      $("#th-ai-paste").focus();
    } else if (e.key === "Escape") win.close();
    else if (e.ctrlKey && (e.key === "Tab" || e.key === "PageDown"))
      (e.preventDefault(), cyclePage(e.shiftKey ? -1 : 1));
    else if (e.ctrlKey && e.key === "PageUp")
      (e.preventDefault(), cyclePage(-1));
  });
}
init();
