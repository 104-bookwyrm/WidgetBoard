// Library window: every content item (memo, photos, timer...), on the board or not, plus Recently deleted.
// Content lives in content.json (Rust); boards act on "widget-restore" / "widget-locate" and on content-changed.
import { createMockTauri } from "./mock-tauri.js";
import { loadLang, t, applyStatic } from "./i18n.js";
import { sanitize, copyText } from "./theme.js";
import { syncScheme, esc, assetUrl, fold, appWindow } from "./util.js";
import CONTENT_KEYS from "./widgets/content-keys.json" with { type: "json" };
import { COLORS } from "./widgets/memo.js";
import { fmt as fmtTimer } from "./widgets/timer.js";
import { fmtTotal } from "./widgets/stopwatch.js";

const T = window.__TAURI__ ?? createMockTauri();
appWindow();
// Ctrl+F means "search" here (the browser's find bar is blocked by appWindow)
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    showTab("items");
    $(".lib-search").focus();
  }
});
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const win = T.webviewWindow.getCurrentWebviewWindow();
const listen = (ev, h) => win.listen(ev, (e) => h(e.payload));
const emit = (ev, payload) => T.event.emit(ev, payload).catch(() => {});
const $ = (s) => document.querySelector(s);

let items = [];
let boardWidgets = []; // every placement on every board
let placed = new Set(); // content ids with a placement on some board
let query = ""; // search box
let diary = null; // { date: text }, loaded on the first search
let events = null; // calendar events, loaded on the first search
let filter = "all"; // "all" | a type | "deleted"
let assetsDir = "";
let lang = "ko";
let tab = "items"; // "items" | "layouts"
let renaming = null; // id being renamed
let confirming = null; // id asking "delete permanently?"

const url = (name) => assetUrl(assetsDir, name, T.core.convertFileSrc);
const firstImg = (list) => (Array.isArray(list) && list.length ? (list[0]?.img ?? list[0]) : "");
const title = (c) =>
  c.name ||
  (c.type === "memo" && String(c.data.text ?? "").split("\n")[0].slice(0, 40)) ||
  (c.type === "showcase" && c.data.name) ||
  t("widget." + c.type);

function preview(c) {
  const d = c.data || {};
  const img = (list, label) =>
    `${firstImg(list) ? `<img src="${esc(url(firstImg(list)))}" alt="">` : ""}${esc(label)}`;
  switch (c.type) {
    case "memo": {
      const bg = COLORS[d.color];
      return `<div class="lib-preview memo"${bg ? ` style="background:${bg}"` : ` style="color:inherit"`}>${esc(d.text ?? "")}</div>`;
    }
    case "image":
      return `<div class="lib-preview">${img(d.imgs, t("lib.images", { n: (d.imgs ?? []).length }))}</div>`;
    case "collection":
      return `<div class="lib-preview">${img(d.items, t("lib.items", { n: (d.items ?? []).length }))}</div>`;
    case "showcase":
      return `<div class="lib-preview">${img(d.imgs, d.name ?? "")}</div>`;
    case "audioplayer":
      return `<div class="lib-preview">${esc(t("lib.tracks", { n: (d.tracks ?? []).length }))}\n${esc((d.tracks ?? []).map((x) => x.label).slice(0, 3).join("\n"))}</div>`;
    case "timer":
      return `<div class="lib-preview"><span class="big">${fmtTimer(d.endAt ? Math.max(0, d.endAt - Date.now()) : (d.remaining ?? d.duration ?? 0))}</span></div>`;
    case "stopwatch":
      return `<div class="lib-preview"><span class="big">${fmtTotal(d.elapsed ?? 0)}</span>\n${esc(t("time." + (d.cat || "focus")))}</div>`;
    case "pomodoro":
      return `<div class="lib-preview"><span class="big">${fmtTimer(d.endAt ? Math.max(0, d.endAt - Date.now()) : (d.remaining ?? 0))}</span>\n${esc(t("pomo." + (d.phase || "work")))}</div>`;
  }
  return `<div class="lib-preview"></div>`;
}

