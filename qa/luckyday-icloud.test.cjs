"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { luckyDayMarkerIcs, markerUid, markerKey } = require("../main/luckyday-icloud.cjs");

test("LuckyDay iCloud marker is an all-day transparent event", () => {
  const mark = { dateKey: "2026-09-17", type: "cheng", label: "成日" };
  const ics = luckyDayMarkerIcs(mark, Date.UTC(2026, 8, 1));
  assert.match(ics, /SUMMARY:成日/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260917/);
  assert.match(ics, /DTEND;VALUE=DATE:20260918/);
  assert.match(ics, /TRANSP:TRANSPARENT/);
  assert.match(ics, /X-LUMA-LUCKYDAY:TRUE/);
  assert.match(ics, /X-LUMA-LUCKYDAY-TYPE:cheng/);
  assert.equal(markerUid(mark), "luckyday-cheng-2026-09-17@luma-todo");
});

test("LuckyDay marker key is stable", () => {
  assert.equal(markerKey({ luckyDayType: "chu", luckyDayDate: "2026-09-20" }), "chu|2026-09-20");
  assert.equal(markerKey({ type: "cheng", dateKey: "2026-09-17" }), "cheng|2026-09-17");
});
