// Library window: every content item (memo, photos, timer...), on the board or not, plus Recently deleted.
// Content lives in content.json (Rust); boards act on "widget-restore" / "widget-locate" and on content-changed.
import { createMockTauri } from "./mock-tauri.js";
import { loadLang, t, applyStatic } from "./i18n.js";
import { sanitize, copyText } from "./theme.js";
import { syncScheme, esc, assetUrl, fold, appWindow } from "./util.js";
import CONTENT_KEYS from "./widgets/content-keys.json" with { type: "json" };
import GROUPS from "./widgets/groups.json" with { type: "json" };
import CATALOGUE from "./help/catalogue.json" with { type: "json" };
import { COLORS } from "./widgets/memo.js";
import { fmt as fmtTimer } from "./widgets/timer.js";
import { fmtTotal } from "./widgets/stopwatch.js";

// RULE: every backend call goes through T. Never call window.__TAURI__ directly: the mock (tests, browser
// preview, the demo) only replaces T, so a direct call reaches real app data from a page that must not touch it.
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
let selected = null; // id of the item whose card shows (its type's items fill the middle)
let assetsDir = "";
let lang = "ko";
let tab = "items"; // "items" | "browse" | "layouts"
let version = "";
let browsing = GROUPS[0].widgets[0]; // the widget type shown in Browse
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
  // the Timer widget shows as the mode it is in; old Stopwatch and Pomodoro items have their own type
  switch (c.type === "timer" ? d.mode || "timer" : c.type) {
    case "memo": {
      const bg = COLORS[d.color];
      return `<div class="lib-preview memo"${bg ? ` style="background:${bg}"` : ` style="color:inherit"`}>${esc(d.text ?? "")}</div>`;
    }
    case "image":
      return `<div class="lib-preview media">${img(d.imgs, t("lib.images", { n: (d.imgs ?? []).length }))}</div>`;
    case "collection":
      return `<div class="lib-preview media">${img(d.imgs ?? d.items, t("lib.items", { n: (d.imgs ?? d.items ?? []).length }))}</div>`;
    case "showcase":
      return `<div class="lib-preview media">${img(d.imgs, d.name ?? "")}</div>`;
    case "audioplayer":
    case "nowplaying":
      return `<div class="lib-preview">${esc(t("lib.tracks", { n: (d.tracks ?? []).length }))}\n${esc((d.tracks ?? []).map((x) => x.label).slice(0, 3).join("\n"))}</div>`;
    case "timer":
      return `<div class="lib-preview clock"><span class="big">${fmtTimer(d.endAt ? Math.max(0, d.endAt - Date.now()) : (d.remaining ?? d.duration ?? 0))}</span></div>`;
    case "stopwatch":
      return `<div class="lib-preview clock"><span class="big">${fmtTotal(d.elapsed ?? 0)}</span>\n${esc(t("time." + (d.cat || "focus")))}</div>`;
    case "pomodoro":
      return `<div class="lib-preview clock"><span class="big">${fmtTimer(d.endAt ? Math.max(0, d.endAt - Date.now()) : (d.remaining ?? 0))}</span>\n${esc(t("pomo." + (d.phase || "work")))}</div>`;
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

const when = (secs) =>
  new Date(secs * 1000).toLocaleString(lang === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" });

// The card beside the grid: the selected item's name (click to rename), where it is, and what can be done with it.
// The main action sits at the bottom; the rest are quiet links.
function cardHtml(c) {
  const b = (act, label, cls = "") => `<button data-act="${act}" class="${cls}">${esc(label)}</button>`;
  const name =
    renaming === c.id
      ? `<input class="lib-name" maxlength="40" value="${esc(c.name || "")}" placeholder="${esc(title(c))}">`
      : `<h2><button class="mine-name" data-act="rename" title="${esc(t("lib.rename"))}">${esc(title(c))}</button></h2>`;
  if (c.deletedAt) {
    const links =
      confirming === c.id
        ? `<span class="ask">${esc(t("lib.erase_confirm"))}</span>${b("erase-yes", t("lib.erase"), "danger")}${b("erase-no", t("lib.cancel"))}`
        : b("erase", t("lib.erase"), "danger");
    return `<p class="kind">${esc(t("lib.deleted"))} · ${esc(t("widget." + c.type))}</p>${name}
      <p class="meta">${esc(t("lib.deleted_at", { when: when(c.deletedAt) }))}</p>
      <div class="mine-links">${links}</div>${b("restore", t("lib.restore"), "primary")}`;
  }
  const on = placed.has(c.id);
  return `<p class="kind">${esc(t("widget." + c.type))}</p>${name}
    <p class="where"><span class="dot ${on ? "on" : ""}"></span>${esc(t(on ? "lib.on_board" : "lib.off_board"))}</p>
    ${c.updated ? `<p class="meta">${esc(t("lib.updated_at", { when: when(c.updated) }))}</p>` : ""}
    <div class="mine-links">${c.type === "memo" ? b("history", t("lib.history")) : ""}${b("delete", t("lib.delete"), "danger")}</div>
    ${on ? b("locate", t("lib.locate"), "primary") : b("show", t("lib.show"), "primary")}`;
}

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
  tab = ["layouts", "browse"].includes(name) ? name : "items";
  for (const b of document.querySelectorAll(".lib-tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  $(".lib-items").hidden = tab !== "items";
  $(".lib-browse").hidden = tab !== "browse";
  $(".lib-layouts").hidden = tab !== "layouts";
  if (tab === "layouts") renderLayouts();
  if (tab === "browse") renderBrowse();
}

// ---- Browse: every widget type, live, in the middle. The card only says what the widget can't show by itself. ----
// gal.<type>.1, .2, ... are optional; most widgets borrow a design people know and have none.
const notes = (type) => {
  const out = [];
  for (let i = 1; t(`gal.${type}.${i}`) !== `gal.${type}.${i}`; i++) out.push(t(`gal.${type}.${i}`));
  return out;
};
const isNew = (type) => !!version && CATALOGUE.some((e) => e.kind === "guide" && e.type === type && e.since === version);
// the preview frame's snapshot of the user's look, as Rust's open_demo builds it (the frame reads it, never real data)
function setPreviewInit(theme, config) {
  const c = structuredClone(config && typeof config === "object" ? config : {});
  c.ui = { ...(c.ui ?? {}), layoutMode: "grid", flashAlert: true };
  window.__previewInit = { theme, config: c };
}
function renderBrowse() {
  const list = $(".gal-list");
  list.replaceChildren();
  for (const group of GROUPS) {
    const h = document.createElement("h3");
    h.textContent = t(`group.${group.id}`);
    list.append(h);
    for (const type of group.widgets) {
      const b = document.createElement("button");
      b.dataset.type = type;
      b.textContent = t(`widget.${type}`);
      if (isNew(type)) b.insertAdjacentHTML("beforeend", `<span class="gal-new">${esc(t("lib.gal_new"))}</span>`);
      if (type === browsing) b.setAttribute("aria-current", "true");
      list.append(b);
    }
  }
  const group = GROUPS.find((g) => g.widgets.includes(browsing));
  $(".gal-group").textContent = group ? t(`group.${group.id}`) : "";
  $(".gal-card h2").textContent = t(`widget.${browsing}`);
  $(".gal-notes").replaceChildren(...notes(browsing).map((n) => Object.assign(document.createElement("li"), { textContent: n })));
  const frame = $(".gal-stage iframe");
  frame.title = t(`widget.${browsing}`);
  const src = `index.html?demo&preview=${encodeURIComponent(browsing)}&lang=${encodeURIComponent(lang)}`;
  if (frame.getAttribute("src") !== src) frame.src = src;
}
$(".gal-list").addEventListener("click", (e) => {
  const type = e.target.closest("[data-type]")?.dataset.type;
  if (type && type !== browsing) (browsing = type), renderBrowse();
});
$(".gal-add").addEventListener("click", () => {
  toBoard("add-widget", browsing);
  flash(t("lib.gal_added", { name: t(`widget.${browsing}`) }));
});
$(".lib-tabs").addEventListener("click", (e) => {
  const name = e.target.closest("[data-tab]")?.dataset.tab;
  if (name) showTab(name);
});

// ---- 내 위젯: groups by type (Recently deleted last) | every item of the selected one's group | its card ----
const group = (c) => (c.deletedAt ? "deleted" : c.type);
const TYPE_ORDER = Object.keys(CONTENT_KEYS);
/** Groups in list order, each sorted newest first; a search keeps only matching items. */
function groups() {
  const out = [];
  const keys = [...TYPE_ORDER, ...new Set(items.map((c) => c.type).filter((ty) => !TYPE_ORDER.includes(ty))), "deleted"];
  for (const key of keys) {
    const list = items
      .filter((c) => group(c) === key && (!query || matchesItem(c)))
      .sort((a, b) => (key === "deleted" ? b.deletedAt - a.deletedAt : b.updated - a.updated));
    if (list.length) out.push({ key, list });
  }
  return out;
}

function render() {
  const gs = groups();
  const all = gs.flatMap((g) => g.list);
  if (!all.some((c) => c.id === selected)) selected = all[0]?.id ?? null;
  const cur = all.find((c) => c.id === selected);
  const label = (key) => t(key === "deleted" ? "lib.deleted" : "widget." + key);
  $(".mine-rows").innerHTML = gs
    .map(
      ({ key, list }) =>
        `<h3>${esc(label(key))}<span>${list.length}</span></h3>` +
        list
          .map(
            (c) => `<button data-id="${esc(c.id)}" class="${c.deletedAt ? "gone" : ""}" ${c.id === selected ? 'aria-current="true"' : ""}>${
              c.deletedAt ? "" : `<span class="dot ${placed.has(c.id) ? "on" : ""}" title="${esc(t(placed.has(c.id) ? "lib.on_board" : "lib.off_board"))}"></span>`
            }<span class="t">${esc(title(c))}</span></button>`,
          )
          .join(""),
    )
    .join("");

  // the middle: while searching, every match (then diary and calendar hits); otherwise the selected item's group
  const shown = query ? all : (gs.find((g) => g.key === group(cur ?? {}))?.list ?? []);
  const rows = resultRows();
  const head = query ? t("lib.results") : cur ? label(group(cur)) : "";
  $(".lib-grid").innerHTML =
    shown.length || rows
      ? (shown.length ? `<h2>${esc(head)} ${shown.length}</h2>` : "") +
        shown
          .map(
            (c) => `<article class="lib-card ${c.deletedAt ? "gone" : ""}" data-id="${esc(c.id)}" tabindex="0" role="button" ${c.id === selected ? 'aria-current="true"' : ""} aria-label="${esc(title(c))}">
              ${preview(c)}<h3 title="${esc(title(c))}">${esc(title(c))}</h3></article>`,
          )
          .join("") +
        rows
      : `<p class="lib-empty">${esc(t(query ? "lib.no_results" : "lib.empty"))}</p>`;

  const card = $(".mine-card");
  card.hidden = !cur;
  card.innerHTML = cur ? cardHtml(cur) : "";
  if (renaming) {
    const input = $(".lib-name");
    input?.focus();
    input?.select();
  }
}

/** Select an item: its row, its card in the middle (scrolled into view) and the card on the right. */
function select(id) {
  if (id === selected) return;
  selected = id;
  confirming = renaming = null;
  render();
  $(`.lib-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
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

$(".lib-search").addEventListener("input", async (e) => {
  query = e.target.value.trim();
  if (query && !diary) await loadSearchData();
  render();
});

// pick an item from the list or the middle; double-click a card for its main action
$(".lib-items").addEventListener("click", async (e) => {
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
  const pick = e.target.closest(".mine-rows [data-id], .lib-card");
  if (pick) return select(pick.dataset.id);
  const act = e.target.closest(".mine-card [data-act]")?.dataset.act;
  if (act) await run(act, items.find((x) => x.id === selected));
});
$(".lib-grid").addEventListener("dblclick", (e) => {
  const c = items.find((x) => x.id === e.target.closest(".lib-card")?.dataset.id);
  if (c) run(c.deletedAt ? "restore" : placed.has(c.id) ? "locate" : "show", c);
});

async function run(act, c) {
  if (!c) return;
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
    case "erase-yes": {
      // stay in the group: the next item (or the one before) takes the selection
      const list = groups().find((g) => g.key === group(c))?.list ?? [];
      const i = list.indexOf(c);
      selected = (list[i + 1] ?? list[i - 1])?.id ?? null;
      confirming = null;
      if (act === "delete") await put(c, { deletedAt: Math.floor(Date.now() / 1000) });
      else {
        await invoke("content_erase", { id: c.id }).catch((err) => flash(String(err)));
        await load();
      }
      break;
    }
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
  }
}

// rename: Enter saves, Escape cancels, leaving the field saves
async function commitName(input) {
  const c = items.find((x) => x.id === renaming);
  renaming = null;
  const name = input.value.trim().slice(0, 40);
  if (c && name !== (c.name || "")) await put(c, { name });
  else render();
}
$(".lib-items").addEventListener("keydown", (e) => {
  // a card in the middle acts like a button
  if (e.target.matches(".lib-card") && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    return select(e.target.dataset.id);
  }
  if (!e.target.matches(".lib-name")) return;
  if (e.key === "Enter") commitName(e.target);
  if (e.key === "Escape") {
    e.stopPropagation();
    renaming = null;
    render();
  }
});
$(".lib-items").addEventListener("focusout", (e) => {
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
  version = data.version || "";
  assetsDir = data.assetsDir || "";
  lang = data.app.lang;
  applyTheme(data.theme);
  setPreviewInit(data.theme, data.config);
  await loadLang(data.app.lang, "library");
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
    showTab(["layouts", "browse"].includes(page) ? page : "items");
    if (page === "search") $(".lib-search").focus();
  };
  await listen("library-page", openPage);
  openPage(new URLSearchParams(location.search).get("page") || "items");
  await listen("theme-changed", (css) => {
    applyTheme(css);
    setPreviewInit(css, window.__previewInit?.config);
    if (tab === "browse") $(".gal-stage iframe").contentWindow?.location.reload();
  });
  await listen("lang-changed", async (code) => {
    lang = code;
    await loadLang(code, "library");
    applyStatic();
    render();
    if (tab === "layouts") renderLayouts();
    if (tab === "browse") renderBrowse();
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
