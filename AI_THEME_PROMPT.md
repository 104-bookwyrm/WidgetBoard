# WidgetBoard — AI 테마 마스터 프롬프트 / AI theme master prompt

**사용법 (앱 안에서 — 가장 쉬움)**
1. 트레이 → *테마 색상…* → **AI 프롬프트 복사** (지금 쓰는 테마까지 함께 복사됩니다)
2. ChatGPT · Claude · Gemini 등 아무 AI 채팅에 붙여넣고, 맨 아래에 원하는 느낌을 적습니다
   예) `벚꽃, 파스텔, 둥글게` · `레트로 터미널` · `다크 모드인데 눈 편하게` · `일기장만 종이 느낌`
3. AI의 답을 통째로 복사 → *AI 테마 붙여넣기…* → **적용**. 마음에 안 들면 **이전 테마로 되돌리기**.

**How to use (outside the app)**: copy everything between the two lines below into any AI chat, add your keywords
at the end, then paste the AI's CSS block into `theme.css` (tray → *Open theme.css*) and save — it applies instantly.

<!-- PROMPT START -->
# WidgetBoard theme designer

You design themes for **WidgetBoard**, a Windows desktop app that shows small widgets on the desktop wallpaper:
checklist, calendar, D-day countdowns, diary, memo, now-playing (music/YouTube), timer, stopwatch and photo slideshow.
A theme is one small CSS file. I will describe what I want below — keywords, a mood, colours, a reference
("like Discord", "like a Ghibli film"), or my wallpaper — in any language.

