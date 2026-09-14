'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eventKey,
  runGoogleVersionGuard,
} = require('../main/google-version-guard.cjs');

function headers(input = {}) {
  const map = new Map(Object.entries(input).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    get(key) { return map.get(String(key).toLowerCase()) || null; },
  };
}

function response(body, { status = 200, headers: headerValues = {} } = {}) {
  const payload = body == null ? null : structuredClone(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers(headerValues),
    clone() {
      return {
        json: async () => structuredClone(payload),
      };
    },
  };
}

function requestHeader(options, key) {
  const h = options?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(key) || '';
  const found = Object.entries(h).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return found ? String(found[1]) : '';
}

const listUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?showDeleted=true';
const eventUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1';
const taskListUrl = 'https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks?showDeleted=true';
const taskItemUrl = 'https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks/task-1';

function state(overrides = {}) {
  return {
    tasks: [],
    googleDeletedItems: [],
    ...overrides,
  };
}

test('Calendar PATCH uses the exact ETag from the list version used for reconciliation', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === listUrl) {
      return response({ items: [{ id: 'event-1', etag: '"list-v2"', extendedProperties: { private: { lumaTaskId: 'local-1' } } }] });
    }
    if (url === eventUrl && options.method === 'PATCH') {
      assert.equal(requestHeader(options, 'If-Match'), '"list-v2"');
      return response({ id: 'event-1', etag: '"saved-v3"' });
    }
    throw new Error('unexpected request ' + url);
  };

  const { result, context } = await runGoogleVersionGuard({
    state: state(),
    fetchImpl: fakeFetch,
    invoke: async (guardedFetch) => {
      await guardedFetch(listUrl);
      await guardedFetch(eventUrl, { method: 'PATCH', body: '{}' });
      return { state: { tasks: [{ id: 'local-1', googleCalendarEventId: 'event-1', googleCalendarId: 'primary' }] } };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(context.calendarEtags.get(eventKey('primary', 'event-1')), '"saved-v3"');
  assert.equal(result.state.tasks[0].googleCalendarEtag, '"saved-v3"');
});

test('queued Calendar delete keeps its frozen ETag even when list shows a newer version', async () => {
  const calls = [];
  const input = state({
    googleDeletedItems: [{
      source: 'calendar',
      googleCalendarEventId: 'event-1',
      googleCalendarId: 'primary',
      googleCalendarEtag: '"intent-v1"',
      task: { id: 'local-1', googleCalendarEventId: 'event-1', googleCalendarId: 'primary', googleCalendarEtag: '"intent-v1"' },
    }],
  });
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === listUrl) return response({ items: [{ id: 'event-1', etag: '"remote-v2"' }] });
    if (url === eventUrl && options.method === 'DELETE') {
      assert.equal(requestHeader(options, 'If-Match'), '"intent-v1"');
      return response({ error: 'precondition' }, { status: 412 });
    }
    throw new Error('unexpected request');
  };

  await runGoogleVersionGuard({
    state: input,
    fetchImpl: fakeFetch,
    invoke: async (guardedFetch) => {
      await guardedFetch(listUrl);
      return guardedFetch(eventUrl, { method: 'DELETE' });
    },
  });
  assert.equal(calls.length, 2);
});

test('destructive Calendar mutation without a known ETag is stopped before network access', async () => {
  let calls = 0;
  await assert.rejects(
    runGoogleVersionGuard({
      state: state(),
      fetchImpl: async () => { calls += 1; return response(null, { status: 204 }); },
      invoke: async (guardedFetch) => guardedFetch(eventUrl, { method: 'DELETE' }),
    }),
    (error) => error.code === 'GOOGLE_VERSION_REQUIRED'
  );
  assert.equal(calls, 0);
});

test('Apple-source Luma identity found in Calendar list blocks later Google mutation', async () => {
  let mutations = 0;
  const protection = {
    protectedTaskIds: new Set(['apple-local']),
    protectedEventIds: new Set(),
    protectedGoogleTaskIds: new Set(),
  };
  await assert.rejects(
    runGoogleVersionGuard({
      state: state(),
      protection,
      fetchImpl: async (url, options = {}) => {
        if (url === listUrl) return response({ items: [{
          id: 'event-1',
          etag: '"v1"',
          extendedProperties: { private: { lumaTaskId: 'apple-local' } },
        }] });
        if (options.method === 'DELETE') mutations += 1;
        return response(null, { status: 204 });
      },
      invoke: async (guardedFetch) => {
        await guardedFetch(listUrl);
        return guardedFetch(eventUrl, { method: 'DELETE' });
      },
    }),
    (error) => error.code === 'PROVIDER_OWNERSHIP_CONFLICT'
  );
  assert.equal(mutations, 0);
});

