// Theme colours as a labelled swatch (palette.png) and as a text theme code.
// One row per target: the board first, then widgets, stacked downward. A row's position comes from its index in
// BLOCKS and a square's from its index in the row, so nothing ever moves: new widgets add rows at the bottom, new
// colours add squares at the right, and older or shorter sheets keep reading. The Basic template is the first
// BASIC rows; the Full template is all of them.
// The app reads the inside of each square only, so the labels in the margins never change the result.
// A checkerboard (or transparent) square is "not set" and falls through to the board. The sheet holds no opacity,
// so it survives JPEG recompression in chat apps; opacity lives in theme.txt.
import REGISTRY from "./widgets/index.js";

// APPEND ONLY. A row's index is its pixel address and its place in the theme code.
export const BLOCKS = [
  "board", "calendar", "memo", "checklist", "dday", "diary", "clock", "alarm",
  "timer", "stopwatch", "pomodoro", "image", "showcase", "nowplaying",
];
export const BASIC = 3; // board, calendar, memo
export const CAP = 16; // squares per row (fixed forever)

// Every row starts with these (append only). short = the label over the square; note = a circled column number over
// the square, explained in the legend (for colours a short word can't name).
const BASE = [
  { short: "pal.s.c1", v: "--c1" },
  { short: "pal.s.c2", v: "--c2" },
  { short: "pal.s.c3", v: "--c3" },
  { note: "pal.n.on_accent", v: "--on-accent" },
  { note: "pal.n.line", v: "--line-color" },
  { note: "pal.n.frame", v: "--frame-color" },
];
const BOARD_EXTRA = [
  { short: "pal.s.hol", v: "--hol" },
  { short: "pal.s.sat", v: "--sat" },
  { short: "pal.s.danger", v: "--danger" },
  { short: "pal.s.stamp", v: "--stamp-c", default: "#d8343a" },
];

/** A row's colours, in order: the base six, then its own (module.palette, append only). */
export const slotsOf = (block) => [...BASE, ...(block === "board" ? BOARD_EXTRA : (REGISTRY[block]?.palette ?? []))];

// Geometry v1, fixed forever. The reader scales by width only, since the height depends on the template.
const M = 20, NAME = 100, S = 40, PITCH = 48, LABEL = 18, ROWH = LABEL + S + 12, HEAD = 74;
const W = M * 2 + NAME + CAP * PITCH;
const heightFor = (rows) => HEAD + rows * ROWH + 6;
const INSET = 6; // ignore brush edges near the square's border
const CHECK = ["#d6d6d6", "#f2f2f2"], TILE = 10; // the "not set" fill

/** Every square: its row (block), column, the variable it sets, and where it is. */
export const SLOTS = BLOCKS.flatMap((block, r) =>
  slotsOf(block).map((s, i) => ({ block, i, ...s, x: M + NAME + i * PITCH, y: HEAD + r * ROWH + LABEL })),
);

async function strings(code) {
  const get = (n) => fetch(`locales/${code}/${n}.json`).then((r) => r.json()).catch(() => ({}));
  return Object.assign({}, ...(await Promise.all(["native", "widgets/calendar", "widgets/memo", "palette"].map(get))));
}
const circled = (n) => String.fromCharCode(0x2460 + n - 1); // 1 -> ①

