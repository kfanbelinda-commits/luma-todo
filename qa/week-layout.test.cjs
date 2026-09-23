'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/week-view.js'), 'utf8')
  .replace(
    /  boot\(\);\s+document\.addEventListener\('DOMContentLoaded', boot\);/,
    '  globalThis.weekItems = weekItemsOnDate; globalThis.weekTodoMarkup = weekTodoMarkup;'
      + ' globalThis.weekTimedSegment = weekTimedSegment; globalThis.weekBlockMarkup = blockMarkup;'
      + ' globalThis.weekConfig = { viewStart: VIEW_START, viewEnd: VIEW_END, todoVisible: WEEK_TODO_VISIBLE };'
      + ' globalThis.defaultScrollTop = defaultScrollTop; globalThis.fitWeekTimeScale = fitWeekTimeScale;'
  );

function loadWeek(tasks, pending = new Set()) {
  const state = {
    tasks,
    projects: [
      { id: 'inbox', name: '未分类', color: '#78a28a' },
      { id: 'calendar', name: '日程', color: '#8da4c3' },
    ],
  };
  const context = vm.createContext({
    console,
    state,
    window: {},
    document: { addEventListener() {} },
    isCalendarEvent: (task) => task?.itemType === 'event',
    eventCoversDate: (task, key) => String(task.dueDate || '') <= key && key <= String(task.endDate || task.dueDate || ''),
    taskSort: (a, b) => Number(a.order || 0) - Number(b.order || 0),
    isTaskPendingCompletion: (id) => pending.has(id),
    projectById: (id) => state.projects.find((project) => project.id === id),
  });
  vm.runInContext(source, context);
  return context;
}

test('week layout separates Todos, all-day Events and timed Events by item type', () => {
  const tasks = [
    { id: 'todo-timed', title: '定时待办', itemType: 'todo', projectId: 'inbox', dueDate: '2026-09-08', time: '09:30', order: 1, completed: false },
    { id: 'todo-done', title: '已完成待办', itemType: 'todo', projectId: 'inbox', dueDate: '2026-09-08', time: '', order: 2, completed: true, updatedAt: 20 },
    { id: 'all-day', title: '全天日程', itemType: 'event', projectId: 'calendar', dueDate: '2026-09-08', endDate: '2026-09-08', time: '', completed: false },
    { id: 'timed-event', title: '时间日程', itemType: 'event', projectId: 'calendar', dueDate: '2026-09-08', endDate: '2026-09-08', time: '10:00', completed: false },
    { id: 'other-day', title: '其他日期', itemType: 'todo', projectId: 'inbox', dueDate: '2026-09-09', time: '', completed: false },
  ];
  const context = loadWeek(tasks);
  const result = context.weekItems('2026-09-08');

  assert.deepEqual(Array.from(result.todos, (task) => task.id), ['todo-timed', 'todo-done']);
  assert.deepEqual(Array.from(result.allDayEvents, (task) => task.id), ['all-day']);
  assert.deepEqual(Array.from(result.timedEvents, (task) => task.id), ['timed-event']);
});

test('week Todo markup exposes checkbox, time and pending completion state', () => {
  const task = { id: 'todo-timed', title: '定时待办', itemType: 'todo', projectId: 'inbox', dueDate: '2026-09-08', time: '09:30', completed: false };
  const context = loadWeek([task], new Set([task.id]));
  const html = context.weekTodoMarkup(task, '2026-09-08');

  assert.match(html, /week-todo-item is-checked is-pending/);
  assert.match(html, /week-todo-check is-checked/);
  assert.match(html, /09:30/);
  assert.match(html, /定时待办/);
});

test('timed events spanning three days use work-hour continuation segments', () => {
  const task = {
    id: 'trip', title: '跨日现场工作', itemType: 'event', projectId: 'calendar',
    dueDate: '2026-09-21', time: '12:00', endDate: '2026-09-23', endTime: '15:00', completed: false,
  };
  const context = loadWeek([task]);

  assert.deepEqual({ ...context.weekTimedSegment(task, '2026-09-21') }, {
    begin: 720, finish: 1080, continuesBefore: false, continuesAfter: true,
  });
  assert.deepEqual({ ...context.weekTimedSegment(task, '2026-09-22') }, {
    begin: 480, finish: 1080, continuesBefore: true, continuesAfter: true,
  });
  assert.deepEqual({ ...context.weekTimedSegment(task, '2026-09-23') }, {
    begin: 480, finish: 900, continuesBefore: true, continuesAfter: false,
  });
  assert.match(context.weekBlockMarkup(task, '2026-09-22', 0, 1440), /continues-before continues-after/);
  assert.match(context.weekBlockMarkup(task, '2026-09-22', 0, 1440), /续 · 08:00 →/);
  assert.doesNotMatch(context.weekBlockMarkup(task, '2026-09-22', 0, 1440), /is-draggable/);
});

test('multi-day display keeps real endpoints outside the continuation window', () => {
  const task = {
    id: 'overnight', title: '早晚跨日', itemType: 'event', projectId: 'calendar',
    dueDate: '2026-09-21', time: '06:00', endDate: '2026-09-22', endTime: '20:00', completed: false,
  };
  const context = loadWeek([task]);
  assert.deepEqual({ ...context.weekTimedSegment(task, '2026-09-21') }, {
    begin: 360, finish: 1080, continuesBefore: false, continuesAfter: true,
  });
  assert.deepEqual({ ...context.weekTimedSegment(task, '2026-09-22') }, {
    begin: 480, finish: 1200, continuesBefore: true, continuesAfter: false,
  });
});

test('week defaults show three Todos and focus the initial 07:00–21:00 window', () => {
  const context = loadWeek([]);
  assert.deepEqual({ ...context.weekConfig }, { viewStart: 7, viewEnd: 21, todoVisible: 3 });
  assert.equal(context.defaultScrollTop(32), 7 * 32);

  const values = {};
  const style = { setProperty: (name, value) => { values[name] = value; } };
  const scroll = { clientHeight: 448 };
  const gutter = { style };
  const days = { style };
  const board = {
    dataset: {},
    querySelector: (selector) => ({ '.week-scroll': scroll, '.week-gutter': gutter, '.week-days': days })[selector],
  };
  assert.deepEqual({ ...context.fitWeekTimeScale(board) }, { hourPx: 32, previousHourPx: 44 });
  assert.equal(values['--hour-h'], '32px');
});
