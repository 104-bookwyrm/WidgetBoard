// Showcase (오시 · oshi): a shrine card for a favourite character/person/thing.
// Primary image (or slideshow), name overlay, rotating quotes, birthday countdown.
// Birthday auto-syncs as a recurring calendar entry via shared data/events.json.
// Frameless mode hides widget chrome so transparent PNGs sit on the desktop.
// Data is inspectable: right-click → Export data (JSON to clipboard) / Import data.
import { esc, ymd, daysBetween, uid, dropZone } from '../util.js';
import { icon } from '../icons.js';

const QUOTE_INTERVAL = 8000; // ms between quote rotations

export default {
  size: { w: 3, h: 4 },
  min: { w: 2, h: 2 },
  defaults: {
    name: '',
    imgs: [],
    index: 0,
    fit: 'cover',
    quotes: [],
    birthday: '', // YYYY-MM-DD — only month-day matter for recurrence
    color: '', // optional accent override for the name band
    frameless: false,
    calSync: true, // auto-create a recurring calendar entry for the birthday
    _calId: '', // id of the synced calendar entry (for cleanup)
  },
  css: `
    .sc { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; }
    .sc .hero { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: pointer; }
    .sc .hero img { position: absolute; inset: 0; width: 100%; height: 100%; display: block;
      opacity: 0; transition: opacity .6s; }
    .sc .hero img.on { opacity: 1; }
    .sc .hero .empty { position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: var(--space-2); font-size: var(--fs-small); color: var(--text-faint);
      text-align: center; padding: 8px; cursor: pointer; }
    .sc .hero .empty .ico { font-size: 2.2em; line-height: 1; }
    .sc .band { flex: none; padding: 6px 10px; display: flex; align-items: baseline; gap: var(--space-3);
      background: color-mix(in srgb, var(--sc-color, var(--c2)) 15%, transparent); min-height: 1.6em; }
    .sc .band .nm { font-weight: 700; font-size: var(--fs-title); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; flex: 1; min-width: 0; }
    .sc .band .bd { font-size: var(--fs-meta); font-weight: 600; font-family: var(--font-num, var(--font)); white-space: nowrap; flex: none;
      color: var(--sc-color, var(--c2)); font-variant-numeric: tabular-nums; }
    .sc .band .bd.today { background: var(--sc-color, var(--c2)); color: var(--on-accent);
      padding: 0 .45em; border-radius: 999px; }
    .sc .qt { flex: none; padding: 4px 10px 6px; font-size: var(--fs-meta); font-style: italic; color: var(--text-muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.4em;
      transition: opacity .4s; }
    .sc .qt.fade { opacity: 0; }
    .sc .nav { position: absolute; left: 4px; right: 4px; bottom: 4px; display: flex;
      justify-content: center; gap: var(--space-2); opacity: 0; transition: opacity .15s; z-index: 2; }
    .widget:hover .sc .nav { opacity: 1; }
    .sc .nav button { font-size: var(--fs-meta); padding: 1px 7px; background: color-mix(in srgb, var(--c1) 75%, transparent);
      border-radius: 999px; }
    @container (max-width: 9em) { .sc .qt { display: none; } .sc .band .bd { font-size: var(--fs-meta); } }
    @container (max-width: 7em) { .sc .nav { display: none; } }
    .sc-edit { position: absolute; inset: 0; z-index: 6; padding: calc(var(--head-h) + 4px) calc(var(--pad) + 2px)
      calc(var(--pad) + 2px); box-sizing: border-box; background: color-mix(in srgb, var(--c1) 96%, transparent);
      overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-3); font-size: var(--fs-small); }
    .sc-edit label { font-size: var(--fs-meta); color: var(--text-faint); }
    .sc-edit input, .sc-edit textarea { width: 100%; box-sizing: border-box; }
    .sc-edit textarea { resize: vertical; min-height: 3.5em; font-family: inherit; }
    .sc-edit .btns { display: flex; gap: var(--space-3); margin-top: auto; }
    .sc-edit .btns .sp { flex: 1; }
  `,
  mount(root, s, api) {
    const { t } = api;

    // ---- sanitize ----
    if (!Array.isArray(s.imgs)) s.imgs = [];
    s.imgs = s.imgs.filter((x) => typeof x === 'string' && x);
    if (!Array.isArray(s.quotes)) s.quotes = [];
    s.quotes = s.quotes.filter((x) => typeof x === 'string' && x.trim());
    if (!(s.index >= 0 && s.index < s.imgs.length)) s.index = 0;
    s.name = String(s.name ?? '');
    s.birthday = typeof s.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.birthday) ? s.birthday : '';
    api.setFrameless(s.frameless);
    if (s.color) root.style.setProperty('--sc-color', s.color);

    // ---- DOM ----
    root.innerHTML = `
      <div class="sc">
        <div class="hero"></div>
        <div class="band"><span class="nm"></span><span class="bd"></span></div>
        <div class="qt"></div>
        <div class="sc-edit" hidden></div>
      </div>`;
    const box = root.firstElementChild;
    const hero = box.querySelector('.hero');
    const bandName = box.querySelector('.nm');
    const bandBd = box.querySelector('.bd');
    const quoteEl = box.querySelector('.qt');
    const editor = box.querySelector('.sc-edit');

    const bad = new Set();
    let quoteTimer = null;
    let quoteIdx = 0;
    let front = 0;

    // ---- image display (reuses image.js crossfade pattern) ----
    async function addImages(files) {
      const imgs = [...files].filter((f) => f && f.type.startsWith('image/'));
      if (!imgs.length) return files.length && api.toast(t('toast.not_image'));
      for (const f of imgs) {
        try {
          const name = await api.uploadImage(f);
          if (!s.imgs.includes(name)) s.imgs.push(name);
          bad.delete(name);
        } catch {}
      }
      if (s.imgs.length) s.index = s.imgs.length - 1;
      api.save();
      buildHero();
    }
    const chooseImg = async () => addImages(await api.pickImages());

    function buildHero() {
      const usable = s.imgs.filter((x) => !bad.has(x));
      if (!usable.length) {
        hero.innerHTML = `<div class="empty"><span class="ico">${icon('image')}</span><span>${esc(t('sc.add_image'))}</span></div>`;
        hero.firstElementChild.onclick = chooseImg;
        return;
      }
      const many = s.imgs.length > 1;
      hero.innerHTML = `
        <img draggable="false" alt=""><img draggable="false" alt="">
        ${many ? `<div class="nav">
          <button data-a="prev" title="${esc(t('image.prev'))}">${icon('left')}</button>
          <button data-a="next" title="${esc(t('image.next'))}">${icon('right')}</button>
        </div>` : ''}`;
      for (const img of hero.querySelectorAll('img')) {
        img.style.objectFit = s.fit;
        img.onerror = () => {
          const name = img.dataset.name;
          if (!name || bad.has(name)) return;
          bad.add(name);
          if (s.imgs.every((x) => bad.has(x))) return buildHero();
          showImg(s.index + 1);
        };
      }
      showImg(s.index, true);
    }

    function showImg(i, instant) {
      const n = s.imgs.length;
      if (!n) return;
      s.index = ((i % n) + n) % n;
      const layers = hero.querySelectorAll('img');
      if (layers.length < 2) return;
      const next = instant ? layers[front] : layers[1 - front];
      next.dataset.name = s.imgs[s.index];
      const reveal = () => {
        layers.forEach((l) => l.classList.toggle('on', l === next));
        front = [...layers].indexOf(next);
      };
      const url = api.assetUrl(s.imgs[s.index]);
      if (next.getAttribute('src') === url && next.complete) reveal();
      else { next.onload = reveal; next.src = url; }
    }

    hero.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'prev' || a === 'next') {
        showImg(s.index + (a === 'prev' ? -1 : 1));
        api.save();
      } else if (!e.target.closest('.nav') && !s.imgs.length) {
        chooseImg();
      }
    });
    dropZone(hero, t('w.drop'), addImages);

    // ---- name & birthday band ----
    function renderBand() {
      bandName.textContent = s.name || t('sc.unnamed');
      bandBd.textContent = '';
      bandBd.className = 'bd';
      if (!s.birthday) return;
      const md = s.birthday.slice(5); // MM-DD
      const thisYear = new Date().getFullYear();
      let next = `${thisYear}-${md}`;
      if (daysBetween(ymd(), next) < 0) next = `${thisYear + 1}-${md}`;
      const diff = daysBetween(ymd(), next);
      if (diff === 0) {
        bandBd.innerHTML = `${icon('cake')} ${esc(t('sc.birthday_today'))}`;
        bandBd.classList.add('today');
      } else {
        bandBd.innerHTML = `${icon('cake')} D-${diff}`;
      }
    }

    // ---- quote rotation ----
    function startQuotes() {
      clearInterval(quoteTimer);
      if (!s.quotes.length) { quoteEl.textContent = ''; return; }
      quoteIdx = quoteIdx % s.quotes.length;
      quoteEl.textContent = s.quotes[quoteIdx];
      quoteEl.classList.remove('fade');
      if (s.quotes.length > 1) {
        quoteTimer = setInterval(() => {
          quoteEl.classList.add('fade');
          setTimeout(() => {
            quoteIdx = (quoteIdx + 1) % s.quotes.length;
            quoteEl.textContent = s.quotes[quoteIdx];
            quoteEl.classList.remove('fade');
          }, 400);
        }, QUOTE_INTERVAL);
      }
    }

    // ---- calendar birthday sync ----
    // api.store.get/set are async (they cross into Tauri) — must be awaited; calendar does the same.
    async function syncBirthday() {
      if (!s.calSync || !s.birthday || !s.name) {
        if (s._calId) await removeBirthdayEntry(); // drop a stale entry
        return;
      }
      const md = s.birthday.slice(5);
      const title = t('sc.birthday_event', { name: s.name });
      const events = (await api.store.get('events').catch(() => null)) || [];
      const existing = s._calId && events.find((e) => e.id === s._calId);
      if (existing) {
        // a changed birthday moves the entry too (yearly: only month-day matters)
        const moved = String(existing.date || '').slice(5) !== md;
        if (existing.title !== title || existing.repeat !== 'yearly' || moved) {
          existing.title = title;
          existing.repeat = 'yearly';
          if (moved) existing.date = `${new Date().getFullYear()}-${md}`;
          await api.store.set('events', events).catch(() => {});
        }
        return;
      }
      // new entry — calendar repeats a 'yearly' event each year on its month-day
      const id = uid();
      events.push({
        id,
        date: `${new Date().getFullYear()}-${md}`,
        title,
        done: false,
        repeat: 'yearly',
        _src: 'showcase', // marks origin, for cleanup
      });
      await api.store.set('events', events).catch(() => {});
      s._calId = id;
      api.save();
    }

    async function removeBirthdayEntry() {
      if (!s._calId) return;
      const events = (
        (await api.store.get('events').catch(() => null)) || []
      ).filter((e) => e.id !== s._calId);
      await api.store.set('events', events).catch(() => {});
      s._calId = '';
      api.save();
    }

    // ---- editor ----
    function openEditor() {
      const draft = { name: s.name, birthday: s.birthday, quotes: s.quotes.join('\n'), color: s.color, calSync: s.calSync };
      editor.innerHTML = `
        <label>${esc(t('sc.name'))}</label>
        <input data-f="name" placeholder="${esc(t('sc.name_hint'))}" value="${esc(draft.name)}">
        <label>${esc(t('sc.birthday'))}</label>
        <input data-f="birthday" type="date" value="${esc(draft.birthday)}">
        <label>${esc(t('sc.quotes'))}</label>
        <textarea data-f="quotes" placeholder="${esc(t('sc.quotes_hint'))}" rows="3">${esc(draft.quotes)}</textarea>
        <label>${esc(t('sc.accent'))}</label>
        <input data-f="color" type="color" value="${draft.color || '#888888'}" style="width:2.5em;height:2em;padding:0;border:0;">
        <label style="display:flex;gap: var(--space-3);align-items:center;font-size:1em;color:var(--c3);">
          <input data-f="calSync" type="checkbox" ${draft.calSync ? 'checked' : ''}> ${esc(t('sc.cal_sync'))}
        </label>
        <div class="btns">
          <button data-a="clear_color">${esc(t('sc.clear_color'))}</button>
          <span class="sp"></span>
          <button data-a="cancel">${esc(t('dday.cancel'))}</button>
          <button class="primary" data-a="ok">${esc(t('dday.save'))}</button>
        </div>`;
      editor.hidden = false;
      editor.querySelector('[data-f=name]').focus();

      const f = (n) => editor.querySelector(`[data-f=${n}]`);
      let clearColor = false;

      editor.onclick = (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'cancel') { editor.hidden = true; editor.innerHTML = ''; return; }
        if (a === 'clear_color') { clearColor = true; f('color').value = '#888888'; return; }
        if (a === 'ok') {
          s.name = f('name').value.trim().slice(0, 100);
          s.birthday = f('birthday').value || '';
          s.quotes = f('quotes').value.split('\n').map((l) => l.trim()).filter(Boolean);
          s.color = clearColor ? '' : (f('color').value === '#888888' && !s.color ? '' : f('color').value);
          s.calSync = f('calSync').checked;
          if (s.color) root.style.setProperty('--sc-color', s.color);
          else root.style.removeProperty('--sc-color');
          api.save();
          editor.hidden = true;
          editor.innerHTML = '';
          render();
          syncBirthday();
        }
      };
      editor.onkeydown = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); editor.hidden = true; editor.innerHTML = ''; }
      };
    }

    // ---- data export/import (partial reverse-engineering) ----
    function exportData() {
      const data = { name: s.name, birthday: s.birthday, quotes: [...s.quotes], imgs: [...s.imgs], color: s.color, calSync: s.calSync };
      navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(
        () => api.toast(t('sc.exported')),
        () => api.toast(t('sc.export_failed')),
      );
    }
    function importData() {
      navigator.clipboard.readText().then((text) => {
        try {
          const d = JSON.parse(text);
          if (typeof d.name === 'string') s.name = d.name;
          if (typeof d.birthday === 'string') s.birthday = d.birthday;
          if (Array.isArray(d.quotes)) s.quotes = d.quotes.filter((q) => typeof q === 'string' && q.trim());
          if (Array.isArray(d.imgs)) s.imgs = [...new Set([...s.imgs, ...d.imgs.filter((i) => typeof i === 'string')])];
          if (typeof d.color === 'string') s.color = d.color;
          if (typeof d.calSync === 'boolean') s.calSync = d.calSync;
          if (s.color) root.style.setProperty('--sc-color', s.color);
          else root.style.removeProperty('--sc-color');
          api.save();
          render();
          syncBirthday();
          api.toast(t('sc.imported'));
        } catch { api.toast(t('sc.import_failed')); }
      }).catch(() => api.toast(t('sc.import_failed')));
    }

    // ---- render ----
    function render() {
      buildHero();
      renderBand();
      startQuotes();
    }

    // re-render at midnight (birthday countdown changes)
    api.onDayChange(() => renderBand());

    render();
    syncBirthday();

    return {
      destroy: () => clearInterval(quoteTimer),
      resized: () => {}, // CSS container queries handle responsive layout
      summary: () => {
        const parts = [];
        if (s.name) parts.push(s.name);
        if (s.birthday) {
          const md = s.birthday.slice(5);
          const thisYear = new Date().getFullYear();
          let next = `${thisYear}-${md}`;
          if (daysBetween(ymd(), next) < 0) next = `${thisYear + 1}-${md}`;
          const diff = daysBetween(ymd(), next);
          parts.push(diff === 0 ? t('sc.birthday_today') : `🎂 D-${diff}`);
        }
        if (s.imgs.length) parts.push(t('sum.image', { i: s.index + 1, n: s.imgs.length }));
        return parts.join(' · ') || t('sc.empty');
      },
      menu: () => [
        { text: t('sc.edit'), action: openEditor },
        { text: t('image.add_more'), action: chooseImg },
        {
          text: (s.frameless ? '✓ ' : '') + t('image.frameless'),
          action: () => {
            s.frameless = !s.frameless;
            if (s.frameless) s.fit = 'contain';
            api.setFrameless(s.frameless);
            api.save();
            buildHero();
          },
        },
        { text: t('sc.export'), action: exportData },
        { text: t('sc.import'), action: importData },
        ...(s.imgs.length > 1 ? [{
          text: t(s.fit === 'cover' ? 'image.fit' : 'image.fill'),
          action: () => { s.fit = s.fit === 'cover' ? 'contain' : 'cover'; api.save(); buildHero(); },
        }] : []),
        ...(s.imgs.length ? [{ text: t('image.clear'), action: () => { s.imgs = []; s.index = 0; api.save(); buildHero(); } }] : []),
      ],
    };
  },
};
