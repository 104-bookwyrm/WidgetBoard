// Memo: a sticky note that keeps whatever you write (no daily reset). Each memo widget is its own note.
// Paper colour: hover → colour dots (bottom-right), or right-click → 메모 색.
const COLORS = {
  theme: null, // the widget's normal theme surface
  yellow: '#fff1a6',
  pink: '#ffcfe1',
  green: '#cdefc4',
  blue: '#c9e4ff',
  purple: '#e2d6ff',
  orange: '#ffd9b3',
};

export default {
  size: { w: 3, h: 3 },
  min: { w: 2, h: 2 },
  defaults: { text: '', color: 'yellow' },
  css: `
    .memo { position: absolute; inset: 0; display: flex; flex-direction: column; box-sizing: border-box; padding: var(--head-h) calc(var(--pad) + 2px) var(--pad); }
    .memo.paper { background: color-mix(in srgb, var(--memo-bg) calc(var(--widget-opacity) * 100% + 10%), transparent); color: #2a2a2a; }
    .memo textarea { flex: 1; min-height: 0; resize: none; border: 0; border-radius: 0; padding: 0; background: transparent;
      color: inherit; line-height: 1.55; scrollbar-width: thin; overflow-wrap: anywhere; }
    .memo textarea:focus { border: 0; }
    .memo.paper textarea::placeholder { color: #2a2a2a; opacity: .45; }
    .memo-colors { position: absolute; right: 8px; bottom: 6px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
    .widget:hover .memo-colors { opacity: 1; }
    .memo-colors button { width: 14px; height: 14px; padding: 0; border-radius: 50%;
      border: 1px solid rgb(0 0 0 / .25); background: var(--dot); }
    .memo-colors button.on { outline: 2px solid var(--c2); outline-offset: 1px; }
    .memo-colors button[data-c=theme] { background: var(--c1); border-color: var(--c3); }
    @container (max-width: 11em) { .memo-colors { display: none; } }
  `,
  mount(root, s, api) {
    const { t } = api;
    if (typeof s.text !== 'string') s.text = '';
    if (!(s.color in COLORS)) s.color = 'yellow';

    root.innerHTML = `
      <div class="memo">
        <textarea spellcheck="false" placeholder="${t('memo.placeholder')}"></textarea>
        <div class="memo-colors">${Object.keys(COLORS)
          .map((c) => `<button data-c="${c}" title="${t('memo.color.' + c)}" style="--dot:${COLORS[c] ?? 'transparent'}"></button>`)
          .join('')}</div>
      </div>`;
    const box = root.firstElementChild;
    const ta = box.querySelector('textarea');
    ta.value = s.text;

    function paint() {
      box.classList.toggle('paper', !!COLORS[s.color]);
      box.style.setProperty('--memo-bg', COLORS[s.color] ?? 'transparent');
      box.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', b.dataset.c === s.color));
    }
    function setColor(c) {
      s.color = c;
      api.save();
      paint();
    }

    let timer;
    const flush = () => {
      clearTimeout(timer);
      if (s.text === ta.value) return;
      s.text = ta.value.slice(0, 50000);
      api.save();
    };
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 500);
    });
    ta.addEventListener('blur', flush);
    box.querySelector('.memo-colors').onclick = (e) => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (c) setColor(c);
    };

    paint();
    return {
      destroy: flush,
      summary: () => {
        const txt = ta.value.trim().replace(/\s+/g, ' ');
        return txt ? txt.slice(0, 160) + (txt.length > 160 ? '…' : '') : t('sum.memo_empty');
      },
      menu: () => [{ text: t('memo.color'), items: Object.keys(COLORS).map((c) => ({ text: t('memo.color.' + c), action: () => setColor(c) })) }],
    };
  },
};
