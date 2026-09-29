// Now Playing: whatever Windows' media controls report — YouTube in Chrome/Edge/Whale/Firefox, Spotify,
// the Media Player app… Title, channel/artist, artwork, progress, and ⏮ ⏯ ⏭. Click the bar to jump.
// ⇄ switches between sources when several are open (e.g. a YouTube tab and Spotify).
const p2 = (n) => String(n).padStart(2, '0');
const clock = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return h ? `${h}:${p2(m)}:${p2(x)}` : `${m}:${p2(x)}`;
};
function sourceName(id) {
  const s = String(id || '').toLowerCase();
  const known = [['chrome', 'Chrome'], ['msedge', 'Edge'], ['whale', 'Whale'], ['firefox', 'Firefox'], ['opera', 'Opera'],
    ['brave', 'Brave'], ['spotify', 'Spotify'], ['zunemusic', 'Media Player'], ['vlc', 'VLC'], ['melon', 'Melon'],
    ['genie', 'genie'], ['bugs', 'Bugs'], ['flo', 'FLO'], ['youtube', 'YouTube']];
  const hit = known.find(([k]) => s.includes(k));
  if (hit) return hit[1];
  return (String(id || '').split(/[\\\\/!]/).pop() || '').replace(/\.exe$/i, '');
}

