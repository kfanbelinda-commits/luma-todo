'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, mergeSnapshots, syncCalendar } = require('../main/icloud-sync.cjs');
const { taskToIcloudIcs, parseIcloudEvent } = require('../main/icloud-ics.cjs');
const calendar = { url: 'https://qa.invalid/calendar/', name: 'QA' };
function task(overrides = {}) {
  const value = { id: 'qa', itemType: 'event', title: 'Meeting', dueDate: '2026-09-08', time: '10:00',
    endDate: '2026-09-08', endTime: '11:00', completed: false, eventColor: '#91a9c7',
    projectId: 'inbox', updatedAt: 100, lastIcloudSyncAt: 100, icloudHref: calendar.url + 'qa.ics',
    icloudUid: 'qa@luma', icloudCalendarUrl: calendar.url, lastIcloudEtag: '"1"', icloudEtag: '"1"', ...overrides };
  value.lastIcloudSnapshot = snapshot(value);
  return value;
}
function remote(value, overrides = {}) {
  return { ...parseIcloudEvent(taskToIcloudIcs(value, value.icloudUid || 'qa@luma'), value.icloudHref || calendar.url + 'qa.ics', '"1"', calendar), ...overrides };
}
function harness(tasks, remotes, overrides = {}, deleted = []) {
  const calls = [];
  const state = { tasks: structuredClone(tasks), projects: [], icloudDeletedItems: structuredClone(deleted) };
  const io = {
    list: async () => structuredClone(remotes),
    get: async (href) => { calls.push(['get', href]); return structuredClone(remotes.find((r) => r.href === href) || null); },
    put: async (href, value, uid, etag) => { calls.push(['put', href, structuredClone(value), etag]); return '"saved"'; },
    remove: async (href, etag) => { calls.push(['delete', href, etag]); },
    uid: (id) => id + '@luma', safeId: (id) => id, ensureProject: () => {}, ...overrides,
  };
  return { state, calls, run: () => syncCalendar(state, calendar, io) };
}
function deleted(value) {
  return { href: value.icloudHref, uid: value.icloudUid, calendarUrl: calendar.url, etag: value.lastIcloudEtag,
    itemType: value.itemType, lastIcloudSnapshot: value.lastIcloudSnapshot, task: value };
}
const precondition = () => Object.assign(new Error('changed'), { status: 412 });

for (const itemType of ['todo', 'event']) {
  test(itemType + ': merge separate edits and persist only the successful baseline', async () => {
    const value = task({ itemType });
    const apple = remote(value, { time: '10:30', etag: '"2"' });
    value.title = 'Local title';
    const h = harness([value], [apple]);
    const { state, summary } = await h.run();
    assert.equal(state.tasks[0].title, 'Local title');
    assert.equal(state.tasks[0].time, '10:30');
    assert.equal(state.tasks[0].itemType, itemType);
    assert.equal(h.calls[0][3], '"2"');
    assert.equal(summary.updated, 1);
    assert.deepEqual(state.tasks[0].lastIcloudSnapshot, snapshot(state.tasks[0]));
  });
  test(itemType + ': conflicting same-field edits survive repeated sync and reload', async () => {
    const value = task({ itemType });
    const base = structuredClone(value.lastIcloudSnapshot);
    const apple = remote(value, { time: '10:45', etag: '"2"' });
    value.time = '10:15';
    const h = harness([value], [apple]);
    await h.run();
    const reloaded = harness(JSON.parse(JSON.stringify(h.state.tasks)), [apple]);
    const { state, summary } = await reloaded.run();
    assert.equal(summary.conflicts, 1);
    assert.equal(state.tasks[0].time, '10:15');
    assert.deepEqual(state.tasks[0].lastIcloudSnapshot, base);
    assert.equal(state.tasks[0].lastIcloudEtag, '"1"');
    assert.equal(reloaded.calls.length, 0);
  });
  test(itemType + ': equal edits settle without upload', async () => {
    const value = task({ itemType });
    value.title = 'Same';
    const h = harness([value], [remote(value, { etag: '"2"' })]);
    const result = await h.run();
    assert.equal(result.summary.conflicts, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.tasks[0].lastIcloudSnapshot.title, 'Same');
  });
  test(itemType + ': Apple deletion removes unchanged item but protects local edit', async () => {
    const value = task({ itemType });
    const unchanged = harness([value], []);
    await unchanged.run();
    assert.equal(unchanged.state.tasks.length, 0);
    value.title = 'New local work';
    const edited = harness([value], []);
    await edited.run();
    assert.equal(edited.state.tasks[0].icloudConflict.type, 'remote-deleted-local-modified');
    assert.equal(edited.calls.length, 0);
  });
  test(itemType + ': local deletion deletes unchanged remote and freezes edited remote', async () => {
    const value = task({ itemType });
    const h = harness([], [remote(value)], {}, [deleted(value)]);
    await h.run();
    assert.deepEqual(h.calls, [['delete', value.icloudHref, '"1"']]);
    assert.equal(h.state.icloudDeletedItems.length, 0);
    const edited = harness([], [remote(value, { title: 'Edited remotely', etag: '"2"' })], {}, [deleted(value)]);
    await edited.run();
    assert.equal(edited.calls.length, 0);
    assert.equal(edited.state.tasks.length, 0, 'do not reimport pending deletion');
    assert.equal(edited.state.icloudDeletedItems[0].icloudConflict.type, 'local-deleted-remote-modified');
    assert.equal(edited.state.icloudDeletedItems[0].task.title, value.title);
  });
}

