// One browser-only native substitute for boards and settings. Never touches real app data.
import REGISTRY from "./widgets/index.js";

export function createMockTauri() {
  const query = new URLSearchParams(location.search);
  const display = query.get("display") || "D1";
  const label = location.pathname.endsWith("settings.html")
    ? "settings"
    : display === "D1"
      ? "board-0"
      : "board-1";
  // The test runner injects metadata read from Cargo.toml and default-config.json.
  // A plain browser preview has no native version to report.
  const metadata = window.__mockMetadata ?? { version: "browser", config: {} };
  window.__mockConfig = structuredClone(metadata.config);
  const get = (key, fallback = null) =>
    JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback));
  const set = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const all = () => get("wb-widgets", []);
  const config = () => get("wb-config", window.__mockConfig);
  const app = () => ({
    lang: config().app?.lang || query.get("lang") || "ko",
    reduceMotion: config().app?.reduce_motion ?? query.has("rm"),
  });
  const displays = [
    { label: "board-0", display: "D1", index: 1, primary: true },
    { label: "board-1", display: "D2", index: 2, primary: false },
  ];
  const handlers = new Map();
  const channel = new BroadcastChannel("widgetboard-mock");
  const client = crypto.randomUUID();
  const clients = () => get("wb-mock-windows", {});
  const register = () =>
    set("wb-mock-windows", { ...clients(), [client]: label });
  register();
  addEventListener(
    "pagehide",
    () => {
      const current = clients();
      delete current[client];
      set("wb-mock-windows", current);
      channel.close();
    },
    { once: true },
  );
  const dispatch = (event, payload, target) => {
    if (target && target !== label) return;
    for (const handler of [...(handlers.get(event) || [])])
      handler({ payload: structuredClone(payload) });
  };
  const emit = (event, payload, target) => {
    dispatch(event, payload, target);
    channel.postMessage({ event, payload, target });
  };
  channel.onmessage = ({ data }) =>
    dispatch(data.event, data.payload, data.target);
  const listen = async (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event).delete(handler);
  };
  const native = (...call) => (window.__native ||= []).push(call);
  // per-store revisions, shared by every mock window through localStorage (Rust keeps them per session)
  const revOf = (slot) => get("wb-revs", {})[slot] ?? 0;
  const bumpRev = (slot, expected) => {
    const revs = get("wb-revs", {});
    const current = revs[slot] ?? 0;
    if (expected != null && expected !== current) throw "conflict";
    revs[slot] = current + 1;
    set("wb-revs", revs);
    return current + 1;
  };
  const calls = (...call) => (window.__calls ||= []).push(call);
  const merge = (base, patch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      return patch;
    if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete base[key];
      else base[key] = merge(base[key], value);
    }
    return base;
  };
  const update = () => {
    const found = get("wb-update-found");
    return {
      current: metadata.version,
      configured: !!window.__mockUpdate,
      check: config().update?.check || "weekly",
      lastCheck: 0,
      lastError: null,
      busy: false,
      available: found?.version === get("wb-update-skipped") ? null : found,
    };
  };
  const flushBoards = async () => {
    const labels = new Set(
      Object.values(clients()).filter((value) => value.startsWith("board-")),
    );
    if (!labels.size) return;
    const request = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Timed out flushing boards")),
        10000,
      );
      const finish = (error) => {
        clearTimeout(timer);
        handlers.get("saves-flushed")?.delete(ack);
        error ? reject(error) : resolve();
      };
      const ack = ({ payload }) => {
        if (payload.request !== request || !labels.delete(payload.label))
          return;
        if (payload.error) return finish(new Error(payload.error));
        if (!labels.size) finish();
      };
      if (!handlers.has("saves-flushed"))
        handlers.set("saves-flushed", new Set());
      handlers.get("saves-flushed").add(ack);
      for (const target of labels) emit("flush-saves", { request }, target);
    });
  };
  async function invoke(cmd, args = {}, options) {
    args = structuredClone(args); // native IPC snapshots arguments before any asynchronous work
    calls(cmd, args);
    if (window.__mockDelay?.[cmd])
      await new Promise((resolve) =>
        setTimeout(resolve, window.__mockDelay[cmd]),
      );
    if (window.__mockFail?.has(cmd)) throw new Error("mock failure: " + cmd);
    switch (cmd) {
      case "load_state":
        register();
        return {
          display,
          primary: display === "D1",
          displays,
          ...app(),
          config: config(),
          version: metadata.version,
          widgets: all().filter(
            (w) =>
              w.display === display ||
              (display === "D1" &&
                !displays.some((d) => d.display === w.display)),
          ),
          theme: localStorage.getItem("wb-theme") || "",
          assetsDir: "",
          autostart: !!localStorage.getItem("wb-autostart"),
        };
      case "get_settings":
        return {
          app: app(),
          config: config(),
          version: metadata.version,
          widgets: all(),
          displays,
          widgetTypes: Object.keys(REGISTRY),
          theme: localStorage.getItem("wb-theme") || "",
          dataDir: "C:/mock/appdata",
          autostart: {
            on: !!localStorage.getItem("wb-autostart"),
            disabledByWindows: !!window.__mockAutostartDisabled,
          },
        };
      case "save_config":
        if (window.__mockConfigBroken) throw "config_broken";
        {
          const cfg = merge(config(), args.patch);
          set("wb-config", cfg);
          emit("config-changed", cfg);
          return;
        }
      case "set_app": {
        native(cmd, args.patch);
        const before = app();
        const cfg = config();
        cfg.app = {
          ...cfg.app,
          lang: args.patch.lang ?? before.lang,
          reduce_motion: args.patch.reduceMotion ?? before.reduceMotion,
        };
        set("wb-config", cfg);
        if ("lang" in args.patch) emit("lang-changed", args.patch.lang);
        if ("reduceMotion" in args.patch)
          emit("motion-changed", args.patch.reduceMotion);
        return;
      }
      case "set_autostart":
        localStorage.setItem("wb-autostart", args.on ? "1" : "");
        return !!args.on;
      case "get_all_widgets":
        return all();
      case "put_widget":
        set("wb-widgets", [
          ...all().filter((w) => w.id !== args.widget.id),
          args.widget,
        ]);
        return;
      case "remove_widget":
        set(
          "wb-widgets",
          all().filter((w) => w.id !== args.id),
        );
        return;
      case "move_widget": {
        const target = displays.find((d) => d.display === args.display);
        if (!target) throw new Error("display not found");
        const widget = all().find((w) => w.id === args.id);
        if (!widget) throw new Error("widget not found");
        widget.display = args.display;
        set(
          "wb-widgets",
          all().map((w) => (w.id === args.id ? widget : w)),
        );
        emit("widget-arrived", widget, target.label);
        return;
      }
      case "replace_widgets":
        set("wb-widgets", args.widgets);
        native(cmd, args.widgets);
        emit("layout-replaced");
        return;
      case "flush_boards":
        return flushBoards();
      case "save_theme":
        localStorage.setItem("wb-theme", args.css);
        native(cmd, args.css);
        emit("theme-changed", args.css);
        return;
      case "store_get":
        return get("wb-store-" + args.key);
      case "store_read":
        return { value: get("wb-store-" + args.key), rev: revOf("store:" + args.key) };
      case "store_set": {
        const rev = bumpRev("store:" + args.key, args.rev);
        set("wb-store-" + args.key, args.value);
        emit("store-changed", { key: args.key, src: args.src, rev });
        return rev;
      }
      case "diary_get":
        return localStorage.getItem("wb-diary-" + args.date) || "";
      case "diary_read":
        return {
          text: localStorage.getItem("wb-diary-" + args.date) || "",
          rev: revOf("diary:" + args.date),
        };
      case "diary_set": {
        const rev = bumpRev("diary:" + args.date, args.rev);
        if (args.text.trim())
          localStorage.setItem("wb-diary-" + args.date, args.text);
        else localStorage.removeItem("wb-diary-" + args.date);
        emit("store-changed", { key: "diary", date: args.date, src: args.src, rev });
        return rev;
      }
      // Library content (content.rs): compare the revision, then write
      case "content_list":
        return Object.values(get("wb-content", {}));
      case "content_put": {
        const item = args.item || {};
        if (!item.id || !item.type) throw { error: "content needs an id and a type" };
        const items = get("wb-content", {});
        const current = items[item.id];
        if ((current?.rev ?? null) !== (args.rev ?? null)) throw { conflict: current ?? null };
        const now = Math.floor(Date.now() / 1000);
        const stored = {
          name: "", tags: [], deletedAt: null, data: {},
          ...item,
          rev: (current?.rev ?? 0) + 1,
          created: current?.created ?? now,
          updated: now,
        };
        items[item.id] = stored;
        set("wb-content", items);
        emit("content-changed", { item: stored, src: args.src });
        return stored;
      }
      case "content_erase": {
        const items = get("wb-content", {});
        if (!items[args.id]) return;
        if (items[args.id].deletedAt == null) throw "only deleted content can be erased";
        delete items[args.id];
        set("wb-content", items);
        emit("content-erased", { id: args.id });
        return;
      }
      case "diary_dates":
        return Object.keys(localStorage)
          .filter((k) => k.startsWith("wb-diary-"))
          .map((k) => k.slice(9))
          .sort();
      case "memo_archive_list":
        return get("wb-archive", []);
      case "memo_archive":
        return; // Archive history is supplied as a fixture; this mock writes no real files.
      case "save_asset":
        return URL.createObjectURL(new Blob([args]));
      case "list_assets":
        return [];
      case "list_fonts":
        return [
          "Malgun Gothic",
          "Segoe UI",
          "Arial",
          "Consolas",
          "Lexend",
          "Georgia",
        ];
      case "media_subscribe":
        return window.__mockMedia || { has: false };
      case "media_control":
        (window.__mockMediaCmds ||= []).push([args.action, args.seconds]);
        return;
      case "set_edit_mode":
        native(cmd, args.on);
        emit("edit-mode", args.on);
        return;
      case "set_kbd_mode":
        emit("kbd-mode", args.on);
        return;
      case "set_hit_rects":
        window.__hits = args.rects;
        return;
      case "set_interacting":
        return;
      case "emit_primary":
        native(cmd, args.event, args.payload);
        emit(args.event, args.payload, "board-0");
        return;
      case "update_status":
        return update();
      case "update_check": {
        set("wb-update-skipped", null);
        window.__updSkipped = null;
        const fixture = window.__mockUpdate;
        if (!fixture) {
          emit("update-failed", "not_configured");
          return;
        }
        if (fixture.found) {
          const found = { version: fixture.found, notes: fixture.notes || "" };
          set("wb-update-found", found);
          emit("update-status", update());
          emit("update-available", found);
        } else emit("toast", "upd.latest");
        return;
      }
      case "update_skip":
        set("wb-update-skipped", args.version);
        window.__updSkipped = args.version;
        return update();
      case "update_install":
        window.__installed = true;
        native(cmd, args);
        return;
      case "list_backups":
        return {
          root: "C:/mock/Backups",
          items: get("wb-backups", []),
          backup: config().backup || { auto: "off", keep: 7, dir: "" },
        };
      case "backup_now": {
        await flushBoards();
        const stamp = new Date()
          .toISOString()
          .replace(/[-:]/g, "")
          .slice(0, 13)
          .replace("T", "-");
        const path =
          "C:/mock/Backups/WidgetBoard-backup-" +
          stamp +
          "-" +
          crypto.randomUUID();
        set("wb-backups", [
          {
            name: path.split("/").at(-1),
            path,
            created: stamp,
            app: metadata.version,
          },
          ...get("wb-backups", []),
        ]);
        set("wb-backup-snapshot", {
          widgets: widgets(),
          diary: Object.fromEntries(
            Object.keys(localStorage)
              .filter((k) => k.startsWith("wb-diary-"))
              .map((k) => [k, localStorage.getItem(k)]),
          ),
        });
        return path;
      }
      case "restore_backup":
        window.__restored = args.path;
        emit("restoring", true);
        return;
      case "open_theme_file":
      case "open_config_file":
      case "open_backups_folder":
        native(cmd);
        return;
      case "set_dwell":
      case "set_zoom":
      case "set_hotkey":
      case "notify":
      case "open_settings":
      case "open_library":
      case "open_url":
        native(cmd, args);
        return;
      default:
        throw new Error("Unimplemented mock command: " + cmd);
    }
  }
  /** Tests: saved widgets with their Library content merged back into settings (what the widget sees). */
  const widgets = () => {
    const items = get("wb-content", {});
    return all().map((w) => {
      const c = items[w.id];
      return c ? { ...w, name: c.name || w.name, settings: { ...w.settings, ...c.data } } : w;
    });
  };
  window.__mock = { emit, invoke, widgets, menus: [] };
  return {
    core: { invoke, convertFileSrc: (p) => p },
    event: {
      emit: async (event, payload) => {
        native("emit", event, payload);
        emit(event, payload);
      },
    },
    webviewWindow: {
      getCurrentWebviewWindow: () => ({
        label,
        listen,
        close: async () => {
          window.__mock.closed = true;
        },
      }),
    },
    menu: {
      Menu: {
        new: async ({ items }) => ({
          items,
          popup: async () => window.__mock.menus.push(items),
          close: async () => {},
        }),
      },
    },
  };
}
