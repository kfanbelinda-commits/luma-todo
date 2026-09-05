const fs = require('fs');
const assert = require('assert');

const read = (path) => fs.readFileSync(path, 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const main = read('main.cjs');
const preload = read('preload.cjs');
const app = read('src/app.js');
const gitignore = read('.gitignore');

assert.strictEqual(pkg.scripts.start, 'electron .', 'npm start must use real Luma data');
assert.strictEqual(pkg.version, lock.version, 'package and lockfile versions must match');
assert.strictEqual(pkg.version, lock.packages?.['']?.version, 'root lockfile package version must match');

const packagedFiles = new Set(pkg.build?.files || []);
for (const required of ['main.cjs', 'preload.cjs', 'index.html', 'src/**/*', 'assets/icon.png', 'assets/icon.ico', 'package.json']) {
  assert(packagedFiles.has(required), `packaged files must include ${required}`);
}
assert(!packagedFiles.has('assets/**/*'), 'package must not include every asset');
assert(![...packagedFiles].some((entry) => entry.startsWith('demo/')), 'demo files must not be packaged');
assert(![...packagedFiles].some((entry) => entry.startsWith('qa/')), 'QA files must not be packaged');

for (const ignored of [
  'credentials.json',
  'google-token.enc',
  'icloud-calendar.enc',
  '**/luma-data.json',
  '**/luma-window-state.json',
  '**/Backups/'
]) {
  assert(gitignore.includes(ignored), `.gitignore must protect ${ignored}`);
}

assert(/contextIsolation:\s*true/.test(main), 'BrowserWindow must keep contextIsolation enabled');
assert(/nodeIntegration:\s*false/.test(main), 'BrowserWindow must keep nodeIntegration disabled');
assert(main.includes("setWindowOpenHandler(() => ({ action: 'deny' }))"), 'renderer-created windows must remain blocked');
assert(main.includes("webContents.on('will-navigate'"), 'unexpected renderer navigation must remain blocked');
assert(/safeStorage\.encryptString/.test(main), 'local credentials/tokens must use safeStorage encryption');

const publicStatusStart = main.indexOf('function publicIcloudStatus');
const publicStatusEnd = main.indexOf('function icsEscapeText', publicStatusStart);
assert(publicStatusStart >= 0 && publicStatusEnd > publicStatusStart, 'publicIcloudStatus must remain identifiable');
assert(!/password/i.test(main.slice(publicStatusStart, publicStatusEnd)), 'saved iCloud password must not be exposed by publicIcloudStatus');

assert(!/require\(['"]fs['"]\)/.test(preload), 'preload must not expose direct filesystem access');
assert(!/child_process/.test(preload), 'preload must not expose child_process');
assert(main.includes("!app.isPackaged && process.env.LUMA_BEHAVIOR_SMOKE === '1'"), 'renderer QA must remain dev-only');
assert(main.includes("!app.isPackaged && process.env.LUMA_SYNC_PROTOCOL_SMOKE === '1'"), 'sync QA must remain dev-only');

for (const removed of ['isTodayTask', 'parseQuickInput', 'renderUpcoming', 'openTaskInCalendar', 'stepTaskDateFilter', 'toggleTodayOrAll', 'setTaskDateFilter']) {
  assert(!new RegExp(`function\\s+${removed}\\s*\\(`).test(app), `dead helper ${removed} should not return`);
}

console.log('Luma invariants: OK');