test('Todo prefix completion pullback preserves its identity and local-only fields', async () => {
  const value = task({ itemType: 'todo', eventColor: '#ffffff' });
  const h = harness([value], [remote(value, { title: '✓ 买水果', dueDate: '2026-09-09', lumaItemType: '', etag: '"2"' })]);
  await h.run();
  assert.equal(h.state.tasks[0].completed, true);
  assert.equal(h.state.tasks[0].title, '买水果');
  assert.equal(h.state.tasks[0].itemType, 'todo');
  assert.equal(h.state.tasks[0].eventColor, '#ffffff');
});

test('native Apple Event edits merge without Luma origin metadata', async () => {
  const value = task({ icloudExternal: true, projectId: 'apple-calendar' });
  const h = harness([value], [remote(value, { title: 'Apple edit', lumaItemType: '', lumaTaskId: '', etag: '"2"' })]);
  await h.run();
  assert.equal(h.state.tasks[0].title, 'Apple edit');
  assert.equal(h.state.tasks[0].icloudExternal, true);
  assert.equal(h.state.tasks[0].projectId, 'apple-calendar');
});

test('old data bootstraps only when contents agree; mismatches and missing items stay protected', async () => {
  const value = task();
  delete value.lastIcloudSnapshot;
  const h = harness([value], [remote(value)]);
  await h.run();
  assert.ok(h.state.tasks[0].lastIcloudSnapshot);
  const mismatch = harness([value], [remote(value, { title: 'Other' })]);
  await mismatch.run();
  assert.equal(mismatch.state.tasks[0].icloudConflict.type, 'missing-baseline');
  const missing = harness([value], []);
  await missing.run();
  assert.equal(missing.state.tasks.length, 1);
  assert.equal(missing.calls.length, 0);
});

test('legacy deletion uses the last known etag conservatively', async () => {
  const value = task();
  const entry = deleted(value);
  delete entry.lastIcloudSnapshot;
  delete entry.task;
  const h = harness([], [remote(value, { etag: '"2"' })], {}, [entry]);
  await h.run();
  assert.equal(h.state.icloudDeletedItems.length, 1);
  assert.equal(h.calls.length, 0);
});

test('invalid cross-field time merge and mixed all-day/timed edits become conflicts', () => {
  const base = snapshot(task());
  const invalid = mergeSnapshots(base, { ...base, time: '10:45' }, { ...base, endTime: '10:30' }, 'event');
  assert.equal(invalid.type, 'invalid-schedule');
  const mixed = mergeSnapshots(base, { ...base, time: '', endTime: '' }, { ...base, dueDate: '2026-09-07' }, 'event');
  assert.equal(mixed.type, 'schedule-conflict');
});

test('PUT 412 rereads and merges latest fields with fresh If-Match', async () => {
  const value = task();
  const old = remote(value);
  const latest = remote(value, { time: '10:30', etag: '"2"' });
  value.title = 'Local';
  let puts = 0;
  const h = harness([value], [old], {
    put: async (_href, upload, _uid, etag) => {
      puts += 1;
      if (puts === 1) throw precondition();
      assert.equal(etag, '"2"');
      assert.equal(upload.time, '10:30');
      assert.equal(upload.title, 'Local');
      return '"3"';
    }, get: async () => latest,
  });
  await h.run();
  assert.equal(puts, 2);
  assert.equal(h.state.tasks[0].lastIcloudEtag, '"3"');
});

test('repeated 412 freezes only that item; next item still syncs', async () => {
  const first = task();
  const second = task({ id: 'two', icloudHref: calendar.url + 'two.ics', icloudUid: 'two@luma' });
  const remotes = [remote(first), remote(second)];
  first.title = 'Local one'; second.title = 'Local two';
  let puts = 0;
  const h = harness([first, second], remotes, { put: async (href) => {
    puts += 1;
    if (href === first.icloudHref) throw precondition();
    return '"3"';
  } });
  const { summary } = await h.run();
  assert.equal(puts, 3);
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.updated, 1);
  assert.equal(h.state.tasks[0].lastIcloudSnapshot.title, 'Meeting');
});