/** Draw a sheet with its labels. colors: { board: { "--c1": "#rrggbb" }, ... }; rows: BASIC or BLOCKS.length. */
export async function drawSheet(colors = {}, rows = BLOCKS.length, code = "ko") {
  const L = await strings(code);
  const c = Object.assign(document.createElement("canvas"), { width: W, height: heightFor(rows) });
  const g = c.getContext("2d");
  // maxW: shrink (down to 9px) until the text fits
  const text = (s, x, y, px, bold, color, align = "left", maxW = Infinity) => {
    do g.font = `${bold ? "700 " : ""}${px}px "Malgun Gothic", "Segoe UI", sans-serif`;
    while (g.measureText(s).width > maxW && --px > 9);
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  };
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, c.height);

  text(L["pal.title"], M, 30, 18, true, "#222");
  text("v1", W - M, 30, 11, false, "#aaa", "right");
  // legend: every numbered square that is on this sheet, once
  const notes = new Map();
  for (const s of SLOTS) if (s.note && BLOCKS.indexOf(s.block) < rows) notes.set(s.i + 1, L[s.note]);
  text([...notes].map(([n, t]) => `${circled(n)} ${t}`).join("   ") + `   ·   ${L["pal.how"]}`, M, 56, 13, false, "#444", "left", W - M * 2);

  for (let r = 0; r < rows; r++) {
    const block = BLOCKS[r];
    text(L[block === "board" ? "pal.board" : `widget.${block}`], M, HEAD + r * ROWH + LABEL + S / 2 + 5, 14, true, "#222");
  }
  for (const s of SLOTS) {
    if (BLOCKS.indexOf(s.block) >= rows) continue;
    text(s.note ? circled(s.i + 1) : (L[s.short] ?? ""), s.x + S / 2, s.y - 5, 12, false, "#444", "center");
    const hex = colors[s.block]?.[s.v];
    if (hex) {
      g.fillStyle = hex;
      g.fillRect(s.x, s.y, S, S);
    } else
      for (let ty = 0; ty < S; ty += TILE)
        for (let tx = 0; tx < S; tx += TILE) {
          g.fillStyle = CHECK[((tx + ty) / TILE) % 2];
          g.fillRect(s.x + tx, s.y + ty, TILE, TILE);
        }
    g.strokeStyle = "#999";
    g.lineWidth = 1;
    g.strokeRect(s.x - 1.5, s.y - 1.5, S + 3, S + 3); // outside the square: never read
  }
  return c;
}

// ---- nine-slice skins (themes/<name>/skins/*.png): the image's outer thirds are the fixed corners ----
const SKIN = 300; // template size; any size works, the thirds are what count

/** skin-template.png: transparent, guide lines on the thirds and what each part does. Artists hide it and paint. */
export async function drawSkinTemplate(code = "ko") {
  const L = await strings(code);
  const c = Object.assign(document.createElement("canvas"), { width: SKIN, height: SKIN });
  const g = c.getContext("2d"), third = SKIN / 3;
  g.strokeStyle = "#00a8c8";
  g.setLineDash([6, 4]);
  g.lineWidth = 1;
  for (const p of [third, third * 2]) {
    g.strokeRect(p + 0.5, 0.5, 0, SKIN - 1);
    g.strokeRect(0.5, p + 0.5, SKIN - 1, 0);
  }
  g.setLineDash([]);
  g.strokeRect(0.5, 0.5, SKIN - 1, SKIN - 1);
  g.fillStyle = "#00a8c8";
  g.font = `12px "Malgun Gothic", "Segoe UI", sans-serif`;
  g.textAlign = "center";
  for (const [x, y, k] of [[0, 0, "fixed"], [2, 0, "fixed"], [0, 2, "fixed"], [2, 2, "fixed"], [1, 0, "stretch"],
    [1, 2, "stretch"], [0, 1, "stretch"], [2, 1, "stretch"], [1, 1, "middle"]])
    g.fillText(L[`pal.skin.${k}`], third * x + third / 2, third * y + third / 2 + 4);
  return c;
}

/** An example skin: a dark panel with a pink rim, readable with the default light text. */
export function drawSkinExample() {
  const c = Object.assign(document.createElement("canvas"), { width: SKIN, height: SKIN });
  const g = c.getContext("2d");
  g.beginPath();
  g.roundRect(12, 12, SKIN - 24, SKIN - 24, 56);
  g.fillStyle = "rgb(42 35 51 / 0.92)";
  g.fill();
  g.lineWidth = 14; // shown at about a quarter size, so draw it bold
  g.strokeStyle = "#e58fb5";
  g.stroke();
  return c;
}

