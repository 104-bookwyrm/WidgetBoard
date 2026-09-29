// D-day list: Discord-member-list style rows with circular icons.
// Drag rows to reorder, or drop them onto another D-day widget. Filter by status and tag.
import { esc, ymd, daysBetween, uid, wheelScrollX } from '../util.js';

const STATUSES = ['all', 'upcoming', 'past'];

export default {
  size: { w: 3, h: 4 },
  min: { w: 2, h: 2 },
  defaults: { items: [], filter: { status: 'all', tags: [] } },
  css: `
    .dd { position: absolute; inset: 0; padding: var(--head-h) var(--pad) var(--pad); box-sizing: border-box;
      display: flex; flex-direction: column; gap: 6px; }
    .dd-filter { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; flex: none;
      mask-image: linear-gradient(to right, #000 88%, transparent); }
    .dd-filter .chip { max-width: 9em; overflow: hidden; text-overflow: ellipsis; flex: none; }
    .dd-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px;
      scrollbar-width: thin; }
    .dd-row { display: flex; align-items: center; gap: .7em; padding: .35em .45em; border-radius: 6px;
      cursor: pointer; touch-action: none; }
    .dd-row:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .dd-row.dragging { opacity: .25; }
    .dd-row.drop-before { box-shadow: 0 -2px 0 var(--c2); }
    .dd-row.drop-after { box-shadow: 0 2px 0 var(--c2); }
    .dd-list.drop-empty { outline: 2px dashed var(--c2); outline-offset: -2px; border-radius: 6px; }
    .dd-av { width: 2.4em; height: 2.4em; border-radius: 50%; flex: none; overflow: hidden;
      background: var(--c2); display: grid; place-items: center; font-weight: 700; color: var(--on-accent); }
    .dd-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dd-text { flex: 1; min-width: 0; }
    .dd-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dd-sub { font-size: .75em; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dd-d { font-weight: 700; color: var(--c2); white-space: nowrap; font-variant-numeric: tabular-nums; flex: none; }
    .dd-d.today { background: var(--c2); color: var(--on-accent); padding: 0 .5em; border-radius: 999px; }
    .dd-d.past { color: var(--c3); opacity: .5; }
    .dd-empty { opacity: .5; font-size: .85em; padding: 8px 4px; }
    .dd-add { flex: none; font-size: .85em; }
    .dd-ghost { position: fixed; z-index: 100; pointer-events: none; background: var(--c1);
      border-radius: 6px; box-shadow: 0 6px 22px rgb(0 0 0 / .45); opacity: .95; font-family: var(--font); }
    .dd-editor { position: absolute; inset: 0; z-index: 6; padding: calc(var(--head-h) + 4px) calc(var(--pad) + 2px) calc(var(--pad) + 2px); box-sizing: border-box;
      background: color-mix(in srgb, var(--c1) 96%, transparent); overflow-y: auto;
      display: flex; flex-direction: column; gap: 6px; font-size: .9em; }
    .dd-ed-top { display: flex; gap: 8px; align-items: center; }
    .dd-ed-top .dd-av { width: 3.4em; height: 3.4em; cursor: pointer; border: 0; padding: 0; font-size: 1em; }
    .dd-ed-fields { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .dd-editor input, .dd-editor select { width: 100%; box-sizing: border-box; }
    .dd-icons { display: flex; flex-wrap: wrap; gap: 6px; max-height: 8.5em; overflow-y: auto; }
    .dd-icons .dd-av { width: 2.2em; height: 2.2em; cursor: pointer; font-size: .8em; border: 0; padding: 0; }
    .dd-icons .dd-av.sel { outline: 2px solid var(--c2); outline-offset: 1px; }
    .dd-ed-btns { display: flex; gap: 6px; margin-top: auto; }
    .dd-ed-btns .sp { flex: 1; }
    .dd-text { min-width: 1.2em; }
    @container (max-width: 13em) {
      .dd-sub { display: none; }
      .dd-av { width: 1.7em; height: 1.7em; font-size: .9em; }
      .dd-d { font-size: .85em; }
      .dd-row { gap: .45em; }
    }
  `,
  mount(root, s, api) {
    const { t } = api;
    const validDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d));
    s.items = (Array.isArray(s.items) ? s.items : [])
      .filter((i) => i && typeof i === 'object')
      .map((i) => ({ ...i, id: i.id || uid(), name: String(i.name ?? ''), tag: String(i.tag ?? ''), date: validDate(i.date) ? i.date : ymd() }));
    if (!s.filter || typeof s.filter !== 'object') s.filter = {};
    if (!STATUSES.includes(s.filter.status)) s.filter.status = 'all';
    if (!Array.isArray(s.filter.tags)) s.filter.tags = [];

    root.innerHTML = `
      <div class="dd">
        <div class="dd-filter"></div>
        <div class="dd-list"></div>
        <button class="dd-add">+ ${t('dday.add')}</button>
        <div class="dd-editor" hidden></div>
      </div>`;
    const box = root.firstElementChild;
    const bar = box.querySelector('.dd-filter');
    const list = box.querySelector('.dd-list');
    const editor = box.querySelector('.dd-editor');
    wheelScrollX(bar);

    const today = () => ymd();
    const diffOf = (it) => daysBetween(today(), it.date);
    function dLabel(it) {
      const diff = diffOf(it);
      if (it.mode === 'since' && diff <= 0) return t('dday.since', { n: 1 - diff });
      return diff > 0 ? `D-${diff}` : diff === 0 ? 'D-Day' : `D+${-diff}`;
    }
    const tagsOf = () => [...new Set(s.items.map((i) => i.tag).filter(Boolean))].sort();
    function visible() {
      const f = s.filter;
      return s.items.filter((it) => {
        const diff = diffOf(it);
        if (f.status === 'upcoming' && diff < 0) return false;
        if (f.status === 'past' && diff >= 0) return false;
        if (f.tags.length && !f.tags.includes(it.tag)) return false;
        return true;
      });
    }
    const avatar = (it, cls = '') =>
      `<div class="dd-av ${cls}">${it.icon ? `<img src="${esc(api.assetUrl(it.icon))}" alt="">` : esc((it.name || '?').trim().charAt(0))}</div>`;

    function render() {
      s.filter.tags = s.filter.tags.filter((tg) => tagsOf().includes(tg));
      bar.hidden = !s.items.length;
      bar.innerHTML =
        `<button class="chip on" data-status>${t('dday.status.' + s.filter.status)}</button>` +
        tagsOf().map((tg) => `<button class="chip ${s.filter.tags.includes(tg) ? 'on' : ''}" data-tag="${esc(tg)}" title="#${esc(tg)}">#${esc(tg)}</button>`).join('');
      const vis = visible();
      list.innerHTML = vis.length
        ? vis.map((it) => {
            const diff = diffOf(it);
            const cls = diff === 0 ? 'today' : diff < 0 && it.mode !== 'since' ? 'past' : '';
            const sub = [it.date.replaceAll('-', '.'), it.tag ? '#' + it.tag : ''].filter(Boolean).join(' · ');
            return `<div class="dd-row" data-id="${esc(it.id)}" role="button" tabindex="0" aria-label="${esc(it.name + ', ' + dLabel(it) + ', ' + sub)}" title="${esc(it.name)}\n${esc(sub)}">${avatar(it)}
              <div class="dd-text"><div class="dd-name">${esc(it.name)}</div><div class="dd-sub">${esc(sub)}</div></div>
              <div class="dd-d ${cls}">${esc(dLabel(it))}</div></div>`;
          }).join('')
        : `<div class="dd-empty">${t('dday.empty')}</div>`;
    }

    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-status')) {
        s.filter.status = STATUSES[(STATUSES.indexOf(s.filter.status) + 1) % STATUSES.length];
      } else {
        const tg = b.dataset.tag;
        s.filter.tags = s.filter.tags.includes(tg) ? s.filter.tags.filter((x) => x !== tg) : [...s.filter.tags, tg];
      }
      api.save();
      render();
    });

    // ---- drag rows (reorder, or drop onto another D-day widget) ----
    list.__dday = {
      accept(item, beforeId) {
        insert(item, beforeId);
        api.save();
        render();
      },
    };
    function insert(item, beforeId) {
      let idx = beforeId ? s.items.findIndex((i) => i.id === beforeId) : -1;
      if (idx < 0) {
        // after the last visible item (keeps filtered views sensible), else at the end
        const vis = visible();
        idx = vis.length ? s.items.indexOf(vis.at(-1)) + 1 : s.items.length;
      }
      s.items.splice(idx, 0, item);
    }

    list.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.dd-row');
      if (!row || e.button !== 0) return;
      const item = s.items.find((i) => i.id === row.dataset.id);
      const sx = e.clientX, sy = e.clientY;
      let ghost = null, target = null, marked = [];
      row.setPointerCapture(e.pointerId);

      const clearMarks = () => {
        marked.forEach((m) => m.classList.remove('drop-before', 'drop-after', 'drop-empty'));
        marked = [];
      };
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          api.setInteracting(true);
          const r = row.getBoundingClientRect();
          ghost = row.cloneNode(true);
          ghost.classList.add('dd-ghost');
          ghost.style.width = r.width + 'px';
          ghost.style.fontSize = getComputedStyle(row).fontSize;
          ghost._dx = sx - r.left;
          ghost._dy = sy - r.top;
          document.body.append(ghost);
          row.classList.add('dragging');
        }
        ghost.style.left = ev.clientX - ghost._dx + 'px';
        ghost.style.top = ev.clientY - ghost._dy + 'px';
        // auto-scroll a long list while dragging near its top/bottom edge
        const lr = list.getBoundingClientRect();
        if (ev.clientY < lr.top + 24) list.scrollTop -= 12;
        else if (ev.clientY > lr.bottom - 24) list.scrollTop += 12;
        clearMarks();
        const tl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dd-list');
        target = null;
        if (!tl?.__dday) return;
        const rows = [...tl.querySelectorAll('.dd-row:not(.dragging)')];
        const before = rows.find((r) => ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
        target = { list: tl, beforeId: before?.dataset.id };
        const mark = before ? [before, 'drop-before'] : rows.length ? [rows.at(-1), 'drop-after'] : [tl, 'drop-empty'];
        mark[0].classList.add(mark[1]);
        marked.push(mark[0]);
      };
      const up = () => {
        row.removeEventListener('pointermove', move);
        row.removeEventListener('pointerup', up);
        row.removeEventListener('pointercancel', up);
        clearMarks();
        if (!ghost) return openEditor(item); // plain click = edit
        ghost.remove();
        row.classList.remove('dragging');
        api.setInteracting(false);
        if (!target || target.beforeId === item.id) return;
        s.items = s.items.filter((i) => i.id !== item.id);
        if (target.list === list) insert(item, target.beforeId);
        else target.list.__dday.accept(item, target.beforeId);
        api.save();
        render();
      };
      row.addEventListener('pointermove', move);
      row.addEventListener('pointerup', up);
      row.addEventListener('pointercancel', up);
    });

    // keyboard: Enter opens the editor, Alt+↑/↓ moves the D-day up/down (same as dragging)
    list.addEventListener('keydown', (e) => {
      const row = e.target.closest('.dd-row');
      if (!row) return;
      const item = s.items.find((i) => i.id === row.dataset.id);
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        return openEditor(item);
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const vis = visible();
        const j = vis.indexOf(item) + (e.key === 'ArrowUp' ? -1 : 1);
        if (j < 0 || j >= vis.length) return;
        const other = vis[j];
        const a = s.items.indexOf(item), b = s.items.indexOf(other);
        [s.items[a], s.items[b]] = [s.items[b], s.items[a]];
        api.save();
        render();
        list.querySelector(`[data-id="${CSS.escape(item.id)}"]`)?.focus();
        api.announce?.(`${item.name} ${j + 1}/${vis.length}`);
      }
    });

    // ---- editor ----
    box.querySelector('.dd-add').onclick = () => openEditor(null);
    function openEditor(existing) {
      const it = existing ? { ...existing } : { id: uid(), name: '', date: today(), icon: null, tag: '', mode: 'until' };
      const tagOpts = tagsOf().map((tg) => `<option value="${esc(tg)}">`).join('');
      editor.innerHTML = `
        <div class="dd-ed-top">
          <button class="dd-av" data-a="icon" title="${t('dday.icon')}"></button>
          <div class="dd-ed-fields">
            <input data-f="name" placeholder="${t('dday.name')}" value="${esc(it.name)}">
            <input data-f="date" type="date" value="${esc(it.date)}">
          </div>
        </div>
        <div class="dd-icons" hidden></div>
        <input data-f="tag" list="dd-tags-${it.id}" placeholder="${t('dday.tag')}" value="${esc(it.tag)}">
        <datalist id="dd-tags-${it.id}">${tagOpts}</datalist>
        <select data-f="mode">
          <option value="until">${t('dday.mode_until')}</option>
          <option value="since">${t('dday.mode_since')}</option>
        </select>
        <div class="dd-ed-btns">
          ${existing ? `<button data-a="del">${t('dday.delete')}</button>` : ''}
          <span class="sp"></span>
          <button data-a="cancel">${t('dday.cancel')}</button>
          <button class="primary" data-a="ok">${t('dday.save')}</button>
        </div>`;
      editor.hidden = false;
      const f = (n) => editor.querySelector(`[data-f=${n}]`);
      f('mode').value = it.mode || 'until';
      const iconBtn = editor.querySelector('[data-a=icon]');
      const paintIcon = () => (iconBtn.innerHTML = it.icon ? `<img src="${esc(api.assetUrl(it.icon))}" alt="">` : '＋');
      paintIcon();
      f('name').focus();

      const icons = editor.querySelector('.dd-icons');
      async function showIcons() {
        const used = s.items.map((i) => i.icon).filter(Boolean);
        const all = [...new Set([...used, ...(await api.listAssets().catch(() => []))])].slice(0, 60);
        icons.innerHTML =
          `<button class="dd-av" data-up title="${t('dday.icon_upload')}">⬆</button>` +
          `<button class="dd-av" data-none title="${t('dday.icon_none')}">∅</button>` +
          all.map((a) => `<button class="dd-av ${a === it.icon ? 'sel' : ''}" data-icon="${esc(a)}"><img src="${esc(api.assetUrl(a))}" alt=""></button>`).join('');
        icons.hidden = false;
      }
      iconBtn.onclick = () => (icons.hidden ? showIcons() : (icons.hidden = true));
      icons.onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.hasAttribute('data-up')) {
          const file = await api.pickImage();
          if (!file) return;
          it.icon = await api.uploadImage(file);
        } else if (b.hasAttribute('data-none')) it.icon = null;
        else it.icon = b.dataset.icon;
        paintIcon();
        icons.hidden = true;
      };

      const close = () => ((editor.hidden = true), (editor.innerHTML = ''));
      const ok = () => {
        it.name = f('name').value.trim().slice(0, 100);
        it.date = f('date').value;
        it.tag = f('tag').value.trim().replace(/^#/, '');
        it.mode = f('mode').value;
        if (!it.name || !it.date) return api.toast(t('dday.need_name'));
        if (!validDate(it.date)) return api.toast(t('dday.need_name'));
        const i = s.items.findIndex((x) => x.id === it.id);
        if (i >= 0) s.items[i] = it;
        else s.items.push(it);
        api.save();
        close();
        render();
        if (!visible().includes(it)) api.toast(t('dday.hidden_by_filter'));
      };
      editor.onclick = (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'ok') ok();
        if (a === 'cancel') close();
        if (a === 'del') {
          s.items = s.items.filter((x) => x.id !== it.id);
          api.save();
          close();
          render();
        }
      };
      editor.onkeydown = (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') ok();
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      };
    }

    // re-render when the date rolls over
    let day = today();
    const tick = setInterval(() => {
      if (today() !== day) (day = today()), render();
    }, 60000);

    render();
    return {
      destroy: () => clearInterval(tick),
      summary: () => {
        const list = visible();
        if (!list.length) return t('sum.dday_empty');
        return list.slice(0, 6).map((it) => `${it.name} ${dLabel(it)}`).join(', ') + (list.length > 6 ? ' …' : '');
      },
    };
  },
};
