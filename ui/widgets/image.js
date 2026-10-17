// Image widget with two layouts (s.layout): "slideshow" (below) or "grid" (collection.js).
// Slideshow: one picture = a plain image; several = a slideshow (crossfade, interval, shuffle).
// Hover for controls: ‹ ❚❚ › · 3/12 · ＋ add · 🗑 remove this one · 맞춤/채우기.
// "액자 없이" (frameless) hides the widget's background and outline, so a transparent PNG/WebP/GIF/SVG
// sits directly on the desktop.
import { icon } from "../icons.js";
import { dropZone } from "../util.js";
import { grid, gridCss } from "./collection.js";

const INTERVALS = [5, 10, 30, 60, 300, 1800];

const slideshowCss = `
    .imgw-host { position: absolute; inset: 0; }
    .imgw { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
    .imgw .slide { position: absolute; inset: 0; width: 100%; height: 100%; display: block; opacity: 0; transition: opacity .8s; }
    .imgw .slide.on { opacity: 1; }
    .imgw .empty { font-size: var(--fs-small); color: var(--text-muted); text-align: center; padding: 8px; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; gap: var(--space-2); overflow: hidden; max-height: 100%; box-sizing: border-box; }
    .imgw .empty .ico { font-size: 1.8em; line-height: 1; }
    @container (max-width: 9em) { .imgw .empty .txt { display: none; } }
    .imgw .tools { position: absolute; left: 6px; right: 6px; bottom: 6px; display: flex; gap: var(--space-2); justify-content: center;
      flex-wrap: wrap; opacity: 0; transition: opacity .15s; z-index: 2; }
    .widget:hover .imgw .tools { opacity: 1; }
    .imgw .tools button, .imgw .tools span { font-size: var(--fs-meta); padding: 1px 7px; white-space: nowrap;
      background: color-mix(in srgb, var(--c1) 75%, transparent); border-radius: 999px; }
    .imgw .tools span { border: var(--line-width) var(--line-style) var(--line-color); font-variant-numeric: tabular-nums; }
    @container (max-width: 13em) { .imgw .tools .opt { display: none; } }
    @container (max-width: 7em) { .imgw .tools { display: none; } }
  `;

function slideshow(root, s, api) {
  const { t } = api;
  if (!INTERVALS.includes(s.interval)) s.interval = 10;
  if (!(s.index >= 0 && s.index < s.imgs.length)) s.index = 0;
  api.setFrameless(s.frameless);

  const box = document.createElement("div");
  box.className = "imgw";
  root.append(box);
  const bad = new Set(); // files that failed to load
  let timer = null;
  let front = 0; // which of the two <img> layers is showing

  async function add(files) {
    const imgs = [...files].filter((f) => f && f.type.startsWith("image/"));
    if (!imgs.length) return files.length && api.toast(t("toast.not_image"));
    for (const f of imgs) {
      try {
        const name = await api.uploadImage(f);
        if (!s.imgs.includes(name)) s.imgs.push(name);
        bad.delete(name);
      } catch {}
    }
    if (s.imgs.length) s.index = s.imgs.length - 1; // show what was just added
    api.save();
    build();
  }
  const choose = async () => add(await api.pickImages());

  function build() {
    clearInterval(timer);
    const usable = s.imgs.filter((x) => !bad.has(x));
    if (!usable.length) {
      const missing = s.imgs.length > 0;
      box.innerHTML = `<div class="empty" title="${t(missing ? "image.missing" : "image.empty")}">
        <span class="ico">${icon(missing ? "alert" : "image")}</span><span class="txt">${t(missing ? "image.missing" : "image.empty")}</span></div>`;
      box.firstElementChild.onclick = choose;
      return;
    }
    const many = s.imgs.length > 1;
    box.innerHTML = `
      <img class="slide" draggable="false" alt=""><img class="slide" draggable="false" alt="">
      <div class="tools">
        ${
          many
            ? `<button data-a="prev" title="${t("image.prev")}">${icon("left")}</button>
        <button data-a="play" title="${t(s.playing ? "image.pause" : "image.play")}">${icon(s.playing ? "pause" : "play")}</button>
        <button data-a="next" title="${t("image.next")}">${icon("right")}</button>
        <span class="opt count"></span>`
            : ""
        }
        <button data-a="add" title="${t("image.add")}">${icon("plus")}</button>
        ${many ? `<button class="opt" data-a="del" title="${t("image.remove")}">${icon("trash")}</button>` : ""}
        <button class="opt" data-a="fit">${t(s.fit === "cover" ? "image.fit" : "image.fill")}</button>
      </div>`;
    for (const img of box.querySelectorAll(".slide")) {
      img.style.objectFit = s.fit;
      img.onerror = () => {
        const name = img.dataset.name;
        if (!name || bad.has(name)) return;
        bad.add(name);
        if (s.imgs.every((x) => bad.has(x))) return build();
        step(1);
      };
    }
    show(s.index, true);
    schedule();
  }

  function show(i, instant) {
    const n = s.imgs.length;
    if (!n) return;
    s.index = ((i % n) + n) % n;
    const layers = box.querySelectorAll(".slide");
    if (layers.length < 2) return;
    const next = instant ? layers[front] : layers[1 - front];
    next.dataset.name = s.imgs[s.index];
    const reveal = () => {
      layers.forEach((l) => l.classList.toggle("on", l === next));
      front = [...layers].indexOf(next);
    };
    const url = api.assetUrl(s.imgs[s.index]);
    if (next.getAttribute("src") === url && next.complete) reveal();
    else {
      next.onload = reveal;
      next.src = url;
    }
    const c = box.querySelector(".count");
    if (c) c.textContent = `${s.index + 1}/${n}`;
  }
  function step(dir) {
    const n = s.imgs.length;
    if (n < 2) return;
    let i = s.index + dir;
    if (s.shuffle && dir > 0) {
      do i = Math.floor(Math.random() * n);
      while (i === s.index);
    }
    for (let k = 0; k < n && bad.has(s.imgs[((i % n) + n) % n]); k++)
      i += dir || 1;
    show(i);
  }
  function schedule() {
    clearInterval(timer);
    if (s.playing && s.imgs.length > 1)
      timer = setInterval(
        () => !document.hidden && step(1),
        s.interval * 1000,
      );
  }

  box.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "prev" || a === "next") {
      step(a === "prev" ? -1 : 1);
      schedule(); // restart the countdown after a manual step
      api.save();
    }
    if (a === "play") {
      s.playing = !s.playing;
      api.save();
      build();
    }
    if (a === "add") choose();
    if (a === "del") {
      const i = s.index;
      const [gone] = s.imgs.splice(i, 1);
      s.index = Math.min(i, s.imgs.length - 1);
      api.save();
      build();
      api.deleted(() => {
        s.imgs.splice(Math.min(i, s.imgs.length), 0, gone);
        s.index = i;
        api.save();
        build();
      });
    }
    if (a === "fit") {
      s.fit = s.fit === "cover" ? "contain" : "cover";
      api.save();
      build();
    }
  });
  dropZone(box, t("w.drop"), add);

  const secs = (n) =>
    n < 60 ? t("image.sec", { n }) : t("image.min", { n: n / 60 });
  build();
  return {
    destroy: () => clearInterval(timer),
    summary: () =>
      s.imgs.length
        ? t("sum.image", {
            i: Math.min(s.index, s.imgs.length - 1) + 1,
            n: s.imgs.length,
          })
        : t("sum.image_empty"),
    menu: () => [
      { text: t("image.add_more"), action: choose },
      ...(s.imgs.length > 1
        ? [
            {
              text: t("image.interval"),
              items: INTERVALS.map((n) => ({
                text: (n === s.interval ? "✓ " : "") + secs(n),
                action: () => ((s.interval = n), api.save(), schedule()),
              })),
            },
            {
              text: (s.shuffle ? "✓ " : "") + t("image.shuffle"),
              action: () => ((s.shuffle = !s.shuffle), api.save()),
            },
          ]
        : []),
      {
        text: (s.frameless ? "✓ " : "") + t("image.frameless"),
        action: () => {
          s.frameless = !s.frameless;
          if (s.frameless) s.fit = "contain"; // show the whole transparent picture
          api.setFrameless(s.frameless);
          api.save();
          build();
        },
      },
      ...(s.imgs.length
        ? [
            {
              text: t("image.clear"),
              action: () => (
                (s.imgs = []),
                (s.index = 0),
                api.save(),
                build()
              ),
            },
          ]
        : []),
    ],
  };
}

