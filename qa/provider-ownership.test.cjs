'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sourceProvider,
  crossProviderAmbiguous,
  protectGoogleDispatch,
  restoreGoogleProtected,
} = require('../main/provider-ownership.cjs');

function baseState(tasks = []) {
  return {
    version: 1,
    settings: {},
    projects: [
      { id: 'inbox', name: '未分类', order: 0 },
      { id: 'apple-calendar', name: 'Apple 日历', order: 1 },
    ],
    tasks,
    googleDeletedItems: [],
    icloudDeletedItems: [],
  };
}

function appleEvent(overrides = {}) {
  return {
    id: 'apple-one',
    title: 'Apple native',
    itemType: 'event',
    projectId: 'apple-calendar',
    syncTarget: 'calendar',
    icloudExternal: true,
    icloudHref: 'https://apple.invalid/cal/one.ics',
    icloudUid: 'apple-one@example',
    icloudCalendarUrl: 'https://apple.invalid/cal/',
    ...overrides,
  };
}

test('source provider inference preserves legacy Apple and Google imports', () => {
  assert.equal(sourceProvider(appleEvent()), 'apple');
  assert.equal(sourceProvider({ id: 'g', googleCalendarExternal: true, syncTarget: 'external-calendar' }), 'google');
  assert.equal(sourceProvider({ id: 'local', syncTarget: 'calendar' }), 'luma');
  assert.equal(sourceProvider({ id: 'explicit', sourceProvider: 'apple' }), 'apple');
});

test('legacy Apple source with Google identity is marked ambiguous instead of re-owned', () => {
  const mixed = appleEvent({ googleCalendarEventId: 'g-event', googleCalendarId: 'primary' });
  assert.equal(crossProviderAmbiguous(mixed), true);
  assert.equal(sourceProvider(mixed), 'apple');
});

test('Apple source is made ineligible for Google mutation while remote identities stay discoverable', () => {
  const original = appleEvent({ googleCalendarEventId: 'g-event', googleCalendarId: 'primary' });
  const prepared = protectGoogleDispatch(baseState([original]));
  assert.equal(prepared.state.tasks.length, 1);
  assert.equal(prepared.state.tasks[0].syncTarget, 'provider-protected');
  assert.equal(prepared.state.tasks[0].googleCalendarEventId, 'g-event');
  assert.equal(prepared.state.tasks[0].sourceProvider, 'apple');
  assert.equal(prepared.protection.protectedTasks.length, 1);
  assert.ok(prepared.protection.protectedEventIds.has('g-event'));
});

test('Google returned omission cannot delete an Apple-source local record', () => {
  const original = appleEvent();
  const before = baseState([original]);
  const prepared = protectGoogleDispatch(before);
  const returned = baseState([]);
  returned.projects = [{ id: 'inbox', name: '未分类', order: 0 }];

  const restored = restoreGoogleProtected(before, returned, prepared.protection);
  assert.equal(restored.tasks.length, 1);
  assert.deepEqual(restored.tasks[0], original);
  assert.ok(restored.projects.some((project) => project.id === 'apple-calendar'));
});

test('Google-created duplicate of protected Apple source is suppressed from returned state', () => {
  const original = appleEvent({ googleCalendarEventId: 'g-event', googleCalendarId: 'primary' });
  const before = baseState([original]);
  const prepared = protectGoogleDispatch(before);
  const returned = baseState([
    {
      id: original.id,
      title: 'Google copy',
      itemType: 'event',
      syncTarget: 'calendar',
      googleCalendarEventId: 'g-event',
      googleCalendarId: 'primary',
    },
  ]);

  const restored = restoreGoogleProtected(before, returned, prepared.protection);
  assert.equal(restored.tasks.length, 1);
  assert.deepEqual(restored.tasks[0], original);
});

test('Apple-source Google deletion queue is preserved and never dispatched', () => {
  const original = appleEvent({ googleCalendarEventId: 'g-event', googleCalendarId: 'primary' });
  const before = baseState([]);
  before.googleDeletedItems = [{
    source: 'calendar',
    googleCalendarEventId: 'g-event',
    googleCalendarId: 'primary',
    deletedAt: 1,
    task: original,
  }];
  const prepared = protectGoogleDispatch(before);
  assert.deepEqual(prepared.state.googleDeletedItems, []);
  assert.equal(prepared.protection.protectedDeletes.length, 1);

  const restored = restoreGoogleProtected(before, { ...baseState([]), googleDeletedItems: [] }, prepared.protection);
  assert.equal(restored.googleDeletedItems.length, 1);
  assert.equal(restored.googleDeletedItems[0].googleCalendarEventId, 'g-event');
  assert.match(restored.googleDeletedItems[0].googleSyncError, /Apple 来源/);
});
