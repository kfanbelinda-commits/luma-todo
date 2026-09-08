'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mergeResult } = require('../src/icloud-state.js');
const { syncCalendar, snapshot } = require('../main/icloud-sync.cjs');
const clone = structuredClone;
const calendar = { url: 'https://qa.invalid/calendar/', name: 'QA' };
const initial = () => ({ settings: { lightMode: false }, projects: [{ id: 'inbox', name: 'Inbox' }],
  tasks: [{ id: 'one', itemType: 'todo', title: 'Before', dueDate: '2026-09-08', time: '09:00', projectId: 'inbox', updatedAt: 1 }], icloudDeletedItems: [] });
const linked = (task) => ({ ...task, icloudHref: calendar.url + 'one.ics', icloudUid: 'one@luma', icloudCalendarUrl: calendar.url,
  lastIcloudSnapshot: snapshot(task), lastIcloudEtag: '"2"' });

test('in-flight local edits/additions/settings survive while remote-only fields and baseline arrive', () => {
  const before = initial(), current = clone(before), returned = clone(before);
  current.tasks[0].title = 'Edited while syncing';
  current.tasks[0].updatedAt = 2;
  current.tasks.push({ id: 'new', title: 'New local task' });
  current.settings.lightMode = true;
  returned.tasks[0] = linked({ ...returned.tasks[0], time: '10:00' });
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.tasks[0].title, 'Edited while syncing');
  assert.equal(merged.tasks[0].time, '10:00');
  assert.equal(merged.tasks[0].updatedAt, 2);
  assert.equal(merged.tasks[0].lastIcloudSnapshot.title, 'Before');
  assert.equal(merged.tasks[1].title, 'New local task');
  assert.equal(merged.settings.lightMode, true);
  assert.equal(current.tasks[0].icloudHref, undefined, 'inputs are not mutated');
});

test('in-flight local deletion after first upload creates deletion queue without resurrecting task', () => {
  const before = initial(), current = clone(before), returned = clone(before);
  current.tasks = [];
  returned.tasks[0] = linked(returned.tasks[0]);
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.tasks.length, 0);
  assert.equal(merged.icloudDeletedItems.length, 1);
  assert.equal(merged.icloudDeletedItems[0].href, returned.tasks[0].icloudHref);
  assert.equal(merged.icloudDeletedItems[0].etag, '"2"');
  assert.deepEqual(merged.icloudDeletedItems[0].lastIcloudSnapshot, returned.tasks[0].lastIcloudSnapshot);
});

test('in-flight deletion does not acknowledge unseen Apple edits as a deletion baseline', () => {
  const before = initial(); before.tasks[0] = linked(before.tasks[0]);
  const current = clone(before), returned = clone(before);
  current.tasks = [];
  current.icloudDeletedItems.push({ href: before.tasks[0].icloudHref, calendarUrl: calendar.url, task: before.tasks[0], etag: '"old"' });
  returned.tasks[0] = linked({ ...returned.tasks[0], title: 'Apple edit' });
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.icloudDeletedItems.length, 1);
  assert.equal(merged.icloudDeletedItems[0].lastIcloudSnapshot.title, 'Before');
  assert.equal(merged.icloudDeletedItems[0].task.title, 'Before', 'preserve deleted local copy');
});

test('response-lost upload retains attempted address for a concurrent deletion', async () => {
  const before = initial(), current = clone(before);
  current.tasks = [];
  const { state: returned } = await syncCalendar(clone(before), calendar, {
    list: async () => [], put: async () => { throw new Error('response lost'); },
    uid: () => 'one@luma', safeId: (id) => id, ensureProject: () => {},
  });
  const merged = mergeResult(before, current, returned);
  assert.equal(merged.tasks.length, 0);
  assert.equal(merged.icloudDeletedItems[0].href, calendar.url + 'one%40luma.ics');
  assert.equal(merged.icloudDeletedItems[0].lastIcloudSnapshot, null);
});

test('remote deletion removes unchanged tasks but preserves newer local edits', () => {
  const before = initial(), current = clone(before), returned = clone(before);
  returned.tasks = [];
  assert.equal(mergeResult(before, current, returned).tasks.length, 0);
  current.tasks[0].title = 'New work';
  assert.equal(mergeResult(before, current, returned).tasks[0].title, 'New work');
});

