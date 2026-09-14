const { contextBridge, ipcRenderer, webFrame } = require('electron');

const SNAPSHOT_TOKEN_KEY = '__lumaSnapshotToken';
let currentSnapshotToken = null;
let allowInitialTokenFallback = false;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function stripSnapshotToken(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const result = clone(payload);
  delete result[SNAPSHOT_TOKEN_KEY];
  return result;
}

async function setRendererSnapshotToken(token) {
  currentSnapshotToken = clone(token);
  allowInitialTokenFallback = false;
  const key = JSON.stringify(SNAPSHOT_TOKEN_KEY);
  const value = JSON.stringify(currentSnapshotToken);
  try {
    await webFrame.executeJavaScript(
      `if (typeof state !== 'undefined' && state && typeof state === 'object') state[${key}] = ${value};`
    );
  } catch (error) {
    console.error('Unable to refresh Luma snapshot token in renderer', error);
  }
}

async function loadState() {
  const result = await ipcRenderer.invoke('data:load');
  if (!result || !Object.hasOwn(result, 'state') || !result.token) {
    throw new Error('本地数据未返回有效快照凭证，请重新加载 Luma');
  }
  currentSnapshotToken = clone(result.token);
  allowInitialTokenFallback = result.state == null;
  if (result.state == null) return null;
  const state = clone(result.state);
  state[SNAPSHOT_TOKEN_KEY] = clone(result.token);
  return state;
}

async function saveState(payload) {
  const token = payload?.[SNAPSHOT_TOKEN_KEY]
    || (allowInitialTokenFallback ? currentSnapshotToken : null);
  if (!token) throw new Error('当前数据快照缺少保存凭证，请重新加载 Luma');
  const result = await ipcRenderer.invoke('data:save', stripSnapshotToken(payload), clone(token));
  if (!result?.token) throw new Error('保存完成状态无法确认，请重新加载 Luma');
  await setRendererSnapshotToken(result.token);
  return true;
}

async function chooseLocal(kind) {
  const result = await ipcRenderer.invoke('local:choose', kind);
  if (kind === 'storage') {
    const loaded = await ipcRenderer.invoke('data:load');
    if (!loaded?.token) throw new Error('新的本地数据位置无法建立保存凭证，请重新加载 Luma');
    await setRendererSnapshotToken(loaded.token);
  }
  return result;
}

contextBridge.exposeInMainWorld('luma', {
  localStatus: () => ipcRenderer.invoke('local:status'),
  localConfigure: (values) => ipcRenderer.invoke('local:configure', values),
  localChoose: chooseLocal,
  localScan: () => ipcRenderer.invoke('local:scan'),
  setExpanded: (expanded) => ipcRenderer.invoke('window:set-expanded', expanded),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:set-always-on-top', enabled),
  activate: () => ipcRenderer.send('window:activate'),
  hide: () => ipcRenderer.send('window:hide'),
  load: loadState,
  save: saveState,
  exportData: (payload) => ipcRenderer.invoke('data:export', stripSnapshotToken(payload)),
  setAutoStart: (enabled) => ipcRenderer.invoke('settings:auto-start', enabled),
  getAutoStart: () => ipcRenderer.invoke('settings:get-auto-start'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  resizeStart: (payload) => ipcRenderer.send('window:resize-start', payload),
  resizeMove: (payload) => ipcRenderer.send('window:resize-move', payload),
  resizeEnd: () => ipcRenderer.send('window:resize-end'),
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleConnect: () => ipcRenderer.invoke('google:connect'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  googleSync: (payload) => ipcRenderer.invoke('google:sync', stripSnapshotToken(payload)),
  googleDeleteTask: (task) => ipcRenderer.invoke('google:delete-task', task),
  icloudStatus: () => ipcRenderer.invoke('icloud:status'),
  icloudConnect: (payload) => ipcRenderer.invoke('icloud:connect', payload),
  icloudDisconnect: () => ipcRenderer.invoke('icloud:disconnect'),
  icloudSync: (payload) => ipcRenderer.invoke('icloud:sync', {
    ...payload,
    state: stripSnapshotToken(payload?.state),
  }),
  lifelogLoad: () => ipcRenderer.invoke('lifelog:load'),
  lifelogSave: (payload) => ipcRenderer.invoke('lifelog:save', payload),
  lifelogMediaDataUrl: (relativePath) => ipcRenderer.invoke('lifelog:media-data-url', relativePath),
  lifelogSaveMedia: (payload) => ipcRenderer.invoke('lifelog:save-media', payload),
  lifelogDeleteMedia: (relativePath) => ipcRenderer.invoke('lifelog:delete-media', relativePath),
  privateExtensionsStatus: () => ipcRenderer.invoke('private-extensions:status'),
  privateExtensionsActivate: (code) => ipcRenderer.invoke('private-extensions:activate', code),
  privateExtensionsInstall: () => ipcRenderer.invoke('private-extensions:install'),
  privateExtensionPanel: (id,args) => ipcRenderer.invoke('private-extensions:panel',{id,args}),
  privateExtensionMarks: (id,args) => ipcRenderer.invoke('private-extensions:marks',{id,args}),
  privateExtensionSettings: (id,result,error) => ipcRenderer.invoke('private-extensions:settings',{id,result,error}),
  privateExtensionSyncCalendar: (id,calendarUrl) => ipcRenderer.invoke('private-extensions:sync-calendar',{id,calendarUrl}),
  privateExtensionUninstall: id => ipcRenderer.invoke('private-extensions:uninstall',id),
});