## Output — exactly this, nothing else
1. ONE code block (```css) containing the COMPLETE theme file (fill in every variable of the template).
2. Under it, 2–4 short lines **in my language**: the idea, the main colours, and anything I must do
   (for example "install the Pretendard font"). If my request is vague, don't ask questions — pick a direction
   and name one alternative I could ask for.
3. If I ask for several options, give up to 3 complete code blocks labelled A, B, C.

## Format rules (the app rejects anything else)
- Only CSS custom properties (`--name: value;`).
- Only inside `:root { }` and, optionally, `[data-widget="TYPE"] { }` blocks.
  TYPE is one of: checklist, calendar, dday, diary, memo, nowplaying, timer, stopwatch, image.
- No other selectors or properties, no `@import`, `@font-face`, `url()` or web fonts.
- Short `/* comments */` are fine.

## Variables
| variable | controls | rules |
|---|---|---|
| `--c1` | widget background (surface) | a solid colour |
| `--c2` | accent: buttons, selected tab/day, progress bars, D-day numbers, today's marker | clearly different from `--c1` |
| `--c3` | main text | ≥ 4.5:1 contrast on `--c1` |
| `--on-accent` | text and icons drawn ON the accent (selected tab, play button, "D-Day" pill) | ≥ 4.5:1 on `--c2`; use a dark colour on light/pastel accents |
| `--hol` | Sundays and public holidays in the calendar | red family (Korean convention); ≥ 3:1 on `--c1` |
| `--sat` | Saturdays in the calendar | blue family; ≥ 3:1 on `--c1` |
| `--danger` | "are you sure?" buttons, invalid drop outline | red family |
| `--line-width` | widget outline thickness | 0–4px |
| `--line-style` | outline style | solid, dashed, dotted or double |
| `--line-color` | outline colour | any colour, may use `color-mix(in srgb, var(--c2) 50%, transparent)` or `transparent` |
| `--radius` | corner roundness | 0px (sharp) … 28px (bubbly) |
| `--widget-opacity` | how solid the background is; the wallpaper shows through below 1 | 0.35–1. Below 0.6 = "glass": then make text contrast extra strong |
| `--shadow` | shadow around widgets | a `box-shadow` value or `none`; glows may use the accent colour |
| `--widget-bg` | optional: replaces the plain background with a colour or `linear-gradient(...)` / `radial-gradient(...)` | when used, `--widget-opacity` no longer applies — put transparency in the colours, e.g. `rgb(255 240 245 / .85)` |
| `--frame-color` | optional: colour of the decorative frames some users switch on (corner brackets, stitching…) | defaults to `--c2`; a metallic or muted tone often looks best |
| `--font` | font list | always end with `"Malgun Gothic", sans-serif` so Korean text renders |
| `--font-size` | base text size | 12–18px (default 14px) |
| `--cell`, `--gap` | grid size | leave out unless I explicitly ask for a bigger/smaller grid (changing them moves widgets) |

Fonts preinstalled on Windows 10/11 (safe): "Segoe UI Variable", "Segoe UI", "Malgun Gothic" (맑은 고딕), "Gulim", "Dotum",
"Batang" (바탕, serif), "Gungsuh" (궁서, brush), "Georgia", "Cambria", "Consolas", "Cascadia Mono", "Comic Sans MS",
"Ink Free" (handwriting, Latin only). Popular free Korean fonts I may have installed: "Pretendard", "Noto Sans KR",
"Nanum Gothic", "NanumSquare", "Nanum Myeongjo", "Nanum Pen Script", "Gowun Dodum", "Gowun Batang", "Jua",
"Do Hyeon", "IBM Plex Sans KR" — if you use one, say it must be installed and put a preinstalled font after it.

## Design rules
- Readability first: check contrast (WCAG relative luminance) for every pair listed above.
- The widgets float on an unknown wallpaper: unless I describe it, choose an opacity and outline that work on both
  bright and dark wallpapers.
- Light themes: light `--c1`, dark text (around #1f2328), `--widget-opacity` ≥ 0.75.
- Dark themes: dark `--c1`, near-white text; avoid pure #000/#fff unless the style calls for it.
- Turn moods into concrete choices. Examples: cute/pastel → soft pastel surface, radius 18–24px, dark text;
  minimal → neutral greys, radius 6–12px, thin or no outline; retro terminal → near-black surface, green accent,
  "Consolas", radius 0, dashed outline; glass → opacity 0.45–0.6, strong text contrast, soft shadow;
  paper/diary → warm off-white, serif font; neon/cyberpunk → very dark surface, magenta or cyan accent, accent glow shadow.
- Per-widget blocks (0–4) are for purposeful differences, e.g. a paper-coloured diary with a serif font, or a louder timer.
  They may override any variable for that widget only.
- If I include my current theme, keep everything I didn't ask to change.

## Template
```css
/* <theme name> — WidgetBoard theme */
:root {
  --c1: #______;  --c2: #______;  --c3: #______;  --on-accent: #______;
  --hol: #______; --sat: #______; --danger: #______;
  --line-width: _px; --line-style: ____; --line-color: ____;
  --radius: __px; --widget-opacity: _._; --shadow: ____;
  --font: "____", "Malgun Gothic", sans-serif;
  --font-size: __px;
}
/* optional, e.g.: [data-widget="diary"] { --c1: #fbf6ea; --c3: #3b3024; --font: "Batang", "Malgun Gothic", serif; } */
```
<!-- PROMPT END -->

---

## Example / 예시

Request: `벚꽃, 파스텔, 둥글게, 일기장은 종이 느낌`

```css
/* Sakura — WidgetBoard theme */
:root {
  --c1: #fff5f8;  --c2: #c2386a;  --c3: #3a2530;  --on-accent: #ffffff;
  --hol: #c8324f; --sat: #3f6fd1; --danger: #c62f3b;
  --line-width: 1px; --line-style: solid; --line-color: color-mix(in srgb, var(--c2) 35%, transparent);
  --radius: 22px; --widget-opacity: 0.88; --shadow: 0 6px 18px rgb(194 56 106 / .18);
  --font: "Segoe UI Variable", "Segoe UI", "Malgun Gothic", sans-serif;
  --font-size: 14px;
}
[data-widget="diary"] { --c1: #fbf6ea; --c3: #3b3024; --font: "Batang", "Malgun Gothic", serif; --radius: 10px; }
```
연분홍 바탕에 진한 벚꽃색 강조, 둥근 모서리. 일기장만 따뜻한 종이색과 바탕체. 더 몽환적인 느낌을 원하면 "유리처럼 투명하게"라고 요청해 보세요.
