'use strict';

const crypto = require('crypto');
const { sourceProvider } = require('./provider-ownership.cjs');

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function conversionKind(task) {
  if (!task || sourceProvider(task) !== 'luma') return '';
  if (task.syncTarget === 'calendar' && task.dueDate && task.googleTaskId) return 'tasks-to-calendar';
  if (task.syncTarget === 'tasks' && task.googleCalendarEventId) return 'calendar-to-tasks';
  return '';
}

function operationId(task, kind) {
  const source = kind === 'tasks-to-calendar' ? task.googleTaskId : task.googleCalendarEventId;
  return `google-convert:${kind}:${String(task.id || '')}:${String(source || '')}`;
}

function proposedCalendarEventId(id) {
  return 'luma' + crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 48);
}

function expectedDestination(task, kind, id) {
  if (kind === 'tasks-to-calendar') {
    return {
      type: 'calendar',
      calendarId: String(task.googleCalendarId || 'primary'),
      proposedEventId: proposedCalendarEventId(id),
      title: String(task.title || ''),
      dueDate: String(task.dueDate || ''),
      time: String(task.time || ''),
      endDate: String(task.endDate || task.dueDate || ''),
      endTime: String(task.endTime || ''),
      itemType: task.itemType === 'event' ? 'event' : 'todo',
    };
  }
  return {
    type: 'tasks',
    listId: '@default',
    title: String(task.title || ''),
    dueDate: String(task.dueDate || ''),
    completed: Boolean(task.completed),
  };
}

function buildOperation(task, kind) {
  const id = operationId(task, kind);
  const source = kind === 'tasks-to-calendar'
    ? { type: 'tasks', taskId: String(task.googleTaskId || '') }
    : {
        type: 'calendar',
        eventId: String(task.googleCalendarEventId || ''),
        calendarId: String(task.googleCalendarId || 'primary'),
      };
  const sourceVersion = kind === 'tasks-to-calendar'
    ? {
        remoteUpdatedAt: Number(task.googleRemoteUpdatedAt || 0),
        snapshot: clone(task.lastGoogleTaskSnapshot || null),
      }
    : {
        etag: String(task.googleCalendarEtag || ''),
        remoteUpdatedAt: Number(task.googleRemoteUpdatedAt || 0),
        snapshot: clone(task.lastGoogleCalendarSnapshot || null),
      };
  return {
    id,
    provider: 'google',
    kind,
    localItemId: String(task.id || ''),
    phase: kind === 'calendar-to-tasks' && !sourceVersion.etag ? 'conflict' : 'prepared',
    source,
    destination: expectedDestination(task, kind, id),
    sourceVersion,
    destinationIdentity: null,
    recovery: { task: clone(task) },
    error: kind === 'calendar-to-tasks' && !sourceVersion.etag
      ? '旧 Google Calendar 关联缺少已确认 ETag，已停止转换并保留源事项'
      : '',
  };
}

function pendingByLocalItem(pendingOperations) {
  const result = new Map();
  for (const operation of pendingOperations || []) {
    if (operation?.provider !== 'google') continue;
    if (!['tasks-to-calendar', 'calendar-to-tasks'].includes(operation.kind)) continue;
    result.set(String(operation.localItemId || ''), operation);
  }
  return result;
}

