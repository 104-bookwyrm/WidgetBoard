// Stopwatch that counts up, with a running TOTAL of all time ever measured.
// Stores start timestamps (not ticks): it stays exact through sleep, and keeps running while the app is closed.
//   session — this run (reset with ↺ when stopped); laps belong to the session
//   total   — every second ever counted; only "reset total" (click twice) clears it
const p2 = (n) => String(n).padStart(2, '0');
function fmtSession(ms) {
  const t = Math.floor(ms / 100); // tenths
  const h = Math.floor(t / 36000), m = Math.floor((t % 36000) / 600), s = Math.floor((t % 600) / 10), d = t % 10;
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}.${d}`;
}
function fmtTotal(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${p2(m)}:${p2(s)}`;
}

export default {
  size: { w: 3, h: 3 },
  min: { w: 2, h: 2 },
  defaults: { startedAt: null, elapsed: 0, total: 0, laps: [] },
  css: `
    .sw { height: 100%; box-sizing: border-box; padding: calc(var(--head-h) - 4px) var(--pad) var(--pad);
      display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 5cqh; }
    .sw-main { font-size: min(calc(108cqw / var(--len, 7)), 30cqh); font-weight: 600; line-height: 1;
      font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
    .sw.running .sw-main { color: var(--c2); }
    .sw-total { font-size: .85em; opacity: .75; white-space: nowrap; display: flex; gap: 6px; align-items: center; flex: none;
      font-variant-numeric: tabular-nums; }
    .sw-total b { font-weight: 600; opacity: 1; }
    .sw-total button { padding: 0 6px; font-size: .85em; }
    .sw-total button.confirm { background: var(--danger); border-color: var(--danger); color: #fff; }
    .sw-ctrl { display: flex; gap: 6px; flex: none; max-width: 100%; }
    .sw-ctrl button { white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .sw-ctrl .ico { display: none; }
    .sw-laps { align-self: stretch; flex: 1 1 0; min-height: 0; overflow-y: auto; font-size: .8em; scrollbar-width: thin;
      font-variant-numeric: tabular-nums; }
    .sw-laps div { display: flex; justify-content: space-between; gap: 8px; padding: 1px 4px; opacity: .8; }
    .sw-laps div span:first-child { opacity: .6; }
    @container (max-width: 12em) { .sw-ctrl .ico { display: inline; } .sw-ctrl .lbl { display: none; } }
    @container (max-height: 14em) { .sw-laps { display: none; } }
    @container (max-height: 6.5em) { .sw-total { display: none; } }
  `,
  mount(root, s, api) {
    const { t } = api;
    const num = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : 0);
    s.elapsed = num(s.elapsed);
    s.total = num(s.total);
    s.startedAt = s.startedAt && num(s.startedAt) <= Date.now() ? num(s.startedAt) : null;
    s.laps = Array.isArray(s.laps) ? s.laps.filter((l) => l && Number.isFinite(l.at)).slice(0, 99) : [];

    root.innerHTML = `
      <div class="sw">
        <div class="sw-main"></div>
        <div class="sw-total" title="${t('sw.total_hint')}">${t('sw.total')} <b></b>
          <button data-a="reset-total" title="${t('sw.reset_total')}">↺</button></div>
        <div class="sw-ctrl">
          <button class="primary" data-a="go"></button>
          <button data-a="lap"></button>
        </div>
        <div class="sw-laps"></div>
      </div>`;
    const box = root.firstElementChild;
    const q = (c) => box.querySelector(c);
    const run = () => (s.startedAt ? Date.now() - s.startedAt : 0);
    const session = () => s.elapsed + run();
    const total = () => s.total + run();
    let confirmTimer = null;

    function render() {
      const main = q('.sw-main');
      main.textContent = fmtSession(session());
      main.style.setProperty('--len', Math.max(7, main.textContent.length));
      q('.sw-total b').textContent = fmtTotal(total());
      box.classList.toggle('running', !!s.startedAt);
      const go = q('[data-a=go]');
      const k = s.startedAt ? 'sw.stop' : session() ? 'sw.resume' : 'sw.start';
      go.innerHTML = `<span class="ico">${s.startedAt ? '❚❚' : '▶'}</span><span class="lbl">${t(k)}</span>`;
      go.title = t(k);
      const lap = q('[data-a=lap]');
      const lk = s.startedAt ? 'sw.lap' : 'sw.reset';
      lap.innerHTML = `<span class="ico">${s.startedAt ? '⚑' : '↺'}</span><span class="lbl">${t(lk)}</span>`;
      lap.title = t(lk);
      lap.disabled = !s.startedAt && !session();
    }
    function renderLaps() {
      q('.sw-laps').hidden = !s.laps.length; // keeps the clock centred until there are laps
      q('.sw-laps').innerHTML = s.laps
        .map((l) => `<div><span>#${l.n}</span><span>+${fmtSession(l.split)}</span><span>${fmtSession(l.at)}</span></div>`)
        .join('');
    }

    let tick;
    function loop() {
      clearInterval(tick);
      if (s.startedAt) tick = setInterval(render, 100);
    }
    function start() {
      s.startedAt = Date.now();
      api.save();
      loop();
      render();
    }
    function stop() {
      const d = run();
      s.elapsed += d;
      s.total += d;
      s.startedAt = null;
      api.save();
      loop();
      render();
    }

    box.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'go') s.startedAt ? stop() : start();
      if (a === 'lap') {
        if (s.startedAt) {
          const at = session();
          s.laps.unshift({ n: (s.laps[0]?.n ?? 0) + 1, at, split: at - (s.laps[0]?.at ?? 0) });
          s.laps = s.laps.slice(0, 99);
        } else {
          s.elapsed = 0;
          s.laps = [];
        }
        api.save();
        renderLaps();
        render();
      }
      if (a === 'reset-total') {
        // two clicks within 3 s: the total can represent months of counting
        const btn = e.target.closest('button');
        if (!confirmTimer) {
          btn.classList.add('confirm');
          btn.textContent = t('sw.sure');
          confirmTimer = setTimeout(() => {
            confirmTimer = null;
            btn.classList.remove('confirm');
            btn.textContent = '↺';
          }, 3000);
          return;
        }
        clearTimeout(confirmTimer);
        confirmTimer = null;
        btn.classList.remove('confirm');
        btn.textContent = '↺';
        s.total = 0;
        if (s.startedAt) {
          // keep the current run going, but count the total from now
          s.elapsed += run();
          s.startedAt = Date.now();
        }
        api.save();
        render();
      }
    });

    renderLaps();
    render();
    loop();
    return {
      destroy: () => (clearInterval(tick), clearTimeout(confirmTimer)),
      summary: () =>
        t(s.startedAt ? 'sum.sw_running' : 'sum.sw_stopped', { now: fmtTotal(session()), total: fmtTotal(total()) }),
    };
  },
};
