'use strict';

// Compatibility boundary for the published sync engine. It adds revisioned
// persistence, provider ownership checks, conditional Google mutations, and a
// persistent conversion journal while the older JSON fields remain readable.

const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const { createStateStore } = require('./state-store.cjs');
const {
  sourceProvider,
  protectGoogleDispatch,
  restoreGoogleProtected,
} = require('./provider-ownership.cjs');
const { runGoogleVersionGuard } = require('./google-version-guard.cjs');
const { parseGoogleTaskNotes } = require('./google-task-notes.cjs');
const {
  planConversions,
  currentSourceStatus,
  removeSourceIdentity,
  reconcileConversionRecord,
  operationSatisfiedByState,
} = require('./google-conversion.cjs');

const originalHandle = ipcMain.handle.bind(ipcMain);
const rawHandlers = new Map();
let stateStore = null;
let recoveryDialogShown = false;
let googleBoundaryInFlight = false;
const clients = new Map();

function store() {
  if (!stateStore) stateStore = createStateStore({ home: app.getPath('userData') });
  return stateStore;
}

function senderKey(event) {
  return Number(event?.sender?.id || 0);
}

function assertMainRenderer(event) {
  const frameUrl = String(event?.senderFrame?.url || '');
  const pageUrl = String(event?.sender?.getURL?.() || '');
  if (!frameUrl || frameUrl !== pageUrl || !frameUrl.startsWith('file:')) {
    throw new Error('Blocked untrusted IPC sender');
  }
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(frameUrl).pathname).replace(/\\/g, '/'); } catch {}
  if (!pathname.endsWith('/index.html')) throw new Error('Blocked non-main renderer IPC sender');
}

function clientExpectation(event) {
  const expected = clients.get(senderKey(event));
  if (!expected) throw Object.assign(new Error('本地数据会话尚未建立，请重新加载'), { code: 'STATE_SESSION_STALE' });
  return expected;
}

function resultExpectation(result) {
  return {
    revision: Number(result.meta?.revision || 0),
    businessRevision: Number(result.meta?.businessRevision ?? result.meta?.revision ?? 0),
    storageId: result.state == null && Number(result.meta?.revision || 0) === 0 ? '' : String(result.meta?.storageId || ''),
    sessionId: String(result.sessionId || ''),
  };
}

function snapshotToken(result) {
  const expected = resultExpectation(result);
  return {
    businessRevision: expected.businessRevision,
    storageId: expected.storageId,
    sessionId: expected.sessionId,
  };
}

function remember(event, result) {
  clients.set(senderKey(event), resultExpectation(result));
}

function updateOperationMeta(event, method, ...args) {
  const result = store()[method](clientExpectation(event), ...args);
  remember(event, result);
  return result;
}

function showRecovery(error) {
  if (recoveryDialogShown) return;
  recoveryDialogShown = true;
  const status = store().status();
  setImmediate(() => {
    try {
      dialog.showErrorBox(
        'Luma 数据需要恢复',
        [
          error?.message || 'Luma 数据文件无法读取。',
          status.filePath ? `\n数据文件：${status.filePath}` : '',
          '\n已禁止普通保存和云端同步，避免把空状态覆盖到现有数据。请先从备份恢复或修复数据文件后重新启动 Luma。',
        ].join('')
      );
    } catch {}
  });
}

function assertCloudAllowed() {
  const recovery = store().status().recovery;
  if (recovery) {
    throw Object.assign(new Error('Luma 数据处于恢复状态，已禁止云端写入'), { code: 'STATE_RECOVERY_REQUIRED' });
  }
}

async function runGuardedGoogle(state, protection, conversionCalendarIds, invoke) {
  if (googleBoundaryInFlight) throw new Error('Google 数据保护检查正在进行，请稍后重试');
  const originalFetch = global.fetch;
  if (typeof originalFetch !== 'function') throw new Error('当前运行环境缺少网络接口');
  googleBoundaryInFlight = true;
  try {
    return await runGoogleVersionGuard({
      state,
      protection,
      conversionCalendarIds,
      fetchImpl: originalFetch,
      parseTaskNotes: parseGoogleTaskNotes,
      invoke: async (guardedFetch, context) => {
        global.fetch = guardedFetch;
        try { return await invoke(context); }
        finally { global.fetch = originalFetch; }
      },
    });
  } finally {
    global.fetch = originalFetch;
    googleBoundaryInFlight = false;
  }
}

function includeDiscoveredProtectedIds(protection, context) {
  for (const key of context?.protectedCalendarKeys || []) {
    const eventId = String(key).split('\n').at(-1);
    if (eventId) protection.protectedEventIds.add(eventId);
  }
  for (const id of context?.protectedGoogleTaskIds || []) {
    if (id) protection.protectedGoogleTaskIds.add(String(id));
  }
}

function operationFor(record, metaResult) {
  return metaResult.meta.pendingOperations.find((item) => item.id === record.operation.id) || record.operation;
}

