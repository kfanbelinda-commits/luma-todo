'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStateStore } = require('../main/state-store.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luma-op-journal-'));
}

function state(title) {
  return {
    version: 1,
    settings: {},
    projects: [{ id: 'inbox', name: '未分类', order: 0 }],
    tasks: [{ id: 'one', title, itemType: 'todo', projectId: 'inbox', completed: false }],
    googleDeletedItems: [],
    icloudDeletedItems: [],
  };
}

function expected(result) {
  return {
    revision: result.meta.revision,
    businessRevision: result.meta.businessRevision,
    storageId: result.state == null && result.meta.revision === 0 ? '' : result.meta.storageId,
    sessionId: result.sessionId,
  };
}

const operation = {
  id: 'google-convert:one',
  provider: 'google',
  kind: 'tasks-to-calendar',
  localItemId: 'one',
  phase: 'prepared',
  source: { type: 'tasks', taskId: 'task-1' },
  destination: { type: 'calendar', calendarId: 'primary' },
  sourceVersion: { remoteUpdatedAt: 1 },
  recovery: { task: { id: 'one', title: 'before' } },
};

test('metadata-only journal writes leave the current business state unchanged', () => {
  const home = tempDir();
  fs.writeFileSync(path.join(home, 'luma-data.json'), JSON.stringify(state('A')), 'utf8');
  const store = createStateStore({ home });
  const loaded = store.load();

  const prepared = store.prepareOperationMeta(expected(loaded), operation);
  assert.equal(prepared.state.tasks[0].title, 'A');
  assert.equal(prepared.meta.pendingOperations.length, 1);
  assert.equal(prepared.meta.businessRevision, loaded.meta.businessRevision);

  const edited = store.commit(state('B'), expected(prepared));
  assert.equal(edited.state.tasks[0].title, 'B');

  const advanced = store.advanceOperationMeta(expected(edited), operation.id, {
    phase: 'destination-confirmed',
    destinationIdentity: { eventId: 'event-1' },
  });
  assert.equal(advanced.state.tasks[0].title, 'B');
  assert.equal(advanced.meta.pendingOperations[0].phase, 'destination-confirmed');
  assert.equal(advanced.meta.pendingOperations[0].destinationIdentity.eventId, 'event-1');
});

test('journal completion can be committed after the business state carries the new identity', () => {
  const home = tempDir();
  fs.writeFileSync(path.join(home, 'luma-data.json'), JSON.stringify(state('A')), 'utf8');
  const store = createStateStore({ home });
  const loaded = store.load();
  const prepared = store.prepareOperationMeta(expected(loaded), operation);
  const confirmed = store.advanceOperationMeta(expected(prepared), operation.id, {
    phase: 'source-delete-confirmed',
    destinationIdentity: { eventId: 'event-1' },
  });

  const next = state('A');
  next.tasks[0].googleCalendarEventId = 'event-1';
  const saved = store.commit(next, expected(confirmed), (meta) => {
    meta.pendingOperations = meta.pendingOperations.filter((entry) => entry.id !== operation.id);
  });
  assert.equal(saved.state.tasks[0].googleCalendarEventId, 'event-1');
  assert.deepEqual(saved.meta.pendingOperations, []);
});
