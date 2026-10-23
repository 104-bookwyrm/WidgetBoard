// Checklist with three tabs, all over the shared entry store (data/events.json, the calendar's and D-day's too):
//  • 오늘 (today)  - one-off to-dos (unfinished ones carry over, ↪), daily routines (🔁)
//  • 이번 주 (week) - one-off to-dos dated this week, and weekly quotas: due on the week's last day, ticked once a week
//  • 이번 달 (month)- the same for this month, with monthly quotas
// Every tab also lists the shared entries (calendar, d-days) dated in its period (📅, ticked in both places),
// unless 달력 연동 is off; tags in `hideTags` keep entries out of this widget only.
// Entries added here carry `todo: true` (only they carry over); quotas carry `quota: true`.
// Week start: Settings → 한 주 시작 (util.js weekFirstDay; 기본 = Sunday). Each widget remembers its own tab.
import {
  esc,
  ymd,
  parseYmd,
  addDays,
  uid,
  deferWhileEditing,
  editInlineText,
  occursOn,
  eventDone,
  setEventDone,
  weekFirstDay,
  tickDay,
} from "../util.js";
import { icon } from "../icons.js";

const TABS = ["today", "week", "month"];
const REPEAT_OF_TAB = { week: "weekly", month: "monthly" };
const TILTS = ["tilt", "random", "straight"];
// stable per-day angle for the "random" tilt so it doesn't jump on every render
const seed = (str) => {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
};

