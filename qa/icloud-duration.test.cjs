'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskToIcloudIcs, parseIcloudEvent } = require('../main/icloud-ics.cjs');

const calendar = { name: 'QA Calendar', url: 'https://qa.invalid/calendar/' };

function durationEvent() {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:native-duration',
    'DTSTAMP:20260901T010203Z',
    'SUMMARY:Duration event',
    'DTSTART:20260910T090000',
    'DURATION:PT1H',
    'DESCRIPTION:Keep duration representation',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function taskFromRaw(overrides = {}) {
  const parsed = parseIcloudEvent(durationEvent(), '/qa/duration.ics', '"1"', calendar);
  return {
    id: 'icloud-native-duration',
    itemType: 'event',
    title: parsed.title,
    projectId: 'apple-calendar',
    dueDate: parsed.dueDate,
    time: parsed.time,
    endDate: parsed.endDate,
    endTime: parsed.endTime,
    completed: false,
    eventColor: parsed.eventColor,
    updatedAt: Date.parse('2026-09-14T03:45:00Z'),
    icloudRawIcs: parsed.rawIcs,
    ...overrides,
  };
}

test('DURATION event keeps DURATION and does not gain DTEND for non-schedule edits', () => {
  const updated = taskToIcloudIcs(taskFromRaw({ title: 'Renamed in Luma' }), 'native-duration');
  assert.ok(updated.includes('SUMMARY:Renamed in Luma'));
  assert.ok(updated.includes('DURATION:PT1H'));
  assert.ok(updated.includes('DESCRIPTION:Keep duration representation'));
  assert.equal(/^DTEND(?:;|:)/m.test(updated), false);
});

test('DURATION event refuses schedule rewrites rather than adding conflicting DTEND', () => {
  const moved = taskFromRaw({ time: '10:00', endTime: '' });
  assert.throws(
    () => taskToIcloudIcs(moved, 'native-duration'),
    (error) => error.code === 'ICLOUD_COMPLEX_SCHEDULE_EDIT'
  );
});