const near = (d, o, hex, tol) =>
  Math.abs(d[o] - parseInt(hex.slice(1, 3), 16)) <= tol &&
  Math.abs(d[o + 1] - parseInt(hex.slice(3, 5), 16)) <= tol &&
  Math.abs(d[o + 2] - parseInt(hex.slice(5, 7), 16)) <= tol;
const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");

/** Read a sheet (ImageData, any width; PNG or recompressed JPEG) into { board: { "--c1": "#rrggbb" }, ... }.
 * Rows below the image's bottom edge (a Basic or older sheet) are simply not set.
 * A square is unset when it is mostly transparent, or when both checker greys still cover a fifth of it each.
 * So paint that covers most of a checker square wins, and a few strokes over the checker leave it unset. On purpose. */
export function readSheet(img) {
  const k = img.width / W, out = {}, d = img.data;
  for (const s of SLOTS) {
    if ((s.y + S) * k > img.height) continue;
    const buckets = new Map();
    let total = 0, clear = 0, dark = 0, light = 0;
    for (let py = Math.round((s.y + INSET) * k); py < (s.y + S - INSET) * k; py++)
      for (let px = Math.round((s.x + INSET) * k); px < (s.x + S - INSET) * k; px++) {
        const o = (py * img.width + px) * 4;
        total++;
        if (d[o + 3] < 128) { clear++; continue; }
        // the checkerboard is both greys together; one flat grey is a real colour
        if (near(d, o, CHECK[0], 10)) dark++;
        else if (near(d, o, CHECK[1], 10)) light++;
        // vote in coarse buckets (JPEG noise), then average the winning bucket (exact for flat fills)
        const b = ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3);
        const e = buckets.get(b) ?? buckets.set(b, [0, 0, 0, 0]).get(b);
        e[0] += d[o]; e[1] += d[o + 1]; e[2] += d[o + 2]; e[3]++;
      }
    if (!buckets.size || clear > total / 2 || (dark > total / 5 && light > total / 5)) continue;
    const [r, g, b, n] = [...buckets.values()].sort((a, z) => z[3] - a[3])[0];
    (out[s.block] ??= {})[s.v] = `#${hex2(r / n)}${hex2(g / n)}${hex2(b / n)}`;
  }
  return out;
}

/** Theme code: "WB1:" then rows in BLOCKS order split by "/", colours by ",", "-" = not set; trailing blanks dropped.
 * Survives any chat app; fits a tweet for a Basic theme. */
export function encodeCode(colors) {
  const rows = BLOCKS.map((block) => {
    const cells = slotsOf(block).map((s) => colors[block]?.[s.v]?.slice(1, 7) ?? "-");
    while (cells.at(-1) === "-") cells.pop();
    return cells.join(",");
  });
  while (rows.at(-1) === "") rows.pop();
  return `WB1:${rows.join("/")}`;
}
/** Find a theme code anywhere in pasted text (a whole tweet or chat bubble) and parse it; null if there is none.
 * Lenient: upper case, "#" before a colour, empty slots, and line breaks a chat app put inside the code.
 * Rows and colours this version doesn't know are ignored, so a newer code still loads. */
export function decodeCode(text) {
  // ponytail: an English word made only of a-f letters right after the code would join its last colour and void it
  const m = String(text).match(/WB1:([0-9a-f#,\-/\s]*)/i);
  if (!m) return null;
  const out = {};
  m[1].replace(/\s+/g, "").split("/").forEach((row, r) => {
    const block = BLOCKS[r], slots = block ? slotsOf(block) : [];
    row.split(",").forEach((h, i) => {
      h = h.replace(/^#/, "");
      if (slots[i] && /^[0-9a-f]{6}$/i.test(h)) (out[block] ??= {})[slots[i].v] = `#${h.toLowerCase()}`;
    });
  });
  return out;
}
