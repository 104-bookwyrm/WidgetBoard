// Repeat rules in util.js occursOn: a wrong answer silently drops or adds calendar entries and reminders.
import assert from "node:assert/strict";
import { occursOn, setWeekStart } from "../ui/util.js";

const on = (e, d) => occursOn({ date: "2026-01-05", ...e }, d); // 2026-01-05 is a Monday
setWeekStart("sun");

// every N
assert.equal(on({ repeat: "daily", every: 3 }, "2026-01-08"), true);
assert.equal(on({ repeat: "daily", every: 3 }, "2026-01-07"), false);
assert.equal(on({ repeat: "weekly", every: 2 }, "2026-01-19"), true);
assert.equal(on({ repeat: "weekly", every: 2 }, "2026-01-12"), false);
assert.equal(on({ repeat: "monthly", every: 2 }, "2026-03-05"), true);
assert.equal(on({ repeat: "monthly", every: 2 }, "2026-02-05"), false);
assert.equal(on({ repeat: "yearly", every: 2 }, "2028-01-05"), true);
assert.equal(on({ repeat: "yearly", every: 2 }, "2027-01-05"), false);

// weekdays: Mon + Wed every 2 weeks stay in the same calendar week
const mw = { repeat: "weekly", days: [1, 3], every: 2 };
assert.equal(on(mw, "2026-01-07"), true); // Wed, week 0
assert.equal(on(mw, "2026-01-14"), false); // Wed, week 1
assert.equal(on(mw, "2026-01-21"), true); // Wed, week 2
assert.equal(on({ repeat: "weekly", days: [2] }, "2026-01-05"), false); // start day not a chosen weekday

// end date
assert.equal(on({ repeat: "daily", until: "2026-01-10" }, "2026-01-10"), true);
assert.equal(on({ repeat: "daily", until: "2026-01-10" }, "2026-01-11"), false);

// lunar yearly: 2026-02-17 is lunar 1/1 (Seollal); 2027's is 2027-02-07
const seollal = { date: "2026-02-17", repeat: "yearly", lunar: true };
assert.equal(occursOn(seollal, "2027-02-07"), true);
assert.equal(occursOn(seollal, "2027-02-17"), false);
// a regular-month date never lands in the leap month: 2025 had 윤6월 (2025-07-25 = 윤6/1)
const june1 = { date: "2024-07-06", repeat: "yearly", lunar: true }; // lunar 6/1
assert.equal(occursOn(june1, "2025-06-25"), true);
assert.equal(occursOn(june1, "2025-07-25"), false);

console.log("PASS recurrence rules");