function planConversions(inputState, pendingOperations = []) {
  const state = clone(inputState || {});
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const existingByItem = pendingByLocalItem(pendingOperations);
  const records = [];

  state.tasks = state.tasks.map((task) => {
    const kind = conversionKind(task);
    const existing = existingByItem.get(String(task.id || ''));
    if (!kind && !existing) return task;

    const operation = clone(existing || buildOperation(task, kind));
    const effectiveKind = operation.kind;
    const fresh = !existing;
    const allowCreate = fresh && operation.phase === 'prepared';
    const dispatch = { ...task };

    if (effectiveKind === 'tasks-to-calendar') {
      dispatch.googleTaskId = null;
      if (operation.destinationIdentity?.eventId) {
        dispatch.googleCalendarEventId = operation.destinationIdentity.eventId;
        dispatch.googleCalendarId = operation.destinationIdentity.calendarId || operation.destination?.calendarId || 'primary';
        dispatch.syncTarget = 'calendar';
      } else if (allowCreate) {
        dispatch.googleCalendarEventId = null;
        dispatch.googleCalendarId = operation.destination?.calendarId || 'primary';
        dispatch.syncTarget = 'calendar';
      } else {
        dispatch.syncTarget = 'provider-protected';
        dispatch.googleSyncError = operation.error || 'Google Calendar 目标状态待确认，未再次创建';
      }
    } else {
      dispatch.googleCalendarEventId = null;
      dispatch.googleCalendarId = null;
      dispatch.googleCalendarEtag = '';
      if (operation.destinationIdentity?.taskId) {
        dispatch.googleTaskId = operation.destinationIdentity.taskId;
        dispatch.syncTarget = 'tasks';
      } else if (allowCreate) {
        dispatch.googleTaskId = null;
        dispatch.syncTarget = 'tasks';
      } else {
        dispatch.syncTarget = 'provider-protected';
        dispatch.googleSyncError = operation.error || 'Google Task 目标状态待确认，未再次创建';
      }
    }

    records.push({ operation, original: clone(task), fresh, allowCreate });
    return dispatch;
  });

  return { state, records };
}

function calendarIdentityFromContext(context, operation) {
  const found = context?.calendarByLumaTaskId?.get(String(operation.localItemId || ''));
  if (!found) return null;
  return {
    eventId: String(found.eventId || ''),
    calendarId: String(found.calendarId || operation.destination?.calendarId || 'primary'),
    etag: String(found.etag || ''),
  };
}

function taskIdentityFromContext(context, operation) {
  const found = context?.googleTaskByLumaTaskId?.get(String(operation.localItemId || ''));
  if (!found) return null;
  return {
    taskId: String(found.taskId || ''),
    updatedAt: Number(found.updatedAt || 0),
  };
}

function targetIdentity(operation, returnedTask, context) {
  if (operation.kind === 'tasks-to-calendar') {
    if (returnedTask?.googleCalendarEventId) {
      return {
        eventId: String(returnedTask.googleCalendarEventId),
        calendarId: String(returnedTask.googleCalendarId || operation.destination?.calendarId || 'primary'),
        etag: String(returnedTask.googleCalendarEtag || ''),
      };
    }
    return calendarIdentityFromContext(context, operation);
  }
  if (returnedTask?.googleTaskId) return { taskId: String(returnedTask.googleTaskId) };
  return taskIdentityFromContext(context, operation);
}

function currentSourceUnchanged(operation, context) {
  if (operation.kind === 'calendar-to-tasks') return Boolean(operation.sourceVersion?.etag);
  const remote = context?.googleTasksById?.get(String(operation.source?.taskId || ''));
  if (!remote) return true;
  const expected = Number(operation.sourceVersion?.remoteUpdatedAt || 0);
  if (!expected) return false;
  return Number(remote.updatedAt || 0) === expected;
}

function restoreSourceIdentity(task, operation) {
  if (!task) return task;
  if (operation.kind === 'tasks-to-calendar') {
    task.googleTaskId = operation.source?.taskId || task.googleTaskId || null;
  } else {
    task.googleCalendarEventId = operation.source?.eventId || task.googleCalendarEventId || null;
    task.googleCalendarId = operation.source?.calendarId || task.googleCalendarId || 'primary';
    task.googleCalendarEtag = operation.sourceVersion?.etag || task.googleCalendarEtag || '';
  }
  return task;
}

function applyTargetIdentity(task, operation, identity) {
  if (!task || !identity) return task;
  if (operation.kind === 'tasks-to-calendar') {
    task.googleCalendarEventId = identity.eventId;
    task.googleCalendarId = identity.calendarId || operation.destination?.calendarId || 'primary';
    if (identity.etag) task.googleCalendarEtag = identity.etag;
  } else {
    task.googleTaskId = identity.taskId;
  }
  return task;
}

function removeSourceIdentity(task, operation) {
  if (!task) return task;
  if (operation.kind === 'tasks-to-calendar') {
    task.googleTaskId = null;
  } else {
    task.googleCalendarEventId = null;
    task.googleCalendarId = null;
    task.googleCalendarEtag = '';
  }
  return task;
}

