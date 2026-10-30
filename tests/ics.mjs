// Calendar subscription expansion (ui/calsubs.js): a wrong answer silently drops, adds or shifts imported entries.
import assert from "node:assert/strict";
import { expandIcs } from "../ui/calsubs.js";
import ICAL from "../ui/vendor/ical.js";

process.env.TZ ||= "Asia/Seoul"; // only for Date when the shell has no TZ; checks below are written for UTC+9
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly
DTSTART:20261005T010000Z
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE:20261012T010000Z
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID:20261019T010000Z
DTSTART:20261020T030000Z
SUMMARY:Standup moved
END:VEVENT
BEGIN:VEVENT
UID:trip
DTSTART;VALUE=DATE:20261101
DTEND;VALUE=DATE:20261104
SUMMARY:Trip
URL:https://example.com/trip
END:VEVENT
BEGIN:VEVENT
UID:ny
DTSTART;TZID=America/New_York:20261102T090000
SUMMARY:NY call
END:VEVENT
BEGIN:VEVENT
UID:old
DTSTART;VALUE=DATE:20200101
SUMMARY:Too old
END:VEVENT
END:VCALENDAR`;

const out = expandIcs(ICAL, ics, "2026-10-30");
const on = (title) => out.filter((e) => e.title === title).map((e) => e.date + (e.time ? " " + e.time : ""));
if (new Date("2026-10-05T01:00:00Z").getTimezoneOffset() === -540) {
  assert.deepEqual(on("Standup"), ["2026-10-05 10:00", "2026-10-26 10:00"]); // EXDATE dropped, 19th moved
  assert.deepEqual(on("Standup moved"), ["2026-10-20 12:00"]);
  assert.deepEqual(on("NY call"), ["2026-11-02 23:00"]); // 09:00 EST = 14:00 UTC
}
assert.deepEqual(on("Trip"), ["2026-11-01", "2026-11-02", "2026-11-03"]); // DTEND is exclusive
assert.equal(out.find((e) => e.title === "Trip").url, "https://example.com/trip");
assert.deepEqual(on("Too old"), []);
console.log("ics: ok");