test('PUT 412 followed by deletion does not recreate an edited linked item', async () => {
  const value = task(); const apple = remote(value); value.title = 'Local';
  const h = harness([value], [apple], { put: async () => { throw precondition(); }, get: async () => null });
  await h.run();
  assert.equal(h.state.tasks[0].icloudConflict.type, 'remote-deleted-local-modified');
});

test('DELETE 412 rereads, preserves remote edit, and continues next deletion', async () => {
  const first = task(); const second = task({ id: 'two', icloudHref: calendar.url + 'two.ics', icloudUid: 'two@luma' });
  const calls = [];
  const h = harness([], [remote(first), remote(second)], {
    remove: async (href) => { calls.push(href); if (href === first.icloudHref) throw precondition(); },
    get: async () => remote(first, { title: 'Apple edit', etag: '"2"' }),
  }, [deleted(first), deleted(second)]);
  const { summary } = await h.run();
  assert.equal(summary.remoteDeleted, 1);
  assert.equal(summary.conflicts, 1);
  assert.equal(calls.length, 2);
  assert.equal(h.state.tasks.length, 0);
});

test('DELETE 412 with metadata-only change retries; already missing deletion succeeds', async () => {
  const value = task(); let count = 0;
  const h = harness([], [remote(value)], {
    remove: async (_href, etag) => { if (++count === 1) throw precondition(); assert.equal(etag, '"2"'); },
    get: async () => remote(value, { etag: '"2"' }),
  }, [deleted(value)]);
  await h.run();
  assert.equal(count, 2);
  assert.equal(h.state.icloudDeletedItems.length, 0);
  const missing = harness([], [], {}, [deleted(value)]);
  await missing.run();
  assert.equal(missing.state.icloudDeletedItems.length, 0);
});

test('network failure preserves baseline and pending deletion while other items continue', async () => {
  const value = task(); const apple = remote(value); value.title = 'Local';
  const h = harness([value], [apple], { put: async () => { throw new Error('offline'); } });
  const { summary } = await h.run();
  assert.equal(summary.failed, 1);
  assert.equal(h.state.tasks[0].lastIcloudSnapshot.title, 'Meeting');
  assert.equal(h.state.tasks[0].title, 'Local');
  const del = harness([], [apple], { remove: async () => { throw new Error('offline'); } }, [deleted(task())]);
  await del.run();
  assert.equal(del.state.icloudDeletedItems.length, 1);
  assert.equal(del.state.tasks.length, 0);
});

test('unreadable Apple resource protects linked local item while other items continue', async () => {
  const blocked = task();
  const other = task({ id: 'two', icloudHref: calendar.url + 'two.ics', icloudUid: 'two@luma' });
  other.title = 'Local two';
  const unreadable = { href: blocked.icloudHref, uid: blocked.icloudUid, lumaTaskId: blocked.id, unreadable: true, readError: 'unsupported Apple event' };
  const h = harness([blocked, other], [unreadable, remote(other)]);
  const { summary } = await h.run();
  assert.equal(h.state.tasks.length, 2);
  assert.equal(h.state.tasks[0].title, blocked.title);
  assert.equal(h.state.tasks[0].icloudSyncError, 'unsupported Apple event');
  assert.equal(summary.unreadable, 1);
  assert.equal(summary.updated, 1);
  assert.equal(h.calls.filter((call) => call[0] === 'put').length, 1);
});

test('unreadable Apple resource never confirms a pending local deletion', async () => {
  const value = task();
  const unreadable = { href: value.icloudHref, uid: value.icloudUid, lumaTaskId: value.id, unreadable: true, readError: 'unsupported Apple event' };
  const h = harness([], [unreadable], {}, [deleted(value)]);
  const { summary } = await h.run();
  assert.equal(h.state.icloudDeletedItems.length, 1);
  assert.equal(h.state.icloudDeletedItems[0].icloudSyncError, 'unsupported Apple event');
  assert.equal(summary.remoteDeleted, 0);
  assert.equal(summary.unreadable, 1);
  assert.equal(h.calls.length, 0);
});

test('unreadable unlinked Apple resource is skipped instead of imported', async () => {
  const unreadable = { href: calendar.url + 'odd.ics', uid: 'odd@apple', unreadable: true, readError: 'unsupported Apple event' };
  const h = harness([], [unreadable]);
  const { summary } = await h.run();
  assert.equal(h.state.tasks.length, 0);
  assert.equal(summary.downloaded, 0);
  assert.equal(summary.unreadable, 1);
});