function prepareConversionJournal(event, records) {
  for (const record of records) {
    if (!record.fresh) continue;
    let meta = updateOperationMeta(event, 'prepareOperationMeta', record.operation);
    record.operation = operationFor(record, meta);
    if (record.allowCreate) {
      meta = updateOperationMeta(event, 'advanceOperationMeta', record.operation.id, {
        phase: 'destination-create-pending',
        error: '',
      });
      record.operation = operationFor(record, meta);
    }
  }
}

function conversionCalendarIds(records) {
  const result = new Map();
  for (const record of records) {
    if (record.operation.kind !== 'tasks-to-calendar' || !record.allowCreate) continue;
    const proposed = String(record.operation.destination?.proposedEventId || '');
    if (proposed) result.set(String(record.operation.localItemId || ''), proposed);
  }
  return result;
}

function guardStateForConversions(dispatchState, records) {
  const guarded = structuredClone(dispatchState);
  guarded.googleDeletedItems = Array.isArray(guarded.googleDeletedItems) ? guarded.googleDeletedItems : [];
  for (const record of records) {
    const operation = record.operation;
    if (operation.kind !== 'calendar-to-tasks' || !operation.source?.eventId) continue;
    guarded.googleDeletedItems.push({
      source: 'calendar',
      googleCalendarEventId: operation.source.eventId,
      googleCalendarId: operation.source.calendarId || 'primary',
      googleCalendarEtag: operation.sourceVersion?.etag || '',
      task: {
        id: operation.localItemId,
        googleCalendarEventId: operation.source.eventId,
        googleCalendarId: operation.source.calendarId || 'primary',
        googleCalendarEtag: operation.sourceVersion?.etag || '',
      },
    });
  }
  return guarded;
}

function sourceDeleteArgument(operation) {
  if (operation.kind === 'tasks-to-calendar') {
    return { id: operation.localItemId, sourceProvider: 'luma', googleTaskId: operation.source?.taskId || '' };
  }
  return {
    id: operation.localItemId,
    sourceProvider: 'luma',
    googleCalendarEventId: operation.source?.eventId || '',
    googleCalendarId: operation.source?.calendarId || 'primary',
    googleCalendarEtag: operation.sourceVersion?.etag || '',
  };
}

function conversionFailurePhase(error) {
  const status = Number(error?.status || 0);
  if (status === 412 || error?.code === 'GOOGLE_VERSION_REQUIRED' || error?.code === 'PROVIDER_OWNERSHIP_CONFLICT') return 'conflict';
  return 'source-delete-pending';
}

async function reconcileConversions(event, result, records, context) {
  if (!result?.state || !records.length) return result;
  const rawDelete = rawHandlers.get('google:delete-task');

  for (const record of records) {
    let operation = record.operation;
    const reconciled = reconcileConversionRecord(result.state, record, context);
    const item = reconciled.item;
    const identity = reconciled.identity;

    if (!identity) {
      const meta = updateOperationMeta(event, 'advanceOperationMeta', operation.id, {
        phase: operation.phase === 'conflict' ? 'conflict' : 'unknown',
        error: operation.error || 'Google 转换目标状态无法确认；源事项保持不变，未再次创建目标',
      });
      record.operation = operationFor(record, meta);
      item.googleSyncError = record.operation.error;
      continue;
    }

    if (!operation.destinationIdentity
      || JSON.stringify(operation.destinationIdentity) !== JSON.stringify(identity)
      || !['destination-confirmed', 'source-delete-pending', 'source-delete-confirmed'].includes(operation.phase)) {
      const meta = updateOperationMeta(event, 'advanceOperationMeta', operation.id, {
        phase: 'destination-confirmed',
        destinationIdentity: identity,
        error: '',
      });
      operation = operationFor(record, meta);
      record.operation = operation;
    }

    if (operation.phase === 'source-delete-confirmed') {
      removeSourceIdentity(item, operation);
      delete item.googleSyncError;
      continue;
    }

    const sourceStatus = currentSourceStatus(operation, context);
    if (sourceStatus === 'absent') {
      const meta = updateOperationMeta(event, 'advanceOperationMeta', operation.id, {
        phase: 'source-delete-confirmed',
        destinationIdentity: identity,
        error: '',
      });
      record.operation = operationFor(record, meta);
      removeSourceIdentity(item, record.operation);
      delete item.googleSyncError;
      continue;
    }

    if (sourceStatus !== 'unchanged') {
      const sourceReadUnknown = operation.kind === 'tasks-to-calendar' && sourceStatus === 'unknown';
      const message = operation.kind === 'tasks-to-calendar'
        ? (sourceReadUnknown
          ? 'Google Task 源事项读取状态未完整确认，已保留源与目标，未执行删除'
          : 'Google Task 源事项在转换期间发生变化，已保留源与目标，等待确认')
        : 'Google Calendar 源事项缺少可验证版本，已保留源与目标，等待确认';
      const meta = updateOperationMeta(event, 'advanceOperationMeta', operation.id, {
        phase: sourceReadUnknown ? 'source-delete-pending' : 'conflict',
        destinationIdentity: identity,
        error: message,
      });
      record.operation = operationFor(record, meta);
      item.googleSyncError = message;
      continue;
    }

    if (typeof rawDelete !== 'function') {
      const message = 'Google 删除接口尚未就绪，已保留源与目标';
      const meta = updateOperationMeta(event, 'advanceOperationMeta', operation.id, { phase: 'source-delete-pending', error: message });
      record.operation = operationFor(record, meta);
      item.googleSyncError = message;
      continue;
    }

    try {
      await rawDelete(event, sourceDeleteArgument(operation));
      const meta = updateOperationMeta(event, 'advanceOperationMeta', operation.id, {
        phase: 'source-delete-confirmed',
        destinationIdentity: identity,
        error: '',
      });
      record.operation = operationFor(record, meta);
      removeSourceIdentity(item, record.operation);
      delete item.googleSyncError;
    } catch (error) {
      const message = String(error?.message || error || 'Google 源事项删除失败');
      const meta = updateOperationMeta(event, 'advanceOperationMeta', operation.id, {
        phase: conversionFailurePhase(error),
        destinationIdentity: identity,
        error: message,
      });
      record.operation = operationFor(record, meta);
      item.googleSyncError = message;
    }
  }
  return result;
}

