// Audio Player: local MP3/audio file player for voicelines, character songs, BGM.
// Stores tracks in the shared assets folder. Supports drag-and-drop, playlist,
// shuffle, loop, and frameless mode. Designed as a narrow companion strip.
import { esc } from '../util.js';

const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'webm']);
const p2 = (n) => String(n).padStart(2, '0');
const clock = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), x = sec % 60;
  return `${m}:${p2(x)}`;
};

function isAudioFile(file) {
  if (file.type && file.type.startsWith('audio/')) return true;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return AUDIO_EXT.has(ext);
}

export default {
  size: { w: 2, h: 2 },
  min: { w: 2, h: 1 },
  defaults: {
    tracks: [],   // [{file:'hash.mp3', label:'name'}, ...]
    current: 0,
    volume: 0.8,
    shuffle: false,
    loop: 'all',  // 'off' | 'all' | 'one'
    frameless: false,
  },
  css: `
    .ap { position: absolute; inset: 0; display: flex; flex-direction: column;
      box-sizing: border-box; padding: calc(var(--head-h) - 2px) var(--pad) var(--pad);
      overflow: hidden; font-size: .88em; }
    .ap-now { flex: none; display: flex; align-items: center; gap: 6px; min-height: 1.6em;
      margin-bottom: 4px; }
    .ap-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; font-weight: 600; line-height: 1.3; }
    .ap-time { font-size: .78em; opacity: .7; font-variant-numeric: tabular-nums; }

    .ap-bar { flex: none; height: 4px; border-radius: 2px;
      background: color-mix(in srgb, var(--c3) 18%, transparent);
      position: relative; cursor: pointer; margin-bottom: 6px; }
    .ap-bar::before { content: ""; position: absolute; inset: -6px 0; }
    .ap-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
      border-radius: 2px; background: var(--c2); transition: width .15s linear; }

    .ap-ctrl { flex: none; display: flex; align-items: center; justify-content: center; gap: 4px; }
    .ap-ctrl button { padding: 0 7px; line-height: 1.6; font-size: .85em; min-width: 0; }
    .ap-ctrl [data-a=play] { background: var(--c2); border-color: var(--c2);
      color: var(--on-accent); padding: 0 10px; }
    .ap-ctrl .active { background: color-mix(in srgb, var(--c2) 25%, transparent); }

    .ap-list { flex: 1; overflow-y: auto; min-height: 0; margin-top: 4px; }
    .ap-track { display: flex; align-items: center; gap: 4px; padding: 2px 4px;
      border-radius: 4px; cursor: pointer; line-height: 1.4; }
    .ap-track:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .ap-track.playing { color: var(--c2); font-weight: 600; }
    .ap-track .idx { opacity: .4; font-size: .8em; min-width: 1.4em; text-align: right; }
    .ap-track .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .ap-track .del { opacity: 0; padding: 0 4px; font-size: .8em; }
    .ap-track:hover .del { opacity: .5; }
    .ap-track .del:hover { opacity: 1; color: var(--danger, #c00); }

    .ap-empty { flex: 1; display: grid; place-items: center; text-align: center;
      opacity: .55; font-size: .85em; }
    .ap-empty small { display: block; margin-top: 2px; opacity: .8; }

    .ap-drop { position: absolute; inset: 0; background: color-mix(in srgb, var(--c2) 12%, var(--c1));
      display: grid; place-items: center; font-size: .9em; font-weight: 600;
      border: 2px dashed var(--c2); border-radius: var(--radius); z-index: 10; pointer-events: none; }

    /* compact: hide list */
    @container (max-height: 6em) {
      .ap-list { display: none; }
      .ap { padding-bottom: 6px; }
    }
    /* very compact: hide bar */
    @container (max-height: 4em) {
      .ap-bar { display: none; }
      .ap-now { margin-bottom: 0; }
    }
  `,
  mount(root, s, api) {
    const { t } = api;
    const audio = new Audio();
    audio.volume = s.volume;
    let tick = null;
    let dragCount = 0;

    // -- own file picker (the global one is image-only) --
    const filePicker = document.createElement('input');
    filePicker.type = 'file';
    filePicker.accept = 'audio/*';
    filePicker.multiple = true;
    filePicker.hidden = true;
    root.appendChild(filePicker);

    root.innerHTML += `<div class="ap"></div>`;
    const box = root.querySelector('.ap');

    // -- add files --
    async function addFiles(files) {
      const audios = [...files].filter(isAudioFile);
      if (!audios.length) return files.length && api.toast(t('ap.not_audio'));
      for (const f of audios) {
        try {
          const name = await api.uploadImage(f); // save_asset works for any file
          const label = f.name.replace(/\.[^.]+$/, '');
          if (!s.tracks.some((tr) => tr.file === name))
            s.tracks.push({ file: name, label });
        } catch {}
      }
      api.save();
      build();
      if (!audio.src && s.tracks.length) play(s.current);
    }

    const chooser = () => {
      filePicker.value = '';
      filePicker.onchange = () => addFiles(filePicker.files);
      filePicker.click();
    };

    // -- drag & drop --
    root.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    root.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragCount === 1) showDrop(true); });
    root.addEventListener('dragleave', () => { if (--dragCount <= 0) { dragCount = 0; showDrop(false); } });
    root.addEventListener('drop', (e) => { e.preventDefault(); dragCount = 0; showDrop(false); addFiles(e.dataTransfer.files); });

    function showDrop(on) {
      let el = root.querySelector('.ap-drop');
      if (on && !el) {
        el = document.createElement('div');
        el.className = 'ap-drop';
        el.textContent = t('ap.drop');
        root.appendChild(el);
      } else if (!on && el) el.remove();
    }

    // -- playback --
    function play(idx) {
      if (!s.tracks.length) return;
      idx = ((idx % s.tracks.length) + s.tracks.length) % s.tracks.length;
      s.current = idx;
      const tr = s.tracks[idx];
      audio.src = api.assetUrl(tr.file);
      audio.play().catch(() => {});
      api.save();
      build();
    }

    function next() {
      if (!s.tracks.length) return;
      if (s.shuffle) {
        let r;
        do { r = Math.floor(Math.random() * s.tracks.length); } while (r === s.current && s.tracks.length > 1);
        play(r);
      } else play(s.current + 1);
    }

    audio.addEventListener('ended', () => {
      if (s.loop === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); }
      else if (s.loop === 'all') next();
      else if (s.current < s.tracks.length - 1) next();
      // 'off' at last track → stop
    });

    // -- build UI --
    function build() {
      clearInterval(tick);
      const tr = s.tracks[s.current];

      if (!s.tracks.length) {
        box.innerHTML = `<div class="ap-empty">🎵 ${t('ap.empty')}<small>${t('ap.hint')}</small></div>`;
        box.querySelector('.ap-empty').addEventListener('click', chooser);
        return;
      }

      const loopIcon = s.loop === 'one' ? '🔂' : s.loop === 'all' ? '🔁' : '➡';
      box.innerHTML = `
        <div class="ap-now">
          <span class="ap-label">${esc(tr?.label || t('ap.untitled'))}</span>
          <span class="ap-time"></span>
        </div>
        <div class="ap-bar"><i></i></div>
        <div class="ap-ctrl">
          <button data-a="shuf" class="${s.shuffle ? 'active' : ''}" title="${t('ap.shuffle')}">🔀</button>
          <button data-a="prev" title="${t('ap.prev')}">⏮</button>
          <button data-a="play" title="${t('ap.play')}">▶</button>
          <button data-a="next" title="${t('ap.next')}">⏭</button>
          <button data-a="loop" title="${t('ap.loop')}">${loopIcon}</button>
          <button data-a="add" title="${t('ap.add')}">＋</button>
        </div>
        <div class="ap-list">
          ${s.tracks.map((t, i) => `
            <div class="ap-track ${i === s.current ? 'playing' : ''}" data-i="${i}">
              <span class="idx">${i + 1}</span>
              <span class="name">${esc(t.label || '?')}</span>
              <button class="del" data-del="${i}" title="×">×</button>
            </div>`).join('')}
        </div>`;

      updatePlayBtn();
      progress();
      if (!audio.paused) tick = setInterval(progress, 250);
    }

    function updatePlayBtn() {
      const btn = box.querySelector('[data-a=play]');
      if (btn) btn.textContent = audio.paused ? '▶' : '❚❚';
    }

    function progress() {
      const bar = box.querySelector('.ap-bar i');
      const time = box.querySelector('.ap-time');
      if (!bar) return;
      const dur = audio.duration || 0;
      const cur = audio.currentTime || 0;
      bar.style.width = dur ? `${(cur / dur) * 100}%` : '0';
      if (time) time.textContent = dur ? `${clock(cur)} / ${clock(dur)}` : '';
    }

    // -- events --
    audio.addEventListener('play', () => { clearInterval(tick); tick = setInterval(progress, 250); updatePlayBtn(); });
    audio.addEventListener('pause', () => { clearInterval(tick); progress(); updatePlayBtn(); });
    audio.addEventListener('loadedmetadata', progress);

    box.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'play') {
        if (!audio.src && s.tracks.length) play(s.current);
        else audio.paused ? audio.play().catch(() => {}) : audio.pause();
        return;
      }
      if (a === 'prev') { play(s.current - 1); return; }
      if (a === 'next') { next(); return; }
      if (a === 'shuf') { s.shuffle = !s.shuffle; api.save(); build(); return; }
      if (a === 'loop') {
        s.loop = s.loop === 'off' ? 'all' : s.loop === 'all' ? 'one' : 'off';
        api.save(); build(); return;
      }
      if (a === 'add') { chooser(); return; }

      // delete track
      const del = e.target.closest('[data-del]');
      if (del) {
        const di = +del.dataset.del;
        const wasPlaying = di === s.current && !audio.paused;
        s.tracks.splice(di, 1);
        if (s.current >= s.tracks.length) s.current = Math.max(0, s.tracks.length - 1);
        if (di === s.current || wasPlaying) { audio.pause(); audio.src = ''; }
        api.save(); build(); return;
      }

      // click track to play
      const tr = e.target.closest('.ap-track');
      if (tr && !e.target.closest('.del')) { play(+tr.dataset.i); return; }

      // seek bar
      const bar = e.target.closest('.ap-bar');
      if (bar && audio.duration) {
        const r = bar.getBoundingClientRect();
        audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
        progress();
      }
    });

    // frameless
    if (s.frameless) api.setFrameless(true);

    build();

    return {
      destroy: () => { clearInterval(tick); audio.pause(); audio.src = ''; },
      resized: () => {},
      menu: () => [
        { text: t('ap.add'), action: chooser },
        { item: 'Separator' },
        {
          text: (s.frameless ? '✓ ' : '') + t('ap.frameless'),
          action: () => {
            s.frameless = !s.frameless;
            api.setFrameless(s.frameless);
            api.save();
          },
        },
      ],
      summary: () => {
        if (!s.tracks.length) return t('sum.ap_empty');
        const tr = s.tracks[s.current];
        return (tr?.label || t('ap.untitled')) + (audio.paused ? '' : ' ▶');
      },
    };
  },
};