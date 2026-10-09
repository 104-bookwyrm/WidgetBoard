// Clock: the current time and date in a chosen timezone — "what time is it for my oshi right now".
// Pick from the common zones or this computer's own; the date shows the day roll-over across zones.
import { TZ_COMMON, TZ_BASELINE, tzLabel, osZone } from "../util.js";

export default {
  size: { w: 3, h: 2 },
  min: { w: 2, h: 1 },
  defaults: { tz: TZ_BASELINE, seconds: false },
  css: `
    .clk { position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 2cqh; box-sizing: border-box; padding: var(--head-h) var(--pad) var(--pad); }
    .clk-time { font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap;
      font-size: min(calc(150cqw / var(--len, 5)), 42cqh); }
    .clk-sub { font-size: .85em; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 100%; text-align: center; }
    @container (max-height: 5em) { .clk-sub { display: none; } }
  `,
  mount(root, s, api) {
    const { t, lang } = api;
    if (typeof s.tz !== "string" || !s.tz) s.tz = TZ_BASELINE;
    s.seconds = !!s.seconds;

    root.innerHTML = `<div class="clk"><div class="clk-time"></div><div class="clk-sub"></div></div>`;
    const timeEl = root.querySelector(".clk-time");
    const subEl = root.querySelector(".clk-sub");

    const zoneLabel = (z) => (z === osZone() ? t("clock.here") : tzLabel(z));
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
          items: [osZone(), ...TZ_COMMON.filter((z) => z !== osZone())].map(
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
