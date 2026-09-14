'use strict';

function calendarRequest(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return null; }
  if (parsed.origin !== 'https://www.googleapis.com') return null;
  const match = parsed.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (!match) return null;
  return {
    calendarId: decodeURIComponent(match[1]),
    eventId: match[2] ? decodeURIComponent(match[2]) : '',
    collection: !match[2],
  };
}

function taskRequest(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return null; }
  if (parsed.origin !== 'https://tasks.googleapis.com') return null;
  const match = parsed.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
  if (!match) return null;
  return {
    listId: decodeURIComponent(match[1]),
    taskId: match[2] ? decodeURIComponent(match[2]) : '',
    collection: !match[2],
    pageToken: parsed.searchParams.get('pageToken') || '',
  };
}

function eventKey(calendarId, eventId) {
  return String(calendarId || 'primary') + '\n' + String(eventId || '');
}

function responseJson(response) {
  if (!response || typeof response.clone !== 'function') return Promise.resolve(null);
  try { return response.clone().json().catch(() => null); } catch { return Promise.resolve(null); }
}

function makeHeaders(input) {
  if (typeof Headers === 'function') return new Headers(input || {});
  const result = { ...(input || {}) };
  result.set = (key, value) => { result[key] = value; };
  result.get = (key) => result[key] || result[key.toLowerCase()] || null;
  return result;
}

function seedContext(state, protection, conversionCalendarIds) {
  const context = {
    calendarEtags: new Map(),
    knownCalendarEtags: new Map(),
    frozenDeleteEtags: new Map(),
    frozenDeleteKeys: new Set(),
    protectedTaskIds: new Set(protection?.protectedTaskIds || []),
    protectedCalendarKeys: new Set(),
    protectedGoogleTaskIds: new Set(protection?.protectedGoogleTaskIds || []),
    calendarByLumaTaskId: new Map(),
    googleTaskByLumaTaskId: new Map(),
    googleTasksById: new Map(),
    knownGoogleTaskUpdatedAt: new Map(),
    googleTaskListReads: new Map(),
    calendarEventsByKey: new Map(),
    conversionCalendarIds: conversionCalendarIds instanceof Map
      ? new Map(conversionCalendarIds)
      : new Map(Object.entries(conversionCalendarIds || {})),
  };

  for (const task of state?.tasks || []) {
    if (task?.googleTaskId && Number(task.googleRemoteUpdatedAt || 0) > 0) {
      context.knownGoogleTaskUpdatedAt.set(String(task.googleTaskId), Number(task.googleRemoteUpdatedAt));
    }
    if (!task?.googleCalendarEventId) continue;
    const key = eventKey(task.googleCalendarId || 'primary', task.googleCalendarEventId);
    if (task.googleCalendarEtag) context.knownCalendarEtags.set(key, String(task.googleCalendarEtag));
    if (context.protectedTaskIds.has(String(task.id || ''))) context.protectedCalendarKeys.add(key);
  }
  for (const id of protection?.protectedEventIds || []) {
    if (id) context.protectedCalendarKeys.add('*\n' + String(id));
  }

  for (const entry of state?.googleDeletedItems || []) {
    const queuedTask = entry?.task || entry;
    if (queuedTask?.googleTaskId && Number(queuedTask.googleRemoteUpdatedAt || entry?.googleRemoteUpdatedAt || 0) > 0) {
      context.knownGoogleTaskUpdatedAt.set(
        String(queuedTask.googleTaskId),
        Number(queuedTask.googleRemoteUpdatedAt || entry.googleRemoteUpdatedAt)
      );
    }
    if (entry?.source !== 'calendar' || !entry.googleCalendarEventId) continue;
    const key = eventKey(entry.googleCalendarId || 'primary', entry.googleCalendarEventId);
    context.frozenDeleteKeys.add(key);
    const etag = String(entry.googleCalendarEtag || entry.task?.googleCalendarEtag || '');
    if (etag) context.frozenDeleteEtags.set(key, etag);
  }
  return context;
}

function keyProtected(context, calendarId, eventId) {
  return context.protectedCalendarKeys.has(eventKey(calendarId, eventId))
    || context.protectedCalendarKeys.has('*\n' + String(eventId || ''));
}