test('list failure makes no changes or deletion calls', async () => {
  const value = task();
  const h = harness([value], [], { list: async () => { throw new Error('incomplete'); } }, [deleted(value)]);
  await assert.rejects(h.run, /incomplete/);
  assert.equal(h.state.tasks.length, 1);
  assert.equal(h.state.icloudDeletedItems.length, 1);
  assert.equal(h.calls.length, 0);
});

test('missing PUT etag requires readback; mismatched readback does not advance baseline', async () => {
  const value = task(); const apple = remote(value); value.title = 'Local';
  const h = harness([value], [apple], { put: async () => '', get: async () => remote(value, { etag: '"2"' }) });
  await h.run();
  assert.equal(h.state.tasks[0].lastIcloudEtag, '"2"');
  const mismatch = harness([value], [apple], { put: async () => '', get: async () => apple });
  await mismatch.run();
  assert.equal(mismatch.state.tasks[0].icloudConflict.type, 'write-unconfirmed');
  assert.equal(mismatch.state.tasks[0].lastIcloudSnapshot.title, 'Meeting');
});

test('user choice applies only to the exact reviewed local and remote versions', async () => {
  const value = task(); const apple = remote(value, { title: 'Apple', etag: '"2"' }); value.title = 'Local';
  const h = harness([value], [apple]); await h.run();
  h.state.tasks[0].icloudResolution = { choice: 'local', detectedAt: h.state.tasks[0].icloudConflict.detectedAt };
  await h.run();
  assert.equal(h.state.tasks[0].icloudConflict, undefined);
  assert.equal(h.calls[0][3], '"2"');
  const stale = harness([value], [apple]); await stale.run();
  stale.state.tasks[0].icloudResolution = { choice: 'remote', detectedAt: stale.state.tasks[0].icloudConflict.detectedAt };
  stale.state.tasks[0].title = 'Newer local edit';
  await stale.run();
  assert.equal(stale.state.tasks[0].title, 'Newer local edit');
  assert.ok(stale.state.tasks[0].icloudConflict);
});

test('deletion conflict can restore Apple version with original task identity', async () => {
  const value = task();
  const h = harness([], [remote(value, { title: 'Apple', etag: '"2"' })], {}, [deleted(value)]);
  await h.run();
  const entry = h.state.icloudDeletedItems[0];
  entry.icloudResolution = { choice: 'remote', detectedAt: entry.icloudConflict.detectedAt };
  await h.run();
  assert.equal(h.state.icloudDeletedItems.length, 0);
  assert.equal(h.state.tasks.length, 1);
  assert.equal(h.state.tasks[0].id, value.id);
  assert.equal(h.state.tasks[0].title, 'Apple');
  assert.equal(h.state.tasks[0].projectId, 'inbox');
  assert.equal(h.calls.length, 0);
});

test('accepting local deletion sends DELETE with the reviewed remote etag', async () => {
  const value = task();
  const h = harness([], [remote(value, { title: 'Apple', etag: '"2"' })], {}, [deleted(value)]);
  await h.run();
  const entry = h.state.icloudDeletedItems[0];
  entry.icloudResolution = { choice: 'local', detectedAt: entry.icloudConflict.detectedAt };
  await h.run();
  assert.equal(h.state.icloudDeletedItems.length, 0);
  assert.deepEqual(h.calls, [['delete', value.icloudHref, '"2"']]);
});

test('accepting remote deletion removes local item; keeping local recreates conditionally', async () => {
  for (const choice of ['local', 'remote']) {
    const value = task(); value.title = 'Local edit';
    const h = harness([value], []); await h.run();
    h.state.tasks[0].icloudResolution = { choice, detectedAt: h.state.tasks[0].icloudConflict.detectedAt };
    await h.run();
    assert.equal(h.state.tasks.length, choice === 'local' ? 1 : 0);
    if (choice === 'local') assert.equal(h.calls[0][3], '');
    else assert.equal(h.calls.length, 0);
  }
});

test('remote change after a user choice requires fresh confirmation', async () => {
  const value = task(); value.title = 'Local';
  const first = harness([value], [remote(value, { title: 'Apple', etag: '"2"' })]); await first.run();
  first.state.tasks[0].icloudResolution = { choice: 'local', detectedAt: first.state.tasks[0].icloudConflict.detectedAt };
  const latest = harness(first.state.tasks, [remote(value, { title: 'Apple newer', etag: '"3"' })]);
  await latest.run();
  assert.equal(latest.calls.length, 0);
  assert.equal(latest.state.tasks[0].icloudConflict.remote.title, 'Apple newer');
});

test('other calendars and Google read-only items remain untouched', async () => {
  const value = task({ icloudCalendarUrl: 'https://qa.invalid/other/' });
  const google = task({ id: 'google', googleCalendarExternal: true });
  const h = harness([value, google], []);
  await h.run();
  assert.deepEqual(h.state.tasks, [value, google]);
  assert.equal(h.calls.length, 0);
});
