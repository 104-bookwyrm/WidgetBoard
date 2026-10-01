// Standalone settings window. Plain module, no build step (like the rest of ui/).
// Reads everything once via get_settings, applies changes instantly, mirrors the app's a11y settings.
import { loadLang, t, applyStatic } from "./i18n.js";

const T = window.__TAURI__ ?? settingsMock();
const invoke = (cmd, args) => T.core.invoke(cmd, args);
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
  s.textContent = themeCss;
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

  const onTop = $("#set-ontop");
  onTop.checked = !!data.app.onTop;
  onTop.onchange = () =>
    invoke("set_app", { patch: { onTop: onTop.checked } }).then(saved);

  const auto = $("#set-autostart");
  auto.checked = !!data.autostart.on;
  $("#set-autostart-hint").hidden = !data.autostart.disabledByWindows;
  auto.onchange = () =>
    invoke("set_autostart", { on: auto.checked }).then((on) => {
      auto.checked = !!on;
      saved();
    });

  const week = $("#set-weekstart");
  week.value = cfgUi().weekStart || "default";
  week.onchange = () =>
    invoke("save_config", { patch: { ui: { weekStart: week.value } } }).then(
      saved,
    );
}

// ---- shared [data-ui] controls → config.ui.* ----
// Same keys as the in-board #settings-panel. Only save_config is needed: boards re-apply
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
  else if (info.pending)
    lines.push(
      t("upd.ready", { v: info.pending.version }) +
        (info.pending.notes ? ` — ${info.pending.notes}` : ""),
    );
  else if (!info.configured) lines.push(t("upd.not_configured"));
  else if (info.lastError)
    lines.push(
      t("upd.failed", {
        e:
          info.lastError === "not_configured"
            ? t("upd.not_configured")
            : String(info.lastError || ""),
      }),
    );
  else if (when) lines.push(t("upd.last", { when }));
  $("#about-update-status").textContent = lines.join(" · ");
  $("#about-update-now").disabled = !!info.busy;
  const a = $("#about-update-apply");
  a.hidden = !info.pending;
  a.textContent = info.pending
    ? t("upd.apply", { v: info.pending.version })
    : "";
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
  // Rust's restart_for_update emits flush-saves + waits 700ms, so boards persist first.
  $("#about-update-apply").onclick = () =>
    invoke("update_restart").catch(() => {});
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
    txt.textContent = `${date} — ${name}`;
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

