const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lumaEdge', { restore: () => ipcRenderer.send('edge:restore') });
