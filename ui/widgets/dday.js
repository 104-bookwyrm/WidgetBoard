// D-day list: Discord-member-list style rows with circular icons (filter by status/tag, drag to reorder).
// Below the d-days: every upcoming calendar entry as a D-x countdown (never past), unless turned off in the menu.
// D-day items live in the shared `events` store (unified with the calendar): each is an event
// carrying a `dday:{mode,icon,mstep,munit,countFrom}` marker, so an item shows in both widgets.
import {
  esc,
  ymd,
  daysBetween,
  addDays,
  addMonths,
  uid,
  wheelScrollX,
  occursOn,
  eventDone,
  nextYearly,
  leapFallback,
} from "../util.js";
import { icon } from "../icons.js";

const STATUSES = ["all", "upcoming", "past"];

export default {
  size: { w: 3, h: 4 },
  min: { w: 2, h: 2 },
  // `items` persists only to carry legacy (pre-unify) data forward one last time; the live data is `events`.
  defaults: { items: [], filter: { status: "all", tags: [] }, cal: true },
  css: `
    .dd { position: absolute; inset: 0; padding: var(--head-h) var(--pad) var(--pad); box-sizing: border-box;
      display: flex; flex-direction: column; gap: var(--space-3); }
    .dd-top { display: flex; gap: var(--space-2); align-items: center; flex: none; min-width: 0; }
    .dd-view { flex: none; padding: 0 7px; font-size: var(--fs-small); }
    .dd-top .dd-filter { flex: 1; min-width: 0; }
    .dd-filter { display: flex; gap: var(--space-2); overflow-x: auto; scrollbar-width: none; flex: none;
      mask-image: linear-gradient(to right, #000 88%, transparent); }
    .dd-row.dd-auto { cursor: default; touch-action: auto; }
    .dd-row.dd-auto .dd-av { background: color-mix(in srgb, var(--c3) 14%, transparent); color: var(--text-muted); }
    .dd-sep { border-top: var(--line-width) var(--line-style) var(--line-color); margin: 4px 4px; opacity: .6; }
    .dd-filter .chip { max-width: 9em; overflow: hidden; text-overflow: ellipsis; flex: none; }
    .dd-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-1);
      scrollbar-width: thin; }
    .dd-row { display: flex; align-items: center; gap: .7em; padding: .35em .45em; border-radius: var(--r-inner);
      cursor: pointer; touch-action: none; }
    .dd-row:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .dd-row.dragging { opacity: .25; }
    .dd-row.drop-before { box-shadow: 0 -2px 0 var(--c2); }
    .dd-row.drop-after { box-shadow: 0 2px 0 var(--c2); }
    .dd-list.drop-empty { outline: 2px dashed var(--c2); outline-offset: -2px; border-radius: var(--r-inner); }
    .dd-av { width: 2.4em; height: 2.4em; border-radius: 50%; flex: none; overflow: hidden;
      background: var(--c2); display: grid; place-items: center; font-weight: 700; color: var(--on-accent); }
    .dd-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dd-text { flex: 1; min-width: 0; }
    .dd-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dd-sub { font-size: var(--fs-meta); color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dd-d { font-weight: 700; font-family: var(--font-num, var(--font)); color: var(--c2); white-space: nowrap; font-variant-numeric: tabular-nums; flex: none; }
    .dd-d.today { background: var(--c2); color: var(--on-accent); padding: 0 .5em; border-radius: 999px; }
    .dd-d.past { color: var(--text-faint); }
    .dd-empty { margin: auto; padding: 4px 10px; font-size: 1.3em; line-height: 1; color: var(--text-muted); }
    .dd-ghost { position: fixed; z-index: 100; pointer-events: none; background: var(--c1);
      border-radius: var(--r-inner); box-shadow: 0 6px 22px rgb(0 0 0 / .45); opacity: .95; font-family: var(--font); }
    .dd-editor { position: absolute; inset: 0; z-index: 6; padding: calc(var(--head-h) + 4px) calc(var(--pad) + 2px) calc(var(--pad) + 2px); box-sizing: border-box;
      background: color-mix(in srgb, var(--c1) 96%, transparent); overflow-y: auto;
      display: flex; flex-direction: column; gap: var(--space-3); font-size: var(--fs-small); }
    .dd-ed-top { display: flex; gap: var(--space-4); align-items: center; }
    .dd-ed-top .dd-av { width: 3.4em; height: 3.4em; cursor: pointer; border: 0; padding: 0; font-size: 1em; }
    .dd-ed-fields { flex: 1; display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
    .dd-editor input, .dd-editor select { width: 100%; box-sizing: border-box; }
    .dd-ms { display: flex; flex-direction: column; gap: var(--space-3); }
    .dd-ms-row { display: flex; gap: var(--space-3); align-items: center; }
    .dd-ms-row > span { flex: none; color: var(--text-muted); }
    .dd-ms-row input[data-f=mstep] { width: 4em; flex: none; }
    .dd-ms-row select { flex: 1; }
    .dd-ms-cf { display: flex; gap: var(--space-3); align-items: center; font-size: var(--fs-small); color: var(--text-faint); }
    .dd-ms-cf input { width: auto; flex: none; }
    .dd-icons { display: flex; flex-wrap: wrap; gap: var(--space-3); max-height: 8.5em; overflow-y: auto; }
    .dd-icons .dd-av { width: 2.2em; height: 2.2em; cursor: pointer; font-size: var(--fs-meta); border: 0; padding: 0; }
    .dd-icons .dd-av.sel { outline: 2px solid var(--c2); outline-offset: 1px; }
    .dd-ed-btns { display: flex; gap: var(--space-3); margin-top: auto; }
    .dd-ed-btns .sp { flex: 1; }
    .dd-text { min-width: 1.2em; }
    @container (max-width: 13em) {
      .dd-sub { display: none; }
      .dd-av { width: 1.7em; height: 1.7em; font-size: var(--fs-small); }
      .dd-d { font-size: var(--fs-small); }
      .dd-row { gap: .45em; }
    }
  `,
  mount(root, s, api) {
    const { t } = api;
    const validDate = (d) =>
      typeof d === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      !isNaN(new Date(d));
    s.items = (Array.isArray(s.items) ? s.items : [])
      .filter((i) => i && typeof i === "object")
      .map((i) => ({
        ...i,
        id: i.id || uid(),
        name: String(i.name ?? ""),
        tag: String(i.tag ?? ""),
        date: validDate(i.date) ? i.date : ymd(),
        // milestone: celebrate every `mstep` days/months (0 = off). countFrom 'one' = Korean inclusive count.
        mstep: Number.isFinite(+i.mstep) && +i.mstep > 0 ? Math.floor(+i.mstep) : 0,
        munit: i.munit === "months" ? "months" : "days",
        countFrom: i.countFrom === "zero" ? "zero" : "one",
      }));
    if (!s.filter || typeof s.filter !== "object") s.filter = {};
    if (!STATUSES.includes(s.filter.status)) s.filter.status = "all";
    if (!Array.isArray(s.filter.tags)) s.filter.tags = [];
    delete s.view; // the old schedule view: its rows are in the list now
    s.cal = s.cal !== false;

    // ---- shared-store data layer ----
    // `events` is the whole shared store; `items` is the d-day view over it (events with a marker).
    let events = [];
    let items = [];
    const isDday = (e) =>
      e && typeof e === "object" && e.dday && typeof e.dday === "object";
    const normMode = (m) => (m === "since" ? "since" : "until");
    const normUnit = (u) => (u === "months" ? "months" : "days");
    const normStep = (n) =>
      Number.isFinite(+n) && +n > 0 ? Math.floor(+n) : 0;
    const normCF = (c) => (c === "zero" ? "zero" : "one");
    // event -> the item shape the rest of the widget works with (name↔title, tag↔tags[0])
    const toItem = (e) => ({
      id: e.id,
      name: String(e.title ?? ""),
      date: validDate(e.date) ? e.date : ymd(),
      tag: String((e.tags || [])[0] ?? ""),
      icon: e.dday.icon ?? null,
      mode: normMode(e.dday.mode),
      mstep: normStep(e.dday.mstep),
      munit: normUnit(e.dday.munit),
      countFrom: normCF(e.dday.countFrom),
      yearly: e.repeat === "yearly", // birthdays, anniversaries: counts down to the next one
      fromShowcase: e._src === "showcase", // a Showcase birthday: the Showcase owns its name and date
    });
    // item -> event, keeping any extra fields the same event picked up in the calendar (time/url/…)
    const toEvent = (it, prev) => ({
      ...(prev || {}),
      id: it.id,
      date: it.date,
      title: String(it.name ?? ""),
      tags: it.tag ? [it.tag] : [],
      repeat: it.yearly && it.mode !== "since" ? "yearly" : null,
      done: prev?.done ?? false,
      dday: {
        mode: normMode(it.mode),
        icon: it.icon ?? null,
        mstep: normStep(it.mstep),
        munit: normUnit(it.munit),
        countFrom: normCF(it.countFrom),
      },
    });
    // write d-day items back into the shared store, leaving every non-d-day event untouched
    const persist = () => {
      const prev = new Map(events.map((e) => [e.id, e]));
      events = [
        ...events.filter((e) => !isDday(e)),
        ...items.map((it) => toEvent(it, prev.get(it.id))),
      ];
      return api.store.set("events", events).catch(() => {});
    };
    // one-time, idempotent-by-id migration of legacy settings-stored items into the shared store
    function migrateLegacy() {
      if (!Array.isArray(s.items) || !s.items.length) return false;
      const seen = new Set(events.map((e) => e.id));
      let added = 0;
      for (const it of s.items) {
        if (!it || !it.id || seen.has(it.id)) continue;
        events.push(toEvent(it));
        seen.add(it.id);
        added++;
      }
      s.items = []; // drop the legacy copy so it can't resurrect or double-count
      api.save();
      // ponytail: defer the store write to a macrotask so it lands after boot wires the
      // store-changed listener and sibling widgets finish their first load — otherwise a
      // calendar mounted in the same tick keeps its empty startup snapshot and misses the migration.
      if (added) setTimeout(() => api.store.set("events", events).catch(() => {}), 0);
      return added > 0;
    }

    root.innerHTML = `
      <div class="dd">
        <div class="dd-top">
          <div class="dd-filter"></div>
        </div>
        <div class="dd-list"></div>
        <div class="dd-editor" hidden></div>
      </div>`;
    const box = root.firstElementChild;
    const bar = box.querySelector(".dd-filter");
    const list = box.querySelector(".dd-list");
    const editor = box.querySelector(".dd-editor");
    wheelScrollX(bar);

    const today = () => ymd();
    // the day it counts to: a yearly item's next occurrence, else its own date
    const dateOf = (it) =>
      it.yearly && it.mode !== "since" ? nextYearly(it.date, today()) : it.date;
    const diffOf = (it) => daysBetween(today(), dateOf(it));

    // Running "days elapsed" label for a since-item, honouring its counting convention.
    function sinceCount(it) {
      const elapsed = daysBetween(it.date, today()); // today - anchor
      return it.countFrom === "zero"
        ? t("dday.plus", { n: Math.max(0, elapsed) }) // D+100 = anchor + 100
        : t("dday.since", { n: elapsed + 1 }); // 101일째 = anchor + 100 (day 1 = anchor)
    }

    // Next upcoming milestone for a since-item: { label, date, countdown } or null.
    function milestone(it) {
      if (it.mode !== "since" || !it.mstep) return null;
      const step = it.mstep;
      if (it.munit === "months") {
        const [ay, am] = it.date.split("-").map(Number);
        const [ty, tm] = today().split("-").map(Number);
        const elapsed = Math.max(0, (ty - ay) * 12 + (tm - am));
        let k = Math.max(step, Math.ceil(elapsed / step) * step);
        // correct for day-of-month: the clamped date may land just before/after today
        while (daysBetween(today(), addMonths(it.date, k)) < 0) k += step;
        while (k > step && daysBetween(today(), addMonths(it.date, k - step)) >= 0)
          k -= step;
        const date = addMonths(it.date, k);
        return { label: t("dday.ms_month", { n: k }), date, countdown: daysBetween(today(), date) };
      }
      // days — 'one' counts day 1 as the anchor (Nth day = anchor + N-1); 'zero' = exact days
      const base = it.countFrom === "zero" ? 0 : 1;
      const need = daysBetween(it.date, today()) + base;
      let m = Math.max(step, Math.ceil(need / step) * step);
      while (daysBetween(today(), addDays(it.date, m - base)) < 0) m += step;
      const date = addDays(it.date, m - base);
      return { label: t("dday.ms_day", { n: m }), date, countdown: daysBetween(today(), date) };
    }

    function dLabel(it) {
      const ms = milestone(it);
      if (ms) return ms.countdown > 0 ? `D-${ms.countdown}` : "D-Day";
      const diff = diffOf(it);
      if (it.mode === "since" && diff <= 0)
        return t("dday.since", { n: 1 - diff });
      return diff > 0 ? `D-${diff}` : diff === 0 ? "D-Day" : `D+${-diff}`;
    }
    const tagsOf = () =>
      [...new Set([...items.map((i) => i.tag), ...upcoming(false).flatMap((r) => r.e.tags || [])].filter(Boolean))].sort();

    // Upcoming shared entries (calendar entries, to-dos, quotas; not d-days) by next occurrence within a year. Dailies are
    // not countdowns; a ticked occurrence leaves the list until the next one. `filtered`: status and tag chips.
    function upcoming(filtered = true) {
      if (!s.cal || (filtered && s.filter.status === "past")) return [];
      const t0 = today();
      const rows = [];
      for (const e of events) {
        if (!e || typeof e.date !== "string" || isDday(e) || e.repeat === "daily") continue;
        if (filtered && s.filter.tags.length && !(e.tags || []).some((g) => s.filter.tags.includes(g))) continue;
        let next = null;
        for (let i = 0; i <= 366 && !next; i++) {
          const d = addDays(t0, i);
          if (occursOn(e, d) && !eventDone(e, d)) next = d;
        }
        if (next) rows.push({ e, date: next, days: daysBetween(t0, next) });
      }
      return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.e.time || "").localeCompare(b.e.time || ""));
    }
    function visible() {
      const f = s.filter;
      return items.filter((it) => {
        const diff = diffOf(it);
        if (f.status === "upcoming" && diff < 0) return false;
        if (f.status === "past" && diff >= 0) return false;
        if (f.tags.length && !f.tags.includes(it.tag)) return false;
        return true;
      });
    }
    // first user-perceived character: a whole emoji (🎂, ❤️‍🔥), never half a surrogate pair
    const initial = (name) =>
      [...new Intl.Segmenter().segment(String(name ?? "").trim() || "?")][0].segment;
    const avatar = (it, cls = "") =>
      `<div class="dd-av ${cls}">${it.icon ? `<img src="${esc(api.assetUrl(it.icon))}" alt="">` : esc(initial(it.name))}</div>`;

    function render() {
      renderList();
    }

    const autoRows = (rows) =>
      rows
        .map(({ e, date, days }) => {
          const label = days === 0 ? "D-Day" : `D-${days}`;
          const when = [
            date.replaceAll("-", ".") + (e.time ? " " + e.time : ""),
            e.repeat === "yearly" && leapFallback(e.date, date) ? t("dday.leap_note") : "",
            ...(e.tags || []).map((g) => "#" + g),
          ]
            .filter(Boolean)
            .join(" · ");
          const name = e.title || "";
          return `<div class="dd-row dd-auto" title="${esc(name)}\n${esc(when)}" aria-label="${esc(name + ", " + label + ", " + when)}">
          <div class="dd-av">${icon("calendar")}</div>
          <div class="dd-text"><div class="dd-name">${esc(name)}</div><div class="dd-sub">${esc(when)}</div></div>
          <div class="dd-d ${days === 0 ? "today" : ""}">${esc(label)}</div></div>`;
        })
        .join("");

    function renderList() {
      s.filter.tags = s.filter.tags.filter((tg) => tagsOf().includes(tg));
      const auto = upcoming();
      bar.hidden = !items.length && !upcoming(false).length;
      bar.innerHTML =
        `<button class="chip on" data-status>${t("dday.status." + s.filter.status)}</button>` +
        tagsOf()
          .map(
            (tg) =>
              `<button class="chip ${s.filter.tags.includes(tg) ? "on" : ""}" data-tag="${esc(tg)}" title="#${esc(tg)}">#${esc(tg)}</button>`,
          )
          .join("");
      const vis = visible();
      list.innerHTML = vis.length || auto.length
        ? vis
            .map((it) => {
              const ms = milestone(it);
              const diff = diffOf(it);
              const cls = ms
                ? ms.countdown === 0
                  ? "today"
                  : ""
                : diff === 0
                  ? "today"
                  : diff < 0 && it.mode !== "since"
                    ? "past"
                    : "";
              const sub = ms
                ? [
                    sinceCount(it),
                    t("dday.next", { m: ms.label }),
                    it.tag ? "#" + it.tag : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : [
                    dateOf(it).replaceAll("-", "."),
                    it.yearly && it.mode !== "since" ? t("dday.yearly") : "",
                    leapFallback(it.date, dateOf(it)) ? t("dday.leap_note") : "",
                    it.tag ? "#" + it.tag : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
              return `<div class="dd-row" data-id="${esc(it.id)}" role="button" tabindex="0" aria-label="${esc(it.name + ", " + dLabel(it) + ", " + sub)}" title="${esc(it.name)}\n${esc(sub)}">${avatar(it)}
              <div class="dd-text"><div class="dd-name">${esc(it.name)}</div><div class="dd-sub">${esc(sub)}</div></div>
              <div class="dd-d ${cls}">${esc(dLabel(it))}</div></div>`;
            })
            .join("") +
          (auto.length ? (vis.length ? `<div class="dd-sep" role="separator"></div>` : "") + autoRows(auto) : "")
        : `<button class="dd-empty" data-a="add" title="${esc(t("dday.add"))}" aria-label="${esc(t("dday.add"))}">+</button>`;
    }

    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-status")) {
        s.filter.status =
          STATUSES[(STATUSES.indexOf(s.filter.status) + 1) % STATUSES.length];
      } else {
        const tg = b.dataset.tag;
        s.filter.tags = s.filter.tags.includes(tg)
          ? s.filter.tags.filter((x) => x !== tg)
          : [...s.filter.tags, tg];
      }
      api.save();
      render();
    });

    // ---- drag rows to reorder ----
    // All d-day widgets now share one list, so a drop onto any d-day list is just a reorder of the
    // shared order (the marker lets the drag code recognise a d-day list as a drop target).
    list.__dday = true;
    function insert(item, beforeId) {
      let idx = beforeId ? items.findIndex((i) => i.id === beforeId) : -1;
      if (idx < 0) {
        // after the last visible item (keeps filtered views sensible), else at the end
        const vis = visible();
        idx = vis.length ? items.indexOf(vis.at(-1)) + 1 : items.length;
      }
      items.splice(idx, 0, item);
    }

    let endDrag = null; // set while a reorder drag runs; destroy() calls it
    list.addEventListener("pointerdown", (e) => {
      const row = e.target.closest(".dd-row");
      if (!row || row.classList.contains("dd-auto") || e.button !== 0) return;
      const item = items.find((i) => i.id === row.dataset.id);
      const sx = e.clientX,
        sy = e.clientY;
      let ghost = null,
        target = null,
        marked = [];
      row.setPointerCapture(e.pointerId);

      const clearMarks = () => {
        marked.forEach((m) =>
          m.classList.remove("drop-before", "drop-after", "drop-empty"),
        );
        marked = [];
      };
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          api.setInteracting(true);
          const r = row.getBoundingClientRect();
          ghost = row.cloneNode(true);
          ghost.classList.add("dd-ghost");
          ghost.style.width = r.width + "px";
          ghost.style.fontSize = getComputedStyle(row).fontSize;
          ghost._dx = sx - r.left;
          ghost._dy = sy - r.top;
          document.body.append(ghost);
          row.classList.add("dragging");
        }
        ghost.style.left = ev.clientX - ghost._dx + "px";
        ghost.style.top = ev.clientY - ghost._dy + "px";
        // auto-scroll a long list while dragging near its top/bottom edge
        const lr = list.getBoundingClientRect();
        if (ev.clientY < lr.top + 24) list.scrollTop -= 12;
        else if (ev.clientY > lr.bottom - 24) list.scrollTop += 12;
        clearMarks();
        const tl = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest(".dd-list");
        target = null;
        if (!tl?.__dday) return;
        const rows = [...tl.querySelectorAll(".dd-row:not(.dragging):not(.dd-auto)")];
        const before = rows.find(
          (r) =>
            ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2,
        );
        target = { list: tl, beforeId: before?.dataset.id };
        const mark = before
          ? [before, "drop-before"]
          : rows.length
            ? [rows.at(-1), "drop-after"]
            : [tl, "drop-empty"];
        mark[0].classList.add(mark[1]);
        marked.push(mark[0]);
      };
      // release is watched on the window: a store sync or day change can re-render `row` away
      const up = (ev) => {
        endDrag = null;
        row.removeEventListener("pointermove", move);
        row.removeEventListener("lostpointercapture", up);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        clearMarks();
        if (!ghost) return ev?.type === "pointerup" && openEditor(item); // plain click = edit
        ghost.remove();
        row.classList.remove("dragging");
        api.setInteracting(false);
        if (!target || target.beforeId === item.id) return;
        items = items.filter((i) => i.id !== item.id);
        insert(item, target.beforeId);
        persist();
        render();
      };
      endDrag = up;
      row.addEventListener("pointermove", move);
      row.addEventListener("lostpointercapture", up);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    });

    // keyboard: Enter opens the editor, Alt+↑/↓ moves the D-day up/down (same as dragging)
    list.addEventListener("keydown", (e) => {
      const row = e.target.closest(".dd-row");
      if (!row || row.classList.contains("dd-auto")) return;
      const item = items.find((i) => i.id === row.dataset.id);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        return openEditor(item);
      }
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const vis = visible();
        const j = vis.indexOf(item) + (e.key === "ArrowUp" ? -1 : 1);
        if (j < 0 || j >= vis.length) return;
        const other = vis[j];
        const a = items.indexOf(item),
          b = items.indexOf(other);
        [items[a], items[b]] = [items[b], items[a]];
        persist();
        render();
        list.querySelector(`[data-id="${CSS.escape(item.id)}"]`)?.focus();
        api.announce?.(`${item.name} ${j + 1}/${vis.length}`);
      }
    });

    // ---- editor ----
    list.addEventListener("click", (e) => e.target.closest("[data-a=add]") && openEditor(null));
    function openEditor(existing) {
      const it = existing
        ? { ...existing }
        : {
            id: uid(),
            name: "",
            date: today(),
            icon: null,
            tag: "",
            mode: "until",
            yearly: false,
            mstep: 0,
            munit: "days",
            countFrom: "one",
          };
      const tagOpts = tagsOf()
        .map((tg) => `<option value="${esc(tg)}">`)
        .join("");
      editor.innerHTML = `
        <div class="dd-ed-top">
          <button class="dd-av" data-a="icon" title="${t("dday.icon")}"></button>
          <div class="dd-ed-fields">
            <input data-f="name" placeholder="${t("dday.name")}" value="${esc(it.name)}">
            <input data-f="date" type="date" value="${esc(it.date)}">
          </div>
        </div>
        <div class="dd-icons" hidden></div>
        <input data-f="tag" list="dd-tags-${esc(it.id)}" placeholder="${t("dday.tag")}" value="${esc(it.tag)}">
        <datalist id="dd-tags-${esc(it.id)}">${tagOpts}</datalist>
        <select data-f="mode">
          <option value="until">${t("dday.mode_until")}</option>
          <option value="since">${t("dday.mode_since")}</option>
        </select>
        <label class="dd-ms-cf dd-yearly"><input data-f="yearly" type="checkbox"> ${t("dday.yearly")}</label>
        ${it.fromShowcase ? `<div class="dd-ms-cf">${t("dday.from_showcase")}</div>` : ""}
        <div class="dd-ms" hidden>
          <div class="dd-ms-row">
            <span>${t("dday.milestone")}</span>
            <input data-f="mstep" type="number" min="0" step="1" inputmode="numeric" value="${it.mstep || ""}" placeholder="0">
            <select data-f="munit">
              <option value="days">${t("dday.unit_days")}</option>
              <option value="months">${t("dday.unit_months")}</option>
            </select>
          </div>
          <label class="dd-ms-cf" hidden><input data-f="countFrom" type="checkbox"> ${t("dday.count_from_zero")}</label>
        </div>
        <div class="dd-ed-btns">
          ${existing && !it.fromShowcase ? `<button data-a="del">${t("dday.delete")}</button>` : ""}
          <span class="sp"></span>
          <button data-a="cancel">${t("dday.cancel")}</button>
          <button class="primary" data-a="ok">${t("dday.save")}</button>
        </div>`;
      editor.hidden = false;
      const f = (n) => editor.querySelector(`[data-f=${n}]`);
      f("mode").value = it.mode || "until";
      f("munit").value = it.munit === "months" ? "months" : "days";
      f("countFrom").checked = it.countFrom === "zero";
      f("yearly").checked = !!it.yearly;
      // a Showcase birthday keeps the Showcase's name and date (its sync would undo edits made here)
      if (it.fromShowcase)
        for (const n of ["name", "date", "mode", "yearly"]) f(n).disabled = true;
      // milestone options only for 'since'; the count-from-0 escape hatch only for day-milestones
      const msBlock = editor.querySelector(".dd-ms");
      const cfLabel = editor.querySelector(".dd-ms .dd-ms-cf");
      const yearlyLabel = editor.querySelector(".dd-yearly");
      const syncMs = () => {
        msBlock.hidden = f("mode").value !== "since";
        yearlyLabel.hidden = f("mode").value === "since";
        cfLabel.hidden = !(
          f("mode").value === "since" &&
          +f("mstep").value > 0 &&
          f("munit").value === "days"
        );
      };
      syncMs();
      f("mode").addEventListener("change", syncMs);
      f("mstep").addEventListener("input", syncMs);
      f("munit").addEventListener("change", syncMs);
      const iconBtn = editor.querySelector("[data-a=icon]");
      const paintIcon = () =>
        (iconBtn.innerHTML = it.icon
          ? `<img src="${esc(api.assetUrl(it.icon))}" alt="">`
          : icon("plus"));
      paintIcon();
      f("name").focus();

      const icons = editor.querySelector(".dd-icons");
      async function showIcons() {
        const used = items.map((i) => i.icon).filter(Boolean);
        const all = [
          ...new Set([...used, ...(await api.listAssets().catch(() => []))]),
        ].slice(0, 60);
        icons.innerHTML =
          `<button class="dd-av" data-up title="${t("dday.icon_upload")}">${icon("upload")}</button>` +
          `<button class="dd-av" data-none title="${t("dday.icon_none")}">${icon("none")}</button>` +
          all
            .map(
              (a) =>
                `<button class="dd-av ${a === it.icon ? "sel" : ""}" data-icon="${esc(a)}"><img src="${esc(api.assetUrl(a))}" alt=""></button>`,
            )
            .join("");
        icons.hidden = false;
      }
      iconBtn.onclick = () =>
        icons.hidden ? showIcons() : (icons.hidden = true);
      icons.onclick = async (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.hasAttribute("data-up")) {
          const file = await api.pickImage();
          if (!file) return;
          it.icon = await api.uploadImage(file);
        } else if (b.hasAttribute("data-none")) it.icon = null;
        else it.icon = b.dataset.icon;
        paintIcon();
        icons.hidden = true;
      };

      const close = () => ((editor.hidden = true), (editor.innerHTML = ""));
      const ok = () => {
        it.name = f("name").value.trim().slice(0, 100);
        it.date = f("date").value;
        it.tag = f("tag").value.trim().replace(/^#/, "");
        it.mode = f("mode").value;
        it.yearly = it.mode !== "since" && f("yearly").checked;
        it.mstep =
          it.mode === "since" ? Math.max(0, Math.floor(+f("mstep").value || 0)) : 0;
        it.munit = f("munit").value === "months" ? "months" : "days";
        it.countFrom = f("countFrom").checked ? "zero" : "one";
        if (!it.name || !it.date) return api.toast(t("dday.need_name"));
        if (!validDate(it.date)) return api.toast(t("dday.need_name"));
        const i = items.findIndex((x) => x.id === it.id);
        if (i >= 0) items[i] = it;
        else items.push(it);
        persist();
        close();
        render();
        if (!visible().includes(it))
          api.toast(t("dday.hidden_by_filter"));
      };
      editor.onclick = (e) => {
        const a = e.target.closest("button")?.dataset.a;
        if (a === "ok") ok();
        if (a === "cancel") close();
        if (a === "del") {
          items = items.filter((x) => x.id !== it.id);
          persist();
          close();
          render();
        }
      };
      editor.onkeydown = (e) => {
        if (e.key === "Enter" && e.target.tagName === "INPUT") ok();
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      };
    }

    api.onDayChange(() => render()); // re-render when the date rolls over

    // load the shared store (migrating any legacy items once) and stay in sync with the calendar
    const load = async () => {
      const data = await api.store.get("events").catch(() => null);
      events = Array.isArray(data) ? data : [];
      migrateLegacy();
      items = events.filter(isDday).map(toItem);
      render();
    };
    api.onStore("events", load);

    render();
    load();
    return {
      destroy: () => endDrag?.(),
      menu: () => [
        { text: t("dday.add"), action: () => openEditor(null) },
        {
          text: (s.cal ? "✓ " : "") + t("dday.menu_cal"),
          action: () => ((s.cal = !s.cal), api.save(), render()),
        },
      ],
      summary: () => {
        const list = visible();
        if (!list.length) return t("sum.dday_empty");
        return (
          list
            .slice(0, 6)
            .map((it) => `${it.name} ${dLabel(it)}`)
            .join(", ") + (list.length > 6 ? " …" : "")
        );
      },
    };
  },
};
