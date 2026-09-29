// Checklist with three tabs:
//  • 오늘 (today)  — one-off to-dos (unfinished ones carry over, ↪), daily routines (🔁),
//                    and optionally today's calendar entries (📅, ticked in both places)
//  • 이번 주 (week) — weekly recurring tasks: tick once per week, unticked again when a new week starts
//  • 이번 달 (month)— monthly recurring tasks: tick once per month, unticked again on the 1st
// Items are shared by every checklist widget (data/checklist.json); each widget remembers its own tab.
// Week start: Monday by default, config.json → "checklist": { "weekStart": "sun" } for Sunday.
import { esc, ymd, parseYmd, addDays, uid, deferWhileEditing } from '../util.js';

const TABS = ['today', 'week', 'month'];
const REPEAT_OF_TAB = { week: 'weekly', month: 'monthly' };

export default {
  size: { w: 3, h: 4 },
  min: { w: 2, h: 2 },
  defaults: { sync: true, hideDone: false, tab: 'today' },
  css: `
    .ck { position: absolute; inset: 0; padding: var(--head-h) var(--pad) var(--pad); box-sizing: border-box;
      display: flex; flex-direction: column; gap: 6px; }
    .ck-tabs { display: flex; gap: 3px; flex: none; }
    .ck-tabs button { flex: 1; min-width: 0; padding: 1px 4px; font-size: .8em; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; opacity: .7; }
    .ck-tabs button.on { background: var(--c2); border-color: var(--c2); color: var(--on-accent); opacity: 1; }
    .ck-tabs small { opacity: .8; font-variant-numeric: tabular-nums; }
    .ck-head { display: flex; align-items: baseline; gap: 6px; flex: none; min-width: 0; }
    .ck-date { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ck-count { font-size: .8em; opacity: .7; font-variant-numeric: tabular-nums; flex: none; }
    .ck-sync { padding: 0 6px; font-size: .8em; flex: none; opacity: .45; }
    .ck-sync.on { opacity: 1; }
    .ck-bar { height: 4px; border-radius: 2px; flex: none; background: color-mix(in srgb, var(--c3) 12%, transparent); overflow: hidden; }
    .ck-bar i { display: block; height: 100%; width: 0; background: var(--c2); transition: width .3s; }
    .ck-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; scrollbar-width: thin; }
    .ck-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 6px; min-width: 0; }
    .ck-row:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .ck-row input[type=checkbox] { accent-color: var(--c2); margin: 0; flex: none; width: 1.05em; height: 1.05em; }
    .ck-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ck-title input { width: 100%; box-sizing: border-box; font-size: 1em; }
    .ck-row.done .ck-title { text-decoration: line-through; opacity: .45; }
    .ck-meta { font-size: .72em; opacity: .6; white-space: nowrap; flex: none; }
    .ck-time { color: var(--c2); font-size: .85em; font-variant-numeric: tabular-nums; flex: none; }
    .ck-row.ck-cal .ck-title::before { content: "📅 "; font-size: .8em; }
    .ck-btn { padding: 0 5px; font-size: .72em; opacity: 0; flex: none; }
    .ck-row:hover .ck-btn { opacity: .75; }
    .ck-btn.on { opacity: .9; color: var(--c2); }
    .ck-empty { opacity: .5; font-size: .85em; padding: 6px 4px; }
    .ck-alldone { color: var(--c2); font-size: .85em; padding: 4px; text-align: center; }
    .ck-add { flex: none; width: 100%; box-sizing: border-box; }
    @container (max-width: 12em) { .ck-meta, .ck-tabs small { display: none; } }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    s.sync = s.sync !== false;
    s.hideDone = !!s.hideDone;
    if (!TABS.includes(s.tab)) s.tab = 'today';
    let items = [];
    let events = [];

    root.innerHTML = `
      <div class="ck">
        <div class="ck-tabs">${TABS.map((k) => `<button data-tab="${k}"></button>`).join('')}</div>
        <div class="ck-head">
          <span class="ck-date"></span><span class="ck-count"></span>
          <button class="ck-sync" data-a="sync">📅</button>
        </div>
        <div class="ck-bar"><i></i></div>
        <div class="ck-list"></div>
        <input class="ck-add">
      </div>`;
    const box = root.firstElementChild;
    const q = (c) => box.querySelector(c);
    const today = () => ymd();
    const fmt = (opts, d) => new Intl.DateTimeFormat(lang, opts).format(parseYmd(d));

    // ---- periods ----
    const weekStart = () => ((api.config?.ui?.weekStart ?? api.config?.checklist?.weekStart) === 'sun' ? 0 : 1);
    function weekFirstDay(d) {
      const back = (parseYmd(d).getDay() - weekStart() + 7) % 7;
      return addDays(d, -back);
    }
    const periodKey = (repeat, d = today()) =>
      repeat === 'daily' ? d : repeat === 'weekly' ? 'W' + weekFirstDay(d) : repeat === 'monthly' ? d.slice(0, 7) : null;
    const isDone = (i) => (i.repeat ? (i.doneKeys || []).includes(periodKey(i.repeat)) : !!i.done);

    /** Older files: `repeat: true` + `doneDates` meant daily. */
    function normalize(i) {
      const it = { ...i, id: i.id || uid(), title: String(i.title).slice(0, 300) };
      if (it.repeat === true) it.repeat = 'daily';
      if (!['daily', 'weekly', 'monthly'].includes(it.repeat)) it.repeat = null;
      if (it.repeat) it.doneKeys = Array.isArray(it.doneKeys) ? it.doneKeys : Array.isArray(it.doneDates) ? it.doneDates : [];
      delete it.doneDates;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) it.date = today();
      return it;
    }

    // ---- rows per tab ----
    function rowsFor(tab) {
      const d = today();
      if (tab === 'today') {
        const cal = s.sync
          ? events.filter((e) => e.date === d)
              .sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || (a.time || '').localeCompare(b.time || ''))
              .map((e) => ({ kind: 'cal', item: e, done: !!e.done }))
          : [];
        const own = items
          .filter((i) => i.repeat === 'daily' || (!i.repeat && (i.date === d || i.doneOn === d || (!i.done && i.date < d))))
          .map((i) => ({ kind: 'own', item: i, done: isDone(i) }));
        return [...cal, ...own];
      }
      return items.filter((i) => i.repeat === REPEAT_OF_TAB[tab]).map((i) => ({ kind: 'own', item: i, done: isDone(i) }));
    }
    function periodLabel(tab) {
      const d = today();
      if (tab === 'today') return fmt({ month: 'long', day: 'numeric', weekday: 'short' }, d);
      if (tab === 'week') {
        const a = weekFirstDay(d);
        return `${fmt({ month: 'numeric', day: 'numeric' }, a)} – ${fmt({ month: 'numeric', day: 'numeric' }, addDays(a, 6))}`;
      }
      return fmt({ year: 'numeric', month: 'long' }, d);
    }

    function render() {
      const d = today();
      for (const b of box.querySelectorAll('[data-tab]')) {
        const r = rowsFor(b.dataset.tab);
        const n = r.filter((x) => x.done).length;
        b.classList.toggle('on', b.dataset.tab === s.tab);
        b.innerHTML = `${esc(t('ck.tab.' + b.dataset.tab))}${r.length ? ` <small>${n}/${r.length}</small>` : ''}`;
        b.title = t('ck.tab_hint.' + b.dataset.tab);
      }
      const rows = rowsFor(s.tab);
      const done = rows.filter((r) => r.done).length;
      q('.ck-date').textContent = periodLabel(s.tab);
      q('.ck-count').textContent = rows.length ? `${done}/${rows.length}` : '';
      q('.ck-bar i').style.width = rows.length ? `${(done / rows.length) * 100}%` : '0';
      const sync = q('.ck-sync');
      sync.hidden = s.tab !== 'today';
      sync.classList.toggle('on', s.sync);
      sync.title = t(s.sync ? 'ck.sync_on' : 'ck.sync_off');
      q('.ck-add').placeholder = t('ck.add.' + s.tab);

      const shown = s.hideDone ? rows.filter((r) => !r.done) : rows;
      q('.ck-list').innerHTML =
        shown.map(({ kind, item, done }) => {
          if (kind === 'cal')
            return `<div class="ck-row ck-cal ${done ? 'done' : ''}" data-cal="${esc(item.id)}" title="${esc(t('ck.from_calendar'))}">
              <input type="checkbox" ${done ? 'checked' : ''}>
              ${item.time ? `<span class="ck-time">${esc(item.time)}</span>` : ''}
              <span class="ck-title">${esc(item.title)}</span></div>`;
          const carried = !item.repeat && item.date < d;
          const repeatBtn = s.tab === 'today'
            ? `<button class="ck-btn ${item.repeat ? 'on' : ''}" data-a="repeat" title="${esc(t(item.repeat ? 'ck.repeat_off' : 'ck.repeat_on'))}">🔁</button>`
            : '';
          return `<div class="ck-row ${done ? 'done' : ''}" data-id="${esc(item.id)}">
              <input type="checkbox" ${done ? 'checked' : ''}>
              <span class="ck-title" title="${esc(item.title)} — ${esc(t('cal.edit_hint'))}">${esc(item.title)}</span>
              ${carried ? `<span class="ck-meta" title="${esc(t('ck.carried'))}">↪ ${esc(fmt({ month: 'numeric', day: 'numeric' }, item.date))}</span>` : ''}
              ${repeatBtn}
              <button class="ck-btn" data-a="del" title="${esc(t('dday.delete'))}">✕</button></div>`;
        }).join('') +
        (!rows.length ? `<div class="ck-empty">${esc(t('ck.empty.' + s.tab))}</div>` : '') +
        (rows.length && done === rows.length ? `<div class="ck-alldone">${esc(t('ck.all_done.' + s.tab))}</div>` : '');
    }

    // ---- saving / interaction ----
    const saveItems = () => api.store.set('checklist', items).catch(() => {});
    const saveEvents = () => api.store.set('events', events).catch(() => {});
    const own = (el) => items.find((i) => i.id === el.closest('[data-id]')?.dataset.id);
    const cal = (el) => events.find((e) => e.id === el.closest('[data-cal]')?.dataset.cal);

    box.addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      const on = e.target.checked;
      const ev = cal(e.target);
      if (ev) {
        ev.done = on;
        saveEvents();
        return render();
      }
      const it = own(e.target);
      if (!it) return;
      if (it.repeat) {
        const key = periodKey(it.repeat);
        const set = new Set(it.doneKeys || []);
        on ? set.add(key) : set.delete(key);
        it.doneKeys = [...set].sort().slice(-60);
      } else {
        it.done = on;
        it.doneOn = on ? today() : undefined;
      }
      saveItems();
      render();
    });
    box.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]')?.dataset.tab;
      if (tab) {
        s.tab = tab;
        api.save();
        return render();
      }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'sync') {
        s.sync = !s.sync;
        api.save();
        return render();
      }
      const it = own(e.target);
      if (!it) return;
      if (a === 'del') {
        items = items.filter((x) => x !== it);
        saveItems();
        render();
      }
      if (a === 'repeat') {
        // one-off <-> daily
        if (it.repeat) {
          it.done = isDone(it);
          it.doneOn = it.done ? today() : undefined;
          it.date = today();
          it.repeat = null;
          delete it.doneKeys;
        } else {
          it.doneKeys = it.done ? [today()] : [];
          it.repeat = 'daily';
          delete it.done;
          delete it.doneOn;
        }
        saveItems();
        render();
      }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'F2') return;
      const span = e.target.closest('.ck-row')?.querySelector('.ck-title');
      if (span) {
        e.preventDefault();
        span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }
    });
    box.addEventListener('dblclick', (e) => {
      const span = e.target.closest('.ck-title');
      const it = span && own(span);
      if (!it || span.querySelector('input')) return;
      span.innerHTML = `<input value="${esc(it.title)}">`;
      const inp = span.firstChild;
      inp.focus();
      let finished = false;
      const commit = (keep) => {
        if (finished) return;
        finished = true;
        if (keep) {
          const v = inp.value.trim().slice(0, 300);
          if (v) it.title = v;
          else items = items.filter((x) => x !== it);
          saveItems();
        }
        render();
      };
      inp.onkeydown = (k) => {
        if (k.key === 'Enter') commit(true);
        if (k.key === 'Escape') {
          k.stopPropagation();
          commit(false);
        }
      };
      inp.onblur = () => commit(true);
    });
    q('.ck-add').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const title = e.target.value.trim().slice(0, 300);
      if (!title) return;
      const repeat = REPEAT_OF_TAB[s.tab] ?? null;
      items.push(repeat ? { id: uid(), title, date: today(), repeat, doneKeys: [] } : { id: uid(), title, date: today(), done: false, repeat: null });
      e.target.value = '';
      saveItems();
      render();
    });

    // ---- data ----
    const renderLater = deferWhileEditing(box, render);
    async function loadItems() {
      const d = await api.store.get('checklist').catch(() => null);
      items = Array.isArray(d) ? d.filter((i) => i && typeof i === 'object' && typeof i.title === 'string').map(normalize) : [];
      renderLater();
    }
    async function loadEvents() {
      const d = await api.store.get('events').catch(() => null);
      events = Array.isArray(d) ? d.filter((e) => e && typeof e.date === 'string') : [];
      renderLater();
    }
    api.onStore('checklist', loadItems);
    api.onStore('events', loadEvents);
    api.onConfig(renderLater); // week start may change

    let day = today();
    const tick = setInterval(() => {
      if (today() !== day) (day = today()), renderLater(); // new day / week / month: recurring items untick
    }, 60000);
    render();
    loadItems();
    loadEvents();

    const menuToggle = (k, on, off) => ({ text: t(s[k] ? on : off), action: () => ((s[k] = !s[k]), api.save(), render()) });
    return {
      destroy: () => clearInterval(tick),
      summary: () => {
        const r = rowsFor('today');
        const left = r.filter((x) => !x.done);
        if (!r.length) return t('sum.ck_empty');
        return t('sum.ck', { done: r.length - left.length, n: r.length }) +
          (left.length ? ' — ' + left.slice(0, 6).map((x) => x.item.title).join(', ') : '');
      },
      menu: () => [
        menuToggle('sync', 'ck.menu_sync_off', 'ck.menu_sync_on'),
        menuToggle('hideDone', 'ck.menu_show_done', 'ck.menu_hide_done'),
        {
          text: t('ck.menu_clear_done'),
          action: () => {
            items = items.filter((i) => i.repeat || !i.done);
            saveItems();
            render();
          },
        },
      ],
    };
  },
};