// ---- search: Library content, diary pages, calendar events (local scan) ----
const ASSET = /^[0-9a-f]{8,}\.\w+$/; // uploaded file names are not text worth matching
const strings = (v) =>
  typeof v === "string" ? (ASSET.test(v) ? [] : [v])
  : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === "object" ? Object.values(v).flatMap(strings)
  : [];
const hit = (text) => !!query && fold(text).includes(fold(query));
const matchesItem = (c) => hit([title(c), ...strings(c.data)].join("\n"));
/** Text around the first match, the match marked. Original text is shown (NFC), never the folded copy. */
function snippet(text, radius = 40) {
  const shown = String(text).normalize("NFC").replace(/\s+/g, " ");
  const at = fold(shown).indexOf(fold(query));
  if (at < 0 || fold(shown).length !== shown.length) return esc(shown.slice(0, radius * 2));
  const from = Math.max(0, at - radius);
  const end = at + query.normalize("NFC").length;
  return (from ? "…" : "") + esc(shown.slice(from, at)) + "<mark>" + esc(shown.slice(at, end)) + "</mark>" +
    esc(shown.slice(end, end + radius)) + (end + radius < shown.length ? "…" : "");
}
async function loadSearchData() {
  [diary, events] = await Promise.all([
    invoke("diary_all").catch(() => ({})),
    invoke("store_get", { key: "events" }).catch(() => []),
  ]);
  if (!Array.isArray(events)) events = [];
}
function resultRows() {
  if (!query || !diary) return "";
  const days = Object.entries(diary).filter(([, text]) => hit(text)).sort((a, b) => b[0].localeCompare(a[0]));
  const evs = events.filter((e) => hit([e.title, ...(e.tags || [])].join(" "))).sort((a, b) => b.date.localeCompare(a.date));
  const row = (type, date, html) =>
    `<button class="lib-row" data-goto="${type}" data-date="${esc(date)}"><span class="when">${esc(date)}</span><span class="what">${html}</span></button>`;
  return (
    (days.length
      ? `<section class="lib-results"><h2>${esc(t("lib.diary"))}</h2>${days.map(([d, text]) => row("diary", d, snippet(text))).join("")}</section>`
      : "") +
    (evs.length
      ? `<section class="lib-results"><h2>${esc(t("lib.calendar"))}</h2>${evs.map((e) => row("calendar", e.date, snippet(e.title))).join("")}</section>`
      : "")
  );
}

function actions(c) {
  const b = (act, label, cls = "") => `<button data-act="${act}" class="${cls}">${esc(label)}</button>`;
  if (c.deletedAt) {
    if (confirming === c.id)
      return `<span class="badge">${esc(t("lib.erase_confirm"))}</span>${b("erase-yes", t("lib.erase"), "primary")}${b("erase-no", t("lib.cancel"))}`;
    return b("restore", t("lib.restore"), "primary") + b("erase", t("lib.erase"));
  }
  const where = placed.has(c.id)
    ? `<span class="badge">${esc(t("lib.on_board"))}</span>${b("locate", t("lib.locate"))}`
    : b("show", t("lib.show"), "primary");
  const history = c.type === "memo" ? b("history", t("lib.history")) : "";
  return where + history + b("rename", t("lib.rename")) + b("delete", t("lib.delete"));
}