export default {
  size: { w: 3, h: 4 },
  min: { w: 2, h: 2 },
  defaults: {
    sync: true,
    hideDone: false,
    hideTags: [], // entries with any of these tags stay out of this checklist
    tab: "today",
    stamp: false, // "day well done" stamp when every Today item is finished
    stampTilt: "tilt", // tilt | random | straight
    stampImg: "", // optional custom stamp image (asset name); empty = drawn default
  },
  css: `
    .ck { position: absolute; inset: 0; padding: var(--head-h) var(--pad) var(--pad); box-sizing: border-box;
      display: flex; flex-direction: column; gap: var(--space-3); }
    .ck-tabs { display: flex; gap: var(--space-2); flex: none; }
    .ck-tabs button { flex: 1; min-width: 0; padding: 1px 4px; font-size: var(--fs-meta); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; color: var(--text-muted); }
    .ck-tabs button.on { background: var(--c2); border-color: var(--c2); color: var(--on-accent); opacity: 1; }
    .ck-head { display: flex; align-items: baseline; gap: var(--space-3); flex: none; min-width: 0; }
    .ck-date { flex: 1; min-width: 0; font-weight: 600; text-wrap: balance; word-break: keep-all; } /* a week range with its year wraps, never cut */
    .ck-sync { padding: 0 6px; font-size: var(--fs-meta); flex: none; color: var(--text-faint); }
    .ck-sync.on { color: var(--c3); }
    .ck-bar { height: 4px; border-radius: 2px; flex: none; background: color-mix(in srgb, var(--c3) 12%, transparent); overflow: hidden; }
    .ck-bar i { display: block; height: 100%; width: 0; background: var(--c2); transition: width .3s; }
    .ck-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-1); scrollbar-width: thin; }
    .ck-row { display: flex; align-items: center; gap: var(--space-3); padding: 3px 4px; border-radius: var(--r-inner); min-width: 0; }
    .ck-row:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .ck-row input[type=checkbox] { accent-color: var(--c2); margin: 0; flex: none; width: 1.05em; height: 1.05em; }
    .ck-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ck-title input { width: 100%; box-sizing: border-box; font-size: 1em; }
    .ck-row.done .ck-title { text-decoration: line-through; color: var(--text-faint); }
    .ck-meta { font-size: var(--fs-meta); color: var(--text-faint); white-space: nowrap; flex: none; }
    .ck-time { color: var(--c2); font-size: var(--fs-small); font-variant-numeric: tabular-nums; flex: none; }
    .ck-cal-ico { color: var(--text-muted); font-size: var(--fs-meta); }
    .ck-btn { padding: 0 5px; font-size: var(--fs-meta); opacity: 0; flex: none; }
    .ck-row:hover .ck-btn { opacity: .75; }
    .ck-btn.on { color: color-mix(in srgb, var(--c2) 90%, var(--c1)); }
    .ck-add { flex: none; width: 100%; box-sizing: border-box; }
    .ck-stamp { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 4; }
    .ck-stamp .mark { transform: rotate(var(--rot, -8deg)); animation: ck-stamp-in .25s ease-out; }
    .ck-stamp img { max-width: 72%; max-height: 62%; object-fit: contain; }
    .ck-stamp .drawn { width: 6.5em; height: 6.5em; max-width: 72%; box-sizing: border-box; border-radius: 50%;
      border: .16em solid var(--stamp-c, #d8343a); box-shadow: inset 0 0 0 .14em var(--stamp-c, #d8343a);
      color: var(--stamp-c, #d8343a); display: grid; place-items: center; text-align: center;
      font-weight: 800; line-height: 1.15; padding: .5em; opacity: .9; }
    @keyframes ck-stamp-in { from { transform: rotate(var(--rot, -8deg)) scale(1.5); opacity: 0; } }
    body.reduce-motion .ck-stamp .mark { animation: none; }
    @container (max-width: 12em) { .ck-meta { display: none; } }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    s.sync = s.sync !== false;
    s.hideDone = !!s.hideDone;
    s.hideTags = Array.isArray(s.hideTags) ? s.hideTags.filter((g) => typeof g === "string") : [];
    if (!TABS.includes(s.tab)) s.tab = "today";
    let events = []; // the whole shared store; checklist rows are its `todo` entries plus today's entries

    root.innerHTML = `
      <div class="ck">
        <div class="ck-tabs">${TABS.map((k) => `<button data-tab="${k}"></button>`).join("")}</div>
        <div class="ck-head">
          <span class="ck-date"></span>
          <button class="ck-sync" data-a="sync">${icon("calendar")}</button>
        </div>
        <div class="ck-bar"><i></i></div>
        <div class="ck-list"></div>
        <input class="ck-add">
      </div>`;
    const box = root.firstElementChild;
    const q = (c) => box.querySelector(c);
    const today = () => ymd();
    const fmt = (opts, d) =>
      new Intl.DateTimeFormat(lang, opts).format(parseYmd(d));

    // ---- periods: a daily ticks today, a quota ticks its week's or month's last day ----
    const isDone = (i) => eventDone(i, tickDay(i, today()));
    const todos = () => events.filter((e) => e.todo && typeof e.title === "string");

    // ---- rows per tab ----
    // Every tab shows every shared entry dated in its period (calendar entries and d-days, once each, on their
    // first day in it), unless 달력 연동 is off or a hidden tag is on it. A repeat as short as the period or
    // shorter (daily in a week, daily/weekly in a month) would be there all the time, so it stays out.
    const hidden = (e) => (e.tags || []).some((g) => s.hideTags.includes(g));
    const TOO_OFTEN = { today: [], week: ["daily"], month: ["daily", "weekly"] };
    function period(tab) {
      const d = today();
      if (tab === "today") return [d, d];
      if (tab === "week") return [weekFirstDay(d), addDays(weekFirstDay(d), 6)];
      const first = d.slice(0, 8) + "01";
      return [first, addDays(addDays(first, 31).slice(0, 8) + "01", -1)];
    }
    function rowsFor(tab) {
      const d = today();
      const [from, to] = period(tab);
      const cal = [];
      if (s.sync)
        for (const e of events) {
          if (e.todo || e.quota || hidden(e) || TOO_OFTEN[tab].includes(e.repeat)) continue;
          for (let x = from; x <= to; x = addDays(x, 1))
            if (occursOn(e, x)) {
              cal.push({ kind: "cal", item: e, day: x, done: eventDone(e, x) });
              break;
            }
        }
      cal.sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          (a.item.time ? 0 : 1) - (b.item.time ? 0 : 1) ||
          (a.item.time || "").localeCompare(b.item.time || ""),
      );
      if (tab === "today") {
        const own = todos()
          .filter(
            (i) =>
              !hidden(i) &&
              (i.repeat === "daily" ||
                (!i.repeat &&
                  (i.date === d || i.doneOn === d || (!i.done && i.date < d)))),
          )
          .map((i) => ({ kind: "own", item: i, done: isDone(i) }));
        return [...cal, ...own];
      }
      // one-off to-dos dated in the period, then this period's quotas
      const own = todos()
        .filter((i) => !hidden(i) && !i.repeat && i.date >= from && i.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((i) => ({ kind: "own", item: i, day: i.date, done: isDone(i) }));
      const quotas = todos()
        .filter((i) => i.quota && i.repeat === REPEAT_OF_TAB[tab] && !hidden(i))
        .map((i) => ({ kind: "own", item: i, done: isDone(i) }));
      return [...cal, ...own, ...quotas];
    }
    function periodLabel(tab) {
      const d = today();
      const day = (x) => fmt({ month: "long", day: "numeric", weekday: "short" }, x);
      if (tab === "today") return day(d);
      if (tab === "week") {
        const a = weekFirstDay(d);
        const nb = (x) => day(x).replace(/ /g, "\u00a0"); // a wrapped range breaks between the two dates only
        return t("ck.week_range", { a: nb(a), b: nb(addDays(a, 6)) });
      }
      return fmt({ month: "long" }, d);
    }

    function render() {
      const d = today();
      for (const b of box.querySelectorAll("[data-tab]")) {
        const r = rowsFor(b.dataset.tab);
        const n = r.filter((x) => x.done).length;
        b.classList.toggle("on", b.dataset.tab === s.tab);
        b.textContent = t("ck.tab." + b.dataset.tab);
        b.title = t("ck.tab_hint." + b.dataset.tab) + (r.length ? ` · ${n}/${r.length}` : "");
      }
      const rows = rowsFor(s.tab);
      const done = rows.filter((r) => r.done).length;
      q(".ck-date").textContent = periodLabel(s.tab);
      q(".ck-bar").title = rows.length ? `${done}/${rows.length}` : "";
      q(".ck-bar i").style.width = rows.length
        ? `${(done / rows.length) * 100}%`
        : "0";
      const sync = q(".ck-sync");
      sync.classList.toggle("on", s.sync);
      sync.title = t(s.sync ? "ck.sync_on" : "ck.sync_off");
      q(".ck-add").placeholder = t("ck.add." + s.tab);

      const shown = s.hideDone ? rows.filter((r) => !r.done) : rows;
      q(".ck-list").innerHTML =
        shown
          .map(({ kind, item, done, day }) => {
            // week / month rows say which day they fall on
            const when =
              day && s.tab !== "today"
                ? `<span class="ck-meta">${esc(fmt({ day: "numeric", weekday: "short" }, day))}</span>`
                : "";
            if (kind === "cal")
              return `<div class="ck-row ck-cal ${done ? "done" : ""}" data-cal="${esc(item.id)}" data-day="${esc(day)}" title="${esc(t("ck.from_calendar"))}">
              <input type="checkbox" ${done ? "checked" : ""}>
              ${item.time ? `<span class="ck-time">${esc(item.time)}</span>` : ""}
              <span class="ck-cal-ico">${icon("calendar")}</span><span class="ck-title">${esc(item.title)}</span>${when}</div>`;
            const carried = s.tab === "today" && !item.repeat && item.date < d;
            const repeatBtn =
              s.tab === "today"
                ? `<button class="ck-btn ${item.repeat ? "on" : ""}" data-a="repeat" title="${esc(t(item.repeat ? "ck.repeat_off" : "ck.repeat_on"))}">${icon("repeat")}</button>`
                : "";
            return `<div class="ck-row ${done ? "done" : ""}" data-id="${esc(item.id)}">
              <input type="checkbox" ${done ? "checked" : ""}>
              <span class="ck-title" title="${esc(item.title)} - ${esc(t("cal.edit_hint"))}">${esc(item.title)}</span>
              ${carried ? `<span class="ck-meta" title="${esc(t("ck.carried"))}">${icon("carried")} ${esc(fmt({ month: "numeric", day: "numeric" }, item.date))}</span>` : ""}
              ${when}${repeatBtn}
              <button class="ck-btn" data-a="del" title="${esc(t("dday.delete"))}">${icon("x")}</button></div>`;
          })
          .join("");

      // "day well done" stamp — only the Today tab, only when everything's ticked
      box.querySelector(".ck-stamp")?.remove();
      if (s.stamp && s.tab === "today" && rows.length && done === rows.length) {
        const rot =
          s.stampTilt === "straight"
            ? 0
            : s.stampTilt === "random"
              ? (seed(d) % 25) - 12
              : -8;
        const inner = s.stampImg
          ? `<img src="${esc(api.assetUrl(s.stampImg))}" alt="${esc(t("ck.stamp_text"))}">`
          : `<div class="drawn">${esc(t("ck.stamp_text"))}</div>`;
        const stamp = document.createElement("div");
        stamp.className = "ck-stamp";
        stamp.innerHTML = `<div class="mark" style="--rot:${rot}deg">${inner}</div>`;
        box.appendChild(stamp);
      }
    }

    // ---- saving / interaction ----
    const saveEvents = () => api.store.set("events", events).catch(() => {});
    const own = (el) =>
      todos().find((i) => i.id === el.closest("[data-id]")?.dataset.id);
    const cal = (el) =>
      events.find((e) => e.id === el.closest("[data-cal]")?.dataset.cal);

    box.addEventListener("change", (e) => {
      if (e.target.type !== "checkbox") return;
      const on = e.target.checked;
      const ev = cal(e.target);
      if (ev) {
        // a repeating entry: only the occurrence this row shows
        setEventDone(ev, e.target.closest("[data-day]").dataset.day || today(), on);
        saveEvents();
        return render();
      }
      const it = own(e.target);
      if (!it) return;
      if (it.repeat) {
        setEventDone(it, tickDay(it, today()), on);
        it.doneDates = it.doneDates.slice(-60);
      } else {
        it.done = on;
        it.doneOn = on ? today() : undefined;
      }
      saveEvents();
      render();
    });
    box.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]")?.dataset.tab;
      if (tab) {
        s.tab = tab;
        api.save();
        return render();
      }
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "sync") {
        s.sync = !s.sync;
        api.save();
        return render();
      }
      const it = own(e.target);
      if (!it) return;
      if (a === "del") {
        const i = events.indexOf(it);
        events = events.filter((x) => x !== it);
        saveEvents();
        render();
        api.deleted(() => {
          events.splice(Math.min(i, events.length), 0, it);
          saveEvents();
          render();
        });
      }
      if (a === "repeat") {
        // one-off <-> daily
        if (it.repeat) {
          it.done = isDone(it);
          it.doneOn = it.done ? today() : undefined;
          it.date = today();
          it.repeat = null;
          delete it.doneDates;
        } else {
          it.doneDates = it.done ? [today()] : [];
          it.repeat = "daily";
          delete it.done;
          delete it.doneOn;
        }
        saveEvents();
        render();
      }
    });
    box.addEventListener("keydown", (e) => {
      if (e.key !== "F2") return;
      const span = e.target.closest(".ck-row")?.querySelector(".ck-title");
      if (span) {
        e.preventDefault();
        span.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }
    });
    box.addEventListener("dblclick", (e) => {
      const span = e.target.closest(".ck-title");
      const it = span && own(span);
      if (!it || span.querySelector("input")) return;
      const id = it.id;
      editInlineText(span, it.title, (title) => {
        const current = events.find((item) => item.id === id);
        if (!current) return; // deleted by another widget while editing
        if (title) current.title = title.slice(0, 300);
        else events = events.filter((item) => item.id !== id);
        saveEvents();
      }, render);
    });
    q(".ck-add").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const title = e.target.value.trim().slice(0, 300);
      if (!title) return;
      const repeat = REPEAT_OF_TAB[s.tab] ?? null;
      const base = { id: uid(), title, date: today(), todo: true, tags: [] };
      events.push(
        repeat
          ? { ...base, repeat, quota: true, doneDates: [] }
          : { ...base, done: false, repeat: null },
      );
      e.target.value = "";
      saveEvents();
      render();
    });

    // ---- data ----
    const renderLater = deferWhileEditing(box, render);
    async function loadEvents() {
      const d = await api.store.get("events").catch(() => null);
      events = Array.isArray(d)
        ? d.filter((e) => e && typeof e.date === "string")
        : [];
      renderLater();
    }
    api.onStore("events", loadEvents);
    api.onConfig(renderLater); // week start may change

    api.onDayChange(renderLater); // new day / week / month: recurring items untick
    render();
    loadEvents();

    const menuToggle = (k, on, off) => ({
      text: t(s[k] ? on : off),
      action: () => ((s[k] = !s[k]), api.save(), render()),
    });
    async function setStampImage() {
      const f = await api.pickImage();
      if (!f) return;
      try {
        s.stampImg = await api.uploadImage(f);
        api.save();
        render();
      } catch {}
    }
    // every tag in the shared store (plus hidden ones no entry uses any more, so they can be turned back on)
    const tagMenu = () => {
      const tags = [...new Set([...events.flatMap((e) => e.tags || []), ...s.hideTags])].sort();
      if (!tags.length) return [];
      const flip = (g) => {
        s.hideTags = s.hideTags.includes(g) ? s.hideTags.filter((x) => x !== g) : [...s.hideTags, g];
        api.save();
        render();
      };
      return [{ text: t("ck.menu_hide_tags"), items: tags.map((g) => ({ text: (s.hideTags.includes(g) ? "✓ " : "") + "#" + g, action: () => flip(g) })) }];
    };
    const stampMenu = () => ({
      text: t("ck.stamp"),
      items: [
        {
          text: (s.stamp ? "✓ " : "") + t("ck.stamp_enable"),
          action: () => ((s.stamp = !s.stamp), api.save(), render()),
        },
        ...(s.stamp
          ? [
              { item: "Separator" },
              ...TILTS.map((m) => ({
                text: (s.stampTilt === m ? "✓ " : "") + t("ck.tilt_" + m),
                action: () => ((s.stampTilt = m), api.save(), render()),
              })),
              { item: "Separator" },
              {
                text: t(s.stampImg ? "ck.stamp_image_change" : "ck.stamp_image"),
                action: setStampImage,
              },
              ...(s.stampImg
                ? [
                    {
                      text: t("ck.stamp_default"),
                      action: () => ((s.stampImg = ""), api.save(), render()),
                    },
                  ]
                : []),
            ]
          : []),
      ],
    });
    return {
      destroy: () => {},
      summary: () => {
        const r = rowsFor("today");
        const left = r.filter((x) => !x.done);
        if (!r.length) return t("sum.ck_empty");
        return (
          t("sum.ck", { done: r.length - left.length, n: r.length }) +
          (left.length
            ? " - " +
              left
                .slice(0, 6)
                .map((x) => x.item.title)
                .join(", ")
            : "")
        );
      },
      menu: () => [
        menuToggle("sync", "ck.menu_sync_off", "ck.menu_sync_on"),
        menuToggle("hideDone", "ck.menu_show_done", "ck.menu_hide_done"),
        ...tagMenu(),
        {
          text: t("ck.menu_clear_done"),
          action: () => {
            events = events.filter((i) => !(i.todo && !i.repeat && i.done));
            saveEvents();
            render();
          },
        },
        stampMenu(),
      ],
    };
  },
};