function completeCommittedConversions(meta, payload) {
  meta.pendingOperations = (meta.pendingOperations || []).filter((operation) => !operationSatisfiedByState(operation, payload));
}

function wrapRegistration(channel, registeredHandler) {
  if (channel === 'data:load') {
    return async (event) => {
      assertMainRenderer(event);
      try {
        const result = store().load();
        remember(event, result);
        return { state: result.state, token: snapshotToken(result) };
      } catch (error) {
        showRecovery(error);
        throw error;
      }
    };
  }

  if (channel === 'data:save') {
    return async (event, payload, token) => {
      assertMainRenderer(event);
      const result = store().commit(payload, token, (meta) => completeCommittedConversions(meta, payload));
      remember(event, result);
      return { token: snapshotToken(result) };
    };
  }

  if (channel === 'local:choose') {
    return async (event, ...args) => {
      const result = await registeredHandler(event, ...args);
      try {
        const loaded = store().load();
        remember(event, loaded);
      } catch (error) {
        showRecovery(error);
        throw error;
      }
      return result;
    };
  }

  if (channel === 'google:sync') {
    return async (event, payload) => {
      assertCloudAllowed();
      const originalState = structuredClone(payload || {});
      const protectedDispatch = protectGoogleDispatch(originalState);
      const pendingOperations = store().status().pendingOperations;
      const conversionPlan = planConversions(protectedDispatch.state, pendingOperations);
      prepareConversionJournal(event, conversionPlan.records);

      const guardState = guardStateForConversions(conversionPlan.state, conversionPlan.records);
      const stableCalendarIds = conversionCalendarIds(conversionPlan.records);
      const guarded = await runGuardedGoogle(guardState, protectedDispatch.protection, stableCalendarIds, async (context) => {
        const result = await registeredHandler(event, conversionPlan.state);
        return reconcileConversions(event, result, conversionPlan.records, context);
      });

      includeDiscoveredProtectedIds(protectedDispatch.protection, guarded.context);
      if (guarded.result?.state) {
        guarded.result.state = restoreGoogleProtected(originalState, guarded.result.state, protectedDispatch.protection);
      }
      if (guarded.result?.summary) {
        guarded.result.summary.providerProtected = protectedDispatch.protection.protectedTasks.length
          + protectedDispatch.protection.protectedDeletes.length;
        guarded.result.summary.conversionPending = conversionPlan.records.filter((record) => record.operation.phase !== 'source-delete-confirmed').length;
      }
      return guarded.result;
    };
  }

  if (channel === 'google:delete-task') {
    return async (event, entry) => {
      assertCloudAllowed();
      const sourceItem = entry?.task || entry;
      if (sourceProvider(sourceItem) === 'apple') {
        const error = new Error('Apple 来源事项存在 Google 关联，已保留关联并停止跨来源删除');
        error.code = 'PROVIDER_OWNERSHIP_CONFLICT';
        throw error;
      }
      const guardState = {
        tasks: sourceItem ? [structuredClone(sourceItem)] : [],
        googleDeletedItems: entry ? [structuredClone(entry)] : [],
      };
      const guarded = await runGuardedGoogle(guardState, null, null, () => registeredHandler(event, entry));
      return guarded.result;
    };
  }

  if (channel === 'icloud:sync') {
    return async (event, ...args) => {
      assertCloudAllowed();
      return registeredHandler(event, ...args);
    };
  }

  return registeredHandler;
}

ipcMain.handle = (channel, registeredHandler) => {
  rawHandlers.set(channel, registeredHandler);
  return originalHandle(channel, wrapRegistration(channel, registeredHandler));
};

require(path.join('..', 'main.cjs'));
