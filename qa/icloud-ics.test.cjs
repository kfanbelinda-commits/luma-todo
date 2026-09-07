'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskToIcloudIcs, parseIcloudEvent } = require('../main/icloud-ics.cjs');

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
});
