const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLocalData, validatePackage } = require('../main/local-data.cjs');
const scratch = path.join(__dirname, '..', '.codex-tmp');
fs.mkdirSync(scratch, { recursive: true });
function setup() {
  const base = fs.mkdtempSync(path.join(scratch, 'local-data-test-'));
  const home = path.join(base, 'home'), inbox = path.join(base, 'inbox'), destination = path.join(base, 'destination');
  for (const dir of [home, inbox, destination]) fs.mkdirSync(dir);
  const service = createLocalData(home);
  return { base, home, inbox, destination, service };
}
const pack = () => ({ schema: 'luma-lifelog-inbox-v1', dateKey: '2026-09-06', weather: 'cloudy', mood: 'good', note: '测试日记', coverIndex: 0, photos: [{ mime: 'image/jpeg', dataBase64: 'data:image/jpeg;base64,/9j/2Q==' }] });
function drop(inbox, value = pack()) { fs.writeFileSync(path.join(inbox, 'lifelog-2026-09-06.json'), JSON.stringify(value)); }
test('default disabled; import media, archive and deduplicate after restart', () => {
  const { home, inbox, service } = setup();
  drop(inbox);
  service.scan();
  assert.equal(fs.existsSync(path.join(home, 'lifelog.json')), false);
  service.configure({ inboxPath: inbox, inboxEnabled: true });
  assert.match(service.scan().lastImport, /导入 1 篇/);
  const entry = JSON.parse(fs.readFileSync(path.join(home, 'lifelog.json'))).entries['2026-09-06'];
  assert.equal(entry.note, '测试日记');
  assert.equal(entry.coverPhotoId, entry.photos[0].id);
  assert.equal(fs.readFileSync(path.join(home, 'lifelog-media', entry.photos[0].path)).length, 4);
  assert.equal(fs.readdirSync(path.join(inbox, 'done')).length, 1);
  drop(inbox);
  assert.match(createLocalData(home).scan().lastImport, /导入 0 篇/);
});
test('date conflicts and malformed packages keep originals without overwriting', () => {
  const { home, inbox, service } = setup();
  const old = { version: 1, entries: { '2026-09-06': { note: '桌面记录' } } };
  fs.writeFileSync(path.join(home, 'lifelog.json'), JSON.stringify(old));
  drop(inbox);
  service.configure({ inboxPath: inbox, inboxEnabled: true });
  assert.match(service.scan().lastImport, /1 篇日期冲突/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'lifelog.json'))), old);
  assert.equal(fs.existsSync(path.join(inbox, 'lifelog-2026-09-06.json')), false);
  assert.equal(fs.readdirSync(path.join(inbox, 'conflicts')).length, 1);
  const second = service.scan().lastImport;
  assert.match(second, /导入 0 篇/);
  assert.doesNotMatch(second, /冲突/);
  drop(inbox, { ...pack(), photos: [{ mime: 'image/svg+xml', dataBase64: 'bad' }] });
  assert.match(service.scan().lastImport, /1 个文件待重试/);
  assert.equal(fs.existsSync(path.join(inbox, 'lifelog-2026-09-06.json')), true);
});
test('reject invalid dates, moods, cover indices and non-image bytes', () => {
  for (const change of [{ dateKey: '2026-02-30' }, { mood: 'unknown' }, { coverIndex: 4 }, { photos: [{ mime: 'image/jpeg', dataBase64: 'dGVzdA==' }] }]) assert.throws(() => validatePackage({ ...pack(), ...change }));
});
test('corrupt database is preserved and archive failures recover without duplication', () => {
  const { home, inbox, service } = setup();
  const file = path.join(home, 'lifelog.json');
  fs.writeFileSync(file, '{incomplete');
  drop(inbox);
  service.configure({ inboxPath: inbox, inboxEnabled: true });
  assert.match(service.scan().lastImport, /暂时无法读取/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{incomplete');
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: {} }));
  fs.writeFileSync(path.join(inbox, 'done'), 'blocks directory');
  assert.match(service.scan().lastImport, /导入 1 篇.*待重试/);
  fs.renameSync(path.join(inbox, 'done'), path.join(inbox, 'blocked-done'));
  assert.match(createLocalData(home).scan().lastImport, /导入 0 篇/);
  assert.equal(fs.readdirSync(path.join(inbox, 'done')).length, 1);
  assert.equal(fs.readdirSync(path.join(home, 'lifelog-media')).length, 1);
});
test('migration preserves source and credentials, verifies files and persists destination', () => {
  const { home, destination, service } = setup();
  fs.writeFileSync(path.join(home, 'luma-data.json'), '{"tasks":[]}');
  fs.writeFileSync(path.join(home, 'google-token.enc'), 'fake-test-token');
  fs.mkdirSync(path.join(home, 'lifelog-media'));
  fs.writeFileSync(path.join(home, 'lifelog-media', 'test.jpg'), 'test');
  service.migrate(destination);
  assert.equal(createLocalData(home).root(), destination);
  assert.equal(fs.existsSync(path.join(home, 'luma-data.json')), true);
  assert.equal(fs.existsSync(path.join(destination, 'google-token.enc')), false);
  assert.equal(fs.readFileSync(path.join(destination, 'lifelog-media', 'test.jpg'), 'utf8'), 'test');
});
test('nonempty destination and unavailable source never switch to empty data', () => {
  const { home, destination, service } = setup();
  fs.writeFileSync(path.join(destination, 'existing'), 'keep');
  assert.throws(() => service.migrate(destination));
  assert.equal(service.root(), home);
  assert.throws(() => service.configure({ storagePath: path.join(home, 'missing') }));
  assert.throws(() => service.root());
});
