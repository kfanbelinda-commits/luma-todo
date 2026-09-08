const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeResult } = require('../src/google-state.js');

const baseTask = (overrides = {}) => ({
  id: 'one',
  title: 'Original',
  projectId: 'inbox',
  completed: false,
  dueDate: '2026-09-08',
  time: '',
  itemType: 'todo',
  syncTarget: 'tasks',
  createdAt: 1,
  updatedAt: 10,
  googleTaskId: 'g-one',
  googleRemoteUpdatedAt: 10,
  lastGoogleSyncAt: 10,
  ...overrides,
});

const state = (task, extras = {}) => ({
  version: 1,
  settings: { googleConnected: true },
  projects: [{ id: 'inbox', name: '未分类', color: '#9aa4b8', order: 0, updatedAt: 1 }],
  projectsUpdatedAt: 1,
  tasks: task ? [task] : [],
  googleDeletedItems: [],
  ...extras,
});

test('concurrent local edit survives returned Google sync metadata', () => {
  const before = state(baseTask());
  const current = state(baseTask({ title: 'Edited while syncing', updatedAt: 30 }));
  const returned = state(baseTask({ googleRemoteUpdatedAt: 20, lastGoogleSyncAt: 20 }));
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.tasks[0].title, 'Edited while syncing');
  assert.equal(merged.tasks[0].updatedAt, 30);
  assert.equal(merged.tasks[0].googleRemoteUpdatedAt, 20);
  assert.equal(merged.tasks[0].lastGoogleSyncAt, 10);
});

test('unchanged local task follows remote deletion', () => {
  const before = state(baseTask());
  const current = structuredClone(before);
  const returned = state(null);
  assert.equal(mergeResult(before, current, returned).tasks.length, 0);
});

test('local edit made during sync survives remote deletion result', () => {
  const before = state(baseTask());
  const current = state(baseTask({ title: 'Keep me', updatedAt: 40 }));
  const returned = state(null);
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.tasks.length, 1);
  assert.equal(merged.tasks[0].title, 'Keep me');
});

test('remote-only import is added', () => {
  const before = state(null);
  const current = structuredClone(before);
  const imported = baseTask({ id: 'remote', googleTaskId: 'g-remote' });
  const returned = state(imported);
  assert.equal(mergeResult(before, current, returned).tasks[0].id, 'remote');
});

test('local deletion during first upload queues newly-created Google identity', () => {
  const local = baseTask({ googleTaskId: '', googleRemoteUpdatedAt: 0, lastGoogleSyncAt: 0 });
  const before = state(local);
  const current = state(null);
  const returned = state(baseTask({ googleTaskId: 'created-remotely', lastGoogleSyncAt: 50 }));
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.tasks.length, 0);
  assert.equal(merged.googleDeletedItems.length, 1);
  assert.equal(merged.googleDeletedItems[0].googleTaskId, 'created-remotely');
  assert.equal(merged.googleDeletedItems[0].task.id, 'one');
});

test('successful queued deletion is removed when local queue did not change', () => {
  const entry = {
    source: 'tasks',
    googleTaskId: 'g-one',
    googleCalendarEventId: '',
    googleCalendarId: '',
    deletedAt: 20,
    task: baseTask(),
    googleSyncError: '',
  };
  const before = state(null, { googleDeletedItems: [entry] });
  const current = structuredClone(before);
  const returned = state(null, { googleDeletedItems: [] });
  assert.equal(mergeResult(before, current, returned).googleDeletedItems.length, 0);
});

test('deletion queued after dispatch is preserved', () => {
  const before = state(null);
  const entry = {
    source: 'calendar',
    googleTaskId: '',
    googleCalendarEventId: 'e-one',
    googleCalendarId: 'primary',
    deletedAt: 30,
    task: baseTask({ googleCalendarEventId: 'e-one', googleCalendarId: 'primary' }),
    googleSyncError: '',
  };
  const current = state(null, { googleDeletedItems: [entry] });
  const returned = state(null);
  assert.equal(mergeResult(before, current, returned).googleDeletedItems[0].googleCalendarEventId, 'e-one');
});

test('concurrent project edit is not overwritten by returned state', () => {
  const before = state(null);
  const current = structuredClone(before);
  current.projects[0].name = 'My Inbox';
  current.projects[0].updatedAt = 30;
  current.projectsUpdatedAt = 30;
  const returned = structuredClone(before);
  returned.projects[0].name = 'Remote Inbox';
  returned.projects[0].updatedAt = 20;
  returned.projectsUpdatedAt = 20;
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.projects[0].name, 'My Inbox');
  assert.equal(merged.projectsUpdatedAt, 30);
});