// Bring older saved data to the current shape. True when something was converted (the caller saves once).
function normalize(s) {
  let changed = false;
  // single-image format of older versions
  if (!Array.isArray(s.imgs)) s.imgs = [];
  if (s.img && !s.imgs.length) s.imgs = [s.img];
  if ("img" in s) (delete s.img, (changed = true));
  s.imgs = s.imgs.filter((x) => typeof x === "string" && x);
  if (!s.labels || typeof s.labels !== "object" || Array.isArray(s.labels)) s.labels = {};
  // Collection widgets of older versions: items [{img, label}]
  const legacy = Array.isArray(s.items);
  if (legacy) {
    for (const it of s.items) {
      if (!it || typeof it.img !== "string" || !it.img) continue;
      if (!s.imgs.includes(it.img)) s.imgs.push(it.img);
      if (it.label && !s.labels[it.img]) s.labels[it.img] = String(it.label);
    }
    changed = true;
  }
  if ("items" in s) delete s.items;
  if (s.layout !== "grid" && s.layout !== "slideshow") s.layout = legacy ? "grid" : "slideshow";
  for (const k of Object.keys(s.labels)) if (!s.imgs.includes(k) || typeof s.labels[k] !== "string") delete s.labels[k];
  return changed;
}

export default {
  size: { w: 2, h: 2 },
  min: { w: 1, h: 1 },
  defaults: {
    imgs: [],
    labels: {}, // { 'hash.png': 'caption' }, grid only
    layout: "slideshow", // "slideshow" | "grid"
    columns: 0, // grid: 0 = auto
    fit: "cover",
    interval: 10,
    playing: true,
    shuffle: false,
    index: 0,
    frameless: false,
  },
  css: slideshowCss + gridCss,
  mount(root, s, api) {
    const { t } = api;
    if (normalize(s)) api.save();
    // each layout gets its own host element, so its listeners go away with it
    let host, inner;
    const start = () => {
      host = document.createElement("div");
      host.className = "imgw-host";
      root.append(host);
      inner = (s.layout === "grid" ? grid : slideshow)(host, s, api);
    };
    const switchTo = (layout) => {
      if (s.layout === layout) return;
      inner.destroy?.();
      host.remove();
      s.layout = layout;
      start();
      api.save();
    };
    start();
    return {
      destroy: () => inner.destroy?.(),
      resized: () => inner.resized?.(),
      summary: () => inner.summary(),
      menu: () => [
        {
          text: t("image.layout"),
          items: ["slideshow", "grid"].map((l) => ({
            text: (s.layout === l ? "✓ " : "") + t("image." + l),
            action: () => switchTo(l),
          })),
        },
        { item: "Separator" },
        ...inner.menu(),
      ],
    };
  },
};
