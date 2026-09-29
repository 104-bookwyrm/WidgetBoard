// Timer widget. Stores the end timestamp (not ticks), so it stays correct across sleep/restart.
const fmt = (ms) => {
  const t = Math.ceil(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};
// "25" = 25 min, "1:30" = 1 min 30 s, "1:00:00" = 1 h
const parse = (str) => {
  str = str.trim();
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str) * 60000 || null;
  const parts = str.split(':').map(Number);
  if (!str || parts.some(isNaN)) return null;
  if (parts.length > 3 || parts.some((v) => v < 0)) return null;
  const ms = parts.reduce((acc, v) => acc * 60 + v, 0) * 1000;
  return ms > 0 ? ms : null;
};

let audio;
/** volume 0–1 (Settings → 타이머 소리). */
function beep(volume = 0.6) {
  if (!(volume > 0)) return;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const d of [0, 0.18, 0.36]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.42 * volume, t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.14);
      o.connect(g).connect(audio.destination);
      o.start(t + d);
      o.stop(t + d + 0.16);
    }
  } catch {}
}

export default {
  title: 'Timer',
  size: { w: 3, h: 2 },
  min: { w: 2, h: 2 },
  defaults: { duration: 300000, remaining: 300000, endAt: null },
  css: `
    .timer { height: 100%; box-sizing: border-box; padding: calc(var(--head-h) - 6px) var(--pad) var(--pad);
      display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 7cqh; }
    .t-display { font-size: min(calc(108cqw / var(--len, 5)), 34cqh); white-space: nowrap; font-weight: 600; line-height: 1;
      font-variant-numeric: tabular-nums; cursor: text; }
    .t-display input { width: 5.5ch; font: inherit; text-align: center; background: none;
      border: 0; border-bottom: 2px solid var(--c2); outline: none; }
    .t-presets, .t-ctrl { display: flex; gap: 6px; max-width: 100%; flex: none; }
    .t-presets { overflow-x: auto; scrollbar-width: none; justify-content: safe center; }
    .t-presets button { font-size: .85em; padding: 1px 8px; white-space: nowrap; flex: none; }
    .t-ctrl button { white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .t-ctrl .ico { display: none; }
    @container (max-width: 12em) { .t-ctrl .ico { display: inline; } .t-ctrl .lbl { display: none; } }
    .timer.running .t-presets { visibility: hidden; }
    .timer.ringing .t-display { color: var(--c2); animation: t-blink .7s steps(2) infinite; }
    body.reduce-motion .timer.ringing .t-display { text-decoration: underline; text-decoration-thickness: 3px; }
    @keyframes t-blink { 50% { opacity: .3; } }
    .t-cap { font-size: .85em; font-weight: 600; padding: 2px 10px; border-radius: 999px; flex: none; max-width: 100%;
      background: var(--c2); color: var(--on-accent, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* em-based, so larger text hides extras sooner instead of overflowing */
    @container (max-height: 10.5em) { .t-presets { display: none; } }
    @container (max-height: 5.5em) { .t-ctrl { display: none; } }
  `,
  mount(root, s, api) {
    const { t } = api;
    root.innerHTML = `
      <div class="timer">
        <div class="t-display" title="${t('timer.hint')}"></div>
        <div class="t-presets"></div>
        <div class="t-cap" role="status" hidden></div>
        <div class="t-ctrl"><button class="primary" data-a="go"></button><button data-a="reset" title="${t('timer.reset')}"><span class="ico">↺</span><span class="lbl">${t('timer.reset')}</span></button></div>
      </div>`;
    const box = root.firstElementChild;
    const disp = box.querySelector('.t-display');
    const go = box.querySelector('[data-a=go]');
    let tick, ringTimer, editing = false;
    const ui = () => api.config?.ui ?? {};
    const volume = () => (ui().timerSound === false ? 0 : Math.min(Math.max((ui().timerVolume ?? 60) / 100, 0), 1));
    const rings = () => Math.min(Math.max(ui().timerRings ?? 10, 1), 60);

    // repair odd saved values (hand-edited layout.json etc.)
    const num = (v, d) => (Number.isFinite(+v) && +v >= 0 ? +v : d);
    s.duration = Math.min(num(s.duration, 300000) || 300000, 99 * 3600000);
    s.remaining = Math.min(num(s.remaining, s.duration), s.duration);
    s.endAt = s.endAt ? num(s.endAt, null) : null;
    const left = () => (s.endAt ? Math.max(0, s.endAt - Date.now()) : s.remaining);
    function render() {
      if (!editing) {
        disp.textContent = fmt(left());
        disp.style.setProperty('--len', Math.max(5, disp.textContent.length));
      }
      const k = s.endAt ? 'timer.pause' : s.remaining > 0 && s.remaining < s.duration ? 'timer.resume' : 'timer.start';
      go.innerHTML = `<span class="ico">${s.endAt ? '❚❚' : '▶'}</span><span class="lbl">${t(k)}</span>`;
      go.title = t(k);
      box.classList.toggle('running', !!s.endAt);
    }
    function run() {
      clearInterval(tick);
      if (!s.endAt) return;
      tick = setInterval(() => (left() <= 0 ? finish(true) : render()), 250);
    }
    function finish(sound) {
      clearInterval(tick);
      s.endAt = null;
      s.remaining = 0;
      api.save();
      render();
      box.classList.add('ringing');
      if (sound) {
        api.alert?.(t('timer.done'), fmt(s.duration));
        const ring = (n) => {
          beep(volume());
          caption(n);
        };
        let n = 0;
        ring(1);
        ringTimer = setInterval(() => (++n >= rings() ? stopRing() : ring(n + 1)), 1500);
      }
    }
    // Sound captions (Settings → 청각): say on screen what the speaker is doing
    const cap = box.querySelector('.t-cap');
    function caption(n) {
      if (!ui().soundCaptions) return (cap.hidden = true);
      cap.textContent = volume() ? t('timer.caption', { n, total: rings() }) : t('timer.caption_muted');
      cap.hidden = false;
    }
    function stopRing() {
      clearInterval(ringTimer);
      box.classList.remove('ringing');
      cap.hidden = true;
    }
    function start() {
      audio ??= new AudioContext(); // unlock audio during the click
      audio.resume?.();
      if (s.remaining <= 0) s.remaining = s.duration;
      s.endAt = Date.now() + s.remaining;
      api.save();
      run();
      render();
    }
    function pause() {
      s.remaining = left();
      s.endAt = null;
      clearInterval(tick);
      api.save();
      render();
    }
    function setDuration(ms) {
      ms = Math.min(Math.max(ms, 1000), 99 * 3600000);
      stopRing();
      clearInterval(tick);
      Object.assign(s, { duration: ms, remaining: ms, endAt: null });
      api.save();
      render();
    }

    box.addEventListener('pointerdown', stopRing);
    go.onclick = () => (s.endAt ? pause() : start());
    box.querySelector('[data-a=reset]').onclick = () => setDuration(s.duration);
    // Presets come from config.json (timer.presets: [{ label, time }]); label may be empty.
    const DEFAULT_PRESETS = [{ time: '1' }, { time: '5' }, { time: '10' }, { time: '25' }];
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    function renderPresets() {
      const list = api.config?.timer?.presets;
      box.querySelector('.t-presets').innerHTML = (Array.isArray(list) ? list : DEFAULT_PRESETS)
        .map((p) => {
          const ms = parse(String(p?.time ?? ''));
          if (!ms) return '';
          const label = p.label || (ms % 60000 === 0 ? t('timer.min', { n: ms / 60000 }) : fmt(ms));
          return `<button data-ms="${ms}">${esc(label)}</button>`;
        })
        .join('');
    }
    renderPresets();
    api.onConfig(renderPresets);
    api.wheelScrollX?.(box.querySelector('.t-presets'));
    box.querySelector('.t-presets').onclick = (e) => {
      const ms = +e.target.closest('button')?.dataset.ms;
      if (ms) setDuration(ms);
    };
    disp.addEventListener('wheel', (e) => {
      if (s.endAt) return;
      e.preventDefault();
      setDuration(Math.round(s.duration / 60000) * 60000 + (e.deltaY < 0 ? 60000 : -60000));
    });
    disp.addEventListener('click', () => {
      if (s.endAt || editing) return;
      editing = true;
      disp.innerHTML = `<input value="${fmt(s.remaining || s.duration)}">`;
      const inp = disp.firstChild;
      inp.focus();
      inp.select();
      const done = (commit) => {
        if (!editing) return;
        editing = false;
        const ms = commit ? parse(inp.value) : null;
        ms ? setDuration(ms) : render();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      });
      inp.addEventListener('blur', () => done(true));
    });

    // Finished while the app was closed/asleep: show it, no sound.
    if (s.endAt && s.endAt <= Date.now()) finish(false);
    run();
    render();
    return {
      destroy() { clearInterval(tick); clearInterval(ringTimer); },
      summary: () =>
        s.endAt ? t('sum.timer_running', { left: fmt(left()) })
        : box.classList.contains('ringing') || s.remaining === 0 ? t('sum.timer_done')
        : s.remaining < s.duration ? t('sum.timer_paused', { left: fmt(s.remaining) })
        : t('sum.timer_idle', { dur: fmt(s.duration) }),
    };
  },
};
