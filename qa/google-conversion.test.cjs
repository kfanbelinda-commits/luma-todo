'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOperation,
  planConversions,
  proposedCalendarEventId,
  currentSourceStatus,
  currentSourceUnchanged,
  reconcileConversionRecord,
  removeSourceIdentity,
  operationSatisfiedByState,
} = require('../main/google-conversion.cjs');

function baseState(task) {
  return {
    version: 1,
    settings: {},
    projects: [{ id: 'inbox', name: '未分类', order: 0 }],
    tasks: [task],
    googleDeletedItems: [],
    icloudDeletedItems: [],
  };
}

function googleTaskSource(overrides = {}) {
  return {
    id: 'one',
    title: 'Meeting',
    itemType: 'todo',
    projectId: 'inbox',
    syncTarget: 'calendar',
    dueDate: '2026-09-20',
    time: '10:00',
    googleTaskId: 'task-source',
    googleRemoteUpdatedAt: Date.parse('2026-09-14T01:00:00Z'),
    lastGoogleTaskSnapshot: { title: 'Meeting', dueDate: '2026-09-20', completed: false },
    ...overrides,
  };
}

function calendarSource(overrides = {}) {
  return {
    id: 'two',
    title: 'Calendar source',
    itemType: 'todo',
    projectId: 'inbox',
    syncTarget: 'tasks',
    dueDate: '2026-09-21',
    googleCalendarEventId: 'calendar-source',
    googleCalendarId: 'primary',
    googleCalendarEtag: '"source-v1"',
    googleRemoteUpdatedAt: Date.parse('2026-09-14T01:00:00Z'),
    lastGoogleCalendarSnapshot: { title: 'Calendar source', dueDate: '2026-09-21', itemType: 'todo' },
    ...overrides,
  };
}

test('fresh Tasks to Calendar conversion hides source and permits one target creation', () => {
  const task = googleTaskSource();
  const plan = planConversions(baseState(task), []);
  assert.equal(plan.records.length, 1);
  assert.equal(plan.records[0].fresh, true);
  assert.equal(plan.records[0].allowCreate, true);
  assert.equal(plan.state.tasks[0].googleTaskId, null);
  assert.equal(plan.state.tasks[0].syncTarget, 'calendar');
  assert.equal(plan.records[0].operation.source.taskId, 'task-source');
  assert.equal(plan.records[0].operation.source.listId, '@default');
  assert.equal(plan.records[0].operation.destination.proposedEventId, proposedCalendarEventId(plan.records[0].operation.id));
});

test('interrupted target creation is read-only on restart until target is discovered', () => {
  const task = googleTaskSource();
  const operation = buildOperation(task, 'tasks-to-calendar');
  operation.phase = 'destination-create-pending';
  const plan = planConversions(baseState(task), [operation]);
  assert.equal(plan.records[0].fresh, false);
  assert.equal(plan.records[0].allowCreate, false);
  assert.equal(plan.state.tasks[0].syncTarget, 'provider-protected');
  assert.equal(plan.state.tasks[0].googleTaskId, null);
  assert.match(plan.state.tasks[0].googleSyncError, /未再次创建/);
});

test('Calendar to Tasks without a previously accepted ETag is frozen as conflict', () => {
  const task = calendarSource({ googleCalendarEtag: '' });
  const operation = buildOperation(task, 'calendar-to-tasks');
  assert.equal(operation.phase, 'conflict');
  assert.match(operation.error, /ETag/);
  const plan = planConversions(baseState(task), []);
  assert.equal(plan.records[0].allowCreate, false);
  assert.equal(plan.state.tasks[0].syncTarget, 'provider-protected');
});

test('discovered conversion target is joined to original identity and source import artifact is removed', () => {
  const original = googleTaskSource();
  const operation = buildOperation(original, 'tasks-to-calendar');
  operation.phase = 'destination-create-pending';
  const record = { operation, original, fresh: false, allowCreate: false };
  const state = {
    tasks: [
      { id: 'one', title: 'protected copy', syncTarget: 'provider-protected' },
      { id: 'google-task-task-source', googleTaskId: 'task-source', title: 'source artifact' },
      { id: 'calendar-event-target', googleCalendarEventId: 'event-target', googleCalendarId: 'primary', lastGoogleCalendarSnapshot: { title: 'Meeting' } },
    ],
  };
  const context = {
    calendarByLumaTaskId: new Map([['one', { eventId: 'event-target', calendarId: 'primary', etag: '"target-v1"' }]]),
  };
  const result = reconcileConversionRecord(state, record, context);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'one');
  assert.equal(state.tasks[0].googleTaskId, 'task-source');
  assert.equal(state.tasks[0].googleCalendarEventId, 'event-target');
  assert.equal(state.tasks[0].googleCalendarEtag, '"target-v1"');
  assert.equal(result.identity.eventId, 'event-target');
});

test('Google Task source must still match the version recorded before conversion', () => {
  const operation = buildOperation(googleTaskSource(), 'tasks-to-calendar');
  const same = { googleTasksById: new Map([['task-source', { updatedAt: operation.sourceVersion.remoteUpdatedAt }]]) };
  const changed = { googleTasksById: new Map([['task-source', { updatedAt: operation.sourceVersion.remoteUpdatedAt + 1000 }]]) };
  assert.equal(currentSourceStatus(operation, same), 'unchanged');
  assert.equal(currentSourceUnchanged(operation, same), true);
  assert.equal(currentSourceStatus(operation, changed), 'changed');
  assert.equal(currentSourceUnchanged(operation, changed), false);
  operation.sourceVersion.remoteUpdatedAt = 0;
  assert.equal(currentSourceStatus(operation, same), 'unknown');
  assert.equal(currentSourceUnchanged(operation, same), false);
});

test('missing Google Task is not treated as safe unless its list was read completely', () => {
  const operation = buildOperation(googleTaskSource(), 'tasks-to-calendar');
  const unread = {
    googleTasksById: new Map(),
    googleTaskListReads: new Map(),
  };
  const partial = {
    googleTasksById: new Map(),
    googleTaskListReads: new Map([['@default', { startedFromFirstPage: true, complete: false, pages: 1, nextPageToken: 'next' }]]),
  };
  const complete = {
    googleTasksById: new Map(),
    googleTaskListReads: new Map([['@default', { startedFromFirstPage: true, complete: true, pages: 2, nextPageToken: '' }]]),
  };

  assert.equal(currentSourceStatus(operation, unread), 'unknown');
  assert.equal(currentSourceStatus(operation, partial), 'unknown');
  assert.equal(currentSourceStatus(operation, complete), 'absent');
  assert.equal(currentSourceUnchanged(operation, complete), false);
});

test('confirmed source deletion is kept in journal until matching business state is saved', () => {
  const operation = buildOperation(googleTaskSource(), 'tasks-to-calendar');
  operation.phase = 'source-delete-confirmed';
  operation.destinationIdentity = { eventId: 'event-target', calendarId: 'primary', etag: '"target-v1"' };
  const item = googleTaskSource({ googleCalendarEventId: 'event-target', googleCalendarId: 'primary' });
  removeSourceIdentity(item, operation);
  assert.equal(item.googleTaskId, null);
  assert.equal(operationSatisfiedByState(operation, baseState(item)), true);
  item.googleTaskId = 'task-source';
  assert.equal(operationSatisfiedByState(operation, baseState(item)), false);
});
