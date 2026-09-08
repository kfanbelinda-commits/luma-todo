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
