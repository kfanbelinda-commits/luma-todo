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
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-02-17')), '春节');
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-05-01')), '劳动');
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-10-01')), '国庆');
  assert.equal(sandbox.cnHolidayBadgeText(sandbox.getCnHolidayMark('2026-10-10')), '班');
  assert.equal(sandbox.cnHolidayBadgeText(null), '');
});

test('festival names stay on the lead rest day only', () => {
  assert.equal(sandbox.cnFestivalName(sandbox.getCnHolidayMark('2026-09-25')), '中秋');
  assert.equal(sandbox.cnFestivalName(sandbox.getCnHolidayMark('2026-10-01')), '国庆');
  assert.equal(sandbox.cnFestivalName(sandbox.getCnHolidayMark('2026-05-01')), '劳动');
  assert.equal(sandbox.cnFestivalName(sandbox.getCnHolidayMark('2026-09-20')), '');
  assert.equal(sandbox.cnFestivalName(null), '');
  assert.equal(sandbox.cnHolidayIsLeadDay('2026-09-25'), true);
  assert.equal(sandbox.cnHolidayIsLeadDay('2026-09-26'), false);
  assert.equal(sandbox.cnHolidayIsLeadDay('2026-09-27'), false);
  assert.equal(sandbox.cnHolidayIsLeadDay('2025-10-06'), true);
});

test('week captions reuse rest/work marks without a second table', () => {
  function captionOf(dateKey) {
    const caption = sandbox.cnHolidayWeekCaption(dateKey);
    if (!caption) return null;
    return {
      type: String(caption.type),
      badge: String(caption.badge),
      full: String(caption.full),
      fest: String(caption.fest),
      detail: String(caption.detail),
    };
  }
  assert.deepEqual(captionOf('2026-09-25'), {
    type: 'off',
    badge: '休',
    full: '中秋 · 休',
    fest: '中秋',
    detail: '中秋 · 放假',
  });
  assert.deepEqual(captionOf('2026-09-26'), {
    type: 'off',
    badge: '休',
    full: '休息日',
    fest: '',
    detail: '中秋 · 放假',
  });
  assert.deepEqual(captionOf('2026-09-20'), {
    type: 'work',
    badge: '班',
    full: '调休上班',
    fest: '',
    detail: '国庆节 · 调休上班',
  });
  assert.equal(captionOf('2026-09-07'), null);
  assert.equal(captionOf('2026-10-01').full, '国庆 · 休');
  assert.equal(captionOf('2026-10-02').full, '休息日');
});

test('week view wires holiday captions into the existing header and mini calendar', () => {
  const week = fs.readFileSync(path.join(__dirname, '..', 'src', 'week-view.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'week-view.css'), 'utf8');
  assert.match(week, /function weekHolidaySubline/);
  assert.match(week, /getCnHolidayMark/);
  assert.match(week, /cnHolidayBadgeText/);
  assert.match(week, /cnFestivalName/);
  assert.match(week, /cnHolidayDetailLabel/);
  assert.match(week, /week-mini-workdot/);
  assert.match(week, /is-holiday-off/);
  assert.doesNotMatch(week, /setTimeout\(/);
  assert.match(css, /\.week-col-lunar\.is-holiday-off/);
  assert.match(css, /\.week-mini-day\.is-holiday-off:not\(\.is-anchor\)/);
  assert.match(css, /@container weekcol/);
});
