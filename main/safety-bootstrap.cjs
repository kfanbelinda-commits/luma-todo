'use strict';

// This bootstrap is intentionally narrow. It keeps the published application
// intact while placing a revision/session guard around destructive persistence
// and cloud entry points. The sync engines can be migrated behind this boundary
// without allowing a corrupt load or stale storage session to overwrite data.

const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const { createStateStore } = require('./state-store.cjs');

const originalHandle = ipcMain.handle.bind(ipcMain);
let stateStore = null;
let recoveryDialogShown = false;
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

  if (channel === 'google:sync' || channel === 'icloud:sync' || channel === 'google:delete-task') {
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
