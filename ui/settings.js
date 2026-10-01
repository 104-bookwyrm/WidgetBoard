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
const $ = (sel) => document.querySelector(sel);
const cfgUi = () =>
  data?.config?.ui && typeof data.config.ui === "object" ? data.config.ui : {};

// ---- live "saved" feedback ----
let savedTimer;
function saved() {
  const el = $(".set-saved");
  el.textContent = t("set.saved");
  el.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("show"), 1200);
}

// ---- theme + accessibility (the window respects the app's own a11y) ----
function applyTheme(css) {
  let s = document.getElementById("theme-css");
  if (!s) {
    s = document.createElement("style");
    s.id = "theme-css";
    document.head.appendChild(s);
  }
  s.textContent = css || "";
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
    showPage(currentPage());
  });
  await listen("theme-changed", applyTheme);
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
