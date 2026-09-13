'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { backupBeforeIcloudSync } = require('../main/icloud-backup.cjs');
const scratch = path.join(__dirname, '..', '.codex-tmp');
fs.mkdirSync(scratch, { recursive: true });
const setup = () => fs.mkdtempSync(path.join(scratch, 'icloud-backup-test-'));
const state = () => ({ version: 1, projects: [{ id: 'inbox', name: 'QA' }], tasks: [
  { id: 'done', title: 'Completed QA task', itemType: 'todo', completed: true, completedDate: '2026-09-08',
    icloudHref: 'https://qa.invalid/done.ics', lastIcloudSnapshot: { completed: true } },
] });

test('each sync keeps a distinct importable snapshot without changing the source', () => {
  const root = setup(), original = state();
  const bytes = JSON.stringify(original, null, 2);
  fs.writeFileSync(path.join(root, 'luma-data.json'), bytes);
  const first = backupBeforeIcloudSync(root, original);
  const second = backupBeforeIcloudSync(root, original);
  assert.notEqual(first, second);
  assert.deepEqual(JSON.parse(fs.readFileSync(first, 'utf8')), original);
  assert.equal(fs.readFileSync(path.join(root, 'luma-data.json'), 'utf8'), bytes);
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 2);
});

test('a differing or malformed disk version is also preserved byte-for-byte', () => {
  for (const disk of [JSON.stringify({ ...state(), tasks: [] }), '{incomplete']) {
    const root = setup();
    fs.writeFileSync(path.join(root, 'luma-data.json'), disk);
    const file = backupBeforeIcloudSync(root, state());
    const diskFile = file.replace(/\.json$/, '-disk.json');
    assert.equal(fs.readFileSync(diskFile, 'utf8'), disk);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), state());
    assert.equal(fs.readFileSync(path.join(root, 'luma-data.json'), 'utf8'), disk);
  }
});

test('invalid input and backup write failure surface before sync may begin', () => {
  const root = setup();
  assert.throws(() => backupBeforeIcloudSync(root, { tasks: [] }), /数据无效/);
  fs.writeFileSync(path.join(root, 'backups'), 'blocked');
  assert.throws(() => backupBeforeIcloudSync(root, state()));
});
