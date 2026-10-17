// Now Playing: whatever Windows' media controls report (YouTube in Chrome/Edge/Whale/Firefox, Spotify,
// the Media Player app...). Title, channel/artist, artwork, progress, and prev / play-pause / next. Click the bar to jump.
// The cycle button switches between sources when several are open (e.g. a YouTube tab and Spotify).
// "My files" plays the user's own audio in a hidden <audio>. WebView2 registers it with Windows like any other
// player, so it comes back through the same media payload; the widget never draws a second display.
import { icon } from "../icons.js";
import { esc, dropZone } from "../util.js";

const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus", "webm"]);
function isAudioFile(file) {
  if (file.type && file.type.startsWith("audio/")) return true;
  const ext = (file.name || "").split(".").pop().toLowerCase();
  return AUDIO_EXT.has(ext);
}
// navigator.mediaSession is one per page; only the widget whose audio last played owns its handlers
let owner = null;

const p2 = (n) => String(n).padStart(2, "0");
const clock = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    x = sec % 60;
  return h ? `${h}:${p2(m)}:${p2(x)}` : `${m}:${p2(x)}`;
};
function sourceName(id) {
  const s = String(id || "").toLowerCase();
  const known = [
    ["chrome", "Chrome"],
    ["msedge", "Edge"],
    ["whale", "Whale"],
    ["firefox", "Firefox"],
    ["opera", "Opera"],
    ["brave", "Brave"],
    ["spotify", "Spotify"],
    ["zunemusic", "Media Player"],
    ["vlc", "VLC"],
    ["melon", "Melon"],
    ["genie", "genie"],
    ["bugs", "Bugs"],
    ["flo", "FLO"],
    ["youtube", "YouTube"],
  ];
  const hit = known.find(([k]) => s.includes(k));
  if (hit) return hit[1];
  return (
    String(id || "")
      .split(/[\\\\/!]/)
      .pop() || ""
  ).replace(/\.exe$/i, "");
}


// Short widget: one line. Also used while the file list is open (it takes the lower part).
const compact = (p) => `
    ${p} .np { padding-top: 8px; gap: var(--space-4); }
    ${p} .np-prog, ${p} .np-sub, ${p} .np-ctrl [data-a=cycle] { display: none; }
    ${p} .np-info { flex-direction: row; align-items: center; gap: var(--space-3); }
    ${p} .np-title { flex: 1; min-width: 4em; -webkit-line-clamp: 2; font-size: var(--fs-small); }
    ${p} .np-ctrl button { padding: 0 6px; }`;

