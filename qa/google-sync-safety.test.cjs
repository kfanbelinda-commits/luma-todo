const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectGoogleCalendarReads,
  classifyLumaDuplicates,
} = require('../main/google-sync-safety.cjs');

test('one failed Google Calendar does not discard successful calendars', async () => {
  const calendars = [
    { id: 'ok', summary: 'OK' },
    { id: 'bad', summary: 'Bad' },
  ];
  const result = await collectGoogleCalendarReads(calendars, async (calendar, lumaOnly) => {
    if (calendar.id === 'bad') throw new Error('temporary failure');
    return [{ id: lumaOnly ? 'luma' : 'normal', calendarId: calendar.id }];
  });
  assert.equal(result.events.length, 2);
  assert.equal(result.failedCalendarIds.has('bad'), true);
  assert.equal(result.failedCalendarIds.has('ok'), false);
  assert.equal(result.failures[0].calendarName, 'Bad');
});

test('duplicate classifier keeps currently linked remote copy', () => {
  const items = [
    { id: 'old', taskId: 'one', updated: 10, value: 'same' },
    { id: 'linked', taskId: 'one', updated: 20, value: 'same' },
  ];
  const result = classifyLumaDuplicates(items, {
    taskId: (item) => item.taskId,
    remoteKey: (item) => item.id,
    linkedKeyByTaskId: new Map([['one', 'linked']]),
    fingerprint: (item) => item.value,
    updatedAt: (item) => item.updated,
  });
  assert.equal(result.kept[0].id, 'linked');
  assert.equal(result.safeDuplicates[0].duplicate.id, 'old');
});

test('equivalent Luma-owned duplicates are safe cleanup candidates', () => {
  const result = classifyLumaDuplicates([
    { id: 'a', taskId: 'one', updated: 20, value: 'same' },
    { id: 'b', taskId: 'one', updated: 10, value: 'same' },
  ], {
    taskId: (item) => item.taskId,
    remoteKey: (item) => item.id,
    fingerprint: (item) => item.value,
    updatedAt: (item) => item.updated,
  });
  assert.equal(result.safeDuplicates.length, 1);
  assert.equal(result.divergentDuplicates.length, 0);
  assert.equal(result.kept[0].id, 'a');
});

test('divergent duplicates are suppressed but never auto-deleted', () => {
  const result = classifyLumaDuplicates([
    { id: 'a', taskId: 'one', updated: 20, value: 'newer' },
    { id: 'b', taskId: 'one', updated: 10, value: 'different' },
  ], {
    taskId: (item) => item.taskId,
    remoteKey: (item) => item.id,
    fingerprint: (item) => item.value,
    updatedAt: (item) => item.updated,
  });
  assert.equal(result.kept.length, 1);
  assert.equal(result.safeDuplicates.length, 0);
  assert.equal(result.divergentDuplicates.length, 1);
});

test('items without a Luma task id are never classified as duplicates', () => {
  const result = classifyLumaDuplicates([
    { id: 'a', taskId: '', value: 'same' },
    { id: 'b', taskId: '', value: 'same' },
  ], {
    taskId: (item) => item.taskId,
    remoteKey: (item) => item.id,
    fingerprint: (item) => item.value,
  });
  assert.equal(result.kept.length, 2);
  assert.equal(result.safeDuplicates.length, 0);
});
