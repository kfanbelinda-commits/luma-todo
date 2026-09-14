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

function seedContext(state, protection) {
  const context = {
    calendarEtags: new Map(),
    knownCalendarEtags: new Map(),
    frozenDeleteEtags: new Map(),
    frozenDeleteKeys: new Set(),
    protectedTaskIds: new Set(protection?.protectedTaskIds || []),
    protectedCalendarKeys: new Set(),
    protectedGoogleTaskIds: new Set(protection?.protectedGoogleTaskIds || []),
  };

  for (const task of state?.tasks || []) {
    if (!task?.googleCalendarEventId) continue;
    const key = eventKey(task.googleCalendarId || 'primary', task.googleCalendarEventId);
    if (task.googleCalendarEtag) context.knownCalendarEtags.set(key, String(task.googleCalendarEtag));
    if (context.protectedTaskIds.has(String(task.id || ''))) context.protectedCalendarKeys.add(key);
  }
  for (const id of protection?.protectedEventIds || []) {
    // Calendar id may be unknown here; response inspection below protects all
    // matching Luma task ids. Existing task records add exact keys above.
    if (id) context.protectedCalendarKeys.add('*\n' + String(id));
  }

  for (const entry of state?.googleDeletedItems || []) {
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

function protectCalendarList(context, calendarId, body) {
  for (const event of body?.items || []) {
    if (!event?.id) continue;
    const key = eventKey(calendarId, event.id);
    if (event.etag) context.calendarEtags.set(key, String(event.etag));
    const taskId = String(event.extendedProperties?.private?.lumaTaskId || '');
    if (taskId && context.protectedTaskIds.has(taskId)) context.protectedCalendarKeys.add(key);
  }
}

function protectTasksList(context, body, parseTaskNotes) {
  for (const item of body?.items || []) {
    if (!item?.id) continue;
    let taskId = '';
    try { taskId = String(parseTaskNotes?.(item.notes)?.metadata?.taskId || ''); } catch {}
    if (taskId && context.protectedTaskIds.has(taskId)) context.protectedGoogleTaskIds.add(String(item.id));
  }
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

async function runGoogleVersionGuard({ state, protection, fetchImpl, parseTaskNotes, invoke }) {
  const context = seedContext(state, protection);
  const guardedFetch = async (url, options = {}) => {
    const method = String(options?.method || 'GET').toUpperCase();
    const cal = calendarRequest(url);
    const task = taskRequest(url);

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

    const response = await fetchImpl(url, options);
    const body = await responseJson(response);

    if (cal?.collection && method === 'GET' && response?.ok && body) {
      protectCalendarList(context, cal.calendarId, body);
    } else if (cal?.eventId && response?.ok && body?.id) {
      const key = eventKey(cal.calendarId, body.id);
      const etag = String(body.etag || response.headers?.get?.('etag') || '');
      if (etag) context.calendarEtags.set(key, etag);
    } else if (cal?.collection && method === 'POST' && response?.ok && body?.id) {
      const key = eventKey(cal.calendarId, body.id);
      const etag = String(body.etag || response.headers?.get?.('etag') || '');
      if (etag) context.calendarEtags.set(key, etag);
    }

    if (task?.collection && method === 'GET' && response?.ok && body) {
      protectTasksList(context, body, parseTaskNotes);
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
