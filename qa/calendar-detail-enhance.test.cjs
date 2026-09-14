const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'src', 'calendar-detail-enhance.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'calendar-detail-enhance.css'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'src', 'lifelog-boot.js'), 'utf8');

test('calendar detail enhancement keeps completed todos and LifeLog compact behavior wired', () => {
  assert.match(js, /task\.completed/);
  assert.match(js, /calendarCompletedTodos/);
  assert.match(js, /toggleTask\(task\.id\)/);
  assert.match(js, /lifelog-detail-compact/);
  assert.match(js, /还没有生活记录/);
  assert.match(css, /calendar-detail-completed-row/);
  assert.match(css, /lifelog-detail-compact:not\(\.is-expanded\)/);
  assert.match(boot, /calendar-detail-enhance\.css/);
  assert.match(boot, /calendar-detail-enhance\.js/);
});