test('Apple-source task identity discovered in Google Tasks list blocks PATCH and DELETE', async () => {
  let mutations = 0;
  const protection = {
    protectedTaskIds: new Set(['apple-local']),
    protectedEventIds: new Set(),
    protectedGoogleTaskIds: new Set(),
  };
  await assert.rejects(
    runGoogleVersionGuard({
      state: state(),
      protection,
      parseTaskNotes: () => ({ metadata: { taskId: 'apple-local' } }),
      fetchImpl: async (url, options = {}) => {
        if (url === taskListUrl) return response({ items: [{ id: 'task-1', notes: 'metadata' }] });
        if (options.method === 'PATCH' || options.method === 'DELETE') mutations += 1;
        return response({ id: 'task-1' });
      },
      invoke: async (guardedFetch) => {
        await guardedFetch(taskListUrl);
        return guardedFetch(taskItemUrl, { method: 'PATCH', body: '{}' });
      },
    }),
    (error) => error.code === 'PROVIDER_OWNERSHIP_CONFLICT'
  );
  assert.equal(mutations, 0);
});

test('Google Tasks absence is trusted only after a complete first-to-final pagination chain', async () => {
  const first = taskListUrl;
  const second = 'https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks?showDeleted=true&pageToken=next-1';
  const { context } = await runGoogleVersionGuard({
    state: state(),
    parseTaskNotes: () => ({ metadata: {} }),
    fetchImpl: async (url) => {
      if (url === first) return response({ items: [{ id: 'task-a', updated: '2026-09-14T01:00:00Z' }], nextPageToken: 'next-1' });
      if (url === second) return response({ items: [{ id: 'task-b', updated: '2026-09-14T01:01:00Z' }] });
      throw new Error('unexpected request ' + url);
    },
    invoke: async (guardedFetch, liveContext) => {
      await guardedFetch(first);
      assert.equal(liveContext.googleTaskListReads.get('@default').complete, false);
      await guardedFetch(second);
      assert.equal(liveContext.googleTaskListReads.get('@default').complete, true);
      return { state: { tasks: [] } };
    },
  });
  assert.equal(context.googleTaskListReads.get('@default').pages, 2);
  assert.equal(context.googleTaskListReads.get('@default').complete, true);
});

test('an orphan Google Tasks page cannot prove list completeness', async () => {
  const orphan = 'https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks?pageToken=orphan';
  const { context } = await runGoogleVersionGuard({
    state: state(),
    fetchImpl: async () => response({ items: [] }),
    invoke: async (guardedFetch) => {
      await guardedFetch(orphan);
      return { state: { tasks: [] } };
    },
  });
  assert.equal(context.googleTaskListReads.get('@default').complete, false);
});

test('Google Task PATCH validates the list version immediately before writing without re-deciding the merge', async () => {
  const listUpdated = '2026-09-14T01:00:00Z';
  const localOlder = '2026-09-14T00:59:00Z';
  const calls = [];
  const body = JSON.stringify({ title: 'local decision already made' });
  const fakeFetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ url, method, body: options.body });
    if (url === taskListUrl) return response({ items: [{ id: 'task-1', updated: listUpdated, title: 'list copy' }] });
    if (url === taskItemUrl && method === 'GET') return response({ id: 'task-1', updated: listUpdated, title: 'same version' });
    if (url === taskItemUrl && method === 'PATCH') {
      assert.equal(options.body, body, 'guard must pass through the engine-approved PATCH body unchanged');
      return response({ id: 'task-1', updated: '2026-09-14T01:00:02Z', title: 'saved' });
    }
    throw new Error('unexpected request ' + method + ' ' + url);
  };

  await runGoogleVersionGuard({
    state: state({ tasks: [{ id: 'local-1', googleTaskId: 'task-1', googleRemoteUpdatedAt: Date.parse(localOlder) }] }),
    fetchImpl: fakeFetch,
    invoke: async (guardedFetch) => {
      await guardedFetch(taskListUrl);
      return guardedFetch(taskItemUrl, { method: 'PATCH', body });
    },
  });

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'PATCH']);
});

