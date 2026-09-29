# WidgetBoard — v0.11 prototype

Grid-based desktop widgets for Windows. Tauri 2 (Rust core + plain HTML/CSS/JS UI, no build step).
Korean by default, English available.

- [Run](#run) · [Everyday use](#everyday-use) · [Widgets](#widgets) · [Customising](#customising-the-look) ·
  [config.json](#configjson) · [Files](#files) · [When something goes wrong](#when-something-goes-wrong) ·
  [Updates](#updates) · [Languages](#languages) · [Developing](#developing)

## Run
Unzip `WidgetBoard-win64.zip` and run `WidgetBoard.exe` (keep `WebView2Loader.dll` beside it).
Needs the WebView2 runtime, which Windows 10/11 already have. The exe is unsigned, so SmartScreen may ask once:
*More info → Run anyway*. Starting it a second time just shows the running copy.

## Everyday use
**Tray icon** (bottom-right, maybe under `^`)
- right-click → **위젯 추가 / Add widget ›** (Checklist, Calendar, D-day, Diary, Memo, Now Playing, Timer, Stopwatch, Image), **레이아웃 편집 / Edit layout**, **항상 창 위에 표시 / Always on top**,
  **동작 줄이기 / Reduce motion**, **테마 색상 / Theme colours…**, **설정 / Settings…**, **레이아웃 모음 / Layouts…**, **언어 / Language ›**, show/hide, open data folder,
  **설정 파일 열기 / Open settings file** (config.json), quit
- left-click → show/hide all widgets

**Moving and sizing**
- Hover a widget and drag its top strip (⋮⋮) to move it; drag the bottom-right corner to resize. Everything snaps to the grid.
- Dropping onto other widgets **pushes them aside** to make room — you see them slide while you drag, and they slide
  back if you move on. If there's truly no room the widget turns red and everything snaps back when you let go.
- **Edit layout** shows the grid, brings the widgets in front of windows and adds ✕ to each. `Esc` or **완료** ends it.
- Empty space is click-through: the desktop (or the windows behind) keep working.

**Transparent pictures** — without *액자 없이*, a widget always has its tinted surface, so transparent parts of a
picture show that surface (not the desktop). This applies to the image widget, background images (*배경 이미지*,
which also get a light tint for readability) and D-day icons (transparent parts show the accent colour inside the
circle). Clicks are caught by the whole widget rectangle, including transparent areas.

**Right-click a widget** — background image set/remove, move to another monitor, widget-specific options,
**위젯 종류 바꾸기 / Change widget type ›** (e.g. timer → stopwatch: same spot and size; each type remembers its own
content, so switching back restores the timer's time, the memo's text, the photo list…), **모양 / Appearance…**
(font, colours, frame — see [Customising](#customising-the-look)), **요약 읽기 / Read summary**, **이 위젯에만 집중 / Focus on this widget**,
edit layout, **닫기 / Close** — closing shows **되돌리기 / Undo** for 7 seconds. Inside a text box you get the normal copy/paste menu instead; right-click the
widget's header or edge.

**Layer** — by default widgets sit on the desktop behind your windows; *Always on top* floats them above.

**Monitors** — every monitor gets its own board. New widgets go to the primary monitor; right-click → *Move to display*.
Monitors plugged in, removed or changed while running are picked up after a few seconds. If a monitor disappears, its
widgets show on the primary one until it returns. If the screen gets smaller, widgets that would fall off are moved in.

**Reduce motion** — widgets jump into place instead of sliding; no blinking, fading or page-slide animations.
Also switches on by itself when Windows' *Accessibility → Visual effects → Animation effects* is off.

**Fonts** — *Theme colours…* sets one font and text size for everything; right-click → *Appearance…* overrides them for a
single widget (installed fonts are suggested, any name can be typed; *모두 초기화* removes every override).

**Layouts (레이아웃 모음)** — tray → *레이아웃 모음…* or Settings → *레이아웃 모음*.
- **업무용 / Work desk**: big writable calendar, to-dos, memo, timer, D-days, Now Playing.
- **공부용 / Study**: focus timer, stopwatch (study-time total), to-dos, diary (study log), D-days (exams), month calendar.
- Presets fill **this monitor** from the top-right corner (desktop icons live top-left). A widget of the same type is
  reused with its contents; widgets the preset doesn't include are put on a **shelf** and come back — text, photos and
  all — when you switch to a layout that has them. If the screen is too small, what doesn't fit is left out (you're told).
- **지금 배치 저장 / Save current** stores every monitor's arrangement under a name (up to 20). Applying one restores
  positions, sizes, monitors, colours and frames, but never rolls back what's *inside* a widget (a memo keeps today's text).
- Every change can be undone: the toast after switching, or *이전 배치로 되돌리기* in the panel.

## Settings (tray → 설정…)
Saved in `config.json` → `"ui"`, applied instantly on every monitor.

| group | setting | options |
|---|---|---|
| Layout | 위쪽 막대 (top strip) | on hover · always · hidden (only in edit mode — gives the space back to the content) |
| | 여백 (spacing) | compact · normal · roomy |
| | 레이아웃 잠금 (lock) | no accidental drags/resizes; move and resize only in edit mode |
| | 기본 테두리 장식 (default frame) | none · corners · double · stitched · beads · ornate · pixel · washi tape — for every widget without its own |
| Behaviour | 한 주의 시작 (week start) | default (calendar Sunday, checklist Monday) · Sunday · Monday — for both |
| | Windows 시작 시 자동 실행 | start with Windows |
| | 타이머 소리 / 음량 / 반복 | timer sound on/off, volume, how many times the alarm repeats |
| Accessibility | see below | every option starts **off** |

### Accessibility
**Everything in this section is off until you turn it on** (Settings → 접근성). Nothing changes for anyone who
doesn't go looking — but each option is one click away and applies instantly. What is always on is invisible:
screen-reader names and announcements, and a focus ring that only appears when you use the keyboard.

| for | setting (config `ui` key) | what it does |
|---|---|---|
| Keyboard & motor | 키보드 모드 단축키 (`hotkey`: off · Ctrl+Alt+W · Ctrl+Alt+Space · Ctrl+Shift+F12) | a global shortcut brings the widgets in front of everything and puts the keyboard on the first widget. **Tab** moves between widgets, **S** reads a summary, **L** lists every widget, **Esc** leaves. If another program owns the shortcut you're told to pick another. |
| | 머문 뒤에 클릭 받기 (`dwellMs`: off · 0.4 · 0.8 · 1.5 s) | the pointer must rest on a widget for a moment before it takes clicks — passing over widgets on the way to the desktop no longer clicks them (tremor, head/eye pointers) |
| | 끌지 않고 옮기기 (`clickDrag`) | click the top strip to pick a widget up, move the pointer, click again to drop (Esc cancels) — no holding the button |
| | 큰 버튼 (`bigTargets`), 버튼 항상 보이기 (`showControls`) | ≥ 30px targets; no hover-only controls |
| Low vision | 전체 확대 (`zoom`: 100–200%) | zooms every board; the grid and click-through follow |
| | 고대비 (`highContrast`) | solid backgrounds, strong 2px outlines, no faded text, every button visible, ✓/✕ on filters, holidays underlined |
| | 글자 간격 넓게 (`wideText`) | wider letter/word spacing and line height |
| | 모든 위젯 내용을 글로 보기 | a text list of every widget with its summary; pick one to jump to it (also **L** in keyboard mode) |
| Deaf / hard of hearing | 화면 테두리 번쩍임 (`flashAlert`) | when the timer ends: the screen edge flashes 3 times (steady with reduced motion) with the message on top; clicks still pass through |
| | Windows 알림 (`notifyAlert`) | the same alert as a Windows notification (Action Center keeps it) |
| | 소리 자막 (`soundCaptions`) | while an alarm rings the timer shows "🔔 알람이 울리는 중 (3/10)" — or "소리 꺼짐" if sound is off |
| Colour vision | 색각 친화 (`cvd`) | holiday/Saturday colours from a colour-blind-safe palette (vermillion/blue) plus shapes: Sundays & holidays underlined, Saturdays dotted, filters ✓/✕ |
| Less to think about | 한 줄 사용법 (`showHints`) | each header shows what the widget does and how ("숫자를 눌러 시간 입력 · ▶ 시작") |
| | 읽기 쉬운 글꼴 (`readableFont`: Atkinson Hyperlegible · Lexend · OpenDyslexic) | bundled, for Latin letters and digits; Korean stays Malgun Gothic. A per-widget font still wins. |
| | 줄 길이 짧게 (`shortLines`) | memo and diary lines stop at ~60 characters |
| | 남은 할 일 알려주기 (`reminderTime`, e.g. `"18:00"`) | once a day at that time: "오늘 남은 할 일 3개" (toast; also a Windows notification if that's on) |
| | 이 위젯에만 집중 (right-click) | hides every other widget until you press Esc or *집중 모드 끝내기* |

Always available:
- **Keyboard**: Tab moves between controls. On a widget's **⋮⋮** grip: arrow keys move it (neighbours make room),
  Shift+arrows resize, **S** reads its summary, Delete closes (with undo). **Menu key / Shift+F10** opens the
  right-click menu anywhere in a widget. **F2** edits the focused entry (checklist, calendar). Enter/Space opens a
  calendar day, starts writing in a big square, or opens a D-day; **Alt+↑/↓** reorders D-days.
- **Screen readers** (Narrator, NVDA): widgets are labelled regions, every icon button has a name, calendar days and
  D-days read their date/count; moves, type changes, summaries and a finished timer are announced.
- Windows' own high-contrast themes (forced colours) keep outlines and highlights. Reduce motion is in the tray.

## Widgets
Default size / minimum size in grid cells (1 cell = 80 px by default).

### 체크리스트 · Checklist (3×4 / 2×2)
Your to-dos, in three tabs. Every tab shows progress (`2/5` and a bar) and says when everything is done.
- **오늘 · Today** — type and press Enter to add a to-do for today.
  - Unfinished to-dos **carry over** to the next day, marked `↪ 9/25` with the day they were first written.
    Finished ones disappear the next day.
  - 🔁 turns a to-do into a **daily routine**: it shows every day, and ticking it only counts for that day.
  - 📅 (on by default) also lists **today's calendar entries**. Ticking one here ticks it in the calendar, and the
    other way round.
- **이번 주 · This week** — tasks you do once a week (recycling, laundry). Tick them any day of the week; they untick
  themselves when a new week starts (Monday; can be Sunday — see config.json).
- **이번 달 · This month** — tasks you do once a month (bills, backups); they untick on the 1st.
- Double-click a task to edit it (erase the text to delete), ✕ to delete.
- Right-click: hide/show completed, clear completed, calendar entries on/off. Every checklist widget shows the same
  tasks; each remembers which tab it is on.

### 캘린더 · Calendar (4×5 / 3×3)
A month calendar for to-dos and appointments, in two views (switch with ▦ / ☰ or right-click):
- **작은 달력 · Small** — just the month. A **dot** marks days that have entries (hollow dot = all done); empty days
  have none. **Click a day** to open its list: add with Enter, tick when done, double-click to edit, ✕ to delete,
  ‹ › step to the previous/next day, Esc or ✕ closes.
- **큰 칸 · Big squares** — every day is a writable square showing its entries. Click a square and type (Enter adds and
  keeps the box open for the next line, Esc closes); click an entry to edit it (erase the text to delete); tick its box
  when done. When a day is full the rest collapse into **+N개 더**, which opens the whole list. Switching to this view
  enlarges a small widget, pushing neighbours aside.
- **Typing**: `14:00 회의 #업무` → time 14:00, title "회의", tag #업무. Time and tags are optional.
- **Tags**: chips above the calendar cycle *normal → only this tag → hidden*.
- **Holidays**: Korean public holidays 2020–2050, including the lunar holidays, substitute holidays (대체공휴일), 노동절
  and 제헌절 (public holidays from 2026). Red = Sunday/holiday, blue = Saturday; hover a day for its name.
- Scroll over the month to change month; **오늘** jumps back. All calendar widgets on all monitors share the same
  entries (and so does the checklist); each widget keeps its own view and tag filter.

### D-day (3×4 / 2×2)
Countdowns, listed like a Discord member list: round icon, name, date and tag, and **D-54 / D-Day / D+3**.
- **+ D-day 추가**: name, date, optional tag, icon, and mode — *countdown* (D-12, D+3) or *anniversary* (N일째,
  counting the start date as day 1).
- **Icons**: click the circle to pick any image you've uploaded before (several D-days can share one; it's stored once),
  upload a new one, or use none (the first letter of the name is shown).
- Click a row to edit or delete it. **Drag a row** to reorder, or drop it onto another D-day widget to move it there.
- **Filters**: the first chip cycles 전체 → 다가오는 → 지난 (all / upcoming / past); tag chips show only those tags.

### 일기 · Diary (4×4 / 3×3)
One page per day, saved automatically as you type.
- ‹ › flick to the previous / next day that has a page (› stops at today); **오늘** jumps back; click the date to pick
  any day. A sideways touchpad swipe also flicks pages. Arrow keys only move the text cursor.
- Lined paper; background image via right-click → *배경 이미지 설정…*. Character count at the bottom.
- Pages are plain text files (`diary/2026-09-26.md`) — easy to back up or read elsewhere.

### 타이머 · Timer (3×2 / 2×2)
Counts down and rings (sound + blinking) when done.
- Presets underneath (set your own in config.json), or click the digits and type: `25` = 25 min, `1:30`, `1:00:00`.
- Scroll over the digits to add/subtract a minute. ▶ start, ❚❚ pause, ↺ reset. Up to 99 hours.
- Keeps correct time through sleep and restarts.

### 스톱워치 · Stopwatch (3×3 / 2×2)
Counts up, with a running **누적 (total)** of every second you've ever measured.
- ▶ start / ❚❚ stop. While running, **랩** records laps (shown when the widget is tall enough); when stopped,
  **초기화** clears this run — the total is kept.
- The total survives restarts and keeps counting if the app is closed while the stopwatch runs.
- ↺ next to the total resets it — click twice within 3 s so it can't happen by accident.

### 메모 · Memo (3×3 / 2×2)
A sticky note that keeps whatever you write — no daily reset. Each memo widget is its own note, saved as you type.
- Paper colour: hover and click a colour dot (bottom-right), or right-click → *메모 색*: yellow, pink, green, blue,
  purple, orange, or *테마 색* (the normal widget look). The theme's opacity slider also applies to the paper.
- Font and size per memo: right-click → *글꼴…*.

### 지금 재생 중 · Now Playing (4×2 / 3×1)
Shows what's playing anywhere on the PC — **YouTube** (Chrome, Edge, Whale, Firefox…), Spotify, Melon, the Media
Player app, VLC — using Windows' own media controls (the same source as the volume pop-up).
- Artwork (video thumbnails keep their 16:9 shape), title, channel/artist and which app it's from.
- Progress bar with time; **click the bar to jump** (when the site allows it — YouTube does).
- ⏮ ⏯ ⏭ control the player; buttons the player doesn't support are greyed out.
- **⇄ 2** appears when several players are open (e.g. a YouTube tab and Spotify) — click to switch which one is shown.
- Layouts: 1 row (title + play/next), 2 rows (artwork beside the text), tall (artwork on top).
- Only reads while a Now Playing widget exists; it asks Windows once a second and only redraws when something changed.

### 이미지 · Image — photo & slideshow (2×2 / 1×1)
One picture, or a **slideshow** of many.
- Click or drop images onto it — several at once. Hover for controls: ‹ ❚❚ › (previous / pause / next), `3/12`,
  **＋** add more, **🗑** take the current one out of the list, *맞춤 / 채우기* (fit / fill).
- Right-click: *넘김 간격* (5 s – 30 min, default 10 s), *무작위 순서* (shuffle), *사진 모두 빼기*.
- Photos crossfade (a plain switch with *Reduce motion*); the slideshow pauses while the widgets are hidden.
- **Transparent images**: right-click → **액자 없이** (frameless). The widget's background and outline disappear and the
  picture switches to *fit*, so a transparent PNG / WebP / GIF / SVG sits directly on the desktop like a sticker.
  A faint dashed outline shows the widget's edge only while you hover or edit the layout.

## Customising the look
Three ways, from easiest to most flexible:
1. **Theme panel** (tray → *테마 색상…*): 3 colours, font, text size, corner radius, outline width, opacity, cell size —
   live preview. Right-click any widget → **모양 / Appearance…** for that widget only: font and size, its own surface /
   accent / text colours and opacity (unset = follow the theme; text on the accent picks black or white for contrast),
   and a **frame**. Also per-widget background images, frameless images, memo paper colours.
   - **Frames** are SVG decorations drawn over the widget's edge in the frame colour (default: the accent):
     corners, double line, stitched, beads, ornate, pixel, washi tape. Settings → *기본 테두리 장식* sets one for every
     widget; a widget's own choice wins. **SVG 테두리 불러오기…** takes any SVG (≤ 100 KB): it's used as a 9-slice
     mask — the outer 30% on each side are the corners, the middle stretches — and only its shape matters, the colour
     comes from *장식 색*. Frames hide in high-contrast mode and on frameless images.
2. **AI themes** — describe a look in words and let any AI write the theme:
   *AI 프롬프트 복사* → paste into ChatGPT / Claude / Gemini and add keywords (`벚꽃, 파스텔, 둥글게`) →
   copy the whole answer → *AI 테마 붙여넣기…* → *적용*. The app extracts the CSS, rejects answers that aren't themes,
   warns about low contrast or unsupported rules, and *이전 테마로 되돌리기* restores the previous theme (even after a restart).
   The prompt is also in `AI_THEME_PROMPT.md` to share with others.
3. **theme.css by hand** (*theme.css 열기*): saving applies it instantly. Copy the file to share a theme.

### Theme format (contract v1)
Only CSS custom properties, in `:root { }` and optional `[data-widget="TYPE"] { }` blocks
(TYPE: checklist, calendar, dday, diary, memo, nowplaying, timer, stopwatch, image). This set is kept stable across versions.

| variable | controls |
|---|---|
| `--c1` `--c2` `--c3` | surface, accent, text |
| `--on-accent` | text/icons on the accent colour (use a dark one for light accents) |
| `--hol` `--sat` `--danger` | Sundays & holidays, Saturdays, destructive/invalid |
| `--line-width` `--line-style` `--line-color` | outline |
| `--radius` `--widget-opacity` `--shadow` | corner roundness, background solidity (wallpaper shows through), shadow/glow |
| `--widget-bg` | optional colour or gradient replacing the plain surface |
| `--font` `--font-size` | font list (end with `"Malgun Gothic", sans-serif`), base size |
| `--frame-color` | optional: colour of the frame decorations (default = `--c2`) |
| `--cell` `--gap` | grid (changing them moves widgets) |

```css
:root {
  --c1: #fff5f8; --c2: #c2386a; --c3: #3a2530; --on-accent: #ffffff;
  --hol: #c8324f; --sat: #3f6fd1; --danger: #c62f3b;
  --line-width: 1px; --line-style: solid; --line-color: color-mix(in srgb, var(--c2) 35%, transparent);
  --radius: 22px; --widget-opacity: .88; --shadow: 0 6px 18px rgb(194 56 106 / .18);
  --font: "Segoe UI", "Malgun Gothic", sans-serif; --font-size: 14px;
}
[data-widget="diary"] { --c1: #fbf6ea; --c3: #3b3024; --font: "Batang", "Malgun Gothic", serif; }
```
`@import` and remote `url(...)` are stripped when a theme loads.

## config.json
Open it from the tray (*설정 파일 열기*); saving applies it immediately.
```json
{
  "timer": { "presets": [
    { "label": "", "time": "1" },          // empty label = automatic ("1분")
    { "label": "라면 🍜", "time": "3" },
    { "label": "", "time": "1:30" }         // 1 min 30 s; "1:00:00" = 1 hour
  ] },
  "holidays": { "country": "KR",           // or "none"
                "add": { "2026-10-15": "창립기념일" },   // temporary holidays, elections, your own days off
                "remove": ["2026-05-01"] },
  "checklist": { "weekStart": "mon" },     // or "sun"
  "update": { "check": "weekly",           // "daily" or "off"
              "url": "" }                  // latest.json address; empty = the one built into the app
}
```
(JSON has no comments — they're only here to explain.) The holiday table (`ui/holidays/kr.json`) comes from
python-holidays with the lunar dates cross-checked against KASI data; holidays announced later (임시공휴일,
elections after 2026) need an `add` entry.

## Files
All in `%APPDATA%\app.widgetboard.desktop\`:

| file | what |
|---|---|
| `layout.json` | widgets: type, monitor, x, y, w, h (grid cells), settings (memo text, slideshow list…), background, font, colours, frame |
| `settings.json` | `lang` (`ko` / `en`), `on_top`, `reduce_motion` |
| `config.json` | `ui` (Settings panel), timer presets, holidays |
| `theme.css` | the theme |
| `data/events.json` | calendar entries (also used by the checklist) |
| `data/checklist.json` | checklist tasks |
| `data/layouts.json` | saved layouts; `layouts_shelf.json` widgets put away by a layout; `layouts_undo.json` the arrangement before the last switch |
| `diary/YYYY-MM-DD.md` | diary pages |
| `assets/` | uploaded images, named by content hash (the same image is stored once) |
| `updates/` | `state.json` (last check), a verified download waiting to install (`pending.exe` + `pending.json`) |

## When something goes wrong
- A save that fails (disk full, folder locked) shows a message; the diary keeps your text and retries.
- A widget that can't load, or an unknown widget type, shows a note instead of breaking the board — right-click → 닫기.
- Damaged or hand-edited `layout.json` / `events.json` / `checklist.json` values are repaired on load; a broken
  `theme.css` value such as `--cell: abc` falls back to a safe default.
- A change from another widget or monitor never wipes something you're halfway through typing.

## Updates
WidgetBoard looks for a new version **once a week** (Settings → *업데이트*: weekly · daily · off; or *지금 확인*,
or tray → *업데이트 확인*). The first look is 3 minutes after start, never during startup.
- A new version is downloaded quietly and **checked against the release key built into the app** — an exe that isn't
  signed for exactly that version, or is older than what you have, is thrown away. Only `https://` addresses are used.
- It installs **the next time WidgetBoard starts**; *지금 다시 시작* (toast, Settings or tray) does it right away.
  The old exe is kept as `WidgetBoard.exe.old` until the new one is running, and put back if the swap fails
  (e.g. the folder is read-only — then you're told and keep the current version).
- Your widgets, notes and settings live in `%APPDATA%` and are not touched by an update.
- Until a release address is set (`config.json` → `"update": { "url": "https://…/latest.json" }`, or built in),
  the updater does nothing and Settings says so.

## Languages
Korean is the default; English lives in `ui/locales/en.json` (also the fallback for missing keys).
Keys are flat (`"timer.start": "시작"`), `{n}` is a placeholder, `_name` is the name shown in the Language menu.
To add a language: copy `en.json` to `<code>.json`, translate, and add it to `LOCALES` in `src-tauri/src/main.rs`.

## Developing
**Add a widget type**
1. `ui/widgets/<name>.js` exports `{ size, min, defaults, css, mount(root, settings, api) }`; `mount` may return
   `{ destroy, resized, menu, summary }` (`summary()` returns one line of plain text for screen readers and the overview). `api` offers `save, t, lang, toast, store.get/set, onStore, diary.*, config, onConfig,
   pickImage(s), uploadImage, assetUrl, listAssets, requestSize, size, reduceMotion, setInteracting, wheelScrollX,
   setFrameless, on(event), media.subscribe/control, announce, alert(title, body)` (`alert` = the user's opted-in
   flash / Windows notification; sound stays the widget's job).
2. Register it in `REGISTRY` (`ui/app.js`) and `WIDGETS` (`src-tauri/src/main.rs`); add `widget.<name>` to the locales.

**Build (Windows)**
```powershell
winget install Rustlang.Rustup          # plus "Desktop development with C++" build tools if missing
cd src-tauri
cargo build --release                   # -> target\release\widgetboard.exe
```
**Try the UI in a browser**: `python -m http.server 8765` in `ui/`; a mock backend kicks in
(`__mock.emit('add-widget','timer')` in the console adds widgets, `?lang=en` switches language).

**Publish a release (auto-update)** — once, `node tools/release.mjs keygen` makes the release key
(private key → `~/.widgetboard/updater.key`, public key → `src-tauri/updater.pub`, compiled into the app; builds with a
different public key refuse your updates). For every release:
1. bump `version` in `src-tauri/Cargo.toml` and `tauri.conf.json`, build;
2. `node tools/release.mjs sign target\release\widgetboard.exe --version 0.12.0 --notes "what changed"` → `latest.json`;
3. upload **both** `latest.json` and the exe (named `WidgetBoard.exe`) to the release. With GitHub Releases the app's
   address is `https://github.com/<you>/<repo>/releases/latest/download/latest.json` — build with
   `WIDGETBOARD_UPDATE_URL=<that>` or put it in `config.json` → `update.url`.
`node tools/release.mjs verify latest.json WidgetBoard.exe` checks a release the way the app will.
Updater logic tests (no Windows needed): `bash tools/updater-test/run.sh` (35 checks: signatures, relabelled or
foreign-key releases, downgrades, http, tampered downloads, the exe swap and rollback).

**Tests**: `tests/stress.mjs` (Playwright) runs 185 checks — damaged saved data, HTML/CSS injection, push-aside
layout (incl. 60 random drags/resizes checked for overlaps), screen shrinking, both calendar views and holidays,
checklist day/week/month rollover and calendar sync, stopwatch totals (simulated clock), reduced motion, D-day /
diary / timer edge cases, memo persistence, slideshow timing and frameless transparency (pixel check), Now Playing
with simulated media, the AI theme flow (prompt copy, pasting AI answers, rejection of non-themes, contrast
warnings, undo), every setting, keyboard move/resize/menu, change type round trips, undo close, accessible names for
every control, Windows forced-colours mode, large text at minimum sizes, save failures. With the UI served on port 8765:
`npm i playwright && node tests/stress.mjs`. `tests/v10.mjs` (121 checks) covers v0.10: every accessibility option
is off on a fresh board and switches on/off cleanly, keyboard mode / overview / summaries / focus mode, click-to-carry,
timer flash + notification + captions, the reminder (simulated clock), per-widget colours, all frames (pixel check),
custom SVG frames and hostile values, layout presets, saved layouts, the shelf and undo, and English without raw keys.
