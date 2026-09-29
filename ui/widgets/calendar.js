// Calendar + to-do, two views over the SAME shared events (data/events.json):
//  • mini  — just the month grid; a dot marks days that have entries; click a day to open its list
//  • board — big month squares; click a square to write in it, click an entry to edit it,
//            entries that don't fit collapse into "+N", which opens the full list for that day.
// Each widget keeps its own view and tag filter. Tag chips cycle: normal → only this tag → hidden.
// Korean public holidays are shown in both views (see ../holidays.js).
import { esc, ymd, parseYmd, addDays, pad, uid, wheelScrollX, deferWhileEditing, throttle } from '../util.js';
import { loadHolidays, holidayName } from '../holidays.js';

/** "14:00 회의 #work" -> { title: '회의', time: '14:00', tags: ['work'] } */
export function parseEntry(text) {
  text = String(text ?? '').slice(0, 500);
  const tags = [...text.matchAll(/#([^\s#]+)/g)].map((m) => m[1].slice(0, 40));
  let rest = text.replace(/#[^\s#]+/g, ' ');
  let time = null;
  const tm = rest.match(/(^|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/);
  if (tm) {
    time = `${pad(+tm[2])}:${tm[3]}`;
    rest = rest.replace(tm[0], ' ');
  }
  return { title: rest.replace(/\s+/g, ' ').trim(), time, tags: [...new Set(tags)] };
}
const unparse = (ev) => [ev.time, ev.title, ...(ev.tags || []).map((x) => '#' + x)].filter(Boolean).join(' ');
const isEvent = (e) => e && typeof e === 'object' && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date);

export default {
  size: { w: 4, h: 5 },
  min: { w: 3, h: 3 },
  defaults: { filter: {}, view: 'mini' },
  css: `
    .cal { position: absolute; inset: 0; padding: var(--head-h) var(--pad) var(--pad); box-sizing: border-box;
      display: flex; flex-direction: column; gap: 5px; }
    .cal-head { display: flex; align-items: center; gap: 4px; flex: none; min-width: 0; }
    .cal-head button { padding: 0 7px; font-size: .85em; flex: none; }
    .cal-title { flex: 1; min-width: 0; text-align: center; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cal-filter { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; flex: none;
      mask-image: linear-gradient(to right, #000 88%, transparent); }
    .cal-filter .chip { max-width: 9em; overflow: hidden; text-overflow: ellipsis; }
    .cal-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 5px; }

    /* mini view */
    .cal-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px;
      font-size: .85em; text-align: center; }
    .cal-grid .wd { opacity: .5; font-size: .9em; align-self: end; padding-bottom: 2px; }
    .cal-grid .wd.sun { color: var(--hol); opacity: .8; }
    .cal-grid .wd.sat { color: var(--sat); opacity: .8; }
    .cal-grid .d { position: relative; border-radius: 6px; cursor: pointer; font-variant-numeric: tabular-nums;
      display: flex; align-items: center; justify-content: center; min-height: 0; }
    .cal-grid .d:hover { background: color-mix(in srgb, var(--c3) 10%, transparent); }
    .cal-grid .d.sun, .cal-grid .d.hol { color: var(--hol); }
    .cal-grid .d.sat { color: var(--sat); }
    .cal-grid .d.other { opacity: .3; }
    .cal-grid .d.today { font-weight: 800; text-decoration: underline; text-underline-offset: 3px; }
    .cal-grid .d.sel { background: var(--c2); color: var(--on-accent); }
    .cal-grid .d.has::after { content: ""; position: absolute; left: 50%; bottom: 12%; width: 5px; height: 5px;
      margin-left: -2.5px; border-radius: 50%; background: var(--c2); }
    .cal-grid .d.sel.has::after { background: var(--on-accent); }
    .cal-grid .d.alldone::after { background: transparent; box-shadow: inset 0 0 0 1.2px currentColor; opacity: .7; }
    .cal-dayhead { font-size: .8em; opacity: .75; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hol-name { color: var(--hol); margin-left: 6px; }
    .cal-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; scrollbar-width: thin; }
    .ev { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 6px; min-width: 0; }
    .ev:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .ev input[type=checkbox] { accent-color: var(--c2); margin: 0; flex: none; }
    .ev-time { color: var(--c2); font-size: .85em; font-variant-numeric: tabular-nums; flex: none; }
    .ev-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
    .ev-title input, .bc-t input { width: 100%; box-sizing: border-box; font-size: 1em; }
    .ev-tags { font-size: .75em; opacity: .6; white-space: nowrap; max-width: 35%; overflow: hidden; text-overflow: ellipsis; }
    .ev.done .ev-title, .ev.done .ev-time { text-decoration: line-through; opacity: .45; }
    .ev-del { padding: 0 6px; font-size: .75em; opacity: 0; flex: none; }
    .ev:hover .ev-del { opacity: .8; }
    .cal-empty { opacity: .5; font-size: .85em; padding: 6px 4px; }
    .cal-add { flex: none; width: 100%; box-sizing: border-box; }

    /* board view: big writable squares */
    .cal-board { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
    .cal-board .wd { font-size: .72em; opacity: .55; text-align: center; }
    .cal-board .wd.sun { color: var(--hol); opacity: .8; }
    .cal-board .wd.sat { color: var(--sat); opacity: .8; }
    .bc { position: relative; min-height: 0; min-width: 0; overflow: hidden; border-radius: 5px; padding: 2px 3px;
      display: flex; flex-direction: column; cursor: text; font-size: .74em;
      background: color-mix(in srgb, var(--c3) 5%, transparent); }
    .bc:hover { background: color-mix(in srgb, var(--c3) 11%, transparent); }
    .bc.other { opacity: .4; }
    .bc.today { box-shadow: inset 0 0 0 1.5px var(--c2); }
    .bc-top { display: flex; gap: 4px; align-items: baseline; flex: none; white-space: nowrap; overflow: hidden; }
    .bc-num { font-weight: 600; font-variant-numeric: tabular-nums; }
    .bc.sun .bc-num, .bc.hol .bc-num { color: var(--hol); }
    .bc.sat .bc-num { color: var(--sat); }
    .bc-hol { font-size: .85em; color: var(--hol); overflow: hidden; text-overflow: ellipsis; }
    .bc-evs { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 1px; }
    .bc-ev { display: flex; align-items: center; gap: 3px; white-space: nowrap; min-width: 0; flex: none; }
    .bc-ev input[type=checkbox] { margin: 0; width: .95em; height: .95em; flex: none; accent-color: var(--c2); }
    .bc-t { flex: 1; overflow: hidden; text-overflow: ellipsis; min-width: 0; cursor: pointer; }
    .bc-t b { color: var(--c2); font-weight: 600; }
    .bc-ev.done .bc-t { text-decoration: line-through; opacity: .45; }
    .bc-more { font-size: .92em; opacity: .7; cursor: pointer; flex: none; }
    .bc-more:hover { color: var(--c2); opacity: 1; }
    input.bc-add { position: absolute; left: 2px; right: 2px; bottom: 2px; z-index: 2; font-size: 1em; padding: 1px 4px; }

    /* day popover (board "+N") */
    .cal-pop { position: absolute; inset: calc(var(--head-h) + 2px) 6px 6px; z-index: 6; padding: 8px; display: flex; flex-direction: column; gap: 6px;
      background: color-mix(in srgb, var(--c1) 97%, transparent); border: var(--line-width) var(--line-style) var(--line-color);
      border-radius: calc(var(--radius) * .6); box-shadow: 0 8px 24px rgb(0 0 0 / .45); }
    .pop-head { display: flex; gap: 6px; align-items: center; min-width: 0; }
    .pop-head b { flex: 1; min-width: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pop-head button { padding: 0 7px; }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    if (!s.filter || typeof s.filter !== 'object' || Array.isArray(s.filter)) s.filter = {};
    if (s.view !== 'board') s.view = 'mini';
    let events = [];
    let hol = {};
    let month = ymd().slice(0, 7) + '-01';
    let popDate = null;

    root.innerHTML = `
      <div class="cal">
        <div class="cal-head">
          <button data-a="prev" title="${esc(t('cal.prev_month'))}">‹</button><span class="cal-title" aria-live="polite"></span><button data-a="next" title="${esc(t('cal.next_month'))}">›</button>
          <button data-a="today">${esc(t('cal.today'))}</button>
          <button data-a="view"></button>
        </div>
        <div class="cal-filter" title="${esc(t('cal.filter_hint'))}"></div>
        <div class="cal-body"></div>
        <div class="cal-pop" hidden></div>
      </div>`;
    const box = root.firstElementChild;
    const q = (c) => box.querySelector(c);
    wheelScrollX(q('.cal-filter'));
    const fmt = (opts, d) => new Intl.DateTimeFormat(lang, opts).format(parseYmd(d));
    const dayLabel = (d) => fmt({ month: 'long', day: 'numeric', weekday: 'short' }, d);
    const holName = (d) => holidayName(hol, api.config, lang, d);

    const allTags = () => [...new Set(events.flatMap((e) => e.tags || []))].sort();
    function shown(ev) {
      const tags = ev.tags || [];
      if (tags.some((x) => s.filter[x] === 'hide')) return false;
      const only = Object.keys(s.filter).filter((k) => s.filter[k] === 'only');
      return !only.length || tags.some((x) => only.includes(x));
    }
    const dayEvents = (d) =>
      events.filter((e) => e.date === d && shown(e)).sort(
        (a, b) => !!a.done - !!b.done || (a.time ? 0 : 1) - (b.time ? 0 : 1) || (a.time || '').localeCompare(b.time || ''),
      );
    const persist = () => api.store.set('events', events).catch(() => {});
    const byId = (id) => events.find((e) => e.id === id);

    // ---------------- rendering ----------------
    function render() {
      const v = q('[data-a=view]');
      v.textContent = s.view === 'mini' ? '▦' : '☰';
      v.title = t(s.view === 'mini' ? 'cal.view_board' : 'cal.view_mini');
      q('.cal-title').textContent = fmt({ year: 'numeric', month: 'long' }, month);

      const tags = allTags();
      for (const k of Object.keys(s.filter)) if (!tags.includes(k)) delete s.filter[k];
      q('.cal-filter').hidden = !tags.length;
      q('.cal-filter').innerHTML = tags
        .map((x) => `<button class="chip ${s.filter[x] === 'only' ? 'on' : s.filter[x] === 'hide' ? 'off' : ''}" data-tag="${esc(x)}" title="#${esc(x)}">#${esc(x)}</button>`)
        .join('');

      if (s.view === 'mini') renderMini();
      else renderBoard();
      renderPop();
    }

    // week start: Settings → 한 주의 시작 (config ui.weekStart), Sunday by default for the calendar
    const ws = () => ((api.config?.ui?.weekStart ?? 'sun') === 'mon' ? 1 : 0);
    const dowOf = (i) => (ws() + i) % 7; // column index -> 0 = Sunday … 6 = Saturday
    const weekdays = () => [...Array(7)].map((_, i) => fmt({ weekday: 'narrow' }, addDays('2023-01-01', dowOf(i))));
    const wdClass = (i) => (dowOf(i) === 0 ? 'sun' : dowOf(i) === 6 ? 'sat' : '');
    function monthCells() {
      const first = parseYmd(month);
      const lead = (first.getDay() - ws() + 7) % 7;
      const start = addDays(month, -lead);
      const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const weeks = Math.ceil((lead + days) / 7);
      return { start, weeks };
    }
    function dayClasses(d, i) {
      return [
        dowOf(i % 7) === 0 && 'sun',
        dowOf(i % 7) === 6 && 'sat',
        holName(d) && 'hol',
        d.slice(0, 7) !== month.slice(0, 7) && 'other',
        d === ymd() && 'today',
      ].filter(Boolean);
    }

    function agendaHtml(d) {
      const evs = dayEvents(d);
      return evs.length
        ? evs.map((e) => `
            <div class="ev ${e.done ? 'done' : ''}" data-id="${esc(e.id)}">
              <input type="checkbox" ${e.done ? 'checked' : ''}>
              ${e.time ? `<span class="ev-time">${esc(e.time)}</span>` : ''}
              <span class="ev-title" title="${esc(e.title)} — ${esc(t('cal.edit_hint'))}">${esc(e.title)}</span>
              <span class="ev-tags" title="${esc((e.tags || []).map((x) => '#' + x).join(' '))}">${esc((e.tags || []).map((x) => '#' + x).join(' '))}</span>
              <button class="ev-del" title="${esc(t('dday.delete'))}">✕</button>
            </div>`).join('')
        : `<div class="cal-empty">${esc(t('cal.empty'))}</div>`;
    }

    /** Mini view: only the month. Dots mark days with entries (hollow = all done); click a day to open its list. */
    function renderMini() {
      const { start, weeks } = monthCells();
      let html = weekdays().map((w, i) => `<div class="wd ${wdClass(i)}">${esc(w)}</div>`).join('');
      for (let i = 0; i < weeks * 7; i++) {
        const d = addDays(start, i);
        const evs = dayEvents(d);
        const hn = holName(d);
        const cls = ['d', ...dayClasses(d, i), d === popDate && 'sel', evs.length && 'has', evs.length && evs.every((e) => e.done) && 'alldone']
          .filter(Boolean).join(' ');
        const tip = [hn, evs.length ? t('cal.count', { n: evs.length }) : ''].filter(Boolean).join(' · ');
        const label = [dayLabel(d), tip].filter(Boolean).join(', ');
        html += `<div class="${cls}" data-d="${d}" role="button" tabindex="0" aria-label="${esc(label)}"${tip ? ` title="${esc(tip)}"` : ''}>${+d.slice(8)}</div>`;
      }
      q('.cal-body').innerHTML = `<div class="cal-grid" style="grid-template-rows: auto repeat(${weeks}, minmax(0, 1fr))">${html}</div>`;
    }

    function renderBoard() {
      const { start, weeks } = monthCells();
      let html = weekdays().map((w, i) => `<div class="wd ${wdClass(i)}">${esc(w)}</div>`).join('');
      for (let i = 0; i < weeks * 7; i++) {
        const d = addDays(start, i);
        const hn = holName(d);
        const evs = dayEvents(d);
        html += `
          <div class="bc ${dayClasses(d, i).join(' ')}" data-d="${d}" tabindex="0" aria-label="${esc([dayLabel(d), hn, evs.length ? t('cal.count', { n: evs.length }) : ''].filter(Boolean).join(', '))}" title="${esc(hn || '')}">
            <div class="bc-top"><span class="bc-num">${+d.slice(8)}</span>${hn ? `<span class="bc-hol">${esc(hn)}</span>` : ''}</div>
            <div class="bc-evs">${evs.map((e) => `
              <div class="bc-ev ${e.done ? 'done' : ''}" data-id="${esc(e.id)}" title="${esc(unparse(e))}">
                <input type="checkbox" ${e.done ? 'checked' : ''}><span class="bc-t">${e.time ? `<b>${esc(e.time)}</b> ` : ''}${esc(e.title)}</span>
              </div>`).join('')}</div>
          </div>`;
      }
      q('.cal-body').innerHTML = `<div class="cal-board" style="grid-template-rows: auto repeat(${weeks}, minmax(0, 1fr))">${html}</div>`;
      fitCells();
    }

    /** Entries that don't fit a square collapse into "+N". */
    function fitCells() {
      for (const list of box.querySelectorAll('.bc-evs')) {
        list.querySelector('.bc-more')?.remove();
        const lines = [...list.querySelectorAll('.bc-ev')];
        lines.forEach((l) => (l.hidden = false));
        if (list.scrollHeight <= list.clientHeight + 1) continue;
        const more = document.createElement('div');
        more.className = 'bc-more';
        list.append(more);
        let hidden = 0;
        more.textContent = t('cal.more', { n: 1 });
        for (let i = lines.length - 1; i >= 0 && list.scrollHeight > list.clientHeight + 1; i--) {
          lines[i].hidden = true;
          more.textContent = t('cal.more', { n: ++hidden });
        }
        more.title = t('cal.more_hint');
      }
    }

    function renderPop() {
      const pop = q('.cal-pop');
      if (!popDate) {
        pop.hidden = true;
        pop.innerHTML = '';
        return;
      }
      const hn = holName(popDate);
      pop.innerHTML = `
        <div class="pop-head"><button data-a="pop-prev" title="${esc(t('cal.prev_day'))}">‹</button>
          <b>${esc(dayLabel(popDate))}${hn ? `<span class="hol-name">${esc(hn)}</span>` : ''}</b>
          <button data-a="pop-next" title="${esc(t('cal.next_day'))}">›</button>
          <button data-a="pop-close" title="${esc(t('theme.close'))}">✕</button></div>
        <div class="cal-list">${agendaHtml(popDate)}</div>
        <input class="cal-add" data-date="${popDate}" placeholder="${esc(t('cal.add_placeholder'))}">`;
      pop.hidden = false;
    }

    // ---------------- editing ----------------
    function addEntry(date, text) {
      const p = parseEntry(text);
      if (!p.title) {
        if (text.trim()) api.toast(t('cal.need_title'));
        return false;
      }
      events.push({ id: uid(), date, done: false, ...p });
      persist();
      return true;
    }

    /** Replace `span` with an input for `ev`; Enter saves, Esc cancels, empty text deletes. */
    function editInline(span, ev) {
      span.innerHTML = `<input value="${esc(unparse(ev))}">`;
      const inp = span.querySelector('input');
      inp.focus();
      let done = false;
      const commit = (keep) => {
        if (done) return;
        done = true;
        if (keep) {
          const txt = inp.value.trim();
          if (!txt) events = events.filter((x) => x !== ev);
          else {
            const p = parseEntry(txt);
            if (p.title) Object.assign(ev, p);
          }
          persist();
        }
        render();
      };
      inp.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') commit(true);
        if (k.key === 'Escape') {
          k.stopPropagation();
          commit(false);
        }
      });
      inp.addEventListener('blur', () => commit(true));
    }

    /** Write directly into a board square. Enter adds and keeps the box open for the next line. */
    function addInCell(cell) {
      const existing = cell.querySelector('.bc-add');
      if (existing) return existing.focus();
      const d = cell.dataset.d;
      const inp = document.createElement('input');
      inp.className = 'bc-add';
      inp.placeholder = t('cal.cell_placeholder');
      cell.append(inp);
      inp.focus();
      let closed = false;
      inp.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') {
          if (addEntry(d, inp.value)) {
            closed = true;
            render();
            const again = box.querySelector(`.bc[data-d="${d}"]`);
            if (again) addInCell(again);
          }
        }
        if (k.key === 'Escape') {
          k.stopPropagation();
          closed = true;
          inp.remove();
        }
      });
      inp.addEventListener('blur', () => {
        if (closed) return;
        closed = true;
        const added = addEntry(d, inp.value);
        inp.remove();
        if (added) render();
      });
    }

    /** Open a day's list (from the mini grid, a "+N", or ‹ › inside the list). */
    function openDay(d) {
      popDate = d;
      if (d.slice(0, 7) !== month.slice(0, 7)) month = d.slice(0, 7) + '-01';
      render();
      q('.cal-pop .cal-add')?.focus(); // type right away; Esc closes
    }
    function go(dir) {
      const d = parseYmd(month);
      d.setDate(1);
      d.setMonth(d.getMonth() + dir);
      month = ymd(d);
      render();
    }
    function toggleView() {
      s.view = s.view === 'mini' ? 'board' : 'mini';
      popDate = null;
      api.save();
      q('.cal-body').innerHTML = '';
      if (s.view === 'board') {
        const cur = api.size;
        if (cur.w < 6 || cur.h < 5) api.requestSize({ w: Math.max(cur.w, 7), h: Math.max(cur.h, 6) });
      }
      render();
    }

    box.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'prev') return go(-1);
      if (a === 'next') return go(1);
      if (a === 'today') {
        month = ymd().slice(0, 7) + '-01';
        return render();
      }
      if (a === 'view') return toggleView();
      if (a === 'pop-close') {
        popDate = null;
        return render();
      }
      if (a === 'pop-prev' || a === 'pop-next') return openDay(addDays(popDate, a === 'pop-prev' ? -1 : 1));
      const chip = e.target.closest('.cal-filter [data-tag]');
      if (chip) {
        const x = chip.dataset.tag;
        const next = { undefined: 'only', only: 'hide', hide: undefined }[s.filter[x]];
        if (next) s.filter[x] = next;
        else delete s.filter[x];
        api.save();
        return render();
      }
      if (e.target.closest('.ev-del')) {
        const ev = byId(e.target.closest('[data-id]').dataset.id);
        events = events.filter((x) => x !== ev);
        persist();
        return render();
      }
      const more = e.target.closest('.bc-more');
      if (more) return openDay(more.closest('.bc').dataset.d);
      const line = e.target.closest('.bc-t');
      if (line && !line.querySelector('input')) return editInline(line, byId(line.closest('[data-id]').dataset.id));
      const cell = e.target.closest('.bc');
      if (cell && !e.target.closest('input')) return addInCell(cell);
      const d = e.target.closest('.cal-grid [data-d]')?.dataset.d;
      if (d) openDay(d);
    });
    box.addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      const ev = byId(e.target.closest('[data-id]')?.dataset.id);
      if (!ev) return;
      ev.done = e.target.checked;
      persist();
      render();
    });
    box.addEventListener('dblclick', (e) => {
      const span = e.target.closest('.ev-title');
      if (span && !span.querySelector('input')) editInline(span, byId(span.closest('[data-id]').dataset.id));
    });
    box.addEventListener('keydown', (e) => {
      // keyboard: Enter/Space on a day opens it (mini) or starts writing in it (big squares); F2 edits an entry
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.cal-grid .d')) {
        e.preventDefault();
        return openDay(e.target.dataset.d);
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.bc')) {
        e.preventDefault();
        return addInCell(e.target);
      }
      if (e.key === 'F2') {
        const row = e.target.closest('.ev, .bc-ev');
        const span = row?.querySelector('.ev-title, .bc-t');
        if (span) {
          e.preventDefault();
          return editInline(span, byId(row.dataset.id));
        }
      }
      if (e.target.matches('.cal-add') && e.key === 'Enter') {
        if (addEntry(e.target.dataset.date || ymd(), e.target.value)) {
          const keep = e.target.dataset.date;
          e.target.value = '';
          render();
          box.querySelector(`.cal-add[data-date="${keep}"]`)?.focus();
        }
      }
      if (e.key === 'Escape' && popDate && !e.target.matches('input:not(.cal-add)')) {
        e.stopPropagation();
        popDate = null;
        render();
      }
    });
    const wheelGo = throttle((dir) => go(dir), 220);
    box.addEventListener('wheel', (e) => {
      if (!e.target.closest('.cal-grid, .cal-board') || Math.abs(e.deltaY) < 4) return;
      e.preventDefault();
      wheelGo(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    // ---------------- lifecycle ----------------
    const ro = new ResizeObserver(() => s.view === 'board' && fitCells());
    ro.observe(box);

    const renderLater = deferWhileEditing(box, render); // don't wipe a half-typed entry
    const load = async () => {
      const data = await api.store.get('events').catch(() => null);
      events = Array.isArray(data) ? data.filter(isEvent).map((e) => ({ ...e, id: e.id || uid(), title: String(e.title ?? '') })) : [];
      renderLater();
    };
    api.onStore('events', load);
    api.onConfig(renderLater);
    loadHolidays().then((h) => {
      hol = h;
      renderLater();
    });
    let day = ymd();
    const tick = setInterval(() => {
      if (ymd() !== day) (day = ymd()), renderLater();
    }, 60000);
    render();
    load();
    return {
      destroy() {
        ro.disconnect();
        clearInterval(tick);
      },
      resized: () => (s.view === 'board' ? fitCells() : null),
      summary: () => {
        const d = ymd();
        const label = (e) => (e.time ? e.time + ' ' : '') + e.title + (e.done ? ' ✓' : '');
        const today = events.filter((e) => e.date === d);
        const next = events.filter((e) => e.date > d).sort((a, b) => a.date.localeCompare(b.date))[0];
        const h = holName(d);
        return [
          h ? t('sum.cal_hol', { name: h }) : '',
          today.length ? t('sum.cal_today', { n: today.length }) + ' — ' + today.slice(0, 6).map(label).join(', ') : t('sum.cal_none'),
          next ? t('sum.cal_next', { date: next.date, title: next.title }) : '',
        ].filter(Boolean).join('. ');
      },
      menu: () => [{ text: t(s.view === 'mini' ? 'cal.view_board' : 'cal.view_mini'), action: toggleView }],
    };
  },
};
