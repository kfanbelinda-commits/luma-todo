const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'cn-holidays.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(source, sandbox);

function markOf(dateKey) {
  const mark = sandbox.getCnHolidayMark(dateKey);
  return mark ? { type: String(mark.type), name: String(mark.name) } : null;
}

test('marks official rest days as 放假', () => {
  assert.deepEqual(markOf('2026-02-17'), { type: 'off', name: '春节' });
  assert.deepEqual(markOf('2026-10-01'), { type: 'off', name: '国庆节' });
  assert.equal(sandbox.cnHolidayDetailLabel(sandbox.getCnHolidayMark('2026-01-01')), '元旦 · 放假');
});

test('marks makeup weekdays as 调休上班', () => {
  assert.deepEqual(markOf('2026-02-14'), { type: 'work', name: '春节' });
  assert.deepEqual(markOf('2026-10-10'), { type: 'work', name: '国庆节' });
  assert.equal(sandbox.cnHolidayDetailLabel(sandbox.getCnHolidayMark('2026-01-04')), '元旦 · 调休上班');
});

test('leaves ordinary days unmarked', () => {
  assert.equal(sandbox.getCnHolidayMark('2026-09-07'), null);
  assert.equal(sandbox.getCnHolidayMark('2027-01-01'), null);
  assert.equal(sandbox.getCnHolidayMark(''), null);
});

test('short grid badges stay lightweight', () => {
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-02-17')), '休');
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-05-01')), '休');
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-10-01')), '休');
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-10-10')), '班');
  assert.equal(sandbox.cnHolidayBadgeText(null), '');
});

test('festival names identify the day, not the beginning or continuation of a break', () => {
  assert.equal(sandbox.cnFestivalName('2026-02-15'), '');
  assert.equal(sandbox.cnFestivalName('2026-02-17'), '春节');
  assert.equal(sandbox.cnFestivalName('2026-04-04'), '');
  assert.equal(sandbox.cnFestivalName('2026-04-05'), '清明');
  assert.equal(sandbox.cnFestivalName('2026-09-25'), '中秋');
  assert.equal(sandbox.cnFestivalName('2026-09-26'), '');
  assert.equal(sandbox.cnFestivalName('2025-10-06'), '中秋');
  assert.equal(sandbox.cnFestivalName('2027-01-01'), '');
});