const when = (secs) =>
  new Date(secs * 1000).toLocaleString(lang === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" });

// ---- memo History: the archived versions of one memo ----
async function openHistory(c) {
  const all = await invoke("memo_archive_list").catch(() => []);
  const versions = all.filter((v) => v.id === c.id).reverse();
  const box = $(".lib-history");
  const list = versions.length
    ? versions
        .map(
          (v, i) =>
            `<div class="ver"><span class="lib-type">${esc(when(v.t))}</span><pre>${esc(v.text)}</pre><button data-h="copy" data-i="${i}">${esc(t("set.archive.copy"))}</button></div>`,
        )
        .join("")
    : `<p class="lib-empty">${esc(t("lib.history_none"))}</p>`;
  box.innerHTML = `<div class="head"><b>${esc(t("lib.history"))} · ${esc(title(c))}</b><button data-h="close">${esc(t("theme.close"))}</button></div>${list}`;
  box.hidden = false;
  box.onclick = async (e) => {
    const h = e.target.closest("[data-h]")?.dataset.h;
    if (h === "close") box.hidden = true;
    if (h === "copy") flash(t((await copyText(versions[+e.target.dataset.i].text)) ? "lib.copied" : "lib.copy_failed"));
  };
  box.querySelector("[data-h=close]").focus();
}

// ---- Layouts tab: built-in presets, saved layouts, undo (the board applies them) ----
const PRESET_IDS = ["work", "study", "oshi"];
const toBoard = (event, payload = null) =>
  invoke("emit_primary", { event, payload })
    .then(() => setTimeout(() => (load(), renderLayouts()), 500)) // board-side ops land asynchronously
    .catch(() => {});
let confirmingLayout = null; // layout name asking "delete?"
async function renderLayouts() {
  $(".lay-presets").innerHTML = PRESET_IDS.map(
    (id) => `<button data-preset="${id}"><b>${esc(t("lay." + id))}</b><small>${esc(t("lay." + id + "_desc"))}</small></button>`,
  ).join("");
  const list = await invoke("store_get", { key: "layouts" }).catch(() => null);
  const layouts = (Array.isArray(list) ? list : []).filter((l) => l && typeof l.name === "string" && Array.isArray(l.widgets));
  const row = (l) =>
    confirmingLayout === l.name
      ? `<div class="lay-row"><span class="grow">${esc(t("lay.delete_confirm", { name: l.name }))}</span><button class="primary" data-lay="del-yes" data-name="${esc(l.name)}">${esc(t("lib.delete"))}</button><button data-lay="del-no">${esc(t("lib.cancel"))}</button></div>`
      : `<div class="lay-row"><span class="grow">${esc(l.name)} · ${esc(t("lay.count", { n: l.widgets.length }))}</span><button data-lay="apply" data-name="${esc(l.name)}">${esc(t("lay.apply"))}</button><button data-lay="del" data-name="${esc(l.name)}" title="${esc(t("lay.delete", { name: l.name }))}">${esc(t("lib.delete"))}</button></div>`;
  $(".lay-saved").innerHTML = layouts.length ? layouts.map(row).join("") : `<p class="hint">${esc(t("lay.none"))}</p>`;
  const undo = await invoke("store_get", { key: "layouts_undo" }).catch(() => null);
  $(".lay-undo").hidden = !Array.isArray(undo);
}
$(".lib-layouts").addEventListener("click", async (e) => {
  const preset = e.target.closest("[data-preset]")?.dataset.preset;
  if (preset) return toBoard("apply-preset", preset);
  const el = e.target.closest("[data-lay]");
  if (!el) return;
  const name = el.dataset.name;
  if (el.dataset.lay === "apply") return toBoard("apply-layout", name);
  if (el.dataset.lay === "del") confirmingLayout = name;
  if (el.dataset.lay === "del-no") confirmingLayout = null;
  if (el.dataset.lay === "del-yes") {
    confirmingLayout = null;
    const list = (await invoke("store_get", { key: "layouts" }).catch(() => null)) || [];
    await invoke("store_set", { key: "layouts", value: list.filter((l) => l?.name !== name), src: "library" }).catch(() => {});
  }
  renderLayouts();
});
$(".lay-save").addEventListener("click", async () => {
  const all = await invoke("get_all_widgets").catch(() => []);
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const name =
    $(".lay-name").value.trim().slice(0, 40) ||
    t("lay.default_name", { date: `${now.getMonth() + 1}/${now.getDate()} ${p2(now.getHours())}:${p2(now.getMinutes())}` });
  const list = (await invoke("store_get", { key: "layouts" }).catch(() => null)) || [];
  const next = [...list.filter((l) => l?.name !== name), { name, saved: now.toISOString(), widgets: all }].slice(-20);
  await invoke("store_set", { key: "layouts", value: next, src: "library" }).catch(() => {});
  $(".lay-name").value = "";
  flash(t("lay.saved_as", { name }));
  renderLayouts();
});
// the board undoes it: positions go back, what was typed since stays
$(".lay-undo").addEventListener("click", () => toBoard("undo-layout"));

function showTab(name) {
  tab = name === "layouts" ? "layouts" : "items";
  for (const b of document.querySelectorAll(".lib-tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  $(".lib-items").hidden = tab !== "items";
  $(".lib-layouts").hidden = tab !== "layouts";
  if (tab === "layouts") renderLayouts();
}
$(".lib-tabs").addEventListener("click", (e) => {
  const name = e.target.closest("[data-tab]")?.dataset.tab;
  if (name) showTab(name);
});

function render() {
  const live = items.filter((c) => !c.deletedAt);
  const deleted = items.filter((c) => c.deletedAt);
  const chip = (key, label, n) =>
    `<button data-filter="${key}" aria-pressed="${filter === key}">${esc(label)}${n != null ? ` ${n}` : ""}</button>`;
  $(".lib-chips").innerHTML =
    chip("all", t("lib.all"), live.length) +
    Object.keys(CONTENT_KEYS)
      .filter((ty) => live.some((c) => c.type === ty))
      .map((ty) => chip(ty, t("widget." + ty), live.filter((c) => c.type === ty).length))
      .join("") +
    chip("deleted", t("lib.deleted"), deleted.length);
  const shown = (
    filter === "deleted"
      ? deleted.sort((a, b) => b.deletedAt - a.deletedAt)
      : live.filter((c) => filter === "all" || c.type === filter).sort((a, b) => b.updated - a.updated)
  ).filter((c) => !query || matchesItem(c));
  const rows = filter === "deleted" ? "" : resultRows();
  const empty = query ? "lib.no_results" : filter === "deleted" ? "lib.deleted_empty" : "lib.empty";
  $(".lib-grid").innerHTML = (shown.length || rows
    ? shown
        .map(
          (c) => `<article class="lib-card" data-id="${esc(c.id)}">
            ${renaming === c.id ? `<input class="lib-name" value="${esc(c.name || "")}" placeholder="${esc(title(c))}">` : `<h3 title="${esc(title(c))}">${esc(title(c))}</h3>`}
            ${title(c) === t("widget." + c.type) ? "" : `<div class="lib-type">${esc(t("widget." + c.type))}</div>`}
            ${preview(c)}
            <div class="lib-actions">${actions(c)}</div>
          </article>`,
        )
        .join("")
    : `<p class="lib-empty">${esc(t(empty))}</p>`) + rows;
  if (renaming) {
    const input = $(".lib-name");
    input?.focus();
    input?.select();
  }
}

async function load() {
  const [list, widgets] = await Promise.all([
    invoke("content_list").catch(() => []),
    invoke("get_all_widgets").catch(() => []),
  ]);
  items = list;
  boardWidgets = widgets;
  placed = new Set(widgets.map((w) => w.id));
  if (query) await loadSearchData();
  if (filter !== "all" && filter !== "deleted" && !items.some((c) => c.type === filter && !c.deletedAt)) filter = "all";
  render();
}

let flashTimer;
function flash(msg) {
  const el = $(".lib-flash");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 2400);
}

/** Write one change to an item; a stale revision reloads the list instead. */
async function put(c, patch) {
  const item = { ...c, ...patch };
  delete item.rev;
  try {
    await invoke("content_put", { item, rev: c.rev, src: "library" });
  } catch (e) {
    if (e && "conflict" in e) flash(t("lib.changed"));
    else flash(String(e?.error ?? e));
  }
  await load();
}

$(".lib-chips").addEventListener("click", (e) => {
  const f = e.target.closest("[data-filter]")?.dataset.filter;
  if (!f) return;
  filter = f;
  confirming = renaming = null;
  render();
});

$(".lib-search").addEventListener("input", async (e) => {
  query = e.target.value.trim();
  if (query && !diary) await loadSearchData();
  render();
});

$(".lib-grid").addEventListener("click", async (e) => {
  // a diary/calendar result: that widget opens the date and is pointed out
  const go = e.target.closest("[data-goto]");
  if (go) {
    const type = go.dataset.goto;
    const w = boardWidgets.find((x) => x.type === type);
    if (!w) return flash(t("lib.no_widget", { type: t("widget." + type) }));
    emit("widget-locate", w.id);
    emit("goto-date", { type, date: go.dataset.date });
    return;
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  const c = items.find((x) => x.id === e.target.closest(".lib-card")?.dataset.id);
  if (!act || !c) return;
  switch (act) {
    case "show": {
      // the board of its last monitor puts it back where it was (or a free spot on the primary)
      const p = c.placement ?? {};
      emit("widget-restore", { ...p, id: c.id, type: c.type, settings: p.settings ?? {} });
      setTimeout(load, 500);
      break;
    }
    case "locate":
      emit("widget-locate", c.id);
      break;
    case "history":
      openHistory(c);
      break;
    case "rename":
      renaming = c.id;
      render();
      break;
    case "delete":
      await put(c, { deletedAt: Math.floor(Date.now() / 1000) });
      break;
    case "restore":
      await put(c, { deletedAt: null });
      break;
    case "erase":
      confirming = c.id;
      render();
      break;
    case "erase-no":
      confirming = null;
      render();
      break;
    case "erase-yes":
      confirming = null;
      await invoke("content_erase", { id: c.id }).catch((err) => flash(String(err)));
      await load();
      break;
  }
});

// rename: Enter saves, Escape cancels, leaving the field saves
async function commitName(input) {
  const c = items.find((x) => x.id === renaming);
  renaming = null;
  const name = input.value.trim().slice(0, 40);
  if (c && name !== (c.name || "")) await put(c, { name });
  else render();
}
$(".lib-grid").addEventListener("keydown", (e) => {
  if (!e.target.matches(".lib-name")) return;
  if (e.key === "Enter") commitName(e.target);
  if (e.key === "Escape") {
    e.stopPropagation();
    renaming = null;
    render();
  }
});
$(".lib-grid").addEventListener("focusout", (e) => {
  if (e.target.matches(".lib-name") && renaming) commitName(e.target);
});

function applyTheme(css) {
  let s = document.getElementById("theme-css");
  if (!s) {
    s = document.createElement("style");
    s.id = "theme-css";
    document.head.appendChild(s);
  }
  s.textContent = sanitize(typeof css === "string" ? css : "");
  syncScheme();
}

(async function init() {
  const data = await invoke("get_settings");
  assetsDir = data.assetsDir || "";
  lang = data.app.lang;
  applyTheme(data.theme);
  await loadLang(data.app.lang);
  applyStatic();
  await load();
  await listen("content-changed", load);
  await listen("content-erased", load);
  await listen("store-changed", (p) => {
    if (query && (p?.key === "diary" || p?.key === "events")) loadSearchData().then(render);
    else if (p?.key === "diary" || p?.key === "events") diary = events = null; // stale; reload on the next search
  });
  // which page the tray / menu asked for: items, search (cursor in the box) or layouts
  const openPage = (page) => {
    showTab(page === "layouts" ? "layouts" : "items");
    if (page === "search") $(".lib-search").focus();
  };
  await listen("library-page", openPage);
  openPage(new URLSearchParams(location.search).get("page") || "items");
  await listen("theme-changed", applyTheme);
  await listen("lang-changed", async (code) => {
    lang = code;
    await loadLang(code);
    applyStatic();
    render();
    if (tab === "layouts") renderLayouts();
  });
  addEventListener("focus", load); // widgets closed or opened on the board since
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (e.target.matches(".lib-search") && query) return; // the search box clears itself first
    if (!$(".lib-history").hidden) return void ($(".lib-history").hidden = true);
    win.close();
  });
  document.documentElement.dataset.ready = ""; // tests wait on html[data-ready]
})();
