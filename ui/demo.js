// Tutorial demo stage: wallpaper, a fake taskbar with a tray icon, the replica tray menu and the practice-screen frame.
// Loaded by app.js in demo mode only. The backend is whatever T it is given (the in-memory mock); nothing here
// touches window.__TAURI__.
import TRAY from "./tray-menu.json" with { type: "json" };
import { icon } from "./icons.js";
import { t } from "./i18n.js";

const ASSETS = "tutorial/assets/";

/**
 * `T` is app.js's backend object, `invoke` its wrapper, `toast` the board's toast, `groupMenus` the board's
 * grouped add-widget menu helper and `isEdit` reads the board's edit state.
 */
export async function mountStage({ T, invoke, toast, groupMenus, isEdit }) {
  await new Promise((done) => {
    const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "demo.css" });
    css.onload = css.onerror = done;
    document.head.append(css);
  });
  document.body.classList.add("demo");

  const wallpaper = Object.assign(document.createElement("div"), { id: "demo-wallpaper" });
  const frame = Object.assign(document.createElement("div"), { id: "demo-frame" });
  const bar = Object.assign(document.createElement("div"), { id: "demo-taskbar" });
  for (const el of [wallpaper, frame]) el.setAttribute("aria-hidden", "true");
  bar.innerHTML = `
    <div class="dt-side"></div>
    <div class="dt-apps" aria-hidden="true">
      <span class="dt-app">${icon("grid")}</span>
      <span class="dt-search"></span>
      <span class="dt-app dt-a1"></span><span class="dt-app dt-a2"></span><span class="dt-app dt-a3"></span>
    </div>
    <div class="dt-side dt-tray">
      <span class="dt-chev" aria-hidden="true">${icon("up")}</span>
      <button id="demo-tray" type="button"><img src="${ASSETS}tray-icon.png" alt="" draggable="false" /></button>
      <span class="dt-clock" aria-hidden="true"><b></b><small></small></span>
    </div>`;
  document.body.append(wallpaper, bar, frame);

  const clock = () => {
    const now = new Date();
    bar.querySelector(".dt-clock b").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    bar.querySelector(".dt-clock small").textContent = now.toLocaleDateString([], { year: "numeric", month: "numeric", day: "numeric" });
  };
  clock();
  setInterval(clock, 15000);

  const tray = bar.querySelector("#demo-tray");
  const label = t("demo.tray_icon");
  tray.setAttribute("aria-label", label);
  tray.title = label;

  // the real tray hides or shows every board window; here it is the board layer (board, edit bar, panels)
  const setBoard = (on) => document.body.classList.toggle("demo-board-off", !on);
  const toggleBoard = () => setBoard(document.body.classList.contains("demo-board-off"));
  tray.onclick = toggleBoard;

  // one entry per tray-menu.json item, in its order; what each id does follows main.rs on_menu
  const items = () => {
    const unavailable = () => toast(t("demo.unavailable"));
    return TRAY.map((e) => {
      if (e === "-") return { item: "Separator" };
      const text = t(e.label);
      switch (e.id) {
        case "add":
          return {
            text,
            items: groupMenus((kind) => {
              setBoard(true);
              T.event.emit("add-widget", kind); // what the real tray sends to the board
            }),
          };
        case "edit":
          return {
            text: (isEdit() ? "✓ " : "") + text,
            action: () => {
              setBoard(true);
              invoke("set_edit_mode", { on: !isEdit() });
            },
          };
        case "toggle":
          return { text, action: toggleBoard };
        case "quit":
          return { text, action: () => (T.demoWindow ?? T.webviewWindow.getCurrentWebviewWindow()).close() };
        default:
          return { text, action: unavailable };
      }
    });
  };

  let lastMenu = null;
  let keyOpened = 0;
  async function openMenu(atButton) {
    try {
      await lastMenu?.close();
    } catch {}
    lastMenu = await T.menu.Menu.new({ items: items() });
    // from the keyboard the menu opens at the icon (the mouse can be anywhere), otherwise at the cursor
    const r = tray.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent("tutorial-action", { detail: "tray" }));
    await lastMenu.popup(atButton && T.dpi ? new T.dpi.LogicalPosition(r.left, r.top) : undefined);
  }
  tray.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (Date.now() - keyOpened > 500) openMenu(false);
  });
  tray.addEventListener("keydown", (e) => {
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    e.preventDefault();
    keyOpened = Date.now();
    openMenu(true);
  });
}
