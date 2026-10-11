// Library window: every content item (memo, photos, timer...), on the board or not, plus Recently deleted.
// Content lives in content.json (Rust); boards act on "widget-restore" / "widget-locate" and on content-changed.
import { createMockTauri } from "./mock-tauri.js";
import { loadLang, t, applyStatic } from "./i18n.js";
import { sanitize } from "./theme.js";
import { syncScheme, esc, assetUrl } from "./util.js";
import CONTENT_KEYS from "./widgets/content-keys.json" with { type: "json" };
import { COLORS } from "./widgets/memo.js";
import { fmt as fmtTimer } from "./widgets/timer.js";
import { fmtTotal } from "./widgets/stopwatch.js";

const T = window.__TAURI__ ?? createMockTauri();
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const win = T.webviewWindow.getCurrentWebviewWindow();
const listen = (ev, h) => win.listen(ev, (e) => h(e.payload));
const emit = (ev, payload) => T.event.emit(ev, payload).catch(() => {});
const $ = (s) => document.querySelector(s);

let items = [];
let placed = new Set(); // content ids with a placement on some board
let filter = "all"; // "all" | a type | "deleted"
let assetsDir = "";
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
      return `<div class="lib-preview"><span class="big">${esc(t("lib.laps", { t: fmtTotal(d.total ?? 0) }))}</span></div>`;
  }
  return `<div class="lib-preview"></div>`;
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
  return where + b("rename", t("lib.rename")) + b("delete", t("lib.delete"));
}

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
  const shown =
    filter === "deleted"
      ? deleted.sort((a, b) => b.deletedAt - a.deletedAt)
      : live.filter((c) => filter === "all" || c.type === filter).sort((a, b) => b.updated - a.updated);
  $(".lib-grid").innerHTML = shown.length
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
    : `<p class="lib-empty">${esc(t(filter === "deleted" ? "lib.deleted_empty" : "lib.empty"))}</p>`;
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
  placed = new Set(widgets.map((w) => w.id));
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

$(".lib-grid").addEventListener("click", async (e) => {
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
  applyTheme(data.theme);
  await loadLang(data.app.lang);
  applyStatic();
  await load();
  await listen("content-changed", load);
  await listen("content-erased", load);
  await listen("theme-changed", applyTheme);
  await listen("lang-changed", async (code) => {
    await loadLang(code);
    applyStatic();
    render();
  });
  addEventListener("focus", load); // widgets closed or opened on the board since
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) win.close();
  });
  document.documentElement.dataset.ready = ""; // tests wait on html[data-ready]
})();