export default {
  size: { w: 4, h: 2 },
  min: { w: 3, h: 1 },
  defaults: {},
  css: `
    .np { position: absolute; inset: 0; display: flex; gap: 10px; align-items: center; box-sizing: border-box;
      padding: calc(var(--head-h) - 2px) calc(var(--pad) + 2px) var(--pad); overflow: hidden; }
    .np-bg { position: absolute; inset: -20px; background-size: cover; background-position: center;
      filter: blur(18px) saturate(1.3); opacity: .35; pointer-events: none; }
    .np-art { position: relative; flex: none; height: 100%; max-width: 45%; aspect-ratio: var(--ar, 1);
      border-radius: calc(var(--radius) * .5); overflow: hidden; background: color-mix(in srgb, var(--c3) 10%, transparent);
      display: grid; place-items: center; font-size: 1.6em; }
    .np-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .np-info { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; justify-content: center; }
    .np-title { font-weight: 600; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .np-sub { font-size: .8em; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .np-prog { display: flex; align-items: center; gap: 6px; font-size: .72em; opacity: .85; font-variant-numeric: tabular-nums; }
    .np-bar { flex: 1; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--c3) 18%, transparent);
      position: relative; cursor: pointer; }
    .np-bar::before { content: ""; position: absolute; inset: -6px 0; } /* bigger click target */
    .np-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 2px; background: var(--c2); }
    .np-bar.noseek { cursor: default; }
    .np-ctrl { display: flex; gap: 4px; align-items: center; }
    .np-ctrl button { padding: 0 9px; line-height: 1.6; }
    .np-ctrl button:disabled { opacity: .3; cursor: default; }
    .np-ctrl [data-a=playpause] { background: var(--c2); border-color: var(--c2); color: var(--on-accent); }
    .np-ctrl [data-a=cycle] { margin-left: auto; font-size: .8em; opacity: .7; }
    .np-empty { position: relative; flex: 1; text-align: center; opacity: .6; font-size: .85em; }
    .np-empty small { display: block; opacity: .8; margin-top: 2px; }
    /* short widget: one line */
    @container (max-height: 7.5em) {
      .np { padding-top: 8px; gap: 8px; }
      .np-prog, .np-sub, .np-ctrl [data-a=cycle] { display: none; }
      .np-info { flex-direction: row; align-items: center; gap: 6px; }
      .np-title { flex: 1; min-width: 4em; -webkit-line-clamp: 2; font-size: .9em; }
      .np-ctrl button { padding: 0 6px; }
    }
    @container (max-height: 7.5em) and (max-width: 20em) { .np-ctrl [data-a=prev] { display: none; } }
    /* tall and narrow: artwork on top */
    @container (min-height: 15em) and (max-width: 24em) {
      .np { flex-direction: column; align-items: stretch; }
      .np-art { height: auto; width: 100%; max-width: none; max-height: 55%; }
      .np-info { flex: none; }
    }
  `,
  mount(root, s, api) {
    const { t } = api;
    root.innerHTML = `<div class="np"></div>`;
    const box = root.firstElementChild;
    let m = { has: false };
    let receivedAt = Date.now();
    let tick = null;

    const position = () => {
      if (!m.duration) return 0;
      let p = m.position || 0;
      if (m.status === 'playing') {
        // the player reports position "as of" updatedAt; extrapolate from there
        const base = m.updatedAt > 0 && m.updatedAt <= Date.now() + 2000 ? m.updatedAt : receivedAt;
        p += (Date.now() - base) / 1000;
      }
      return Math.min(Math.max(p, 0), m.duration);
    };

    function build() {
      clearInterval(tick);
      if (!m.has) {
        box.innerHTML = `<div class="np-empty">🎵 ${t('np.none')}<small>${t(m.unsupported ? 'np.unsupported' : 'np.hint')}</small></div>`;
        return;
      }
      const src = sourceName(m.source);
      const sub = [m.artist, src].filter(Boolean).join(' · ');
      box.innerHTML = `
        ${m.thumb ? `<div class="np-bg"></div>` : ''}
        <div class="np-art">${m.thumb ? `<img alt="">` : '🎵'}</div>
        <div class="np-info">
          <div class="np-title"></div>
          <div class="np-sub"></div>
          ${m.duration ? `<div class="np-prog"><span class="np-cur"></span><div class="np-bar ${m.canSeek ? '' : 'noseek'}"><i></i></div><span>${clock(m.duration)}</span></div>` : ''}
          <div class="np-ctrl">
            <button data-a="prev" title="${t('np.prev')}" ${m.canPrev ? '' : 'disabled'}>⏮</button>
            <button data-a="playpause" title="${t(m.status === 'playing' ? 'np.pause' : 'np.play')}" ${m.canPlayPause ? '' : 'disabled'}>${m.status === 'playing' ? '❚❚' : '▶'}</button>
            <button data-a="next" title="${t('np.next')}" ${m.canNext ? '' : 'disabled'}>⏭</button>
            ${m.sessions > 1 ? `<button data-a="cycle" title="${t('np.cycle', { n: m.sessions })}">⇄ ${m.sessions}</button>` : ''}
          </div>
        </div>`;
      const title = box.querySelector('.np-title');
      title.textContent = m.title || t('np.untitled');
      title.title = [m.title, m.artist, m.album, src].filter(Boolean).join('\n');
      box.querySelector('.np-sub').textContent = sub;
      if (m.thumb) {
        const img = box.querySelector('.np-art img');
        img.onload = () => {
          // keep the artwork's own shape (square album art, 16:9 video thumbnails)
          const ar = img.naturalWidth / img.naturalHeight;
          box.querySelector('.np-art').style.setProperty('--ar', Math.min(Math.max(ar || 1, 1), 16 / 9));
        };
        img.src = m.thumb;
        box.querySelector('.np-bg').style.backgroundImage = `url("${m.thumb}")`;
      }
      progress();
      if (m.status === 'playing' && m.duration) tick = setInterval(progress, 500);
    }
    function progress() {
      const cur = box.querySelector('.np-cur');
      if (!cur) return;
      const p = position();
      cur.textContent = clock(p);
      box.querySelector('.np-bar i').style.width = `${(p / m.duration) * 100}%`;
    }

    box.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a && !e.target.closest('button').disabled) {
        api.media.control(a);
        if (a === 'playpause') {
          // answer immediately; the real state arrives a moment later
          m = { ...m, position: position(), updatedAt: Date.now(), status: m.status === 'playing' ? 'paused' : 'playing' };
          receivedAt = Date.now();
          build();
        }
        return;
      }
      const bar = e.target.closest('.np-bar');
      if (bar && m.canSeek && m.duration) {
        const r = bar.getBoundingClientRect();
        const sec = ((e.clientX - r.left) / r.width) * m.duration;
        api.media.control('seek', sec);
        m = { ...m, position: sec, updatedAt: Date.now() };
        receivedAt = Date.now();
        progress();
      }
    });

    const update = (v) => {
      m = v && typeof v === 'object' ? v : { has: false };
      receivedAt = Date.now();
      build();
    };
    api.on('media', update);
    api.media.subscribe().then(update).catch(() => update({ has: false, unsupported: true }));
    build();
    return {
      destroy: () => clearInterval(tick),
      summary: () =>
        m.has
          ? [m.title, m.artist].filter(Boolean).join(' — ') + (m.status === 'paused' ? ` (${t('sum.paused')})` : '')
          : t('sum.np_none'),
    };
  },
};
