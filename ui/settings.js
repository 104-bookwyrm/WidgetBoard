import { createMockTauri } from "./mock-tauri.js";
// Standalone settings window. Plain module, no build step (like the rest of ui/).
// Reads everything once via get_settings, applies changes instantly, mirrors the app's a11y settings.
import { loadLang, t, applyStatic } from "./i18n.js";
import { tzOptions, osZone, syncScheme } from "./util.js";
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

const T = window.__TAURI__ ?? createMockTauri();
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
  "timer",
  "a11y",
  "backup",
  "about",
];
const LANGS = [
  ["ko", "한국어"],
  ["en", "English"],
];

let data = null; // last get_settings result
let themeCss = ""; // current theme.css text, kept in sync with the board
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
function showPage(page) {
  if (!PAGES.includes(page)) page = "general";
  for (const sec of document.querySelectorAll(".set-main [data-page]"))
    sec.hidden = sec.dataset.page !== page;
  for (const b of document.querySelectorAll(".set-nav button"))
    b.setAttribute("aria-current", b.dataset.page === page ? "page" : "false");
  const sel = $(".set-nav-select");
  if (sel.value !== page) sel.value = page;
  const main = $(".set-main");
  main.scrollTop = 0;
  main.focus();
  if (page === "widgets" && data) fillWidgets(); // board widgets may have changed since last view
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
    const commit = () => {
      presets[i] = { label: label.value, time: time.value };
      savePresets(); // no re-render here — keep focus/caret while typing
    };
    label.oninput = time.oninput = () => (
      clearTimeout(tmr),
      (tmr = setTimeout(commit, 300))
    );
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
  bindUiControls('[data-page="timer"] [data-ui]');
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
  fillUiControls('[data-page="timer"] [data-ui]');
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
    txt.textContent = prettyStamp(it.created) + (it.app ? ` · v${it.app}` : "");
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
        .catch((e) => (msg.textContent = String(e)));
    },
    "primary",
  );
  const no = btn(t("set.close"), () => fillBackup(), "");
  row.append(msg, yes, no);
}
function bindBackup() {
  $("#backup-open").onclick = () =>
    invoke("open_backups_folder").catch(() => {});
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
  $("#backup-auto").onchange = () =>
    invoke("save_config", {
      patch: { backup: { auto: $("#backup-auto").value } },
    }).then(saved);
  $("#backup-keep").onchange = () => {
    const n = Math.max(1, Math.min(99, +$("#backup-keep").value || 7));
    $("#backup-keep").value = n;
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
  renderBackupList(info.items || []);
}

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
const afterBoardChange = () => {
  saved();
  setTimeout(fillWidgets, 400); // board-side ops land asynchronously
};
// Boards listen for these broadcasts and act on their own widgets (name / hidden / locate / restore).
const emit = (ev, payload) => T.event.emit(ev, payload).catch(() => {});
const wName = (w) => w.name || t("widget." + w.type);
const when = (secs) =>
  new Date(secs * 1000).toLocaleString(
    data.app.lang === "ko" ? "ko-KR" : "en-US",
    {
      dateStyle: "medium",
      timeStyle: "short",
    },
  );
function hintRow(host, key) {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = t(key);
  host.append(p);
}
function renderWidgetList(all) {
  const host = $("#wg-list");
  host.innerHTML = "";
  if (!all.length) return hintRow(host, "set.widgets.none");
  const displays = (data.displays || []).map((d) => d.display);
  for (const w of all) {
    const row = document.createElement("div");
    row.className = "set-list-row" + (w.hidden ? " is-hidden" : "");
    // the name field: clicking it flashes the real widget, typing renames it
    const name = document.createElement("input");
    name.type = "text";
    name.className = "grow";
    name.maxLength = 40;
    name.value = w.name || "";
    name.placeholder = t("widget." + w.type);
    name.setAttribute(
      "aria-label",
      t("set.widgets.name", { type: t("widget." + w.type) }),
    );
    name.onfocus = () => emit("widget-locate", w.id);
    name.onchange = () => {
      w.name = name.value.trim();
      emit("widget-patch", { id: w.id, patch: { name: w.name } });
      saved();
    };
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent =
      t("widget." + w.type) +
      (w.display && displays.length > 1 ? ` · ${w.display}` : "");
    const hide = btn(
      t(w.hidden ? "set.widgets.show" : "set.widgets.hide"),
      () => {
        w.hidden = !w.hidden;
        emit("widget-patch", { id: w.id, patch: { hidden: w.hidden } });
        saved();
        renderWidgetList(all);
      },
      "",
    );
    hide.setAttribute("aria-pressed", String(!!w.hidden));
    row.append(name, meta, hide);
    if (displays.length > 1)
      row.append(
        btn(
          "⇆",
          () => {
            const i = displays.indexOf(w.display);
            const to = displays[(i + 1) % displays.length];
            // the board moves its live copy; this list can be minutes old
            emit("widget-move", { id: w.id, display: to }).then(afterBoardChange);
          },
          "",
        ),
      );
    // the board closes its live copy (bin + undo toast), so nothing else on screen rolls back
    const close = btn("✕", () => emit("widget-close", w.id).then(afterBoardChange));
    close.title = close.ariaLabel = t("set.widgets.close", { name: wName(w) });
    row.append(close);
    host.append(row);
  }
}

// -- closed-widgets bin --
function confirmInline(row, msgKey, onYes, back, { vars, yes = "lib.delete" } = {}) {
  row.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "grow";
  msg.textContent = t(msgKey, vars);
  row.append(
    msg,
    btn(t(yes), onYes, "primary"),
    btn(t("set.close"), back, ""),
  );
}

// -- memo archive (opt-in) --
async function renderArchive() {
  const on = !!data.config?.archive?.memos;
  $("#wg-archive").checked = on;
  const host = $("#wg-archive-list");
  const lines = await invoke("memo_archive_list").catch(() => []);
  host.innerHTML = ""; // after the await: overlapping renders would both append
  if (!lines.length) return on ? hintRow(host, "set.archive.none") : undefined;
  const byId = new Map();
  for (const v of lines)
    (byId.get(v.id) || byId.set(v.id, []).get(v.id)).push(v);
  const memos = [...byId.values()].sort((a, b) => b.at(-1).t - a.at(-1).t);
  for (const versions of memos) {
    const last = versions.at(-1);
    const d = document.createElement("details");
    const sum = document.createElement("summary");
    const title = last.name || last.text.split("\n")[0].slice(0, 40);
    sum.textContent = `${title} · ${t("set.archive.versions", { n: versions.length })} · ${when(last.t)}`;
    d.append(sum);
    d.ontoggle = () => {
      if (!d.open || d.children.length > 1) return;
      for (const v of [...versions].reverse()) {
        const row = document.createElement("div");
        row.className = "set-list-row";
        const pre = document.createElement("pre");
        pre.textContent = v.text;
        const ts = document.createElement("span");
        ts.className = "muted";
        ts.textContent = when(v.t);
        row.append(
          ts,
          pre,
          btn(
            t("set.archive.copy"),
            () =>
              copyText(v.text).then((ok) =>
                flash(t(ok ? "ai.copied" : "ai.copy_failed")),
              ),
            "",
          ),
        );
        d.append(row);
      }
    };
    host.append(d);
  }
}

async function renderWgLayouts() {
  const list = await invoke("store_get", { key: "layouts" }).catch(() => null);
  const layouts = (Array.isArray(list) ? list : []).filter(
    (l) => l && typeof l.name === "string" && Array.isArray(l.widgets),
  );
  const host = $("#wg-layouts");
  host.innerHTML = "";
  if (!layouts.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = t("lay.none");
    host.append(p);
  } else {
    for (const l of layouts) {
      const row = document.createElement("div");
      row.className = "set-list-row";
      const txt = document.createElement("span");
      txt.className = "grow";
      txt.textContent = `${l.name} · ${t("lay.count", { n: l.widgets.length })}`;
      row.append(
        txt,
        btn(
          t("lay.apply"),
          // the board merges current contents (memo text...) into the saved positions
          () =>
            invoke("emit_primary", { event: "apply-layout", payload: l.name })
              .then(afterBoardChange)
              .catch(() => {}),
          "",
        ),
        btn("✕", () =>
          confirmInline(
            row,
            "lay.delete_confirm",
            () =>
              invoke("store_set", {
                key: "layouts",
                value: layouts.filter((x) => x !== l),
                src: "settings",
              }).then(() => {
                saved();
                renderWgLayouts();
              }),
            renderWgLayouts,
            { vars: { name: l.name }, yes: "dday.delete" },
          ),
        ),
      );
      host.append(row);
    }
  }
  const undo = await invoke("store_get", { key: "layouts_undo" }).catch(
    () => null,
  );
  $("#wg-layout-undo").hidden = !Array.isArray(undo);
}
function bindWidgets() {
  $("#wg-library").onclick = () => invoke("open_library").catch(() => {});
  $("#wg-archive").onchange = () =>
    invoke("save_config", {
      patch: { archive: { memos: $("#wg-archive").checked } },
    }).then(() => {
      saved();
      renderArchive();
    });
  bindUiControls('[data-page="widgets"] [data-ui]');
  const sel = $("#wg-add-type");
  $("#wg-add").onclick = () =>
    invoke("emit_primary", { event: "add-widget", payload: sel.value })
      .then(afterBoardChange)
      .catch(() => {});
  $("#wg-edit").onclick = () =>
    invoke("set_edit_mode", { on: true }).catch(() => {});
  for (const id of ["work", "study", "oshi"])
    $("#wg-preset-" + id).onclick = () =>
      invoke("emit_primary", { event: "apply-preset", payload: id })
        .then(afterBoardChange)
        .catch(() => {});
  $("#wg-layout-save").onclick = async () => {
    const all = await invoke("get_all_widgets").catch(() => []);
    const now = new Date();
    const name =
      $("#wg-layout-name").value.trim().slice(0, 40) ||
      t("lay.default_name", {
        date: `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      });
    const list = await invoke("store_get", { key: "layouts" }).catch(
      () => null,
    );
    const prev = Array.isArray(list) ? list : [];
    const next = [
      ...prev.filter((l) => l.name !== name),
      { name, saved: now.toISOString(), widgets: all },
    ].slice(-20);
    await invoke("store_set", {
      key: "layouts",
      value: next,
      src: "settings",
    }).catch(() => {});
    $("#wg-layout-name").value = "";
    saved();
    renderWgLayouts();
  };
  // the board undoes it: positions go back, contents typed since stay
  $("#wg-layout-undo").onclick = () =>
    invoke("emit_primary", { event: "undo-layout", payload: null })
      .then(afterBoardChange)
      .catch(() => {});
}
async function fillWidgets() {
  const sel = $("#wg-add-type");
  sel.innerHTML = "";
  for (const type of data.widgetTypes || []) {
    const o = document.createElement("option");
    o.value = type;
    o.textContent = t("widget." + type);
    sel.append(o);
  }
  const all = await invoke("get_all_widgets").catch(() => []);
  renderWidgetList(Array.isArray(all) ? all : []);
  renderWgLayouts();
  renderArchive();
  fillUiControls('[data-page="widgets"] [data-ui]');
}

// ---- init ----
async function init() {
  data = await invoke("get_settings");
  applyTheme(data.theme);
  await loadLang(data.app.lang);
  buildNav();
  applyStatic();
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
    await loadLang(data.app.lang);
    buildNav();
    applyStatic();
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
    $("#backup-now-msg").textContent = String(e);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") win.close();
    else if (e.ctrlKey && (e.key === "Tab" || e.key === "PageDown"))
      (e.preventDefault(), cyclePage(e.shiftKey ? -1 : 1));
    else if (e.ctrlKey && e.key === "PageUp")
      (e.preventDefault(), cyclePage(-1));
  });
}
init();
