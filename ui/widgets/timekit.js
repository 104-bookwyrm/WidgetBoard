// Helpers shared by the Timer widget's three modes (timer, stopwatch, pomodoro) and the Library.
export const p2 = (n) => String(n).padStart(2, "0");

export const fmt = (ms) => {
  const t = Math.ceil(ms / 1000);
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
};
export function fmtTotal(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return `${h}:${p2(m)}:${p2(s)}`;
}

let audio;
/** Create/resume the shared AudioContext; call it during a click (autoplay rules). */
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    audio.resume?.();
  } catch {}
}
/** volume 0–1 (Settings → 타이머 소리). */
export function beep(volume = 0.6) {
  if (!(volume > 0)) return;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const d of [0, 0.18, 0.36]) {
      const o = audio.createOscillator(),
        g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.42 * volume, t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.14);
      o.connect(g).connect(audio.destination);
      o.start(t + d);
      o.stop(t + d + 0.16);
    }
  } catch {}
}
