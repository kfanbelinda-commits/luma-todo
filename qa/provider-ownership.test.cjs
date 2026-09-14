'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sourceProvider,
  crossProviderAmbiguous,
  protectGoogleDispatch,
  restoreGoogleProtected,
  protectAppleDispatch,
  restoreAppleProtected,
  wrapAppleSyncEngine,
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

function googleEvent(overrides = {}) {
  return {
    id: 'google-one',
    title: 'Google native',
    itemType: 'event',
    projectId: 'google-calendar',
    sourceProvider: 'google',
    syncTarget: 'calendar',
    googleCalendarEventId: 'google-event-one',
    googleCalendarId: 'primary',
    icloudHref: 'https://apple.invalid/cal/google-residue.ics',
    icloudUid: 'google-residue@example',
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

test('Google source with stale Apple identity is removed from Apple dispatch, but Luma dual-write stays eligible', () => {
  const google = googleEvent();
  const lumaDual = {
    id: 'luma-dual',
    title: 'Luma dual write',
    itemType: 'event',
    sourceProvider: 'luma',
    syncTarget: 'calendar',
    googleCalendarEventId: 'luma-google-event',
    googleCalendarId: 'primary',
    icloudHref: 'https://apple.invalid/cal/luma-dual.ics',
    icloudUid: 'luma-dual@example',
    icloudCalendarUrl: 'https://apple.invalid/cal/',
  };
  const before = baseState([google, lumaDual]);
  const prepared = protectAppleDispatch(before);

  assert.deepEqual(prepared.state.tasks.map((item) => item.id), ['luma-dual']);
  assert.deepEqual(prepared.state.tasks[0], lumaDual);
  assert.equal(prepared.protection.protectedTasks.length, 1);
  assert.deepEqual(prepared.protection.protectedTasks[0], google);
  assert.ok(prepared.protection.protectedHrefs.has(google.icloudHref));
});

test('Google-source Apple deletion queue is removed before Apple sync and restored byte-for-byte', () => {
  const google = googleEvent();
  const queued = {
    href: google.icloudHref,
    uid: google.icloudUid,
    calendarUrl: google.icloudCalendarUrl,
    itemType: 'event',
    etag: '"old"',
    deletedAt: 123,
    task: structuredClone(google),
  };
  const before = baseState([]);
  before.icloudDeletedItems = [queued];
  before.projects.push({ id: 'google-calendar', name: 'Google 日历', order: 2 });

  const prepared = protectAppleDispatch(before);
  assert.deepEqual(prepared.state.icloudDeletedItems, []);
  assert.equal(prepared.protection.protectedDeletes.length, 1);

  const returned = baseState([]);
  returned.projects = returned.projects.filter((project) => project.id !== 'google-calendar');
  returned.icloudDeletedItems = [{ ...queued, task: appleEvent({ id: 'duplicate', icloudHref: queued.href, icloudUid: queued.uid }) }];
  const restored = restoreAppleProtected(before, returned, prepared.protection);

  assert.deepEqual(restored.icloudDeletedItems, [queued]);
  assert.ok(restored.projects.some((project) => project.id === 'google-calendar'));
});

test('Apple ownership wrapper keeps engine decisions for Luma items while restoring Google source exactly', async () => {
  const google = googleEvent();
  const lumaDual = {
    id: 'luma-dual',
    title: 'Before Apple sync',
    itemType: 'event',
    sourceProvider: 'luma',
    syncTarget: 'calendar',
    googleTaskId: 'google-task-copy',
    icloudHref: 'https://apple.invalid/cal/luma-dual.ics',
    icloudUid: 'luma-dual@example',
    icloudCalendarUrl: 'https://apple.invalid/cal/',
  };
  const before = baseState([google, lumaDual]);
  const untouched = structuredClone(before);
  let seenByApple = null;

  const wrapped = wrapAppleSyncEngine(async (state) => {
    seenByApple = structuredClone(state);
    const returned = structuredClone(state);
    returned.tasks[0].title = 'Apple engine result';
    returned.tasks.push({
      id: 'apple-reimport',
      title: 'Should be suppressed',
      itemType: 'event',
      sourceProvider: 'apple',
      icloudExternal: true,
      icloudHref: google.icloudHref,
      icloudUid: google.icloudUid,
      icloudCalendarUrl: google.icloudCalendarUrl,
    });
    return { state: returned, summary: { updated: 1 } };
  });

  const result = await wrapped(before, { url: 'https://apple.invalid/cal/' }, {});
  assert.deepEqual(before, untouched, 'ownership wrapper must not mutate the caller snapshot');
  assert.deepEqual(seenByApple.tasks.map((item) => item.id), ['luma-dual']);
  assert.equal(result.state.tasks.length, 2);
  assert.equal(result.state.tasks.find((item) => item.id === 'luma-dual').title, 'Apple engine result');
  assert.deepEqual(result.state.tasks.find((item) => item.id === google.id), google);
  assert.equal(result.state.tasks.some((item) => item.id === 'apple-reimport'), false);
  assert.equal(result.summary.providerProtected, 1);
});
