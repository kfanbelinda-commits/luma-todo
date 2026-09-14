'use strict';

// This bootstrap is intentionally narrow. It keeps the published application
// intact while placing revision/session and provider/version guards around
// destructive persistence and cloud entry points. The sync engines can migrate
// behind this boundary without allowing corrupt loads, stale storage sessions,
// or one provider to authorize another provider's destructive operations.

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

const originalHandle = ipcMain.handle.bind(ipcMain);
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

function remember(event, result) {
  clients.set(senderKey(event), {
    revision: Number(result.meta?.revision || 0),
    storageId: result.state == null && Number(result.meta?.revision || 0) === 0 ? '' : String(result.meta?.storageId || ''),
    sessionId: String(result.sessionId || ''),
  });
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

async function runGuardedGoogle(state, protection, invoke) {
  if (googleBoundaryInFlight) throw new Error('Google 数据保护检查正在进行，请稍后重试');
  const originalFetch = global.fetch;
  if (typeof originalFetch !== 'function') throw new Error('当前运行环境缺少网络接口');
  googleBoundaryInFlight = true;
  try {
    const guarded = await runGoogleVersionGuard({
      state,
      protection,
      fetchImpl: originalFetch,
      parseTaskNotes: parseGoogleTaskNotes,
      invoke: async (guardedFetch, context) => {
        global.fetch = guardedFetch;
        try { return await invoke(context); }
        finally { global.fetch = originalFetch; }
      },
    });
    return guarded;
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

function wrapRegistration(channel, registeredHandler) {
  if (channel === 'data:load') {
    return async (event) => {
      assertMainRenderer(event);
      try {
        const result = store().load();
        remember(event, result);
        return result.state;
      } catch (error) {
        showRecovery(error);
        throw error;
      }
    };
  }

  if (channel === 'data:save') {
    return async (event, payload) => {
      assertMainRenderer(event);
      const result = store().commit(payload, clientExpectation(event));
      remember(event, result);
      return true;
    };
  }

  if (channel === 'local:choose') {
    return async (event, ...args) => {
      const result = await registeredHandler(event, ...args);
      // A storage migration changes the file path. Establish the new storage
      // session from the copied file so a request dispatched against the old
      // path cannot arrive later and commit into the new context.
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
      const prepared = protectGoogleDispatch(originalState);
      const guarded = await runGuardedGoogle(prepared.state, prepared.protection, () =>
        registeredHandler(event, prepared.state)
      );
      includeDiscoveredProtectedIds(prepared.protection, guarded.context);
      if (guarded.result?.state) {
        guarded.result.state = restoreGoogleProtected(originalState, guarded.result.state, prepared.protection);
      }
      if (guarded.result?.summary) {
        guarded.result.summary.providerProtected = prepared.protection.protectedTasks.length
          + prepared.protection.protectedDeletes.length;
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
      const guarded = await runGuardedGoogle(guardState, null, () => registeredHandler(event, entry));
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
  return originalHandle(channel, wrapRegistration(channel, registeredHandler));
};

require(path.join('..', 'main.cjs'));
