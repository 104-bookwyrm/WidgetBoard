// Clock: the current time and date in a chosen timezone — "what time is it for my oshi right now".
// Pick from the common zones or your own (Settings time zone, else this computer's); the date shows the day roll-over across zones.
import { TZ_COMMON, tzLabel, osZone } from "../util.js";

export default {
  size: { w: 3, h: 2 },
  min: { w: 2, h: 1 },
  defaults: { tz: "", seconds: false }, // "" = the viewer's zone (Settings, else the OS), fixed on first mount
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
    let tick;

    function render() {
      const now = new Date();
      const time = new Intl.DateTimeFormat(lang, {
        timeZone: s.tz,
        hour: "numeric",
        minute: "2-digit",
        ...(s.seconds ? { second: "2-digit" } : {}),
      }).format(now);
      const date = new Intl.DateTimeFormat(lang, {
        timeZone: s.tz,
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(now);
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
        const time = new Intl.DateTimeFormat(lang, {
          timeZone: s.tz,
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date());
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
