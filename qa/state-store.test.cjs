'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStateStore, META_KEY } = require('../main/state-store.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luma-state-store-'));
}

function seed(title = 'A') {
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
    storageId: result.state == null && result.meta.revision === 0 ? '' : result.meta.storageId,
    sessionId: result.sessionId,
  };
}

test('missing store can be created once and receives a revision', () => {
  const home = tempDir();
  let n = 0;
  const store = createStateStore({ home, idFactory: () => `id-${++n}` });
  const loaded = store.load();
  assert.equal(loaded.state, null);
  assert.equal(loaded.meta.revision, 0);

  const saved = store.commit(seed(), expected(loaded));
  assert.equal(saved.meta.revision, 1);
  assert.equal(saved.state.tasks[0].title, 'A');

  const disk = JSON.parse(fs.readFileSync(path.join(home, 'luma-data.json'), 'utf8'));
  assert.equal(disk[META_KEY].revision, 1);
  assert.ok(disk[META_KEY].storageId);
  assert.deepEqual(disk[META_KEY].pendingOperations, []);
});

test('corrupt JSON is recovery-blocked and never converted into an empty normal store', () => {
  const home = tempDir();
  const file = path.join(home, 'luma-data.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  const original = fs.readFileSync(file, 'utf8');
  const store = createStateStore({ home });

  assert.throws(() => store.load(), (error) => error.code === 'STATE_PARSE_FAILED');
  assert.equal(store.status().recovery.code, 'STATE_PARSE_FAILED');
  assert.throws(
    () => store.commit(seed('replacement'), { revision: 0, storageId: '', sessionId: store.status().sessionId }),
    (error) => ['STATE_PARSE_FAILED', 'STATE_RECOVERY_REQUIRED'].includes(error.code)
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('a stale revision cannot overwrite a newer valid state', () => {
  const home = tempDir();
  fs.writeFileSync(path.join(home, 'luma-data.json'), JSON.stringify(seed()), 'utf8');
  const store = createStateStore({ home });
  const loaded = store.load();
  const stale = expected(loaded);

  const current = seed('newer');
  const saved = store.commit(current, stale);
  assert.equal(saved.meta.revision, 1);

  assert.throws(
    () => store.commit(seed('old'), stale),
    (error) => error.code === 'STATE_REVISION_CONFLICT'
  );
  assert.equal(store.load().state.tasks[0].title, 'newer');
});

test('changing storage path rotates the session and rejects a late old-context save', () => {
  const home = tempDir();
  const destination = tempDir();
  const file = path.join(home, 'luma-data.json');
  fs.writeFileSync(file, JSON.stringify(seed()), 'utf8');
  const store = createStateStore({ home });
  const loaded = store.load();
  const oldExpected = expected(loaded);

  fs.copyFileSync(file, path.join(destination, 'luma-data.json'));
  fs.writeFileSync(path.join(home, 'local-preferences.json'), JSON.stringify({ storagePath: destination }), 'utf8');

  assert.throws(
    () => store.commit(seed('late'), oldExpected),
    (error) => error.code === 'STATE_SESSION_STALE'
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'luma-data.json'), 'utf8')).tasks[0].title, 'A');
});

test('failed temp write keeps the previous valid file unchanged', () => {
  const home = tempDir();
  const file = path.join(home, 'luma-data.json');
  fs.writeFileSync(file, JSON.stringify(seed()), 'utf8');
  const original = fs.readFileSync(file, 'utf8');
  const failingFs = { ...fs };
  failingFs.writeFileSync = (filename, ...args) => {
    if (String(filename).includes('.tmp-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return fs.writeFileSync(filename, ...args);
  };
  const store = createStateStore({ home, fs: failingFs });
  const loaded = store.load();

  assert.throws(
    () => store.commit(seed('new'), expected(loaded)),
    (error) => error.code === 'STATE_WRITE_FAILED'
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('pending operation is persisted before progress and survives reload', () => {
  const home = tempDir();
  fs.writeFileSync(path.join(home, 'luma-data.json'), JSON.stringify(seed()), 'utf8');
  const store = createStateStore({ home, now: () => 1000, idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  const loaded = store.load();
  const operation = {
    id: 'op-1',
    provider: 'google',
    kind: 'tasks-to-calendar',
    localItemId: 'one',
    source: { type: 'tasks', id: 'task-1' },
    destination: { type: 'calendar', calendarId: 'primary' },
    sourceVersion: { updated: 'v1' },
    recovery: { task: seed().tasks[0] },
  };

  const prepared = store.prepareOperation(seed(), expected(loaded), operation);
  assert.equal(prepared.meta.pendingOperations[0].phase, 'prepared');

  const progressed = store.advanceOperation(prepared.state, expected(prepared), 'op-1', {
    phase: 'destination-confirmed',
    destinationIdentity: { eventId: 'event-1' },
  });
  assert.equal(progressed.meta.pendingOperations[0].destinationIdentity.eventId, 'event-1');

  const reloadedStore = createStateStore({ home });
  const reloaded = reloadedStore.load();
  assert.equal(reloaded.meta.pendingOperations[0].phase, 'destination-confirmed');
  assert.equal(reloaded.meta.pendingOperations[0].source.id, 'task-1');

  const completed = reloadedStore.completeOperation(reloaded.state, expected(reloaded), 'op-1');
  assert.deepEqual(completed.meta.pendingOperations, []);
});