export default {
  size: { w: 4, h: 2 },
  min: { w: 3, h: 1 },
  defaults: {
    tracks: [], // [{file:"hash.mp3", label:"name"}, ...]
    current: 0,
    volume: 0.8,
    shuffle: false,
    loop: "all", // "off" | "all" | "one"
    frameless: false,
    list: false, // "My files" panel open
  },
  css: `
    .npw { position: absolute; inset: 0; display: flex; flex-direction: column; }
    .np { position: relative; flex: 1; min-height: 0; display: flex; gap: var(--space-4); align-items: center; box-sizing: border-box;
      padding: calc(var(--head-h) - 2px) calc(var(--pad) + 2px) var(--pad); overflow: hidden; }
    .np-bg { position: absolute; inset: -20px; background-size: cover; background-position: center;
      filter: blur(18px) saturate(1.3); opacity: .35; pointer-events: none; }
    .np-art { position: relative; flex: none; height: 100%; max-width: 45%; aspect-ratio: var(--ar, 1);
      border-radius: calc(var(--radius) * .5); overflow: hidden; background: color-mix(in srgb, var(--c3) 10%, transparent);
      display: grid; place-items: center; font-size: 1.6em; }
    .np-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .np-info { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); justify-content: center; }
    .np-title { font-weight: 600; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .np-sub { font-size: var(--fs-meta); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .np-prog { display: flex; align-items: center; gap: var(--space-3); font-size: var(--fs-meta); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .np-bar { flex: 1; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--c3) 18%, transparent);
      position: relative; cursor: pointer; }
    .np-bar::before { content: ""; position: absolute; inset: -6px 0; } /* bigger click target */
    .np-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 2px; background: var(--c2); }
    .np-bar.noseek { cursor: default; }
    .np-ctrl { display: flex; gap: var(--space-2); align-items: center; }
    .np-ctrl button { padding: 0 9px; line-height: 1.6; }
    .np-ctrl button:disabled { opacity: .3; cursor: default; }
    .np-ctrl [data-a=playpause] { background: var(--c2); border-color: var(--c2); color: var(--on-accent); }
    .np-ctrl [data-a=cycle], .np-ctrl [data-a=files] { font-size: var(--fs-meta); color: var(--text-muted); }
    .np-ctrl [data-a=files] { margin-left: auto; }
    .np-ctrl [data-a=files] + [data-a=cycle] { margin-left: 0; }
    .np-ctrl .active, .npf-head .active { background: color-mix(in srgb, var(--c2) 25%, transparent); }
    .np-empty { position: relative; flex: 1; text-align: center; color: var(--text-faint); font-size: var(--fs-small); }
    .np-empty small { display: block; margin-top: 2px; }
    .np-empty-act { display: flex; justify-content: center; gap: var(--space-2); margin-top: 6px; }
    .np-empty-act button { padding: 0 9px; line-height: 1.6; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* My files panel */
    .np-files { flex: 1; min-height: 0; display: flex; flex-direction: column; box-sizing: border-box;
      padding: 0 calc(var(--pad) + 2px) var(--pad); font-size: var(--fs-small);
      border-top: 1px solid color-mix(in srgb, var(--c3) 15%, transparent); }
    .np-files[hidden] { display: none; }
    .npf-head { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); padding: 4px 0; }
    .npf-title { flex: 1; min-width: 3em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .npf-head button { padding: 0 7px; line-height: 1.6; min-width: 0; font-size: var(--fs-small); }
    .npf-head button:disabled { opacity: .3; cursor: default; }
    .npf-tp { display: none; gap: var(--space-2); }
    .npf-vol { flex: none; width: 4em; accent-color: var(--c2); }
    .npf-list { flex: 1; overflow-y: auto; min-height: 0; }
    .npf-none { display: grid; place-items: center; height: 100%; text-align: center; cursor: pointer;
      color: var(--text-faint); }
    .npf-none small { display: block; margin-top: 2px; }
    .np-track { display: flex; align-items: center; gap: var(--space-2); padding: 2px 4px;
      border-radius: var(--r-inner); cursor: pointer; line-height: 1.4; }
    .np-track:hover { background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .np-track.playing { color: var(--c2); font-weight: 600; }
    .np-track .idx { color: var(--text-faint); font-size: var(--fs-meta); min-width: 1.4em; text-align: right; }
    .np-track .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .np-track .del { opacity: 0; padding: 0 4px; font-size: var(--fs-meta); }
    .np-track:hover .del { opacity: .5; }
    .np-track .del:hover { opacity: 1; color: var(--danger, #c00); }

    @container (max-height: 7.5em) { ${compact("")} }
    @container (max-height: 7.5em) and (max-width: 20em) { .np-ctrl [data-a=prev] { display: none; } }
    /* file list open: the main view shrinks to one line */
    .npw.list .np { flex: 0 0 4.5em; }
    ${compact(".npw.list")}
    @container (max-width: 20em) { .npw.list .np-ctrl [data-a=prev] { display: none; } }
    /* ...or goes away when the widget is short; the panel header then carries prev / play / next */
    @container (max-height: 8em) {
      .npw.list .np { display: none; }
      .npw.list .npf-tp { display: flex; }
    }
    /* tall and narrow: artwork on top */
    @container (min-height: 15em) and (max-width: 24em) {
      .npw:not(.list) .np { flex-direction: column; align-items: stretch; }
      .npw:not(.list) .np-art { height: auto; width: 100%; max-width: none; max-height: 55%; }
      .npw:not(.list) .np-info { flex: none; }
    }
  `,
  mount(root, s, api) {
    const { t } = api;
    // saved by older versions: Now Playing as {}, Audio Player without some keys
    s.tracks = (Array.isArray(s.tracks) ? s.tracks : []).filter((x) => x && typeof x.file === "string" && x.file);
    if (!(Number.isInteger(s.current) && s.current >= 0 && s.current < s.tracks.length)) s.current = 0;
    if (!(typeof s.volume === "number" && s.volume >= 0 && s.volume <= 1)) s.volume = 0.8;
    s.shuffle = !!s.shuffle;
    if (!["off", "all", "one"].includes(s.loop)) s.loop = "all";
    s.frameless = !!s.frameless;
    s.list = !!s.list;
    api.setFrameless(s.frameless);

    root.innerHTML = `<div class="npw"><div class="np"></div><div class="np-files"></div></div>`;
    const wrap = root.firstElementChild;
    const box = wrap.querySelector(".np");
    const files = wrap.querySelector(".np-files");
    let m = { has: false };
    let receivedAt = Date.now();
    let tick = null;

    // -- own files: a hidden <audio>, shown to Windows (and back to this widget) as a media session --
    const me = {};
    const audio = new Audio();
    audio.volume = s.volume;
    let loaded = false; // audio has a track (its src is reset on stop, so it is not read back)
    const ms = navigator.mediaSession;

    function describe() {
      const tr = s.tracks[s.current];
      if (owner !== me || !ms || !tr) return;
      try { ms.metadata = new MediaMetadata({ title: tr.label || t("ap.untitled"), artist: "WidgetBoard" }); } catch {}
    }
    function report() {
      if (owner !== me || !ms || !Number.isFinite(audio.duration) || !audio.duration) return;
      try {
        ms.setPositionState({
          duration: audio.duration,
          position: Math.min(Math.max(audio.currentTime, 0), audio.duration),
          playbackRate: audio.playbackRate || 1,
        });
      } catch {}
    }
    function claim() {
      if (!ms || owner === me) return;
      owner = me;
      const handlers = {
        play: () => audio.play().catch(() => {}),
        pause: () => audio.pause(),
        previoustrack: () => play(s.current - 1),
        nexttrack: () => next(),
        seekto: (d) => { if (Number.isFinite(d?.seekTime)) { audio.currentTime = d.seekTime; report(); } },
      };
      for (const [k, f] of Object.entries(handlers)) try { ms.setActionHandler(k, f); } catch {}
      describe();
    }
    function release() {
      if (!ms || owner !== me) return;
      owner = null;
      for (const k of ["play", "pause", "previoustrack", "nexttrack", "seekto"]) try { ms.setActionHandler(k, null); } catch {}
      try { ms.metadata = null; } catch {}
    }
    function stop() {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      loaded = false;
    }

    function play(idx) {
      if (!s.tracks.length) return;
      idx = ((idx % s.tracks.length) + s.tracks.length) % s.tracks.length;
      s.current = idx;
      audio.src = api.assetUrl(s.tracks[idx].file);
      loaded = true;
      audio.play().catch(() => {});
      describe();
      api.save();
      buildFiles();
    }
    function next() {
      if (!s.tracks.length) return;
      if (s.shuffle) {
        let r;
        do { r = Math.floor(Math.random() * s.tracks.length); } while (r === s.current && s.tracks.length > 1);
        play(r);
      } else play(s.current + 1);
    }
    audio.addEventListener("ended", () => {
      if (s.loop === "one") { audio.currentTime = 0; audio.play().catch(() => {}); }
      else if (s.loop === "all") next();
      else if (s.current < s.tracks.length - 1) next();
      // "off" at the last track: stop
    });
    audio.addEventListener("play", () => { claim(); report(); });
    for (const ev of ["pause", "loadedmetadata", "seeked"]) audio.addEventListener(ev, report);

    // -- add files (own picker: the global one is image-only) --
    const filePicker = document.createElement("input");
    filePicker.type = "file";
    filePicker.accept = "audio/*";
    filePicker.multiple = true;
    filePicker.hidden = true;
    wrap.append(filePicker);

    async function addFiles(list) {
      const audios = [...list].filter(isAudioFile);
      if (!audios.length) return list.length && api.toast(t("ap.not_audio"));
      for (const f of audios) {
        try {
          const name = await api.uploadImage(f, "ap.too_big"); // save_asset works for any file
          const label = f.name.replace(/\.[^.]+$/, "");
          if (!s.tracks.some((tr) => tr.file === name)) s.tracks.push({ file: name, label });
        } catch {}
      }
      api.save();
      buildFiles();
      build();
      if (!loaded && !m.has && s.tracks.length) play(s.current); // start only when nothing else plays
    }
    const chooser = () => {
      filePicker.value = "";
      filePicker.onchange = () => addFiles(filePicker.files);
      filePicker.click();
    };
    dropZone(root, t("w.drop"), addFiles);

    // -- "My files" panel --
    const loopIcon = () => icon(s.loop === "one" ? "repeat-one" : s.loop === "all" ? "repeat" : "repeat-off");
    function buildFiles() {
      wrap.classList.toggle("list", s.list);
      files.hidden = !s.list;
      if (!s.list) return;
      files.innerHTML = `
        <div class="npf-head">
          <span class="npf-title">${t("np.files")}</span>
          <span class="npf-tp"></span>
          <input type="range" class="npf-vol" min="0" max="1" step="0.05" value="${s.volume}"
            title="${t("ap.volume")}" aria-label="${t("ap.volume")}">
          <button data-a="shuf" class="${s.shuffle ? "active" : ""}" title="${t("ap.shuffle")}">${icon("shuffle")}</button>
          <button data-a="loop" title="${t("ap.loop")}">${loopIcon()}</button>
          <button data-a="add" title="${t("ap.add")}">${icon("plus")}</button>
          <button data-a="files" title="${t("np.files")}">${icon("x")}</button>
        </div>
        <div class="npf-list">${
          s.tracks.length
            ? s.tracks.map((tr, i) => `
          <div class="np-track ${loaded && i === s.current ? "playing" : ""}" data-i="${i}">
            <span class="idx">${i + 1}</span>
            <span class="name">${esc(tr.label || "?")}</span>
            <button class="del" data-del="${i}" title="${esc(t("ap.delete", { name: tr.label || i + 1 }))}">${icon("x")}</button>
          </div>`).join("")
            : `<div class="npf-none" data-a="add"><div>${icon("music")} ${t("ap.empty")}<small>${t("ap.hint")}</small></div></div>`
        }</div>`;
      syncTp();
    }
    // prev / play / next in the panel header (shown when the widget is too short for the main view)
    function syncTp() {
      const tp = files.querySelector(".npf-tp");
      if (!tp) return;
      tp.innerHTML = `
        <button data-a="prev" title="${t("np.prev")}" ${m.has && m.canPrev ? "" : "disabled"}>${icon("prev")}</button>
        <button data-a="playpause" title="${t(m.status === "playing" ? "np.pause" : "np.play")}" ${m.has && m.canPlayPause ? "" : "disabled"}>${icon(m.status === "playing" ? "pause" : "play")}</button>
        <button data-a="next" title="${t("np.next")}" ${m.has && m.canNext ? "" : "disabled"}>${icon("next")}</button>`;
    }

    const position = () => {
      if (!m.duration) return 0;
      let p = m.position || 0;
      if (m.status === "playing") {
        // the player reports position "as of" updatedAt; extrapolate from there
        const base =
          m.updatedAt > 0 && m.updatedAt <= Date.now() + 2000
            ? m.updatedAt
            : receivedAt;
        p += (Date.now() - base) / 1000;
      }
      return Math.min(Math.max(p, 0), m.duration);
    };

    function build() {
      clearInterval(tick);
      syncTp();
      if (!m.has) {
        const act = s.list
          ? ""
          : `<div class="np-empty-act">
              ${s.tracks.length ? `<button data-a="own" title="${t("ap.play")}">${icon("play")} ${esc(s.tracks[s.current]?.label || t("ap.untitled"))}</button>` : ""}
              <button data-a="files" title="${t("np.files")}">${icon("list")}</button>
            </div>`;
        box.innerHTML = `<div class="np-empty">${icon("music")} ${t("np.none")}<small>${t(m.unsupported ? "np.unsupported" : "np.hint")}</small>${act}</div>`;
        return;
      }
      const src = sourceName(m.source);
      const sub = [m.artist, src].filter(Boolean).join(" · ");
      box.innerHTML = `
        ${m.thumb ? `<div class="np-bg"></div>` : ""}
        <div class="np-art">${m.thumb ? `<img alt="">` : icon("music")}</div>
        <div class="np-info">
          <div class="np-title"></div>
          <div class="np-sub"></div>
          ${m.duration ? `<div class="np-prog"><span class="np-cur"></span><div class="np-bar ${m.canSeek ? "" : "noseek"}"><i></i></div><span>${clock(m.duration)}</span></div>` : ""}
          <div class="np-ctrl">
            <button data-a="prev" title="${t("np.prev")}" ${m.canPrev ? "" : "disabled"}>${icon("prev")}</button>
            <button data-a="playpause" title="${t(m.status === "playing" ? "np.pause" : "np.play")}" ${m.canPlayPause ? "" : "disabled"}>${icon(m.status === "playing" ? "pause" : "play")}</button>
            <button data-a="next" title="${t("np.next")}" ${m.canNext ? "" : "disabled"}>${icon("next")}</button>
            <button data-a="files" class="${s.list ? "active" : ""}" title="${t("np.files")}">${icon("list")}</button>
            ${m.sessions > 1 ? `<button data-a="cycle" title="${t("np.cycle", { n: m.sessions })}">${icon("cycle")} ${m.sessions}</button>` : ""}
          </div>
        </div>`;
      const title = box.querySelector(".np-title");
      title.textContent = m.title || t("np.untitled");
      title.title = [m.title, m.artist, m.album, src]
        .filter(Boolean)
        .join("\n");
      box.querySelector(".np-sub").textContent = sub;
      if (m.thumb) {
        const img = box.querySelector(".np-art img");
        img.onload = () => {
          // keep the artwork's own shape (square album art, 16:9 video thumbnails)
          const ar = img.naturalWidth / img.naturalHeight;
          box
            .querySelector(".np-art")
            .style.setProperty("--ar", Math.min(Math.max(ar || 1, 1), 16 / 9));
        };
        img.src = m.thumb;
        box.querySelector(".np-bg").style.backgroundImage = `url("${m.thumb}")`;
      }
      progress();
      if (m.status === "playing" && m.duration)
        tick = setInterval(progress, 500);
    }
    function progress() {
      const cur = box.querySelector(".np-cur");
      if (!cur) return;
      const p = position();
      cur.textContent = clock(p);
      box.querySelector(".np-bar i").style.width = `${(p / m.duration) * 100}%`;
    }

    wrap.addEventListener("input", (e) => {
      if (e.target.matches(".npf-vol")) audio.volume = s.volume = +e.target.value;
    });
    wrap.addEventListener("change", (e) => {
      if (e.target.matches(".npf-vol")) api.save();
    });

    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-a]");
      const a = btn?.dataset.a;
      if (a && ["prev", "playpause", "next", "cycle"].includes(a)) {
        if (btn.disabled) return;
        api.media.control(a);
        if (a === "playpause") {
          // answer immediately; the real state arrives a moment later
          m = {
            ...m,
            position: position(),
            updatedAt: Date.now(),
            status: m.status === "playing" ? "paused" : "playing",
          };
          receivedAt = Date.now();
          build();
        }
        return;
      }
      if (a === "files") { s.list = !s.list; api.save(); buildFiles(); build(); return; }
      if (a === "own") { play(s.current); return; }
      if (a === "add") { chooser(); return; }
      if (a === "shuf") { s.shuffle = !s.shuffle; api.save(); buildFiles(); return; }
      if (a === "loop") {
        s.loop = s.loop === "off" ? "all" : s.loop === "all" ? "one" : "off";
        api.save(); buildFiles(); return;
      }

      // delete track
      const del = e.target.closest("[data-del]");
      if (del) {
        const di = +del.dataset.del;
        const wasCurrent = di === s.current;
        const cur = s.tracks[s.current];
        const [gone] = s.tracks.splice(di, 1);
        // keep "now playing" on the same track when one above it goes
        s.current = wasCurrent ? Math.min(s.current, Math.max(0, s.tracks.length - 1)) : s.tracks.indexOf(cur);
        if (wasCurrent) stop();
        api.save(); buildFiles(); build();
        api.deleted(() => {
          const now = s.tracks[s.current];
          s.tracks.splice(Math.min(di, s.tracks.length), 0, gone);
          s.current = Math.max(0, s.tracks.indexOf(now));
          api.save(); buildFiles(); build();
        });
        return;
      }

      // click track to play
      const row = e.target.closest(".np-track");
      if (row) { play(+row.dataset.i); return; }

      // seek bar (the media session's seekto handler moves our own audio)
      const bar = e.target.closest(".np-bar");
      if (bar && m.canSeek && m.duration) {
        const r = bar.getBoundingClientRect();
        const sec = ((e.clientX - r.left) / r.width) * m.duration;
        api.media.control("seek", sec);
        m = { ...m, position: sec, updatedAt: Date.now() };
        receivedAt = Date.now();
        progress();
      }
    });

    const update = (v) => {
      m = v && typeof v === "object" ? v : { has: false };
      receivedAt = Date.now();
      build();
    };
    api.on("media", update);
    api.media
      .subscribe()
      .then(update)
      .catch(() => update({ has: false, unsupported: true }));
    buildFiles();
    build();
    return {
      destroy: () => {
        clearInterval(tick);
        stop();
        release();
      },
      menu: () => [
        { text: t("ap.add"), action: chooser },
        { item: "Separator" },
        {
          text: (s.frameless ? "✓ " : "") + t("ap.frameless"),
          action: () => {
            s.frameless = !s.frameless;
            api.setFrameless(s.frameless);
            api.save();
          },
        },
      ],
      summary: () =>
        m.has
          ? [m.title, m.artist].filter(Boolean).join(" - ") +
            (m.status === "paused" ? ` (${t("sum.paused")})` : "")
          : t("sum.np_none"),
    };
  },
};
