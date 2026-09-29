// Diary: one page per day (diary/YYYY-MM-DD.md). ‹ › flick between days that have pages
// (› ends at today); click the date to jump anywhere. Arrow keys stay with the text cursor.
// A horizontal touchpad swipe over the widget also flicks pages.
import { ymd, parseYmd } from '../util.js';

export default {
  size: { w: 4, h: 4 },
  min: { w: 3, h: 3 },
  defaults: {},
  css: `
    .dy { position: absolute; inset: 0; padding: var(--head-h) calc(var(--pad) + 2px) calc(var(--pad) - 2px); box-sizing: border-box;
      display: flex; flex-direction: column; gap: 6px; }
    .dy-head { display: flex; gap: 4px; align-items: center; flex: none; position: relative; }
    .dy-head button { padding: 0 8px; font-size: .85em; }
    .dy-head button:disabled { opacity: .3; cursor: default; }
    .dy-head .dy-date { flex: 1; background: none; border: 0; font-weight: 600; font-size: 1em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dy-head .dy-date:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .dy-picker { position: absolute; left: 30%; bottom: 0; width: 1px; height: 1px; opacity: 0;
      pointer-events: none; padding: 0; border: 0; }
    .dy textarea.dy-text { flex: 1; min-height: 0; resize: none; border: 0; border-radius: 0; padding: 0 2px;
      line-height: 1.7em; background-color: transparent; background-attachment: local;
      background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(1.7em - 1px),
        color-mix(in srgb, var(--c3) 13%, transparent) calc(1.7em - 1px), color-mix(in srgb, var(--c3) 13%, transparent) 1.7em);
      scrollbar-width: thin; }
    .dy-foot { display: flex; justify-content: space-between; font-size: .72em; opacity: .55; flex: none; }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    root.innerHTML = `
      <div class="dy">
        <div class="dy-head">
          <button data-a="prev" title="${t('diary.prev')}">‹</button>
          <button class="dy-date" data-a="pick" title="${t('diary.pick')}"></button>
          <button data-a="next" title="${t('diary.next')}">›</button>
          <button data-a="today">${t('diary.today')}</button>
          <input type="date" class="dy-picker" tabindex="-1" aria-hidden="true" aria-label="${t('diary.pick')}">
        </div>
        <textarea class="dy-text" spellcheck="false" placeholder="${t('diary.placeholder')}"></textarea>
        <div class="dy-foot"><span class="dy-status"></span><span class="dy-count"></span></div>
      </div>`;
    const box = root.firstElementChild;
    const q = (c) => box.querySelector(c);
    const ta = q('.dy-text');
    const picker = q('.dy-picker');

    let date = ymd();
    let dates = [];
    let dirty = false;
    let saveTimer;

    const prevDate = () => dates.filter((d) => d < date).at(-1) ?? null;
    const nextDate = () => dates.find((d) => d > date) ?? (date < ymd() ? ymd() : null);

    function renderHead() {
      const label = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(parseYmd(date));
      q('.dy-date').textContent = label;
      q('[data-a=prev]').disabled = !prevDate();
      q('[data-a=next]').disabled = !nextDate();
      q('[data-a=today]').disabled = date === ymd();
      q('.dy-count').textContent = t('diary.chars', { n: ta.value.length });
    }
    const status = (k) => (q('.dy-status').textContent = k ? t(k) : '');

    async function flush() {
      if (!dirty) return;
      clearTimeout(saveTimer);
      dirty = false;
      const text = ta.value;
      try {
        await api.diary.set(date, text);
      } catch {
        dirty = true; // keep the text; try again on the next edit / blur
        status('diary.save_failed');
        return;
      }
      const has = dates.includes(date);
      if (text.trim() && !has) dates = [...dates, date].sort();
      if (!text.trim() && has) dates = dates.filter((d) => d !== date);
      status('diary.saved');
      renderHead();
    }
    async function open(d, dir = 0) {
      if (!d) return;
      await flush();
      date = d;
      ta.value = await api.diary.get(d);
      status('');
      renderHead();
      if (dir && !api.reduceMotion) ta.animate([{ transform: `translateX(${dir * 18}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 170, easing: 'ease-out' });
    }

    ta.addEventListener('input', () => {
      dirty = true;
      status('diary.saving');
      q('.dy-count').textContent = t('diary.chars', { n: ta.value.length });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 700);
    });
    ta.addEventListener('blur', flush);

    q('.dy-head').onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'prev') open(prevDate(), -1);
      if (a === 'next') open(nextDate(), 1);
      if (a === 'today') open(ymd(), 1);
      if (a === 'pick') {
        picker.value = date;
        try { picker.showPicker(); } catch { picker.focus(); }
      }
    };
    picker.onchange = () => picker.value && open(picker.value, picker.value < date ? -1 : 1);

    // horizontal touchpad swipe flicks pages
    let swipeLock = 0;
    box.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) < 25 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return;
      e.preventDefault();
      if (Date.now() < swipeLock) return;
      swipeLock = Date.now() + 600;
      e.deltaX > 0 ? open(nextDate(), 1) : open(prevDate(), -1);
    }, { passive: false });

    // another diary widget (or monitor) changed a page
    api.onStore('diary', async (p) => {
      dates = await api.diary.dates();
      if (p.date === date && document.activeElement !== ta && !dirty) ta.value = await api.diary.get(date);
      renderHead();
    });

    let day = ymd();
    const tick = setInterval(() => {
      if (ymd() !== day) (day = ymd()), renderHead();
    }, 60000);

    (async () => {
      dates = await api.diary.dates();
      await open(date);
    })();
    return {
      destroy() {
        clearInterval(tick);
        flush();
      },
      summary: () => {
        const txt = ta.value.trim().replace(/\s+/g, ' ');
        return t('sum.diary', { date, n: txt.length }) + (txt ? ' — ' + txt.slice(0, 100) + (txt.length > 100 ? '…' : '') : '');
      },
    };
  },
};