// ---- Appearance page (theme editor) — ported from the in-board #theme-panel ----
// theme.css is the source of truth; save_theme persists and emits theme-changed for instant board preview.
const sanitize = (css) =>
  css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*['"]?\s*(https?:|\/\/)[^)]*\)/gi, "none");
function setVar(css, name, value) {
  const esc = name.replace(/[-]/g, "\\-");
  const re = new RegExp(`(^|[\\s;{])(${esc}\\s*:\\s*)([^;]*)(;)`, "m");
  if (re.test(css)) return css.replace(re, `$1$2${value}$4`);
  if (/:root\s*\{/.test(css))
    return css.replace(/:root\s*\{/, (m) => `${m}\n  ${name}: ${value};`);
  return `${css}\n:root { ${name}: ${value}; }\n`;
}
const _cvs = document.createElement("canvas").getContext("2d");
function toHex(color) {
  _cvs.fillStyle = "#000";
  _cvs.fillStyle = color.trim();
  return _cvs.fillStyle.startsWith("#") ? _cvs.fillStyle : "#000000";
}
const firstFamily = (v) =>
  (v || "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
const cleanFont = (f) =>
  String(f || "")
    .replace(/["';{}\\<>]/g, "")
    .trim()
    .slice(0, 80);
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

// --- AI theme validation (ported) ---
function extractCss(text) {
  const m = String(text).match(/```(?:css)?\s*\n([\s\S]*?)```/i);
  return (m ? m[1] : String(text)).trim();
}
function checkTheme(text) {
  const css = extractCss(text);
  if (!css) return { ok: false, error: t("ai.err_empty") };
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(sanitize(css));
  } catch {
    return { ok: false, error: t("ai.err_syntax") };
  }
  const style = [...sheet.cssRules].filter((r) => r.style);
  if (!style.some((r) => [...r.style].some((p) => p.startsWith("--"))))
    return { ok: false, error: t("ai.err_no_vars") };
  const warnings = [];
  const outside = style.filter(
    (r) =>
      !/^(:root|\[data-widget=("|')?[a-z]+("|')?\])(\s*,\s*(:root|\[data-widget=("|')?[a-z]+("|')?\]))*$/.test(
        r.selectorText,
      ),
  );
  if (outside.length || [...sheet.cssRules].length !== style.length)
    warnings.push(
      t("ai.warn_outside", {
        n: outside.length + [...sheet.cssRules].length - style.length,
      }),
    );
  if (/@import|url\(\s*['"]?\s*(https?:|\/\/)/i.test(css))
    warnings.push(t("ai.warn_remote"));
  if (/--(cell|gap)\s*:/.test(css)) warnings.push(t("ai.warn_grid"));
  return { ok: true, css, warnings };
}
function contrast(a, b) {
  const lum = (c) => {
    const p = document.createElement("i");
    p.style.color = c;
    document.body.append(p);
    const v = getComputedStyle(p).color;
    p.remove();
    const n = v.match(/[\d.]+/g)?.map(Number) || [0, 0, 0];
    const rgb = v.startsWith("color(")
      ? n.slice(0, 3).map((x) => x * 255)
      : n.slice(0, 3);
    const ch = rgb.map((x) =>
      (x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function contrastWarnings() {
  const w = [];
  const text = contrast("var(--c3)", "var(--c1)");
  const acc = contrast("var(--on-accent)", "var(--c2)");
  if (text < 4.5) w.push(t("ai.warn_contrast_text", { r: text.toFixed(1) }));
  if (acc < 3) w.push(t("ai.warn_contrast_accent", { r: acc.toFixed(1) }));
  return w;
}
let themeBackup = null;
async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch {
    const ta = Object.assign(document.createElement("textarea"), {
      value: txt,
    });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
async function aiCopy() {
  const prompt = await fetch("ai-theme-prompt.md")
    .then((r) => r.text())
    .catch(() => "");
  const body =
    prompt
      .split("<!-- PROMPT START -->")[1]
      ?.split("<!-- PROMPT END -->")[0]
      ?.trim() || prompt;
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
// Board-geometry actions (add, presets) go to the primary board via emit_primary; everything
// else (close, move, save/apply/undo layouts, lock) is plain commands.
const WIDGET_TYPES = [
  "checklist",
  "calendar",
  "dday",
  "diary",
  "memo",
  "nowplaying",
  "timer",
  "stopwatch",
  "image",
];
async function winReplace(next) {
  const before = await invoke("get_all_widgets").catch(() => []);
  await invoke("store_set", {
    key: "layouts_undo",
    value: before,
    src: "settings",
  }).catch(() => {});
  await invoke("replace_widgets", { widgets: next }).catch(() => {});
}
const afterBoardChange = () => {
  saved();
  setTimeout(fillWidgets, 400); // board-side ops land asynchronously
};
function renderWidgetList(all) {
  const host = $("#wg-list");
  host.innerHTML = "";
  if (!all.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = t("set.widgets.none");
    host.append(p);
    return;
  }
  const displays = (data.displays || []).map((d) => d.display);
  for (const w of all) {
    const row = document.createElement("div");
    row.className = "set-list-row";
    const txt = document.createElement("span");
    txt.className = "grow";
    txt.textContent =
      t("widget." + w.type) + (w.display ? ` · ${w.display}` : "");
    row.append(txt);
    if (displays.length > 1)
      row.append(
        btn(
          "⇆",
          () => {
            const i = displays.indexOf(w.display);
            const to = displays[(i + 1) % displays.length];
            winReplace(
              all.map((x) => (x.id === w.id ? { ...x, display: to } : x)),
            ).then(afterBoardChange);
          },
          "",
        ),
      );
    row.append(
      btn("✕", () =>
        winReplace(all.filter((x) => x.id !== w.id)).then(afterBoardChange),
      ),
    );
    host.append(row);
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
          () => winReplace(l.widgets).then(afterBoardChange),
          "",
        ),
        btn("✕", () => {
          invoke("store_set", {
            key: "layouts",
            value: layouts.filter((x) => x !== l),
            src: "settings",
          }).then(() => {
            saved();
            renderWgLayouts();
          });
        }),
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
  bindUiControls('[data-page="widgets"] [data-ui]');
  const sel = $("#wg-add-type");
  $("#wg-add").onclick = () =>
    invoke("emit_primary", { event: "add-widget", payload: sel.value })
      .then(afterBoardChange)
      .catch(() => {});
  $("#wg-edit").onclick = () =>
    invoke("set_edit_mode", { on: true }).catch(() => {});
  for (const id of ["work", "study"])
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
  $("#wg-layout-undo").onclick = async () => {
    const prev = await invoke("store_get", { key: "layouts_undo" }).catch(
      () => null,
    );
    if (!Array.isArray(prev)) return;
    await invoke("replace_widgets", { widgets: prev }).catch(() => {});
    await invoke("store_set", {
      key: "layouts_undo",
      value: null,
      src: "settings",
    }).catch(() => {});
    afterBoardChange();
  };
}
async function fillWidgets() {
  const sel = $("#wg-add-type");
  sel.innerHTML = "";
  for (const type of WIDGET_TYPES) {
    const o = document.createElement("option");
    o.value = type;
    o.textContent = t("widget." + type);
    sel.append(o);
  }
  const all = await invoke("get_all_widgets").catch(() => []);
  renderWidgetList(Array.isArray(all) ? all : []);
  renderWgLayouts();
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") win.close();
    else if (e.ctrlKey && (e.key === "Tab" || e.key === "PageDown"))
      (e.preventDefault(), cyclePage(e.shiftKey ? -1 : 1));
    else if (e.ctrlKey && e.key === "PageUp")
      (e.preventDefault(), cyclePage(-1));
  });
}
init();

// ---- browser mock (mirrors the app's mock contract; used when window.__TAURI__ is absent) ----
function settingsMock() {
  const handlers = {};
  const ls = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };
  const emit = (ev, p) =>
    (handlers[ev] || []).forEach((h) => h({ payload: p }));
  window.__mock = { emit };
  const cfg = () => JSON.parse(ls.get("wb-config") || "null") || { ui: {} };
  return {
    core: {
      async invoke(cmd, args) {
        if (window.__mockFail?.has(cmd))
          throw new Error("mock failure: " + cmd);
        switch (cmd) {
          case "get_settings":
            return {
              app: {
                lang: new URLSearchParams(location.search).get("lang") || "ko",
                onTop: ls.get("wb-ontop") === "1",
                reduceMotion: false,
              },
              theme: ls.get("wb-theme") || "",
              config: cfg(),
              autostart: {
                on: !!ls.get("wb-autostart"),
                disabledByWindows: !!window.__mockAutostartDisabled,
              },
              version: "0.12.0",
              displays: [
                { label: "board-0", display: "D1", index: 1, primary: true },
                { label: "board-1", display: "D2", index: 2, primary: false },
              ],
              widgets: JSON.parse(ls.get("wb-widgets") || "[]"),
              dataDir: "C:/mock/appdata",
            };
          case "set_app": {
            const p = args.patch || {};
            if ("onTop" in p) ls.set("wb-ontop", p.onTop ? "1" : "");
            (window.__native ||= []).push(["set_app", p]);
            if ("lang" in p) emit("lang-changed", p.lang);
            if ("reduceMotion" in p) emit("motion-changed", p.reduceMotion);
            return;
          }
          case "set_autostart":
            ls.set("wb-autostart", args.on ? "1" : "");
            return !!args.on;
          case "save_config": {
            const merge = (b, p) => {
              for (const [k, v] of Object.entries(p)) {
                if (v === null) {
                  delete b[k];
                  continue;
                }
                b[k] =
                  v && typeof v === "object" && !Array.isArray(v)
                    ? merge(b[k] && typeof b[k] === "object" ? b[k] : {}, v)
                    : v;
              }
              return b;
            };
            const c = merge(cfg(), args.patch);
            ls.set("wb-config", JSON.stringify(c));
            return emit("config-changed", c);
          }
          case "update_status":
            return {
              configured: true,
              current: "0.12.0",
              check: (cfg().update && cfg().update.check) || "weekly",
              lastCheck: 0,
            };
          case "update_check":
            emit("update-status", {
              configured: true,
              current: "0.12.0",
              check: (cfg().update && cfg().update.check) || "weekly",
              pending: { version: "0.12.1", notes: "" },
            });
            return;
          case "update_restart":
            window.__restarted = true;
            return;
          case "save_theme":
            ls.set("wb-theme", args.css);
            (window.__native ||= []).push(["save_theme", args.css]);
            return emit("theme-changed", args.css);
          case "open_theme_file":
            (window.__native ||= []).push(["open_theme_file"]);
            return;
          case "list_fonts":
            return ["Lexend", "Arial", "Georgia"];
          case "store_set":
            ls.set("wb-store-" + args.key, JSON.stringify(args.value));
            return;
          case "store_get": {
            const v = ls.get("wb-store-" + args.key);
            return v ? JSON.parse(v) : null;
          }
          case "get_all_widgets":
            return JSON.parse(ls.get("wb-widgets") || "[]");
          case "replace_widgets":
            ls.set("wb-widgets", JSON.stringify(args.widgets || []));
            (window.__native ||= []).push(["replace_widgets", args.widgets]);
            return emit("layout-replaced");
          case "set_edit_mode":
            (window.__native ||= []).push(["set_edit_mode", args.on]);
            return;
          case "emit_primary":
            (window.__native ||= []).push([
              "emit_primary",
              args.event,
              args.payload,
            ]);
            if (args.event === "add-widget") {
              const ws = JSON.parse(ls.get("wb-widgets") || "[]");
              ws.push({
                id: "w" + ws.length,
                type: args.payload,
                display: "D1",
              });
              ls.set("wb-widgets", JSON.stringify(ws));
            }
            return;
          case "list_backups":
            return {
              root: "C:/mock/Backups",
              items: JSON.parse(ls.get("wb-backups") || "[]"),
              backup: cfg().backup || { auto: "off", keep: 7, dir: "" },
            };
          case "backup_now": {
            const items = JSON.parse(ls.get("wb-backups") || "[]");
            const stamp = "20261001-1530";
            const path = "C:/mock/Backups/WidgetBoard-backup-" + stamp;
            if (!items.some((x) => x.path === path))
              items.unshift({
                name: "WidgetBoard-backup-" + stamp,
                path,
                created: stamp,
                app: "0.12.0",
              });
            ls.set("wb-backups", JSON.stringify(items));
            return path;
          }
          case "restore_backup":
            window.__restored = args.path;
            return;
          case "open_backups_folder":
            (window.__native ||= []).push(["open_backups_folder"]);
            return;
          case "open_config_file":
            (window.__native ||= []).push(["open_config_file"]);
            return;
          default:
            return null;
        }
      },
    },
    webviewWindow: {
      getCurrentWebviewWindow: () => ({
        listen: async (ev, h) => {
          (handlers[ev] ||= []).push(h);
          return () => (handlers[ev] = handlers[ev].filter((x) => x !== h));
        },
        close: async () => (window.__mock.closed = true),
      }),
    },
  };
}