test('completed queue entries clear while newly queued deletions and category edits survive', () => {
  const before = initial();
  before.icloudDeletedItems = [{ href: calendar.url + 'old.ics', calendarUrl: calendar.url }];
  const current = clone(before), returned = clone(before);
  returned.icloudDeletedItems = [];
  current.icloudDeletedItems.push({ href: calendar.url + 'new.ics', calendarUrl: calendar.url });
  current.projects[0].name = 'Renamed';
  returned.projects.push({ id: 'apple-calendar', name: 'Apple 日历' });
  returned.tasks.push({ id: 'apple-new', title: 'Imported' });
  const merged = mergeResult(before, current, returned);
  assert.deepEqual(merged.icloudDeletedItems, [current.icloudDeletedItems[1]]);
  assert.equal(merged.projects[0].name, 'Renamed');
  assert.equal(merged.projects[1].id, 'apple-calendar');
  assert.equal(merged.tasks[1].id, 'apple-new');
});

function renderer(transport) {
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { value: calendar.url, replaceChildren(...items) { this.children = items; },
      showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const context = vm.createContext({ state: initial(), structuredClone, LumaIcloudState: { mergeResult }, $, document: { createElement: () => ({}) },
    window: { luma: { icloudSync: transport } }, normalizeState: (state) => state, persist: async () => {}, render: () => {}, googleErrorMessage: String });
  vm.runInContext(source.slice(source.indexOf('function icloudConflictEntries()'), source.indexOf('async function connectOrSyncIcloud()')), context);
  return { context, $ };
}

test('real renderer sync function protects edits and suppresses overlapping calls', async () => {
  let release; const pending = new Promise((resolve) => { release = resolve; }); let calls = 0;
  const { context } = renderer(async ({ state }) => { calls++; await pending; return { state, summary: {} }; });
  const first = context.syncIcloud();
  context.state.tasks[0].title = 'During sync';
  context.state.tasks.push({ id: 'two', title: 'New' });
  await context.syncIcloud();
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(context.state.tasks[0].title, 'During sync');
  assert.equal(context.state.tasks.length, 2);
  await context.syncIcloud();
  assert.equal(calls, 2, 'guard releases after completion');
});

test('main IPC rejects concurrent sync and releases guard on rejection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  let handler, reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  let calls = 0;
  const context = vm.createContext({ DEMO_MODE: false, trustedHandle: (_name, fn) => { handler = fn; }, syncIcloudEvents: () => { calls++; return pending; } });
  vm.runInContext(source.slice(source.indexOf('let icloudSyncInFlight = false;'), source.indexOf("trustedHandle('settings:auto-start'")), context);
  const first = handler({}, {});
  await assert.rejects(handler({}, {}), /正在进行/);
  reject(new Error('offline')); await assert.rejects(first, /offline/);
  await assert.rejects(handler({}, {}), /offline/);
  assert.equal(calls, 2);
});

test('conflict navigation reaches later entries without resolving the first', () => {
  const { context, $ } = renderer(async () => {});
  const value = snapshot(initial().tasks[0]);
  context.state.tasks = ['First', 'Second'].map((title, id) => ({ id, itemType: 'todo', icloudCalendarUrl: calendar.url,
    icloudConflict: { type: 'both-modified', local: { ...value, title }, remote: { ...value, title: 'Apple ' + title } } }));
  context.showIcloudConflict();
  assert.equal($('#icloudConflictPosition').textContent, '1 / 2');
  $('#icloudConflictNext').onclick();
  assert.equal($('#icloudConflictPosition').textContent, '2 / 2');
  assert.match($('#icloudConflictLocal').value, /Second/);
  $('#icloudConflictPrevious').onclick();
  assert.match($('#icloudConflictLocal').value, /First/);
  assert.equal(context.state.tasks.filter((task) => task.icloudConflict).length, 2);
});

test('failure list displays names and causes safely, including deletion errors', () => {
  const { context, $ } = renderer(async () => {});
  context.state.tasks[0].icloudCalendarUrl = calendar.url;
  context.state.tasks[0].title = '<img src=x>';
  context.state.tasks[0].icloudSyncError = 'HTTP 503';
  context.state.icloudDeletedItems.push({ href: calendar.url + 'delete.ics', calendarUrl: calendar.url, task: { title: 'Deleted task' }, icloudSyncError: 'offline' });
  context.refreshIcloudConflictButton();
  const rows = $('#icloudFailureList').children;
  assert.equal($('#icloudFailures').hidden, false);
  assert.equal(rows[0].textContent, '<img src=x>：HTTP 503');
  assert.match(rows[1].textContent, /Deleted task（待同步删除）：offline/);
});
