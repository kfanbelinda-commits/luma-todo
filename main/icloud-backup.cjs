'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Keep plain, importable state snapshots before any iCloud network side effect.
// Preserve the on-disk version too if it differs from the renderer's snapshot.
function backupBeforeIcloudSync(root, state) {
  if (!state || !Array.isArray(state.tasks) || !Array.isArray(state.projects)) {
    throw new Error('Luma 同步数据无效');
  }
  const payload = JSON.stringify(state, null, 2);
  let disk;
  try { disk = fs.readFileSync(path.join(root, 'luma-data.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = path.join(root, 'backups');
  fs.mkdirSync(directory, { recursive: true });
  const stem = 'luma-before-icloud-sync-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  if (disk && !disk.equals(Buffer.from(payload))) {
    fs.writeFileSync(path.join(directory, stem + '-disk.json'), disk, { flag: 'wx' });
  }
  const file = path.join(directory, stem + '.json');
  fs.writeFileSync(file, payload, { encoding: 'utf8', flag: 'wx' });
  return file;
}

module.exports = { backupBeforeIcloudSync };
