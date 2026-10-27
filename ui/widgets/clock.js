// Clock: the current time and date in a chosen timezone — "what time is it for my oshi right now".
// Pick from the common zones or your own (Settings time zone, else this computer's); the date shows the day roll-over across zones.
import { TZ_COMMON, tzLabel, osZone, formatTime, TIME_FORMATS, dateOpts, DATE_STYLES, dateStyleSample } from "../util.js";

export default {
  size: { w: 3, h: 2 },
  min: { w: 2, h: 1 },
  // tz "" = the viewer's zone (Settings, else the OS), fixed on first mount; formats null = follow Settings
  defaults: { tz: "", seconds: false, timeFormat: null, dateFormat: null },
  css: `
    .clk { position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 2cqh; box-sizing: border-box; padding: var(--head-h) var(--pad) var(--pad); }
    .clk-time { font-weight: 600; font-family: var(--font-num, var(--font)); font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap;
      font-size: min(calc(150cqw / var(--len, 5)), 42cqh); }
    .clk-sub { font-size: var(--fs-small); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 100%; text-align: center; }
    @container (max-height: 5em) { .clk-sub { display: none; } }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    const here = () => api.config?.ui?.currentTz || osZone(); // the viewer's zone, as app.js currentTz()
    if (typeof s.tz !== "string" || !s.tz) s.tz = here();
    s.seconds = !!s.seconds;

    root.innerHTML = `<div class="clk"><div class="clk-time"></div><div class="clk-sub"></div></div>`;
    const timeEl = root.querySelector(".clk-time");
    const subEl = root.querySelector(".clk-sub");

    const zoneLabel = (z) => (z === here() ? t("clock.here") : tzLabel(z));
    // this clock's own format, else the app's (Settings › 일반)
    const pref = (k) => s[k] ?? api.config?.ui?.[k] ?? "";
    const timeText = (when, opts) => formatTime(lang, when, { timeZone: s.tz, ...opts }, pref("timeFormat"));
    let tick;

    function render() {
      const now = new Date();
      const time = timeText(now, { hour: "numeric", minute: "2-digit", ...(s.seconds ? { second: "2-digit" } : {}) });
      const date = new Intl.DateTimeFormat(
        lang,
        dateOpts({ timeZone: s.tz, weekday: "short", month: "short", day: "numeric" }, pref("dateFormat")),
      ).format(now);
      timeEl.textContent = time;
      timeEl.style.setProperty("--len", Math.max(5, time.length));
      subEl.textContent = `${date} · ${zoneLabel(s.tz)}`;
    }
    function loop() {
      clearInterval(tick);
      tick = setInterval(render, 1000); // every second: cheap, and the minute flips on time
    }

    render();
    loop();

    return {
      destroy: () => clearInterval(tick),
      resized: () => {},
      summary: () => {
        const time = timeText(new Date(), { hour: "numeric", minute: "2-digit" });
        return `${time} · ${zoneLabel(s.tz)}`;
      },
      menu: () => [
        {
          text: t("clock.zone"),
          items: [here(), ...TZ_COMMON.filter((z) => z !== here())].map(
            (z) => ({
              text: (s.tz === z ? "✓ " : "") + zoneLabel(z),
              action: () => {
                s.tz = z;
                api.save();
                render();
              },
            }),
          ),
        },
        {
          text: t("fmt.time"),
          items: [null, ...TIME_FORMATS.slice(1)].map((v) => ({
            text: (s.timeFormat === v ? "✓ " : "") + t(v ? `fmt.h${v}` : "fmt.follow"),
            action: () => {
              s.timeFormat = v;
              api.save();
              render();
            },
          })),
        },
        {
          text: t("fmt.date"),
          items: [null, ...DATE_STYLES].map((v) => ({
            text: (s.dateFormat === v ? "✓ " : "") + (v === null ? t("fmt.follow") : dateStyleSample(lang, v)),
            action: () => {
              s.dateFormat = v;
              api.save();
              render();
            },
          })),
        },
        {
          text: (s.seconds ? "✓ " : "") + t("clock.seconds"),
          action: () => {
            s.seconds = !s.seconds;
            api.save();
            loop();
            render();
          },
        },
      ],
    };
  },
};
