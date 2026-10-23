// Tutorial demo sample board. ui/tutorial/dataset/ is a WidgetBoard backup folder (manifest, layout.json, data/);
// this reads it and seeds the demo's in-memory mock through the commands the board itself uses. Nothing here
// touches window.__TAURI__ or any storage: `invoke` is app.js's wrapper over T, which is the mock in the demo.
//
// Text: a string that starts with TEXT is a locale key in board.json, resolved with t() in the demo's language.
// Dates: every date in the files is relative to manifest.anchor and shifted by (today - anchor) days.
//   Shifted: events.json `date`, `doneOn`, `doneDates[]`. The files hold no other dates (see the cargo test
//   `tutorial_dataset_is_a_valid_backup`, which fails if a timer field or a stray date is added without a shift).
// Placement: x/y in layout.json are ignored. Widgets are packed in file order by the board's own packSlots.
import { ymd, daysBetween, addDays } from "../util.js";

const BASE = "tutorial/dataset/";
const TEXT = "demo.sample.";
const ASSETS = "tutorial/assets"; // the demo board's assets folder (picture, cover and track names resolve here)
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const getJson = async (path) => {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`demo dataset: ${path} (${res.status})`);
  return res.json();
};

/**
 * `invoke` is app.js's backend call, `t` its translator, `display` this board's monitor id and `place(slots)` the
 * board's packSlots on the current grid. Returns what load_state would: { widgets, assetsDir }.
 */
export async function loadDataset({ invoke, t, display, place, focusWidget = null, only = false }) {
  const [manifest, layout, events, content] = await Promise.all(
    ["manifest.json", "layout.json", "data/events.json", "data/content.json"].map(getJson),
  );
  const shift = daysBetween(manifest.anchor, ymd());
  const day = (s) => (typeof s === "string" && DATE.test(s) ? addDays(s, shift) : s);
  const words = (v) =>
    typeof v === "string"
      ? v.startsWith(TEXT) ? t(v) : v
      : Array.isArray(v)
        ? v.map(words)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, words(x)]))
          : v;

  await invoke("store_set", {
    key: "events",
    value: events.map((e) => ({
      ...words(e),
      date: day(e.date),
      ...(e.doneOn && { doneOn: day(e.doneOn) }),
      ...(e.doneDates && { doneDates: e.doneDates.map(day) }),
    })),
    src: "demo",
  });
  for (const { rev, ...item } of Object.values(content.items)) await invoke("content_put", { item: words(item), rev: null, src: "demo" });

  const samples = layout.widgets.map((w) => structuredClone(w));
  if (focusWidget) {
    const index = samples.findIndex((w) => w.type === focusWidget.type);
    const sample = index >= 0 ? samples.splice(index, 1)[0] : structuredClone(focusWidget);
    delete sample.hidden;
    samples.unshift(sample);
    if (only) samples.length = 1; // the gallery preview: just this widget
  }
  const entries = samples.map((source) => ({ source, slot: [source.type, source.w, source.h] }));
  const bySlot = new Map(entries.map((entry) => [entry.slot, entry.source]));
  const widgets = place(entries.map((entry) => entry.slot)).map(({ slot, x, y, w, h }) => ({
    ...bySlot.get(slot), display, x, y, w, h,
  }));
  for (const w of widgets) await invoke("put_widget", { widget: w });

  // what Windows reports as playing (the mock's media_subscribe answers with this)
  window.__mockMedia = {
    has: true,
    title: t(TEXT + "song"),
    artist: t(TEXT + "artist"),
    album: "",
    source: "ZuneMusic",
    status: "playing",
    position: 72,
    duration: 263,
    updatedAt: Date.now(),
    canPlayPause: true,
    canNext: true,
    canPrev: true,
    canSeek: true,
    sessions: 1,
    thumb: `${ASSETS}/sample-cover.jpg`,
  };
  return { widgets, assetsDir: ASSETS };
}