test('Google Task PATCH stops if the remote changed after the reconciliation read', async () => {
  const listUpdated = '2026-09-14T01:00:00Z';
  let patches = 0;
  await assert.rejects(
    runGoogleVersionGuard({
      state: state(),
      fetchImpl: async (url, options = {}) => {
        const method = String(options.method || 'GET').toUpperCase();
        if (url === taskListUrl) return response({ items: [{ id: 'task-1', updated: listUpdated }] });
        if (url === taskItemUrl && method === 'GET') return response({ id: 'task-1', updated: '2026-09-14T01:00:01Z' });
        if (method === 'PATCH') patches += 1;
        return response({ id: 'task-1', updated: '2026-09-14T01:00:02Z' });
      },
      invoke: async (guardedFetch) => {
        await guardedFetch(taskListUrl);
        return guardedFetch(taskItemUrl, { method: 'PATCH', body: '{}' });
      },
    }),
    (error) => error.code === 'GOOGLE_TASK_VERSION_CHANGED'
  );
  assert.equal(patches, 0);
});

test('Google Task PATCH without a known version is stopped before network access', async () => {
  let calls = 0;
  await assert.rejects(
    runGoogleVersionGuard({
      state: state({ tasks: [{ id: 'local-1', googleTaskId: 'task-1' }] }),
      fetchImpl: async () => { calls += 1; return response({ id: 'task-1' }); },
      invoke: async (guardedFetch) => guardedFetch(taskItemUrl, { method: 'PATCH', body: '{}' }),
    }),
    (error) => error.code === 'GOOGLE_TASK_VERSION_REQUIRED'
  );
  assert.equal(calls, 0);
});

test('Google Task DELETE rechecks the exact updated version immediately before deletion', async () => {
  const updated = '2026-09-14T01:00:00Z';
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, method: String(options.method || 'GET').toUpperCase(), body: options.body });
    if (String(options.method || 'GET').toUpperCase() === 'GET') {
      return response({ id: 'task-1', updated, title: 'still the same' });
    }
    if (options.method === 'DELETE') return response(null, { status: 204 });
    throw new Error('unexpected request');
  };

  await runGoogleVersionGuard({
    state: state({ tasks: [{ id: 'local-1', googleTaskId: 'task-1', googleRemoteUpdatedAt: Date.parse(updated) }] }),
    fetchImpl: fakeFetch,
    invoke: async (guardedFetch) => guardedFetch(taskItemUrl, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test' },
    }),
  });

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'DELETE']);
  assert.equal(calls[0].body, undefined);
});

test('Google Task DELETE stops if the task changed after the previously confirmed version', async () => {
  const original = '2026-09-14T01:00:00Z';
  let deletes = 0;
  await assert.rejects(
    runGoogleVersionGuard({
      state: state({ tasks: [{ id: 'local-1', googleTaskId: 'task-1', googleRemoteUpdatedAt: Date.parse(original) }] }),
      fetchImpl: async (_url, options = {}) => {
        if (String(options.method || 'GET').toUpperCase() === 'GET') {
          return response({ id: 'task-1', updated: '2026-09-14T01:00:01Z', title: 'changed remotely' });
        }
        if (options.method === 'DELETE') deletes += 1;
        return response(null, { status: 204 });
      },
      invoke: async (guardedFetch) => guardedFetch(taskItemUrl, { method: 'DELETE' }),
    }),
    (error) => error.code === 'GOOGLE_TASK_VERSION_CHANGED'
  );
  assert.equal(deletes, 0);
});

test('Google Task DELETE without a known version is stopped before network access', async () => {
  let calls = 0;
  await assert.rejects(
    runGoogleVersionGuard({
      state: state({ tasks: [{ id: 'local-1', googleTaskId: 'task-1' }] }),
      fetchImpl: async () => { calls += 1; return response(null, { status: 204 }); },
      invoke: async (guardedFetch) => guardedFetch(taskItemUrl, { method: 'DELETE' }),
    }),
    (error) => error.code === 'GOOGLE_TASK_VERSION_REQUIRED'
  );
  assert.equal(calls, 0);
});

test('Tasks to Calendar conversion insert receives its stable proposed event id', async () => {
  const createUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const proposedId = 'luma1234567890abcdef';
  let postedBody = null;
  const { context } = await runGoogleVersionGuard({
    state: state(),
    conversionCalendarIds: new Map([['local-1', proposedId]]),
    fetchImpl: async (url, options = {}) => {
      assert.equal(url, createUrl);
      postedBody = JSON.parse(options.body);
      return response({ id: proposedId, etag: '"created-v1"', extendedProperties: { private: { lumaTaskId: 'local-1' } } });
    },
    invoke: async (guardedFetch) => {
      await guardedFetch(createUrl, {
        method: 'POST',
        body: JSON.stringify({ summary: 'Meeting', extendedProperties: { private: { lumaTaskId: 'local-1' } } }),
      });
      return { state: { tasks: [] } };
    },
  });
  assert.equal(postedBody.id, proposedId);
  assert.equal(context.calendarByLumaTaskId.get('local-1').eventId, proposedId);
});
