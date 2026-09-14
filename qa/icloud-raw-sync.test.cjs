'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncCalendar, snapshot } = require('../main/icloud-sync.cjs');
const { parseIcloudEvent, taskToIcloudIcs } = require('../main/icloud-ics.cjs');

const calendar = { url: 'https://qa.invalid/calendar/', name: 'QA' };

function appleIcs(description) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iCal//EN',
    'BEGIN:VEVENT',
    'UID:rich@apple',
    'DTSTAMP:20260910T010203Z',
    'SUMMARY:Meeting',
    'DTSTART;VALUE=DATE:20260920',
    'DTEND;VALUE=DATE:20260921',
    'DESCRIPTION:' + description,
    'LOCATION:Room A',
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Keep alarm',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

test('local modeled edit uploads against the latest Apple raw resource', async () => {
  const oldRaw = appleIcs('Old remote description');
  const latestRaw = appleIcs('New remote description');
  const oldRemote = parseIcloudEvent(oldRaw, calendar.url + 'rich.ics', '"1"', calendar);
  const latestRemote = parseIcloudEvent(latestRaw, calendar.url + 'rich.ics', '"2"', calendar);

  const local = {
    id: 'icloud-rich',
    itemType: 'event',
    title: 'Local title',
    dueDate: oldRemote.dueDate,
    time: oldRemote.time,
    endDate: oldRemote.endDate,
    endTime: oldRemote.endTime,
    completed: false,
    eventColor: oldRemote.eventColor,
    projectId: 'apple-calendar',
    syncTarget: 'calendar',
    icloudExternal: true,
    icloudHref: oldRemote.href,
    icloudUid: oldRemote.uid,
    icloudEtag: '"1"',
    lastIcloudEtag: '"1"',
    icloudCalendarUrl: calendar.url,
    icloudRawIcs: oldRaw,
    updatedAt: Date.parse('2026-09-14T03:00:00Z'),
  };
  local.lastIcloudSnapshot = snapshot({ ...local, title: 'Meeting' });

  let uploaded = null;
  const state = { tasks: [local], projects: [], icloudDeletedItems: [] };
  const io = {
    list: async () => [structuredClone(latestRemote)],
    get: async () => structuredClone(latestRemote),
    put: async (_href, task, uid, etag) => {
      assert.equal(etag, '"2"');
      assert.equal(task.icloudRawIcs, latestRaw);
      uploaded = taskToIcloudIcs(task, uid);
      return '"3"';
    },
    remove: async () => {},
    uid: (id) => id + '@luma',
    safeId: (id) => id,
    ensureProject: () => {},
  };

  const result = await syncCalendar(state, calendar, io);
  assert.equal(result.summary.updated, 1);
  assert.ok(uploaded.includes('SUMMARY:Local title'));
  assert.ok(uploaded.includes('DESCRIPTION:New remote description'));
  assert.ok(!uploaded.includes('DESCRIPTION:Old remote description'));
  assert.ok(uploaded.includes('LOCATION:Room A'));
  assert.ok(uploaded.includes('BEGIN:VALARM\r\nTRIGGER:-PT10M\r\nACTION:DISPLAY\r\nDESCRIPTION:Keep alarm\r\nEND:VALARM'));
});