function recordCalendarEvent(context, calendarId, event) {
  if (!event?.id) return;
  const key = eventKey(calendarId, event.id);
  const etag = String(event.etag || '');
  if (etag) context.calendarEtags.set(key, etag);
  context.calendarEventsByKey.set(key, structuredClone(event));
  const taskId = String(event.extendedProperties?.private?.lumaTaskId || '');
  if (taskId) {
    context.calendarByLumaTaskId.set(taskId, {
      eventId: String(event.id),
      calendarId: String(calendarId || 'primary'),
      etag,
      event: structuredClone(event),
    });
  }
  if (taskId && context.protectedTaskIds.has(taskId)) context.protectedCalendarKeys.add(key);
}

function protectCalendarList(context, calendarId, body) {
  for (const event of body?.items || []) recordCalendarEvent(context, calendarId, event);
}

function recordGoogleTask(context, item, parseTaskNotes) {
  if (!item?.id) return;
  let taskId = '';
  try { taskId = String(parseTaskNotes?.(item.notes)?.metadata?.taskId || ''); } catch {}
  const updatedAt = Date.parse(item.updated || 0) || 0;
  const record = { taskId: String(item.id), updatedAt, item: structuredClone(item) };
  context.googleTasksById.set(String(item.id), record);
  if (taskId) context.googleTaskByLumaTaskId.set(taskId, record);
  if (taskId && context.protectedTaskIds.has(taskId)) context.protectedGoogleTaskIds.add(String(item.id));
}

function protectTasksList(context, body, parseTaskNotes) {
  for (const item of body?.items || []) recordGoogleTask(context, item, parseTaskNotes);
}

function recordGoogleTaskListPage(context, request, body) {
  const listId = String(request?.listId || '@default');
  const pageToken = String(request?.pageToken || '');
  const nextPageToken = String(body?.nextPageToken || '');
  const previous = context.googleTaskListReads.get(listId) || null;

  let validChain = false;
  let pages = 0;
  if (!pageToken) {
    validChain = true;
    pages = 1;
  } else if (previous?.startedFromFirstPage
    && !previous.complete
    && String(previous.nextPageToken || '') === pageToken) {
    validChain = true;
    pages = Number(previous.pages || 0) + 1;
  }

  context.googleTaskListReads.set(listId, {
    startedFromFirstPage: validChain,
    complete: validChain && !nextPageToken,
    pages: validChain ? pages : 0,
    nextPageToken,
  });
}

function setConditionalHeader(options, etag) {
  const headers = makeHeaders(options?.headers);
  headers.set('If-Match', etag);
  return { ...(options || {}), headers };
}

function expectedDeleteEtag(context, key) {
  if (context.frozenDeleteKeys.has(key)) return context.frozenDeleteEtags.get(key) || '';
  return context.calendarEtags.get(key) || context.knownCalendarEtags.get(key) || '';
}

function expectedGoogleTaskUpdatedAt(context, taskId) {
  const id = String(taskId || '');
  return Number(context.googleTasksById.get(id)?.updatedAt || context.knownGoogleTaskUpdatedAt.get(id) || 0);
}

function getOptionsFromMutation(options) {
  const { body: _body, ...rest } = options || {};
  return { ...rest, method: 'GET' };
}

async function preflightGoogleTaskDelete(url, options, request, context, fetchImpl, parseTaskNotes) {
  const expected = expectedGoogleTaskUpdatedAt(context, request.taskId);
  if (!expected) {
    const error = new Error('缺少 Google Task 已确认版本，已停止删除');
    error.code = 'GOOGLE_TASK_VERSION_REQUIRED';
    throw error;
  }

  const checked = await fetchImpl(url, getOptionsFromMutation(options));
  const body = await responseJson(checked);
  if (!checked?.ok) return checked;

  const current = Date.parse(body?.updated || 0) || 0;
  if (!body?.id || !current) {
    const error = new Error('Google Task 当前版本无法确认，已停止删除');
    error.code = 'GOOGLE_TASK_VERSION_REQUIRED';
    throw error;
  }
  if (current !== expected) {
    const error = new Error('Google Task 在删除前已发生变化，已停止删除并保留远端事项');
    error.code = 'GOOGLE_TASK_VERSION_CHANGED';
    throw error;
  }

  recordGoogleTask(context, body, parseTaskNotes);
  return null;
}

function annotateCalendarEtags(state, context) {
  if (!state || !Array.isArray(state.tasks)) return state;
  for (const task of state.tasks) {
    if (!task?.googleCalendarEventId) continue;
    const key = eventKey(task.googleCalendarId || 'primary', task.googleCalendarEventId);
    const etag = context.calendarEtags.get(key) || context.knownCalendarEtags.get(key) || '';
    if (etag) task.googleCalendarEtag = etag;
  }
  return state;
}

