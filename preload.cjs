const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('luma', {
  setExpanded: (expanded) => ipcRenderer.invoke('window:set-expanded', expanded),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:set-always-on-top', enabled),
  activate: () => ipcRenderer.send('window:activate'),
  hide: () => ipcRenderer.send('window:hide'),
  load: () => ipcRenderer.invoke('data:load'),
  save: (payload) => ipcRenderer.invoke('data:save', payload),
  exportData: (payload) => ipcRenderer.invoke('data:export', payload),
  setAutoStart: (enabled) => ipcRenderer.invoke('settings:auto-start', enabled),
  getAutoStart: () => ipcRenderer.invoke('settings:get-auto-start'),
  resizeStart: (payload) => ipcRenderer.send('window:resize-start', payload),
  resizeMove: (payload) => ipcRenderer.send('window:resize-move', payload),
  resizeEnd: () => ipcRenderer.send('window:resize-end'),
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleConnect: () => ipcRenderer.invoke('google:connect'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  googleSync: (payload) => ipcRenderer.invoke('google:sync', payload),
  googleDeleteTask: (task) => ipcRenderer.invoke('google:delete-task', task),
});