function findReturnedTask(resultState, operation, identity, context) {
  const tasks = Array.isArray(resultState?.tasks) ? resultState.tasks : [];
  const direct = tasks.find((task) => String(task.id || '') === String(operation.localItemId || ''));
  if (direct) return direct;
  if (identity?.eventId) return tasks.find((task) => String(task.googleCalendarEventId || '') === identity.eventId) || null;
  if (identity?.taskId) return tasks.find((task) => String(task.googleTaskId || '') === identity.taskId) || null;
  const discovered = operation.kind === 'tasks-to-calendar'
    ? context?.calendarByLumaTaskId?.get(String(operation.localItemId || ''))
    : context?.googleTaskByLumaTaskId?.get(String(operation.localItemId || ''));
  if (discovered?.eventId) return tasks.find((task) => String(task.googleCalendarEventId || '') === String(discovered.eventId)) || null;
  if (discovered?.taskId) return tasks.find((task) => String(task.googleTaskId || '') === String(discovered.taskId)) || null;
  return null;
}

function copyGoogleSyncFields(target, source) {
  if (!source) return target;
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('google') || key.startsWith('lastGoogle')) target[key] = clone(value);
  }
  return target;
}

function isSourceArtifact(task, operation) {
  if (operation.kind === 'tasks-to-calendar') {
    return Boolean(operation.source?.taskId)
      && String(task?.googleTaskId || '') === String(operation.source.taskId);
  }
  return Boolean(operation.source?.eventId)
    && String(task?.googleCalendarEventId || '') === String(operation.source.eventId)
    && String(task?.googleCalendarId || 'primary') === String(operation.source.calendarId || 'primary');
}

function reconcileConversionRecord(resultState, record, context) {
  const operation = record.operation;
  const firstCandidate = findReturnedTask(resultState, operation, operation.destinationIdentity, context);
  const identity = targetIdentity(operation, firstCandidate, context);
  const candidate = firstCandidate || findReturnedTask(resultState, operation, identity, context);
  const tasks = Array.isArray(resultState?.tasks) ? resultState.tasks : [];

  resultState.tasks = tasks.filter((task) => {
    if (String(task.id || '') === String(operation.localItemId || '')) return false;
    if (isSourceArtifact(task, operation)) return false;
    if (identity?.eventId && String(task.googleCalendarEventId || '') === identity.eventId) return false;
    if (identity?.taskId && String(task.googleTaskId || '') === identity.taskId) return false;
    return true;
  });

  const item = clone(record.original || operation.recovery?.task || {});
  copyGoogleSyncFields(item, candidate);
  item.id = operation.localItemId;
  applyTargetIdentity(item, operation, identity);
  restoreSourceIdentity(item, operation);
  if (!identity) item.googleSyncError = operation.error || item.googleSyncError || 'Google 转换目标尚未确认，源事项已保留';
  resultState.tasks.push(item);
  return { item, identity };
}

function operationSatisfiedByState(operation, state) {
  if (operation?.phase !== 'source-delete-confirmed') return false;
  const task = (state?.tasks || []).find((item) => String(item.id || '') === String(operation.localItemId || ''));
  if (!task) return false;
  if (operation.kind === 'tasks-to-calendar') {
    return Boolean(operation.destinationIdentity?.eventId)
      && String(task.googleCalendarEventId || '') === String(operation.destinationIdentity.eventId)
      && !task.googleTaskId;
  }
  if (operation.kind === 'calendar-to-tasks') {
    return Boolean(operation.destinationIdentity?.taskId)
      && String(task.googleTaskId || '') === String(operation.destinationIdentity.taskId)
      && !task.googleCalendarEventId;
  }
  return false;
}

module.exports = {
  conversionKind,
  operationId,
  proposedCalendarEventId,
  buildOperation,
  planConversions,
  targetIdentity,
  currentSourceUnchanged,
  restoreSourceIdentity,
  applyTargetIdentity,
  removeSourceIdentity,
  reconcileConversionRecord,
  operationSatisfiedByState,
};
