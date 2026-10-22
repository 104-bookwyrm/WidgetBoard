// Help state (shared store "help", data/help.json): what the tutorial and hints have already shown.
//   { demoDone, hintsSeen: [catalogue ids], typesUsed: [host types], whatsNewSeen: version | null }
// The board and the Settings window both write it, so every write names the revision it read (store_read / rev,
// as app.js writeStore does) and re-applies its patch to the latest state when that revision went stale.
// This module never touches window.__TAURI__: the caller passes its own invoke (see RULE at T in app.js).
const KEY = "help";
const defaults = () => ({ demoDone: false, hintsSeen: [], typesUsed: [], whatsNewSeen: null });
const merged = (v) => ({ ...defaults(), ...(v && typeof v === "object" && !Array.isArray(v) ? v : {}) });

/** The catalogue: [{ id, kind, level?, type?, sections?, since }]. Text keys are help.<id>.title / .body / .<section>. */
export const loadCatalogue = async () => (await fetch("help/catalogue.json")).json();

/** The help state, with defaults for anything missing. */
export const readHelp = async (invoke) => merged(await invoke("store_get", { key: KEY }));

/**
 * Update the state with a patch: an object, or a function of the latest state (use it for lists, so two windows
 * adding to hintsSeen both survive). Resolves to the stored state; retries once on a stale revision.
 */
export async function patchHelp(invoke, patch) {
  for (let tries = 0; ; tries++) {
    const r = await invoke("store_read", { key: KEY });
    const next = { ...merged(r.value), ...(typeof patch === "function" ? patch(merged(r.value)) : patch) };
    try {
      await invoke("store_set", { key: KEY, value: next, src: "help", rev: r.rev });
      return next;
    } catch (e) {
      if (e !== "conflict" || tries) throw e;
    }
  }
}

/** Atomically add one value to a help-state list. Only one window receives claimed=true. */
export async function claimHelp(invoke, key, value) {
  for (let tries = 0; ; tries++) {
    const r = await invoke("store_read", { key: KEY });
    const state = merged(r.value);
    const list = Array.isArray(state[key]) ? state[key] : [];
    if (list.includes(value)) return { claimed: false, state };
    const next = { ...state, [key]: [...list, value] };
    try {
      await invoke("store_set", { key: KEY, value: next, src: "help", rev: r.rev });
      return { claimed: true, state: next };
    } catch (e) {
      if (e !== "conflict" || tries) throw e;
    }
  }
}
