'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskToIcloudIcs, parseIcloudEvent, parseIcloudEventIdentity } = require('../main/icloud-ics.cjs');

const calendar = { name: 'QA Calendar', url: 'https://qa.invalid/calendar/' };
const fixedUpdatedAt = Date.parse('2026-09-05T00:00:00Z');

function baseTask(overrides = {}) {
  return {
    id: 'qa-task',
    title: 'QA task',
    projectId: 'inbox',
    dueDate: '2026-09-05',
    time: '',
    endDate: '',
    endTime: '',
    itemType: 'todo',
    completed: false,
    updatedAt: fixedUpdatedAt,
    createdAt: fixedUpdatedAt,
    order: 1,
    ...overrides,
  };
}

test('timed Todo keeps Todo metadata and round-trips its local schedule', () => {
  const task = baseTask({
    id: 'qa-timed-todo',
    title: 'QA, Todo; path\\line',
    time: '09:30',
  });
  const ics = taskToIcloudIcs(task, 'qa-timed-todo@luma');

  assert.match(ics, /X-LUMA-ITEM-TYPE:todo/);
  assert.match(ics, /X-LUMA-COMPLETED:false/);
  assert.ok(ics.includes('SUMMARY:□ QA\\, Todo\\; path\\\\line'));

  const parsed = parseIcloudEvent(ics, '/qa/todo.ics', '"todo-etag"', calendar);
  assert.equal(parsed.lumaItemType, 'todo');
  assert.equal(parsed.lumaTaskId, task.id);
  assert.equal(parsed.dueDate, task.dueDate);
  assert.equal(parsed.time, task.time);
  assert.equal(parsed.endDate, task.dueDate);
  assert.equal(parsed.endTime, '10:00');
});

test('completed Todo exports completed metadata and summary prefix', () => {
  const task = baseTask({ id: 'qa-completed', title: 'Done', completed: true, time: '11:00' });
  const ics = taskToIcloudIcs(task, 'qa-completed@luma');

  assert.ok(ics.includes('SUMMARY:✓ Done'));
  assert.ok(ics.includes('X-LUMA-COMPLETED:true'));

  const parsed = parseIcloudEvent(ics, '/qa/completed.ics', '"done-etag"', calendar);
  assert.equal(parsed.lumaCompleted, true);
  assert.equal(parsed.lumaItemType, 'todo');
});

test('all-day multi-day Event uses exclusive ICS end and restores inclusive Luma end', () => {
  const task = baseTask({
    id: 'qa-all-day-event',
    title: 'All day',
    itemType: 'event',
    dueDate: '2026-09-05',
    endDate: '2026-09-07',
    eventColor: '#91a9c7',
  });
  const ics = taskToIcloudIcs(task, 'qa-all-day-event@luma');

  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260905'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20260908'));
  assert.ok(ics.includes('X-LUMA-ITEM-TYPE:event'));

  const parsed = parseIcloudEvent(ics, '/qa/all-day.ics', '"event-etag"', calendar);
  assert.equal(parsed.dueDate, '2026-09-05');
  assert.equal(parsed.endDate, '2026-09-07');
  assert.equal(parsed.time, '');
  assert.equal(parsed.endTime, '');
  assert.equal(parsed.eventColor, '#91a9c7');
});

test('overnight Event round-trips start and end dates and times', () => {
  const task = baseTask({
    id: 'qa-overnight',
    itemType: 'event',
    dueDate: '2026-09-05',
    endDate: '2026-09-06',
    time: '23:30',
    endTime: '01:00',
    eventColor: '#8b6ef5',
  });
  const ics = taskToIcloudIcs(task, 'qa-overnight@luma');
  const parsed = parseIcloudEvent(ics, '/qa/overnight.ics', '"overnight-etag"', calendar);

  assert.equal(parsed.dueDate, task.dueDate);
  assert.equal(parsed.time, task.time);
  assert.equal(parsed.endDate, task.endDate);
  assert.equal(parsed.endTime, task.endTime);
  assert.equal(parsed.eventColor, task.eventColor);
});

test('native Apple all-day Event parses without Luma linkage metadata', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:native-apple-event',
    'SUMMARY:Native Apple Event',
    'DTSTART;VALUE=DATE:20260910',
    'DTEND;VALUE=DATE:20260912',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  const parsed = parseIcloudEvent(ics, '/qa/native.ics', '"native-etag"', calendar);
  assert.equal(parsed.uid, 'native-apple-event');
  assert.equal(parsed.lumaTaskId, '');
  assert.equal(parsed.lumaItemType, '');
  assert.equal(parsed.dueDate, '2026-09-10');
  assert.equal(parsed.endDate, '2026-09-11');
  assert.equal(parsed.rawIcs, ics);
});


test('identity survives unsupported or cancelled VEVENT without DTSTART', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:cancelled-instance',
    'SUMMARY:Cancelled occurrence',
    'RECURRENCE-ID:20260910T100000Z',
    'STATUS:CANCELLED',
    'X-LUMA-TASK-ID:qa-linked',
    'X-LUMA-ITEM-TYPE:event',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  assert.equal(parseIcloudEvent(ics, '/qa/cancelled.ics', '"1"', calendar), null);
  assert.deepEqual(parseIcloudEventIdentity(ics), {
    uid: 'cancelled-instance',
    title: 'Cancelled occurrence',
    lumaTaskId: 'qa-linked',
    lumaItemType: 'event',
    extensionProperties: {},
  });
});

