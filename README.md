# WidgetBoard

Grid-based desktop widgets for Windows: a checklist, calendar, D-days, diary, memos, a timer with stopwatch and
pomodoro modes, Now Playing, pictures, a world clock and an oshi (최애) showcase card. They live on your desktop,
snap to a grid and stay out of the way of your other windows.
Korean by default, English available. Version 0.15.

Built with Tauri 2: a small Rust core and a plain HTML/CSS/JS interface with no build step. One ~5 MB exe, no
installer, nothing running in the background except the app itself.

- [Features](#features) · [Run](#run) · [Everyday use](#everyday-use) · [Settings](#settings) ·
  [Names, hiding and closed widgets](#names-hiding-and-closed-widgets) · [Backup and restore](#backup-and-restore) ·
  [Widgets](#widgets) · [Customising](#customising-the-look) · [config.json](#configjson) · [Files](#files) ·
  [When something goes wrong](#when-something-goes-wrong) · [Updates](#updates) · [Languages](#languages) ·
  [Developing](#developing)

## Features

- **Ten widgets**: checklist (today / week / month, routines, carry-over), month calendar with tags and Korean
  public holidays, D-day countdowns, a daily diary, sticky memos, a **timer** that is also a stopwatch (with a
  lifetime total) and a pomodoro, **Now Playing** for any media app (YouTube, Spotify, Melon…) that also plays your
  own voicelines and character songs, an **image** widget (slideshow or a thumbnail grid for goods and cards) that can
  sit frameless on the desktop like a sticker, a world **clock** in any timezone, and an **oshi (최애) showcase**
  card (image, name, rotating quotes, birthday countdown).
- **Event reminders**: give a calendar entry a time, a timezone and a link, and it fires a desktop notification at the
  right local moment (handy for streams in another timezone); clicking the notification opens the link. Weekly and
  yearly repeats. Times are correct across timezones and daylight-saving changes.
- **A grid that makes room**: drag a widget onto others and they slide aside; nothing ever overlaps. Empty space is
  click-through, so the desktop and windows behind keep working.
- **Every monitor gets its own board**; monitors added or removed while running are picked up.
- **One settings window** for everything: appearance, widgets and layouts, timer and calendar, accessibility,
  backups and updates. Changes apply instantly on every monitor.
- **Name, hide and recover widgets**: give widgets your own names, find one on screen from the settings list, hide it
  without losing anything, and bring back closed widgets from a bin.
- **Backups** as plain folders, on demand or daily/weekly, with one-click restore. An optional **memo archive** keeps
  the history of every memo, even after the memo is erased.
- **Layouts**: Work and Study presets, saved arrangements across all monitors, undo for every switch.
- **Themes**: colours, font, corner radius, opacity, cell size and decorative frames; per-widget overrides; let any
  AI write a theme from a few words; or edit `theme.css` by hand.
- **Accessible by design**: keyboard mode, dwell clicking, click-to-carry, zoom to 200%, high contrast, colour-blind
  safe palette, readable fonts, visual and Windows-notification alerts, screen-reader names. All off until you turn
  them on.
- **Reduced motion** respected everywhere, and switched on automatically when Windows animations are off.
- **Your data stays local** in `%APPDATA%`, as readable JSON and Markdown files. The only network access is the
  optional signed update check.

## Run

Run `WidgetBoard.exe`. It needs the WebView2 runtime, which Windows 10/11 already have. The exe is unsigned, so
SmartScreen may ask once: _More info → Run anyway_. Starting it a second time just shows the running copy.
To start it with Windows, tick Settings → 일반 → _Windows 시작 시 자동 실행_.

## Everyday use

**Tray icon** (bottom-right, maybe under `^`)

- right-click → **위젯 추가 / Add widget ›** grouped as 일정 · Planning (Checklist, Calendar, D-day), 기록 · Notes
  (Memo, Diary), 시간 · Time (Clock, Timer), 이미지 · Images (Image, Showcase) and Now Playing, **레이아웃 편집 / Edit layout**, **테마 / Theme…**,
  **설정창 / Settings**, **레이아웃 / Layouts…**, **언어 / Language ›**, show/hide, open data folder,
  **설정 파일 열기 / Open settings file** (config.json), check for updates, quit.
  _Theme colours…_ and _Layouts…_ open the matching page of the settings window.
- left-click → show/hide all widgets

**Moving and sizing**

- Hover a widget and drag its top strip (⋮⋮) to move it; drag the bottom-right corner to resize. Everything snaps to the grid.
- Dropping onto other widgets **pushes them aside** to make room - you see them slide while you drag, and they slide
  back if you move on. If there's truly no room the widget turns red and everything snaps back when you let go.
- **Edit layout** shows the grid, brings the widgets in front of every window while you arrange them, shows hidden
  widgets as faint ghosts and adds ✕ to each. **Right-click an empty cell** to add a widget right there. `Esc` or
  **완료** ends it.
- Empty space is click-through: the desktop (or the windows behind) keep working.

**Free placement** (Settings → 일반 → 배치 방식 → 자유 배치) is for arranging widgets like furniture or around your
wallpaper art. The grid and push-aside stay the default (칸에 맞춤).

- Widgets go anywhere, right up to the screen edges, at any size (down to each widget's minimum), and may overlap.
- While you drag, a widget sticks to the screen edges and margins, the screen centre, other widgets' edges and centres,
  and the spacing already used between neighbours; dashed guides show what it's sticking to. Hold **Alt** to place it
  exactly.
- Widgets stack in layers, as in a drawing program: moving or clicking a widget leaves the order alone. Change it with
  right-click → **앞으로 / 뒤로 / 맨 앞으로 / 맨 뒤로**, or Ctrl+] / Ctrl+[ (with Shift: to the front / back) on a
  selected widget.
- **레이어 (Layers)** (right-click, or the button in the edit bar) lists every widget front first: drag a row to
  reorder, the eye hides or shows, the lock fixes its position, and clicking a name selects the widget so the arrow
  keys move it, even when it is covered. Right-click → **아래 위젯 선택** selects a widget under the pointer.
- A widget with one of its own panels open (a pomodoro's settings, a calendar entry) sits on top while it is open.
- Keyboard: arrows move 10 px (Alt: 1 px), Shift+arrows resize.
- Each mode keeps its own arrangement: switching back to 칸에 맞춤 shows the grid layout again (widgets added while
  free get a free cell, or overlap with a notice when the grid is full), and switching to free again restores it.

**Layer** - widgets behave like any other window. Click a widget and that monitor's widgets come forward; click
another program and it covers them. Edit layout and keyboard mode bring them to the front while they're on.

**Transparent pictures** - without _액자 없이_, a widget always has its tinted surface, so transparent parts of a
picture show that surface (not the desktop). This applies to the image widget, background images (_배경 이미지_,
which also get a light tint for readability) and D-day icons (transparent parts show the accent colour inside the
circle). Clicks are caught by the whole widget rectangle, including transparent areas.

**Right-click a widget** opens its own options, **Appearance…**, **Focus on this widget**, **Hide** and **Close**.
**Read summary** appears when its accessibility setting is enabled. Inside a text box you get the normal
copy/paste menu; right-click the widget's header or edge to open the widget menu.

**In Edit layout**, that menu also offers background image set/remove, **Move to display** and
**Change widget type ›**. Changing type keeps the widget's position and appearance. Each type retains its own
content, so switching back restores the memo text, timer settings or photo list. A larger type may need more grid space.
Timer, Stopwatch and Pomodoro switch in place (stop and reset a running one first).

Closing shows **Undo** for 7 seconds. The widget also goes to the [closed widgets bin](#names-hiding-and-closed-widgets).

**Monitors** - every monitor gets its own board. New widgets go to the primary monitor; right-click → _Move to display_.
Monitors plugged in, removed or changed while running are picked up after a few seconds. If a monitor disappears, its
widgets show on the primary one until it returns. If the screen gets smaller, widgets that would fall off are moved in.

**Reduce motion** - widgets jump into place instead of sliding; no blinking, scaling or page-slide animations. Fades stay, kept short.
Also switches on by itself when Windows' _Accessibility → Visual effects → Animation effects_ is off.

**Fonts** - Settings → 모양 sets one font and text size for everything; right-click → _Appearance…_ overrides them for a
single widget (installed fonts are suggested, any name can be typed; _초기화_ removes every override).

**Layouts (레이아웃)** - tray → _레이아웃…_ or Settings → 위젯 · 배치.

- **업무용 / Work desk**: big writable calendar, to-dos, memo, timer, D-days, Now Playing.
- **공부용 / Study**: focus timer, stopwatch (study-time total), to-dos, diary (study log), D-days (exams), month calendar.
- Presets fill **this monitor** from the top-right corner (desktop icons live top-left). A widget of the same type is
  reused with its contents; widgets the preset doesn't include are put on a **shelf** and come back - text, photos and
  all - when you switch to a layout that has them. If the screen is too small, what doesn't fit is left out (you're told).
- **현재 배치 저장 / Save current** stores every monitor's arrangement under a name (up to 20). Applying one restores
  positions, sizes, monitors, colours and frames, but never rolls back what's _inside_ a widget (a memo keeps today's text).
- Every change can be undone: the toast after switching, or _배치 되돌리기_ in settings.

## Settings

Tray → **설정창** opens the settings window: a normal window with a page list on the left (a drop-down when the
window is narrow). Changes apply instantly on every monitor and show a short _저장됨_; there is no Save button.
`Esc` closes it; `Ctrl+Tab`, `Ctrl+PgDn` and `Ctrl+PgUp` switch pages. The window follows the app's own zoom,
contrast, font and motion settings.

| page                    | what's there                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 일반 · General          | language, start with Windows, week start (default Sunday · Sunday · Monday; one week for the calendar and checklist), your timezone (for reminders; defaults to this computer's) |
| 모양 · Appearance       | theme colours, font, text size, corner radius, outline, opacity, cell size with live preview; top strip (on hover · always · hidden), spacing, default frame; reset theme; AI theme copy/paste/undo; open `theme.css` |
| 위젯 · 배치 · Widgets   | every widget on every monitor (name, hide/show, move to another monitor, close); add a widget; lock layout; edit layout; Work/Study presets; saved layouts; the closed widgets bin; the memo archive                  |
| 타이머 · 달력 · Timer   | timer sound, volume and repeats; timer presets (label + time, reorder); holiday country, your own holidays, days that aren't holidays                                                                                 |
| 접근성 · Accessibility  | everything in [Accessibility](#accessibility), plus reduce motion                                                                                                                                                     |
| 백업 · 데이터 · Backup  | back up now, automatic backups, restore, open the backups folder, open `config.json`                                                                                                                                  |
| 정보 · 업데이트 · About | version, update schedule and status, check now, install and restart, font licences                                                                                                                                    |

**Lock layout** stops accidental drags and resizes; widgets then move only in edit mode.

## Names, hiding and closed widgets

- **Names** - in Settings → 위젯 · 배치, type a name into a widget's field (up to 40 characters). The name replaces
  the type in the widget's top strip, in screen-reader labels and in messages. Leave it empty for the type name.
- **Find a widget** - clicking or tabbing into a name makes the real widget's outline pulse, on whichever monitor it
  is (a steady outline with reduced motion).
- **Hide** - _숨기기_ in the settings list or the widget's right-click menu. A hidden widget keeps its content, its
  place on the grid and anything it is doing (a hidden timer still rings). It isn't drawn; in edit mode it shows as a
  faint dashed ghost so you know what's holding that space. _보이기_ or right-click → _보이기_ brings it back.
- **Closed widgets bin** - every closed widget (✕, Delete, or ✕ in settings) waits in the bin with its content, the
  latest 50. _복원_ puts it back in its old spot if that spot is free, otherwise in the nearest free one.
  _영구 삭제_ and _모두 영구 삭제_ ask first; erasing also deletes images that only that widget used.
- **What closing does not delete** - checklist tasks, calendar entries and diary pages are shared by every widget of
  that type, so closing or erasing a widget leaves them alone. Every widget has a unique id, so a restored widget
  never collides with one you added later.
- **Memo archive** (opt-in, off by default) - _메모 기록 보관_ at the bottom of the widgets page. When on, memo
  text is saved as it changes: at most once a minute while you type, and at once when a memo is closed or mostly
  deleted. Unchanged text isn't saved twice. The archive survives the bin, erasing and restoring backups; turning it
  off keeps what is already saved. The list groups versions by memo, newest first, each with a copy button.
  Typical use adds a few MB a year (about 40 MB at the extreme of an hour's memo typing every day).

## Backup and restore

- **지금 백업 / Back up now** copies your widgets, settings, theme, calendar, checklist, diary, images and memo
  archive into a dated folder, by default `Documents\WidgetBoard\Backups` (outside AppData, so it survives a
  reinstall and can sit in OneDrive). Change the place with `config.json` → `backup.dir`.
- **Automatic backups**: off · daily · weekly, keeping the last N (default 7). Only automatic backups are pruned;
  the ones you make by hand stay until you delete them.
- **Restore** asks first. It saves anything unsaved, takes a `pre-restore` snapshot of the current state, copies the
  backup over and restarts the app. If the snapshot can't be made, nothing is overwritten. The memo archive is never
  replaced by an older copy.
- A backup is an ordinary folder: copy it anywhere, or pick single files out of it.

### Accessibility

**Everything in this section is off until you turn it on** (Settings → 접근성). Nothing changes for anyone who
doesn't go looking - but each option is one click away and applies instantly. What is always on is invisible:
screen-reader names and announcements, and a focus ring that only appears when you use the keyboard.

| for                    | setting (config `ui` key)                                                         | what it does                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keyboard & motor       | 키보드 모드 단축키 (`hotkey`: off · Ctrl+Alt+W · Ctrl+Alt+Space · Ctrl+Shift+F12) | a global shortcut brings the widgets in front of everything and puts the keyboard on the first widget. **Tab** moves between widgets, **S** reads a summary, **L** lists every widget, **Esc** leaves. If another program owns the shortcut you're told to pick another. |
|                        | 클릭 전 대기 (`dwellMs`: off · 0.4 · 0.8 · 1.5 s)                                 | the pointer must rest on a widget for a moment before it takes clicks - passing over widgets on the way to the desktop no longer clicks them (tremor, head/eye pointers)                                                                                                 |
|                        | 끌지 않고 옮기기 (`clickDrag`)                                                    | click the top strip to pick a widget up, move the pointer, click again to drop (Esc cancels) - no holding the button                                                                                                                                                     |
|                        | 큰 버튼 (`bigTargets`), 버튼 항상 보이기 (`showControls`)                         | ≥ 30px targets; no hover-only controls                                                                                                                                                                                                                                   |
| Low vision             | 전체 확대 (`zoom`: 100–200%)                                                      | zooms every board; the grid and click-through follow                                                                                                                                                                                                                     |
|                        | 고대비 (`highContrast`)                                                           | solid backgrounds, strong 2px outlines, no faded text, every button visible, ✓/✕ on filters, holidays underlined                                                                                                                                                         |
|                        | 글자 간격 넓게 (`wideText`)                                                       | wider letter/word spacing and line height                                                                                                                                                                                                                                |
|                        | 모든 위젯 내용을 글로 보기 (keyboard mode **L**)                                  | a text list of every widget with its summary; pick one to jump to it. Settings → 위젯 · 배치 lists every widget too                                                                                                                                                      |
| Deaf / hard of hearing | 화면 테두리 번쩍임 (`flashAlert`)                                                 | when the timer ends: the screen edge flashes 3 times (steady with reduced motion) with the message on top; clicks still pass through                                                                                                                                     |
|                        | Windows 알림 (`notifyAlert`)                                                      | the same alert as a Windows notification (Action Center keeps it)                                                                                                                                                                                                        |
|                        | 소리 자막 (`soundCaptions`)                                                       | while an alarm rings the timer shows "🔔 알람이 울리는 중 (3/10)" - or "소리 꺼짐" if sound is off                                                                                                                                                                       |
| Colour vision          | 색각 친화 (`cvd`)                                                                 | holiday/Saturday colours from a colour-blind-safe palette (vermillion/blue) plus shapes: Sundays & holidays underlined, Saturdays dotted, filters ✓/✕                                                                                                                    |
| Less to think about    | 한 줄 사용법 (`showHints`)                                                        | each header shows what the widget does and how ("숫자 클릭: 시간 입력 (25, 1:30, 1:00:00), ▶: 시작")                                                                                                                                                                     |
|                        | 읽기 쉬운 글꼴 (`readableFont`: Atkinson Hyperlegible · Lexend · OpenDyslexic)    | bundled, for Latin letters and digits; Korean stays Malgun Gothic. A per-widget font still wins.                                                                                                                                                                         |
|                        | 줄 길이 짧게 (`shortLines`)                                                       | memo and diary lines stop at ~60 characters                                                                                                                                                                                                                              |
|                        | 남은 할 일 알려주기 (`reminderTime`, e.g. `"18:00"`)                              | once a day at that time: "오늘 남은 할 일 3개" (toast; also a Windows notification if that's on)                                                                                                                                                                         |
|                        | 요약 읽기 메뉴 (`announceSummary`)                                               | adds _요약 읽기 / Read summary_ to a widget's normal right-click menu (off by default; summaries are always available by keyboard **S**)                                                                                                                                  |
|                        | 집중 모드 (right-click)                                                           | hides every other widget until you press Esc or _집중 모드 종료_                                                                                                                                                                                                         |

Always available:

- **Keyboard**: Tab moves between controls. On a widget's **⋮⋮** grip: arrow keys move it (neighbours make room),
  Shift+arrows resize, **S** reads its summary, Delete closes (with undo). **Menu key / Shift+F10** opens the
  right-click menu anywhere in a widget. **F2** edits the focused entry (checklist, calendar). Enter/Space opens a
  calendar day, starts writing in a big square, or opens a D-day; **Alt+↑/↓** reorders D-days.
- **Screen readers** (Narrator, NVDA): widgets are labelled regions, every icon button has a name, calendar days and
  D-days read their date/count; moves, type changes, summaries and a finished timer are announced.
- Windows' own high-contrast themes (forced colours) keep outlines and highlights. Reduce motion is on the settings
  window's accessibility page.

## Widgets

Default size / minimum size in grid cells (1 cell = 80 px by default).

### 체크리스트 · Checklist (3×4 / 2×2)

Your to-dos, in three tabs. A bar shows each tab's progress; hover a tab or the bar for the count.

- **오늘 · Today** - type and press Enter to add a to-do for today.
  - Unfinished to-dos **carry over** to the next day, marked `↪ 9/25` with the day they were first written.
    Finished ones disappear the next day.
  - 🔁 turns a to-do into a **daily routine**: it shows every day, and ticking it only counts for that day.
- **이번 주 · This week** - everything dated this week (a one-off dentist visit on Saturday included), plus tasks you do
  once a week (recycling, laundry). Those are due on the week's last day, where the calendar and the D-day list show
  them. Tick them any day of the week; they untick themselves when a new week starts (Sunday by default; Monday in
  Settings → 일반).
- **이번 달 · This month** - everything dated this month, plus tasks you do once a month (bills, backups), due on the
  month's last day; they untick on the 1st.
- 📅 (on by default) lists **calendar entries and D-days** in every tab, on the day they fall. Ticking one here ticks it
  in the calendar, and the other way round. An entry that repeats as often as the tab's period or more (daily in a
  week, weekly in a month) stays out of that tab. Right-click → _숨길 태그 / Hide tags_ keeps tagged entries out of
  this checklist only.
- To-dos are calendar entries too: they show on their day in the calendar and count down in the D-day list.
  Daily routines stay in the checklist.
- Double-click a task to edit it (erase the text to delete), ✕ to delete.
- **Day-well-done stamp**: when every Today item is done, a "참 잘했어요 / Well done!" stamp drops onto the list. Right-click →
  _스탬프_ turns it on/off, sets the tilt (slight / random / straight) and lets you use your own image.
- Right-click: hide/show completed, clear completed, calendar entries on/off. Every checklist widget shows the same
  tasks; each remembers which tab it is on. (D-day countdowns stay out of this list - they live in the D-day widget.)

### 달력 · Calendar (4×5 / 3×3)

A month calendar for to-dos and appointments, in two views (switch with ▦ / ☰ or right-click):

- **작은 달력 · Small** - just the month. A **dot** marks days that have entries (hollow dot = all done); empty days
  have none. **Click a day** to open its list: add with Enter, tick when done, double-click to edit, ✕ to delete,
  ‹ › step to the previous/next day, Esc or ✕ closes.
- **큰 칸 · Big squares** - every day is a writable square showing its entries. Click a square and type (Enter adds and
  keeps the box open for the next line, Esc closes); click an entry to edit it (erase the text to delete); tick its box
  when done. When a day is full the rest collapse into **+N개 더**, which opens the whole list. Switching to this view
  enlarges a small widget, pushing neighbours aside.
- **Typing**: `14:00 회의 #업무` → time 14:00, title "회의", tag #업무. Time and tags are optional.
- **Repeat**: an entry can repeat **weekly** (same weekday) or **yearly** (same date); repeating entries show ↻.
- **Reminders & links** (⚙ on an entry): set a time, a timezone, a link (URL) and a lead time, and tick _remind me_.
  The app fires a desktop notification at that local moment and clicking it opens the link. Entries show 🔔 when a
  reminder is set and 🔗 when a link is set. Useful for a stream in another timezone.
- **Tags**: chips above the calendar cycle _normal → only this tag → hidden_.
- **Holidays**: Korean public holidays 2020–2050, including the lunar holidays, substitute holidays (대체공휴일), 노동절
  and 제헌절 (public holidays from 2026). Red = Sunday/holiday, blue = Saturday; hover a day for its name.
- Scroll over the month to change month; **오늘** jumps back. All calendar widgets on all monitors share the same
  entries (and so does the checklist); each widget keeps its own view and tag filter.

### D-day (3×4 / 2×2)

Countdowns, listed like a Discord member list: round icon, name, date and tag, and **D-54 / D-Day / D+3**.

- **Right-click → D-day 추가** (or the **+** in an empty list): name, date, optional tag, icon, and mode - _countdown_ (D-12, D+3) or _anniversary_ (N일째,
  counting the start date as day 1).
- **Milestones** (anniversary mode): mark the 100-day steps (백일: D+100, D+200, D+300…) or month anniversaries, with
  the next one counted down. Korean day-1 counting is the default; a hidden per-item option counts from zero.
- **Icons**: click the circle to pick any image you've uploaded before (several D-days can share one; it's stored once),
  upload a new one, or use none (the first letter of the name is shown).
- **Everything coming up**: below your D-days, every upcoming calendar entry and checklist to-do counts down
  (D-x), soonest first. Past ones, daily routines and ticked entries stay out. Right-click → _달력 일정 표시 / Show
  calendar entries_ turns this off.
- **매년 반복** (every year): a birthday or anniversary counts down to its next occurrence. A Showcase's birthday is
  listed here on its own; change its name and date in the Showcase.
- Click a row to edit or delete it. **Drag a row** to reorder.
- **Filters**: the first chip cycles 전체 → 다가오는 → 지난 (all / upcoming / past); tag chips show only those tags.
- D-days and the calendar share one list: a D-day shows on its date in the calendar (📌), and every D-day widget shows
  the same countdowns. Each widget keeps its own view and filters.

### 다이어리 · Diary (4×4 / 3×3)

One page per day, saved automatically as you type.

- ‹ › flick to the previous / next day that has a page (› stops at today); **오늘** jumps back; click the date to pick
  any day. A sideways touchpad swipe also flicks pages. Arrow keys only move the text cursor.
- Lined paper; background image via right-click → _배경 이미지 설정_. Character count at the bottom.
- Pages are plain text files (`diary/2026-09-26.md`) - easy to back up or read elsewhere.

### 타이머 · Timer (3×2 / 2×2)

**타이머 (timer)**, **스톱워치 (stopwatch)** and **포모도로 (pomodoro)** are listed as three widgets. In Edit layout,
_다른 위젯으로 바꾸기_ switches between them in place; a running or paused one has to be reset first. The faces show
only the time and icon buttons (hover a button for its name); everything else is in the right-click menu.

#### Timer mode

Counts down and rings (sound + blinking) when done.

- Right-click → **빠른 시작** sets a preset time and starts it (set your own in Settings → 타이머 · 달력), or click the
  digits and type: `25` = 25 min, `1:30`, `1:00:00`.
- Scroll over the digits to add/subtract a minute. ▶ start, ❚❚ pause, ↺ reset. Up to 99 hours.
- Keeps correct time through sleep. Quitting the app (or Windows shutting down) pauses it with the time it had left.

#### Stopwatch mode

Counts up in whole seconds. Every run is kept in one shared time record, under a category: **집중 (focus)** or
**그외 (other)**; right-click → _분류_ switches it.

- ▶ start / ❚❚ stop. While running, ⚑ records a lap (right-click → _랩 기록_ lists them); when stopped, ↺ clears
  this run - the total is kept.
- **총 시간 (total)** is all the time in the stopwatch's category, from every stopwatch and pomodoro; hover the time to
  see it. Two focus stopwatches show the same focus total.
- Right-click → _총 시간 새로 세기_ counts the total from now on. Nothing is deleted from the record.
- Keeps counting through sleep. If the PC slept for a while (Settings → 타이머 · 달력 → 자리 비움 확인, 30 min by
  default) it asks whether that time counts: **포함** keeps it, **빼기** takes it out.
- Quitting the app (or Windows shutting down) stops it at that moment. If the app crashed while it ran, the next
  start asks whether that run counts.

#### Pomodoro mode

Focus blocks and breaks: 25 min 집중 (focus), 5 min 짧은 휴식, and a 15 min 긴 휴식 after every 4 focus blocks.
The pill shows the phase; hover it for the round and today's count.

- ▶ start, ❚❚ pause, ⏭ skip to the next phase, ↺ start the cycle over. It rings at the end of each phase
  (same sound settings as the timer); click the widget to stop the ringing.
- Right-click → _포모도로 설정…_: the lengths, focus blocks per long break, and starting the next phase automatically
  (on by default; the ⟳ button beside skip toggles it too).
- All focus time goes to the shared time record as focus, including a block you pause or skip partway, so every
  focus stopwatch's **총 시간** includes it.
- Keeps correct time through sleep, and asks about long sleeps during a focus block like the stopwatch does.
  Quitting the app (or Windows shutting down) pauses it.

### 메모 · Memo (3×3 / 2×2)

A sticky note that keeps whatever you write - no daily reset. Each memo widget is its own note, saved as you type.

- Paper colour: hover and click a colour dot (bottom-right), or right-click → _메모 색_: yellow, pink, green, blue,
  purple, orange, or _테마_ (the normal widget look). The theme's opacity slider also applies to the paper.
- Font and size per memo: right-click → _글꼴…_.

### 지금 재생 중 · Now Playing (4×2 / 3×1)

Shows what's playing anywhere on the PC - **YouTube** (Chrome, Edge, Whale, Firefox…), Spotify, Melon, the Media
Player app, VLC - using Windows' own media controls (the same source as the volume pop-up).

- Artwork (video thumbnails keep their 16:9 shape), title, channel/artist and which app it's from.
- Progress bar with time; **click the bar to jump** (when the site allows it - YouTube does).
- ⏮ ⏯ ⏭ control the player; buttons the player doesn't support are greyed out.
- **⇄ 2** appears when several players are open (e.g. a YouTube tab and Spotify) - click to switch which one is shown.
- Layouts: 1 row (title + play/next), 2 rows (artwork beside the text), tall (artwork on top).
- Only reads while a Now Playing widget exists; it asks Windows once a second and only redraws when something changed.
- **내 파일 · My files** (the list button) plays your own audio - voicelines, character songs, BGM. Drop audio files
  (mp3, wav, ogg, flac, m4a…, up to 30 MB each) onto it or use right-click → _트랙 추가_; files are kept in the shared
  assets folder. The list has shuffle, loop (off / all / one) and volume. Your own files show in the player like any
  other app, so ⏮ ⏯ ⏭ and the progress bar work on them too.
- Right-click → _액자 없이_ (frameless) for a narrow strip on the desktop.

### 이미지 · Image (2×2 / 1×1)

Your pictures in two layouts. Right-click → _레이아웃_ switches between **슬라이드쇼 (slideshow)** and **갤러리 (grid)**.

#### Slideshow

One picture, or a slideshow of many.

- Click or drop images onto it - several at once. Hover for controls: ‹ ❚❚ › (previous / pause / next), `3/12`,
  **＋** add more, **🗑** take the current one out of the list, _맞춤 / 채우기_ (fit / fill).
- Right-click: _슬라이드쇼 전환 간격_ (5 s – 30 min, default 10 s), _무작위_ (shuffle), _모든 사진 제거_.
- Photos crossfade (a short fade with _Reduce motion_); the slideshow pauses while the widgets are hidden.
- **Transparent images**: right-click → **액자 없이** (frameless). The widget's background and outline disappear and the
  picture switches to _fit_, so a transparent PNG / WebP / GIF / SVG sits directly on the desktop like a sticker.
  A faint dashed outline shows the widget's edge only while you hover or edit the layout.

#### Grid

A thumbnail grid for goods, figures, merch and cards.

- Drop images, click the empty grid, or right-click → add; double-click a thumbnail to label it. Click a thumbnail to
  view it full-size (Esc closes); drag it, or press Alt+arrow keys, to reorder. × deletes, with undo.
- The column count follows the widget width; frameless mode for transparent desktop display.

### 시계 · Clock (3×2 / 2×1)

The time and date in any timezone - "what time is it for my oshi right now".

- Right-click → _시간대_ to pick this computer's zone or one of the common zones (KST, JST, UTC, New York, Los Angeles,
  London, Paris); _초 표시_ shows seconds.
- The date rolls over correctly when a zone is a day ahead or behind, and daylight-saving is handled automatically.

### 쇼케이스 · Showcase (3×4 / 2×2)

A shrine card for a favourite character or person (오시 · oshi): a big image or slideshow, a name band, rotating
quotes and a birthday countdown.

- Click the image to add or change pictures; right-click sets the name, quotes, birthday, accent colour and frameless mode.
- The birthday auto-syncs as a yearly calendar entry, so it shows up in the calendar and D-day list too.
- **Export / Import data** (right-click) copies the card as JSON to share or back up.

Widgets saved by older versions as Stopwatch, Pomodoro, Audio Player or Collection open as the Timer, Now Playing or
Image widget in the matching mode. Nothing is lost.

## Customising the look

Three ways, from easiest to most flexible:

1. **Settings → 모양** (or tray → _테마…_): 3 colours, font, text size, corner radius, outline width, opacity, cell size -
   live preview. Right-click any widget → **모양 / Appearance…** for that widget only: font and size, its own surface /
   accent / text colours and opacity (unset = follow the theme; text on the accent picks black or white for contrast),
   and a **frame**. Also per-widget background images, frameless images, memo paper colours.
   - **Frames** are SVG decorations drawn over the widget's edge in the frame colour (default: the accent):
     corners, double line, stitched, beads, ornate, pixel, washi tape. Settings → _기본 테두리 장식_ sets one for every
     widget; a widget's own choice wins. **SVG 테두리 불러오기…** takes any SVG (≤ 100 KB): it's used as a 9-slice
     mask - the outer 30% on each side are the corners, the middle stretches - and only its shape matters, the colour
     comes from _장식 색_. Frames hide in high-contrast mode and on frameless images.
2. **AI themes** - describe a look in words and let any AI write the theme:
   _AI용 프롬프트 복사_ → paste into ChatGPT / Claude / Gemini and add keywords (`벚꽃, 파스텔, 둥글게`) →
   copy the whole answer → _테마 붙여넣기…_ → _테마 적용_. The app extracts the CSS, rejects answers that aren't themes,
   warns about low contrast or unsupported rules, and _테마 되돌리기_ restores the previous theme (even after a restart).
   The prompt is also in `AI_THEME_PROMPT.md` to share with others.
3. **theme.css by hand** (_테마 설정 파일…_): saving applies it instantly. Copy the file to share a theme.

### Theme format (contract v1)

Only CSS custom properties, in `:root { }` and optional `[data-widget="TYPE"] { }` blocks
(TYPE: checklist, calendar, dday, diary, memo, nowplaying, timer, stopwatch, pomodoro, image, clock, showcase, audioplayer,
collection). This set is kept stable across versions.

| variable                                     | controls                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `--c1` `--c2` `--c3`                         | surface, accent, text                                                        |
| `--on-accent`                                | text/icons on the accent colour (use a dark one for light accents)           |
| `--hol` `--sat` `--danger`                   | Sundays & holidays, Saturdays, destructive/invalid                           |
| `--line-width` `--line-style` `--line-color` | outline                                                                      |
| `--radius` `--widget-opacity` `--shadow`     | corner roundness, background solidity (wallpaper shows through), shadow/glow |
| `--widget-bg`                                | optional colour or gradient replacing the plain surface                      |
| `--font` `--font-size`                       | font list (end with `"Malgun Gothic", sans-serif`), base size                |
| `--frame-color`                              | optional: colour of the frame decorations (default = `--c2`)                 |
| `--cell` `--gap`                             | grid (changing them moves widgets)                                           |

```css
:root {
  --c1: #fff5f8;
  --c2: #c2386a;
  --c3: #3a2530;
  --on-accent: #ffffff;
  --hol: #c8324f;
  --sat: #3f6fd1;
  --danger: #c62f3b;
  --line-width: 1px;
  --line-style: solid;
  --line-color: color-mix(in srgb, var(--c2) 35%, transparent);
  --radius: 22px;
  --widget-opacity: 0.88;
  --shadow: 0 6px 18px rgb(194 56 106 / 0.18);
  --font: "Segoe UI", "Malgun Gothic", sans-serif;
  --font-size: 14px;
}
[data-widget="diary"] {
  --c1: #fbf6ea;
  --c3: #3b3024;
  --font: "Batang", "Malgun Gothic", serif;
}
```

`@import` and remote `url(...)` are stripped when a theme loads.

## config.json

Everything the settings window changes lives here, so you rarely need to open it. Open it from the tray
(_설정 파일 열기_) or Settings → 백업 · 데이터; saving applies it immediately.

```json
{
  "app": { "lang": "ko", "reduce_motion": false },
  "ui": { "weekStart": "mon", "lockLayout": false }, // appearance & accessibility keys
  "timer": {
    "presets": [
      { "label": "", "time": "1" }, // empty label = automatic ("1분")
      { "label": "라면 🍜", "time": "3" },
      { "label": "", "time": "1:30" } // 1 min 30 s; "1:00:00" = 1 hour
    ]
  },
  "holidays": {
    "country": "KR", // or "none"
    "add": { "2026-10-15": "창립기념일" }, // temporary holidays, elections, your own days off
    "remove": ["2026-05-01"]
  },
  "backup": { "auto": "off", "keep": 7, "dir": "" }, // "daily" / "weekly"; empty dir = Documents\WidgetBoard\Backups
  "archive": { "memos": false }, // the memo archive
  "update": { "check": "weekly" } // "daily" / "off"
}
```

(JSON has no comments - they're only here to explain.) The holiday table (`ui/holidays/kr.json`) comes from
python-holidays with the lunar dates cross-checked against KASI data; holidays announced later (임시공휴일,
elections after 2026) need an `add` entry.

## Files

All in `%APPDATA%\app.widgetboard.desktop\`:

| file                  | what                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `layout.json`         | widgets: id, type, name, hidden, monitor, x, y, w, h (grid cells), free (x, y, w, h px) and z (free placement), settings (memo text, slideshow list…), background, font, colours, frame |
| `config.json`         | `app` (language, reduce motion), `ui` (appearance & accessibility), timer presets, holidays, `backup`, `archive`, `update`                 |
| `settings.json`       | legacy app settings (pre-0.12); read once and merged into `config.json`                                                                    |
| `theme.css`           | the theme                                                                                                                                  |
| `data/time.json`      | the time record: one entry per stopwatch run or pomodoro focus stretch (category, start, end, time taken out) |
| `data/closed.json`    | when the app last quit properly; timers, stopwatches and pomodoros still running then stop at that moment |
| `data/events.json`    | every entry: calendar entries, D-days, showcase birthdays and checklist to-dos (shared by the calendar, checklist and D-day); holds any time, timezone, link and reminder on an entry. An older `checklist.json` is merged in once at startup (a pre-migration backup is taken first) |
| `data/bin.json`       | closed widgets waiting to be restored or erased                                                                                            |
| `data/layouts.json`   | saved layouts; `layouts_shelf.json` widgets put away by a layout; `layouts_undo.json` the arrangement before the last switch               |
| `diary/YYYY-MM-DD.md` | diary pages                                                                                                                                |
| `assets/`             | uploaded images, named by content hash (the same image is stored once)                                                                     |
| `archive/memos.jsonl` | the memo archive (only when turned on): one JSON line per saved version                                                                    |
| `updates/`            | `state.json` (last check, found and skipped versions); `pending.exe` + `pending.json` during an install                                    |

Backups go to `Documents\WidgetBoard\Backups\WidgetBoard-backup-YYYYMMDD-HHMM[-auto|-pre-restore]\`.

## When something goes wrong

- A save that fails (disk full, folder locked) shows a message; the diary keeps your text and retries.
- A widget that can't load, or an unknown widget type, shows a note instead of breaking the board - right-click → 닫기.
- Closed something by mistake: _되돌리기_ in the message, or Settings → 위젯 · 배치 → closed widgets.
- Lost more than that: Settings → 백업 · 데이터 → restore a backup (your current state is snapshotted first).
- Damaged or hand-edited `layout.json` / `events.json` values are repaired on load; a broken
  `theme.css` value such as `--cell: abc` falls back to a safe default.
- A change from another widget or monitor never wipes something you're halfway through typing.

## Updates

WidgetBoard looks for a new version **once a week** (Settings → 정보 · 업데이트: weekly · daily · off; or
_지금 확인_, or tray → _업데이트 확인_). The first look is 3 minutes after start, never during startup.

- A check reads only a small `latest.json`. Nothing is downloaded or installed until you choose to.
- When there is a new version, a toast appears on the board and _업데이트 있음_ shows at the bottom of the tray menu.
  Both open Settings → 정보 · 업데이트 with the release notes and three choices:
  - _v… 설치 및 재시작_ backs up your data, downloads the new exe, checks it, and restarts into it.
  - _나중에_ closes the window. You're reminded at the next check.
  - _이 버전 건너뛰기_ stays quiet about that version. A newer one is shown again.
- Every download is **checked against the release key built into the app**. An exe that isn't signed for exactly
  that version, or is older than yours, is thrown away. Only `https://` addresses are used.
- The old exe is kept as `WidgetBoard.exe.old` until the new one is running. It's put back if the swap fails, for
  example in a read-only folder. You're told, and you keep the current version.
- Your widgets, notes and settings live in `%APPDATA%` and are not touched by an update.
- Releases come from this repo's GitHub Releases. The address is built into the app, so `config.json` can't change it.

## Languages

Korean is the default; English lives in `ui/locales/en/` (also the fallback for missing keys).
Each language is a folder of small flat files: `native.json` (tray and window titles), `common.json`, one per window
(`board`, `settings`, `library`) and `widgets/<widget>.json`.
Keys are flat (`"timer.start": "시작"`), `{n}` is a placeholder, `_name` is the name shown in the Language menu.
To add a language: copy `ui/locales/en/` to `ui/locales/<code>/`, translate, and add its `native.json` to `LOCALES` in `src-tauri/src/main.rs`.
Notes for translators go in `ui/locales/context/` (same file names); keys listed in its `_legacy.json` have none yet.

## Developing

**Add a widget type**

1. `ui/widgets/<name>.js` exports `{ size, min, defaults, css, mount(root, settings, api) }`; `mount` may return
   `{ destroy, resized, menu, summary }` (`summary()` returns one line of plain text for screen readers and the overview). `api` offers `save, t, lang, toast, store.get/set, onStore, diary.*, config, onConfig, onDayChange,
pickImage(s), uploadImage, assetUrl, listAssets, requestSize, size, reduceMotion, setInteracting, wheelScrollX,
setFrameless, on(event), media.subscribe/control, announce, alert(title, body)` (`alert` = the user's opted-in
   flash / Windows notification; sound stays the widget's job). Shared parts: `icon(name)` from `ui/icons.js`,
   `dropZone` from `ui/util.js`, and the tokens on `.widget` in `base.css` (`--text-muted`, `--space-*`, `--fs-*`).
2. Register it in `REGISTRY` (`ui/app.js`) and `WIDGETS` (`src-tauri/src/main.rs`); add `widget.<name>` to `native.json` and its other strings to `widgets/<name>.json`, in both languages.

**Build (Windows)**

```powershell
winget install Rustlang.Rustup          # plus "Desktop development with C++" build tools if missing
cd src-tauri
cargo build --release                   # -> target\release\widgetboard.exe
```

**Try the UI in a browser**: `python -m http.server 8765 --directory ui`; a mock backend kicks in
(`__mock.emit('add-widget','timer')` in the console adds widgets, `?lang=en` switches language). The settings
window is `settings.html` and has its own mock.

**Publish a release (auto-update)** - once, `node tools/release.mjs keygen` makes the release key
(private key → `~/.widgetboard/updater.key`, public key → `src-tauri/updater.pub`, compiled into the app; builds with a
different public key refuse your updates). The private key is encrypted with a passphrase, asked for at each signing.
A key made before that is upgraded once with `node tools/release.mjs encrypt`. For every release:

1. bump `version` in `src-tauri/Cargo.toml` and `tauri.conf.json`, commit, and build;
2. `node tools/release.mjs sign target\release\widgetboard.exe --version 0.12.1 --notes "what changed"` writes
   `latest.json` next to the exe;
3. create a GitHub release tagged `v0.12.1` and upload `latest.json` and the exe, renamed to `WidgetBoard.exe`.
   Builds check `https://github.com/104-bookwyrm/WidgetBoard/releases/latest/download/latest.json`. A fork builds with
   `WIDGETBOARD_UPDATE_URL=<its own>`.
   `node tools/release.mjs verify latest.json WidgetBoard.exe` checks a release the way the app will.
   Updater logic tests (no Windows needed): `bash tools/updater-test/run.sh` (44 checks: signatures, relabelled or
   foreign-key releases, downgrades, http, tampered downloads, the exe swap and rollback).

**Tests**: a small set, kept short on purpose (about 30 s). `tests/smoke.mjs` checks the bugs that keep coming
back: every widget type mounts, a save survives a reload, grid and free moves, the time record, stopping on close,
the timer ringing, the Settings and widget menu windows opening, and both languages having the same keys. It never
checks displayed text, so copy can change freely. Anything else is debugged when it breaks.
Run `npm install`, `npx playwright install chromium`, then `npm test`. The tests serve UI files through Playwright
without a background server. Set `PW_CHROMIUM` to use another Chromium executable. Rust unit tests (`cargo test`
in `src-tauri`): backup/restore round trip, the v0.12 config migration, and image clean-up when erasing from the bin.

`tests/persistence.mjs` covers layout content preservation, editor flushes, shared checklist edits and diary save
failures. Both pages use `ui/mock-tauri.js` in browser tests. The runner reads the version and default config from
the native sources. Shared widget types come from `ui/widgets/index.js`; a contract test checks the native list.
Screenshots, logs and test fixtures go in the gitignored root `test-artifacts/` directory.