function prepareStableCalendarInsert(options, context) {
  if (!options?.body) return { options, lumaTaskId: '' };
  let body;
  try { body = JSON.parse(String(options.body)); } catch { return { options, lumaTaskId: '' }; }
  const lumaTaskId = String(body?.extendedProperties?.private?.lumaTaskId || '');
  const proposedId = context.conversionCalendarIds.get(lumaTaskId);
  if (!proposedId) return { options, lumaTaskId };
  body.id = body.id || proposedId;
  return { options: { ...options, body: JSON.stringify(body) }, lumaTaskId };
}

async function runGoogleVersionGuard({ state, protection, fetchImpl, parseTaskNotes, conversionCalendarIds, invoke }) {
  const context = seedContext(state, protection, conversionCalendarIds);
  const guardedFetch = async (url, options = {}) => {
    const method = String(options?.method || 'GET').toUpperCase();
    const cal = calendarRequest(url);
    const task = taskRequest(url);
    let requestTaskId = '';

    if (cal?.collection && method === 'POST') {
      const prepared = prepareStableCalendarInsert(options, context);
      options = prepared.options;
      requestTaskId = prepared.lumaTaskId;
    }

    if (cal?.eventId && ['PATCH', 'PUT', 'DELETE'].includes(method)) {
      if (keyProtected(context, cal.calendarId, cal.eventId)) {
        const error = new Error('该 Google 日历副本关联到 Apple 来源事项，已停止跨来源修改');
        error.code = 'PROVIDER_OWNERSHIP_CONFLICT';
        throw error;
      }
      const key = eventKey(cal.calendarId, cal.eventId);
      const etag = method === 'DELETE'
        ? expectedDeleteEtag(context, key)
        : (context.calendarEtags.get(key) || context.knownCalendarEtags.get(key) || '');
      if (!etag) {
        const error = new Error('缺少 Google Calendar 已确认版本，已停止破坏性操作');
        error.code = 'GOOGLE_VERSION_REQUIRED';
        throw error;
      }
      options = setConditionalHeader(options, etag);
    }

    if (task?.taskId && ['PATCH', 'DELETE'].includes(method) && context.protectedGoogleTaskIds.has(String(task.taskId))) {
      const error = new Error('该 Google Task 副本关联到 Apple 来源事项，已停止跨来源修改');
      error.code = 'PROVIDER_OWNERSHIP_CONFLICT';
      throw error;
    }

    if (task?.taskId && method === 'DELETE') {
      const shortCircuit = await preflightGoogleTaskDelete(url, options, task, context, fetchImpl, parseTaskNotes);
      if (shortCircuit) return shortCircuit;
    }

    const response = await fetchImpl(url, options);
    const body = await responseJson(response);

    if (cal?.collection && method === 'GET' && response?.ok && body) {
      protectCalendarList(context, cal.calendarId, body);
    } else if (cal?.eventId && response?.ok && body?.id) {
      recordCalendarEvent(context, cal.calendarId, body);
    } else if (cal?.collection && method === 'POST' && response?.ok && body?.id) {
      recordCalendarEvent(context, cal.calendarId, body);
      if (requestTaskId && !context.calendarByLumaTaskId.has(requestTaskId)) {
        context.calendarByLumaTaskId.set(requestTaskId, {
          eventId: String(body.id),
          calendarId: String(cal.calendarId || 'primary'),
          etag: String(body.etag || response.headers?.get?.('etag') || ''),
          event: structuredClone(body),
        });
      }
    }

    if (task?.collection && method === 'GET' && response?.ok && body) {
      protectTasksList(context, body, parseTaskNotes);
      recordGoogleTaskListPage(context, task, body);
    } else if (task?.taskId && response?.ok && body?.id) {
      recordGoogleTask(context, body, parseTaskNotes);
    } else if (task?.collection && method === 'POST' && response?.ok && body?.id) {
      recordGoogleTask(context, body, parseTaskNotes);
    }
    return response;
  };

  const result = await invoke(guardedFetch, context);
  if (result?.state) annotateCalendarEtags(result.state, context);
  return { result, context };
}

module.exports = {
  calendarRequest,
  taskRequest,
  eventKey,
  seedContext,
  annotateCalendarEtags,
  runGoogleVersionGuard,
};