test('Extension marker identity stays separate from normal Luma items', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:example-cheng-2026-09-17@luma-todo',
    'SUMMARY:Example mark',
    'DTSTART;VALUE=DATE:20260917',
    'DTEND;VALUE=DATE:20260918',
    'TRANSP:TRANSPARENT',
    'X-LUMA-EXAMPLE:TRUE',
    'X-LUMA-EXAMPLE-TYPE:cheng',
    'X-LUMA-EXAMPLE-DATE:2026-09-17',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  const parsed = parseIcloudEvent(ics, '/qa/example.ics', '"ld"', calendar);
  assert.equal(parsed.extensionProperties['X-LUMA-EXAMPLE'], 'TRUE');
  assert.equal(parsed.extensionProperties['X-LUMA-EXAMPLE-TYPE'], 'cheng');
  assert.equal(parsed.extensionProperties['X-LUMA-EXAMPLE-DATE'], '2026-09-17');
  assert.equal(parsed.lumaTaskId, '');
});

test('editing a simple Apple event preserves unmodeled properties, folding and VALARM', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iCal 7.0//EN',
    'BEGIN:VEVENT',
    'UID:native-rich',
    'DTSTAMP:20260901T010203Z',
    'SUMMARY:Original title',
    'DTSTART;VALUE=DATE:20260910',
    'DTEND;VALUE=DATE:20260912',
    'DESCRIPTION:First part of a description that Apple folded for transport',
    ' and this continuation must stay exactly folded',
    'LOCATION:Board Room',
    'ATTENDEE;CN=Alice:mailto:alice@example.com',
    'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder text',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  const parsed = parseIcloudEvent(ics, '/qa/native-rich.ics', '"1"', calendar);
  const task = baseTask({
    id: 'icloud-native-rich',
    itemType: 'event',
    title: 'Renamed in Luma',
    dueDate: parsed.dueDate,
    endDate: parsed.endDate,
    time: parsed.time,
    endTime: parsed.endTime,
    eventColor: parsed.eventColor,
    icloudRawIcs: parsed.rawIcs,
    updatedAt: Date.parse('2026-09-14T03:30:00Z'),
  });

  const updated = taskToIcloudIcs(task, parsed.uid);
  assert.ok(updated.includes('SUMMARY:Renamed in Luma'));
  assert.ok(updated.includes('DESCRIPTION:First part of a description that Apple folded for transport\r\n and this continuation must stay exactly folded'));
  assert.ok(updated.includes('LOCATION:Board Room'));
  assert.ok(updated.includes('ATTENDEE;CN=Alice:mailto:alice@example.com'));
  assert.ok(updated.includes('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC'));
  assert.ok(updated.includes('BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder text\r\nEND:VALARM'));
  assert.ok(updated.includes('DTSTART;VALUE=DATE:20260910'));
  assert.ok(updated.includes('DTEND;VALUE=DATE:20260912'));
  assert.ok(updated.includes('X-LUMA-TASK-ID:icloud-native-rich'));
});

test('simple Apple schedule edits preserve unrelated raw properties', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:native-simple-move',
    'SUMMARY:Move me',
    'DTSTART;VALUE=DATE:20260910',
    'DTEND;VALUE=DATE:20260911',
    'DESCRIPTION:Keep this text',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  const parsed = parseIcloudEvent(ics, '/qa/move.ics', '"1"', calendar);
  const task = baseTask({
    id: 'icloud-native-simple-move',
    itemType: 'event',
    title: parsed.title,
    dueDate: '2026-09-12',
    endDate: '2026-09-12',
    eventColor: parsed.eventColor,
    icloudRawIcs: parsed.rawIcs,
  });
  const updated = taskToIcloudIcs(task, parsed.uid);
  assert.ok(updated.includes('DTSTART;VALUE=DATE:20260912'));
  assert.ok(updated.includes('DTEND;VALUE=DATE:20260913'));
  assert.ok(updated.includes('DESCRIPTION:Keep this text'));
});

test('complex Apple schedules refuse date/time rewrites instead of flattening the resource', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:native-recurring',
    'SUMMARY:Recurring meeting',
    'DTSTART;TZID=Asia/Singapore:20260910T090000',
    'DTEND;TZID=Asia/Singapore:20260910T100000',
    'RRULE:FREQ=WEEKLY;COUNT=5',
    'EXDATE;TZID=Asia/Singapore:20260924T090000',
    'DESCRIPTION:Do not lose recurrence metadata',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  const parsed = parseIcloudEvent(ics, '/qa/recur.ics', '"1"', calendar);
  const task = baseTask({
    id: 'icloud-native-recurring',
    itemType: 'event',
    title: parsed.title,
    dueDate: '2026-09-11',
    endDate: '2026-09-11',
    time: parsed.time,
    endTime: parsed.endTime,
    eventColor: parsed.eventColor,
    icloudRawIcs: parsed.rawIcs,
  });
  assert.throws(
    () => taskToIcloudIcs(task, parsed.uid),
    (error) => error.code === 'ICLOUD_COMPLEX_SCHEDULE_EDIT'
  );
});
