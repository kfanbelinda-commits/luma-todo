const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lumaEdge', {
  restore: () => ipcRenderer.send('edge:restore'),
  move: (payload) => ipcRenderer.send('edge:move', payload),
});