import timer from "./timer.js";
import image from "./image.js";
import dday from "./dday.js";
import checklist from "./checklist.js";
import stopwatch from "./stopwatch.js";
import pomodoro from "./pomodoro.js";
import memo from "./memo.js";
import nowplaying from "./nowplaying.js";
import calendar from "./calendar.js";
import diary from "./diary.js";
import showcase from "./showcase.js";
import clock from "./clock.js";

export default {
  checklist,
  calendar,
  dday,
  diary,
  memo,
  nowplaying,
  timer,
  stopwatch,
  pomodoro,
  image,
  showcase,
  // old saved Audio Player widgets keep type "audioplayer"; they open as Now Playing with the file list showing
  audioplayer: { ...nowplaying, size: { w: 2, h: 2 }, min: { w: 2, h: 1 }, defaults: { ...nowplaying.defaults, list: true } },
  // old saved Collection widgets keep type "collection"; they open as the Image widget in grid layout
  collection: { ...image, defaults: { ...image.defaults, layout: "grid" } },
  clock,
};
