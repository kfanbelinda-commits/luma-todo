"use strict";

let registered = false;

function registerPrivateExtensionWebOpener(manager) {
  if (registered || !manager || typeof manager.manifest !== 'function') return false;
  let electron;
  try { electron = require('electron'); } catch { return false; }
  if (typeof electron?.ipcMain?.handle !== 'function' || typeof electron?.shell?.openExternal !== 'function') return false;

  electron.ipcMain.handle('private-extensions:open-web', async (event, rawId) => {
    const frameUrl = String(event?.senderFrame?.url || '');
    if (!frameUrl.startsWith('file:')) throw new Error('不允许从当前页面打开扩展网址');
    const id = String(rawId || '');
    const manifest = manager.manifest(id);
    const url = String(manifest?.fullUrl || '');
    if (!/^https:\/\/\S+$/i.test(url)) throw new Error('扩展未提供网页版地址');
    await electron.shell.openExternal(url);
    return true;
  });
  registered = true;
  return true;
}

module.exports = { registerPrivateExtensionWebOpener };
